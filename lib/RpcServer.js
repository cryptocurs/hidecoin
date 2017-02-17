'use strict'

const R = require('ramda')
const rpc = require('node-json-rpc')

const helper = require('./helper')
const storage = require('./Storage')
const Tx = require('./Tx')

module.exports = new class RpcServer {

  constructor() {
    this.server = new rpc.Server({host: storage.config.rpcHost, port: storage.config.rpcPort})
    
    /* Miner */
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
    
    /* Wallet */
    this.server.addMethod('walletOpen', (params, callback) => {
      const {wallet} = storage.session
      if (!wallet.open(params.password)) {
        callback({code: -1000, message: 'Wrong password'})
        return
      }
      wallet.updateData()
      callback(null, {status: 'success'})
    })
    this.server.addMethod('walletGetBalances', (params, callback) => {
      const {wallet} = storage.session
      const content = wallet.getContent()
      if (!content.length) {
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      let balances = {}
      wallet.updateData()
      const {balances: balancesHard, balancesSoft, balancesUnconfirmed} = wallet.getData()
      for (let addr in balancesHard) {
        balances[addr] = {
          confirmed: balancesHard[addr],
          confirmedLow: balancesSoft[addr],
          unconfirmed: balancesUnconfirmed[addr]
        }
      }
      callback(null, {status: 'success', balances})
    })
    this.server.addMethod('walletSendCoins', (params, callback) => {
      const {wallet} = storage.session
      const content = wallet.getContent()
      if (!content.length) {
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      const result = wallet.sendCoins(params, ({type, message}) => {
        if (type === 'error') {
          callback({code: -1002, message})
        } else {
          callback(null, {status: 'success'})
        }
      })
    })
    
    this.server.start((err) => {
      err && storage.trigger('fatalError', err)
    })
  }
}