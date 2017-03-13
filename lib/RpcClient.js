'use strict'

const rpc = require('node-json-rpc')

const storage = require('./Storage')

module.exports = new class RpcClient {

  constructor() {
    this.client = new rpc.Client({port: storage.config.rpcPort, host: storage.config.rpcHost})
  }
  
  call(method, params, callback) {
    let timeout = setTimeout(() => {
      callback(null)
    }, 1000)
    this.client.call({method: method, params: params}, (err, res) => {
      clearTimeout(timeout)
      callback(err ? null : res)
    })
  }
}