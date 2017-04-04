'use strict'

const R = require('ramda')
const rpc = require('node-json-rpc')

const helper = require('./helper')
const storage = require('./Storage')
const Address = require('./Address')
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
      if (storage.miningTask && storage.miningTask.active && !storage.session.forkProcessor) {
        callback(null, storage.miningTask)
      } else {
        callback(null, {
          active: 0
        })
      }
    })
    this.server.addMethod('blockFound', (params, callback) => {
      storage.trigger('minerBlockFound', params.hash, params.blockData, params.txHashList, (status) => {
        storage.trigger('log', 'FND', 'Sent ' + status)
        callback(null, {
          status: status
        })
      })
    })
    this.server.addMethod('getBlockConfirmationsCount', (params, callback) => {
      storage.trigger('getBlockConfirmationsCount', params.hash, (count) => {
        callback(null, {
          count
        })
      })
    })
    
    /* Wallet */
    this.server.addMethod('walletCreate', (params, callback) => {
      const {wallet} = storage.localSession
      if (!wallet.create(params.password)) {
        callback({code: -1004, message: 'Wallet already exists'})
        return
      }
      wallet.attachAddress(Address.create())
      wallet.updateData((updated) => {
        if (updated) {
          callback(null, {status: 'success'})
        } else {
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletOpen', (params, callback) => {
      const {wallet} = storage.localSession
      if (!wallet.exists()) {
        callback({code: -1003, message: 'Wallet is not created'})
        return
      }
      if (!wallet.open(params.password)) {
        callback({code: -1000, message: 'Wrong password'})
        return
      }
      wallet.updateData((updated) => {
        if (updated) {
          callback(null, {status: 'success'})
        } else {
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletGetBalances', (params, callback) => {
      const {wallet} = storage.localSession
      let balances = {}
      wallet.updateData((updated) => {
        if (updated) {
          const {balances: balancesHard, balancesSoft, balancesUnconfirmed} = wallet.getData()
          for (let addr in balancesHard) {
            balances[addr] = {
              confirmed: balancesHard[addr],
              confirmedLow: balancesSoft[addr],
              unconfirmed: balancesUnconfirmed[addr]
            }
          }
          callback(null, {status: 'success', balances})
        } else {
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletGetTransactionsConfirmedUnspent', (params, callback) => {
      const processTx = (tx) => {
        if (tx.spent || tx.spentFreeTxs) {
          return null
        }
        
        const {blockId, blockTime, hash, outN, value, confirmations} = tx
        return  {
          blockId,
          blockTime,
          hash: hash.toString('hex'),
          outN,
          value,
          confirmations
        }
      }
      
      const processTxs = (txs) => {
        return R.filter(i => i, R.map(processTx, txs))
      }
      
      const {wallet} = storage.localSession
      wallet.updateData((updated) => {
        if (updated) {
          const {txs} = wallet.getData()
          callback(null, {status: 'success', transactions: params.address ? processTxs(txs[params.address]) : R.map((txsAddr) => processTxs(txsAddr), txs)})
        } else {
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletSendCoins', (params, callback) => {
      const {wallet} = storage.localSession
      if (!wallet.isOpened()) {
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      if (params.recipients) {
        const result = wallet.sendCoinsMulti(params, ({type, message, fee}) => {
          if (type === 'error') {
            callback({code: -1002, message})
          } else {
            callback(null, {status: 'success', fee})
          }
        })
      } else {
        const result = wallet.sendCoins(params, ({type, message, fee}) => {
          if (type === 'error') {
            callback({code: -1002, message})
          } else {
            callback(null, {status: 'success', fee})
          }
        })
      }
    })
    this.server.addMethod('walletCreateAddress', (params, callback) => {
      const {wallet} = storage.localSession
      if (!wallet.isOpened()) {
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      callback(null, {status: 'success', address: wallet.createAddress().getAddress()})
    })
    
    /* Info */
    this.server.addMethod('infoMinimalFee', (params, callback) => {
      callback(null, {status: 'success', minimalFee: Tx.MIN_FEE})
    })
    
    this.server.start((err) => {
      err && storage.trigger('fatalError', err)
    })
  }
}