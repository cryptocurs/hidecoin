'use strict'

const cluster = require('cluster')
const R = require('ramda')
const _ = require('lodash')

const Component = require('./Component')
const helper = require('./helper')
const storage = require('./Storage')

const MAX_SAME_TASK_LOW_PRIORITY = 8
const MAX_IDLE_THREADS = 8

class Disp extends Component {

  constructor() {
    super()
    this.module = 'THR'
    
    this.threads = {}
    this.locks = {}
    this.tasksRunned = {}
    
    this.extractCluster = (name) => {
      const match = name.match(/(^\w*)/)
      return match && match[1]
    }
    
    this.extractKind = (name) => {
      const match = name.match(/(^\w*\.\w*)/)
      return match && match[1]
    }
    
    this._createThread = (task, callback, ignoreLock = false) => {
      if (cluster.isWorker) {
        storage.trigger('fatalError', 'Workers are not allowed to create threads')
      }
      
      const run = () => {
        this.tasksRunned[clusterName] = this.tasksRunned[clusterName] ? this.tasksRunned[clusterName] + 1 : 1
        this.tasksRunned[kindName] = this.tasksRunned[kindName] ? this.tasksRunned[kindName] + 1 : 1
        this.log(this.tasksRunned)
        
        let worker
        let newWorker = false
        for (const i in this.threads) {
          if (!this.threads[i].active) {
            this.threads[i].alias = alias
            this.threads[i].clusterName = clusterName
            this.threads[i].kindName = kindName
            this.threads[i].active = true
            this.threads[i].callback = callback
            worker = this.threads[i].worker
            break
          }
        }
        
        if (!worker) {
          newWorker = true
          worker = cluster.fork()
          worker.on('exit', () => {
            this.log(kindName, 'exit')
            delete this.threads[worker.id]
          })
          this.threads[worker.id] = {
            alias,
            clusterName,
            kindName,
            worker,
            active: true,
            callback
          }
          worker.on('message', (data) => {
            const thread = this.threads[worker.id]
            if (data.result) {
              const {result} = data
              if (_.size(this.threads) <= MAX_IDLE_THREADS) {
                thread.active = false
              } else {
                worker.removeAllListeners('message')
                worker.send({cmd: 'exit'})
              }
              this.tasksRunned[thread.clusterName]--
              this.tasksRunned[thread.kindName]--
              this.log('Performed task by #' + worker.id, thread.kindName, 'done')
              this.log(this.tasksRunned)
              helper.restoreObject(result)
              thread.callback && thread.callback(null, result)
            } else if (data.state) {
              this.log('Updated state of #' + worker.id, data.state)
            } else if (data.cmd) {
              helper.restoreObject(data.cmdData)
              thread.callback && thread.callback(null, null, data)
            }
          })
        }
        
        if (!task.params) {
          task.params = {}
        }
        if (newWorker) {
          task.storage = _.fromPairs(_.map(_.filter(_.keys(storage), key => key !== 'localSession' && key !== 'callbacks' && key !== 'defaultCallbacks'), (key) => {
            return [key, storage[key]]
          }))
        }
        worker.send({cmd: 'performTask', cmdData: task})
      }
      
      const waitAndRun = () => {
        if (!ignoreLock && (this.locks[clusterName] || this.locks[kindName]) || this.tasksRunned[kindName] >= MAX_SAME_TASK_LOW_PRIORITY) {
          if (task.priority > 1) {
            callback && callback('busy.cluster', null)
          } else {
            setTimeout(waitAndRun, 100)
          }
        } else {
          run()
        }
      }
      
      const alias = task.alias
      const clusterName = this.extractCluster(task.kind)
      const kindName = this.extractKind(task.kind)
      waitAndRun()
    }
    
    cluster.isMaster && setInterval(() => {
      const threads = R.values(this.threads)
      this.log('Threads active', R.filter(i => i && i.active, threads).length, 'idle', R.filter(i => i && !i.active, threads).length, 'all', threads.length, 'locks', R.keys(this.locks).length)
    }, 1000)
  }
  
  createThread(task, callback) {
    this._createThread(task, callback)
  }
  
  createThreadExclusiveCluster(task, callback) {
    const clusterName = this.extractCluster(task.kind)
    this.lock(clusterName, () => {
      this._createThread(task, (...params) => {
        this.unlock(clusterName)
        callback && callback(...params)
      }, true)
    })
  }
  
  createThreadExclusiveKind(task, callback) {
    const kindName = this.extractKind(task.kind)
    this.lock(kindName, () => {
      this._createThread(task, (...params) => {
        this.unlock(kindName)
        callback && callback(...params)
      }, true)
    })
  }
  
  sendCmdToWorkers(cmd, cmdData, alias) {
    for (const i in this.threads) {
      if (!alias || this.threads[i].alias && (this.threads[i].alias.indexOf(alias) + 1)) {
        this.log('Sending', cmd, 'to #' + this.threads[i].worker.id)
        this.threads[i].worker.send({cmd, cmdData})
      }
    }
  }
  
  lock(name, callback) {
    this.log('locking', name)
    if (this.tasksRunned[name] || this.locks[name]) {
      setTimeout(() => {
        this.lock(name, callback)
      }, 100)
      return
    }
    this.log('locked', name)
    this.locks[name] = true
    callback && callback()
  }
  
  unlock(name) {
    this.log('unlocked', name)
    delete this.locks[name]
  }
  
  isMaster() {
    return cluster.isMaster
  }
  
  isLocked(name) {
    const clusterName = this.extractCluster(name)
    const kindName = this.extractKind(name)
    this.log(this.locks)
    return !!(clusterName && this.locks[clusterName] || kindName && this.locks[kindName])
  }
  
  getTasksRunned() {
    return this.tasksRunned
  }
  
  getLocks() {
    return this.locks
  }
}

const disp = new Disp
module.exports = disp