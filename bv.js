'use strict'

const blockchain = require('./lib/Blockchain')
const Block = require('./lib/Block')
const Tx = require('./lib/Tx')

const action = process.argv[2] || process.exit(0)

if (action === 'e') {
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
} else if (action === 'v') {
  let id
  if (id = process.argv[3]) {
    const block = blockchain.get(parseInt(id))
    block && console.log(block.hash.toString('hex'), block.data.length)
  }
}

console.log('Blockchain length:', blockchain.getLength())
setTimeout(() => {
    process.exit()
}, 1000)