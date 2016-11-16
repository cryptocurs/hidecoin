'use strict'

/* Pack bytes */

class Packet {

  constructor(data = null) {
    if (typeof data === 'number') {
      this.buffer = Buffer.from([data])
    } else if (data !== null) {
      this.buffer = data
    } else {
      this.buffer = Buffer.from([])
    }
    
    this.packByte = (data) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from([data])])
    }
  }
  
  packFixed(data) {
    this.buffer = Buffer.concat([this.buffer, data])
    return this
  }
  
  packDynamic(data) {
    if (data.length > 255) {
      throw new Error('Too much size for packDynamic')
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from([data.length]), data])
    return this
  }
  
  packNumber(data, size) {
    for (let i = size - 1; i >= 0; i--) {
      this.packByte(data >> i * 8)
    }
    return this
  }
  
  packNumber64(data) {
    this.buffer = Buffer.concat([this.buffer, new Packet().packNumber(data / 0x100000000 >> 0, 4).get(), new Packet().packNumber(data & 0xFFFFFFFF, 4).get()])
    return this
  }
  
  unpackNumber64() {
    if (this.buffer.length !== 8) {
      throw new Error('Wrong number length')
    }
    return this.buffer.readUInt32BE(0) * 0x100000000 + this.buffer.readUInt32BE(4)
  }
  
  get() {
    return this.buffer
  }
}

module.exports = function(data) {
  return new Packet(data)
}