'use strict'

const moment = require('moment')
const R = require('ramda')

const Component = require('./Component')
const helper = require('./helper')
const hours = require('./Hours')
const storage = require('./Storage')
const blockchain = require('./Blockchain')
const synchronizer = require('./Synchronizer')
const Block = require('./Block')
const BlockHelper = require('./BlockHelper')
const Tx = require('./Tx')

module.exports = new class Miner extends Component {

  constructor() {
    super()
    this.module = 'MNR'
    this.minerAddresses = null
    this.lastBlock = null
    this.lastBlockId = null
    this.lastBlockHash = null
    this.block = null
    this.blockPacked = null
    this.blockPackedHeader = null
    this.doRestart = false
    this.rejectBlocks = false
    this.running = false
    
    setInterval(() => {
      this.update({time: hours.now()})
    }, 10000)
    
    storage.on('minerBlockFound', (hashData, blockData, txHashList, callback) => {
      if (this.rejectBlocks) {
        callback('rejected')
        return
      }
      const hash = helper.baseToBuf(hashData)
      const block = helper.baseToBuf(blockData)
      this.logBy('FND', moment().format('YYYY-MM-DD HH:mm:ss'))
      this.logBy('FND', 'FOUND BLOCK', hash.toString('hex'))
      this.rejectBlocks = true
      storage.miningTask.active = 0
      setTimeout(() => {
        this.rejectBlocks = false
        storage.miningTask.active = 1
      }, 10000)
      synchronizer.add(hash, block, {
        onAccept: () => {
          txHashList = R.map((hash) => {
            return helper.baseToBuf(hash)
          }, txHashList)
          synchronizer.broadcast(hash, block)
          let deleted = 0
          for (let i in txHashList) {
            if (Tx.freeTxDelete(txHashList[i])) {
              deleted++
            }
          }
          this.logBy('FND', 'Free txs used: ' + deleted)
          callback('accepted')
        },
        onReject: (err, info) => {
          let msg = 'rejected: ' + err
          if (err === Block.ERR_WRONG_TX) {
            const {index, hash} = info
            if (index > 0) {
              msg += '. Free tx ' + helper.bufToHex(hash)
              if (!Tx.freeTxDelete(hash)) {
                msg += ' already'
              }
              msg += ' deleted'
            }
          }
          callback(msg)
        },
        onKnown: () => {
          callback('known')
        }
      })
      this.restart()
    })
    
    storage.on('minerRestart', () => {
      this.restart()
    })
    
    storage.on('getBlockConfirmationsCount', (hash, callback) => {
      callback(Block.getConfirmationsCount(helper.baseToBuf(hash)))
    })
  }
  
  update(data) {
    if (this.block && this.blockPacked && this.blockPackedHeader) {
      Block.set(this.blockPacked, data)
      Block.set(this.blockPackedHeader, data)
      for (let i in data) {
        this.block[i] = data[i]
      }
      this.block.nonce = 0
      
      if (storage.miningTask) {
        storage.miningTask.blockHeaderSize = this.blockPackedHeader.length
        storage.miningTask.blockData = helper.bufToBase(this.blockPacked)
      }
      
      this.log('Updated', data)
    }
  }
  
  restart() {
    this.run()
  }
  
  run(minerAddresses = null) {
    if (minerAddresses) {
      this.minerAddresses = minerAddresses
    }
    if (this.running || !this.minerAddresses) {
      return
    }
    if (storage.session.forkProcessor || storage.session.synchronizing) {
      setTimeout(() => {
        this.run()
      }, 5000)
      return
    }
    this.running = true
    
    var currentBlockId = blockchain.getLength()
    this.lastBlockId = currentBlockId - 1
    var lastBlock = blockchain.get(this.lastBlockId)
    this.lastBlockHash = lastBlock.hash
    this.lastBlock = Block.unpack(lastBlock.data)
    
    var txHashList = []
    var txList = []
    var feeSum = 0
    var size = 85
    
    const hashes = R.keys(storage.freeTxs)
    const txsCount = hashes.length
    txsCount && this.log('Validating', txsCount, 'txs...')
    helper.processListSync(hashes, {
      onProcess: (item, callback, toReturn, i) => {
        if (storage.freeTxs[item]) {
          const txData = helper.baseToBuf(storage.freeTxs[item].data)
          this.logAlias('minerValidatingTxs', 'Validating tx ' + i + '/' + txsCount + ' (' + helper.sizeToStr(txData.length) + ')...')
          Tx.isValid(helper.hexToBuf(item), txData, null, blockchain.getLength(), false, (valid, err) => {
            if (!valid) {
              if (Tx.freeTxDelete(item, true)) {
                this.log('Free tx ' + item + ' deleted: ' + err)
              }
            }
            callback()
          }, 0, null, item)
        } else {
          callback()
        }
      },
      onReady: () => {
        if (txsCount) {
          this.logAliasClear('minerValidatingTxs')
          this.log('Txs validated. Creating block...')
        }
        for (let i in storage.freeTxs) {
          let freeTx = storage.freeTxs[i]
          if (freeTx) {
            const txHash = helper.hexToBuf(i)
            const txData = helper.baseToBuf(freeTx.data)
            const txSize = txData.length + 36 // 4 bytes for length
            if (txSize <= 1048576 - size) {
              txHashList.push(txHash)
              txList.push(txData)
              feeSum += freeTx.fee
              size += txSize
            }
          }
        }
        const reward = BlockHelper.calcReward(blockchain.getLength()) + feeSum
        var txOuts = [{address: helper.randomItem(this.minerAddresses), value: reward}]
        
        var tx = {
          time: hours.now(),
          txKeys: [],
          txIns: [],
          txOutCount: txOuts.length,
          txOutsRaw: Tx.packOuts(txOuts)
        }
        var txPacked = Tx.pack(tx)
        txHashList.unshift(helper.hash(txPacked))
        txList.unshift(txPacked)
        
        this.log('{green-fg}New block mining (' + txHashList.length + ' txs){/green-fg}')
        
        this.block = {
          ver: 2,
          prevBlock: this.lastBlockHash,
          time: hours.now(),
          diff: Block.calcDiff(currentBlockId, this.lastBlock.diff, Block.getByTimeCount(this.lastBlock.time - 3600, this.lastBlock.time)),
          nonce: 0,
          txList: txList,
          txHashList: txHashList
        }
        const packed = Block.pack(this.block)
        this.blockPacked = packed.entire
        this.blockPackedHeader = packed.header
        
        storage.miningTask = {
          active: 1,
          blockHeaderSize: this.blockPackedHeader.length,
          blockData: helper.bufToBase(this.blockPacked),
          txHashList: R.map((hash) => {
            return helper.bufToBase(hash)
          }, txHashList),
          reward
        }
        
        this.log('{green-fg}Mining task is ready{/green-fg}')
        
        storage.session.stat.txs = txHashList.length
        storage.session.stat.bsz = this.blockPacked.length
        
        this.running = false
      }
    })
  }
}