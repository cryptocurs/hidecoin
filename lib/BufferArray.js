'use strict'

/* BufferArray
*  step - step in bytes
*  fields - array of {
*    name
*    size
*  }
*/

const R = require('ramda')

class BufferArray {

  constructor(options) {
    const {step, fields} = options
    
    this.buffer = Buffer.allocUnsafeSlow(step)
    this.bufferSize = step
    this.dataSize = 0
    this.length = 0
    
    this.fields = fields
    let start = 0
    this.itemSize = R.reduce((acc, field) => {
      field.start = start
      start += field.size
      return acc + field.size
    }, 0, R.values(this.fields))
    
    this.alloc = () => {
      this.bufferSize += step
      const _buffer = Buffer.allocUnsafeSlow(this.dataSize)
      this.buffer.copy(_buffer)
      this.buffer = Buffer.allocUnsafeSlow(this.bufferSize)
      _buffer.copy(this.buffer)
    }
    
    this.getValue = (data, field) => {
      if (field.type === 'number') {
        return data.readUIntBE(field.start, field.size)
      } else if (field.type === 'buffer') {
        return data.slice(field.start, field.start + field.size)
      }
    }
  }
  
  get(i) {
    const start = i * this.itemSize
    const end = start + this.itemSize
    if (end > this.dataSize) {
      return null
    }
    
    const data = this.buffer.slice(start, end)
    let res = {}
    for (const name in this.fields) {
      res[name] = this.getValue(data, this.fields[name])
    }
    return res
  }
  
  getField(i, name) {
    if (!this.fields[name]) {
      return null
    }
    
    const start = i * this.itemSize
    const end = start + this.itemSize
    if (end > this.dataSize) {
      return null
    }
    
    return this.getValue(this.buffer.slice(start, end), this.fields[name])
  }
  
  each(callback, returnDefault = null) {
    let i = 0
    let pos = 0
    while (pos < this.dataSize) {
      const data = this.buffer.slice(pos, pos += this.itemSize)
      let res = {}
      for (const name in this.fields) {
        res[name] = this.getValue(data, this.fields[name])
      }
      const callbackResult = callback(res, i++, data)
      if (callbackResult !== undefined) {
        return callbackResult
      }
    }
    return returnDefault
  }
  
  push(data, i) {
    if (this.dataSize + this.itemSize > this.bufferSize) {
      this.alloc()
    }
    let start
    if (i === undefined) {
      start = this.dataSize
    } else if (i < 0 || i > this.length) {
      return false
    } else {
      start = i * this.itemSize
      this.buffer.copy(this.buffer, start + this.itemSize, start)
    }
    for (const name in this.fields) {
      const field = this.fields[name]
      const fieldData = data[name]
      if (field.type === 'number') {
        this.buffer.writeUIntBE(fieldData, start, field.size)
      } else if (field.type === 'buffer') {
        fieldData.copy(this.buffer, start, 0, field.size)
      }
      start += field.size
    }
    this.dataSize += this.itemSize
    this.length++
    return true
  }
  
  remove(i) {
    if (i < 0 || i >= this.length) {
      return false
    }
    
    const start = i * this.itemSize
    this.buffer.copy(this.buffer, start, start + this.itemSize)
    this.dataSize -= this.itemSize
    this.length--
    return true
  }
  
  filter(callback) {
    let dataSizeNew = 0
    let lengthNew = 0
    this.each((item, i, raw) => {
      if (callback(item)) {
        raw.copy(this.buffer, dataSizeNew)
        dataSizeNew += this.itemSize
        lengthNew++
      }
    })
    this.dataSize = dataSizeNew
    this.length = lengthNew
  }
  
  getItemSize() {
    return this.itemSize
  }
  
  getSize() {
    return this.bufferSize
  }
  
  getWhole() {
    return this.buffer.slice(0, this.dataSize)
  }
  
  getLength() {
    return this.length
  }
}

module.exports = (options) => {
  return new BufferArray(options)
}