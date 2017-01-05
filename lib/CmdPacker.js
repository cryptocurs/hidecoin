'use strict'

const R = require('ramda')

const helper = require('./helper')
const Packet = require('./Packet')
const PacketBig = require('./PacketBig')

const CMD_ACC = 0x00
const CMD_ERR = 0x01
const CMD_SRV_INFO = 0x10
const CMD_REQUEST_SRV_INFO = 0x11
const CMD_REQUEST_BLOCK_AFTER = 0x20
const CMD_REQUEST_BLOCKS_AFTER = 0x23
const CMD_REQUEST_LAST_BLOCK_INFO = 0x25
const CMD_REQUEST_HASHES_AFTER = 0x26
const CMD_TAKE_BLOCK_AFTER = 0x30
const CMD_NO_BLOCK = 0x31
const CMD_NO_BLOCK_AFTER = 0x32
const CMD_TAKE_BLOCKS_AFTER = 0x33
const CMD_TAKE_LAST_BLOCK_INFO = 0x35
const CMD_TAKE_HASHES_AFTER = 0x36
const CMD_BLOCK_FOUND = 0x40
const CMD_TX_INFO = 0x50
const CMD_REQUEST_TIME = 0xe0
const CMD_TAKE_TIME = 0xf0

module.exports = {
  pack: (cmd, data) => {
    const packet = (R.contains(cmd, [CMD_TAKE_BLOCK_AFTER, CMD_TAKE_HASHES_AFTER, CMD_BLOCK_FOUND, CMD_TX_INFO, CMD_TAKE_BLOCKS_AFTER]) ? PacketBig(cmd) : Packet(cmd))
    if (cmd === CMD_SRV_INFO) {
      packet.packNumber(data.port, 2).packFixed(data.isIpv6 ? helper.ipv6Pack(data.address) : helper.ipv4Pack(data.address))
    } else if (cmd === CMD_REQUEST_SRV_INFO) {
    } else if (cmd === CMD_REQUEST_BLOCK_AFTER) {
      packet.packFixed(data.hash)
    } else if (cmd === CMD_REQUEST_BLOCKS_AFTER) {
      packet.packNumber(data.flags || 0, 1).packFixed(data.hash).packNumber(data.id || 0, 4).packNumber(data.count, 2)
    } else if (cmd === CMD_REQUEST_LAST_BLOCK_INFO) {
    } else if (cmd === CMD_REQUEST_HASHES_AFTER) {
      packet.packFixed(data.hash)
    } else if (cmd === CMD_TAKE_BLOCK_AFTER) {
      packet.packFixed(data.afterHash).packFixed(data.hash).packFixed(data.block)
    } else if (cmd === CMD_TAKE_BLOCKS_AFTER) {
      packet.packNumber(data.flags || 0, 1).packFixed(data.afterHash).packNumber(data.afterId, 4).packNumber(data.blocks.length, 2)
      R.forEach((block) => {
        packet.packFixed(block.hash).packNumber(block.data.length, 4).packFixed(block.data)
      }, data.blocks)
    } else if (cmd === CMD_NO_BLOCK) {
      packet.packFixed(data.hash).packNumber(data.len, 4).packFixed(data.lastBlockHash)
    } else if (cmd === CMD_NO_BLOCK_AFTER) {
      packet.packFixed(data.hash)
    } else if (cmd === CMD_TAKE_LAST_BLOCK_INFO) {
      packet.packNumber(data.id, 4).packFixed(data.hash)
    } else if (cmd === CMD_TAKE_HASHES_AFTER) {
      packet.packFixed(data.afterHash).packNumber(data.hashes.length, 2)
      R.forEach((hash) => {
        packet.packFixed(hash)
      }, data.hashes)
    } else if (cmd === CMD_BLOCK_FOUND) {
      packet.packFixed(data.hash).packFixed(data.block)
    } else if (cmd === CMD_TX_INFO) {
      packet.packFixed(data.hash).packFixed(data.tx)
    } else if (cmd === CMD_REQUEST_TIME) {
    } else if (cmd === CMD_TAKE_TIME) {
      packet.packNumber64(data.time)
    }
    return packet.get()
  },
  unpack: (data) => {
    let res = {}
    if (data[0] === CMD_SRV_INFO) {
      if (!R.contains(data.length, [7, 19])) {
        return false
      }
      res.isIpv6 = (data.length === 19)
      res.port = data.readUInt16BE(1)
      res.address = data.length === 19 ? helper.ipv6Unpack(data.slice(3)) : helper.ipv4Unpack(data.slice(3))
    } else if (data[0] === CMD_REQUEST_SRV_INFO) {
      if (data.length !== 1) {
        return false
      }
    } else if (data[0] === CMD_REQUEST_BLOCK_AFTER) {
      if (data.length !== 33) {
        return false
      }
      res.hash = data.slice(1, 33)
    } else if (data[0] === CMD_REQUEST_BLOCKS_AFTER) {
      if (data.length !== 40) {
        return false
      }
      res.flags = data.readUInt8(1)
      res.hash = data.slice(2, 34)
      res.id = data.readUInt32BE(34)
      res.count = data.readUInt16BE(38)
    } else if (data[0] === CMD_REQUEST_LAST_BLOCK_INFO) {
      if (data.length !== 1) {
        return false
      }
    } else if (data[0] === CMD_REQUEST_HASHES_AFTER) {
      if (data.length !== 33) {
        return false
      }
      res.hash = data.slice(1, 33)
    } else if (data[0] === CMD_TAKE_BLOCK_AFTER) {
      if (data.length < 65) {
        return false
      }
      res.afterHash = data.slice(1, 33)
      res.hash = data.slice(33, 65)
      res.block = data.slice(65)
    } else if (data[0] === CMD_NO_BLOCK) {
      if (data.length !== 69) {
        return false
      }
      res.hash = data.slice(1, 33)
      res.len = data.readUInt32BE(33)
      res.lastBlockHash = data.slice(37, 69)
    } else if (data[0] === CMD_NO_BLOCK_AFTER) {
      if (data.length !== 33) {
        return false
      }
      res.hash = data.slice(1, 33)
    } else if (data[0] === CMD_TAKE_BLOCKS_AFTER) {
      if (data.length < 40) {
        return false
      }
      res.flags = data.readUInt8(1)
      res.afterHash = data.slice(2, 34)
      res.afterId = data.readUInt32BE(34)
      res.blocksCount = data.readUInt16BE(38)
      res.blocks = []
      let pos = 40
      for (let i = 0; i < res.blocksCount; i++) {
        if (pos + 36 > data.length) {
          return false
        }
        let block = {}
        block.hash = data.slice(pos, pos += 32)
        block.size = data.readUInt32BE(pos)
        block.data = data.slice(pos += 4, pos += block.size)
        if (block.data.length < block.size) {
          return false
        }
        res.blocks.push(block)
      }
    } else if (data[0] === CMD_TAKE_LAST_BLOCK_INFO) {
      if (data.length !== 37) {
        return false
      }
      res.id = data.readUInt32BE(1)
      res.hash = data.slice(5, 37)
    } else if (data[0] === CMD_TAKE_HASHES_AFTER) {
      if (data.length < 35) {
        return false
      }
      res.afterHash = data.slice(1, 33)
      res.hashesCount = data.readUInt16BE(33)
      if (data.length !== 35 + res.hashesCount * 32) {
        return false
      }
      res.hashes = []
      let pos = 35
      for (let i = 0; i < res.hashesCount; i++) {
        res.hashes.push(data.slice(pos, pos += 32))
      }
    } else if (data[0] === CMD_BLOCK_FOUND) {
      if (data.length < 33) {
        return false
      }
      res.hash = data.slice(1, 33)
      res.block = data.slice(33)
    } else if (data[0] === CMD_TX_INFO) {
      if (data.length < 33) {
        return false
      }
      res.hash = data.slice(1, 33)
      res.tx = data.slice(33)
    } else if (data[0] === CMD_REQUEST_TIME) {
      if (data.length !== 1) {
        return false
      }
    } else if (data[0] === CMD_TAKE_TIME) {
      if (data.length !== 9) {
        return false
      }
      res.time = Packet(data.slice(1)).unpackNumber64()
    }
    return res
  },
  toStr: (cmd) => {
    switch (cmd) {
      case CMD_ACC: return 'CMD_ACC'
      case CMD_ERR: return 'CMD_ERR'
      case CMD_SRV_INFO: return 'CMD_SRV_INFO'
      case CMD_REQUEST_SRV_INFO: return 'CMD_REQUEST_SRV_INFO'
      case CMD_REQUEST_BLOCK_AFTER: return 'CMD_REQUEST_BLOCK_AFTER'
      case CMD_REQUEST_BLOCKS_AFTER: return 'CMD_REQUEST_BLOCKS_AFTER'
      case CMD_REQUEST_LAST_BLOCK_INFO: return 'CMD_REQUEST_LAST_BLOCK_INFO'
      case CMD_REQUEST_HASHES_AFTER: return 'CMD_REQUEST_HASHES_AFTER'
      case CMD_TAKE_BLOCK_AFTER: return 'CMD_TAKE_BLOCK_AFTER'
      case CMD_NO_BLOCK: return 'CMD_NO_BLOCK'
      case CMD_NO_BLOCK_AFTER: return 'CMD_NO_BLOCK_AFTER'
      case CMD_TAKE_BLOCKS_AFTER: return 'CMD_TAKE_BLOCKS_AFTER'
      case CMD_TAKE_LAST_BLOCK_INFO: return 'CMD_TAKE_LAST_BLOCK_INFO'
      case CMD_TAKE_HASHES_AFTER: return 'CMD_TAKE_HASHES_AFTER'
      case CMD_BLOCK_FOUND: return 'CMD_BLOCK_FOUND'
      case CMD_TX_INFO: return 'CMD_TX_INFO'
      case CMD_REQUEST_TIME: return 'CMD_REQUEST_TIME'
      case CMD_TAKE_TIME: return 'CMD_TAKE_TIME'
      default: return 'UNKNOWN'
    }
  }
}

module.exports.CMD_ACC = CMD_ACC
module.exports.CMD_ERR = CMD_ERR
module.exports.CMD_SRV_INFO = CMD_SRV_INFO
module.exports.CMD_REQUEST_SRV_INFO = CMD_REQUEST_SRV_INFO
module.exports.CMD_REQUEST_BLOCK_AFTER = CMD_REQUEST_BLOCK_AFTER
module.exports.CMD_REQUEST_BLOCKS_AFTER = CMD_REQUEST_BLOCKS_AFTER
module.exports.CMD_REQUEST_LAST_BLOCK_INFO = CMD_REQUEST_LAST_BLOCK_INFO
module.exports.CMD_REQUEST_HASHES_AFTER = CMD_REQUEST_HASHES_AFTER
module.exports.CMD_TAKE_BLOCK_AFTER = CMD_TAKE_BLOCK_AFTER
module.exports.CMD_TAKE_BLOCKS_AFTER = CMD_TAKE_BLOCKS_AFTER
module.exports.CMD_NO_BLOCK = CMD_NO_BLOCK
module.exports.CMD_NO_BLOCK_AFTER = CMD_NO_BLOCK_AFTER
module.exports.CMD_TAKE_LAST_BLOCK_INFO = CMD_TAKE_LAST_BLOCK_INFO
module.exports.CMD_TAKE_HASHES_AFTER = CMD_TAKE_HASHES_AFTER
module.exports.CMD_BLOCK_FOUND = CMD_BLOCK_FOUND
module.exports.CMD_TX_INFO = CMD_TX_INFO
module.exports.CMD_REQUEST_TIME = CMD_REQUEST_TIME
module.exports.CMD_TAKE_TIME = CMD_TAKE_TIME