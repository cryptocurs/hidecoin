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
      this.waiter = null
      storage.session.forkProcessor = false
      this.callback && this.callback()
    }
    
    this.step = () => {
      this.stepId++
      if (this.stepId > 200) {
        return
      }
      const blockId = blockchain.getLength() - this.stepId
      const block = blockchain.get(blockId)
      this.log('Request hashes after #' + blockId)
      net.send(CmdPacker.pack(CmdPacker.CMD_REQUEST_HASHES_AFTER, {hash: block.hash}), this.port, this.address)
      this.waiter = setTimeout(this.waiterTimeout, 10000)
    }
    
    net.on('blockAfterNoBlock', (hash, len, lastBlockHash, port, address) => {
      if (!storage.session.forkProcessor) {
        return
      }
      if ((port !== this.port) || (address !== this.address)) {
        return
      }
      this.log('No block after')
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
      this.add(hash, block, {
        onAccept: (unpacked) => {
          this.trigger('blockAfterAccept', afterHash, hash, block, unpacked)
          this.log('Validated block after. ACCEPT')
          clearTimeout(this.waiterTimeout)
          this.waiter = null
          storage.session.forkProcessor = false
          this.callback && this.callback()
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