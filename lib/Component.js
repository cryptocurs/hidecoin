'use strict'

const moment = require('moment')
const R = require('ramda')

var storage = require('./Storage')

module.exports = class Component {

  constructor() {
    this.callbacks = {}
    
    this.trigger = (event, ...data) => {
      if (this.callbacks[event]) {
        for (let i in this.callbacks[event]) {
          this.callbacks[event][i].callback && this.callbacks[event][i].callback(...data)
          if (this.callbacks[event][i].once) {
            delete this.callbacks[event][i]
          }
        }
      }
      return true
    }
  }
  
  log(...data) {
    if (!storage.logIgnoreModules || !R.contains(this.module, storage.logIgnoreModules)) {
      storage.trigger('log', ...data) || console.log('[' + moment().format('HH:mm:ss') + ' ' + (this.module || 'LOG') + ']#', ...data)
    }
  }
  
  logBy(module, ...data) {
    if (!storage.logIgnoreModules || !R.contains(module, storage.logIgnoreModules)) {
      storage.trigger('log', ...data) || console.log('[' + moment().format('HH:mm:ss') + ' ' + module + ']#', ...data)
    }
  }
  
  on(event, callback) {
    if (!this.callbacks[event])
      this.callbacks[event] = []
    this.callbacks[event].push({callback: callback, once: false})
    return [event, this.callbacks[event].length - 1]
  }
  
  once(event, callback) {
    if (!this.callbacks[event])
      this.callbacks[event] = []
    this.callbacks[event].push({callback: callback, once: true})
    return [event, this.callbacks[event].length - 1]
  }
  
  off(listener) {
    delete this.callbacks[listener[0]][listener[1]]
    return true
  }
}