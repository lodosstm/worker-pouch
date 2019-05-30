(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.workerPouch = f()}})(function(){var define,module,exports;return (function(){function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s}return e})()({1:[function(_dereq_,module,exports){
'use strict';

var utils = _dereq_(8);
var clientUtils = _dereq_(5);
var uuid = _dereq_(9);
var errors = _dereq_(6);
var log = _dereq_(11)('pouchdb:worker:client');
var preprocessAttachments = clientUtils.preprocessAttachments;
var encodeArgs = clientUtils.encodeArgs;
var adapterFun = clientUtils.adapterFun;

// Implements the PouchDB API for dealing with PouchDB instances over WW
function WorkerPouch(opts, callback) {
  var api = this;

  if (typeof opts === 'string') {
    var slashIdx = utils.lastIndexOf(opts, '/');
    opts = {
      url: opts.substring(0, slashIdx),
      name: opts.substring(slashIdx + 1)
    };
  } else {
    opts = utils.clone(opts);
  }

  log('constructor called', opts);

  // Aspirational. once https://github.com/pouchdb/pouchdb/issues/5200
  // is resolved, you'll be able to directly pass in a worker here instead of
  // a function that returns a worker.
  var worker = (opts.worker && typeof opts.worker === 'function') ?
    opts.worker() : opts.worker;
  if (!worker || (!worker.postMessage && (!worker.controller || !worker.controller.postMessage))) {
    var workerOptsErrMessage =
      'Error: you must provide a valid `worker` in `new PouchDB()`';
    console.error(workerOptsErrMessage);
    return callback(new Error(workerOptsErrMessage));
  }

  if (!opts.name) {
    var optsErrMessage = 'Error: you must provide a database name.';
    console.error(optsErrMessage);
    return callback(new Error(optsErrMessage));
  }

  function handleUncaughtError(content) {
    try {
      api.emit('error', content);
    } catch (err) {
      // TODO: it's weird that adapters should have to handle this themselves
      console.error(
        'The user\'s map/reduce function threw an uncaught error.\n' +
        'You can debug this error by doing:\n' +
        'myDatabase.on(\'error\', function (err) { debugger; });\n' +
        'Please double-check your map/reduce function.');
      console.error(content);
    }
  }

  function onReceiveMessage(message) {
    var messageId = message.messageId;
    var messageType = message.type;
    var content = message.content;

    if (messageType === 'uncaughtError') {
      handleUncaughtError(content);
      return;
    }

    var cb = api._callbacks[messageId];

    if (!cb) {
      log('duplicate message (ignoring)', messageId, messageType, content);
      return;
    }

    log('receive message', api._instanceId, messageId, messageType, content);

    if (messageType === 'error') {
      delete api._callbacks[messageId];
      cb(content);
    } else if (messageType === 'success') {
      delete api._callbacks[messageId];
      cb(null, content);
    } else { // 'update'
      api._changesListeners[messageId](content);
    }
  }

  function workerListener(e) {
    if (e.data.id === api._instanceId) {
      onReceiveMessage(e.data);
    }
  }

  function postMessage(message) {
    /* istanbul ignore if */
    if (typeof worker.controller !== 'undefined') {
      // service worker, use MessageChannels because e.source is broken in Chrome < 51:
      // https://bugs.chromium.org/p/chromium/issues/detail?id=543198
      var channel = new MessageChannel();
      channel.port1.onmessage = workerListener;
      worker.controller.postMessage(message, [channel.port2]);
    } else {
      // web worker
      worker.postMessage(message);
    }
  }

  function sendMessage(type, args, callback) {
    if (api._destroyed) {
      return callback(new Error('this db was destroyed'));
    } else if (api._closed) {
      return callback(new Error('this db was closed'));
    }
    var messageId = uuid();
    log('send message', api._instanceId, messageId, type, args);
    api._callbacks[messageId] = callback;
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  function sendRawMessage(messageId, type, args) {
    log('send message', api._instanceId, messageId, type, args);
    var encodedArgs = encodeArgs(args);
    postMessage({
      id: api._instanceId,
      type: type,
      messageId: messageId,
      args: encodedArgs
    });
    log('message sent', api._instanceId, messageId);
  }

  api.type = function () {
    return 'worker';
  };

  api._remote = false;

  api._id = adapterFun('id', function (callback) {
    sendMessage('id', [], callback);
  });

  api.compact = adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('compact', [opts], callback);
  });

  api._info = function (callback) {
    sendMessage('info', [], callback);
  };

  api.get = adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('get', [id, opts], callback);
  });

  // hacky code necessary due to implicit breaking change in
  // https://github.com/pouchdb/pouchdb/commits/0ddeae6b
  api._get = function (id, opts, callback) {
    api.get(id, opts, function (err, doc) {
      if (err) {
        return callback(err);
      }
      callback(null, {doc: doc});
    });
  };

  api.remove =
    adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
      var doc;
      if (typeof optsOrRev === 'string') {
        // id, rev, opts, callback style
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        // doc, opts, callback style
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }
      var rev = (doc._rev || opts.rev);

      sendMessage('remove', [doc._id, rev], callback);
  });

  api.getAttachment =
    adapterFun('getAttachment', function (docId, attachmentId, opts,
                                                callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      sendMessage('getAttachment', [docId, attachmentId, opts], callback);
  });

  api.removeAttachment =
    adapterFun('removeAttachment', function (docId, attachmentId, rev,
                                                   callback) {

      sendMessage('removeAttachment', [docId, attachmentId, rev], callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun('putAttachment', function (docId, attachmentId, rev, blob,
                                                type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      if (typeof type === 'undefined') {
        type = blob;
        blob = rev;
        rev = null;
      }

      if (typeof blob === 'string') {
        var binary;
        try {
          binary = atob(blob);
        } catch (err) {
          // it's not base64-encoded, so throw error
          return callback(errors.error(errors.BAD_ARG,
            'Attachments need to be base64 encoded'));
        }
        blob = utils.createBlob([utils.binaryStringToArrayBuffer(binary)], {type: type});
      }

      var args = [docId, attachmentId, rev, blob, type];
      sendMessage('putAttachment', args, callback);
    });

  api.put = adapterFun('put', utils.getArguments(function (args) {
    var temp, temptype, opts;
    var doc = args.shift();
    var id = '_id' in doc;
    var callback = args.pop();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(errors.error(errors.NOT_AN_OBJECT));
    }

    doc = utils.clone(doc);

    preprocessAttachments(doc).then(function () {
      while (true) {
        temp = args.shift();
        temptype = typeof temp;
        if (temptype === "string" && !id) {
          doc._id = temp;
          id = true;
        } else if (temptype === "string" && id && !('_rev' in doc)) {
          doc._rev = temp;
        } else if (temptype === "object") {
          opts = utils.clone(temp);
        }
        if (!args.length) {
          break;
        }
      }
      opts = opts || {};

      sendMessage('put', [doc, opts], callback);
    })["catch"](callback);

  }));

  api.post = adapterFun('post', function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = utils.clone(opts);

    sendMessage('post', [doc, opts], callback);
  });

  api._bulkDocs = function (req, opts, callback) {
    sendMessage('bulkDocs', [req, opts], callback);
  };

  api.load = adapterFun('load', function (req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('load', [req, opts], callback);
  });

  api.find = adapterFun('find', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('find', [opts], callback);
  });

  api.createIndex = adapterFun('createIndex', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('createIndex', [opts], callback);
  });

  api._allDocs = function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('allDocs', [opts], callback);
  };

  api._changes = function (opts) {
    opts = utils.clone(opts);

    if (opts.continuous) {
      var messageId = uuid();
      api._changesListeners[messageId] = opts.onChange;
      api._callbacks[messageId] = opts.complete;
      sendRawMessage(messageId, 'liveChanges', [opts]);
      return {
        cancel: function () {
          sendRawMessage(messageId, 'cancelChanges', []);
        }
      };
    }

    sendMessage('changes', [opts], function (err, res) {
      if (err) {
        opts.complete(err);
        return callback(err);
      }
      res.results.forEach(function (change) {
        opts.onChange(change);
      });
      if (opts.returnDocs === false || opts.return_docs === false) {
        res.results = [];
      }
      opts.complete(null, res);
    });
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See http://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    sendMessage('revsDiff', [req, opts], callback);
  });

  api._query = adapterFun('query', function (fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    var funEncoded = fun;
    if (typeof fun === 'function') {
      funEncoded = {map: fun};
    }
    sendMessage('query', [funEncoded, opts], callback);
  });

  api._viewCleanup = adapterFun('viewCleanup', function (callback) {
    sendMessage('viewCleanup', [], callback);
  });

  api._close = function (callback) {
    api._closed = true;
    callback();
  };

  api.destroy = adapterFun('destroy', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    sendMessage('destroy', [], function (err, res) {
      if (err) {
        api.emit('error', err);
        return callback(err);
      }
      api._destroyed = true;
      worker.removeEventListener('message', workerListener);
      api.emit('destroyed');
      callback(null, res);
    });
  });

  // api.name was added in pouchdb 6.0.0
  api._instanceId = api.name || opts.originalName;
  api._callbacks = {};
  api._changesListeners = {};

  worker.addEventListener('message', workerListener);

  var workerOpts = {
    name: api._instanceId,
    auto_compaction: !!opts.auto_compaction,
    storage: opts.storage
  };
  if (opts.revs_limit) {
    workerOpts.revs_limit = opts.revs_limit;
  }

  sendMessage('createDatabase', [workerOpts], function (err) {
    if (err) {
      return callback(err);
    }
    callback(null, api);
  });
}

// WorkerPouch is a valid adapter.
WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

module.exports = WorkerPouch;

},{"11":11,"5":5,"6":6,"8":8,"9":9}],2:[function(_dereq_,module,exports){
'use strict';
/* global webkitURL */

module.exports = function createWorker(code) {
  var createBlob = _dereq_(8).createBlob;
  var URLCompat = typeof URL !== 'undefined' ? URL : webkitURL;

  function makeBlobURI(script) {
    var blob = createBlob([script], {type: 'text/javascript'});
    return URLCompat.createObjectURL(blob);
  }

  var blob = createBlob([code], {type: 'text/javascript'});
  return new Worker(makeBlobURI(blob));
};
},{"8":8}],3:[function(_dereq_,module,exports){
(function (global){
'use strict';

// main script used with a blob-style worker

var extend = _dereq_(15).extend;
var WorkerPouchCore = _dereq_(1);
var createWorker = _dereq_(2);
var isSupportedBrowser = _dereq_(4);
var workerCode = _dereq_(10);

function WorkerPouch(opts, callback) {

  var worker = window.__pouchdb_global_worker; // cache so there's only one
  if (!worker) {
    try {
      worker = createWorker(workerCode);
      worker.addEventListener('error', function (e) {
        if ('console' in global && 'warn' in console) {
          console.warn('worker threw an error', e.error);
        }
      });
      window.__pouchdb_global_worker = worker;
    } catch (e) {
      if ('console' in global && 'info' in console) {
        console.info('This browser is not supported by WorkerPouch. ' +
          'Please use isSupportedBrowser() to check.', e);
      }
      return callback(new Error('browser unsupported by worker-pouch'));
    }
  }

  var _opts = extend({
    worker: function () { return worker; }
  }, opts);

  WorkerPouchCore.call(this, _opts, callback);
}

WorkerPouch.valid = function () {
  return true;
};
WorkerPouch.use_prefix = false;

WorkerPouch.isSupportedBrowser = isSupportedBrowser;

module.exports = WorkerPouch;

/* istanbul ignore next */
if (typeof window !== 'undefined' && window.PouchDB) {
  window.PouchDB.adapter('worker', module.exports);
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"1":1,"10":10,"15":15,"2":2,"4":4}],4:[function(_dereq_,module,exports){
(function (global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(18));
var createWorker = _dereq_(2);

module.exports = function isSupportedBrowser() {
  return Promise.resolve().then(function () {
    // synchronously throws in IE/Edge
    var worker = createWorker('' +
      'self.onmessage = function () {' +
      '  self.postMessage({' +
      '    hasIndexedDB: (typeof indexedDB !== "undefined")' +
      '  });' +
      '};');

    return new Promise(function (resolve, reject) {

      function listener(e) {
        worker.terminate();
        if (e.data.hasIndexedDB) {
          resolve();
          return;
        }
        reject();
      }

      function errorListener() {
        worker.terminate();
        reject();
      }

      worker.addEventListener('error', errorListener);
      worker.addEventListener('message', listener);
      worker.postMessage({});
    });
  }).then(function () {
    return true;
  }, function (err) {
    if ('console' in global && 'info' in console) {
      console.info('This browser is not supported by WorkerPouch', err);
    }
    return false;
  });
};
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"18":18,"2":2}],5:[function(_dereq_,module,exports){
(function (process){
'use strict';

var utils = _dereq_(8);
var log = _dereq_(11)('pouchdb:worker:client');
var isBrowser = typeof process === 'undefined' || process.browser;

exports.preprocessAttachments = function preprocessAttachments(doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return utils.Promise.resolve();
  }

  return utils.Promise.all(Object.keys(doc._attachments).map(function (key) {
    var attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      if (isBrowser) {
        return new utils.Promise(function (resolve) {
          utils.readAsBinaryString(attachment.data, function (binary) {
            attachment.data = btoa(binary);
            resolve();
          });
        });
      } else {
        attachment.data = attachment.data.toString('base64');
      }
    }
  }));
};

function encodeObjectArg(arg) {
  // these can't be encoded by normal structured cloning
  var funcKeys = ['filter', 'map', 'reduce'];
  var keysToRemove = ['onChange', 'processChange', 'complete'];
  var clonedArg = {};
  Object.keys(arg).forEach(function (key) {
    if (keysToRemove.indexOf(key) !== -1) {
      return;
    }
    if (funcKeys.indexOf(key) !== -1 && typeof arg[key] === 'function') {
      clonedArg[key] = {
        type: 'func',
        func: arg[key].toString()
      };
    } else {
      clonedArg[key] = arg[key];
    }
  });
  return clonedArg;
}

exports.encodeArgs = function encodeArgs(args) {
  var result = [];
  args.forEach(function (arg) {
    if (arg === null || typeof arg !== 'object' ||
        Array.isArray(arg) || arg instanceof Blob || arg instanceof Date) {
      result.push(arg);
    } else {
      result.push(encodeObjectArg(arg));
    }
  });
  return result;
};

exports.padInt = function padInt(i, len) {
  var res = i.toString();
  while (res.length < len) {
    res = '0' + res;
  }
  return res;
};


exports.adapterFun = function adapterFun(name, callback) {

  function logApiCall(self, name, args) {
    if (!log.enabled) {
      return;
    }
    // db.name was added in pouch 6.0.0
    var dbName = self.name || self._db_name;
    var logArgs = [dbName, name];
    for (var i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    log.apply(null, logArgs);

    // override the callback itself to log the response
    var origCallback = args[args.length - 1];
    args[args.length - 1] = function (err, res) {
      var responseArgs = [dbName, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      log.apply(null, responseArgs);
      origCallback(err, res);
    };
  }


  return utils.toPromise(utils.getArguments(function (args) {
    if (this._closed) {
      return utils.Promise.reject(new Error('database is closed'));
    }
    var self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new utils.Promise(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  }));
};
}).call(this,_dereq_(20))
},{"11":11,"20":20,"8":8}],6:[function(_dereq_,module,exports){
"use strict";

var inherits = _dereq_(14);
inherits(PouchError, Error);

function PouchError(opts) {
  Error.call(opts.reason);
  this.status = opts.status;
  this.name = opts.error;
  this.message = opts.reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message
  });
};

exports.UNAUTHORIZED = new PouchError({
  status: 401,
  error: 'unauthorized',
  reason: "Name or password is incorrect."
});

exports.MISSING_BULK_DOCS = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: "Missing JSON list of 'docs'"
});

exports.MISSING_DOC = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'missing'
});

exports.REV_CONFLICT = new PouchError({
  status: 409,
  error: 'conflict',
  reason: 'Document update conflict'
});

exports.INVALID_ID = new PouchError({
  status: 400,
  error: 'invalid_id',
  reason: '_id field must contain a string'
});

exports.MISSING_ID = new PouchError({
  status: 412,
  error: 'missing_id',
  reason: '_id is required for puts'
});

exports.RESERVED_ID = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Only reserved document ids may start with underscore.'
});

exports.NOT_OPEN = new PouchError({
  status: 412,
  error: 'precondition_failed',
  reason: 'Database not open'
});

exports.UNKNOWN_ERROR = new PouchError({
  status: 500,
  error: 'unknown_error',
  reason: 'Database encountered an unknown error'
});

exports.BAD_ARG = new PouchError({
  status: 500,
  error: 'badarg',
  reason: 'Some query argument is invalid'
});

exports.INVALID_REQUEST = new PouchError({
  status: 400,
  error: 'invalid_request',
  reason: 'Request was invalid'
});

exports.QUERY_PARSE_ERROR = new PouchError({
  status: 400,
  error: 'query_parse_error',
  reason: 'Some query parameter is invalid'
});

exports.DOC_VALIDATION = new PouchError({
  status: 500,
  error: 'doc_validation',
  reason: 'Bad special document member'
});

exports.BAD_REQUEST = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Something wrong with the request'
});

exports.NOT_AN_OBJECT = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Document must be a JSON object'
});

exports.DB_MISSING = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'Database not found'
});

exports.IDB_ERROR = new PouchError({
  status: 500,
  error: 'indexed_db_went_bad',
  reason: 'unknown'
});

exports.WSQ_ERROR = new PouchError({
  status: 500,
  error: 'web_sql_went_bad',
  reason: 'unknown'
});

exports.LDB_ERROR = new PouchError({
  status: 500,
  error: 'levelDB_went_went_bad',
  reason: 'unknown'
});

exports.FORBIDDEN = new PouchError({
  status: 403,
  error: 'forbidden',
  reason: 'Forbidden by design doc validate_doc_update function'
});

exports.INVALID_REV = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Invalid rev format'
});

exports.FILE_EXISTS = new PouchError({
  status: 412,
  error: 'file_exists',
  reason: 'The database could not be created, the file already exists.'
});

exports.MISSING_STUB = new PouchError({
  status: 412,
  error: 'missing_stub'
});

exports.error = function (error, reason, name) {
  function CustomPouchError(reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    /* jshint ignore:start */
    for (var p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p];
      }
    }
    /* jshint ignore:end */
    if (name !== undefined) {
      this.name = name;
    }
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
};

// Find one of the errors defined above based on the value
// of the specified property.
// If reason is provided prefer the error matching that reason.
// This is for differentiating between errors with the same name and status,
// eg, bad_request.
exports.getErrorTypeByProp = function (prop, value, reason) {
  var errors = exports;
  var keys = Object.keys(errors).filter(function (key) {
    var error = errors[key];
    return typeof error !== 'function' && error[prop] === value;
  });
  var key = reason && keys.filter(function (key) {
      var error = errors[key];
      return error.message === reason;
    })[0] || keys[0];
  return (key) ? errors[key] : null;
};

exports.generateErrorFromResponse = function (res) {
  var error, errName, errType, errMsg, errReason;
  var errors = exports;

  errName = (res.error === true && typeof res.name === 'string') ?
    res.name :
    res.error;
  errReason = res.reason;
  errType = errors.getErrorTypeByProp('name', errName, errReason);

  if (res.missing ||
    errReason === 'missing' ||
    errReason === 'deleted' ||
    errName === 'not_found') {
    errType = errors.MISSING_DOC;
  } else if (errName === 'doc_validation') {
    // doc validation needs special treatment since
    // res.reason depends on the validation error.
    // see utils.js
    errType = errors.DOC_VALIDATION;
    errMsg = errReason;
  } else if (errName === 'bad_request' && errType.message !== errReason) {
    // if bad_request error already found based on reason don't override.

    // attachment errors.
    if (errReason.indexOf('unknown stub attachment') === 0) {
      errType = errors.MISSING_STUB;
      errMsg = errReason;
    } else {
      errType = errors.BAD_REQUEST;
    }
  }

  // fallback to error by statys or unknown error.
  if (!errType) {
    errType = errors.getErrorTypeByProp('status', res.status, errReason) ||
    errors.UNKNOWN_ERROR;
  }

  error = errors.error(errType, errReason, errName);

  // Keep custom message.
  if (errMsg) {
    error.message = errMsg;
  }

  // Keep helpful response data in our error messages.
  if (res.id) {
    error.id = res.id;
  }
  if (res.status) {
    error.status = res.status;
  }
  if (res.statusText) {
    error.name = res.statusText;
  }
  if (res.missing) {
    error.missing = res.missing;
  }

  return error;
};

},{"14":14}],7:[function(_dereq_,module,exports){
'use strict';

function isBinaryObject(object) {
  return object instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && object instanceof Blob);
}

function cloneArrayBuffer(buff) {
  if (typeof buff.slice === 'function') {
    return buff.slice(0);
  }
  // IE10-11 slice() polyfill
  var target = new ArrayBuffer(buff.byteLength);
  var targetArray = new Uint8Array(target);
  var sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

function cloneBinaryObject(object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  // Blob
  return object.slice(0, object.size, object.type);
}

module.exports = function clone(object) {
  var newObject;
  var i;
  var len;

  if (!object || typeof object !== 'object') {
    return object;
  }

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  newObject = {};
  for (i in object) {
    if (Object.prototype.hasOwnProperty.call(object, i)) {
      var value = clone(object[i]);
      if (typeof value !== 'undefined') {
        newObject[i] = value;
      }
    }
  }
  return newObject;
};

},{}],8:[function(_dereq_,module,exports){
(function (process,global){
'use strict';

function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex;
}

var Promise = _interopDefault(_dereq_(18));

exports.lastIndexOf = function lastIndexOf(str, char) {
  for (var i = str.length - 1; i >= 0; i--) {
    if (str.charAt(i) === char) {
      return i;
    }
  }
  return -1;
};

exports.clone = _dereq_(7);

/* istanbul ignore next */
exports.once = function once(fun) {
  var called = false;
  return exports.getArguments(function (args) {
    if (called) {
      if ('console' in global && 'trace' in console) {
        console.trace();
      }
      throw new Error('once called  more than once');
    } else {
      called = true;
      fun.apply(this, args);
    }
  });
};
/* istanbul ignore next */
exports.getArguments = function getArguments(fun) {
  return function () {
    var len = arguments.length;
    var args = new Array(len);
    var i = -1;
    while (++i < len) {
      args[i] = arguments[i];
    }
    return fun.call(this, args);
  };
};
/* istanbul ignore next */
exports.toPromise = function toPromise(func) {
  //create the function we will be returning
  return exports.getArguments(function (args) {
    var self = this;
    var tempCB = (typeof args[args.length - 1] === 'function') ? args.pop() : false;
    // if the last argument is a function, assume its a callback
    var usedCB;
    if (tempCB) {
      // if it was a callback, create a new callback which calls it,
      // but do so async so we don't trap any errors
      usedCB = function (err, resp) {
        process.nextTick(function () {
          tempCB(err, resp);
        });
      };
    }
    var promise = new Promise(function (fulfill, reject) {
      try {
        var callback = exports.once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        func.apply(self, args);
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    promise.cancel = function () {
      return this;
    };
    return promise;
  });
};

exports.inherits = _dereq_(14);
exports.Promise = Promise;

var binUtil = _dereq_(17);

exports.createBlob = binUtil.createBlob;
exports.readAsArrayBuffer = binUtil.readAsArrayBuffer;
exports.readAsBinaryString = binUtil.readAsBinaryString;
exports.binaryStringToArrayBuffer = binUtil.binaryStringToArrayBuffer;
exports.arrayBufferToBinaryString = binUtil.arrayBufferToBinaryString;

}).call(this,_dereq_(20),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"14":14,"17":17,"18":18,"20":20,"7":7}],9:[function(_dereq_,module,exports){
"use strict";

// BEGIN Math.uuid.js

/*!
 Math.uuid.js (v1.4)
 http://www.broofa.com
 mailto:robert@broofa.com

 Copyright (c) 2010 Robert Kieffer
 Dual licensed under the MIT and GPL licenses.
 */

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix. 
 *   // (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
var chars = (
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
'abcdefghijklmnopqrstuvwxyz'
).split('');
function getValue(radix) {
  return 0 | Math.random() * radix;
}
function uuid(len, radix) {
  radix = radix || chars.length;
  var out = '';
  var i = -1;

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)];
    }
    return out;
  }
  // rfc4122, version 4 form
  // Fill in random data.  At i==19 set the high bits of clock sequence as
  // per rfc4122, sec. 4.1.5
  while (++i < 36) {
    switch (i) {
      case 8:
      case 13:
      case 18:
      case 23:
        out += '-';
        break;
      case 19:
        out += chars[(getValue(16) & 0x3) | 0x8];
        break;
      default:
        out += chars[getValue(16)];
    }
  }

  return out;
}



module.exports = uuid;


},{}],10:[function(_dereq_,module,exports){
// this code is automatically generated by bin/build.js
module.exports = "!function(){function e(t,n,r){function o(a,s){if(!n[a]){if(!t[a]){var u=\"function\"==typeof require&&require;if(!s&&u)return u(a,!0);if(i)return i(a,!0);var c=new Error(\"Cannot find module '\"+a+\"'\");throw c.code=\"MODULE_NOT_FOUND\",c}var f=n[a]={exports:{}};t[a][0].call(f.exports,function(e){var n=t[a][1][e];return o(n||e)},f,f.exports,e,t,n,r)}return n[a].exports}for(var i=\"function\"==typeof require&&require,a=0;a<r.length;a++)o(r[a]);return o}return e}()({1:[function(e,t,n){\"use strict\";function r(e){Error.call(e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}e(12)(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message})},n.UNAUTHORIZED=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),n.MISSING_BULK_DOCS=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),n.MISSING_DOC=new r({status:404,error:\"not_found\",reason:\"missing\"}),n.REV_CONFLICT=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),n.INVALID_ID=new r({status:400,error:\"invalid_id\",reason:\"_id field must contain a string\"}),n.MISSING_ID=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),n.RESERVED_ID=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),n.NOT_OPEN=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),n.UNKNOWN_ERROR=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),n.BAD_ARG=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),n.INVALID_REQUEST=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),n.QUERY_PARSE_ERROR=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),n.DOC_VALIDATION=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),n.BAD_REQUEST=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),n.NOT_AN_OBJECT=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),n.DB_MISSING=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),n.IDB_ERROR=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),n.WSQ_ERROR=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),n.LDB_ERROR=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),n.FORBIDDEN=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),n.INVALID_REV=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),n.FILE_EXISTS=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),n.MISSING_STUB=new r({status:412,error:\"missing_stub\"}),n.error=function(e,t,n){function o(t){for(var r in e)\"function\"!=typeof e[r]&&(this[r]=e[r]);void 0!==n&&(this.name=n),void 0!==t&&(this.reason=t)}return o.prototype=r.prototype,new o(t)},n.getErrorTypeByProp=function(e,t,r){var o=n,i=Object.keys(o).filter(function(n){var r=o[n];return\"function\"!=typeof r&&r[e]===t}),a=r&&i.filter(function(e){return o[e].message===r})[0]||i[0];return a?o[a]:null},n.generateErrorFromResponse=function(e){var t,r,o,i,a,s=n;return r=!0===e.error&&\"string\"==typeof e.name?e.name:e.error,a=e.reason,o=s.getErrorTypeByProp(\"name\",r,a),e.missing||\"missing\"===a||\"deleted\"===a||\"not_found\"===r?o=s.MISSING_DOC:\"doc_validation\"===r?(o=s.DOC_VALIDATION,i=a):\"bad_request\"===r&&o.message!==a&&(0===a.indexOf(\"unknown stub attachment\")?(o=s.MISSING_STUB,i=a):o=s.BAD_REQUEST),o||(o=s.getErrorTypeByProp(\"status\",e.status,a)||s.UNKNOWN_ERROR),t=s.error(o,a,r),i&&(t.message=i),e.id&&(t.id=e.id),e.status&&(t.status=e.status),e.statusText&&(t.name=e.statusText),e.missing&&(t.missing=e.missing),t}},{12:12}],2:[function(e,t,n){\"use strict\";function r(e,t){function n(t,n){\"function\"!=typeof e.postMessage?n.ports[0].postMessage(t):e.postMessage(t)}function r(e,t,r){f(\" -> sendUncaughtError\",e,t),n({type:\"uncaughtError\",id:e,content:a.createError(t)},r)}function l(e,t,r,o){f(\" -> sendError\",e,t,r),n({type:\"error\",id:e,messageId:t,content:a.createError(r)},o)}function d(e,t,r,o){f(\" -> sendSuccess\",e,t),n({type:\"success\",id:e,messageId:t,content:r},o)}function h(e,t,r,o){f(\" -> sendUpdate\",e,t),n({type:\"update\",id:e,messageId:t,content:r},o)}function p(e,t,n,r,i){var a=u[\"$\"+e];if(!a)return l(e,n,{error:\"db not found\"},i);o.resolve().then(function(){return a[t].apply(a,r)}).then(function(t){d(e,n,t,i)}).catch(function(t){l(e,n,t,i)})}function v(e,t,n,r){var o=n[0];o&&\"object\"==typeof o&&(o.returnDocs=!0,o.return_docs=!0),p(e,\"changes\",t,n,r)}function y(e,t,n,r){var a=u[\"$\"+e];if(!a)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=n[0],s=n[1],u=n[2];return\"object\"!=typeof u&&(u={}),a.get(o,u).then(function(o){if(!o._attachments||!o._attachments[s])throw i.MISSING_DOC;return a.getAttachment.apply(a,n).then(function(n){d(e,t,n,r)})})}).catch(function(n){l(e,t,n,r)})}function g(e,t,n,r){var i=\"$\"+e,a=u[i];if(!a)return l(e,t,{error:\"db not found\"},r);delete u[i],o.resolve().then(function(){return a.destroy.apply(a,n)}).then(function(n){d(e,t,n,r)}).catch(function(n){l(e,t,n,r)})}function m(e,t,n,r){var i=u[\"$\"+e];if(!i)return l(e,t,{error:\"db not found\"},r);o.resolve().then(function(){var o=i.changes(n[0]);c[t]=o,o.on(\"change\",function(n){h(e,t,n,r)}).on(\"complete\",function(n){o.removeAllListeners(),delete c[t],d(e,t,n,r)}).on(\"error\",function(n){o.removeAllListeners(),delete c[t],l(e,t,n,r)})})}function _(e){var t=c[e];t&&t.cancel()}function b(e,t,n){return o.resolve().then(function(){e.on(\"error\",function(e){r(t,e,n)})})}function w(e,n,r,o){var i=\"$\"+e,a=u[i];return a?b(a,e,o).then(function(){return d(e,n,{ok:!0,exists:!0},o)}):(\"string\"==typeof r[0]?r[0]:r[0].name)?(a=u[i]=t(r[0]),void b(a,e,o).then(function(){d(e,n,{ok:!0},o)}).catch(function(t){l(e,n,t,o)})):l(e,n,{error:\"you must provide a database name\"},o)}function k(e,t,n,r,o){switch(f(\"onReceiveMessage\",t,e,n,r,o),t){case\"createDatabase\":return w(e,n,r,o);case\"id\":case\"info\":case\"put\":case\"allDocs\":case\"bulkDocs\":case\"post\":case\"get\":case\"remove\":case\"revsDiff\":case\"compact\":case\"viewCleanup\":case\"removeAttachment\":case\"putAttachment\":case\"query\":case\"createIndex\":case\"find\":case\"load\":return p(e,t,n,r,o);case\"changes\":return v(e,n,r,o);case\"getAttachment\":return y(e,n,r,o);case\"liveChanges\":return m(e,n,r,o);case\"cancelChanges\":return _(n);case\"destroy\":return g(e,n,r,o);default:return l(e,n,{error:\"unknown API method: \"+t},o)}}function E(e,t,n){k(t,e.type,e.messageId,s(e.args),n)}e.addEventListener(\"message\",function(e){if(e.data&&e.data.id&&e.data.args&&e.data.type&&e.data.messageId){var t=e.data.id;\"close\"===e.data.type?(f(\"closing worker\",t),delete u[\"$\"+t]):E(e.data,t,e)}})}var o=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(68)),i=e(1),a=e(6),s=a.decodeArgs,u={},c={},f=e(8)(\"pouchdb:worker\");t.exports=r},{1:1,6:6,68:68,8:8}],3:[function(e,t,n){\"use strict\";var r=e(2),o=e(4);r(self,o)},{2:2,4:4}],4:[function(e,t,n){\"use strict\";t.exports=e(25).plugin(e(33)).plugin(e(45)).plugin(e(17)).plugin(e(16)).plugin(e(65)).plugin(e(70))},{16:16,17:17,25:25,33:33,45:45,65:65,70:70}],5:[function(_dereq_,module,exports){\"use strict\";var log=_dereq_(8)(\"pouchdb:worker\");module.exports=function safeEval(str){log(\"safeEvaling\",str);var target={};return eval(\"target.target = (\"+str+\");\"),log(\"returning\",target.target),target.target}},{8:8}],6:[function(e,t,n){\"use strict\";var r=e(5);n.createError=function(e){var t=e.status||500;return e.name&&e.message&&(\"Error\"!==e.name&&\"TypeError\"!==e.name||(-1!==e.message.indexOf(\"Bad special document member\")?e.name=\"doc_validation\":e.name=\"bad_request\"),e={error:e.name,name:e.name,reason:e.message,message:e.message,status:t}),e},n.decodeArgs=function(e){var t=[\"filter\",\"map\",\"reduce\"];return e.forEach(function(e){\"object\"!=typeof e||null===e||Array.isArray(e)||t.forEach(function(t){t in e&&null!==e[t]?\"func\"===e[t].type&&e[t].func&&(e[t]=r(e[t].func)):delete e[t]})}),e}},{5:5}],7:[function(e,t,n){\"use strict\";function r(e){return function(){var t=arguments.length;if(t){for(var n=[],r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}return e.call(this,[])}}t.exports=r},{}],8:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document.documentElement&&document.documentElement.style&&document.documentElement.style.WebkitAppearance||\"undefined\"!=typeof window&&window.console&&(window.console.firebug||window.console.exception&&window.console.table)||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function a(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function s(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function u(){var e;try{e=n.storage.debug}catch(e){}return!e&&void 0!==r&&\"env\"in r&&(e=r.env.DEBUG),e}n=t.exports=e(9),n.log=a,n.formatArgs=i,n.save=s,n.load=u,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(u())}).call(this,e(73))},{73:73,9:9}],9:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(c||r);e.diff=o,e.prev=c,e.curr=r,c=r;for(var i=new Array(arguments.length),a=0;a<i.length;a++)i[a]=arguments[a];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var s=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;s++;var o=n.formatters[r];if(\"function\"==typeof o){var a=i[s];t=o.call(e,a),i.splice(s,1),s--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}return t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(\"string\"==typeof e?e:\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function a(){n.enable(\"\")}function s(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=u,n.disable=a,n.enable=i,n.enabled=s,n.humanize=e(14),n.names=[],n.skips=[],n.formatters={};var c},{14:14}],10:[function(e,t,n){function r(){this._events=this._events||{},this._maxListeners=this._maxListeners||void 0}function o(e){return\"function\"==typeof e}function i(e){return\"number\"==typeof e}function a(e){return\"object\"==typeof e&&null!==e}function s(e){return void 0===e}t.exports=r,r.EventEmitter=r,r.prototype._events=void 0,r.prototype._maxListeners=void 0,r.defaultMaxListeners=10,r.prototype.setMaxListeners=function(e){if(!i(e)||e<0||isNaN(e))throw TypeError(\"n must be a positive number\");return this._maxListeners=e,this},r.prototype.emit=function(e){var t,n,r,i,u,c;if(this._events||(this._events={}),\"error\"===e&&(!this._events.error||a(this._events.error)&&!this._events.error.length)){if((t=arguments[1])instanceof Error)throw t;var f=new Error('Uncaught, unspecified \"error\" event. ('+t+\")\");throw f.context=t,f}if(n=this._events[e],s(n))return!1;if(o(n))switch(arguments.length){case 1:n.call(this);break;case 2:n.call(this,arguments[1]);break;case 3:n.call(this,arguments[1],arguments[2]);break;default:i=Array.prototype.slice.call(arguments,1),n.apply(this,i)}else if(a(n))for(i=Array.prototype.slice.call(arguments,1),c=n.slice(),r=c.length,u=0;u<r;u++)c[u].apply(this,i);return!0},r.prototype.addListener=function(e,t){var n;if(!o(t))throw TypeError(\"listener must be a function\");return this._events||(this._events={}),this._events.newListener&&this.emit(\"newListener\",e,o(t.listener)?t.listener:t),this._events[e]?a(this._events[e])?this._events[e].push(t):this._events[e]=[this._events[e],t]:this._events[e]=t,a(this._events[e])&&!this._events[e].warned&&(n=s(this._maxListeners)?r.defaultMaxListeners:this._maxListeners)&&n>0&&this._events[e].length>n&&(this._events[e].warned=!0,console.error(\"(node) warning: possible EventEmitter memory leak detected. %d listeners added. Use emitter.setMaxListeners() to increase limit.\",this._events[e].length),\"function\"==typeof console.trace&&console.trace()),this},r.prototype.on=r.prototype.addListener,r.prototype.once=function(e,t){function n(){this.removeListener(e,n),r||(r=!0,t.apply(this,arguments))}if(!o(t))throw TypeError(\"listener must be a function\");var r=!1;return n.listener=t,this.on(e,n),this},r.prototype.removeListener=function(e,t){var n,r,i,s;if(!o(t))throw TypeError(\"listener must be a function\");if(!this._events||!this._events[e])return this;if(n=this._events[e],i=n.length,r=-1,n===t||o(n.listener)&&n.listener===t)delete this._events[e],this._events.removeListener&&this.emit(\"removeListener\",e,t);else if(a(n)){for(s=i;s-- >0;)if(n[s]===t||n[s].listener&&n[s].listener===t){r=s;break}if(r<0)return this;1===n.length?(n.length=0,delete this._events[e]):n.splice(r,1),this._events.removeListener&&this.emit(\"removeListener\",e,t)}return this},r.prototype.removeAllListeners=function(e){var t,n;if(!this._events)return this;if(!this._events.removeListener)return 0===arguments.length?this._events={}:this._events[e]&&delete this._events[e],this;if(0===arguments.length){for(t in this._events)\"removeListener\"!==t&&this.removeAllListeners(t);return this.removeAllListeners(\"removeListener\"),this._events={},this}if(n=this._events[e],o(n))this.removeListener(e,n);else if(n)for(;n.length;)this.removeListener(e,n[n.length-1]);return delete this._events[e],this},r.prototype.listeners=function(e){return this._events&&this._events[e]?o(this._events[e])?[this._events[e]]:this._events[e].slice():[]},r.prototype.listenerCount=function(e){if(this._events){var t=this._events[e];if(o(t))return 1;if(t)return t.length}return 0},r.listenerCount=function(e,t){return e.listenerCount(t)}},{}],11:[function(e,t,n){(function(e){\"use strict\";function n(){f=!0;for(var e,t,n=l.length;n;){for(t=l,l=[],e=-1;++e<n;)t[e]();n=l.length}f=!1}function r(e){1!==l.push(e)||f||o()}var o,i=e.MutationObserver||e.WebKitMutationObserver;if(i){var a=0,s=new i(n),u=e.document.createTextNode(\"\");s.observe(u,{characterData:!0}),o=function(){u.data=a=++a%2}}else if(e.setImmediate||void 0===e.MessageChannel)o=\"document\"in e&&\"onreadystatechange\"in e.document.createElement(\"script\")?function(){var t=e.document.createElement(\"script\");t.onreadystatechange=function(){n(),t.onreadystatechange=null,t.parentNode.removeChild(t),t=null},e.document.documentElement.appendChild(t)}:function(){setTimeout(n,0)};else{var c=new e.MessageChannel;c.port1.onmessage=n,o=function(){c.port2.postMessage(0)}}var f,l=[];t.exports=r}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{}],12:[function(e,t,n){\"function\"==typeof Object.create?t.exports=function(e,t){e.super_=t,e.prototype=Object.create(t.prototype,{constructor:{value:e,enumerable:!1,writable:!0,configurable:!0}})}:t.exports=function(e,t){e.super_=t;var n=function(){};n.prototype=t.prototype,e.prototype=new n,e.prototype.constructor=e}},{}],13:[function(e,t,n){(function(e){e(\"object\"==typeof n?n:this)}).call(this,function(e){var t=Array.prototype.slice,n=Array.prototype.forEach,r=function(e){if(\"object\"!=typeof e)throw e+\" is not an object\";var o=t.call(arguments,1);return n.call(o,function(t){if(t)for(var n in t)\"object\"==typeof t[n]&&e[n]?r.call(e,e[n],t[n]):e[n]=t[n]}),e};e.extend=r})},{}],14:[function(e,t,n){function r(e){if(e=String(e),!(e.length>100)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*s;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=s?Math.round(e/s)+\"s\":e+\"ms\"}function i(e){return a(e,f,\"day\")||a(e,c,\"hour\")||a(e,u,\"minute\")||a(e,s,\"second\")||e+\" ms\"}function a(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var s=1e3,u=60*s,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],15:[function(e,t,n){\"use strict\";function r(){this.promise=new l(function(e){e()})}function o(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function i(e,t){return o(e)+o(t)+\"undefined\"}function a(e,t,n,r,o,a){var s,u=i(n,r);if(!o&&(s=e._cachedViews=e._cachedViews||{},s[u]))return s[u];var c=e.info().then(function(i){function c(e){e.views=e.views||{};var n=t;-1===n.indexOf(\"/\")&&(n=t+\"/\"+t);var r=e.views[n]=e.views[n]||{};if(!r[f])return r[f]=!0,e}var f=i.db_name+\"-mrview-\"+(o?\"temp\":y.stringMd5(u));return h.upsert(e,\"_local/\"+a,c).then(function(){return e.registerDependentDatabase(f).then(function(t){var o=t.db;o.auto_compaction=!0;var i={name:f,db:o,sourceDB:e,adapter:e.adapter,mapFun:n,reduceFun:r};return i.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return i.seq=e?e.seq:0,s&&i.db.once(\"destroyed\",function(){delete s[u]}),i})})})});return s&&(s[u]=c),c}function s(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function u(e){return 1===e.length&&/^1-/.test(e[0].rev)}function c(e,t){try{e.emit(\"error\",t)}catch(e){h.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),h.guardedConsole(\"error\",t)}}function f(e,t,n,o){function i(e,t,n){try{t(n)}catch(t){c(e,t)}}function f(e,t,n,r,o){try{return{output:t(n,r,o)}}catch(t){return c(e,t),{error:t}}}function y(e,t){var n=v.collate(e.key,t.key);return 0!==n?n:v.collate(e.value,t.value)}function w(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function k(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function E(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=p.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function S(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&E(t),t}}function O(e,t,n,r){var o=t[e];void 0!==o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function A(e){if(void 0!==e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function j(e){return e.group_level=A(e.group_level),e.limit=A(e.limit),e.skip=A(e.skip),e}function x(e){if(e){if(\"number\"!=typeof e)return new g.QueryParseError('Invalid value for integer: \"'+e+'\"');if(e<0)return new g.QueryParseError('Invalid value for positive integer: \"'+e+'\"')}}function I(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(void 0!==e[n]&&void 0!==e[r]&&v.collate(e[n],e[r])>0)throw new g.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&!1!==e.reduce){if(e.include_docs)throw new g.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new g.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=x(e[t]);if(n)throw n})}function D(e,t,n){var r,o=[],i=\"GET\";if(O(\"reduce\",n,o),O(\"include_docs\",n,o),O(\"attachments\",n,o),O(\"limit\",n,o),O(\"descending\",n,o),O(\"group\",n,o),O(\"group_level\",n,o),O(\"skip\",n,o),O(\"stale\",n,o),O(\"conflicts\",n,o),O(\"startkey\",n,o,!0),O(\"start_key\",n,o,!0),O(\"endkey\",n,o,!0),O(\"end_key\",n,o,!0),O(\"inclusive_end\",n,o),O(\"key\",n,o,!0),o=o.join(\"&\"),o=\"\"===o?\"\":\"?\"+o,void 0!==n.keys){var a=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));a.length+o.length+1<=2e3?o+=(\"?\"===o[0]?\"&\":\"?\")+a:(i=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var u=s(t);return e.request({method:i,url:\"_design/\"+u[0]+\"/_view/\"+u[1]+o,body:r}).then(S(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.request({method:\"POST\",url:\"_temp_view\"+o,body:r}).then(S(n))}function q(e,t,n){return new l(function(r,o){e._query(t,n,function(e,t){if(e)return o(e);r(t)})})}function C(e){return new l(function(t,n){e._viewCleanup(function(e,r){if(e)return n(e);t(r)})})}function B(e){return function(t){if(404===t.status)return e;throw t}}function R(e,t,n){function r(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):l.resolve({rows:[]})}function o(e,t){for(var n=[],r=new d.Set,o=0,i=t.rows.length;o<i;o++){var a=t.rows[o],s=a.doc;if(s&&(n.push(s),r.add(s._id),s._deleted=!c.has(s._id),!s._deleted)){var u=c.get(s._id);\"value\"in u&&(s.value=u.value)}}var f=g.mapToKeysArray(c);return f.forEach(function(e){if(!r.has(e)){var t={_id:e},o=c.get(e);\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=g.uniq(f.concat(e.keys)),n.push(e),n}var i=\"_local/doc_\"+e,a={_id:i,keys:[]},s=n.get(e),c=s[0],f=s[1];return function(){return u(f)?l.resolve(a):t.db.get(i).catch(B(a))}().then(function(e){return r(e).then(function(t){return o(e,t)})})}function T(e,t,n){return e.db.get(\"_local/lastSeq\").catch(B({_id:\"_local/lastSeq\",seq:0})).then(function(r){var o=g.mapToKeysArray(t);return l.all(o.map(function(n){return R(n,e,t)})).then(function(t){var o=h.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function $(e){var t=\"string\"==typeof e?e:e.name,n=m[t];return n||(n=m[t]=new r),n}function L(e){return g.sequentialize($(e),function(){return N(e)})()}function N(e){function n(e,t){var n={id:l._id,key:v.normalizeKey(e)};void 0!==t&&null!==t&&(n.value=v.normalizeKey(t)),f.push(n)}function o(t,n){return function(){return T(e,t,n)}}function a(){return e.sourceDB.changes({conflicts:!0,include_docs:!0,style:\"all_docs\",since:p,limit:b}).then(s)}function s(e){var t=e.results;if(t.length){var n=u(t);if(g.add(o(n,p)),!(t.length<b))return a()}}function u(t){for(var n=new d.Map,r=0,o=t.length;r<o;r++){var a=t[r];if(\"_\"!==a.doc._id[0]){f=[],l=a.doc,l._deleted||i(e.sourceDB,h,l),f.sort(y);var s=c(f);n.set(a.doc._id,[s,a.changes])}p=a.seq}return n}function c(e){for(var t,n=new d.Map,r=0,o=e.length;r<o;r++){var i=e[r],a=[i.key,i.id];r>0&&0===v.collate(i.key,t)&&a.push(r),n.set(v.toIndexableString(a),i),t=i.key}return n}var f,l,h=t(e.mapFun,n),p=e.seq||0,g=new r;return a().then(function(){return g.finish()}).then(function(){e.seq=p})}function M(e,t,r){0===r.group_level&&delete r.group_level;var o=r.group||r.group_level,i=n(e.reduceFun),a=[],s=isNaN(r.group_level)?Number.POSITIVE_INFINITY:r.group_level;t.forEach(function(e){var t=a[a.length-1],n=o?e.key:null;if(o&&Array.isArray(n)&&(n=n.slice(0,s)),t&&0===v.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);a.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var u=0,c=a.length;u<c;u++){var l=a[u],d=f(e.sourceDB,i,l.keys,l.values,!1);if(d.error&&d.error instanceof g.BuiltInError)throw d.error;t.push({value:d.error?null:d.output,key:l.groupKey})}return{rows:w(t,r.limit,r.skip)}}function F(e,t){return g.sequentialize($(e),function(){return P(e,t)})()}function P(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||t>n))return e.doc.value}var r=v.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?M(e,n,t):{total_rows:o,offset:a,rows:n},t.include_docs){var s=g.uniq(n.map(k));return e.sourceDB.allDocs({keys:s,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t=new d.Map;return e.rows.forEach(function(e){t.set(e.id,e.doc)}),n.forEach(function(e){var n=k(e),r=t.get(n);r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&!1!==t.reduce,a=t.skip||0;if(void 0===t.keys||t.keys.length||(t.limit=0,delete t.keys),void 0!==t.keys){var s=t.keys,u=s.map(function(e){return n({startkey:v.toIndexableString([e]),endkey:v.toIndexableString([e,{}])})});return l.all(u).then(h.flatten).then(r)}var c,f,p={descending:t.descending};if(\"start_key\"in t&&(c=t.start_key),\"startkey\"in t&&(c=t.startkey),\"end_key\"in t&&(f=t.end_key),\"endkey\"in t&&(f=t.endkey),void 0!==c&&(p.startkey=t.descending?v.toIndexableString([c,{}]):v.toIndexableString([c])),void 0!==f){var y=!1!==t.inclusive_end;t.descending&&(y=!y),p.endkey=v.toIndexableString(y?[f,{}]:[f])}if(void 0!==t.key){var m=v.toIndexableString([t.key]),_=v.toIndexableString([t.key,{}]);p.descending?(p.endkey=m,p.startkey=_):(p.startkey=m,p.endkey=_)}return i||(\"number\"==typeof t.limit&&(p.limit=t.limit),p.skip=a),n(p).then(r)}function U(e){return e.request({method:\"POST\",url:\"_view_cleanup\"})}function z(t){return t.get(\"_local/\"+e).then(function(e){var n=new d.Map;Object.keys(e.views).forEach(function(e){var t=s(e),r=\"_design/\"+t[0],o=t[1],i=n.get(r);i||(i=new d.Set,n.set(r,i)),i.add(o)});var r={keys:g.mapToKeysArray(n),include_docs:!0};return t.allDocs(r).then(function(r){var o={};r.rows.forEach(function(t){var r=t.key.substring(8);n.get(t.key).forEach(function(n){var i=r+\"/\"+n;e.views[i]||(i=n);var a=Object.keys(e.views[i]),s=t.doc&&t.doc.views&&t.doc.views[n];a.forEach(function(e){o[e]=o[e]||s})})});var i=Object.keys(o).filter(function(e){return!o[e]}),a=i.map(function(e){return g.sequentialize($(e),function(){return new t.constructor(e,t.__opts).destroy()})()});return l.all(a).then(function(){return{ok:!0}})})},B({ok:!0}))}function K(t,n,r){if(\"function\"==typeof t._query)return q(t,n,r);if(h.isRemote(t))return D(t,n,r);if(\"string\"!=typeof n)return I(r,n),_.add(function(){return a(t,\"temp_view/temp_view\",n.map,n.reduce,!0,e).then(function(e){return g.fin(L(e).then(function(){return F(e,r)}),function(){return e.db.destroy()})})}),_.finish();var i=n,u=s(i),c=u[0],f=u[1];return t.get(\"_design/\"+c).then(function(n){var s=n.views&&n.views[f];if(!s)throw new g.NotFoundError(\"ddoc \"+n._id+\" has no view named \"+f);return o(n,f),I(r,s),a(t,i,s.map,s.reduce,!1,e).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&h.nextTick(function(){L(e)}),F(e,r)):L(e).then(function(){return F(e,r)})})})}function G(e,t,n){var r=this;\"function\"==typeof t&&(n=t,t={}),t=t?j(t):{},\"function\"==typeof e&&(e={map:e});var o=l.resolve().then(function(){return K(r,e,t)});return g.promisedCallback(o,n),o}return{query:G,viewCleanup:g.callbackify(function(){var e=this;return\"function\"==typeof e._viewCleanup?C(e):h.isRemote(e)?U(e):z(e)})}}var l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(68)),d=e(24),h=e(72),p=e(20),v=e(23),y=e(66),g=e(64);r.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},r.prototype.finish=function(){return this.promise};var m={},_=new r,b=50;t.exports=f},{20:20,23:23,24:24,64:64,66:66,68:68,72:72}],16:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t){return new p(function(n,r){function o(){f++,e[l++]().then(a,s)}function i(){++d===h?c?r(c):n():u()}function a(){f--,i()}function s(e){f--,c=c||e,i()}function u(){for(;f<t&&l<h;)o()}var c,f=0,l=0,d=0,h=e.length;u()})}function i(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];n.data=m.base64StringToBlobOrBuffer(n.data,n.content_type)})}function a(e){return/^_design/.test(e)?\"_design/\"+encodeURIComponent(e.slice(8)):/^_local/.test(e)?\"_local/\"+encodeURIComponent(e.slice(7)):encodeURIComponent(e)}function s(e){return e._attachments&&Object.keys(e._attachments)?p.all(Object.keys(e._attachments).map(function(t){var n=e._attachments[t];if(n.data&&\"string\"!=typeof n.data)return new p(function(e){m.blobOrBufferToBase64(n.data,e)}).then(function(e){n.data=e})})):p.resolve()}function u(e){if(!e.prefix)return!1;var t=v.parseUri(e.prefix).protocol;return\"http\"===t||\"https\"===t}function c(e,t){if(u(t)){var n=t.name.substr(t.prefix.length);e=t.prefix+encodeURIComponent(n)}var r=v.parseUri(e);(r.user||r.password)&&(r.auth={username:r.user,password:r.password});var o=r.path.replace(/(^\\/|\\/$)/g,\"\").split(\"/\");return r.db=o.pop(),-1===r.db.indexOf(\"%\")&&(r.db=encodeURIComponent(r.db)),r.path=o.join(\"/\"),r}function f(e,t){return l(e,e.db+\"/\"+t)}function l(e,t){var n=e.path?\"/\":\"\";return e.protocol+\"://\"+e.host+(e.port?\":\"+e.port:\"\")+\"/\"+e.path+n+t}function d(e){return\"?\"+Object.keys(e).map(function(t){return t+\"=\"+encodeURIComponent(e[t])}).join(\"&\")}function h(e,t){function n(e,t,n){var r=e.ajax||{},o=v.assign(v.clone(j),r,t),i=v.clone(j.headers||{});return o.headers=v.assign(i,r.headers,t.headers||{}),S.constructor.listeners(\"debug\").length&&S.constructor.emit(\"debug\",[\"http\",o.method,o.url]),S._ajax(o,n)}function r(e,t){return new p(function(r,o){n(e,t,function(e,t){if(e)return o(e);r(t)})})}function u(e,t){return v.adapterFun(e,g(function(e){h().then(function(){return t.apply(this,e)}).catch(function(t){e.pop()(t)})}))}function h(){return e.skipSetup||e.skip_setup?p.resolve():q||(q=r({},{method:\"GET\",url:A}).catch(function(e){return e&&e.status&&404===e.status?(v.explainError(404,\"PouchDB is just detecting if the remote exists.\"),r({},{method:\"PUT\",url:A})):p.reject(e)}).catch(function(e){return!(!e||!e.status||412!==e.status)||p.reject(e)}),q.catch(function(){q=null}),q)}function E(e){return e.split(\"/\").map(encodeURIComponent).join(\"/\")}var S=this,O=c(e.name,e),A=f(O,\"\");e=v.clone(e);var j=e.ajax||{};if(e.auth||O.auth){var x=e.auth||O.auth,I=x.username+\":\"+x.password,D=m.btoa(unescape(encodeURIComponent(I)));j.headers=j.headers||{},j.headers.Authorization=\"Basic \"+D}S._ajax=y;var q;v.nextTick(function(){t(null,S)}),S._remote=!0,S.type=function(){return\"http\"},S.id=u(\"id\",function(e){n({},{method:\"GET\",url:l(O,\"\")},function(t,n){var r=n&&n.uuid?n.uuid+O.db:f(O,\"\");e(null,r)})}),S.request=u(\"request\",function(e,t){e.url=f(O,e.url),n({},e,t)}),S.compact=u(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=v.clone(e),n(e,{url:f(O,\"_compact\"),method:\"POST\"},function(){function n(){S.info(function(r,o){o&&!o.compact_running?t(null,{ok:!0\n}):setTimeout(n,e.interval||200)})}n()})}),S.bulkGet=v.adapterFun(\"bulkGet\",function(e,t){function r(t){var r={};e.revs&&(r.revs=!0),e.attachments&&(r.attachments=!0),e.latest&&(r.latest=!0),n(e,{url:f(O,\"_bulk_get\"+d(r)),method:\"POST\",body:{docs:e.docs}},t)}function o(){for(var n=w,r=Math.ceil(e.docs.length/n),o=0,a=new Array(r),s=0;s<r;s++){var u=v.pick(e,[\"revs\",\"attachments\",\"latest\"]);u.ajax=j,u.docs=e.docs.slice(s*n,Math.min(e.docs.length,(s+1)*n)),v.bulkGetShim(i,u,function(e){return function(n,i){a[e]=i.results,++o===r&&t(null,{results:v.flatten(a)})}}(s))}}var i=this,a=l(O,\"\"),s=k[a];\"boolean\"!=typeof s?r(function(e,n){e?(k[a]=!1,v.explainError(e.status,\"PouchDB is just detecting if the remote supports the _bulk_get API.\"),o()):(k[a]=!0,t(null,n))}):s?r(t):o()}),S._info=function(e){h().then(function(){n({},{method:\"GET\",url:f(O,\"\")},function(t,n){if(t)return e(t);n.host=f(O,\"\"),e(null,n)})}).catch(e)},S.get=u(\"get\",function(e,t,n){function i(e){function n(n){var o=i[n],s=a(e._id)+\"/\"+E(n)+\"?rev=\"+e._rev;return r(t,{method:\"GET\",url:f(O,s),binary:!0}).then(function(e){return t.binary?e:new p(function(t){m.blobOrBufferToBase64(e,t)})}).then(function(e){delete o.stub,delete o.length,o.data=e})}var i=e._attachments,s=i&&Object.keys(i);if(i&&s.length){return o(s.map(function(e){return function(){return n(e)}}),5)}}function s(e){return Array.isArray(e)?p.all(e.map(function(e){if(e.ok)return i(e.ok)})):i(e)}\"function\"==typeof t&&(n=t,t={}),t=v.clone(t);var u={};t.revs&&(u.revs=!0),t.revs_info&&(u.revs_info=!0),t.latest&&(u.latest=!0),t.open_revs&&(\"all\"!==t.open_revs&&(t.open_revs=JSON.stringify(t.open_revs)),u.open_revs=t.open_revs),t.rev&&(u.rev=t.rev),t.conflicts&&(u.conflicts=t.conflicts),e=a(e);var c={method:\"GET\",url:f(O,e+d(u))};r(t,c).then(function(e){return p.resolve().then(function(){if(t.attachments)return s(e)}).then(function(){n(null,e)})}).catch(n)}),S.remove=u(\"remove\",function(e,t,r,o){var i;\"string\"==typeof t?(i={_id:e,_rev:t},\"function\"==typeof r&&(o=r,r={})):(i=e,\"function\"==typeof t?(o=t,r={}):(o=r,r=t));var s=i._rev||r.rev;n(r,{method:\"DELETE\",url:f(O,a(i._id))+\"?rev=\"+s},o)}),S.getAttachment=u(\"getAttachment\",function(e,t,r,o){\"function\"==typeof r&&(o=r,r={});var i=r.rev?\"?rev=\"+r.rev:\"\";n(r,{method:\"GET\",url:f(O,a(e))+\"/\"+E(t)+i,binary:!0},o)}),S.removeAttachment=u(\"removeAttachment\",function(e,t,r,o){n({},{method:\"DELETE\",url:f(O,a(e)+\"/\"+E(t))+\"?rev=\"+r},o)}),S.putAttachment=u(\"putAttachment\",function(e,t,r,o,i,s){\"function\"==typeof i&&(s=i,i=o,o=r,r=null);var u=a(e)+\"/\"+E(t),c=f(O,u);if(r&&(c+=\"?rev=\"+r),\"string\"==typeof o){var l;try{l=m.atob(o)}catch(e){return s(_.createError(_.BAD_ARG,\"Attachment is not a valid base64 string\"))}o=l?m.binaryStringToBlobOrBuffer(l,i):\"\"}n({},{headers:{\"Content-Type\":i},method:\"PUT\",url:c,processData:!1,body:o,timeout:j.timeout||6e4},s)}),S._bulkDocs=function(e,t,r){e.new_edits=t.new_edits,h().then(function(){return p.all(e.docs.map(s))}).then(function(){n(t,{method:\"POST\",url:f(O,\"_bulk_docs\"),timeout:t.timeout,body:e},function(e,t){if(e)return r(e);t.forEach(function(e){e.ok=!0}),r(null,t)})}).catch(r)},S._put=function(e,t,r){h().then(function(){return s(e)}).then(function(){n(t,{method:\"PUT\",url:f(O,a(e._id)),body:e},function(e,t){if(e)return r(e);r(null,t)})}).catch(r)},S.allDocs=u(\"allDocs\",function(e,t){\"function\"==typeof e&&(t=e,e={}),e=v.clone(e);var n,o={},a=\"GET\";e.conflicts&&(o.conflicts=!0),e.descending&&(o.descending=!0),e.include_docs&&(o.include_docs=!0),e.attachments&&(o.attachments=!0),e.key&&(o.key=JSON.stringify(e.key)),e.start_key&&(e.startkey=e.start_key),e.startkey&&(o.startkey=JSON.stringify(e.startkey)),e.end_key&&(e.endkey=e.end_key),e.endkey&&(o.endkey=JSON.stringify(e.endkey)),void 0!==e.inclusive_end&&(o.inclusive_end=!!e.inclusive_end),void 0!==e.limit&&(o.limit=e.limit),void 0!==e.skip&&(o.skip=e.skip);var s=d(o);void 0!==e.keys&&(a=\"POST\",n={keys:e.keys}),r(e,{method:a,url:f(O,\"_all_docs\"+s),body:n}).then(function(n){e.include_docs&&e.attachments&&e.binary&&n.rows.forEach(i),t(null,n)}).catch(t)}),S._changes=function(e){var t=\"batch_size\"in e?e.batch_size:b;e=v.clone(e),e.timeout=\"timeout\"in e?e.timeout:\"timeout\"in j?j.timeout:3e4;var r,o=e.timeout?{timeout:e.timeout-5e3}:{},a=void 0!==e.limit&&e.limit;r=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var s=a;if(e.style&&(o.style=e.style),(e.include_docs||e.filter&&\"function\"==typeof e.filter)&&(o.include_docs=!0),e.attachments&&(o.attachments=!0),e.continuous&&(o.feed=\"longpoll\"),e.conflicts&&(o.conflicts=!0),e.descending&&(o.descending=!0),\"heartbeat\"in e?e.heartbeat&&(o.heartbeat=e.heartbeat):e.continuous&&(o.heartbeat=1e4),e.filter&&\"string\"==typeof e.filter&&(o.filter=e.filter),e.view&&\"string\"==typeof e.view&&(o.filter=\"_view\",o.view=e.view),e.query_params&&\"object\"==typeof e.query_params)for(var u in e.query_params)e.query_params.hasOwnProperty(u)&&(o[u]=e.query_params[u]);var c,l=\"GET\";e.doc_ids?(o.filter=\"_doc_ids\",l=\"POST\",c={doc_ids:e.doc_ids}):e.selector&&(o.filter=\"_selector\",l=\"POST\",c={selector:e.selector});var p,y,g=function(r,i){if(!e.aborted){o.since=r,\"object\"==typeof o.since&&(o.since=JSON.stringify(o.since)),e.descending?a&&(o.limit=s):o.limit=!a||s>t?t:s;var u={method:l,url:f(O,\"_changes\"+d(o)),timeout:e.timeout,body:c};y=r,e.aborted||h().then(function(){p=n(e,u,i)}).catch(i)}},m={results:[]},_=function(n,o){if(!e.aborted){var u=0;if(o&&o.results){u=o.results.length,m.last_seq=o.last_seq;({}).query=e.query_params,o.results=o.results.filter(function(t){s--;var n=v.filterChange(e)(t);return n&&(e.include_docs&&e.attachments&&e.binary&&i(t),r&&m.results.push(t),e.onChange(t)),n})}else if(n)return e.aborted=!0,void e.complete(n);o&&o.last_seq&&(y=o.last_seq);var c=a&&s<=0||o&&u<t||e.descending;(!e.continuous||a&&s<=0)&&c?e.complete(null,m):v.nextTick(function(){g(y,_)})}};return g(e.since||0,_),{cancel:function(){e.aborted=!0,p&&p.abort()}}},S.revsDiff=u(\"revsDiff\",function(e,t,r){\"function\"==typeof t&&(r=t,t={}),n(t,{method:\"POST\",url:f(O,\"_revs_diff\"),body:e},r)}),S._close=function(e){e()},S._destroy=function(e,t){n(e,{url:f(O,\"\"),method:\"DELETE\"},function(e,n){if(e&&e.status&&404!==e.status)return t(e);t(null,n)})}}var p=r(e(68)),v=e(72),y=r(e(19)),g=r(e(7)),m=e(20),_=e(30),b=25,w=50,k={};h.valid=function(){return!0};var E=function(e){e.adapter(\"http\",h,!1),e.adapter(\"https\",h,!1)};t.exports=E},{19:19,20:20,30:30,68:68,7:7,72:72}],17:[function(e,t,n){\"use strict\";function r(e){return function(t){var n=\"unknown_error\";t.target&&t.target.error&&(n=t.target.error.name||t.target.error.message),e(D.createError(D.IDB_ERROR,n,t.type))}}function o(e,t,n){return{data:B.safeJsonStringify(e),winningRev:t,deletedOrLocal:n?\"1\":\"0\",seq:e.seq,id:e.id}}function i(e){if(!e)return null;var t=B.safeJsonParse(e.data);return t.winningRev=e.winningRev,t.deleted=\"1\"===e.deletedOrLocal,t.seq=e.seq,t}function a(e){if(!e)return e;var t=e._doc_id_rev.lastIndexOf(\":\");return e._id=e._doc_id_rev.substring(0,t-1),e._rev=e._doc_id_rev.substring(t+1),delete e._doc_id_rev,e}function s(e,t,n,r){n?r(e?\"string\"!=typeof e?e:R.base64StringToBlobOrBuffer(e,t):R.blob([\"\"],{type:t})):e?\"string\"!=typeof e?R.readAsBinaryString(e,function(e){r(R.btoa(e))}):r(e):r(\"\")}function u(e,t,n,r){function o(){++s===a.length&&r&&r()}function i(e,t){var r=e._attachments[t],i=r.digest;n.objectStore(N).get(i).onsuccess=function(e){r.body=e.target.result.body,o()}}var a=Object.keys(e._attachments||{});if(!a.length)return r&&r();var s=0;a.forEach(function(n){t.attachments&&t.include_docs?i(e,n):(e._attachments[n].stub=!0,o())})}function c(e,t){return C.all(e.map(function(e){if(e.doc&&e.doc._attachments){var n=Object.keys(e.doc._attachments);return C.all(n.map(function(n){var r=e.doc._attachments[n];if(\"body\"in r){var o=r.body,i=r.content_type;return new C(function(a){s(o,i,t,function(t){e.doc._attachments[n]=x.assign(x.pick(r,[\"digest\",\"content_type\"]),{data:t}),a()})})}}))}}))}function f(e,t,n){function r(){--c||o()}function o(){i.length&&i.forEach(function(e){u.index(\"digestSeq\").count(IDBKeyRange.bound(e+\"::\",e+\"::￿\",!1,!1)).onsuccess=function(t){t.target.result||s.delete(e)}})}var i=[],a=n.objectStore(L),s=n.objectStore(N),u=n.objectStore(M),c=e.length;e.forEach(function(e){var n=a.index(\"_doc_id_rev\"),o=t+\"::\"+e;n.getKey(o).onsuccess=function(e){var t=e.target.result;if(\"number\"!=typeof t)return r();a.delete(t),u.index(\"seq\").openCursor(IDBKeyRange.only(t)).onsuccess=function(e){var t=e.target.result;if(t){var n=t.value.digestSeq.split(\"::\")[0];i.push(n),u.delete(t.primaryKey),t.continue()}else r()}}})}function l(e,t,n){try{return{txn:e.transaction(t,n)}}catch(e){return{error:e}}}function d(e,t,n,a,s,u){function c(){var e=[$,L,N,P,M,F],t=l(s,e,\"readwrite\");if(t.error)return u(t.error);S=t.txn,S.onabort=r(u),S.ontimeout=r(u),S.oncomplete=y,O=S.objectStore($),A=S.objectStore(L),x=S.objectStore(N),C=S.objectStore(M),B=S.objectStore(F),B.get(F).onsuccess=function(e){T=e.target.result,p()},m(function(e){if(e)return X=!0,u(e);v()})}function d(){V=!0,p()}function h(){q.processDocs(e.revs_limit,U,a,W,S,H,_,n,d)}function p(){T&&V&&(T.docCount+=Q,B.put(T))}function v(){function e(){++n===U.length&&h()}function t(t){var n=i(t.target.result);n&&W.set(n.id,n),e()}if(U.length)for(var n=0,r=0,o=U.length;r<o;r++){var a=U[r];if(a._id&&q.isLocalId(a._id))e();else{var s=O.get(a.metadata.id);s.onsuccess=t}}}function y(){X||(z.notify(a._meta.name),u(null,H))}function g(e,t){x.get(e).onsuccess=function(n){if(n.target.result)t();else{var r=D.createError(D.MISSING_STUB,\"unknown stub attachment with digest \"+e);r.status=412,t(r)}}}function m(e){function t(){++o===n.length&&e(r)}var n=[];if(U.forEach(function(e){e.data&&e.data._attachments&&Object.keys(e.data._attachments).forEach(function(t){var r=e.data._attachments[t];r.stub&&n.push(r.digest)})}),!n.length)return e();var r,o=0;n.forEach(function(e){g(e,function(e){e&&!r&&(r=e),t()})})}function _(e,t,n,r,o,i,a,s){e.metadata.winningRev=t,e.metadata.deleted=n;var u=e.data;if(u._id=e.metadata.id,u._rev=e.metadata.rev,r&&(u._deleted=!0),u._attachments&&Object.keys(u._attachments).length)return w(e,t,n,o,a,s);Q+=i,p(),b(e,t,n,o,a,s)}function b(e,t,n,r,i,s){function u(i){var s=e.stemmedRevs||[];r&&a.auto_compaction&&(s=s.concat(I.compactTree(e.metadata))),s&&s.length&&f(s,e.metadata.id,S),h.seq=i.target.result;var u=o(h,t,n);O.put(u).onsuccess=l}function c(e){e.preventDefault(),e.stopPropagation(),A.index(\"_doc_id_rev\").getKey(d._doc_id_rev).onsuccess=function(e){A.put(d,e.target.result).onsuccess=u}}function l(){H[i]={ok:!0,id:h.id,rev:h.rev},W.set(e.metadata.id,e.metadata),k(e,h.seq,s)}var d=e.data,h=e.metadata;d._doc_id_rev=h.id+\"::\"+h.rev,delete d._id,delete d._rev;var p=A.put(d);p.onsuccess=u,p.onerror=c}function w(e,t,n,r,o,i){function a(){c===f.length&&b(e,t,n,r,o,i)}function s(){c++,a()}var u=e.data,c=0,f=Object.keys(u._attachments);f.forEach(function(n){var r=e.data._attachments[n];if(r.stub)c++,a();else{var o=r.data;delete r.data,r.revpos=parseInt(t,10);E(r.digest,o,s)}})}function k(e,t,n){function r(){++o===i.length&&n()}var o=0,i=Object.keys(e.data._attachments||{});if(!i.length)return n();for(var a=0;a<i.length;a++)!function(n){var o=e.data._attachments[n].digest,i=C.put({seq:t,digestSeq:o+\"::\"+t});i.onsuccess=r,i.onerror=function(e){e.preventDefault(),e.stopPropagation(),r()}}(i[a])}function E(e,t,n){x.count(e).onsuccess=function(r){if(r.target.result)return n();var o={digest:e,body:t};x.put(o).onsuccess=n}}for(var S,O,A,x,C,B,R,T,U=t.docs,K=0,G=U.length;K<G;K++){var J=U[K];J._id&&q.isLocalId(J._id)||(J=U[K]=q.parseDoc(J,n.new_edits),J.error&&!R&&(R=J))}if(R)return u(R);var V=!1,Q=0,H=new Array(U.length),W=new j.Map,X=!1,Y=a._meta.blobSupport?\"blob\":\"base64\";q.preprocessAttachments(U,Y,function(e){if(e)return u(e);c()})}function h(e,t,n,r,o){function i(e){f=e.target.result,c&&o(c,f,l)}function a(e){c=e.target.result,f&&o(c,f,l)}function s(){if(!c.length)return o();var n,s=c[c.length-1];if(t&&t.upper)try{n=IDBKeyRange.bound(s,t.upper,!0,t.upperOpen)}catch(e){if(\"DataError\"===e.name&&0===e.code)return o()}else n=IDBKeyRange.lowerBound(s,!0);t=n,c=null,f=null,e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=a}function u(e){var t=e.target.result;if(!t)return o();o([t.key],[t.value],t)}var c,f,l,d=\"function\"==typeof e.getAll&&\"function\"==typeof e.getAllKeys&&r>1&&!n;d?(l={continue:s},e.getAll(t,r).onsuccess=i,e.getAllKeys(t,r).onsuccess=a):n?e.openCursor(t,\"prev\").onsuccess=u:e.openCursor(t).onsuccess=u}function p(e,t,n){function r(e){var t=e.target.result;t?(o.push(t.value),t.continue()):n({target:{result:o}})}if(\"function\"==typeof e.getAll)return void(e.getAll(t).onsuccess=n);var o=[];e.openCursor(t).onsuccess=r}function v(e,t,n,r,o){try{if(e&&t)return o?IDBKeyRange.bound(t,e,!n,!1):IDBKeyRange.bound(e,t,!1,!n);if(e)return o?IDBKeyRange.upperBound(e):IDBKeyRange.lowerBound(e);if(t)return o?IDBKeyRange.lowerBound(t,!n):IDBKeyRange.upperBound(t,!n);if(r)return IDBKeyRange.only(r)}catch(e){return{error:e}}return null}function y(e,t,n){function o(t,n,r){var o=t.id+\"::\"+r;M.get(o).onsuccess=function(r){if(n.doc=a(r.target.result),e.conflicts){var o=I.collectConflicts(t);o.length&&(n.doc._conflicts=o)}u(n.doc,e,q)}}function s(t,n){var r={id:n.id,key:n.id,value:{rev:t}},i=n.deleted;\"ok\"===e.deleted?(P.push(r),i?(r.value.deleted=!0,r.doc=null):e.include_docs&&o(n,r,t)):!i&&k--<=0&&(P.push(r),e.include_docs&&o(n,r,t))}function f(e){for(var t=0,n=e.length;t<n&&P.length!==E;t++){var r=e[t],o=i(r);s(o.winningRev,o)}}function d(e,t,n){n&&(f(t),P.length<E&&n.continue())}function y(t){var n=t.target.result;e.descending&&(n=n.reverse()),f(n)}function g(){n(null,{total_rows:C,offset:e.skip,rows:P})}function m(){e.attachments?c(P,e.binary).then(g):g()}var _=\"startkey\"in e&&e.startkey,b=\"endkey\"in e&&e.endkey,w=\"key\"in e&&e.key,k=e.skip||0,E=\"number\"==typeof e.limit?e.limit:-1,S=!1!==e.inclusive_end,O=v(_,b,S,w,e.descending),A=O&&O.error;if(A&&(\"DataError\"!==A.name||0!==A.code))return n(D.createError(D.IDB_ERROR,A.name,A.message));var j=[$,L,F];e.attachments&&j.push(N);var x=l(t,j,\"readonly\");if(x.error)return n(x.error);var q=x.txn;q.oncomplete=m,q.onabort=r(n);var C,B=q.objectStore($),R=q.objectStore(L),T=q.objectStore(F),M=R.index(\"_doc_id_rev\"),P=[];return T.get(F).onsuccess=function(e){C=e.target.result.docCount},A||0===E?void 0:-1===E?p(B,O,y):void h(B,O,e.descending,E+k,d)}function g(e){return new C(function(t){var n=R.blob([\"\"]);e.objectStore(U).put(n,\"key\").onsuccess=function(){var e=navigator.userAgent.match(/Chrome\\/(\\d+)/),n=navigator.userAgent.match(/Edge\\//);t(n||!e||parseInt(e[1],10)>=43)},e.onabort=function(e){e.preventDefault(),e.stopPropagation(),t(!1)}}).catch(function(){return!1})}function m(e,t){e.objectStore($).index(\"deletedOrLocal\").count(IDBKeyRange.only(\"0\")).onsuccess=function(e){t(e.target.result)}}function _(e,t,n,r){try{e(t,n)}catch(t){r.emit(\"error\",t)}}function b(){!K&&G.length&&(K=!0,G.shift()())}function w(e,t,n){G.push(function(){e(function(e,r){_(t,e,r,n),K=!1,x.nextTick(function(){b(n)})})}),b()}function k(e,t,n,o){function s(t,n,r){function o(t,n){var r=e.processChange(n,t,e);m=r.seq=t.seq;var o=I(r);if(\"object\"==typeof o)return e.complete(o);o&&(A++,b&&O.push(r),e.attachments&&e.include_docs?u(n,e,w,function(){c([r],e.binary).then(function(){e.onChange(r)})}):e.onChange(r))}function i(){for(var e=0,t=s.length;e<t&&A!==_;e++){var n=s[e];if(n){o(f[e],n)}}A!==_&&r.continue()}if(r&&t.length){var s=new Array(t.length),f=new Array(t.length),l=0;n.forEach(function(e,n){d(a(e),t[n],function(e,r){f[n]=e,s[n]=r,++l===t.length&&i()})})}}function f(e,t,n,r){if(n.seq!==t)return r();if(n.winningRev===e._rev)return r(n,e);var o=e._id+\"::\"+n.winningRev;S.get(o).onsuccess=function(e){r(n,a(e.target.result))}}function d(e,t,n){if(g&&!g.has(e._id))return n();var r=D.get(e._id);if(r)return f(e,t,r,n);E.get(e._id).onsuccess=function(o){r=i(o.target.result),D.set(e._id,r),f(e,t,r,n)}}function p(){e.complete(null,{results:O,last_seq:m})}function v(){!e.continuous&&e.attachments?c(O).then(p):p()}if(e=x.clone(e),e.continuous){var y=n+\":\"+x.uuid();return z.addListener(n,y,t,e),z.notify(n),{cancel:function(){z.removeListener(n,y)}}}var g=e.doc_ids&&new j.Set(e.doc_ids);e.since=e.since||0;var m=e.since,_=\"limit\"in e?e.limit:-1;0===_&&(_=1);var b;b=\"return_docs\"in e?e.return_docs:!(\"returnDocs\"in e)||e.returnDocs;var w,k,E,S,O=[],A=0,I=x.filterChange(e),D=new j.Map,q=[$,L];e.attachments&&q.push(N);var C=l(o,q,\"readonly\");if(C.error)return e.complete(C.error);w=C.txn,w.onabort=r(e.complete),w.oncomplete=v,k=w.objectStore(L),E=w.objectStore($),S=k.index(\"_doc_id_rev\"),h(k,e.since&&!e.descending?IDBKeyRange.lowerBound(e.since,!0):null,e.descending,_,s)}function E(e,t){var n=this;w(function(t){S(n,e,t)},t,n.constructor)}function S(e,t,n){function u(e){var t=e.createObjectStore($,{keyPath:\"id\"});e.createObjectStore(L,{autoIncrement:!0}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0}),e.createObjectStore(N,{keyPath:\"digest\"}),e.createObjectStore(F,{keyPath:\"id\",autoIncrement:!1}),e.createObjectStore(U),t.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),e.createObjectStore(P,{keyPath:\"_id\"});var n=e.createObjectStore(M,{autoIncrement:!0});n.createIndex(\"seq\",\"seq\"),n.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function c(e,t){var n=e.objectStore($);n.createIndex(\"deletedOrLocal\",\"deletedOrLocal\",{unique:!1}),n.openCursor().onsuccess=function(e){var r=e.target.result;if(r){var o=r.value,i=I.isDeleted(o);o.deletedOrLocal=i?\"1\":\"0\",n.put(o),r.continue()}else t()}}function h(e){e.createObjectStore(P,{keyPath:\"_id\"}).createIndex(\"_doc_id_rev\",\"_doc_id_rev\",{unique:!0})}function p(e,t){var n=e.objectStore(P),r=e.objectStore($),o=e.objectStore(L);r.openCursor().onsuccess=function(e){var i=e.target.result;if(i){var a=i.value,s=a.id,u=I.isLocalId(s),c=I.winningRev(a);if(u){var f=s+\"::\"+c,l=s+\"::\",d=s+\"::~\",h=o.index(\"_doc_id_rev\"),p=IDBKeyRange.bound(l,d,!1,!1),v=h.openCursor(p);v.onsuccess=function(e){if(v=e.target.result){var t=v.value;t._doc_id_rev===f&&n.put(t),o.delete(v.primaryKey),v.continue()}else r.delete(i.primaryKey),i.continue()}}else i.continue()}else t&&t()}}function v(e){var t=e.createObjectStore(M,{autoIncrement:!0});t.createIndex(\"seq\",\"seq\"),t.createIndex(\"digestSeq\",\"digestSeq\",{unique:!0})}function _(e,t){var n=e.objectStore(L),r=e.objectStore(N),o=e.objectStore(M);r.count().onsuccess=function(e){if(!e.target.result)return t();n.openCursor().onsuccess=function(e){var n=e.target.result;if(!n)return t();for(var r=n.value,i=n.primaryKey,a=Object.keys(r._attachments||{}),s={},u=0;u<a.length;u++)s[r._attachments[a[u]].digest]=!0;var c=Object.keys(s);for(u=0;u<c.length;u++){var f=c[u];o.put({seq:i,digestSeq:f+\"::\"+i})}n.continue()}}}function b(e){function t(e){return e.data?i(e):(e.deleted=\"1\"===e.deletedOrLocal,e)}var n=e.objectStore(L),r=e.objectStore($);r.openCursor().onsuccess=function(e){function i(){var e=o(s,s.winningRev,s.deleted);r.put(e).onsuccess=function(){a.continue()}}var a=e.target.result;if(a){var s=t(a.value);if(s.winningRev=s.winningRev||I.winningRev(s),s.seq)return i();!function(){var e=s.id+\"::\",t=s.id+\"::￿\",r=n.index(\"_doc_id_rev\").openCursor(IDBKeyRange.bound(e,t)),o=0;r.onsuccess=function(e){var t=e.target.result;if(!t)return s.seq=o,i();var n=t.primaryKey;n>o&&(o=n),t.continue()}}()}}}var w=t.name,E=null;e._meta=null,e._remote=!1,e.type=function(){return\"idb\"},e._id=x.toPromise(function(t){t(null,e._meta.instanceId)}),e._bulkDocs=function(n,r,o){d(t,n,r,e,E,o)},e._get=function(e,t,n){function r(){n(u,{doc:o,metadata:s,ctx:c})}var o,s,u,c=t.ctx;if(!c){var f=l(E,[$,L,N],\"readonly\");if(f.error)return n(f.error);c=f.txn}c.objectStore($).get(e).onsuccess=function(e){if(!(s=i(e.target.result)))return u=D.createError(D.MISSING_DOC,\"missing\"),r();var n;if(t.rev)n=t.latest?I.latest(t.rev,s):t.rev;else{n=s.winningRev;if(I.isDeleted(s))return u=D.createError(D.MISSING_DOC,\"deleted\"),r()}var f=c.objectStore(L),l=s.id+\"::\"+n;f.index(\"_doc_id_rev\").get(l).onsuccess=function(e){if(o=e.target.result,o&&(o=a(o)),!o)return u=D.createError(D.MISSING_DOC,\"missing\"),r();r()}}},e._getAttachment=function(e,t,n,r,o){var i;if(r.ctx)i=r.ctx;else{var a=l(E,[$,L,N],\"readonly\");if(a.error)return o(a.error);i=a.txn}var u=n.digest,c=n.content_type;i.objectStore(N).get(u).onsuccess=function(e){s(e.target.result.body,c,r.binary,function(e){o(null,e)})}},e._info=function(t){var n,r,o=l(E,[F,L],\"readonly\");if(o.error)return t(o.error);var i=o.txn;i.objectStore(F).get(F).onsuccess=function(e){r=e.target.result.docCount},i.objectStore(L).openCursor(null,\"prev\").onsuccess=function(e){var t=e.target.result;n=t?t.key:0},i.oncomplete=function(){t(null,{doc_count:r,update_seq:n,idb_attachment_format:e._meta.blobSupport?\"binary\":\"base64\"})}},e._allDocs=function(e,t){y(e,E,t)},e._changes=function(t){k(t,e,w,E)},e._close=function(e){E.close(),J.delete(w),e()},e._getRevisionTree=function(e,t){var n=l(E,[$],\"readonly\");if(n.error)return t(n.error);n.txn.objectStore($).get(e).onsuccess=function(e){var n=i(e.target.result);n?t(null,n.rev_tree):t(D.createError(D.MISSING_DOC))}},e._doCompaction=function(e,t,n){var a=[$,L,N,M],s=l(E,a,\"readwrite\");if(s.error)return n(s.error);var u=s.txn;u.objectStore($).get(e).onsuccess=function(n){var r=i(n.target.result);I.traverseRevTree(r.rev_tree,function(e,n,r,o,i){var a=n+\"-\"+r;-1!==t.indexOf(a)&&(i.status=\"missing\")}),f(t,e,u);var a=r.winningRev,s=r.deleted;u.objectStore($).put(o(r,a,s))},u.onabort=r(n),u.oncomplete=function(){n()}},e._getLocal=function(e,t){var n=l(E,[P],\"readonly\");if(n.error)return t(n.error);var o=n.txn,i=o.objectStore(P).get(e);i.onerror=r(t),i.onsuccess=function(e){var n=e.target.result;n?(delete n._doc_id_rev,t(null,n)):t(D.createError(D.MISSING_DOC))}},e._putLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={}),delete e._revisions;var o=e._rev,i=e._id;e._rev=o?\"0-\"+(parseInt(o.split(\"-\")[1],10)+1):\"0-1\";var a,s=t.ctx;if(!s){var u=l(E,[P],\"readwrite\");if(u.error)return n(u.error);s=u.txn,s.onerror=r(n),s.oncomplete=function(){a&&n(null,a)}}var c,f=s.objectStore(P);o?(c=f.get(i),c.onsuccess=function(r){var i=r.target.result;if(i&&i._rev===o){f.put(e).onsuccess=function(){a={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,a)}}else n(D.createError(D.REV_CONFLICT))}):(c=f.add(e),c.onerror=function(e){n(D.createError(D.REV_CONFLICT)),e.preventDefault(),e.stopPropagation()},c.onsuccess=function(){a={ok:!0,id:e._id,rev:e._rev},t.ctx&&n(null,a)})},e._removeLocal=function(e,t,n){\"function\"==typeof t&&(n=t,t={});var o=t.ctx;if(!o){var i=l(E,[P],\"readwrite\");if(i.error)return n(i.error);o=i.txn,o.oncomplete=function(){a&&n(null,a)}}var a,s=e._id,u=o.objectStore(P),c=u.get(s);c.onerror=r(n),c.onsuccess=function(r){var o=r.target.result;o&&o._rev===e._rev?(u.delete(s),a={ok:!0,id:s,rev:\"0-0\"},t.ctx&&n(null,a)):n(D.createError(D.MISSING_DOC))}},e._destroy=function(e,t){z.removeAllListeners(w);var n=V.get(w);n&&n.result&&(n.result.close(),J.delete(w));var o=indexedDB.deleteDatabase(w);o.onsuccess=function(){V.delete(w),x.hasLocalStorage()&&w in localStorage&&delete localStorage[w],t(null,{ok:!0})},o.onerror=r(t)};var S=J.get(w);if(S)return E=S.idb,e._meta=S.global,x.nextTick(function(){n(null,e)});var j;j=t.storage?O(w,t.storage):indexedDB.open(w,T),V.set(w,j),j.onupgradeneeded=function(e){function t(){var e=o[i-1];i++,e&&e(r,t)}var n=e.target.result;if(e.oldVersion<1)return u(n);var r=e.currentTarget.transaction;e.oldVersion<3&&h(n),e.oldVersion<4&&v(n);var o=[c,p,_,b],i=e.oldVersion;t()},j.onsuccess=function(t){function r(){void 0!==s&&f&&(e._meta={name:w,instanceId:u,blobSupport:s},J.set(w,{idb:E,global:e._meta}),n(null,e))}function o(){if(void 0!==a&&void 0!==i){var e=w+\"_id\";e in i?u=i[e]:i[e]=u=x.uuid(),i.docCount=a,c.objectStore(F).put(i)}}E=t.target.result,E.onversionchange=function(){E.close(),J.delete(w)},E.onabort=function(e){x.guardedConsole(\"error\",\"Database has a global failure\",e.target.error),E.close(),J.delete(w)};var i,a,s,u,c=E.transaction([F,U,$],\"readwrite\"),f=!1;c.objectStore(F).get(F).onsuccess=function(e){i=e.target.result||{id:F},o()},m(c,function(e){a=e,o()}),A||(A=g(c)),A.then(function(e){s=e,r()}),c.oncomplete=function(){f=!0,r()}},j.onerror=function(){var e=\"Failed to open indexedDB, are you in private browsing mode?\";x.guardedConsole(\"error\",e),n(D.createError(D.IDB_ERROR,e))}}function O(e,t){try{return indexedDB.open(e,{version:T,storage:t})}catch(t){return indexedDB.open(e,T)}}var A,j=e(24),x=e(72),I=e(67),D=e(30),q=e(18),C=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(68)),B=e(44),R=e(20),T=5,$=\"document-store\",L=\"by-sequence\",N=\"attach-store\",M=\"attach-seq-store\",F=\"meta-store\",P=\"local-store\",U=\"detect-blob-support\",z=new x.changesHandler,K=!1,G=[],J=new j.Map,V=new j.Map;E.valid=function(){return!(\"undefined\"!=typeof openDatabase&&/(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)&&!/BlackBerry/.test(navigator.platform))&&\"undefined\"!=typeof indexedDB&&\"undefined\"!=typeof IDBKeyRange};var Q=function(e){e.adapter(\"idb\",E,!0)};t.exports=Q},{18:18,20:20,24:24,30:30,44:44,67:67,68:68,72:72}],18:[function(e,t,n){\"use strict\";function r(e){return e.reduce(function(e,t){return e[t]=!0,e},{})}function o(e){if(!/^\\d+\\-./.test(e))return y.createError(y.INVALID_REV);var t=e.indexOf(\"-\"),n=e.substring(0,t),r=e.substring(t+1);return{prefix:parseInt(n,10),id:r}}function i(e,t){for(var n=e.start-e.ids.length+1,r=e.ids,o=[r[0],t,[]],i=1,a=r.length;i<a;i++)o=[r[i],{status:\"missing\"},[o]];return[{pos:n,ids:o}]}function a(e,t){var n,r,a,s={status:\"available\"};if(e._deleted&&(s.deleted=!0),t)if(e._id||(e._id=v.uuid()),r=v.uuid(32,16).toLowerCase(),e._rev){if(a=o(e._rev),a.error)return a;e._rev_tree=[{pos:a.prefix,ids:[a.id,{status:\"missing\"},[[r,s,[]]]]}],n=a.prefix+1}else e._rev_tree=[{pos:1,ids:[r,s,[]]}],n=1;else if(e._revisions&&(e._rev_tree=i(e._revisions,s),n=e._revisions.start,r=e._revisions.ids[0]),!e._rev_tree){if(a=o(e._rev),a.error)return a;n=a.prefix,r=a.id,e._rev_tree=[{pos:n,ids:[r,s,[]]}]}v.invalidIdError(e._id),e._rev=n+\"-\"+r;var u={metadata:{},data:{}};for(var c in e)if(Object.prototype.hasOwnProperty.call(e,c)){var f=\"_\"===c[0];if(f&&!w[c]){var l=y.createError(y.DOC_VALIDATION,c);throw l.message=y.DOC_VALIDATION.message+\": \"+c,l}f&&!k[c]?u.metadata[c.slice(1)]=e[c]:u.data[c]=e[c]}return u}function s(e){try{return m.atob(e)}catch(e){var t=y.createError(y.BAD_ARG,\"Attachment is not a valid base64 string\");return{error:t}}}function u(e,t,n){var r=s(e.data);if(r.error)return n(r.error);e.length=r.length,e.data=\"blob\"===t?m.binaryStringToBlobOrBuffer(r,e.content_type):\"base64\"===t?m.btoa(r):r,_.binaryMd5(r,function(t){e.digest=\"md5-\"+t,n()})}function c(e,t,n){_.binaryMd5(e.data,function(r){e.digest=\"md5-\"+r,e.length=e.data.size||e.data.length||0,\"binary\"===t?m.blobOrBufferToBinaryString(e.data,function(t){e.data=t,n()}):\"base64\"===t?m.blobOrBufferToBase64(e.data,function(t){e.data=t,n()}):n()})}function f(e,t,n){if(e.stub)return n();\"string\"==typeof e.data?u(e,t,n):c(e,t,n)}function l(e,t,n){function r(){i++,e.length===i&&(o?n(o):n())}if(!e.length)return n();var o,i=0;e.forEach(function(e){function n(e){o=e,++a===i.length&&r()}var i=e.data&&e.data._attachments?Object.keys(e.data._attachments):[],a=0;if(!i.length)return r();for(var s in e.data._attachments)e.data._attachments.hasOwnProperty(s)&&f(e.data._attachments[s],t,n)})}function d(e,t,n,r,o,i,s,u){if(g.revExists(t.rev_tree,n.metadata.rev))return r[o]=n,i();var c=t.winningRev||g.winningRev(t),f=\"deleted\"in t?t.deleted:g.isDeleted(t,c),l=\"deleted\"in n.metadata?n.metadata.deleted:g.isDeleted(n.metadata),d=/^1-/.test(n.metadata.rev);if(f&&!l&&u&&d){var h=n.data;h._rev=c,h._id=n.metadata.id,n=a(h,u)}var p=g.merge(t.rev_tree,n.metadata.rev_tree[0],e);if(u&&(f&&l&&\"new_leaf\"!==p.conflicts||!f&&\"new_leaf\"!==p.conflicts||f&&!l&&\"new_branch\"===p.conflicts)){var v=y.createError(y.REV_CONFLICT);return r[o]=v,i()}var m=n.metadata.rev;n.metadata.rev_tree=p.tree,n.stemmedRevs=p.stemmedRevs||[],t.rev_map&&(n.metadata.rev_map=t.rev_map);var _,b=g.winningRev(n.metadata),w=g.isDeleted(n.metadata,b),k=f===w?0:f<w?-1:1;_=m===b?w:g.isDeleted(n.metadata,m),s(n,b,w,_,!0,k,o,i)}function h(e){return\"missing\"===e.metadata.rev_tree[0].ids[1].status}function p(e,t,n,r,o,i,a,s,u){function c(e,t,n){var r=g.winningRev(e.metadata),o=g.isDeleted(e.metadata,r);if(\"was_delete\"in s&&o)return i[t]=y.createError(y.MISSING_DOC,\"deleted\"),n();if(l&&h(e)){var u=y.createError(y.REV_CONFLICT);return i[t]=u,n()}a(e,r,o,o,!1,o?0:1,t,n)}function f(){++v===m&&u&&u()}e=e||1e3;var l=s.new_edits,p=new b.Map,v=0,m=t.length;t.forEach(function(e,t){if(e._id&&g.isLocalId(e._id)){var r=e._deleted?\"_removeLocal\":\"_putLocal\";return void n[r](e,{ctx:o},function(e,n){i[t]=e||n,f()})}var a=e.metadata.id;p.has(a)?(m--,p.get(a).push([e,t])):p.set(a,[[e,t]])}),p.forEach(function(t,n){function o(){++u<t.length?s():f()}function s(){var s=t[u],f=s[0],h=s[1];if(r.has(n))d(e,r.get(n),f,i,h,o,a,l);else{var p=g.merge([],f.metadata.rev_tree[0],e);f.metadata.rev_tree=p.tree,f.stemmedRevs=p.stemmedRevs||[],c(f,h,o)}}var u=0;s()})}Object.defineProperty(n,\"__esModule\",{value:!0});var v=e(72),y=e(30),g=e(67),m=e(20),_=e(66),b=e(24),w=r([\"_id\",\"_rev\",\"_attachments\",\"_deleted\",\"_revisions\",\"_revs_info\",\"_conflicts\",\"_deleted_conflicts\",\"_local_seq\",\"_rev_tree\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\",\"_removed\"]),k=r([\"_attachments\",\"_replication_id\",\"_replication_state\",\"_replication_state_time\",\"_replication_state_reason\",\"_replication_stats\"]);n.invalidIdError=v.invalidIdError,n.isDeleted=g.isDeleted,n.isLocalId=g.isLocalId,n.normalizeDdocFunctionName=v.normalizeDdocFunctionName,n.parseDdocFunctionName=v.parseDdocFunctionName,n.parseDoc=a,n.preprocessAttachments=l,n.processDocs=p,n.updateDoc=d},{20:20,24:24,30:30,66:66,67:67,72:72}],19:[function(e,t,n){\"use strict\";function r(){for(var e={},t=new l(function(t,n){e.resolve=t,e.reject=n}),n=new Array(arguments.length),r=0;r<n.length;r++)n[r]=arguments[r];return e.promise=t,l.resolve().then(function(){return fetch.apply(null,n)}).then(function(t){e.resolve(t)}).catch(function(t){e.reject(t)}),e}function o(e,t){var n,o,i,a=new Headers,s={method:e.method,credentials:\"include\",headers:a};return e.json&&(a.set(\"Accept\",\"application/json\"),a.set(\"Content-Type\",e.headers[\"Content-Type\"]||\"application/json\")),e.body&&e.processData&&\"string\"!=typeof e.body?s.body=JSON.stringify(e.body):s.body=\"body\"in e?e.body:null,Object.keys(e.headers).forEach(function(t){e.headers.hasOwnProperty(t)&&a.set(t,e.headers[t])}),n=r(e.url,s),e.timeout>0&&(o=setTimeout(function(){n.reject(new Error(\"Load timeout for resource: \"+e.url))},e.timeout)),n.promise.then(function(t){return i={statusCode:t.status},e.timeout>0&&clearTimeout(o),i.statusCode>=200&&i.statusCode<300?e.binary?t.blob():t.text():t.json()}).then(function(e){i.statusCode>=200&&i.statusCode<300?t(null,i,e):(e.status=i.statusCode,t(e))}).catch(function(e){e||(e=new Error(\"canceled\")),t(e)}),{abort:n.reject}}function i(e,t){var n,r,o=!1,i=function(){n.abort(),u()},a=function(){o=!0,n.abort(),u()},s={abort:i},u=function(){clearTimeout(r),s.abort=function(){},n&&(n.onprogress=void 0,n.upload&&(n.upload.onprogress=void 0),n.onreadystatechange=void 0,n=void 0)};n=e.xhr?new e.xhr:new XMLHttpRequest;try{n.open(e.method,e.url)}catch(e){return t(new Error(e.name||\"Url is invalid\"))}n.withCredentials=!(\"withCredentials\"in e)||e.withCredentials,\"GET\"===e.method?delete e.headers[\"Content-Type\"]:e.json&&(e.headers.Accept=\"application/json\",e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\",e.body&&e.processData&&\"string\"!=typeof e.body&&(e.body=JSON.stringify(e.body))),e.binary&&(n.responseType=\"arraybuffer\"),\"body\"in e||(e.body=null);for(var c in e.headers)e.headers.hasOwnProperty(c)&&n.setRequestHeader(c,e.headers[c])\n;return e.timeout>0&&(r=setTimeout(a,e.timeout),n.onprogress=function(){clearTimeout(r),4!==n.readyState&&(r=setTimeout(a,e.timeout))},void 0!==n.upload&&(n.upload.onprogress=n.onprogress)),n.onreadystatechange=function(){if(4===n.readyState){var r={statusCode:n.status};if(n.status>=200&&n.status<300){var i;i=e.binary?d.blob([n.response||\"\"],{type:n.getResponseHeader(\"Content-Type\")}):n.responseText,t(null,r,i)}else{var a={};if(o)a=new Error(\"ETIMEDOUT\"),a.code=\"ETIMEDOUT\";else if(\"string\"==typeof n.response)try{a=JSON.parse(n.response)}catch(e){}a.status=n.status,t(a)}u()}},e.body&&e.body instanceof Blob?d.readAsArrayBuffer(e.body,function(e){n.send(e)}):n.send(e.body),s}function a(e,t){return p||e.xhr?i(e,t):o(e,t)}function s(){return\"\"}function u(e,t){function n(t,n,r){if(!e.binary&&e.json&&\"string\"==typeof t)try{t=JSON.parse(t)}catch(e){return r(e)}Array.isArray(t)&&(t=t.map(function(e){return e.error||e.missing?h.generateErrorFromResponse(e):e})),e.binary&&v(t,n),r(null,t,n)}e=f.clone(e);var r={method:\"GET\",headers:{},json:!0,processData:!0,timeout:1e4,cache:!1};return e=f.assign(r,e),e.json&&(e.binary||(e.headers.Accept=\"application/json\"),e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\"),e.binary&&(e.encoding=null,e.json=!1),e.processData||(e.json=!1),a(e,function(r,o,i){if(r)return t(h.generateErrorFromResponse(r));var a,u=o.headers&&o.headers[\"content-type\"],c=i||s();if(!e.binary&&(e.json||!e.processData)&&\"object\"!=typeof c&&(/json/.test(u)||/^[\\s]*\\{/.test(c)&&/\\}[\\s]*$/.test(c)))try{c=JSON.parse(c.toString())}catch(e){}o.statusCode>=200&&o.statusCode<300?n(c,o,t):(a=h.generateErrorFromResponse(c),a.status=o.statusCode,t(a))})}function c(e,t){var n=navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",r=-1!==n.indexOf(\"safari\")&&-1===n.indexOf(\"chrome\"),o=-1!==n.indexOf(\"msie\"),i=-1!==n.indexOf(\"edge\"),a=r||(o||i)&&\"GET\"===e.method,s=!(\"cache\"in e)||e.cache;if(!/^blob:/.test(e.url)&&(a||!s)){var c=-1!==e.url.indexOf(\"?\");e.url+=(c?\"&\":\"?\")+\"_nonce=\"+Date.now()}return u(e,t)}var f=e(72),l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(68)),d=e(20),h=e(30),p=function(){try{return new XMLHttpRequest,!0}catch(e){return!1}}(),v=function(){};t.exports=c},{20:20,30:30,68:68,72:72}],20:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function a(e,t){return i(h(e),t)}function s(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function u(e,t){if(\"undefined\"==typeof FileReader)return t(s((new FileReaderSync).readAsArrayBuffer(e)));var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";if(r)return t(n);t(s(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}function f(e,t){c(e,function(e){t(p(e))})}function l(e,t){if(\"undefined\"==typeof FileReader)return t((new FileReaderSync).readAsArrayBuffer(e));var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=a,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=l,n.readAsBinaryString=u,n.typedBuffer=d},{}],21:[function(e,t,n){\"use strict\";function r(e){return l.scopeEval('\"use strict\";\\nreturn '+e+\";\",{})}function o(e){var t=[\"return function(doc) {\",'  \"use strict\";',\"  var emitted = false;\",\"  var emit = function (a, b) {\",\"    emitted = true;\",\"  };\",\"  var view = \"+e+\";\",\"  view(doc);\",\"  if (emitted) {\",\"    return true;\",\"  }\",\"};\"].join(\"\\n\");return l.scopeEval(t,{})}function i(e,t){if(e.selector&&e.filter&&\"_selector\"!==e.filter){var n=\"string\"==typeof e.filter?e.filter:\"function\";return t(new Error('selector invalid for filter \"'+n+'\"'))}t()}function a(e){e.view&&!e.filter&&(e.filter=\"_view\"),e.selector&&!e.filter&&(e.filter=\"_selector\"),e.filter&&\"string\"==typeof e.filter&&(\"_view\"===e.filter?e.view=l.normalizeDdocFunctionName(e.view):e.filter=l.normalizeDdocFunctionName(e.filter))}function s(e,t){return t.filter&&\"string\"==typeof t.filter&&!t.doc_ids&&!l.isRemote(e.db)}function u(e,t){var n=t.complete;if(\"_view\"===t.filter){if(!t.view||\"string\"!=typeof t.view){var i=f.createError(f.BAD_REQUEST,\"`view` filter parameter not found or invalid.\");return n(i)}var a=l.parseDdocFunctionName(t.view);e.db.get(\"_design/\"+a[0],function(r,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(r)return n(f.generateErrorFromResponse(r));var s=i&&i.views&&i.views[a[1]]&&i.views[a[1]].map;if(!s)return n(f.createError(f.MISSING_DOC,i.views?\"missing json key: \"+a[1]:\"missing json key: views\"));t.filter=o(s),e.doChanges(t)})}else if(t.selector)t.filter=function(e){return d.matchesSelector(e,t.selector)},e.doChanges(t);else{var s=l.parseDdocFunctionName(t.filter);e.db.get(\"_design/\"+s[0],function(o,i){if(e.isCancelled)return n(null,{status:\"cancelled\"});if(o)return n(f.generateErrorFromResponse(o));var a=i&&i.filters&&i.filters[s[1]];if(!a)return n(f.createError(f.MISSING_DOC,i&&i.filters?\"missing json key: \"+s[1]:\"missing json key: filters\"));t.filter=r(a),e.doChanges(t)})}}function c(e){e._changesFilterPlugin={validate:i,normalize:a,shouldFilter:s,filter:u}}var f=e(30),l=e(72),d=e(71);t.exports=c},{30:30,71:71,72:72}],22:[function(e,t,n){\"use strict\";function r(e,t,n,o,i){return e.get(t).catch(function(n){if(404===n.status)return\"http\"!==e.adapter&&\"https\"!==e.adapter||f.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:o,_id:t,history:[],replicator:h,version:d};throw n}).then(function(a){if(!i.cancelled&&a.last_seq!==n)return a.history=(a.history||[]).filter(function(e){return e.session_id!==o}),a.history.unshift({last_seq:n,session_id:o}),a.history=a.history.slice(0,p),a.version=d,a.replicator=h,a.session_id=o,a.last_seq=n,e.put(a).catch(function(a){if(409===a.status)return r(e,t,n,o,i);throw a})})}function o(e,t,n,r){this.src=e,this.target=t,this.id=n,this.returnValue=r}function i(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:a(e.history,t.history)}function a(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);return n&&0!==t.length?s(n.session_id,t)?{last_seq:n.last_seq,history:e}:s(o.session_id,r)?{last_seq:o.last_seq,history:i}:a(r,i):{last_seq:v,history:[]}}function s(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||s(e,r))}function u(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var c=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(68)),f=e(72),l=e(23),d=1,h=\"pouchdb\",p=5,v=0;o.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},o.prototype.updateTarget=function(e,t){return r(this.target,this.id,e,t,this.returnValue)},o.prototype.updateSource=function(e,t){var n=this;return this.readOnlySource?c.resolve(!0):r(this.src,this.id,e,t,this.returnValue).catch(function(e){if(u(e))return n.readOnlySource=!0,!0;throw e})};var y={undefined:function(e,t){return 0===l.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return i(t,e).last_seq}};o.prototype.getCheckpoint=function(){var e=this;return e.target.get(e.id).then(function(t){return e.readOnlySource?c.resolve(t.last_seq):e.src.get(e.id).then(function(e){if(t.version!==e.version)return v;var n;return n=t.version?t.version.toString():\"undefined\",n in y?y[n](t,e):v},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:v}).then(function(){return v},function(n){return u(n)?(e.readOnlySource=!0,t.last_seq):v});throw n})}).catch(function(e){if(404!==e.status)throw e;return v})},t.exports=o},{23:23,68:68,72:72}],23:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}function o(e,t,n){return r(e,t,n)+e}function i(e,t){if(e===t)return 0;e=a(e),t=a(t);var n=v(e),r=v(t);if(n-r!=0)return n-r;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return h(e,t)}return Array.isArray(e)?d(e,t):p(e,t)}function a(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=a(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var o in t)if(t.hasOwnProperty(o)){var i=t[o];void 0!==i&&(e[o]=a(i))}}}}return e}function s(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return y(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";if(t)for(;++r<o;)i+=u(n[r]);else for(;++r<o;){var a=n[r];i+=u(a)+u(e[a])}return i}return\"\"}function u(e){return e=a(e),v(e)+_+s(e)+\"\\0\"}function c(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t];t++;var i=\"\",a=e.substring(t,t+m),s=parseInt(a,10)+g;for(o&&(s=-s),t+=m;;){var u=e[t];if(\"\\0\"===u)break;i+=u,t++}i=i.split(\".\"),n=1===i.length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==s&&(n=parseFloat(n+\"e\"+s))}return{num:n,length:t-r}}function f(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var a=e.pop();o[a]=n}else e.push(n)}}function l(e){for(var t=[],n=[],r=0;;){var o=e[r++];if(\"\\0\"!==o)switch(o){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var i=c(e,r);t.push(i.num),r+=i.length;break;case\"4\":for(var a=\"\";;){var s=e[r];if(\"\\0\"===s)break;a+=s,r++}a=a.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(a);break;case\"5\":var u={element:[],index:t.length};t.push(u.element),n.push(u);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+o)}else{if(1===t.length)return t.pop();f(t,n)}}}function d(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=i(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}function h(e,t){return e===t?0:e>t?1:-1}function p(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),a=0;a<o;a++){var s=i(n[a],r[a]);if(0!==s)return s;if(0!==(s=i(e[n[a]],t[r[a]])))return s}return n.length===r.length?0:n.length>r.length?1:-1}function v(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function y(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",a=(r?-n:n)-g,s=o(a.toString(),\"0\",m);i+=_+s;var u=Math.abs(parseFloat(t[0]));r&&(u=10-u);var c=u.toFixed(20);return c=c.replace(/\\.?0+$/,\"\"),i+=_+c}Object.defineProperty(n,\"__esModule\",{value:!0});var g=-324,m=3,_=\"\";n.collate=i,n.normalizeKey=a,n.toIndexableString=u,n.parseIndexableString=l},{}],24:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function o(e){return e.substring(1)}function i(){this._store={}}function a(e){if(this._store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this._store[t]},i.prototype.set=function(e,t){var n=r(e);return this._store[n]=t,!0},i.prototype.has=function(e){return r(e)in this._store},i.prototype.delete=function(e){var t=r(e),n=t in this._store;return delete this._store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var i=t[n],a=this._store[i];i=o(i),e(a,i)}},Object.defineProperty(i.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),a.prototype.add=function(e){return this._store.set(e,!0)},a.prototype.has=function(e){return this._store.has(e)},a.prototype.forEach=function(e){this._store.forEach(function(t,n){e(n)})},Object.defineProperty(a.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"==typeof Symbol||\"undefined\"==typeof Map||\"undefined\"==typeof Set)return!1;var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=a,n.Map=i):(n.Set=Set,n.Map=Map)},{}],25:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e,t){try{e.emit(\"change\",t)}catch(e){b.guardedConsole(\"error\",'Error in .on(\"change\", function):',e)}}function i(e,t,n){function r(){i.cancel()}S.EventEmitter.call(this);var i=this;this.db=e,t=t?b.clone(t):{};var a=t.complete=b.once(function(t,n){t?b.listenerCount(i,\"error\")>0&&i.emit(\"error\",t):i.emit(\"complete\",n),i.removeAllListeners(),e.removeListener(\"destroyed\",r)});n&&(i.on(\"complete\",function(e){n(null,e)}),i.on(\"error\",n)),e.once(\"destroyed\",r),t.onChange=function(e){i.isCancelled||o(i,e)};var s=new E(function(e,n){t.complete=function(t,r){t?n(t):e(r)}});i.once(\"cancel\",function(){e.removeListener(\"destroyed\",r),t.complete(null,{status:\"cancelled\"})}),this.then=s.then.bind(s),this.catch=s.catch.bind(s),this.then(function(e){a(null,e)},a),e.taskqueue.isReady?i.validateChanges(t):e.taskqueue.addTask(function(e){e?t.complete(e):i.isCancelled?i.emit(\"cancel\"):i.validateChanges(t)})}function a(e,t,n){var r=[{rev:e._rev}];\"all_docs\"===n.style&&(r=A.collectLeaves(t.rev_tree).map(function(e){return{rev:e.rev}}));var o={id:t.id,changes:r,doc:e};return A.isDeleted(t,e._rev)&&(o.deleted=!0),n.conflicts&&(o.doc._conflicts=A.collectConflicts(t),o.doc._conflicts.length||delete o.doc._conflicts),o}function s(e,t){return e<t?-1:e>t?1:0}function u(e){return function(t,n){t||n[0]&&n[0].error?e(t||n[0]):e(null,n.length?n[0]:n)}}function c(e){for(var t=0;t<e.length;t++){var n=e[t];if(n._deleted)delete n._attachments;else if(n._attachments)for(var r=Object.keys(n._attachments),o=0;o<r.length;o++){var i=r[o];n._attachments[i]=b.pick(n._attachments[i],[\"data\",\"digest\",\"content_type\",\"length\",\"revpos\",\"stub\"])}}}function f(e,t){var n=s(e._id,t._id);return 0!==n?n:s(e._revisions?e._revisions.start:0,t._revisions?t._revisions.start:0)}function l(e){var t={},n=[];return A.traverseRevTree(e,function(e,r,o,i){var a=r+\"-\"+o;return e&&(t[a]=0),void 0!==i&&n.push({from:i,to:a}),a}),n.reverse(),n.forEach(function(e){void 0===t[e.from]?t[e.from]=1+t[e.to]:t[e.from]=Math.min(t[e.from],1+t[e.to])}),t}function d(e,t,n){var r=\"limit\"in t?t.keys.slice(t.skip,t.limit+t.skip):t.skip>0?t.keys.slice(t.skip):t.keys;if(t.descending&&r.reverse(),!r.length)return e._allDocs({limit:0},n);var o={offset:t.skip};return E.all(r.map(function(n){var r=b.assign({key:n,deleted:\"ok\"},t);return[\"limit\",\"skip\",\"keys\"].forEach(function(e){delete r[e]}),new E(function(t,i){e._allDocs(r,function(e,r){if(e)return i(e);o.total_rows=r.total_rows,t(r.rows[0]||{key:n,error:\"not_found\"})})})})).then(function(e){return o.rows=e,o})}function h(e){var t=e._compactionQueue[0],n=t.opts,r=t.callback;e.get(\"_local/compaction\").catch(function(){return!1}).then(function(t){t&&t.last_seq&&(n.last_seq=t.last_seq),e._compact(n,function(t,n){t?r(t):r(null,n),b.nextTick(function(){e._compactionQueue.shift(),e._compactionQueue.length&&h(e)})})})}function p(e){return\"_\"===e.charAt(0)&&e+\" is not a valid attachment name, attachment names cannot start with '_'\"}function v(){S.EventEmitter.call(this)}function y(){this.isReady=!1,this.failed=!1,this.queue=[]}function g(e,t){var n=e.match(/([a-z\\-]*):\\/\\/(.*)/);if(n)return{name:/https?/.test(n[1])?n[1]+\"://\"+n[2]:n[2],adapter:n[1]};var r=_.adapters,o=_.preferredAdapters,i=_.prefix,a=t.adapter;if(!a)for(var s=0;s<o.length;++s){a=o[s];{if(!(\"idb\"===a&&\"websql\"in r&&b.hasLocalStorage()&&localStorage[\"_pouch__websqldb_\"+i+e]))break;b.guardedConsole(\"log\",'PouchDB is downgrading \"'+e+'\" to WebSQL to avoid data loss, because it was already opened with WebSQL.')}}var u=r[a];return{name:u&&\"use_prefix\"in u&&!u.use_prefix?e:i+e,adapter:a}}function m(e){function t(){e.removeListener(\"closed\",r),e.constructor.emit(\"destroyed\",e.name)}function n(){e.removeListener(\"destroyed\",t),e.removeListener(\"closed\",r),e.emit(\"destroyed\")}function r(){e.removeListener(\"destroyed\",t),o.delete(e.name)}var o=e.constructor._destructionListeners;e.once(\"destroyed\",t),e.once(\"closed\",r),o.has(e.name)||o.set(e.name,[]),o.get(e.name).push(n)}function _(e,t){if(!(this instanceof _))return new _(e,t);var n=this;if(t=t||{},e&&\"object\"==typeof e&&(t=e,e=t.name,delete t.name),this.__opts=t=b.clone(t),n.auto_compaction=t.auto_compaction,n.prefix=_.prefix,\"string\"!=typeof e)throw new Error(\"Missing/invalid DB name\");var r=(t.prefix||\"\")+e,o=g(r,t);if(t.name=o.name,t.adapter=t.adapter||o.adapter,n.name=e,n._adapter=t.adapter,_.emit(\"debug\",[\"adapter\",\"Picked adapter: \",t.adapter]),!_.adapters[t.adapter]||!_.adapters[t.adapter].valid())throw new Error(\"Invalid Adapter: \"+t.adapter);v.call(n),n.taskqueue=new y,n.adapter=t.adapter,_.adapters[t.adapter].call(n,t,function(e){if(e)return n.taskqueue.fail(e);m(n),n.emit(\"created\",n),_.emit(\"created\",n.name),n.taskqueue.ready(n)})}var b=e(72),w=e(24),k=r(e(12)),E=r(e(68)),S=e(10),O=r(e(7)),A=e(67),j=e(30),x=r(e(26)),I=r(e(21));k(i,S.EventEmitter),i.prototype.cancel=function(){this.isCancelled=!0,this.db.taskqueue.isReady&&this.emit(\"cancel\")},i.prototype.validateChanges=function(e){var t=e.complete,n=this;_._changesFilterPlugin?_._changesFilterPlugin.validate(e,function(r){if(r)return t(r);n.doChanges(e)}):n.doChanges(e)},i.prototype.doChanges=function(e){var t=this,n=e.complete;if(e=b.clone(e),\"live\"in e&&!(\"continuous\"in e)&&(e.continuous=e.live),e.processChange=a,\"latest\"===e.since&&(e.since=\"now\"),e.since||(e.since=0),\"now\"===e.since)return void this.db.info().then(function(r){if(t.isCancelled)return void n(null,{status:\"cancelled\"});e.since=r.update_seq,t.doChanges(e)},n);if(_._changesFilterPlugin){if(_._changesFilterPlugin.normalize(e),_._changesFilterPlugin.shouldFilter(this,e))return _._changesFilterPlugin.filter(this,e)}else[\"doc_ids\",\"filter\",\"selector\",\"view\"].forEach(function(t){t in e&&b.guardedConsole(\"warn\",'The \"'+t+'\" option was passed in to changes/replicate, but pouchdb-changes-filter plugin is not installed, so it was ignored. Please install the plugin to enable filtering.')});\"descending\"in e||(e.descending=!1),e.limit=0===e.limit?1:e.limit,e.complete=n;var r=this.db._changes(e);if(r&&\"function\"==typeof r.cancel){var o=t.cancel;t.cancel=O(function(e){r.cancel(),o.apply(this,e)})}},k(v,S.EventEmitter),v.prototype.post=b.adapterFun(\"post\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e))return n(j.createError(j.NOT_AN_OBJECT));this.bulkDocs({docs:[e]},t,u(n))}),v.prototype.put=b.adapterFun(\"put\",function(e,t,n){return\"function\"==typeof t&&(n=t,t={}),\"object\"!=typeof e||Array.isArray(e)?n(j.createError(j.NOT_AN_OBJECT)):(b.invalidIdError(e._id),A.isLocalId(e._id)&&\"function\"==typeof this._putLocal?e._deleted?this._removeLocal(e,n):this._putLocal(e,n):void(\"function\"==typeof this._put&&!1!==t.new_edits?this._put(e,t,n):this.bulkDocs({docs:[e]},t,u(n))))}),v.prototype.putAttachment=b.adapterFun(\"putAttachment\",function(e,t,n,r,o){function i(e){var n=\"_rev\"in e?parseInt(e._rev,10):0;return e._attachments=e._attachments||{},e._attachments[t]={content_type:o,data:r,revpos:++n},a.put(e)}var a=this;return\"function\"==typeof o&&(o=r,r=n,n=null),void 0===o&&(o=r,r=n,n=null),o||b.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e,\"is missing content_type\"),a.get(e).then(function(e){if(e._rev!==n)throw j.createError(j.REV_CONFLICT);return i(e)},function(t){if(t.reason===j.MISSING_DOC.message)return i({_id:e});throw t})}),v.prototype.removeAttachment=b.adapterFun(\"removeAttachment\",function(e,t,n,r){var o=this;o.get(e,function(e,i){return e?void r(e):i._rev!==n?void r(j.createError(j.REV_CONFLICT)):i._attachments?(delete i._attachments[t],0===Object.keys(i._attachments).length&&delete i._attachments,void o.put(i,r)):r()})}),v.prototype.remove=b.adapterFun(\"remove\",function(e,t,n,r){var o;\"string\"==typeof t?(o={_id:e,_rev:t},\"function\"==typeof n&&(r=n,n={})):(o=e,\"function\"==typeof t?(r=t,n={}):(r=n,n=t)),n=n||{},n.was_delete=!0;var i={_id:o._id,_rev:o._rev||n.rev};if(i._deleted=!0,A.isLocalId(i._id)&&\"function\"==typeof this._removeLocal)return this._removeLocal(o,r);this.bulkDocs({docs:[i]},n,u(r))}),v.prototype.revsDiff=b.adapterFun(\"revsDiff\",function(e,t,n){function r(e,t){s.has(e)||s.set(e,{missing:[]}),s.get(e).missing.push(t)}function o(t,n){var o=e[t].slice(0);A.traverseRevTree(n,function(e,n,i,a,s){var u=n+\"-\"+i,c=o.indexOf(u);-1!==c&&(o.splice(c,1),\"available\"!==s.status&&r(t,u))}),o.forEach(function(e){r(t,e)})}\"function\"==typeof t&&(n=t,t={});var i=Object.keys(e);if(!i.length)return n(null,{});var a=0,s=new w.Map;i.map(function(t){this._getRevisionTree(t,function(r,u){if(r&&404===r.status&&\"missing\"===r.message)s.set(t,{missing:e[t]});else{if(r)return n(r);o(t,u)}if(++a===i.length){var c={};return s.forEach(function(e,t){c[t]=e}),n(null,c)}})},this)}),v.prototype.bulkGet=b.adapterFun(\"bulkGet\",function(e,t){b.bulkGetShim(this,e,t)}),v.prototype.compactDocument=b.adapterFun(\"compactDocument\",function(e,t,n){var r=this;this._getRevisionTree(e,function(o,i){if(o)return n(o);var a=l(i),s=[],u=[];Object.keys(a).forEach(function(e){a[e]>t&&s.push(e)}),A.traverseRevTree(i,function(e,t,n,r,o){var i=t+\"-\"+n;\"available\"===o.status&&-1!==s.indexOf(i)&&u.push(i)}),r._doCompaction(e,u,n)})}),v.prototype.compact=b.adapterFun(\"compact\",function(e,t){\"function\"==typeof e&&(t=e,e={});var n=this;e=e||{},n._compactionQueue=n._compactionQueue||[],n._compactionQueue.push({opts:e,callback:t}),1===n._compactionQueue.length&&h(n)}),v.prototype._compact=function(e,t){function n(e){a.push(o.compactDocument(e.id,0))}function r(e){var n=e.last_seq;E.all(a).then(function(){return b.upsert(o,\"_local/compaction\",function(e){return(!e.last_seq||e.last_seq<n)&&(e.last_seq=n,e)})}).then(function(){t(null,{ok:!0})}).catch(t)}var o=this,i={return_docs:!1,last_seq:e.last_seq||0},a=[];o.changes(i).on(\"change\",n).on(\"complete\",r).on(\"error\",t)},v.prototype.get=b.adapterFun(\"get\",function(e,t,n){function r(){var r=[],a=o.length;if(!a)return n(null,r);o.forEach(function(o){i.get(e,{rev:o,revs:t.revs,latest:t.latest,attachments:t.attachments},function(e,t){if(e)r.push({missing:o});else{for(var i,s=0,u=r.length;s<u;s++)if(r[s].ok&&r[s].ok._rev===t._rev){i=!0;break}i||r.push({ok:t})}--a||n(null,r)})})}if(\"function\"==typeof t&&(n=t,t={}),\"string\"!=typeof e)return n(j.createError(j.INVALID_ID));if(A.isLocalId(e)&&\"function\"==typeof this._getLocal)return this._getLocal(e,n);var o=[],i=this;if(!t.open_revs)return this._get(e,t,function(e,r){if(e)return n(e);var o=r.doc,a=r.metadata,s=r.ctx;if(t.conflicts){var u=A.collectConflicts(a);u.length&&(o._conflicts=u)}if(A.isDeleted(a,o._rev)&&(o._deleted=!0),t.revs||t.revs_info){for(var c=o._rev.split(\"-\"),f=parseInt(c[0],10),l=c[1],d=A.rootToLeaf(a.rev_tree),h=null,p=0;p<d.length;p++){var v=d[p],y=v.ids.map(function(e){return e.id}).indexOf(l);(y===f-1||!h&&-1!==y)&&(h=v)}var g=h.ids.map(function(e){return e.id}).indexOf(o._rev.split(\"-\")[1])+1,m=h.ids.length-g;if(h.ids.splice(g,m),h.ids.reverse(),t.revs&&(o._revisions={start:h.pos+h.ids.length-1,ids:h.ids.map(function(e){return e.id})}),t.revs_info){var _=h.pos+h.ids.length;o._revs_info=h.ids.map(function(e){return _--,{rev:_+\"-\"+e.id,status:e.opts.status}})}}if(t.attachments&&o._attachments){var b=o._attachments,w=Object.keys(b).length;if(0===w)return n(null,o);Object.keys(b).forEach(function(e){this._getAttachment(o._id,e,b[e],{rev:o._rev,binary:t.binary,ctx:s},function(t,r){var i=o._attachments[e];i.data=r,delete i.stub,delete i.length,--w||n(null,o)})},i)}else{if(o._attachments)for(var k in o._attachments)o._attachments.hasOwnProperty(k)&&(o._attachments[k].stub=!0);n(null,o)}});if(\"all\"===t.open_revs)this._getRevisionTree(e,function(e,t){if(e)return n(e);o=A.collectLeaves(t).map(function(e){return e.rev}),r()});else{if(!Array.isArray(t.open_revs))return n(j.createError(j.UNKNOWN_ERROR,\"function_clause\"));o=t.open_revs;for(var a=0;a<o.length;a++){var s=o[a];if(\"string\"!=typeof s||!/^\\d+-/.test(s))return n(j.createError(j.INVALID_REV))}r()}}),v.prototype.getAttachment=b.adapterFun(\"getAttachment\",function(e,t,n,r){var o=this;n instanceof Function&&(r=n,n={}),this._get(e,n,function(i,a){return i?r(i):a.doc._attachments&&a.doc._attachments[t]?(n.ctx=a.ctx,n.binary=!0,o._getAttachment(e,t,a.doc._attachments[t],n,r),void 0):r(j.createError(j.MISSING_DOC))})}),v.prototype.allDocs=b.adapterFun(\"allDocs\",function(e,t){if(\"function\"==typeof e&&(t=e,e={}),e.skip=void 0!==e.skip?e.skip:0,e.start_key&&(e.startkey=e.start_key),e.end_key&&(e.endkey=e.end_key),\"keys\"in e){if(!Array.isArray(e.keys))return t(new TypeError(\"options.keys must be an array\"));var n=[\"startkey\",\"endkey\",\"key\"].filter(function(t){return t in e})[0];if(n)return void t(j.createError(j.QUERY_PARSE_ERROR,\"Query parameter `\"+n+\"` is not compatible with multi-get\"));if(!b.isRemote(this))return d(this,e,t)}return this._allDocs(e,t)}),v.prototype.changes=function(e,t){return\"function\"==typeof e&&(t=e,e={}),new i(this,e,t)},v.prototype.close=b.adapterFun(\"close\",function(e){return this._closed=!0,this.emit(\"closed\"),this._close(e)}),v.prototype.info=b.adapterFun(\"info\",function(e){var t=this;this._info(function(n,r){if(n)return e(n);r.db_name=r.db_name||t.name,r.auto_compaction=!(!t.auto_compaction||b.isRemote(t)),r.adapter=t.adapter,e(null,r)})}),v.prototype.id=b.adapterFun(\"id\",function(e){return this._id(e)}),v.prototype.type=function(){return\"function\"==typeof this._type?this._type():this.adapter},v.prototype.bulkDocs=b.adapterFun(\"bulkDocs\",function(e,t,n){if(\"function\"==typeof t&&(n=t,t={}),t=t||{},Array.isArray(e)&&(e={docs:e}),!e||!e.docs||!Array.isArray(e.docs))return n(j.createError(j.MISSING_BULK_DOCS));for(var r=0;r<e.docs.length;++r)if(\"object\"!=typeof e.docs[r]||Array.isArray(e.docs[r]))return n(j.createError(j.NOT_AN_OBJECT));var o;if(e.docs.forEach(function(e){e._attachments&&Object.keys(e._attachments).forEach(function(t){o=o||p(t),e._attachments[t].content_type||b.guardedConsole(\"warn\",\"Attachment\",t,\"on document\",e._id,\"is missing content_type\")})}),o)return n(j.createError(j.BAD_REQUEST,o));\"new_edits\"in t||(t.new_edits=!(\"new_edits\"in e)||e.new_edits);var i=this;t.new_edits||b.isRemote(i)||e.docs.sort(f),c(e.docs);var a=e.docs.map(function(e){return e._id});return this._bulkDocs(e,t,function(e,r){if(e)return n(e);if(t.new_edits||(r=r.filter(function(e){return e.error})),!b.isRemote(i))for(var o=0,s=r.length;o<s;o++)r[o].id=r[o].id||a[o];n(null,r)})}),v.prototype.registerDependentDatabase=b.adapterFun(\"registerDependentDatabase\",function(e,t){function n(t){return t.dependentDbs=t.dependentDbs||{},!t.dependentDbs[e]&&(t.dependentDbs[e]=!0,t)}var r=new this.constructor(e,this.__opts);b.upsert(this,\"_local/_pouch_dependentDbs\",n).then(function(){t(null,{db:r})}).catch(t)}),v.prototype.destroy=b.adapterFun(\"destroy\",function(e,t){function n(){r._destroy(e,function(e,n){if(e)return t(e);r._destroyed=!0,r.emit(\"destroyed\"),t(null,n||{ok:!0})})}\"function\"==typeof e&&(t=e,e={});var r=this,o=!(\"use_prefix\"in r)||r.use_prefix;if(b.isRemote(r))return n();r.get(\"_local/_pouch_dependentDbs\",function(e,i){if(e)return 404!==e.status?t(e):n();var a=i.dependentDbs,s=r.constructor,u=Object.keys(a).map(function(e){var t=o?e.replace(new RegExp(\"^\"+s.prefix),\"\"):e;return new s(t,r.__opts).destroy()});E.all(u).then(n,t)})}),y.prototype.execute=function(){var e;if(this.failed)for(;e=this.queue.shift();)e(this.failed);else for(;e=this.queue.shift();)e()},y.prototype.fail=function(e){this.failed=e,this.execute()},y.prototype.ready=function(e){this.isReady=!0,this.db=e,this.execute()},y.prototype.addTask=function(e){this.queue.push(e),this.failed&&this.execute()},k(_,v),_.adapters={},_.preferredAdapters=[],_.prefix=\"_pouch_\";var D=new S.EventEmitter;!function(e){Object.keys(S.EventEmitter.prototype).forEach(function(t){\"function\"==typeof S.EventEmitter.prototype[t]&&(e[t]=D[t].bind(D))});var t=e._destructionListeners=new w.Map;e.on(\"destroyed\",function(e){t.get(e).forEach(function(e){e()}),t.delete(e)})}(_),_.adapter=function(e,t,n){t.valid()&&(_.adapters[e]=t,n&&_.preferredAdapters.push(e))},_.plugin=function(e){if(\"function\"==typeof e)e(_);else{if(\"object\"!=typeof e||0===Object.keys(e).length)throw new Error('Invalid plugin: got \"'+e+'\", expected an object or a function');Object.keys(e).forEach(function(t){_.prototype[t]=e[t]})}return this.__defaults&&(_.__defaults=b.assign({},this.__defaults)),_},_.defaults=function(e){function t(e,n){if(!(this instanceof t))return new t(e,n);n=n||{},e&&\"object\"==typeof e&&(n=e,e=n.name,delete n.name),n=b.assign({},t.__defaults,n),_.call(this,e,n)}return k(t,_),t.preferredAdapters=_.preferredAdapters.slice(),Object.keys(_).forEach(function(e){e in t||(t[e]=_[e])}),t.__defaults=b.assign({},this.__defaults,e),t};_.plugin(x),_.plugin(I),_.version=\"6.2.0\",t.exports=_},{10:10,12:12,21:21,24:24,26:26,30:30,67:67,68:68,7:7,72:72}],26:[function(e,t,n){\"use strict\";function r(e){e.debug=o;var t={};e.on(\"debug\",function(e){var n=e[0],r=e.slice(1);t[n]||(t[n]=o(\"pouchdb:\"+n)),t[n].apply(null,r)})}var o=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(27));t.exports=r},{27:27}],27:[function(e,t,n){(function(r){function o(){return!(\"undefined\"==typeof window||!window||void 0===window.process||\"renderer\"!==window.process.type)||(\"undefined\"!=typeof document&&document&&\"WebkitAppearance\"in document.documentElement.style||\"undefined\"!=typeof window&&window&&window.console&&(console.firebug||console.exception&&console.table)||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31||\"undefined\"!=typeof navigator&&navigator&&navigator.userAgent&&navigator.userAgent.toLowerCase().match(/applewebkit\\/(\\d+)/))}function i(e){var t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),t){var r=\"color: \"+this.color;e.splice(1,0,r,\"color: inherit\");var o=0,i=0;e[0].replace(/%[a-zA-Z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r)}}function a(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function s(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function u(){try{return n.storage.debug}catch(e){}if(void 0!==r&&\"env\"in r)return r.env.DEBUG}n=t.exports=e(28),n.log=a,n.formatArgs=i,n.save=s,n.load=u,n.useColors=o,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){try{return JSON.stringify(e)}catch(e){return\"[UnexpectedJSONParseError]: \"+e.message}},n.enable(u())}).call(this,e(73))},{28:28,73:73}],28:[function(e,t,n){function r(e){var t,r=0;for(t in e)r=(r<<5)-r+e.charCodeAt(t),r|=0;return n.colors[Math.abs(r)%n.colors.length]}function o(e){function t(){if(t.enabled){var e=t,r=+new Date,o=r-(c||r)\n;e.diff=o,e.prev=c,e.curr=r,c=r;for(var i=new Array(arguments.length),a=0;a<i.length;a++)i[a]=arguments[a];i[0]=n.coerce(i[0]),\"string\"!=typeof i[0]&&i.unshift(\"%O\");var s=0;i[0]=i[0].replace(/%([a-zA-Z%])/g,function(t,r){if(\"%%\"===t)return t;s++;var o=n.formatters[r];if(\"function\"==typeof o){var a=i[s];t=o.call(e,a),i.splice(s,1),s--}return t}),n.formatArgs.call(e,i);(t.log||n.log||console.log.bind(console)).apply(e,i)}}return t.namespace=e,t.enabled=n.enabled(e),t.useColors=n.useColors(),t.color=r(e),\"function\"==typeof n.init&&n.init(t),t}function i(e){n.save(e),n.names=[],n.skips=[];for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function a(){n.enable(\"\")}function s(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o.debug=o.default=o,n.coerce=u,n.disable=a,n.enable=i,n.enabled=s,n.humanize=e(29),n.names=[],n.skips=[],n.formatters={};var c},{29:29}],29:[function(e,t,n){function r(e){if(e=String(e),!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*s;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n;default:return}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=s?Math.round(e/s)+\"s\":e+\"ms\"}function i(e){return a(e,f,\"day\")||a(e,c,\"hour\")||a(e,u,\"minute\")||a(e,s,\"second\")||e+\" ms\"}function a(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var s=1e3,u=60*s,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){t=t||{};var n=typeof e;if(\"string\"===n&&e.length>0)return r(e);if(\"number\"===n&&!1===isNaN(e))return t.long?i(e):o(e);throw new Error(\"val is not a non-empty string or a valid number. val=\"+JSON.stringify(e))}},{}],30:[function(e,t,n){\"use strict\";function r(e,t,n){Error.call(this,n),this.status=e,this.name=t,this.message=n,this.error=!0}function o(e,t){function n(t){for(var n in e)\"function\"!=typeof e[n]&&(this[n]=e[n]);void 0!==t&&(this.reason=t)}return n.prototype=r.prototype,new n(t)}function i(e){if(\"object\"!=typeof e){var t=e;e=p,e.data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}Object.defineProperty(n,\"__esModule\",{value:!0}),function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(12))(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var a=new r(401,\"unauthorized\",\"Name or password is incorrect.\"),s=new r(400,\"bad_request\",\"Missing JSON list of 'docs'\"),u=new r(404,\"not_found\",\"missing\"),c=new r(409,\"conflict\",\"Document update conflict\"),f=new r(400,\"bad_request\",\"_id field must contain a string\"),l=new r(412,\"missing_id\",\"_id is required for puts\"),d=new r(400,\"bad_request\",\"Only reserved document ids may start with underscore.\"),h=new r(412,\"precondition_failed\",\"Database not open\"),p=new r(500,\"unknown_error\",\"Database encountered an unknown error\"),v=new r(500,\"badarg\",\"Some query argument is invalid\"),y=new r(400,\"invalid_request\",\"Request was invalid\"),g=new r(400,\"query_parse_error\",\"Some query parameter is invalid\"),m=new r(500,\"doc_validation\",\"Bad special document member\"),_=new r(400,\"bad_request\",\"Something wrong with the request\"),b=new r(400,\"bad_request\",\"Document must be a JSON object\"),w=new r(404,\"not_found\",\"Database not found\"),k=new r(500,\"indexed_db_went_bad\",\"unknown\"),E=new r(500,\"web_sql_went_bad\",\"unknown\"),S=new r(500,\"levelDB_went_went_bad\",\"unknown\"),O=new r(403,\"forbidden\",\"Forbidden by design doc validate_doc_update function\"),A=new r(400,\"bad_request\",\"Invalid rev format\"),j=new r(412,\"file_exists\",\"The database could not be created, the file already exists.\"),x=new r(412,\"missing_stub\",\"A pre-existing attachment stub wasn't found\"),I=new r(413,\"invalid_url\",\"Provided URL is invalid\");n.UNAUTHORIZED=a,n.MISSING_BULK_DOCS=s,n.MISSING_DOC=u,n.REV_CONFLICT=c,n.INVALID_ID=f,n.MISSING_ID=l,n.RESERVED_ID=d,n.NOT_OPEN=h,n.UNKNOWN_ERROR=p,n.BAD_ARG=v,n.INVALID_REQUEST=y,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=m,n.BAD_REQUEST=_,n.NOT_AN_OBJECT=b,n.DB_MISSING=w,n.WSQ_ERROR=E,n.LDB_ERROR=S,n.FORBIDDEN=O,n.INVALID_REV=A,n.FILE_EXISTS=j,n.MISSING_STUB=x,n.IDB_ERROR=k,n.INVALID_URL=I,n.createError=o,n.generateErrorFromResponse=i},{12:12}],31:[function(e,t,n){\"use strict\";function r(e){return null===e?String(e):\"object\"==typeof e||\"function\"==typeof e?c[h.call(e)]||\"object\":typeof e}function o(e){return null!==e&&e===e.window}function i(e){if(!e||\"object\"!==r(e)||e.nodeType||o(e))return!1;try{if(e.constructor&&!p.call(e,\"constructor\")&&!p.call(e.constructor.prototype,\"isPrototypeOf\"))return!1}catch(e){return!1}var t;for(t in e);return void 0===t||p.call(e,t)}function a(e){return\"function\"===r(e)}function s(){for(var e=[],t=-1,n=arguments.length,r=new Array(n);++t<n;)r[t]=arguments[t];var o={};e.push({args:r,result:{container:o,key:\"key\"}});for(var i;i=e.pop();)u(e,i.args,i.result);return o.key}function u(e,t,n){var r,o,s,u,c,f,l,d=t[0]||{},h=1,p=t.length,y=!1,g=/\\d+/;for(\"boolean\"==typeof d&&(y=d,d=t[1]||{},h=2),\"object\"==typeof d||a(d)||(d={}),p===h&&(d=this,--h);h<p;h++)if(null!=(r=t[h])){l=v(r);for(o in r)if(!(o in Object.prototype)){if(l&&!g.test(o))continue;if(s=d[o],u=r[o],d===u)continue;y&&u&&(i(u)||(c=v(u)))?(c?(c=!1,f=s&&v(s)?s:[]):f=s&&i(s)?s:{},e.push({args:[y,f,u],result:{container:d,key:o}})):void 0!==u&&(v(r)&&a(u)||(d[o]=u))}}n.container[n.key]=d}for(var c={},f=[\"Boolean\",\"Number\",\"String\",\"Function\",\"Array\",\"Date\",\"RegExp\",\"Object\",\"Error\"],l=0;l<f.length;l++){var d=f[l];c[\"[object \"+d+\"]\"]=d.toLowerCase()}var h=c.toString,p=c.hasOwnProperty,v=Array.isArray||function(e){return\"array\"===r(e)};t.exports=s},{}],32:[function(e,t,n){\"use strict\";Object.defineProperty(n,\"__esModule\",{value:!0});var r=\"undefined\"!=typeof AbortController?AbortController:function(){return{abort:function(){}}},o=fetch,i=Headers;n.fetch=o,n.Headers=i,n.AbortController=r},{}],33:[function(e,t,n){\"use strict\";function r(e){return e=he.clone(e),e.index||(e.index={}),[\"type\",\"name\",\"ddoc\"].forEach(function(t){e.index[t]&&(e[t]=e.index[t],delete e.index[t])}),e.fields&&(e.index.fields=e.fields,delete e.fields),e.type||(e.type=\"json\"),e}function o(e,t,n,r){var o,i;n.headers=new ve.Headers({\"Content-type\":\"application/json\"}),e.fetch(t,n).then(function(e){return o=e.status,i=e.ok,e.json()}).then(function(e){if(i)r(null,e);else{e.status=o;var t=pe.generateErrorFromResponse(e);r(t)}}).catch(r)}function i(e,t,n){t=r(t),o(e,\"_index\",{method:\"POST\",body:JSON.stringify(t)},n)}function a(e,t,n){o(e,\"_find\",{method:\"POST\",body:JSON.stringify(t)},n)}function s(e,t,n){o(e,\"_explain\",{method:\"POST\",body:JSON.stringify(t)},n)}function u(e,t){o(e,\"_index\",{method:\"GET\"},t)}function c(e,t,n){var r=t.ddoc,i=t.type||\"json\",a=t.name;return r?a?void o(e,\"_index/\"+[r,i,a].map(encodeURIComponent).join(\"/\"),{method:\"DELETE\"},n):n(new Error(\"you must provide an index's name\")):n(new Error(\"you must provide an index's ddoc\"))}function f(e){return function(){for(var t=arguments.length,n=new Array(t),r=-1;++r<t;)n[r]=arguments[r];return e.call(this,n)}}function l(e){return f(function(t){var n=t.pop(),r=e.apply(this,t);return d(r,n),r})}function d(e,t){return e.then(function(e){he.nextTick(function(){t(null,e)})},function(e){he.nextTick(function(){t(e)})}),e}function h(e){for(var t={},n=0,r=e.length;n<r;n++)t=he.assign(t,e[n]);return t}function p(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=ye.parseField(t[r]),a=ye.getFieldFromDoc(e,i);void 0!==a&&ye.setFieldInDoc(n,i,a)}return n}function v(e,t){for(var n=0,r=Math.min(e.length,t.length);n<r;n++)if(e[n]!==t[n])return!1;return!0}function y(e,t){return!(e.length>t.length)&&v(e,t)}function g(e,t){e=e.slice();for(var n=0,r=t.length;n<r;n++){var o=t[n];if(!e.length)break;var i=e.indexOf(o);if(-1===i)return!1;e.splice(i,1)}return!0}function m(e){for(var t={},n=0,r=e.length;n<r;n++)t[e[n]]=!0;return t}function _(e,t){for(var n=null,r=-1,o=0,i=e.length;o<i;o++){var a=e[o],s=t(a);s>r&&(r=s,n=a)}return n}function b(e,t){if(e.length!==t.length)return!1;for(var n=0,r=e.length;n<r;n++)if(e[n]!==t[n])return!1;return!0}function w(e){for(var t={},n=0;n<e.length;n++)t[\"$\"+e[n]]=!0;return Object.keys(t).map(function(e){return e.substring(1)})}function k(e,t){return function(n){for(var r=[],o=0,i=e.length;o<i;o++){for(var a=ye.parseField(e[o]),s=n,u=0,c=a.length;u<c;u++){if(void 0===(s=s[a[u]]))return}r.push(s)}t(r)}}function E(e,t){var n=ye.parseField(e);return function(e){for(var r=e,o=0,i=n.length;o<i;o++){if(void 0===(r=r[n[o]]))return}t(r)}}function S(e,t){return function(n){t(n[e])}}function O(e,t){return function(n){for(var r=[],o=0,i=e.length;o<i;o++)r.push(n[e[o]]);t(r)}}function A(e){for(var t=0,n=e.length;t<n;t++){if(-1!==e[t].indexOf(\".\"))return!1}return!0}function j(e,t){var n=A(e),r=1===e.length;return n?r?S(e[0],t):O(e,t):r?E(e[0],t):k(e,t)}function x(e,t){return j(Object.keys(e.fields),t)}function I(){throw new Error(\"reduce not supported\")}function D(e,t){var n=e.views[t];if(!n.map||!n.map.fields)throw new Error(\"ddoc \"+e._id+\" with view \"+t+\" doesn't have map.fields defined. maybe it wasn't created by this plugin?\")}function q(e){if(!Array.isArray(e))throw new Error(\"invalid sort json - should be an array\");return e.map(function(e){if(\"string\"==typeof e){var t={};return t[e]=\"asc\",t}return e})}function C(e){var t=[];return\"string\"==typeof e?t.push(e):t=e,t.map(function(e){return e.replace(\"_design/\",\"\")})}function B(e){return e.fields=e.fields.map(function(e){if(\"string\"==typeof e){var t={};return t[e]=\"asc\",t}return e}),e}function R(e,t){for(var n=[],r=0;r<t.def.fields.length;r++){var o=ye.getKey(t.def.fields[r]);n.push(e[o])}return n}function T(e,t,n){for(var r=n.def.fields,o=0,i=e.length;o<i;o++){var a=e[o],s=R(a.doc,n);if(1===r.length)s=s[0];else for(;s.length>t.length;)s.pop();if(Math.abs(me.collate(s,t))>0)break}return o>0?e.slice(o):e}function $(e){var t=he.clone(e);return delete t.startkey,delete t.endkey,delete t.inclusive_start,delete t.inclusive_end,\"endkey\"in e&&(t.startkey=e.endkey),\"startkey\"in e&&(t.endkey=e.startkey),\"inclusive_start\"in e&&(t.inclusive_end=e.inclusive_start),\"inclusive_end\"in e&&(t.inclusive_start=e.inclusive_end),t}function L(e){var t=e.fields.filter(function(e){return\"asc\"===ye.getValue(e)});if(0!==t.length&&t.length!==e.fields.length)throw new Error(\"unsupported mixed sorting\")}function N(e,t){if(t.defaultUsed&&e.sort){var n=e.sort.filter(function(e){return\"_id\"!==Object.keys(e)[0]}).map(function(e){return Object.keys(e)[0]});if(n.length>0)throw new Error('Cannot sort on field(s) \"'+n.join(\",\")+'\" when using the default index')}t.defaultUsed}function M(e){if(\"object\"!=typeof e.selector)throw new Error(\"you must provide a selector when you find()\")}function F(e,t){var n,r=Object.keys(e),o=t?t.map(ye.getKey):[];return n=r.length>=o.length?r:o,0===o.length?{fields:n}:(n=n.sort(function(e,t){var n=o.indexOf(e);-1===n&&(n=Number.MAX_VALUE);var r=o.indexOf(t);return-1===r&&(r=Number.MAX_VALUE),n<r?-1:n>r?1:0}),{fields:n,sortOrder:t.map(ye.getKey)})}function P(e,t){function n(){return a||(a=_e.stringMd5(JSON.stringify(t)))}function o(e){return e._rev&&\"query\"!==e.language&&(f=!0),e.language=\"query\",e.views=e.views||{},!(l=!!e.views[s])&&(e.views[s]={map:{fields:h(t.index.fields)},reduce:\"_count\",options:{def:i}},e)}t=r(t);var i=he.clone(t.index);t.index=B(t.index),L(t.index);var a,s=t.name||\"idx-\"+n(),u=t.ddoc||\"idx-\"+n(),c=\"_design/\"+u,f=!1,l=!1;return e.constructor.emit(\"debug\",[\"find\",\"creating index\",c]),he.upsert(e,c,o).then(function(){if(f)throw new Error('invalid language for ddoc with id \"'+c+'\" (should be \"query\")')}).then(function(){var t=u+\"/\"+s;return we.query.call(e,t,{limit:0,reduce:!1}).then(function(){return{id:c,name:s,result:l?\"exists\":\"created\"}})})}function U(e){return e.allDocs({startkey:\"_design/\",endkey:\"_design/￿\",include_docs:!0}).then(function(e){var t={indexes:[{ddoc:null,name:\"_all_docs\",type:\"special\",def:{fields:[{_id:\"asc\"}]}}]};return t.indexes=be(t.indexes,e.rows.filter(function(e){return\"query\"===e.doc.language}).map(function(e){return(void 0!==e.doc.views?Object.keys(e.doc.views):[]).map(function(t){var n=e.doc.views[t];return{ddoc:e.id,name:t,type:\"json\",def:B(n.options.def)}})})),t.indexes.sort(function(e,t){return ye.compare(e.name,t.name)}),t.total_rows=t.indexes.length,t})}function z(e,t){for(var n=e.def.fields.map(ye.getKey),r=0,o=n.length;r<o;r++){if(t===n[r])return!0}return!1}function K(e,t){var n=e[t];return\"$eq\"!==ye.getKey(n)}function G(e,t){var n=t.def.fields.map(ye.getKey);return e.slice().sort(function(e,t){var r=n.indexOf(e),o=n.indexOf(t);return-1===r&&(r=Number.MAX_VALUE),-1===o&&(o=Number.MAX_VALUE),ye.compare(r,o)})}function J(e,t,n){n=G(n,e);for(var r=!1,o=0,i=n.length;o<i;o++){var a=n[o];if(r||!z(e,a))return n.slice(o);o<i-1&&K(t,a)&&(r=!0)}return[]}function V(e){var t=[];return Object.keys(e).forEach(function(n){var r=e[n];Object.keys(r).forEach(function(e){\"$ne\"===e&&t.push(n)})}),t}function Q(e,t,n,r){return G(w(be(e,J(t,n,r),V(n))),t)}function H(e,t,n){if(t){var r=y(t,e),o=v(n,e);return r&&o}return g(n,e)}function W(e){return-1===Se.indexOf(e)}function X(e,t){var n=e[0],r=t[n];return void 0===r||!!Object.keys(r).some(function(e){return!W(e)})&&!(1===Object.keys(r).length&&\"$ne\"===ye.getKey(r))}function Y(e,t,n,r){var o=e.def.fields.map(ye.getKey);return!!H(o,t,n)&&X(o,r)}function Z(e,t,n,r){return r.reduce(function(r,o){return Y(o,n,t,e)&&r.push(o),r},[])}function ee(e,t,n,r,o){function i(e){for(var t=e.def.fields.map(ye.getKey),n=0,r=0,o=t.length;r<o;r++){var i=t[r];u[i]&&n++}return n}var a=Z(e,t,n,r);if(0===a.length){if(o)throw{error:\"no_usable_index\",message:\"There is no index available for this selector.\"};var s=r[0];return s.defaultUsed=!0,s}if(1===a.length&&!o)return a[0];var u=m(t);if(o){var c=\"_design/\"+o[0],f=2===o.length&&o[1],l=a.find(function(e){return!(!f||e.ddoc!==c||f!==e.name)||e.ddoc===c});if(!l)throw{error:\"unknown_error\",message:\"Could not find that index or could not use that index for the query\"};return l}return _(a,i)}function te(e,t){switch(e){case\"$eq\":return{key:t};case\"$lte\":return{endkey:t};case\"$gte\":return{startkey:t};case\"$lt\":return{endkey:t,inclusive_end:!1};case\"$gt\":return{startkey:t,inclusive_start:!1}}}function ne(e,t){var n,r=ye.getKey(t.def.fields[0]),o=e[r]||{},i=[],a=Object.keys(o);return a.forEach(function(e){if(W(e))return void i.push(r);var t=o[e],a=te(e,t);n=n?h([n,a]):a}),{queryOpts:n,inMemoryFields:i}}function re(e,t){switch(e){case\"$eq\":return{startkey:t,endkey:t};case\"$lte\":return{endkey:t};case\"$gte\":return{startkey:t};case\"$lt\":return{endkey:t,inclusive_end:!1};case\"$gt\":return{startkey:t,inclusive_start:!1}}}function oe(e,t){function n(e){!1!==r&&s.push(ke),!1!==o&&u.push(Ee),a=i.slice(e)}for(var r,o,i=t.def.fields.map(ye.getKey),a=[],s=[],u=[],c=0,f=i.length;c<f;c++){var l=i[c],d=e[l];if(!d||!Object.keys(d).length){n(c);break}if(c>0){if(Object.keys(d).some(W)){n(c);break}var p=\"$gt\"in d||\"$gte\"in d||\"$lt\"in d||\"$lte\"in d,v=Object.keys(e[i[c-1]]),y=b(v,[\"$eq\"]),g=b(v,Object.keys(d));if(p&&!y&&!g){n(c);break}}for(var m=Object.keys(d),_=null,w=0;w<m.length;w++){var k=m[w],E=d[k],S=re(k,E);_=_?h([_,S]):S}s.push(\"startkey\"in _?_.startkey:ke),u.push(\"endkey\"in _?_.endkey:Ee),\"inclusive_start\"in _&&(r=_.inclusive_start),\"inclusive_end\"in _&&(o=_.inclusive_end)}var O={startkey:s,endkey:u};return void 0!==r&&(O.inclusive_start=r),void 0!==o&&(O.inclusive_end=o),{queryOpts:O,inMemoryFields:a}}function ie(e){return{queryOpts:{startkey:null},inMemoryFields:[Object.keys(e)]}}function ae(e,t){return t.defaultUsed?ie(e,t):1===t.def.fields.length?ne(e,t):oe(e,t)}function se(e,t){var n=e.selector,r=e.sort,o=F(n,r),i=o.fields,a=o.sortOrder,s=ee(n,i,a,t,e.use_index),u=ae(n,s);return{queryOpts:u.queryOpts,index:s,inMemoryFields:Q(u.inMemoryFields,s,n,i)}}function ue(e){return e.ddoc.substring(8)+\"/\"+e.name}function ce(e,t){var n=he.clone(t);return n.descending?(\"endkey\"in n&&\"string\"!=typeof n.endkey&&(n.endkey=\"\"),\"startkey\"in n&&\"string\"!=typeof n.startkey&&(n.limit=0)):(\"startkey\"in n&&\"string\"!=typeof n.startkey&&(n.startkey=\"\"),\"endkey\"in n&&\"string\"!=typeof n.endkey&&(n.limit=0)),\"key\"in n&&\"string\"!=typeof n.key&&(n.limit=0),e.allDocs(n).then(function(e){return e.rows=e.rows.filter(function(e){return!/^_design\\//.test(e.id)}),e})}function fe(e,t,n){return t.selector&&(t.selector=ye.massageSelector(t.selector)),t.sort&&(t.sort=q(t.sort)),t.use_index&&(t.use_index=C(t.use_index)),M(t),U(e).then(function(r){e.constructor.emit(\"debug\",[\"find\",\"planning query\",t]);var o=se(t,r.indexes);e.constructor.emit(\"debug\",[\"find\",\"query plan\",o]);var i=o.index;N(t,i);var a=he.assign({include_docs:!0,reduce:!1},o.queryOpts);return\"startkey\"in a&&\"endkey\"in a&&me.collate(a.startkey,a.endkey)>0?{docs:[]}:(t.sort&&\"string\"!=typeof t.sort[0]&&\"desc\"===ye.getValue(t.sort[0])&&(a.descending=!0,a=$(a)),o.inMemoryFields.length||(\"limit\"in t&&(a.limit=t.limit),\"skip\"in t&&(a.skip=t.skip)),n?Promise.resolve(o,a):Promise.resolve().then(function(){if(\"_all_docs\"===i.name)return ce(e,a);var t=ue(i);return we.query.call(e,t,a)}).then(function(e){!1===a.inclusive_start&&(e.rows=T(e.rows,a.startkey,i)),o.inMemoryFields.length&&(e.rows=ye.filterInMemoryFields(e.rows,t,o.inMemoryFields));var n={docs:e.rows.map(function(e){var n=e.doc;return t.fields?p(n,t.fields):n})};return i.defaultUsed&&(n.warning=\"no matching index found, create an index to optimize query time\"),n}))})}function le(e,t){return fe(e,t,!0).then(function(n){return{dbname:e.name,index:n.index,selector:t.selector,range:{start_key:n.queryOpts.startkey,end_key:n.queryOpts.endkey},opts:{use_index:t.use_index||[],bookmark:\"nil\",limit:t.limit,skip:t.skip,sort:t.sort||{},fields:t.fields,conflicts:!1,r:[49]},limit:t.limit,skip:t.skip||0,fields:t.fields}})}function de(e,t){function n(e){return 1===Object.keys(e.views).length&&e.views[o]?{_id:r,_deleted:!0}:(delete e.views[o],e)}if(!t.ddoc)throw new Error(\"you must supply an index.ddoc when deleting\");if(!t.name)throw new Error(\"you must supply an index.name when deleting\");var r=t.ddoc,o=t.name;return he.upsert(e,r,n).then(function(){return we.viewCleanup.apply(e)}).then(function(){return{ok:!0}})}var he=e(42),pe=e(38),ve=e(32),ye=e(41),ge=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(34)),me=e(36),_e=e(40),be=f(function(e){for(var t=[],n=0,r=e.length;n<r;n++){var o=e[n];Array.isArray(o)?t=t.concat(be.apply(null,o)):t.push(o)}return t}),we=ge(\"indexes\",x,I,D),ke=null,Ee={\"￿\":{}},Se=[\"$eq\",\"$gt\",\"$gte\",\"$lt\",\"$lte\"],Oe=l(P),Ae=l(fe),je=l(le),xe=l(U),Ie=l(de),De={};De.createIndex=he.toPromise(function(e,t){if(\"object\"!=typeof e)return t(new Error(\"you must provide an index to create\"));(he.isRemote(this)?i:Oe)(this,e,t)}),De.find=he.toPromise(function(e,t){if(void 0===t&&(t=e,e=void 0),\"object\"!=typeof e)return t(new Error(\"you must provide search parameters to find()\"));(he.isRemote(this)?a:Ae)(this,e,t)}),De.explain=he.toPromise(function(e,t){if(void 0===t&&(t=e,e=void 0),\"object\"!=typeof e)return t(new Error(\"you must provide search parameters to explain()\"));(he.isRemote(this)?s:je)(this,e,t)}),De.getIndexes=he.toPromise(function(e){(he.isRemote(this)?u:xe)(this,e)}),De.deleteIndex=he.toPromise(function(e,t){if(\"object\"!=typeof e)return t(new Error(\"you must provide an index to delete\"));(he.isRemote(this)?c:Ie)(this,e,t)}),t.exports=De},{32:32,34:34,36:36,38:38,40:40,41:41,42:42}],34:[function(e,t,n){\"use strict\";function r(){this.promise=new Promise(function(e){e()})}function o(e){if(!e)return\"undefined\";switch(typeof e){case\"function\":case\"string\":return e.toString();default:return JSON.stringify(e)}}function i(e,t){return o(e)+o(t)+\"undefined\"}function a(e,t,n,r,o,a){var s,u=i(n,r);if(!o&&(s=e._cachedViews=e._cachedViews||{},s[u]))return s[u];var c=e.info().then(function(i){function c(e){e.views=e.views||{};var n=t;-1===n.indexOf(\"/\")&&(n=t+\"/\"+t);var r=e.views[n]=e.views[n]||{};if(!r[f])return r[f]=!0,e}var f=i.db_name+\"-mrview-\"+(o?\"temp\":d.stringMd5(u));return l.upsert(e,\"_local/\"+a,c).then(function(){return e.registerDependentDatabase(f).then(function(t){var o=t.db;o.auto_compaction=!0;var i={name:f,db:o,sourceDB:e,adapter:e.adapter,mapFun:n,reduceFun:r};return i.db.get(\"_local/lastSeq\").catch(function(e){if(404!==e.status)throw e}).then(function(e){return i.seq=e?e.seq:0,s&&i.db.once(\"destroyed\",function(){delete s[u]}),i})})})});return s&&(s[u]=c),c}function s(e){return-1===e.indexOf(\"/\")?[e,e]:e.split(\"/\")}function u(e){return 1===e.length&&/^1-/.test(e[0].rev)}function c(e,t){try{e.emit(\"error\",t)}catch(e){l.guardedConsole(\"error\",\"The user's map/reduce function threw an uncaught error.\\nYou can debug this error by doing:\\nmyDatabase.on('error', function (err) { debugger; });\\nPlease double-check your map/reduce function.\"),l.guardedConsole(\"error\",t)}}function f(e,t,n,o){function i(e,t,n){try{t(n)}catch(t){c(e,t)}}function f(e,t,n,r,o){try{return{output:t(n,r,o)}}catch(t){return c(e,t),{error:t}}}function d(e,t){var n=v.collate(e.key,t.key);return 0!==n?n:v.collate(e.value,t.value)}function k(e,t,n){return n=n||0,\"number\"==typeof t?e.slice(n,t+n):n>0?e.slice(n):e}function E(e){var t=e.value;return t&&\"object\"==typeof t&&t._id||e.id}function S(e){e.rows.forEach(function(e){var t=e.doc&&e.doc._attachments;t&&Object.keys(t).forEach(function(e){var n=t[e];t[e].data=p.base64StringToBlobOrBuffer(n.data,n.content_type)})})}function O(e){return function(t){return e.include_docs&&e.attachments&&e.binary&&S(t),t}}function A(e,t,n,r){var o=t[e];void 0!==o&&(r&&(o=encodeURIComponent(JSON.stringify(o))),n.push(e+\"=\"+o))}function j(e){if(void 0!==e){var t=Number(e);return isNaN(t)||t!==parseInt(e,10)?e:t}}function x(e){return e.group_level=j(e.group_level),e.limit=j(e.limit),e.skip=j(e.skip),e}function I(e){if(e){if(\"number\"!=typeof e)return new m.QueryParseError('Invalid value for integer: \"'+e+'\"');if(e<0)return new m.QueryParseError('Invalid value for positive integer: \"'+e+'\"')}}function D(e,t){var n=e.descending?\"endkey\":\"startkey\",r=e.descending?\"startkey\":\"endkey\";if(void 0!==e[n]&&void 0!==e[r]&&v.collate(e[n],e[r])>0)throw new m.QueryParseError(\"No rows can match your key range, reverse your start_key and end_key or set {descending : true}\");if(t.reduce&&!1!==e.reduce){if(e.include_docs)throw new m.QueryParseError(\"{include_docs:true} is invalid for reduce\");if(e.keys&&e.keys.length>1&&!e.group&&!e.group_level)throw new m.QueryParseError(\"Multi-key fetches for reduce views must use {group: true}\")}[\"group_level\",\"limit\",\"skip\"].forEach(function(t){var n=I(e[t]);if(n)throw n})}function q(e,t,n){var r,o,i,a=[],u=\"GET\";if(A(\"reduce\",n,a),A(\"include_docs\",n,a),A(\"attachments\",n,a),A(\"limit\",n,a),A(\"descending\",n,a),A(\"group\",n,a),A(\"group_level\",n,a),A(\"skip\",n,a),A(\"stale\",n,a),A(\"conflicts\",n,a),A(\"startkey\",n,a,!0),A(\"start_key\",n,a,!0),A(\"endkey\",n,a,!0),A(\"end_key\",n,a,!0),A(\"inclusive_end\",n,a),A(\"key\",n,a,!0),A(\"update_seq\",n,a),a=a.join(\"&\"),a=\"\"===a?\"\":\"?\"+a,void 0!==n.keys){var c=\"keys=\"+encodeURIComponent(JSON.stringify(n.keys));c.length+a.length+1<=2e3?a+=(\"?\"===a[0]?\"&\":\"?\")+c:(u=\"POST\",\"string\"==typeof t?r={keys:n.keys}:t.keys=n.keys)}if(\"string\"==typeof t){var f=s(t);return e.fetch(\"_design/\"+f[0]+\"/_view/\"+f[1]+a,{headers:new g.Headers({\"Content-Type\":\"application/json\"}),method:u,body:JSON.stringify(r)}).then(function(e){return o=e.ok,i=e.status,e.json()}).then(function(e){if(!o)throw e.status=i,y.generateErrorFromResponse(e);return e.rows.forEach(function(e){if(e.value&&e.value.error&&\"builtin_reduce_error\"===e.value.error)throw new Error(e.reason)}),e}).then(O(n))}return r=r||{},Object.keys(t).forEach(function(e){Array.isArray(t[e])?r[e]=t[e]:r[e]=t[e].toString()}),e.fetch(\"_temp_view\"+a,{headers:new g.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\",body:JSON.stringify(r)}).then(function(e){return o=e.ok,i=e.status,e.json()}).then(function(e){if(!o)throw e.status=i,y.generateErrorFromResponse(e);return e}).then(O(n))}function C(e,t,n){return new Promise(function(r,o){e._query(t,n,function(e,t){if(e)return o(e);r(t)})})}function B(e){return new Promise(function(t,n){e._viewCleanup(function(e,r){if(e)return n(e);t(r)})})}function R(e){return function(t){if(404===t.status)return e;throw t}}function T(e,t,n){function r(e){return e.keys.length?t.db.allDocs({keys:e.keys,include_docs:!0}):Promise.resolve({rows:[]})}function o(e,t){for(var n=[],r=new h.Set,o=0,i=t.rows.length;o<i;o++){var a=t.rows[o],s=a.doc;if(s&&(n.push(s),r.add(s._id),s._deleted=!c.has(s._id),!s._deleted)){var u=c.get(s._id);\"value\"in u&&(s.value=u.value)}}var f=m.mapToKeysArray(c);return f.forEach(function(e){if(!r.has(e)){var t={_id:e},o=c.get(e);\"value\"in o&&(t.value=o.value),n.push(t)}}),e.keys=m.uniq(f.concat(e.keys)),n.push(e),n}var i=\"_local/doc_\"+e,a={_id:i,keys:[]},s=n.get(e),c=s[0],f=s[1];return function(){return u(f)?Promise.resolve(a):t.db.get(i).catch(R(a))}().then(function(e){return r(e).then(function(t){return o(e,t)})})}function $(e,t,n){return e.db.get(\"_local/lastSeq\").catch(R({_id:\"_local/lastSeq\",seq:0})).then(function(r){var o=m.mapToKeysArray(t);return Promise.all(o.map(function(n){return T(n,e,t)})).then(function(t){var o=l.flatten(t);return r.seq=n,o.push(r),e.db.bulkDocs({docs:o})})})}function L(e){var t=\"string\"==typeof e?e:e.name,n=_[t];return n||(n=_[t]=new r),n}function N(e){return m.sequentialize(L(e),function(){return M(e)})()}function M(e){function n(e,t){var n={id:l._id,key:v.normalizeKey(e)};void 0!==t&&null!==t&&(n.value=v.normalizeKey(t)),f.push(n)}function o(t,n){return function(){return $(e,t,n)}}function a(){return e.sourceDB.changes({return_docs:!0,conflicts:!0,include_docs:!0,style:\"all_docs\",since:y,limit:w}).then(s)}function s(e){var t=e.results;if(t.length){var n=u(t);if(g.add(o(n,y)),!(t.length<w))return a()}}function u(t){for(var n=new h.Map,r=0,o=t.length;r<o;r++){var a=t[r];if(\"_\"!==a.doc._id[0]){f=[],l=a.doc,l._deleted||i(e.sourceDB,p,l),f.sort(d);var s=c(f);n.set(a.doc._id,[s,a.changes])}y=a.seq}return n}function c(e){for(var t,n=new h.Map,r=0,o=e.length;r<o;r++){var i=e[r],a=[i.key,i.id];r>0&&0===v.collate(i.key,t)&&a.push(r),n.set(v.toIndexableString(a),i),t=i.key}return n}var f,l,p=t(e.mapFun,n),y=e.seq||0,g=new r;return a().then(function(){return g.finish()}).then(function(){e.seq=y})}function F(e,t,r){0===r.group_level&&delete r.group_level;var o=r.group||r.group_level,i=n(e.reduceFun),a=[],s=isNaN(r.group_level)?Number.POSITIVE_INFINITY:r.group_level;t.forEach(function(e){var t=a[a.length-1],n=o?e.key:null;if(o&&Array.isArray(n)&&(n=n.slice(0,s)),t&&0===v.collate(t.groupKey,n))return t.keys.push([e.key,e.id]),void t.values.push(e.value);a.push({keys:[[e.key,e.id]],values:[e.value],groupKey:n})}),t=[];for(var u=0,c=a.length;u<c;u++){var l=a[u],d=f(e.sourceDB,i,l.keys,l.values,!1);if(d.error&&d.error instanceof m.BuiltInError)throw d.error;t.push({value:d.error?null:d.output,key:l.groupKey})}return{rows:k(t,r.limit,r.skip)}}function P(e,t){return m.sequentialize(L(e),function(){return U(e,t)})()}function U(e,t){function n(t){return t.include_docs=!0,e.db.allDocs(t).then(function(e){return o=e.total_rows,e.rows.map(function(e){if(\"value\"in e.doc&&\"object\"==typeof e.doc.value&&null!==e.doc.value){var t=Object.keys(e.doc.value).sort(),n=[\"id\",\"key\",\"value\"];if(!(t<n||t>n))return e.doc.value}var r=v.parseIndexableString(e.doc._id);return{key:r[0],id:r[1],value:\"value\"in e.doc?e.doc.value:null}})})}function r(n){var r;if(r=i?F(e,n,t):{total_rows:o,offset:a,rows:n},t.update_seq&&(r.update_seq=e.seq),t.include_docs){var s=m.uniq(n.map(E));return e.sourceDB.allDocs({keys:s,include_docs:!0,conflicts:t.conflicts,attachments:t.attachments,binary:t.binary}).then(function(e){var t=new h.Map;return e.rows.forEach(function(e){t.set(e.id,e.doc)}),n.forEach(function(e){var n=E(e),r=t.get(n);r&&(e.doc=r)}),r})}return r}var o,i=e.reduceFun&&!1!==t.reduce,a=t.skip||0;if(void 0===t.keys||t.keys.length||(t.limit=0,delete t.keys),void 0!==t.keys){var s=t.keys,u=s.map(function(e){var r={startkey:v.toIndexableString([e]),endkey:v.toIndexableString([e,{}])};return t.update_seq&&(r.update_seq=!0),n(r)});return Promise.all(u).then(l.flatten).then(r)}var c={descending:t.descending};t.update_seq&&(c.update_seq=!0);var f,d;if(\"start_key\"in t&&(f=t.start_key),\"startkey\"in t&&(f=t.startkey),\"end_key\"in t&&(d=t.end_key),\"endkey\"in t&&(d=t.endkey),void 0!==f&&(c.startkey=t.descending?v.toIndexableString([f,{}]):v.toIndexableString([f])),void 0!==d){var p=!1!==t.inclusive_end;t.descending&&(p=!p),c.endkey=v.toIndexableString(p?[d,{}]:[d])}if(void 0!==t.key){var y=v.toIndexableString([t.key]),g=v.toIndexableString([t.key,{}]);c.descending?(c.endkey=y,c.startkey=g):(c.startkey=y,c.endkey=g)}return i||(\"number\"==typeof t.limit&&(c.limit=t.limit),c.skip=a),n(c).then(r)}function z(e){return e.fetch(\"_view_cleanup\",{headers:new g.Headers({\"Content-Type\":\"application/json\"}),method:\"POST\"}).then(function(e){return e.json()})}function K(t){return t.get(\"_local/\"+e).then(function(e){var n=new h.Map;Object.keys(e.views).forEach(function(e){var t=s(e),r=\"_design/\"+t[0],o=t[1],i=n.get(r);i||(i=new h.Set,n.set(r,i)),i.add(o)});var r={keys:m.mapToKeysArray(n),include_docs:!0};return t.allDocs(r).then(function(r){var o={};r.rows.forEach(function(t){var r=t.key.substring(8);n.get(t.key).forEach(function(n){var i=r+\"/\"+n;e.views[i]||(i=n);var a=Object.keys(e.views[i]),s=t.doc&&t.doc.views&&t.doc.views[n];a.forEach(function(e){o[e]=o[e]||s})})});var i=Object.keys(o).filter(function(e){return!o[e]}),a=i.map(function(e){return m.sequentialize(L(e),function(){return new t.constructor(e,t.__opts).destroy()})()});return Promise.all(a).then(function(){return{ok:!0}})})},R({ok:!0}))}function G(t,n,r){if(\"function\"==typeof t._query)return C(t,n,r);if(l.isRemote(t))return q(t,n,r);if(\"string\"!=typeof n)return D(r,n),b.add(function(){return a(t,\"temp_view/temp_view\",n.map,n.reduce,!0,e).then(function(e){return m.fin(N(e).then(function(){return P(e,r)}),function(){return e.db.destroy()})})}),b.finish();var i=n,u=s(i),c=u[0],f=u[1];return t.get(\"_design/\"+c).then(function(n){var s=n.views&&n.views[f];if(!s)throw new m.NotFoundError(\"ddoc \"+n._id+\" has no view named \"+f);return o(n,f),D(r,s),a(t,i,s.map,s.reduce,!1,e).then(function(e){return\"ok\"===r.stale||\"update_after\"===r.stale?(\"update_after\"===r.stale&&l.nextTick(function(){N(e)}),P(e,r)):N(e).then(function(){return P(e,r)})})})}function J(e,t,n){var r=this;\"function\"==typeof t&&(n=t,t={}),t=t?x(t):{},\"function\"==typeof e&&(e={map:e});var o=Promise.resolve().then(function(){return G(r,e,t)});return m.promisedCallback(o,n),o}return{query:J,viewCleanup:m.callbackify(function(){var e=this;return\"function\"==typeof e._viewCleanup?B(e):l.isRemote(e)?z(e):K(e)})}}var l=e(42),d=e(40),h=e(37),p=e(35),v=e(36),y=e(38),g=e(32),m=e(39);r.prototype.add=function(e){return this.promise=this.promise.catch(function(){}).then(function(){return e()}),this.promise},r.prototype.finish=function(){return this.promise};var _={},b=new r,w=50;t.exports=f},{32:32,35:35,36:36,37:37,38:38,39:39,40:40,42:42}],35:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)\n}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function a(e,t){return i(h(e),t)}function s(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function u(e,t){var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";if(r)return t(n);t(s(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}function f(e,t){c(e,function(e){t(p(e))})}function l(e,t){var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=a,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=l,n.readAsBinaryString=u,n.typedBuffer=d},{}],36:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}function o(e,t,n){return r(e,t,n)+e}function i(e,t){if(e===t)return 0;e=a(e),t=a(t);var n=v(e),r=v(t);if(n-r!=0)return n-r;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e<t?-1:1;case\"string\":return h(e,t)}return Array.isArray(e)?d(e,t):p(e,t)}function a(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var n=e.length;e=new Array(n);for(var r=0;r<n;r++)e[r]=a(t[r])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var o in t)if(t.hasOwnProperty(o)){var i=t[o];void 0!==i&&(e[o]=a(i))}}}}return e}function s(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return y(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),n=t?e:Object.keys(e),r=-1,o=n.length,i=\"\";if(t)for(;++r<o;)i+=u(n[r]);else for(;++r<o;){var a=n[r];i+=u(a)+u(e[a])}return i}return\"\"}function u(e){return e=a(e),v(e)+_+s(e)+\"\\0\"}function c(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t];t++;var i=\"\",a=e.substring(t,t+m),s=parseInt(a,10)+g;for(o&&(s=-s),t+=m;;){var u=e[t];if(\"\\0\"===u)break;i+=u,t++}i=i.split(\".\"),n=1===i.length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==s&&(n=parseFloat(n+\"e\"+s))}return{num:n,length:t-r}}function f(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var a=e.pop();o[a]=n}else e.push(n)}}function l(e){for(var t=[],n=[],r=0;;){var o=e[r++];if(\"\\0\"!==o)switch(o){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var i=c(e,r);t.push(i.num),r+=i.length;break;case\"4\":for(var a=\"\";;){var s=e[r];if(\"\\0\"===s)break;a+=s,r++}a=a.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(a);break;case\"5\":var u={element:[],index:t.length};t.push(u.element),n.push(u);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+o)}else{if(1===t.length)return t.pop();f(t,n)}}}function d(e,t){for(var n=Math.min(e.length,t.length),r=0;r<n;r++){var o=i(e[r],t[r]);if(0!==o)return o}return e.length===t.length?0:e.length>t.length?1:-1}function h(e,t){return e===t?0:e>t?1:-1}function p(e,t){for(var n=Object.keys(e),r=Object.keys(t),o=Math.min(n.length,r.length),a=0;a<o;a++){var s=i(n[a],r[a]);if(0!==s)return s;if(0!==(s=i(e[n[a]],t[r[a]])))return s}return n.length===r.length?0:n.length>r.length?1:-1}function v(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function y(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,i=r?\"0\":\"2\",a=(r?-n:n)-g,s=o(a.toString(),\"0\",m);i+=_+s;var u=Math.abs(parseFloat(t[0]));r&&(u=10-u);var c=u.toFixed(20);return c=c.replace(/\\.?0+$/,\"\"),i+=_+c}Object.defineProperty(n,\"__esModule\",{value:!0});var g=-324,m=3,_=\"\";n.collate=i,n.normalizeKey=a,n.toIndexableString=u,n.parseIndexableString=l},{}],37:[function(e,t,n){\"use strict\";function r(e){return\"$\"+e}function o(e){return e.substring(1)}function i(){this._store={}}function a(e){if(this._store=new i,e&&Array.isArray(e))for(var t=0,n=e.length;t<n;t++)this.add(e[t])}Object.defineProperty(n,\"__esModule\",{value:!0}),i.prototype.get=function(e){var t=r(e);return this._store[t]},i.prototype.set=function(e,t){var n=r(e);return this._store[n]=t,!0},i.prototype.has=function(e){return r(e)in this._store},i.prototype.delete=function(e){var t=r(e),n=t in this._store;return delete this._store[t],n},i.prototype.forEach=function(e){for(var t=Object.keys(this._store),n=0,r=t.length;n<r;n++){var i=t[n],a=this._store[i];i=o(i),e(a,i)}},Object.defineProperty(i.prototype,\"size\",{get:function(){return Object.keys(this._store).length}}),a.prototype.add=function(e){return this._store.set(e,!0)},a.prototype.has=function(e){return this._store.has(e)},a.prototype.forEach=function(e){this._store.forEach(function(t,n){e(n)})},Object.defineProperty(a.prototype,\"size\",{get:function(){return this._store.size}}),!function(){if(\"undefined\"==typeof Symbol||\"undefined\"==typeof Map||\"undefined\"==typeof Set)return!1;var e=Object.getOwnPropertyDescriptor(Map,Symbol.species);return e&&\"get\"in e&&Map[Symbol.species]===Map}()?(n.Set=a,n.Map=i):(n.Set=Set,n.Map=Map)},{}],38:[function(e,t,n){arguments[4][30][0].apply(n,arguments)},{12:12,30:30}],39:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,o)}catch(e){}}function i(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,i)}catch(e){}}function a(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,a)}catch(e){}}function s(e,t){return t&&e.then(function(e){y.nextTick(function(){t(null,e)})},function(e){y.nextTick(function(){t(e)})}),e}function u(e){return v(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&s(r,n),r})}function c(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})}function f(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}}function l(e){var t=new p.Set(e),n=new Array(t.size),r=-1;return t.forEach(function(e){n[++r]=e}),n}function d(e){var t=new Array(e.size),n=-1;return e.forEach(function(e,r){t[++n]=r}),t}Object.defineProperty(n,\"__esModule\",{value:!0});var h=r(e(12)),p=e(37),v=r(e(7)),y=e(42);h(o,Error),h(i,Error),h(a,Error),n.uniq=l,n.sequentialize=f,n.fin=c,n.callbackify=u,n.promisedCallback=s,n.mapToKeysArray=d,n.QueryParseError=o,n.NotFoundError=i,n.BuiltInError=a},{12:12,37:37,42:42,7:7}],40:[function(e,t,n){(function(t){\"use strict\";function r(e){return c.btoa(e)}function o(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}function i(e,t,n,r,i){(n>0||r<t.size)&&(t=o(t,n,r)),c.readAsArrayBuffer(t,function(t){e.append(t),i()})}function a(e,t,n,r,o){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}function s(e,t){function n(){l(s)}function o(){var e=y.end(!0),n=r(e);t(n),y.destroy()}function s(){var t=v*h,r=t+h;v++,v<p?g(y,e,t,r,n):g(y,e,t,r,o)}var u=\"string\"==typeof e,c=u?e.length:e.size,h=Math.min(d,c),p=Math.ceil(c/h),v=0,y=u?new f:new f.ArrayBuffer,g=u?a:i;s()}function u(e){return f.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var c=e(35),f=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(74)),l=t.setImmediate||t.setTimeout,d=32768;n.binaryMd5=s,n.stringMd5=u}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{35:35,74:74}],41:[function(e,t,n){\"use strict\";function r(e,t){for(var n=e,r=0,o=t.length;r<o;r++){if(!(n=n[t[r]]))break}return n}function o(e,t,n){for(var r=0,o=t.length;r<o-1;r++){e=e[t[r]]={}}e[t[o-1]]=n}function i(e,t){return e<t?-1:e>t?1:0}function a(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?r>0&&\"\\\\\"===e[r-1]?n=n.substring(0,n.length-1)+\".\":(t.push(n),n=\"\"):n+=i}return t.push(n),t}function s(e){return B.indexOf(e)>-1}function u(e){return Object.keys(e)[0]}function c(e){return e[u(e)]}function f(e){var t={};return e.forEach(function(e){Object.keys(e).forEach(function(n){var r=e[n];if(\"object\"!=typeof r&&(r={$eq:r}),s(n))r instanceof Array?t[n]=r.map(function(e){return f([e])}):t[n]=f([r]);else{var o=t[n]=t[n]||{};Object.keys(r).forEach(function(e){var t=r[e];return\"$gt\"===e||\"$gte\"===e?l(e,t,o):\"$lt\"===e||\"$lte\"===e?d(e,t,o):\"$ne\"===e?h(t,o):\"$eq\"===e?p(t,o):void(o[e]=t)})}})}),t}function l(e,t,n){void 0===n.$eq&&(void 0!==n.$gte?\"$gte\"===e?t>n.$gte&&(n.$gte=t):t>=n.$gte&&(delete n.$gte,n.$gt=t):void 0!==n.$gt?\"$gte\"===e?t>n.$gt&&(delete n.$gt,n.$gte=t):t>n.$gt&&(n.$gt=t):n[e]=t)}function d(e,t,n){void 0===n.$eq&&(void 0!==n.$lte?\"$lte\"===e?t<n.$lte&&(n.$lte=t):t<=n.$lte&&(delete n.$lte,n.$lt=t):void 0!==n.$lt?\"$lte\"===e?t<n.$lt&&(delete n.$lt,n.$lte=t):t<n.$lt&&(n.$lt=t):n[e]=t)}function h(e,t){\"$ne\"in t?t.$ne.push(e):t.$ne=[e]}function p(e,t){delete t.$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,t.$eq=e}function v(e){var t=q.clone(e),n=!1;\"$and\"in t&&(t=f(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=f([t.$not]));for(var r=Object.keys(t),o=0;o<r.length;o++){var i=r[o],a=t[i];\"object\"!=typeof a||null===a?a={$eq:a}:\"$ne\"in a&&!n&&(a.$ne=[a.$ne]),t[i]=a}return t}function y(e){function t(t){return e.map(function(e){var n=u(e),o=a(n);return r(t,o)})}return function(e,n){var r=t(e.doc),o=t(n.doc),a=C.collate(r,o);return 0!==a?a:i(e.doc._id,n.doc._id)}}function g(e,t,n){if(e=e.filter(function(e){return m(e.doc,t.selector,n)}),t.sort){var r=y(t.sort);e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===c(t.sort[0])&&(e=e.reverse())}if(\"limit\"in t||\"skip\"in t){var o=t.skip||0,i=(\"limit\"in t?t.limit:e.length)+o;e=e.slice(o,i)}return e}function m(e,t,n){return n.every(function(n){var o=t[n],i=a(n),u=r(e,i);return s(n)?b(n,o,e):_(o,e,i,u)})}function _(e,t,n,r){return!e||Object.keys(e).every(function(o){var i=e[o];return w(o,t,i,n,r)})}function b(e,t,n){return\"$or\"===e?t.some(function(e){return m(n,e,Object.keys(e))}):\"$not\"===e?!m(n,t,Object.keys(t)):!t.find(function(e){return m(n,e,Object.keys(e))})}function w(e,t,n,r,o){if(!R[e])throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type, $allMatch or $all');return R[e](t,n,r,o)}function k(e){return void 0!==e&&null!==e}function E(e){return void 0!==e}function S(e,t){var n=t[0],r=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(r,10)!==r)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===r}function O(e,t){return t.some(function(t){return e instanceof Array?e.indexOf(t)>-1:e===t})}function A(e,t){return t.every(function(t){return e.indexOf(t)>-1})}function j(e,t){return e.length===t}function x(e,t){return new RegExp(t).test(e)}function I(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}function D(e,t){if(\"object\"!=typeof t)throw new Error(\"Selector error: expected a JSON object\");t=v(t);var n={doc:e},r=g([n],{selector:t},Object.keys(t));return r&&1===r.length}Object.defineProperty(n,\"__esModule\",{value:!0});var q=e(42),C=e(36),B=[\"$or\",\"$nor\",\"$not\"],R={$elemMatch:function(e,t,n,r){return!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.some(function(e){return m(e,t,Object.keys(t))}):r.some(function(r){return _(t,e,n,r)})))},$allMatch:function(e,t,n,r){return!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.every(function(e){return m(e,t,Object.keys(t))}):r.every(function(r){return _(t,e,n,r)})))},$eq:function(e,t,n,r){return E(r)&&0===C.collate(r,t)},$gte:function(e,t,n,r){return E(r)&&C.collate(r,t)>=0},$gt:function(e,t,n,r){return E(r)&&C.collate(r,t)>0},$lte:function(e,t,n,r){return E(r)&&C.collate(r,t)<=0},$lt:function(e,t,n,r){return E(r)&&C.collate(r,t)<0},$exists:function(e,t,n,r){return t?E(r):!E(r)},$mod:function(e,t,n,r){return k(r)&&S(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==C.collate(r,e)})},$in:function(e,t,n,r){return k(r)&&O(r,t)},$nin:function(e,t,n,r){return k(r)&&!O(r,t)},$size:function(e,t,n,r){return k(r)&&j(r,t)},$all:function(e,t,n,r){return Array.isArray(r)&&A(r,t)},$regex:function(e,t,n,r){return k(r)&&x(r,t)},$type:function(e,t,n,r){return I(r,t)}};n.massageSelector=v,n.matchesSelector=D,n.filterInMemoryFields=g,n.createFieldSorter=y,n.rowFilter=m,n.isCombinationalField=s,n.getKey=u,n.getValue=c,n.getFieldFromDoc=r,n.setFieldInDoc=o,n.compare=i,n.parseField=a},{36:36,42:42}],42:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function a(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function s(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&Q.call(n)==H}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return a(e);if(!s(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);void 0!==i&&(t[n]=i)}return t}function c(e){var t=!1;return M(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return M(function(t){t=u(t);var n=this,r=\"function\"==typeof t[t.length-1]&&t.pop(),o=new Promise(function(r,o){var i;try{var a=c(function(e,t){e?o(e):r(t)});t.push(a),i=e.apply(n,t),i&&\"function\"==typeof i.then&&r(i)}catch(e){o(e)}});return r&&o.then(function(e){r(null,e)},r),o})}function l(e,t,n){if(e.constructor.listeners(\"debug\").length){for(var r=[\"api\",e.name,t],o=0;o<n.length-1;o++)r.push(n[o]);e.constructor.emit(\"debug\",r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[\"api\",e.name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),e.constructor.emit(\"debug\",o),i(n,r)}}}function d(e,t){return f(M(function(n){if(this._closed)return Promise.reject(new Error(\"database is closed\"));if(this._destroyed)return Promise.reject(new Error(\"database is destroyed\"));var r=this;return l(r,e,n),this.taskqueue.isReady?t.apply(this,n):new Promise(function(t,o){r.taskqueue.addTask(function(i){i?o(i):t(r[e].apply(r,n))})})}))}function h(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function p(e){return e}function v(e){return[{ok:e}]}function y(e,t,n){function r(){var e=[];d.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){d[e]={id:t,docs:n},o()}function a(){if(!(g>=y.length)){var e=Math.min(g+W,y.length),t=y.slice(g,e);s(t,g),g+=t.length}}function s(n,r){n.forEach(function(n,o){var s=r+o,u=c.get(n),f=h(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=v),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(s,n,r),a()})})}var u=t.docs,c=new F.Map;u.forEach(function(e){c.has(e.id)?c.get(e.id).push(e):c.set(e.id,[e])});var f=c.size,l=0,d=new Array(f),y=[];c.forEach(function(e,t){y.push(t)});var g=0;a()}function g(){return N}function m(e){g()&&addEventListener(\"storage\",function(t){e.emit(t.key)})}function _(){U.EventEmitter.call(this),this._listeners={},m(this)}function b(e){if(\"undefined\"!=typeof console&&\"function\"==typeof console[e]){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function w(e,t){return e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>6e5&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}function k(e){var t=0;return e||(t=2e3),w(e,t)}function E(e,t){b(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function S(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return K.createError(K.BAD_REQUEST,r)}}function O(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&S(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function A(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function j(){}function x(e){var t;if(e?\"string\"!=typeof e?t=K.createError(K.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=K.createError(K.RESERVED_ID)):t=K.createError(K.MISSING_ID),t)throw t}function I(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(b(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())}function D(e,t){return\"listenerCount\"in e?e.listenerCount(t):U.EventEmitter.listenerCount(e,t)}function q(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function C(e){var t=q(e);return t?t.join(\"/\"):null}function B(e){for(var t=ie.exec(e),n={},r=14;r--;){var o=ne[r],i=t[r]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);n[o]=a?decodeURIComponent(i):i}return n[re]={},n[ne[12]].replace(oe,function(e,t,r){t&&(n[re][t]=r)}),n}function R(e,t){var n=[],r=[];for(var o in t)t.hasOwnProperty(o)&&(n.push(o),r.push(t[o]));return n.push(e),Function.apply(null,n).apply(null,r)}function T(e,t,n){return new Promise(function(r,o){e.get(t,function(i,a){if(i){if(404!==i.status)return o(i);a={}}var s=a._rev,u=n(a);if(!u)return r({updated:!1,rev:s});u._id=t,u._rev=s,r($(e,u,n))})})}function $(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return T(e,t._id,n)})}function L(e,t){var n=V.clone(e);return t?(delete n._rev_tree,J.stringMd5(JSON.stringify(n))):G.v4().replace(/-/g,\"\").toLowerCase()}Object.defineProperty(n,\"__esModule\",{value:!0});var N,M=r(e(7)),F=e(37),P=r(e(11)),U=e(10),z=r(e(12)),K=e(38),G=r(e(75)),J=e(40),V=e(42),Q=Function.prototype.toString,H=Q.call(Object),W=6;try{localStorage.setItem(\"_pouch_check_localstorage\",1),N=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){N=!1}z(_,U.EventEmitter),_.prototype.addListener=function(e,t,n,r){function o(){function e(){a=!1}if(i._listeners[t]){if(a)return void(a=\"waiting\");a=!0;var s=h(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\",\"return_docs\"]);n.changes(s).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===a&&P(o),a=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,a=!1;this._listeners[t]=o,this.on(e,o)}},_.prototype.removeListener=function(e,t){t in this._listeners&&(U.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},_.prototype.notifyLocalWindows=function(e){g()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},_.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var X;X=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};var Y,Z=X,ee=j.name;Y=ee?function(e){return e.name}:function(e){var t=e.toString().match(/^\\s*function\\s*(?:(\\S+)\\s*)?\\(/);return t&&t[1]?t[1]:\"\"};var te=Y,ne=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],re=\"queryKey\",oe=/(?:^|&)([^&=]*)=?([^&]*)/g,ie=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,ae=G.v4;n.adapterFun=d,n.assign=Z,n.bulkGetShim=y,n.changesHandler=_,n.clone=u,n.defaultBackOff=k,n.explainError=E,n.filterChange=O,n.flatten=A,n.functionName=te,n.guardedConsole=b,n.hasLocalStorage=g,n.invalidIdError=x,n.isRemote=I,n.listenerCount=D,n.nextTick=P,n.normalizeDdocFunctionName=C,n.once=c,n.parseDdocFunctionName=q,n.parseUri=B,n.pick=h,n.rev=L,n.scopeEval=R,n.toPromise=f,n.upsert=T,n.uuid=ae},{10:10,11:11,12:12,37:37,38:38,40:40,42:42,7:7,75:75}],43:[function(e,t,n){\"use strict\";function r(e){return Object.keys(e).sort(s.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function o(e,t,n){var o=n.doc_ids?n.doc_ids.sort(s.collate):\"\",u=n.filter?n.filter.toString():\"\",c=\"\",f=\"\",l=\"\";return n.selector&&(l=JSON.stringify(n.selector)),n.filter&&n.query_params&&(c=JSON.stringify(r(n.query_params))),n.filter&&\"_view\"===n.filter&&(f=n.view.toString()),i.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+u+f+c+o+l;return new i(function(e){a.binaryMd5(t,e)})}).then(function(e){return\"_local/\"+(e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"))})}var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(68)),a=e(66),s=e(23);t.exports=o},{23:23,66:66,68:68}],44:[function(e,t,n){\"use strict\";function r(e){try{return JSON.parse(e)}catch(t){return i.parse(e)}}function o(e){try{return JSON.stringify(e)}catch(t){return i.stringify(e)}}Object.defineProperty(n,\"__esModule\",{value:!0});var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(80));n.safeJsonParse=r,n.safeJsonStringify=o},{80:80}],45:[function(e,t,n){\"use strict\";function r(e){var t=[],n=0;try{e.split(\"\\n\").forEach(function(e){e&&(e=JSON.parse(e),e.docs&&(t=t.concat(e.docs)),e.seq&&(n=e.seq))})}catch(e){return{err:e}}return{docs:t,lastSeq:n}}function o(e,t,n,o){function i(){return e.info().then(function(t){var r=new e.constructor(n.proxy,a.extend(!0,{},{},n)),o=new e.constructor(t.db_name,a.extend(!0,{},e.__opts,n)),i={};return n.filter&&(i.filter=n.filter),n.query_params&&(i.query_params=n.query_params),n.view&&(i.view=n.view),c(r,o,i).then(function(e){return new u(r,o,e,{cancelled:!1}).writeCheckpoint(l)})})}var s=r(t);if(s.err)return o(s.err);var f=s.docs,l=s.lastSeq;e.bulkDocs({docs:f,new_edits:!1}).then(function(){if(n.proxy)return i()}).then(function(){o()},o)}function i(e,t,n,r){var i={url:t,json:!1};n.ajax&&(i=a.extend(!0,i,n.ajax)),s(i,function(t,i){if(t)return r(t);o(e,i,n,r)})}var a=e(46),s=e(51),u=e(53),c=e(58);n.load=a.toPromise(function(e,t,n){var r=this;return\"function\"==typeof t&&(n=t,t={}),/^\\s*\\{/.test(e)?o(r,e,t,n):i(r,e,t,n)}),\"undefined\"!=typeof window&&window.PouchDB&&window.PouchDB.plugin(n)},{46:46,51:51,53:53,58:58}],46:[function(e,t,n){(function(t,r){\"use strict\";var o=e(60),i=e(61);n.uuid=i.uuid,n.extend=e(31),n.once=function(e){var t=!1;return n.getArguments(function(n){if(t)throw console.trace(),new Error(\"once called  more than once\");t=!0,e.apply(this,n)})},n.getArguments=e(7),n.toPromise=function(e){return n.getArguments(function(r){var i,a=this,s=\"function\"==typeof r[r.length-1]&&r.pop();s&&(i=function(e,n){t.nextTick(function(){s(e,n)})});var u=new o(function(t,o){try{var i=n.once(function(e,n){e?o(e):t(n)});r.push(i),e.apply(a,r)}catch(e){o(e)}});return i&&u.then(function(e){i(null,e)},i),u.cancel=function(){return this},u})},n.inherits=e(12),n.Promise=o,n.explain404=function(e){t.browser&&\"console\"in r&&\"info\"in console&&console.info(\"The above 404 is totally normal. \"+e+\"\\n♥ the PouchDB team\")}}).call(this,e(73),\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{12:12,31:31,60:60,61:61,7:7,73:73}],47:[function(e,t,n){function r(){return\"WebkitAppearance\"in document.documentElement.style||window.console&&(console.firebug||console.exception&&console.table)||navigator.userAgent.toLowerCase().match(/firefox\\/(\\d+)/)&&parseInt(RegExp.$1,10)>=31}function o(){var e=arguments,t=this.useColors;if(e[0]=(t?\"%c\":\"\")+this.namespace+(t?\" %c\":\" \")+e[0]+(t?\"%c \":\" \")+\"+\"+n.humanize(this.diff),!t)return e;var r=\"color: \"+this.color;e=[e[0],r,\"color: inherit\"].concat(Array.prototype.slice.call(e,1));var o=0,i=0;return e[0].replace(/%[a-z%]/g,function(e){\"%%\"!==e&&(o++,\"%c\"===e&&(i=o))}),e.splice(i,0,r),e}function i(){return\"object\"==typeof console&&console.log&&Function.prototype.apply.call(console.log,console,arguments)}function a(e){try{null==e?n.storage.removeItem(\"debug\"):n.storage.debug=e}catch(e){}}function s(){var e;try{e=n.storage.debug}catch(e){}return e}n=t.exports=e(48),n.log=i,n.formatArgs=o,n.save=a,n.load=s,n.useColors=r,n.storage=\"undefined\"!=typeof chrome&&void 0!==chrome.storage?chrome.storage.local:function(){try{return window.localStorage}catch(e){}}(),n.colors=[\"lightseagreen\",\"forestgreen\",\"goldenrod\",\"dodgerblue\",\"darkorchid\",\"crimson\"],n.formatters.j=function(e){return JSON.stringify(e)},n.enable(s())},{48:48}],48:[function(e,t,n){function r(){return n.colors[f++%n.colors.length]}function o(e){function t(){}function o(){var e=o,t=+new Date,i=t-(c||t);e.diff=i,e.prev=c,e.curr=t,c=t,null==e.useColors&&(e.useColors=n.useColors()),null==e.color&&e.useColors&&(e.color=r());var a=Array.prototype.slice.call(arguments);a[0]=n.coerce(a[0]),\"string\"!=typeof a[0]&&(a=[\"%o\"].concat(a));var s=0;a[0]=a[0].replace(/%([a-z%])/g,function(t,r){if(\"%%\"===t)return t;s++;var o=n.formatters[r];if(\"function\"==typeof o){var i=a[s];t=o.call(e,i),a.splice(s,1),s--}return t}),\"function\"==typeof n.formatArgs&&(a=n.formatArgs.apply(e,a)),(o.log||n.log||console.log.bind(console)).apply(e,a)}t.enabled=!1,o.enabled=!0;var i=n.enabled(e)?o:t;return i.namespace=e,i}function i(e){n.save(e);for(var t=(e||\"\").split(/[\\s,]+/),r=t.length,o=0;o<r;o++)t[o]&&(e=t[o].replace(/\\*/g,\".*?\"),\"-\"===e[0]?n.skips.push(new RegExp(\"^\"+e.substr(1)+\"$\")):n.names.push(new RegExp(\"^\"+e+\"$\")))}function a(){n.enable(\"\")}function s(e){var t,r;for(t=0,r=n.skips.length;t<r;t++)if(n.skips[t].test(e))return!1;for(t=0,r=n.names.length;t<r;t++)if(n.names[t].test(e))return!0;return!1}function u(e){return e instanceof Error?e.stack||e.message:e}n=t.exports=o,n.coerce=u,n.disable=a,n.enable=i,n.enabled=s,n.humanize=e(50),n.names=[],n.skips=[],n.formatters={};var c,f=0},{50:50}],49:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=m,this.queue=[],this.outcome=void 0,e!==r&&u(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function a(e,t,n){p(function(){var r;try{r=t(n)}catch(t){return v.reject(e,t)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function s(e){var t=e&&e.then;if(e&&\"object\"==typeof e&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function u(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,a=c(o);\"error\"===a.status&&n(a.value)}function c(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=new Array(n),a=0,s=-1,u=new this(r);++s<n;)!function(e,r){function s(e){i[r]=e,++a!==n||o||(o=!0,v.resolve(u,i))}t.resolve(e).then(s,function(e){o||(o=!0,v.reject(u,e))})}(e[s],s);return u}function h(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=-1,a=new this(r);++i<n;)!function(e){t.resolve(e).then(function(e){o||(o=!0,v.resolve(a,e))},function(e){o||(o=!0,v.reject(a,e))})}(e[i]);return a}var p=e(11),v={},y=[\"REJECTED\"],g=[\"FULFILLED\"],m=[\"PENDING\"];t.exports=o,o.prototype.catch=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===g||\"function\"!=typeof t&&this.state===y)return this;var n=new this.constructor(r);if(this.state!==m){a(n,this.state===g?e:t,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){a(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){a(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=c(s,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)u(e,r);else{e.state=g,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=y,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=h},{11:11}],50:[function(e,t,n){function r(e){if(e=\"\"+e,!(e.length>1e4)){var t=/^((?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(e);if(t){var n=parseFloat(t[1]);switch((t[2]||\"ms\").toLowerCase()){case\"years\":case\"year\":case\"yrs\":case\"yr\":case\"y\":return n*l;case\"days\":case\"day\":case\"d\":return n*f;case\"hours\":case\"hour\":case\"hrs\":case\"hr\":case\"h\":return n*c;case\"minutes\":case\"minute\":case\"mins\":case\"min\":case\"m\":return n*u;case\"seconds\":case\"second\":case\"secs\":case\"sec\":case\"s\":return n*s;case\"milliseconds\":case\"millisecond\":case\"msecs\":case\"msec\":case\"ms\":return n}}}}function o(e){return e>=f?Math.round(e/f)+\"d\":e>=c?Math.round(e/c)+\"h\":e>=u?Math.round(e/u)+\"m\":e>=s?Math.round(e/s)+\"s\":e+\"ms\"}function i(e){return a(e,f,\"day\")||a(e,c,\"hour\")||a(e,u,\"minute\")||a(e,s,\"second\")||e+\" ms\"}function a(e,t,n){if(!(e<t))return e<1.5*t?Math.floor(e/t)+\" \"+n:Math.ceil(e/t)+\" \"+n+\"s\"}var s=1e3,u=60*s,c=60*u,f=24*c,l=365.25*f;t.exports=function(e,t){return t=t||{},\"string\"==typeof e?r(e):t.long?i(e):o(e)}},{}],51:[function(e,t,n){\"use strict\";function r(){for(var e={},t=new l(function(t,n){e.resolve=t,e.reject=n}),n=new Array(arguments.length),r=0;r<n.length;r++)n[r]=arguments[r];return e.promise=t,l.resolve().then(function(){return fetch.apply(null,n)}).then(function(t){\ne.resolve(t)}).catch(function(t){e.reject(t)}),e}function o(e,t){var n,o,i,a=new Headers,s={method:e.method,credentials:\"include\",headers:a};return e.json&&(a.set(\"Accept\",\"application/json\"),a.set(\"Content-Type\",e.headers[\"Content-Type\"]||\"application/json\")),e.body&&e.body instanceof Blob?f.readAsArrayBuffer(e.body,function(e){s.body=e}):e.body&&e.processData&&\"string\"!=typeof e.body?s.body=JSON.stringify(e.body):s.body=\"body\"in e?e.body:null,Object.keys(e.headers).forEach(function(t){e.headers.hasOwnProperty(t)&&a.set(t,e.headers[t])}),n=r(e.url,s),e.timeout>0&&(o=setTimeout(function(){n.reject(new Error(\"Load timeout for resource: \"+e.url))},e.timeout)),n.promise.then(function(t){return i={statusCode:t.status},e.timeout>0&&clearTimeout(o),i.statusCode>=200&&i.statusCode<300?e.binary?t.blob():t.text():t.json()}).then(function(e){i.statusCode>=200&&i.statusCode<300?t(null,i,e):t(e,i)}).catch(function(e){t(e,i)}),{abort:n.reject}}function i(e,t){var n,r,o=!1,i=function(){n.abort()},a=function(){o=!0,n.abort()};n=e.xhr?new e.xhr:new XMLHttpRequest;try{n.open(e.method,e.url)}catch(e){return t(new Error(e.name||\"Url is invalid\"))}n.withCredentials=!(\"withCredentials\"in e)||e.withCredentials,\"GET\"===e.method?delete e.headers[\"Content-Type\"]:e.json&&(e.headers.Accept=\"application/json\",e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\",e.body&&e.processData&&\"string\"!=typeof e.body&&(e.body=JSON.stringify(e.body))),e.binary&&(n.responseType=\"arraybuffer\"),\"body\"in e||(e.body=null);for(var s in e.headers)e.headers.hasOwnProperty(s)&&n.setRequestHeader(s,e.headers[s]);return e.timeout>0&&(r=setTimeout(a,e.timeout),n.onprogress=function(){clearTimeout(r),4!==n.readyState&&(r=setTimeout(a,e.timeout))},void 0!==n.upload&&(n.upload.onprogress=n.onprogress)),n.onreadystatechange=function(){if(4===n.readyState){var r={statusCode:n.status};if(n.status>=200&&n.status<300){var i;i=e.binary?f.blob([n.response||\"\"],{type:n.getResponseHeader(\"Content-Type\")}):n.responseText,t(null,r,i)}else{var a={};if(o)a=new Error(\"ETIMEDOUT\"),a.code=\"ETIMEDOUT\";else try{a=JSON.parse(n.response)}catch(e){}a.status=n.status,t(a)}}},e.body&&e.body instanceof Blob?f.readAsArrayBuffer(e.body,function(e){n.send(e)}):n.send(e.body),{abort:i}}function a(e,t){return v||e.xhr?i(e,t):o(e,t)}function s(){return\"\"}function u(e,t){function n(t,n,r){if(!e.binary&&e.json&&\"string\"==typeof t)try{t=JSON.parse(t)}catch(e){return r(e)}Array.isArray(t)&&(t=t.map(function(e){return e.error||e.missing?h.generateErrorFromResponse(e):e})),e.binary&&y(t,n),r(null,t,n)}e=p.clone(e);var r={method:\"GET\",headers:{},json:!0,processData:!0,timeout:1e4,cache:!1};return e=d.extend(r,e),e.json&&(e.binary||(e.headers.Accept=\"application/json\"),e.headers[\"Content-Type\"]=e.headers[\"Content-Type\"]||\"application/json\"),e.binary&&(e.encoding=null,e.json=!1),e.processData||(e.json=!1),a(e,function(r,o,i){if(r)return t(h.generateErrorFromResponse(r));var a,u=o.headers&&o.headers[\"content-type\"],c=i||s();if(!e.binary&&(e.json||!e.processData)&&\"object\"!=typeof c&&(/json/.test(u)||/^[\\s]*\\{/.test(c)&&/\\}[\\s]*$/.test(c)))try{c=JSON.parse(c.toString())}catch(e){}o.statusCode>=200&&o.statusCode<300?n(c,o,t):(a=h.generateErrorFromResponse(c),a.status=o.statusCode,t(a))})}function c(e,t){var n=navigator&&navigator.userAgent?navigator.userAgent.toLowerCase():\"\",r=-1!==n.indexOf(\"safari\")&&-1===n.indexOf(\"chrome\"),o=-1!==n.indexOf(\"msie\"),i=-1!==n.indexOf(\"edge\"),a=r||(o||i)&&\"GET\"===e.method,s=!(\"cache\"in e)||e.cache;if(!/^blob:/.test(e.url)&&(a||!s)){var c=-1!==e.url.indexOf(\"?\");e.url+=(c?\"&\":\"?\")+\"_nonce=\"+Date.now()}return u(e,t)}var f=e(52),l=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(60)),d=e(13),h=e(56),p=e(61),v=function(){try{return new XMLHttpRequest,!0}catch(e){return!1}}(),y=function(){};t.exports=c},{13:13,52:52,56:56,60:60,61:61}],52:[function(e,t,n){\"use strict\";function r(e,t){e=e||[],t=t||{};try{return new Blob(e,t)}catch(i){if(\"TypeError\"!==i.name)throw i;for(var n=\"undefined\"!=typeof BlobBuilder?BlobBuilder:\"undefined\"!=typeof MSBlobBuilder?MSBlobBuilder:\"undefined\"!=typeof MozBlobBuilder?MozBlobBuilder:WebKitBlobBuilder,r=new n,o=0;o<e.length;o+=1)r.append(e[o]);return r.getBlob(t.type)}}function o(e){for(var t=e.length,n=new ArrayBuffer(t),r=new Uint8Array(n),o=0;o<t;o++)r[o]=e.charCodeAt(o);return n}function i(e,t){return r([o(e)],{type:t})}function a(e,t){return i(h(e),t)}function s(e){for(var t=\"\",n=new Uint8Array(e),r=n.byteLength,o=0;o<r;o++)t+=String.fromCharCode(n[o]);return t}function u(e,t){if(\"undefined\"==typeof FileReader)return t(s((new FileReaderSync).readAsArrayBuffer(e)));var n=new FileReader,r=\"function\"==typeof n.readAsBinaryString;n.onloadend=function(e){var n=e.target.result||\"\";if(r)return t(n);t(s(n))},r?n.readAsBinaryString(e):n.readAsArrayBuffer(e)}function c(e,t){u(e,function(e){t(e)})}function f(e,t){c(e,function(e){t(p(e))})}function l(e,t){if(\"undefined\"==typeof FileReader)return t((new FileReaderSync).readAsArrayBuffer(e));var n=new FileReader;n.onloadend=function(e){var n=e.target.result||new ArrayBuffer(0);t(n)},n.readAsArrayBuffer(e)}function d(){}Object.defineProperty(n,\"__esModule\",{value:!0});var h=function(e){return atob(e)},p=function(e){return btoa(e)};n.atob=h,n.btoa=p,n.base64StringToBlobOrBuffer=a,n.binaryStringToArrayBuffer=o,n.binaryStringToBlobOrBuffer=i,n.blob=r,n.blobOrBufferToBase64=f,n.blobOrBufferToBinaryString=c,n.readAsArrayBuffer=l,n.readAsBinaryString=u,n.typedBuffer=d},{}],53:[function(e,t,n){\"use strict\";function r(e,t,n,o,i){return e.get(t).catch(function(n){if(404===n.status)return\"http\"===e.type()&&f.explainError(404,\"PouchDB is just checking if a remote checkpoint exists.\"),{session_id:o,_id:t,history:[],replicator:h,version:d};throw n}).then(function(a){if(!i.cancelled)return a.history=(a.history||[]).filter(function(e){return e.session_id!==o}),a.history.unshift({last_seq:n,session_id:o}),a.history=a.history.slice(0,p),a.version=d,a.replicator=h,a.session_id=o,a.last_seq=n,e.put(a).catch(function(a){if(409===a.status)return r(e,t,n,o,i);throw a})})}function o(e,t,n,r){this.src=e,this.target=t,this.id=n,this.returnValue=r}function i(e,t){return e.session_id===t.session_id?{last_seq:e.last_seq,history:e.history}:a(e.history,t.history)}function a(e,t){var n=e[0],r=e.slice(1),o=t[0],i=t.slice(1);return n&&0!==t.length?s(n.session_id,t)?{last_seq:n.last_seq,history:e}:s(o.session_id,r)?{last_seq:o.last_seq,history:i}:a(r,i):{last_seq:v,history:[]}}function s(e,t){var n=t[0],r=t.slice(1);return!(!e||0===t.length)&&(e===n.session_id||s(e,r))}function u(e){return\"number\"==typeof e.status&&4===Math.floor(e.status/100)}var c=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(60)),f=e(61),l=e(54),d=1,h=\"pouchdb\",p=5,v=0;o.prototype.writeCheckpoint=function(e,t){var n=this;return this.updateTarget(e,t).then(function(){return n.updateSource(e,t)})},o.prototype.updateTarget=function(e,t){return r(this.target,this.id,e,t,this.returnValue)},o.prototype.updateSource=function(e,t){var n=this;return this.readOnlySource?c.resolve(!0):r(this.src,this.id,e,t,this.returnValue).catch(function(e){if(u(e))return n.readOnlySource=!0,!0;throw e})};var y={undefined:function(e,t){return 0===l.collate(e.last_seq,t.last_seq)?t.last_seq:0},1:function(e,t){return i(t,e).last_seq}};o.prototype.getCheckpoint=function(){var e=this;return e.target.get(e.id).then(function(t){return e.readOnlySource?c.resolve(t.last_seq):e.src.get(e.id).then(function(e){if(t.version!==e.version)return v;var n;return n=t.version?t.version.toString():\"undefined\",n in y?y[n](t,e):v},function(n){if(404===n.status&&t.last_seq)return e.src.put({_id:e.id,last_seq:v}).then(function(){return v},function(n){return u(n)?(e.readOnlySource=!0,t.last_seq):v});throw n})}).catch(function(e){if(404!==e.status)throw e;return v})},t.exports=o},{54:54,60:60,61:61}],54:[function(e,t,n){\"use strict\";function r(e){if(null!==e)switch(typeof e){case\"boolean\":return e?1:0;case\"number\":return f(e);case\"string\":return e.replace(/\\u0002/g,\"\u0002\u0002\").replace(/\\u0001/g,\"\u0001\u0002\").replace(/\\u0000/g,\"\u0001\u0001\");case\"object\":var t=Array.isArray(e),r=t?e:Object.keys(e),o=-1,i=r.length,a=\"\";if(t)for(;++o<i;)a+=n.toIndexableString(r[o]);else for(;++o<i;){var s=r[o];a+=n.toIndexableString(s)+n.toIndexableString(e[s])}return a}return\"\"}function o(e,t){var n,r=t;if(\"1\"===e[t])n=0,t++;else{var o=\"0\"===e[t];t++;var i=\"\",a=e.substring(t,t+d),s=parseInt(a,10)+l;for(o&&(s=-s),t+=d;;){var u=e[t];if(\"\\0\"===u)break;i+=u,t++}i=i.split(\".\"),n=1===i.length?parseInt(i,10):parseFloat(i[0]+\".\"+i[1]),o&&(n-=10),0!==s&&(n=parseFloat(n+\"e\"+s))}return{num:n,length:t-r}}function i(e,t){var n=e.pop();if(t.length){var r=t[t.length-1];n===r.element&&(t.pop(),r=t[t.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(n);else if(i===e.length-2){var a=e.pop();o[a]=n}else e.push(n)}}function a(e,t){for(var r=Math.min(e.length,t.length),o=0;o<r;o++){var i=n.collate(e[o],t[o]);if(0!==i)return i}return e.length===t.length?0:e.length>t.length?1:-1}function s(e,t){return e===t?0:e>t?1:-1}function u(e,t){for(var r=Object.keys(e),o=Object.keys(t),i=Math.min(r.length,o.length),a=0;a<i;a++){var s=n.collate(r[a],o[a]);if(0!==s)return s;if(0!==(s=n.collate(e[r[a]],t[o[a]])))return s}return r.length===o.length?0:r.length>o.length?1:-1}function c(e){var t=[\"boolean\",\"number\",\"string\",\"object\"],n=t.indexOf(typeof e);return~n?null===e?1:Array.isArray(e)?5:n<3?n+2:n+3:Array.isArray(e)?5:void 0}function f(e){if(0===e)return\"1\";var t=e.toExponential().split(/e\\+?/),n=parseInt(t[1],10),r=e<0,o=r?\"0\":\"2\",i=(r?-n:n)-l,a=p.padLeft(i.toString(),\"0\",d);o+=h+a;var s=Math.abs(parseFloat(t[0]));r&&(s=10-s);var u=s.toFixed(20);return u=u.replace(/\\.?0+$/,\"\"),o+=h+u}var l=-324,d=3,h=\"\",p=e(55);n.collate=function(e,t){if(e===t)return 0;e=n.normalizeKey(e),t=n.normalizeKey(t);var r=c(e),o=c(t);if(r-o!=0)return r-o;if(null===e)return 0;switch(typeof e){case\"number\":return e-t;case\"boolean\":return e===t?0:e<t?-1:1;case\"string\":return s(e,t)}return Array.isArray(e)?a(e,t):u(e,t)},n.normalizeKey=function(e){switch(typeof e){case\"undefined\":return null;case\"number\":return e===1/0||e===-1/0||isNaN(e)?null:e;case\"object\":var t=e;if(Array.isArray(e)){var r=e.length;e=new Array(r);for(var o=0;o<r;o++)e[o]=n.normalizeKey(t[o])}else{if(e instanceof Date)return e.toJSON();if(null!==e){e={};for(var i in t)if(t.hasOwnProperty(i)){var a=t[i];void 0!==a&&(e[i]=n.normalizeKey(a))}}}}return e},n.toIndexableString=function(e){return e=n.normalizeKey(e),c(e)+h+r(e)+\"\\0\"},n.parseIndexableString=function(e){for(var t=[],n=[],r=0;;){var a=e[r++];if(\"\\0\"!==a)switch(a){case\"1\":t.push(null);break;case\"2\":t.push(\"1\"===e[r]),r++;break;case\"3\":var s=o(e,r);t.push(s.num),r+=s.length;break;case\"4\":for(var u=\"\";;){var c=e[r];if(\"\\0\"===c)break;u+=c,r++}u=u.replace(/\\u0001\\u0001/g,\"\\0\").replace(/\\u0001\\u0002/g,\"\u0001\").replace(/\\u0002\\u0002/g,\"\u0002\"),t.push(u);break;case\"5\":var f={element:[],index:t.length};t.push(f.element),n.push(f);break;case\"6\":var l={element:{},index:t.length};t.push(l.element),n.push(l);break;default:throw new Error(\"bad collationIndex or unexpectedly reached end of input: \"+a)}else{if(1===t.length)return t.pop();i(t,n)}}}},{55:55}],55:[function(e,t,n){\"use strict\";function r(e,t,n){for(var r=\"\",o=n-e.length;r.length<o;)r+=t;return r}n.padLeft=function(e,t,n){return r(e,t,n)+e},n.padRight=function(e,t,n){return e+r(e,t,n)},n.stringLexCompare=function(e,t){var n,r=e.length,o=t.length;for(n=0;n<r;n++){if(n===o)return 1;var i=e.charAt(n),a=t.charAt(n);if(i!==a)return i<a?-1:1}return r<o?-1:0},n.intToDecimalForm=function(e){var t=e<0,n=\"\";do{n=(t?-Math.ceil(e%10):Math.floor(e%10))+n,e=t?Math.ceil(e/10):Math.floor(e/10)}while(e);return t&&\"0\"!==n&&(n=\"-\"+n),n}},{}],56:[function(e,t,n){\"use strict\";function r(e){Error.call(this,e.reason),this.status=e.status,this.name=e.error,this.message=e.reason,this.error=!0}function o(e,t){function n(t){for(var n in e)\"function\"!=typeof e[n]&&(this[n]=e[n]);void 0!==t&&(this.reason=t)}return n.prototype=r.prototype,new n(t)}function i(e){if(\"object\"!=typeof e){var t=e;e=p,e.data=t}return\"error\"in e&&\"conflict\"===e.error&&(e.name=\"conflict\",e.status=409),\"name\"in e||(e.name=e.error||\"unknown\"),\"status\"in e||(e.status=500),\"message\"in e||(e.message=e.message||e.reason),e}Object.defineProperty(n,\"__esModule\",{value:!0}),function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(57))(r,Error),r.prototype.toString=function(){return JSON.stringify({status:this.status,name:this.name,message:this.message,reason:this.reason})};var a=new r({status:401,error:\"unauthorized\",reason:\"Name or password is incorrect.\"}),s=new r({status:400,error:\"bad_request\",reason:\"Missing JSON list of 'docs'\"}),u=new r({status:404,error:\"not_found\",reason:\"missing\"}),c=new r({status:409,error:\"conflict\",reason:\"Document update conflict\"}),f=new r({status:400,error:\"bad_request\",reason:\"_id field must contain a string\"}),l=new r({status:412,error:\"missing_id\",reason:\"_id is required for puts\"}),d=new r({status:400,error:\"bad_request\",reason:\"Only reserved document ids may start with underscore.\"}),h=new r({status:412,error:\"precondition_failed\",reason:\"Database not open\"}),p=new r({status:500,error:\"unknown_error\",reason:\"Database encountered an unknown error\"}),v=new r({status:500,error:\"badarg\",reason:\"Some query argument is invalid\"}),y=new r({status:400,error:\"invalid_request\",reason:\"Request was invalid\"}),g=new r({status:400,error:\"query_parse_error\",reason:\"Some query parameter is invalid\"}),m=new r({status:500,error:\"doc_validation\",reason:\"Bad special document member\"}),_=new r({status:400,error:\"bad_request\",reason:\"Something wrong with the request\"}),b=new r({status:400,error:\"bad_request\",reason:\"Document must be a JSON object\"}),w=new r({status:404,error:\"not_found\",reason:\"Database not found\"}),k=new r({status:500,error:\"indexed_db_went_bad\",reason:\"unknown\"}),E=new r({status:500,error:\"web_sql_went_bad\",reason:\"unknown\"}),S=new r({status:500,error:\"levelDB_went_went_bad\",reason:\"unknown\"}),O=new r({status:403,error:\"forbidden\",reason:\"Forbidden by design doc validate_doc_update function\"}),A=new r({status:400,error:\"bad_request\",reason:\"Invalid rev format\"}),j=new r({status:412,error:\"file_exists\",reason:\"The database could not be created, the file already exists.\"}),x=new r({status:412,error:\"missing_stub\"}),I=new r({status:413,error:\"invalid_url\",reason:\"Provided URL is invalid\"});n.UNAUTHORIZED=a,n.MISSING_BULK_DOCS=s,n.MISSING_DOC=u,n.REV_CONFLICT=c,n.INVALID_ID=f,n.MISSING_ID=l,n.RESERVED_ID=d,n.NOT_OPEN=h,n.UNKNOWN_ERROR=p,n.BAD_ARG=v,n.INVALID_REQUEST=y,n.QUERY_PARSE_ERROR=g,n.DOC_VALIDATION=m,n.BAD_REQUEST=_,n.NOT_AN_OBJECT=b,n.DB_MISSING=w,n.WSQ_ERROR=E,n.LDB_ERROR=S,n.FORBIDDEN=O,n.INVALID_REV=A,n.FILE_EXISTS=j,n.MISSING_STUB=x,n.IDB_ERROR=k,n.INVALID_URL=I,n.createError=o,n.generateErrorFromResponse=i},{57:57}],57:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],58:[function(e,t,n){\"use strict\";function r(e){return Object.keys(e).sort(s.collate).reduce(function(t,n){return t[n]=e[n],t},{})}function o(e,t,n){var o=n.doc_ids?n.doc_ids.sort(s.collate):\"\",u=n.filter?n.filter.toString():\"\",c=\"\",f=\"\";return n.filter&&n.query_params&&(c=JSON.stringify(r(n.query_params))),n.filter&&\"_view\"===n.filter&&(f=n.view.toString()),i.all([e.id(),t.id()]).then(function(e){var t=e[0]+e[1]+u+f+c+o;return new i(function(e){a.binaryMd5(t,e)})}).then(function(e){return\"_local/\"+(e=e.replace(/\\//g,\".\").replace(/\\+/g,\"_\"))})}var i=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(60)),a=e(59),s=e(54);t.exports=o},{54:54,59:59,60:60}],59:[function(e,t,n){(function(t){\"use strict\";function r(e){return c.btoa(e)}function o(e,t,n){return e.webkitSlice?e.webkitSlice(t,n):e.slice(t,n)}function i(e,t,n,r,i){(n>0||r<t.size)&&(t=o(t,n,r)),c.readAsArrayBuffer(t,function(t){e.append(t),i()})}function a(e,t,n,r,o){(n>0||r<t.length)&&(t=t.substring(n,r)),e.appendBinary(t),o()}function s(e,t){function n(){l(s)}function o(){var e=y.end(!0),n=r(e);t(n),y.destroy()}function s(){var t=v*h,r=t+h;v++,v<p?g(y,e,t,r,n):g(y,e,t,r,o)}var u=\"string\"==typeof e,c=u?e.length:e.size,h=Math.min(d,c),p=Math.ceil(c/h),v=0,y=u?new f:new f.ArrayBuffer,g=u?a:i;s()}function u(e){return f.hash(e)}Object.defineProperty(n,\"__esModule\",{value:!0});var c=e(52),f=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(63)),l=t.setImmediate||t.setTimeout,d=32768;n.binaryMd5=s,n.stringMd5=u}).call(this,\"undefined\"!=typeof global?global:\"undefined\"!=typeof self?self:\"undefined\"!=typeof window?window:{})},{52:52,63:63}],60:[function(e,t,n){\"use strict\";var r=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(49)),o=\"function\"==typeof Promise?Promise:r;t.exports=o},{49:49}],61:[function(e,t,n){(function(t){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function a(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function s(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&V.call(n)==Q}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return a(e);if(!s(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);void 0!==i&&(t[n]=i)}return t}function c(e){var t=!1;return U(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return U(function(n){n=u(n);var r,o=this,i=\"function\"==typeof n[n.length-1]&&n.pop();i&&(r=function(e,n){t.nextTick(function(){i(e,n)})});var a=new P(function(t,r){var i;try{var a=c(function(e,n){e?r(e):t(n)});n.push(a),i=e.apply(o,n),i&&\"function\"==typeof i.then&&t(i)}catch(e){r(e)}});return r&&a.then(function(e){r(null,e)},r),a})}function l(e,t){function n(e,t,n){if(H.enabled){for(var r=[e._db_name,t],o=0;o<n.length-1;o++)r.push(n[o]);H.apply(null,r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[e._db_name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),H.apply(null,o),i(n,r)}}}return f(U(function(r){if(this._closed)return P.reject(new Error(\"database is closed\"));if(this._destroyed)return P.reject(new Error(\"database is destroyed\"));var o=this;return n(o,e,r),this.taskqueue.isReady?t.apply(this,r):new P(function(t,n){o.taskqueue.addTask(function(i){i?n(i):t(o[e].apply(o,r))})})}))}function d(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function h(e){return e}function p(e){return[{ok:e}]}function v(e,t,n){function r(){var e=[];v.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){v[e]={id:t,docs:n},o()}function a(){if(!(g>=y.length)){var e=Math.min(g+W,y.length),t=y.slice(g,e);s(t,g),g+=t.length}}function s(n,r){n.forEach(function(n,o){var s=r+o,u=c[n],f=d(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(h);var l=h;0===f.open_revs.length&&(delete f.open_revs,l=p),[\"revs\",\"attachments\",\"binary\",\"ajax\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(s,n,r),a()})})}var u=t.docs,c={};u.forEach(function(e){e.id in c?c[e.id].push(e):c[e.id]=[e]});var f=Object.keys(c).length,l=0,v=new Array(f),y=Object.keys(c),g=0;a()}function y(){return\"undefined\"!=typeof chrome&&void 0!==chrome.storage&&void 0!==chrome.storage.local}function g(){return F}function m(e){y()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):g()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function _(){K.EventEmitter.call(this),this._listeners={},m(this)}function b(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function w(e,t){return e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>6e5&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}function k(e){var t=0;return e||(t=2e3),w(e,t)}function E(e,t){b(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function S(e,t){for(var n in t)if(t.hasOwnProperty(n)){var r=u(t[n]);void 0!==r&&(e[n]=r)}}function O(e,t,n){return S(e,t),n&&S(e,n),e}function A(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return J.createError(J.BAD_REQUEST,r)}}function j(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&A(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function x(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function I(){}function D(e){var t;if(e?\"string\"!=typeof e?t=J.createError(J.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=J.createError(J.RESERVED_ID)):t=J.createError(J.MISSING_ID),t)throw t}function q(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function C(e,t){return\"listenerCount\"in e?e.listenerCount(t):K.EventEmitter.listenerCount(e,t)}function B(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function R(e){var t=B(e);return t?t.join(\"/\"):null}function T(e){for(var t=re.exec(e),n={},r=14;r--;){var o=ee[r],i=t[r]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);n[o]=a?decodeURIComponent(i):i}return n[te]={},n[ee[12]].replace(ne,function(e,t,r){t&&(n[te][t]=r)}),n}function $(e,t,n){return new P(function(r,o){e.get(t,function(i,a){if(i){if(404!==i.status)return o(i);a={}}var s=a._rev,u=n(a);if(!u)return r({updated:!1,rev:s});u._id=t,u._rev=s,r(L(e,u,n))})})}function L(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return $(e,t._id,n)})}function N(e){return 0|Math.random()*e}function M(e,t){t=t||oe.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=oe[N(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=oe[3&N(16)|8];break;default:n+=oe[N(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var F,P=r(e(60)),U=r(e(7)),z=r(e(47)),K=e(10),G=r(e(62)),J=e(56),V=Function.prototype.toString,Q=V.call(Object),H=z(\"pouchdb:api\"),W=6;if(y())F=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),F=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){F=!1}G(_,K.EventEmitter),_.prototype.addListener=function(e,t,n,r){function o(){function e(){a=!1}if(i._listeners[t]){if(a)return void(a=\"waiting\");a=!0;var s=d(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(s).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===a&&setTimeout(function(){o()},0),a=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,a=!1;this._listeners[t]=o,this.on(e,o)}},_.prototype.removeListener=function(e,t){t in this._listeners&&K.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t])},_.prototype.notifyLocalWindows=function(e){y()?chrome.storage.local.set({dbName:e}):g()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},_.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var X,Y=I.name;X=Y?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var Z=X,ee=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],te=\"queryKey\",ne=/(?:^|&)([^&=]*)=?([^&]*)/g,re=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,oe=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=l,n.bulkGetShim=v,n.changesHandler=_,n.clone=u,n.defaultBackOff=k,n.explainError=E,n.extend=O,n.filterChange=j,n.flatten=x,n.functionName=Z,n.guardedConsole=b,n.hasLocalStorage=g,n.invalidIdError=D,n.isChromeApp=y,n.isCordova=q,n.listenerCount=C,n.normalizeDdocFunctionName=R,n.once=c,n.parseDdocFunctionName=B,n.parseUri=T,n.pick=d,n.toPromise=f,n.upsert=$,n.uuid=M}).call(this,e(73))},{10:10,47:47,56:56,60:60,62:62,7:7,73:73}],62:[function(e,t,n){arguments[4][12][0].apply(n,arguments)},{12:12}],63:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(e){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t,n,r,o,i){return t=_(_(t,e),_(r,i)),_(t<<o|t>>>32-o,n)}function n(e,n,r,o,i,a,s){return t(n&r|~n&o,e,n,i,a,s)}function r(e,n,r,o,i,a,s){return t(n&o|r&~o,e,n,i,a,s)}function o(e,n,r,o,i,a,s){return t(n^r^o,e,n,i,a,s)}function i(e,n,r,o,i,a,s){return t(r^(n|~o),e,n,i,a,s)}function a(e,t){var a=e[0],s=e[1],u=e[2],c=e[3];a=n(a,s,u,c,t[0],7,-680876936),c=n(c,a,s,u,t[1],12,-389564586),u=n(u,c,a,s,t[2],17,606105819),s=n(s,u,c,a,t[3],22,-1044525330),a=n(a,s,u,c,t[4],7,-176418897),c=n(c,a,s,u,t[5],12,1200080426),u=n(u,c,a,s,t[6],17,-1473231341),s=n(s,u,c,a,t[7],22,-45705983),a=n(a,s,u,c,t[8],7,1770035416),c=n(c,a,s,u,t[9],12,-1958414417),u=n(u,c,a,s,t[10],17,-42063),s=n(s,u,c,a,t[11],22,-1990404162),a=n(a,s,u,c,t[12],7,1804603682),c=n(c,a,s,u,t[13],12,-40341101),u=n(u,c,a,s,t[14],17,-1502002290),s=n(s,u,c,a,t[15],22,1236535329),a=r(a,s,u,c,t[1],5,-165796510),c=r(c,a,s,u,t[6],9,-1069501632),u=r(u,c,a,s,t[11],14,643717713),s=r(s,u,c,a,t[0],20,-373897302),a=r(a,s,u,c,t[5],5,-701558691),c=r(c,a,s,u,t[10],9,38016083),u=r(u,c,a,s,t[15],14,-660478335),s=r(s,u,c,a,t[4],20,-405537848),a=r(a,s,u,c,t[9],5,568446438),c=r(c,a,s,u,t[14],9,-1019803690),u=r(u,c,a,s,t[3],14,-187363961),s=r(s,u,c,a,t[8],20,1163531501),a=r(a,s,u,c,t[13],5,-1444681467),c=r(c,a,s,u,t[2],9,-51403784),u=r(u,c,a,s,t[7],14,1735328473),s=r(s,u,c,a,t[12],20,-1926607734),a=o(a,s,u,c,t[5],4,-378558),c=o(c,a,s,u,t[8],11,-2022574463),u=o(u,c,a,s,t[11],16,1839030562),s=o(s,u,c,a,t[14],23,-35309556),a=o(a,s,u,c,t[1],4,-1530992060),c=o(c,a,s,u,t[4],11,1272893353),u=o(u,c,a,s,t[7],16,-155497632),s=o(s,u,c,a,t[10],23,-1094730640),a=o(a,s,u,c,t[13],4,681279174),c=o(c,a,s,u,t[0],11,-358537222),u=o(u,c,a,s,t[3],16,-722521979),s=o(s,u,c,a,t[6],23,76029189),a=o(a,s,u,c,t[9],4,-640364487),c=o(c,a,s,u,t[12],11,-421815835),u=o(u,c,a,s,t[15],16,530742520),s=o(s,u,c,a,t[2],23,-995338651),a=i(a,s,u,c,t[0],6,-198630844),c=i(c,a,s,u,t[7],10,1126891415),u=i(u,c,a,s,t[14],15,-1416354905),s=i(s,u,c,a,t[5],21,-57434055),a=i(a,s,u,c,t[12],6,1700485571),c=i(c,a,s,u,t[3],10,-1894986606),u=i(u,c,a,s,t[10],15,-1051523),s=i(s,u,c,a,t[1],21,-2054922799),a=i(a,s,u,c,t[8],6,1873313359),c=i(c,a,s,u,t[15],10,-30611744),u=i(u,c,a,s,t[6],15,-1560198380),s=i(s,u,c,a,t[13],21,1309151649),a=i(a,s,u,c,t[4],6,-145523070),c=i(c,a,s,u,t[11],10,-1120210379),u=i(u,c,a,s,t[2],15,718787259),s=i(s,u,c,a,t[9],21,-343485551),e[0]=_(a,e[0]),e[1]=_(s,e[1]),e[2]=_(u,e[2]),e[3]=_(c,e[3])}function s(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function u(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function c(e){var t,n,r,o,i,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(t=64;t<=c;t+=64)a(f,s(e.substring(t-64,t)));for(e=e.substring(t-64),n=e.length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;t<n;t+=1)r[t>>2]|=e.charCodeAt(t)<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),t>55)for(a(f,r),t=0;t<16;t+=1)r[t]=0;return o=8*c,o=o.toString(16).match(/(.*?)(.{0,8})$/),i=parseInt(o[2],16),u=parseInt(o[1],16)||0,r[14]=i,r[15]=u,a(f,r),f}function f(e){var t,n,r,o,i,s,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(t=64;t<=c;t+=64)a(f,u(e.subarray(t-64,t)));for(e=t-64<c?e.subarray(t-64):new Uint8Array(0),n=e.length,r=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],t=0;t<n;t+=1)r[t>>2]|=e[t]<<(t%4<<3);if(r[t>>2]|=128<<(t%4<<3),t>55)for(a(f,r),t=0;t<16;t+=1)r[t]=0;return o=8*c,o=o.toString(16).match(/(.*?)(.{0,8})$/),i=parseInt(o[2],16),s=parseInt(o[1],16)||0,r[14]=i,r[15]=s,a(f,r),f}function l(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=b[e>>8*t+4&15]+b[e>>8*t&15];return n}function d(e){var t;for(t=0;t<e.length;t+=1)e[t]=l(e[t]);return e.join(\"\")}function h(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function p(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;n<r;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function v(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function y(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function g(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function m(){this.reset()}var _=function(e,t){return e+t&4294967295},b=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==d(c(\"hello\"))&&(_=function(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n}),\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||function(){function t(e,t){return e=0|e||0,e<0?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,a,s,u=this.byteLength,c=t(n,u),f=u;return r!==e&&(f=t(r,u)),c>f?new ArrayBuffer(0):(o=f-c,i=new ArrayBuffer(o),a=new Uint8Array(i),s=new Uint8Array(this,c,o),a.set(s),i)}}(),m.prototype.append=function(e){return this.appendBinary(h(e)),this},m.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var t,n=this._buff.length;for(t=64;t<=n;t+=64)a(this._hash,s(this._buff.substring(t-64,t)));return this._buff=this._buff.substring(t-64),this},m.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=d(this._hash),e&&(n=g(n)),this.reset(),n},m.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},m.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},m.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},m.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},m.prototype._finish=function(e,t){var n,r,o,i=t;if(e[i>>2]|=128<<(i%4<<3),i>55)for(a(this._hash,e),i=0;i<16;i+=1)e[i]=0;n=8*this._length,n=n.toString(16).match(/(.*?)(.{0,8})$/),r=parseInt(n[2],16),o=parseInt(n[1],16)||0,e[14]=r,e[15]=o,a(this._hash,e)},m.hash=function(e,t){return m.hashBinary(h(e),t)},m.hashBinary=function(e,t){var n=c(e),r=d(n);return t?g(r):r},m.ArrayBuffer=function(){this.reset()},m.ArrayBuffer.prototype.append=function(e){var t,n=y(this._buff.buffer,e,!0),r=n.length;for(this._length+=e.byteLength,t=64;t<=r;t+=64)a(this._hash,u(n.subarray(t-64,t)));return this._buff=t-64<r?new Uint8Array(n.buffer.slice(t-64)):new Uint8Array(0),this},m.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=d(this._hash),e&&(n=g(n)),this.reset(),n},\nm.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},m.ArrayBuffer.prototype.getState=function(){var e=m.prototype.getState.call(this);return e.buff=v(e.buff),e},m.ArrayBuffer.prototype.setState=function(e){return e.buff=p(e.buff,!0),m.prototype.setState.call(this,e)},m.ArrayBuffer.prototype.destroy=m.prototype.destroy,m.ArrayBuffer.prototype._finish=m.prototype._finish,m.ArrayBuffer.hash=function(e,t){var n=f(new Uint8Array(e)),r=d(n);return t?g(r):r},m})},{}],64:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){this.status=400,this.name=\"query_parse_error\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,o)}catch(e){}}function i(e){this.status=404,this.name=\"not_found\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,i)}catch(e){}}function a(e){this.status=500,this.name=\"invalid_value\",this.message=e,this.error=!0;try{Error.captureStackTrace(this,a)}catch(e){}}function s(e,t){return t&&e.then(function(e){v.nextTick(function(){t(null,e)})},function(e){v.nextTick(function(){t(e)})}),e}function u(e){return p(function(t){var n=t.pop(),r=e.apply(this,t);return\"function\"==typeof n&&s(r,n),r})}function c(e,t){return e.then(function(e){return t().then(function(){return e})},function(e){return t().then(function(){throw e})})}function f(e,t){return function(){var n=arguments,r=this;return e.add(function(){return t.apply(r,n)})}}function l(e){var t=new h.Set(e),n=new Array(t.size),r=-1;return t.forEach(function(e){n[++r]=e}),n}function d(e){var t=new Array(e.size),n=-1;return e.forEach(function(e,r){t[++n]=r}),t}Object.defineProperty(n,\"__esModule\",{value:!0});var h=e(24),p=r(e(7)),v=e(72),y=r(e(12));y(o,Error),y(i,Error),y(a,Error),n.uniq=l,n.sequentialize=f,n.fin=c,n.callbackify=u,n.promisedCallback=s,n.mapToKeysArray=d,n.QueryParseError=o,n.NotFoundError=i,n.BuiltInError=a},{12:12,24:24,7:7,72:72}],65:[function(e,t,n){\"use strict\";function r(e){var t=\"builtin \"+e+\" function requires map values to be numbers or number arrays\";return new d.BuiltInError(t)}function o(e){for(var t=0,n=0,o=e.length;n<o;n++){var i=e[n];if(\"number\"!=typeof i){if(!Array.isArray(i))throw r(\"_sum\");t=\"number\"==typeof t?[t]:t;for(var a=0,s=i.length;a<s;a++){var u=i[a];if(\"number\"!=typeof u)throw r(\"_sum\");void 0===t[a]?t.push(u):t[a]+=u}}else\"number\"==typeof t?t+=i:t[0]+=i}return t}function i(e,t){return l.scopeEval(\"return (\"+e.replace(/;\\s*$/,\"\")+\");\",{emit:t,sum:o,log:p,isArray:v,toJSON:y})}function a(e,t){if(\"function\"==typeof e&&2===e.length){var n=e;return function(e){return n(e,t)}}return i(e.toString(),t)}function s(e){return g[e]?g[e]:i(e.toString())}function u(e,t){var n=e.views&&e.views[t];if(\"string\"!=typeof n.map)throw new d.NotFoundError(\"ddoc \"+e._id+\" has no string view named \"+t+\", instead found object of type: \"+typeof n.map)}function c(e,t,n){return m.query.call(this,e,t,n)}function f(e){return m.viewCleanup.call(this,e)}var l=e(72),d=e(64),h=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(15)),p=l.guardedConsole.bind(null,\"log\"),v=Array.isArray,y=JSON.parse,g={_sum:function(e,t){return o(t)},_count:function(e,t){return t.length},_stats:function(e,t){return{sum:o(t),min:Math.min.apply(null,t),max:Math.max.apply(null,t),count:t.length,sumsqr:function(e){for(var t=0,n=0,r=e.length;n<r;n++){var o=e[n];t+=o*o}return t}(t)}}},m=h(\"mrviews\",a,s,u),_={query:c,viewCleanup:f};t.exports=_},{15:15,64:64,72:72}],66:[function(e,t,n){arguments[4][40][0].apply(n,arguments)},{20:20,40:40,74:74}],67:[function(e,t,n){\"use strict\";function r(e){for(var t,n,r,o,i=e.rev_tree.slice();o=i.pop();){var a=o.ids,s=a[2],u=o.pos;if(s.length)for(var c=0,f=s.length;c<f;c++)i.push({pos:u+1,ids:s[c]});else{var l=!!a[1].deleted,d=a[0];t&&!(r!==l?r:n!==u?n<u:t<d)||(t=d,n=u,r=l)}}return n+\"-\"+t}function o(e,t){for(var n,r=e.slice();n=r.pop();)for(var o=n.pos,i=n.ids,a=i[2],s=t(0===a.length,o,i[0],n.ctx,i[1]),u=0,c=a.length;u<c;u++)r.push({pos:o+1,ids:a[u],ctx:s})}function i(e,t){return e.pos-t.pos}function a(e){var t=[];o(e,function(e,n,r,o,i){e&&t.push({rev:n+\"-\"+r,pos:n,opts:i})}),t.sort(i).reverse();for(var n=0,r=t.length;n<r;n++)delete t[n].pos;return t}function s(e){for(var t=r(e),n=a(e.rev_tree),o=[],i=0,s=n.length;i<s;i++){var u=n[i];u.rev===t||u.opts.deleted||o.push(u.rev)}return o}function u(e){var t=[];return o(e.rev_tree,function(e,n,r,o,i){\"available\"!==i.status||e||(t.push(n+\"-\"+r),i.status=\"missing\")}),t}function c(e){for(var t,n=[],r=e.slice();t=r.pop();){var o=t.pos,i=t.ids,a=i[0],s=i[1],u=i[2],c=0===u.length,f=t.history?t.history.slice():[];f.push({id:a,opts:s}),c&&n.push({pos:o+1-f.length,ids:f});for(var l=0,d=u.length;l<d;l++)r.push({pos:o+1,ids:u[l],history:f})}return n.reverse()}function f(e,t){return e.pos-t.pos}function l(e,t,n){for(var r,o=0,i=e.length;o<i;)r=o+i>>>1,n(e[r],t)<0?o=r+1:i=r;return o}function d(e,t,n){var r=l(e,t,n);e.splice(r,0,t)}function h(e,t){for(var n,r,o=t,i=e.length;o<i;o++){var a=e[o],s=[a.id,a.opts,[]];r?(r[2].push(s),r=s):n=r=s}return n}function p(e,t){return e[0]<t[0]?-1:1}function v(e,t){for(var n=[{tree1:e,tree2:t}],r=!1;n.length>0;){var o=n.pop(),i=o.tree1,a=o.tree2;(i[1].status||a[1].status)&&(i[1].status=\"available\"===i[1].status||\"available\"===a[1].status?\"available\":\"missing\");for(var s=0;s<a[2].length;s++)if(i[2][0]){for(var u=!1,c=0;c<i[2].length;c++)i[2][c][0]===a[2][s][0]&&(n.push({tree1:i[2][c],tree2:a[2][s]}),u=!0);u||(r=\"new_branch\",d(i[2],a[2][s],p))}else r=\"new_leaf\",i[2][0]=a[2][s]}return{conflicts:r,tree:e}}function y(e,t,n){var r,o=[],i=!1,a=!1;if(!e.length)return{tree:[t],conflicts:\"new_leaf\"};for(var s=0,u=e.length;s<u;s++){var c=e[s];if(c.pos===t.pos&&c.ids[0]===t.ids[0])r=v(c.ids,t.ids),o.push({pos:c.pos,ids:r.tree}),i=i||r.conflicts,a=!0;else if(!0!==n){var l=c.pos<t.pos?c:t,d=c.pos<t.pos?t:c,h=d.pos-l.pos,p=[],y=[];for(y.push({ids:l.ids,diff:h,parent:null,parentIdx:null});y.length>0;){var g=y.pop();if(0!==g.diff)for(var m=g.ids[2],_=0,b=m.length;_<b;_++)y.push({ids:m[_],diff:g.diff-1,parent:g.ids,parentIdx:_});else g.ids[0]===d.ids[0]&&p.push(g)}var w=p[0];w?(r=v(w.ids,d.ids),w.parent[2][w.parentIdx]=r.tree,o.push({pos:l.pos,ids:l.ids}),i=i||r.conflicts,a=!0):o.push(c)}else o.push(c)}return a||o.push(t),o.sort(f),{tree:o,conflicts:i||\"internal_node\"}}function g(e,t){for(var n,r,i=c(e),a=0,s=i.length;a<s;a++){var u,f=i[a],l=f.ids;if(l.length>t){n||(n={});var d=l.length-t;u={pos:f.pos+d,ids:h(l,d)};for(var p=0;p<d;p++){var v=f.pos+p+\"-\"+l[p].id;n[v]=!0}}else u={pos:f.pos,ids:h(l,0)};r=r?y(r,u,!0).tree:[u]}return n&&o(r,function(e,t,r){delete n[t+\"-\"+r]}),{tree:r,revs:n?Object.keys(n):[]}}function m(e,t,n){var r=y(e,t),o=g(r.tree,n);return{tree:o.tree,stemmedRevs:o.revs,conflicts:r.conflicts}}function _(e,t){for(var n,r=e.slice(),o=t.split(\"-\"),i=parseInt(o[0],10),a=o[1];n=r.pop();){if(n.pos===i&&n.ids[0]===a)return!0;for(var s=n.ids[2],u=0,c=s.length;u<c;u++)r.push({pos:n.pos+1,ids:s[u]})}return!1}function b(e){return e.ids}function w(e,t){t||(t=r(e));for(var n,o=t.substring(t.indexOf(\"-\")+1),i=e.rev_tree.map(b);n=i.pop();){if(n[0]===o)return!!n[1].deleted;i=i.concat(n[2])}}function k(e){return/^_local/.test(e)}function E(e,t){for(var n,r=t.rev_tree.slice();n=r.pop();){var o=n.pos,i=n.ids,a=i[0],s=i[1],u=i[2],c=0===u.length,f=n.history?n.history.slice():[];if(f.push({id:a,pos:o,opts:s}),c)for(var l=0,d=f.length;l<d;l++){var h=f[l],p=h.pos+\"-\"+h.id;if(p===e)return o+\"-\"+a}for(var v=0,y=u.length;v<y;v++)r.push({pos:o+1,ids:u[v],history:f})}throw new Error(\"Unable to resolve latest revision for id \"+t.id+\", rev \"+e)}Object.defineProperty(n,\"__esModule\",{value:!0}),n.collectConflicts=s,n.collectLeaves=a,n.compactTree=u,n.isDeleted=w,n.isLocalId=k,n.merge=m,n.revExists=_,n.rootToLeaf=c,n.traverseRevTree=o,n.winningRev=r,n.latest=E},{}],68:[function(e,t,n){\"use strict\";var r=function(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}(e(69)),o=\"function\"==typeof Promise?Promise:r;t.exports=o},{69:69}],69:[function(e,t,n){\"use strict\";function r(){}function o(e){if(\"function\"!=typeof e)throw new TypeError(\"resolver must be a function\");this.state=m,this.queue=[],this.outcome=void 0,e!==r&&u(this,e)}function i(e,t,n){this.promise=e,\"function\"==typeof t&&(this.onFulfilled=t,this.callFulfilled=this.otherCallFulfilled),\"function\"==typeof n&&(this.onRejected=n,this.callRejected=this.otherCallRejected)}function a(e,t,n){p(function(){var r;try{r=t(n)}catch(t){return v.reject(e,t)}r===e?v.reject(e,new TypeError(\"Cannot resolve promise with itself\")):v.resolve(e,r)})}function s(e){var t=e&&e.then;if(e&&(\"object\"==typeof e||\"function\"==typeof e)&&\"function\"==typeof t)return function(){t.apply(e,arguments)}}function u(e,t){function n(t){i||(i=!0,v.reject(e,t))}function r(t){i||(i=!0,v.resolve(e,t))}function o(){t(r,n)}var i=!1,a=c(o);\"error\"===a.status&&n(a.value)}function c(e,t){var n={};try{n.value=e(t),n.status=\"success\"}catch(e){n.status=\"error\",n.value=e}return n}function f(e){return e instanceof this?e:v.resolve(new this(r),e)}function l(e){var t=new this(r);return v.reject(t,e)}function d(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=new Array(n),a=0,s=-1,u=new this(r);++s<n;)!function(e,r){function s(e){i[r]=e,++a!==n||o||(o=!0,v.resolve(u,i))}t.resolve(e).then(s,function(e){o||(o=!0,v.reject(u,e))})}(e[s],s);return u}function h(e){var t=this;if(\"[object Array]\"!==Object.prototype.toString.call(e))return this.reject(new TypeError(\"must be an array\"));var n=e.length,o=!1;if(!n)return this.resolve([]);for(var i=-1,a=new this(r);++i<n;)!function(e){t.resolve(e).then(function(e){o||(o=!0,v.resolve(a,e))},function(e){o||(o=!0,v.reject(a,e))})}(e[i]);return a}var p=e(11),v={},y=[\"REJECTED\"],g=[\"FULFILLED\"],m=[\"PENDING\"];t.exports=o,o.prototype.catch=function(e){return this.then(null,e)},o.prototype.then=function(e,t){if(\"function\"!=typeof e&&this.state===g||\"function\"!=typeof t&&this.state===y)return this;var n=new this.constructor(r);if(this.state!==m){a(n,this.state===g?e:t,this.outcome)}else this.queue.push(new i(n,e,t));return n},i.prototype.callFulfilled=function(e){v.resolve(this.promise,e)},i.prototype.otherCallFulfilled=function(e){a(this.promise,this.onFulfilled,e)},i.prototype.callRejected=function(e){v.reject(this.promise,e)},i.prototype.otherCallRejected=function(e){a(this.promise,this.onRejected,e)},v.resolve=function(e,t){var n=c(s,t);if(\"error\"===n.status)return v.reject(e,n.value);var r=n.value;if(r)u(e,r);else{e.state=g,e.outcome=t;for(var o=-1,i=e.queue.length;++o<i;)e.queue[o].callFulfilled(t)}return e},v.reject=function(e,t){e.state=y,e.outcome=t;for(var n=-1,r=e.queue.length;++n<r;)e.queue[n].callRejected(t);return e},o.resolve=f,o.reject=l,o.all=d,o.race=h},{11:11}],70:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return/^1-/.test(e)}function i(e,t,n){return!e._attachments||!e._attachments[n]||e._attachments[n].digest!==t._attachments[n].digest}function a(e,t){var n=Object.keys(t._attachments);return m.all(n.map(function(n){return e.getAttachment(t._id,n,{rev:t._rev})}))}function s(e,t,n){var r=_.isRemote(t)&&!_.isRemote(e),o=Object.keys(n._attachments);return r?e.get(n._id).then(function(r){return m.all(o.map(function(o){return i(r,n,o)?t.getAttachment(n._id,o):e.getAttachment(r._id,o)}))}).catch(function(e){if(404!==e.status)throw e;return a(t,n)}):a(t,n)}function u(e){var t=[];return Object.keys(e).forEach(function(n){e[n].missing.forEach(function(e){t.push({id:n,rev:e})})}),{docs:t,revs:!0,latest:!0}}function c(e,t,n,r){function i(){var o=u(n);if(o.docs.length)return e.bulkGet(o).then(function(n){if(r.cancelled)throw new Error(\"cancelled\");return m.all(n.results.map(function(n){return m.all(n.docs.map(function(n){var r=n.ok;return n.error&&(p=!1),r&&r._attachments?s(t,e,r).then(function(e){var t=Object.keys(r._attachments);return e.forEach(function(e,n){var o=r._attachments[t[n]];delete o.stub,delete o.length,o.data=e}),r}):r}))})).then(function(e){h=h.concat(_.flatten(e).filter(Boolean))})})}function a(e){return e._attachments&&Object.keys(e._attachments).length>0}function c(e){return e._conflicts&&e._conflicts.length>0}function f(t){return e.allDocs({keys:t,include_docs:!0,conflicts:!0}).then(function(e){if(r.cancelled)throw new Error(\"cancelled\");e.rows.forEach(function(e){e.deleted||!e.doc||!o(e.value.rev)||a(e.doc)||c(e.doc)||(e.doc._conflicts&&delete e.doc._conflicts,h.push(e.doc),delete n[e.id])})})}function l(){var e=Object.keys(n).filter(function(e){var t=n[e].missing;return 1===t.length&&o(t[0])});if(e.length>0)return f(e)}function d(){return{ok:p,docs:h}}n=_.clone(n);var h=[],p=!0;return m.resolve().then(l).then(i).then(d)}function f(e,t,n,r){if(!1===e.retry)return t.emit(\"error\",n),void t.removeAllListeners();if(\"function\"!=typeof e.back_off_function&&(e.back_off_function=_.defaultBackOff),t.emit(\"requestError\",n),\"active\"===t.state||\"pending\"===t.state){t.emit(\"paused\",n),t.state=\"stopped\";var o=function(){e.current_back_off=O},i=function(){t.removeListener(\"active\",o)};t.once(\"paused\",i),t.once(\"active\",o)}e.current_back_off=e.current_back_off||O,e.current_back_off=e.back_off_function(e.current_back_off),setTimeout(r,e.current_back_off)}function l(e,t,n,r,o){function i(){return D?m.resolve():w(e,t,n).then(function(n){I=n,D=new b(e,t,I,r)})}function a(){if(z=[],0!==x.docs.length){var e=x.docs,i={timeout:n.timeout};return t.bulkDocs({docs:e,new_edits:!1},i).then(function(t){if(r.cancelled)throw y(),new Error(\"cancelled\");var n=Object.create(null);t.forEach(function(e){e.error&&(n[e.id]=e)});var i=Object.keys(n).length;o.doc_write_failures+=i,o.docs_written+=e.length-i,e.forEach(function(e){var t=n[e._id];if(t){if(o.errors.push(t),\"unauthorized\"!==t.name&&\"forbidden\"!==t.name)throw t;r.emit(\"denied\",_.clone(t))}else z.push(e)})},function(t){throw o.doc_write_failures+=e.length,t})}}function s(){if(x.error)throw new Error(\"There was a problem getting docs.\");o.last_seq=$=x.seq;var e=_.clone(o);return z.length&&(e.docs=z,r.emit(\"change\",e)),B=!0,D.writeCheckpoint(x.seq,K).then(function(){if(B=!1,r.cancelled)throw y(),new Error(\"cancelled\");x=void 0,O()}).catch(function(e){throw j(e),e})}function u(){var e={};return x.changes.forEach(function(t){\"_user/\"!==t.id&&(e[t.id]=t.changes.map(function(e){return e.rev}))}),t.revsDiff(e).then(function(e){if(r.cancelled)throw y(),new Error(\"cancelled\");x.diffs=e})}function d(){return c(e,t,x.diffs,r).then(function(e){x.error=!e.ok,e.docs.forEach(function(e){delete x.diffs[e._id],o.docs_read++,x.docs.push(e)})})}function h(){if(!r.cancelled&&!x){if(0===q.length)return void p(!0);x=q.shift(),u().then(d).then(a).then(s).then(h).catch(function(e){v(\"batch processing terminated with error\",e)})}}function p(e){if(0===C.changes.length)return void(0!==q.length||x||((L&&G.live||R)&&(r.state=\"pending\",r.emit(\"paused\")),R&&y()));(e||R||C.changes.length>=N)&&(q.push(C),C={seq:0,changes:[],docs:[]},\"pending\"!==r.state&&\"stopped\"!==r.state||(r.state=\"active\",r.emit(\"active\")),h())}function v(e,t){T||(t.message||(t.message=e),o.ok=!1,o.status=\"aborting\",q=[],C={seq:0,changes:[],docs:[]},y(t))}function y(i){T||r.cancelled&&(o.status=\"cancelled\",B)||(o.status=o.status||\"complete\",o.end_time=new Date,o.last_seq=$,T=!0,i?(i=k.createError(i),i.result=o,\"unauthorized\"===i.name||\"forbidden\"===i.name?(r.emit(\"error\",i),r.removeAllListeners()):f(n,r,i,function(){l(e,t,n,r)})):(r.emit(\"complete\",o),r.removeAllListeners()))}function g(e){if(r.cancelled)return y();_.filterChange(n)(e)&&(C.seq=e.seq,C.changes.push(e),p(0===q.length&&G.live))}function E(e){if(F=!1,r.cancelled)return y();if(e.results.length>0)G.since=e.last_seq,O(),p(!0);else{var t=function(){L?(G.live=!0,O()):R=!0,p(!0)};x||0!==e.results.length?t():(B=!0,D.writeCheckpoint(e.last_seq,K).then(function(){B=!1,o.last_seq=$=e.last_seq,t()}).catch(j))}}function S(e){if(F=!1,r.cancelled)return y();v(\"changes rejected\",e)}function O(){function t(){i.cancel()}function o(){r.removeListener(\"cancel\",t)}if(!F&&!R&&q.length<M){F=!0,r._changes&&(r.removeListener(\"cancel\",r._abortChanges),r._changes.cancel()),r.once(\"cancel\",t);var i=e.changes(G).on(\"change\",g);i.then(o,o),i.then(E).catch(S),n.retry&&(r._changes=i,r._abortChanges=t)}}function A(){i().then(function(){return r.cancelled?void y():D.getCheckpoint().then(function(e){$=e,G={since:$,limit:N,batch_size:N,style:\"all_docs\",doc_ids:P,selector:U,return_docs:!0},n.filter&&(\"string\"!=typeof n.filter?G.include_docs=!0:G.filter=n.filter),\"heartbeat\"in n&&(G.heartbeat=n.heartbeat),\"timeout\"in n&&(G.timeout=n.timeout),n.query_params&&(G.query_params=n.query_params),n.view&&(G.view=n.view),O()})}).catch(function(e){v(\"getCheckpoint rejected with \",e)})}function j(e){B=!1,v(\"writeCheckpoint completed with error\",e)}var x,I,D,q=[],C={seq:0,changes:[],docs:[]},B=!1,R=!1,T=!1,$=0,L=n.continuous||n.live||!1,N=n.batch_size||100,M=n.batches_limit||10,F=!1,P=n.doc_ids,U=n.selector,z=[],K=_.uuid();o=o||{ok:!0,start_time:new Date,docs_read:0,docs_written:0,doc_write_failures:0,errors:[]};var G={};if(r.ready(e,t),r.cancelled)return void y();r._addedListeners||(r.once(\"cancel\",y),\"function\"==typeof n.complete&&(r.once(\"error\",n.complete),r.once(\"complete\",function(e){n.complete(null,e)})),r._addedListeners=!0),void 0===n.since?A():i().then(function(){return B=!0,D.writeCheckpoint(n.since,K)}).then(function(){if(B=!1,r.cancelled)return void y();$=n.since,A()}).catch(j)}function d(){E.EventEmitter.call(this),this.cancelled=!1,this.state=\"pending\";var e=this,t=new m(function(t,n){e.once(\"complete\",t),e.once(\"error\",n)});e.then=function(e,n){return t.then(e,n)},e.catch=function(e){return t.catch(e)},e.catch(function(){})}function h(e,t){var n=t.PouchConstructor;return\"string\"==typeof e?new n(e,t):e}function p(e,t,n,r){if(\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n.doc_ids&&!Array.isArray(n.doc_ids))throw k.createError(k.BAD_REQUEST,\"`doc_ids` filter parameter is not a list.\");n.complete=r,n=_.clone(n),n.continuous=n.continuous||n.live,n.retry=\"retry\"in n&&n.retry,n.PouchConstructor=n.PouchConstructor||this;var o=new d(n);return l(h(e,n),h(t,n),n,o),o}function v(e,t,n,r){return\"function\"==typeof n&&(r=n,n={}),void 0===n&&(n={}),n=_.clone(n),n.PouchConstructor=n.PouchConstructor||this,e=h(e,n),t=h(t,n),new y(e,t,n,r)}function y(e,t,n,r){function o(e){v.emit(\"change\",{direction:\"pull\",change:e})}function i(e){v.emit(\"change\",{direction:\"push\",change:e})}function a(e){v.emit(\"denied\",{direction:\"push\",doc:e})}function s(e){v.emit(\"denied\",{direction:\"pull\",doc:e})}function u(){v.pushPaused=!0,v.pullPaused&&v.emit(\"paused\")}function c(){v.pullPaused=!0,v.pushPaused&&v.emit(\"paused\")}function f(){v.pushPaused=!1,v.pullPaused&&v.emit(\"active\",{direction:\"push\"})}function l(){v.pullPaused=!1,v.pushPaused&&v.emit(\"active\",{direction:\"pull\"})}function d(e){return function(t,n){var r=\"change\"===t&&(n===o||n===i),d=\"denied\"===t&&(n===s||n===a),h=\"paused\"===t&&(n===c||n===u),p=\"active\"===t&&(n===l||n===f);(r||d||h||p)&&(t in b||(b[t]={}),b[t][e]=!0,2===Object.keys(b[t]).length&&v.removeAllListeners(t))}}function h(e,t,n){-1==e.listeners(t).indexOf(n)&&e.on(t,n)}var v=this;this.canceled=!1;var y=n.push?_.assign({},n,n.push):n,g=n.pull?_.assign({},n,n.pull):n;this.push=p(e,t,y),this.pull=p(t,e,g),this.pushPaused=!0,this.pullPaused=!0;var b={};n.live&&(this.push.on(\"complete\",v.pull.cancel.bind(v.pull)),this.pull.on(\"complete\",v.push.cancel.bind(v.push))),this.on(\"newListener\",function(e){\"change\"===e?(h(v.pull,\"change\",o),h(v.push,\"change\",i)):\"denied\"===e?(h(v.pull,\"denied\",s),h(v.push,\"denied\",a)):\"active\"===e?(h(v.pull,\"active\",l),h(v.push,\"active\",f)):\"paused\"===e&&(h(v.pull,\"paused\",c),h(v.push,\"paused\",u))}),this.on(\"removeListener\",function(e){\"change\"===e?(v.pull.removeListener(\"change\",o),v.push.removeListener(\"change\",i)):\"denied\"===e?(v.pull.removeListener(\"denied\",s),v.push.removeListener(\"denied\",a)):\"active\"===e?(v.pull.removeListener(\"active\",l),v.push.removeListener(\"active\",f)):\"paused\"===e&&(v.pull.removeListener(\"paused\",c),v.push.removeListener(\"paused\",u))}),this.pull.on(\"removeListener\",d(\"pull\")),this.push.on(\"removeListener\",d(\"push\"));var w=m.all([this.push,this.pull]).then(function(e){var t={push:e[0],pull:e[1]};return v.emit(\"complete\",t),r&&r(null,t),v.removeAllListeners(),t},function(e){if(v.cancel(),r?r(e):v.emit(\"error\",e),v.removeAllListeners(),r)throw e});this.then=function(e,t){return w.then(e,t)},this.catch=function(e){return w.catch(e)}}function g(e){e.replicate=p,e.sync=v,Object.defineProperty(e.prototype,\"replicate\",{get:function(){var e=this;return{from:function(t,n,r){return e.constructor.replicate(t,e,n,r)},to:function(t,n,r){return e.constructor.replicate(e,t,n,r)}}}}),e.prototype.sync=function(e,t,n){return this.constructor.sync(this,e,t,n)}}var m=r(e(68)),_=e(72),b=r(e(22)),w=r(e(43)),k=e(30),E=e(10),S=r(e(12)),O=0;S(d,E.EventEmitter),d.prototype.cancel=function(){this.cancelled=!0,this.state=\"cancelled\",this.emit(\"cancel\")},d.prototype.ready=function(e,t){function n(){o.cancel()}function r(){e.removeListener(\"destroyed\",n),t.removeListener(\"destroyed\",n)}var o=this;o._readyCalled||(o._readyCalled=!0,e.once(\"destroyed\",n),t.once(\"destroyed\",n),o.once(\"complete\",r))},S(y,E.EventEmitter),y.prototype.cancel=function(){this.canceled||(this.canceled=!0,this.push.cancel(),this.pull.cancel())},t.exports=g},{10:10,12:12,22:22,30:30,43:43,68:68,72:72}],71:[function(e,t,n){\"use strict\";function r(e,t){for(var n=e,r=0,o=t.length;r<o;r++){if(!(n=n[t[r]]))break}return n}function o(e,t,n){for(var r=0,o=t.length;r<o-1;r++){e=e[t[r]]={}}e[t[o-1]]=n}function i(e,t){return e<t?-1:e>t?1:0}function a(e){for(var t=[],n=\"\",r=0,o=e.length;r<o;r++){var i=e[r];\".\"===i?r>0&&\"\\\\\"===e[r-1]?n=n.substring(0,n.length-1)+\".\":(t.push(n),n=\"\"):n+=i}return t.push(n),t}function s(e){return R.indexOf(e)>-1}function u(e){return Object.keys(e)[0]}function c(e){return e[u(e)]}function f(e){var t={};return e.forEach(function(e){Object.keys(e).forEach(function(n){var r=e[n];if(\"object\"!=typeof r&&(r={$eq:r}),s(n))r instanceof Array?t[n]=r.map(function(e){return f([e])}):t[n]=f([r]);else{var o=t[n]=t[n]||{};Object.keys(r).forEach(function(e){var t=r[e];return\"$gt\"===e||\"$gte\"===e?l(e,t,o):\"$lt\"===e||\"$lte\"===e?d(e,t,o):\"$ne\"===e?h(t,o):\"$eq\"===e?p(t,o):void(o[e]=t)})}})}),t}function l(e,t,n){void 0===n.$eq&&(void 0!==n.$gte?\"$gte\"===e?t>n.$gte&&(n.$gte=t):t>=n.$gte&&(delete n.$gte,n.$gt=t):void 0!==n.$gt?\"$gte\"===e?t>n.$gt&&(delete n.$gt,n.$gte=t):t>n.$gt&&(n.$gt=t):n[e]=t)}function d(e,t,n){void 0===n.$eq&&(void 0!==n.$lte?\"$lte\"===e?t<n.$lte&&(n.$lte=t):t<=n.$lte&&(delete n.$lte,n.$lt=t):void 0!==n.$lt?\"$lte\"===e?t<n.$lt&&(delete n.$lt,n.$lte=t):t<n.$lt&&(n.$lt=t):n[e]=t)}function h(e,t){\"$ne\"in t?t.$ne.push(e):t.$ne=[e]}function p(e,t){delete t.$gt,delete t.$gte,delete t.$lt,delete t.$lte,delete t.$ne,t.$eq=e}function v(e){var t=C.clone(e),n=!1;\"$and\"in t&&(t=f(t.$and),n=!0),[\"$or\",\"$nor\"].forEach(function(e){e in t&&t[e].forEach(function(e){for(var t=Object.keys(e),n=0;n<t.length;n++){var r=t[n],o=e[r];\"object\"==typeof o&&null!==o||(e[r]={$eq:o})}})}),\"$not\"in t&&(t.$not=f([t.$not]));for(var r=Object.keys(t),o=0;o<r.length;o++){var i=r[o],a=t[i];\"object\"!=typeof a||null===a?a={$eq:a}:\"$ne\"in a&&!n&&(a.$ne=[a.$ne]),t[i]=a}return t}function y(e){function t(t){return e.map(function(e){var n=u(e),o=a(n);return r(t,o)})}return function(e,n){var r=t(e.doc),o=t(n.doc),a=B.collate(r,o);return 0!==a?a:i(e.doc._id,n.doc._id)}}function g(e,t,n){if(e=e.filter(function(e){return m(e.doc,t.selector,n)}),t.sort){var r=y(t.sort);e=e.sort(r),\"string\"!=typeof t.sort[0]&&\"desc\"===c(t.sort[0])&&(e=e.reverse())}if(\"limit\"in t||\"skip\"in t){var o=t.skip||0,i=(\"limit\"in t?t.limit:e.length)+o;e=e.slice(o,i)}return e}function m(e,t,n){return n.every(function(n){if(_(e))return!1;var o=t[n],i=a(n),u=r(e,i);return s(n)?w(n,o,e):b(o,e,i,u)})}function _(e){return/^_design\\//.test(e._id)}function b(e,t,n,r){return!e||Object.keys(e).every(function(o){var i=e[o];return k(o,t,i,n,r)})}function w(e,t,n){return\"$or\"===e?t.some(function(e){return m(n,e,Object.keys(e))}):\"$not\"===e?!m(n,t,Object.keys(t)):!t.find(function(e){return m(n,e,Object.keys(e))})}function k(e,t,n,r,o){if(!T[e])throw new Error('unknown operator \"'+e+'\" - should be one of $eq, $lte, $lt, $gt, $gte, $exists, $ne, $in, $nin, $size, $mod, $regex, $elemMatch, $type or $all');return T[e](t,n,r,o)}function E(e){return void 0!==e&&null!==e}function S(e){return void 0!==e}function O(e,t){var n=t[0],r=t[1];if(0===n)throw new Error(\"Bad divisor, cannot divide by zero\");if(parseInt(n,10)!==n)throw new Error(\"Divisor is not an integer\");if(parseInt(r,10)!==r)throw new Error(\"Modulus is not an integer\");return parseInt(e,10)===e&&e%n===r}function A(e,t){return t.some(function(t){return e instanceof Array?e.indexOf(t)>-1:e===t})}function j(e,t){return t.every(function(t){return e.indexOf(t)>-1})}function x(e,t){return e.length===t}function I(e,t){return new RegExp(t).test(e)}function D(e,t){switch(t){case\"null\":return null===e;case\"boolean\":return\"boolean\"==typeof e;case\"number\":return\"number\"==typeof e;case\"string\":return\"string\"==typeof e;case\"array\":return e instanceof Array;case\"object\":return\"[object Object]\"==={}.toString.call(e)}throw new Error(t+\" not supported as a type.Please use one of object, string, array, number, boolean or null.\")}function q(e,t){if(\"object\"!=typeof t)throw\"Selector error: expected a JSON object\";t=v(t);var n={doc:e},r=g([n],{selector:t},Object.keys(t));return r&&1===r.length}Object.defineProperty(n,\"__esModule\",{value:!0});var C=e(72),B=e(23),R=[\"$or\",\"$nor\",\"$not\"],T={$elemMatch:function(e,t,n,r){return!!Array.isArray(r)&&(0!==r.length&&(\"object\"==typeof r[0]?r.some(function(e){return m(e,t,Object.keys(t))}):r.some(function(r){return b(t,e,n,r)})))},$eq:function(e,t,n,r){return S(r)&&0===B.collate(r,t)},$gte:function(e,t,n,r){return S(r)&&B.collate(r,t)>=0},$gt:function(e,t,n,r){return S(r)&&B.collate(r,t)>0},$lte:function(e,t,n,r){return S(r)&&B.collate(r,t)<=0},$lt:function(e,t,n,r){return S(r)&&B.collate(r,t)<0},$exists:function(e,t,n,r){return t?S(r):!S(r)},$mod:function(e,t,n,r){return E(r)&&O(r,t)},$ne:function(e,t,n,r){return t.every(function(e){return 0!==B.collate(r,e)})},$in:function(e,t,n,r){return E(r)&&A(r,t)},$nin:function(e,t,n,r){return E(r)&&!A(r,t)},$size:function(e,t,n,r){return E(r)&&x(r,t)},$all:function(e,t,n,r){return Array.isArray(r)&&j(r,t)},$regex:function(e,t,n,r){return E(r)&&I(r,t)},$type:function(e,t,n,r){return D(r,t)}};n.massageSelector=v,n.matchesSelector=q,n.filterInMemoryFields=g,n.createFieldSorter=y,n.rowFilter=m,n.isCombinationalField=s,n.getKey=u,n.getValue=c,n.getFieldFromDoc=r,n.setFieldInDoc=o,n.compare=i,n.parseField=a},{23:23,72:72}],72:[function(e,t,n){\"use strict\";function r(e){return e&&\"object\"==typeof e&&\"default\"in e?e.default:e}function o(e){return\"undefined\"!=typeof ArrayBuffer&&e instanceof ArrayBuffer||\"undefined\"!=typeof Blob&&e instanceof Blob}function i(e){if(\"function\"==typeof e.slice)return e.slice(0);var t=new ArrayBuffer(e.byteLength),n=new Uint8Array(t),r=new Uint8Array(e);return n.set(r),t}function a(e){if(e instanceof ArrayBuffer)return i(e);var t=e.size,n=e.type;return\"function\"==typeof e.slice?e.slice(0,t,n):e.webkitSlice(0,t,n)}function s(e){var t=Object.getPrototypeOf(e);if(null===t)return!0;var n=t.constructor;return\"function\"==typeof n&&n instanceof n&&H.call(n)==W}function u(e){var t,n,r;if(!e||\"object\"!=typeof e)return e;if(Array.isArray(e)){for(t=[],n=0,r=e.length;n<r;n++)t[n]=u(e[n]);return t}if(e instanceof Date)return e.toISOString();if(o(e))return a(e);if(!s(e))return e;t={};for(n in e)if(Object.prototype.hasOwnProperty.call(e,n)){var i=u(e[n]);void 0!==i&&(t[n]=i)}return t}function c(e){var t=!1;return z(function(n){if(t)throw new Error(\"once called more than once\");t=!0,e.apply(this,n)})}function f(e){return z(function(t){t=u(t);var n=this,r=\"function\"==typeof t[t.length-1]&&t.pop(),o=new U(function(r,o){var i;try{var a=c(function(e,t){e?o(e):r(t)});t.push(a),i=e.apply(n,t),i&&\"function\"==typeof i.then&&r(i)}catch(e){o(e)}});return r&&o.then(function(e){r(null,e)},r),o})}function l(e,t,n){if(e.constructor.listeners(\"debug\").length){for(var r=[\"api\",e.name,t],o=0;o<n.length-1;o++)r.push(n[o]);e.constructor.emit(\"debug\",r);var i=n[n.length-1];n[n.length-1]=function(n,r){var o=[\"api\",e.name,t];o=o.concat(n?[\"error\",n]:[\"success\",r]),e.constructor.emit(\"debug\",o),i(n,r)}}}function d(e,t){return f(z(function(n){if(this._closed)return U.reject(new Error(\"database is closed\"));if(this._destroyed)return U.reject(new Error(\"database is destroyed\"));var r=this;return l(r,e,n),this.taskqueue.isReady?t.apply(this,n):new U(function(t,o){r.taskqueue.addTask(function(i){i?o(i):t(r[e].apply(r,n))})})}))}function h(e,t){for(var n={},r=0,o=t.length;r<o;r++){var i=t[r];i in e&&(n[i]=e[i])}return n}function p(e){return e}function v(e){return[{ok:e}]}function y(e,t,n){function r(){var e=[];d.forEach(function(t){t.docs.forEach(function(n){e.push({id:t.id,docs:[n]})})}),n(null,{results:e})}function o(){++l===f&&r()}function i(e,t,n){d[e]={id:t,docs:n},o()}function a(){if(!(g>=y.length)){var e=Math.min(g+X,y.length),t=y.slice(g,e);s(t,g),g+=t.length}}function s(n,r){n.forEach(function(n,o){var s=r+o,u=c.get(n),f=h(u[0],[\"atts_since\",\"attachments\"]);f.open_revs=u.map(function(e){return e.rev}),f.open_revs=f.open_revs.filter(p);var l=p;0===f.open_revs.length&&(delete f.open_revs,l=v),[\"revs\",\"attachments\",\"binary\",\"ajax\",\"latest\"].forEach(function(e){e in t&&(f[e]=t[e])}),e.get(n,f,function(e,t){var r;r=e?[{error:e}]:l(t),i(s,n,r),a()})})}var u=t.docs,c=new K.Map;u.forEach(function(e){c.has(e.id)?c.get(e.id).push(e):c.set(e.id,[e])});var f=c.size,l=0,d=new Array(f),y=[];c.forEach(function(e,t){y.push(t)});var g=0;a()}function g(){return\"undefined\"!=typeof chrome&&void 0!==chrome.storage&&void 0!==chrome.storage.local}function m(){return P}function _(e){g()?chrome.storage.onChanged.addListener(function(t){null!=t.db_name&&e.emit(t.dbName.newValue)}):m()&&(\"undefined\"!=typeof addEventListener?addEventListener(\"storage\",function(t){e.emit(t.key)}):window.attachEvent(\"storage\",function(t){e.emit(t.key)}))}function b(){G.EventEmitter.call(this),this._listeners={},_(this)}function w(e){if(\"undefined\"!==console&&e in console){var t=Array.prototype.slice.call(arguments,1);console[e].apply(console,t)}}function k(e,t){return e=parseInt(e,10)||0,t=parseInt(t,10),t!==t||t<=e?t=(e||1)<<1:t+=1,t>6e5&&(e=3e5,t=6e5),~~((t-e)*Math.random()+e)}function E(e){var t=0;return e||(t=2e3),k(e,t)}function S(e,t){w(\"info\",\"The above \"+e+\" is totally normal. \"+t)}function O(e,t,n){try{return!e(t,n)}catch(e){var r=\"Filter function threw: \"+e.toString();return Q.createError(Q.BAD_REQUEST,r)}}function A(e){var t={},n=e.filter&&\"function\"==typeof e.filter;return t.query=e.query_params,function(r){r.doc||(r.doc={});var o=n&&O(e.filter,r.doc,t);if(\"object\"==typeof o)return o;if(o)return!1;if(e.include_docs){if(!e.attachments)for(var i in r.doc._attachments)r.doc._attachments.hasOwnProperty(i)&&(r.doc._attachments[i].stub=!0)}else delete r.doc;return!0}}function j(e){for(var t=[],n=0,r=e.length;n<r;n++)t=t.concat(e[n]);return t}function x(){}function I(e){var t;if(e?\"string\"!=typeof e?t=Q.createError(Q.INVALID_ID):/^_/.test(e)&&!/^_(design|local)/.test(e)&&(t=Q.createError(Q.RESERVED_ID)):t=Q.createError(Q.MISSING_ID),t)throw t}function D(){return\"undefined\"!=typeof cordova||\"undefined\"!=typeof PhoneGap||\"undefined\"!=typeof phonegap}function q(e){return\"boolean\"==typeof e._remote?e._remote:\"function\"==typeof e.type&&(w(\"warn\",\"db.type() is deprecated and will be removed in a future version of PouchDB\"),\"http\"===e.type())}function C(e,t){\nreturn\"listenerCount\"in e?e.listenerCount(t):G.EventEmitter.listenerCount(e,t)}function B(e){if(!e)return null;var t=e.split(\"/\");return 2===t.length?t:1===t.length?[e,e]:null}function R(e){var t=B(e);return t?t.join(\"/\"):null}function T(e){for(var t=ae.exec(e),n={},r=14;r--;){var o=re[r],i=t[r]||\"\",a=-1!==[\"user\",\"password\"].indexOf(o);n[o]=a?decodeURIComponent(i):i}return n[oe]={},n[re[12]].replace(ie,function(e,t,r){t&&(n[oe][t]=r)}),n}function $(e,t){var n=[],r=[];for(var o in t)t.hasOwnProperty(o)&&(n.push(o),r.push(t[o]));return n.push(e),Function.apply(null,n).apply(null,r)}function L(e,t,n){return new U(function(r,o){e.get(t,function(i,a){if(i){if(404!==i.status)return o(i);a={}}var s=a._rev,u=n(a);if(!u)return r({updated:!1,rev:s});u._id=t,u._rev=s,r(N(e,u,n))})})}function N(e,t,n){return e.put(t).then(function(e){return{updated:!0,rev:e.rev}},function(r){if(409!==r.status)throw r;return L(e,t._id,n)})}function M(e){return 0|Math.random()*e}function F(e,t){t=t||se.length;var n=\"\",r=-1;if(e){for(;++r<e;)n+=se[M(t)];return n}for(;++r<36;)switch(r){case 8:case 13:case 18:case 23:n+=\"-\";break;case 19:n+=se[3&M(16)|8];break;default:n+=se[M(16)]}return n}Object.defineProperty(n,\"__esModule\",{value:!0});var P,U=r(e(68)),z=r(e(7)),K=e(24),G=e(10),J=r(e(12)),V=r(e(11)),Q=e(30),H=Function.prototype.toString,W=H.call(Object),X=6;if(g())P=!1;else try{localStorage.setItem(\"_pouch_check_localstorage\",1),P=!!localStorage.getItem(\"_pouch_check_localstorage\")}catch(e){P=!1}J(b,G.EventEmitter),b.prototype.addListener=function(e,t,n,r){function o(){function e(){a=!1}if(i._listeners[t]){if(a)return void(a=\"waiting\");a=!0;var s=h(r,[\"style\",\"include_docs\",\"attachments\",\"conflicts\",\"filter\",\"doc_ids\",\"view\",\"since\",\"query_params\",\"binary\"]);n.changes(s).on(\"change\",function(e){e.seq>r.since&&!r.cancelled&&(r.since=e.seq,r.onChange(e))}).on(\"complete\",function(){\"waiting\"===a&&V(o),a=!1}).on(\"error\",e)}}if(!this._listeners[t]){var i=this,a=!1;this._listeners[t]=o,this.on(e,o)}},b.prototype.removeListener=function(e,t){t in this._listeners&&(G.EventEmitter.prototype.removeListener.call(this,e,this._listeners[t]),delete this._listeners[t])},b.prototype.notifyLocalWindows=function(e){g()?chrome.storage.local.set({dbName:e}):m()&&(localStorage[e]=\"a\"===localStorage[e]?\"b\":\"a\")},b.prototype.notify=function(e){this.emit(e),this.notifyLocalWindows(e)};var Y;Y=\"function\"==typeof Object.assign?Object.assign:function(e){for(var t=Object(e),n=1;n<arguments.length;n++){var r=arguments[n];if(null!=r)for(var o in r)Object.prototype.hasOwnProperty.call(r,o)&&(t[o]=r[o])}return t};var Z,ee=Y,te=x.name;Z=te?function(e){return e.name}:function(e){return e.toString().match(/^\\s*function\\s*(\\S*)\\s*\\(/)[1]};var ne=Z,re=[\"source\",\"protocol\",\"authority\",\"userInfo\",\"user\",\"password\",\"host\",\"port\",\"relative\",\"path\",\"directory\",\"file\",\"query\",\"anchor\"],oe=\"queryKey\",ie=/(?:^|&)([^&=]*)=?([^&]*)/g,ae=/^(?:(?![^:@]+:[^:@\\/]*@)([^:\\/?#.]+):)?(?:\\/\\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\\/?#]*)(?::(\\d*))?)(((\\/(?:[^?#](?![^?#\\/]*\\.[^?#\\/.]+(?:[?#]|$)))*\\/?)?([^?#\\/]*))(?:\\?([^#]*))?(?:#(.*))?)/,se=\"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\".split(\"\");n.adapterFun=d,n.bulkGetShim=y,n.changesHandler=b,n.clone=u,n.defaultBackOff=E,n.explainError=S,n.assign=ee,n.filterChange=A,n.flatten=j,n.functionName=ne,n.guardedConsole=w,n.hasLocalStorage=m,n.invalidIdError=I,n.isChromeApp=g,n.isCordova=D,n.isRemote=q,n.listenerCount=C,n.nextTick=V,n.normalizeDdocFunctionName=R,n.once=c,n.parseDdocFunctionName=B,n.parseUri=T,n.pick=h,n.scopeEval=$,n.toPromise=f,n.upsert=L,n.uuid=F},{10:10,11:11,12:12,24:24,30:30,68:68,7:7}],73:[function(e,t,n){function r(){throw new Error(\"setTimeout has not been defined\")}function o(){throw new Error(\"clearTimeout has not been defined\")}function i(e){if(l===setTimeout)return setTimeout(e,0);if((l===r||!l)&&setTimeout)return l=setTimeout,setTimeout(e,0);try{return l(e,0)}catch(t){try{return l.call(null,e,0)}catch(t){return l.call(this,e,0)}}}function a(e){if(d===clearTimeout)return clearTimeout(e);if((d===o||!d)&&clearTimeout)return d=clearTimeout,clearTimeout(e);try{return d(e)}catch(t){try{return d.call(null,e)}catch(t){return d.call(this,e)}}}function s(){y&&p&&(y=!1,p.length?v=p.concat(v):g=-1,v.length&&u())}function u(){if(!y){var e=i(s);y=!0;for(var t=v.length;t;){for(p=v,v=[];++g<t;)p&&p[g].run();g=-1,t=v.length}p=null,y=!1,a(e)}}function c(e,t){this.fun=e,this.array=t}function f(){}var l,d,h=t.exports={};!function(){try{l=\"function\"==typeof setTimeout?setTimeout:r}catch(e){l=r}try{d=\"function\"==typeof clearTimeout?clearTimeout:o}catch(e){d=o}}();var p,v=[],y=!1,g=-1;h.nextTick=function(e){var t=new Array(arguments.length-1);if(arguments.length>1)for(var n=1;n<arguments.length;n++)t[n-1]=arguments[n];v.push(new c(e,t)),1!==v.length||y||i(u)},c.prototype.run=function(){this.fun.apply(null,this.array)},h.title=\"browser\",h.browser=!0,h.env={},h.argv=[],h.version=\"\",h.versions={},h.on=f,h.addListener=f,h.once=f,h.off=f,h.removeListener=f,h.removeAllListeners=f,h.emit=f,h.prependListener=f,h.prependOnceListener=f,h.listeners=function(e){return[]},h.binding=function(e){throw new Error(\"process.binding is not supported\")},h.cwd=function(){return\"/\"},h.chdir=function(e){throw new Error(\"process.chdir is not supported\")},h.umask=function(){return 0}},{}],74:[function(e,t,n){!function(e){if(\"object\"==typeof n)t.exports=e();else if(\"function\"==typeof define&&define.amd)define(e);else{var r;try{r=window}catch(e){r=self}r.SparkMD5=e()}}(function(e){\"use strict\";function t(e,t){var n=e[0],r=e[1],o=e[2],i=e[3];n+=(r&o|~r&i)+t[0]-680876936|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[1]-389564586|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[2]+606105819|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[3]-1044525330|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[4]-176418897|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[5]+1200080426|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[6]-1473231341|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[7]-45705983|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[8]+1770035416|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[9]-1958414417|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[10]-42063|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[11]-1990404162|0,r=(r<<22|r>>>10)+o|0,n+=(r&o|~r&i)+t[12]+1804603682|0,n=(n<<7|n>>>25)+r|0,i+=(n&r|~n&o)+t[13]-40341101|0,i=(i<<12|i>>>20)+n|0,o+=(i&n|~i&r)+t[14]-1502002290|0,o=(o<<17|o>>>15)+i|0,r+=(o&i|~o&n)+t[15]+1236535329|0,r=(r<<22|r>>>10)+o|0,n+=(r&i|o&~i)+t[1]-165796510|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[6]-1069501632|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[11]+643717713|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[0]-373897302|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[5]-701558691|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[10]+38016083|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[15]-660478335|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[4]-405537848|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[9]+568446438|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[14]-1019803690|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[3]-187363961|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[8]+1163531501|0,r=(r<<20|r>>>12)+o|0,n+=(r&i|o&~i)+t[13]-1444681467|0,n=(n<<5|n>>>27)+r|0,i+=(n&o|r&~o)+t[2]-51403784|0,i=(i<<9|i>>>23)+n|0,o+=(i&r|n&~r)+t[7]+1735328473|0,o=(o<<14|o>>>18)+i|0,r+=(o&n|i&~n)+t[12]-1926607734|0,r=(r<<20|r>>>12)+o|0,n+=(r^o^i)+t[5]-378558|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[8]-2022574463|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[11]+1839030562|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[14]-35309556|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[1]-1530992060|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[4]+1272893353|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[7]-155497632|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[10]-1094730640|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[13]+681279174|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[0]-358537222|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[3]-722521979|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[6]+76029189|0,r=(r<<23|r>>>9)+o|0,n+=(r^o^i)+t[9]-640364487|0,n=(n<<4|n>>>28)+r|0,i+=(n^r^o)+t[12]-421815835|0,i=(i<<11|i>>>21)+n|0,o+=(i^n^r)+t[15]+530742520|0,o=(o<<16|o>>>16)+i|0,r+=(o^i^n)+t[2]-995338651|0,r=(r<<23|r>>>9)+o|0,n+=(o^(r|~i))+t[0]-198630844|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[7]+1126891415|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[14]-1416354905|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[5]-57434055|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[12]+1700485571|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[3]-1894986606|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[10]-1051523|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[1]-2054922799|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[8]+1873313359|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[15]-30611744|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[6]-1560198380|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[13]+1309151649|0,r=(r<<21|r>>>11)+o|0,n+=(o^(r|~i))+t[4]-145523070|0,n=(n<<6|n>>>26)+r|0,i+=(r^(n|~o))+t[11]-1120210379|0,i=(i<<10|i>>>22)+n|0,o+=(n^(i|~r))+t[2]+718787259|0,o=(o<<15|o>>>17)+i|0,r+=(i^(o|~n))+t[9]-343485551|0,r=(r<<21|r>>>11)+o|0,e[0]=n+e[0]|0,e[1]=r+e[1]|0,e[2]=o+e[2]|0,e[3]=i+e[3]|0}function n(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e.charCodeAt(t)+(e.charCodeAt(t+1)<<8)+(e.charCodeAt(t+2)<<16)+(e.charCodeAt(t+3)<<24);return n}function r(e){var t,n=[];for(t=0;t<64;t+=4)n[t>>2]=e[t]+(e[t+1]<<8)+(e[t+2]<<16)+(e[t+3]<<24);return n}function o(e){var r,o,i,a,s,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(r=64;r<=c;r+=64)t(f,n(e.substring(r-64,r)));for(e=e.substring(r-64),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],r=0;r<o;r+=1)i[r>>2]|=e.charCodeAt(r)<<(r%4<<3);if(i[r>>2]|=128<<(r%4<<3),r>55)for(t(f,i),r=0;r<16;r+=1)i[r]=0;return a=8*c,a=a.toString(16).match(/(.*?)(.{0,8})$/),s=parseInt(a[2],16),u=parseInt(a[1],16)||0,i[14]=s,i[15]=u,t(f,i),f}function i(e){var n,o,i,a,s,u,c=e.length,f=[1732584193,-271733879,-1732584194,271733878];for(n=64;n<=c;n+=64)t(f,r(e.subarray(n-64,n)));for(e=n-64<c?e.subarray(n-64):new Uint8Array(0),o=e.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],n=0;n<o;n+=1)i[n>>2]|=e[n]<<(n%4<<3);if(i[n>>2]|=128<<(n%4<<3),n>55)for(t(f,i),n=0;n<16;n+=1)i[n]=0;return a=8*c,a=a.toString(16).match(/(.*?)(.{0,8})$/),s=parseInt(a[2],16),u=parseInt(a[1],16)||0,i[14]=s,i[15]=u,t(f,i),f}function a(e){var t,n=\"\";for(t=0;t<4;t+=1)n+=p[e>>8*t+4&15]+p[e>>8*t&15];return n}function s(e){var t;for(t=0;t<e.length;t+=1)e[t]=a(e[t]);return e.join(\"\")}function u(e){return/[\\u0080-\\uFFFF]/.test(e)&&(e=unescape(encodeURIComponent(e))),e}function c(e,t){var n,r=e.length,o=new ArrayBuffer(r),i=new Uint8Array(o);for(n=0;n<r;n+=1)i[n]=e.charCodeAt(n);return t?i:o}function f(e){return String.fromCharCode.apply(null,new Uint8Array(e))}function l(e,t,n){var r=new Uint8Array(e.byteLength+t.byteLength);return r.set(new Uint8Array(e)),r.set(new Uint8Array(t),e.byteLength),n?r:r.buffer}function d(e){var t,n=[],r=e.length;for(t=0;t<r-1;t+=2)n.push(parseInt(e.substr(t,2),16));return String.fromCharCode.apply(String,n)}function h(){this.reset()}var p=[\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\",\"a\",\"b\",\"c\",\"d\",\"e\",\"f\"];return\"5d41402abc4b2a76b9719d911017c592\"!==s(o(\"hello\"))&&function(e,t){var n=(65535&e)+(65535&t);return(e>>16)+(t>>16)+(n>>16)<<16|65535&n},\"undefined\"==typeof ArrayBuffer||ArrayBuffer.prototype.slice||function(){function t(e,t){return e=0|e||0,e<0?Math.max(e+t,0):Math.min(e,t)}ArrayBuffer.prototype.slice=function(n,r){var o,i,a,s,u=this.byteLength,c=t(n,u),f=u;return r!==e&&(f=t(r,u)),c>f?new ArrayBuffer(0):(o=f-c,i=new ArrayBuffer(o),a=new Uint8Array(i),s=new Uint8Array(this,c,o),a.set(s),i)}}(),h.prototype.append=function(e){return this.appendBinary(u(e)),this},h.prototype.appendBinary=function(e){this._buff+=e,this._length+=e.length;var r,o=this._buff.length;for(r=64;r<=o;r+=64)t(this._hash,n(this._buff.substring(r-64,r)));return this._buff=this._buff.substring(r-64),this},h.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r.charCodeAt(t)<<(t%4<<3);return this._finish(i,o),n=s(this._hash),e&&(n=d(n)),this.reset(),n},h.prototype.reset=function(){return this._buff=\"\",this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.prototype.getState=function(){return{buff:this._buff,length:this._length,hash:this._hash}},h.prototype.setState=function(e){return this._buff=e.buff,this._length=e.length,this._hash=e.hash,this},h.prototype.destroy=function(){delete this._hash,delete this._buff,delete this._length},h.prototype._finish=function(e,n){var r,o,i,a=n;if(e[a>>2]|=128<<(a%4<<3),a>55)for(t(this._hash,e),a=0;a<16;a+=1)e[a]=0;r=8*this._length,r=r.toString(16).match(/(.*?)(.{0,8})$/),o=parseInt(r[2],16),i=parseInt(r[1],16)||0,e[14]=o,e[15]=i,t(this._hash,e)},h.hash=function(e,t){return h.hashBinary(u(e),t)},h.hashBinary=function(e,t){var n=o(e),r=s(n);return t?d(r):r},h.ArrayBuffer=function(){this.reset()},h.ArrayBuffer.prototype.append=function(e){var n,o=l(this._buff.buffer,e,!0),i=o.length;for(this._length+=e.byteLength,n=64;n<=i;n+=64)t(this._hash,r(o.subarray(n-64,n)));return this._buff=n-64<i?new Uint8Array(o.buffer.slice(n-64)):new Uint8Array(0),this},h.ArrayBuffer.prototype.end=function(e){var t,n,r=this._buff,o=r.length,i=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(t=0;t<o;t+=1)i[t>>2]|=r[t]<<(t%4<<3);return this._finish(i,o),n=s(this._hash),e&&(n=d(n)),this.reset(),n},h.ArrayBuffer.prototype.reset=function(){return this._buff=new Uint8Array(0),this._length=0,this._hash=[1732584193,-271733879,-1732584194,271733878],this},h.ArrayBuffer.prototype.getState=function(){var e=h.prototype.getState.call(this);return e.buff=f(e.buff),e},h.ArrayBuffer.prototype.setState=function(e){return e.buff=c(e.buff,!0),h.prototype.setState.call(this,e)},h.ArrayBuffer.prototype.destroy=h.prototype.destroy,h.ArrayBuffer.prototype._finish=h.prototype._finish,h.ArrayBuffer.hash=function(e,t){var n=i(new Uint8Array(e)),r=s(n);return t?d(r):r},h})},{}],75:[function(e,t,n){var r=e(78),o=e(79),i=o;i.v1=r,i.v4=o,t.exports=i},{78:78,79:79}],76:[function(e,t,n){function r(e,t){var n=t||0,r=o;return r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+\"-\"+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]+r[e[n++]]}for(var o=[],i=0;i<256;++i)o[i]=(i+256).toString(16).substr(1);t.exports=r},{}],77:[function(e,t,n){var r=\"undefined\"!=typeof crypto&&crypto.getRandomValues.bind(crypto)||\"undefined\"!=typeof msCrypto&&msCrypto.getRandomValues.bind(msCrypto);if(r){var o=new Uint8Array(16);t.exports=function(){return r(o),o}}else{var i=new Array(16);t.exports=function(){for(var e,t=0;t<16;t++)0==(3&t)&&(e=4294967296*Math.random()),i[t]=e>>>((3&t)<<3)&255;return i}}},{}],78:[function(e,t,n){function r(e,t,n){var r=t&&n||0,f=t||[];e=e||{};var l=e.node||o,d=void 0!==e.clockseq?e.clockseq:i;if(null==l||null==d){var h=a();null==l&&(l=o=[1|h[0],h[1],h[2],h[3],h[4],h[5]]),null==d&&(d=i=16383&(h[6]<<8|h[7]))}var p=void 0!==e.msecs?e.msecs:(new Date).getTime(),v=void 0!==e.nsecs?e.nsecs:c+1,y=p-u+(v-c)/1e4;if(y<0&&void 0===e.clockseq&&(d=d+1&16383),(y<0||p>u)&&void 0===e.nsecs&&(v=0),v>=1e4)throw new Error(\"uuid.v1(): Can't create more than 10M uuids/sec\");u=p,c=v,i=d,p+=122192928e5;var g=(1e4*(268435455&p)+v)%4294967296;f[r++]=g>>>24&255,f[r++]=g>>>16&255,f[r++]=g>>>8&255,f[r++]=255&g;var m=p/4294967296*1e4&268435455;f[r++]=m>>>8&255,f[r++]=255&m,f[r++]=m>>>24&15|16,f[r++]=m>>>16&255,f[r++]=d>>>8|128,f[r++]=255&d;for(var _=0;_<6;++_)f[r+_]=l[_];return t||s(f)}var o,i,a=e(77),s=e(76),u=0,c=0;t.exports=r},{76:76,77:77}],79:[function(e,t,n){function r(e,t,n){var r=t&&n||0;\"string\"==typeof e&&(t=\"binary\"===e?new Array(16):null,e=null),e=e||{};var a=e.random||(e.rng||o)();if(a[6]=15&a[6]|64,a[8]=63&a[8]|128,t)for(var s=0;s<16;++s)t[r+s]=a[s];return t||i(a)}var o=e(77),i=e(76);t.exports=r},{76:76,77:77}],80:[function(e,t,n){\"use strict\";function r(e,t,n){var r=n[n.length-1];e===r.element&&(n.pop(),r=n[n.length-1]);var o=r.element,i=r.index;if(Array.isArray(o))o.push(e);else if(i===t.length-2){var a=t.pop();o[a]=e}else t.push(e)}n.stringify=function(e){var t=[];t.push({obj:e});for(var n,r,o,i,a,s,u,c,f,l,d,h=\"\";n=t.pop();)if(r=n.obj,o=n.prefix||\"\",i=n.val||\"\",h+=o,i)h+=i;else if(\"object\"!=typeof r)h+=void 0===r?null:JSON.stringify(r);else if(null===r)h+=\"null\";else if(Array.isArray(r)){for(t.push({val:\"]\"}),a=r.length-1;a>=0;a--)s=0===a?\"\":\",\",t.push({obj:r[a],prefix:s});t.push({val:\"[\"})}else{u=[];for(c in r)r.hasOwnProperty(c)&&u.push(c);for(t.push({val:\"}\"}),a=u.length-1;a>=0;a--)f=u[a],l=r[f],d=a>0?\",\":\"\",d+=JSON.stringify(f)+\":\",t.push({obj:l,prefix:d});t.push({val:\"{\"})}return h},n.parse=function(e){for(var t,n,o,i,a,s,u,c,f,l=[],d=[],h=0;;)if(\"}\"!==(t=e[h++])&&\"]\"!==t&&void 0!==t)switch(t){case\" \":case\"\\t\":case\"\\n\":case\":\":case\",\":break;case\"n\":h+=3,r(null,l,d);break;case\"t\":h+=3,r(!0,l,d);break;case\"f\":h+=4,r(!1,l,d);break;case\"0\":case\"1\":case\"2\":case\"3\":case\"4\":case\"5\":case\"6\":case\"7\":case\"8\":case\"9\":case\"-\":for(n=\"\",h--;;){if(o=e[h++],!/[\\d\\.\\-e\\+]/.test(o)){h--;break}n+=o}r(parseFloat(n),l,d);break;case'\"':for(i=\"\",a=void 0,s=0;;){if('\"'===(u=e[h++])&&(\"\\\\\"!==a||s%2!=1))break;i+=u,a=u,\"\\\\\"===a?s++:s=0}r(JSON.parse('\"'+i+'\"'),l,d);break;case\"[\":c={element:[],index:l.length},l.push(c.element),d.push(c);break;case\"{\":f={element:{},index:l.length},l.push(f.element),d.push(f);break;default:throw new Error(\"unexpectedly reached end of input: \"+t)}else{if(1===l.length)return l.pop();r(l.pop(),l,d)}}},{}]},{},[3]);";
},{}],11:[function(_dereq_,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = _dereq_(12);
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,_dereq_(20))
},{"12":12,"20":20}],12:[function(_dereq_,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = _dereq_(16);

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"16":16}],13:[function(_dereq_,module,exports){
(function (global){
'use strict';
var Mutation = global.MutationObserver || global.WebKitMutationObserver;

var scheduleDrain;

{
  if (Mutation) {
    var called = 0;
    var observer = new Mutation(nextTick);
    var element = global.document.createTextNode('');
    observer.observe(element, {
      characterData: true
    });
    scheduleDrain = function () {
      element.data = (called = ++called % 2);
    };
  } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {
    var channel = new global.MessageChannel();
    channel.port1.onmessage = nextTick;
    scheduleDrain = function () {
      channel.port2.postMessage(0);
    };
  } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {
    scheduleDrain = function () {

      // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
      // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
      var scriptEl = global.document.createElement('script');
      scriptEl.onreadystatechange = function () {
        nextTick();

        scriptEl.onreadystatechange = null;
        scriptEl.parentNode.removeChild(scriptEl);
        scriptEl = null;
      };
      global.document.documentElement.appendChild(scriptEl);
    };
  } else {
    scheduleDrain = function () {
      setTimeout(nextTick, 0);
    };
  }
}

var draining;
var queue = [];
//named nextTick for less confusing stack traces
function nextTick() {
  draining = true;
  var i, oldQueue;
  var len = queue.length;
  while (len) {
    oldQueue = queue;
    queue = [];
    i = -1;
    while (++i < len) {
      oldQueue[i]();
    }
    len = queue.length;
  }
  draining = false;
}

module.exports = immediate;
function immediate(task) {
  if (queue.push(task) === 1 && !draining) {
    scheduleDrain();
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],14:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],15:[function(_dereq_,module,exports){
(function(factory) {
  if(typeof exports === 'object') {
    factory(exports);
  } else {
    factory(this);
  }
}).call(this, function(root) { 

  var slice   = Array.prototype.slice,
      each    = Array.prototype.forEach;

  var extend = function(obj) {
    if(typeof obj !== 'object') throw obj + ' is not an object' ;

    var sources = slice.call(arguments, 1); 

    each.call(sources, function(source) {
      if(source) {
        for(var prop in source) {
          if(typeof source[prop] === 'object' && obj[prop]) {
            extend.call(obj, obj[prop], source[prop]);
          } else {
            obj[prop] = source[prop];
          }
        } 
      }
    });

    return obj;
  }

  root.extend = extend;
});

},{}],16:[function(_dereq_,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options["long"] ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],17:[function(_dereq_,module,exports){
(function (global){
"use strict";

//Abstracts constructing a Blob object, so it also works in older
//browsers that don't support the native Blob constructor. (i.e.
//old QtWebKit versions, at least).
function createBlob(parts, properties) {
  parts = parts || [];
  properties = properties || {};
  try {
    return new Blob(parts, properties);
  } catch (e) {
    if (e.name !== "TypeError") {
      throw e;
    }
    var BlobBuilder = global.BlobBuilder ||
                      global.MSBlobBuilder ||
                      global.MozBlobBuilder ||
                      global.WebKitBlobBuilder;
    var builder = new BlobBuilder();
    for (var i = 0; i < parts.length; i += 1) {
      builder.append(parts[i]);
    }
    return builder.getBlob(properties.type);
  }
}

//Can't find original post, but this is close
//http://stackoverflow.com/questions/6965107/ (continues on next line)
//converting-between-strings-and-arraybuffers
function arrayBufferToBinaryString(buffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var length = bytes.byteLength;
  for (var i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// This used to be called "fixBinary", which wasn't a very evocative name
// From http://stackoverflow.com/questions/14967647/ (continues on next line)
// encode-decode-image-with-base64-breaks-image (2013-04-21)
function binaryStringToArrayBuffer(bin) {
  var length = bin.length;
  var buf = new ArrayBuffer(length);
  var arr = new Uint8Array(buf);
  for (var i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
}

// shim for browsers that don't support it
function readAsBinaryString(blob, callback) {
  var reader = new FileReader();
  var hasBinaryString = typeof reader.readAsBinaryString === 'function';
  reader.onloadend = function (e) {
    var result = e.target.result || '';
    if (hasBinaryString) {
      return callback(result);
    }
    callback(arrayBufferToBinaryString(result));
  };
  if (hasBinaryString) {
    reader.readAsBinaryString(blob);
  } else {
    reader.readAsArrayBuffer(blob);
  }
}

// simplified API. universal browser support is assumed
function readAsArrayBuffer(blob, callback) {
  var reader = new FileReader();
  reader.onloadend = function (e) {
    var result = e.target.result || new ArrayBuffer(0);
    callback(result);
  };
  reader.readAsArrayBuffer(blob);
}

module.exports = {
  createBlob: createBlob,
  readAsArrayBuffer: readAsArrayBuffer,
  readAsBinaryString: readAsBinaryString,
  binaryStringToArrayBuffer: binaryStringToArrayBuffer,
  arrayBufferToBinaryString: arrayBufferToBinaryString
};


}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],18:[function(_dereq_,module,exports){
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var lie = _interopDefault(_dereq_(19));

/* istanbul ignore next */
var PouchPromise = typeof Promise === 'function' ? Promise : lie;

module.exports = PouchPromise;

},{"19":19}],19:[function(_dereq_,module,exports){
'use strict';
var immediate = _dereq_(13);

/* istanbul ignore next */
function INTERNAL() {}

var handlers = {};

var REJECTED = ['REJECTED'];
var FULFILLED = ['FULFILLED'];
var PENDING = ['PENDING'];

module.exports = Promise;

function Promise(resolver) {
  if (typeof resolver !== 'function') {
    throw new TypeError('resolver must be a function');
  }
  this.state = PENDING;
  this.queue = [];
  this.outcome = void 0;
  if (resolver !== INTERNAL) {
    safelyResolveThenable(this, resolver);
  }
}

Promise.prototype["catch"] = function (onRejected) {
  return this.then(null, onRejected);
};
Promise.prototype.then = function (onFulfilled, onRejected) {
  if (typeof onFulfilled !== 'function' && this.state === FULFILLED ||
    typeof onRejected !== 'function' && this.state === REJECTED) {
    return this;
  }
  var promise = new this.constructor(INTERNAL);
  if (this.state !== PENDING) {
    var resolver = this.state === FULFILLED ? onFulfilled : onRejected;
    unwrap(promise, resolver, this.outcome);
  } else {
    this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
  }

  return promise;
};
function QueueItem(promise, onFulfilled, onRejected) {
  this.promise = promise;
  if (typeof onFulfilled === 'function') {
    this.onFulfilled = onFulfilled;
    this.callFulfilled = this.otherCallFulfilled;
  }
  if (typeof onRejected === 'function') {
    this.onRejected = onRejected;
    this.callRejected = this.otherCallRejected;
  }
}
QueueItem.prototype.callFulfilled = function (value) {
  handlers.resolve(this.promise, value);
};
QueueItem.prototype.otherCallFulfilled = function (value) {
  unwrap(this.promise, this.onFulfilled, value);
};
QueueItem.prototype.callRejected = function (value) {
  handlers.reject(this.promise, value);
};
QueueItem.prototype.otherCallRejected = function (value) {
  unwrap(this.promise, this.onRejected, value);
};

function unwrap(promise, func, value) {
  immediate(function () {
    var returnValue;
    try {
      returnValue = func(value);
    } catch (e) {
      return handlers.reject(promise, e);
    }
    if (returnValue === promise) {
      handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));
    } else {
      handlers.resolve(promise, returnValue);
    }
  });
}

handlers.resolve = function (self, value) {
  var result = tryCatch(getThen, value);
  if (result.status === 'error') {
    return handlers.reject(self, result.value);
  }
  var thenable = result.value;

  if (thenable) {
    safelyResolveThenable(self, thenable);
  } else {
    self.state = FULFILLED;
    self.outcome = value;
    var i = -1;
    var len = self.queue.length;
    while (++i < len) {
      self.queue[i].callFulfilled(value);
    }
  }
  return self;
};
handlers.reject = function (self, error) {
  self.state = REJECTED;
  self.outcome = error;
  var i = -1;
  var len = self.queue.length;
  while (++i < len) {
    self.queue[i].callRejected(error);
  }
  return self;
};

function getThen(obj) {
  // Make sure we only access the accessor once as required by the spec
  var then = obj && obj.then;
  if (obj && (typeof obj === 'object' || typeof obj === 'function') && typeof then === 'function') {
    return function appyThen() {
      then.apply(obj, arguments);
    };
  }
}

function safelyResolveThenable(self, thenable) {
  // Either fulfill, reject or reject with error
  var called = false;
  function onError(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.reject(self, value);
  }

  function onSuccess(value) {
    if (called) {
      return;
    }
    called = true;
    handlers.resolve(self, value);
  }

  function tryToUnwrap() {
    thenable(onSuccess, onError);
  }

  var result = tryCatch(tryToUnwrap);
  if (result.status === 'error') {
    onError(result.value);
  }
}

function tryCatch(func, value) {
  var out = {};
  try {
    out.value = func(value);
    out.status = 'success';
  } catch (e) {
    out.status = 'error';
    out.value = e;
  }
  return out;
}

Promise.resolve = resolve;
function resolve(value) {
  if (value instanceof this) {
    return value;
  }
  return handlers.resolve(new this(INTERNAL), value);
}

Promise.reject = reject;
function reject(reason) {
  var promise = new this(INTERNAL);
  return handlers.reject(promise, reason);
}

Promise.all = all;
function all(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var values = new Array(len);
  var resolved = 0;
  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    allResolver(iterable[i], i);
  }
  return promise;
  function allResolver(value, i) {
    self.resolve(value).then(resolveFromAll, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
    function resolveFromAll(outValue) {
      values[i] = outValue;
      if (++resolved === len && !called) {
        called = true;
        handlers.resolve(promise, values);
      }
    }
  }
}

Promise.race = race;
function race(iterable) {
  var self = this;
  if (Object.prototype.toString.call(iterable) !== '[object Array]') {
    return this.reject(new TypeError('must be an array'));
  }

  var len = iterable.length;
  var called = false;
  if (!len) {
    return this.resolve([]);
  }

  var i = -1;
  var promise = new this(INTERNAL);

  while (++i < len) {
    resolver(iterable[i]);
  }
  return promise;
  function resolver(value) {
    self.resolve(value).then(function (response) {
      if (!called) {
        called = true;
        handlers.resolve(promise, response);
      }
    }, function (error) {
      if (!called) {
        called = true;
        handlers.reject(promise, error);
      }
    });
  }
}

},{"13":13}],20:[function(_dereq_,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],21:[function(_dereq_,module,exports){
'use strict';

module.exports = _dereq_(3);
},{"3":3}]},{},[21])(21)
});