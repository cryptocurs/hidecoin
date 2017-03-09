'use strict'

const fs = require('fs')

const helper = require('./helper')

class WCache {

  constructor(login = 'wallet') {
    this.path = __dirname + '/../data/wcache-' + login + '.json'
    this.data = fs.existsSync(this.path) ? require(this.path) : {}
    helper.unbaseObject(this.data)
  }
  
  get(key) {
    return this.data[key]
  }
  
  set(key, value) {
    this.data[key] = value
    this.flush()
  }
  
  flush() {
    const toWrite = helper.cloneObject(this.data)
    helper.baseObject(toWrite)
    fs.writeFileSync(this.path, JSON.stringify(toWrite))
  }
}

module.exports = function(login) {
  return new WCache(login)
}