'use strict'

const blessed = require('blessed')
const R = require('ramda')
const _ = require('lodash')
const moment = require('moment')

const storage = require('./Storage')
const Block = require('./Block')
const Tx = require('./Tx')

class Interface {

  constructor() {
    storage.session.stat = {
      hpsList: {},
      hps: 0,
      rps: 0,
      daq: 0,
      blk: 0,
      snc: 5,
      sncColor: 'white',
      net: 'OFFLINE',
      netRole: ''
    }
    
    this.minerStates = ['/', '-', '\\', '|']
    this.minerState = 0
    this.aliases = {}
    this.minerReqTask = false
  }
  
  open() {
    this.screen = blessed.screen({
      smartCSR: true
    })
    this.screen.title = 'XHD Core'
    this.boxes = {
      header: blessed.box({
        parent: this.screen,
        top: 0,
        left: 0,
        right: 0,
        bottom: this.screen.height - 1,
        content: '',
        tags: true,
        style: {
          fg: 'white',
          bg: 'cyan',
        }
      }),
      console: blessed.box({
        parent: this.screen,
        top: 1,
        left: 0,
        right: 0,
        bottom: 1,
        tags: true,
        style: {
          fg: 'white',
          bg: 'black',
        }
      }),
      consoleFixed: blessed.box({
        parent: this.screen,
        top: this.screen.height - 1,
        left: 0,
        right: 0,
        bottom: 1,
        tags: true,
        style: {
          fg: 'white',
          bg: 'cyan',
          bold: true
        }
      }),
      blocks: blessed.box({
        parent: this.screen,
        top: 1,
        left: 0,
        right: 0,
        bottom: 1,
        content: '{center}{bold}Block Explorer{/bold}{/center}',
        tags: true,
        style: {
          fg: 'white',
          bg: 'black'
        }
      }),
      miner: blessed.box({
        parent: this.screen,
        top: 1,
        left: 0,
        right: 0,
        bottom: 1,
        tags: true,
        style: {
          fg: 'white',
          bg: 'black'
        }
      }),
      wallet: blessed.box({
        parent: this.screen,
        top: 1,
        left: 0,
        right: 0,
        bottom: 1,
        tags: true,
        style: {
          fg: 'white',
          bg: 'black'
        }
      }),
      dev: blessed.box({
        parent: this.screen,
        top: 1,
        left: 0,
        right: 0,
        bottom: 1,
        tags: true,
        style: {
          fg: 'white',
          bg: 'black'
        }
      }),
      footer: blessed.box({
        parent: this.screen,
        top: this.screen.height - 1,
        left: 0,
        right: 0,
        bottom: 0,
        content: 'F1 Cnsl F2 Blks F3 Minr F4 Wlt  F5 Snc- F6 Snc+ F7 Prms                 F10 Quit',
        tags: true,
        style: {
          fg: 'white',
          bg: 'blue',
        }
      })
    }
    this.blockBoxes = {
      lastBlock: blessed.box({
        parent: this.boxes.blocks,
        top: 1,
        left: 0,
        right: 0,
        bottom: 0,
        content: 'Last block info',
        tags: true,
        style: {
          fg: 'white',
          bg: 'black',
          scrollbar: {
            fg: 'blue',
            bg: 'blue'
          }
        },
        scrollbar: true,
        scrollable: true,
        keys: true
      })
    }
    this.devBoxes = {
      console: blessed.box({
        parent: this.boxes.dev,
        top: 0,
        left: 0,
        right: 0,
        bottom: 1,
        content: '{red-fg}{bold}Press ESCAPE if you are not Hidecoin Developer{/bold}{/red-fg}',
        tags: true,
        style: {
          fg: 'white',
          bg: 'black'
        }
      }),
      cmd: blessed.textbox({
        parent: this.boxes.dev,
        top: this.boxes.dev.height - 1,
        left: 0,
        right: 0,
        bottom: 0,
        content: '#',
        tags: true,
        inputOnFocus: true,
        style: {
          fg: 'white',
          bg: 'blue'
        },
        keys: true
      })
    }
    
    setInterval(() => {
      if (this.minerReqTask) {
        this.minerReqTask = false
        this.minerState = (this.minerState + 1) % 4
      }
      this.boxes.header.setLine(0, '{bold}HPS ' + _.padStart(storage.session.stat.hps, 4)
        + ' RPS ' + _.padStart(storage.session.stat.rps >> 1, 4)
        + ' DAQ ' + _.padStart(storage.session.stat.daq, 4)
        + ' BLK ' + _.padStart(storage.session.stat.blk, 8)
        + ' {' + storage.session.stat.sncColor + '-fg}SNC '
        + storage.session.syncSpeed + '{/' + storage.session.stat.sncColor + '-fg} '
        + _.padStart(storage.session.stat.net, 7) + ' '
        + _.padStart(storage.session.stat.netRole, 7)
        + ' MNR ' + this.minerStates[this.minerState] + _.padStart(storage.session.version, 12) + '{/bold}')
      storage.session.stat.rps = 0
      this.screen.render()
    }, 2000)
    
    this.boxes.consoleFixed.setFront()
    this.boxes.console.setFront()
    this.screen.render()
    
    this.screen.on('resize', () => {
      this.boxes.header.bottom = this.screen.height - 1
      this.boxes.footer.top = this.screen.height - 1
      this.boxes.footer.bottom = 0
      this.screen.render()
    })
    
    this.screen.key('f1', () => {
      this.boxes.consoleFixed.setFront()
      this.boxes.consoleFixed.focus()
      this.boxes.console.setFront()
      this.boxes.console.focus()
      this.screen.render()
    })
    
    this.screen.key('f2', () => {
      const block = Block.getLast()
      this.blockBoxes.lastBlock.setContent('Last block info')
      this.blockBoxes.lastBlock.pushLine('ID   {bold}' + block.id + '{/bold}')
      this.blockBoxes.lastBlock.pushLine('Hash {bold}' + block.hash.toString('hex') + '{/bold}')
      
      const blockUnpacked = Block.unpack(block.data)
      this.blockBoxes.lastBlock.pushLine('Time {bold}' + moment(blockUnpacked.time * 1000 - moment().utcOffset() * 60000).format('YYYY-MM-DD HH:mm:ss') + '{/bold}')
      this.blockBoxes.lastBlock.pushLine('Diff {bold}' + blockUnpacked.diff.toString('hex') + '{/bold}')
      this.blockBoxes.lastBlock.pushLine('Txs  {bold}' + blockUnpacked.txCount + '{/bold}')
      this.blockBoxes.lastBlock.pushLine('')
      
      let txList = R.map(tx => Tx.unpack(tx), blockUnpacked.txList)
      for (let i in txList) {
        const txHash = blockUnpacked.txHashList[i]
        const tx = blockUnpacked.txList[i]
        
        this.blockBoxes.lastBlock.pushLine(txHash.toString('hex'))
      }
      
      this.boxes.blocks.setFront()
      this.boxes.blocks.focus()
      this.screen.render()
    })
    
    this.screen.key('f3', () => {
      this.boxes.miner.setFront()
      this.boxes.miner.focus()
      this.screen.render()
    })
    
    this.screen.key('f4', () => {
      this.boxes.wallet.setFront()
      this.boxes.wallet.focus()
      this.screen.render()
    })
    
    this.screen.key('C-p', () => {
      storage.logIgnoreModules = storage.logIgnoreModules.length ? [] : ['P2P']
      this.logConsole('Log ignore modules: [' + R.join(', ', storage.logIgnoreModules) + ']')
    })
    
    this.screen.key('C-s', () => {
      storage.trigger('syncState')
    })
    
    this.screen.key('`', () => {
      this.boxes.dev.setFront()
      this.devBoxes.cmd.setFront()
      this.devBoxes.cmd.focus()
      this.screen.render()
    })
    
    this.devBoxes.cmd.on('submit', (data) => {
      this.logDev('#' + data)
      let res
      try {
        res = eval(data)
      } catch (e) {
        this.logDev('{red-fg}Error: ' + e + '{/red-fg}')
        this.devBoxes.cmd.focus()
        return
      }
      if (res) {
        this.logDev('>' + res)
      } else {
        this.logDev('No result')
      }
      this.devBoxes.cmd.focus()
    })
    
    this.devBoxes.cmd.on('cancel', (data) => {
      this.boxes.console.setFront()
      this.boxes.console.focus()
      this.screen.render()
    })
    
    storage.on('log', (...data) => {
      if (data[0] === 'FND') {
        this.logMiner(R.join(' ', R.map((line) => {
          return typeof line === 'object' ? JSON.stringify(line) : line
        }, data)))
      } else if (data[0] === 'WLT') {
        this.logWallet(R.join(' ', R.map((line) => {
          return typeof line === 'object' ? JSON.stringify(line) : line
        }, data)))
      } else {
        this.logConsole(R.join(' ', R.map((line) => {
          return typeof line === 'object' ? JSON.stringify(line) : line
        }, data)))
      }
    })
    
    storage.on('logAlias', (alias, data) => {
      this.logConsoleAlias(alias, data)
    })
    
    storage.on('logAliasClear', (alias) => {
      this.logConsoleAliasClear(alias)
    })
    
    storage.on('minerReqTask', () => {
      this.minerReqTask = true
    })
  }
  
  key(...args) {
    this.screen.key(...args)
  }
  
  close() {
    this.screen.destroy()
  }
  
  logConsole(...data) {
    R.forEach((line) => {
      this.boxes.console.pushLine(line)
    }, data)
    const extraLines = this.boxes.console.getScreenLines().length - this.screen.height + 2
    if (extraLines > 0) {
      for (let i = 0; i < extraLines; i++) {
        this.boxes.console.shiftLine(0)
      }
    }
    this.screen.render()
  }
  
  logConsoleAlias(alias, data) {
    if (this.aliases[alias]) {
      this.aliases[alias].content = data
      this.boxes.consoleFixed.setLine(this.aliases[alias].line, data)
    } else {
      this.boxes.console.bottom++
      this.boxes.consoleFixed.top--
      const line = _.size(this.aliases)
      this.aliases[alias] = {
        line: line,
        content: data
      }
      this.boxes.consoleFixed.setLine(line, data)
    }
    this.screen.render()
  }
  
  logConsoleAliasClear(alias) {
    if (this.aliases[alias]) {
      this.boxes.console.bottom--
      this.boxes.consoleFixed.top++
      const deletedLine = this.aliases[alias].line
      delete this.aliases[alias]
      for (let i in this.aliases) {
        if (this.aliases[i].line > deletedLine) {
          this.aliases[i].line--
          this.boxes.consoleFixed.setLine(this.aliases[i].line, this.aliases[i].content)
        }
      }
      this.screen.render()
    }
  }
  
  logMiner(...data) {
    R.forEach((line) => {
      this.boxes.miner.pushLine(line)
    }, data)
    const extraLines = this.boxes.miner.getScreenLines().length - this.screen.height + 2
    if (extraLines > 0) {
      for (let i = 0; i < extraLines; i++) {
        this.boxes.miner.shiftLine(0)
      }
    }
    this.screen.render()
  }
  
  logWallet(...data) {
    R.forEach((line) => {
      this.boxes.wallet.pushLine(line)
    }, data)
    const extraLines = this.boxes.wallet.getScreenLines().length - this.screen.height + 2
    if (extraLines > 0) {
      for (let i = 0; i < extraLines; i++) {
        this.boxes.wallet.shiftLine(0)
      }
    }
    this.screen.render()
  }
  
  logDev(...data) {
    R.forEach((line) => {
      this.devBoxes.console.pushLine(line)
    }, data)
    const extraLines = this.devBoxes.console.getScreenLines().length - this.screen.height + 2
    if (extraLines > 0) {
      for (let i = 0; i < extraLines; i++) {
        this.devBoxes.console.shiftLine(0)
      }
    }
    this.screen.render()
  }
}

const ifc = new Interface()
module.exports = ifc