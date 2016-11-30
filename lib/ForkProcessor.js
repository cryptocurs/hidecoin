'use strict'

const R = require('ramda')
const _ = require('lodash')

const Component = require('./Component')
const storage = require('./Storage')
const CmdPacker = require('./CmdPacker')
const net = require('./Net')
const Block = require('./Block')
const blockchain = require('./Blockchain')

class ForkProcessor extends Component {

  constructor() {
    super()
    
    this.module = '{red-fg}FRK{/red-fg}'
    this.port = null
    this.address = null
    this.callback = null
    this.stepId = 1
    this.waiter = null
    this.waiterTimeout = () => {
      if (!storage.session.forkProcessor) {
        return
      }
      this.log('{red-fg}Timed out{/red-fg}')
      this.waiter = null
      storage.session.forkProcessor = false
      this.callback && this.callback(false)
    }
    
    this.step = () => {
      this.stepId++
      if (this.stepId > 200) {
        return
      }
      const blockId = blockchain.getLength() - this.stepId
      if (blockId < 0) {
        clearTimeout(this.waiterTimeout)
        this.waiter = null
        storage.session.forkProcessor = false
        this.callback && this.callback(false)
        return
      }
      const block = blockchain.get(blockId)
      this.log('Request hashes after #' + blockId, block.hash.toString('hex'))
      net.send(CmdPacker.pack(CmdPacker.CMD_REQUEST_HASHES_AFTER, {hash: block.hash}), this.port, this.address)
      this.waiter = setTimeout(this.waiterTimeout, 30000)
    }
    
    net.on('blockAfterNoBlock', (hash, len, lastBlockHash, port, address) => {
      if (!storage.session.forkProcessor) {
        return
      }
      if ((port !== this.port) || (address !== this.address)) {
        return
      }
      this.log('No block')
      this.step()
    })
    
    net.on('hashesAfter', (hash, hashesCount, hashes, port, address) => {
      if (!storage.session.forkProcessor) {
        return
      }
      if ((port !== this.port) || (address !== this.address)) {
        return
      }
      this.log('Received hashes after, count: ' + hashesCount)
      const toRemove = this.stepId - 1
      if (hashesCount > toRemove) {
        this.log('Remove ' + toRemove + ' blocks')
        blockchain.removeLast(() => {
          storage.session.blockchain.spends = R.filter(block => block[0] < blockchain.getLength(), storage.session.blockchain.spends)
          
          net.send(CmdPacker.pack(CmdPacker.CMD_REQUEST_BLOCK_AFTER, {hash: Block.getLast().hash}), this.port, this.address)
          this.waiter = setTimeout(this.waiterTimeout, 10000)
        }, toRemove)
      }
    })
    
    net.on('blockAfterRcvd', (afterHash, hash, block) => {
      if (!storage.session.forkProcessor) {
        return
      }
      this.log('Received block after. Validating')
      this.trigger('add', hash, block, {
        onAccept: () => {
          this.log('Validated block after. ACCEPT')
          clearTimeout(this.waiterTimeout)
          this.waiter = null
          storage.session.forkProcessor = false
          this.callback && this.callback(true)
        },
        onKnown: () => {
          this.log('Validated block after. KNOWN')
          clearTimeout(this.waiterTimeout)
          this.waiter = null
          storage.session.forkProcessor = false
          this.callback && this.callback(true)
        },
        onReject: () => {
          this.log('Validated block after. REJECT')
          clearTimeout(this.waiterTimeout)
          this.waiter = null
          storage.session.forkProcessor = false
          this.callback && this.callback(true)
        }
      })
    })
  }
  
  run(port, address, callback) {
    if (storage.session.forkProcessor) {
      callback(false)
      return
    }
    this.port = port
    this.address = address
    this.callback = callback
    this.stepId = 1
    storage.session.forkProcessor = true
    this.log('Working with forked chain')
    this.step()
  }
}

const forkProcessor = new ForkProcessor()
module.exports = forkProcessor