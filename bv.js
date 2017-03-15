'use strict'

const blockchain = require('./lib/Blockchain')
const Block = require('./lib/Block')
const Tx = require('./lib/Tx')

var id = process.argv[2] || process.exit(0)
var toId = null

if (id === 'e') {
  let maxId
  if (maxId = process.argv[3]) {
    blockchain.eachTo(maxId, (block) => {
      console.log(block.id, block.hash.toString('hex'))
    })
  } else {
    blockchain.each((block) => {
      console.log(block.id, block.hash.toString('hex'))
    })
  }
} else if (id === 'r') {
  blockchain.removeLast(null, process.argv[3] || 5)
} else if (id === '--repair') {
  let hasErrors = true
  while (hasErrors) {
    console.log('Checking blockchain...')
    const len = blockchain.getLength()
    console.log('Length:', len)
    const {hash, data} = blockchain.get(len - 1)
    console.log('Hash of last block:', hash.toString('hex'))
    if (hash.equals(Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'))) {
      console.log('Error in blockchain')
      console.log('Repairing blockchain...')
      blockchain.removeLast(null, 1)
    } else if (data[0] === 0) {
      console.log('Error in blockchain')
      console.log('Repairing blockchain...')
      blockchain.removeLast(null, 1)
    } else {
      hasErrors = false
    }
  }
  console.log('No errors in blockchain')
}
console.log('Blockchain length:', blockchain.getLength())
setTimeout(() => {
    process.exit()
}, 1000)