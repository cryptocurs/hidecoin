'use strict'

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
    
    setInterval(() => {
      this.update({time: hours.now()})
    }, 10000)
  }
  
  update(data) {
    if (this.block && this.blockPacked && this.blockPackedHeader) {
      Block.set(this.blockPacked, data)
      Block.set(this.blockPackedHeader, data)
      for (let i in data) {
        this.block[i] = data[i]
      }
      this.block.nonce = 0
      this.log('Updated', data)
    }
  }
  
  restart() {
    this.doRestart = true
  }
  
  run(minerAddresses = null) {
    if (minerAddresses) {
      this.minerAddresses = minerAddresses
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
    
    for (let i in storage.freeTxs) {
      let freeTx = storage.freeTxs[i]
      if (freeTx) {
        txHashList.push(helper.hexToBuf(i))
        txList.push(helper.baseToBuf(freeTx.data))
        feeSum += freeTx.fee
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
    
    let hash = null
    helper.asyncWhile(() => {
      for (let i = 0; i < 1000; i++) {
        if (storage.session.forkProcessor || storage.session.synchronizing) {
          this.doRestart = true
          return false
        }
        if (this.doRestart) {
          return false
        }
        storage.session.stat && (storage.session.stat.hps !== undefined) && storage.session.stat.hps++
        this.block.nonce++
        Block.set(this.blockPackedHeader, {
          nonce: this.block.nonce
        })
        hash = Block.calcHash(this.blockPackedHeader)
        if (hash) {
          return false
        }
        return true
      }
    }, {
      after: () => {
        if (this.doRestart) {
          this.doRestart = false
          if (storage.session.forkProcessor || storage.session.synchronizing) {
            setTimeout(() => {
              this.run()
            }, 5000)
            return
          }
          setTimeout(() => {
            this.run()
          }, 1)
          return
        }
        this.log('{bold}{green-fg}!!! BLOCK FOUND !!!{/green-fg}{/bold}')
        this.log('{bold}' + hash.toString('hex') + '{/bold}')
        Block.set(this.blockPacked, {
          nonce: this.block.nonce
        })
        synchronizer.add(hash, this.blockPacked, {
          onAccept: () => {
            synchronizer.broadcast(hash, this.blockPacked)
            let deleted = 0
            for (let i in txHashList) {
              if (Tx.freeTxDelete(txHashList[i])) {
                deleted++
              }
            }
            this.log('Free txs used: ' + deleted)
          }
        })
        
        this.trigger('blockFound', this.blockPacked, hash)
        setTimeout(() => {
          this.run()
        }, 1)
      }
    })
  }
}