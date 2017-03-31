'use strict'

const crypto = require('crypto')
const eccrypto = require('eccrypto')
const R = require('ramda')
const _ = require('lodash')
const zlib = require('zlib')

module.exports = new class helper {

  unixTimeMs() {
    return new Date().getTime()
  }
  
  unixTime() {
    return parseInt(this.unixTimeMs() / 1000)
  }
  
  objToJson(data) {
    return JSON.stringify(data)
  }
  
  jsonToObj(data) {
    return JSON.parse(data)
  }
  
  strToBase(text) {
    return Buffer.from(text).toString('base64')
  }
  
  baseToStr(text) {
    return Buffer.from(text, 'base64').toString()
  }
  
  bufToBase(buffer) {
    return buffer.toString('base64')
  }
  
  baseToBuf(base) {
    return Buffer.from(base, 'base64')
  }
  
  bufToHex(buf) {
    return buf.toString('hex')
  }
  
  hexToBuf(hex) {
    return Buffer.from(hex, 'hex')
  }
  
  encryptText(text, password) {
    const cipher = crypto.createCipher('aes192', password)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return encrypted
  }
  
  decryptText(text, password) {
    const decipher = crypto.createDecipher('aes192', password)
    let decrypted
    try {
      decrypted = decipher.update(text, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
    } catch (e) {
      return false
    }
    return decrypted
  }
  
  signData(data, privateKey, callback) {
    const textHash = this.hashOnce(data)
    return eccrypto.sign(privateKey, textHash).then((sign) => {
      callback && callback(sign)
    }).catch((e) => {
      console.log(e)
    })
  }
  
  verifySign(data, publicKey, sign, callback) {
    const textHash = this.hashOnce(data)
    eccrypto.verify(publicKey, textHash, sign).then(() => {
      callback && callback(true)
    }).catch(() => {
      callback && callback(false)
    })
  }
  
  publicToAddress(publ) {
    let hash = crypto.createHash('sha256').update(publ).digest()
    hash = crypto.createHash('ripemd160').update(hash).digest()
    
    const version = Buffer.from('28', 'hex')
    let checksum = Buffer.concat([version, hash])
    checksum = crypto.createHash('sha256').update(checksum).digest()
    checksum = checksum.slice(0, 4)
    
    return Buffer.concat([version, hash, checksum])
  }
  
  // / 2
  shiftBuffer(buffer) {
    let res = []
    let nextMask = 0x00
    for (let value of buffer) {
      res.push(value >> 1 | nextMask)
      nextMask = value & 0x01 ? 0x80 : 0x00
    }
    return Buffer.from(res)
  }
  
  // * 2
  unshiftBuffer(buffer, addOne = false) {
    let res = []
    let prevMask = null
    let prevValue = null
    for (let value of buffer) {
      if (prevValue !== null) {
        res.push(prevValue << 1 | (value & 0x80 ? 0x01 : 0x00))
      }
      prevValue = value
    }
    res.push(prevValue << 1 | (addOne ? 0x01 : 0x00))
    return Buffer.from(res)
  }
  
  randomBool() {
    return (Math.random() < 0.5)
  }
  
  randomNumber(min, max) {
    return min + Math.floor(Math.random() * (max + 1 - min))
  }
  
  randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
  }
  
  randomId(bytesCount = 8) {
    return crypto.randomBytes(bytesCount)
  }
  
  isIpv4(ip) {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)
  }
  
  ipv4tov6(ipv4) {
    return '::ffff:' + ipv4
  }
  
  ipv6tov4(ipv6) {
    return (ipv6.substr(0, 7) === '::ffff:' ? ipv6.substr(7) : false)
  }
  
  ipv6Full(ip) {
    const index = ip.indexOf('::')
    let segments = []
    if (index >= 0) {
      const before = ip.slice(0, index).split(':')
      const after = ip.slice(index + 2).split(':')
      const toAdd = 8 - before.length - after.length
      segments = [...before, ...R.repeat('', toAdd), ...after]
    } else {
      segments = ip.split(':')
    }
    return R.join(':', R.map(i => _.padStart(i, 4, '0'), segments))
  }
  
  ipv4Pack(ip) {
    return Buffer.concat(R.map(i => Buffer.from([i]), ip.split('.')))
  }
  
  ipv6Pack(ip) {
    return Buffer.concat(R.map(i => Buffer.from(R.map(t => ('0x' + t) >> 0, i.match(/.{2}/g))), this.ipv6Full(ip).split(':')))
  }
  
  ipv4Unpack(ip) {
    return R.join('.', this.valuesOf(ip.values()))
  }
  
  ipv6Unpack(ip) {
    let values = []
    let accum = []
    let x = 0
    for (let i of ip.values()) {
      accum.push(i)
      if (x % 2) {
        values.push(accum)
        accum = []
      }
      x++
    }
    return R.join(':', R.map(i => Buffer.from([i[0], i[1]]).toString('hex'), values))
  }
  
  hasOnlyKeys(data, keys) {
    for (let i in data) {
      if (!R.contains(i, keys)) {
        return false
      }
    }
    return true
  }
  
  hashOnce(data) {
    return crypto.createHash('sha256').update(data).digest()
  }
  
  hash(data) {
    return this.hashOnce(this.hashOnce(data))
  }
  
  processList(list, callbacks) {
    const itemsCount = list.length
    let processed = 0
    let returned = false
    if (!itemsCount) {
      callbacks.onReady && callbacks.onReady()
    } else {
      for (let i in list) {
        callbacks.onProcess(list[i], (value) => {
          if (value !== undefined) {
            list[i] = value
          }
          processed++
          if (!returned && (processed === itemsCount)) {
            callbacks.onReady && callbacks.onReady()
          }
        }, () => {
          const wasReturned = returned
          returned = true
          !wasReturned && callbacks.onReturn && callbacks.onReturn()
        }, i)
        if (returned) {
          break
        }
      }
    }
  }
  
  processListSync(list, callbacks, start = 0) {
    const itemsCount = list.length
    let returned = false
    if (!itemsCount || (itemsCount <= start)) {
      callbacks.onReady && callbacks.onReady()
    } else {
      callbacks.onProcess(list[start], (value) => {
        if (value !== undefined) {
          list[start] = value
        }
        if (!returned) {
          this.processListSync(list, callbacks, start + 1)
        }
      }, () => {
        const wasReturned = returned
        returned = true
        !wasReturned && callbacks.onReturn && callbacks.onReturn()
      }, start)
    }
  }
  
  valuesOf(iterator) {
    let res = []
    for (let i of iterator) {
      res.push(i)
    }
    return res
  }
  
  asyncWhile(callback, options) {
    if (callback()) {
      setTimeout(() => {
        this.asyncWhile(callback, options)
      }, 1)
    } else {
      options && options.after && options.after()
    }
  }
  
  wait(cond, callback, interval = 500) {
    if (cond()) {
      callback()
    } else {
      setTimeout(() => {
        this.wait(cond, callback, interval)
      }, interval)
    }
  }
  
  checksum(buffer) {
    const cs = Buffer.allocUnsafe(4)
    this.hashOnce(buffer).copy(cs)
    return cs.toString('hex')
  }
  
  stopwatch(func, async = false, callback = null) {
    const timeStart = this.unixTimeMs()
    if (async) {
      func(() => {
        callback && callback(this.unixTimeMs() - timeStart)
      })
    } else {
      func()
      return this.unixTimeMs() - timeStart
    }
  }
  
  countToStr(size) {
    if (size < 1000) {
      return size
    } else if (size < 1000000) {
      return (size / 1000 >> 0) + 'K'
    } else {
      return (size / 1000000 >> 0) + 'M'
    }
  }
  
  sizeToStr(size) {
    if (size < 1024) {
      return size + ' B'
    } else if (size < 1048576) {
      return (size / 1024 >> 0) + ' KB'
    } else {
      return (size / 1048576 >> 0) + ' MB'
    }
  }
  
  insertIntoArray(array, index, item) {
    array.splice(index, 0, item)
  }
  
  bufferCompare(index, a, b) {
    const isArray = index >= 0
    return Buffer.compare(isArray ? b[index] : b, isArray ? a[index] : a)
  }
  
  sortedIndex(array, value, compare) {
    let low = 0
    let high = array ? array.length : low
    
	  while (low < high) {
	    const mid = (low + high) >>> 1
	    compare(array[mid], value) > 0
	      ? low = mid + 1
	      : high = mid
	  }
	  return low
  }
  
  sortedIndexOf(array, value, compare) {
    const index = this.sortedIndex(array, value, compare)
    return index < array.length
      ? compare(array[index], value)
        ? -1
        : index
      : -1
  }
  
  sortedIndexesOf(array, value, compare) {
    let indexes = []
    const low = this.sortedIndexOf(array, value, compare)
    if (low >= 0) {
      indexes.push(low)
      for (let i = low + 1; i < array.length; i++) {
        if (!compare(array[i], value)) {
          indexes.push(i)
        }
      }
    }
    return indexes
  }
  
  restoreObject(obj) {
    if (typeof obj === 'object') {
      for (const k in obj) {
        if (obj[k] && obj[k].type && obj[k].type === 'Buffer') {
          obj[k] = Buffer.from(obj[k].data)
        } else {
          this.restoreObject(obj[k])
        }
      }
    }
  }
  
  cloneObject(obj) {
    let res
    if (typeof obj === 'object') {
      if (obj instanceof Buffer) {
        res = obj
      } else {
        res = obj instanceof Array ? [] : {}
        for (const k in obj) {
          res[k] = this.cloneObject(obj[k])
        }
      }
    } else {
      res = obj
    }
    return res
  }
  
  baseObject(obj) {
    if (typeof obj === 'object') {
      for (const k in obj) {
        if (obj[k] instanceof Buffer) {
          obj[k] = {
            type: 'Based',
            data: this.bufToBase(obj[k])
          }
        } else {
          this.baseObject(obj[k])
        }
      }
    }
  }
  
  unbaseObject(obj) {
    if (typeof obj === 'object') {
      for (const k in obj) {
        if (obj[k] && obj[k].type && obj[k].type === 'Based') {
          obj[k] = this.baseToBuf(obj[k].data)
        } else {
          this.unbaseObject(obj[k])
        }
      }
    }
  }
  
  calcProbableValue(values) {
    let itemIndex
    while (values.length > 2) {
      const avg = _.mean(values)
      const min = _.min(values)
      const max = _.max(values)
      if ((min + max) / 2 === avg) {
        return avg
      }
      let maxDeviation = 0
      _.forEach(values, (value, i) => {
        const deviation = Math.abs(value - avg)
        if (deviation > maxDeviation) {
          maxDeviation = deviation
          itemIndex = i
        }
      })
      values.splice(itemIndex, 1)
    }
    return parseInt(_.mean(values))
  }
  
  zipTxMap(txMap) {
    const txMapBuffered = Buffer.allocUnsafe(txMap.length * 36)
    let pos = -32
    R.forEach((txInfo) => {
      txMapBuffered.writeUInt32BE(txInfo[0], pos += 32)
      txInfo[1].copy(txMapBuffered, pos += 4)
    }, txMap)
    return zlib.deflateRawSync(txMapBuffered)
  }
  
  unzipTxMap(txMapZipped) {
    const txMapBuffered = zlib.inflateRawSync(txMapZipped)
    let txMap = []
    let pos = 0
    while (pos < txMapBuffered.length) {
      txMap.push([txMapBuffered.readUInt32BE(pos), txMapBuffered.slice(pos += 4, pos += 32)])
    }
    return txMap
  }
}