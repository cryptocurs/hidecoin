'use strict'

const R = require('ramda')
const rpc = require('node-json-rpc')

const helper = require('./helper')
const storage = require('./Storage')

module.exports = new class RpcServer {

  constructor() {
    this.server = new rpc.Server({host: storage.config.rpcHost, port: storage.config.rpcPort})
    this.server.addMethod('getMiningTask', (params, callback) => {
      storage.trigger('minerReqTask')
      if ((params.nonce !== undefined) && (params.hps !== undefined)) {
        storage.session.stat.hpsList[params.nonce] = params.hps
        storage.session.stat.hps = helper.countToStr(R.reduce((a, b) => a + b, 0, R.values(storage.session.stat.hpsList)))
      }
      if (storage.miningTask && storage.miningTask.active && !storage.session.forkProcessor && !storage.session.synchronizing) {
        const task = storage.miningTask
        task.active = 1
        callback(null, task)
      } else {
        callback(null, {
          active: 0
        })
      }
    })
    this.server.addMethod('blockFound', (params, callback) => {
      storage.trigger('minerBlockFound', params.hash, params.blockData, params.txHashList, (status) => {
        storage.trigger('log', 'MNR', 'Sent ' + status)
        callback(null, {
          status: status
        })
      })
    })
    this.server.start((err) => {
      err && storage.trigger('fatalError', err)
    })
  }
}