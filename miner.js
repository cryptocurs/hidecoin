'use strict'

const config = require('./config')
const helper = require('./lib/helper')
const hours = require('./lib/Hours')
const storage = require('./lib/Storage')
const Block = require('./lib/Block')
const Packet = require('./lib/Packet')

storage.config = config
storage.config.listenRpcPort = 5840
storage.config.callRpcPort = 5839
const rpcClient = require('./lib/RpcClient')

hours.sync()

console.log('Miner runned')

var hashesPerCycle = 100000
var nonce = 0
var working = false

const args = process.argv
for (let i = 2; i < args.length; i++) {
  if ((args[i] === '--hpc') && (args[i + 1] !== undefined)) {
    hashesPerCycle = args[i + 1]
  } else if ((args[i] === '--nonce') && (args[i + 1] !== undefined)) {
    const buffer = Buffer.alloc(8, 0x00)
    let argNonce = args[i + 1]
    if (argNonce.length % 2) {
      argNonce = '0' + argNonce
    }
    const nonceBuffer = Buffer.from(argNonce, 'hex')
    nonceBuffer.copy(buffer, 8 - nonceBuffer.length)
    nonce = Packet(buffer).unpackNumber64()
  }
}

const initNonce = nonce
var hps = 0

console.log('Configuration')
console.log('HPC     :', hashesPerCycle)
console.log('Nonce   :', nonce)

function continueMining() {
  if (working) {
    console.log('Already mining')
    return
  }
  working = true
  console.log('Requesting fresh data')
  rpcClient.call('getMiningTask', {nonce: initNonce, hps: hps}, (res) => {
    if (!res || !res.result) {
      console.log('Request error')
      setTimeout(continueMining, 1000)
      working = false
      return
    }
    
    const result = res.result
    if (!result.active) {
      console.log('Mining suspended')
      hps = 0
      working = false
      setTimeout(continueMining, 1000)
      return
    }
    
    const block = helper.baseToBuf(result.blockData)
    const header = block.slice(0, result.blockHeaderSize)
    
    console.log('Received fresh data, block size', block.length, 'bytes')
    
    let hash
    const timeStart = helper.unixTimeMs()
    for (let i = 0; i < hashesPerCycle; i++) {
      nonce = (nonce < 0xffffffffffff0000 ? nonce + 1 : 0)
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
    hps = parseInt(hashesPerCycle * 1000 / duration)
    console.log('Min.', hps, 'HPS', Block.unpackDiff(header).toString('hex'))
    
    working = false
    continueMining()
  })
}

continueMining()