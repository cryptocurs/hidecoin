'use strict'

const crypto = require('crypto')
const eccrypto = require('eccrypto')
const bs58 = require('bs58')

const helper = require('./helper')

class Address {

  constructor(privBased = null) {
    this.privateKey = privBased ? helper.baseToBuf(privBased) : null
    this.publicKey = null
    this.addressRaw = null
    this.address = null
    this.MIN_PRIVATE_KEY = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
    this.MAX_PRIVATE_KEY = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140', 'hex')
    
    this.prepareKeys = () => {
      if (this.address) {
        return false
      }
      this.publicKey = eccrypto.getPublic(this.privateKey)
      this.addressRaw = helper.publicToAddress(this.publicKey)
      this.address = bs58.encode(this.addressRaw)
      
      return true
    }
    
    this.validatePrivateKey = (privateKey) => {
      let isValid = true

      if (privateKey.compare(this.MIN_PRIVATE_KEY) < 0) {
        isValid = false
      }
      if (privateKey.compare(this.MAX_PRIVATE_KEY) > 0) {
        isValid = false
      }

      return isValid
    }
  }
  
  create() {
    do {
      this.privateKey = crypto.randomBytes(32)
    } while (!this.validatePrivateKey(this.privateKey))
  }
  
  getKeys() {
    this.prepareKeys()
    return {
      priv: this.privateKey,
      publ: this.publicKey
    }
  }
  
  getAddressRaw() {
    this.prepareKeys()
    return this.addressRaw
  }
  
  getAddress() {
    this.prepareKeys()
    return this.address
  }
}
module.exports = Address
module.exports.create = () => {
  let address = new Address()
  address.create()
  return address
}
module.exports.hashToRaw = (address) => {
  return Buffer.from(bs58.decode(address))
}
module.exports.rawToHash = (address) => {
  return bs58.encode(address)
}
module.exports.isValid = (address) => {
  try {
    const decoded = address instanceof Buffer ? address : Buffer.from(bs58.decode(address))
    const basic = decoded.slice(0, 21)
    const checksum = decoded.slice(21)
    const basicChecksum = crypto.createHash('sha256').update(basic).digest().slice(0, 4)
    return (checksum.equals(basicChecksum))
  } catch(e) {
    return false
  }
}