'use strict'

const crypto = require('crypto')
const eccrypto = require('eccrypto')
const R = require('ramda')
const _ = require('lodash')

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
    var encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return encrypted
  }
  
  decryptText(text, password) {
    const decipher = crypto.createDecipher('aes192', password)
    try {
      var decrypted = decipher.update(text, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
    } catch (e) {
      return false
    }
    return decrypted
  }
  
  signData(data, privateKey, callback) {
    var textHash = this.hashOnce(data)
    return eccrypto.sign(privateKey, textHash).then((sign) => {
      callback && callback(sign)
    }).catch(function(e) {
      console.log(e)
    })
  }
  
  verifySign(data, publicKey, sign, callback) {
    var textHash = this.hashOnce(data)
    eccrypto.verify(publicKey, textHash, sign).then(() => {
      callback && callback(true)
    }).catch(function() {
      callback && callback(false)
    })
  }
  
  publicToAddress(publ) {
    var hash = crypto.createHash('sha256').update(publ).digest()
    hash = crypto.createHash('ripemd160').update(hash).digest()
    
    var version = Buffer.from('28', 'hex')
    var checksum = Buffer.concat([version, hash])
    checksum = crypto.createHash('sha256').update(checksum).digest()
    checksum = checksum.slice(0, 4)
    
    return Buffer.concat([version, hash, checksum])
  }
  
  // / 2
  shiftBuffer(buffer) {
    var res = []
    var nextMask = 0x00
    for (let value of buffer) {
      res.push(value >> 1 | nextMask)
      nextMask = value & 0x01 ? 0x80 : 0x00
    }
    return Buffer.from(res)
  }
  
  // * 2
  unshiftBuffer(buffer, addOne = false) {
    var res = []
    var prevMask = null
    var prevValue = null
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
    var index = ip.indexOf('::')
    var segments = []
    if (index >= 0) {
      let before = ip.slice(0, index).split(':')
      let after = ip.slice(index + 2).split(':')
      let toAdd = 8 - before.length - after.length
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
    var values = []
    var accum = []
    var x = 0
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
    var itemsCount = list.length
    var processed = 0
    var returned = false
    if (!list.length) {
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
          let wasReturned = returned
          returned = true
          !wasReturned && callbacks.onReturn && callbacks.onReturn()
        }, i)
        if (returned) {
          break
        }
      }
    }
  }
  
  valuesOf(iterator) {
    var res = []
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
}