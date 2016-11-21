'use strict'

const fs = require('fs')
const R = require('ramda')

const helper = require('./helper')
const Address = require('./Address')
const Packet = require('./Packet')

const base = __dirname + '/../'
const path = base + 'data/blockchain.dat'
const pathIndex = base + 'data/blockchain.ind'

class Blockchain {

  constructor() {
    this.workers = 0
    this.length = fs.existsSync(pathIndex) ? parseInt(fs.statSync(pathIndex).size / 40) : 0
  }
  
  add(hash, data, callback) {
    if (this.workers) {
      setTimeout(() => {
        this.add(hash, data, callback)
      }, 1)
    } else {
      this.workers++
      fs.appendFileSync(path, data)
      fs.appendFileSync(pathIndex, Packet().packFixed(hash).packNumber64(fs.statSync(path).size - data.length).get())
      this.workers--
      this.length++
      callback && callback()
    }
  }
  
  removeLast(callback) {
    if (!fs.existsSync(pathIndex) || !fs.existsSync(path) || !this.length) {
      callback && callback()
      return
    }
    if (this.workers) {
      setTimeout(() => {
        this.removeLast(callback)
      }, 1)
    } else {
      this.workers++
      
      var fdIndex = fs.openSync(pathIndex, 'r+')
      var buffer = Buffer.allocUnsafe(40)
      var startIndex = (this.length - 1) * 40
      fs.readSync(fdIndex, buffer, 0, 40, startIndex)
      fs.ftruncateSync(fdIndex, startIndex)
      var start = Packet(buffer.slice(32)).unpackNumber64()
      fs.closeSync(fdIndex)
      
      var fd = fs.openSync(path, 'r+')
      fs.ftruncateSync(fd, start)
      fs.closeSync(fd)
      
      this.length--
      this.workers--
      callback && callback()
    }
  }
  
  get(id) {
    if (typeof id !== 'number') {
      throw new Error('Type of block id must be Number')
    }
    this.workers++
    
    var fdIndex = fs.openSync(pathIndex, 'a+')
    var buffer = Buffer.allocUnsafe(40)
    var bufferNext = Buffer.allocUnsafe(40)
    var startNext = null
    if (!fs.readSync(fdIndex, buffer, 0, 40, id * 40)) {
      throw new Error('No block ' + id + ' in blockchain')
    }
    var hash = buffer.slice(0, 32)
    var start = Packet(buffer.slice(32)).unpackNumber64()
    if (fs.readSync(fdIndex, bufferNext, 0, 40, (id + 1) * 40)) {
      startNext = Packet(bufferNext.slice(32)).unpackNumber64()
    } else {
      startNext = fs.statSync(path).size
    }
    fs.closeSync(fdIndex)
    
    var size = startNext - start
    buffer = Buffer.allocUnsafe(size)
    var fd = fs.openSync(path, 'a+')
    fs.readSync(fd, buffer, 0, size, start)
    fs.closeSync(fd)
    
    this.workers--
    return {id: id, hash: hash, data: buffer}
  }
  
  getWithHash(blockHash) {
    var beforeReturn = () => {
      fd && fs.closeSync(fd)
      fs.closeSync(fdIndex)
      this.workers--
    }
    this.workers++
    
    var fdIndex = fs.openSync(pathIndex, 'a+')
    
    var buffer = Buffer.allocUnsafe(40)
    var bufferNext = Buffer.allocUnsafe(40)
    var startNext = null
    let id = 0
    let pos = 0
    while (fs.readSync(fdIndex, buffer, 0, 40, pos)) {
      if (pos) {
        buffer = Buffer.from(bufferNext)
      }
      
      if (fs.readSync(fdIndex, bufferNext, 0, 40, pos += 40)) {
        startNext = Packet(bufferNext.slice(32)).unpackNumber64()
      } else {
        startNext = fs.statSync(path).size
      }
      
      let hash = buffer.slice(0, 32)
      if (!hash.equals(blockHash)) {
        id++
        continue
      }
      let start = Packet(buffer.slice(32)).unpackNumber64()
      
      var size = startNext - start
      buffer = Buffer.allocUnsafe(size)
      
      var fd = fs.openSync(path, 'a+')
      fs.readSync(fd, buffer, 0, size, start)
      
      beforeReturn()
      return ({id: id, hash: hash, data: buffer})
    }
    
    beforeReturn()
    return false
  }
  
  each(callback, returnDefault = false) {
    return this.eachTo(this.length, callback, returnDefault)
  }
  
  //maxId - not including
  eachTo(maxId, callback, returnDefault = false) {
    var beforeReturn = () => {
      fs.closeSync(fd)
      fs.closeSync(fdIndex)
      this.workers--
    }
    
    this.workers++
    
    var fdIndex = fs.openSync(pathIndex, 'a+')
    var fd = fs.openSync(path, 'a+')
    
    var buffer = Buffer.allocUnsafe(40)
    var bufferNext = Buffer.allocUnsafe(40)
    var startNext = null
    let id = 0
    let pos = 0
    while ((id < maxId) && fs.readSync(fdIndex, buffer, 0, 40, pos)) {
      if (pos) {
        buffer = Buffer.from(bufferNext)
      }
      let hash = buffer.slice(0, 32)
      let start = Packet(buffer.slice(32)).unpackNumber64()
      if (fs.readSync(fdIndex, bufferNext, 0, 40, pos += 40)) {
        startNext = Packet(bufferNext.slice(32)).unpackNumber64()
      } else {
        startNext = fs.statSync(path).size
      }
      
      var size = startNext - start
      buffer = Buffer.allocUnsafe(size)
      fs.readSync(fd, buffer, 0, size, start)
      
      let res = callback({id: id, hash: hash, data: buffer})
      if (res !== undefined) {
        beforeReturn()
        return res
      }
      id++
    }
    
    beforeReturn()
    return returnDefault
  }
  
  getLength() {
    return this.length
  }
}

const blockchain = new Blockchain()
module.exports = blockchain