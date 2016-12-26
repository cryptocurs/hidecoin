'use strict'

const moment = require('moment')
const R = require('ramda')

var storage = require('./Storage')

module.exports = class Component {

  constructor() {
    this.callbacks = {}
    this.module = null
    
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
    this.logBy(this.module, ...data)
  }
  
  logBy(module, ...data) {
    if (!storage.logIgnoreModules || !R.contains(module, storage.logIgnoreModules)) {
      const msgInfo = '[' + moment().format('HH:mm:ss') + ' ' + module + ']#'
      storage.trigger('log', msgInfo, ...data) || console.log(msgInfo, ...data)
    }
  }
  
  logAlias(alias, data) {
    this.logAliasBy(this.module, alias, data)
  }
  
  logAliasBy(module, alias, data) {
    if (!storage.logIgnoreModules || !R.contains(module, storage.logIgnoreModules)) {
      const msgInfo = '[' + moment().format('HH:mm:ss') + ' ' + module + ']#'
      storage.trigger('logAlias', alias, msgInfo + ' ' + data) || console.log(msgInfo, data)
    }
  }
  
  logAliasClear(alias) {
    storage.trigger('logAliasClear', alias)
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