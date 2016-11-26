'use strict'

const R = require('ramda')
const _ = require('lodash')

const Component = require('./Component')
const helper = require('./helper')
const hours = require('./Hours')
const Packet = require('./Packet')
const storage = require('./Storage')
const p2p = require('./P2P')
const CmdPacker = require('./CmdPacker')
const Block = require('./Block')

const PARTIAL_TRANSFER_SIZE = 1024
const MAX_PARTS_COUNT = 4294967296
const MAX_SAME_TIME_PARTIALS = 8

class Net extends Component {

  constructor() {
    super()
    this.module = 'NET'
    this.currentServer = null
    this.config = null
    this.clientMode = false
    this.requestsCount = 0
    
    setInterval(() => {
      if (this.requestsCount) {
        const rps = parseInt(this.requestsCount / 10)
        storage.trigger('stat', {rps: rps})
        this.requestsCount = 0
      }
    }, 10000)
    
    this.partialBuffers = {}
    
    this.processCommand = (msg, rinfo) => {
      if (msg[0] === CmdPacker.CMD_SRV_INFO) {
        let data = CmdPacker.unpack(msg)
        if (data) {
          if (!storage.servers[data.address]) {
            storage.servers[data.address] = {rating: 0}
          }
          storage.servers[data.address].isIpv6 = data.isIpv6
          storage.servers[data.address].port = data.port
          this.broadcast(CmdPacker.pack(CmdPacker.CMD_SRV_INFO, {isIpv6: data.isIpv6, port: data.port, address: data.address}))
        }
      } else if (msg[0] === CmdPacker.CMD_REQUEST_BLOCK_AFTER) {
        let data = CmdPacker.unpack(msg)
        if (data) {
          let block = Block.getWithBuffer('prevBlock', data.hash)
          if (block) {
            this.send(CmdPacker.pack(CmdPacker.CMD_TAKE_BLOCK_AFTER, {afterHash: data.hash, hash: block.hash, block: block.data}), rinfo.port, rinfo.address)
          }
        }
      } else if (msg[0] === CmdPacker.CMD_REQUEST_LAST_BLOCK_INFO) {
        let data = CmdPacker.unpack(msg)
        if (data) {
          let lastBlock = Block.getLast()
          if (lastBlock) {
            this.send(CmdPacker.pack(CmdPacker.CMD_TAKE_LAST_BLOCK_INFO, {id: lastBlock.id, hash: lastBlock.hash}), rinfo.port, rinfo.address)
          }
        }
      } else if (msg[0] === CmdPacker.CMD_TAKE_BLOCK_AFTER) {
        let data = CmdPacker.unpack(msg)
        data && this.trigger('blockAfterRcvd', data.afterHash, data.hash, data.block)
      } else if (msg[0] === CmdPacker.CMD_TAKE_LAST_BLOCK_INFO) {
        let data = CmdPacker.unpack(msg)
        data && this.trigger('lastBlockInfoRcvd', data.id, data.hash)
      } else if (msg[0] === CmdPacker.CMD_BLOCK_FOUND) {
        let data = CmdPacker.unpack(msg)
        data && this.trigger('blockFoundRcvd', data.hash, data.block)
      } else if (msg[0] === CmdPacker.CMD_TX_INFO) {
        let data = CmdPacker.unpack(msg)
        data && this.trigger('txInfoRcvd', data.hash, data.tx)
      } else if (msg[0] === CmdPacker.CMD_REQUEST_TIME) {
        let time = hours.now()
        if (time) {
          this.send(CmdPacker.pack(CmdPacker.CMD_TAKE_TIME, {time: time}), rinfo.port, rinfo.address)
        }
      } else if (msg[0] === CmdPacker.CMD_TAKE_TIME) {
      }
    }
  }
  
  connect(config, disallowServerMode = false) {
    this.config = config
    
    setInterval(() => {
      let localTime = helper.unixTime()
      for (let i in storage.session.clients) {
        if (storage.session.clients[i].lastPing < localTime - 15) {
          this.log('Client ' + i + ' disconnected')
          delete storage.session.clients[i]
        }
      }
    }, 5000)
    
    setInterval(() => {
      let addresses = R.keys(storage.servers)
      if (addresses.length) {
        let address = helper.randomItem(addresses)
        let server = storage.servers[address]
        if (server.rating > 0) {
          this.broadcast(CmdPacker.pack(CmdPacker.CMD_SRV_INFO, {isIpv6: server.isIpv6, port: server.port, address: address}))
        }
      }
    }, 30000)
    
    setInterval(() => {
      let addresses = R.keys(storage.servers)
      if (addresses.length) {
        let address = helper.randomItem(addresses)
        let server = storage.servers[address]
        p2p.send(Packet(p2p.PACK_PING).get(), server.port, address)
        p2p.wait(p2p.PACK_PONG, server.port, address, 2000, {
          onTimeout: () => {
            if (storage.servers[address]) {
              storage.servers[address].rating--
              if (storage.servers[address].rating < -10) {
                delete storage.servers[address]
              }
            }
          }
        })
      }
    }, 60000)
    
    p2p.on('messageRcvd', (msg, rinfo) => {
      this.requestsCount++
      this.logBy('P2P', 'Rcvd', msg)
      this.logBy('P2P', 'From ' + rinfo.address + ' port ' + rinfo.port)
      
      if (msg[0] === p2p.PACK_PING) {
        let id = rinfo.address + '|' + rinfo.port
        if (storage.session.clients && storage.session.clients[id]) {
          storage.session.clients[id] = {lastPing: helper.unixTime()}
        }
      } else if (msg[0] === p2p.PACK_DATA) {
        if (msg.slice(1, 9).equals(p2p.getId())) {
          return
        }
        p2p.send(Packet(p2p.PACK_DATA_OK).packFixed(msg.slice(9, 13)).get(), rinfo.port, rinfo.address)
        this.processCommand(msg.slice(13), rinfo)
      } else if (msg[0] === p2p.PACK_DATA_PART_SIZE) {
        let partialId = msg.slice(9, 13)
        let dataLength = msg.readUInt32BE(13)
        let partSize = msg.readUInt32BE(17)
        let partsCount = Math.ceil(dataLength / partSize)
        let localPartialId = rinfo.address + '|' + rinfo.port + '|' + helper.bufToHex(partialId)
        for (let i in this.partialBuffers) {
          if (this.partialBuffers[i].t < helper.unixTime() - 30) {
            delete this.partialBuffers[i]
          }
        }
        if (_.size(this.partialBuffers) >= MAX_SAME_TIME_PARTIALS) {
          return
        }
        this.partialBuffers[localPartialId] = {
          t: helper.unixTime(),
          partSize: partSize,
          partsCount: partsCount,
          partsReceived: R.repeat(false, partsCount),
          dataLength: dataLength,
          receivedLength: 0,
          data: Buffer.allocUnsafe(dataLength)
        }
        p2p.send(Packet(p2p.PACK_DATA_PART_SIZE_OK).packFixed(msg.slice(9, 21)).get(), rinfo.port, rinfo.address)
      } else if (msg[0] === p2p.PACK_DATA_PART) {
        if (msg.slice(1, 9).equals(p2p.getId())) {
          return
        }
        p2p.send(Packet(p2p.PACK_DATA_PART_OK).packFixed(msg.slice(9, 17)).get(), rinfo.port, rinfo.address)
        let partialId = msg.slice(9, 13)
        let localPartialId = rinfo.address + '|' + rinfo.port + '|' + helper.bufToHex(partialId)
        if (this.partialBuffers[localPartialId]) {
          let partialBuffer = this.partialBuffers[localPartialId]
          let partId = msg.readUInt32BE(13)
          if (!partialBuffer.partsReceived[partId]) {
            partialBuffer.partsReceived[partId] = true
            let received = msg.slice(17)
            received.copy(partialBuffer.data, partId * partialBuffer.partSize)
            partialBuffer.receivedLength += received.length
            
            if (partialBuffer.receivedLength === partialBuffer.dataLength) {
              this.processCommand(this.partialBuffers[localPartialId].data, rinfo)
              delete this.partialBuffers[localPartialId]
            }
          }
        }
      }
    })

    p2p.on('messageSent', (msg, address, port, family, asClient) => {
      this.requestsCount++
      this.logBy('P2P', 'Sent', msg)
      this.logBy('P2P', 'To ' + address + ' port ' + port + ' ' + family + ' ' + (asClient ? 'c' : 's'))
    })
    
    p2p.on('newServer', (data) => {
      var isIpv6 = (data.family === 'IPv6')
      if (!storage.servers[data.address]) {
        storage.servers[data.address] = {rating: 0}
      }
      storage.servers[data.address].isIpv6 = isIpv6
      storage.servers[data.address].port = data.port
      this.broadcast(CmdPacker.pack(CmdPacker.CMD_SRV_INFO, {isIpv6: isIpv6, port: data.port, address: data.address}))
    })
    
    p2p.on('newClient', (data) => {
      let id = data.address + '|' + data.port
      this.log('Client ' + data.address + ':' + data.port + ' connected')
      if (!storage.session.clients) {
        storage.session.clients = {}
      }
      storage.session.clients[id] = {lastPing: helper.unixTime()}
    })

    p2p.on('netLoop', () => {
      this.logBy('P2P', 'Net Loop')
      delete storage.servers[this.currentServer.address]
    })

    p2p.on('clientMode', () => {
      this.logBy('P2P', 'Turned on client mode')
      this.clientMode = true
    })

    p2p.on('serverMode', () => {
      this.logBy('P2P', 'Turned on normal mode')
      this.clientMode = false
    })

    p2p.on('online', () => {
      this.logBy('P2P', 'Online')
      this.trigger('online')
      storage.servers[this.currentServer.address] && storage.servers[this.currentServer.address].rating++
    })

    p2p.on('offline', () => {
      this.logBy('P2P', 'Offline')
      this.trigger('offline')
      
      if (storage.servers[this.currentServer.address]) {
        storage.servers[this.currentServer.address].rating--
        
        if (storage.servers[this.currentServer.address].rating < -10) {
          delete storage.servers[this.currentServer.address]
        }
      }
      
      var serversWaiter = setInterval(() => {
        if (storage.servers && (_.size(storage.servers) > 0)) {
          clearInterval(serversWaiter)
          this.currentServer = {address: helper.randomItem(R.keys(storage.servers))}
          this.currentServer.port = storage.servers[this.currentServer.address].port
          p2p.reconnect(this.currentServer.address, this.currentServer.port)
        } else {
          this.log('Loading default servers')
          storage.reset()
        }
      }, 5000)
    })

    if ((config.myServerPort < 7000) || (config.myServerPort > 8000)) {
      this.trigger('error', 'Error in config: myServerPort should be between 7000 and 8000')
    }
    if (!storage.servers || (storage.servers.length === 0)) {
      this.trigger('error', 'Error: no servers in storage')
    }

    !disallowServerMode && p2p.listen(config.myServerPort)
    this.logBy('P2P', 'Local client port: ' + p2p.getLocalClientPort())
    
    var serversWaiter = setInterval(() => {
      if (storage.servers && (_.size(storage.servers) > 0)) {
        clearInterval(serversWaiter)
        this.currentServer = {address: helper.randomItem(R.keys(storage.servers))}
        this.currentServer.port = storage.servers[this.currentServer.address].port
        p2p.connect(this.currentServer.address, this.currentServer.port, disallowServerMode)
      } else {
        this.log('Waiting for new servers')
      }
    }, 5000)
  }
  
  send(data, port, address, callbacks) {
    if (data.length > PARTIAL_TRANSFER_SIZE) {
      let dataLength = data.length
      let partialId = helper.randomId(4)
      let parts = []
      while (data.length > PARTIAL_TRANSFER_SIZE) {
        parts.push(data.slice(0, PARTIAL_TRANSFER_SIZE))
        data = data.slice(PARTIAL_TRANSFER_SIZE)
      }
      if (data.length) {
        parts.push(data)
      }
      let partsCount = parts.length
      p2p.send(Packet(p2p.PACK_DATA_PART_SIZE).packFixed(p2p.getId()).packFixed(partialId).packNumber(dataLength, 4).packNumber(PARTIAL_TRANSFER_SIZE, 4).get(), port, address)
      p2p.wait(p2p.PACK_DATA_PART_SIZE_OK, port, address, 2000, {
        onRcvd: (msg) => {
          if (!msg.slice(1, 5).equals(partialId)) {
            return false
          }
          let accepted = 0
          let wasTimeout = false
          let sendPart = (i, attempts) => {
            if (attempts >= 3) {
              if (!wasTimeout) {
                wasTimeout = true
                callbacks && callbacks.onTimeout && callbacks.onTimeout()
              }
              return
            }
            let part = parts[i]
            p2p.send(Packet(p2p.PACK_DATA_PART).packFixed(p2p.getId()).packFixed(partialId).packNumber(i, 4).packFixed(part).get(), port, address)
            p2p.wait(p2p.PACK_DATA_PART_OK, port, address, 2000, {
              onRcvd: (msg) => {
                if ((!msg.slice(1, 5).equals(partialId)) || (i !== msg.readUInt32BE(5))) {
                  return false
                }
                accepted++
                if (accepted === partsCount) {
                  callbacks && callbacks.onAccept && callbacks.onAccept()
                }
              },
              onTimeout: () => {
                sendPart(i, attempts + 1)
              }
            })
          }
          for (let i in parts) {
            sendPart(parseInt(i), 0)
          }
        }
      })
    } else {
      let reqId = helper.randomId(4)
      p2p.send(Packet(p2p.PACK_DATA).packFixed(p2p.getId()).packFixed(reqId).packFixed(data).get(), port, address)
      p2p.wait(p2p.PACK_DATA_OK, port, address, 2000, {
        onRcvd: (msg) => {
          if (!msg.slice(1, 5).equals(reqId)) {
            return false
          }
          callbacks && callbacks.onAccept && callbacks.onAccept()
        },
        onTimeout: () => {
          callbacks && callbacks.onTimeout && callbacks.onTimeout()
        }
      })
    }
  }
  
  broadcast(data, ignoreBroadcastLog = false, toSend = 7) {
    var sendNext = () => {
      if (!addresses[index]) {
        return false
      }
      let address = addresses[index]
      index++
      if (!storage.servers[address]) {
        setTimeout(() => {
          sendNext()
        }, 1)
      } else {
        this.send(data, storage.servers[address].port, address, {
          onAccept: () => {
            sent++
          },
          onTimeout: () => {
            if (sent < toSend) {
              sendNext()
            }
          }
        })
      }
    }
    
    var dataBase = data.toString('base64')
    var localTime = helper.unixTime()
    if (!ignoreBroadcastLog) {
      if (!storage.session.broadcastLog) {
        storage.session.broadcastLog = {}
      } else {
        for (let i in storage.session.broadcastLog) {
          if (storage.session.broadcastLog[i] < localTime - 3600) {
            delete storage.session.broadcastLog[i]
          }
        }
        if (storage.session.broadcastLog[dataBase]) {
          return false
        }
      }
      storage.session.broadcastLog[dataBase] = localTime
    }
    
    for (let i in storage.session.clients) {
      let client = i.split('|')
      this.send(data, client[1], client[0])
    }
    
    var addresses = _.shuffle(R.filter(i => (this.config.allowIpv4 && !storage.servers[i].isIpv6) || (this.config.allowIpv6 && storage.servers[i].isIpv6), R.keys(storage.servers)))
    var cnt = addresses.length
    if (cnt === 0) {
      this.trigger('error', 'No addresses for broadcast available. Check your config.js.')
    }
    var index = 0
    var sent = 0
    for (let i = 0; i < toSend * 2 + 1; i++) {
      sendNext()
    }
    
    return true
  }
}

const net = new Net()
module.exports = net