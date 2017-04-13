'use strict'

const R = require('ramda')
const rpc = require('node-json-rpc')

const Component = require('./Component')
const helper = require('./helper')
const storage = require('./Storage')
const Address = require('./Address')
const Tx = require('./Tx')

module.exports = new class RpcServer extends Component {

  constructor() {
    super()
    this.module = 'RPC'
    this.server = new rpc.Server({host: storage.config.rpcHost, port: storage.config.rpcPort})
    this.lastRequestId = 0
    
    /* Miner */
    this.server.addMethod('getMiningTask', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd getMiningTask, nonce=' + params.nonce + ', hps=' + params.hps)
      storage.trigger('minerReqTask')
      if ((params.nonce !== undefined) && (params.hps !== undefined)) {
        storage.session.stat.hpsList[params.nonce] = params.hps
        storage.session.stat.hps = helper.countToStr(R.reduce((a, b) => a + b, 0, R.values(storage.session.stat.hpsList)))
      }
      if (storage.miningTask && storage.miningTask.active && !storage.session.forkProcessor) {
        this.log('#' + requestId + ' Sent {green-fg}active=1{/green-fg}')
        callback(null, storage.miningTask)
      } else {
        this.log('#' + requestId + ' Sent {red-fg}active=0{/red-fg}')
        callback(null, {
          active: 0
        })
      }
    })
    this.server.addMethod('blockFound', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd blockFound, txs=' + params.txHashList.length)
      storage.trigger('minerBlockFound', params.hash, params.blockData, params.txHashList, (status) => {
        storage.trigger('log', 'FND', 'Sent ' + status)
        this.log('#' + requestId + ' Sent {yellow-fg}' + status + '{/yellow-fg}')
        callback(null, {
          status: status
        })
      })
    })
    this.server.addMethod('getBlockConfirmationsCount', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd getBlockConfirmationsCount')
      storage.trigger('getBlockConfirmationsCount', params.hash, (count) => {
        this.log('#' + requestId + ' Sent {yellow-fg}count=' + count + '{/yellow-fg}')
        callback(null, {
          count
        })
      })
    })
    
    /* Wallet */
    this.server.addMethod('walletCreate', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletCreate')
      const {wallet} = storage.localSession
      if (!wallet.create(params.password)) {
        this.log('#' + requestId + ' Sent {red-fg}Wallet already exists{/red-fg}')
        callback({code: -1004, message: 'Wallet already exists'})
        return
      }
      wallet.attachAddress(Address.create())
      wallet.updateData((updated) => {
        if (updated) {
          this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
          callback(null, {status: 'success'})
        } else {
        this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletOpen', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletOpen')
      const {wallet} = storage.localSession
      if (!wallet.exists()) {
        this.log('#' + requestId + ' Sent {red-fg}Wallet is not created{/red-fg}')
        callback({code: -1003, message: 'Wallet is not created'})
        return
      }
      if (!wallet.open(params.password)) {
        this.log('#' + requestId + ' Sent {red-fg}Wrong password{/red-fg}')
        callback({code: -1000, message: 'Wrong password'})
        return
      }
      wallet.updateData((updated) => {
        if (updated) {
          this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
          callback(null, {status: 'success'})
        } else {
          this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletGetBalances', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletGetBalances')
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
          this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
          callback(null, {status: 'success', balances})
        } else {
          this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletGetTransactionsConfirmedUnspent', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletGetTransactionsConfirmedUnspent')
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
          this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
          callback(null, {status: 'success', transactions: params.address ? processTxs(txs[params.address]) : R.map((txsAddr) => processTxs(txsAddr), txs)})
        } else {
          this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
          callback({code: -1001, message: 'Wallet is not opened'})
        }
      })
    })
    this.server.addMethod('walletSendCoins', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletSendCoins')
      const {wallet} = storage.localSession
      if (!wallet.isOpened()) {
        this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      if (params.recipients) {
        const result = wallet.sendCoinsMulti(params, ({type, message, fee}) => {
          if (type === 'error') {
            this.log('#' + requestId + ' Sent {red-fg}' + message + '{/red-fg}')
            callback({code: -1002, message})
          } else {
            this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
            callback(null, {status: 'success', fee})
          }
        })
      } else {
        const result = wallet.sendCoins(params, ({type, message, fee}) => {
          if (type === 'error') {
            this.log('#' + requestId + ' Sent {red-fg}' + message + '{/red-fg}')
            callback({code: -1002, message})
          } else {
            this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
            callback(null, {status: 'success', fee})
          }
        })
      }
    })
    this.server.addMethod('walletCreateAddress', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletCreateAddress')
      const {wallet} = storage.localSession
      if (!wallet.isOpened()) {
        this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
      callback(null, {status: 'success', address: wallet.createAddress().getAddress()})
    })
    this.server.addMethod('walletSpendTransaction', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd walletSpendTransaction')
      const {wallet} = storage.localSession
      if (!wallet.isOpened()) {
        this.log('#' + requestId + ' Sent {red-fg}Wallet is not opened{/red-fg}')
        callback({code: -1001, message: 'Wallet is not opened'})
        return
      }
      
      wallet.spendTransaction(params, ({type, message, amount, fee}) => {
        if (type === 'error') {
          this.log('#' + requestId + ' Sent {red-fg}' + message + '{/red-fg}')
          callback({code: -1002, message})
        } else {
          this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
          callback(null, {status: 'success', message, amount, fee})
        }
      })
    })
    
    /* Info */
    this.server.addMethod('infoMinimalFee', (params, callback) => {
      const requestId = this.lastRequestId++
      this.log('#' + requestId + ' Rcvd infoMinimalFee')
      this.log('#' + requestId + ' Sent {green-fg}success{/green-fg}')
      callback(null, {status: 'success', minimalFee: Tx.MIN_FEE})
    })
    
    this.server.start((err) => {
      err && storage.trigger('fatalError', err)
    })
  }
}