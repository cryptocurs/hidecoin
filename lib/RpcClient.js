'use strict'

const rpc = require('node-json-rpc')

const storage = require('./Storage')

module.exports = new class RpcClient {

  constructor() {
    this.client = new rpc.Client({port: storage.config.rpcPort || 5839, host: storage.config.rpcHost || 'localhost'})
  }
  
  call(method, params, callback) {
    let timeout = setTimeout(() => {
      timeout = null
      callback(null)
    }, 300000)
    this.client.call({method: method, params: params}, (err, res) => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
        callback(err ? null : res)
      }
    })
  }
}