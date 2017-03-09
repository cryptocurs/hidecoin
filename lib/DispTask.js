'use strict'

const disp = require('./Disp')

module.exports = {
  blockCache: (callback) => {
    disp.createThreadExclusiveCluster({
      alias: 'block.worker',
      kind: 'block.cache',
      priority: 1
    }, callback)
  },
  blockValidate: (hash, data, promiscuous, priority, callback) => {
    disp.createThread({
      alias: 'block.worker',
      kind: 'block.validate',
      params: {hash, data, promiscuous},
      priority
    }, callback)
  },
  blockGetBalances: (addresses, callback) => {
    disp.createThread({
      alias: 'block.worker',
      kind: 'block.get.balances',
      params: {addresses},
      priority: 1
    }, callback)
  }
}