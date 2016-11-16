'use strict'

console.log('XHD Core loading...')
const config = require('./config')
console.log(config)

const fs = require('fs')
const blessed = require('blessed')
const R = require('ramda')

const helper = require('./lib/helper')
const hours = require('./lib/Hours')
const storage = require('./lib/Storage')
const Address = require('./lib/Address')
const blockchain = require('./lib/Blockchain')
const net = require('./lib/Net')
const miner = require('./lib/Miner')
const synchronizer = require('./lib/Synchronizer')

storage.logIgnoreModules = ['P2P']

if (process.argv[2] === '--clear-storage') {
  storage.freeTxs = {}
  storage.flush()
  process.exit()
}

setInterval(() => {
  storage.flush()
}, 60000)

storage.on('fatalError', (msg) => {
  screen.destroy()
  console.log('Fatal error: ' + msg)
  process.exit(0)
})

net.once('error', (msg) => {
  screen.destroy()
  console.log(msg)
  process.exit(0)
})

net.once('online', () => {
  console.log('CORE: Synchronizing blockchain...')
  synchronizer.remote(() => {
    console.log('CORE: Blockchain synchronized')
    if (config.minerMode) {
      miner.run(R.map(i => Address.hashToRaw(i), config.minerAddresses))
    }
  })
})

net.on('offline', () => {
})

var onNewBlock = (hash, block, unpacked) => {
  let deleted = 0
  for (let i in unpacked.txHashList) {
    if (Tx.freeTxDelete(unpacked.txHashList[i])) {
      deleted++
    }
  }
  console.log('CORE: Free txs deleted: ' + deleted)
  
  miner.restart()
}

synchronizer.on('blockAfterAccept', (afterHash, hash, block, unpacked) => {
  onNewBlock(hash, block, unpacked)
})

synchronizer.on('blockFoundAccept', (hash, block, unpacked) => {
  onNewBlock(hash, block, unpacked)
})

synchronizer.on('txInfoAccept', (hash, tx, fee) => {
  if (fee >= config.minerMinimalFee) {
    console.log('CORE: Free tx accepted')
    Tx.freeTxAdd(hash, tx, fee)
    synchronizer.broadcastTx(hash, tx)
    
    miner.restart()
  }
})

var screen = blessed.screen({
  smartCSR: true
})

screen.render()

screen.key('f9', () => {
  console.log('CORE: current time', hours.now())
})

screen.key('f10', () => {
  storage.flush()
  process.exit(0)
})

hours.sync()
setTimeout(() => {
  console.log('F10 - quit')
  console.log(storage.servers)
  setTimeout(() => {
    console.log('CORE: connection may take some time')
    net.connect(config)
  }, 1000)
}, 2000)

/* Wallet */
const express = require('express')
const bodyParser = require('body-parser')

const login = process.argv[2] || 'wallet'
const base = __dirname + '/templates/'

const Block = require('./lib/Block')
const Tx = require('./lib/Tx')
const Wallet = require('./lib/Wallet')
const wallet = Wallet(login)
var balances = {}
var balancesUnconfirmed = {}
var txs = {}
var keys = {}
var allAmount = 0
var allAmountUnconfirmed = 0
var opened = false

var updateData = () => {
  let addresses = wallet.getContent()
  balances = {}
  balancesUnconfirmed = {}
  txs = {}
  keys = {}
  allAmount = 0
  allAmountUnconfirmed = 0
  for (let i in addresses) {
    let address = new Address(addresses[i])
    let addr = address.getAddress()
    let data = Block.getAddressBalance(address.getAddressRaw())
    let dataUnconfirmed = Tx.getAddressBalanceUnconfirmed(address.getAddressRaw())
    balances[addr] = data.balance
    balancesUnconfirmed[addr] = dataUnconfirmed.balance
    txs[addr] = data.txs
    keys[addr] = address.getKeys()
    allAmount += data.balance
    allAmountUnconfirmed += dataUnconfirmed.balance
  }
  return addresses.length
}

var sendData = (socket) => {
  socket.json.send({
    balances: balances,
    balancesUnconfirmed: balancesUnconfirmed,
    txs: txs,
    allAmount: (allAmount / 100000000).toFixed(8),
    allAmountUnconfirmed: (allAmountUnconfirmed / 100000000).toFixed(8)
  })
}

var app = express()
app.use(bodyParser.urlencoded({extended: false}))
var server = app.listen(config.walletPort, config.walletHost)
var io = require('socket.io').listen(server)
io.sockets.on('connection', function(socket) {
  socket.on('message', function (data) {
    setInterval(() => {
      updateData()
      sendData(socket)
    }, 10000)
    if (!opened) {
      socket.json.send({reload: true})
    } else if (data.get === 'balances') {
      sendData(socket)
    } else if (data.post === 'address') {
      wallet.attachAddress(Address.create())
      updateData()
      sendData(socket)
    } else if (data.post === 'coins') {
      data.amount = data.amount || 0
      data.amountm = data.amountm || 0
      data.fee = data.fee || 0
      
      if (!Address.isValid(data.address)) {
        socket.json.send({noty: {type: 'error', message: 'Enter correct address'}})
				return
      }
      
			let toSend = parseInt(data.amount) * 100000000 + parseInt(data.amountm)
			if (toSend <= 0) {
				socket.json.send({noty: {type: 'error', message: 'Enter correct sum'}})
				return
			}
      let toReceive = toSend
      
			let txFee = parseInt(data.fee)
      txFee *= 100000000
			if (txFee < config.minerMinimalFee) {
				socket.json.send({noty: {type: 'error', message: 'Enter correct fee'}})
				return
			}
      toSend += txFee
      
			if (allAmount < toSend) {
				socket.json.send({noty: {type: 'error', message: 'Not enough micoins'}})
				return
			}
      
      let sortedAddrs = R.sort((a, b) => {
				return balances[b] - balances[a]
			}, R.keys(balances))
      
      let txIns = []
      let txOuts = [{address: Address.hashToRaw(data.address), value: toReceive}]
      let txKeys = []
      let txKeyId = -1
			
			for (let i in sortedAddrs) {
				if (toSend <= 0) {
					break
				}
				let addr = sortedAddrs[i]
        
        txKeys.push({
          publicKey: keys[addr].publ
        })
        txKeyId++
				
				let sortedTxs = R.sort((a, b) => {
					return a.value - b.value
				}, txs[addr])
				
				for (let t in sortedTxs) {
					if (toSend <= 0) {
						break
					}
					let curTx = sortedTxs[t]
					let value = curTx.value
					
					txIns.push({
						txHash: curTx.hash,
						outN: curTx.outN,
            keyId: txKeyId,
						sign: null,
            addr: addr
					})
					
					toSend -= value
				}
			}
      
      if (toSend < 0) {
        txOuts.push({address: Address.hashToRaw(sortedAddrs[0]), value: -toSend})
      }
      let txOutsRaw = Tx.packOuts(txOuts)
      
			helper.processList(txIns, {
				onProcess: (item, callback) => {
          helper.signData(Buffer.concat([Tx.packHashOutN(item), txOutsRaw]), keys[item.addr].priv, (sign) => {
            item.sign = sign
            delete item.addr
            callback()
          })
				},
				onReady: () => {
					let tx = {
            time: hours.now(),
            txKeyCount: txKeys.length,
            txInCount: txIns.length,
            txOutCount: txOuts.length,
            txKeys: txKeys,
            txIns: txIns,
            txOutsRaw: txOutsRaw
          }
          let txPacked = Tx.pack(tx)
          let txHash = helper.hash(txPacked)
          Tx.isValid(txHash, txPacked, null, blockchain.getLength(), false, (valid) => {
            if (valid) {
              Tx.freeTxAdd(txHash, txPacked, txFee)
              miner.restart()
              updateData()
              sendData(socket)
              socket.json.send({noty: {type: 'success', message: 'Coins has been sent'}})
              
              synchronizer.broadcastTx(txHash, txPacked)
            }
          }, 0, tx)
				}
			})
    }
  })
})
app.get('/', function(req, res) {
  res.send(fs.readFileSync(base + 'index.html', 'utf8').replace('%LOGIN%', login))
})
app.get('/assets/*', function(req, res) {
  let url = req.params[0]
  if (R.contains(url, ['bootstrap.min.css'])) {
    res.set('Content-type', 'text/css')
    res.send(fs.readFileSync(base + url, 'utf8'))
  } else if (R.contains(url, ['jquery.min.js', 'bootstrap.min.js', 'jquery.noty.packaged.min.js'])) {
    res.set('Content-type', 'application/javascript')
    res.send(fs.readFileSync(base + url, 'utf8'))
  }
})
app.post('/', function(req, res) {
  let created = wallet.create(req.body.password)
  if (created) {
    wallet.attachAddress(Address.create())
  } else {
    wallet.open(req.body.password)
  }
  if (updateData()) {
    opened = true
    res.send(fs.readFileSync(base + 'wallet.html', 'utf8'))
  } else {
    res.redirect('/')
  }
})