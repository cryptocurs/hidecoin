'use strict'

const config = require('./config')
const helper = require('./lib/helper')
const hours = require('./lib/Hours')
const storage = require('./lib/Storage')
const Block = require('./lib/Block')

storage.config = config
storage.config.listenRpcPort = 5840
storage.config.callRpcPort = 5839
const rpcClient = require('./lib/RpcClient')

hours.sync()

console.log('Miner runned')

const HASHES_PER_CYCLE = 100000
var nonce = 0
var working = false

function continueMining() {
  if (working) {
    console.log('Already mining')
    return
  }
  working = true
  console.log('Requesting fresh data')
  rpcClient.call('getMiningTask', {}, (res) => {
    if (!res || !res.result) {
      console.log('Request error')
      setTimeout(continueMining, 1000)
      working = false
      return
    }
    
    const result = res.result
    if (!result.active) {
      console.log('Mining suspended')
      setTimeout(continueMining, 1000)
      working = false
      return
    }
    
    const block = helper.baseToBuf(result.blockData)
    const header = block.slice(0, result.blockHeaderSize)
    
    console.log('Received fresh data, block size', block.length, 'bytes')
    
    let hash
    const timeStart = helper.unixTimeMs()
    for (let i = 0; i < HASHES_PER_CYCLE; i++) {
      nonce++
      Block.set(block, {
        nonce: nonce
      })
      hash = Block.calcHash(header)
      if (hash) {
        console.log('FOUND', hash.toString('hex'))
        rpcClient.call('blockFound', {hash: helper.bufToBase(hash), blockData: helper.bufToBase(block), txHashList: result.txHashList}, (res) => {
          res && res.status && console.log(res.status)
        })
        setTimeout(continueMining, 500)
        working = false
        return
      }
    }
    
    const duration = helper.unixTimeMs() - timeStart
    const speed = parseInt(HASHES_PER_CYCLE * 1000 / duration)
    console.log('Min.', speed, 'HPS', Block.unpackDiff(header).toString('hex'))
    
    working = false
    continueMining()
  })
}

continueMining()