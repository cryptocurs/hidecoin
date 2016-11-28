'use strict'

/* P2P */

const dgram = require('dgram')
const R = require('ramda')
const _ = require('lodash')

const Component = require('./Component')
const helper = require('./helper')
const Packet = require('./Packet')

const PACK_PING = 0x00
const PACK_PONG = 0x01
const PACK_CONNECT = 0x04
const PACK_EXT_IP_OK = 0x05
const PACK_KEEP_ALIVE = 0x06
const PACK_ERR_NET_LOOP = 0x07
const PACK_DATA = 0x08
const PACK_DATA_OK = 0x09
const PACK_DATA_PART = 0x0a
const PACK_DATA_PART_OK = 0x0b
const PACK_DATA_PART_SIZE = 0x0c
const PACK_DATA_PART_SIZE_OK = 0x0d
const PACK_CONNECT_CLIENT = 0x0e
const PACK_ANY = 0x0f

module.exports = new class P2P extends Component {

  constructor() {
    super()
    this.sockets = {client: null, server: null}
    this.uniqueId = helper.randomId()
    this.localServerPort = null
    this.localClientPort = null
    this.clientMode = false
    this.clientTimer = null
    this.disallowServerMode = false
    this.serverModeAttempts = 0
    this.waiters = {}
    this.partials = {}
    
    this.createPartialId = (port, address, id) => {
      return port + '|' + address + '|' + helper.bufToBase(id)
    }
    
    this.bindLocalPort = () => {
      var port = helper.randomNumber(50000, 55000)
      this.sockets.client && this.sockets.client.close()
      this.sockets.client = dgram.createSocket('udp4')
      this.sockets.client.on('error', () => {
        this.bindLocalPort()
      })
      this.sockets.client.on('message', this.processMessage)
      this.sockets.client.bind(port)
      this.localClientPort = port
    }
    
    this.closeClient = () => {
      if (!this.sockets.client) {
        return false
      }
      this.sockets.client.close()
      this.sockets.client.removeAllListeners()
      this.sockets.client = null
      return true
    }
    
    this.closeServer = () => {
      if (!this.sockets.server) {
        return false
      }
      this.sockets.server.close()
      this.sockets.server.removeAllListeners()
      this.sockets.server = null
      return true
    }
    
    this.validateLength = (msg) => {
      return msg.length && (R.contains(msg[0],
        [PACK_PING, PACK_PONG, PACK_EXT_IP_OK, PACK_KEEP_ALIVE, PACK_ERR_NET_LOOP]) && (msg.length === 1)
        || R.contains(msg[0], [PACK_CONNECT, PACK_CONNECT_CLIENT]) && (msg.length === 11)
        || (msg[0] === PACK_DATA) && (msg.length >= 13)
        || (msg[0] === PACK_DATA_OK) && (msg.length === 5)
        || (msg[0] === PACK_DATA_PART) && (msg.length >= 17)
        || (msg[0] === PACK_DATA_PART_OK) && (msg.length === 9)
        || (msg[0] === PACK_DATA_PART_SIZE) && (msg.length === 21)
        || (msg[0] === PACK_DATA_PART_SIZE_OK) && (msg.length === 13))
    }
    
    this.processMessage = (msg, rinfo) => {
      if (!this.validateLength(msg)) {
        return
      }
      this.trigger('messageRcvd', msg, rinfo)
      
      let waiterId = PACK_ANY + ':' + rinfo.address + ':' + rinfo.port
      if (this.waiters[waiterId]) {
        for (let subId in this.waiters[waiterId]) {
          this.waiters[waiterId][subId].onRcvd && this.waiters[waiterId][subId].onRcvd(msg)
        }
      }
      
      waiterId = msg[0] + ':' + rinfo.address + ':' + rinfo.port
      if (this.waiters[waiterId]) {
        for (let subId in this.waiters[waiterId]) {
          this.waiters[waiterId][subId].onRcvd && this.waiters[waiterId][subId].onRcvd(msg)
        }
      }
      if (msg[0] === PACK_PING) {
        this.send(Packet(PACK_PONG).get(), rinfo.port, rinfo.address, rinfo.family)
      } else if (msg[0] === PACK_PONG) {
      } else if (msg[0] === PACK_CONNECT) {
        let id = msg.slice(1, 9)
        let port = msg.readUInt16BE(9)
        if (id.equals(this.uniqueId)) {
          this.send(Packet(PACK_ERR_NET_LOOP).get(), rinfo.port, rinfo.address, rinfo.family)
        } else {
          this.sendWait(port, rinfo.address, Packet(this.PACK_PING).get(), this.PACK_PONG, 1000, 3, {
            onRcvd: () => {
              this.send(Packet(PACK_EXT_IP_OK).get(), rinfo.port, rinfo.address, rinfo.family)
              this.trigger('newServer', {family: rinfo.family, address: rinfo.address, port: port})
            },
            onTimeout: () => {
              this.send(Packet(PACK_KEEP_ALIVE).get(), rinfo.port, rinfo.address, rinfo.family)
              this.trigger('newClient', rinfo)
            }
          })
        }
      } else if (msg[0] === PACK_CONNECT_CLIENT) {
        let id = msg.slice(1, 9)
        let port = msg.readUInt16BE(9)
        if (id.equals(this.uniqueId)) {
          this.send(Packet(PACK_ERR_NET_LOOP).get(), rinfo.port, rinfo.address, rinfo.family)
        } else {
          this.send(Packet(PACK_KEEP_ALIVE).get(), rinfo.port, rinfo.address, rinfo.family)
          this.trigger('newClient', rinfo)
        }
      } else if (msg[0] === PACK_DATA) {
      } else if (msg[0] === PACK_DATA_OK) {
      } else if (msg[0] === PACK_DATA_PART) {
      } else if (msg[0] === PACK_DATA_PART_OK) {
      } else if (msg[0] === PACK_DATA_PART_SIZE) {
      } else if (msg[0] === PACK_DATA_PART_SIZE_OK) {
      }
    }
    
    this.bindLocalPort()
  }
  
  listen(localServerPort, listenAnyway = false) {
    if (listenAnyway || !this.localServerPort) {
      this.localServerPort = localServerPort
      this.sockets.server = dgram.createSocket('udp4')
      this.sockets.server.on('error', () => {
        storage.trigger('fatalError', 'Server socket error')
      })
      this.sockets.server.on('message', this.processMessage)
      this.sockets.server.bind(localServerPort)
    }
  }
  
  resetServer() {
    this.closeServer()
    this.listen(this.localServerPort, true)
  }
  
  connect(address, port, disallowServerMode = false) {
    this.disallowServerMode = disallowServerMode
    this.server = [address, port]
    this.sendAsClient(Packet(disallowServerMode ? PACK_CONNECT_CLIENT : PACK_CONNECT).packFixed(this.uniqueId).packNumber(this.localServerPort, 2).get(), port, address)
    this.wait(PACK_ANY, port, address, 4000, {
      onRcvd: (msg) => {
        if (msg[0] === PACK_EXT_IP_OK) {
          this.closeClient()
          this.trigger('serverMode')
          this.trigger('online')
        } else if (msg[0] === PACK_KEEP_ALIVE) {
          if (!disallowServerMode && (this.serverModeAttempts < 15)) {
            this.serverModeAttempts++
            return false
          }
          this.clientMode = true
          this.closeServer()
          this.clientTimer = setInterval(() => {
            this.sendWait(this.server[1], this.server[0], Packet(this.PACK_PING).get(), this.PACK_PONG, 1000, 3, {
              onTimeout: () => {
                clearInterval(this.clientTimer)
                this.clientTimer = null
                this.trigger('offline')
              }
            })
          }, 10000)
          this.trigger('clientMode')
          this.trigger('online')
        } else if (msg[0] === PACK_ERR_NET_LOOP) {
          this.trigger('netLoop')
          this.trigger('offline')
        } else {
          return false
        }
      },
      onTimeout: () => {
        this.trigger('offline')
      }
    })
  }
  
  close() {
    for (let i in this.waiters) {
      this.waiters[i].close && this.waiters[i].close()
    }
    this.closeServer()
    this.closeClient()
  }
  
  reconnect(address, port) {
    this.close()
    setTimeout(() => {
      this.listen(this.localServerPort)
      this.bindLocalPort()
      this.connect(address, port, this.disallowServerMode)
    }, 500)
  }
  
  send(data, port, address, family = null) {
    this.trigger('messageSent', data, address, port, family || (helper.isIpv4(address) ? 'IPv4' : 'IPv6'), false)
    const socket = this.clientMode ? this.sockets.client : this.sockets.server
    socket && socket.send(data, port, address, (err) => {
      if (err) {
        this.trigger('sendError')
      }
    })
  }
  
  sendAsClient(data, port, address, family = null) {
    if (this.sockets.client) {
      this.trigger('messageSent', data, address, port, family || (helper.isIpv4(address) ? 'IPv4' : 'IPv6'), true)
      this.sockets.client && this.sockets.client.send(data, port, address, (err) => {
        if (err) {
          this.trigger('sendError')
        }
      })
    }
  }
  
  wait(type, port, address, timeout, callbacks) {
    var waiterId = type + ':' + address + ':' + port
    var subId = 0
    if (this.waiters[waiterId]) {
      while (this.waiters[waiterId][subId]) {
        subId++
      }
    } else {
      this.waiters[waiterId] = {}
    }
    var timer = setTimeout(() => {
      delete this.waiters[waiterId][subId]
      if (!_.size(this.waiters[waiterId])) {
        delete this.waiters[waiterId]
      }
      callbacks.onTimeout && callbacks.onTimeout()
    }, timeout)
    this.waiters[waiterId][subId] = {
      onRcvd: (msg) => {
        if (!callbacks.onRcvd || (callbacks.onRcvd(msg) !== false)) {
          clearTimeout(timer)
          delete this.waiters[waiterId][subId]
          if (!_.size(this.waiters[waiterId])) {
            delete this.waiters[waiterId]
          }
        }
      },
      close: () => {
        clearTimeout(timer)
        delete this.waiters[waiterId][subId]
        if (!_.size(this.waiters[waiterId])) {
          delete this.waiters[waiterId]
        }
      }
    }
  }
  
  sendWait(port, address, data, waitFor, timeout, attempts, callbacks = {}) {
    this.send(data, port, address)
    this.wait(waitFor, port, address, timeout, {
      onRcvd: (msg) => {
        if (callbacks.onRcvd) {
          return callbacks.onRcvd(msg)
        }
      },
      onTimeout: () => {
        if (attempts > 1) {
          this.sendWait(port, address, data, waitFor, timeout, attempts - 1, callbacks)
        } else {
          callbacks.onTimeout && callbacks.onTimeout()
        }
      }
    })
  }
  
  getId() {
    return this.uniqueId
  }
  
  getLocalClientPort() {
    return this.localClientPort
  }
}

module.exports.PACK_PING = PACK_PING
module.exports.PACK_PONG = PACK_PONG
module.exports.PACK_CONNECT = PACK_CONNECT
module.exports.PACK_EXT_IP_OK = PACK_EXT_IP_OK
module.exports.PACK_KEEP_ALIVE = PACK_KEEP_ALIVE
module.exports.PACK_ERR_NET_LOOP = PACK_ERR_NET_LOOP
module.exports.PACK_DATA = PACK_DATA
module.exports.PACK_DATA_OK = PACK_DATA_OK
module.exports.PACK_DATA_PART = PACK_DATA_PART
module.exports.PACK_DATA_PART_OK = PACK_DATA_PART_OK
module.exports.PACK_DATA_PART_SIZE = PACK_DATA_PART_SIZE
module.exports.PACK_DATA_PART_SIZE_OK = PACK_DATA_PART_SIZE_OK
module.exports.PACK_CONNECT_CLIENT = PACK_CONNECT_CLIENT