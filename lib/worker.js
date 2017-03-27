'use strict'

const helper = require('./helper')
const storage = require('./Storage')

storage.session.disableLog = true

process.on('message', ({cmd, cmdData}) => {
  const send = (data) => {
    process.send(data)
  }
  
  helper.restoreObject(cmdData)
  
  if (cmd === 'update.blockchain.spends') {
    const {spends} = cmdData
    storage.session.blockchain.spends = spends
    send({state: 'blockchain.cache.spends.updated.length=' + storage.session.blockchain.spends.length})
  } else if (cmd === 'update.blockchain.spends.add') {
    const synchronizer = require('./Synchronizer')
    
    const {spend} = cmdData
    synchronizer.addSpend(spend)
    send({state: 'blockchain.cache.spends.updated.added.length=' + storage.session.blockchain.spends.length})
  } else if (cmd === 'update.blockchain.txmap') {
    const {txMap} = cmdData
    storage.session.blockchain.txMap = helper.unzipTxMap(txMap)
    send({state: 'blockchain.cache.txmap.updated.length=' + storage.session.blockchain.txMap.length})
  } else if (cmd === 'update.blockchain.txmap.add') {
    const synchronizer = require('./Synchronizer')
    
    const {txInfo} = cmdData
    synchronizer.addTxToMap(txInfo)
    send({state: 'blockchain.cache.txmap.updated.added.length=' + storage.session.blockchain.txMap.length})
  } else if (cmd === 'update.freetxs') {
    const {freeTxs} = cmdData
    storage.freeTxs = freeTxs
    send({state: 'freetxs.updated'})
  } else if (cmd === 'update.blockchain.index.add') {
    const blockchain = require('./Blockchain')
    
    const {indexRecord} = cmdData
    blockchain.addToIndexCached(indexRecord)
    send({state: 'blockchain.cache.index.updated.length=' + blockchain.getLength()})
  } else if (cmd === 'update.blockchain.index.remove') {
    const blockchain = require('./Blockchain')
    
    const {count} = cmdData
    blockchain.removeFromIndexCached(count)
    send({state: 'blockchain.cache.index.updated.length=' + blockchain.getLength()})
  } else if (cmd === 'performTask') {
    send({state: 'task.received'})
    const {kind, params, storage: masterStorage} = cmdData
    const clusterName = kind.match(/(^\w*)/)[1]
    if (masterStorage) {
      for (const i in masterStorage) {
        storage[i] = masterStorage[i]
      }
      send({state: 'storage.updated'})
    }
    if (clusterName === 'block') {
      var synchronizer = require('./Synchronizer')
      var Block = require('./Block')
      var blockchain = require('./Blockchain')
      
      // TODO: automatic update of blockchain for blockchainMemory=true or remove blockchainMemory
      if (!synchronizer.isCached()) {
        synchronizer.cache()
        send({state: 'blockchain.cache.spends.created.length=' + storage.session.blockchain.spends.length})
        send({state: 'blockchain.cache.txmap.created.length=' + storage.session.blockchain.txMap.length})
      }
    }
    if (kind === 'block.cache') {
      send({result: {spends: storage.session.blockchain.spends, txMap: helper.zipTxMap(storage.session.blockchain.txMap)}})
    } else if (kind === 'block.validate') {
      send({state: 'block.validating.length=' + params.data.length})
      Block.isValidNew(params.hash, params.data, (valid, unpacked, txUnpackedList) => {
        send({state: 'block.validating.done=' + (valid ? 'valid' : 'not valid ' + Block.getError() + ' ' + blockchain.getLength())})
        send({result: {valid, unpacked, txUnpackedList, lastBlockValidationError: Block.getError()}})
      }, params.promiscuous)
    } else if (kind === 'block.get.balances') {
      const balances = Block.getAddressesBalanceSep(params.addresses, null, {
        onCheckpointLoaded: (blockId) => {
          send({state: 'block.checkpoint.loaded.to=' + blockId})
        },
        onCheckpointCreated: (blockId) => {
          send({state: 'block.checkpoint.created.to=' + blockId})
        }
      }, params.login)
      send({result: {balances}})
    } else {
      send({result: {error: 'Unknown kind of task'}})
    }
  } else if (cmd === 'exit') {
    process.exit()
  }
})