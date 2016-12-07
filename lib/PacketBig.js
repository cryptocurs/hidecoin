'use strict'

/* Pack bytes */

class PacketBig {

  constructor(data = null) {
    if (typeof data === 'number') {
      this.buffer = Buffer.allocUnsafeSlow(1)
      this.buffer.writeUInt8(data, 0)
    } else if (data !== null) {
      this.buffer = Buffer.allocUnsafeSlow(data.length)
      data.copy(this.buffer, 0)
    } else {
      this.buffer = Buffer.allocUnsafeSlow(0)
    }
  }
  
  packFixed(data) {
    const bufferLength = this.buffer.length
    const buffer = Buffer.allocUnsafeSlow(bufferLength + data.length)
    this.buffer.copy(buffer, 0)
    data.copy(buffer, bufferLength)
    this.buffer = buffer
    return this
  }
  
  packDynamic(data) {
    if (data.length > 255) {
      throw new Error('Too much size for packDynamic')
    }
    const bufferLength = this.buffer.length
    const buffer = Buffer.allocUnsafeSlow(bufferLength + 1 + data.length)
    this.buffer.copy(buffer, 0)
    buffer.writeUInt8(data.length, bufferLength)
    data.copy(buffer, bufferLength + 1)
    this.buffer = buffer
    return this
  }
  
  packNumber(data, size) {
    const bufferLength = this.buffer.length
    const buffer = Buffer.allocUnsafeSlow(bufferLength + size)
    this.buffer.copy(buffer, 0)
    buffer.writeUIntBE(data, bufferLength, size)
    this.buffer = buffer
    return this
  }
  
  packNumber64(data) {
    const bufferLength = this.buffer.length
    const buffer = Buffer.allocUnsafeSlow(bufferLength + 8)
    this.buffer.copy(buffer, 0)
    buffer.writeUInt32BE(data / 0x100000000, bufferLength)
    buffer.writeUInt32BE(data % 0x100000000, bufferLength + 4)
    this.buffer = buffer
    return this
  }
  
  unpackNumber64(start = 0) {
    return this.buffer.readUInt32BE(start) * 0x100000000 + this.buffer.readUInt32BE(start + 4)
  }
  
  get() {
    return this.buffer
  }
}

module.exports = function(data) {
  return new PacketBig(data)
}