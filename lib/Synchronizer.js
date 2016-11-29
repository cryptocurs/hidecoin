'use strict'

const R = require('ramda')
const _ = require('lodash')

const Component = require('./Component')
const helper = require('./helper')
const storage = require('./Storage')
const CmdPacker = require('./CmdPacker')
const net = require('./Net')
const Block = require('./Block')
const Tx = require('./Tx')
const blockchain = require('./Blockchain')
const forkProcessor = require('./ForkProcessor')

class Synchronizer extends Component {

  constructor() {
    super()
    
    if (!storage.session.blockchain) {
      storage.session.blockchain = {spends: [], knowns: {}}
    }
    storage.session.forkHashes = []
    storage.session.syncSpeed = 5
    
    setInterval(() => {
      storage.trigger('stat', {blk: blockchain.getLength()})
    }, 10000)
    
    this.module = 'SNC'
    this.working = false
    this.firstSynchronized = false
    this.synchronizing = false
    this.callback = null
    
    this.maxReceivedBlockId = -1
    
    this.blockCheckTimer = null
    this.blockSyncTimer = null
    
    this.remoteInternal = () => {
      if (storage.session.forkProcessor) {
        return true
      }
      if (this.blockSyncTimer) {
        return true
      }
      this.synchronizing = true
      storage.trigger('stat', {sncColor: this.firstSynchronized ? 'yellow' : 'red'})
      
      this.log('Synchronizing...')
      this.blockSyncTimer = setTimeout(this.blockSyncTimeout, 5000)
      let len = blockchain.getLength()
      let lastHash = len ? blockchain.get(len - 1).hash : Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex')
      net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_BLOCK_AFTER, {hash: lastHash}), true, storage.session.syncSpeed)
      return true
    }
    
    this.blockCheckTimeout = () => {
      this.blockCheckTimer = null
      
      if (this.maxReceivedBlockId >= blockchain.getLength() - 1) {
        // regressive synchronization
        /*
        this.log('Regressive synchronization')
        storage.session.blockchain.knowns = {}
        blockchain.removeLast(() => {
          this.cacheDeleteBlock(blockchain.getLength())
          this.remoteInternal()
        })
        */
      } else {
        this.remoteInternal()
      }
    }
    this.blockSyncTimeout = () => {
      this.blockSyncTimer = null
      this.maxReceivedBlockId = -1
      this.log('Request last block info')
      net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_LAST_BLOCK_INFO), true)
      if (!this.blockCheckTimer) {
        this.blockCheckTimer = setTimeout(this.blockCheckTimeout, 10000)
      }
    }
    
    net.on('blockAfterRcvd', (afterHash, hash, block) => {
      if (storage.session.forkProcessor) {
        return
      }
      if (!this.blockSyncTimer) {
        return
      }
      if (this.blockCheckTimer) {
        clearTimeout(this.blockCheckTimer)
        this.blockCheckTimer = null
      }
      
      const hashBased = helper.bufToBase(hash)
      if (storage.session.blockchain.knowns[hashBased]) {
        this.log('Received block after. KNOWN CACHE', _.size(storage.session.blockchain.knowns))
        return
      }
      const localTime = helper.unixTime()
      storage.session.blockchain.knowns[hashBased] = localTime
      for (let i in storage.session.blockchain.knowns) {
        if (storage.session.blockchain.knowns[i] < localTime - 30) {
          delete storage.session.blockchain.knowns[i]
        }
      }
      
      clearTimeout(this.blockSyncTimer)
      this.blockSyncTimer = null
      this.log('Received block after. Validating')
      this.add(hash, block, {
        onKnown: () => {
          this.log('Validated block after. KNOWN')
          process.nextTick(() => {
            this.remoteInternal()
          })
        },
        onAccept: (unpacked) => {
          this.trigger('blockAfterAccept', afterHash, hash, block, unpacked)
          this.log('Validated block after. ACCEPT')
          process.nextTick(() => {
            this.remoteInternal()
          })
        },
        onReject: () => {
          this.log('Validated block after. REJECT')
          process.nextTick(() => {
            this.remoteInternal()
          })
        }
      })
    })
    net.on('blockAfterNoBlock', (hash, len, lastBlockHash, port, address) => {
      if (storage.session.forkProcessor) {
        return
      }
      if (R.contains(lastBlockHash, storage.session.forkHashes)) {
        return
      }
      if (len >= blockchain.getLength()) {
        this.log('{red-fg}!!! FORK !!!{/red-fg}')
        storage.session.forkHashes.push(lastBlockHash)
        forkProcessor.run(port, address, (res) => {
          
        })
      }
    })
    net.on('blockAfterNoBlockAfter', (hash) => {
      if (storage.session.forkProcessor) {
        return
      }
      this.log('No block after', hash.toString('hex'))
    })
    net.on('lastBlockInfoRcvd', (id, hash) => {
      if (storage.session.forkProcessor) {
        return
      }
      let lastBlock = Block.getLast()
      if (!lastBlock) {
        storage.trigger('fatalError', 'Error in blockchain while synchronizing')
      }
      if (id > this.maxReceivedBlockId) {
        this.maxReceivedBlockId = id
      }
      if (this.blockCheckTimer && hash.equals(lastBlock.hash)) {
        this.log('Received last block info. ACCEPT')
        clearTimeout(this.blockCheckTimer)
        this.blockCheckTimer = null
        storage.session.blockchain.knowns = {}
        this.firstSynchronized = true
        
        this.synchronizing = false
        storage.trigger('stat', {sncColor: 'white'})
        
        this.callback && this.callback()
        this.callback = null
      } else {
        this.log('Received last block info. REJECT')
      }
    })
    net.on('blockFoundRcvd', (hash, block) => {
      if (storage.session.forkProcessor) {
        return
      }
      if (!this.firstSynchronized) {
        this.log('Received block found. NOT SYNC YET')
        return
      }
      const hashBased = helper.bufToBase(hash)
      if (storage.session.blockchain.knowns[hashBased]) {
        this.log('Received block found. KNOWN CACHE', _.size(storage.session.blockchain.knowns))
        return
      }
      const localTime = helper.unixTime()
      storage.session.blockchain.knowns[hashBased] = localTime
      for (let i in storage.session.blockchain.knowns) {
        if (storage.session.blockchain.knowns[i] < localTime - 30) {
          delete storage.session.blockchain.knowns[i]
        }
      }
      
      this.add(hash, block, {
        onKnown: () => {
          this.log('Received block found. KNOWN')
        },
        onAccept: (unpacked) => {
          this.log('Received block found. ACCEPT')
          this.trigger('blockFoundAccept', hash, block, unpacked)
        },
        onReject: () => {
          this.log('Received block found. REJECT')
          if (!this.synchronizing) {
            this.remoteInternal()
          }
        }
      })
    })
    net.on('txInfoRcvd', (hash, tx) => {
      Tx.isValid(hash, tx, null, blockchain.getLength(), false, (valid, fee) => {
        if (valid) {
          this.trigger('txInfoAccept', hash, tx, fee)
        } else {
          this.log('TX_INFO rejected', Tx.getError())
        }
      })
    })
  }
  
  add(hash, data, callbacks) {
    if (storage.session.forkProcessor) {
      return
    }
    if (this.working) {
      setTimeout(() => {
        this.add(hash, data, callbacks)
      }, 1)
    } else {
      if (Block.known(hash)) {
        callbacks && callbacks.onKnown && callbacks.onKnown()
      } else {
        this.working = true
        let length = blockchain.getLength()
        Block.isValidNew(hash, data, (valid, unpacked, txUnpackedList) => {
          if (length === blockchain.getLength()) {
            if (valid) {
              this.cacheNewTxs(length, unpacked.txHashList, txUnpackedList)
              blockchain.add(hash, data, () => {
                this.working = false
                callbacks && callbacks.onAccept && callbacks.onAccept(unpacked)
              })
            } else {
              this.working = false
              this.log('Block rejected, reason: ' + Block.getError())
              callbacks && callbacks.onReject && callbacks.onReject()
            }
          } else {
            this.working = false
            this.add(hash, data, callbacks)
          }
        })
      }
    }
  }
  
  remote(callback) {
    if (callback) {
      this.callback = callback
    }
    return this.remoteInternal()
  }
  
  cache() {
    blockchain.each((block) => {
      let blockUnpacked = Block.unpack(block.data)
      for (let i in blockUnpacked.txList) {
        let tx = blockUnpacked.txList[i]
        let txUnpacked = Tx.unpack(tx)
        for (let t in txUnpacked.txIns) {
          let txIn = txUnpacked.txIns[t]
          storage.session.blockchain.spends.push([block.id, txIn.txHash, txIn.outN, blockUnpacked.txHashList[i]])
        }
      }
    })
  }
  
  cacheNewTxs(blockId, txHashList, txUnpackedList) {
    for (let i in txUnpackedList) {
      let txUnpacked = txUnpackedList[i]
      for (let t in txUnpacked.txIns) {
        let txIn = txUnpacked.txIns[t]
        storage.session.blockchain.spends.push([blockId, txIn.txHash, txIn.outN, txHashList[i]])
      }
    }
  }
  
  cacheDeleteBlock(id) {
    storage.session.blockchain.spends = R.filter(block => block[0] !== id, storage.session.blockchain.spends) 
  }
  
  broadcast(hash, block) {
    net.broadcast(CmdPacker.pack(CmdPacker.CMD_BLOCK_FOUND, {hash: hash, block: block}))
  }
  
  broadcastTx(hash, tx) {
    net.broadcast(CmdPacker.pack(CmdPacker.CMD_TX_INFO, {hash: hash, tx: tx}))
  }
  
  isReady() {
    return this.firstSynchronized
  }
}

const synchronizer = new Synchronizer()
module.exports = synchronizer