'use strict'

const Component = require('./Component')
const helper = require('./helper')
const ntpClient = require('ntp-client')

class Hours extends Component {

  constructor() {
    super()
    this.module = 'HRS'
    this.timeOffset = 0
    this.wasReady = false
  }
  
  set(timestamp) {
    this.timeOffset = timestamp - helper.unixTime()
    if (!this.wasReady) {
      this.trigger('ready')
      this.wasReady = true
    }
  }
  
  sync() {
    ntpClient.getNetworkTime('pool.ntp.org', 123, (err, date) => {
      if (!err) {
        this.set(parseInt(date.getTime() / 1000))
        this.log('Time difference:', this.timeOffset)
      }
    })
  }
  
  now() {
    return helper.unixTime() + this.timeOffset
  }
}

const hours = new Hours()
module.exports = hours