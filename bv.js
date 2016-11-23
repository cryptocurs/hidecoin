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
}
console.log('Blockchain length:', blockchain.getLength())
setTimeout(() => {
    process.exit()
}, 1000)