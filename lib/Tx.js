'use strict'

/* Work with tx
*  Tx format
*
*  hash         32 B        Tx hash
*  time          8 B        Time of tx creation
*  txKeyCount    4 B        Count of keys
*  txInCount     4 B        Count of ins
*  txOutCount    4 B        Count of outs
*  KEYS
*  INS
*  OUTS
*
*  Key format
*  publicKey    65 B        Own public key
*
*  In format
*  txHash       32 B        Hash of tx with coins
*  outN          4 B        Out id
*  keyId         4 B        Key id
*  signSize      1 B        Size of sign
*  sign   signSize B        Sign of [txHash, outN, OUTS]
*
*  Out format
*  address      25 B        Address of receiver
*  value         8 B        Amount in micoins
*/

const R = require('ramda')

const helper = require('./helper')
const hours = require('./Hours')
const storage = require('./Storage')
const Packet = require('./Packet')
const blockchain = require('./Blockchain')
const BlockHelper = require('./BlockHelper')
const Address = require('./Address')

const MIN_CONFIRMATIONS = 30

if (!storage.freeTxs) {
  storage.freeTxs = {}
}

var lastValidationError = null
var lastFee = null

const functions = {
  packHashOutN: (txIn) => {
    return Packet().packFixed(txIn.txHash).packNumber(txIn.outN, 4).get()
  },
  packOuts: (txOuts) => {
    let packet = Packet()
    R.forEach((txOut) => {
      packet.packFixed(txOut.address).packNumber64(txOut.value)
    }, txOuts)
    return packet.get()
  },
  pack: (data) => {
    let packet = Packet().packNumber64(data.time).packNumber(data.txKeys.length, 4).packNumber(data.txIns.length, 4).packNumber(data.txOutCount, 4)
    R.forEach((txKey) => {
      packet.packFixed(txKey.publicKey)
    }, data.txKeys)
    R.forEach((txIn) => {
      packet.packFixed(txIn.txHash).packNumber(txIn.outN, 4).packNumber(txIn.keyId, 4).packDynamic(txIn.sign)
    }, data.txIns)
    packet.packFixed(data.txOutsRaw)
    return packet.get()
  },
  attachHash: (hash, data) => {
    return Buffer.concat([hash, data])
  },
  getHash: (data) => {
    return data.slice(0, 32)
  },
  detachHash: (data) => {
    return data.slice(32)
  },
  unpack: (data) => {
    let res = {}
    try {
      res.time = Packet(data.slice(0, 8)).unpackNumber64()
      res.txKeyCount = data.readUInt32BE(8)
      res.txInCount = data.readUInt32BE(12)
      res.txOutCount = data.readUInt32BE(16)
      
      res.txKeys = []
      let pos = 20
      for (let i = 0; i < res.txKeyCount; i++) {
        let txKey = {}
        txKey.publicKey = data.slice(pos, pos += 65)
        res.txKeys.push(txKey)
      }
      
      res.txIns = []
      for (let i = 0; i < res.txInCount; i++) {
        let txIn = {}
        txIn.txHash = data.slice(pos, pos += 32)
        txIn.outN = data.readUInt32BE(pos)
        txIn.keyId = data.readUInt32BE(pos += 4)
        txIn.signSize = data.readUInt8(pos += 4)
        txIn.sign = data.slice(pos += 1, pos += txIn.signSize)
        res.txIns.push(txIn)
      }
      
      res.txOuts = []
      res.txOutsRaw = data.slice(pos)
      for (let i = 0; i < res.txOutCount; i++) {
        let txOut = {}
        txOut.address = data.slice(pos, pos += 25)
        txOut.value = Packet(data.slice(pos, pos += 8)).unpackNumber64()
        res.txOuts.push(txOut)
      }
      
      if (pos < data.length) {
        return false
      }
    } catch (e) {
      return false
    }
    return res
  },
  get: (hash, id = null) => {
    return blockchain.eachTo(id === null ? blockchain.getLength() : id, (block) => {
      let txHashList = BlockHelper.unpackHashList(block.data)
      for (let i in txHashList) {
        if (hash.equals(txHashList[i])) {
          return {blockId: block.id, blockHash: block.hash, data: BlockHelper.unpack(block.data).txList[i]}
        }
      }
    })
  },
  getAddressBalanceUnconfirmed: (address) => {
    let balance = 0
    let txs = []
    for (let i in storage.freeTxs) {
      let freeTx = storage.freeTxs[i] && storage.freeTxs[i].data && helper.baseToBuf(storage.freeTxs[i].data)
      if (freeTx) {
        let txUnpacked = functions.unpack(freeTx)
        for (let t in txUnpacked.txOuts) {
          t = parseInt(t)
          let txOut = txUnpacked.txOuts[t]
          if (txOut.address.equals(address)) {
            balance += txOut.value
            txs.push({hash: helper.hexToBuf(i), outN: t, value: txOut.value})
          }
        }
      }
    }
    return {balance: balance, txs: txs}
  },
  known: (hash, id = null) => {
    return blockchain.eachTo(id === null ? blockchain.getLength() : id, (block) => {
      let txHashList = BlockHelper.unpackHashList(block.data)
      for (let i in txHashList) {
        if (hash.equals(txHashList[i])) {
          return true
        }
      }
    })
  },
  isOutSpent: (hash, outN) => {
    for (let i in storage.session.blockchain.spends) {
      let spend = storage.session.blockchain.spends[i]
      if (spend[1].equals(hash) && (spend[2] === outN)) {
        return {blockId: spend[0], txHash: spend[3]}
      }
    }
    return null
  },
  isOutSpentFreeTxs: (hash, outN) => {
    for (let t in storage.freeTxs) {
      let txData = functions.unpack(helper.baseToBuf(storage.freeTxs[t].data))
      for (let x in txData.txIns) {
        let freeTxIn = txData.txIns[x]
        if ((freeTxIn.txHash.equals(hash))
          && (freeTxIn.outN === outN)) {
          return true
        }
      }
    }
    return false
  },
  isValid: (hash, tx, blockInfo, id, isFirstBlockTx, callback, notFirstBlockTxsFee = 0, unpacked = null) => {
    lastValidationError = null
    lastFee = null
    let txUnpacked = unpacked || functions.unpack(tx)
    if (!txUnpacked) {
      lastValidationError = 'Unpack failed'
      callback(false)
      return
    }
    
    // hash
    let calcedHash = helper.hash(tx)
    if (!calcedHash.equals(hash)) {
      lastValidationError = 'Wrong hash'
      callback(false)
      return
    }
    
    // time
    if (txUnpacked.time > hours.now() + 60) {
      lastValidationError = 'Wrong time: ' + txUnpacked.time + ', ' + hours.now()
      callback(false)
      return
    }
    
    // ins
    let txInSum = 0
    let txOutSum = 0
    let toVerify = []
    helper.processList(txUnpacked.txIns, {
      onProcess: (item, callback, toReturn, i) => {
        i = parseInt(i)
        let txIn = txUnpacked.txIns[i]
        let txWithOut = functions.get(txIn.txHash, id).data
        
        // out exists
        if (!txWithOut) {
          lastValidationError = 'Tx in IN ' + i + ' not exists'
          toReturn()
        }
        
        // prevent double spend
        for (let t = i + 1; t < txUnpacked.txInCount; t++) {
          t = parseInt(t)
          if ((txIn.txHash.equals(txUnpacked.txIns[t].txHash))
            && (txIn.outN === txUnpacked.txIns[t].outN)) {
            lastValidationError = 'Double spend, ins ' + i + ', ' + t
            toReturn()
          }
        }
        // block tx must have no collisions with block txs
        if (blockInfo) {
          let blockCurTxId = blockInfo.blockCurTxId
          let blockOtherTxs = blockInfo.blockOtherTxs
          for (let t in blockOtherTxs) {
            t = parseInt(t)
            let txData = blockOtherTxs[t]
            for (let x in txData.txIns) {
              let blockTxIn = txData.txIns[x]
              if ((txIn.txHash.equals(blockTxIn.txHash))
                && (txIn.outN === blockTxIn.outN)) {
                if (blockCurTxId !== t) {
                  toReturn()
                }
              }
            }
          }
        // free tx must have no collisions with other free txs
        } else {
          for (let t in storage.freeTxs) {
            let txData = functions.unpack(helper.baseToBuf(storage.freeTxs[t].data))
            for (let x in txData.txIns) {
              let freeTxIn = txData.txIns[x]
              if ((txIn.txHash.equals(freeTxIn.txHash))
                && (txIn.outN === freeTxIn.outN)) {
                lastValidationError = 'Double spend with free txs'
                toReturn()
              }
            }
          }
        }
        
        // out not spent
        if (functions.isOutSpent(txIn.txHash, txIn.outN, id)) {
          lastValidationError = 'Out ' + txIn.outN + ' is spent'
          toReturn()
        }
        
        // public key -> address
        let txWithOutUnpacked = functions.unpack(txWithOut)
        let publicKey = txUnpacked.txKeys[txIn.keyId].publicKey
        let addressFromKey = helper.publicToAddress(publicKey)
        if (!addressFromKey.equals(txWithOutUnpacked.txOuts[txIn.outN].address)) {
          lastValidationError = 'Public key does not match with address'
          toReturn()
        }
        txInSum += txWithOutUnpacked.txOuts[txIn.outN].value
        
        let toSign = Buffer.concat([functions.packHashOutN(txIn), txUnpacked.txOutsRaw])
        toVerify.push({toSign: toSign, publicKey: publicKey, sign: Buffer.concat([txIn.sign])})
        
        setTimeout(() => {
          callback()
        }, 100)
      },
      onReady: () => {
        helper.processList(toVerify, {
          onProcess: (item, callback, toReturn) => {
            helper.verifySign(item.toSign, item.publicKey, item.sign, (valid) => {
              if (valid) {
                callback()
              } else {
                toReturn()
              }
            })
          },
          onReady: () => {
            // outs
            for (let i in txUnpacked.txOuts) {
              i = parseInt(i)
              let txOut = txUnpacked.txOuts[i]
              
              // address
              if (!Address.isValid(txOut.address)) {
                lastValidationError = 'Wrong address at out ' + i
                callback(false)
                return
              }
              
              // amount
              if (txOut.value <= 0) {
                lastValidationError = 'Wrong amount at out ' + i
                callback(false)
                return
              }
              txOutSum += txOut.value
            }
            
            if (isFirstBlockTx) {
              // ins count
              if (txUnpacked.txInCount > 0) {
                lastValidationError = 'First tx must have no ins'
                callback(false)
                return
              }
              
              // outs count
              if (txUnpacked.txOutCount !== 1) {
                lastValidationError = 'First tx must have only one out'
                callback(false)
                return
              }
              
              if (txOutSum !== BlockHelper.calcReward(id) + notFirstBlockTxsFee) {
                lastValidationError = 'Wrong amount of reward'
                callback(false)
                return
              }
              
              callback(true, 0)
            } else {
              // fee
              if (txInSum < txOutSum) {
                lastValidationError = 'ins < outs'
                callback(false)
                return
              }
              
              callback(true, txInSum - txOutSum)
            }
          },
          onReturn: () => {
            lastValidationError = 'Wrong sign of in'
            callback(false)
          }
        })
      },
      onReturn: () => {
        callback(false)
      }
    })
  },
  getError: () => {
    return lastValidationError
  },
  freeTxAdd: (hash, data, fee) => {
    let hashHex = helper.bufToHex(hash)
    if (!storage.freeTxs[hashHex]) {
      storage.freeTxs[hashHex] = {t: helper.unixTime(), fee: fee, data: helper.bufToBase(data)}
    }
    for (let i in storage.freeTxs) {
      let freeTx = storage.freeTxs[i]
      if (freeTx && (freeTx.t < helper.unixTime() - 600)) {
        delete storage.freeTxs[i]
      }
    }
  },
  freeTxDelete: (hash) => {
    if (storage.freeTxs[helper.bufToHex(hash)]) {
      delete storage.freeTxs[helper.bufToHex(hash)]
      return true
    } else {
      return false
    }
  }
}
module.exports = functions
module.exports.MIN_CONFIRMATIONS = MIN_CONFIRMATIONS