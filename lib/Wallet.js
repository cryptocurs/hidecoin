'use strict'

const R = require('ramda')
const fs = require('fs')

const Component = require('./Component')
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

class Wallet extends Component {

  constructor(login = 'wallet') {
    super()
    this.module = 'WLT'
    this.keys = []
    this.password = null
    this.inWallet = false
    this.blockchainChanged = false
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
    
    this.processData = (balances) => {
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
      
      for (const addr in balances) {
        const data = balances[addr]
        
        const dataUnconfirmed = Tx.getAddressBalanceUnconfirmed(data.raw)
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
    }
    
    storage.on('blockchainAddedBlock', (unpacked) => {
      this.blockchainChanged = true
    })
    
    storage.on('blockchainRemovedBlocks', (count) => {
      this.blockchainChanged = true
    })
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
  
  createAddress() {
    const address = Address.create()
    this.attachAddress(address)
    return address
  }
  
  updateData(callback) {
    if (!this.inWallet) {
      callback && callback(false)
      return
    }
    this.blockchainChanged = false
    
    const addresses = R.map((privBased) => {
      const address = new Address(privBased)
      return {hashed: address.getAddress(), raw: address.getAddressRaw(), keys: address.getKeys()}
    }, this.keys)
    
    const balances = Block.getAddressesBalanceSep(addresses)
    this.processData(balances)
    callback && callback(true)
  }
  
  sendCoinsMulti(data, callback) {
    if (!this.inWallet) {
      callback({type: 'error', message: 'Wallet is not opened'})
      return
    }
    
    let walletData = {}
    for (let i in this.data) {
      walletData[i] = this.data[i]
    }
    
    let toSend = 0
    
    let txOutsWithoutFee = []
    const {recipients, senders} = data
    for (let i in recipients) {
      const rec = recipients[i]
      let {address, amount, amountm} = rec
      if (!Address.isValid(address)) {
        callback({type: 'error', message: 'Enter correct address'})
        return
      }
      if (amount && /^([\d\.]*)$/.test(amount)) {
        amount = parseFloat(amount)
      } else {
        amount = 0
      }
      if (amountm && /^([\d\.]*)$/.test(amountm)) {
        amountm = parseInt(amountm)
      } else {
        amountm = 0
      }
      const value = Math.round(amount * 100000000, 8) + amountm
      if (value <= 0) {
        callback({type: 'error', message: 'Enter correct sum'})
        return
      }
      txOutsWithoutFee.push({address: Address.hashToRaw(address), value})
      toSend += value
    }
    
    const toReceive = toSend
    toSend += Tx.MIN_FEE
    
    const from = senders ? R.intersection(R.keys(walletData.balances), senders) : R.keys(walletData.balances)
    if (!from.length) {
      callback({type: 'error', message: 'No addresses from which to send'})
      return
    }
    
    const allAmount = senders ? R.reduce((acc, sender) => acc + walletData.balances[sender], 0, senders) : walletData.allAmount
    if (allAmount < toSend) {
      callback({type: 'error', message: 'Not enough micoins'})
      return
    }
    
    const createTx = ({toSend, toReceive}, walletData, callback) => {
      const sortedAddrs = R.sort((a, b) => {
        return walletData.balances[b] - walletData.balances[a]
      }, from)
      
      let txIns = []
      let txOuts = Array.from(txOutsWithoutFee)
      let txKeys = []
      let txKeyId = -1
      
      for (let i in sortedAddrs) {
        if (toSend <= 0) {
          break
        }
        const addr = sortedAddrs[i]
        
        txKeys.push({
          publicKey: walletData.keys[addr].publ
        })
        txKeyId++
        
        const sortedTxs = R.sort((a, b) => {
          return b.value - a.value
        }, R.filter(tx => !tx.spent && !tx.spentFreeTxs, walletData.txs[addr]))
        
        for (let t in sortedTxs) {
          if (toSend <= 0) {
            break
          }
          const curTx = sortedTxs[t]
          const value = curTx.value
          
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
      const txOutsRaw = Tx.packOuts(txOuts)
      
      helper.processList(txIns, {
        onProcess: (item, callback) => {
          helper.signData(Buffer.concat([Tx.packHashOutN(item), txOutsRaw]), walletData.keys[item.addr].priv, (sign) => {
            item.sign = sign
            delete item.addr
            callback()
          })
        },
        onReady: () => {
          const tx = {
            time: hours.now(),
            txKeyCount: txKeys.length,
            txInCount: txIns.length,
            txOutCount: txOuts.length,
            txKeys: txKeys,
            txIns: txIns,
            txOutsRaw: txOutsRaw
          }
          this.log('Checking fee')
          callback(Tx.pack(tx), tx)
        }
      })
    }
    
    const calcFee = () => {
      this.log('Create tx', {toSend, toReceive})
      createTx({toSend, toReceive}, walletData, (txPacked, tx) => {
        const txSize = txPacked.length
        const fee = Math.max(Tx.calcFee(txSize), Tx.MIN_FEE)
        this.log('Tx size', txSize, 'Fee', fee)
        
        const realFee = toSend - toReceive
        if (realFee >= fee) {
          let txHash = helper.hash(txPacked)
          Tx.isValid(txHash, txPacked, null, blockchain.getLength(), false, (valid, err) => {
            if (valid) {
              Tx.freeTxAdd(txHash, txPacked, realFee)
              miner.restart()
              callback({type: 'success', message: 'Coins has been sent with fee ' + realFee + ' micoins', fee: realFee})
              
              synchronizer.broadcastTx(txHash, txPacked)
            } else {
              callback({type: 'error', message: err})
            }
          }, 0, tx)
        } else {
          toSend = toReceive + fee
          
          if (allAmount < toSend) {
            callback({type: 'error', message: 'Not enough micoins'})
            return
          }
          
          calcFee()
        }
      })
    }
    
    calcFee()
  }
  
  sendCoins(data, callback) {
    const {address, amount, amountm, fee, senders} = data
    this.sendCoinsMulti({
      recipients: [
        {address, amount, amountm}
      ],
      fee,
      senders
    }, callback)
  }
  
  isBlockchainChanged() {
    return this.blockchainChanged
  }
  
  isOpened() {
    return this.inWallet
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