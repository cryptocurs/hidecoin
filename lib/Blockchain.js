'use strict'

const fs = require('fs')
const R = require('ramda')

const helper = require('./helper')
const Address = require('./Address')
const Packet = require('./Packet')
const PacketBig = require('./PacketBig')
const storage = require('./Storage')

const base = __dirname + '/../'
const path = base + 'data/blockchain.dat'
const pathIndex = base + 'data/blockchain.ind'

const BUFFER_00 = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
const BUFFER_FF = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'hex')

class Blockchain {

  constructor() {
    this.workers = 0
    this.length = fs.existsSync(pathIndex) ? parseInt(fs.statSync(pathIndex).size / 40) : 0
    
    this.cacheIndex = (fdIndex) => {
      this.indexSize = this.length * 40
      this.indexCached = Buffer.allocUnsafeSlow(this.indexSize)
      this.workers++
      fs.readSync(fdIndex, this.indexCached, 0, this.indexSize, 0)
      this.workers--
    }
    
    this.cacheBlocks = (fd) => {
      this.blocksSize = fs.statSync(path).size
      this.blocksCached = Buffer.allocUnsafeSlow(this.blocksSize)
      this.workers++
      fs.readSync(fd, this.blocksCached, 0, this.blocksSize, 0)
      this.workers--
    }
    
    const fdIndex = fs.openSync(pathIndex, 'a+')
    this.cacheIndex(fdIndex)
    fs.closeSync(fdIndex)
    
    const fd = fs.openSync(path, 'a+')
    storage.config.blockchainMemory && this.cacheBlocks(fd)
    fs.closeSync(fd)
  }
  
  add(hash, data, unpacked, callback) {
    if (this.workers) {
      setTimeout(() => {
        this.add(hash, data, callback)
      }, 1)
    } else {
      this.workers++
      
      const indexRecord = Packet().packFixed(hash).packNumber64(fs.statSync(path).size).get()
      fs.appendFileSync(path, data)
      fs.appendFileSync(pathIndex, indexRecord)
      
      this.addToIndexCached(indexRecord)
      
      if (storage.config.blockchainMemory) {
        const _blocksCached = Buffer.allocUnsafeSlow(this.blocksSize)
        this.blocksCached.copy(_blocksCached)
        
        const prevBlocksSize = this.blocksSize
        this.blocksSize += data.length
        this.blocksCached = Buffer.allocUnsafeSlow(this.blocksSize)
        _blocksCached.copy(this.blocksCached)
        data.copy(this.blocksCached, prevBlocksSize)
      }
      
      this.workers--
      callback && callback()
      storage.trigger('blockchainAddedBlock', unpacked, indexRecord)
    }
  }
  
  removeLast(callback, count = 1) {
    if (!fs.existsSync(pathIndex) || !fs.existsSync(path) || !this.length || count < 1) {
      callback && callback()
      return
    }
    if (this.workers) {
      setTimeout(() => {
        this.removeLast(callback)
      }, 1)
    } else {
      this.workers++
      
      const fdIndex = fs.openSync(pathIndex, 'r+')
      const buffer = Buffer.allocUnsafe(40)
      const startIndex = (this.length - count) * 40
      fs.readSync(fdIndex, buffer, 0, 40, startIndex)
      fs.ftruncateSync(fdIndex, startIndex)
      const start = Packet(buffer.slice(32)).unpackNumber64()
      fs.closeSync(fdIndex)
      
      const fd = fs.openSync(path, 'r+')
      fs.ftruncateSync(fd, start)
      fs.closeSync(fd)
      
      this.removeFromIndexCached(count)
      
      if (storage.config.blockchainMemory) {
        this.blocksSize = start
        const _blocksCached = Buffer.allocUnsafeSlow(this.blocksSize)
        this.blocksCached.copy(_blocksCached)
        this.blocksCached = Buffer.allocUnsafeSlow(this.blocksSize)
        _blocksCached.copy(this.blocksCached)
      }
      
      this.workers--
      callback && callback()
      storage.trigger('blockchainRemovedBlocks', count)
    }
  }
  
  get(id) {
    if (typeof id !== 'number') {
      throw new Error('Type of block id must be Number')
    }
    this.workers++
    
    let pos = id * 40
    if (pos >= this.indexSize) {
      this.workers--
      return false
    }
    
    let startNext
    if (pos + 40 < this.indexSize) {
      startNext = Packet(this.indexCached.slice(pos + 72, pos + 80)).unpackNumber64()
    } else {
      startNext = storage.config.blockchainMemory ? this.blocksSize : fs.statSync(path).size
    }
    
    const hash = this.indexCached.slice(pos, pos += 32)
    if (hash.equals(BUFFER_00)) {
      storage.trigger('fatalError', 'Blockchain is broken. Run node bv --repair')
    }
    const start = Packet(this.indexCached.slice(pos, pos + 8)).unpackNumber64()
    const size = startNext - start
    let buffer
    
    if (storage.config.blockchainMemory) {
      this.workers--
      return {id, hash, data: this.blocksCached.slice(start, start + size)}
    }
    
    buffer = Buffer.allocUnsafeSlow(size)
    const fd = fs.openSync(path, 'r')
    if (!fs.readSync(fd, buffer, 0, size, start)) {
      storage.trigger('fatalError', 'Blockchain is broken. Run node bv --repair')
    }
    fs.closeSync(fd)
    
    this.workers--
    return {id, hash, data: buffer}
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
        
        const fd = fs.openSync(path, 'r')
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
    if (blockHash.equals(BUFFER_FF)) {
      return blockchain.get(0)
    }
    const id = this.getWithHash(blockHash, true)
    if (id === false) {
      return false
    }
    
    return blockchain.get(id + 1)
  }
  
  known(blockHash) {
    const beforeReturn = () => {
      this.workers--
    }
    this.workers++
    
    let pos = 0
    while (pos < this.indexSize) {
      const hash = this.indexCached.slice(pos, pos + 32)
      if (hash.equals(blockHash)) {
        beforeReturn()
        return true
      }
      pos += 40
    }
    
    beforeReturn()
    return false
  }
  
  //maxId - not including
  getHashes(minId, maxId = null) {
    this.workers++
    
    let hashes = []
    const fdIndex = fs.openSync(pathIndex, 'r')
    const buffer = Buffer.allocUnsafe(32)
    let pos = minId * 40
    const maxPos = (maxId || this.length) * 40
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
    return this.eachFromTo(0, maxId, callback, returnDefault)
  }
  
  //minId - including, maxId - not including
  eachFromTo(minId, maxId, callback, returnDefault = false) {
    if (storage.config.blockchainMemory) {
      return this.eachFromToMemory(minId, maxId, callback, returnDefault = false)
    }
    
    const beforeReturn = () => {
      fs.closeSync(fd)
      this.workers--
    }
    
    this.workers++
    
    const fd = fs.openSync(path, 'r')
    
    let buffer = Buffer.allocUnsafe(40)
    const bufferNext = Buffer.allocUnsafe(40)
    let startNext = null
    const startPos = minId * 40
    let id = minId
    let pos = startPos
    while ((id < maxId) && (pos + 40 <= this.indexSize)) {
      const startNext = pos + 40 < this.indexSize ? Packet(this.indexCached.slice(pos + 72, pos + 80)).unpackNumber64() : fs.statSync(path).size
      
      const hash = this.indexCached.slice(pos, pos += 32)
      if (pos + 8 > this.indexCached.length) {
        storage.trigger('fatalError', '' + pos + ' ' + this.indexCached.length + ' ' + this.indexSize + ' ' + this.indexCached.slice(pos, pos + 8).toString('hex') + ' ' + maxId + ' ' + (maxId * 40))
      }
      const start = Packet(this.indexCached.slice(pos, pos += 8)).unpackNumber64()
      const size = startNext - start
      
      buffer = Buffer.allocUnsafeSlow(size)
      try {
        fs.readSync(fd, buffer, 0, size, start)
      } catch (e) {
        console.log({blocksSize: this.blocksSize, startNext, size, start})
      }
      
      const res = callback({id: id, hash: hash, data: buffer})
      if (res !== undefined) {
        beforeReturn()
        return res
      }
      id++
    }
    
    beforeReturn()
    return returnDefault
  }
  
  //minId - including, maxId - not including
  eachFromToMemory(minId, maxId, callback, returnDefault = false) {
    let id = minId
    let pos = id * 40
    while ((id < maxId) && (pos + 40 <= this.indexSize)) {
      let startNext
      if (pos + 40 < this.indexSize) {
        startNext = Packet(this.indexCached.slice(pos + 72, pos + 80)).unpackNumber64()
      } else {
        startNext = this.blocksSize
      }
      
      const hash = this.indexCached.slice(pos, pos += 32)
      if (pos + 8 > this.indexCached.length) {
        storage.trigger('fatalError', '' + pos + ' ' + this.indexCached.length + ' ' + this.indexSize + ' ' + this.indexCached.slice(pos, pos + 8).toString('hex') + ' ' + maxId + ' ' + (maxId * 40))
      }
      const start = Packet(this.indexCached.slice(pos, pos += 8)).unpackNumber64()
      const size = startNext - start
      
      const res = callback({id: id, hash: hash, data: this.blocksCached.slice(start, start + size)})
      if (res !== undefined) {
        return res
      }
      
      id++
    }
    
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
        const hash = buffer.slice(0, 32)
        const start = Packet(buffer.slice(32)).unpackNumber64()
        if (fs.readSync(fdIndex, bufferNext, 0, 40, pos += 40)) {
          startNext = Packet(bufferNext.slice(32)).unpackNumber64()
        } else {
          startNext = fs.statSync(path).size
        }
        
        const size = startNext - start
        buffer = Buffer.allocUnsafeSlow(size)
        fs.readSync(fd, buffer, 0, size, start)
        
        const res = callback({id: id, hash: hash, data: buffer}, () => {
          process.nextTick(readNext)
        })
        if (res !== undefined) {
          beforeReturn()
          returnCallback && returnCallback(res)
        }
        id++
      } else {
        beforeReturn()
        returnCallback && returnCallback(returnDefault)
      }
    }
    
    this.workers++
    
    const fdIndex = fs.openSync(pathIndex, 'r')
    const fd = fs.openSync(path, 'r')
    
    let buffer = Buffer.allocUnsafe(40)
    const bufferNext = Buffer.allocUnsafe(40)
    let startNext = null
    let id = 0
    let pos = 0
    
    readNext()
  }
  
  addToIndexCached(indexRecord) {
    const _indexCached = Buffer.allocUnsafeSlow(this.indexSize)
    this.indexCached.copy(_indexCached)
    
    const prevIndexSize = this.indexSize
    this.indexSize += 40
    this.indexCached = Buffer.allocUnsafeSlow(this.indexSize)
    _indexCached.copy(this.indexCached)
    indexRecord.copy(this.indexCached, prevIndexSize)
    
    this.length++
  }
  
  removeFromIndexCached(count) {
    this.indexSize -= count * 40
    const _indexCached = Buffer.allocUnsafeSlow(this.indexSize)
    this.indexCached.copy(_indexCached)
    this.indexCached = Buffer.allocUnsafeSlow(this.indexSize)
    _indexCached.copy(this.indexCached)
    
    this.length -= count
  }
  
  getLength() {
    return this.length
  }
  
  branch(branch) {
    storage.trigger('blockchainBranched')
  }
}

const blockchain = new Blockchain()
module.exports = blockchain