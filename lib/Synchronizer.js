'use strict'

const R = require('ramda')
const _ = require('lodash')

const Component = require('./Component')
const disp = require('./Disp')
const dispTask = require('./DispTask')
const helper = require('./helper')
const storage = require('./Storage')
const CmdPacker = require('./CmdPacker')
const net = require('./Net')
const Block = require('./Block')
const Tx = require('./Tx')
const blockchain = require('./Blockchain')
const forkProcessor = require('./ForkProcessor')

const BLOCK_SYNC_TIMEOUT = 4000

class Synchronizer extends Component {

  constructor() {
    super()
    
    if (!storage.session.blockchain) {
      storage.session.blockchain = {spends: [], knowns: {}, txMap: []}
    }
    storage.session.synchronizing = false
    storage.session.isPackSynchronizing = true
    storage.session.validating = false
    storage.session.forkHashes = []
    storage.session.forkServers = {}
    storage.session.syncSpeed = 5
    
    if (disp.isMaster()) {
      setTimeout(() => {
        this.requestNetInfoBlockchainLength()
      }, 5000)
      setInterval(() => {
        this.requestNetInfoBlockchainLength()
        setTimeout(() => {
          if (this.lastBlockAcceptedAt < helper.unixTime() - 300 || (blockchain.getLength() < storage.session.netInfoBlockchainLength || this.lastScheduled < helper.unixTime() - 60) && this.firstSynchronized && !this.blockSyncTimer && !this.blockCheckTimer && !storage.session.synchronizing && !storage.session.forkProcessor) {
            this.log('{yellow-fg}Scheduled synchronization{/yellow-fg}')
            this.lastScheduled = helper.unixTime()
            this.remoteInternal()
          }
        }, 5000)
      }, 30000)
    }
    
    this.module = 'SNC'
    this.promiscuous = true
    this.working = false
    this.firstSynchronized = false
    this.lastScheduled = helper.unixTime()
    this.lastBlockInfoRejected = false
    this.lastBlockAcceptedAt = helper.unixTime()
    this.callback = null
    
    this.maxReceivedBlockId = -1
    
    this.blockCheckTimer = null
    this.blockSyncTimer = null
    this.blockMultipartTimer = null
    
    this.rejectNewBlocks = false
    this.waitForMultipartId = null
    this.notZippedCount = 0
    
    this.netInfoBlockchainLengths = {}
    
    this.blocksFoundKnown = 0
    this.blocksFoundAccepted = 0
    this.blocksFoundRejected = 0
    
    this.setBlockSyncTimer = () => {
      this.blockSyncTimer = setTimeout(this.blockSyncTimeout, BLOCK_SYNC_TIMEOUT)
    }
    
    this.clearBlockSyncTimer = () => {
      if (this.blockSyncTimer) {
        clearTimeout(this.blockSyncTimer)
        this.blockSyncTimer = null
        return true
      } else {
        return false
      }
    }
    
    this.remoteInternal = () => {
      if (!disp.isMaster() || this.blockSyncTimer || this.blockCheckTimer || storage.session.validating || storage.session.forkProcessor || this.waitForMultipartId) {
        return true
      }
      this.rejectNewBlocks = false
      this.waitForMultipartId = null
      this.notZippedCount = 0
      storage.session.synchronizing = true
      storage.session.stat.sncColor = this.firstSynchronized ? 'yellow' : 'red'
      
      this.log('Synchronizing...')
      let len = blockchain.getLength()
      let lastHash = len ? blockchain.get(len - 1).hash : Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex')
      this.setBlockSyncTimer()
      if (storage.session.isPackSynchronizing) {
        this.log('Requesting block packet after', lastHash.toString('hex'))
        // storage.session.isPackSynchronizing = false
        net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_BLOCKS_AFTER, {flags: [CmdPacker.FLAG_ZIP_ALLOWED], hash: lastHash, count: 256}), true, storage.session.syncSpeed)
      } else {
        this.log('Requesting block after', lastHash.toString('hex'))
        net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_BLOCK_AFTER, {hash: lastHash}), true, storage.session.syncSpeed)
      }
      return true
    }
    
    this.runForkProcessor = ({port, address}) => {
      forkProcessor.run(port, address, (res) => {
        if (res) {
          this.remoteInternal()
        } else {
          this.log('Regressive synchronization')
          storage.session.blockchain.knowns = {}
          disp.lock('block', () => {
            blockchain.removeLast(() => {
              this.cacheDeleteBlocks()
              disp.unlock('block')
              this.remoteInternal()
            })
          })
        }
      })
    }
    
    this.blockCheckTimeout = () => {
      this.blockCheckTimer = null
      if (this.lastBlockInfoRejected) {
        this.remoteInternal()
      } else {
        this.acceptLastBlock()
      }
    }
    this.blockSyncTimeout = () => {
      this.blockSyncTimer = null
      this.maxReceivedBlockId = -1
      if (storage.session.netInfoBlockchainLength && blockchain.getLength() < storage.session.netInfoBlockchainLength) {
        this.log('{red-fg}Blockchain length is less than probable length{/red-fg}')
        this.remoteInternal()
      } else {
        this.log('Requesting last block info...')
        net.broadcast(CmdPacker.pack(CmdPacker.CMD_REQUEST_LAST_BLOCK_INFO), true)
        if (!this.blockCheckTimer) {
          this.lastBlockInfoRejected = false
          this.blockCheckTimer = setTimeout(this.blockCheckTimeout, 2000)
        }
      }
    }
    
    this.blockMultipartTimeout = () => {
      this.blockMultipartTimer = null
      this.log('{red-fg}MPX timed out{/red-fg}')
      this.rejectNewBlocks = false
      this.waitForMultipartId = null
      this.remoteInternal()
    }
    
    this.acceptLastBlock = () => {
      clearTimeout(this.blockCheckTimer)
      this.blockCheckTimer = null
      storage.session.blockchain.knowns = {}
      storage.session.multipartHeaders = []
      if (!this.firstSynchronized && storage.config.minerMode) {
        this.setPromiscuous(false)
        this.log('{red-fg}Promiscuous mode OFF{/red-fg}')
      }
      this.firstSynchronized = true
      
      storage.session.synchronizing = false
      storage.session.stat.sncColor = 'white'
      storage.trigger('minerRestart')
      
      this.callback && this.callback()
      this.callback = null
    }
    
    net.on('multipartRcvdFirst', (multipartId, data, callback) => {
      this.log('{yellow-fg}MPX for ' + CmdPacker.toStr(data[0]) + ' requested{/yellow-fg}')
      const isNewBlocks = R.contains(data[0], [CmdPacker.CMD_TAKE_BLOCK_AFTER, CmdPacker.CMD_TAKE_BLOCKS_AFTER, CmdPacker.CMD_BLOCK_FOUND])
      if (this.rejectNewBlocks && isNewBlocks) {
        this.log('{red-fg}MPX ' + multipartId + ' rejected: RECEIVING{/red-fg}')
        callback(false)
        return
      }
      if (this.notZippedCount < 3 && data[0] === CmdPacker.CMD_TAKE_BLOCKS_AFTER) {
        const flags = data.readUInt8(1)
        if (!CmdPacker.isFlagSet(flags, CmdPacker.FLAG_ZIPPED)) {
          this.notZippedCount++
          this.log('{red-fg}MPX ' + multipartId + ' rejected: NOT ZIPPED{/red-fg}')
          callback(false)
          return
        }
      }
      
      if (!storage.session.multipartHeaders) {
        storage.session.multipartHeaders = []
      }
      for (let i in storage.session.multipartHeaders) {
        const header = storage.session.multipartHeaders[i]
        if (header.t < helper.unixTime() - 10) {
          delete storage.session.multipartHeaders[i]
        } else if (header.data.equals(data)) {
          this.log('{red-fg}MPX ' + multipartId + ' rejected: KNOWN{/red-fg}')
          callback(false)
          return
        }
      }
      this.log('{green-fg}MPX ' + multipartId + ' allowed{/green-fg}')
      storage.session.multipartHeaders.push({data: data, t: helper.unixTime()})
      
      if (isNewBlocks && !this.waitForMultipartId) {
        this.clearBlockSyncTimer()
        this.rejectNewBlocks = true
        this.waitForMultipartId = multipartId
        this.log('{cyan-fg}Waiting for MPX ' + multipartId + '{/cyan-fg}')
        this.blockMultipartTimer = setTimeout(this.blockMultipartTimeout, 60000)
      }
      
      callback(true)
    })
    
    net.on('multipartRcvTimeout', (multipartId) => {
      this.blockMultipartTimer && clearTimeout(this.blockMultipartTimer)
      this.blockMultipartTimer = null
      if (this.waitForMultipartId === multipartId) {
        this.log('{red-fg}MPX timed out{/red-fg}')
        this.rejectNewBlocks = false
        this.waitForMultipartId = null
        this.remoteInternal()
      }
    })
    
    net.on('blockAfterRcvd', (afterHash, hash, block, multipartId) => {
      if (!storage.session.synchronizing || storage.session.forkProcessor) {
        return
      }
      
      if (!this.waitForMultipartId && !this.blockSyncTimer) {
        return
      }
      if (this.waitForMultipartId) {
        if (this.waitForMultipartId !== multipartId) {
          return
        }
        this.rejectNewBlocks = false
        this.waitForMultipartId = null
        
        this.blockMultipartTimer && clearTimeout(this.blockMultipartTimer)
        this.blockMultipartTimer = null
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
      
      if (this.promiscuous) {
        this.log('Received block after. {red-fg}Fast validating{/red-fg}')
      } else {
        this.log('Received block after. Validating')
      }
      this.clearBlockSyncTimer()
      this.add(hash, block, {
        onKnown: () => {
          this.log('Validated block after. KNOWN')
          this.remoteInternal()
        },
        onAccept: (unpacked) => {
          this.trigger('blockAfterAccept', afterHash, hash, block, unpacked)
          this.log('Validated block after. ACCEPT')
          this.log('{cyan-fg}Fast synchronization{/cyan-fg}')
          // storage.session.isPackSynchronizing = true
          this.remoteInternal()
        },
        onReject: (err) => {
          if (storage.localSession.lastValidationErrors) {
            storage.localSession.lastValidationErrors.push(err)
            storage.localSession.lastValidationErrors = storage.localSession.lastValidationErrors.slice(-15)
          } else {
            storage.localSession.lastValidationErrors = [err]
          }
          this.log('Validated block after. REJECT')
          this.remoteInternal()
        }
      })
    })
    net.on('blocksAfterRcvd', (afterHash, blocks, blocksCount, multipartId, zipped) => {
      if (!this.waitForMultipartId && !this.blockSyncTimer) {
        return
      }
      if (!this.clearBlockSyncTimer()) {
        if (this.waitForMultipartId !== multipartId) {
          return
        }
        this.waitForMultipartId = null
      }
      
      this.log('Received', blocksCount, 'blocks' + (zipped ? ' +Z' : ''))
      storage.session.validating = true
      helper.processListSync(blocks, {
        onProcess: (item, callback, toReturn, i) => {
          this.logAlias('blocksAfter', 'Validating block ' + i + '/' + blocksCount + ' (' + helper.sizeToStr(item.data.length) + ')...')
          setTimeout(() => {
            this.add(item.hash, item.data, {
              onKnown: () => {
                //this.logAlias('blocksAfter', 'Validated block ' + i + '/' + blocksCount + '. KNOWN')
                callback()
              },
              onAccept: (unpacked) => {
                this.trigger('blockAfterAccept', afterHash, item.hash, item.data, unpacked)
                callback()
              },
              onReject: () => {
                //this.logAlias('blocksAfter', 'Validated block ' + i + '/' + blocksCount + '. REJECT')
                toReturn()
              }
            })
          }, 10)
        },
        onReady: () => {
          this.log('Blocks validated')
          this.logAliasClear('blocksAfter')
          this.rejectNewBlocks = false
          storage.session.validating = false
          this.remoteInternal()
        },
        onReturn: () => {
          this.log('One of blocks is rejected')
          this.logAliasClear('blocksAfter')
          this.rejectNewBlocks = false
          storage.session.validating = false
          this.remoteInternal()
        }
      })
    })
    net.on('blockAfterNoBlock', (hash, len, lastBlockHash, port, address) => {
      if (!storage.session.synchronizing || storage.session.forkProcessor) {
        return
      }
      if (R.contains(lastBlockHash, storage.session.forkHashes)) {
        return
      }
      const localTime = helper.unixTime()
      for (const addr in storage.session.forkServers) {
        if (storage.session.forkServers[addr].usedAt < localTime - 1800) {
          delete storage.session.forkServers[addr]
        }
      }
      if (storage.session.forkServers[address]) {
        return
      }
      // this.log('No block with hash', hash.toString('hex'), len)
      if (len >= blockchain.getLength()) {
        this.log('{red-fg}!!! FORK !!!{/red-fg} {yellow-fg}+' + (len - blockchain.getLength()) + ' blocks{/yellow-fg}')
        storage.session.forkHashes.push(lastBlockHash)
        storage.session.forkServers[address] = {usedAt: localTime}
        this.runForkProcessor({port, address})
      }
    })
    net.on('blockAfterNoBlockAfter', (hash) => {
      if (!storage.session.synchronizing || storage.session.forkProcessor) {
        return
      }
      // this.log('No block after', hash.toString('hex'))
    })
    net.on('lastBlockInfoRcvd', (id, hash) => {
      if (!storage.session.synchronizing || storage.session.forkProcessor) {
        return
      }
      let lastBlock = Block.getLast()
      if (!lastBlock) {
        //storage.trigger('fatalError', 'Error in blockchain while synchronizing')
        return
      }
      if (id > this.maxReceivedBlockId) {
        this.maxReceivedBlockId = id
      }
      if (!this.blockCheckTimer) {
        //this.log('Received last block info. UNWANTED')
      } else if (hash.equals(lastBlock.hash)) {
        this.log('Received last block info. ACCEPT')
        this.acceptLastBlock()
      } else if (id >= lastBlock.id) {
        this.lastBlockInfoRejected = true
        this.log('Received last block info. REJECT')
      } else {
        this.log('Received last block info. IGNORE')
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
          this.blocksFoundKnown++
          //this.log('Received block found. KNOWN')
        },
        onAccept: (unpacked) => {
          this.blocksFoundAccepted++
          this.log('Received block found. ACCEPT')
          this.trigger('blockFoundAccept', hash, block, unpacked)
          this.broadcast(hash, block)
        },
        onReject: () => {
          this.blocksFoundRejected++
          //this.log('Received block found. REJECT')
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
          this.log('TX_INFO accepted')
          this.trigger('txInfoAccept', hash, tx, fee)
        } else {
          this.log('TX_INFO rejected', Tx.getError())
        }
      })
    })
    net.on('netInfoBlockchainLength', (length, address) => {
      if (length >= blockchain.getLength()) {
        this.netInfoBlockchainLengths[address] = length
        storage.session.netInfoBlockchainLength = helper.calcProbableValue(R.values(this.netInfoBlockchainLengths))
        // this.log('Received blockchain length. ACCEPT. Probable length', storage.session.netInfoBlockchainLength)
      } else {
        // this.log('Received blockchain length. REJECT')
      }
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
    
    storage.on('blockchainAddedBlock', (unpacked, indexRecord) => {
      disp.sendCmdToWorkers('update.blockchain.index.add', {indexRecord}, 'block')
    })
    
    storage.on('blockchainRemovedBlocks', (count) => {
      disp.sendCmdToWorkers('update.blockchain.index.remove', {count}, 'block')
    })
    
    storage.on('blockchainSpendsUpdated', () => {
      disp.sendCmdToWorkers('update.blockchain.spends', {spends: storage.session.blockchain.spends}, 'block')
    })
    
    storage.on('blockchainSpendsUpdatedAdded', (spend) => {
      disp.sendCmdToWorkers('update.blockchain.spends.add', {spend}, 'block')
    })
    
    storage.on('blockchainTxMapUpdated', () => {
      disp.sendCmdToWorkers('update.blockchain.txmap', {txMap: helper.zipTxMap(storage.session.blockchain.txMap)}, 'block')
    })
    
    storage.on('blockchainTxMapUpdatedAdded', (txInfo) => {
      disp.sendCmdToWorkers('update.blockchain.txmap.add', {txInfo}, 'block')
    })
    
    storage.on('cacheDeleteBlocks', () => {
      this.cacheDeleteBlocks()
    })
    
    storage.on('syncState', () => {
      this.log(
        (this.rejectNewBlocks ? 'RY' : 'RN')
        + ' ' + (this.waitForMultipartId ? 'MY' : 'MN')
        + ' ' + (this.blockCheckTimer ? 'CY' : 'CN')
        + ' ' + (this.blockSyncTimer ? 'SY' : 'SN')
        + ' ' + (storage.session.synchronizing ? 'YY' : 'YN')
        + ' ' + (storage.session.forkProcessor ? 'FY' : 'FN')
        + ' BFK/A/R ' + this.blocksFoundKnown + ' ' + this.blocksFoundAccepted + ' ' + this.blocksFoundRejected
      )
    })
    
    storage.on('logLastValidationErrors', () => {
      storage.localSession.lastValidationErrors && R.forEach((err) => {
        this.log(err)
      }, storage.localSession.lastValidationErrors)
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
        const length = blockchain.getLength()
        if (storage.config.singleThreaded) {
          Block.isValidNew(hash, data, (valid, unpacked, txUnpackedList) => {
            if (length === blockchain.getLength()) {
              if (valid) {
                this.lastBlockAcceptedAt = helper.unixTime()
                this.cacheNewTxs(length, unpacked.txHashList, txUnpackedList)
                blockchain.add(hash, data, unpacked, () => {
                  this.working = false
                  if (blockchain.getLength() === length + 1) {
                    callbacks && callbacks.onAccept && callbacks.onAccept(unpacked)
                  } else {
                    blockchain.removeLast(() => {
                      this.cacheDeleteBlocks()
                      const lastBlockValidationError = 'Blockchain error'
                      this.log('Block rejected, reason: ' + lastBlockValidationError)
                      callbacks && callbacks.onReject && callbacks.onReject(lastBlockValidationError)
                    }, blockchain.getLength() - length)
                  }
                })
              } else {
                this.working = false
                const lastBlockValidationError = Block.getError()
                this.log('Block rejected, reason: ' + lastBlockValidationError)
                callbacks && callbacks.onReject && callbacks.onReject(lastBlockValidationError)
              }
            } else {
              this.working = false
              this.add(hash, data, callbacks)
            }
          }, this.promiscuous)
        } else {
          dispTask.blockValidate(hash, data, this.promiscuous, 1, (err, res) => {
            const {valid, unpacked, txUnpackedList, lastBlockValidationError} = res
            if (length === blockchain.getLength()) {
              if (valid) {
                this.lastBlockAcceptedAt = helper.unixTime()
                this.cacheNewTxs(length, unpacked.txHashList, txUnpackedList)
                disp.lock('block', () => {
                  blockchain.add(hash, data, unpacked, () => {
                    disp.unlock('block')
                    this.working = false
                    if (blockchain.getLength() === length + 1) {
                      callbacks && callbacks.onAccept && callbacks.onAccept(unpacked)
                    } else {
                      blockchain.removeLast(() => {
                        this.cacheDeleteBlocks()
                        const lastBlockValidationError = 'Blockchain error'
                        this.log('Block rejected, reason: ' + lastBlockValidationError)
                        callbacks && callbacks.onReject && callbacks.onReject(lastBlockValidationError)
                      }, blockchain.getLength() - length)
                    }
                  })
                })
              } else {
                this.working = false
                this.log('Block rejected, reason: ' + lastBlockValidationError)
                callbacks && callbacks.onReject && callbacks.onReject(lastBlockValidationError)
              }
            } else {
              this.working = false
              this.add(hash, data, callbacks)
            }
          })
        }
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
        this.addTxToMap(block.id, blockUnpacked.txHashList[i], true)
        let tx = blockUnpacked.txList[i]
        let txUnpacked = Tx.unpack(tx)
        for (let t in txUnpacked.txIns) {
          let txIn = txUnpacked.txIns[t]
          this.addSpend([block.id, txIn.txHash, txIn.outN, blockUnpacked.txHashList[i]], true)
        }
      }
    })
  }
  
  cacheNewTxs(blockId, txHashList, txUnpackedList) {
    for (let i in txUnpackedList) {
      this.addTxToMap(blockId, txHashList[i])
      let txUnpacked = txUnpackedList[i]
      for (let t in txUnpacked.txIns) {
        let txIn = txUnpacked.txIns[t]
        this.addSpend([blockId, txIn.txHash, txIn.outN, txHashList[i]])
      }
    }
  }
  
  cacheDeleteBlocks() {
    storage.session.blockchain.knowns = {}
    
    storage.session.blockchain.spends = R.filter(block => block[0] < blockchain.getLength(), storage.session.blockchain.spends)
    storage.trigger('blockchainSpendsUpdated')
    
    storage.session.blockchain.txMap = R.filter(block => block[0] < blockchain.getLength(), storage.session.blockchain.txMap)
    storage.trigger('blockchainTxMapUpdated')
  }
  
  broadcast(hash, block) {
    net.broadcast(CmdPacker.pack(CmdPacker.CMD_BLOCK_FOUND, {hash: hash, block: block}))
  }
  
  broadcastTx(hash, tx) {
    net.broadcast(CmdPacker.pack(CmdPacker.CMD_TX_INFO, {hash: hash, tx: tx}), true)
  }
  
  isCached() {
    return storage.session.blockchain.spends.length > 0
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
  
  addSpend(spend, disableTrigger = false) {
    const pos = helper.sortedIndex(storage.session.blockchain.spends, spend, helper.bufferCompare.bind(this, 1))
    helper.insertIntoArray(storage.session.blockchain.spends, pos, spend)
    !disableTrigger && storage.trigger('blockchainSpendsUpdatedAdded', spend)
  }
  
  addTxToMap(blockId, txHash, disableTrigger = false) {
    const txInfo = [blockId, txHash]
    storage.session.blockchain.txMap.push(txInfo)
    !disableTrigger && storage.trigger('blockchainTxMapUpdatedAdded', txInfo)
  }
  
  requestNetInfoBlockchainLength() {
    // this.log('Requesting blockchain length...')
    net.broadcast(CmdPacker.pack(CmdPacker.CMD_INFO_REQUEST_BLOCKCHAIN_LENGTH), true)
  }
}

const synchronizer = new Synchronizer()
module.exports = synchronizer