'use strict'

/* Common functions for Block and Tx
*  It is need because Block cannot require Tx while Tx require Block :)
*/

const helper = require('./helper')
const Packet = require('./Packet')

var lastValidationError = null

const functions = {
  unpack: (data) => {
    let res = {}
    try {
      res.ver = data.readUInt8(0)
      res.prevBlock = data.slice(1, 33)
      res.time = Packet(data.slice(33, 41)).unpackNumber64()
      res.diff = data.slice(41, 73)
      res.nonce = Packet(data.slice(73, 81)).unpackNumber64()
      res.txCount = data.readUInt32BE(81)
      if (res.txCount === 0) {
        lastValidationError = 'No tx found'
        return false
      }
      
      res.txHashList = []
      let pos = 85
      for (let i = 0; i < res.txCount; i++) {
        res.txHashList.push(data.slice(pos, pos += 32))
      }
      
      res.txList = []
      for (let i = 0; i < res.txCount; i++) {
        let size = data.readUInt32BE(pos)
        if (size === 0) {
          lastValidationError = 'Zero tx #' + i + ' size'
          return false
        }
        res.txList.push(data.slice(pos += 4, pos += size))
      }
      
      if (pos < data.length) {
        lastValidationError = 'Excess data'
        return false
      }
    } catch (e) {
      lastValidationError = e
      return false
    }
    return res
  },
  unpackHashList: (data) => {
    let txHashList = []
    try {
      let txCount = data.readUInt32BE(81)
      let pos = 85
      for (let i = 0; i < txCount; i++) {
        txHashList.push(data.slice(pos, pos += 32))
      }
    } catch (e) {
      return false
    }
    return txHashList
  },
  calcReward: (id) => {
    let reward = 1000000000
    let steps = parseInt(id / 259200)
    for (let x = 0; x < steps; x++) {
      reward = parseInt(reward * 0.75)
    }
    return reward || 1
  },
  getError: () => {
    return lastValidationError
  }
}
module.exports = functions