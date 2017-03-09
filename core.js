'use strict'

const cluster = require('cluster')
require('./lib/' + (cluster.isMaster ? 'master' : 'worker'))