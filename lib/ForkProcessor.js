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
    this.stepId = 1
    
    this.step = () => {
      this.stepId++
      if (this.stepId > 200) {
        return
      }
      const blockId = blockchain.getLength() - this.stepId
      const block = blockchain.get(blockId)
      this.log('Request hashes after #' + blockId)
      net.send(CmdPacker.pack(CmdPacker.CMD_REQUEST_HASHES_AFTER, {hash: block.hash}), this.port, this.address)
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
    
    net.on('hashesAfter', (hash, hashesCount, hashes) => {
      if (!storage.session.forkProcessor) {
        return
      }
      if ((port !== this.port) || (address !== this.address)) {
        return
      }
      this.log('Received hashes after, count: ' + hashesCount)
    })
  }
  
  run(port, address, callback) {
    if (storage.session.forkProcessor) {
      callback(false)
      return
    }
    this.port = port
    this.address = address
    this.stepId = 1
    storage.session.forkProcessor = true
    this.log('Working with forked chain')
    this.step()
  }
}

const forkProcessor = new ForkProcessor()
module.exports = forkProcessor