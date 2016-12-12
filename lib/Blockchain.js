'use strict'

const fs = require('fs')
const R = require('ramda')

const helper = require('./helper')
const Address = require('./Address')
const Packet = require('./Packet')
const PacketBig = require('./PacketBig')

const base = __dirname + '/../'
const path = base + 'data/blockchain.dat'
const pathIndex = base + 'data/blockchain.ind'

class Blockchain {

  constructor() {
    this.workers = 0
    this.length = fs.existsSync(pathIndex) ? parseInt(fs.statSync(pathIndex).size / 40) : 0
    
    this.cacheIndex = () => {
      this.indexSize = this.length * 40
      this.indexCached = Buffer.allocUnsafeSlow(this.indexSize)
      this.workers++
      const fdIndex = fs.openSync(pathIndex, 'a+')
      fs.readSync(fdIndex, this.indexCached, 0, this.indexSize, 0)
      fs.closeSync(fdIndex)
      this.workers--
    }
    
    this.cacheIndex()
  }
  
  add(hash, data, callback) {
    if (this.workers) {
      setTimeout(() => {
        this.add(hash, data, callback)
      }, 1)
    } else {
      this.workers++
      
      const indexRecord = Packet().packFixed(hash).packNumber64(fs.statSync(path).size).get()
      fs.appendFileSync(path, data)
      fs.appendFileSync(pathIndex, indexRecord)
      
      const _indexCached = Buffer.allocUnsafeSlow(this.indexSize)
      this.indexCached.copy(_indexCached)
      
      const prevIndexSize = this.indexSize
      this.indexSize += 40
      this.indexCached = Buffer.allocUnsafeSlow(this.indexSize)
      _indexCached.copy(this.indexCached)
      indexRecord.copy(this.indexCached, prevIndexSize)
      
      this.workers--
      this.length++
      callback && callback()
    }
  }
  
  removeLast(callback, count = 1) {
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
      var startIndex = (this.length - count) * 40
      fs.readSync(fdIndex, buffer, 0, 40, startIndex)
      fs.ftruncateSync(fdIndex, startIndex)
      var start = Packet(buffer.slice(32)).unpackNumber64()
      fs.closeSync(fdIndex)
      
      var fd = fs.openSync(path, 'r+')
      fs.ftruncateSync(fd, start)
      fs.closeSync(fd)
      
      this.indexSize -= count * 40
      const _indexCached = Buffer.allocUnsafeSlow(this.indexSize)
      this.indexCached.copy(_indexCached)
      this.indexCached = Buffer.allocUnsafeSlow(this.indexSize)
      _indexCached.copy(this.indexCached)
      
      this.length -= count
      this.workers--
      callback && callback()
    }
  }
  
  get(id) {
    if (typeof id !== 'number') {
      throw new Error('Type of block id must be Number')
    }
    this.workers++
    
    let pos = id * 40
    if (pos >= this.indexSize) {
      return false
    }
    
    let startNext
    if (pos + 40 < this.indexSize) {
      startNext = Packet(this.indexCached.slice(pos + 72, pos + 80)).unpackNumber64()
    } else {
      startNext = fs.statSync(path).size
    }
    
    const hash = this.indexCached.slice(pos, pos += 32)
    const start = Packet(this.indexCached.slice(pos, pos + 8)).unpackNumber64()
    const size = startNext - start
    const buffer = Buffer.allocUnsafeSlow(size)
    
    var fd = fs.openSync(path, 'a+')
    fs.readSync(fd, buffer, 0, size, start)
    fs.closeSync(fd)
    
    this.workers--
    return {id: id, hash: hash, data: buffer}
  }
  
  getFromFile(id) {
    if (typeof id !== 'number') {
      throw new Error('Type of block id must be Number')
    }
    this.workers++
    
    var fdIndex = fs.openSync(pathIndex, 'a+')
    var buffer = Buffer.allocUnsafe(40)
    var bufferNext = Buffer.allocUnsafe(40)
    var startNext = null
    if (!fs.readSync(fdIndex, buffer, 0, 40, id * 40)) {
      fs.closeSync(fdIndex)
      return false
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
    buffer = Buffer.allocUnsafeSlow(size)
    var fd = fs.openSync(path, 'a+')
    fs.readSync(fd, buffer, 0, size, start)
    fs.closeSync(fd)
    
    this.workers--
    return {id: id, hash: hash, data: buffer}
  }
  
  getWithHash(blockHash, onlyId = false) {
    const beforeReturn = () => {
      this.workers--
    }
    this.workers++
    
    let id = 0
    let pos = 0
    while (pos < this.indexSize) {
      const hash = this.indexCached.slice(pos, pos + 32)
      pos += 40
      if (hash.equals(blockHash)) {
        if (onlyId) {
          beforeReturn()
          return id
        }
        
        let startNext
        if (pos < this.indexSize) {
          startNext = Packet(this.indexCached.slice(pos + 32, pos + 40)).unpackNumber64()
        } else {
          startNext = fs.statSync(path).size
        }
        
        const start = Packet(this.indexCached.slice(pos - 8, pos)).unpackNumber64()
        const size = startNext - start
        const buffer = Buffer.allocUnsafeSlow(size)
        
        var fd = fs.openSync(path, 'a+')
        fs.readSync(fd, buffer, 0, size, start)
        fs.closeSync(fd)
        
        beforeReturn()
        return {id: id, hash: hash, data: buffer}
      }
      id++
    }
    
    beforeReturn()
    return false
  }
  
  getWithPrevBlock(blockHash) {
    if (blockHash.equals(Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex'))) {
      return blockchain.get(0)
    }
    const id = this.getWithHash(blockHash, true)
    if (id === false) {
      return false
    }
    
    return blockchain.get(id + 1)
  }
  
  getWithHashFile(blockHash) {
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
      buffer = Buffer.allocUnsafeSlow(size)
      
      var fd = fs.openSync(path, 'a+')
      fs.readSync(fd, buffer, 0, size, start)
      
      beforeReturn()
      return ({id: id, hash: hash, data: buffer})
    }
    
    beforeReturn()
    return false
  }
  
  known(blockHash) {
    var beforeReturn = () => {
      fs.closeSync(fdIndex)
      this.workers--
    }
    this.workers++
    
    var fdIndex = fs.openSync(pathIndex, 'a+')
    var buffer = Buffer.allocUnsafe(32)
    var pos = -40
    while (fs.readSync(fdIndex, buffer, 0, 32, pos += 40)) {
      if (buffer.equals(blockHash)) {
        beforeReturn()
        return true
      }
    }
    
    beforeReturn()
    return false
  }
  
  //maxId - not including
  getHashes(minId, maxId = null) {
    this.workers++
    
    var hashes = []
    var fdIndex = fs.openSync(pathIndex, 'a+')
    var buffer = Buffer.allocUnsafe(32)
    let pos = minId * 40
    let maxPos = (maxId || this.length) * 40
    while ((pos < maxPos) && fs.readSync(fdIndex, buffer, 0, 32, pos)) {
      hashes.push(Buffer.from(buffer))
      pos += 40
    }
    
    this.workers--
    return hashes
  }
  
  each(callback, returnDefault = false) {
    return this.eachTo(this.length, callback, returnDefault)
  }
  
  eachAsync(callback, returnCallback = null, returnDefault = false) {
    return this.eachToAsync(this.length, callback, returnCallback, returnDefault)
  }
  
  //maxId - not including
  eachTo(maxId, callback, returnDefault = false) {
    const beforeReturn = () => {
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
      buffer = Buffer.allocUnsafeSlow(size)
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
  
  //maxId - not including
  eachToAsync(maxId, callback, returnCallback = null, returnDefault = false) {
    const beforeReturn = () => {
      fs.closeSync(fd)
      fs.closeSync(fdIndex)
      this.workers--
    }
    const readNext = () => {
      if ((id < maxId) && fs.readSync(fdIndex, buffer, 0, 40, pos)) {
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
        buffer = Buffer.allocUnsafeSlow(size)
        fs.readSync(fd, buffer, 0, size, start)
        
        let res = callback({id: id, hash: hash, data: buffer}, () => {
          process.nextTick(readNext)
        })
        if (res !== undefined) {
          beforeReturn()
          returnCallback && returnCallback(res)
        }
        id++
        readNext()
      } else {
        beforeReturn()
        returnCallback && returnCallback(returnDefault)
      }
    }
    
    this.workers++
    
    var fdIndex = fs.openSync(pathIndex, 'a+')
    var fd = fs.openSync(path, 'a+')
    
    var buffer = Buffer.allocUnsafe(40)
    var bufferNext = Buffer.allocUnsafe(40)
    var startNext = null
    var id = 0
    var pos = 0
    
    readNext()
  }
  
  getLength() {
    return this.length
  }
}

const blockchain = new Blockchain()
module.exports = blockchain