'use strict';

// no need for WebSQL when running in a worker
module.exports = require('pouchdb-core')
  .plugin(require('pouchdb-find'))
  .plugin(require('pouchdb-load'))
  .plugin(require('pouchdb-adapter-idb'))
  .plugin(require('pouchdb-adapter-http'))
  .plugin(require('pouchdb-mapreduce'))
  .plugin(require('pouchdb-replication'));
