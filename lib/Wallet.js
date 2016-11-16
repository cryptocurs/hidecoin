'use strict'

const fs = require('fs')

const helper = require('./helper')

const base = __dirname + '/../'

class Wallet {

  constructor(login = 'wallet') {
    this.data = []
    this.password = null
    this.inWallet = false
    this.path = base + 'data/' + login + '.dat'
  }
  
  create(password) {
    if (this.inWallet) {
      return false
    }
    
    if (fs.existsSync(this.path)) {
      return false
    }
    
    this.password = password
    this.inWallet = true
    this.flush()
    
    return true
  }
  
  open(password) {
    let decrypted = helper.decryptText(fs.readFileSync(this.path).toString(), password)
    if (!decrypted) {
      return false
    }
    this.data = helper.jsonToObj(helper.baseToStr(decrypted))
    this.password = password
    this.inWallet = true
    return true
  }
  
  flush() {
    fs.writeFileSync(this.path, helper.encryptText(helper.strToBase(helper.objToJson(this.data)), this.password))
  }
  
  attachAddress(address) {
    var privBased = helper.bufToBase(address.getKeys().priv)
    this.data.push(privBased)
    this.flush()
  }
  
  getContent() {
    return this.data
  }
}

module.exports = function(login) {
  return new Wallet(login)
}