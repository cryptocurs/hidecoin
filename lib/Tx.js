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
const PacketBig = require('./PacketBig')
const blockchain = require('./Blockchain')
const BlockHelper = require('./BlockHelper')
const Address = require('./Address')

const MIN_CONFIRMATIONS = 30
const ERR_NULL = 'null'
const ERR_TOO_BIG = 'Too big'
const ERR_UNPACK_FAILED = 'Unpack failed'
const ERR_WRONG_HASH = 'Wrong hash'
const ERR_WRONG_TIME = 'Wrong time'
const ERR_IN_NOT_EXISTS = 'IN does not exist'
const ERR_DOUBLE_SPEND = 'Double spend'
const ERR_DOUBLE_SPEND_IN_ONE_BLOCK = 'Double spend in one block'
const ERR_DOUBLE_SPEND_WITH_FREE_TXS = 'Double spend with free txs'
const ERR_OUT_SPENT = 'OUT spent'
const ERR_OUT_UNPACK_FAILED = 'OUT unpack failed'
const ERR_OUT_NOT_EXISTS = 'OUT does not exist'
const ERR_PUBLIC_NOT_MATCHES_ADDR = 'Public key does not match address'
const ERR_WRONG_ADDRESS_AT_OUT = 'Wrong address at OUT'
const ERR_WRONG_AMOUNT_AT_OUT = 'Wrong amount at OUT'
const ERR_FIRST_TX_HAS_IN = 'First tx has IN'
const ERR_FIRST_TX_HAS_EXTRA_OR_NO_OUT = 'First tx has extra or no OUT'
const ERR_WRONG_AMOUNT_OF_REWARD = 'Wrong amount of reward'
const ERR_WRONG_FEE = 'Wrong fee'
const ERR_WRONG_SIGN_OF_IN = 'Wrong sign of IN'

if (!storage.freeTxs) {
  storage.freeTxs = {}
}

const functions = {
  packHashOutN: (txIn) => {
    return Packet().packFixed(txIn.txHash).packNumber(txIn.outN, 4).get()
  },
  packOuts: (txOuts) => {
    let packet = PacketBig()
    R.forEach((txOut) => {
      packet.packFixed(txOut.address).packNumber64(txOut.value)
    }, txOuts)
    return packet.get()
  },
  pack: (data) => {
    let packet = PacketBig().packNumber64(data.time).packNumber(data.txKeys.length, 4).packNumber(data.txIns.length, 4).packNumber(data.txOutCount, 4)
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
    const {txMap} = storage.session.blockchain
    for (const i in txMap) {
      if (id !== null && txMap[i][0] >= id) {
        return false
      }
      if (hash.equals(txMap[i][1])) {
        const block = blockchain.get(txMap[i][0])
        const txHashList = BlockHelper.unpackHashList(block.data)
        for (const t in txHashList) {
          if (hash.equals(txHashList[t])) {
            return {blockId: block.id, blockHash: block.hash, data: BlockHelper.unpack(block.data).txList[t]}
          }
        }
      }
    }
    return false
  },
  getOld: (hash, id = null) => {
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
  known: (hash) => {
    const {txMap} = storage.session.blockchain
    for (const i in txMap) {
      if (hash.equals(txMap[i][1])) {
        return true
      }
    }
    return false
  },
  isOutSpentOld: (hash, outN, id = null) => {
    for (let i in storage.session.blockchain.spends) {
      let spend = storage.session.blockchain.spends[i]
      if ((!id || (spend[0] < id)) && spend[1].equals(hash) && (spend[2] === outN)) {
        return {blockId: spend[0], txHash: spend[3]}
      }
    }
    return null
  },
  isOutSpent: (hash, outN, id = null) => {
    const indexes = helper.sortedIndexesOf(storage.session.blockchain.spends, [, hash], helper.bufferCompare.bind(this, 1))
    for (let i in indexes) {
      const index = indexes[i]
      const spend = storage.session.blockchain.spends[index]
      if (spend[2] === outN) {
        return {blockId: spend[0], txHash: spend[3]}
      }
    }
    return null
  },
  isOutSpentAfterBlock: (id, hash, outN) => {
    for (let i in storage.session.blockchain.spends) {
      let spend = storage.session.blockchain.spends[i]
      if ((spend[0] > id) && (spend[2] === outN) && spend[1].equals(hash)) {
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
  calcFee: (txSize) => {
    return txSize * storage.config.minerMinimalFeePerByte
  },
  isValid: (hash, tx, blockInfo, id, isFirstBlockTx, callback, notFirstBlockTxsFee = 0, unpacked = null, excludeFreeTxHex = null) => {
    let lastValidationError = null
    
    // length <= 786432
    const txSize = tx.length
    if (txSize > 786432) {
      callback(false, ERR_TOO_BIG, {size: txSize})
      return
    }
    
    // txUnpacked !== false
    let txUnpacked = unpacked || functions.unpack(tx)
    if (!txUnpacked) {
      callback(false, ERR_UNPACK_FAILED)
      return
    }
    
    // hash
    let calcedHash = helper.hash(tx)
    if (!calcedHash.equals(hash)) {
      callback(false, ERR_WRONG_HASH)
      return
    }
    
    // time
    if (txUnpacked.time > hours.now() + 60) {
      callback(false, ERR_WRONG_TIME)
      return
    }
    
    // ins
    let txInSum = 0
    let txOutSum = 0
    let toVerify = []
    helper.processListSync(txUnpacked.txIns, {
      onProcess: (item, callback, toReturn, i) => {
        i = parseInt(i)
        let txIn = txUnpacked.txIns[i]
        let txWithOutInfo = functions.get(txIn.txHash, id)
        
        // out exists
        if (!txWithOutInfo) {
          lastValidationError = {type: ERR_IN_NOT_EXISTS, params: {txIn: i}}
          toReturn()
          return
        }
        const txWithOut = txWithOutInfo.data
        
        // prevent double spend
        for (let t = i + 1; t < txUnpacked.txInCount; t++) {
          t = parseInt(t)
          if ((txIn.txHash.equals(txUnpacked.txIns[t].txHash))
            && (txIn.outN === txUnpacked.txIns[t].outN)) {
            lastValidationError = {type: ERR_DOUBLE_SPEND, params: {hash: txIn.txHash, outN: txIn.outN, txIns: [i, t]}}
            toReturn()
            return
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
                  lastValidationError = {type: ERR_DOUBLE_SPEND_IN_ONE_BLOCK}
                  toReturn()
                  return
                }
              }
            }
          }
        // free tx must have no collisions with other free txs
        } else {
          for (let t in storage.freeTxs) {
            if (t === excludeFreeTxHex) {
              continue
            }
            let txData = functions.unpack(helper.baseToBuf(storage.freeTxs[t].data))
            for (let x in txData.txIns) {
              let freeTxIn = txData.txIns[x]
              if ((txIn.txHash.equals(freeTxIn.txHash))
                && (txIn.outN === freeTxIn.outN)) {
                lastValidationError = {type: ERR_DOUBLE_SPEND_WITH_FREE_TXS}
                toReturn()
                return
              }
            }
          }
        }
        
        // out not spent
        if (functions.isOutSpent(txIn.txHash, txIn.outN, id)) {
          lastValidationError = {type: ERR_OUT_SPENT, params: {outN: txIn.outN}}
          toReturn()
          return
        }
        
        // public key -> address
        let txWithOutUnpacked = functions.unpack(txWithOut)
        if (!txWithOutUnpacked) {
          lastValidationError = {type: ERR_OUT_UNPACK_FAILED}
          toReturn()
          return
        }
        let publicKey = txUnpacked.txKeys[txIn.keyId].publicKey
        let addressFromKey = helper.publicToAddress(publicKey)
        if (!txWithOutUnpacked.txOuts[txIn.outN]) {
          lastValidationError = {type: ERR_OUT_NOT_EXISTS, params: {outN: txIn.outN}}
          toReturn()
          return
        }
        if (!addressFromKey.equals(txWithOutUnpacked.txOuts[txIn.outN].address)) {
          lastValidationError = {type: ERR_PUBLIC_NOT_MATCHES_ADDR}
          toReturn()
          return
        }
        txInSum += txWithOutUnpacked.txOuts[txIn.outN].value
        
        const toSign = Buffer.concat([functions.packHashOutN(txIn), txUnpacked.txOutsRaw])
        toVerify.push({toSign, publicKey, sign: Buffer.concat([txIn.sign])})
        
        if (toVerify.length % 100) {
          callback()
        } else {
          setTimeout(() => {
            callback()
          }, 10)
        }
      },
      onReady: () => {
        helper.processListSync(toVerify, {
          onProcess: (item, callback, toReturn, i) => {
            helper.verifySign(item.toSign, item.publicKey, item.sign, (valid) => {
              if (valid) {
                if (i % 100) {
                  callback()
                } else {
                  setTimeout(() => {
                    callback()
                  }, 10)
                }
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
                callback(false, ERR_WRONG_ADDRESS_AT_OUT, {txOut: i})
                return
              }
              
              // amount
              if (txOut.value <= 0) {
                callback(false, ERR_WRONG_AMOUNT_AT_OUT, {txOut: i})
                return
              }
              txOutSum += txOut.value
            }
            
            if (isFirstBlockTx) {
              // ins count
              if (txUnpacked.txInCount > 0) {
                callback(false, ERR_FIRST_TX_HAS_IN, {txInCount: txUnpacked.txInCount})
                return
              }
              
              // outs count
              if (txUnpacked.txOutCount !== 1) {
                callback(false, ERR_FIRST_TX_HAS_EXTRA_OR_NO_OUT, {txOutCount: txUnpacked.txOutCount})
                return
              }
              
              const reward = BlockHelper.calcReward(id)
              if (txOutSum !== reward + notFirstBlockTxsFee) {
                callback(false, ERR_WRONG_AMOUNT_OF_REWARD, {current: txOutSum, basic: reward, fees: notFirstBlockTxsFee})
                return
              }
              
              callback(true, {type: ERR_NULL}, {fee: 0})
            } else {
              // fee
              const fee = txInSum - txOutSum
              if (fee < 0) {
                callback(false, ERR_WRONG_FEE, {fee})
                return
              }
              
              callback(true, {type: ERR_NULL}, {fee})
            }
          },
          onReturn: () => {
            callback(false, {type: ERR_WRONG_SIGN_OF_IN})
          }
        })
      },
      onReturn: () => {
        callback(false, lastValidationError.type, lastValidationError.params)
      }
    })
  },
  freeTxAdd: (hash, data, fee) => {
    const hashHex = helper.bufToHex(hash)
    if (!storage.freeTxs[hashHex]) {
      storage.freeTxs[hashHex] = {t: helper.unixTime(), fee, data: helper.bufToBase(data)}
    }
    for (let i in storage.freeTxs) {
      const freeTx = storage.freeTxs[i]
      if (freeTx && (freeTx.t < helper.unixTime() - 1800)) {
        delete storage.freeTxs[i]
      }
    }
    storage.trigger('freeTxAdd')
  },
  freeTxDelete: (hash, isHex = false) => {
    const hashHex = isHex ? hash : helper.bufToHex(hash)
    let deleted = false
    if (storage.freeTxs[hashHex]) {
      delete storage.freeTxs[hashHex]
      deleted = true
      storage.trigger('freeTxDelete')
    }
    return deleted
  },
  freeTxKnown: (hash) => {
    return !!storage.freeTxs[helper.bufToHex(hash)]
  }
}
module.exports = functions
module.exports.MIN_CONFIRMATIONS = MIN_CONFIRMATIONS
module.exports.ERR_NULL = ERR_NULL
module.exports.ERR_TOO_BIG = ERR_TOO_BIG
module.exports.ERR_UNPACK_FAILED = ERR_UNPACK_FAILED
module.exports.ERR_WRONG_HASH = ERR_WRONG_HASH
module.exports.ERR_WRONG_TIME = ERR_WRONG_TIME
module.exports.ERR_IN_NOT_EXISTS = ERR_IN_NOT_EXISTS
module.exports.ERR_DOUBLE_SPEND = ERR_DOUBLE_SPEND
module.exports.ERR_DOUBLE_SPEND_IN_ONE_BLOCK = ERR_DOUBLE_SPEND_IN_ONE_BLOCK
module.exports.ERR_DOUBLE_SPEND_WITH_FREE_TXS = ERR_DOUBLE_SPEND_WITH_FREE_TXS
module.exports.ERR_OUT_SPENT = ERR_OUT_SPENT
module.exports.ERR_OUT_UNPACK_FAILED = ERR_OUT_UNPACK_FAILED
module.exports.ERR_OUT_NOT_EXISTS = ERR_OUT_NOT_EXISTS
module.exports.ERR_PUBLIC_NOT_MATCHES_ADDR = ERR_PUBLIC_NOT_MATCHES_ADDR
module.exports.ERR_WRONG_ADDRESS_AT_OUT = ERR_WRONG_ADDRESS_AT_OUT
module.exports.ERR_WRONG_AMOUNT_AT_OUT = ERR_WRONG_AMOUNT_AT_OUT
module.exports.ERR_FIRST_TX_HAS_IN = ERR_FIRST_TX_HAS_IN
module.exports.ERR_FIRST_TX_HAS_EXTRA_OR_NO_OUT = ERR_FIRST_TX_HAS_EXTRA_OR_NO_OUT
module.exports.ERR_WRONG_AMOUNT_OF_REWARD = ERR_WRONG_AMOUNT_OF_REWARD
module.exports.ERR_WRONG_FEE = ERR_WRONG_FEE
module.exports.ERR_WRONG_SIGN_OF_IN = ERR_WRONG_SIGN_OF_IN