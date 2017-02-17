'use strict'

console.log('XHD Core 0.3.1 loading...')
const config = require('./config')
const storage = require('./lib/Storage')
storage.config = config
console.log(config)

const fs = require('fs')
const R = require('ramda')

const helper = require('./lib/helper')
const hours = require('./lib/Hours')
const Address = require('./lib/Address')
const blockchain = require('./lib/Blockchain')
const Block = require('./lib/Block')
const net = require('./lib/Net')
const miner = require('./lib/Miner')
const synchronizer = require('./lib/Synchronizer')
const ifc = require('./lib/Interface')

if (!storage.config.rpcHost) {
  storage.config.rpcHost = '127.0.0.1'
}
if (!storage.config.rpcPort) {
  storage.config.rpcPort = 5839
}
const rpcServer = require('./lib/RpcServer')

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
  console.log('Fatal error: ' + msg)
  process.exit(0)
})

net.once('error', (msg) => {
  ifc.close()
  console.log(msg)
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

ifc.key('f5', () => {
  if (storage.session.syncSpeed > 1) {
    storage.session.syncSpeed--
  }
  storage.session.stat.snc = storage.session.syncSpeed
})

ifc.key('f6', () => {
  if (storage.session.syncSpeed < 9) {
    storage.session.syncSpeed++
  }
  storage.session.stat.snc = storage.session.syncSpeed
})

ifc.key('f7', () => {
  if (synchronizer.isPromiscuous()) {
    synchronizer.setPromiscuous(false)
    log('CORE: {red-fg}promiscuous mode OFF{/red-fg}')
  } else {
    synchronizer.setPromiscuous(true)
    log('CORE: {green-fg}promiscuous mode ON{/green-fg}')
  }
})

ifc.key('f8', () => {
  log(storage.servers)
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
storage.session.wallet = Wallet(login)
const {wallet} = storage.session
var opened = false

const def = (value) => {
  return value !== undefined
}

const updateData = () => {
  log('WLT', '<UpdateData> Balances ready in ' + helper.stopwatch(() => {
    wallet.updateData()
  }) + 'ms')
  return wallet.getContent().length
}

const sendData = (socket) => {
  const walletData = wallet.getData()
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

const sendCoins = (data, callback) => {
  wallet.sendCoins(data, callback)
}

const app = express()
app.use(bodyParser.urlencoded({extended: false}))
const server = app.listen(config.walletPort, config.walletHost)
const io = require('socket.io').listen(server)
var walletTimer = null
io.sockets.on('connection', (socket) => {
  if (walletTimer) {
    clearInterval(walletTimer)
  }
  walletTimer = setInterval(() => {
    updateData()
    sendData(socket)
  }, 20000)
  socket.on('message', (data) => {
    if (!opened) {
      socket.json.send({reload: true})
    } else if (data.get === 'balances') {
      sendData(socket)
    } else if (data.post === 'address') {
      wallet.attachAddress(Address.create())
      updateData()
      sendData(socket)
    } else if (data.post === 'coins') {
      sendCoins(data, (result) => {
        socket.json.send({noty: result})
        updateData()
        sendData(socket)
      })
    }
  })
})
app.get('/', (req, res) => {
  if (synchronizer.isReady()) {
    res.send(fs.readFileSync(base + 'index.html', 'utf8').replace('%LOGIN%', login))
  } else {
    res.send(fs.readFileSync(base + 'sync.html', 'utf8'))
  }
})
app.get('/assets/*', (req, res) => {
  let url = req.params[0]
  if (R.contains(url, ['bootstrap.min.css'])) {
    res.set('Content-type', 'text/css')
    res.send(fs.readFileSync(base + url, 'utf8'))
  } else if (R.contains(url, ['jquery.min.js', 'bootstrap.min.js', 'jquery.noty.packaged.min.js'])) {
    res.set('Content-type', 'application/javascript')
    res.send(fs.readFileSync(base + url, 'utf8'))
  }
})
app.post('/', (req, res) => {
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