'use strict'

/* Work with blocks
*  Block format
*
*  hash         32 B        Header hash
*  --------------- HEADER ---------------
*  ver           1 B        Block version
*  prevBlock    32 B        Hash of previous block
*  time          8 B        Time of generation (+- 5 sec.)
*  diff         32 B        Maximum value of header hash
*  nonce         8 B        Nonce
*  txCount       4 B        Count of transactions (tx)
*  txHashList 32 * txCount  List of tx hashes
*  --------------------------------------
*  transactions with size (for fast reading) and without hash field
*/

const R = require('ramda')

const helper = require('./helper')
const hours = require('./Hours')
const PacketBig = require('./PacketBig')
const blockchain = require('./Blockchain')
const BlockHelper = require('./BlockHelper')
const Tx = require('./Tx')

var lastValidationError = null

const functions = {
  // Pack, unpack, update and work with hashes
  pack: (data) => {
    const packet = PacketBig().packNumber(data.ver, 1).packFixed(data.prevBlock).packNumber64(data.time).packFixed(data.diff).packNumber64(data.nonce)
    packet.packNumber(data.txList.length, 4)
    R.forEach((hash) => {
      packet.packFixed(hash)
    }, data.txHashList)
    const header = Buffer.from(packet.get())
    
    R.forEach((tx) => {
      packet.packNumber(tx.length, 4).packFixed(tx)
    }, data.txList)
    return {header: header, entire: packet.get()}
  },
  set: (buffer, data) => {
    if (data.prevBlock !== undefined) {
      data.prevBlock.copy(buffer, 1)
    }
    if (data.time !== undefined) {
      PacketBig().packNumber64(data.time).get().copy(buffer, 33)
    }
    if (data.diff !== undefined) {
      data.diff.copy(buffer, 41)
    }
    if (data.nonce !== undefined) {
      PacketBig().packNumber64(data.nonce).get().copy(buffer, 73)
    }
  },
  calcHash: (data) => {
    const hash = helper.hash(data)
    return (hash.compare(data.slice(41, 73)) > 0 ? false : hash)
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
    return BlockHelper.unpack(data)
  },
  unpackPrevBlock: (data) => {
    return data.slice(1, 33)
  },
  unpackTime: (data) => {
    return PacketBig(data.slice(33, 41)).unpackNumber64()
  },
  unpackDiff: (data) => {
    return data.slice(41, 73)
  },
  unpackHashList: (data) => {
    return BlockHelper.unpackHashList(data)
  },
  // Get
  getLast: () => {
    var lastId = blockchain.getLength() - 1
    if (lastId === -1) {
      return false
    } else {
      var lastBlock = blockchain.get(lastId)
      return {id: lastId, hash: lastBlock.hash, data: lastBlock.data}
    }
  },
  getByTimeCount: (from, to) => {
    var count = 0
    var max = blockchain.getLength() - 1
    for (let i = max; i >= 0; i--) {
      const time = functions.unpackTime(blockchain.get(i).data)
      if (time < from) {
        break
      } else if ((time >= from) && (time <= to)) {
        count++
      }
    }
    return count
  },
  getWithBuffer: (field, value) => {
    return blockchain.each((block) => {
      if (functions.unpack(block.data)[field].equals(value)) {
        return block
      }
    })
  },
  // Properties and validation
  getAddressBalance: (address, id = null) => {
    const maxId = (id === null ? blockchain.getLength() : id)
    let balance = 0
    let txs = []
    blockchain.eachTo(maxId, (block) => {
      const blockUnpacked = functions.unpack(block.data)
      for (let i in blockUnpacked.txList) {
        const tx = blockUnpacked.txList[i]
        const txHash = blockUnpacked.txHashList[i]
        const txUnpacked = Tx.unpack(tx)
        for (let t in txUnpacked.txOuts) {
          t = parseInt(t)
          const txOut = txUnpacked.txOuts[t]
          if (txOut.address.equals(address)) {
            const txWithOutSpent = Tx.isOutSpent(txHash, t)
            const txWithOutSpentFreeTxs = Tx.isOutSpentFreeTxs(txHash, t)
            txs.push({blockId: block.id, blockTime: blockUnpacked.time, hash: txHash, outN: t, value: txOut.value, spent: txWithOutSpent, spentFreeTxs: txWithOutSpentFreeTxs, confirmations: maxId - block.id})
            if (!txWithOutSpent && !txWithOutSpentFreeTxs) {
              balance += txOut.value
            }
          }
        }
      }
    })
    return {balance: balance, txs: txs}
  },
  getAddressBalanceSep: (address, id = null) => {
    const maxId = (id === null ? blockchain.getLength() : id)
    let balanceSoft = 0
    let balanceHard = 0
    let txsSoft = []
    let txsHard = []
    blockchain.eachTo(maxId, (block) => {
      const blockUnpacked = functions.unpack(block.data)
      for (let i in blockUnpacked.txList) {
        const tx = blockUnpacked.txList[i]
        const txHash = blockUnpacked.txHashList[i]
        const txUnpacked = Tx.unpack(tx)
        for (let t in txUnpacked.txOuts) {
          t = parseInt(t)
          const txOut = txUnpacked.txOuts[t]
          if (txOut.address.equals(address)) {
            const txWithOutSpent = Tx.isOutSpent(txHash, t)
            const txWithOutSpentFreeTxs = Tx.isOutSpentFreeTxs(txHash, t)
            const confirmations = maxId - block.id
            if (confirmations < Tx.MIN_CONFIRMATIONS) {
              txsSoft.push({blockId: block.id, blockTime: blockUnpacked.time, hash: txHash, outN: t, value: txOut.value, spent: txWithOutSpent, spentFreeTxs: txWithOutSpentFreeTxs, confirmations: confirmations})
            } else {
              txsHard.push({blockId: block.id, blockTime: blockUnpacked.time, hash: txHash, outN: t, value: txOut.value, spent: txWithOutSpent, spentFreeTxs: txWithOutSpentFreeTxs, confirmations: confirmations})
            }
            if (!txWithOutSpent && !txWithOutSpentFreeTxs) {
              if (confirmations < Tx.MIN_CONFIRMATIONS) {
                balanceSoft += txOut.value
              } else {
                balanceHard += txOut.value
              }
            }
          }
        }
      }
    })
    return {balanceSoft: balanceSoft, balanceHard: balanceHard, txsSoft: txsSoft, txsHard: txsHard}
  },
  getAddressesBalance: (addresses, id = null) => {
    const maxId = (id === null ? blockchain.getLength() : id)
    let balance = 0
    let txs = []
    blockchain.eachTo(maxId, (block) => {
      const blockUnpacked = functions.unpack(block.data)
      for (let i in blockUnpacked.txList) {
        const tx = blockUnpacked.txList[i]
        const txHash = blockUnpacked.txHashList[i]
        const txUnpacked = Tx.unpack(tx)
        for (let t in txUnpacked.txOuts) {
          t = parseInt(t)
          const txOut = txUnpacked.txOuts[t]
          if (R.contains(txOut.address, addresses)) {
            const txWithOutSpent = Tx.isOutSpent(txHash, t)
            const txWithOutSpentFreeTxs = Tx.isOutSpentFreeTxs(txHash, t)
            txs.push({blockId: block.id, blockTime: blockUnpacked.time, hash: txHash, outN: t, address: txOut.address, value: txOut.value, spent: txWithOutSpent, spentFreeTxs: txWithOutSpentFreeTxs, confirmations: maxId - block.id})
            if (!txWithOutSpent && !txWithOutSpentFreeTxs) {
              balance += txOut.value
            }
          }
        }
      }
    })
    return {balance: balance, txs: txs}
  },
  // id - ID of current block
  calcDiff: (id, prevDiff, blocksCount) => {
    if (!(id % 60)) {
      if ((blocksCount > 70) && (prevDiff.compare(Buffer.from('000000000000000000000000000000000000000000000000000000000000FFFF', 'hex')) > 0)) {
        return helper.shiftBuffer(prevDiff)
      } else if ((blocksCount < 50) && (prevDiff.compare(Buffer.from('000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex')) < 0)) {
        return helper.unshiftBuffer(prevDiff, true)
      }
    }
    return prevDiff
  },
  known: (hash) => {
    return blockchain.known(hash)
  },
  isValidNew: (hash, packed, callback, promiscuous = false) => {
    const lastBlock = functions.getLast()
    functions.isValidExisting(lastBlock ? lastBlock.id + 1 : 0, hash, packed, callback, lastBlock, promiscuous)
  },
  // id - ID of current block. If it is new block, then id=last.id+1
  isValidExisting: (id, hash, packed, callback, prepared = null, promiscuous = false) => {
    lastValidationError = null
    
    // length <= 49152
    if (packed.length > 49152) {
      lastValidationError = 'Too big block'
      callback(false)
      return
    }
    
    const lastBlock = id ? prepared || blockchain.get(id - 1) : {hash: Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex')}
    
    // unpacked !== false
    const unpacked = functions.unpack(packed)
    if (!unpacked) {
      lastValidationError = 'Unpack failed, reason: ' + BlockHelper.getError()
      callback(false)
      return
    }
    
    // ver === 1 or ver === 2
    if ((unpacked.ver !== 1) && (unpacked.ver !== 2)) {
      lastValidationError = 'Wrong version'
      callback(false)
      return
    }
    
    // hash
    const calcedHash = helper.hash(unpacked.ver === 1 ? packed : unpacked.headerRaw)
    if (!calcedHash.equals(hash)) {
      lastValidationError = 'Wrong hash'
      callback(false)
      return
    }
    
    // prevBlock
    if (!unpacked.prevBlock.equals(lastBlock.hash)) {
      lastValidationError = 'Wrong prevBlock'
      callback(false)
      return
    }
    
    // time
    const lastBlockUnpacked = lastBlock.data ? functions.unpack(lastBlock.data) : false
    if (lastBlockUnpacked && ((unpacked.time < lastBlockUnpacked.time - 60) || (unpacked.time > hours.now() + 60))) {
      lastValidationError = 'Wrong time: ' + lastBlockUnpacked.time + ', ' + unpacked.time + ', ' + hours.now()
      callback(false)
      return
    }
    
    // diff
    if (lastBlockUnpacked && !unpacked.diff.equals(functions.calcDiff(id, lastBlockUnpacked.diff, functions.getByTimeCount(lastBlockUnpacked.time - 3600, lastBlockUnpacked.time)))
      || !lastBlockUnpacked && !unpacked.diff.equals(Buffer.from('000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex'))) {
      lastValidationError = 'Wrong diff'
      callback(false)
      return
    }
    
    // hash <= diff
    if (hash.compare(unpacked.diff) > 0) {
      lastValidationError = 'Hash > diff'
      callback(false)
      return
    }
    
    // tx
    let checked = 0
    let txUnpackedList = []
    for (let i in unpacked.txList) {
      txUnpackedList.push(Tx.unpack(unpacked.txList[i]))
    }
    
    if (promiscuous) {
      callback(true, unpacked, txUnpackedList)
      return
    }
    
    const toCheck = unpacked.txCount - 1
    let notFirstBlockTxsFee = 0
    let stopChecking = false
    
    let checkFirstTx = () => {
      Tx.isValid(unpacked.txHashList[0], unpacked.txList[0], {blockCurTxId: 0, blockOtherTxs: txUnpackedList}, id, true, (valid) => {
        if (valid) {
          callback(true, unpacked, txUnpackedList)
        } else {
          lastValidationError = 'Wrong tx 0: ' + Tx.getError()
          callback(false)
          stopChecking = true
        }
      }, notFirstBlockTxsFee, txUnpackedList[0])
    }
    
    for (let i = toCheck; i > 0; i--) {
      Tx.isValid(unpacked.txHashList[i], unpacked.txList[i], {blockCurTxId: i, blockOtherTxs: txUnpackedList}, id, false, (valid, fee) => {
        if (valid) {
          checked++
          notFirstBlockTxsFee += fee
        } else {
          lastValidationError = 'Wrong tx ' + i + ': ' + Tx.getError()
          callback(false)
          stopChecking = true
        }
        if (checked === toCheck) {
          checkFirstTx()
        }
      }, 0, txUnpackedList[i])
      if (stopChecking) {
        return
      }
    }
    toCheck || checkFirstTx()
  },
  getError: () => {
    return lastValidationError
  }
}
module.exports = functions