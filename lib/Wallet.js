'use strict'

const R = require('ramda')
const fs = require('fs')

const storage = require('./Storage')
const helper = require('./helper')
const hours = require('./Hours')
const Address = require('./Address')
const blockchain = require('./Blockchain')
const Block = require('./Block')
const Tx = require('./Tx')
const miner = require('./Miner')
const synchronizer = require('./Synchronizer')

const base = __dirname + '/../'

class Wallet {

  constructor(login = 'wallet') {
    this.keys = []
    this.password = null
    this.inWallet = false
    this.path = base + 'data/' + login.replace(/\W/g, '') + '.dat'
    
    this.data = {
      balances: {},
      balancesSoft: {},
      balancesUnconfirmed: {},
      txs: {},
      txsSoft: {},
      keys: {},
      allAmount: 0,
      allAmountSoft: 0,
      allAmountUnconfirmed: 0
    }
  }
  
  exists() {
    return fs.existsSync(this.path)
  }
  
  create(password) {
    if (this.inWallet) {
      return false
    }
    
    if (fs.existsSync(this.path)) {
      return false
    }
    
    this.password = password
    this.inWallet = true
    this.flush()
    
    return true
  }
  
  open(password) {
    let decrypted = helper.decryptText(fs.readFileSync(this.path).toString(), password)
    if (!decrypted) {
      return false
    }
    this.keys = helper.jsonToObj(helper.baseToStr(decrypted))
    this.password = password
    this.inWallet = true
    return true
  }
  
  flush() {
    fs.writeFileSync(this.path, helper.encryptText(helper.strToBase(helper.objToJson(this.keys)), this.password))
  }
  
  attachAddress(address) {
    var privBased = helper.bufToBase(address.getKeys().priv)
    this.keys.push(privBased)
    this.flush()
  }
  
  updateData() {
    const balances = Block.getAddressesBalanceSepOld(R.map((privBased) => {
      const address = new Address(privBased)
      return {hashed: address.getAddress(), raw: address.getAddressRaw(), keys: address.getKeys()}
    }, this.keys))
    
    const newData = {
      balances: {},
      balancesSoft: {},
      balancesUnconfirmed: {},
      txs: {},
      txsSoft: {},
      keys: {},
      allAmount: 0,
      allAmountSoft: 0,
      allAmountUnconfirmed: 0
    }
    
    for (let addr in balances) {
      const data = balances[addr]
      
      let dataUnconfirmed = Tx.getAddressBalanceUnconfirmed(data.raw)
      newData.balances[addr] = data.balanceHard
      newData.balancesSoft[addr] = data.balanceSoft
      newData.balancesUnconfirmed[addr] = dataUnconfirmed.balance
      newData.txs[addr] = data.txsHard
      newData.txsSoft[addr] = data.txsSoft
      newData.keys[addr] = data.keys
      newData.allAmount += data.balanceHard
      newData.allAmountSoft += data.balanceSoft
      newData.allAmountUnconfirmed += dataUnconfirmed.balance
    }
    
    this.data = newData
    return true
  }
  
  sendCoins(data, callback) {
    let walletData = {}
    for (let i in this.data) {
      walletData[i] = this.data[i]
    }
    
    data.amount = data.amount || 0
    data.amountm = data.amountm || 0
    data.fee = data.fee || 0
    
    if (!Address.isValid(data.address)) {
      callback({type: 'error', message: 'Enter correct address'})
      return
    }
    
    let toSend = parseInt(data.amount) * 100000000 + parseInt(data.amountm)
    if (toSend <= 0) {
      callback({type: 'error', message: 'Enter correct sum'})
      return
    }
    let toReceive = toSend
    
    let txFee = parseInt(data.fee)
    txFee *= 100000000
    if (txFee < storage.config.minerMinimalFee) {
      callback({type: 'error', message: 'Enter correct fee'})
      return
    }
    toSend += txFee
    
    if (walletData.allAmount < toSend) {
      callback({type: 'error', message: 'Not enough micoins'})
      return
    }
    
    let sortedAddrs = R.sort((a, b) => {
      return walletData.balances[b] - walletData.balances[a]
    }, R.keys(walletData.balances))
    
    let txIns = []
    let txOuts = [{address: Address.hashToRaw(data.address), value: toReceive}]
    let txKeys = []
    let txKeyId = -1
    
    for (let i in sortedAddrs) {
      if (toSend <= 0) {
        break
      }
      let addr = sortedAddrs[i]
      
      txKeys.push({
        publicKey: walletData.keys[addr].publ
      })
      txKeyId++
      
      let sortedTxs = R.sort((a, b) => {
        return b.value - a.value
      }, R.filter(tx => !tx.spent && !tx.spentFreeTxs, walletData.txs[addr]))
      
      for (let t in sortedTxs) {
        if (toSend <= 0) {
          break
        }
        let curTx = sortedTxs[t]
        let value = curTx.value
        
        txIns.push({
          txHash: curTx.hash,
          outN: curTx.outN,
          keyId: txKeyId,
          sign: null,
          addr: addr
        })
        
        toSend -= value
      }
    }
    
    if (toSend < 0) {
      txOuts.push({address: Address.hashToRaw(sortedAddrs[0]), value: -toSend})
    }
    let txOutsRaw = Tx.packOuts(txOuts)
    
    helper.processList(txIns, {
      onProcess: (item, callback) => {
        helper.signData(Buffer.concat([Tx.packHashOutN(item), txOutsRaw]), walletData.keys[item.addr].priv, (sign) => {
          item.sign = sign
          delete item.addr
          callback()
        })
      },
      onReady: () => {
        let tx = {
          time: hours.now(),
          txKeyCount: txKeys.length,
          txInCount: txIns.length,
          txOutCount: txOuts.length,
          txKeys: txKeys,
          txIns: txIns,
          txOutsRaw: txOutsRaw
        }
        let txPacked = Tx.pack(tx)
        let txHash = helper.hash(txPacked)
        Tx.isValid(txHash, txPacked, null, blockchain.getLength(), false, (valid) => {
          if (valid) {
            Tx.freeTxAdd(txHash, txPacked, txFee)
            miner.restart()
            callback({type: 'success', message: 'Coins has been sent'})
            
            synchronizer.broadcastTx(txHash, txPacked)
          } else {
            callback({type: 'error', message: Tx.getError()})
          }
        }, 0, tx)
      }
    })
  }
  
  getContent() {
    return this.keys
  }
  
  getData() {
    return this.data
  }
}

module.exports = function(login) {
  return new Wallet(login)
}