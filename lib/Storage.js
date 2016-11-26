'use strict'

const fs = require('fs')

const path = __dirname + '/../data/storage.json'
const pathInit = __dirname + '/../data/init-storage.json'

class Storage {

  constructor() {
    if (!fs.existsSync(path)) {
      if (!fs.existsSync(pathInit)) {
        console.log('Fatal error: no storage')
        process.exit()
      }
			var data = JSON.parse(fs.readFileSync(pathInit))
    } else {
      var data = JSON.parse(fs.readFileSync(path))
    }
    for (var i in data) {
      this[i] = data[i]
    }
    this.session = {}
    this.callbacks = {}
    this.defaultCallbacks = {}
  }
  
  flush() {
    var toWrite = {}
    for (let i in this) {
      if ((i != 'session') && (i != 'callbacks') && (i != 'defaultCallbacks')) {
        toWrite[i] = this[i]
      }
    }
    fs.writeFileSync(path, JSON.stringify(toWrite))
  }
  
  reset() {
    var data = JSON.parse(fs.readFileSync(pathInit))
    for (var i in data) {
      this[i] = data[i]
    }
  }
  
  defaultOn(event, callback) {
    this.defaultCallbacks[event] = callback
  }
  
  defaultOff(event, callback) {
    this.defaultCallbacks[event] = null
  }
  
  on(event, callback) {
    if (!this.callbacks[event])
      this.callbacks[event] = []
    this.callbacks[event].push(callback)
    return [event, this.callbacks[event].length - 1]
  }
  
  off(listener) {
    this.callbacks[listener[0]][listener[1]] = null
  }
  
  trigger(event, ...data) {
    var responses = 0
    if (this.callbacks[event]) {
      for (let i in this.callbacks[event]) {
        this.callbacks[event][i] && ++responses && this.callbacks[event][i](...data)
      }
    }
    !responses && this.defaultCallbacks[event] && this.defaultCallbacks[event](...data)
    return responses
  }
}

const storage = new Storage()
module.exports = storage