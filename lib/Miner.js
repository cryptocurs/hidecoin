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
    
    setInterval(() => {
      this.update({time: hours.now()})
    }, 10000)
    
    storage.on('minerBlockFound', (hashData, blockData, txHashList, callback) => {
      const hash = helper.baseToBuf(hashData)
      const block = helper.baseToBuf(blockData)
      storage.trigger('log', 'MNR', moment().format('YYYY-MM-DD HH:mm:ss'))
      storage.trigger('log', 'MNR', 'FOUND BLOCK', hash.toString('hex'))
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
          storage.trigger('log', 'MNR', 'Free txs used: ' + deleted)
          callback('accepted')
        },
        onReject: () => {
          callback('rejected')
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
    if (!this.minerAddresses) {
      return
    }
    if (storage.session.forkProcessor || storage.session.synchronizing) {
      setTimeout(() => {
        this.run()
      }, 5000)
      return
    }
    this.log('>>> New block mining <<<')
    var currentBlockId = blockchain.getLength()
    this.lastBlockId = currentBlockId - 1
    var lastBlock = blockchain.get(this.lastBlockId)
    this.lastBlockHash = lastBlock.hash
    this.lastBlock = Block.unpack(lastBlock.data)
    
    var txHashList = []
    var txList = []
    var feeSum = 0
    var size = 85
    
    for (let i in storage.freeTxs) {
      let freeTx = storage.freeTxs[i]
      if (freeTx) {
        const txHash = helper.hexToBuf(i)
        const txData = helper.baseToBuf(freeTx.data)
        const txSize = txData.length + 32
        if (txSize <= 49152 - size) {
          txHashList.push(txHash)
          txList.push(txData)
          feeSum += freeTx.fee
          size += txSize
        }
      }
    }
    var txOuts = [{address: helper.randomItem(this.minerAddresses), value: BlockHelper.calcReward(blockchain.getLength()) + feeSum}]
    
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
    
    this.log('There are ' + txHashList.length + ' txs in block')
    
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
      }, txHashList)
    }
  }
}