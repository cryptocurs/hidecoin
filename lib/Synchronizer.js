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
    storage.session.synchronizing = false
    storage.session.isPackSynchronizing = false
    storage.session.forkHashes = []
    storage.session.syncSpeed = 5
    
    setInterval(() => {
      if (storage.session.stat) {
        storage.session.stat.blk = blockchain.getLength()
      }
    }, 10000)
    
    setInterval(() => {
      if (this.firstSynchronized && !this.blockSyncTimer && !this.blockCheckTimer && !storage.session.synchronizing && !storage.session.forkProcessor) {
        this.log('{yellow-fg}Scheduled synchronization{/yellow-fg}')
        this.remoteInternal()
      }
    }, 90000)
    
    this.module = 'SNC'
    this.promiscuous = false
    this.working = false
    this.firstSynchronized = false
    this.callback = null
    
    this.maxReceivedBlockId = -1
    
    this.blockCheckTimer = null
    this.blockSyncTimer = null
    
    this.waitForMultipartId = null
    
    this.remoteInternal = () => {
      if (storage.session.forkProcessor) {
        return true
      }
      if (this.blockSyncTimer || this.blockCheckTimer) {
        return true
      }
      storage.session.synchronizing = true
      storage.session.stat.sncColor = this.firstSynchronized ? 'yellow' : 'red'
      
      this.log('Synchronizing...')
      this.blockSyncTimer = setTimeout(this.blockSyncTimeout, 15000)
      let len = blockchain.getLength()
      let lastHash = len ? blockchain.get(len - 1).hash : Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex')
      if (storage.session.isPackSynchronizing) {
        storage.session.isPackSynchronizing = false
        net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_BLOCKS_AFTER, {hash: lastHash, count: 512}), true, storage.session.syncSpeed)
      } else {
        net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_BLOCK_AFTER, {hash: lastHash}), true, storage.session.syncSpeed)
      }
      return true
    }
    
    this.blockCheckTimeout = () => {
      this.blockCheckTimer = null
      
      this.remoteInternal()
      /*
      if (this.maxReceivedBlockId >= blockchain.getLength() - 1) {
        // regressive synchronization
        this.log('Regressive synchronization')
        storage.session.blockchain.knowns = {}
        blockchain.removeLast(() => {
          this.cacheDeleteBlock(blockchain.getLength())
          this.remoteInternal()
        })
      } else {
        this.remoteInternal()
      }
      */
    }
    this.blockSyncTimeout = () => {
      this.blockSyncTimer = null
      this.maxReceivedBlockId = -1
      this.log('Request last block info')
      net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_LAST_BLOCK_INFO), true)
      if (!this.blockCheckTimer) {
        this.blockCheckTimer = setTimeout(this.blockCheckTimeout, 15000)
      }
    }
    
    net.on('multipartRcvdFirst', (multipartId, data, callback) => {
      if (!storage.session.multipartHeaders) {
        storage.session.multipartHeaders = []
      }
      for (let i in storage.session.multipartHeaders) {
        const header = storage.session.multipartHeaders[i]
        if (header.t < helper.unixTime() - 300) {
          delete storage.session.multipartHeaders[i]
        } else if (header.data.equals(data)) {
          this.log('{red-fg}Multi-part transfer rejected: KNOWN{/red-fg}')
          callback(false)
          return
        }
      }
      this.log('{green-fg}Multi-part transfer allowed{/green-fg}')
      storage.session.multipartHeaders.push({data: data, t: helper.unixTime()})
      
      clearTimeout(this.blockSyncTimer)
      this.blockSyncTimer = null
      this.waitForMultipartId = multipartId
      
      callback(true)
    })
    
    net.on('multipartRcvTimeout', (multipartId) => {
      if (this.waitForMultipartId === multipartId) {
        this.log('{red-fg}Multi-part transfer timed out{/red-fg}')
        this.remoteInternal()
      }
    })
    
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
        //this.log('Received block after. KNOWN CACHE', _.size(storage.session.blockchain.knowns))
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
      if (this.promiscuous) {
        this.log('Received block after. {red-fg}Fast validating{/red-fg}')
      } else {
        this.log('Received block after. Validating')
      }
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
            this.log('{cyan-fg}Fast synchronization{/cyan-fg}')
            storage.session.isPackSynchronizing = true
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
    net.on('blocksAfterRcvd', (afterHash, blocks, blocksCount) => {
      if (!this.waitForMultipartId) {
        return
      }
      
      this.waitForMultipartId = null
      
      this.log('Received', blocksCount, 'blocks')
      helper.processList(blocks, {
        onProcess: (item, callback, toReturn, i) => {
          this.logAlias('blocksAfter', 'Validating ' + i + '/' + blocksCount)
          this.add(item.hash, item.data, {
            onKnown: () => {
              this.logAlias('blocksAfter', 'Validated block. KNOWN')
              callback()
            },
            onAccept: (unpacked) => {
              this.trigger('blockAfterAccept', afterHash, item.hash, item.data, unpacked)
              this.logAlias('blocksAfter', 'Validated block. ACCEPT')
              callback()
            },
            onReject: () => {
              this.logAlias('blocksAfter', 'Validated block. REJECT')
              toReturn()
            }
          })
        },
        onReady: () => {
          this.log('Blocks validated')
          this.logAliasClear('blocksAfter')
          this.remoteInternal()
        },
        onReturn: () => {
          this.log('One of blocks is rejected')
          this.logAliasClear('blocksAfter')
          this.remoteInternal()
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
        this.log('{red-fg}!!! FORK !!!{/red-fg} {yellow-fg}+' + (len - blockchain.getLength()) + ' blocks{/yellow-fg}')
        storage.session.forkHashes.push(lastBlockHash)
        forkProcessor.run(port, address, (res) => {
          if (res) {
            this.remoteInternal()
          } else {
            this.log('Regressive synchronization')
            storage.session.blockchain.knowns = {}
            blockchain.removeLast(() => {
              this.cacheDeleteBlock(blockchain.getLength())
              this.remoteInternal()
            })
          }
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
        storage.session.multipartHeaders = []
        this.firstSynchronized = true
        
        storage.session.synchronizing = false
        storage.session.stat.sncColor = 'white'
        storage.trigger('minerRestart')
        
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
        //this.log('Received block found. KNOWN CACHE', _.size(storage.session.blockchain.knowns))
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
          if (!storage.session.synchronizing) {
            this.remoteInternal()
          }
        }
      })
    })
    net.on('txInfoRcvd', (hash, tx) => {
      this.log('TX_INFO validating')
      Tx.isValid(hash, tx, null, blockchain.getLength(), false, (valid, fee) => {
        if (valid) {
          this.log('TX_INFO validated')
          this.trigger('txInfoAccept', hash, tx, fee)
        } else {
          this.log('TX_INFO rejected', Tx.getError())
        }
      })
    })
    
    forkProcessor.on('add', (hash, block, callbacks) => {
      this.add(hash, block, {
        onKnown: () => {
          callbacks.onKnown && callbacks.onKnown()
        },
        onAccept: (unpacked) => {
          callbacks.onAccept && callbacks.onAccept()
          this.trigger('blockFoundAccept', hash, block, unpacked)
        },
        onReject: () => {
          callbacks.onReject && callbacks.onReject()
        }
      }, true)
    })
  }
  
  add(hash, data, callbacks, ignoreForkProcessor = false) {
    if (!ignoreForkProcessor && storage.session.forkProcessor || this.working) {
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
        }, this.promiscuous)
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
  
  setPromiscuous(promiscuous) {
    this.promiscuous = promiscuous
  }
  
  isPromiscuous() {
    return this.promiscuous
  }
}

const synchronizer = new Synchronizer()
module.exports = synchronizer