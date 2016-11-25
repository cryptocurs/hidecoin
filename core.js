'use strict'

console.log('XHD Core loading...')
const config = require('./config')
console.log(config)

const fs = require('fs')
const R = require('ramda')

const helper = require('./lib/helper')
const hours = require('./lib/Hours')
const storage = require('./lib/Storage')
const Address = require('./lib/Address')
const blockchain = require('./lib/Blockchain')
const Block = require('./lib/Block')
const net = require('./lib/Net')
const miner = require('./lib/Miner')
const synchronizer = require('./lib/Synchronizer')
const ifc = require('./lib/Interface')

function log(...data) {
  storage.trigger('log', ...data)
}

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
  ifc.close()
  log('Fatal error: ' + msg)
  process.exit(0)
})

net.once('error', (msg) => {
  ifc.close()
  log(msg)
  process.exit(0)
})

net.once('online', () => {
  log('CORE: Synchronizing blockchain...')
  synchronizer.remote(() => {
    log('CORE: Blockchain synchronized')
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
  log('CORE: Free txs deleted: ' + deleted)
  
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
    log('CORE: Free tx accepted')
    Tx.freeTxAdd(hash, tx, fee)
    synchronizer.broadcastTx(hash, tx)
    
    miner.restart()
  }
})

ifc.key('f8', () => {
  log(storage.servers)
})

ifc.key('f9', () => {
  log('CORE: current time', hours.now())
})

ifc.key('f10', () => {
  storage.flush()
  process.exit(0)
})

hours.sync()
setTimeout(() => {
  log('F10 - quit')
  setTimeout(() => {
    log('CORE: blockchain caching...')
    synchronizer.cache()
    log('CORE: blockchain cached')
    log('CORE: connection may take some time')
    net.connect(config)
  }, 1000)
}, 2000)

/* Wallet */
const express = require('express')
const bodyParser = require('body-parser')

const login = process.argv[2] || 'wallet'
const base = __dirname + '/templates/'

const Tx = require('./lib/Tx')
const Wallet = require('./lib/Wallet')
const wallet = Wallet(login)
const walletData = {
  balances: {},
  balancesSoft: {},
  balancesUnconfirmed: {},
  txs: {},
  txsSoft: {},
  keys: {},
  allAmount: 0,
  allAmountSoft: 0,
  allAmountUnconfirmed: 0
}
const wallets = {}
const walletsData = {}
var opened = false

var def = (value) => {
  return value !== undefined
}

var updateData = (wallet, walletData) => {
  let addresses = wallet.getContent()
  walletData.balances = {}
  walletData.balancesSoft = {}
  walletData.balancesUnconfirmed = {}
  walletData.txs = {}
  walletData.txsSoft = {}
  walletData.keys = {}
  walletData.allAmount = 0
  walletData.allAmountSoft = 0
  walletData.allAmountUnconfirmed = 0
  for (let i in addresses) {
    let address = new Address(addresses[i])
    let addr = address.getAddress()
    let data = Block.getAddressBalanceSep(address.getAddressRaw())
    let dataUnconfirmed = Tx.getAddressBalanceUnconfirmed(address.getAddressRaw())
    walletData.balances[addr] = data.balanceHard
    walletData.balancesSoft[addr] = data.balanceSoft
    walletData.balancesUnconfirmed[addr] = dataUnconfirmed.balance
    walletData.txs[addr] = data.txsHard
    walletData.txsSoft[addr] = data.txsSoft
    walletData.keys[addr] = address.getKeys()
    walletData.allAmount += data.balanceHard
    walletData.allAmountSoft += data.balanceSoft
    walletData.allAmountUnconfirmed += dataUnconfirmed.balance
  }
  
  return addresses.length
}

var sendData = (socket) => {
  socket.json.send({
    balances: walletData.balances,
    balanceSoft: walletData.balanceSoft,
    balancesUnconfirmed: walletData.balancesUnconfirmed,
    txs: walletData.txs,
    txsSoft: walletData.txsSoft,
    allAmount: (walletData.allAmount / 100000000).toFixed(8),
    allAmountSoft: (walletData.allAmountSoft / 100000000).toFixed(8),
    allAmountUnconfirmed: (walletData.allAmountUnconfirmed / 100000000).toFixed(8)
  })
}

var sendCoins = (walletData, data, callback) => {
  data.amount = data.amount || 0
  data.amountm = data.amountm || 0
  data.fee = data.fee || 0
  
  if (!Address.isValid(data.address)) {
    callback({type: 'error', message: 'Enter correct address'})
    return
  }
  
  let toSend = parseInt(data.amount) * 100000000 + parseInt(data.amountm)
  if (toSend <= 0) {
    callback({type: 'error', message: 'Enter correct sum'})
    return
  }
  let toReceive = toSend
  
  let txFee = parseInt(data.fee)
  txFee *= 100000000
  if (txFee < config.minerMinimalFee) {
    callback({type: 'error', message: 'Enter correct fee'})
    return
  }
  toSend += txFee
  
  if (walletData.allAmount < toSend) {
    callback({type: 'error', message: 'Not enough micoins'})
    return
  }
  
  let sortedAddrs = R.sort((a, b) => {
    return walletData.balances[b] - walletData.balances[a]
  }, R.keys(walletData.balances))
  
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
      publicKey: walletData.keys[addr].publ
    })
    txKeyId++
    
    let sortedTxs = R.sort((a, b) => {
      return a.value - b.value
    }, R.filter(tx => !tx.spent && !tx.spentFreeTxs, walletData.txs[addr]))
    
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
      helper.signData(Buffer.concat([Tx.packHashOutN(item), txOutsRaw]), walletData.keys[item.addr].priv, (sign) => {
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
          callback({type: 'success', message: 'Coins has been sent'})
          
          synchronizer.broadcastTx(txHash, txPacked)
        }
      }, 0, tx)
    }
  })
}

var app = express()
app.use(bodyParser.urlencoded({extended: false}))
var server = app.listen(config.walletPort, config.walletHost)
var io = require('socket.io').listen(server)
io.sockets.on('connection', function(socket) {
  socket.on('message', function (data) {
    setInterval(() => {
      updateData(wallet, walletData)
      sendData(socket)
    }, 10000)
    if (!opened) {
      socket.json.send({reload: true})
    } else if (data.get === 'balances') {
      sendData(socket)
    } else if (data.post === 'address') {
      wallet.attachAddress(Address.create())
      updateData(wallet, walletData)
      sendData(socket)
    } else if (data.post === 'coins') {
      sendCoins(walletData, data, (result) => {
        socket.json.send({noty: result})
        updateData(wallet, walletData)
        sendData(socket)
      })
    }
  })
})
app.get('/', function(req, res) {
  if (synchronizer.isReady()) {
    res.send(fs.readFileSync(base + 'index.html', 'utf8').replace('%LOGIN%', login))
  } else {
    res.send('Wait until blockchain synchronization is complete')
  }
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
  if (updateData(wallet, walletData)) {
    opened = true
    res.send(fs.readFileSync(base + 'wallet.html', 'utf8'))
  } else {
    res.redirect('/')
  }
})
app.post('/api', function(req, res) {
  let request = req.body
  if (request.action && (request.action === 'exists') && request.login) {
    res.send(helper.objToJson({status: 'success', exists: Wallet(request.login).exists()}))
  } else if (request.action && (request.action === 'open') && def(request.password)) {
    let wallet = Wallet(request.login || 'wallet')
    let created = wallet.create(request.password)
    let logged = false
    if (created) {
      wallet.attachAddress(Address.create())
      logged = true
    } else {
      logged = wallet.open(req.body.password)
    }
    let wid = null
    do {
      wid = helper.bufToHex(helper.randomId(32))
    } while (walletsData[wid])
    if (logged) {
      wallets[wid] = wallet
      walletsData[wid] = {
        balances: {},
        balancesUnconfirmed: {},
        txs: {},
        keys: {},
        allAmount: 0,
        allAmountUnconfirmed: 0
      }
      res.send(helper.objToJson({status: 'success', wid: wid}))
    } else {
      res.send(helper.objToJson({status: 'error'}))
    }
  } else if (request.action && (request.action === 'close') && request.wid) {
    delete walletsData[request.wid]
    delete wallets[request.wid]
    res.send(helper.objToJson({status: 'success'}))
  } else if (request.action && (request.action === 'info') && request.wid) {
    if (wallets[request.wid] && walletsData[request.wid]) {
      let data = walletsData[request.wid]
      updateData(wallets[request.wid], data)
      res.send(helper.objToJson({
        balances: data.balances,
        balancesUnconfirmed: data.balancesUnconfirmed,
        txs: data.txs,
        allAmount: data.allAmount,
        allAmountUnconfirmed: data.allAmountUnconfirmed
      }))
    } else {
      res.send(helper.objToJson({status: 'error'}))
    }
  } else if (request.action && (request.action === 'send') && def(request.address) && def(request.amount) && def(request.amountm) && def(request.fee) && def(request.wid)) {
    if (wallets[request.wid] && walletsData[request.wid]) {
      updateData(wallets[request.wid], walletsData[request.wid])
      sendCoins(walletsData[request.wid], request, (result) => {
        res.send(helper.objToJson(result))
      })
    } else {
      res.send(helper.objToJson({status: 'error'}))
    }
  } else {
    res.send(helper.objToJson({status: 'error'}))
  }
})