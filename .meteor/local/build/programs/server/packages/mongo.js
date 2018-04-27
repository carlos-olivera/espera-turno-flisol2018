(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var NpmModuleMongodb = Package['npm-mongo'].NpmModuleMongodb;
var NpmModuleMongodbVersion = Package['npm-mongo'].NpmModuleMongodbVersion;
var AllowDeny = Package['allow-deny'].AllowDeny;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var DDP = Package['ddp-client'].DDP;
var DDPServer = Package['ddp-server'].DDPServer;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var MongoID = Package['mongo-id'].MongoID;
var check = Package.check.check;
var Match = Package.check.Match;
var ECMAScript = Package.ecmascript.ECMAScript;
var _ = Package.underscore._;
var MaxHeap = Package['binary-heap'].MaxHeap;
var MinHeap = Package['binary-heap'].MinHeap;
var MinMaxHeap = Package['binary-heap'].MinMaxHeap;
var Hook = Package['callback-hook'].Hook;
var meteorInstall = Package.modules.meteorInstall;
var meteorBabelHelpers = Package['babel-runtime'].meteorBabelHelpers;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var MongoInternals, MongoTest, MongoConnection, CursorDescription, Cursor, listenAll, forEachTrigger, OPLOG_COLLECTION, idForOp, OplogHandle, ObserveMultiplexer, ObserveHandle, DocFetcher, PollingObserveDriver, OplogObserveDriver, Mongo, selector, callback, options;

var require = meteorInstall({"node_modules":{"meteor":{"mongo":{"mongo_driver.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/mongo_driver.js                                                                                      //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
/**
 * Provide a synchronous Collection API using fibers, backed by
 * MongoDB.  This is only for use on the server, and mostly identical
 * to the client API.
 *
 * NOTE: the public API methods must be run within a fiber. If you call
 * these outside of a fiber they will explode!
 */
var MongoDB = NpmModuleMongodb;

var Future = Npm.require('fibers/future');

MongoInternals = {};
MongoTest = {};
MongoInternals.NpmModules = {
  mongodb: {
    version: NpmModuleMongodbVersion,
    module: MongoDB
  }
}; // Older version of what is now available via
// MongoInternals.NpmModules.mongodb.module.  It was never documented, but
// people do use it.
// XXX COMPAT WITH 1.0.3.2

MongoInternals.NpmModule = MongoDB; // This is used to add or remove EJSON from the beginning of everything nested
// inside an EJSON custom type. It should only be called on pure JSON!

var replaceNames = function (filter, thing) {
  if (typeof thing === "object" && thing !== null) {
    if (_.isArray(thing)) {
      return _.map(thing, _.bind(replaceNames, null, filter));
    }

    var ret = {};

    _.each(thing, function (value, key) {
      ret[filter(key)] = replaceNames(filter, value);
    });

    return ret;
  }

  return thing;
}; // Ensure that EJSON.clone keeps a Timestamp as a Timestamp (instead of just
// doing a structural clone).
// XXX how ok is this? what if there are multiple copies of MongoDB loaded?


MongoDB.Timestamp.prototype.clone = function () {
  // Timestamps should be immutable.
  return this;
};

var makeMongoLegal = function (name) {
  return "EJSON" + name;
};

var unmakeMongoLegal = function (name) {
  return name.substr(5);
};

var replaceMongoAtomWithMeteor = function (document) {
  if (document instanceof MongoDB.Binary) {
    var buffer = document.value(true);
    return new Uint8Array(buffer);
  }

  if (document instanceof MongoDB.ObjectID) {
    return new Mongo.ObjectID(document.toHexString());
  }

  if (document["EJSON$type"] && document["EJSON$value"] && _.size(document) === 2) {
    return EJSON.fromJSONValue(replaceNames(unmakeMongoLegal, document));
  }

  if (document instanceof MongoDB.Timestamp) {
    // For now, the Meteor representation of a Mongo timestamp type (not a date!
    // this is a weird internal thing used in the oplog!) is the same as the
    // Mongo representation. We need to do this explicitly or else we would do a
    // structural clone and lose the prototype.
    return document;
  }

  return undefined;
};

var replaceMeteorAtomWithMongo = function (document) {
  if (EJSON.isBinary(document)) {
    // This does more copies than we'd like, but is necessary because
    // MongoDB.BSON only looks like it takes a Uint8Array (and doesn't actually
    // serialize it correctly).
    return new MongoDB.Binary(Buffer.from(document));
  }

  if (document instanceof Mongo.ObjectID) {
    return new MongoDB.ObjectID(document.toHexString());
  }

  if (document instanceof MongoDB.Timestamp) {
    // For now, the Meteor representation of a Mongo timestamp type (not a date!
    // this is a weird internal thing used in the oplog!) is the same as the
    // Mongo representation. We need to do this explicitly or else we would do a
    // structural clone and lose the prototype.
    return document;
  }

  if (EJSON._isCustomType(document)) {
    return replaceNames(makeMongoLegal, EJSON.toJSONValue(document));
  } // It is not ordinarily possible to stick dollar-sign keys into mongo
  // so we don't bother checking for things that need escaping at this time.


  return undefined;
};

var replaceTypes = function (document, atomTransformer) {
  if (typeof document !== 'object' || document === null) return document;
  var replacedTopLevelAtom = atomTransformer(document);
  if (replacedTopLevelAtom !== undefined) return replacedTopLevelAtom;
  var ret = document;

  _.each(document, function (val, key) {
    var valReplaced = replaceTypes(val, atomTransformer);

    if (val !== valReplaced) {
      // Lazy clone. Shallow copy.
      if (ret === document) ret = _.clone(document);
      ret[key] = valReplaced;
    }
  });

  return ret;
};

MongoConnection = function (url, options) {
  var self = this;
  options = options || {};
  self._observeMultiplexers = {};
  self._onFailoverHook = new Hook();
  var mongoOptions = Object.assign({
    // Reconnect on error.
    autoReconnect: true,
    // Try to reconnect forever, instead of stopping after 30 tries (the
    // default), with each attempt separated by 1000ms.
    reconnectTries: Infinity,
    ignoreUndefined: true
  }, Mongo._connectionOptions); // Disable the native parser by default, unless specifically enabled
  // in the mongo URL.
  // - The native driver can cause errors which normally would be
  //   thrown, caught, and handled into segfaults that take down the
  //   whole app.
  // - Binary modules don't yet work when you bundle and move the bundle
  //   to a different platform (aka deploy)
  // We should revisit this after binary npm module support lands.

  if (!/[\?&]native_?[pP]arser=/.test(url)) {
    mongoOptions.native_parser = false;
  } // Internally the oplog connections specify their own poolSize
  // which we don't want to overwrite with any user defined value


  if (_.has(options, 'poolSize')) {
    // If we just set this for "server", replSet will override it. If we just
    // set it for replSet, it will be ignored if we're not using a replSet.
    mongoOptions.poolSize = options.poolSize;
  }

  self.db = null; // We keep track of the ReplSet's primary, so that we can trigger hooks when
  // it changes.  The Node driver's joined callback seems to fire way too
  // often, which is why we need to track it ourselves.

  self._primary = null;
  self._oplogHandle = null;
  self._docFetcher = null;
  var connectFuture = new Future();
  MongoDB.connect(url, mongoOptions, Meteor.bindEnvironment(function (err, db) {
    if (err) {
      throw err;
    } // First, figure out what the current primary is, if any.


    if (db.serverConfig.isMasterDoc) {
      self._primary = db.serverConfig.isMasterDoc.primary;
    }

    db.serverConfig.on('joined', Meteor.bindEnvironment(function (kind, doc) {
      if (kind === 'primary') {
        if (doc.primary !== self._primary) {
          self._primary = doc.primary;

          self._onFailoverHook.each(function (callback) {
            callback();
            return true;
          });
        }
      } else if (doc.me === self._primary) {
        // The thing we thought was primary is now something other than
        // primary.  Forget that we thought it was primary.  (This means
        // that if a server stops being primary and then starts being
        // primary again without another server becoming primary in the
        // middle, we'll correctly count it as a failover.)
        self._primary = null;
      }
    })); // Allow the constructor to return.

    connectFuture['return'](db);
  }, connectFuture.resolver() // onException
  )); // Wait for the connection to be successful; throws on failure.

  self.db = connectFuture.wait();

  if (options.oplogUrl && !Package['disable-oplog']) {
    self._oplogHandle = new OplogHandle(options.oplogUrl, self.db.databaseName);
    self._docFetcher = new DocFetcher(self);
  }
};

MongoConnection.prototype.close = function () {
  var self = this;
  if (!self.db) throw Error("close called before Connection created?"); // XXX probably untested

  var oplogHandle = self._oplogHandle;
  self._oplogHandle = null;
  if (oplogHandle) oplogHandle.stop(); // Use Future.wrap so that errors get thrown. This happens to
  // work even outside a fiber since the 'close' method is not
  // actually asynchronous.

  Future.wrap(_.bind(self.db.close, self.db))(true).wait();
}; // Returns the Mongo Collection object; may yield.


MongoConnection.prototype.rawCollection = function (collectionName) {
  var self = this;
  if (!self.db) throw Error("rawCollection called before Connection created?");
  var future = new Future();
  self.db.collection(collectionName, future.resolver());
  return future.wait();
};

MongoConnection.prototype._createCappedCollection = function (collectionName, byteSize, maxDocuments) {
  var self = this;
  if (!self.db) throw Error("_createCappedCollection called before Connection created?");
  var future = new Future();
  self.db.createCollection(collectionName, {
    capped: true,
    size: byteSize,
    max: maxDocuments
  }, future.resolver());
  future.wait();
}; // This should be called synchronously with a write, to create a
// transaction on the current write fence, if any. After we can read
// the write, and after observers have been notified (or at least,
// after the observer notifiers have added themselves to the write
// fence), you should call 'committed()' on the object returned.


MongoConnection.prototype._maybeBeginWrite = function () {
  var fence = DDPServer._CurrentWriteFence.get();

  if (fence) {
    return fence.beginWrite();
  } else {
    return {
      committed: function () {}
    };
  }
}; // Internal interface: adds a callback which is called when the Mongo primary
// changes. Returns a stop handle.


MongoConnection.prototype._onFailover = function (callback) {
  return this._onFailoverHook.register(callback);
}; //////////// Public API //////////
// The write methods block until the database has confirmed the write (it may
// not be replicated or stable on disk, but one server has confirmed it) if no
// callback is provided. If a callback is provided, then they call the callback
// when the write is confirmed. They return nothing on success, and raise an
// exception on failure.
//
// After making a write (with insert, update, remove), observers are
// notified asynchronously. If you want to receive a callback once all
// of the observer notifications have landed for your write, do the
// writes inside a write fence (set DDPServer._CurrentWriteFence to a new
// _WriteFence, and then set a callback on the write fence.)
//
// Since our execution environment is single-threaded, this is
// well-defined -- a write "has been made" if it's returned, and an
// observer "has been notified" if its callback has returned.


var writeCallback = function (write, refresh, callback) {
  return function (err, result) {
    if (!err) {
      // XXX We don't have to run this on error, right?
      try {
        refresh();
      } catch (refreshErr) {
        if (callback) {
          callback(refreshErr);
          return;
        } else {
          throw refreshErr;
        }
      }
    }

    write.committed();

    if (callback) {
      callback(err, result);
    } else if (err) {
      throw err;
    }
  };
};

var bindEnvironmentForWrite = function (callback) {
  return Meteor.bindEnvironment(callback, "Mongo write");
};

MongoConnection.prototype._insert = function (collection_name, document, callback) {
  var self = this;

  var sendError = function (e) {
    if (callback) return callback(e);
    throw e;
  };

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e._expectedByTest = true;
    sendError(e);
    return;
  }

  if (!(LocalCollection._isPlainObject(document) && !EJSON._isCustomType(document))) {
    sendError(new Error("Only plain objects may be inserted into MongoDB"));
    return;
  }

  var write = self._maybeBeginWrite();

  var refresh = function () {
    Meteor.refresh({
      collection: collection_name,
      id: document._id
    });
  };

  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

  try {
    var collection = self.rawCollection(collection_name);
    collection.insert(replaceTypes(document, replaceMeteorAtomWithMongo), {
      safe: true
    }, callback);
  } catch (err) {
    write.committed();
    throw err;
  }
}; // Cause queries that may be affected by the selector to poll in this write
// fence.


MongoConnection.prototype._refresh = function (collectionName, selector) {
  var refreshKey = {
    collection: collectionName
  }; // If we know which documents we're removing, don't poll queries that are
  // specific to other documents. (Note that multiple notifications here should
  // not cause multiple polls, since all our listener is doing is enqueueing a
  // poll.)

  var specificIds = LocalCollection._idsMatchedBySelector(selector);

  if (specificIds) {
    _.each(specificIds, function (id) {
      Meteor.refresh(_.extend({
        id: id
      }, refreshKey));
    });
  } else {
    Meteor.refresh(refreshKey);
  }
};

MongoConnection.prototype._remove = function (collection_name, selector, callback) {
  var self = this;

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e._expectedByTest = true;

    if (callback) {
      return callback(e);
    } else {
      throw e;
    }
  }

  var write = self._maybeBeginWrite();

  var refresh = function () {
    self._refresh(collection_name, selector);
  };

  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

  try {
    var collection = self.rawCollection(collection_name);

    var wrappedCallback = function (err, driverResult) {
      callback(err, transformResult(driverResult).numberAffected);
    };

    collection.remove(replaceTypes(selector, replaceMeteorAtomWithMongo), {
      safe: true
    }, wrappedCallback);
  } catch (err) {
    write.committed();
    throw err;
  }
};

MongoConnection.prototype._dropCollection = function (collectionName, cb) {
  var self = this;

  var write = self._maybeBeginWrite();

  var refresh = function () {
    Meteor.refresh({
      collection: collectionName,
      id: null,
      dropCollection: true
    });
  };

  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

  try {
    var collection = self.rawCollection(collectionName);
    collection.drop(cb);
  } catch (e) {
    write.committed();
    throw e;
  }
}; // For testing only.  Slightly better than `c.rawDatabase().dropDatabase()`
// because it lets the test's fence wait for it to be complete.


MongoConnection.prototype._dropDatabase = function (cb) {
  var self = this;

  var write = self._maybeBeginWrite();

  var refresh = function () {
    Meteor.refresh({
      dropDatabase: true
    });
  };

  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

  try {
    self.db.dropDatabase(cb);
  } catch (e) {
    write.committed();
    throw e;
  }
};

MongoConnection.prototype._update = function (collection_name, selector, mod, options, callback) {
  var self = this;

  if (!callback && options instanceof Function) {
    callback = options;
    options = null;
  }

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e._expectedByTest = true;

    if (callback) {
      return callback(e);
    } else {
      throw e;
    }
  } // explicit safety check. null and undefined can crash the mongo
  // driver. Although the node driver and minimongo do 'support'
  // non-object modifier in that they don't crash, they are not
  // meaningful operations and do not do anything. Defensively throw an
  // error here.


  if (!mod || typeof mod !== 'object') throw new Error("Invalid modifier. Modifier must be an object.");

  if (!(LocalCollection._isPlainObject(mod) && !EJSON._isCustomType(mod))) {
    throw new Error("Only plain objects may be used as replacement" + " documents in MongoDB");
  }

  if (!options) options = {};

  var write = self._maybeBeginWrite();

  var refresh = function () {
    self._refresh(collection_name, selector);
  };

  callback = writeCallback(write, refresh, callback);

  try {
    var collection = self.rawCollection(collection_name);
    var mongoOpts = {
      safe: true
    }; // explictly enumerate options that minimongo supports

    if (options.upsert) mongoOpts.upsert = true;
    if (options.multi) mongoOpts.multi = true; // Lets you get a more more full result from MongoDB. Use with caution:
    // might not work with C.upsert (as opposed to C.update({upsert:true}) or
    // with simulated upsert.

    if (options.fullResult) mongoOpts.fullResult = true;
    var mongoSelector = replaceTypes(selector, replaceMeteorAtomWithMongo);
    var mongoMod = replaceTypes(mod, replaceMeteorAtomWithMongo);

    var isModify = LocalCollection._isModificationMod(mongoMod);

    if (options._forbidReplace && !isModify) {
      var err = new Error("Invalid modifier. Replacements are forbidden.");

      if (callback) {
        return callback(err);
      } else {
        throw err;
      }
    } // We've already run replaceTypes/replaceMeteorAtomWithMongo on
    // selector and mod.  We assume it doesn't matter, as far as
    // the behavior of modifiers is concerned, whether `_modify`
    // is run on EJSON or on mongo-converted EJSON.
    // Run this code up front so that it fails fast if someone uses
    // a Mongo update operator we don't support.


    let knownId;

    if (options.upsert) {
      try {
        let newDoc = LocalCollection._createUpsertDocument(selector, mod);

        knownId = newDoc._id;
      } catch (err) {
        if (callback) {
          return callback(err);
        } else {
          throw err;
        }
      }
    }

    if (options.upsert && !isModify && !knownId && options.insertedId && !(options.insertedId instanceof Mongo.ObjectID && options.generatedId)) {
      // In case of an upsert with a replacement, where there is no _id defined
      // in either the query or the replacement doc, mongo will generate an id itself.
      // Therefore we need this special strategy if we want to control the id ourselves.
      // We don't need to do this when:
      // - This is not a replacement, so we can add an _id to $setOnInsert
      // - The id is defined by query or mod we can just add it to the replacement doc
      // - The user did not specify any id preference and the id is a Mongo ObjectId,
      //     then we can just let Mongo generate the id
      simulateUpsertWithInsertedId(collection, mongoSelector, mongoMod, options, // This callback does not need to be bindEnvironment'ed because
      // simulateUpsertWithInsertedId() wraps it and then passes it through
      // bindEnvironmentForWrite.
      function (error, result) {
        // If we got here via a upsert() call, then options._returnObject will
        // be set and we should return the whole object. Otherwise, we should
        // just return the number of affected docs to match the mongo API.
        if (result && !options._returnObject) {
          callback(error, result.numberAffected);
        } else {
          callback(error, result);
        }
      });
    } else {
      if (options.upsert && !knownId && options.insertedId && isModify) {
        if (!mongoMod.hasOwnProperty('$setOnInsert')) {
          mongoMod.$setOnInsert = {};
        }

        knownId = options.insertedId;
        Object.assign(mongoMod.$setOnInsert, replaceTypes({
          _id: options.insertedId
        }, replaceMeteorAtomWithMongo));
      }

      collection.update(mongoSelector, mongoMod, mongoOpts, bindEnvironmentForWrite(function (err, result) {
        if (!err) {
          var meteorResult = transformResult(result);

          if (meteorResult && options._returnObject) {
            // If this was an upsert() call, and we ended up
            // inserting a new doc and we know its id, then
            // return that id as well.
            if (options.upsert && meteorResult.insertedId) {
              if (knownId) {
                meteorResult.insertedId = knownId;
              } else if (meteorResult.insertedId instanceof MongoDB.ObjectID) {
                meteorResult.insertedId = new Mongo.ObjectID(meteorResult.insertedId.toHexString());
              }
            }

            callback(err, meteorResult);
          } else {
            callback(err, meteorResult.numberAffected);
          }
        } else {
          callback(err);
        }
      }));
    }
  } catch (e) {
    write.committed();
    throw e;
  }
};

var transformResult = function (driverResult) {
  var meteorResult = {
    numberAffected: 0
  };

  if (driverResult) {
    var mongoResult = driverResult.result; // On updates with upsert:true, the inserted values come as a list of
    // upserted values -- even with options.multi, when the upsert does insert,
    // it only inserts one element.

    if (mongoResult.upserted) {
      meteorResult.numberAffected += mongoResult.upserted.length;

      if (mongoResult.upserted.length == 1) {
        meteorResult.insertedId = mongoResult.upserted[0]._id;
      }
    } else {
      meteorResult.numberAffected = mongoResult.n;
    }
  }

  return meteorResult;
};

var NUM_OPTIMISTIC_TRIES = 3; // exposed for testing

MongoConnection._isCannotChangeIdError = function (err) {
  // Mongo 3.2.* returns error as next Object:
  // {name: String, code: Number, errmsg: String}
  // Older Mongo returns:
  // {name: String, code: Number, err: String}
  var error = err.errmsg || err.err; // We don't use the error code here
  // because the error code we observed it producing (16837) appears to be
  // a far more generic error code based on examining the source.

  if (error.indexOf('The _id field cannot be changed') === 0 || error.indexOf("the (immutable) field '_id' was found to have been altered to _id") !== -1) {
    return true;
  }

  return false;
};

var simulateUpsertWithInsertedId = function (collection, selector, mod, options, callback) {
  // STRATEGY: First try doing an upsert with a generated ID.
  // If this throws an error about changing the ID on an existing document
  // then without affecting the database, we know we should probably try
  // an update without the generated ID. If it affected 0 documents,
  // then without affecting the database, we the document that first
  // gave the error is probably removed and we need to try an insert again
  // We go back to step one and repeat.
  // Like all "optimistic write" schemes, we rely on the fact that it's
  // unlikely our writes will continue to be interfered with under normal
  // circumstances (though sufficiently heavy contention with writers
  // disagreeing on the existence of an object will cause writes to fail
  // in theory).
  var insertedId = options.insertedId; // must exist

  var mongoOptsForUpdate = {
    safe: true,
    multi: options.multi
  };
  var mongoOptsForInsert = {
    safe: true,
    upsert: true
  };
  var replacementWithId = Object.assign(replaceTypes({
    _id: insertedId
  }, replaceMeteorAtomWithMongo), mod);
  var tries = NUM_OPTIMISTIC_TRIES;

  var doUpdate = function () {
    tries--;

    if (!tries) {
      callback(new Error("Upsert failed after " + NUM_OPTIMISTIC_TRIES + " tries."));
    } else {
      collection.update(selector, mod, mongoOptsForUpdate, bindEnvironmentForWrite(function (err, result) {
        if (err) {
          callback(err);
        } else if (result && result.result.n != 0) {
          callback(null, {
            numberAffected: result.result.n
          });
        } else {
          doConditionalInsert();
        }
      }));
    }
  };

  var doConditionalInsert = function () {
    collection.update(selector, replacementWithId, mongoOptsForInsert, bindEnvironmentForWrite(function (err, result) {
      if (err) {
        // figure out if this is a
        // "cannot change _id of document" error, and
        // if so, try doUpdate() again, up to 3 times.
        if (MongoConnection._isCannotChangeIdError(err)) {
          doUpdate();
        } else {
          callback(err);
        }
      } else {
        callback(null, {
          numberAffected: result.result.upserted.length,
          insertedId: insertedId
        });
      }
    }));
  };

  doUpdate();
};

_.each(["insert", "update", "remove", "dropCollection", "dropDatabase"], function (method) {
  MongoConnection.prototype[method] = function ()
  /* arguments */
  {
    var self = this;
    return Meteor.wrapAsync(self["_" + method]).apply(self, arguments);
  };
}); // XXX MongoConnection.upsert() does not return the id of the inserted document
// unless you set it explicitly in the selector or modifier (as a replacement
// doc).


MongoConnection.prototype.upsert = function (collectionName, selector, mod, options, callback) {
  var self = this;

  if (typeof options === "function" && !callback) {
    callback = options;
    options = {};
  }

  return self.update(collectionName, selector, mod, _.extend({}, options, {
    upsert: true,
    _returnObject: true
  }), callback);
};

MongoConnection.prototype.find = function (collectionName, selector, options) {
  var self = this;
  if (arguments.length === 1) selector = {};
  return new Cursor(self, new CursorDescription(collectionName, selector, options));
};

MongoConnection.prototype.findOne = function (collection_name, selector, options) {
  var self = this;
  if (arguments.length === 1) selector = {};
  options = options || {};
  options.limit = 1;
  return self.find(collection_name, selector, options).fetch()[0];
}; // We'll actually design an index API later. For now, we just pass through to
// Mongo's, but make it synchronous.


MongoConnection.prototype._ensureIndex = function (collectionName, index, options) {
  var self = this; // We expect this function to be called at startup, not from within a method,
  // so we don't interact with the write fence.

  var collection = self.rawCollection(collectionName);
  var future = new Future();
  var indexName = collection.ensureIndex(index, options, future.resolver());
  future.wait();
};

MongoConnection.prototype._dropIndex = function (collectionName, index) {
  var self = this; // This function is only used by test code, not within a method, so we don't
  // interact with the write fence.

  var collection = self.rawCollection(collectionName);
  var future = new Future();
  var indexName = collection.dropIndex(index, future.resolver());
  future.wait();
}; // CURSORS
// There are several classes which relate to cursors:
//
// CursorDescription represents the arguments used to construct a cursor:
// collectionName, selector, and (find) options.  Because it is used as a key
// for cursor de-dup, everything in it should either be JSON-stringifiable or
// not affect observeChanges output (eg, options.transform functions are not
// stringifiable but do not affect observeChanges).
//
// SynchronousCursor is a wrapper around a MongoDB cursor
// which includes fully-synchronous versions of forEach, etc.
//
// Cursor is the cursor object returned from find(), which implements the
// documented Mongo.Collection cursor API.  It wraps a CursorDescription and a
// SynchronousCursor (lazily: it doesn't contact Mongo until you call a method
// like fetch or forEach on it).
//
// ObserveHandle is the "observe handle" returned from observeChanges. It has a
// reference to an ObserveMultiplexer.
//
// ObserveMultiplexer allows multiple identical ObserveHandles to be driven by a
// single observe driver.
//
// There are two "observe drivers" which drive ObserveMultiplexers:
//   - PollingObserveDriver caches the results of a query and reruns it when
//     necessary.
//   - OplogObserveDriver follows the Mongo operation log to directly observe
//     database changes.
// Both implementations follow the same simple interface: when you create them,
// they start sending observeChanges callbacks (and a ready() invocation) to
// their ObserveMultiplexer, and you stop them by calling their stop() method.


CursorDescription = function (collectionName, selector, options) {
  var self = this;
  self.collectionName = collectionName;
  self.selector = Mongo.Collection._rewriteSelector(selector);
  self.options = options || {};
};

Cursor = function (mongo, cursorDescription) {
  var self = this;
  self._mongo = mongo;
  self._cursorDescription = cursorDescription;
  self._synchronousCursor = null;
};

_.each(['forEach', 'map', 'fetch', 'count', Symbol.iterator], function (method) {
  Cursor.prototype[method] = function () {
    var self = this; // You can only observe a tailable cursor.

    if (self._cursorDescription.options.tailable) throw new Error("Cannot call " + method + " on a tailable cursor");

    if (!self._synchronousCursor) {
      self._synchronousCursor = self._mongo._createSynchronousCursor(self._cursorDescription, {
        // Make sure that the "self" argument to forEach/map callbacks is the
        // Cursor, not the SynchronousCursor.
        selfForIteration: self,
        useTransform: true
      });
    }

    return self._synchronousCursor[method].apply(self._synchronousCursor, arguments);
  };
}); // Since we don't actually have a "nextObject" interface, there's really no
// reason to have a "rewind" interface.  All it did was make multiple calls
// to fetch/map/forEach return nothing the second time.
// XXX COMPAT WITH 0.8.1


Cursor.prototype.rewind = function () {};

Cursor.prototype.getTransform = function () {
  return this._cursorDescription.options.transform;
}; // When you call Meteor.publish() with a function that returns a Cursor, we need
// to transmute it into the equivalent subscription.  This is the function that
// does that.


Cursor.prototype._publishCursor = function (sub) {
  var self = this;
  var collection = self._cursorDescription.collectionName;
  return Mongo.Collection._publishCursor(self, sub, collection);
}; // Used to guarantee that publish functions return at most one cursor per
// collection. Private, because we might later have cursors that include
// documents from multiple collections somehow.


Cursor.prototype._getCollectionName = function () {
  var self = this;
  return self._cursorDescription.collectionName;
};

Cursor.prototype.observe = function (callbacks) {
  var self = this;
  return LocalCollection._observeFromObserveChanges(self, callbacks);
};

Cursor.prototype.observeChanges = function (callbacks) {
  var self = this;
  var methods = ['addedAt', 'added', 'changedAt', 'changed', 'removedAt', 'removed', 'movedTo'];

  var ordered = LocalCollection._observeChangesCallbacksAreOrdered(callbacks); // XXX: Can we find out if callbacks are from observe?


  var exceptionName = ' observe/observeChanges callback';
  methods.forEach(function (method) {
    if (callbacks[method] && typeof callbacks[method] == "function") {
      callbacks[method] = Meteor.bindEnvironment(callbacks[method], method + exceptionName);
    }
  });
  return self._mongo._observeChanges(self._cursorDescription, ordered, callbacks);
};

MongoConnection.prototype._createSynchronousCursor = function (cursorDescription, options) {
  var self = this;
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');
  var collection = self.rawCollection(cursorDescription.collectionName);
  var cursorOptions = cursorDescription.options;
  var mongoOptions = {
    sort: cursorOptions.sort,
    limit: cursorOptions.limit,
    skip: cursorOptions.skip
  }; // Do we want a tailable cursor (which only works on capped collections)?

  if (cursorOptions.tailable) {
    // We want a tailable cursor...
    mongoOptions.tailable = true; // ... and for the server to wait a bit if any getMore has no data (rather
    // than making us put the relevant sleeps in the client)...

    mongoOptions.awaitdata = true; // ... and to keep querying the server indefinitely rather than just 5 times
    // if there's no more data.

    mongoOptions.numberOfRetries = -1; // And if this is on the oplog collection and the cursor specifies a 'ts',
    // then set the undocumented oplog replay flag, which does a special scan to
    // find the first document (instead of creating an index on ts). This is a
    // very hard-coded Mongo flag which only works on the oplog collection and
    // only works with the ts field.

    if (cursorDescription.collectionName === OPLOG_COLLECTION && cursorDescription.selector.ts) {
      mongoOptions.oplogReplay = true;
    }
  }

  var dbCursor = collection.find(replaceTypes(cursorDescription.selector, replaceMeteorAtomWithMongo), cursorOptions.fields, mongoOptions);

  if (typeof cursorOptions.maxTimeMs !== 'undefined') {
    dbCursor = dbCursor.maxTimeMS(cursorOptions.maxTimeMs);
  }

  if (typeof cursorOptions.hint !== 'undefined') {
    dbCursor = dbCursor.hint(cursorOptions.hint);
  }

  return new SynchronousCursor(dbCursor, cursorDescription, options);
};

var SynchronousCursor = function (dbCursor, cursorDescription, options) {
  var self = this;
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');
  self._dbCursor = dbCursor;
  self._cursorDescription = cursorDescription; // The "self" argument passed to forEach/map callbacks. If we're wrapped
  // inside a user-visible Cursor, we want to provide the outer cursor!

  self._selfForIteration = options.selfForIteration || self;

  if (options.useTransform && cursorDescription.options.transform) {
    self._transform = LocalCollection.wrapTransform(cursorDescription.options.transform);
  } else {
    self._transform = null;
  } // Need to specify that the callback is the first argument to nextObject,
  // since otherwise when we try to call it with no args the driver will
  // interpret "undefined" first arg as an options hash and crash.


  self._synchronousNextObject = Future.wrap(dbCursor.nextObject.bind(dbCursor), 0);
  self._synchronousCount = Future.wrap(dbCursor.count.bind(dbCursor));
  self._visitedIds = new LocalCollection._IdMap();
};

_.extend(SynchronousCursor.prototype, {
  _nextObject: function () {
    var self = this;

    while (true) {
      var doc = self._synchronousNextObject().wait();

      if (!doc) return null;
      doc = replaceTypes(doc, replaceMongoAtomWithMeteor);

      if (!self._cursorDescription.options.tailable && _.has(doc, '_id')) {
        // Did Mongo give us duplicate documents in the same cursor? If so,
        // ignore this one. (Do this before the transform, since transform might
        // return some unrelated value.) We don't do this for tailable cursors,
        // because we want to maintain O(1) memory usage. And if there isn't _id
        // for some reason (maybe it's the oplog), then we don't do this either.
        // (Be careful to do this for falsey but existing _id, though.)
        if (self._visitedIds.has(doc._id)) continue;

        self._visitedIds.set(doc._id, true);
      }

      if (self._transform) doc = self._transform(doc);
      return doc;
    }
  },
  forEach: function (callback, thisArg) {
    var self = this; // Get back to the beginning.

    self._rewind(); // We implement the loop ourself instead of using self._dbCursor.each,
    // because "each" will call its callback outside of a fiber which makes it
    // much more complex to make this function synchronous.


    var index = 0;

    while (true) {
      var doc = self._nextObject();

      if (!doc) return;
      callback.call(thisArg, doc, index++, self._selfForIteration);
    }
  },
  // XXX Allow overlapping callback executions if callback yields.
  map: function (callback, thisArg) {
    var self = this;
    var res = [];
    self.forEach(function (doc, index) {
      res.push(callback.call(thisArg, doc, index, self._selfForIteration));
    });
    return res;
  },
  _rewind: function () {
    var self = this; // known to be synchronous

    self._dbCursor.rewind();

    self._visitedIds = new LocalCollection._IdMap();
  },
  // Mostly usable for tailable cursors.
  close: function () {
    var self = this;

    self._dbCursor.close();
  },
  fetch: function () {
    var self = this;
    return self.map(_.identity);
  },
  count: function (applySkipLimit = false) {
    var self = this;
    return self._synchronousCount(applySkipLimit).wait();
  },
  // This method is NOT wrapped in Cursor.
  getRawObjects: function (ordered) {
    var self = this;

    if (ordered) {
      return self.fetch();
    } else {
      var results = new LocalCollection._IdMap();
      self.forEach(function (doc) {
        results.set(doc._id, doc);
      });
      return results;
    }
  }
});

SynchronousCursor.prototype[Symbol.iterator] = function () {
  var self = this; // Get back to the beginning.

  self._rewind();

  return {
    next() {
      const doc = self._nextObject();

      return doc ? {
        value: doc
      } : {
        done: true
      };
    }

  };
};

MongoConnection.prototype.tail = function (cursorDescription, docCallback) {
  var self = this;
  if (!cursorDescription.options.tailable) throw new Error("Can only tail a tailable cursor");

  var cursor = self._createSynchronousCursor(cursorDescription);

  var stopped = false;
  var lastTS;

  var loop = function () {
    var doc = null;

    while (true) {
      if (stopped) return;

      try {
        doc = cursor._nextObject();
      } catch (err) {
        // There's no good way to figure out if this was actually an error
        // from Mongo. Ah well. But either way, we need to retry the cursor
        // (unless the failure was because the observe got stopped).
        doc = null;
      } // Since cursor._nextObject can yield, we need to check again to see if
      // we've been stopped before calling the callback.


      if (stopped) return;

      if (doc) {
        // If a tailable cursor contains a "ts" field, use it to recreate the
        // cursor on error. ("ts" is a standard that Mongo uses internally for
        // the oplog, and there's a special flag that lets you do binary search
        // on it instead of needing to use an index.)
        lastTS = doc.ts;
        docCallback(doc);
      } else {
        var newSelector = _.clone(cursorDescription.selector);

        if (lastTS) {
          newSelector.ts = {
            $gt: lastTS
          };
        }

        cursor = self._createSynchronousCursor(new CursorDescription(cursorDescription.collectionName, newSelector, cursorDescription.options)); // Mongo failover takes many seconds.  Retry in a bit.  (Without this
        // setTimeout, we peg the CPU at 100% and never notice the actual
        // failover.

        Meteor.setTimeout(loop, 100);
        break;
      }
    }
  };

  Meteor.defer(loop);
  return {
    stop: function () {
      stopped = true;
      cursor.close();
    }
  };
};

MongoConnection.prototype._observeChanges = function (cursorDescription, ordered, callbacks) {
  var self = this;

  if (cursorDescription.options.tailable) {
    return self._observeChangesTailable(cursorDescription, ordered, callbacks);
  } // You may not filter out _id when observing changes, because the id is a core
  // part of the observeChanges API.


  if (cursorDescription.options.fields && (cursorDescription.options.fields._id === 0 || cursorDescription.options.fields._id === false)) {
    throw Error("You may not observe a cursor with {fields: {_id: 0}}");
  }

  var observeKey = EJSON.stringify(_.extend({
    ordered: ordered
  }, cursorDescription));
  var multiplexer, observeDriver;
  var firstHandle = false; // Find a matching ObserveMultiplexer, or create a new one. This next block is
  // guaranteed to not yield (and it doesn't call anything that can observe a
  // new query), so no other calls to this function can interleave with it.

  Meteor._noYieldsAllowed(function () {
    if (_.has(self._observeMultiplexers, observeKey)) {
      multiplexer = self._observeMultiplexers[observeKey];
    } else {
      firstHandle = true; // Create a new ObserveMultiplexer.

      multiplexer = new ObserveMultiplexer({
        ordered: ordered,
        onStop: function () {
          delete self._observeMultiplexers[observeKey];
          observeDriver.stop();
        }
      });
      self._observeMultiplexers[observeKey] = multiplexer;
    }
  });

  var observeHandle = new ObserveHandle(multiplexer, callbacks);

  if (firstHandle) {
    var matcher, sorter;

    var canUseOplog = _.all([function () {
      // At a bare minimum, using the oplog requires us to have an oplog, to
      // want unordered callbacks, and to not want a callback on the polls
      // that won't happen.
      return self._oplogHandle && !ordered && !callbacks._testOnlyPollCallback;
    }, function () {
      // We need to be able to compile the selector. Fall back to polling for
      // some newfangled $selector that minimongo doesn't support yet.
      try {
        matcher = new Minimongo.Matcher(cursorDescription.selector);
        return true;
      } catch (e) {
        // XXX make all compilation errors MinimongoError or something
        //     so that this doesn't ignore unrelated exceptions
        return false;
      }
    }, function () {
      // ... and the selector itself needs to support oplog.
      return OplogObserveDriver.cursorSupported(cursorDescription, matcher);
    }, function () {
      // And we need to be able to compile the sort, if any.  eg, can't be
      // {$natural: 1}.
      if (!cursorDescription.options.sort) return true;

      try {
        sorter = new Minimongo.Sorter(cursorDescription.options.sort, {
          matcher: matcher
        });
        return true;
      } catch (e) {
        // XXX make all compilation errors MinimongoError or something
        //     so that this doesn't ignore unrelated exceptions
        return false;
      }
    }], function (f) {
      return f();
    }); // invoke each function


    var driverClass = canUseOplog ? OplogObserveDriver : PollingObserveDriver;
    observeDriver = new driverClass({
      cursorDescription: cursorDescription,
      mongoHandle: self,
      multiplexer: multiplexer,
      ordered: ordered,
      matcher: matcher,
      // ignored by polling
      sorter: sorter,
      // ignored by polling
      _testOnlyPollCallback: callbacks._testOnlyPollCallback
    }); // This field is only set for use in tests.

    multiplexer._observeDriver = observeDriver;
  } // Blocks until the initial adds have been sent.


  multiplexer.addHandleAndSendInitialAdds(observeHandle);
  return observeHandle;
}; // Listen for the invalidation messages that will trigger us to poll the
// database for changes. If this selector specifies specific IDs, specify them
// here, so that updates to different specific IDs don't cause us to poll.
// listenCallback is the same kind of (notification, complete) callback passed
// to InvalidationCrossbar.listen.


listenAll = function (cursorDescription, listenCallback) {
  var listeners = [];
  forEachTrigger(cursorDescription, function (trigger) {
    listeners.push(DDPServer._InvalidationCrossbar.listen(trigger, listenCallback));
  });
  return {
    stop: function () {
      _.each(listeners, function (listener) {
        listener.stop();
      });
    }
  };
};

forEachTrigger = function (cursorDescription, triggerCallback) {
  var key = {
    collection: cursorDescription.collectionName
  };

  var specificIds = LocalCollection._idsMatchedBySelector(cursorDescription.selector);

  if (specificIds) {
    _.each(specificIds, function (id) {
      triggerCallback(_.extend({
        id: id
      }, key));
    });

    triggerCallback(_.extend({
      dropCollection: true,
      id: null
    }, key));
  } else {
    triggerCallback(key);
  } // Everyone cares about the database being dropped.


  triggerCallback({
    dropDatabase: true
  });
}; // observeChanges for tailable cursors on capped collections.
//
// Some differences from normal cursors:
//   - Will never produce anything other than 'added' or 'addedBefore'. If you
//     do update a document that has already been produced, this will not notice
//     it.
//   - If you disconnect and reconnect from Mongo, it will essentially restart
//     the query, which will lead to duplicate results. This is pretty bad,
//     but if you include a field called 'ts' which is inserted as
//     new MongoInternals.MongoTimestamp(0, 0) (which is initialized to the
//     current Mongo-style timestamp), we'll be able to find the place to
//     restart properly. (This field is specifically understood by Mongo with an
//     optimization which allows it to find the right place to start without
//     an index on ts. It's how the oplog works.)
//   - No callbacks are triggered synchronously with the call (there's no
//     differentiation between "initial data" and "later changes"; everything
//     that matches the query gets sent asynchronously).
//   - De-duplication is not implemented.
//   - Does not yet interact with the write fence. Probably, this should work by
//     ignoring removes (which don't work on capped collections) and updates
//     (which don't affect tailable cursors), and just keeping track of the ID
//     of the inserted object, and closing the write fence once you get to that
//     ID (or timestamp?).  This doesn't work well if the document doesn't match
//     the query, though.  On the other hand, the write fence can close
//     immediately if it does not match the query. So if we trust minimongo
//     enough to accurately evaluate the query against the write fence, we
//     should be able to do this...  Of course, minimongo doesn't even support
//     Mongo Timestamps yet.


MongoConnection.prototype._observeChangesTailable = function (cursorDescription, ordered, callbacks) {
  var self = this; // Tailable cursors only ever call added/addedBefore callbacks, so it's an
  // error if you didn't provide them.

  if (ordered && !callbacks.addedBefore || !ordered && !callbacks.added) {
    throw new Error("Can't observe an " + (ordered ? "ordered" : "unordered") + " tailable cursor without a " + (ordered ? "addedBefore" : "added") + " callback");
  }

  return self.tail(cursorDescription, function (doc) {
    var id = doc._id;
    delete doc._id; // The ts is an implementation detail. Hide it.

    delete doc.ts;

    if (ordered) {
      callbacks.addedBefore(id, doc, null);
    } else {
      callbacks.added(id, doc);
    }
  });
}; // XXX We probably need to find a better way to expose this. Right now
// it's only used by tests, but in fact you need it in normal
// operation to interact with capped collections.


MongoInternals.MongoTimestamp = MongoDB.Timestamp;
MongoInternals.Connection = MongoConnection;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"oplog_tailing.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/oplog_tailing.js                                                                                     //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

OPLOG_COLLECTION = 'oplog.rs';
var TOO_FAR_BEHIND = process.env.METEOR_OPLOG_TOO_FAR_BEHIND || 2000;

var showTS = function (ts) {
  return "Timestamp(" + ts.getHighBits() + ", " + ts.getLowBits() + ")";
};

idForOp = function (op) {
  if (op.op === 'd') return op.o._id;else if (op.op === 'i') return op.o._id;else if (op.op === 'u') return op.o2._id;else if (op.op === 'c') throw Error("Operator 'c' doesn't supply an object with id: " + EJSON.stringify(op));else throw Error("Unknown op: " + EJSON.stringify(op));
};

OplogHandle = function (oplogUrl, dbName) {
  var self = this;
  self._oplogUrl = oplogUrl;
  self._dbName = dbName;
  self._oplogLastEntryConnection = null;
  self._oplogTailConnection = null;
  self._stopped = false;
  self._tailHandle = null;
  self._readyFuture = new Future();
  self._crossbar = new DDPServer._Crossbar({
    factPackage: "mongo-livedata",
    factName: "oplog-watchers"
  });
  self._baseOplogSelector = {
    ns: new RegExp('^' + Meteor._escapeRegExp(self._dbName) + '\\.'),
    $or: [{
      op: {
        $in: ['i', 'u', 'd']
      }
    }, // drop collection
    {
      op: 'c',
      'o.drop': {
        $exists: true
      }
    }, {
      op: 'c',
      'o.dropDatabase': 1
    }]
  }; // Data structures to support waitUntilCaughtUp(). Each oplog entry has a
  // MongoTimestamp object on it (which is not the same as a Date --- it's a
  // combination of time and an incrementing counter; see
  // http://docs.mongodb.org/manual/reference/bson-types/#timestamps).
  //
  // _catchingUpFutures is an array of {ts: MongoTimestamp, future: Future}
  // objects, sorted by ascending timestamp. _lastProcessedTS is the
  // MongoTimestamp of the last oplog entry we've processed.
  //
  // Each time we call waitUntilCaughtUp, we take a peek at the final oplog
  // entry in the db.  If we've already processed it (ie, it is not greater than
  // _lastProcessedTS), waitUntilCaughtUp immediately returns. Otherwise,
  // waitUntilCaughtUp makes a new Future and inserts it along with the final
  // timestamp entry that it read, into _catchingUpFutures. waitUntilCaughtUp
  // then waits on that future, which is resolved once _lastProcessedTS is
  // incremented to be past its timestamp by the worker fiber.
  //
  // XXX use a priority queue or something else that's faster than an array

  self._catchingUpFutures = [];
  self._lastProcessedTS = null;
  self._onSkippedEntriesHook = new Hook({
    debugPrintExceptions: "onSkippedEntries callback"
  });
  self._entryQueue = new Meteor._DoubleEndedQueue();
  self._workerActive = false;

  self._startTailing();
};

_.extend(OplogHandle.prototype, {
  stop: function () {
    var self = this;
    if (self._stopped) return;
    self._stopped = true;
    if (self._tailHandle) self._tailHandle.stop(); // XXX should close connections too
  },
  onOplogEntry: function (trigger, callback) {
    var self = this;
    if (self._stopped) throw new Error("Called onOplogEntry on stopped handle!"); // Calling onOplogEntry requires us to wait for the tailing to be ready.

    self._readyFuture.wait();

    var originalCallback = callback;
    callback = Meteor.bindEnvironment(function (notification) {
      // XXX can we avoid this clone by making oplog.js careful?
      originalCallback(EJSON.clone(notification));
    }, function (err) {
      Meteor._debug("Error in oplog callback", err.stack);
    });

    var listenHandle = self._crossbar.listen(trigger, callback);

    return {
      stop: function () {
        listenHandle.stop();
      }
    };
  },
  // Register a callback to be invoked any time we skip oplog entries (eg,
  // because we are too far behind).
  onSkippedEntries: function (callback) {
    var self = this;
    if (self._stopped) throw new Error("Called onSkippedEntries on stopped handle!");
    return self._onSkippedEntriesHook.register(callback);
  },
  // Calls `callback` once the oplog has been processed up to a point that is
  // roughly "now": specifically, once we've processed all ops that are
  // currently visible.
  // XXX become convinced that this is actually safe even if oplogConnection
  // is some kind of pool
  waitUntilCaughtUp: function () {
    var self = this;
    if (self._stopped) throw new Error("Called waitUntilCaughtUp on stopped handle!"); // Calling waitUntilCaughtUp requries us to wait for the oplog connection to
    // be ready.

    self._readyFuture.wait();

    var lastEntry;

    while (!self._stopped) {
      // We need to make the selector at least as restrictive as the actual
      // tailing selector (ie, we need to specify the DB name) or else we might
      // find a TS that won't show up in the actual tail stream.
      try {
        lastEntry = self._oplogLastEntryConnection.findOne(OPLOG_COLLECTION, self._baseOplogSelector, {
          fields: {
            ts: 1
          },
          sort: {
            $natural: -1
          }
        });
        break;
      } catch (e) {
        // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.
        Meteor._debug("Got exception while reading last entry: " + e);

        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped) return;

    if (!lastEntry) {
      // Really, nothing in the oplog? Well, we've processed everything.
      return;
    }

    var ts = lastEntry.ts;
    if (!ts) throw Error("oplog entry without ts: " + EJSON.stringify(lastEntry));

    if (self._lastProcessedTS && ts.lessThanOrEqual(self._lastProcessedTS)) {
      // We've already caught up to here.
      return;
    } // Insert the future into our list. Almost always, this will be at the end,
    // but it's conceivable that if we fail over from one primary to another,
    // the oplog entries we see will go backwards.


    var insertAfter = self._catchingUpFutures.length;

    while (insertAfter - 1 > 0 && self._catchingUpFutures[insertAfter - 1].ts.greaterThan(ts)) {
      insertAfter--;
    }

    var f = new Future();

    self._catchingUpFutures.splice(insertAfter, 0, {
      ts: ts,
      future: f
    });

    f.wait();
  },
  _startTailing: function () {
    var self = this; // First, make sure that we're talking to the local database.

    var mongodbUri = Npm.require('mongodb-uri');

    if (mongodbUri.parse(self._oplogUrl).database !== 'local') {
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " + "a Mongo replica set");
    } // We make two separate connections to Mongo. The Node Mongo driver
    // implements a naive round-robin connection pool: each "connection" is a
    // pool of several (5 by default) TCP connections, and each request is
    // rotated through the pools. Tailable cursor queries block on the server
    // until there is some data to return (or until a few seconds have
    // passed). So if the connection pool used for tailing cursors is the same
    // pool used for other queries, the other queries will be delayed by seconds
    // 1/5 of the time.
    //
    // The tail connection will only ever be running a single tail command, so
    // it only needs to make one underlying TCP connection.


    self._oplogTailConnection = new MongoConnection(self._oplogUrl, {
      poolSize: 1
    }); // XXX better docs, but: it's to get monotonic results
    // XXX is it safe to say "if there's an in flight query, just use its
    //     results"? I don't think so but should consider that

    self._oplogLastEntryConnection = new MongoConnection(self._oplogUrl, {
      poolSize: 1
    }); // Now, make sure that there actually is a repl set here. If not, oplog
    // tailing won't ever find anything!
    // More on the isMasterDoc
    // https://docs.mongodb.com/manual/reference/command/isMaster/

    var f = new Future();

    self._oplogLastEntryConnection.db.admin().command({
      ismaster: 1
    }, f.resolver());

    var isMasterDoc = f.wait();

    if (!(isMasterDoc && isMasterDoc.setName)) {
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " + "a Mongo replica set");
    } // Find the last oplog entry.


    var lastOplogEntry = self._oplogLastEntryConnection.findOne(OPLOG_COLLECTION, {}, {
      sort: {
        $natural: -1
      },
      fields: {
        ts: 1
      }
    });

    var oplogSelector = _.clone(self._baseOplogSelector);

    if (lastOplogEntry) {
      // Start after the last entry that currently exists.
      oplogSelector.ts = {
        $gt: lastOplogEntry.ts
      }; // If there are any calls to callWhenProcessedLatest before any other
      // oplog entries show up, allow callWhenProcessedLatest to call its
      // callback immediately.

      self._lastProcessedTS = lastOplogEntry.ts;
    }

    var cursorDescription = new CursorDescription(OPLOG_COLLECTION, oplogSelector, {
      tailable: true
    });
    self._tailHandle = self._oplogTailConnection.tail(cursorDescription, function (doc) {
      self._entryQueue.push(doc);

      self._maybeStartWorker();
    });

    self._readyFuture.return();
  },
  _maybeStartWorker: function () {
    var self = this;
    if (self._workerActive) return;
    self._workerActive = true;
    Meteor.defer(function () {
      try {
        while (!self._stopped && !self._entryQueue.isEmpty()) {
          // Are we too far behind? Just tell our observers that they need to
          // repoll, and drop our queue.
          if (self._entryQueue.length > TOO_FAR_BEHIND) {
            var lastEntry = self._entryQueue.pop();

            self._entryQueue.clear();

            self._onSkippedEntriesHook.each(function (callback) {
              callback();
              return true;
            }); // Free any waitUntilCaughtUp() calls that were waiting for us to
            // pass something that we just skipped.


            self._setLastProcessedTS(lastEntry.ts);

            continue;
          }

          var doc = self._entryQueue.shift();

          if (!(doc.ns && doc.ns.length > self._dbName.length + 1 && doc.ns.substr(0, self._dbName.length + 1) === self._dbName + '.')) {
            throw new Error("Unexpected ns");
          }

          var trigger = {
            collection: doc.ns.substr(self._dbName.length + 1),
            dropCollection: false,
            dropDatabase: false,
            op: doc
          }; // Is it a special command and the collection name is hidden somewhere
          // in operator?

          if (trigger.collection === "$cmd") {
            if (doc.o.dropDatabase) {
              delete trigger.collection;
              trigger.dropDatabase = true;
            } else if (_.has(doc.o, 'drop')) {
              trigger.collection = doc.o.drop;
              trigger.dropCollection = true;
              trigger.id = null;
            } else {
              throw Error("Unknown command " + JSON.stringify(doc));
            }
          } else {
            // All other ops have an id.
            trigger.id = idForOp(doc);
          }

          self._crossbar.fire(trigger); // Now that we've processed this operation, process pending
          // sequencers.


          if (!doc.ts) throw Error("oplog entry without ts: " + EJSON.stringify(doc));

          self._setLastProcessedTS(doc.ts);
        }
      } finally {
        self._workerActive = false;
      }
    });
  },
  _setLastProcessedTS: function (ts) {
    var self = this;
    self._lastProcessedTS = ts;

    while (!_.isEmpty(self._catchingUpFutures) && self._catchingUpFutures[0].ts.lessThanOrEqual(self._lastProcessedTS)) {
      var sequencer = self._catchingUpFutures.shift();

      sequencer.future.return();
    }
  },
  //Methods used on tests to dinamically change TOO_FAR_BEHIND
  _defineTooFarBehind: function (value) {
    TOO_FAR_BEHIND = value;
  },
  _resetTooFarBehind: function () {
    TOO_FAR_BEHIND = process.env.METEOR_OPLOG_TOO_FAR_BEHIND || 2000;
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"observe_multiplex.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/observe_multiplex.js                                                                                 //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

ObserveMultiplexer = function (options) {
  var self = this;
  if (!options || !_.has(options, 'ordered')) throw Error("must specified ordered");
  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-multiplexers", 1);
  self._ordered = options.ordered;

  self._onStop = options.onStop || function () {};

  self._queue = new Meteor._SynchronousQueue();
  self._handles = {};
  self._readyFuture = new Future();
  self._cache = new LocalCollection._CachingChangeObserver({
    ordered: options.ordered
  }); // Number of addHandleAndSendInitialAdds tasks scheduled but not yet
  // running. removeHandle uses this to know if it's time to call the onStop
  // callback.

  self._addHandleTasksScheduledButNotPerformed = 0;

  _.each(self.callbackNames(), function (callbackName) {
    self[callbackName] = function ()
    /* ... */
    {
      self._applyCallback(callbackName, _.toArray(arguments));
    };
  });
};

_.extend(ObserveMultiplexer.prototype, {
  addHandleAndSendInitialAdds: function (handle) {
    var self = this; // Check this before calling runTask (even though runTask does the same
    // check) so that we don't leak an ObserveMultiplexer on error by
    // incrementing _addHandleTasksScheduledButNotPerformed and never
    // decrementing it.

    if (!self._queue.safeToRunTask()) throw new Error("Can't call observeChanges from an observe callback on the same query");
    ++self._addHandleTasksScheduledButNotPerformed;
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-handles", 1);

    self._queue.runTask(function () {
      self._handles[handle._id] = handle; // Send out whatever adds we have so far (whether or not we the
      // multiplexer is ready).

      self._sendAdds(handle);

      --self._addHandleTasksScheduledButNotPerformed;
    }); // *outside* the task, since otherwise we'd deadlock


    self._readyFuture.wait();
  },
  // Remove an observe handle. If it was the last observe handle, call the
  // onStop callback; you cannot add any more observe handles after this.
  //
  // This is not synchronized with polls and handle additions: this means that
  // you can safely call it from within an observe callback, but it also means
  // that we have to be careful when we iterate over _handles.
  removeHandle: function (id) {
    var self = this; // This should not be possible: you can only call removeHandle by having
    // access to the ObserveHandle, which isn't returned to user code until the
    // multiplex is ready.

    if (!self._ready()) throw new Error("Can't remove handles until the multiplex is ready");
    delete self._handles[id];
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-handles", -1);

    if (_.isEmpty(self._handles) && self._addHandleTasksScheduledButNotPerformed === 0) {
      self._stop();
    }
  },
  _stop: function (options) {
    var self = this;
    options = options || {}; // It shouldn't be possible for us to stop when all our handles still
    // haven't been returned from observeChanges!

    if (!self._ready() && !options.fromQueryError) throw Error("surprising _stop: not ready"); // Call stop callback (which kills the underlying process which sends us
    // callbacks and removes us from the connection's dictionary).

    self._onStop();

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-multiplexers", -1); // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop
    // callback should make our connection forget about us).

    self._handles = null;
  },
  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding
  // adds have been processed. Does not block.
  ready: function () {
    var self = this;

    self._queue.queueTask(function () {
      if (self._ready()) throw Error("can't make ObserveMultiplex ready twice!");

      self._readyFuture.return();
    });
  },
  // If trying to execute the query results in an error, call this. This is
  // intended for permanent errors, not transient network errors that could be
  // fixed. It should only be called before ready(), because if you called ready
  // that meant that you managed to run the query once. It will stop this
  // ObserveMultiplex and cause addHandleAndSendInitialAdds calls (and thus
  // observeChanges calls) to throw the error.
  queryError: function (err) {
    var self = this;

    self._queue.runTask(function () {
      if (self._ready()) throw Error("can't claim query has an error after it worked!");

      self._stop({
        fromQueryError: true
      });

      self._readyFuture.throw(err);
    });
  },
  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"
  // and observe callbacks which came before this call have been propagated to
  // all handles. "ready" must have already been called on this multiplexer.
  onFlush: function (cb) {
    var self = this;

    self._queue.queueTask(function () {
      if (!self._ready()) throw Error("only call onFlush on a multiplexer that will be ready");
      cb();
    });
  },
  callbackNames: function () {
    var self = this;
    if (self._ordered) return ["addedBefore", "changed", "movedBefore", "removed"];else return ["added", "changed", "removed"];
  },
  _ready: function () {
    return this._readyFuture.isResolved();
  },
  _applyCallback: function (callbackName, args) {
    var self = this;

    self._queue.queueTask(function () {
      // If we stopped in the meantime, do nothing.
      if (!self._handles) return; // First, apply the change to the cache.
      // XXX We could make applyChange callbacks promise not to hang on to any
      // state from their arguments (assuming that their supplied callbacks
      // don't) and skip this clone. Currently 'changed' hangs on to state
      // though.

      self._cache.applyChange[callbackName].apply(null, EJSON.clone(args)); // If we haven't finished the initial adds, then we should only be getting
      // adds.


      if (!self._ready() && callbackName !== 'added' && callbackName !== 'addedBefore') {
        throw new Error("Got " + callbackName + " during initial adds");
      } // Now multiplex the callbacks out to all observe handles. It's OK if
      // these calls yield; since we're inside a task, no other use of our queue
      // can continue until these are done. (But we do have to be careful to not
      // use a handle that got removed, because removeHandle does not use the
      // queue; thus, we iterate over an array of keys that we control.)


      _.each(_.keys(self._handles), function (handleId) {
        var handle = self._handles && self._handles[handleId];
        if (!handle) return;
        var callback = handle['_' + callbackName]; // clone arguments so that callbacks can mutate their arguments

        callback && callback.apply(null, EJSON.clone(args));
      });
    });
  },
  // Sends initial adds to a handle. It should only be called from within a task
  // (the task that is processing the addHandleAndSendInitialAdds call). It
  // synchronously invokes the handle's added or addedBefore; there's no need to
  // flush the queue afterwards to ensure that the callbacks get out.
  _sendAdds: function (handle) {
    var self = this;
    if (self._queue.safeToRunTask()) throw Error("_sendAdds may only be called from within a task!");
    var add = self._ordered ? handle._addedBefore : handle._added;
    if (!add) return; // note: docs may be an _IdMap or an OrderedDict

    self._cache.docs.forEach(function (doc, id) {
      if (!_.has(self._handles, handle._id)) throw Error("handle got removed before sending initial adds!");
      var fields = EJSON.clone(doc);
      delete fields._id;
      if (self._ordered) add(id, fields, null); // we're going in order, so add at end
      else add(id, fields);
    });
  }
});

var nextObserveHandleId = 1;

ObserveHandle = function (multiplexer, callbacks) {
  var self = this; // The end user is only supposed to call stop().  The other fields are
  // accessible to the multiplexer, though.

  self._multiplexer = multiplexer;

  _.each(multiplexer.callbackNames(), function (name) {
    if (callbacks[name]) {
      self['_' + name] = callbacks[name];
    } else if (name === "addedBefore" && callbacks.added) {
      // Special case: if you specify "added" and "movedBefore", you get an
      // ordered observe where for some reason you don't get ordering data on
      // the adds.  I dunno, we wrote tests for it, there must have been a
      // reason.
      self._addedBefore = function (id, fields, before) {
        callbacks.added(id, fields);
      };
    }
  });

  self._stopped = false;
  self._id = nextObserveHandleId++;
};

ObserveHandle.prototype.stop = function () {
  var self = this;
  if (self._stopped) return;
  self._stopped = true;

  self._multiplexer.removeHandle(self._id);
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"doc_fetcher.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/doc_fetcher.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Fiber = Npm.require('fibers');

var Future = Npm.require('fibers/future');

DocFetcher = function (mongoConnection) {
  var self = this;
  self._mongoConnection = mongoConnection; // Map from cache key -> [callback]

  self._callbacksForCacheKey = {};
};

_.extend(DocFetcher.prototype, {
  // Fetches document "id" from collectionName, returning it or null if not
  // found.
  //
  // If you make multiple calls to fetch() with the same cacheKey (a string),
  // DocFetcher may assume that they all return the same document. (It does
  // not check to see if collectionName/id match.)
  //
  // You may assume that callback is never called synchronously (and in fact
  // OplogObserveDriver does so).
  fetch: function (collectionName, id, cacheKey, callback) {
    var self = this;
    check(collectionName, String); // id is some sort of scalar

    check(cacheKey, String); // If there's already an in-progress fetch for this cache key, yield until
    // it's done and return whatever it returns.

    if (_.has(self._callbacksForCacheKey, cacheKey)) {
      self._callbacksForCacheKey[cacheKey].push(callback);

      return;
    }

    var callbacks = self._callbacksForCacheKey[cacheKey] = [callback];
    Fiber(function () {
      try {
        var doc = self._mongoConnection.findOne(collectionName, {
          _id: id
        }) || null; // Return doc to all relevant callbacks. Note that this array can
        // continue to grow during callback excecution.

        while (!_.isEmpty(callbacks)) {
          // Clone the document so that the various calls to fetch don't return
          // objects that are intertwingled with each other. Clone before
          // popping the future, so that if clone throws, the error gets passed
          // to the next callback.
          var clonedDoc = EJSON.clone(doc);
          callbacks.pop()(null, clonedDoc);
        }
      } catch (e) {
        while (!_.isEmpty(callbacks)) {
          callbacks.pop()(e);
        }
      } finally {
        // XXX consider keeping the doc around for a period of time before
        // removing from the cache
        delete self._callbacksForCacheKey[cacheKey];
      }
    }).run();
  }
});

MongoTest.DocFetcher = DocFetcher;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"polling_observe_driver.js":function(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/polling_observe_driver.js                                                                            //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
PollingObserveDriver = function (options) {
  var self = this;
  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._ordered = options.ordered;
  self._multiplexer = options.multiplexer;
  self._stopCallbacks = [];
  self._stopped = false;
  self._synchronousCursor = self._mongoHandle._createSynchronousCursor(self._cursorDescription); // previous results snapshot.  on each poll cycle, diffs against
  // results drives the callbacks.

  self._results = null; // The number of _pollMongo calls that have been added to self._taskQueue but
  // have not started running. Used to make sure we never schedule more than one
  // _pollMongo (other than possibly the one that is currently running). It's
  // also used by _suspendPolling to pretend there's a poll scheduled. Usually,
  // it's either 0 (for "no polls scheduled other than maybe one currently
  // running") or 1 (for "a poll scheduled that isn't running yet"), but it can
  // also be 2 if incremented by _suspendPolling.

  self._pollsScheduledButNotStarted = 0;
  self._pendingWrites = []; // people to notify when polling completes
  // Make sure to create a separately throttled function for each
  // PollingObserveDriver object.

  self._ensurePollIsScheduled = _.throttle(self._unthrottledEnsurePollIsScheduled, self._cursorDescription.options.pollingThrottleMs || 50
  /* ms */
  ); // XXX figure out if we still need a queue

  self._taskQueue = new Meteor._SynchronousQueue();
  var listenersHandle = listenAll(self._cursorDescription, function (notification) {
    // When someone does a transaction that might affect us, schedule a poll
    // of the database. If that transaction happens inside of a write fence,
    // block the fence until we've polled and notified observers.
    var fence = DDPServer._CurrentWriteFence.get();

    if (fence) self._pendingWrites.push(fence.beginWrite()); // Ensure a poll is scheduled... but if we already know that one is,
    // don't hit the throttled _ensurePollIsScheduled function (which might
    // lead to us calling it unnecessarily in <pollingThrottleMs> ms).

    if (self._pollsScheduledButNotStarted === 0) self._ensurePollIsScheduled();
  });

  self._stopCallbacks.push(function () {
    listenersHandle.stop();
  }); // every once and a while, poll even if we don't think we're dirty, for
  // eventual consistency with database writes from outside the Meteor
  // universe.
  //
  // For testing, there's an undocumented callback argument to observeChanges
  // which disables time-based polling and gets called at the beginning of each
  // poll.


  if (options._testOnlyPollCallback) {
    self._testOnlyPollCallback = options._testOnlyPollCallback;
  } else {
    var pollingInterval = self._cursorDescription.options.pollingIntervalMs || self._cursorDescription.options._pollingInterval || // COMPAT with 1.2
    10 * 1000;
    var intervalHandle = Meteor.setInterval(_.bind(self._ensurePollIsScheduled, self), pollingInterval);

    self._stopCallbacks.push(function () {
      Meteor.clearInterval(intervalHandle);
    });
  } // Make sure we actually poll soon!


  self._unthrottledEnsurePollIsScheduled();

  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-polling", 1);
};

_.extend(PollingObserveDriver.prototype, {
  // This is always called through _.throttle (except once at startup).
  _unthrottledEnsurePollIsScheduled: function () {
    var self = this;
    if (self._pollsScheduledButNotStarted > 0) return;
    ++self._pollsScheduledButNotStarted;

    self._taskQueue.queueTask(function () {
      self._pollMongo();
    });
  },
  // test-only interface for controlling polling.
  //
  // _suspendPolling blocks until any currently running and scheduled polls are
  // done, and prevents any further polls from being scheduled. (new
  // ObserveHandles can be added and receive their initial added callbacks,
  // though.)
  //
  // _resumePolling immediately polls, and allows further polls to occur.
  _suspendPolling: function () {
    var self = this; // Pretend that there's another poll scheduled (which will prevent
    // _ensurePollIsScheduled from queueing any more polls).

    ++self._pollsScheduledButNotStarted; // Now block until all currently running or scheduled polls are done.

    self._taskQueue.runTask(function () {}); // Confirm that there is only one "poll" (the fake one we're pretending to
    // have) scheduled.


    if (self._pollsScheduledButNotStarted !== 1) throw new Error("_pollsScheduledButNotStarted is " + self._pollsScheduledButNotStarted);
  },
  _resumePolling: function () {
    var self = this; // We should be in the same state as in the end of _suspendPolling.

    if (self._pollsScheduledButNotStarted !== 1) throw new Error("_pollsScheduledButNotStarted is " + self._pollsScheduledButNotStarted); // Run a poll synchronously (which will counteract the
    // ++_pollsScheduledButNotStarted from _suspendPolling).

    self._taskQueue.runTask(function () {
      self._pollMongo();
    });
  },
  _pollMongo: function () {
    var self = this;
    --self._pollsScheduledButNotStarted;
    if (self._stopped) return;
    var first = false;
    var newResults;
    var oldResults = self._results;

    if (!oldResults) {
      first = true; // XXX maybe use OrderedDict instead?

      oldResults = self._ordered ? [] : new LocalCollection._IdMap();
    }

    self._testOnlyPollCallback && self._testOnlyPollCallback(); // Save the list of pending writes which this round will commit.

    var writesForCycle = self._pendingWrites;
    self._pendingWrites = []; // Get the new query results. (This yields.)

    try {
      newResults = self._synchronousCursor.getRawObjects(self._ordered);
    } catch (e) {
      if (first && typeof e.code === 'number') {
        // This is an error document sent to us by mongod, not a connection
        // error generated by the client. And we've never seen this query work
        // successfully. Probably it's a bad selector or something, so we should
        // NOT retry. Instead, we should halt the observe (which ends up calling
        // `stop` on us).
        self._multiplexer.queryError(new Error("Exception while polling query " + JSON.stringify(self._cursorDescription) + ": " + e.message));

        return;
      } // getRawObjects can throw if we're having trouble talking to the
      // database.  That's fine --- we will repoll later anyway. But we should
      // make sure not to lose track of this cycle's writes.
      // (It also can throw if there's just something invalid about this query;
      // unfortunately the ObserveDriver API doesn't provide a good way to
      // "cancel" the observe from the inside in this case.


      Array.prototype.push.apply(self._pendingWrites, writesForCycle);

      Meteor._debug("Exception while polling query " + JSON.stringify(self._cursorDescription) + ": " + e.stack);

      return;
    } // Run diffs.


    if (!self._stopped) {
      LocalCollection._diffQueryChanges(self._ordered, oldResults, newResults, self._multiplexer);
    } // Signals the multiplexer to allow all observeChanges calls that share this
    // multiplexer to return. (This happens asynchronously, via the
    // multiplexer's queue.)


    if (first) self._multiplexer.ready(); // Replace self._results atomically.  (This assignment is what makes `first`
    // stay through on the next cycle, so we've waited until after we've
    // committed to ready-ing the multiplexer.)

    self._results = newResults; // Once the ObserveMultiplexer has processed everything we've done in this
    // round, mark all the writes which existed before this call as
    // commmitted. (If new writes have shown up in the meantime, there'll
    // already be another _pollMongo task scheduled.)

    self._multiplexer.onFlush(function () {
      _.each(writesForCycle, function (w) {
        w.committed();
      });
    });
  },
  stop: function () {
    var self = this;
    self._stopped = true;

    _.each(self._stopCallbacks, function (c) {
      c();
    }); // Release any write fences that are waiting on us.


    _.each(self._pendingWrites, function (w) {
      w.committed();
    });

    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-polling", -1);
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"oplog_observe_driver.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/oplog_observe_driver.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

var PHASE = {
  QUERYING: "QUERYING",
  FETCHING: "FETCHING",
  STEADY: "STEADY"
}; // Exception thrown by _needToPollQuery which unrolls the stack up to the
// enclosing call to finishIfNeedToPollQuery.

var SwitchedToQuery = function () {};

var finishIfNeedToPollQuery = function (f) {
  return function () {
    try {
      f.apply(this, arguments);
    } catch (e) {
      if (!(e instanceof SwitchedToQuery)) throw e;
    }
  };
};

var currentId = 0; // OplogObserveDriver is an alternative to PollingObserveDriver which follows
// the Mongo operation log instead of just re-polling the query. It obeys the
// same simple interface: constructing it starts sending observeChanges
// callbacks (and a ready() invocation) to the ObserveMultiplexer, and you stop
// it by calling the stop() method.

OplogObserveDriver = function (options) {
  var self = this;
  self._usesOplog = true; // tests look at this

  self._id = currentId;
  currentId++;
  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._multiplexer = options.multiplexer;

  if (options.ordered) {
    throw Error("OplogObserveDriver only supports unordered observeChanges");
  }

  var sorter = options.sorter; // We don't support $near and other geo-queries so it's OK to initialize the
  // comparator only once in the constructor.

  var comparator = sorter && sorter.getComparator();

  if (options.cursorDescription.options.limit) {
    // There are several properties ordered driver implements:
    // - _limit is a positive number
    // - _comparator is a function-comparator by which the query is ordered
    // - _unpublishedBuffer is non-null Min/Max Heap,
    //                      the empty buffer in STEADY phase implies that the
    //                      everything that matches the queries selector fits
    //                      into published set.
    // - _published - Min Heap (also implements IdMap methods)
    var heapOptions = {
      IdMap: LocalCollection._IdMap
    };
    self._limit = self._cursorDescription.options.limit;
    self._comparator = comparator;
    self._sorter = sorter;
    self._unpublishedBuffer = new MinMaxHeap(comparator, heapOptions); // We need something that can find Max value in addition to IdMap interface

    self._published = new MaxHeap(comparator, heapOptions);
  } else {
    self._limit = 0;
    self._comparator = null;
    self._sorter = null;
    self._unpublishedBuffer = null;
    self._published = new LocalCollection._IdMap();
  } // Indicates if it is safe to insert a new document at the end of the buffer
  // for this query. i.e. it is known that there are no documents matching the
  // selector those are not in published or buffer.


  self._safeAppendToBuffer = false;
  self._stopped = false;
  self._stopHandles = [];
  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-oplog", 1);

  self._registerPhaseChange(PHASE.QUERYING);

  self._matcher = options.matcher;
  var projection = self._cursorDescription.options.fields || {};
  self._projectionFn = LocalCollection._compileProjection(projection); // Projection function, result of combining important fields for selector and
  // existing fields projection

  self._sharedProjection = self._matcher.combineIntoProjection(projection);
  if (sorter) self._sharedProjection = sorter.combineIntoProjection(self._sharedProjection);
  self._sharedProjectionFn = LocalCollection._compileProjection(self._sharedProjection);
  self._needToFetch = new LocalCollection._IdMap();
  self._currentlyFetching = null;
  self._fetchGeneration = 0;
  self._requeryWhenDoneThisQuery = false;
  self._writesToCommitWhenWeReachSteady = []; // If the oplog handle tells us that it skipped some entries (because it got
  // behind, say), re-poll.

  self._stopHandles.push(self._mongoHandle._oplogHandle.onSkippedEntries(finishIfNeedToPollQuery(function () {
    self._needToPollQuery();
  })));

  forEachTrigger(self._cursorDescription, function (trigger) {
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(trigger, function (notification) {
      Meteor._noYieldsAllowed(finishIfNeedToPollQuery(function () {
        var op = notification.op;

        if (notification.dropCollection || notification.dropDatabase) {
          // Note: this call is not allowed to block on anything (especially
          // on waiting for oplog entries to catch up) because that will block
          // onOplogEntry!
          self._needToPollQuery();
        } else {
          // All other operators should be handled depending on phase
          if (self._phase === PHASE.QUERYING) {
            self._handleOplogEntryQuerying(op);
          } else {
            self._handleOplogEntrySteadyOrFetching(op);
          }
        }
      }));
    }));
  }); // XXX ordering w.r.t. everything else?

  self._stopHandles.push(listenAll(self._cursorDescription, function (notification) {
    // If we're not in a pre-fire write fence, we don't have to do anything.
    var fence = DDPServer._CurrentWriteFence.get();

    if (!fence || fence.fired) return;

    if (fence._oplogObserveDrivers) {
      fence._oplogObserveDrivers[self._id] = self;
      return;
    }

    fence._oplogObserveDrivers = {};
    fence._oplogObserveDrivers[self._id] = self;
    fence.onBeforeFire(function () {
      var drivers = fence._oplogObserveDrivers;
      delete fence._oplogObserveDrivers; // This fence cannot fire until we've caught up to "this point" in the
      // oplog, and all observers made it back to the steady state.

      self._mongoHandle._oplogHandle.waitUntilCaughtUp();

      _.each(drivers, function (driver) {
        if (driver._stopped) return;
        var write = fence.beginWrite();

        if (driver._phase === PHASE.STEADY) {
          // Make sure that all of the callbacks have made it through the
          // multiplexer and been delivered to ObserveHandles before committing
          // writes.
          driver._multiplexer.onFlush(function () {
            write.committed();
          });
        } else {
          driver._writesToCommitWhenWeReachSteady.push(write);
        }
      });
    });
  })); // When Mongo fails over, we need to repoll the query, in case we processed an
  // oplog entry that got rolled back.


  self._stopHandles.push(self._mongoHandle._onFailover(finishIfNeedToPollQuery(function () {
    self._needToPollQuery();
  }))); // Give _observeChanges a chance to add the new ObserveHandle to our
  // multiplexer, so that the added calls get streamed.


  Meteor.defer(finishIfNeedToPollQuery(function () {
    self._runInitialQuery();
  }));
};

_.extend(OplogObserveDriver.prototype, {
  _addPublished: function (id, doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var fields = _.clone(doc);

      delete fields._id;

      self._published.set(id, self._sharedProjectionFn(doc));

      self._multiplexer.added(id, self._projectionFn(fields)); // After adding this document, the published set might be overflowed
      // (exceeding capacity specified by limit). If so, push the maximum
      // element to the buffer, we might want to save it in memory to reduce the
      // amount of Mongo lookups in the future.


      if (self._limit && self._published.size() > self._limit) {
        // XXX in theory the size of published is no more than limit+1
        if (self._published.size() !== self._limit + 1) {
          throw new Error("After adding to published, " + (self._published.size() - self._limit) + " documents are overflowing the set");
        }

        var overflowingDocId = self._published.maxElementId();

        var overflowingDoc = self._published.get(overflowingDocId);

        if (EJSON.equals(overflowingDocId, id)) {
          throw new Error("The document just added is overflowing the published set");
        }

        self._published.remove(overflowingDocId);

        self._multiplexer.removed(overflowingDocId);

        self._addBuffered(overflowingDocId, overflowingDoc);
      }
    });
  },
  _removePublished: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._published.remove(id);

      self._multiplexer.removed(id);

      if (!self._limit || self._published.size() === self._limit) return;
      if (self._published.size() > self._limit) throw Error("self._published got too big"); // OK, we are publishing less than the limit. Maybe we should look in the
      // buffer to find the next element past what we were publishing before.

      if (!self._unpublishedBuffer.empty()) {
        // There's something in the buffer; move the first thing in it to
        // _published.
        var newDocId = self._unpublishedBuffer.minElementId();

        var newDoc = self._unpublishedBuffer.get(newDocId);

        self._removeBuffered(newDocId);

        self._addPublished(newDocId, newDoc);

        return;
      } // There's nothing in the buffer.  This could mean one of a few things.
      // (a) We could be in the middle of re-running the query (specifically, we
      // could be in _publishNewResults). In that case, _unpublishedBuffer is
      // empty because we clear it at the beginning of _publishNewResults. In
      // this case, our caller already knows the entire answer to the query and
      // we don't need to do anything fancy here.  Just return.


      if (self._phase === PHASE.QUERYING) return; // (b) We're pretty confident that the union of _published and
      // _unpublishedBuffer contain all documents that match selector. Because
      // _unpublishedBuffer is empty, that means we're confident that _published
      // contains all documents that match selector. So we have nothing to do.

      if (self._safeAppendToBuffer) return; // (c) Maybe there are other documents out there that should be in our
      // buffer. But in that case, when we emptied _unpublishedBuffer in
      // _removeBuffered, we should have called _needToPollQuery, which will
      // either put something in _unpublishedBuffer or set _safeAppendToBuffer
      // (or both), and it will put us in QUERYING for that whole time. So in
      // fact, we shouldn't be able to get here.

      throw new Error("Buffer inexplicably empty");
    });
  },
  _changePublished: function (id, oldDoc, newDoc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._published.set(id, self._sharedProjectionFn(newDoc));

      var projectedNew = self._projectionFn(newDoc);

      var projectedOld = self._projectionFn(oldDoc);

      var changed = DiffSequence.makeChangedFields(projectedNew, projectedOld);
      if (!_.isEmpty(changed)) self._multiplexer.changed(id, changed);
    });
  },
  _addBuffered: function (id, doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._unpublishedBuffer.set(id, self._sharedProjectionFn(doc)); // If something is overflowing the buffer, we just remove it from cache


      if (self._unpublishedBuffer.size() > self._limit) {
        var maxBufferedId = self._unpublishedBuffer.maxElementId();

        self._unpublishedBuffer.remove(maxBufferedId); // Since something matching is removed from cache (both published set and
        // buffer), set flag to false


        self._safeAppendToBuffer = false;
      }
    });
  },
  // Is called either to remove the doc completely from matching set or to move
  // it to the published set later.
  _removeBuffered: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._unpublishedBuffer.remove(id); // To keep the contract "buffer is never empty in STEADY phase unless the
      // everything matching fits into published" true, we poll everything as
      // soon as we see the buffer becoming empty.


      if (!self._unpublishedBuffer.size() && !self._safeAppendToBuffer) self._needToPollQuery();
    });
  },
  // Called when a document has joined the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _addMatching: function (doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var id = doc._id;
      if (self._published.has(id)) throw Error("tried to add something already published " + id);
      if (self._limit && self._unpublishedBuffer.has(id)) throw Error("tried to add something already existed in buffer " + id);
      var limit = self._limit;
      var comparator = self._comparator;
      var maxPublished = limit && self._published.size() > 0 ? self._published.get(self._published.maxElementId()) : null;
      var maxBuffered = limit && self._unpublishedBuffer.size() > 0 ? self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()) : null; // The query is unlimited or didn't publish enough documents yet or the
      // new document would fit into published set pushing the maximum element
      // out, then we need to publish the doc.

      var toPublish = !limit || self._published.size() < limit || comparator(doc, maxPublished) < 0; // Otherwise we might need to buffer it (only in case of limited query).
      // Buffering is allowed if the buffer is not filled up yet and all
      // matching docs are either in the published set or in the buffer.

      var canAppendToBuffer = !toPublish && self._safeAppendToBuffer && self._unpublishedBuffer.size() < limit; // Or if it is small enough to be safely inserted to the middle or the
      // beginning of the buffer.

      var canInsertIntoBuffer = !toPublish && maxBuffered && comparator(doc, maxBuffered) <= 0;
      var toBuffer = canAppendToBuffer || canInsertIntoBuffer;

      if (toPublish) {
        self._addPublished(id, doc);
      } else if (toBuffer) {
        self._addBuffered(id, doc);
      } else {
        // dropping it and not saving to the cache
        self._safeAppendToBuffer = false;
      }
    });
  },
  // Called when a document leaves the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _removeMatching: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (!self._published.has(id) && !self._limit) throw Error("tried to remove something matching but not cached " + id);

      if (self._published.has(id)) {
        self._removePublished(id);
      } else if (self._unpublishedBuffer.has(id)) {
        self._removeBuffered(id);
      }
    });
  },
  _handleDoc: function (id, newDoc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var matchesNow = newDoc && self._matcher.documentMatches(newDoc).result;

      var publishedBefore = self._published.has(id);

      var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

      var cachedBefore = publishedBefore || bufferedBefore;

      if (matchesNow && !cachedBefore) {
        self._addMatching(newDoc);
      } else if (cachedBefore && !matchesNow) {
        self._removeMatching(id);
      } else if (cachedBefore && matchesNow) {
        var oldDoc = self._published.get(id);

        var comparator = self._comparator;

        var minBuffered = self._limit && self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.minElementId());

        var maxBuffered;

        if (publishedBefore) {
          // Unlimited case where the document stays in published once it
          // matches or the case when we don't have enough matching docs to
          // publish or the changed but matching doc will stay in published
          // anyways.
          //
          // XXX: We rely on the emptiness of buffer. Be sure to maintain the
          // fact that buffer can't be empty if there are matching documents not
          // published. Notably, we don't want to schedule repoll and continue
          // relying on this property.
          var staysInPublished = !self._limit || self._unpublishedBuffer.size() === 0 || comparator(newDoc, minBuffered) <= 0;

          if (staysInPublished) {
            self._changePublished(id, oldDoc, newDoc);
          } else {
            // after the change doc doesn't stay in the published, remove it
            self._removePublished(id); // but it can move into buffered now, check it


            maxBuffered = self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId());
            var toBuffer = self._safeAppendToBuffer || maxBuffered && comparator(newDoc, maxBuffered) <= 0;

            if (toBuffer) {
              self._addBuffered(id, newDoc);
            } else {
              // Throw away from both published set and buffer
              self._safeAppendToBuffer = false;
            }
          }
        } else if (bufferedBefore) {
          oldDoc = self._unpublishedBuffer.get(id); // remove the old version manually instead of using _removeBuffered so
          // we don't trigger the querying immediately.  if we end this block
          // with the buffer empty, we will need to trigger the query poll
          // manually too.

          self._unpublishedBuffer.remove(id);

          var maxPublished = self._published.get(self._published.maxElementId());

          maxBuffered = self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()); // the buffered doc was updated, it could move to published

          var toPublish = comparator(newDoc, maxPublished) < 0; // or stays in buffer even after the change

          var staysInBuffer = !toPublish && self._safeAppendToBuffer || !toPublish && maxBuffered && comparator(newDoc, maxBuffered) <= 0;

          if (toPublish) {
            self._addPublished(id, newDoc);
          } else if (staysInBuffer) {
            // stays in buffer but changes
            self._unpublishedBuffer.set(id, newDoc);
          } else {
            // Throw away from both published set and buffer
            self._safeAppendToBuffer = false; // Normally this check would have been done in _removeBuffered but
            // we didn't use it, so we need to do it ourself now.

            if (!self._unpublishedBuffer.size()) {
              self._needToPollQuery();
            }
          }
        } else {
          throw new Error("cachedBefore implies either of publishedBefore or bufferedBefore is true.");
        }
      }
    });
  },
  _fetchModifiedDocuments: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.FETCHING); // Defer, because nothing called from the oplog entry handler may yield,
      // but fetch() yields.


      Meteor.defer(finishIfNeedToPollQuery(function () {
        while (!self._stopped && !self._needToFetch.empty()) {
          if (self._phase === PHASE.QUERYING) {
            // While fetching, we decided to go into QUERYING mode, and then we
            // saw another oplog entry, so _needToFetch is not empty. But we
            // shouldn't fetch these documents until AFTER the query is done.
            break;
          } // Being in steady phase here would be surprising.


          if (self._phase !== PHASE.FETCHING) throw new Error("phase in fetchModifiedDocuments: " + self._phase);
          self._currentlyFetching = self._needToFetch;
          var thisGeneration = ++self._fetchGeneration;
          self._needToFetch = new LocalCollection._IdMap();
          var waiting = 0;
          var fut = new Future(); // This loop is safe, because _currentlyFetching will not be updated
          // during this loop (in fact, it is never mutated).

          self._currentlyFetching.forEach(function (cacheKey, id) {
            waiting++;

            self._mongoHandle._docFetcher.fetch(self._cursorDescription.collectionName, id, cacheKey, finishIfNeedToPollQuery(function (err, doc) {
              try {
                if (err) {
                  Meteor._debug("Got exception while fetching documents: " + err); // If we get an error from the fetcher (eg, trouble
                  // connecting to Mongo), let's just abandon the fetch phase
                  // altogether and fall back to polling. It's not like we're
                  // getting live updates anyway.


                  if (self._phase !== PHASE.QUERYING) {
                    self._needToPollQuery();
                  }
                } else if (!self._stopped && self._phase === PHASE.FETCHING && self._fetchGeneration === thisGeneration) {
                  // We re-check the generation in case we've had an explicit
                  // _pollQuery call (eg, in another fiber) which should
                  // effectively cancel this round of fetches.  (_pollQuery
                  // increments the generation.)
                  self._handleDoc(id, doc);
                }
              } finally {
                waiting--; // Because fetch() never calls its callback synchronously,
                // this is safe (ie, we won't call fut.return() before the
                // forEach is done).

                if (waiting === 0) fut.return();
              }
            }));
          });

          fut.wait(); // Exit now if we've had a _pollQuery call (here or in another fiber).

          if (self._phase === PHASE.QUERYING) return;
          self._currentlyFetching = null;
        } // We're done fetching, so we can be steady, unless we've had a
        // _pollQuery call (here or in another fiber).


        if (self._phase !== PHASE.QUERYING) self._beSteady();
      }));
    });
  },
  _beSteady: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.STEADY);

      var writes = self._writesToCommitWhenWeReachSteady;
      self._writesToCommitWhenWeReachSteady = [];

      self._multiplexer.onFlush(function () {
        _.each(writes, function (w) {
          w.committed();
        });
      });
    });
  },
  _handleOplogEntryQuerying: function (op) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._needToFetch.set(idForOp(op), op.ts.toString());
    });
  },
  _handleOplogEntrySteadyOrFetching: function (op) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var id = idForOp(op); // If we're already fetching this one, or about to, we can't optimize;
      // make sure that we fetch it again if necessary.

      if (self._phase === PHASE.FETCHING && (self._currentlyFetching && self._currentlyFetching.has(id) || self._needToFetch.has(id))) {
        self._needToFetch.set(id, op.ts.toString());

        return;
      }

      if (op.op === 'd') {
        if (self._published.has(id) || self._limit && self._unpublishedBuffer.has(id)) self._removeMatching(id);
      } else if (op.op === 'i') {
        if (self._published.has(id)) throw new Error("insert found for already-existing ID in published");
        if (self._unpublishedBuffer && self._unpublishedBuffer.has(id)) throw new Error("insert found for already-existing ID in buffer"); // XXX what if selector yields?  for now it can't but later it could
        // have $where

        if (self._matcher.documentMatches(op.o).result) self._addMatching(op.o);
      } else if (op.op === 'u') {
        // Is this a modifier ($set/$unset, which may require us to poll the
        // database to figure out if the whole document matches the selector) or
        // a replacement (in which case we can just directly re-evaluate the
        // selector)?
        var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset'); // If this modifier modifies something inside an EJSON custom type (ie,
        // anything with EJSON$), then we can't try to use
        // LocalCollection._modify, since that just mutates the EJSON encoding,
        // not the actual object.

        var canDirectlyModifyDoc = !isReplace && modifierCanBeDirectlyApplied(op.o);

        var publishedBefore = self._published.has(id);

        var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

        if (isReplace) {
          self._handleDoc(id, _.extend({
            _id: id
          }, op.o));
        } else if ((publishedBefore || bufferedBefore) && canDirectlyModifyDoc) {
          // Oh great, we actually know what the document is, so we can apply
          // this directly.
          var newDoc = self._published.has(id) ? self._published.get(id) : self._unpublishedBuffer.get(id);
          newDoc = EJSON.clone(newDoc);
          newDoc._id = id;

          try {
            LocalCollection._modify(newDoc, op.o);
          } catch (e) {
            if (e.name !== "MinimongoError") throw e; // We didn't understand the modifier.  Re-fetch.

            self._needToFetch.set(id, op.ts.toString());

            if (self._phase === PHASE.STEADY) {
              self._fetchModifiedDocuments();
            }

            return;
          }

          self._handleDoc(id, self._sharedProjectionFn(newDoc));
        } else if (!canDirectlyModifyDoc || self._matcher.canBecomeTrueByModifier(op.o) || self._sorter && self._sorter.affectedByModifier(op.o)) {
          self._needToFetch.set(id, op.ts.toString());

          if (self._phase === PHASE.STEADY) self._fetchModifiedDocuments();
        }
      } else {
        throw Error("XXX SURPRISING OPERATION: " + op);
      }
    });
  },
  // Yields!
  _runInitialQuery: function () {
    var self = this;
    if (self._stopped) throw new Error("oplog stopped surprisingly early");

    self._runQuery({
      initial: true
    }); // yields


    if (self._stopped) return; // can happen on queryError
    // Allow observeChanges calls to return. (After this, it's possible for
    // stop() to be called.)

    self._multiplexer.ready();

    self._doneQuerying(); // yields

  },
  // In various circumstances, we may just want to stop processing the oplog and
  // re-run the initial query, just as if we were a PollingObserveDriver.
  //
  // This function may not block, because it is called from an oplog entry
  // handler.
  //
  // XXX We should call this when we detect that we've been in FETCHING for "too
  // long".
  //
  // XXX We should call this when we detect Mongo failover (since that might
  // mean that some of the oplog entries we have processed have been rolled
  // back). The Node Mongo driver is in the middle of a bunch of huge
  // refactorings, including the way that it notifies you when primary
  // changes. Will put off implementing this until driver 1.4 is out.
  _pollQuery: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (self._stopped) return; // Yay, we get to forget about all the things we thought we had to fetch.

      self._needToFetch = new LocalCollection._IdMap();
      self._currentlyFetching = null;
      ++self._fetchGeneration; // ignore any in-flight fetches

      self._registerPhaseChange(PHASE.QUERYING); // Defer so that we don't yield.  We don't need finishIfNeedToPollQuery
      // here because SwitchedToQuery is not thrown in QUERYING mode.


      Meteor.defer(function () {
        self._runQuery();

        self._doneQuerying();
      });
    });
  },
  // Yields!
  _runQuery: function (options) {
    var self = this;
    options = options || {};
    var newResults, newBuffer; // This while loop is just to retry failures.

    while (true) {
      // If we've been stopped, we don't have to run anything any more.
      if (self._stopped) return;
      newResults = new LocalCollection._IdMap();
      newBuffer = new LocalCollection._IdMap(); // Query 2x documents as the half excluded from the original query will go
      // into unpublished buffer to reduce additional Mongo lookups in cases
      // when documents are removed from the published set and need a
      // replacement.
      // XXX needs more thought on non-zero skip
      // XXX 2 is a "magic number" meaning there is an extra chunk of docs for
      // buffer if such is needed.

      var cursor = self._cursorForQuery({
        limit: self._limit * 2
      });

      try {
        cursor.forEach(function (doc, i) {
          // yields
          if (!self._limit || i < self._limit) {
            newResults.set(doc._id, doc);
          } else {
            newBuffer.set(doc._id, doc);
          }
        });
        break;
      } catch (e) {
        if (options.initial && typeof e.code === 'number') {
          // This is an error document sent to us by mongod, not a connection
          // error generated by the client. And we've never seen this query work
          // successfully. Probably it's a bad selector or something, so we
          // should NOT retry. Instead, we should halt the observe (which ends
          // up calling `stop` on us).
          self._multiplexer.queryError(e);

          return;
        } // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.


        Meteor._debug("Got exception while polling query: " + e);

        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped) return;

    self._publishNewResults(newResults, newBuffer);
  },
  // Transitions to QUERYING and runs another query, or (if already in QUERYING)
  // ensures that we will query again later.
  //
  // This function may not block, because it is called from an oplog entry
  // handler. However, if we were not already in the QUERYING phase, it throws
  // an exception that is caught by the closest surrounding
  // finishIfNeedToPollQuery call; this ensures that we don't continue running
  // close that was designed for another phase inside PHASE.QUERYING.
  //
  // (It's also necessary whenever logic in this file yields to check that other
  // phases haven't put us into QUERYING mode, though; eg,
  // _fetchModifiedDocuments does this.)
  _needToPollQuery: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (self._stopped) return; // If we're not already in the middle of a query, we can query now
      // (possibly pausing FETCHING).

      if (self._phase !== PHASE.QUERYING) {
        self._pollQuery();

        throw new SwitchedToQuery();
      } // We're currently in QUERYING. Set a flag to ensure that we run another
      // query when we're done.


      self._requeryWhenDoneThisQuery = true;
    });
  },
  // Yields!
  _doneQuerying: function () {
    var self = this;
    if (self._stopped) return;

    self._mongoHandle._oplogHandle.waitUntilCaughtUp(); // yields


    if (self._stopped) return;
    if (self._phase !== PHASE.QUERYING) throw Error("Phase unexpectedly " + self._phase);

    Meteor._noYieldsAllowed(function () {
      if (self._requeryWhenDoneThisQuery) {
        self._requeryWhenDoneThisQuery = false;

        self._pollQuery();
      } else if (self._needToFetch.empty()) {
        self._beSteady();
      } else {
        self._fetchModifiedDocuments();
      }
    });
  },
  _cursorForQuery: function (optionsOverwrite) {
    var self = this;
    return Meteor._noYieldsAllowed(function () {
      // The query we run is almost the same as the cursor we are observing,
      // with a few changes. We need to read all the fields that are relevant to
      // the selector, not just the fields we are going to publish (that's the
      // "shared" projection). And we don't want to apply any transform in the
      // cursor, because observeChanges shouldn't use the transform.
      var options = _.clone(self._cursorDescription.options); // Allow the caller to modify the options. Useful to specify different
      // skip and limit values.


      _.extend(options, optionsOverwrite);

      options.fields = self._sharedProjection;
      delete options.transform; // We are NOT deep cloning fields or selector here, which should be OK.

      var description = new CursorDescription(self._cursorDescription.collectionName, self._cursorDescription.selector, options);
      return new Cursor(self._mongoHandle, description);
    });
  },
  // Replace self._published with newResults (both are IdMaps), invoking observe
  // callbacks on the multiplexer.
  // Replace self._unpublishedBuffer with newBuffer.
  //
  // XXX This is very similar to LocalCollection._diffQueryUnorderedChanges. We
  // should really: (a) Unify IdMap and OrderedDict into Unordered/OrderedDict
  // (b) Rewrite diff.js to use these classes instead of arrays and objects.
  _publishNewResults: function (newResults, newBuffer) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      // If the query is limited and there is a buffer, shut down so it doesn't
      // stay in a way.
      if (self._limit) {
        self._unpublishedBuffer.clear();
      } // First remove anything that's gone. Be careful not to modify
      // self._published while iterating over it.


      var idsToRemove = [];

      self._published.forEach(function (doc, id) {
        if (!newResults.has(id)) idsToRemove.push(id);
      });

      _.each(idsToRemove, function (id) {
        self._removePublished(id);
      }); // Now do adds and changes.
      // If self has a buffer and limit, the new fetched result will be
      // limited correctly as the query has sort specifier.


      newResults.forEach(function (doc, id) {
        self._handleDoc(id, doc);
      }); // Sanity-check that everything we tried to put into _published ended up
      // there.
      // XXX if this is slow, remove it later

      if (self._published.size() !== newResults.size()) {
        throw Error("The Mongo server and the Meteor query disagree on how " + "many documents match your query. Maybe it is hitting a Mongo " + "edge case? The query is: " + EJSON.stringify(self._cursorDescription.selector));
      }

      self._published.forEach(function (doc, id) {
        if (!newResults.has(id)) throw Error("_published has a doc that newResults doesn't; " + id);
      }); // Finally, replace the buffer


      newBuffer.forEach(function (doc, id) {
        self._addBuffered(id, doc);
      });
      self._safeAppendToBuffer = newBuffer.size() < self._limit;
    });
  },
  // This stop function is invoked from the onStop of the ObserveMultiplexer, so
  // it shouldn't actually be possible to call it until the multiplexer is
  // ready.
  //
  // It's important to check self._stopped after every call in this file that
  // can yield!
  stop: function () {
    var self = this;
    if (self._stopped) return;
    self._stopped = true;

    _.each(self._stopHandles, function (handle) {
      handle.stop();
    }); // Note: we *don't* use multiplexer.onFlush here because this stop
    // callback is actually invoked by the multiplexer itself when it has
    // determined that there are no handles left. So nothing is actually going
    // to get flushed (and it's probably not valid to call methods on the
    // dying multiplexer).


    _.each(self._writesToCommitWhenWeReachSteady, function (w) {
      w.committed(); // maybe yields?
    });

    self._writesToCommitWhenWeReachSteady = null; // Proactively drop references to potentially big things.

    self._published = null;
    self._unpublishedBuffer = null;
    self._needToFetch = null;
    self._currentlyFetching = null;
    self._oplogEntryHandle = null;
    self._listenersHandle = null;
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "observe-drivers-oplog", -1);
  },
  _registerPhaseChange: function (phase) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var now = new Date();

      if (self._phase) {
        var timeDiff = now - self._phaseStartTime;
        Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact("mongo-livedata", "time-spent-in-" + self._phase + "-phase", timeDiff);
      }

      self._phase = phase;
      self._phaseStartTime = now;
    });
  }
}); // Does our oplog tailing code support this cursor? For now, we are being very
// conservative and allowing only simple queries with simple options.
// (This is a "static method".)


OplogObserveDriver.cursorSupported = function (cursorDescription, matcher) {
  // First, check the options.
  var options = cursorDescription.options; // Did the user say no explicitly?
  // underscored version of the option is COMPAT with 1.2

  if (options.disableOplog || options._disableOplog) return false; // skip is not supported: to support it we would need to keep track of all
  // "skipped" documents or at least their ids.
  // limit w/o a sort specifier is not supported: current implementation needs a
  // deterministic way to order documents.

  if (options.skip || options.limit && !options.sort) return false; // If a fields projection option is given check if it is supported by
  // minimongo (some operators are not supported).

  if (options.fields) {
    try {
      LocalCollection._checkSupportedProjection(options.fields);
    } catch (e) {
      if (e.name === "MinimongoError") {
        return false;
      } else {
        throw e;
      }
    }
  } // We don't allow the following selectors:
  //   - $where (not confident that we provide the same JS environment
  //             as Mongo, and can yield!)
  //   - $near (has "interesting" properties in MongoDB, like the possibility
  //            of returning an ID multiple times, though even polling maybe
  //            have a bug there)
  //           XXX: once we support it, we would need to think more on how we
  //           initialize the comparators when we create the driver.


  return !matcher.hasWhere() && !matcher.hasGeoQuery();
};

var modifierCanBeDirectlyApplied = function (modifier) {
  return _.all(modifier, function (fields, operation) {
    return _.all(fields, function (value, field) {
      return !/EJSON\$/.test(field);
    });
  });
};

MongoInternals.OplogObserveDriver = OplogObserveDriver;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"local_collection_driver.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/local_collection_driver.js                                                                           //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  LocalCollectionDriver: () => LocalCollectionDriver
});
const LocalCollectionDriver = new class LocalCollectionDriver {
  constructor() {
    this.noConnCollections = Object.create(null);
  }

  open(name, conn) {
    if (!name) {
      return new LocalCollection();
    }

    if (!conn) {
      return ensureCollection(name, this.noConnCollections);
    }

    if (!conn._mongo_livedata_collections) {
      conn._mongo_livedata_collections = Object.create(null);
    } // XXX is there a way to keep track of a connection's collections without
    // dangling it off the connection object?


    return ensureCollection(name, conn._mongo_livedata_collections);
  }

}();

function ensureCollection(name, collections) {
  return name in collections ? collections[name] : collections[name] = new LocalCollection(name);
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"remote_collection_driver.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/remote_collection_driver.js                                                                          //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
MongoInternals.RemoteCollectionDriver = function (mongo_url, options) {
  var self = this;
  self.mongo = new MongoConnection(mongo_url, options);
};

_.extend(MongoInternals.RemoteCollectionDriver.prototype, {
  open: function (name) {
    var self = this;
    var ret = {};

    _.each(['find', 'findOne', 'insert', 'update', 'upsert', 'remove', '_ensureIndex', '_dropIndex', '_createCappedCollection', 'dropCollection', 'rawCollection'], function (m) {
      ret[m] = _.bind(self.mongo[m], self.mongo, name);
    });

    return ret;
  }
}); // Create the singleton RemoteCollectionDriver only on demand, so we
// only require Mongo configuration if it's actually used (eg, not if
// you're only trying to receive data from a remote DDP server.)


MongoInternals.defaultRemoteCollectionDriver = _.once(function () {
  var connectionOptions = {};
  var mongoUrl = process.env.MONGO_URL;

  if (process.env.MONGO_OPLOG_URL) {
    connectionOptions.oplogUrl = process.env.MONGO_OPLOG_URL;
  }

  if (!mongoUrl) throw new Error("MONGO_URL must be set in environment");
  return new MongoInternals.RemoteCollectionDriver(mongoUrl, connectionOptions);
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"collection.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/collection.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var _interopRequireDefault = require("@babel/runtime/helpers/builtin/interopRequireDefault");

var _objectSpread2 = _interopRequireDefault(require("@babel/runtime/helpers/builtin/objectSpread"));

// options.connection, if given, is a LivedataClient or LivedataServer
// XXX presently there is no way to destroy/clean up a Collection

/**
 * @summary Namespace for MongoDB-related items
 * @namespace
 */
Mongo = {};
/**
 * @summary Constructor for a Collection
 * @locus Anywhere
 * @instancename collection
 * @class
 * @param {String} name The name of the collection.  If null, creates an unmanaged (unsynchronized) local collection.
 * @param {Object} [options]
 * @param {Object} options.connection The server connection that will manage this collection. Uses the default connection if not specified.  Pass the return value of calling [`DDP.connect`](#ddp_connect) to specify a different server. Pass `null` to specify no connection. Unmanaged (`name` is null) collections cannot specify a connection.
 * @param {String} options.idGeneration The method of generating the `_id` fields of new documents in this collection.  Possible values:

 - **`'STRING'`**: random strings
 - **`'MONGO'`**:  random [`Mongo.ObjectID`](#mongo_object_id) values

The default id generation technique is `'STRING'`.
 * @param {Function} options.transform An optional transformation function. Documents will be passed through this function before being returned from `fetch` or `findOne`, and before being passed to callbacks of `observe`, `map`, `forEach`, `allow`, and `deny`. Transforms are *not* applied for the callbacks of `observeChanges` or to cursors returned from publish functions.
 * @param {Boolean} options.defineMutationMethods Set to `false` to skip setting up the mutation methods that enable insert/update/remove from client code. Default `true`.
 */

Mongo.Collection = function Collection(name, options) {
  if (!name && name !== null) {
    Meteor._debug("Warning: creating anonymous collection. It will not be " + "saved or synchronized over the network. (Pass null for " + "the collection name to turn off this warning.)");

    name = null;
  }

  if (name !== null && typeof name !== "string") {
    throw new Error("First argument to new Mongo.Collection must be a string or null");
  }

  if (options && options.methods) {
    // Backwards compatibility hack with original signature (which passed
    // "connection" directly instead of in options. (Connections must have a "methods"
    // method.)
    // XXX remove before 1.0
    options = {
      connection: options
    };
  } // Backwards compatibility: "connection" used to be called "manager".


  if (options && options.manager && !options.connection) {
    options.connection = options.manager;
  }

  options = (0, _objectSpread2.default)({
    connection: undefined,
    idGeneration: 'STRING',
    transform: null,
    _driver: undefined,
    _preventAutopublish: false
  }, options);

  switch (options.idGeneration) {
    case 'MONGO':
      this._makeNewID = function () {
        var src = name ? DDP.randomStream('/collection/' + name) : Random.insecure;
        return new Mongo.ObjectID(src.hexString(24));
      };

      break;

    case 'STRING':
    default:
      this._makeNewID = function () {
        var src = name ? DDP.randomStream('/collection/' + name) : Random.insecure;
        return src.id();
      };

      break;
  }

  this._transform = LocalCollection.wrapTransform(options.transform);
  if (!name || options.connection === null) // note: nameless collections never have a connection
    this._connection = null;else if (options.connection) this._connection = options.connection;else if (Meteor.isClient) this._connection = Meteor.connection;else this._connection = Meteor.server;

  if (!options._driver) {
    // XXX This check assumes that webapp is loaded so that Meteor.server !==
    // null. We should fully support the case of "want to use a Mongo-backed
    // collection from Node code without webapp", but we don't yet.
    // #MeteorServerNull
    if (name && this._connection === Meteor.server && typeof MongoInternals !== "undefined" && MongoInternals.defaultRemoteCollectionDriver) {
      options._driver = MongoInternals.defaultRemoteCollectionDriver();
    } else {
      const {
        LocalCollectionDriver
      } = require("./local_collection_driver.js");

      options._driver = LocalCollectionDriver;
    }
  }

  this._collection = options._driver.open(name, this._connection);
  this._name = name;
  this._driver = options._driver;

  this._maybeSetUpReplication(name, options); // XXX don't define these until allow or deny is actually used for this
  // collection. Could be hard if the security rules are only defined on the
  // server.


  if (options.defineMutationMethods !== false) {
    try {
      this._defineMutationMethods({
        useExisting: options._suppressSameNameError === true
      });
    } catch (error) {
      // Throw a more understandable error on the server for same collection name
      if (error.message === `A method named '/${name}/insert' is already defined`) throw new Error(`There is already a collection named "${name}"`);
      throw error;
    }
  } // autopublish


  if (Package.autopublish && !options._preventAutopublish && this._connection && this._connection.publish) {
    this._connection.publish(null, () => this.find(), {
      is_auto: true
    });
  }
};

Object.assign(Mongo.Collection.prototype, {
  _maybeSetUpReplication(name, {
    _suppressSameNameError = false
  }) {
    const self = this;

    if (!(self._connection && self._connection.registerStore)) {
      return;
    } // OK, we're going to be a slave, replicating some remote
    // database, except possibly with some temporary divergence while
    // we have unacknowledged RPC's.


    const ok = self._connection.registerStore(name, {
      // Called at the beginning of a batch of updates. batchSize is the number
      // of update calls to expect.
      //
      // XXX This interface is pretty janky. reset probably ought to go back to
      // being its own function, and callers shouldn't have to calculate
      // batchSize. The optimization of not calling pause/remove should be
      // delayed until later: the first call to update() should buffer its
      // message, and then we can either directly apply it at endUpdate time if
      // it was the only update, or do pauseObservers/apply/apply at the next
      // update() if there's another one.
      beginUpdate(batchSize, reset) {
        // pause observers so users don't see flicker when updating several
        // objects at once (including the post-reconnect reset-and-reapply
        // stage), and so that a re-sorting of a query can take advantage of the
        // full _diffQuery moved calculation instead of applying change one at a
        // time.
        if (batchSize > 1 || reset) self._collection.pauseObservers();
        if (reset) self._collection.remove({});
      },

      // Apply an update.
      // XXX better specify this interface (not in terms of a wire message)?
      update(msg) {
        var mongoId = MongoID.idParse(msg.id);

        var doc = self._collection.findOne(mongoId); // Is this a "replace the whole doc" message coming from the quiescence
        // of method writes to an object? (Note that 'undefined' is a valid
        // value meaning "remove it".)


        if (msg.msg === 'replace') {
          var replace = msg.replace;

          if (!replace) {
            if (doc) self._collection.remove(mongoId);
          } else if (!doc) {
            self._collection.insert(replace);
          } else {
            // XXX check that replace has no $ ops
            self._collection.update(mongoId, replace);
          }

          return;
        } else if (msg.msg === 'added') {
          if (doc) {
            throw new Error("Expected not to find a document already present for an add");
          }

          self._collection.insert((0, _objectSpread2.default)({
            _id: mongoId
          }, msg.fields));
        } else if (msg.msg === 'removed') {
          if (!doc) throw new Error("Expected to find a document already present for removed");

          self._collection.remove(mongoId);
        } else if (msg.msg === 'changed') {
          if (!doc) throw new Error("Expected to find a document to change");
          const keys = Object.keys(msg.fields);

          if (keys.length > 0) {
            var modifier = {};
            keys.forEach(key => {
              const value = msg.fields[key];

              if (typeof value === "undefined") {
                if (!modifier.$unset) {
                  modifier.$unset = {};
                }

                modifier.$unset[key] = 1;
              } else {
                if (!modifier.$set) {
                  modifier.$set = {};
                }

                modifier.$set[key] = value;
              }
            });

            self._collection.update(mongoId, modifier);
          }
        } else {
          throw new Error("I don't know how to deal with this message");
        }
      },

      // Called at the end of a batch of updates.
      endUpdate() {
        self._collection.resumeObservers();
      },

      // Called around method stub invocations to capture the original versions
      // of modified documents.
      saveOriginals() {
        self._collection.saveOriginals();
      },

      retrieveOriginals() {
        return self._collection.retrieveOriginals();
      },

      // Used to preserve current versions of documents across a store reset.
      getDoc(id) {
        return self.findOne(id);
      },

      // To be able to get back to the collection from the store.
      _getCollection() {
        return self;
      }

    });

    if (!ok) {
      const message = `There is already a collection named "${name}"`;

      if (_suppressSameNameError === true) {
        // XXX In theory we do not have to throw when `ok` is falsy. The
        // store is already defined for this collection name, but this
        // will simply be another reference to it and everything should
        // work. However, we have historically thrown an error here, so
        // for now we will skip the error only when _suppressSameNameError
        // is `true`, allowing people to opt in and give this some real
        // world testing.
        console.warn ? console.warn(message) : console.log(message);
      } else {
        throw new Error(message);
      }
    }
  },

  ///
  /// Main collection API
  ///
  _getFindSelector(args) {
    if (args.length == 0) return {};else return args[0];
  },

  _getFindOptions(args) {
    var self = this;

    if (args.length < 2) {
      return {
        transform: self._transform
      };
    } else {
      check(args[1], Match.Optional(Match.ObjectIncluding({
        fields: Match.Optional(Match.OneOf(Object, undefined)),
        sort: Match.Optional(Match.OneOf(Object, Array, Function, undefined)),
        limit: Match.Optional(Match.OneOf(Number, undefined)),
        skip: Match.Optional(Match.OneOf(Number, undefined))
      })));
      return (0, _objectSpread2.default)({
        transform: self._transform
      }, args[1]);
    }
  },

  /**
   * @summary Find the documents in a collection that match the selector.
   * @locus Anywhere
   * @method find
   * @memberof Mongo.Collection
   * @instance
   * @param {MongoSelector} [selector] A query describing the documents to find
   * @param {Object} [options]
   * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)
   * @param {Number} options.skip Number of results to skip at the beginning
   * @param {Number} options.limit Maximum number of results to return
   * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.
   * @param {Boolean} options.reactive (Client only) Default `true`; pass `false` to disable reactivity
   * @param {Function} options.transform Overrides `transform` on the  [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
   * @param {Boolean} options.disableOplog (Server only) Pass true to disable oplog-tailing on this query. This affects the way server processes calls to `observe` on this query. Disabling the oplog can be useful when working with data that updates in large batches.
   * @param {Number} options.pollingIntervalMs (Server only) When oplog is disabled (through the use of `disableOplog` or when otherwise not available), the frequency (in milliseconds) of how often to poll this query when observing on the server. Defaults to 10000ms (10 seconds).
   * @param {Number} options.pollingThrottleMs (Server only) When oplog is disabled (through the use of `disableOplog` or when otherwise not available), the minimum time (in milliseconds) to allow between re-polling when observing on the server. Increasing this will save CPU and mongo load at the expense of slower updates to users. Decreasing this is not recommended. Defaults to 50ms.
   * @param {Number} options.maxTimeMs (Server only) If set, instructs MongoDB to set a time limit for this cursor's operations. If the operation reaches the specified time limit (in milliseconds) without the having been completed, an exception will be thrown. Useful to prevent an (accidental or malicious) unoptimized query from causing a full collection scan that would disrupt other database users, at the expense of needing to handle the resulting error.
   * @param {String|Object} options.hint (Server only) Overrides MongoDB's default index selection and query optimization process. Specify an index to force its use, either by its name or index specification. You can also specify `{ $natural : 1 }` to force a forwards collection scan, or `{ $natural : -1 }` for a reverse collection scan. Setting this is only recommended for advanced users.
   * @returns {Mongo.Cursor}
   */
  find(...args) {
    // Collection.find() (return all docs) behaves differently
    // from Collection.find(undefined) (return 0 docs).  so be
    // careful about the length of arguments.
    return this._collection.find(this._getFindSelector(args), this._getFindOptions(args));
  },

  /**
   * @summary Finds the first document that matches the selector, as ordered by sort and skip options. Returns `undefined` if no matching document is found.
   * @locus Anywhere
   * @method findOne
   * @memberof Mongo.Collection
   * @instance
   * @param {MongoSelector} [selector] A query describing the documents to find
   * @param {Object} [options]
   * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)
   * @param {Number} options.skip Number of results to skip at the beginning
   * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.
   * @param {Boolean} options.reactive (Client only) Default true; pass false to disable reactivity
   * @param {Function} options.transform Overrides `transform` on the [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
   * @returns {Object}
   */
  findOne(...args) {
    return this._collection.findOne(this._getFindSelector(args), this._getFindOptions(args));
  }

});
Object.assign(Mongo.Collection, {
  _publishCursor(cursor, sub, collection) {
    var observeHandle = cursor.observeChanges({
      added: function (id, fields) {
        sub.added(collection, id, fields);
      },
      changed: function (id, fields) {
        sub.changed(collection, id, fields);
      },
      removed: function (id) {
        sub.removed(collection, id);
      }
    }); // We don't call sub.ready() here: it gets called in livedata_server, after
    // possibly calling _publishCursor on multiple returned cursors.
    // register stop callback (expects lambda w/ no args).

    sub.onStop(function () {
      observeHandle.stop();
    }); // return the observeHandle in case it needs to be stopped early

    return observeHandle;
  },

  // protect against dangerous selectors.  falsey and {_id: falsey} are both
  // likely programmer error, and not what you want, particularly for destructive
  // operations. If a falsey _id is sent in, a new string _id will be
  // generated and returned; if a fallbackId is provided, it will be returned
  // instead.
  _rewriteSelector(selector, {
    fallbackId
  } = {}) {
    // shorthand -- scalars match _id
    if (LocalCollection._selectorIsId(selector)) selector = {
      _id: selector
    };

    if (Array.isArray(selector)) {
      // This is consistent with the Mongo console itself; if we don't do this
      // check passing an empty array ends up selecting all items
      throw new Error("Mongo selector can't be an array.");
    }

    if (!selector || '_id' in selector && !selector._id) {
      // can't match anything
      return {
        _id: fallbackId || Random.id()
      };
    }

    return selector;
  }

});
Object.assign(Mongo.Collection.prototype, {
  // 'insert' immediately returns the inserted document's new _id.
  // The others return values immediately if you are in a stub, an in-memory
  // unmanaged collection, or a mongo-backed collection and you don't pass a
  // callback. 'update' and 'remove' return the number of affected
  // documents. 'upsert' returns an object with keys 'numberAffected' and, if an
  // insert happened, 'insertedId'.
  //
  // Otherwise, the semantics are exactly like other methods: they take
  // a callback as an optional last argument; if no callback is
  // provided, they block until the operation is complete, and throw an
  // exception if it fails; if a callback is provided, then they don't
  // necessarily block, and they call the callback when they finish with error and
  // result arguments.  (The insert method provides the document ID as its result;
  // update and remove provide the number of affected docs as the result; upsert
  // provides an object with numberAffected and maybe insertedId.)
  //
  // On the client, blocking is impossible, so if a callback
  // isn't provided, they just return immediately and any error
  // information is lost.
  //
  // There's one more tweak. On the client, if you don't provide a
  // callback, then if there is an error, a message will be logged with
  // Meteor._debug.
  //
  // The intent (though this is actually determined by the underlying
  // drivers) is that the operations should be done synchronously, not
  // generating their result until the database has acknowledged
  // them. In the future maybe we should provide a flag to turn this
  // off.

  /**
   * @summary Insert a document in the collection.  Returns its unique _id.
   * @locus Anywhere
   * @method  insert
   * @memberof Mongo.Collection
   * @instance
   * @param {Object} doc The document to insert. May not yet have an _id attribute, in which case Meteor will generate one for you.
   * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the _id as the second.
   */
  insert(doc, callback) {
    // Make sure we were passed a document to insert
    if (!doc) {
      throw new Error("insert requires an argument");
    } // Make a shallow clone of the document, preserving its prototype.


    doc = Object.create(Object.getPrototypeOf(doc), Object.getOwnPropertyDescriptors(doc));

    if ('_id' in doc) {
      if (!doc._id || !(typeof doc._id === 'string' || doc._id instanceof Mongo.ObjectID)) {
        throw new Error("Meteor requires document _id fields to be non-empty strings or ObjectIDs");
      }
    } else {
      let generateId = true; // Don't generate the id if we're the client and the 'outermost' call
      // This optimization saves us passing both the randomSeed and the id
      // Passing both is redundant.

      if (this._isRemoteCollection()) {
        const enclosing = DDP._CurrentMethodInvocation.get();

        if (!enclosing) {
          generateId = false;
        }
      }

      if (generateId) {
        doc._id = this._makeNewID();
      }
    } // On inserts, always return the id that we generated; on all other
    // operations, just return the result from the collection.


    var chooseReturnValueFromCollectionResult = function (result) {
      if (doc._id) {
        return doc._id;
      } // XXX what is this for??
      // It's some iteraction between the callback to _callMutatorMethod and
      // the return value conversion


      doc._id = result;
      return result;
    };

    const wrappedCallback = wrapCallback(callback, chooseReturnValueFromCollectionResult);

    if (this._isRemoteCollection()) {
      const result = this._callMutatorMethod("insert", [doc], wrappedCallback);

      return chooseReturnValueFromCollectionResult(result);
    } // it's my collection.  descend into the collection object
    // and propagate any exception.


    try {
      // If the user provided a callback and the collection implements this
      // operation asynchronously, then queryRet will be undefined, and the
      // result will be returned through the callback instead.
      const result = this._collection.insert(doc, wrappedCallback);

      return chooseReturnValueFromCollectionResult(result);
    } catch (e) {
      if (callback) {
        callback(e);
        return null;
      }

      throw e;
    }
  },

  /**
   * @summary Modify one or more documents in the collection. Returns the number of matched documents.
   * @locus Anywhere
   * @method update
   * @memberof Mongo.Collection
   * @instance
   * @param {MongoSelector} selector Specifies which documents to modify
   * @param {MongoModifier} modifier Specifies how to modify the documents
   * @param {Object} [options]
   * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
   * @param {Boolean} options.upsert True to insert a document if no matching documents are found.
   * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
   */
  update(selector, modifier, ...optionsAndCallback) {
    const callback = popCallbackFromArgs(optionsAndCallback); // We've already popped off the callback, so we are left with an array
    // of one or zero items

    const options = (0, _objectSpread2.default)({}, optionsAndCallback[0] || null);
    let insertedId;

    if (options && options.upsert) {
      // set `insertedId` if absent.  `insertedId` is a Meteor extension.
      if (options.insertedId) {
        if (!(typeof options.insertedId === 'string' || options.insertedId instanceof Mongo.ObjectID)) throw new Error("insertedId must be string or ObjectID");
        insertedId = options.insertedId;
      } else if (!selector || !selector._id) {
        insertedId = this._makeNewID();
        options.generatedId = true;
        options.insertedId = insertedId;
      }
    }

    selector = Mongo.Collection._rewriteSelector(selector, {
      fallbackId: insertedId
    });
    const wrappedCallback = wrapCallback(callback);

    if (this._isRemoteCollection()) {
      const args = [selector, modifier, options];
      return this._callMutatorMethod("update", args, wrappedCallback);
    } // it's my collection.  descend into the collection object
    // and propagate any exception.


    try {
      // If the user provided a callback and the collection implements this
      // operation asynchronously, then queryRet will be undefined, and the
      // result will be returned through the callback instead.
      return this._collection.update(selector, modifier, options, wrappedCallback);
    } catch (e) {
      if (callback) {
        callback(e);
        return null;
      }

      throw e;
    }
  },

  /**
   * @summary Remove documents from the collection
   * @locus Anywhere
   * @method remove
   * @memberof Mongo.Collection
   * @instance
   * @param {MongoSelector} selector Specifies which documents to remove
   * @param {Function} [callback] Optional.  If present, called with an error object as its argument.
   */
  remove(selector, callback) {
    selector = Mongo.Collection._rewriteSelector(selector);
    const wrappedCallback = wrapCallback(callback);

    if (this._isRemoteCollection()) {
      return this._callMutatorMethod("remove", [selector], wrappedCallback);
    } // it's my collection.  descend into the collection object
    // and propagate any exception.


    try {
      // If the user provided a callback and the collection implements this
      // operation asynchronously, then queryRet will be undefined, and the
      // result will be returned through the callback instead.
      return this._collection.remove(selector, wrappedCallback);
    } catch (e) {
      if (callback) {
        callback(e);
        return null;
      }

      throw e;
    }
  },

  // Determine if this collection is simply a minimongo representation of a real
  // database on another server
  _isRemoteCollection() {
    // XXX see #MeteorServerNull
    return this._connection && this._connection !== Meteor.server;
  },

  /**
   * @summary Modify one or more documents in the collection, or insert one if no matching documents were found. Returns an object with keys `numberAffected` (the number of documents modified)  and `insertedId` (the unique _id of the document that was inserted, if any).
   * @locus Anywhere
   * @method upsert
   * @memberof Mongo.Collection
   * @instance
   * @param {MongoSelector} selector Specifies which documents to modify
   * @param {MongoModifier} modifier Specifies how to modify the documents
   * @param {Object} [options]
   * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
   * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
   */
  upsert(selector, modifier, options, callback) {
    if (!callback && typeof options === "function") {
      callback = options;
      options = {};
    }

    return this.update(selector, modifier, (0, _objectSpread2.default)({}, options, {
      _returnObject: true,
      upsert: true
    }), callback);
  },

  // We'll actually design an index API later. For now, we just pass through to
  // Mongo's, but make it synchronous.
  _ensureIndex(index, options) {
    var self = this;
    if (!self._collection._ensureIndex) throw new Error("Can only call _ensureIndex on server collections");

    self._collection._ensureIndex(index, options);
  },

  _dropIndex(index) {
    var self = this;
    if (!self._collection._dropIndex) throw new Error("Can only call _dropIndex on server collections");

    self._collection._dropIndex(index);
  },

  _dropCollection() {
    var self = this;
    if (!self._collection.dropCollection) throw new Error("Can only call _dropCollection on server collections");

    self._collection.dropCollection();
  },

  _createCappedCollection(byteSize, maxDocuments) {
    var self = this;
    if (!self._collection._createCappedCollection) throw new Error("Can only call _createCappedCollection on server collections");

    self._collection._createCappedCollection(byteSize, maxDocuments);
  },

  /**
   * @summary Returns the [`Collection`](http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html) object corresponding to this collection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
   * @locus Server
   */
  rawCollection() {
    var self = this;

    if (!self._collection.rawCollection) {
      throw new Error("Can only call rawCollection on server collections");
    }

    return self._collection.rawCollection();
  },

  /**
   * @summary Returns the [`Db`](http://mongodb.github.io/node-mongodb-native/2.2/api/Db.html) object corresponding to this collection's database connection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
   * @locus Server
   */
  rawDatabase() {
    var self = this;

    if (!(self._driver.mongo && self._driver.mongo.db)) {
      throw new Error("Can only call rawDatabase on server collections");
    }

    return self._driver.mongo.db;
  }

}); // Convert the callback to not return a result if there is an error

function wrapCallback(callback, convertResult) {
  return callback && function (error, result) {
    if (error) {
      callback(error);
    } else if (typeof convertResult === "function") {
      callback(null, convertResult(result));
    } else {
      callback(null, result);
    }
  };
}
/**
 * @summary Create a Mongo-style `ObjectID`.  If you don't specify a `hexString`, the `ObjectID` will generated randomly (not using MongoDB's ID construction rules).
 * @locus Anywhere
 * @class
 * @param {String} [hexString] Optional.  The 24-character hexadecimal contents of the ObjectID to create
 */


Mongo.ObjectID = MongoID.ObjectID;
/**
 * @summary To create a cursor, use find. To access the documents in a cursor, use forEach, map, or fetch.
 * @class
 * @instanceName cursor
 */

Mongo.Cursor = LocalCollection.Cursor;
/**
 * @deprecated in 0.9.1
 */

Mongo.Collection.Cursor = Mongo.Cursor;
/**
 * @deprecated in 0.9.1
 */

Mongo.Collection.ObjectID = Mongo.ObjectID;
/**
 * @deprecated in 0.9.1
 */

Meteor.Collection = Mongo.Collection; // Allow deny stuff is now in the allow-deny package

Object.assign(Meteor.Collection.prototype, AllowDeny.CollectionPrototype);

function popCallbackFromArgs(args) {
  // Pull off any callback (or perhaps a 'callback' variable that was passed
  // in undefined, like how 'upsert' does it).
  if (args.length && (args[args.length - 1] === undefined || args[args.length - 1] instanceof Function)) {
    return args.pop();
  }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"connection_options.js":function(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/connection_options.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
/**
 * @summary Allows for user specified connection options
 * @example http://mongodb.github.io/node-mongodb-native/2.2/reference/connecting/connection-settings/
 * @locus Server
 * @param {Object} options User specified Mongo connection options
 */
Mongo.setConnectionOptions = function setConnectionOptions(options) {
  check(options, Object);
  Mongo._connectionOptions = options;
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});
require("/node_modules/meteor/mongo/mongo_driver.js");
require("/node_modules/meteor/mongo/oplog_tailing.js");
require("/node_modules/meteor/mongo/observe_multiplex.js");
require("/node_modules/meteor/mongo/doc_fetcher.js");
require("/node_modules/meteor/mongo/polling_observe_driver.js");
require("/node_modules/meteor/mongo/oplog_observe_driver.js");
require("/node_modules/meteor/mongo/local_collection_driver.js");
require("/node_modules/meteor/mongo/remote_collection_driver.js");
require("/node_modules/meteor/mongo/collection.js");
require("/node_modules/meteor/mongo/connection_options.js");

/* Exports */
Package._define("mongo", {
  MongoInternals: MongoInternals,
  MongoTest: MongoTest,
  Mongo: Mongo
});

})();

//# sourceURL=meteor://💻app/packages/mongo.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vbW9uZ29fZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9vcGxvZ190YWlsaW5nLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9vYnNlcnZlX211bHRpcGxleC5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vZG9jX2ZldGNoZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21vbmdvL3BvbGxpbmdfb2JzZXJ2ZV9kcml2ZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21vbmdvL29wbG9nX29ic2VydmVfZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9sb2NhbF9jb2xsZWN0aW9uX2RyaXZlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vcmVtb3RlX2NvbGxlY3Rpb25fZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9jb2xsZWN0aW9uLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9jb25uZWN0aW9uX29wdGlvbnMuanMiXSwibmFtZXMiOlsiTW9uZ29EQiIsIk5wbU1vZHVsZU1vbmdvZGIiLCJGdXR1cmUiLCJOcG0iLCJyZXF1aXJlIiwiTW9uZ29JbnRlcm5hbHMiLCJNb25nb1Rlc3QiLCJOcG1Nb2R1bGVzIiwibW9uZ29kYiIsInZlcnNpb24iLCJOcG1Nb2R1bGVNb25nb2RiVmVyc2lvbiIsIm1vZHVsZSIsIk5wbU1vZHVsZSIsInJlcGxhY2VOYW1lcyIsImZpbHRlciIsInRoaW5nIiwiXyIsImlzQXJyYXkiLCJtYXAiLCJiaW5kIiwicmV0IiwiZWFjaCIsInZhbHVlIiwia2V5IiwiVGltZXN0YW1wIiwicHJvdG90eXBlIiwiY2xvbmUiLCJtYWtlTW9uZ29MZWdhbCIsIm5hbWUiLCJ1bm1ha2VNb25nb0xlZ2FsIiwic3Vic3RyIiwicmVwbGFjZU1vbmdvQXRvbVdpdGhNZXRlb3IiLCJkb2N1bWVudCIsIkJpbmFyeSIsImJ1ZmZlciIsIlVpbnQ4QXJyYXkiLCJPYmplY3RJRCIsIk1vbmdvIiwidG9IZXhTdHJpbmciLCJzaXplIiwiRUpTT04iLCJmcm9tSlNPTlZhbHVlIiwidW5kZWZpbmVkIiwicmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28iLCJpc0JpbmFyeSIsIkJ1ZmZlciIsImZyb20iLCJfaXNDdXN0b21UeXBlIiwidG9KU09OVmFsdWUiLCJyZXBsYWNlVHlwZXMiLCJhdG9tVHJhbnNmb3JtZXIiLCJyZXBsYWNlZFRvcExldmVsQXRvbSIsInZhbCIsInZhbFJlcGxhY2VkIiwiTW9uZ29Db25uZWN0aW9uIiwidXJsIiwib3B0aW9ucyIsInNlbGYiLCJfb2JzZXJ2ZU11bHRpcGxleGVycyIsIl9vbkZhaWxvdmVySG9vayIsIkhvb2siLCJtb25nb09wdGlvbnMiLCJPYmplY3QiLCJhc3NpZ24iLCJhdXRvUmVjb25uZWN0IiwicmVjb25uZWN0VHJpZXMiLCJJbmZpbml0eSIsImlnbm9yZVVuZGVmaW5lZCIsIl9jb25uZWN0aW9uT3B0aW9ucyIsInRlc3QiLCJuYXRpdmVfcGFyc2VyIiwiaGFzIiwicG9vbFNpemUiLCJkYiIsIl9wcmltYXJ5IiwiX29wbG9nSGFuZGxlIiwiX2RvY0ZldGNoZXIiLCJjb25uZWN0RnV0dXJlIiwiY29ubmVjdCIsIk1ldGVvciIsImJpbmRFbnZpcm9ubWVudCIsImVyciIsInNlcnZlckNvbmZpZyIsImlzTWFzdGVyRG9jIiwicHJpbWFyeSIsIm9uIiwia2luZCIsImRvYyIsImNhbGxiYWNrIiwibWUiLCJyZXNvbHZlciIsIndhaXQiLCJvcGxvZ1VybCIsIlBhY2thZ2UiLCJPcGxvZ0hhbmRsZSIsImRhdGFiYXNlTmFtZSIsIkRvY0ZldGNoZXIiLCJjbG9zZSIsIkVycm9yIiwib3Bsb2dIYW5kbGUiLCJzdG9wIiwid3JhcCIsInJhd0NvbGxlY3Rpb24iLCJjb2xsZWN0aW9uTmFtZSIsImZ1dHVyZSIsImNvbGxlY3Rpb24iLCJfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbiIsImJ5dGVTaXplIiwibWF4RG9jdW1lbnRzIiwiY3JlYXRlQ29sbGVjdGlvbiIsImNhcHBlZCIsIm1heCIsIl9tYXliZUJlZ2luV3JpdGUiLCJmZW5jZSIsIkREUFNlcnZlciIsIl9DdXJyZW50V3JpdGVGZW5jZSIsImdldCIsImJlZ2luV3JpdGUiLCJjb21taXR0ZWQiLCJfb25GYWlsb3ZlciIsInJlZ2lzdGVyIiwid3JpdGVDYWxsYmFjayIsIndyaXRlIiwicmVmcmVzaCIsInJlc3VsdCIsInJlZnJlc2hFcnIiLCJiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSIsIl9pbnNlcnQiLCJjb2xsZWN0aW9uX25hbWUiLCJzZW5kRXJyb3IiLCJlIiwiX2V4cGVjdGVkQnlUZXN0IiwiTG9jYWxDb2xsZWN0aW9uIiwiX2lzUGxhaW5PYmplY3QiLCJpZCIsIl9pZCIsImluc2VydCIsInNhZmUiLCJfcmVmcmVzaCIsInNlbGVjdG9yIiwicmVmcmVzaEtleSIsInNwZWNpZmljSWRzIiwiX2lkc01hdGNoZWRCeVNlbGVjdG9yIiwiZXh0ZW5kIiwiX3JlbW92ZSIsIndyYXBwZWRDYWxsYmFjayIsImRyaXZlclJlc3VsdCIsInRyYW5zZm9ybVJlc3VsdCIsIm51bWJlckFmZmVjdGVkIiwicmVtb3ZlIiwiX2Ryb3BDb2xsZWN0aW9uIiwiY2IiLCJkcm9wQ29sbGVjdGlvbiIsImRyb3AiLCJfZHJvcERhdGFiYXNlIiwiZHJvcERhdGFiYXNlIiwiX3VwZGF0ZSIsIm1vZCIsIkZ1bmN0aW9uIiwibW9uZ29PcHRzIiwidXBzZXJ0IiwibXVsdGkiLCJmdWxsUmVzdWx0IiwibW9uZ29TZWxlY3RvciIsIm1vbmdvTW9kIiwiaXNNb2RpZnkiLCJfaXNNb2RpZmljYXRpb25Nb2QiLCJfZm9yYmlkUmVwbGFjZSIsImtub3duSWQiLCJuZXdEb2MiLCJfY3JlYXRlVXBzZXJ0RG9jdW1lbnQiLCJpbnNlcnRlZElkIiwiZ2VuZXJhdGVkSWQiLCJzaW11bGF0ZVVwc2VydFdpdGhJbnNlcnRlZElkIiwiZXJyb3IiLCJfcmV0dXJuT2JqZWN0IiwiaGFzT3duUHJvcGVydHkiLCIkc2V0T25JbnNlcnQiLCJ1cGRhdGUiLCJtZXRlb3JSZXN1bHQiLCJtb25nb1Jlc3VsdCIsInVwc2VydGVkIiwibGVuZ3RoIiwibiIsIk5VTV9PUFRJTUlTVElDX1RSSUVTIiwiX2lzQ2Fubm90Q2hhbmdlSWRFcnJvciIsImVycm1zZyIsImluZGV4T2YiLCJtb25nb09wdHNGb3JVcGRhdGUiLCJtb25nb09wdHNGb3JJbnNlcnQiLCJyZXBsYWNlbWVudFdpdGhJZCIsInRyaWVzIiwiZG9VcGRhdGUiLCJkb0NvbmRpdGlvbmFsSW5zZXJ0IiwibWV0aG9kIiwid3JhcEFzeW5jIiwiYXBwbHkiLCJhcmd1bWVudHMiLCJmaW5kIiwiQ3Vyc29yIiwiQ3Vyc29yRGVzY3JpcHRpb24iLCJmaW5kT25lIiwibGltaXQiLCJmZXRjaCIsIl9lbnN1cmVJbmRleCIsImluZGV4IiwiaW5kZXhOYW1lIiwiZW5zdXJlSW5kZXgiLCJfZHJvcEluZGV4IiwiZHJvcEluZGV4IiwiQ29sbGVjdGlvbiIsIl9yZXdyaXRlU2VsZWN0b3IiLCJtb25nbyIsImN1cnNvckRlc2NyaXB0aW9uIiwiX21vbmdvIiwiX2N1cnNvckRlc2NyaXB0aW9uIiwiX3N5bmNocm9ub3VzQ3Vyc29yIiwiU3ltYm9sIiwiaXRlcmF0b3IiLCJ0YWlsYWJsZSIsIl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvciIsInNlbGZGb3JJdGVyYXRpb24iLCJ1c2VUcmFuc2Zvcm0iLCJyZXdpbmQiLCJnZXRUcmFuc2Zvcm0iLCJ0cmFuc2Zvcm0iLCJfcHVibGlzaEN1cnNvciIsInN1YiIsIl9nZXRDb2xsZWN0aW9uTmFtZSIsIm9ic2VydmUiLCJjYWxsYmFja3MiLCJfb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyIsIm9ic2VydmVDaGFuZ2VzIiwibWV0aG9kcyIsIm9yZGVyZWQiLCJfb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkIiwiZXhjZXB0aW9uTmFtZSIsImZvckVhY2giLCJfb2JzZXJ2ZUNoYW5nZXMiLCJwaWNrIiwiY3Vyc29yT3B0aW9ucyIsInNvcnQiLCJza2lwIiwiYXdhaXRkYXRhIiwibnVtYmVyT2ZSZXRyaWVzIiwiT1BMT0dfQ09MTEVDVElPTiIsInRzIiwib3Bsb2dSZXBsYXkiLCJkYkN1cnNvciIsImZpZWxkcyIsIm1heFRpbWVNcyIsIm1heFRpbWVNUyIsImhpbnQiLCJTeW5jaHJvbm91c0N1cnNvciIsIl9kYkN1cnNvciIsIl9zZWxmRm9ySXRlcmF0aW9uIiwiX3RyYW5zZm9ybSIsIndyYXBUcmFuc2Zvcm0iLCJfc3luY2hyb25vdXNOZXh0T2JqZWN0IiwibmV4dE9iamVjdCIsIl9zeW5jaHJvbm91c0NvdW50IiwiY291bnQiLCJfdmlzaXRlZElkcyIsIl9JZE1hcCIsIl9uZXh0T2JqZWN0Iiwic2V0IiwidGhpc0FyZyIsIl9yZXdpbmQiLCJjYWxsIiwicmVzIiwicHVzaCIsImlkZW50aXR5IiwiYXBwbHlTa2lwTGltaXQiLCJnZXRSYXdPYmplY3RzIiwicmVzdWx0cyIsIm5leHQiLCJkb25lIiwidGFpbCIsImRvY0NhbGxiYWNrIiwiY3Vyc29yIiwic3RvcHBlZCIsImxhc3RUUyIsImxvb3AiLCJuZXdTZWxlY3RvciIsIiRndCIsInNldFRpbWVvdXQiLCJkZWZlciIsIl9vYnNlcnZlQ2hhbmdlc1RhaWxhYmxlIiwib2JzZXJ2ZUtleSIsInN0cmluZ2lmeSIsIm11bHRpcGxleGVyIiwib2JzZXJ2ZURyaXZlciIsImZpcnN0SGFuZGxlIiwiX25vWWllbGRzQWxsb3dlZCIsIk9ic2VydmVNdWx0aXBsZXhlciIsIm9uU3RvcCIsIm9ic2VydmVIYW5kbGUiLCJPYnNlcnZlSGFuZGxlIiwibWF0Y2hlciIsInNvcnRlciIsImNhblVzZU9wbG9nIiwiYWxsIiwiX3Rlc3RPbmx5UG9sbENhbGxiYWNrIiwiTWluaW1vbmdvIiwiTWF0Y2hlciIsIk9wbG9nT2JzZXJ2ZURyaXZlciIsImN1cnNvclN1cHBvcnRlZCIsIlNvcnRlciIsImYiLCJkcml2ZXJDbGFzcyIsIlBvbGxpbmdPYnNlcnZlRHJpdmVyIiwibW9uZ29IYW5kbGUiLCJfb2JzZXJ2ZURyaXZlciIsImFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkcyIsImxpc3RlbkFsbCIsImxpc3RlbkNhbGxiYWNrIiwibGlzdGVuZXJzIiwiZm9yRWFjaFRyaWdnZXIiLCJ0cmlnZ2VyIiwiX0ludmFsaWRhdGlvbkNyb3NzYmFyIiwibGlzdGVuIiwibGlzdGVuZXIiLCJ0cmlnZ2VyQ2FsbGJhY2siLCJhZGRlZEJlZm9yZSIsImFkZGVkIiwiTW9uZ29UaW1lc3RhbXAiLCJDb25uZWN0aW9uIiwiVE9PX0ZBUl9CRUhJTkQiLCJwcm9jZXNzIiwiZW52IiwiTUVURU9SX09QTE9HX1RPT19GQVJfQkVISU5EIiwic2hvd1RTIiwiZ2V0SGlnaEJpdHMiLCJnZXRMb3dCaXRzIiwiaWRGb3JPcCIsIm9wIiwibyIsIm8yIiwiZGJOYW1lIiwiX29wbG9nVXJsIiwiX2RiTmFtZSIsIl9vcGxvZ0xhc3RFbnRyeUNvbm5lY3Rpb24iLCJfb3Bsb2dUYWlsQ29ubmVjdGlvbiIsIl9zdG9wcGVkIiwiX3RhaWxIYW5kbGUiLCJfcmVhZHlGdXR1cmUiLCJfY3Jvc3NiYXIiLCJfQ3Jvc3NiYXIiLCJmYWN0UGFja2FnZSIsImZhY3ROYW1lIiwiX2Jhc2VPcGxvZ1NlbGVjdG9yIiwibnMiLCJSZWdFeHAiLCJfZXNjYXBlUmVnRXhwIiwiJG9yIiwiJGluIiwiJGV4aXN0cyIsIl9jYXRjaGluZ1VwRnV0dXJlcyIsIl9sYXN0UHJvY2Vzc2VkVFMiLCJfb25Ta2lwcGVkRW50cmllc0hvb2siLCJkZWJ1Z1ByaW50RXhjZXB0aW9ucyIsIl9lbnRyeVF1ZXVlIiwiX0RvdWJsZUVuZGVkUXVldWUiLCJfd29ya2VyQWN0aXZlIiwiX3N0YXJ0VGFpbGluZyIsIm9uT3Bsb2dFbnRyeSIsIm9yaWdpbmFsQ2FsbGJhY2siLCJub3RpZmljYXRpb24iLCJfZGVidWciLCJzdGFjayIsImxpc3RlbkhhbmRsZSIsIm9uU2tpcHBlZEVudHJpZXMiLCJ3YWl0VW50aWxDYXVnaHRVcCIsImxhc3RFbnRyeSIsIiRuYXR1cmFsIiwiX3NsZWVwRm9yTXMiLCJsZXNzVGhhbk9yRXF1YWwiLCJpbnNlcnRBZnRlciIsImdyZWF0ZXJUaGFuIiwic3BsaWNlIiwibW9uZ29kYlVyaSIsInBhcnNlIiwiZGF0YWJhc2UiLCJhZG1pbiIsImNvbW1hbmQiLCJpc21hc3RlciIsInNldE5hbWUiLCJsYXN0T3Bsb2dFbnRyeSIsIm9wbG9nU2VsZWN0b3IiLCJfbWF5YmVTdGFydFdvcmtlciIsInJldHVybiIsImlzRW1wdHkiLCJwb3AiLCJjbGVhciIsIl9zZXRMYXN0UHJvY2Vzc2VkVFMiLCJzaGlmdCIsIkpTT04iLCJmaXJlIiwic2VxdWVuY2VyIiwiX2RlZmluZVRvb0ZhckJlaGluZCIsIl9yZXNldFRvb0ZhckJlaGluZCIsIkZhY3RzIiwiaW5jcmVtZW50U2VydmVyRmFjdCIsIl9vcmRlcmVkIiwiX29uU3RvcCIsIl9xdWV1ZSIsIl9TeW5jaHJvbm91c1F1ZXVlIiwiX2hhbmRsZXMiLCJfY2FjaGUiLCJfQ2FjaGluZ0NoYW5nZU9ic2VydmVyIiwiX2FkZEhhbmRsZVRhc2tzU2NoZWR1bGVkQnV0Tm90UGVyZm9ybWVkIiwiY2FsbGJhY2tOYW1lcyIsImNhbGxiYWNrTmFtZSIsIl9hcHBseUNhbGxiYWNrIiwidG9BcnJheSIsImhhbmRsZSIsInNhZmVUb1J1blRhc2siLCJydW5UYXNrIiwiX3NlbmRBZGRzIiwicmVtb3ZlSGFuZGxlIiwiX3JlYWR5IiwiX3N0b3AiLCJmcm9tUXVlcnlFcnJvciIsInJlYWR5IiwicXVldWVUYXNrIiwicXVlcnlFcnJvciIsInRocm93Iiwib25GbHVzaCIsImlzUmVzb2x2ZWQiLCJhcmdzIiwiYXBwbHlDaGFuZ2UiLCJrZXlzIiwiaGFuZGxlSWQiLCJhZGQiLCJfYWRkZWRCZWZvcmUiLCJfYWRkZWQiLCJkb2NzIiwibmV4dE9ic2VydmVIYW5kbGVJZCIsIl9tdWx0aXBsZXhlciIsImJlZm9yZSIsIkZpYmVyIiwibW9uZ29Db25uZWN0aW9uIiwiX21vbmdvQ29ubmVjdGlvbiIsIl9jYWxsYmFja3NGb3JDYWNoZUtleSIsImNhY2hlS2V5IiwiY2hlY2siLCJTdHJpbmciLCJjbG9uZWREb2MiLCJydW4iLCJfbW9uZ29IYW5kbGUiLCJfc3RvcENhbGxiYWNrcyIsIl9yZXN1bHRzIiwiX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCIsIl9wZW5kaW5nV3JpdGVzIiwiX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCIsInRocm90dGxlIiwiX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkIiwicG9sbGluZ1Rocm90dGxlTXMiLCJfdGFza1F1ZXVlIiwibGlzdGVuZXJzSGFuZGxlIiwicG9sbGluZ0ludGVydmFsIiwicG9sbGluZ0ludGVydmFsTXMiLCJfcG9sbGluZ0ludGVydmFsIiwiaW50ZXJ2YWxIYW5kbGUiLCJzZXRJbnRlcnZhbCIsImNsZWFySW50ZXJ2YWwiLCJfcG9sbE1vbmdvIiwiX3N1c3BlbmRQb2xsaW5nIiwiX3Jlc3VtZVBvbGxpbmciLCJmaXJzdCIsIm5ld1Jlc3VsdHMiLCJvbGRSZXN1bHRzIiwid3JpdGVzRm9yQ3ljbGUiLCJjb2RlIiwibWVzc2FnZSIsIkFycmF5IiwiX2RpZmZRdWVyeUNoYW5nZXMiLCJ3IiwiYyIsIlBIQVNFIiwiUVVFUllJTkciLCJGRVRDSElORyIsIlNURUFEWSIsIlN3aXRjaGVkVG9RdWVyeSIsImZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5IiwiY3VycmVudElkIiwiX3VzZXNPcGxvZyIsImNvbXBhcmF0b3IiLCJnZXRDb21wYXJhdG9yIiwiaGVhcE9wdGlvbnMiLCJJZE1hcCIsIl9saW1pdCIsIl9jb21wYXJhdG9yIiwiX3NvcnRlciIsIl91bnB1Ymxpc2hlZEJ1ZmZlciIsIk1pbk1heEhlYXAiLCJfcHVibGlzaGVkIiwiTWF4SGVhcCIsIl9zYWZlQXBwZW5kVG9CdWZmZXIiLCJfc3RvcEhhbmRsZXMiLCJfcmVnaXN0ZXJQaGFzZUNoYW5nZSIsIl9tYXRjaGVyIiwicHJvamVjdGlvbiIsIl9wcm9qZWN0aW9uRm4iLCJfY29tcGlsZVByb2plY3Rpb24iLCJfc2hhcmVkUHJvamVjdGlvbiIsImNvbWJpbmVJbnRvUHJvamVjdGlvbiIsIl9zaGFyZWRQcm9qZWN0aW9uRm4iLCJfbmVlZFRvRmV0Y2giLCJfY3VycmVudGx5RmV0Y2hpbmciLCJfZmV0Y2hHZW5lcmF0aW9uIiwiX3JlcXVlcnlXaGVuRG9uZVRoaXNRdWVyeSIsIl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5IiwiX25lZWRUb1BvbGxRdWVyeSIsIl9waGFzZSIsIl9oYW5kbGVPcGxvZ0VudHJ5UXVlcnlpbmciLCJfaGFuZGxlT3Bsb2dFbnRyeVN0ZWFkeU9yRmV0Y2hpbmciLCJmaXJlZCIsIl9vcGxvZ09ic2VydmVEcml2ZXJzIiwib25CZWZvcmVGaXJlIiwiZHJpdmVycyIsImRyaXZlciIsIl9ydW5Jbml0aWFsUXVlcnkiLCJfYWRkUHVibGlzaGVkIiwib3ZlcmZsb3dpbmdEb2NJZCIsIm1heEVsZW1lbnRJZCIsIm92ZXJmbG93aW5nRG9jIiwiZXF1YWxzIiwicmVtb3ZlZCIsIl9hZGRCdWZmZXJlZCIsIl9yZW1vdmVQdWJsaXNoZWQiLCJlbXB0eSIsIm5ld0RvY0lkIiwibWluRWxlbWVudElkIiwiX3JlbW92ZUJ1ZmZlcmVkIiwiX2NoYW5nZVB1Ymxpc2hlZCIsIm9sZERvYyIsInByb2plY3RlZE5ldyIsInByb2plY3RlZE9sZCIsImNoYW5nZWQiLCJEaWZmU2VxdWVuY2UiLCJtYWtlQ2hhbmdlZEZpZWxkcyIsIm1heEJ1ZmZlcmVkSWQiLCJfYWRkTWF0Y2hpbmciLCJtYXhQdWJsaXNoZWQiLCJtYXhCdWZmZXJlZCIsInRvUHVibGlzaCIsImNhbkFwcGVuZFRvQnVmZmVyIiwiY2FuSW5zZXJ0SW50b0J1ZmZlciIsInRvQnVmZmVyIiwiX3JlbW92ZU1hdGNoaW5nIiwiX2hhbmRsZURvYyIsIm1hdGNoZXNOb3ciLCJkb2N1bWVudE1hdGNoZXMiLCJwdWJsaXNoZWRCZWZvcmUiLCJidWZmZXJlZEJlZm9yZSIsImNhY2hlZEJlZm9yZSIsIm1pbkJ1ZmZlcmVkIiwic3RheXNJblB1Ymxpc2hlZCIsInN0YXlzSW5CdWZmZXIiLCJfZmV0Y2hNb2RpZmllZERvY3VtZW50cyIsInRoaXNHZW5lcmF0aW9uIiwid2FpdGluZyIsImZ1dCIsIl9iZVN0ZWFkeSIsIndyaXRlcyIsInRvU3RyaW5nIiwiaXNSZXBsYWNlIiwiY2FuRGlyZWN0bHlNb2RpZnlEb2MiLCJtb2RpZmllckNhbkJlRGlyZWN0bHlBcHBsaWVkIiwiX21vZGlmeSIsImNhbkJlY29tZVRydWVCeU1vZGlmaWVyIiwiYWZmZWN0ZWRCeU1vZGlmaWVyIiwiX3J1blF1ZXJ5IiwiaW5pdGlhbCIsIl9kb25lUXVlcnlpbmciLCJfcG9sbFF1ZXJ5IiwibmV3QnVmZmVyIiwiX2N1cnNvckZvclF1ZXJ5IiwiaSIsIl9wdWJsaXNoTmV3UmVzdWx0cyIsIm9wdGlvbnNPdmVyd3JpdGUiLCJkZXNjcmlwdGlvbiIsImlkc1RvUmVtb3ZlIiwiX29wbG9nRW50cnlIYW5kbGUiLCJfbGlzdGVuZXJzSGFuZGxlIiwicGhhc2UiLCJub3ciLCJEYXRlIiwidGltZURpZmYiLCJfcGhhc2VTdGFydFRpbWUiLCJkaXNhYmxlT3Bsb2ciLCJfZGlzYWJsZU9wbG9nIiwiX2NoZWNrU3VwcG9ydGVkUHJvamVjdGlvbiIsImhhc1doZXJlIiwiaGFzR2VvUXVlcnkiLCJtb2RpZmllciIsIm9wZXJhdGlvbiIsImZpZWxkIiwiZXhwb3J0IiwiTG9jYWxDb2xsZWN0aW9uRHJpdmVyIiwiY29uc3RydWN0b3IiLCJub0Nvbm5Db2xsZWN0aW9ucyIsImNyZWF0ZSIsIm9wZW4iLCJjb25uIiwiZW5zdXJlQ29sbGVjdGlvbiIsIl9tb25nb19saXZlZGF0YV9jb2xsZWN0aW9ucyIsImNvbGxlY3Rpb25zIiwiUmVtb3RlQ29sbGVjdGlvbkRyaXZlciIsIm1vbmdvX3VybCIsIm0iLCJkZWZhdWx0UmVtb3RlQ29sbGVjdGlvbkRyaXZlciIsIm9uY2UiLCJjb25uZWN0aW9uT3B0aW9ucyIsIm1vbmdvVXJsIiwiTU9OR09fVVJMIiwiTU9OR09fT1BMT0dfVVJMIiwiY29ubmVjdGlvbiIsIm1hbmFnZXIiLCJpZEdlbmVyYXRpb24iLCJfZHJpdmVyIiwiX3ByZXZlbnRBdXRvcHVibGlzaCIsIl9tYWtlTmV3SUQiLCJzcmMiLCJERFAiLCJyYW5kb21TdHJlYW0iLCJSYW5kb20iLCJpbnNlY3VyZSIsImhleFN0cmluZyIsIl9jb25uZWN0aW9uIiwiaXNDbGllbnQiLCJzZXJ2ZXIiLCJfY29sbGVjdGlvbiIsIl9uYW1lIiwiX21heWJlU2V0VXBSZXBsaWNhdGlvbiIsImRlZmluZU11dGF0aW9uTWV0aG9kcyIsIl9kZWZpbmVNdXRhdGlvbk1ldGhvZHMiLCJ1c2VFeGlzdGluZyIsIl9zdXBwcmVzc1NhbWVOYW1lRXJyb3IiLCJhdXRvcHVibGlzaCIsInB1Ymxpc2giLCJpc19hdXRvIiwicmVnaXN0ZXJTdG9yZSIsIm9rIiwiYmVnaW5VcGRhdGUiLCJiYXRjaFNpemUiLCJyZXNldCIsInBhdXNlT2JzZXJ2ZXJzIiwibXNnIiwibW9uZ29JZCIsIk1vbmdvSUQiLCJpZFBhcnNlIiwicmVwbGFjZSIsIiR1bnNldCIsIiRzZXQiLCJlbmRVcGRhdGUiLCJyZXN1bWVPYnNlcnZlcnMiLCJzYXZlT3JpZ2luYWxzIiwicmV0cmlldmVPcmlnaW5hbHMiLCJnZXREb2MiLCJfZ2V0Q29sbGVjdGlvbiIsImNvbnNvbGUiLCJ3YXJuIiwibG9nIiwiX2dldEZpbmRTZWxlY3RvciIsIl9nZXRGaW5kT3B0aW9ucyIsIk1hdGNoIiwiT3B0aW9uYWwiLCJPYmplY3RJbmNsdWRpbmciLCJPbmVPZiIsIk51bWJlciIsImZhbGxiYWNrSWQiLCJfc2VsZWN0b3JJc0lkIiwiZ2V0UHJvdG90eXBlT2YiLCJnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3JzIiwiZ2VuZXJhdGVJZCIsIl9pc1JlbW90ZUNvbGxlY3Rpb24iLCJlbmNsb3NpbmciLCJfQ3VycmVudE1ldGhvZEludm9jYXRpb24iLCJjaG9vc2VSZXR1cm5WYWx1ZUZyb21Db2xsZWN0aW9uUmVzdWx0Iiwid3JhcENhbGxiYWNrIiwiX2NhbGxNdXRhdG9yTWV0aG9kIiwib3B0aW9uc0FuZENhbGxiYWNrIiwicG9wQ2FsbGJhY2tGcm9tQXJncyIsInJhd0RhdGFiYXNlIiwiY29udmVydFJlc3VsdCIsIkFsbG93RGVueSIsIkNvbGxlY3Rpb25Qcm90b3R5cGUiLCJzZXRDb25uZWN0aW9uT3B0aW9ucyJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7Ozs7Ozs7O0FBU0EsSUFBSUEsVUFBVUMsZ0JBQWQ7O0FBQ0EsSUFBSUMsU0FBU0MsSUFBSUMsT0FBSixDQUFZLGVBQVosQ0FBYjs7QUFFQUMsaUJBQWlCLEVBQWpCO0FBQ0FDLFlBQVksRUFBWjtBQUVBRCxlQUFlRSxVQUFmLEdBQTRCO0FBQzFCQyxXQUFTO0FBQ1BDLGFBQVNDLHVCQURGO0FBRVBDLFlBQVFYO0FBRkQ7QUFEaUIsQ0FBNUIsQyxDQU9BO0FBQ0E7QUFDQTtBQUNBOztBQUNBSyxlQUFlTyxTQUFmLEdBQTJCWixPQUEzQixDLENBRUE7QUFDQTs7QUFDQSxJQUFJYSxlQUFlLFVBQVVDLE1BQVYsRUFBa0JDLEtBQWxCLEVBQXlCO0FBQzFDLE1BQUksT0FBT0EsS0FBUCxLQUFpQixRQUFqQixJQUE2QkEsVUFBVSxJQUEzQyxFQUFpRDtBQUMvQyxRQUFJQyxFQUFFQyxPQUFGLENBQVVGLEtBQVYsQ0FBSixFQUFzQjtBQUNwQixhQUFPQyxFQUFFRSxHQUFGLENBQU1ILEtBQU4sRUFBYUMsRUFBRUcsSUFBRixDQUFPTixZQUFQLEVBQXFCLElBQXJCLEVBQTJCQyxNQUEzQixDQUFiLENBQVA7QUFDRDs7QUFDRCxRQUFJTSxNQUFNLEVBQVY7O0FBQ0FKLE1BQUVLLElBQUYsQ0FBT04sS0FBUCxFQUFjLFVBQVVPLEtBQVYsRUFBaUJDLEdBQWpCLEVBQXNCO0FBQ2xDSCxVQUFJTixPQUFPUyxHQUFQLENBQUosSUFBbUJWLGFBQWFDLE1BQWIsRUFBcUJRLEtBQXJCLENBQW5CO0FBQ0QsS0FGRDs7QUFH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RDtBQVNEO0FBRUQ7Ozs7Ozs7O0FBTUF2RixNQUFNRCxRQUFOLEdBQWlCdW1CLFFBQVF2bUIsUUFBekI7QUFFQTs7Ozs7O0FBS0FDLE1BQU1rSyxNQUFOLEdBQWVuRSxnQkFBZ0JtRSxNQUEvQjtBQUVBOzs7O0FBR0FsSyxNQUFNNkssVUFBTixDQUFpQlgsTUFBakIsR0FBMEJsSyxNQUFNa0ssTUFBaEM7QUFFQTs7OztBQUdBbEssTUFBTTZLLFVBQU4sQ0FBaUI5SyxRQUFqQixHQUE0QkMsTUFBTUQsUUFBbEM7QUFFQTs7OztBQUdBMkMsT0FBT21JLFVBQVAsR0FBb0I3SyxNQUFNNkssVUFBMUIsQyxDQUVBOztBQUNBcEosT0FBT0MsTUFBUCxDQUNFZ0IsT0FBT21JLFVBQVAsQ0FBa0J6TCxTQURwQixFQUVFc3BCLFVBQVVDLG1CQUZaOztBQUtBLFNBQVNKLG1CQUFULENBQTZCL1AsSUFBN0IsRUFBbUM7QUFDakM7QUFDQTtBQUNBLE1BQUlBLEtBQUt2UCxNQUFMLEtBQ0N1UCxLQUFLQSxLQUFLdlAsTUFBTCxHQUFjLENBQW5CLE1BQTBCNUksU0FBMUIsSUFDQW1ZLEtBQUtBLEtBQUt2UCxNQUFMLEdBQWMsQ0FBbkIsYUFBaUN4QixRQUZsQyxDQUFKLEVBRWlEO0FBQy9DLFdBQU8rUSxLQUFLckMsR0FBTCxFQUFQO0FBQ0Q7QUFDRixDOzs7Ozs7Ozs7OztBQ2h3QkQ7Ozs7OztBQU1BblcsTUFBTTRvQixvQkFBTixHQUE2QixTQUFTQSxvQkFBVCxDQUErQnpuQixPQUEvQixFQUF3QztBQUNuRXFZLFFBQU1yWSxPQUFOLEVBQWVNLE1BQWY7QUFDQXpCLFFBQU0rQixrQkFBTixHQUEyQlosT0FBM0I7QUFDRCxDQUhELEMiLCJmaWxlIjoiL3BhY2thZ2VzL21vbmdvLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQcm92aWRlIGEgc3luY2hyb25vdXMgQ29sbGVjdGlvbiBBUEkgdXNpbmcgZmliZXJzLCBiYWNrZWQgYnlcbiAqIE1vbmdvREIuICBUaGlzIGlzIG9ubHkgZm9yIHVzZSBvbiB0aGUgc2VydmVyLCBhbmQgbW9zdGx5IGlkZW50aWNhbFxuICogdG8gdGhlIGNsaWVudCBBUEkuXG4gKlxuICogTk9URTogdGhlIHB1YmxpYyBBUEkgbWV0aG9kcyBtdXN0IGJlIHJ1biB3aXRoaW4gYSBmaWJlci4gSWYgeW91IGNhbGxcbiAqIHRoZXNlIG91dHNpZGUgb2YgYSBmaWJlciB0aGV5IHdpbGwgZXhwbG9kZSFcbiAqL1xuXG52YXIgTW9uZ29EQiA9IE5wbU1vZHVsZU1vbmdvZGI7XG52YXIgRnV0dXJlID0gTnBtLnJlcXVpcmUoJ2ZpYmVycy9mdXR1cmUnKTtcblxuTW9uZ29JbnRlcm5hbHMgPSB7fTtcbk1vbmdvVGVzdCA9IHt9O1xuXG5Nb25nb0ludGVybmFscy5OcG1Nb2R1bGVzID0ge1xuICBtb25nb2RiOiB7XG4gICAgdmVyc2lvbjogTnBtTW9kdWxlTW9uZ29kYlZlcnNpb24sXG4gICAgbW9kdWxlOiBNb25nb0RCXG4gIH1cbn07XG5cbi8vIE9sZGVyIHZlcnNpb24gb2Ygd2hhdCBpcyBub3cgYXZhaWxhYmxlIHZpYVxuLy8gTW9uZ29JbnRlcm5hbHMuTnBtTW9kdWxlcy5tb25nb2RiLm1vZHVsZS4gIEl0IHdhcyBuZXZlciBkb2N1bWVudGVkLCBidXRcbi8vIHBlb3BsZSBkbyB1c2UgaXQuXG4vLyBYWFggQ09NUEFUIFdJVEggMS4wLjMuMlxuTW9uZ29JbnRlcm5hbHMuTnBtTW9kdWxlID0gTW9uZ29EQjtcblxuLy8gVGhpcyBpcyB1c2VkIHRvIGFkZCBvciByZW1vdmUgRUpTT04gZnJvbSB0aGUgYmVnaW5uaW5nIG9mIGV2ZXJ5dGhpbmcgbmVzdGVkXG4vLyBpbnNpZGUgYW4gRUpTT04gY3VzdG9tIHR5cGUuIEl0IHNob3VsZCBvbmx5IGJlIGNhbGxlZCBvbiBwdXJlIEpTT04hXG52YXIgcmVwbGFjZU5hbWVzID0gZnVuY3Rpb24gKGZpbHRlciwgdGhpbmcpIHtcbiAgaWYgKHR5cGVvZiB0aGluZyA9PT0gXCJvYmplY3RcIiAmJiB0aGluZyAhPT0gbnVsbCkge1xuICAgIGlmIChfLmlzQXJyYXkodGhpbmcpKSB7XG4gICAgICByZXR1cm4gXy5tYXAodGhpbmcsIF8uYmluZChyZXBsYWNlTmFtZXMsIG51bGwsIGZpbHRlcikpO1xuICAgIH1cbiAgICB2YXIgcmV0ID0ge307XG4gICAgXy5lYWNoKHRoaW5nLCBmdW5jdGlvbiAodmFsdWUsIGtleSkge1xuICAgICAgcmV0W2ZpbHRlcihrZXkpXSA9IHJlcGxhY2VOYW1lcyhmaWx0ZXIsIHZhbHVlKTtcbiAgICB9KTtcbiAgICByZXR1cm4gcmV0O1xuICB9XG4gIHJldHVybiB0aGluZztcbn07XG5cbi8vIEVuc3VyZSB0aGF0IEVKU09OLmNsb25lIGtlZXBzIGEgVGltZXN0YW1wIGFzIGEgVGltZXN0YW1wIChpbnN0ZWFkIG9mIGp1c3Rcbi8vIGRvaW5nIGEgc3RydWN0dXJhbCBjbG9uZSkuXG4vLyBYWFggaG93IG9rIGlzIHRoaXM/IHdoYXQgaWYgdGhlcmUgYXJlIG11bHRpcGxlIGNvcGllcyBvZiBNb25nb0RCIGxvYWRlZD9cbk1vbmdvREIuVGltZXN0YW1wLnByb3RvdHlwZS5jbG9uZSA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gVGltZXN0YW1wcyBzaG91bGQgYmUgaW1tdXRhYmxlLlxuICByZXR1cm4gdGhpcztcbn07XG5cbnZhciBtYWtlTW9uZ29MZWdhbCA9IGZ1bmN0aW9uIChuYW1lKSB7IHJldHVybiBcIkVKU09OXCIgKyBuYW1lOyB9O1xudmFyIHVubWFrZU1vbmdvTGVnYWwgPSBmdW5jdGlvbiAobmFtZSkgeyByZXR1cm4gbmFtZS5zdWJzdHIoNSk7IH07XG5cbnZhciByZXBsYWNlTW9uZ29BdG9tV2l0aE1ldGVvciA9IGZ1bmN0aW9uIChkb2N1bWVudCkge1xuICBpZiAoZG9jdW1lbnQgaW5zdGFuY2VvZiBNb25nb0RCLkJpbmFyeSkge1xuICAgIHZhciBidWZmZXIgPSBkb2N1bWVudC52YWx1ZSh0cnVlKTtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyKTtcbiAgfVxuICBpZiAoZG9jdW1lbnQgaW5zdGFuY2VvZiBNb25nb0RCLk9iamVjdElEKSB7XG4gICAgcmV0dXJuIG5ldyBNb25nby5PYmplY3RJRChkb2N1bWVudC50b0hleFN0cmluZygpKTtcbiAgfVxuICBpZiAoZG9jdW1lbnRbXCJFSlNPTiR0eXBlXCJdICYmIGRvY3VtZW50W1wiRUpTT04kdmFsdWVcIl0gJiYgXy5zaXplKGRvY3VtZW50KSA9PT0gMikge1xuICAgIHJldHVybiBFSlNPTi5mcm9tSlNPTlZhbHVlKHJlcGxhY2VOYW1lcyh1bm1ha2VNb25nb0xlZ2FsLCBkb2N1bWVudCkpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvREIuVGltZXN0YW1wKSB7XG4gICAgLy8gRm9yIG5vdywgdGhlIE1ldGVvciByZXByZXNlbnRhdGlvbiBvZiBhIE1vbmdvIHRpbWVzdGFtcCB0eXBlIChub3QgYSBkYXRlIVxuICAgIC8vIHRoaXMgaXMgYSB3ZWlyZCBpbnRlcm5hbCB0aGluZyB1c2VkIGluIHRoZSBvcGxvZyEpIGlzIHRoZSBzYW1lIGFzIHRoZVxuICAgIC8vIE1vbmdvIHJlcHJlc2VudGF0aW9uLiBXZSBuZWVkIHRvIGRvIHRoaXMgZXhwbGljaXRseSBvciBlbHNlIHdlIHdvdWxkIGRvIGFcbiAgICAvLyBzdHJ1Y3R1cmFsIGNsb25lIGFuZCBsb3NlIHRoZSBwcm90b3R5cGUuXG4gICAgcmV0dXJuIGRvY3VtZW50O1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG52YXIgcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28gPSBmdW5jdGlvbiAoZG9jdW1lbnQpIHtcbiAgaWYgKEVKU09OLmlzQmluYXJ5KGRvY3VtZW50KSkge1xuICAgIC8vIFRoaXMgZG9lcyBtb3JlIGNvcGllcyB0aGFuIHdlJ2QgbGlrZSwgYnV0IGlzIG5lY2Vzc2FyeSBiZWNhdXNlXG4gICAgLy8gTW9uZ29EQi5CU09OIG9ubHkgbG9va3MgbGlrZSBpdCB0YWtlcyBhIFVpbnQ4QXJyYXkgKGFuZCBkb2Vzbid0IGFjdHVhbGx5XG4gICAgLy8gc2VyaWFsaXplIGl0IGNvcnJlY3RseSkuXG4gICAgcmV0dXJuIG5ldyBNb25nb0RCLkJpbmFyeShCdWZmZXIuZnJvbShkb2N1bWVudCkpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvLk9iamVjdElEKSB7XG4gICAgcmV0dXJuIG5ldyBNb25nb0RCLk9iamVjdElEKGRvY3VtZW50LnRvSGV4U3RyaW5nKCkpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvREIuVGltZXN0YW1wKSB7XG4gICAgLy8gRm9yIG5vdywgdGhlIE1ldGVvciByZXByZXNlbnRhdGlvbiBvZiBhIE1vbmdvIHRpbWVzdGFtcCB0eXBlIChub3QgYSBkYXRlIVxuICAgIC8vIHRoaXMgaXMgYSB3ZWlyZCBpbnRlcm5hbCB0aGluZyB1c2VkIGluIHRoZSBvcGxvZyEpIGlzIHRoZSBzYW1lIGFzIHRoZVxuICAgIC8vIE1vbmdvIHJlcHJlc2VudGF0aW9uLiBXZSBuZWVkIHRvIGRvIHRoaXMgZXhwbGljaXRseSBvciBlbHNlIHdlIHdvdWxkIGRvIGFcbiAgICAvLyBzdHJ1Y3R1cmFsIGNsb25lIGFuZCBsb3NlIHRoZSBwcm90b3R5cGUuXG4gICAgcmV0dXJuIGRvY3VtZW50O1xuICB9XG4gIGlmIChFSlNPTi5faXNDdXN0b21UeXBlKGRvY3VtZW50KSkge1xuICAgIHJldHVybiByZXBsYWNlTmFtZXMobWFrZU1vbmdvTGVnYWwsIEVKU09OLnRvSlNPTlZhbHVlKGRvY3VtZW50KSk7XG4gIH1cbiAgLy8gSXQgaXMgbm90IG9yZGluYXJpbHkgcG9zc2libGUgdG8gc3RpY2sgZG9sbGFyLXNpZ24ga2V5cyBpbnRvIG1vbmdvXG4gIC8vIHNvIHdlIGRvbid0IGJvdGhlciBjaGVja2luZyBmb3IgdGhpbmdzIHRoYXQgbmVlZCBlc2NhcGluZyBhdCB0aGlzIHRpbWUuXG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG52YXIgcmVwbGFjZVR5cGVzID0gZnVuY3Rpb24gKGRvY3VtZW50LCBhdG9tVHJhbnNmb3JtZXIpIHtcbiAgaWYgKHR5cGVvZiBkb2N1bWVudCAhPT0gJ29iamVjdCcgfHwgZG9jdW1lbnQgPT09IG51bGwpXG4gICAgcmV0dXJuIGRvY3VtZW50O1xuXG4gIHZhciByZXBsYWNlZFRvcExldmVsQXRvbSA9IGF0b21UcmFuc2Zvcm1lcihkb2N1bWVudCk7XG4gIGlmIChyZXBsYWNlZFRvcExldmVsQXRvbSAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiByZXBsYWNlZFRvcExldmVsQXRvbTtcblxuICB2YXIgcmV0ID0gZG9jdW1lbnQ7XG4gIF8uZWFjaChkb2N1bWVudCwgZnVuY3Rpb24gKHZhbCwga2V5KSB7XG4gICAgdmFyIHZhbFJlcGxhY2VkID0gcmVwbGFjZVR5cGVzKHZhbCwgYXRvbVRyYW5zZm9ybWVyKTtcbiAgICBpZiAodmFsICE9PSB2YWxSZXBsYWNlZCkge1xuICAgICAgLy8gTGF6eSBjbG9uZS4gU2hhbGxvdyBjb3B5LlxuICAgICAgaWYgKHJldCA9PT0gZG9jdW1lbnQpXG4gICAgICAgIHJldCA9IF8uY2xvbmUoZG9jdW1lbnQpO1xuICAgICAgcmV0W2tleV0gPSB2YWxSZXBsYWNlZDtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gcmV0O1xufTtcblxuXG5Nb25nb0Nvbm5lY3Rpb24gPSBmdW5jdGlvbiAodXJsLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gIHNlbGYuX29ic2VydmVNdWx0aXBsZXhlcnMgPSB7fTtcbiAgc2VsZi5fb25GYWlsb3Zlckhvb2sgPSBuZXcgSG9vaztcblxuICB2YXIgbW9uZ29PcHRpb25zID0gT2JqZWN0LmFzc2lnbih7XG4gICAgLy8gUmVjb25uZWN0IG9uIGVycm9yLlxuICAgIGF1dG9SZWNvbm5lY3Q6IHRydWUsXG4gICAgLy8gVHJ5IHRvIHJlY29ubmVjdCBmb3JldmVyLCBpbnN0ZWFkIG9mIHN0b3BwaW5nIGFmdGVyIDMwIHRyaWVzICh0aGVcbiAgICAvLyBkZWZhdWx0KSwgd2l0aCBlYWNoIGF0dGVtcHQgc2VwYXJhdGVkIGJ5IDEwMDBtcy5cbiAgICByZWNvbm5lY3RUcmllczogSW5maW5pdHksXG4gICAgaWdub3JlVW5kZWZpbmVkOiB0cnVlXG4gIH0sIE1vbmdvLl9jb25uZWN0aW9uT3B0aW9ucyk7XG5cbiAgLy8gRGlzYWJsZSB0aGUgbmF0aXZlIHBhcnNlciBieSBkZWZhdWx0LCB1bmxlc3Mgc3BlY2lmaWNhbGx5IGVuYWJsZWRcbiAgLy8gaW4gdGhlIG1vbmdvIFVSTC5cbiAgLy8gLSBUaGUgbmF0aXZlIGRyaXZlciBjYW4gY2F1c2UgZXJyb3JzIHdoaWNoIG5vcm1hbGx5IHdvdWxkIGJlXG4gIC8vICAgdGhyb3duLCBjYXVnaHQsIGFuZCBoYW5kbGVkIGludG8gc2VnZmF1bHRzIHRoYXQgdGFrZSBkb3duIHRoZVxuICAvLyAgIHdob2xlIGFwcC5cbiAgLy8gLSBCaW5hcnkgbW9kdWxlcyBkb24ndCB5ZXQgd29yayB3aGVuIHlvdSBidW5kbGUgYW5kIG1vdmUgdGhlIGJ1bmRsZVxuICAvLyAgIHRvIGEgZGlmZmVyZW50IHBsYXRmb3JtIChha2EgZGVwbG95KVxuICAvLyBXZSBzaG91bGQgcmV2aXNpdCB0aGlzIGFmdGVyIGJpbmFyeSBucG0gbW9kdWxlIHN1cHBvcnQgbGFuZHMuXG4gIGlmICghKC9bXFw/Jl1uYXRpdmVfP1twUF1hcnNlcj0vLnRlc3QodXJsKSkpIHtcbiAgICBtb25nb09wdGlvbnMubmF0aXZlX3BhcnNlciA9IGZhbHNlO1xuICB9XG5cbiAgLy8gSW50ZXJuYWxseSB0aGUgb3Bsb2cgY29ubmVjdGlvbnMgc3BlY2lmeSB0aGVpciBvd24gcG9vbFNpemVcbiAgLy8gd2hpY2ggd2UgZG9uJ3Qgd2FudCB0byBvdmVyd3JpdGUgd2l0aCBhbnkgdXNlciBkZWZpbmVkIHZhbHVlXG4gIGlmIChfLmhhcyhvcHRpb25zLCAncG9vbFNpemUnKSkge1xuICAgIC8vIElmIHdlIGp1c3Qgc2V0IHRoaXMgZm9yIFwic2VydmVyXCIsIHJlcGxTZXQgd2lsbCBvdmVycmlkZSBpdC4gSWYgd2UganVzdFxuICAgIC8vIHNldCBpdCBmb3IgcmVwbFNldCwgaXQgd2lsbCBiZSBpZ25vcmVkIGlmIHdlJ3JlIG5vdCB1c2luZyBhIHJlcGxTZXQuXG4gICAgbW9uZ29PcHRpb25zLnBvb2xTaXplID0gb3B0aW9ucy5wb29sU2l6ZTtcbiAgfVxuXG4gIHNlbGYuZGIgPSBudWxsO1xuICAvLyBXZSBrZWVwIHRyYWNrIG9mIHRoZSBSZXBsU2V0J3MgcHJpbWFyeSwgc28gdGhhdCB3ZSBjYW4gdHJpZ2dlciBob29rcyB3aGVuXG4gIC8vIGl0IGNoYW5nZXMuICBUaGUgTm9kZSBkcml2ZXIncyBqb2luZWQgY2FsbGJhY2sgc2VlbXMgdG8gZmlyZSB3YXkgdG9vXG4gIC8vIG9mdGVuLCB3aGljaCBpcyB3aHkgd2UgbmVlZCB0byB0cmFjayBpdCBvdXJzZWx2ZXMuXG4gIHNlbGYuX3ByaW1hcnkgPSBudWxsO1xuICBzZWxmLl9vcGxvZ0hhbmRsZSA9IG51bGw7XG4gIHNlbGYuX2RvY0ZldGNoZXIgPSBudWxsO1xuXG5cbiAgdmFyIGNvbm5lY3RGdXR1cmUgPSBuZXcgRnV0dXJlO1xuICBNb25nb0RCLmNvbm5lY3QoXG4gICAgdXJsLFxuICAgIG1vbmdvT3B0aW9ucyxcbiAgICBNZXRlb3IuYmluZEVudmlyb25tZW50KFxuICAgICAgZnVuY3Rpb24gKGVyciwgZGIpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEZpcnN0LCBmaWd1cmUgb3V0IHdoYXQgdGhlIGN1cnJlbnQgcHJpbWFyeSBpcywgaWYgYW55LlxuICAgICAgICBpZiAoZGIuc2VydmVyQ29uZmlnLmlzTWFzdGVyRG9jKSB7XG4gICAgICAgICAgc2VsZi5fcHJpbWFyeSA9IGRiLnNlcnZlckNvbmZpZy5pc01hc3RlckRvYy5wcmltYXJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgZGIuc2VydmVyQ29uZmlnLm9uKFxuICAgICAgICAgICdqb2luZWQnLCBNZXRlb3IuYmluZEVudmlyb25tZW50KGZ1bmN0aW9uIChraW5kLCBkb2MpIHtcbiAgICAgICAgICAgIGlmIChraW5kID09PSAncHJpbWFyeScpIHtcbiAgICAgICAgICAgICAgaWYgKGRvYy5wcmltYXJ5ICE9PSBzZWxmLl9wcmltYXJ5KSB7XG4gICAgICAgICAgICAgICAgc2VsZi5fcHJpbWFyeSA9IGRvYy5wcmltYXJ5O1xuICAgICAgICAgICAgICAgIHNlbGYuX29uRmFpbG92ZXJIb29rLmVhY2goZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZG9jLm1lID09PSBzZWxmLl9wcmltYXJ5KSB7XG4gICAgICAgICAgICAgIC8vIFRoZSB0aGluZyB3ZSB0aG91Z2h0IHdhcyBwcmltYXJ5IGlzIG5vdyBzb21ldGhpbmcgb3RoZXIgdGhhblxuICAgICAgICAgICAgICAvLyBwcmltYXJ5LiAgRm9yZ2V0IHRoYXQgd2UgdGhvdWdodCBpdCB3YXMgcHJpbWFyeS4gIChUaGlzIG1lYW5zXG4gICAgICAgICAgICAgIC8vIHRoYXQgaWYgYSBzZXJ2ZXIgc3RvcHMgYmVpbmcgcHJpbWFyeSBhbmQgdGhlbiBzdGFydHMgYmVpbmdcbiAgICAgICAgICAgICAgLy8gcHJpbWFyeSBhZ2FpbiB3aXRob3V0IGFub3RoZXIgc2VydmVyIGJlY29taW5nIHByaW1hcnkgaW4gdGhlXG4gICAgICAgICAgICAgIC8vIG1pZGRsZSwgd2UnbGwgY29ycmVjdGx5IGNvdW50IGl0IGFzIGEgZmFpbG92ZXIuKVxuICAgICAgICAgICAgICBzZWxmLl9wcmltYXJ5ID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KSk7XG5cbiAgICAgICAgLy8gQWxsb3cgdGhlIGNvbnN0cnVjdG9yIHRvIHJldHVybi5cbiAgICAgICAgY29ubmVjdEZ1dHVyZVsncmV0dXJuJ10oZGIpO1xuICAgICAgfSxcbiAgICAgIGNvbm5lY3RGdXR1cmUucmVzb2x2ZXIoKSAgLy8gb25FeGNlcHRpb25cbiAgICApXG4gICk7XG5cbiAgLy8gV2FpdCBmb3IgdGhlIGNvbm5lY3Rpb24gdG8gYmUgc3VjY2Vzc2Z1bDsgdGhyb3dzIG9uIGZhaWx1cmUuXG4gIHNlbGYuZGIgPSBjb25uZWN0RnV0dXJlLndhaXQoKTtcblxuICBpZiAob3B0aW9ucy5vcGxvZ1VybCAmJiAhIFBhY2thZ2VbJ2Rpc2FibGUtb3Bsb2cnXSkge1xuICAgIHNlbGYuX29wbG9nSGFuZGxlID0gbmV3IE9wbG9nSGFuZGxlKG9wdGlvbnMub3Bsb2dVcmwsIHNlbGYuZGIuZGF0YWJhc2VOYW1lKTtcbiAgICBzZWxmLl9kb2NGZXRjaGVyID0gbmV3IERvY0ZldGNoZXIoc2VsZik7XG4gIH1cbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuY2xvc2UgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmICghIHNlbGYuZGIpXG4gICAgdGhyb3cgRXJyb3IoXCJjbG9zZSBjYWxsZWQgYmVmb3JlIENvbm5lY3Rpb24gY3JlYXRlZD9cIik7XG5cbiAgLy8gWFhYIHByb2JhYmx5IHVudGVzdGVkXG4gIHZhciBvcGxvZ0hhbmRsZSA9IHNlbGYuX29wbG9nSGFuZGxlO1xuICBzZWxmLl9vcGxvZ0hhbmRsZSA9IG51bGw7XG4gIGlmIChvcGxvZ0hhbmRsZSlcbiAgICBvcGxvZ0hhbmRsZS5zdG9wKCk7XG5cbiAgLy8gVXNlIEZ1dHVyZS53cmFwIHNvIHRoYXQgZXJyb3JzIGdldCB0aHJvd24uIFRoaXMgaGFwcGVucyB0b1xuICAvLyB3b3JrIGV2ZW4gb3V0c2lkZSBhIGZpYmVyIHNpbmNlIHRoZSAnY2xvc2UnIG1ldGhvZCBpcyBub3RcbiAgLy8gYWN0dWFsbHkgYXN5bmNocm9ub3VzLlxuICBGdXR1cmUud3JhcChfLmJpbmQoc2VsZi5kYi5jbG9zZSwgc2VsZi5kYikpKHRydWUpLndhaXQoKTtcbn07XG5cbi8vIFJldHVybnMgdGhlIE1vbmdvIENvbGxlY3Rpb24gb2JqZWN0OyBtYXkgeWllbGQuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLnJhd0NvbGxlY3Rpb24gPSBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmICghIHNlbGYuZGIpXG4gICAgdGhyb3cgRXJyb3IoXCJyYXdDb2xsZWN0aW9uIGNhbGxlZCBiZWZvcmUgQ29ubmVjdGlvbiBjcmVhdGVkP1wiKTtcblxuICB2YXIgZnV0dXJlID0gbmV3IEZ1dHVyZTtcbiAgc2VsZi5kYi5jb2xsZWN0aW9uKGNvbGxlY3Rpb25OYW1lLCBmdXR1cmUucmVzb2x2ZXIoKSk7XG4gIHJldHVybiBmdXR1cmUud2FpdCgpO1xufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbiA9IGZ1bmN0aW9uIChcbiAgICBjb2xsZWN0aW9uTmFtZSwgYnl0ZVNpemUsIG1heERvY3VtZW50cykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKCEgc2VsZi5kYilcbiAgICB0aHJvdyBFcnJvcihcIl9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uIGNhbGxlZCBiZWZvcmUgQ29ubmVjdGlvbiBjcmVhdGVkP1wiKTtcblxuICB2YXIgZnV0dXJlID0gbmV3IEZ1dHVyZSgpO1xuICBzZWxmLmRiLmNyZWF0ZUNvbGxlY3Rpb24oXG4gICAgY29sbGVjdGlvbk5hbWUsXG4gICAgeyBjYXBwZWQ6IHRydWUsIHNpemU6IGJ5dGVTaXplLCBtYXg6IG1heERvY3VtZW50cyB9LFxuICAgIGZ1dHVyZS5yZXNvbHZlcigpKTtcbiAgZnV0dXJlLndhaXQoKTtcbn07XG5cbi8vIFRoaXMgc2hvdWxkIGJlIGNhbGxlZCBzeW5jaHJvbm91c2x5IHdpdGggYSB3cml0ZSwgdG8gY3JlYXRlIGFcbi8vIHRyYW5zYWN0aW9uIG9uIHRoZSBjdXJyZW50IHdyaXRlIGZlbmNlLCBpZiBhbnkuIEFmdGVyIHdlIGNhbiByZWFkXG4vLyB0aGUgd3JpdGUsIGFuZCBhZnRlciBvYnNlcnZlcnMgaGF2ZSBiZWVuIG5vdGlmaWVkIChvciBhdCBsZWFzdCxcbi8vIGFmdGVyIHRoZSBvYnNlcnZlciBub3RpZmllcnMgaGF2ZSBhZGRlZCB0aGVtc2VsdmVzIHRvIHRoZSB3cml0ZVxuLy8gZmVuY2UpLCB5b3Ugc2hvdWxkIGNhbGwgJ2NvbW1pdHRlZCgpJyBvbiB0aGUgb2JqZWN0IHJldHVybmVkLlxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fbWF5YmVCZWdpbldyaXRlID0gZnVuY3Rpb24gKCkge1xuICB2YXIgZmVuY2UgPSBERFBTZXJ2ZXIuX0N1cnJlbnRXcml0ZUZlbmNlLmdldCgpO1xuICBpZiAoZmVuY2UpIHtcbiAgICByZXR1cm4gZmVuY2UuYmVnaW5Xcml0ZSgpO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiB7Y29tbWl0dGVkOiBmdW5jdGlvbiAoKSB7fX07XG4gIH1cbn07XG5cbi8vIEludGVybmFsIGludGVyZmFjZTogYWRkcyBhIGNhbGxiYWNrIHdoaWNoIGlzIGNhbGxlZCB3aGVuIHRoZSBNb25nbyBwcmltYXJ5XG4vLyBjaGFuZ2VzLiBSZXR1cm5zIGEgc3RvcCBoYW5kbGUuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9vbkZhaWxvdmVyID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gIHJldHVybiB0aGlzLl9vbkZhaWxvdmVySG9vay5yZWdpc3RlcihjYWxsYmFjayk7XG59O1xuXG5cbi8vLy8vLy8vLy8vLyBQdWJsaWMgQVBJIC8vLy8vLy8vLy9cblxuLy8gVGhlIHdyaXRlIG1ldGhvZHMgYmxvY2sgdW50aWwgdGhlIGRhdGFiYXNlIGhhcyBjb25maXJtZWQgdGhlIHdyaXRlIChpdCBtYXlcbi8vIG5vdCBiZSByZXBsaWNhdGVkIG9yIHN0YWJsZSBvbiBkaXNrLCBidXQgb25lIHNlcnZlciBoYXMgY29uZmlybWVkIGl0KSBpZiBub1xuLy8gY2FsbGJhY2sgaXMgcHJvdmlkZWQuIElmIGEgY2FsbGJhY2sgaXMgcHJvdmlkZWQsIHRoZW4gdGhleSBjYWxsIHRoZSBjYWxsYmFja1xuLy8gd2hlbiB0aGUgd3JpdGUgaXMgY29uZmlybWVkLiBUaGV5IHJldHVybiBub3RoaW5nIG9uIHN1Y2Nlc3MsIGFuZCByYWlzZSBhblxuLy8gZXhjZXB0aW9uIG9uIGZhaWx1cmUuXG4vL1xuLy8gQWZ0ZXIgbWFraW5nIGEgd3JpdGUgKHdpdGggaW5zZXJ0LCB1cGRhdGUsIHJlbW92ZSksIG9ic2VydmVycyBhcmVcbi8vIG5vdGlmaWVkIGFzeW5jaHJvbm91c2x5LiBJZiB5b3Ugd2FudCB0byByZWNlaXZlIGEgY2FsbGJhY2sgb25jZSBhbGxcbi8vIG9mIHRoZSBvYnNlcnZlciBub3RpZmljYXRpb25zIGhhdmUgbGFuZGVkIGZvciB5b3VyIHdyaXRlLCBkbyB0aGVcbi8vIHdyaXRlcyBpbnNpZGUgYSB3cml0ZSBmZW5jZSAoc2V0IEREUFNlcnZlci5fQ3VycmVudFdyaXRlRmVuY2UgdG8gYSBuZXdcbi8vIF9Xcml0ZUZlbmNlLCBhbmQgdGhlbiBzZXQgYSBjYWxsYmFjayBvbiB0aGUgd3JpdGUgZmVuY2UuKVxuLy9cbi8vIFNpbmNlIG91ciBleGVjdXRpb24gZW52aXJvbm1lbnQgaXMgc2luZ2xlLXRocmVhZGVkLCB0aGlzIGlzXG4vLyB3ZWxsLWRlZmluZWQgLS0gYSB3cml0ZSBcImhhcyBiZWVuIG1hZGVcIiBpZiBpdCdzIHJldHVybmVkLCBhbmQgYW5cbi8vIG9ic2VydmVyIFwiaGFzIGJlZW4gbm90aWZpZWRcIiBpZiBpdHMgY2FsbGJhY2sgaGFzIHJldHVybmVkLlxuXG52YXIgd3JpdGVDYWxsYmFjayA9IGZ1bmN0aW9uICh3cml0ZSwgcmVmcmVzaCwgY2FsbGJhY2spIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChlcnIsIHJlc3VsdCkge1xuICAgIGlmICghIGVycikge1xuICAgICAgLy8gWFhYIFdlIGRvbid0IGhhdmUgdG8gcnVuIHRoaXMgb24gZXJyb3IsIHJpZ2h0P1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVmcmVzaCgpO1xuICAgICAgfSBjYXRjaCAocmVmcmVzaEVycikge1xuICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICBjYWxsYmFjayhyZWZyZXNoRXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgcmVmcmVzaEVycjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIGNhbGxiYWNrKGVyciwgcmVzdWx0KTtcbiAgICB9IGVsc2UgaWYgKGVycikge1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfTtcbn07XG5cbnZhciBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICByZXR1cm4gTWV0ZW9yLmJpbmRFbnZpcm9ubWVudChjYWxsYmFjaywgXCJNb25nbyB3cml0ZVwiKTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX2luc2VydCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uX25hbWUsIGRvY3VtZW50LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICB2YXIgc2VuZEVycm9yID0gZnVuY3Rpb24gKGUpIHtcbiAgICBpZiAoY2FsbGJhY2spXG4gICAgICByZXR1cm4gY2FsbGJhY2soZSk7XG4gICAgdGhyb3cgZTtcbiAgfTtcblxuICBpZiAoY29sbGVjdGlvbl9uYW1lID09PSBcIl9fX21ldGVvcl9mYWlsdXJlX3Rlc3RfY29sbGVjdGlvblwiKSB7XG4gICAgdmFyIGUgPSBuZXcgRXJyb3IoXCJGYWlsdXJlIHRlc3RcIik7XG4gICAgZS5fZXhwZWN0ZWRCeVRlc3QgPSB0cnVlO1xuICAgIHNlbmRFcnJvcihlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIShMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QoZG9jdW1lbnQpICYmXG4gICAgICAgICFFSlNPTi5faXNDdXN0b21UeXBlKGRvY3VtZW50KSkpIHtcbiAgICBzZW5kRXJyb3IobmV3IEVycm9yKFxuICAgICAgXCJPbmx5IHBsYWluIG9iamVjdHMgbWF5IGJlIGluc2VydGVkIGludG8gTW9uZ29EQlwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIHdyaXRlID0gc2VsZi5fbWF5YmVCZWdpbldyaXRlKCk7XG4gIHZhciByZWZyZXNoID0gZnVuY3Rpb24gKCkge1xuICAgIE1ldGVvci5yZWZyZXNoKHtjb2xsZWN0aW9uOiBjb2xsZWN0aW9uX25hbWUsIGlkOiBkb2N1bWVudC5faWQgfSk7XG4gIH07XG4gIGNhbGxiYWNrID0gYmluZEVudmlyb25tZW50Rm9yV3JpdGUod3JpdGVDYWxsYmFjayh3cml0ZSwgcmVmcmVzaCwgY2FsbGJhY2spKTtcbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uX25hbWUpO1xuICAgIGNvbGxlY3Rpb24uaW5zZXJ0KHJlcGxhY2VUeXBlcyhkb2N1bWVudCwgcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28pLFxuICAgICAgICAgICAgICAgICAgICAgIHtzYWZlOiB0cnVlfSwgY2FsbGJhY2spO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn07XG5cbi8vIENhdXNlIHF1ZXJpZXMgdGhhdCBtYXkgYmUgYWZmZWN0ZWQgYnkgdGhlIHNlbGVjdG9yIHRvIHBvbGwgaW4gdGhpcyB3cml0ZVxuLy8gZmVuY2UuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9yZWZyZXNoID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3Rvcikge1xuICB2YXIgcmVmcmVzaEtleSA9IHtjb2xsZWN0aW9uOiBjb2xsZWN0aW9uTmFtZX07XG4gIC8vIElmIHdlIGtub3cgd2hpY2ggZG9jdW1lbnRzIHdlJ3JlIHJlbW92aW5nLCBkb24ndCBwb2xsIHF1ZXJpZXMgdGhhdCBhcmVcbiAgLy8gc3BlY2lmaWMgdG8gb3RoZXIgZG9jdW1lbnRzLiAoTm90ZSB0aGF0IG11bHRpcGxlIG5vdGlmaWNhdGlvbnMgaGVyZSBzaG91bGRcbiAgLy8gbm90IGNhdXNlIG11bHRpcGxlIHBvbGxzLCBzaW5jZSBhbGwgb3VyIGxpc3RlbmVyIGlzIGRvaW5nIGlzIGVucXVldWVpbmcgYVxuICAvLyBwb2xsLilcbiAgdmFyIHNwZWNpZmljSWRzID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihzZWxlY3Rvcik7XG4gIGlmIChzcGVjaWZpY0lkcykge1xuICAgIF8uZWFjaChzcGVjaWZpY0lkcywgZnVuY3Rpb24gKGlkKSB7XG4gICAgICBNZXRlb3IucmVmcmVzaChfLmV4dGVuZCh7aWQ6IGlkfSwgcmVmcmVzaEtleSkpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIE1ldGVvci5yZWZyZXNoKHJlZnJlc2hLZXkpO1xuICB9XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9yZW1vdmUgPSBmdW5jdGlvbiAoY29sbGVjdGlvbl9uYW1lLCBzZWxlY3RvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKGNvbGxlY3Rpb25fbmFtZSA9PT0gXCJfX19tZXRlb3JfZmFpbHVyZV90ZXN0X2NvbGxlY3Rpb25cIikge1xuICAgIHZhciBlID0gbmV3IEVycm9yKFwiRmFpbHVyZSB0ZXN0XCIpO1xuICAgIGUuX2V4cGVjdGVkQnlUZXN0ID0gdHJ1ZTtcbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIHJldHVybiBjYWxsYmFjayhlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuICB2YXIgd3JpdGUgPSBzZWxmLl9tYXliZUJlZ2luV3JpdGUoKTtcbiAgdmFyIHJlZnJlc2ggPSBmdW5jdGlvbiAoKSB7XG4gICAgc2VsZi5fcmVmcmVzaChjb2xsZWN0aW9uX25hbWUsIHNlbGVjdG9yKTtcbiAgfTtcbiAgY2FsbGJhY2sgPSBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSh3cml0ZUNhbGxiYWNrKHdyaXRlLCByZWZyZXNoLCBjYWxsYmFjaykpO1xuXG4gIHRyeSB7XG4gICAgdmFyIGNvbGxlY3Rpb24gPSBzZWxmLnJhd0NvbGxlY3Rpb24oY29sbGVjdGlvbl9uYW1lKTtcbiAgICB2YXIgd3JhcHBlZENhbGxiYWNrID0gZnVuY3Rpb24oZXJyLCBkcml2ZXJSZXN1bHQpIHtcbiAgICAgIGNhbGxiYWNrKGVyciwgdHJhbnNmb3JtUmVzdWx0KGRyaXZlclJlc3VsdCkubnVtYmVyQWZmZWN0ZWQpO1xuICAgIH07XG4gICAgY29sbGVjdGlvbi5yZW1vdmUocmVwbGFjZVR5cGVzKHNlbGVjdG9yLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgICAgICAgICAgICAgICAgICAgIHtzYWZlOiB0cnVlfSwgd3JhcHBlZENhbGxiYWNrKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgdGhyb3cgZXJyO1xuICB9XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9kcm9wQ29sbGVjdGlvbiA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBNZXRlb3IucmVmcmVzaCh7Y29sbGVjdGlvbjogY29sbGVjdGlvbk5hbWUsIGlkOiBudWxsLFxuICAgICAgICAgICAgICAgICAgICBkcm9wQ29sbGVjdGlvbjogdHJ1ZX0pO1xuICB9O1xuICBjYiA9IGJpbmRFbnZpcm9ubWVudEZvcldyaXRlKHdyaXRlQ2FsbGJhY2sod3JpdGUsIHJlZnJlc2gsIGNiKSk7XG5cbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uTmFtZSk7XG4gICAgY29sbGVjdGlvbi5kcm9wKGNiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgIHRocm93IGU7XG4gIH1cbn07XG5cbi8vIEZvciB0ZXN0aW5nIG9ubHkuICBTbGlnaHRseSBiZXR0ZXIgdGhhbiBgYy5yYXdEYXRhYmFzZSgpLmRyb3BEYXRhYmFzZSgpYFxuLy8gYmVjYXVzZSBpdCBsZXRzIHRoZSB0ZXN0J3MgZmVuY2Ugd2FpdCBmb3IgaXQgdG8gYmUgY29tcGxldGUuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9kcm9wRGF0YWJhc2UgPSBmdW5jdGlvbiAoY2IpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBNZXRlb3IucmVmcmVzaCh7IGRyb3BEYXRhYmFzZTogdHJ1ZSB9KTtcbiAgfTtcbiAgY2IgPSBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSh3cml0ZUNhbGxiYWNrKHdyaXRlLCByZWZyZXNoLCBjYikpO1xuXG4gIHRyeSB7XG4gICAgc2VsZi5kYi5kcm9wRGF0YWJhc2UoY2IpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgdGhyb3cgZTtcbiAgfVxufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fdXBkYXRlID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IsIG1vZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLCBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKCEgY2FsbGJhY2sgJiYgb3B0aW9ucyBpbnN0YW5jZW9mIEZ1bmN0aW9uKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSBudWxsO1xuICB9XG5cbiAgaWYgKGNvbGxlY3Rpb25fbmFtZSA9PT0gXCJfX19tZXRlb3JfZmFpbHVyZV90ZXN0X2NvbGxlY3Rpb25cIikge1xuICAgIHZhciBlID0gbmV3IEVycm9yKFwiRmFpbHVyZSB0ZXN0XCIpO1xuICAgIGUuX2V4cGVjdGVkQnlUZXN0ID0gdHJ1ZTtcbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIHJldHVybiBjYWxsYmFjayhlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuICAvLyBleHBsaWNpdCBzYWZldHkgY2hlY2suIG51bGwgYW5kIHVuZGVmaW5lZCBjYW4gY3Jhc2ggdGhlIG1vbmdvXG4gIC8vIGRyaXZlci4gQWx0aG91Z2ggdGhlIG5vZGUgZHJpdmVyIGFuZCBtaW5pbW9uZ28gZG8gJ3N1cHBvcnQnXG4gIC8vIG5vbi1vYmplY3QgbW9kaWZpZXIgaW4gdGhhdCB0aGV5IGRvbid0IGNyYXNoLCB0aGV5IGFyZSBub3RcbiAgLy8gbWVhbmluZ2Z1bCBvcGVyYXRpb25zIGFuZCBkbyBub3QgZG8gYW55dGhpbmcuIERlZmVuc2l2ZWx5IHRocm93IGFuXG4gIC8vIGVycm9yIGhlcmUuXG4gIGlmICghbW9kIHx8IHR5cGVvZiBtb2QgIT09ICdvYmplY3QnKVxuICAgIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgbW9kaWZpZXIuIE1vZGlmaWVyIG11c3QgYmUgYW4gb2JqZWN0LlwiKTtcblxuICBpZiAoIShMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QobW9kKSAmJlxuICAgICAgICAhRUpTT04uX2lzQ3VzdG9tVHlwZShtb2QpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiT25seSBwbGFpbiBvYmplY3RzIG1heSBiZSB1c2VkIGFzIHJlcGxhY2VtZW50XCIgK1xuICAgICAgICBcIiBkb2N1bWVudHMgaW4gTW9uZ29EQlwiKTtcbiAgfVxuXG4gIGlmICghb3B0aW9ucykgb3B0aW9ucyA9IHt9O1xuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBzZWxmLl9yZWZyZXNoKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IpO1xuICB9O1xuICBjYWxsYmFjayA9IHdyaXRlQ2FsbGJhY2sod3JpdGUsIHJlZnJlc2gsIGNhbGxiYWNrKTtcbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uX25hbWUpO1xuICAgIHZhciBtb25nb09wdHMgPSB7c2FmZTogdHJ1ZX07XG4gICAgLy8gZXhwbGljdGx5IGVudW1lcmF0ZSBvcHRpb25zIHRoYXQgbWluaW1vbmdvIHN1cHBvcnRzXG4gICAgaWYgKG9wdGlvbnMudXBzZXJ0KSBtb25nb09wdHMudXBzZXJ0ID0gdHJ1ZTtcbiAgICBpZiAob3B0aW9ucy5tdWx0aSkgbW9uZ29PcHRzLm11bHRpID0gdHJ1ZTtcbiAgICAvLyBMZXRzIHlvdSBnZXQgYSBtb3JlIG1vcmUgZnVsbCByZXN1bHQgZnJvbSBNb25nb0RCLiBVc2Ugd2l0aCBjYXV0aW9uOlxuICAgIC8vIG1pZ2h0IG5vdCB3b3JrIHdpdGggQy51cHNlcnQgKGFzIG9wcG9zZWQgdG8gQy51cGRhdGUoe3Vwc2VydDp0cnVlfSkgb3JcbiAgICAvLyB3aXRoIHNpbXVsYXRlZCB1cHNlcnQuXG4gICAgaWYgKG9wdGlvbnMuZnVsbFJlc3VsdCkgbW9uZ29PcHRzLmZ1bGxSZXN1bHQgPSB0cnVlO1xuXG4gICAgdmFyIG1vbmdvU2VsZWN0b3IgPSByZXBsYWNlVHlwZXMoc2VsZWN0b3IsIHJlcGxhY2VNZXRlb3JBdG9tV2l0aE1vbmdvKTtcbiAgICB2YXIgbW9uZ29Nb2QgPSByZXBsYWNlVHlwZXMobW9kLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyk7XG5cbiAgICB2YXIgaXNNb2RpZnkgPSBMb2NhbENvbGxlY3Rpb24uX2lzTW9kaWZpY2F0aW9uTW9kKG1vbmdvTW9kKTtcblxuICAgIGlmIChvcHRpb25zLl9mb3JiaWRSZXBsYWNlICYmICFpc01vZGlmeSkge1xuICAgICAgdmFyIGVyciA9IG5ldyBFcnJvcihcIkludmFsaWQgbW9kaWZpZXIuIFJlcGxhY2VtZW50cyBhcmUgZm9yYmlkZGVuLlwiKTtcbiAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBXZSd2ZSBhbHJlYWR5IHJ1biByZXBsYWNlVHlwZXMvcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28gb25cbiAgICAvLyBzZWxlY3RvciBhbmQgbW9kLiAgV2UgYXNzdW1lIGl0IGRvZXNuJ3QgbWF0dGVyLCBhcyBmYXIgYXNcbiAgICAvLyB0aGUgYmVoYXZpb3Igb2YgbW9kaWZpZXJzIGlzIGNvbmNlcm5lZCwgd2hldGhlciBgX21vZGlmeWBcbiAgICAvLyBpcyBydW4gb24gRUpTT04gb3Igb24gbW9uZ28tY29udmVydGVkIEVKU09OLlxuXG4gICAgLy8gUnVuIHRoaXMgY29kZSB1cCBmcm9udCBzbyB0aGF0IGl0IGZhaWxzIGZhc3QgaWYgc29tZW9uZSB1c2VzXG4gICAgLy8gYSBNb25nbyB1cGRhdGUgb3BlcmF0b3Igd2UgZG9uJ3Qgc3VwcG9ydC5cbiAgICBsZXQga25vd25JZDtcbiAgICBpZiAob3B0aW9ucy51cHNlcnQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGxldCBuZXdEb2MgPSBMb2NhbENvbGxlY3Rpb24uX2NyZWF0ZVVwc2VydERvY3VtZW50KHNlbGVjdG9yLCBtb2QpO1xuICAgICAgICBrbm93bklkID0gbmV3RG9jLl9pZDtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICByZXR1cm4gY2FsbGJhY2soZXJyKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy51cHNlcnQgJiZcbiAgICAgICAgISBpc01vZGlmeSAmJlxuICAgICAgICAhIGtub3duSWQgJiZcbiAgICAgICAgb3B0aW9ucy5pbnNlcnRlZElkICYmXG4gICAgICAgICEgKG9wdGlvbnMuaW5zZXJ0ZWRJZCBpbnN0YW5jZW9mIE1vbmdvLk9iamVjdElEICYmXG4gICAgICAgICAgIG9wdGlvbnMuZ2VuZXJhdGVkSWQpKSB7XG4gICAgICAvLyBJbiBjYXNlIG9mIGFuIHVwc2VydCB3aXRoIGEgcmVwbGFjZW1lbnQsIHdoZXJlIHRoZXJlIGlzIG5vIF9pZCBkZWZpbmVkXG4gICAgICAvLyBpbiBlaXRoZXIgdGhlIHF1ZXJ5IG9yIHRoZSByZXBsYWNlbWVudCBkb2MsIG1vbmdvIHdpbGwgZ2VuZXJhdGUgYW4gaWQgaXRzZWxmLlxuICAgICAgLy8gVGhlcmVmb3JlIHdlIG5lZWQgdGhpcyBzcGVjaWFsIHN0cmF0ZWd5IGlmIHdlIHdhbnQgdG8gY29udHJvbCB0aGUgaWQgb3Vyc2VsdmVzLlxuXG4gICAgICAvLyBXZSBkb24ndCBuZWVkIHRvIGRvIHRoaXMgd2hlbjpcbiAgICAgIC8vIC0gVGhpcyBpcyBub3QgYSByZXBsYWNlbWVudCwgc28gd2UgY2FuIGFkZCBhbiBfaWQgdG8gJHNldE9uSW5zZXJ0XG4gICAgICAvLyAtIFRoZSBpZCBpcyBkZWZpbmVkIGJ5IHF1ZXJ5IG9yIG1vZCB3ZSBjYW4ganVzdCBhZGQgaXQgdG8gdGhlIHJlcGxhY2VtZW50IGRvY1xuICAgICAgLy8gLSBUaGUgdXNlciBkaWQgbm90IHNwZWNpZnkgYW55IGlkIHByZWZlcmVuY2UgYW5kIHRoZSBpZCBpcyBhIE1vbmdvIE9iamVjdElkLFxuICAgICAgLy8gICAgIHRoZW4gd2UgY2FuIGp1c3QgbGV0IE1vbmdvIGdlbmVyYXRlIHRoZSBpZFxuXG4gICAgICBzaW11bGF0ZVVwc2VydFdpdGhJbnNlcnRlZElkKFxuICAgICAgICBjb2xsZWN0aW9uLCBtb25nb1NlbGVjdG9yLCBtb25nb01vZCwgb3B0aW9ucyxcbiAgICAgICAgLy8gVGhpcyBjYWxsYmFjayBkb2VzIG5vdCBuZWVkIHRvIGJlIGJpbmRFbnZpcm9ubWVudCdlZCBiZWNhdXNlXG4gICAgICAgIC8vIHNpbXVsYXRlVXBzZXJ0V2l0aEluc2VydGVkSWQoKSB3cmFwcyBpdCBhbmQgdGhlbiBwYXNzZXMgaXQgdGhyb3VnaFxuICAgICAgICAvLyBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZS5cbiAgICAgICAgZnVuY3Rpb24gKGVycm9yLCByZXN1bHQpIHtcbiAgICAgICAgICAvLyBJZiB3ZSBnb3QgaGVyZSB2aWEgYSB1cHNlcnQoKSBjYWxsLCB0aGVuIG9wdGlvbnMuX3JldHVybk9iamVjdCB3aWxsXG4gICAgICAgICAgLy8gYmUgc2V0IGFuZCB3ZSBzaG91bGQgcmV0dXJuIHRoZSB3aG9sZSBvYmplY3QuIE90aGVyd2lzZSwgd2Ugc2hvdWxkXG4gICAgICAgICAgLy8ganVzdCByZXR1cm4gdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2NzIHRvIG1hdGNoIHRoZSBtb25nbyBBUEkuXG4gICAgICAgICAgaWYgKHJlc3VsdCAmJiAhIG9wdGlvbnMuX3JldHVybk9iamVjdCkge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyb3IsIHJlc3VsdC5udW1iZXJBZmZlY3RlZCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVycm9yLCByZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuXG4gICAgICBpZiAob3B0aW9ucy51cHNlcnQgJiYgIWtub3duSWQgJiYgb3B0aW9ucy5pbnNlcnRlZElkICYmIGlzTW9kaWZ5KSB7XG4gICAgICAgIGlmICghbW9uZ29Nb2QuaGFzT3duUHJvcGVydHkoJyRzZXRPbkluc2VydCcpKSB7XG4gICAgICAgICAgbW9uZ29Nb2QuJHNldE9uSW5zZXJ0ID0ge307XG4gICAgICAgIH1cbiAgICAgICAga25vd25JZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDtcbiAgICAgICAgT2JqZWN0LmFzc2lnbihtb25nb01vZC4kc2V0T25JbnNlcnQsIHJlcGxhY2VUeXBlcyh7X2lkOiBvcHRpb25zLmluc2VydGVkSWR9LCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbykpO1xuICAgICAgfVxuXG4gICAgICBjb2xsZWN0aW9uLnVwZGF0ZShcbiAgICAgICAgbW9uZ29TZWxlY3RvciwgbW9uZ29Nb2QsIG1vbmdvT3B0cyxcbiAgICAgICAgYmluZEVudmlyb25tZW50Rm9yV3JpdGUoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICAgICAgaWYgKCEgZXJyKSB7XG4gICAgICAgICAgICB2YXIgbWV0ZW9yUmVzdWx0ID0gdHJhbnNmb3JtUmVzdWx0KHJlc3VsdCk7XG4gICAgICAgICAgICBpZiAobWV0ZW9yUmVzdWx0ICYmIG9wdGlvbnMuX3JldHVybk9iamVjdCkge1xuICAgICAgICAgICAgICAvLyBJZiB0aGlzIHdhcyBhbiB1cHNlcnQoKSBjYWxsLCBhbmQgd2UgZW5kZWQgdXBcbiAgICAgICAgICAgICAgLy8gaW5zZXJ0aW5nIGEgbmV3IGRvYyBhbmQgd2Uga25vdyBpdHMgaWQsIHRoZW5cbiAgICAgICAgICAgICAgLy8gcmV0dXJuIHRoYXQgaWQgYXMgd2VsbC5cbiAgICAgICAgICAgICAgaWYgKG9wdGlvbnMudXBzZXJ0ICYmIG1ldGVvclJlc3VsdC5pbnNlcnRlZElkKSB7XG4gICAgICAgICAgICAgICAgaWYgKGtub3duSWQpIHtcbiAgICAgICAgICAgICAgICAgIG1ldGVvclJlc3VsdC5pbnNlcnRlZElkID0ga25vd25JZDtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG1ldGVvclJlc3VsdC5pbnNlcnRlZElkIGluc3RhbmNlb2YgTW9uZ29EQi5PYmplY3RJRCkge1xuICAgICAgICAgICAgICAgICAgbWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQgPSBuZXcgTW9uZ28uT2JqZWN0SUQobWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQudG9IZXhTdHJpbmcoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgY2FsbGJhY2soZXJyLCBtZXRlb3JSZXN1bHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soZXJyLCBtZXRlb3JSZXN1bHQubnVtYmVyQWZmZWN0ZWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgIHRocm93IGU7XG4gIH1cbn07XG5cbnZhciB0cmFuc2Zvcm1SZXN1bHQgPSBmdW5jdGlvbiAoZHJpdmVyUmVzdWx0KSB7XG4gIHZhciBtZXRlb3JSZXN1bHQgPSB7IG51bWJlckFmZmVjdGVkOiAwIH07XG4gIGlmIChkcml2ZXJSZXN1bHQpIHtcbiAgICB2YXIgbW9uZ29SZXN1bHQgPSBkcml2ZXJSZXN1bHQucmVzdWx0O1xuXG4gICAgLy8gT24gdXBkYXRlcyB3aXRoIHVwc2VydDp0cnVlLCB0aGUgaW5zZXJ0ZWQgdmFsdWVzIGNvbWUgYXMgYSBsaXN0IG9mXG4gICAgLy8gdXBzZXJ0ZWQgdmFsdWVzIC0tIGV2ZW4gd2l0aCBvcHRpb25zLm11bHRpLCB3aGVuIHRoZSB1cHNlcnQgZG9lcyBpbnNlcnQsXG4gICAgLy8gaXQgb25seSBpbnNlcnRzIG9uZSBlbGVtZW50LlxuICAgIGlmIChtb25nb1Jlc3VsdC51cHNlcnRlZCkge1xuICAgICAgbWV0ZW9yUmVzdWx0Lm51bWJlckFmZmVjdGVkICs9IG1vbmdvUmVzdWx0LnVwc2VydGVkLmxlbmd0aDtcblxuICAgICAgaWYgKG1vbmdvUmVzdWx0LnVwc2VydGVkLmxlbmd0aCA9PSAxKSB7XG4gICAgICAgIG1ldGVvclJlc3VsdC5pbnNlcnRlZElkID0gbW9uZ29SZXN1bHQudXBzZXJ0ZWRbMF0uX2lkO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBtZXRlb3JSZXN1bHQubnVtYmVyQWZmZWN0ZWQgPSBtb25nb1Jlc3VsdC5uO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBtZXRlb3JSZXN1bHQ7XG59O1xuXG5cbnZhciBOVU1fT1BUSU1JU1RJQ19UUklFUyA9IDM7XG5cbi8vIGV4cG9zZWQgZm9yIHRlc3Rpbmdcbk1vbmdvQ29ubmVjdGlvbi5faXNDYW5ub3RDaGFuZ2VJZEVycm9yID0gZnVuY3Rpb24gKGVycikge1xuXG4gIC8vIE1vbmdvIDMuMi4qIHJldHVybnMgZXJyb3IgYXMgbmV4dCBPYmplY3Q6XG4gIC8vIHtuYW1lOiBTdHJpbmcsIGNvZGU6IE51bWJlciwgZXJybXNnOiBTdHJpbmd9XG4gIC8vIE9sZGVyIE1vbmdvIHJldHVybnM6XG4gIC8vIHtuYW1lOiBTdHJpbmcsIGNvZGU6IE51bWJlciwgZXJyOiBTdHJpbmd9XG4gIHZhciBlcnJvciA9IGVyci5lcnJtc2cgfHwgZXJyLmVycjtcblxuICAvLyBXZSBkb24ndCB1c2UgdGhlIGVycm9yIGNvZGUgaGVyZVxuICAvLyBiZWNhdXNlIHRoZSBlcnJvciBjb2RlIHdlIG9ic2VydmVkIGl0IHByb2R1Y2luZyAoMTY4MzcpIGFwcGVhcnMgdG8gYmVcbiAgLy8gYSBmYXIgbW9yZSBnZW5lcmljIGVycm9yIGNvZGUgYmFzZWQgb24gZXhhbWluaW5nIHRoZSBzb3VyY2UuXG4gIGlmIChlcnJvci5pbmRleE9mKCdUaGUgX2lkIGZpZWxkIGNhbm5vdCBiZSBjaGFuZ2VkJykgPT09IDBcbiAgICB8fCBlcnJvci5pbmRleE9mKFwidGhlIChpbW11dGFibGUpIGZpZWxkICdfaWQnIHdhcyBmb3VuZCB0byBoYXZlIGJlZW4gYWx0ZXJlZCB0byBfaWRcIikgIT09IC0xKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59O1xuXG52YXIgc2ltdWxhdGVVcHNlcnRXaXRoSW5zZXJ0ZWRJZCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uLCBzZWxlY3RvciwgbW9kLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgLy8gU1RSQVRFR1k6IEZpcnN0IHRyeSBkb2luZyBhbiB1cHNlcnQgd2l0aCBhIGdlbmVyYXRlZCBJRC5cbiAgLy8gSWYgdGhpcyB0aHJvd3MgYW4gZXJyb3IgYWJvdXQgY2hhbmdpbmcgdGhlIElEIG9uIGFuIGV4aXN0aW5nIGRvY3VtZW50XG4gIC8vIHRoZW4gd2l0aG91dCBhZmZlY3RpbmcgdGhlIGRhdGFiYXNlLCB3ZSBrbm93IHdlIHNob3VsZCBwcm9iYWJseSB0cnlcbiAgLy8gYW4gdXBkYXRlIHdpdGhvdXQgdGhlIGdlbmVyYXRlZCBJRC4gSWYgaXQgYWZmZWN0ZWQgMCBkb2N1bWVudHMsXG4gIC8vIHRoZW4gd2l0aG91dCBhZmZlY3RpbmcgdGhlIGRhdGFiYXNlLCB3ZSB0aGUgZG9jdW1lbnQgdGhhdCBmaXJzdFxuICAvLyBnYXZlIHRoZSBlcnJvciBpcyBwcm9iYWJseSByZW1vdmVkIGFuZCB3ZSBuZWVkIHRvIHRyeSBhbiBpbnNlcnQgYWdhaW5cbiAgLy8gV2UgZ28gYmFjayB0byBzdGVwIG9uZSBhbmQgcmVwZWF0LlxuICAvLyBMaWtlIGFsbCBcIm9wdGltaXN0aWMgd3JpdGVcIiBzY2hlbWVzLCB3ZSByZWx5IG9uIHRoZSBmYWN0IHRoYXQgaXQnc1xuICAvLyB1bmxpa2VseSBvdXIgd3JpdGVzIHdpbGwgY29udGludWUgdG8gYmUgaW50ZXJmZXJlZCB3aXRoIHVuZGVyIG5vcm1hbFxuICAvLyBjaXJjdW1zdGFuY2VzICh0aG91Z2ggc3VmZmljaWVudGx5IGhlYXZ5IGNvbnRlbnRpb24gd2l0aCB3cml0ZXJzXG4gIC8vIGRpc2FncmVlaW5nIG9uIHRoZSBleGlzdGVuY2Ugb2YgYW4gb2JqZWN0IHdpbGwgY2F1c2Ugd3JpdGVzIHRvIGZhaWxcbiAgLy8gaW4gdGhlb3J5KS5cblxuICB2YXIgaW5zZXJ0ZWRJZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDsgLy8gbXVzdCBleGlzdFxuICB2YXIgbW9uZ29PcHRzRm9yVXBkYXRlID0ge1xuICAgIHNhZmU6IHRydWUsXG4gICAgbXVsdGk6IG9wdGlvbnMubXVsdGlcbiAgfTtcbiAgdmFyIG1vbmdvT3B0c0Zvckluc2VydCA9IHtcbiAgICBzYWZlOiB0cnVlLFxuICAgIHVwc2VydDogdHJ1ZVxuICB9O1xuXG4gIHZhciByZXBsYWNlbWVudFdpdGhJZCA9IE9iamVjdC5hc3NpZ24oXG4gICAgcmVwbGFjZVR5cGVzKHtfaWQ6IGluc2VydGVkSWR9LCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgbW9kKTtcblxuICB2YXIgdHJpZXMgPSBOVU1fT1BUSU1JU1RJQ19UUklFUztcblxuICB2YXIgZG9VcGRhdGUgPSBmdW5jdGlvbiAoKSB7XG4gICAgdHJpZXMtLTtcbiAgICBpZiAoISB0cmllcykge1xuICAgICAgY2FsbGJhY2sobmV3IEVycm9yKFwiVXBzZXJ0IGZhaWxlZCBhZnRlciBcIiArIE5VTV9PUFRJTUlTVElDX1RSSUVTICsgXCIgdHJpZXMuXCIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29sbGVjdGlvbi51cGRhdGUoc2VsZWN0b3IsIG1vZCwgbW9uZ29PcHRzRm9yVXBkYXRlLFxuICAgICAgICAgICAgICAgICAgICAgICAgYmluZEVudmlyb25tZW50Rm9yV3JpdGUoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHJlc3VsdCAmJiByZXN1bHQucmVzdWx0Lm4gIT0gMCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bWJlckFmZmVjdGVkOiByZXN1bHQucmVzdWx0Lm5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkb0NvbmRpdGlvbmFsSW5zZXJ0KCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICB9XG4gIH07XG5cbiAgdmFyIGRvQ29uZGl0aW9uYWxJbnNlcnQgPSBmdW5jdGlvbiAoKSB7XG4gICAgY29sbGVjdGlvbi51cGRhdGUoc2VsZWN0b3IsIHJlcGxhY2VtZW50V2l0aElkLCBtb25nb09wdHNGb3JJbnNlcnQsXG4gICAgICAgICAgICAgICAgICAgICAgYmluZEVudmlyb25tZW50Rm9yV3JpdGUoZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGZpZ3VyZSBvdXQgaWYgdGhpcyBpcyBhXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFwiY2Fubm90IGNoYW5nZSBfaWQgb2YgZG9jdW1lbnRcIiBlcnJvciwgYW5kXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGlmIHNvLCB0cnkgZG9VcGRhdGUoKSBhZ2FpbiwgdXAgdG8gMyB0aW1lcy5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKE1vbmdvQ29ubmVjdGlvbi5faXNDYW5ub3RDaGFuZ2VJZEVycm9yKGVycikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkb1VwZGF0ZSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBudW1iZXJBZmZlY3RlZDogcmVzdWx0LnJlc3VsdC51cHNlcnRlZC5sZW5ndGgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaW5zZXJ0ZWRJZDogaW5zZXJ0ZWRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICB9O1xuXG4gIGRvVXBkYXRlKCk7XG59O1xuXG5fLmVhY2goW1wiaW5zZXJ0XCIsIFwidXBkYXRlXCIsIFwicmVtb3ZlXCIsIFwiZHJvcENvbGxlY3Rpb25cIiwgXCJkcm9wRGF0YWJhc2VcIl0sIGZ1bmN0aW9uIChtZXRob2QpIHtcbiAgTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZVttZXRob2RdID0gZnVuY3Rpb24gKC8qIGFyZ3VtZW50cyAqLykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gTWV0ZW9yLndyYXBBc3luYyhzZWxmW1wiX1wiICsgbWV0aG9kXSkuYXBwbHkoc2VsZiwgYXJndW1lbnRzKTtcbiAgfTtcbn0pO1xuXG4vLyBYWFggTW9uZ29Db25uZWN0aW9uLnVwc2VydCgpIGRvZXMgbm90IHJldHVybiB0aGUgaWQgb2YgdGhlIGluc2VydGVkIGRvY3VtZW50XG4vLyB1bmxlc3MgeW91IHNldCBpdCBleHBsaWNpdGx5IGluIHRoZSBzZWxlY3RvciBvciBtb2RpZmllciAoYXMgYSByZXBsYWNlbWVudFxuLy8gZG9jKS5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUudXBzZXJ0ID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3RvciwgbW9kLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBpZiAodHlwZW9mIG9wdGlvbnMgPT09IFwiZnVuY3Rpb25cIiAmJiAhIGNhbGxiYWNrKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIHJldHVybiBzZWxmLnVwZGF0ZShjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIG1vZCxcbiAgICAgICAgICAgICAgICAgICAgIF8uZXh0ZW5kKHt9LCBvcHRpb25zLCB7XG4gICAgICAgICAgICAgICAgICAgICAgIHVwc2VydDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICAgX3JldHVybk9iamVjdDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgfSksIGNhbGxiYWNrKTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuZmluZCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAxKVxuICAgIHNlbGVjdG9yID0ge307XG5cbiAgcmV0dXJuIG5ldyBDdXJzb3IoXG4gICAgc2VsZiwgbmV3IEN1cnNvckRlc2NyaXB0aW9uKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3Rvciwgb3B0aW9ucykpO1xufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5maW5kT25lID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9ucykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAxKVxuICAgIHNlbGVjdG9yID0ge307XG5cbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gIG9wdGlvbnMubGltaXQgPSAxO1xuICByZXR1cm4gc2VsZi5maW5kKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IsIG9wdGlvbnMpLmZldGNoKClbMF07XG59O1xuXG4vLyBXZSdsbCBhY3R1YWxseSBkZXNpZ24gYW4gaW5kZXggQVBJIGxhdGVyLiBGb3Igbm93LCB3ZSBqdXN0IHBhc3MgdGhyb3VnaCB0b1xuLy8gTW9uZ28ncywgYnV0IG1ha2UgaXQgc3luY2hyb25vdXMuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9lbnN1cmVJbmRleCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgaW5kZXgsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICAvLyBXZSBleHBlY3QgdGhpcyBmdW5jdGlvbiB0byBiZSBjYWxsZWQgYXQgc3RhcnR1cCwgbm90IGZyb20gd2l0aGluIGEgbWV0aG9kLFxuICAvLyBzbyB3ZSBkb24ndCBpbnRlcmFjdCB3aXRoIHRoZSB3cml0ZSBmZW5jZS5cbiAgdmFyIGNvbGxlY3Rpb24gPSBzZWxmLnJhd0NvbGxlY3Rpb24oY29sbGVjdGlvbk5hbWUpO1xuICB2YXIgZnV0dXJlID0gbmV3IEZ1dHVyZTtcbiAgdmFyIGluZGV4TmFtZSA9IGNvbGxlY3Rpb24uZW5zdXJlSW5kZXgoaW5kZXgsIG9wdGlvbnMsIGZ1dHVyZS5yZXNvbHZlcigpKTtcbiAgZnV0dXJlLndhaXQoKTtcbn07XG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9kcm9wSW5kZXggPSBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUsIGluZGV4KSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICAvLyBUaGlzIGZ1bmN0aW9uIGlzIG9ubHkgdXNlZCBieSB0ZXN0IGNvZGUsIG5vdCB3aXRoaW4gYSBtZXRob2QsIHNvIHdlIGRvbid0XG4gIC8vIGludGVyYWN0IHdpdGggdGhlIHdyaXRlIGZlbmNlLlxuICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uTmFtZSk7XG4gIHZhciBmdXR1cmUgPSBuZXcgRnV0dXJlO1xuICB2YXIgaW5kZXhOYW1lID0gY29sbGVjdGlvbi5kcm9wSW5kZXgoaW5kZXgsIGZ1dHVyZS5yZXNvbHZlcigpKTtcbiAgZnV0dXJlLndhaXQoKTtcbn07XG5cbi8vIENVUlNPUlNcblxuLy8gVGhlcmUgYXJlIHNldmVyYWwgY2xhc3NlcyB3aGljaCByZWxhdGUgdG8gY3Vyc29yczpcbi8vXG4vLyBDdXJzb3JEZXNjcmlwdGlvbiByZXByZXNlbnRzIHRoZSBhcmd1bWVudHMgdXNlZCB0byBjb25zdHJ1Y3QgYSBjdXJzb3I6XG4vLyBjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIGFuZCAoZmluZCkgb3B0aW9ucy4gIEJlY2F1c2UgaXQgaXMgdXNlZCBhcyBhIGtleVxuLy8gZm9yIGN1cnNvciBkZS1kdXAsIGV2ZXJ5dGhpbmcgaW4gaXQgc2hvdWxkIGVpdGhlciBiZSBKU09OLXN0cmluZ2lmaWFibGUgb3Jcbi8vIG5vdCBhZmZlY3Qgb2JzZXJ2ZUNoYW5nZXMgb3V0cHV0IChlZywgb3B0aW9ucy50cmFuc2Zvcm0gZnVuY3Rpb25zIGFyZSBub3Rcbi8vIHN0cmluZ2lmaWFibGUgYnV0IGRvIG5vdCBhZmZlY3Qgb2JzZXJ2ZUNoYW5nZXMpLlxuLy9cbi8vIFN5bmNocm9ub3VzQ3Vyc29yIGlzIGEgd3JhcHBlciBhcm91bmQgYSBNb25nb0RCIGN1cnNvclxuLy8gd2hpY2ggaW5jbHVkZXMgZnVsbHktc3luY2hyb25vdXMgdmVyc2lvbnMgb2YgZm9yRWFjaCwgZXRjLlxuLy9cbi8vIEN1cnNvciBpcyB0aGUgY3Vyc29yIG9iamVjdCByZXR1cm5lZCBmcm9tIGZpbmQoKSwgd2hpY2ggaW1wbGVtZW50cyB0aGVcbi8vIGRvY3VtZW50ZWQgTW9uZ28uQ29sbGVjdGlvbiBjdXJzb3IgQVBJLiAgSXQgd3JhcHMgYSBDdXJzb3JEZXNjcmlwdGlvbiBhbmQgYVxuLy8gU3luY2hyb25vdXNDdXJzb3IgKGxhemlseTogaXQgZG9lc24ndCBjb250YWN0IE1vbmdvIHVudGlsIHlvdSBjYWxsIGEgbWV0aG9kXG4vLyBsaWtlIGZldGNoIG9yIGZvckVhY2ggb24gaXQpLlxuLy9cbi8vIE9ic2VydmVIYW5kbGUgaXMgdGhlIFwib2JzZXJ2ZSBoYW5kbGVcIiByZXR1cm5lZCBmcm9tIG9ic2VydmVDaGFuZ2VzLiBJdCBoYXMgYVxuLy8gcmVmZXJlbmNlIHRvIGFuIE9ic2VydmVNdWx0aXBsZXhlci5cbi8vXG4vLyBPYnNlcnZlTXVsdGlwbGV4ZXIgYWxsb3dzIG11bHRpcGxlIGlkZW50aWNhbCBPYnNlcnZlSGFuZGxlcyB0byBiZSBkcml2ZW4gYnkgYVxuLy8gc2luZ2xlIG9ic2VydmUgZHJpdmVyLlxuLy9cbi8vIFRoZXJlIGFyZSB0d28gXCJvYnNlcnZlIGRyaXZlcnNcIiB3aGljaCBkcml2ZSBPYnNlcnZlTXVsdGlwbGV4ZXJzOlxuLy8gICAtIFBvbGxpbmdPYnNlcnZlRHJpdmVyIGNhY2hlcyB0aGUgcmVzdWx0cyBvZiBhIHF1ZXJ5IGFuZCByZXJ1bnMgaXQgd2hlblxuLy8gICAgIG5lY2Vzc2FyeS5cbi8vICAgLSBPcGxvZ09ic2VydmVEcml2ZXIgZm9sbG93cyB0aGUgTW9uZ28gb3BlcmF0aW9uIGxvZyB0byBkaXJlY3RseSBvYnNlcnZlXG4vLyAgICAgZGF0YWJhc2UgY2hhbmdlcy5cbi8vIEJvdGggaW1wbGVtZW50YXRpb25zIGZvbGxvdyB0aGUgc2FtZSBzaW1wbGUgaW50ZXJmYWNlOiB3aGVuIHlvdSBjcmVhdGUgdGhlbSxcbi8vIHRoZXkgc3RhcnQgc2VuZGluZyBvYnNlcnZlQ2hhbmdlcyBjYWxsYmFja3MgKGFuZCBhIHJlYWR5KCkgaW52b2NhdGlvbikgdG9cbi8vIHRoZWlyIE9ic2VydmVNdWx0aXBsZXhlciwgYW5kIHlvdSBzdG9wIHRoZW0gYnkgY2FsbGluZyB0aGVpciBzdG9wKCkgbWV0aG9kLlxuXG5DdXJzb3JEZXNjcmlwdGlvbiA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgc2VsZWN0b3IsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLmNvbGxlY3Rpb25OYW1lID0gY29sbGVjdGlvbk5hbWU7XG4gIHNlbGYuc2VsZWN0b3IgPSBNb25nby5Db2xsZWN0aW9uLl9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuICBzZWxmLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xufTtcblxuQ3Vyc29yID0gZnVuY3Rpb24gKG1vbmdvLCBjdXJzb3JEZXNjcmlwdGlvbikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgc2VsZi5fbW9uZ28gPSBtb25nbztcbiAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24gPSBjdXJzb3JEZXNjcmlwdGlvbjtcbiAgc2VsZi5fc3luY2hyb25vdXNDdXJzb3IgPSBudWxsO1xufTtcblxuXy5lYWNoKFsnZm9yRWFjaCcsICdtYXAnLCAnZmV0Y2gnLCAnY291bnQnLCBTeW1ib2wuaXRlcmF0b3JdLCBmdW5jdGlvbiAobWV0aG9kKSB7XG4gIEN1cnNvci5wcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBZb3UgY2FuIG9ubHkgb2JzZXJ2ZSBhIHRhaWxhYmxlIGN1cnNvci5cbiAgICBpZiAoc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50YWlsYWJsZSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBjYWxsIFwiICsgbWV0aG9kICsgXCIgb24gYSB0YWlsYWJsZSBjdXJzb3JcIik7XG5cbiAgICBpZiAoIXNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yKSB7XG4gICAgICBzZWxmLl9zeW5jaHJvbm91c0N1cnNvciA9IHNlbGYuX21vbmdvLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihcbiAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIHtcbiAgICAgICAgICAvLyBNYWtlIHN1cmUgdGhhdCB0aGUgXCJzZWxmXCIgYXJndW1lbnQgdG8gZm9yRWFjaC9tYXAgY2FsbGJhY2tzIGlzIHRoZVxuICAgICAgICAgIC8vIEN1cnNvciwgbm90IHRoZSBTeW5jaHJvbm91c0N1cnNvci5cbiAgICAgICAgICBzZWxmRm9ySXRlcmF0aW9uOiBzZWxmLFxuICAgICAgICAgIHVzZVRyYW5zZm9ybTogdHJ1ZVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gc2VsZi5fc3luY2hyb25vdXNDdXJzb3JbbWV0aG9kXS5hcHBseShcbiAgICAgIHNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yLCBhcmd1bWVudHMpO1xuICB9O1xufSk7XG5cbi8vIFNpbmNlIHdlIGRvbid0IGFjdHVhbGx5IGhhdmUgYSBcIm5leHRPYmplY3RcIiBpbnRlcmZhY2UsIHRoZXJlJ3MgcmVhbGx5IG5vXG4vLyByZWFzb24gdG8gaGF2ZSBhIFwicmV3aW5kXCIgaW50ZXJmYWNlLiAgQWxsIGl0IGRpZCB3YXMgbWFrZSBtdWx0aXBsZSBjYWxsc1xuLy8gdG8gZmV0Y2gvbWFwL2ZvckVhY2ggcmV0dXJuIG5vdGhpbmcgdGhlIHNlY29uZCB0aW1lLlxuLy8gWFhYIENPTVBBVCBXSVRIIDAuOC4xXG5DdXJzb3IucHJvdG90eXBlLnJld2luZCA9IGZ1bmN0aW9uICgpIHtcbn07XG5cbkN1cnNvci5wcm90b3R5cGUuZ2V0VHJhbnNmb3JtID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50cmFuc2Zvcm07XG59O1xuXG4vLyBXaGVuIHlvdSBjYWxsIE1ldGVvci5wdWJsaXNoKCkgd2l0aCBhIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBhIEN1cnNvciwgd2UgbmVlZFxuLy8gdG8gdHJhbnNtdXRlIGl0IGludG8gdGhlIGVxdWl2YWxlbnQgc3Vic2NyaXB0aW9uLiAgVGhpcyBpcyB0aGUgZnVuY3Rpb24gdGhhdFxuLy8gZG9lcyB0aGF0LlxuXG5DdXJzb3IucHJvdG90eXBlLl9wdWJsaXNoQ3Vyc29yID0gZnVuY3Rpb24gKHN1Yikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHZhciBjb2xsZWN0aW9uID0gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWU7XG4gIHJldHVybiBNb25nby5Db2xsZWN0aW9uLl9wdWJsaXNoQ3Vyc29yKHNlbGYsIHN1YiwgY29sbGVjdGlvbik7XG59O1xuXG4vLyBVc2VkIHRvIGd1YXJhbnRlZSB0aGF0IHB1Ymxpc2ggZnVuY3Rpb25zIHJldHVybiBhdCBtb3N0IG9uZSBjdXJzb3IgcGVyXG4vLyBjb2xsZWN0aW9uLiBQcml2YXRlLCBiZWNhdXNlIHdlIG1pZ2h0IGxhdGVyIGhhdmUgY3Vyc29ycyB0aGF0IGluY2x1ZGVcbi8vIGRvY3VtZW50cyBmcm9tIG11bHRpcGxlIGNvbGxlY3Rpb25zIHNvbWVob3cuXG5DdXJzb3IucHJvdG90eXBlLl9nZXRDb2xsZWN0aW9uTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICByZXR1cm4gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWU7XG59O1xuXG5DdXJzb3IucHJvdG90eXBlLm9ic2VydmUgPSBmdW5jdGlvbiAoY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyhzZWxmLCBjYWxsYmFja3MpO1xufTtcblxuQ3Vyc29yLnByb3RvdHlwZS5vYnNlcnZlQ2hhbmdlcyA9IGZ1bmN0aW9uIChjYWxsYmFja3MpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICB2YXIgbWV0aG9kcyA9IFtcbiAgICAnYWRkZWRBdCcsXG4gICAgJ2FkZGVkJyxcbiAgICAnY2hhbmdlZEF0JyxcbiAgICAnY2hhbmdlZCcsXG4gICAgJ3JlbW92ZWRBdCcsXG4gICAgJ3JlbW92ZWQnLFxuICAgICdtb3ZlZFRvJ1xuICBdO1xuICB2YXIgb3JkZXJlZCA9IExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkKGNhbGxiYWNrcyk7XG5cbiAgLy8gWFhYOiBDYW4gd2UgZmluZCBvdXQgaWYgY2FsbGJhY2tzIGFyZSBmcm9tIG9ic2VydmU/XG4gIHZhciBleGNlcHRpb25OYW1lID0gJyBvYnNlcnZlL29ic2VydmVDaGFuZ2VzIGNhbGxiYWNrJztcbiAgbWV0aG9kcy5mb3JFYWNoKGZ1bmN0aW9uIChtZXRob2QpIHtcbiAgICBpZiAoY2FsbGJhY2tzW21ldGhvZF0gJiYgdHlwZW9mIGNhbGxiYWNrc1ttZXRob2RdID09IFwiZnVuY3Rpb25cIikge1xuICAgICAgY2FsbGJhY2tzW21ldGhvZF0gPSBNZXRlb3IuYmluZEVudmlyb25tZW50KGNhbGxiYWNrc1ttZXRob2RdLCBtZXRob2QgKyBleGNlcHRpb25OYW1lKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiBzZWxmLl9tb25nby5fb2JzZXJ2ZUNoYW5nZXMoXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIG9yZGVyZWQsIGNhbGxiYWNrcyk7XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvciA9IGZ1bmN0aW9uKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IF8ucGljayhvcHRpb25zIHx8IHt9LCAnc2VsZkZvckl0ZXJhdGlvbicsICd1c2VUcmFuc2Zvcm0nKTtcblxuICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSk7XG4gIHZhciBjdXJzb3JPcHRpb25zID0gY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucztcbiAgdmFyIG1vbmdvT3B0aW9ucyA9IHtcbiAgICBzb3J0OiBjdXJzb3JPcHRpb25zLnNvcnQsXG4gICAgbGltaXQ6IGN1cnNvck9wdGlvbnMubGltaXQsXG4gICAgc2tpcDogY3Vyc29yT3B0aW9ucy5za2lwXG4gIH07XG5cbiAgLy8gRG8gd2Ugd2FudCBhIHRhaWxhYmxlIGN1cnNvciAod2hpY2ggb25seSB3b3JrcyBvbiBjYXBwZWQgY29sbGVjdGlvbnMpP1xuICBpZiAoY3Vyc29yT3B0aW9ucy50YWlsYWJsZSkge1xuICAgIC8vIFdlIHdhbnQgYSB0YWlsYWJsZSBjdXJzb3IuLi5cbiAgICBtb25nb09wdGlvbnMudGFpbGFibGUgPSB0cnVlO1xuICAgIC8vIC4uLiBhbmQgZm9yIHRoZSBzZXJ2ZXIgdG8gd2FpdCBhIGJpdCBpZiBhbnkgZ2V0TW9yZSBoYXMgbm8gZGF0YSAocmF0aGVyXG4gICAgLy8gdGhhbiBtYWtpbmcgdXMgcHV0IHRoZSByZWxldmFudCBzbGVlcHMgaW4gdGhlIGNsaWVudCkuLi5cbiAgICBtb25nb09wdGlvbnMuYXdhaXRkYXRhID0gdHJ1ZTtcbiAgICAvLyAuLi4gYW5kIHRvIGtlZXAgcXVlcnlpbmcgdGhlIHNlcnZlciBpbmRlZmluaXRlbHkgcmF0aGVyIHRoYW4ganVzdCA1IHRpbWVzXG4gICAgLy8gaWYgdGhlcmUncyBubyBtb3JlIGRhdGEuXG4gICAgbW9uZ29PcHRpb25zLm51bWJlck9mUmV0cmllcyA9IC0xO1xuICAgIC8vIEFuZCBpZiB0aGlzIGlzIG9uIHRoZSBvcGxvZyBjb2xsZWN0aW9uIGFuZCB0aGUgY3Vyc29yIHNwZWNpZmllcyBhICd0cycsXG4gICAgLy8gdGhlbiBzZXQgdGhlIHVuZG9jdW1lbnRlZCBvcGxvZyByZXBsYXkgZmxhZywgd2hpY2ggZG9lcyBhIHNwZWNpYWwgc2NhbiB0b1xuICAgIC8vIGZpbmQgdGhlIGZpcnN0IGRvY3VtZW50IChpbnN0ZWFkIG9mIGNyZWF0aW5nIGFuIGluZGV4IG9uIHRzKS4gVGhpcyBpcyBhXG4gICAgLy8gdmVyeSBoYXJkLWNvZGVkIE1vbmdvIGZsYWcgd2hpY2ggb25seSB3b3JrcyBvbiB0aGUgb3Bsb2cgY29sbGVjdGlvbiBhbmRcbiAgICAvLyBvbmx5IHdvcmtzIHdpdGggdGhlIHRzIGZpZWxkLlxuICAgIGlmIChjdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSA9PT0gT1BMT0dfQ09MTEVDVElPTiAmJlxuICAgICAgICBjdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3Rvci50cykge1xuICAgICAgbW9uZ29PcHRpb25zLm9wbG9nUmVwbGF5ID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICB2YXIgZGJDdXJzb3IgPSBjb2xsZWN0aW9uLmZpbmQoXG4gICAgcmVwbGFjZVR5cGVzKGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgY3Vyc29yT3B0aW9ucy5maWVsZHMsIG1vbmdvT3B0aW9ucyk7XG5cbiAgaWYgKHR5cGVvZiBjdXJzb3JPcHRpb25zLm1heFRpbWVNcyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBkYkN1cnNvciA9IGRiQ3Vyc29yLm1heFRpbWVNUyhjdXJzb3JPcHRpb25zLm1heFRpbWVNcyk7XG4gIH1cbiAgaWYgKHR5cGVvZiBjdXJzb3JPcHRpb25zLmhpbnQgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgZGJDdXJzb3IgPSBkYkN1cnNvci5oaW50KGN1cnNvck9wdGlvbnMuaGludCk7XG4gIH1cblxuICByZXR1cm4gbmV3IFN5bmNocm9ub3VzQ3Vyc29yKGRiQ3Vyc29yLCBjdXJzb3JEZXNjcmlwdGlvbiwgb3B0aW9ucyk7XG59O1xuXG52YXIgU3luY2hyb25vdXNDdXJzb3IgPSBmdW5jdGlvbiAoZGJDdXJzb3IsIGN1cnNvckRlc2NyaXB0aW9uLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IF8ucGljayhvcHRpb25zIHx8IHt9LCAnc2VsZkZvckl0ZXJhdGlvbicsICd1c2VUcmFuc2Zvcm0nKTtcblxuICBzZWxmLl9kYkN1cnNvciA9IGRiQ3Vyc29yO1xuICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiA9IGN1cnNvckRlc2NyaXB0aW9uO1xuICAvLyBUaGUgXCJzZWxmXCIgYXJndW1lbnQgcGFzc2VkIHRvIGZvckVhY2gvbWFwIGNhbGxiYWNrcy4gSWYgd2UncmUgd3JhcHBlZFxuICAvLyBpbnNpZGUgYSB1c2VyLXZpc2libGUgQ3Vyc29yLCB3ZSB3YW50IHRvIHByb3ZpZGUgdGhlIG91dGVyIGN1cnNvciFcbiAgc2VsZi5fc2VsZkZvckl0ZXJhdGlvbiA9IG9wdGlvbnMuc2VsZkZvckl0ZXJhdGlvbiB8fCBzZWxmO1xuICBpZiAob3B0aW9ucy51c2VUcmFuc2Zvcm0gJiYgY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50cmFuc2Zvcm0pIHtcbiAgICBzZWxmLl90cmFuc2Zvcm0gPSBMb2NhbENvbGxlY3Rpb24ud3JhcFRyYW5zZm9ybShcbiAgICAgIGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMudHJhbnNmb3JtKTtcbiAgfSBlbHNlIHtcbiAgICBzZWxmLl90cmFuc2Zvcm0gPSBudWxsO1xuICB9XG5cbiAgLy8gTmVlZCB0byBzcGVjaWZ5IHRoYXQgdGhlIGNhbGxiYWNrIGlzIHRoZSBmaXJzdCBhcmd1bWVudCB0byBuZXh0T2JqZWN0LFxuICAvLyBzaW5jZSBvdGhlcndpc2Ugd2hlbiB3ZSB0cnkgdG8gY2FsbCBpdCB3aXRoIG5vIGFyZ3MgdGhlIGRyaXZlciB3aWxsXG4gIC8vIGludGVycHJldCBcInVuZGVmaW5lZFwiIGZpcnN0IGFyZyBhcyBhbiBvcHRpb25zIGhhc2ggYW5kIGNyYXNoLlxuICBzZWxmLl9zeW5jaHJvbm91c05leHRPYmplY3QgPSBGdXR1cmUud3JhcChcbiAgICBkYkN1cnNvci5uZXh0T2JqZWN0LmJpbmQoZGJDdXJzb3IpLCAwKTtcbiAgc2VsZi5fc3luY2hyb25vdXNDb3VudCA9IEZ1dHVyZS53cmFwKGRiQ3Vyc29yLmNvdW50LmJpbmQoZGJDdXJzb3IpKTtcbiAgc2VsZi5fdmlzaXRlZElkcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xufTtcblxuXy5leHRlbmQoU3luY2hyb25vdXNDdXJzb3IucHJvdG90eXBlLCB7XG4gIF9uZXh0T2JqZWN0OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciBkb2MgPSBzZWxmLl9zeW5jaHJvbm91c05leHRPYmplY3QoKS53YWl0KCk7XG5cbiAgICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDtcbiAgICAgIGRvYyA9IHJlcGxhY2VUeXBlcyhkb2MsIHJlcGxhY2VNb25nb0F0b21XaXRoTWV0ZW9yKTtcblxuICAgICAgaWYgKCFzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnRhaWxhYmxlICYmIF8uaGFzKGRvYywgJ19pZCcpKSB7XG4gICAgICAgIC8vIERpZCBNb25nbyBnaXZlIHVzIGR1cGxpY2F0ZSBkb2N1bWVudHMgaW4gdGhlIHNhbWUgY3Vyc29yPyBJZiBzbyxcbiAgICAgICAgLy8gaWdub3JlIHRoaXMgb25lLiAoRG8gdGhpcyBiZWZvcmUgdGhlIHRyYW5zZm9ybSwgc2luY2UgdHJhbnNmb3JtIG1pZ2h0XG4gICAgICAgIC8vIHJldHVybiBzb21lIHVucmVsYXRlZCB2YWx1ZS4pIFdlIGRvbid0IGRvIHRoaXMgZm9yIHRhaWxhYmxlIGN1cnNvcnMsXG4gICAgICAgIC8vIGJlY2F1c2Ugd2Ugd2FudCB0byBtYWludGFpbiBPKDEpIG1lbW9yeSB1c2FnZS4gQW5kIGlmIHRoZXJlIGlzbid0IF9pZFxuICAgICAgICAvLyBmb3Igc29tZSByZWFzb24gKG1heWJlIGl0J3MgdGhlIG9wbG9nKSwgdGhlbiB3ZSBkb24ndCBkbyB0aGlzIGVpdGhlci5cbiAgICAgICAgLy8gKEJlIGNhcmVmdWwgdG8gZG8gdGhpcyBmb3IgZmFsc2V5IGJ1dCBleGlzdGluZyBfaWQsIHRob3VnaC4pXG4gICAgICAgIGlmIChzZWxmLl92aXNpdGVkSWRzLmhhcyhkb2MuX2lkKSkgY29udGludWU7XG4gICAgICAgIHNlbGYuX3Zpc2l0ZWRJZHMuc2V0KGRvYy5faWQsIHRydWUpO1xuICAgICAgfVxuXG4gICAgICBpZiAoc2VsZi5fdHJhbnNmb3JtKVxuICAgICAgICBkb2MgPSBzZWxmLl90cmFuc2Zvcm0oZG9jKTtcblxuICAgICAgcmV0dXJuIGRvYztcbiAgICB9XG4gIH0sXG5cbiAgZm9yRWFjaDogZnVuY3Rpb24gKGNhbGxiYWNrLCB0aGlzQXJnKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgLy8gR2V0IGJhY2sgdG8gdGhlIGJlZ2lubmluZy5cbiAgICBzZWxmLl9yZXdpbmQoKTtcblxuICAgIC8vIFdlIGltcGxlbWVudCB0aGUgbG9vcCBvdXJzZWxmIGluc3RlYWQgb2YgdXNpbmcgc2VsZi5fZGJDdXJzb3IuZWFjaCxcbiAgICAvLyBiZWNhdXNlIFwiZWFjaFwiIHdpbGwgY2FsbCBpdHMgY2FsbGJhY2sgb3V0c2lkZSBvZiBhIGZpYmVyIHdoaWNoIG1ha2VzIGl0XG4gICAgLy8gbXVjaCBtb3JlIGNvbXBsZXggdG8gbWFrZSB0aGlzIGZ1bmN0aW9uIHN5bmNocm9ub3VzLlxuICAgIHZhciBpbmRleCA9IDA7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciBkb2MgPSBzZWxmLl9uZXh0T2JqZWN0KCk7XG4gICAgICBpZiAoIWRvYykgcmV0dXJuO1xuICAgICAgY2FsbGJhY2suY2FsbCh0aGlzQXJnLCBkb2MsIGluZGV4KyssIHNlbGYuX3NlbGZGb3JJdGVyYXRpb24pO1xuICAgIH1cbiAgfSxcblxuICAvLyBYWFggQWxsb3cgb3ZlcmxhcHBpbmcgY2FsbGJhY2sgZXhlY3V0aW9ucyBpZiBjYWxsYmFjayB5aWVsZHMuXG4gIG1hcDogZnVuY3Rpb24gKGNhbGxiYWNrLCB0aGlzQXJnKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciByZXMgPSBbXTtcbiAgICBzZWxmLmZvckVhY2goZnVuY3Rpb24gKGRvYywgaW5kZXgpIHtcbiAgICAgIHJlcy5wdXNoKGNhbGxiYWNrLmNhbGwodGhpc0FyZywgZG9jLCBpbmRleCwgc2VsZi5fc2VsZkZvckl0ZXJhdGlvbikpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXM7XG4gIH0sXG5cbiAgX3Jld2luZDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIC8vIGtub3duIHRvIGJlIHN5bmNocm9ub3VzXG4gICAgc2VsZi5fZGJDdXJzb3IucmV3aW5kKCk7XG5cbiAgICBzZWxmLl92aXNpdGVkSWRzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gIH0sXG5cbiAgLy8gTW9zdGx5IHVzYWJsZSBmb3IgdGFpbGFibGUgY3Vyc29ycy5cbiAgY2xvc2U6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICBzZWxmLl9kYkN1cnNvci5jbG9zZSgpO1xuICB9LFxuXG4gIGZldGNoOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBzZWxmLm1hcChfLmlkZW50aXR5KTtcbiAgfSxcblxuICBjb3VudDogZnVuY3Rpb24gKGFwcGx5U2tpcExpbWl0ID0gZmFsc2UpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgcmV0dXJuIHNlbGYuX3N5bmNocm9ub3VzQ291bnQoYXBwbHlTa2lwTGltaXQpLndhaXQoKTtcbiAgfSxcblxuICAvLyBUaGlzIG1ldGhvZCBpcyBOT1Qgd3JhcHBlZCBpbiBDdXJzb3IuXG4gIGdldFJhd09iamVjdHM6IGZ1bmN0aW9uIChvcmRlcmVkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICByZXR1cm4gc2VsZi5mZXRjaCgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgcmVzdWx0cyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgc2VsZi5mb3JFYWNoKGZ1bmN0aW9uIChkb2MpIHtcbiAgICAgICAgcmVzdWx0cy5zZXQoZG9jLl9pZCwgZG9jKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuICB9XG59KTtcblxuU3luY2hyb25vdXNDdXJzb3IucHJvdG90eXBlW1N5bWJvbC5pdGVyYXRvcl0gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICAvLyBHZXQgYmFjayB0byB0aGUgYmVnaW5uaW5nLlxuICBzZWxmLl9yZXdpbmQoKTtcblxuICByZXR1cm4ge1xuICAgIG5leHQoKSB7XG4gICAgICBjb25zdCBkb2MgPSBzZWxmLl9uZXh0T2JqZWN0KCk7XG4gICAgICByZXR1cm4gZG9jID8ge1xuICAgICAgICB2YWx1ZTogZG9jXG4gICAgICB9IDoge1xuICAgICAgICBkb25lOiB0cnVlXG4gICAgICB9O1xuICAgIH1cbiAgfTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUudGFpbCA9IGZ1bmN0aW9uIChjdXJzb3JEZXNjcmlwdGlvbiwgZG9jQ2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBpZiAoIWN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMudGFpbGFibGUpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgdGFpbCBhIHRhaWxhYmxlIGN1cnNvclwiKTtcblxuICB2YXIgY3Vyc29yID0gc2VsZi5fY3JlYXRlU3luY2hyb25vdXNDdXJzb3IoY3Vyc29yRGVzY3JpcHRpb24pO1xuXG4gIHZhciBzdG9wcGVkID0gZmFsc2U7XG4gIHZhciBsYXN0VFM7XG4gIHZhciBsb29wID0gZnVuY3Rpb24gKCkge1xuICAgIHZhciBkb2MgPSBudWxsO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBpZiAoc3RvcHBlZClcbiAgICAgICAgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZG9jID0gY3Vyc29yLl9uZXh0T2JqZWN0KCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgLy8gVGhlcmUncyBubyBnb29kIHdheSB0byBmaWd1cmUgb3V0IGlmIHRoaXMgd2FzIGFjdHVhbGx5IGFuIGVycm9yXG4gICAgICAgIC8vIGZyb20gTW9uZ28uIEFoIHdlbGwuIEJ1dCBlaXRoZXIgd2F5LCB3ZSBuZWVkIHRvIHJldHJ5IHRoZSBjdXJzb3JcbiAgICAgICAgLy8gKHVubGVzcyB0aGUgZmFpbHVyZSB3YXMgYmVjYXVzZSB0aGUgb2JzZXJ2ZSBnb3Qgc3RvcHBlZCkuXG4gICAgICAgIGRvYyA9IG51bGw7XG4gICAgICB9XG4gICAgICAvLyBTaW5jZSBjdXJzb3IuX25leHRPYmplY3QgY2FuIHlpZWxkLCB3ZSBuZWVkIHRvIGNoZWNrIGFnYWluIHRvIHNlZSBpZlxuICAgICAgLy8gd2UndmUgYmVlbiBzdG9wcGVkIGJlZm9yZSBjYWxsaW5nIHRoZSBjYWxsYmFjay5cbiAgICAgIGlmIChzdG9wcGVkKVxuICAgICAgICByZXR1cm47XG4gICAgICBpZiAoZG9jKSB7XG4gICAgICAgIC8vIElmIGEgdGFpbGFibGUgY3Vyc29yIGNvbnRhaW5zIGEgXCJ0c1wiIGZpZWxkLCB1c2UgaXQgdG8gcmVjcmVhdGUgdGhlXG4gICAgICAgIC8vIGN1cnNvciBvbiBlcnJvci4gKFwidHNcIiBpcyBhIHN0YW5kYXJkIHRoYXQgTW9uZ28gdXNlcyBpbnRlcm5hbGx5IGZvclxuICAgICAgICAvLyB0aGUgb3Bsb2csIGFuZCB0aGVyZSdzIGEgc3BlY2lhbCBmbGFnIHRoYXQgbGV0cyB5b3UgZG8gYmluYXJ5IHNlYXJjaFxuICAgICAgICAvLyBvbiBpdCBpbnN0ZWFkIG9mIG5lZWRpbmcgdG8gdXNlIGFuIGluZGV4LilcbiAgICAgICAgbGFzdFRTID0gZG9jLnRzO1xuICAgICAgICBkb2NDYWxsYmFjayhkb2MpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIG5ld1NlbGVjdG9yID0gXy5jbG9uZShjdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3Rvcik7XG4gICAgICAgIGlmIChsYXN0VFMpIHtcbiAgICAgICAgICBuZXdTZWxlY3Rvci50cyA9IHskZ3Q6IGxhc3RUU307XG4gICAgICAgIH1cbiAgICAgICAgY3Vyc29yID0gc2VsZi5fY3JlYXRlU3luY2hyb25vdXNDdXJzb3IobmV3IEN1cnNvckRlc2NyaXB0aW9uKFxuICAgICAgICAgIGN1cnNvckRlc2NyaXB0aW9uLmNvbGxlY3Rpb25OYW1lLFxuICAgICAgICAgIG5ld1NlbGVjdG9yLFxuICAgICAgICAgIGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMpKTtcbiAgICAgICAgLy8gTW9uZ28gZmFpbG92ZXIgdGFrZXMgbWFueSBzZWNvbmRzLiAgUmV0cnkgaW4gYSBiaXQuICAoV2l0aG91dCB0aGlzXG4gICAgICAgIC8vIHNldFRpbWVvdXQsIHdlIHBlZyB0aGUgQ1BVIGF0IDEwMCUgYW5kIG5ldmVyIG5vdGljZSB0aGUgYWN0dWFsXG4gICAgICAgIC8vIGZhaWxvdmVyLlxuICAgICAgICBNZXRlb3Iuc2V0VGltZW91dChsb29wLCAxMDApO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgTWV0ZW9yLmRlZmVyKGxvb3ApO1xuXG4gIHJldHVybiB7XG4gICAgc3RvcDogZnVuY3Rpb24gKCkge1xuICAgICAgc3RvcHBlZCA9IHRydWU7XG4gICAgICBjdXJzb3IuY2xvc2UoKTtcbiAgICB9XG4gIH07XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9vYnNlcnZlQ2hhbmdlcyA9IGZ1bmN0aW9uIChcbiAgICBjdXJzb3JEZXNjcmlwdGlvbiwgb3JkZXJlZCwgY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBpZiAoY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50YWlsYWJsZSkge1xuICAgIHJldHVybiBzZWxmLl9vYnNlcnZlQ2hhbmdlc1RhaWxhYmxlKGN1cnNvckRlc2NyaXB0aW9uLCBvcmRlcmVkLCBjYWxsYmFja3MpO1xuICB9XG5cbiAgLy8gWW91IG1heSBub3QgZmlsdGVyIG91dCBfaWQgd2hlbiBvYnNlcnZpbmcgY2hhbmdlcywgYmVjYXVzZSB0aGUgaWQgaXMgYSBjb3JlXG4gIC8vIHBhcnQgb2YgdGhlIG9ic2VydmVDaGFuZ2VzIEFQSS5cbiAgaWYgKGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMuZmllbGRzICYmXG4gICAgICAoY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5maWVsZHMuX2lkID09PSAwIHx8XG4gICAgICAgY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5maWVsZHMuX2lkID09PSBmYWxzZSkpIHtcbiAgICB0aHJvdyBFcnJvcihcIllvdSBtYXkgbm90IG9ic2VydmUgYSBjdXJzb3Igd2l0aCB7ZmllbGRzOiB7X2lkOiAwfX1cIik7XG4gIH1cblxuICB2YXIgb2JzZXJ2ZUtleSA9IEVKU09OLnN0cmluZ2lmeShcbiAgICBfLmV4dGVuZCh7b3JkZXJlZDogb3JkZXJlZH0sIGN1cnNvckRlc2NyaXB0aW9uKSk7XG5cbiAgdmFyIG11bHRpcGxleGVyLCBvYnNlcnZlRHJpdmVyO1xuICB2YXIgZmlyc3RIYW5kbGUgPSBmYWxzZTtcblxuICAvLyBGaW5kIGEgbWF0Y2hpbmcgT2JzZXJ2ZU11bHRpcGxleGVyLCBvciBjcmVhdGUgYSBuZXcgb25lLiBUaGlzIG5leHQgYmxvY2sgaXNcbiAgLy8gZ3VhcmFudGVlZCB0byBub3QgeWllbGQgKGFuZCBpdCBkb2Vzbid0IGNhbGwgYW55dGhpbmcgdGhhdCBjYW4gb2JzZXJ2ZSBhXG4gIC8vIG5ldyBxdWVyeSksIHNvIG5vIG90aGVyIGNhbGxzIHRvIHRoaXMgZnVuY3Rpb24gY2FuIGludGVybGVhdmUgd2l0aCBpdC5cbiAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgIGlmIChfLmhhcyhzZWxmLl9vYnNlcnZlTXVsdGlwbGV4ZXJzLCBvYnNlcnZlS2V5KSkge1xuICAgICAgbXVsdGlwbGV4ZXIgPSBzZWxmLl9vYnNlcnZlTXVsdGlwbGV4ZXJzW29ic2VydmVLZXldO1xuICAgIH0gZWxzZSB7XG4gICAgICBmaXJzdEhhbmRsZSA9IHRydWU7XG4gICAgICAvLyBDcmVhdGUgYSBuZXcgT2JzZXJ2ZU11bHRpcGxleGVyLlxuICAgICAgbXVsdGlwbGV4ZXIgPSBuZXcgT2JzZXJ2ZU11bHRpcGxleGVyKHtcbiAgICAgICAgb3JkZXJlZDogb3JkZXJlZCxcbiAgICAgICAgb25TdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgZGVsZXRlIHNlbGYuX29ic2VydmVNdWx0aXBsZXhlcnNbb2JzZXJ2ZUtleV07XG4gICAgICAgICAgb2JzZXJ2ZURyaXZlci5zdG9wKCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgc2VsZi5fb2JzZXJ2ZU11bHRpcGxleGVyc1tvYnNlcnZlS2V5XSA9IG11bHRpcGxleGVyO1xuICAgIH1cbiAgfSk7XG5cbiAgdmFyIG9ic2VydmVIYW5kbGUgPSBuZXcgT2JzZXJ2ZUhhbmRsZShtdWx0aXBsZXhlciwgY2FsbGJhY2tzKTtcblxuICBpZiAoZmlyc3RIYW5kbGUpIHtcbiAgICB2YXIgbWF0Y2hlciwgc29ydGVyO1xuICAgIHZhciBjYW5Vc2VPcGxvZyA9IF8uYWxsKFtcbiAgICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgLy8gQXQgYSBiYXJlIG1pbmltdW0sIHVzaW5nIHRoZSBvcGxvZyByZXF1aXJlcyB1cyB0byBoYXZlIGFuIG9wbG9nLCB0b1xuICAgICAgICAvLyB3YW50IHVub3JkZXJlZCBjYWxsYmFja3MsIGFuZCB0byBub3Qgd2FudCBhIGNhbGxiYWNrIG9uIHRoZSBwb2xsc1xuICAgICAgICAvLyB0aGF0IHdvbid0IGhhcHBlbi5cbiAgICAgICAgcmV0dXJuIHNlbGYuX29wbG9nSGFuZGxlICYmICFvcmRlcmVkICYmXG4gICAgICAgICAgIWNhbGxiYWNrcy5fdGVzdE9ubHlQb2xsQ2FsbGJhY2s7XG4gICAgICB9LCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIC8vIFdlIG5lZWQgdG8gYmUgYWJsZSB0byBjb21waWxlIHRoZSBzZWxlY3Rvci4gRmFsbCBiYWNrIHRvIHBvbGxpbmcgZm9yXG4gICAgICAgIC8vIHNvbWUgbmV3ZmFuZ2xlZCAkc2VsZWN0b3IgdGhhdCBtaW5pbW9uZ28gZG9lc24ndCBzdXBwb3J0IHlldC5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIC8vIFhYWCBtYWtlIGFsbCBjb21waWxhdGlvbiBlcnJvcnMgTWluaW1vbmdvRXJyb3Igb3Igc29tZXRoaW5nXG4gICAgICAgICAgLy8gICAgIHNvIHRoYXQgdGhpcyBkb2Vzbid0IGlnbm9yZSB1bnJlbGF0ZWQgZXhjZXB0aW9uc1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfSwgZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyAuLi4gYW5kIHRoZSBzZWxlY3RvciBpdHNlbGYgbmVlZHMgdG8gc3VwcG9ydCBvcGxvZy5cbiAgICAgICAgcmV0dXJuIE9wbG9nT2JzZXJ2ZURyaXZlci5jdXJzb3JTdXBwb3J0ZWQoY3Vyc29yRGVzY3JpcHRpb24sIG1hdGNoZXIpO1xuICAgICAgfSwgZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBBbmQgd2UgbmVlZCB0byBiZSBhYmxlIHRvIGNvbXBpbGUgdGhlIHNvcnQsIGlmIGFueS4gIGVnLCBjYW4ndCBiZVxuICAgICAgICAvLyB7JG5hdHVyYWw6IDF9LlxuICAgICAgICBpZiAoIWN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMuc29ydClcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBzb3J0ZXIgPSBuZXcgTWluaW1vbmdvLlNvcnRlcihjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnNvcnQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBtYXRjaGVyOiBtYXRjaGVyIH0pO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gWFhYIG1ha2UgYWxsIGNvbXBpbGF0aW9uIGVycm9ycyBNaW5pbW9uZ29FcnJvciBvciBzb21ldGhpbmdcbiAgICAgICAgICAvLyAgICAgc28gdGhhdCB0aGlzIGRvZXNuJ3QgaWdub3JlIHVucmVsYXRlZCBleGNlcHRpb25zXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9XSwgZnVuY3Rpb24gKGYpIHsgcmV0dXJuIGYoKTsgfSk7ICAvLyBpbnZva2UgZWFjaCBmdW5jdGlvblxuXG4gICAgdmFyIGRyaXZlckNsYXNzID0gY2FuVXNlT3Bsb2cgPyBPcGxvZ09ic2VydmVEcml2ZXIgOiBQb2xsaW5nT2JzZXJ2ZURyaXZlcjtcbiAgICBvYnNlcnZlRHJpdmVyID0gbmV3IGRyaXZlckNsYXNzKHtcbiAgICAgIGN1cnNvckRlc2NyaXB0aW9uOiBjdXJzb3JEZXNjcmlwdGlvbixcbiAgICAgIG1vbmdvSGFuZGxlOiBzZWxmLFxuICAgICAgbXVsdGlwbGV4ZXI6IG11bHRpcGxleGVyLFxuICAgICAgb3JkZXJlZDogb3JkZXJlZCxcbiAgICAgIG1hdGNoZXI6IG1hdGNoZXIsICAvLyBpZ25vcmVkIGJ5IHBvbGxpbmdcbiAgICAgIHNvcnRlcjogc29ydGVyLCAgLy8gaWdub3JlZCBieSBwb2xsaW5nXG4gICAgICBfdGVzdE9ubHlQb2xsQ2FsbGJhY2s6IGNhbGxiYWNrcy5fdGVzdE9ubHlQb2xsQ2FsbGJhY2tcbiAgICB9KTtcblxuICAgIC8vIFRoaXMgZmllbGQgaXMgb25seSBzZXQgZm9yIHVzZSBpbiB0ZXN0cy5cbiAgICBtdWx0aXBsZXhlci5fb2JzZXJ2ZURyaXZlciA9IG9ic2VydmVEcml2ZXI7XG4gIH1cblxuICAvLyBCbG9ja3MgdW50aWwgdGhlIGluaXRpYWwgYWRkcyBoYXZlIGJlZW4gc2VudC5cbiAgbXVsdGlwbGV4ZXIuYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzKG9ic2VydmVIYW5kbGUpO1xuXG4gIHJldHVybiBvYnNlcnZlSGFuZGxlO1xufTtcblxuLy8gTGlzdGVuIGZvciB0aGUgaW52YWxpZGF0aW9uIG1lc3NhZ2VzIHRoYXQgd2lsbCB0cmlnZ2VyIHVzIHRvIHBvbGwgdGhlXG4vLyBkYXRhYmFzZSBmb3IgY2hhbmdlcy4gSWYgdGhpcyBzZWxlY3RvciBzcGVjaWZpZXMgc3BlY2lmaWMgSURzLCBzcGVjaWZ5IHRoZW1cbi8vIGhlcmUsIHNvIHRoYXQgdXBkYXRlcyB0byBkaWZmZXJlbnQgc3BlY2lmaWMgSURzIGRvbid0IGNhdXNlIHVzIHRvIHBvbGwuXG4vLyBsaXN0ZW5DYWxsYmFjayBpcyB0aGUgc2FtZSBraW5kIG9mIChub3RpZmljYXRpb24sIGNvbXBsZXRlKSBjYWxsYmFjayBwYXNzZWRcbi8vIHRvIEludmFsaWRhdGlvbkNyb3NzYmFyLmxpc3Rlbi5cblxubGlzdGVuQWxsID0gZnVuY3Rpb24gKGN1cnNvckRlc2NyaXB0aW9uLCBsaXN0ZW5DYWxsYmFjaykge1xuICB2YXIgbGlzdGVuZXJzID0gW107XG4gIGZvckVhY2hUcmlnZ2VyKGN1cnNvckRlc2NyaXB0aW9uLCBmdW5jdGlvbiAodHJpZ2dlcikge1xuICAgIGxpc3RlbmVycy5wdXNoKEREUFNlcnZlci5fSW52YWxpZGF0aW9uQ3Jvc3NiYXIubGlzdGVuKFxuICAgICAgdHJpZ2dlciwgbGlzdGVuQ2FsbGJhY2spKTtcbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICBfLmVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAobGlzdGVuZXIpIHtcbiAgICAgICAgbGlzdGVuZXIuc3RvcCgpO1xuICAgICAgfSk7XG4gICAgfVxuICB9O1xufTtcblxuZm9yRWFjaFRyaWdnZXIgPSBmdW5jdGlvbiAoY3Vyc29yRGVzY3JpcHRpb24sIHRyaWdnZXJDYWxsYmFjaykge1xuICB2YXIga2V5ID0ge2NvbGxlY3Rpb246IGN1cnNvckRlc2NyaXB0aW9uLmNvbGxlY3Rpb25OYW1lfTtcbiAgdmFyIHNwZWNpZmljSWRzID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihcbiAgICBjdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3Rvcik7XG4gIGlmIChzcGVjaWZpY0lkcykge1xuICAgIF8uZWFjaChzcGVjaWZpY0lkcywgZnVuY3Rpb24gKGlkKSB7XG4gICAgICB0cmlnZ2VyQ2FsbGJhY2soXy5leHRlbmQoe2lkOiBpZH0sIGtleSkpO1xuICAgIH0pO1xuICAgIHRyaWdnZXJDYWxsYmFjayhfLmV4dGVuZCh7ZHJvcENvbGxlY3Rpb246IHRydWUsIGlkOiBudWxsfSwga2V5KSk7XG4gIH0gZWxzZSB7XG4gICAgdHJpZ2dlckNhbGxiYWNrKGtleSk7XG4gIH1cbiAgLy8gRXZlcnlvbmUgY2FyZXMgYWJvdXQgdGhlIGRhdGFiYXNlIGJlaW5nIGRyb3BwZWQuXG4gIHRyaWdnZXJDYWxsYmFjayh7IGRyb3BEYXRhYmFzZTogdHJ1ZSB9KTtcbn07XG5cbi8vIG9ic2VydmVDaGFuZ2VzIGZvciB0YWlsYWJsZSBjdXJzb3JzIG9uIGNhcHBlZCBjb2xsZWN0aW9ucy5cbi8vXG4vLyBTb21lIGRpZmZlcmVuY2VzIGZyb20gbm9ybWFsIGN1cnNvcnM6XG4vLyAgIC0gV2lsbCBuZXZlciBwcm9kdWNlIGFueXRoaW5nIG90aGVyIHRoYW4gJ2FkZGVkJyBvciAnYWRkZWRCZWZvcmUnLiBJZiB5b3Vcbi8vICAgICBkbyB1cGRhdGUgYSBkb2N1bWVudCB0aGF0IGhhcyBhbHJlYWR5IGJlZW4gcHJvZHVjZWQsIHRoaXMgd2lsbCBub3Qgbm90aWNlXG4vLyAgICAgaXQuXG4vLyAgIC0gSWYgeW91IGRpc2Nvbm5lY3QgYW5kIHJlY29ubmVjdCBmcm9tIE1vbmdvLCBpdCB3aWxsIGVzc2VudGlhbGx5IHJlc3RhcnRcbi8vICAgICB0aGUgcXVlcnksIHdoaWNoIHdpbGwgbGVhZCB0byBkdXBsaWNhdGUgcmVzdWx0cy4gVGhpcyBpcyBwcmV0dHkgYmFkLFxuLy8gICAgIGJ1dCBpZiB5b3UgaW5jbHVkZSBhIGZpZWxkIGNhbGxlZCAndHMnIHdoaWNoIGlzIGluc2VydGVkIGFzXG4vLyAgICAgbmV3IE1vbmdvSW50ZXJuYWxzLk1vbmdvVGltZXN0YW1wKDAsIDApICh3aGljaCBpcyBpbml0aWFsaXplZCB0byB0aGVcbi8vICAgICBjdXJyZW50IE1vbmdvLXN0eWxlIHRpbWVzdGFtcCksIHdlJ2xsIGJlIGFibGUgdG8gZmluZCB0aGUgcGxhY2UgdG9cbi8vICAgICByZXN0YXJ0IHByb3Blcmx5LiAoVGhpcyBmaWVsZCBpcyBzcGVjaWZpY2FsbHkgdW5kZXJzdG9vZCBieSBNb25nbyB3aXRoIGFuXG4vLyAgICAgb3B0aW1pemF0aW9uIHdoaWNoIGFsbG93cyBpdCB0byBmaW5kIHRoZSByaWdodCBwbGFjZSB0byBzdGFydCB3aXRob3V0XG4vLyAgICAgYW4gaW5kZXggb24gdHMuIEl0J3MgaG93IHRoZSBvcGxvZyB3b3Jrcy4pXG4vLyAgIC0gTm8gY2FsbGJhY2tzIGFyZSB0cmlnZ2VyZWQgc3luY2hyb25vdXNseSB3aXRoIHRoZSBjYWxsICh0aGVyZSdzIG5vXG4vLyAgICAgZGlmZmVyZW50aWF0aW9uIGJldHdlZW4gXCJpbml0aWFsIGRhdGFcIiBhbmQgXCJsYXRlciBjaGFuZ2VzXCI7IGV2ZXJ5dGhpbmdcbi8vICAgICB0aGF0IG1hdGNoZXMgdGhlIHF1ZXJ5IGdldHMgc2VudCBhc3luY2hyb25vdXNseSkuXG4vLyAgIC0gRGUtZHVwbGljYXRpb24gaXMgbm90IGltcGxlbWVudGVkLlxuLy8gICAtIERvZXMgbm90IHlldCBpbnRlcmFjdCB3aXRoIHRoZSB3cml0ZSBmZW5jZS4gUHJvYmFibHksIHRoaXMgc2hvdWxkIHdvcmsgYnlcbi8vICAgICBpZ25vcmluZyByZW1vdmVzICh3aGljaCBkb24ndCB3b3JrIG9uIGNhcHBlZCBjb2xsZWN0aW9ucykgYW5kIHVwZGF0ZXNcbi8vICAgICAod2hpY2ggZG9uJ3QgYWZmZWN0IHRhaWxhYmxlIGN1cnNvcnMpLCBhbmQganVzdCBrZWVwaW5nIHRyYWNrIG9mIHRoZSBJRFxuLy8gICAgIG9mIHRoZSBpbnNlcnRlZCBvYmplY3QsIGFuZCBjbG9zaW5nIHRoZSB3cml0ZSBmZW5jZSBvbmNlIHlvdSBnZXQgdG8gdGhhdFxuLy8gICAgIElEIChvciB0aW1lc3RhbXA/KS4gIFRoaXMgZG9lc24ndCB3b3JrIHdlbGwgaWYgdGhlIGRvY3VtZW50IGRvZXNuJ3QgbWF0Y2hcbi8vICAgICB0aGUgcXVlcnksIHRob3VnaC4gIE9uIHRoZSBvdGhlciBoYW5kLCB0aGUgd3JpdGUgZmVuY2UgY2FuIGNsb3NlXG4vLyAgICAgaW1tZWRpYXRlbHkgaWYgaXQgZG9lcyBub3QgbWF0Y2ggdGhlIHF1ZXJ5LiBTbyBpZiB3ZSB0cnVzdCBtaW5pbW9uZ29cbi8vICAgICBlbm91Z2ggdG8gYWNjdXJhdGVseSBldmFsdWF0ZSB0aGUgcXVlcnkgYWdhaW5zdCB0aGUgd3JpdGUgZmVuY2UsIHdlXG4vLyAgICAgc2hvdWxkIGJlIGFibGUgdG8gZG8gdGhpcy4uLiAgT2YgY291cnNlLCBtaW5pbW9uZ28gZG9lc24ndCBldmVuIHN1cHBvcnRcbi8vICAgICBNb25nbyBUaW1lc3RhbXBzIHlldC5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX29ic2VydmVDaGFuZ2VzVGFpbGFibGUgPSBmdW5jdGlvbiAoXG4gICAgY3Vyc29yRGVzY3JpcHRpb24sIG9yZGVyZWQsIGNhbGxiYWNrcykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgLy8gVGFpbGFibGUgY3Vyc29ycyBvbmx5IGV2ZXIgY2FsbCBhZGRlZC9hZGRlZEJlZm9yZSBjYWxsYmFja3MsIHNvIGl0J3MgYW5cbiAgLy8gZXJyb3IgaWYgeW91IGRpZG4ndCBwcm92aWRlIHRoZW0uXG4gIGlmICgob3JkZXJlZCAmJiAhY2FsbGJhY2tzLmFkZGVkQmVmb3JlKSB8fFxuICAgICAgKCFvcmRlcmVkICYmICFjYWxsYmFja3MuYWRkZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuJ3Qgb2JzZXJ2ZSBhbiBcIiArIChvcmRlcmVkID8gXCJvcmRlcmVkXCIgOiBcInVub3JkZXJlZFwiKVxuICAgICAgICAgICAgICAgICAgICArIFwiIHRhaWxhYmxlIGN1cnNvciB3aXRob3V0IGEgXCJcbiAgICAgICAgICAgICAgICAgICAgKyAob3JkZXJlZCA/IFwiYWRkZWRCZWZvcmVcIiA6IFwiYWRkZWRcIikgKyBcIiBjYWxsYmFja1wiKTtcbiAgfVxuXG4gIHJldHVybiBzZWxmLnRhaWwoY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uIChkb2MpIHtcbiAgICB2YXIgaWQgPSBkb2MuX2lkO1xuICAgIGRlbGV0ZSBkb2MuX2lkO1xuICAgIC8vIFRoZSB0cyBpcyBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwuIEhpZGUgaXQuXG4gICAgZGVsZXRlIGRvYy50cztcbiAgICBpZiAob3JkZXJlZCkge1xuICAgICAgY2FsbGJhY2tzLmFkZGVkQmVmb3JlKGlkLCBkb2MsIG51bGwpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjYWxsYmFja3MuYWRkZWQoaWQsIGRvYyk7XG4gICAgfVxuICB9KTtcbn07XG5cbi8vIFhYWCBXZSBwcm9iYWJseSBuZWVkIHRvIGZpbmQgYSBiZXR0ZXIgd2F5IHRvIGV4cG9zZSB0aGlzLiBSaWdodCBub3dcbi8vIGl0J3Mgb25seSB1c2VkIGJ5IHRlc3RzLCBidXQgaW4gZmFjdCB5b3UgbmVlZCBpdCBpbiBub3JtYWxcbi8vIG9wZXJhdGlvbiB0byBpbnRlcmFjdCB3aXRoIGNhcHBlZCBjb2xsZWN0aW9ucy5cbk1vbmdvSW50ZXJuYWxzLk1vbmdvVGltZXN0YW1wID0gTW9uZ29EQi5UaW1lc3RhbXA7XG5cbk1vbmdvSW50ZXJuYWxzLkNvbm5lY3Rpb24gPSBNb25nb0Nvbm5lY3Rpb247XG4iLCJ2YXIgRnV0dXJlID0gTnBtLnJlcXVpcmUoJ2ZpYmVycy9mdXR1cmUnKTtcblxuT1BMT0dfQ09MTEVDVElPTiA9ICdvcGxvZy5ycyc7XG5cbnZhciBUT09fRkFSX0JFSElORCA9IHByb2Nlc3MuZW52Lk1FVEVPUl9PUExPR19UT09fRkFSX0JFSElORCB8fCAyMDAwO1xuXG52YXIgc2hvd1RTID0gZnVuY3Rpb24gKHRzKSB7XG4gIHJldHVybiBcIlRpbWVzdGFtcChcIiArIHRzLmdldEhpZ2hCaXRzKCkgKyBcIiwgXCIgKyB0cy5nZXRMb3dCaXRzKCkgKyBcIilcIjtcbn07XG5cbmlkRm9yT3AgPSBmdW5jdGlvbiAob3ApIHtcbiAgaWYgKG9wLm9wID09PSAnZCcpXG4gICAgcmV0dXJuIG9wLm8uX2lkO1xuICBlbHNlIGlmIChvcC5vcCA9PT0gJ2knKVxuICAgIHJldHVybiBvcC5vLl9pZDtcbiAgZWxzZSBpZiAob3Aub3AgPT09ICd1JylcbiAgICByZXR1cm4gb3AubzIuX2lkO1xuICBlbHNlIGlmIChvcC5vcCA9PT0gJ2MnKVxuICAgIHRocm93IEVycm9yKFwiT3BlcmF0b3IgJ2MnIGRvZXNuJ3Qgc3VwcGx5IGFuIG9iamVjdCB3aXRoIGlkOiBcIiArXG4gICAgICAgICAgICAgICAgRUpTT04uc3RyaW5naWZ5KG9wKSk7XG4gIGVsc2VcbiAgICB0aHJvdyBFcnJvcihcIlVua25vd24gb3A6IFwiICsgRUpTT04uc3RyaW5naWZ5KG9wKSk7XG59O1xuXG5PcGxvZ0hhbmRsZSA9IGZ1bmN0aW9uIChvcGxvZ1VybCwgZGJOYW1lKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5fb3Bsb2dVcmwgPSBvcGxvZ1VybDtcbiAgc2VsZi5fZGJOYW1lID0gZGJOYW1lO1xuXG4gIHNlbGYuX29wbG9nTGFzdEVudHJ5Q29ubmVjdGlvbiA9IG51bGw7XG4gIHNlbGYuX29wbG9nVGFpbENvbm5lY3Rpb24gPSBudWxsO1xuICBzZWxmLl9zdG9wcGVkID0gZmFsc2U7XG4gIHNlbGYuX3RhaWxIYW5kbGUgPSBudWxsO1xuICBzZWxmLl9yZWFkeUZ1dHVyZSA9IG5ldyBGdXR1cmUoKTtcbiAgc2VsZi5fY3Jvc3NiYXIgPSBuZXcgRERQU2VydmVyLl9Dcm9zc2Jhcih7XG4gICAgZmFjdFBhY2thZ2U6IFwibW9uZ28tbGl2ZWRhdGFcIiwgZmFjdE5hbWU6IFwib3Bsb2ctd2F0Y2hlcnNcIlxuICB9KTtcbiAgc2VsZi5fYmFzZU9wbG9nU2VsZWN0b3IgPSB7XG4gICAgbnM6IG5ldyBSZWdFeHAoJ14nICsgTWV0ZW9yLl9lc2NhcGVSZWdFeHAoc2VsZi5fZGJOYW1lKSArICdcXFxcLicpLFxuICAgICRvcjogW1xuICAgICAgeyBvcDogeyRpbjogWydpJywgJ3UnLCAnZCddfSB9LFxuICAgICAgLy8gZHJvcCBjb2xsZWN0aW9uXG4gICAgICB7IG9wOiAnYycsICdvLmRyb3AnOiB7ICRleGlzdHM6IHRydWUgfSB9LFxuICAgICAgeyBvcDogJ2MnLCAnby5kcm9wRGF0YWJhc2UnOiAxIH0sXG4gICAgXVxuICB9O1xuXG4gIC8vIERhdGEgc3RydWN0dXJlcyB0byBzdXBwb3J0IHdhaXRVbnRpbENhdWdodFVwKCkuIEVhY2ggb3Bsb2cgZW50cnkgaGFzIGFcbiAgLy8gTW9uZ29UaW1lc3RhbXAgb2JqZWN0IG9uIGl0ICh3aGljaCBpcyBub3QgdGhlIHNhbWUgYXMgYSBEYXRlIC0tLSBpdCdzIGFcbiAgLy8gY29tYmluYXRpb24gb2YgdGltZSBhbmQgYW4gaW5jcmVtZW50aW5nIGNvdW50ZXI7IHNlZVxuICAvLyBodHRwOi8vZG9jcy5tb25nb2RiLm9yZy9tYW51YWwvcmVmZXJlbmNlL2Jzb24tdHlwZXMvI3RpbWVzdGFtcHMpLlxuICAvL1xuICAvLyBfY2F0Y2hpbmdVcEZ1dHVyZXMgaXMgYW4gYXJyYXkgb2Yge3RzOiBNb25nb1RpbWVzdGFtcCwgZnV0dXJlOiBGdXR1cmV9XG4gIC8vIG9iamVjdHMsIHNvcnRlZCBieSBhc2NlbmRpbmcgdGltZXN0YW1wLiBfbGFzdFByb2Nlc3NlZFRTIGlzIHRoZVxuICAvLyBNb25nb1RpbWVzdGFtcCBvZiB0aGUgbGFzdCBvcGxvZyBlbnRyeSB3ZSd2ZSBwcm9jZXNzZWQuXG4gIC8vXG4gIC8vIEVhY2ggdGltZSB3ZSBjYWxsIHdhaXRVbnRpbENhdWdodFVwLCB3ZSB0YWtlIGEgcGVlayBhdCB0aGUgZmluYWwgb3Bsb2dcbiAgLy8gZW50cnkgaW4gdGhlIGRiLiAgSWYgd2UndmUgYWxyZWFkeSBwcm9jZXNzZWQgaXQgKGllLCBpdCBpcyBub3QgZ3JlYXRlciB0aGFuXG4gIC8vIF9sYXN0UHJvY2Vzc2VkVFMpLCB3YWl0VW50aWxDYXVnaHRVcCBpbW1lZGlhdGVseSByZXR1cm5zLiBPdGhlcndpc2UsXG4gIC8vIHdhaXRVbnRpbENhdWdodFVwIG1ha2VzIGEgbmV3IEZ1dHVyZSBhbmQgaW5zZXJ0cyBpdCBhbG9uZyB3aXRoIHRoZSBmaW5hbFxuICAvLyB0aW1lc3RhbXAgZW50cnkgdGhhdCBpdCByZWFkLCBpbnRvIF9jYXRjaGluZ1VwRnV0dXJlcy4gd2FpdFVudGlsQ2F1Z2h0VXBcbiAgLy8gdGhlbiB3YWl0cyBvbiB0aGF0IGZ1dHVyZSwgd2hpY2ggaXMgcmVzb2x2ZWQgb25jZSBfbGFzdFByb2Nlc3NlZFRTIGlzXG4gIC8vIGluY3JlbWVudGVkIHRvIGJlIHBhc3QgaXRzIHRpbWVzdGFtcCBieSB0aGUgd29ya2VyIGZpYmVyLlxuICAvL1xuICAvLyBYWFggdXNlIGEgcHJpb3JpdHkgcXVldWUgb3Igc29tZXRoaW5nIGVsc2UgdGhhdCdzIGZhc3RlciB0aGFuIGFuIGFycmF5XG4gIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzID0gW107XG4gIHNlbGYuX2xhc3RQcm9jZXNzZWRUUyA9IG51bGw7XG5cbiAgc2VsZi5fb25Ta2lwcGVkRW50cmllc0hvb2sgPSBuZXcgSG9vayh7XG4gICAgZGVidWdQcmludEV4Y2VwdGlvbnM6IFwib25Ta2lwcGVkRW50cmllcyBjYWxsYmFja1wiXG4gIH0pO1xuXG4gIHNlbGYuX2VudHJ5UXVldWUgPSBuZXcgTWV0ZW9yLl9Eb3VibGVFbmRlZFF1ZXVlKCk7XG4gIHNlbGYuX3dvcmtlckFjdGl2ZSA9IGZhbHNlO1xuXG4gIHNlbGYuX3N0YXJ0VGFpbGluZygpO1xufTtcblxuXy5leHRlbmQoT3Bsb2dIYW5kbGUucHJvdG90eXBlLCB7XG4gIHN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG4gICAgc2VsZi5fc3RvcHBlZCA9IHRydWU7XG4gICAgaWYgKHNlbGYuX3RhaWxIYW5kbGUpXG4gICAgICBzZWxmLl90YWlsSGFuZGxlLnN0b3AoKTtcbiAgICAvLyBYWFggc2hvdWxkIGNsb3NlIGNvbm5lY3Rpb25zIHRvb1xuICB9LFxuICBvbk9wbG9nRW50cnk6IGZ1bmN0aW9uICh0cmlnZ2VyLCBjYWxsYmFjaykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbGxlZCBvbk9wbG9nRW50cnkgb24gc3RvcHBlZCBoYW5kbGUhXCIpO1xuXG4gICAgLy8gQ2FsbGluZyBvbk9wbG9nRW50cnkgcmVxdWlyZXMgdXMgdG8gd2FpdCBmb3IgdGhlIHRhaWxpbmcgdG8gYmUgcmVhZHkuXG4gICAgc2VsZi5fcmVhZHlGdXR1cmUud2FpdCgpO1xuXG4gICAgdmFyIG9yaWdpbmFsQ2FsbGJhY2sgPSBjYWxsYmFjaztcbiAgICBjYWxsYmFjayA9IE1ldGVvci5iaW5kRW52aXJvbm1lbnQoZnVuY3Rpb24gKG5vdGlmaWNhdGlvbikge1xuICAgICAgLy8gWFhYIGNhbiB3ZSBhdm9pZCB0aGlzIGNsb25lIGJ5IG1ha2luZyBvcGxvZy5qcyBjYXJlZnVsP1xuICAgICAgb3JpZ2luYWxDYWxsYmFjayhFSlNPTi5jbG9uZShub3RpZmljYXRpb24pKTtcbiAgICB9LCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBNZXRlb3IuX2RlYnVnKFwiRXJyb3IgaW4gb3Bsb2cgY2FsbGJhY2tcIiwgZXJyLnN0YWNrKTtcbiAgICB9KTtcbiAgICB2YXIgbGlzdGVuSGFuZGxlID0gc2VsZi5fY3Jvc3NiYXIubGlzdGVuKHRyaWdnZXIsIGNhbGxiYWNrKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RvcDogZnVuY3Rpb24gKCkge1xuICAgICAgICBsaXN0ZW5IYW5kbGUuc3RvcCgpO1xuICAgICAgfVxuICAgIH07XG4gIH0sXG4gIC8vIFJlZ2lzdGVyIGEgY2FsbGJhY2sgdG8gYmUgaW52b2tlZCBhbnkgdGltZSB3ZSBza2lwIG9wbG9nIGVudHJpZXMgKGVnLFxuICAvLyBiZWNhdXNlIHdlIGFyZSB0b28gZmFyIGJlaGluZCkuXG4gIG9uU2tpcHBlZEVudHJpZXM6IGZ1bmN0aW9uIChjYWxsYmFjaykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbGxlZCBvblNraXBwZWRFbnRyaWVzIG9uIHN0b3BwZWQgaGFuZGxlIVwiKTtcbiAgICByZXR1cm4gc2VsZi5fb25Ta2lwcGVkRW50cmllc0hvb2sucmVnaXN0ZXIoY2FsbGJhY2spO1xuICB9LFxuICAvLyBDYWxscyBgY2FsbGJhY2tgIG9uY2UgdGhlIG9wbG9nIGhhcyBiZWVuIHByb2Nlc3NlZCB1cCB0byBhIHBvaW50IHRoYXQgaXNcbiAgLy8gcm91Z2hseSBcIm5vd1wiOiBzcGVjaWZpY2FsbHksIG9uY2Ugd2UndmUgcHJvY2Vzc2VkIGFsbCBvcHMgdGhhdCBhcmVcbiAgLy8gY3VycmVudGx5IHZpc2libGUuXG4gIC8vIFhYWCBiZWNvbWUgY29udmluY2VkIHRoYXQgdGhpcyBpcyBhY3R1YWxseSBzYWZlIGV2ZW4gaWYgb3Bsb2dDb25uZWN0aW9uXG4gIC8vIGlzIHNvbWUga2luZCBvZiBwb29sXG4gIHdhaXRVbnRpbENhdWdodFVwOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FsbGVkIHdhaXRVbnRpbENhdWdodFVwIG9uIHN0b3BwZWQgaGFuZGxlIVwiKTtcblxuICAgIC8vIENhbGxpbmcgd2FpdFVudGlsQ2F1Z2h0VXAgcmVxdXJpZXMgdXMgdG8gd2FpdCBmb3IgdGhlIG9wbG9nIGNvbm5lY3Rpb24gdG9cbiAgICAvLyBiZSByZWFkeS5cbiAgICBzZWxmLl9yZWFkeUZ1dHVyZS53YWl0KCk7XG4gICAgdmFyIGxhc3RFbnRyeTtcblxuICAgIHdoaWxlICghc2VsZi5fc3RvcHBlZCkge1xuICAgICAgLy8gV2UgbmVlZCB0byBtYWtlIHRoZSBzZWxlY3RvciBhdCBsZWFzdCBhcyByZXN0cmljdGl2ZSBhcyB0aGUgYWN0dWFsXG4gICAgICAvLyB0YWlsaW5nIHNlbGVjdG9yIChpZSwgd2UgbmVlZCB0byBzcGVjaWZ5IHRoZSBEQiBuYW1lKSBvciBlbHNlIHdlIG1pZ2h0XG4gICAgICAvLyBmaW5kIGEgVFMgdGhhdCB3b24ndCBzaG93IHVwIGluIHRoZSBhY3R1YWwgdGFpbCBzdHJlYW0uXG4gICAgICB0cnkge1xuICAgICAgICBsYXN0RW50cnkgPSBzZWxmLl9vcGxvZ0xhc3RFbnRyeUNvbm5lY3Rpb24uZmluZE9uZShcbiAgICAgICAgICBPUExPR19DT0xMRUNUSU9OLCBzZWxmLl9iYXNlT3Bsb2dTZWxlY3RvcixcbiAgICAgICAgICB7ZmllbGRzOiB7dHM6IDF9LCBzb3J0OiB7JG5hdHVyYWw6IC0xfX0pO1xuICAgICAgICBicmVhaztcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gRHVyaW5nIGZhaWxvdmVyIChlZykgaWYgd2UgZ2V0IGFuIGV4Y2VwdGlvbiB3ZSBzaG91bGQgbG9nIGFuZCByZXRyeVxuICAgICAgICAvLyBpbnN0ZWFkIG9mIGNyYXNoaW5nLlxuICAgICAgICBNZXRlb3IuX2RlYnVnKFwiR290IGV4Y2VwdGlvbiB3aGlsZSByZWFkaW5nIGxhc3QgZW50cnk6IFwiICsgZSk7XG4gICAgICAgIE1ldGVvci5fc2xlZXBGb3JNcygxMDApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuXG4gICAgaWYgKCFsYXN0RW50cnkpIHtcbiAgICAgIC8vIFJlYWxseSwgbm90aGluZyBpbiB0aGUgb3Bsb2c/IFdlbGwsIHdlJ3ZlIHByb2Nlc3NlZCBldmVyeXRoaW5nLlxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHZhciB0cyA9IGxhc3RFbnRyeS50cztcbiAgICBpZiAoIXRzKVxuICAgICAgdGhyb3cgRXJyb3IoXCJvcGxvZyBlbnRyeSB3aXRob3V0IHRzOiBcIiArIEVKU09OLnN0cmluZ2lmeShsYXN0RW50cnkpKTtcblxuICAgIGlmIChzZWxmLl9sYXN0UHJvY2Vzc2VkVFMgJiYgdHMubGVzc1RoYW5PckVxdWFsKHNlbGYuX2xhc3RQcm9jZXNzZWRUUykpIHtcbiAgICAgIC8vIFdlJ3ZlIGFscmVhZHkgY2F1Z2h0IHVwIHRvIGhlcmUuXG4gICAgICByZXR1cm47XG4gICAgfVxuXG5cbiAgICAvLyBJbnNlcnQgdGhlIGZ1dHVyZSBpbnRvIG91ciBsaXN0LiBBbG1vc3QgYWx3YXlzLCB0aGlzIHdpbGwgYmUgYXQgdGhlIGVuZCxcbiAgICAvLyBidXQgaXQncyBjb25jZWl2YWJsZSB0aGF0IGlmIHdlIGZhaWwgb3ZlciBmcm9tIG9uZSBwcmltYXJ5IHRvIGFub3RoZXIsXG4gICAgLy8gdGhlIG9wbG9nIGVudHJpZXMgd2Ugc2VlIHdpbGwgZ28gYmFja3dhcmRzLlxuICAgIHZhciBpbnNlcnRBZnRlciA9IHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzLmxlbmd0aDtcbiAgICB3aGlsZSAoaW5zZXJ0QWZ0ZXIgLSAxID4gMCAmJiBzZWxmLl9jYXRjaGluZ1VwRnV0dXJlc1tpbnNlcnRBZnRlciAtIDFdLnRzLmdyZWF0ZXJUaGFuKHRzKSkge1xuICAgICAgaW5zZXJ0QWZ0ZXItLTtcbiAgICB9XG4gICAgdmFyIGYgPSBuZXcgRnV0dXJlO1xuICAgIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzLnNwbGljZShpbnNlcnRBZnRlciwgMCwge3RzOiB0cywgZnV0dXJlOiBmfSk7XG4gICAgZi53YWl0KCk7XG4gIH0sXG4gIF9zdGFydFRhaWxpbmc6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gRmlyc3QsIG1ha2Ugc3VyZSB0aGF0IHdlJ3JlIHRhbGtpbmcgdG8gdGhlIGxvY2FsIGRhdGFiYXNlLlxuICAgIHZhciBtb25nb2RiVXJpID0gTnBtLnJlcXVpcmUoJ21vbmdvZGItdXJpJyk7XG4gICAgaWYgKG1vbmdvZGJVcmkucGFyc2Uoc2VsZi5fb3Bsb2dVcmwpLmRhdGFiYXNlICE9PSAnbG9jYWwnKSB7XG4gICAgICB0aHJvdyBFcnJvcihcIiRNT05HT19PUExPR19VUkwgbXVzdCBiZSBzZXQgdG8gdGhlICdsb2NhbCcgZGF0YWJhc2Ugb2YgXCIgK1xuICAgICAgICAgICAgICAgICAgXCJhIE1vbmdvIHJlcGxpY2Egc2V0XCIpO1xuICAgIH1cblxuICAgIC8vIFdlIG1ha2UgdHdvIHNlcGFyYXRlIGNvbm5lY3Rpb25zIHRvIE1vbmdvLiBUaGUgTm9kZSBNb25nbyBkcml2ZXJcbiAgICAvLyBpbXBsZW1lbnRzIGEgbmFpdmUgcm91bmQtcm9iaW4gY29ubmVjdGlvbiBwb29sOiBlYWNoIFwiY29ubmVjdGlvblwiIGlzIGFcbiAgICAvLyBwb29sIG9mIHNldmVyYWwgKDUgYnkgZGVmYXVsdCkgVENQIGNvbm5lY3Rpb25zLCBhbmQgZWFjaCByZXF1ZXN0IGlzXG4gICAgLy8gcm90YXRlZCB0aHJvdWdoIHRoZSBwb29scy4gVGFpbGFibGUgY3Vyc29yIHF1ZXJpZXMgYmxvY2sgb24gdGhlIHNlcnZlclxuICAgIC8vIHVudGlsIHRoZXJlIGlzIHNvbWUgZGF0YSB0byByZXR1cm4gKG9yIHVudGlsIGEgZmV3IHNlY29uZHMgaGF2ZVxuICAgIC8vIHBhc3NlZCkuIFNvIGlmIHRoZSBjb25uZWN0aW9uIHBvb2wgdXNlZCBmb3IgdGFpbGluZyBjdXJzb3JzIGlzIHRoZSBzYW1lXG4gICAgLy8gcG9vbCB1c2VkIGZvciBvdGhlciBxdWVyaWVzLCB0aGUgb3RoZXIgcXVlcmllcyB3aWxsIGJlIGRlbGF5ZWQgYnkgc2Vjb25kc1xuICAgIC8vIDEvNSBvZiB0aGUgdGltZS5cbiAgICAvL1xuICAgIC8vIFRoZSB0YWlsIGNvbm5lY3Rpb24gd2lsbCBvbmx5IGV2ZXIgYmUgcnVubmluZyBhIHNpbmdsZSB0YWlsIGNvbW1hbmQsIHNvXG4gICAgLy8gaXQgb25seSBuZWVkcyB0byBtYWtlIG9uZSB1bmRlcmx5aW5nIFRDUCBjb25uZWN0aW9uLlxuICAgIHNlbGYuX29wbG9nVGFpbENvbm5lY3Rpb24gPSBuZXcgTW9uZ29Db25uZWN0aW9uKFxuICAgICAgc2VsZi5fb3Bsb2dVcmwsIHtwb29sU2l6ZTogMX0pO1xuICAgIC8vIFhYWCBiZXR0ZXIgZG9jcywgYnV0OiBpdCdzIHRvIGdldCBtb25vdG9uaWMgcmVzdWx0c1xuICAgIC8vIFhYWCBpcyBpdCBzYWZlIHRvIHNheSBcImlmIHRoZXJlJ3MgYW4gaW4gZmxpZ2h0IHF1ZXJ5LCBqdXN0IHVzZSBpdHNcbiAgICAvLyAgICAgcmVzdWx0c1wiPyBJIGRvbid0IHRoaW5rIHNvIGJ1dCBzaG91bGQgY29uc2lkZXIgdGhhdFxuICAgIHNlbGYuX29wbG9nTGFzdEVudHJ5Q29ubmVjdGlvbiA9IG5ldyBNb25nb0Nvbm5lY3Rpb24oXG4gICAgICBzZWxmLl9vcGxvZ1VybCwge3Bvb2xTaXplOiAxfSk7XG5cbiAgICAvLyBOb3csIG1ha2Ugc3VyZSB0aGF0IHRoZXJlIGFjdHVhbGx5IGlzIGEgcmVwbCBzZXQgaGVyZS4gSWYgbm90LCBvcGxvZ1xuICAgIC8vIHRhaWxpbmcgd29uJ3QgZXZlciBmaW5kIGFueXRoaW5nIVxuICAgIC8vIE1vcmUgb24gdGhlIGlzTWFzdGVyRG9jXG4gICAgLy8gaHR0cHM6Ly9kb2NzLm1vbmdvZGIuY29tL21hbnVhbC9yZWZlcmVuY2UvY29tbWFuZC9pc01hc3Rlci9cbiAgICB2YXIgZiA9IG5ldyBGdXR1cmU7XG4gICAgc2VsZi5fb3Bsb2dMYXN0RW50cnlDb25uZWN0aW9uLmRiLmFkbWluKCkuY29tbWFuZChcbiAgICAgIHsgaXNtYXN0ZXI6IDEgfSwgZi5yZXNvbHZlcigpKTtcbiAgICB2YXIgaXNNYXN0ZXJEb2MgPSBmLndhaXQoKTtcblxuICAgIGlmICghKGlzTWFzdGVyRG9jICYmIGlzTWFzdGVyRG9jLnNldE5hbWUpKSB7XG4gICAgICB0aHJvdyBFcnJvcihcIiRNT05HT19PUExPR19VUkwgbXVzdCBiZSBzZXQgdG8gdGhlICdsb2NhbCcgZGF0YWJhc2Ugb2YgXCIgK1xuICAgICAgICAgICAgICAgICAgXCJhIE1vbmdvIHJlcGxpY2Egc2V0XCIpO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIGxhc3Qgb3Bsb2cgZW50cnkuXG4gICAgdmFyIGxhc3RPcGxvZ0VudHJ5ID0gc2VsZi5fb3Bsb2dMYXN0RW50cnlDb25uZWN0aW9uLmZpbmRPbmUoXG4gICAgICBPUExPR19DT0xMRUNUSU9OLCB7fSwge3NvcnQ6IHskbmF0dXJhbDogLTF9LCBmaWVsZHM6IHt0czogMX19KTtcblxuICAgIHZhciBvcGxvZ1NlbGVjdG9yID0gXy5jbG9uZShzZWxmLl9iYXNlT3Bsb2dTZWxlY3Rvcik7XG4gICAgaWYgKGxhc3RPcGxvZ0VudHJ5KSB7XG4gICAgICAvLyBTdGFydCBhZnRlciB0aGUgbGFzdCBlbnRyeSB0aGF0IGN1cnJlbnRseSBleGlzdHMuXG4gICAgICBvcGxvZ1NlbGVjdG9yLnRzID0geyRndDogbGFzdE9wbG9nRW50cnkudHN9O1xuICAgICAgLy8gSWYgdGhlcmUgYXJlIGFueSBjYWxscyB0byBjYWxsV2hlblByb2Nlc3NlZExhdGVzdCBiZWZvcmUgYW55IG90aGVyXG4gICAgICAvLyBvcGxvZyBlbnRyaWVzIHNob3cgdXAsIGFsbG93IGNhbGxXaGVuUHJvY2Vzc2VkTGF0ZXN0IHRvIGNhbGwgaXRzXG4gICAgICAvLyBjYWxsYmFjayBpbW1lZGlhdGVseS5cbiAgICAgIHNlbGYuX2xhc3RQcm9jZXNzZWRUUyA9IGxhc3RPcGxvZ0VudHJ5LnRzO1xuICAgIH1cblxuICAgIHZhciBjdXJzb3JEZXNjcmlwdGlvbiA9IG5ldyBDdXJzb3JEZXNjcmlwdGlvbihcbiAgICAgIE9QTE9HX0NPTExFQ1RJT04sIG9wbG9nU2VsZWN0b3IsIHt0YWlsYWJsZTogdHJ1ZX0pO1xuXG4gICAgc2VsZi5fdGFpbEhhbmRsZSA9IHNlbGYuX29wbG9nVGFpbENvbm5lY3Rpb24udGFpbChcbiAgICAgIGN1cnNvckRlc2NyaXB0aW9uLCBmdW5jdGlvbiAoZG9jKSB7XG4gICAgICAgIHNlbGYuX2VudHJ5UXVldWUucHVzaChkb2MpO1xuICAgICAgICBzZWxmLl9tYXliZVN0YXJ0V29ya2VyKCk7XG4gICAgICB9XG4gICAgKTtcbiAgICBzZWxmLl9yZWFkeUZ1dHVyZS5yZXR1cm4oKTtcbiAgfSxcblxuICBfbWF5YmVTdGFydFdvcmtlcjogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fd29ya2VyQWN0aXZlKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX3dvcmtlckFjdGl2ZSA9IHRydWU7XG4gICAgTWV0ZW9yLmRlZmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdoaWxlICghIHNlbGYuX3N0b3BwZWQgJiYgISBzZWxmLl9lbnRyeVF1ZXVlLmlzRW1wdHkoKSkge1xuICAgICAgICAgIC8vIEFyZSB3ZSB0b28gZmFyIGJlaGluZD8gSnVzdCB0ZWxsIG91ciBvYnNlcnZlcnMgdGhhdCB0aGV5IG5lZWQgdG9cbiAgICAgICAgICAvLyByZXBvbGwsIGFuZCBkcm9wIG91ciBxdWV1ZS5cbiAgICAgICAgICBpZiAoc2VsZi5fZW50cnlRdWV1ZS5sZW5ndGggPiBUT09fRkFSX0JFSElORCkge1xuICAgICAgICAgICAgdmFyIGxhc3RFbnRyeSA9IHNlbGYuX2VudHJ5UXVldWUucG9wKCk7XG4gICAgICAgICAgICBzZWxmLl9lbnRyeVF1ZXVlLmNsZWFyKCk7XG5cbiAgICAgICAgICAgIHNlbGYuX29uU2tpcHBlZEVudHJpZXNIb29rLmVhY2goZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIC8vIEZyZWUgYW55IHdhaXRVbnRpbENhdWdodFVwKCkgY2FsbHMgdGhhdCB3ZXJlIHdhaXRpbmcgZm9yIHVzIHRvXG4gICAgICAgICAgICAvLyBwYXNzIHNvbWV0aGluZyB0aGF0IHdlIGp1c3Qgc2tpcHBlZC5cbiAgICAgICAgICAgIHNlbGYuX3NldExhc3RQcm9jZXNzZWRUUyhsYXN0RW50cnkudHMpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdmFyIGRvYyA9IHNlbGYuX2VudHJ5UXVldWUuc2hpZnQoKTtcblxuICAgICAgICAgIGlmICghKGRvYy5ucyAmJiBkb2MubnMubGVuZ3RoID4gc2VsZi5fZGJOYW1lLmxlbmd0aCArIDEgJiZcbiAgICAgICAgICAgICAgICBkb2MubnMuc3Vic3RyKDAsIHNlbGYuX2RiTmFtZS5sZW5ndGggKyAxKSA9PT1cbiAgICAgICAgICAgICAgICAoc2VsZi5fZGJOYW1lICsgJy4nKSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIlVuZXhwZWN0ZWQgbnNcIik7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdmFyIHRyaWdnZXIgPSB7Y29sbGVjdGlvbjogZG9jLm5zLnN1YnN0cihzZWxmLl9kYk5hbWUubGVuZ3RoICsgMSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgZHJvcENvbGxlY3Rpb246IGZhbHNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgIGRyb3BEYXRhYmFzZTogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgb3A6IGRvY307XG5cbiAgICAgICAgICAvLyBJcyBpdCBhIHNwZWNpYWwgY29tbWFuZCBhbmQgdGhlIGNvbGxlY3Rpb24gbmFtZSBpcyBoaWRkZW4gc29tZXdoZXJlXG4gICAgICAgICAgLy8gaW4gb3BlcmF0b3I/XG4gICAgICAgICAgaWYgKHRyaWdnZXIuY29sbGVjdGlvbiA9PT0gXCIkY21kXCIpIHtcbiAgICAgICAgICAgIGlmIChkb2Muby5kcm9wRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgZGVsZXRlIHRyaWdnZXIuY29sbGVjdGlvbjtcbiAgICAgICAgICAgICAgdHJpZ2dlci5kcm9wRGF0YWJhc2UgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmhhcyhkb2MubywgJ2Ryb3AnKSkge1xuICAgICAgICAgICAgICB0cmlnZ2VyLmNvbGxlY3Rpb24gPSBkb2Muby5kcm9wO1xuICAgICAgICAgICAgICB0cmlnZ2VyLmRyb3BDb2xsZWN0aW9uID0gdHJ1ZTtcbiAgICAgICAgICAgICAgdHJpZ2dlci5pZCA9IG51bGw7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBFcnJvcihcIlVua25vd24gY29tbWFuZCBcIiArIEpTT04uc3RyaW5naWZ5KGRvYykpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBBbGwgb3RoZXIgb3BzIGhhdmUgYW4gaWQuXG4gICAgICAgICAgICB0cmlnZ2VyLmlkID0gaWRGb3JPcChkb2MpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHNlbGYuX2Nyb3NzYmFyLmZpcmUodHJpZ2dlcik7XG5cbiAgICAgICAgICAvLyBOb3cgdGhhdCB3ZSd2ZSBwcm9jZXNzZWQgdGhpcyBvcGVyYXRpb24sIHByb2Nlc3MgcGVuZGluZ1xuICAgICAgICAgIC8vIHNlcXVlbmNlcnMuXG4gICAgICAgICAgaWYgKCFkb2MudHMpXG4gICAgICAgICAgICB0aHJvdyBFcnJvcihcIm9wbG9nIGVudHJ5IHdpdGhvdXQgdHM6IFwiICsgRUpTT04uc3RyaW5naWZ5KGRvYykpO1xuICAgICAgICAgIHNlbGYuX3NldExhc3RQcm9jZXNzZWRUUyhkb2MudHMpO1xuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBzZWxmLl93b3JrZXJBY3RpdmUgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcbiAgX3NldExhc3RQcm9jZXNzZWRUUzogZnVuY3Rpb24gKHRzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX2xhc3RQcm9jZXNzZWRUUyA9IHRzO1xuICAgIHdoaWxlICghXy5pc0VtcHR5KHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzKSAmJiBzZWxmLl9jYXRjaGluZ1VwRnV0dXJlc1swXS50cy5sZXNzVGhhbk9yRXF1YWwoc2VsZi5fbGFzdFByb2Nlc3NlZFRTKSkge1xuICAgICAgdmFyIHNlcXVlbmNlciA9IHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzLnNoaWZ0KCk7XG4gICAgICBzZXF1ZW5jZXIuZnV0dXJlLnJldHVybigpO1xuICAgIH1cbiAgfSxcblxuICAvL01ldGhvZHMgdXNlZCBvbiB0ZXN0cyB0byBkaW5hbWljYWxseSBjaGFuZ2UgVE9PX0ZBUl9CRUhJTkRcbiAgX2RlZmluZVRvb0ZhckJlaGluZDogZnVuY3Rpb24odmFsdWUpIHtcbiAgICBUT09fRkFSX0JFSElORCA9IHZhbHVlO1xuICB9LFxuICBfcmVzZXRUb29GYXJCZWhpbmQ6IGZ1bmN0aW9uKCkge1xuICAgIFRPT19GQVJfQkVISU5EID0gcHJvY2Vzcy5lbnYuTUVURU9SX09QTE9HX1RPT19GQVJfQkVISU5EIHx8IDIwMDA7XG4gIH1cbn0pO1xuIiwidmFyIEZ1dHVyZSA9IE5wbS5yZXF1aXJlKCdmaWJlcnMvZnV0dXJlJyk7XG5cbk9ic2VydmVNdWx0aXBsZXhlciA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBpZiAoIW9wdGlvbnMgfHwgIV8uaGFzKG9wdGlvbnMsICdvcmRlcmVkJykpXG4gICAgdGhyb3cgRXJyb3IoXCJtdXN0IHNwZWNpZmllZCBvcmRlcmVkXCIpO1xuXG4gIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1tdWx0aXBsZXhlcnNcIiwgMSk7XG5cbiAgc2VsZi5fb3JkZXJlZCA9IG9wdGlvbnMub3JkZXJlZDtcbiAgc2VsZi5fb25TdG9wID0gb3B0aW9ucy5vblN0b3AgfHwgZnVuY3Rpb24gKCkge307XG4gIHNlbGYuX3F1ZXVlID0gbmV3IE1ldGVvci5fU3luY2hyb25vdXNRdWV1ZSgpO1xuICBzZWxmLl9oYW5kbGVzID0ge307XG4gIHNlbGYuX3JlYWR5RnV0dXJlID0gbmV3IEZ1dHVyZTtcbiAgc2VsZi5fY2FjaGUgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9DYWNoaW5nQ2hhbmdlT2JzZXJ2ZXIoe1xuICAgIG9yZGVyZWQ6IG9wdGlvbnMub3JkZXJlZH0pO1xuICAvLyBOdW1iZXIgb2YgYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzIHRhc2tzIHNjaGVkdWxlZCBidXQgbm90IHlldFxuICAvLyBydW5uaW5nLiByZW1vdmVIYW5kbGUgdXNlcyB0aGlzIHRvIGtub3cgaWYgaXQncyB0aW1lIHRvIGNhbGwgdGhlIG9uU3RvcFxuICAvLyBjYWxsYmFjay5cbiAgc2VsZi5fYWRkSGFuZGxlVGFza3NTY2hlZHVsZWRCdXROb3RQZXJmb3JtZWQgPSAwO1xuXG4gIF8uZWFjaChzZWxmLmNhbGxiYWNrTmFtZXMoKSwgZnVuY3Rpb24gKGNhbGxiYWNrTmFtZSkge1xuICAgIHNlbGZbY2FsbGJhY2tOYW1lXSA9IGZ1bmN0aW9uICgvKiAuLi4gKi8pIHtcbiAgICAgIHNlbGYuX2FwcGx5Q2FsbGJhY2soY2FsbGJhY2tOYW1lLCBfLnRvQXJyYXkoYXJndW1lbnRzKSk7XG4gICAgfTtcbiAgfSk7XG59O1xuXG5fLmV4dGVuZChPYnNlcnZlTXVsdGlwbGV4ZXIucHJvdG90eXBlLCB7XG4gIGFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkczogZnVuY3Rpb24gKGhhbmRsZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIC8vIENoZWNrIHRoaXMgYmVmb3JlIGNhbGxpbmcgcnVuVGFzayAoZXZlbiB0aG91Z2ggcnVuVGFzayBkb2VzIHRoZSBzYW1lXG4gICAgLy8gY2hlY2spIHNvIHRoYXQgd2UgZG9uJ3QgbGVhayBhbiBPYnNlcnZlTXVsdGlwbGV4ZXIgb24gZXJyb3IgYnlcbiAgICAvLyBpbmNyZW1lbnRpbmcgX2FkZEhhbmRsZVRhc2tzU2NoZWR1bGVkQnV0Tm90UGVyZm9ybWVkIGFuZCBuZXZlclxuICAgIC8vIGRlY3JlbWVudGluZyBpdC5cbiAgICBpZiAoIXNlbGYuX3F1ZXVlLnNhZmVUb1J1blRhc2soKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbid0IGNhbGwgb2JzZXJ2ZUNoYW5nZXMgZnJvbSBhbiBvYnNlcnZlIGNhbGxiYWNrIG9uIHRoZSBzYW1lIHF1ZXJ5XCIpO1xuICAgICsrc2VsZi5fYWRkSGFuZGxlVGFza3NTY2hlZHVsZWRCdXROb3RQZXJmb3JtZWQ7XG5cbiAgICBQYWNrYWdlWydmYWN0cy1iYXNlJ10gJiYgUGFja2FnZVsnZmFjdHMtYmFzZSddLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1oYW5kbGVzXCIsIDEpO1xuXG4gICAgc2VsZi5fcXVldWUucnVuVGFzayhmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9oYW5kbGVzW2hhbmRsZS5faWRdID0gaGFuZGxlO1xuICAgICAgLy8gU2VuZCBvdXQgd2hhdGV2ZXIgYWRkcyB3ZSBoYXZlIHNvIGZhciAod2hldGhlciBvciBub3Qgd2UgdGhlXG4gICAgICAvLyBtdWx0aXBsZXhlciBpcyByZWFkeSkuXG4gICAgICBzZWxmLl9zZW5kQWRkcyhoYW5kbGUpO1xuICAgICAgLS1zZWxmLl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZDtcbiAgICB9KTtcbiAgICAvLyAqb3V0c2lkZSogdGhlIHRhc2ssIHNpbmNlIG90aGVyd2lzZSB3ZSdkIGRlYWRsb2NrXG4gICAgc2VsZi5fcmVhZHlGdXR1cmUud2FpdCgpO1xuICB9LFxuXG4gIC8vIFJlbW92ZSBhbiBvYnNlcnZlIGhhbmRsZS4gSWYgaXQgd2FzIHRoZSBsYXN0IG9ic2VydmUgaGFuZGxlLCBjYWxsIHRoZVxuICAvLyBvblN0b3AgY2FsbGJhY2s7IHlvdSBjYW5ub3QgYWRkIGFueSBtb3JlIG9ic2VydmUgaGFuZGxlcyBhZnRlciB0aGlzLlxuICAvL1xuICAvLyBUaGlzIGlzIG5vdCBzeW5jaHJvbml6ZWQgd2l0aCBwb2xscyBhbmQgaGFuZGxlIGFkZGl0aW9uczogdGhpcyBtZWFucyB0aGF0XG4gIC8vIHlvdSBjYW4gc2FmZWx5IGNhbGwgaXQgZnJvbSB3aXRoaW4gYW4gb2JzZXJ2ZSBjYWxsYmFjaywgYnV0IGl0IGFsc28gbWVhbnNcbiAgLy8gdGhhdCB3ZSBoYXZlIHRvIGJlIGNhcmVmdWwgd2hlbiB3ZSBpdGVyYXRlIG92ZXIgX2hhbmRsZXMuXG4gIHJlbW92ZUhhbmRsZTogZnVuY3Rpb24gKGlkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgLy8gVGhpcyBzaG91bGQgbm90IGJlIHBvc3NpYmxlOiB5b3UgY2FuIG9ubHkgY2FsbCByZW1vdmVIYW5kbGUgYnkgaGF2aW5nXG4gICAgLy8gYWNjZXNzIHRvIHRoZSBPYnNlcnZlSGFuZGxlLCB3aGljaCBpc24ndCByZXR1cm5lZCB0byB1c2VyIGNvZGUgdW50aWwgdGhlXG4gICAgLy8gbXVsdGlwbGV4IGlzIHJlYWR5LlxuICAgIGlmICghc2VsZi5fcmVhZHkoKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbid0IHJlbW92ZSBoYW5kbGVzIHVudGlsIHRoZSBtdWx0aXBsZXggaXMgcmVhZHlcIik7XG5cbiAgICBkZWxldGUgc2VsZi5faGFuZGxlc1tpZF07XG5cbiAgICBQYWNrYWdlWydmYWN0cy1iYXNlJ10gJiYgUGFja2FnZVsnZmFjdHMtYmFzZSddLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1oYW5kbGVzXCIsIC0xKTtcblxuICAgIGlmIChfLmlzRW1wdHkoc2VsZi5faGFuZGxlcykgJiZcbiAgICAgICAgc2VsZi5fYWRkSGFuZGxlVGFza3NTY2hlZHVsZWRCdXROb3RQZXJmb3JtZWQgPT09IDApIHtcbiAgICAgIHNlbGYuX3N0b3AoKTtcbiAgICB9XG4gIH0sXG4gIF9zdG9wOiBmdW5jdGlvbiAob3B0aW9ucykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICAgIC8vIEl0IHNob3VsZG4ndCBiZSBwb3NzaWJsZSBmb3IgdXMgdG8gc3RvcCB3aGVuIGFsbCBvdXIgaGFuZGxlcyBzdGlsbFxuICAgIC8vIGhhdmVuJ3QgYmVlbiByZXR1cm5lZCBmcm9tIG9ic2VydmVDaGFuZ2VzIVxuICAgIGlmICghIHNlbGYuX3JlYWR5KCkgJiYgISBvcHRpb25zLmZyb21RdWVyeUVycm9yKVxuICAgICAgdGhyb3cgRXJyb3IoXCJzdXJwcmlzaW5nIF9zdG9wOiBub3QgcmVhZHlcIik7XG5cbiAgICAvLyBDYWxsIHN0b3AgY2FsbGJhY2sgKHdoaWNoIGtpbGxzIHRoZSB1bmRlcmx5aW5nIHByb2Nlc3Mgd2hpY2ggc2VuZHMgdXNcbiAgICAvLyBjYWxsYmFja3MgYW5kIHJlbW92ZXMgdXMgZnJvbSB0aGUgY29ubmVjdGlvbidzIGRpY3Rpb25hcnkpLlxuICAgIHNlbGYuX29uU3RvcCgpO1xuICAgIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLW11bHRpcGxleGVyc1wiLCAtMSk7XG5cbiAgICAvLyBDYXVzZSBmdXR1cmUgYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzIGNhbGxzIHRvIHRocm93IChidXQgdGhlIG9uU3RvcFxuICAgIC8vIGNhbGxiYWNrIHNob3VsZCBtYWtlIG91ciBjb25uZWN0aW9uIGZvcmdldCBhYm91dCB1cykuXG4gICAgc2VsZi5faGFuZGxlcyA9IG51bGw7XG4gIH0sXG5cbiAgLy8gQWxsb3dzIGFsbCBhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMgY2FsbHMgdG8gcmV0dXJuLCBvbmNlIGFsbCBwcmVjZWRpbmdcbiAgLy8gYWRkcyBoYXZlIGJlZW4gcHJvY2Vzc2VkLiBEb2VzIG5vdCBibG9jay5cbiAgcmVhZHk6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fcXVldWUucXVldWVUYXNrKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLl9yZWFkeSgpKVxuICAgICAgICB0aHJvdyBFcnJvcihcImNhbid0IG1ha2UgT2JzZXJ2ZU11bHRpcGxleCByZWFkeSB0d2ljZSFcIik7XG4gICAgICBzZWxmLl9yZWFkeUZ1dHVyZS5yZXR1cm4oKTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBJZiB0cnlpbmcgdG8gZXhlY3V0ZSB0aGUgcXVlcnkgcmVzdWx0cyBpbiBhbiBlcnJvciwgY2FsbCB0aGlzLiBUaGlzIGlzXG4gIC8vIGludGVuZGVkIGZvciBwZXJtYW5lbnQgZXJyb3JzLCBub3QgdHJhbnNpZW50IG5ldHdvcmsgZXJyb3JzIHRoYXQgY291bGQgYmVcbiAgLy8gZml4ZWQuIEl0IHNob3VsZCBvbmx5IGJlIGNhbGxlZCBiZWZvcmUgcmVhZHkoKSwgYmVjYXVzZSBpZiB5b3UgY2FsbGVkIHJlYWR5XG4gIC8vIHRoYXQgbWVhbnQgdGhhdCB5b3UgbWFuYWdlZCB0byBydW4gdGhlIHF1ZXJ5IG9uY2UuIEl0IHdpbGwgc3RvcCB0aGlzXG4gIC8vIE9ic2VydmVNdWx0aXBsZXggYW5kIGNhdXNlIGFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkcyBjYWxscyAoYW5kIHRodXNcbiAgLy8gb2JzZXJ2ZUNoYW5nZXMgY2FsbHMpIHRvIHRocm93IHRoZSBlcnJvci5cbiAgcXVlcnlFcnJvcjogZnVuY3Rpb24gKGVycikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBzZWxmLl9xdWV1ZS5ydW5UYXNrKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLl9yZWFkeSgpKVxuICAgICAgICB0aHJvdyBFcnJvcihcImNhbid0IGNsYWltIHF1ZXJ5IGhhcyBhbiBlcnJvciBhZnRlciBpdCB3b3JrZWQhXCIpO1xuICAgICAgc2VsZi5fc3RvcCh7ZnJvbVF1ZXJ5RXJyb3I6IHRydWV9KTtcbiAgICAgIHNlbGYuX3JlYWR5RnV0dXJlLnRocm93KGVycik7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gQ2FsbHMgXCJjYlwiIG9uY2UgdGhlIGVmZmVjdHMgb2YgYWxsIFwicmVhZHlcIiwgXCJhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHNcIlxuICAvLyBhbmQgb2JzZXJ2ZSBjYWxsYmFja3Mgd2hpY2ggY2FtZSBiZWZvcmUgdGhpcyBjYWxsIGhhdmUgYmVlbiBwcm9wYWdhdGVkIHRvXG4gIC8vIGFsbCBoYW5kbGVzLiBcInJlYWR5XCIgbXVzdCBoYXZlIGFscmVhZHkgYmVlbiBjYWxsZWQgb24gdGhpcyBtdWx0aXBsZXhlci5cbiAgb25GbHVzaDogZnVuY3Rpb24gKGNiKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX3F1ZXVlLnF1ZXVlVGFzayhmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoIXNlbGYuX3JlYWR5KCkpXG4gICAgICAgIHRocm93IEVycm9yKFwib25seSBjYWxsIG9uRmx1c2ggb24gYSBtdWx0aXBsZXhlciB0aGF0IHdpbGwgYmUgcmVhZHlcIik7XG4gICAgICBjYigpO1xuICAgIH0pO1xuICB9LFxuICBjYWxsYmFja05hbWVzOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9vcmRlcmVkKVxuICAgICAgcmV0dXJuIFtcImFkZGVkQmVmb3JlXCIsIFwiY2hhbmdlZFwiLCBcIm1vdmVkQmVmb3JlXCIsIFwicmVtb3ZlZFwiXTtcbiAgICBlbHNlXG4gICAgICByZXR1cm4gW1wiYWRkZWRcIiwgXCJjaGFuZ2VkXCIsIFwicmVtb3ZlZFwiXTtcbiAgfSxcbiAgX3JlYWR5OiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMuX3JlYWR5RnV0dXJlLmlzUmVzb2x2ZWQoKTtcbiAgfSxcbiAgX2FwcGx5Q2FsbGJhY2s6IGZ1bmN0aW9uIChjYWxsYmFja05hbWUsIGFyZ3MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fcXVldWUucXVldWVUYXNrKGZ1bmN0aW9uICgpIHtcbiAgICAgIC8vIElmIHdlIHN0b3BwZWQgaW4gdGhlIG1lYW50aW1lLCBkbyBub3RoaW5nLlxuICAgICAgaWYgKCFzZWxmLl9oYW5kbGVzKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIC8vIEZpcnN0LCBhcHBseSB0aGUgY2hhbmdlIHRvIHRoZSBjYWNoZS5cbiAgICAgIC8vIFhYWCBXZSBjb3VsZCBtYWtlIGFwcGx5Q2hhbmdlIGNhbGxiYWNrcyBwcm9taXNlIG5vdCB0byBoYW5nIG9uIHRvIGFueVxuICAgICAgLy8gc3RhdGUgZnJvbSB0aGVpciBhcmd1bWVudHMgKGFzc3VtaW5nIHRoYXQgdGhlaXIgc3VwcGxpZWQgY2FsbGJhY2tzXG4gICAgICAvLyBkb24ndCkgYW5kIHNraXAgdGhpcyBjbG9uZS4gQ3VycmVudGx5ICdjaGFuZ2VkJyBoYW5ncyBvbiB0byBzdGF0ZVxuICAgICAgLy8gdGhvdWdoLlxuICAgICAgc2VsZi5fY2FjaGUuYXBwbHlDaGFuZ2VbY2FsbGJhY2tOYW1lXS5hcHBseShudWxsLCBFSlNPTi5jbG9uZShhcmdzKSk7XG5cbiAgICAgIC8vIElmIHdlIGhhdmVuJ3QgZmluaXNoZWQgdGhlIGluaXRpYWwgYWRkcywgdGhlbiB3ZSBzaG91bGQgb25seSBiZSBnZXR0aW5nXG4gICAgICAvLyBhZGRzLlxuICAgICAgaWYgKCFzZWxmLl9yZWFkeSgpICYmXG4gICAgICAgICAgKGNhbGxiYWNrTmFtZSAhPT0gJ2FkZGVkJyAmJiBjYWxsYmFja05hbWUgIT09ICdhZGRlZEJlZm9yZScpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkdvdCBcIiArIGNhbGxiYWNrTmFtZSArIFwiIGR1cmluZyBpbml0aWFsIGFkZHNcIik7XG4gICAgICB9XG5cbiAgICAgIC8vIE5vdyBtdWx0aXBsZXggdGhlIGNhbGxiYWNrcyBvdXQgdG8gYWxsIG9ic2VydmUgaGFuZGxlcy4gSXQncyBPSyBpZlxuICAgICAgLy8gdGhlc2UgY2FsbHMgeWllbGQ7IHNpbmNlIHdlJ3JlIGluc2lkZSBhIHRhc2ssIG5vIG90aGVyIHVzZSBvZiBvdXIgcXVldWVcbiAgICAgIC8vIGNhbiBjb250aW51ZSB1bnRpbCB0aGVzZSBhcmUgZG9uZS4gKEJ1dCB3ZSBkbyBoYXZlIHRvIGJlIGNhcmVmdWwgdG8gbm90XG4gICAgICAvLyB1c2UgYSBoYW5kbGUgdGhhdCBnb3QgcmVtb3ZlZCwgYmVjYXVzZSByZW1vdmVIYW5kbGUgZG9lcyBub3QgdXNlIHRoZVxuICAgICAgLy8gcXVldWU7IHRodXMsIHdlIGl0ZXJhdGUgb3ZlciBhbiBhcnJheSBvZiBrZXlzIHRoYXQgd2UgY29udHJvbC4pXG4gICAgICBfLmVhY2goXy5rZXlzKHNlbGYuX2hhbmRsZXMpLCBmdW5jdGlvbiAoaGFuZGxlSWQpIHtcbiAgICAgICAgdmFyIGhhbmRsZSA9IHNlbGYuX2hhbmRsZXMgJiYgc2VsZi5faGFuZGxlc1toYW5kbGVJZF07XG4gICAgICAgIGlmICghaGFuZGxlKVxuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgdmFyIGNhbGxiYWNrID0gaGFuZGxlWydfJyArIGNhbGxiYWNrTmFtZV07XG4gICAgICAgIC8vIGNsb25lIGFyZ3VtZW50cyBzbyB0aGF0IGNhbGxiYWNrcyBjYW4gbXV0YXRlIHRoZWlyIGFyZ3VtZW50c1xuICAgICAgICBjYWxsYmFjayAmJiBjYWxsYmFjay5hcHBseShudWxsLCBFSlNPTi5jbG9uZShhcmdzKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBTZW5kcyBpbml0aWFsIGFkZHMgdG8gYSBoYW5kbGUuIEl0IHNob3VsZCBvbmx5IGJlIGNhbGxlZCBmcm9tIHdpdGhpbiBhIHRhc2tcbiAgLy8gKHRoZSB0YXNrIHRoYXQgaXMgcHJvY2Vzc2luZyB0aGUgYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzIGNhbGwpLiBJdFxuICAvLyBzeW5jaHJvbm91c2x5IGludm9rZXMgdGhlIGhhbmRsZSdzIGFkZGVkIG9yIGFkZGVkQmVmb3JlOyB0aGVyZSdzIG5vIG5lZWQgdG9cbiAgLy8gZmx1c2ggdGhlIHF1ZXVlIGFmdGVyd2FyZHMgdG8gZW5zdXJlIHRoYXQgdGhlIGNhbGxiYWNrcyBnZXQgb3V0LlxuICBfc2VuZEFkZHM6IGZ1bmN0aW9uIChoYW5kbGUpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3F1ZXVlLnNhZmVUb1J1blRhc2soKSlcbiAgICAgIHRocm93IEVycm9yKFwiX3NlbmRBZGRzIG1heSBvbmx5IGJlIGNhbGxlZCBmcm9tIHdpdGhpbiBhIHRhc2shXCIpO1xuICAgIHZhciBhZGQgPSBzZWxmLl9vcmRlcmVkID8gaGFuZGxlLl9hZGRlZEJlZm9yZSA6IGhhbmRsZS5fYWRkZWQ7XG4gICAgaWYgKCFhZGQpXG4gICAgICByZXR1cm47XG4gICAgLy8gbm90ZTogZG9jcyBtYXkgYmUgYW4gX0lkTWFwIG9yIGFuIE9yZGVyZWREaWN0XG4gICAgc2VsZi5fY2FjaGUuZG9jcy5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICBpZiAoIV8uaGFzKHNlbGYuX2hhbmRsZXMsIGhhbmRsZS5faWQpKVxuICAgICAgICB0aHJvdyBFcnJvcihcImhhbmRsZSBnb3QgcmVtb3ZlZCBiZWZvcmUgc2VuZGluZyBpbml0aWFsIGFkZHMhXCIpO1xuICAgICAgdmFyIGZpZWxkcyA9IEVKU09OLmNsb25lKGRvYyk7XG4gICAgICBkZWxldGUgZmllbGRzLl9pZDtcbiAgICAgIGlmIChzZWxmLl9vcmRlcmVkKVxuICAgICAgICBhZGQoaWQsIGZpZWxkcywgbnVsbCk7IC8vIHdlJ3JlIGdvaW5nIGluIG9yZGVyLCBzbyBhZGQgYXQgZW5kXG4gICAgICBlbHNlXG4gICAgICAgIGFkZChpZCwgZmllbGRzKTtcbiAgICB9KTtcbiAgfVxufSk7XG5cblxudmFyIG5leHRPYnNlcnZlSGFuZGxlSWQgPSAxO1xuT2JzZXJ2ZUhhbmRsZSA9IGZ1bmN0aW9uIChtdWx0aXBsZXhlciwgY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgLy8gVGhlIGVuZCB1c2VyIGlzIG9ubHkgc3VwcG9zZWQgdG8gY2FsbCBzdG9wKCkuICBUaGUgb3RoZXIgZmllbGRzIGFyZVxuICAvLyBhY2Nlc3NpYmxlIHRvIHRoZSBtdWx0aXBsZXhlciwgdGhvdWdoLlxuICBzZWxmLl9tdWx0aXBsZXhlciA9IG11bHRpcGxleGVyO1xuICBfLmVhY2gobXVsdGlwbGV4ZXIuY2FsbGJhY2tOYW1lcygpLCBmdW5jdGlvbiAobmFtZSkge1xuICAgIGlmIChjYWxsYmFja3NbbmFtZV0pIHtcbiAgICAgIHNlbGZbJ18nICsgbmFtZV0gPSBjYWxsYmFja3NbbmFtZV07XG4gICAgfSBlbHNlIGlmIChuYW1lID09PSBcImFkZGVkQmVmb3JlXCIgJiYgY2FsbGJhY2tzLmFkZGVkKSB7XG4gICAgICAvLyBTcGVjaWFsIGNhc2U6IGlmIHlvdSBzcGVjaWZ5IFwiYWRkZWRcIiBhbmQgXCJtb3ZlZEJlZm9yZVwiLCB5b3UgZ2V0IGFuXG4gICAgICAvLyBvcmRlcmVkIG9ic2VydmUgd2hlcmUgZm9yIHNvbWUgcmVhc29uIHlvdSBkb24ndCBnZXQgb3JkZXJpbmcgZGF0YSBvblxuICAgICAgLy8gdGhlIGFkZHMuICBJIGR1bm5vLCB3ZSB3cm90ZSB0ZXN0cyBmb3IgaXQsIHRoZXJlIG11c3QgaGF2ZSBiZWVuIGFcbiAgICAgIC8vIHJlYXNvbi5cbiAgICAgIHNlbGYuX2FkZGVkQmVmb3JlID0gZnVuY3Rpb24gKGlkLCBmaWVsZHMsIGJlZm9yZSkge1xuICAgICAgICBjYWxsYmFja3MuYWRkZWQoaWQsIGZpZWxkcyk7XG4gICAgICB9O1xuICAgIH1cbiAgfSk7XG4gIHNlbGYuX3N0b3BwZWQgPSBmYWxzZTtcbiAgc2VsZi5faWQgPSBuZXh0T2JzZXJ2ZUhhbmRsZUlkKys7XG59O1xuT2JzZXJ2ZUhhbmRsZS5wcm90b3R5cGUuc3RvcCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICByZXR1cm47XG4gIHNlbGYuX3N0b3BwZWQgPSB0cnVlO1xuICBzZWxmLl9tdWx0aXBsZXhlci5yZW1vdmVIYW5kbGUoc2VsZi5faWQpO1xufTtcbiIsInZhciBGaWJlciA9IE5wbS5yZXF1aXJlKCdmaWJlcnMnKTtcbnZhciBGdXR1cmUgPSBOcG0ucmVxdWlyZSgnZmliZXJzL2Z1dHVyZScpO1xuXG5Eb2NGZXRjaGVyID0gZnVuY3Rpb24gKG1vbmdvQ29ubmVjdGlvbikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYuX21vbmdvQ29ubmVjdGlvbiA9IG1vbmdvQ29ubmVjdGlvbjtcbiAgLy8gTWFwIGZyb20gY2FjaGUga2V5IC0+IFtjYWxsYmFja11cbiAgc2VsZi5fY2FsbGJhY2tzRm9yQ2FjaGVLZXkgPSB7fTtcbn07XG5cbl8uZXh0ZW5kKERvY0ZldGNoZXIucHJvdG90eXBlLCB7XG4gIC8vIEZldGNoZXMgZG9jdW1lbnQgXCJpZFwiIGZyb20gY29sbGVjdGlvbk5hbWUsIHJldHVybmluZyBpdCBvciBudWxsIGlmIG5vdFxuICAvLyBmb3VuZC5cbiAgLy9cbiAgLy8gSWYgeW91IG1ha2UgbXVsdGlwbGUgY2FsbHMgdG8gZmV0Y2goKSB3aXRoIHRoZSBzYW1lIGNhY2hlS2V5IChhIHN0cmluZyksXG4gIC8vIERvY0ZldGNoZXIgbWF5IGFzc3VtZSB0aGF0IHRoZXkgYWxsIHJldHVybiB0aGUgc2FtZSBkb2N1bWVudC4gKEl0IGRvZXNcbiAgLy8gbm90IGNoZWNrIHRvIHNlZSBpZiBjb2xsZWN0aW9uTmFtZS9pZCBtYXRjaC4pXG4gIC8vXG4gIC8vIFlvdSBtYXkgYXNzdW1lIHRoYXQgY2FsbGJhY2sgaXMgbmV2ZXIgY2FsbGVkIHN5bmNocm9ub3VzbHkgKGFuZCBpbiBmYWN0XG4gIC8vIE9wbG9nT2JzZXJ2ZURyaXZlciBkb2VzIHNvKS5cbiAgZmV0Y2g6IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgaWQsIGNhY2hlS2V5LCBjYWxsYmFjaykge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIGNoZWNrKGNvbGxlY3Rpb25OYW1lLCBTdHJpbmcpO1xuICAgIC8vIGlkIGlzIHNvbWUgc29ydCBvZiBzY2FsYXJcbiAgICBjaGVjayhjYWNoZUtleSwgU3RyaW5nKTtcblxuICAgIC8vIElmIHRoZXJlJ3MgYWxyZWFkeSBhbiBpbi1wcm9ncmVzcyBmZXRjaCBmb3IgdGhpcyBjYWNoZSBrZXksIHlpZWxkIHVudGlsXG4gICAgLy8gaXQncyBkb25lIGFuZCByZXR1cm4gd2hhdGV2ZXIgaXQgcmV0dXJucy5cbiAgICBpZiAoXy5oYXMoc2VsZi5fY2FsbGJhY2tzRm9yQ2FjaGVLZXksIGNhY2hlS2V5KSkge1xuICAgICAgc2VsZi5fY2FsbGJhY2tzRm9yQ2FjaGVLZXlbY2FjaGVLZXldLnB1c2goY2FsbGJhY2spO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHZhciBjYWxsYmFja3MgPSBzZWxmLl9jYWxsYmFja3NGb3JDYWNoZUtleVtjYWNoZUtleV0gPSBbY2FsbGJhY2tdO1xuXG4gICAgRmliZXIoZnVuY3Rpb24gKCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdmFyIGRvYyA9IHNlbGYuX21vbmdvQ29ubmVjdGlvbi5maW5kT25lKFxuICAgICAgICAgIGNvbGxlY3Rpb25OYW1lLCB7X2lkOiBpZH0pIHx8IG51bGw7XG4gICAgICAgIC8vIFJldHVybiBkb2MgdG8gYWxsIHJlbGV2YW50IGNhbGxiYWNrcy4gTm90ZSB0aGF0IHRoaXMgYXJyYXkgY2FuXG4gICAgICAgIC8vIGNvbnRpbnVlIHRvIGdyb3cgZHVyaW5nIGNhbGxiYWNrIGV4Y2VjdXRpb24uXG4gICAgICAgIHdoaWxlICghXy5pc0VtcHR5KGNhbGxiYWNrcykpIHtcbiAgICAgICAgICAvLyBDbG9uZSB0aGUgZG9jdW1lbnQgc28gdGhhdCB0aGUgdmFyaW91cyBjYWxscyB0byBmZXRjaCBkb24ndCByZXR1cm5cbiAgICAgICAgICAvLyBvYmplY3RzIHRoYXQgYXJlIGludGVydHdpbmdsZWQgd2l0aCBlYWNoIG90aGVyLiBDbG9uZSBiZWZvcmVcbiAgICAgICAgICAvLyBwb3BwaW5nIHRoZSBmdXR1cmUsIHNvIHRoYXQgaWYgY2xvbmUgdGhyb3dzLCB0aGUgZXJyb3IgZ2V0cyBwYXNzZWRcbiAgICAgICAgICAvLyB0byB0aGUgbmV4dCBjYWxsYmFjay5cbiAgICAgICAgICB2YXIgY2xvbmVkRG9jID0gRUpTT04uY2xvbmUoZG9jKTtcbiAgICAgICAgICBjYWxsYmFja3MucG9wKCkobnVsbCwgY2xvbmVkRG9jKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB3aGlsZSAoIV8uaXNFbXB0eShjYWxsYmFja3MpKSB7XG4gICAgICAgICAgY2FsbGJhY2tzLnBvcCgpKGUpO1xuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICAvLyBYWFggY29uc2lkZXIga2VlcGluZyB0aGUgZG9jIGFyb3VuZCBmb3IgYSBwZXJpb2Qgb2YgdGltZSBiZWZvcmVcbiAgICAgICAgLy8gcmVtb3ZpbmcgZnJvbSB0aGUgY2FjaGVcbiAgICAgICAgZGVsZXRlIHNlbGYuX2NhbGxiYWNrc0ZvckNhY2hlS2V5W2NhY2hlS2V5XTtcbiAgICAgIH1cbiAgICB9KS5ydW4oKTtcbiAgfVxufSk7XG5cbk1vbmdvVGVzdC5Eb2NGZXRjaGVyID0gRG9jRmV0Y2hlcjtcbiIsIlBvbGxpbmdPYnNlcnZlRHJpdmVyID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uID0gb3B0aW9ucy5jdXJzb3JEZXNjcmlwdGlvbjtcbiAgc2VsZi5fbW9uZ29IYW5kbGUgPSBvcHRpb25zLm1vbmdvSGFuZGxlO1xuICBzZWxmLl9vcmRlcmVkID0gb3B0aW9ucy5vcmRlcmVkO1xuICBzZWxmLl9tdWx0aXBsZXhlciA9IG9wdGlvbnMubXVsdGlwbGV4ZXI7XG4gIHNlbGYuX3N0b3BDYWxsYmFja3MgPSBbXTtcbiAgc2VsZi5fc3RvcHBlZCA9IGZhbHNlO1xuXG4gIHNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yID0gc2VsZi5fbW9uZ29IYW5kbGUuX2NyZWF0ZVN5bmNocm9ub3VzQ3Vyc29yKFxuICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKTtcblxuICAvLyBwcmV2aW91cyByZXN1bHRzIHNuYXBzaG90LiAgb24gZWFjaCBwb2xsIGN5Y2xlLCBkaWZmcyBhZ2FpbnN0XG4gIC8vIHJlc3VsdHMgZHJpdmVzIHRoZSBjYWxsYmFja3MuXG4gIHNlbGYuX3Jlc3VsdHMgPSBudWxsO1xuXG4gIC8vIFRoZSBudW1iZXIgb2YgX3BvbGxNb25nbyBjYWxscyB0aGF0IGhhdmUgYmVlbiBhZGRlZCB0byBzZWxmLl90YXNrUXVldWUgYnV0XG4gIC8vIGhhdmUgbm90IHN0YXJ0ZWQgcnVubmluZy4gVXNlZCB0byBtYWtlIHN1cmUgd2UgbmV2ZXIgc2NoZWR1bGUgbW9yZSB0aGFuIG9uZVxuICAvLyBfcG9sbE1vbmdvIChvdGhlciB0aGFuIHBvc3NpYmx5IHRoZSBvbmUgdGhhdCBpcyBjdXJyZW50bHkgcnVubmluZykuIEl0J3NcbiAgLy8gYWxzbyB1c2VkIGJ5IF9zdXNwZW5kUG9sbGluZyB0byBwcmV0ZW5kIHRoZXJlJ3MgYSBwb2xsIHNjaGVkdWxlZC4gVXN1YWxseSxcbiAgLy8gaXQncyBlaXRoZXIgMCAoZm9yIFwibm8gcG9sbHMgc2NoZWR1bGVkIG90aGVyIHRoYW4gbWF5YmUgb25lIGN1cnJlbnRseVxuICAvLyBydW5uaW5nXCIpIG9yIDEgKGZvciBcImEgcG9sbCBzY2hlZHVsZWQgdGhhdCBpc24ndCBydW5uaW5nIHlldFwiKSwgYnV0IGl0IGNhblxuICAvLyBhbHNvIGJlIDIgaWYgaW5jcmVtZW50ZWQgYnkgX3N1c3BlbmRQb2xsaW5nLlxuICBzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgPSAwO1xuICBzZWxmLl9wZW5kaW5nV3JpdGVzID0gW107IC8vIHBlb3BsZSB0byBub3RpZnkgd2hlbiBwb2xsaW5nIGNvbXBsZXRlc1xuXG4gIC8vIE1ha2Ugc3VyZSB0byBjcmVhdGUgYSBzZXBhcmF0ZWx5IHRocm90dGxlZCBmdW5jdGlvbiBmb3IgZWFjaFxuICAvLyBQb2xsaW5nT2JzZXJ2ZURyaXZlciBvYmplY3QuXG4gIHNlbGYuX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCA9IF8udGhyb3R0bGUoXG4gICAgc2VsZi5fdW50aHJvdHRsZWRFbnN1cmVQb2xsSXNTY2hlZHVsZWQsXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5wb2xsaW5nVGhyb3R0bGVNcyB8fCA1MCAvKiBtcyAqLyk7XG5cbiAgLy8gWFhYIGZpZ3VyZSBvdXQgaWYgd2Ugc3RpbGwgbmVlZCBhIHF1ZXVlXG4gIHNlbGYuX3Rhc2tRdWV1ZSA9IG5ldyBNZXRlb3IuX1N5bmNocm9ub3VzUXVldWUoKTtcblxuICB2YXIgbGlzdGVuZXJzSGFuZGxlID0gbGlzdGVuQWxsKFxuICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLCBmdW5jdGlvbiAobm90aWZpY2F0aW9uKSB7XG4gICAgICAvLyBXaGVuIHNvbWVvbmUgZG9lcyBhIHRyYW5zYWN0aW9uIHRoYXQgbWlnaHQgYWZmZWN0IHVzLCBzY2hlZHVsZSBhIHBvbGxcbiAgICAgIC8vIG9mIHRoZSBkYXRhYmFzZS4gSWYgdGhhdCB0cmFuc2FjdGlvbiBoYXBwZW5zIGluc2lkZSBvZiBhIHdyaXRlIGZlbmNlLFxuICAgICAgLy8gYmxvY2sgdGhlIGZlbmNlIHVudGlsIHdlJ3ZlIHBvbGxlZCBhbmQgbm90aWZpZWQgb2JzZXJ2ZXJzLlxuICAgICAgdmFyIGZlbmNlID0gRERQU2VydmVyLl9DdXJyZW50V3JpdGVGZW5jZS5nZXQoKTtcbiAgICAgIGlmIChmZW5jZSlcbiAgICAgICAgc2VsZi5fcGVuZGluZ1dyaXRlcy5wdXNoKGZlbmNlLmJlZ2luV3JpdGUoKSk7XG4gICAgICAvLyBFbnN1cmUgYSBwb2xsIGlzIHNjaGVkdWxlZC4uLiBidXQgaWYgd2UgYWxyZWFkeSBrbm93IHRoYXQgb25lIGlzLFxuICAgICAgLy8gZG9uJ3QgaGl0IHRoZSB0aHJvdHRsZWQgX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCBmdW5jdGlvbiAod2hpY2ggbWlnaHRcbiAgICAgIC8vIGxlYWQgdG8gdXMgY2FsbGluZyBpdCB1bm5lY2Vzc2FyaWx5IGluIDxwb2xsaW5nVGhyb3R0bGVNcz4gbXMpLlxuICAgICAgaWYgKHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCA9PT0gMClcbiAgICAgICAgc2VsZi5fZW5zdXJlUG9sbElzU2NoZWR1bGVkKCk7XG4gICAgfVxuICApO1xuICBzZWxmLl9zdG9wQ2FsbGJhY2tzLnB1c2goZnVuY3Rpb24gKCkgeyBsaXN0ZW5lcnNIYW5kbGUuc3RvcCgpOyB9KTtcblxuICAvLyBldmVyeSBvbmNlIGFuZCBhIHdoaWxlLCBwb2xsIGV2ZW4gaWYgd2UgZG9uJ3QgdGhpbmsgd2UncmUgZGlydHksIGZvclxuICAvLyBldmVudHVhbCBjb25zaXN0ZW5jeSB3aXRoIGRhdGFiYXNlIHdyaXRlcyBmcm9tIG91dHNpZGUgdGhlIE1ldGVvclxuICAvLyB1bml2ZXJzZS5cbiAgLy9cbiAgLy8gRm9yIHRlc3RpbmcsIHRoZXJlJ3MgYW4gdW5kb2N1bWVudGVkIGNhbGxiYWNrIGFyZ3VtZW50IHRvIG9ic2VydmVDaGFuZ2VzXG4gIC8vIHdoaWNoIGRpc2FibGVzIHRpbWUtYmFzZWQgcG9sbGluZyBhbmQgZ2V0cyBjYWxsZWQgYXQgdGhlIGJlZ2lubmluZyBvZiBlYWNoXG4gIC8vIHBvbGwuXG4gIGlmIChvcHRpb25zLl90ZXN0T25seVBvbGxDYWxsYmFjaykge1xuICAgIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrID0gb3B0aW9ucy5fdGVzdE9ubHlQb2xsQ2FsbGJhY2s7XG4gIH0gZWxzZSB7XG4gICAgdmFyIHBvbGxpbmdJbnRlcnZhbCA9XG4gICAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5wb2xsaW5nSW50ZXJ2YWxNcyB8fFxuICAgICAgICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMuX3BvbGxpbmdJbnRlcnZhbCB8fCAvLyBDT01QQVQgd2l0aCAxLjJcbiAgICAgICAgICAxMCAqIDEwMDA7XG4gICAgdmFyIGludGVydmFsSGFuZGxlID0gTWV0ZW9yLnNldEludGVydmFsKFxuICAgICAgXy5iaW5kKHNlbGYuX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCwgc2VsZiksIHBvbGxpbmdJbnRlcnZhbCk7XG4gICAgc2VsZi5fc3RvcENhbGxiYWNrcy5wdXNoKGZ1bmN0aW9uICgpIHtcbiAgICAgIE1ldGVvci5jbGVhckludGVydmFsKGludGVydmFsSGFuZGxlKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB3ZSBhY3R1YWxseSBwb2xsIHNvb24hXG4gIHNlbGYuX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkKCk7XG5cbiAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtcG9sbGluZ1wiLCAxKTtcbn07XG5cbl8uZXh0ZW5kKFBvbGxpbmdPYnNlcnZlRHJpdmVyLnByb3RvdHlwZSwge1xuICAvLyBUaGlzIGlzIGFsd2F5cyBjYWxsZWQgdGhyb3VnaCBfLnRocm90dGxlIChleGNlcHQgb25jZSBhdCBzdGFydHVwKS5cbiAgX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgPiAwKVxuICAgICAgcmV0dXJuO1xuICAgICsrc2VsZi5fcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkO1xuICAgIHNlbGYuX3Rhc2tRdWV1ZS5xdWV1ZVRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcG9sbE1vbmdvKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gdGVzdC1vbmx5IGludGVyZmFjZSBmb3IgY29udHJvbGxpbmcgcG9sbGluZy5cbiAgLy9cbiAgLy8gX3N1c3BlbmRQb2xsaW5nIGJsb2NrcyB1bnRpbCBhbnkgY3VycmVudGx5IHJ1bm5pbmcgYW5kIHNjaGVkdWxlZCBwb2xscyBhcmVcbiAgLy8gZG9uZSwgYW5kIHByZXZlbnRzIGFueSBmdXJ0aGVyIHBvbGxzIGZyb20gYmVpbmcgc2NoZWR1bGVkLiAobmV3XG4gIC8vIE9ic2VydmVIYW5kbGVzIGNhbiBiZSBhZGRlZCBhbmQgcmVjZWl2ZSB0aGVpciBpbml0aWFsIGFkZGVkIGNhbGxiYWNrcyxcbiAgLy8gdGhvdWdoLilcbiAgLy9cbiAgLy8gX3Jlc3VtZVBvbGxpbmcgaW1tZWRpYXRlbHkgcG9sbHMsIGFuZCBhbGxvd3MgZnVydGhlciBwb2xscyB0byBvY2N1ci5cbiAgX3N1c3BlbmRQb2xsaW5nOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gUHJldGVuZCB0aGF0IHRoZXJlJ3MgYW5vdGhlciBwb2xsIHNjaGVkdWxlZCAod2hpY2ggd2lsbCBwcmV2ZW50XG4gICAgLy8gX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCBmcm9tIHF1ZXVlaW5nIGFueSBtb3JlIHBvbGxzKS5cbiAgICArK3NlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZDtcbiAgICAvLyBOb3cgYmxvY2sgdW50aWwgYWxsIGN1cnJlbnRseSBydW5uaW5nIG9yIHNjaGVkdWxlZCBwb2xscyBhcmUgZG9uZS5cbiAgICBzZWxmLl90YXNrUXVldWUucnVuVGFzayhmdW5jdGlvbigpIHt9KTtcblxuICAgIC8vIENvbmZpcm0gdGhhdCB0aGVyZSBpcyBvbmx5IG9uZSBcInBvbGxcIiAodGhlIGZha2Ugb25lIHdlJ3JlIHByZXRlbmRpbmcgdG9cbiAgICAvLyBoYXZlKSBzY2hlZHVsZWQuXG4gICAgaWYgKHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCAhPT0gMSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgaXMgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgIHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCk7XG4gIH0sXG4gIF9yZXN1bWVQb2xsaW5nOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gV2Ugc2hvdWxkIGJlIGluIHRoZSBzYW1lIHN0YXRlIGFzIGluIHRoZSBlbmQgb2YgX3N1c3BlbmRQb2xsaW5nLlxuICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgIT09IDEpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJfcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkIGlzIFwiICtcbiAgICAgICAgICAgICAgICAgICAgICBzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQpO1xuICAgIC8vIFJ1biBhIHBvbGwgc3luY2hyb25vdXNseSAod2hpY2ggd2lsbCBjb3VudGVyYWN0IHRoZVxuICAgIC8vICsrX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCBmcm9tIF9zdXNwZW5kUG9sbGluZykuXG4gICAgc2VsZi5fdGFza1F1ZXVlLnJ1blRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcG9sbE1vbmdvKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgX3BvbGxNb25nbzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAtLXNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZDtcblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuXG4gICAgdmFyIGZpcnN0ID0gZmFsc2U7XG4gICAgdmFyIG5ld1Jlc3VsdHM7XG4gICAgdmFyIG9sZFJlc3VsdHMgPSBzZWxmLl9yZXN1bHRzO1xuICAgIGlmICghb2xkUmVzdWx0cykge1xuICAgICAgZmlyc3QgPSB0cnVlO1xuICAgICAgLy8gWFhYIG1heWJlIHVzZSBPcmRlcmVkRGljdCBpbnN0ZWFkP1xuICAgICAgb2xkUmVzdWx0cyA9IHNlbGYuX29yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIH1cblxuICAgIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrICYmIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrKCk7XG5cbiAgICAvLyBTYXZlIHRoZSBsaXN0IG9mIHBlbmRpbmcgd3JpdGVzIHdoaWNoIHRoaXMgcm91bmQgd2lsbCBjb21taXQuXG4gICAgdmFyIHdyaXRlc0ZvckN5Y2xlID0gc2VsZi5fcGVuZGluZ1dyaXRlcztcbiAgICBzZWxmLl9wZW5kaW5nV3JpdGVzID0gW107XG5cbiAgICAvLyBHZXQgdGhlIG5ldyBxdWVyeSByZXN1bHRzLiAoVGhpcyB5aWVsZHMuKVxuICAgIHRyeSB7XG4gICAgICBuZXdSZXN1bHRzID0gc2VsZi5fc3luY2hyb25vdXNDdXJzb3IuZ2V0UmF3T2JqZWN0cyhzZWxmLl9vcmRlcmVkKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZmlyc3QgJiYgdHlwZW9mKGUuY29kZSkgPT09ICdudW1iZXInKSB7XG4gICAgICAgIC8vIFRoaXMgaXMgYW4gZXJyb3IgZG9jdW1lbnQgc2VudCB0byB1cyBieSBtb25nb2QsIG5vdCBhIGNvbm5lY3Rpb25cbiAgICAgICAgLy8gZXJyb3IgZ2VuZXJhdGVkIGJ5IHRoZSBjbGllbnQuIEFuZCB3ZSd2ZSBuZXZlciBzZWVuIHRoaXMgcXVlcnkgd29ya1xuICAgICAgICAvLyBzdWNjZXNzZnVsbHkuIFByb2JhYmx5IGl0J3MgYSBiYWQgc2VsZWN0b3Igb3Igc29tZXRoaW5nLCBzbyB3ZSBzaG91bGRcbiAgICAgICAgLy8gTk9UIHJldHJ5LiBJbnN0ZWFkLCB3ZSBzaG91bGQgaGFsdCB0aGUgb2JzZXJ2ZSAod2hpY2ggZW5kcyB1cCBjYWxsaW5nXG4gICAgICAgIC8vIGBzdG9wYCBvbiB1cykuXG4gICAgICAgIHNlbGYuX211bHRpcGxleGVyLnF1ZXJ5RXJyb3IoXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJFeGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeSBcIiArXG4gICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKSArIFwiOiBcIiArIGUubWVzc2FnZSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIGdldFJhd09iamVjdHMgY2FuIHRocm93IGlmIHdlJ3JlIGhhdmluZyB0cm91YmxlIHRhbGtpbmcgdG8gdGhlXG4gICAgICAvLyBkYXRhYmFzZS4gIFRoYXQncyBmaW5lIC0tLSB3ZSB3aWxsIHJlcG9sbCBsYXRlciBhbnl3YXkuIEJ1dCB3ZSBzaG91bGRcbiAgICAgIC8vIG1ha2Ugc3VyZSBub3QgdG8gbG9zZSB0cmFjayBvZiB0aGlzIGN5Y2xlJ3Mgd3JpdGVzLlxuICAgICAgLy8gKEl0IGFsc28gY2FuIHRocm93IGlmIHRoZXJlJ3MganVzdCBzb21ldGhpbmcgaW52YWxpZCBhYm91dCB0aGlzIHF1ZXJ5O1xuICAgICAgLy8gdW5mb3J0dW5hdGVseSB0aGUgT2JzZXJ2ZURyaXZlciBBUEkgZG9lc24ndCBwcm92aWRlIGEgZ29vZCB3YXkgdG9cbiAgICAgIC8vIFwiY2FuY2VsXCIgdGhlIG9ic2VydmUgZnJvbSB0aGUgaW5zaWRlIGluIHRoaXMgY2FzZS5cbiAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KHNlbGYuX3BlbmRpbmdXcml0ZXMsIHdyaXRlc0ZvckN5Y2xlKTtcbiAgICAgIE1ldGVvci5fZGVidWcoXCJFeGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeSBcIiArXG4gICAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKSArIFwiOiBcIiArIGUuc3RhY2spO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFJ1biBkaWZmcy5cbiAgICBpZiAoIXNlbGYuX3N0b3BwZWQpIHtcbiAgICAgIExvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5Q2hhbmdlcyhcbiAgICAgICAgc2VsZi5fb3JkZXJlZCwgb2xkUmVzdWx0cywgbmV3UmVzdWx0cywgc2VsZi5fbXVsdGlwbGV4ZXIpO1xuICAgIH1cblxuICAgIC8vIFNpZ25hbHMgdGhlIG11bHRpcGxleGVyIHRvIGFsbG93IGFsbCBvYnNlcnZlQ2hhbmdlcyBjYWxscyB0aGF0IHNoYXJlIHRoaXNcbiAgICAvLyBtdWx0aXBsZXhlciB0byByZXR1cm4uIChUaGlzIGhhcHBlbnMgYXN5bmNocm9ub3VzbHksIHZpYSB0aGVcbiAgICAvLyBtdWx0aXBsZXhlcidzIHF1ZXVlLilcbiAgICBpZiAoZmlyc3QpXG4gICAgICBzZWxmLl9tdWx0aXBsZXhlci5yZWFkeSgpO1xuXG4gICAgLy8gUmVwbGFjZSBzZWxmLl9yZXN1bHRzIGF0b21pY2FsbHkuICAoVGhpcyBhc3NpZ25tZW50IGlzIHdoYXQgbWFrZXMgYGZpcnN0YFxuICAgIC8vIHN0YXkgdGhyb3VnaCBvbiB0aGUgbmV4dCBjeWNsZSwgc28gd2UndmUgd2FpdGVkIHVudGlsIGFmdGVyIHdlJ3ZlXG4gICAgLy8gY29tbWl0dGVkIHRvIHJlYWR5LWluZyB0aGUgbXVsdGlwbGV4ZXIuKVxuICAgIHNlbGYuX3Jlc3VsdHMgPSBuZXdSZXN1bHRzO1xuXG4gICAgLy8gT25jZSB0aGUgT2JzZXJ2ZU11bHRpcGxleGVyIGhhcyBwcm9jZXNzZWQgZXZlcnl0aGluZyB3ZSd2ZSBkb25lIGluIHRoaXNcbiAgICAvLyByb3VuZCwgbWFyayBhbGwgdGhlIHdyaXRlcyB3aGljaCBleGlzdGVkIGJlZm9yZSB0aGlzIGNhbGwgYXNcbiAgICAvLyBjb21tbWl0dGVkLiAoSWYgbmV3IHdyaXRlcyBoYXZlIHNob3duIHVwIGluIHRoZSBtZWFudGltZSwgdGhlcmUnbGxcbiAgICAvLyBhbHJlYWR5IGJlIGFub3RoZXIgX3BvbGxNb25nbyB0YXNrIHNjaGVkdWxlZC4pXG4gICAgc2VsZi5fbXVsdGlwbGV4ZXIub25GbHVzaChmdW5jdGlvbiAoKSB7XG4gICAgICBfLmVhY2god3JpdGVzRm9yQ3ljbGUsIGZ1bmN0aW9uICh3KSB7XG4gICAgICAgIHcuY29tbWl0dGVkKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX3N0b3BwZWQgPSB0cnVlO1xuICAgIF8uZWFjaChzZWxmLl9zdG9wQ2FsbGJhY2tzLCBmdW5jdGlvbiAoYykgeyBjKCk7IH0pO1xuICAgIC8vIFJlbGVhc2UgYW55IHdyaXRlIGZlbmNlcyB0aGF0IGFyZSB3YWl0aW5nIG9uIHVzLlxuICAgIF8uZWFjaChzZWxmLl9wZW5kaW5nV3JpdGVzLCBmdW5jdGlvbiAodykge1xuICAgICAgdy5jb21taXR0ZWQoKTtcbiAgICB9KTtcbiAgICBQYWNrYWdlWydmYWN0cy1iYXNlJ10gJiYgUGFja2FnZVsnZmFjdHMtYmFzZSddLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1kcml2ZXJzLXBvbGxpbmdcIiwgLTEpO1xuICB9XG59KTtcbiIsInZhciBGdXR1cmUgPSBOcG0ucmVxdWlyZSgnZmliZXJzL2Z1dHVyZScpO1xuXG52YXIgUEhBU0UgPSB7XG4gIFFVRVJZSU5HOiBcIlFVRVJZSU5HXCIsXG4gIEZFVENISU5HOiBcIkZFVENISU5HXCIsXG4gIFNURUFEWTogXCJTVEVBRFlcIlxufTtcblxuLy8gRXhjZXB0aW9uIHRocm93biBieSBfbmVlZFRvUG9sbFF1ZXJ5IHdoaWNoIHVucm9sbHMgdGhlIHN0YWNrIHVwIHRvIHRoZVxuLy8gZW5jbG9zaW5nIGNhbGwgdG8gZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkuXG52YXIgU3dpdGNoZWRUb1F1ZXJ5ID0gZnVuY3Rpb24gKCkge307XG52YXIgZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkgPSBmdW5jdGlvbiAoZikge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHRyeSB7XG4gICAgICBmLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKCEoZSBpbnN0YW5jZW9mIFN3aXRjaGVkVG9RdWVyeSkpXG4gICAgICAgIHRocm93IGU7XG4gICAgfVxuICB9O1xufTtcblxudmFyIGN1cnJlbnRJZCA9IDA7XG5cbi8vIE9wbG9nT2JzZXJ2ZURyaXZlciBpcyBhbiBhbHRlcm5hdGl2ZSB0byBQb2xsaW5nT2JzZXJ2ZURyaXZlciB3aGljaCBmb2xsb3dzXG4vLyB0aGUgTW9uZ28gb3BlcmF0aW9uIGxvZyBpbnN0ZWFkIG9mIGp1c3QgcmUtcG9sbGluZyB0aGUgcXVlcnkuIEl0IG9iZXlzIHRoZVxuLy8gc2FtZSBzaW1wbGUgaW50ZXJmYWNlOiBjb25zdHJ1Y3RpbmcgaXQgc3RhcnRzIHNlbmRpbmcgb2JzZXJ2ZUNoYW5nZXNcbi8vIGNhbGxiYWNrcyAoYW5kIGEgcmVhZHkoKSBpbnZvY2F0aW9uKSB0byB0aGUgT2JzZXJ2ZU11bHRpcGxleGVyLCBhbmQgeW91IHN0b3Bcbi8vIGl0IGJ5IGNhbGxpbmcgdGhlIHN0b3AoKSBtZXRob2QuXG5PcGxvZ09ic2VydmVEcml2ZXIgPSBmdW5jdGlvbiAob3B0aW9ucykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYuX3VzZXNPcGxvZyA9IHRydWU7ICAvLyB0ZXN0cyBsb29rIGF0IHRoaXNcblxuICBzZWxmLl9pZCA9IGN1cnJlbnRJZDtcbiAgY3VycmVudElkKys7XG5cbiAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24gPSBvcHRpb25zLmN1cnNvckRlc2NyaXB0aW9uO1xuICBzZWxmLl9tb25nb0hhbmRsZSA9IG9wdGlvbnMubW9uZ29IYW5kbGU7XG4gIHNlbGYuX211bHRpcGxleGVyID0gb3B0aW9ucy5tdWx0aXBsZXhlcjtcblxuICBpZiAob3B0aW9ucy5vcmRlcmVkKSB7XG4gICAgdGhyb3cgRXJyb3IoXCJPcGxvZ09ic2VydmVEcml2ZXIgb25seSBzdXBwb3J0cyB1bm9yZGVyZWQgb2JzZXJ2ZUNoYW5nZXNcIik7XG4gIH1cblxuICB2YXIgc29ydGVyID0gb3B0aW9ucy5zb3J0ZXI7XG4gIC8vIFdlIGRvbid0IHN1cHBvcnQgJG5lYXIgYW5kIG90aGVyIGdlby1xdWVyaWVzIHNvIGl0J3MgT0sgdG8gaW5pdGlhbGl6ZSB0aGVcbiAgLy8gY29tcGFyYXRvciBvbmx5IG9uY2UgaW4gdGhlIGNvbnN0cnVjdG9yLlxuICB2YXIgY29tcGFyYXRvciA9IHNvcnRlciAmJiBzb3J0ZXIuZ2V0Q29tcGFyYXRvcigpO1xuXG4gIGlmIChvcHRpb25zLmN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMubGltaXQpIHtcbiAgICAvLyBUaGVyZSBhcmUgc2V2ZXJhbCBwcm9wZXJ0aWVzIG9yZGVyZWQgZHJpdmVyIGltcGxlbWVudHM6XG4gICAgLy8gLSBfbGltaXQgaXMgYSBwb3NpdGl2ZSBudW1iZXJcbiAgICAvLyAtIF9jb21wYXJhdG9yIGlzIGEgZnVuY3Rpb24tY29tcGFyYXRvciBieSB3aGljaCB0aGUgcXVlcnkgaXMgb3JkZXJlZFxuICAgIC8vIC0gX3VucHVibGlzaGVkQnVmZmVyIGlzIG5vbi1udWxsIE1pbi9NYXggSGVhcCxcbiAgICAvLyAgICAgICAgICAgICAgICAgICAgICB0aGUgZW1wdHkgYnVmZmVyIGluIFNURUFEWSBwaGFzZSBpbXBsaWVzIHRoYXQgdGhlXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgZXZlcnl0aGluZyB0aGF0IG1hdGNoZXMgdGhlIHF1ZXJpZXMgc2VsZWN0b3IgZml0c1xuICAgIC8vICAgICAgICAgICAgICAgICAgICAgIGludG8gcHVibGlzaGVkIHNldC5cbiAgICAvLyAtIF9wdWJsaXNoZWQgLSBNaW4gSGVhcCAoYWxzbyBpbXBsZW1lbnRzIElkTWFwIG1ldGhvZHMpXG5cbiAgICB2YXIgaGVhcE9wdGlvbnMgPSB7IElkTWFwOiBMb2NhbENvbGxlY3Rpb24uX0lkTWFwIH07XG4gICAgc2VsZi5fbGltaXQgPSBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLmxpbWl0O1xuICAgIHNlbGYuX2NvbXBhcmF0b3IgPSBjb21wYXJhdG9yO1xuICAgIHNlbGYuX3NvcnRlciA9IHNvcnRlcjtcbiAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlciA9IG5ldyBNaW5NYXhIZWFwKGNvbXBhcmF0b3IsIGhlYXBPcHRpb25zKTtcbiAgICAvLyBXZSBuZWVkIHNvbWV0aGluZyB0aGF0IGNhbiBmaW5kIE1heCB2YWx1ZSBpbiBhZGRpdGlvbiB0byBJZE1hcCBpbnRlcmZhY2VcbiAgICBzZWxmLl9wdWJsaXNoZWQgPSBuZXcgTWF4SGVhcChjb21wYXJhdG9yLCBoZWFwT3B0aW9ucyk7XG4gIH0gZWxzZSB7XG4gICAgc2VsZi5fbGltaXQgPSAwO1xuICAgIHNlbGYuX2NvbXBhcmF0b3IgPSBudWxsO1xuICAgIHNlbGYuX3NvcnRlciA9IG51bGw7XG4gICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIgPSBudWxsO1xuICAgIHNlbGYuX3B1Ymxpc2hlZCA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICB9XG5cbiAgLy8gSW5kaWNhdGVzIGlmIGl0IGlzIHNhZmUgdG8gaW5zZXJ0IGEgbmV3IGRvY3VtZW50IGF0IHRoZSBlbmQgb2YgdGhlIGJ1ZmZlclxuICAvLyBmb3IgdGhpcyBxdWVyeS4gaS5lLiBpdCBpcyBrbm93biB0aGF0IHRoZXJlIGFyZSBubyBkb2N1bWVudHMgbWF0Y2hpbmcgdGhlXG4gIC8vIHNlbGVjdG9yIHRob3NlIGFyZSBub3QgaW4gcHVibGlzaGVkIG9yIGJ1ZmZlci5cbiAgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyID0gZmFsc2U7XG5cbiAgc2VsZi5fc3RvcHBlZCA9IGZhbHNlO1xuICBzZWxmLl9zdG9wSGFuZGxlcyA9IFtdO1xuXG4gIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXSAmJiBQYWNrYWdlWydmYWN0cy1iYXNlJ10uRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1kcml2ZXJzLW9wbG9nXCIsIDEpO1xuXG4gIHNlbGYuX3JlZ2lzdGVyUGhhc2VDaGFuZ2UoUEhBU0UuUVVFUllJTkcpO1xuXG4gIHNlbGYuX21hdGNoZXIgPSBvcHRpb25zLm1hdGNoZXI7XG4gIHZhciBwcm9qZWN0aW9uID0gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5maWVsZHMgfHwge307XG4gIHNlbGYuX3Byb2plY3Rpb25GbiA9IExvY2FsQ29sbGVjdGlvbi5fY29tcGlsZVByb2plY3Rpb24ocHJvamVjdGlvbik7XG4gIC8vIFByb2plY3Rpb24gZnVuY3Rpb24sIHJlc3VsdCBvZiBjb21iaW5pbmcgaW1wb3J0YW50IGZpZWxkcyBmb3Igc2VsZWN0b3IgYW5kXG4gIC8vIGV4aXN0aW5nIGZpZWxkcyBwcm9qZWN0aW9uXG4gIHNlbGYuX3NoYXJlZFByb2plY3Rpb24gPSBzZWxmLl9tYXRjaGVyLmNvbWJpbmVJbnRvUHJvamVjdGlvbihwcm9qZWN0aW9uKTtcbiAgaWYgKHNvcnRlcilcbiAgICBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uID0gc29ydGVyLmNvbWJpbmVJbnRvUHJvamVjdGlvbihzZWxmLl9zaGFyZWRQcm9qZWN0aW9uKTtcbiAgc2VsZi5fc2hhcmVkUHJvamVjdGlvbkZuID0gTG9jYWxDb2xsZWN0aW9uLl9jb21waWxlUHJvamVjdGlvbihcbiAgICBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uKTtcblxuICBzZWxmLl9uZWVkVG9GZXRjaCA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICBzZWxmLl9jdXJyZW50bHlGZXRjaGluZyA9IG51bGw7XG4gIHNlbGYuX2ZldGNoR2VuZXJhdGlvbiA9IDA7XG5cbiAgc2VsZi5fcmVxdWVyeVdoZW5Eb25lVGhpc1F1ZXJ5ID0gZmFsc2U7XG4gIHNlbGYuX3dyaXRlc1RvQ29tbWl0V2hlbldlUmVhY2hTdGVhZHkgPSBbXTtcblxuICAvLyBJZiB0aGUgb3Bsb2cgaGFuZGxlIHRlbGxzIHVzIHRoYXQgaXQgc2tpcHBlZCBzb21lIGVudHJpZXMgKGJlY2F1c2UgaXQgZ290XG4gIC8vIGJlaGluZCwgc2F5KSwgcmUtcG9sbC5cbiAgc2VsZi5fc3RvcEhhbmRsZXMucHVzaChzZWxmLl9tb25nb0hhbmRsZS5fb3Bsb2dIYW5kbGUub25Ta2lwcGVkRW50cmllcyhcbiAgICBmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeShmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9uZWVkVG9Qb2xsUXVlcnkoKTtcbiAgICB9KVxuICApKTtcblxuICBmb3JFYWNoVHJpZ2dlcihzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiwgZnVuY3Rpb24gKHRyaWdnZXIpIHtcbiAgICBzZWxmLl9zdG9wSGFuZGxlcy5wdXNoKHNlbGYuX21vbmdvSGFuZGxlLl9vcGxvZ0hhbmRsZS5vbk9wbG9nRW50cnkoXG4gICAgICB0cmlnZ2VyLCBmdW5jdGlvbiAobm90aWZpY2F0aW9uKSB7XG4gICAgICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICB2YXIgb3AgPSBub3RpZmljYXRpb24ub3A7XG4gICAgICAgICAgaWYgKG5vdGlmaWNhdGlvbi5kcm9wQ29sbGVjdGlvbiB8fCBub3RpZmljYXRpb24uZHJvcERhdGFiYXNlKSB7XG4gICAgICAgICAgICAvLyBOb3RlOiB0aGlzIGNhbGwgaXMgbm90IGFsbG93ZWQgdG8gYmxvY2sgb24gYW55dGhpbmcgKGVzcGVjaWFsbHlcbiAgICAgICAgICAgIC8vIG9uIHdhaXRpbmcgZm9yIG9wbG9nIGVudHJpZXMgdG8gY2F0Y2ggdXApIGJlY2F1c2UgdGhhdCB3aWxsIGJsb2NrXG4gICAgICAgICAgICAvLyBvbk9wbG9nRW50cnkhXG4gICAgICAgICAgICBzZWxmLl9uZWVkVG9Qb2xsUXVlcnkoKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gQWxsIG90aGVyIG9wZXJhdG9ycyBzaG91bGQgYmUgaGFuZGxlZCBkZXBlbmRpbmcgb24gcGhhc2VcbiAgICAgICAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuUVVFUllJTkcpIHtcbiAgICAgICAgICAgICAgc2VsZi5faGFuZGxlT3Bsb2dFbnRyeVF1ZXJ5aW5nKG9wKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHNlbGYuX2hhbmRsZU9wbG9nRW50cnlTdGVhZHlPckZldGNoaW5nKG9wKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0pKTtcbiAgICAgIH1cbiAgICApKTtcbiAgfSk7XG5cbiAgLy8gWFhYIG9yZGVyaW5nIHcuci50LiBldmVyeXRoaW5nIGVsc2U/XG4gIHNlbGYuX3N0b3BIYW5kbGVzLnB1c2gobGlzdGVuQWxsKFxuICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLCBmdW5jdGlvbiAobm90aWZpY2F0aW9uKSB7XG4gICAgICAvLyBJZiB3ZSdyZSBub3QgaW4gYSBwcmUtZmlyZSB3cml0ZSBmZW5jZSwgd2UgZG9uJ3QgaGF2ZSB0byBkbyBhbnl0aGluZy5cbiAgICAgIHZhciBmZW5jZSA9IEREUFNlcnZlci5fQ3VycmVudFdyaXRlRmVuY2UuZ2V0KCk7XG4gICAgICBpZiAoIWZlbmNlIHx8IGZlbmNlLmZpcmVkKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIGlmIChmZW5jZS5fb3Bsb2dPYnNlcnZlRHJpdmVycykge1xuICAgICAgICBmZW5jZS5fb3Bsb2dPYnNlcnZlRHJpdmVyc1tzZWxmLl9pZF0gPSBzZWxmO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGZlbmNlLl9vcGxvZ09ic2VydmVEcml2ZXJzID0ge307XG4gICAgICBmZW5jZS5fb3Bsb2dPYnNlcnZlRHJpdmVyc1tzZWxmLl9pZF0gPSBzZWxmO1xuXG4gICAgICBmZW5jZS5vbkJlZm9yZUZpcmUoZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZHJpdmVycyA9IGZlbmNlLl9vcGxvZ09ic2VydmVEcml2ZXJzO1xuICAgICAgICBkZWxldGUgZmVuY2UuX29wbG9nT2JzZXJ2ZURyaXZlcnM7XG5cbiAgICAgICAgLy8gVGhpcyBmZW5jZSBjYW5ub3QgZmlyZSB1bnRpbCB3ZSd2ZSBjYXVnaHQgdXAgdG8gXCJ0aGlzIHBvaW50XCIgaW4gdGhlXG4gICAgICAgIC8vIG9wbG9nLCBhbmQgYWxsIG9ic2VydmVycyBtYWRlIGl0IGJhY2sgdG8gdGhlIHN0ZWFkeSBzdGF0ZS5cbiAgICAgICAgc2VsZi5fbW9uZ29IYW5kbGUuX29wbG9nSGFuZGxlLndhaXRVbnRpbENhdWdodFVwKCk7XG5cbiAgICAgICAgXy5lYWNoKGRyaXZlcnMsIGZ1bmN0aW9uIChkcml2ZXIpIHtcbiAgICAgICAgICBpZiAoZHJpdmVyLl9zdG9wcGVkKVxuICAgICAgICAgICAgcmV0dXJuO1xuXG4gICAgICAgICAgdmFyIHdyaXRlID0gZmVuY2UuYmVnaW5Xcml0ZSgpO1xuICAgICAgICAgIGlmIChkcml2ZXIuX3BoYXNlID09PSBQSEFTRS5TVEVBRFkpIHtcbiAgICAgICAgICAgIC8vIE1ha2Ugc3VyZSB0aGF0IGFsbCBvZiB0aGUgY2FsbGJhY2tzIGhhdmUgbWFkZSBpdCB0aHJvdWdoIHRoZVxuICAgICAgICAgICAgLy8gbXVsdGlwbGV4ZXIgYW5kIGJlZW4gZGVsaXZlcmVkIHRvIE9ic2VydmVIYW5kbGVzIGJlZm9yZSBjb21taXR0aW5nXG4gICAgICAgICAgICAvLyB3cml0ZXMuXG4gICAgICAgICAgICBkcml2ZXIuX211bHRpcGxleGVyLm9uRmx1c2goZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkcml2ZXIuX3dyaXRlc1RvQ29tbWl0V2hlbldlUmVhY2hTdGVhZHkucHVzaCh3cml0ZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgKSk7XG5cbiAgLy8gV2hlbiBNb25nbyBmYWlscyBvdmVyLCB3ZSBuZWVkIHRvIHJlcG9sbCB0aGUgcXVlcnksIGluIGNhc2Ugd2UgcHJvY2Vzc2VkIGFuXG4gIC8vIG9wbG9nIGVudHJ5IHRoYXQgZ290IHJvbGxlZCBiYWNrLlxuICBzZWxmLl9zdG9wSGFuZGxlcy5wdXNoKHNlbGYuX21vbmdvSGFuZGxlLl9vbkZhaWxvdmVyKGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5KFxuICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX25lZWRUb1BvbGxRdWVyeSgpO1xuICAgIH0pKSk7XG5cbiAgLy8gR2l2ZSBfb2JzZXJ2ZUNoYW5nZXMgYSBjaGFuY2UgdG8gYWRkIHRoZSBuZXcgT2JzZXJ2ZUhhbmRsZSB0byBvdXJcbiAgLy8gbXVsdGlwbGV4ZXIsIHNvIHRoYXQgdGhlIGFkZGVkIGNhbGxzIGdldCBzdHJlYW1lZC5cbiAgTWV0ZW9yLmRlZmVyKGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5KGZ1bmN0aW9uICgpIHtcbiAgICBzZWxmLl9ydW5Jbml0aWFsUXVlcnkoKTtcbiAgfSkpO1xufTtcblxuXy5leHRlbmQoT3Bsb2dPYnNlcnZlRHJpdmVyLnByb3RvdHlwZSwge1xuICBfYWRkUHVibGlzaGVkOiBmdW5jdGlvbiAoaWQsIGRvYykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgZmllbGRzID0gXy5jbG9uZShkb2MpO1xuICAgICAgZGVsZXRlIGZpZWxkcy5faWQ7XG4gICAgICBzZWxmLl9wdWJsaXNoZWQuc2V0KGlkLCBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uRm4oZG9jKSk7XG4gICAgICBzZWxmLl9tdWx0aXBsZXhlci5hZGRlZChpZCwgc2VsZi5fcHJvamVjdGlvbkZuKGZpZWxkcykpO1xuXG4gICAgICAvLyBBZnRlciBhZGRpbmcgdGhpcyBkb2N1bWVudCwgdGhlIHB1Ymxpc2hlZCBzZXQgbWlnaHQgYmUgb3ZlcmZsb3dlZFxuICAgICAgLy8gKGV4Y2VlZGluZyBjYXBhY2l0eSBzcGVjaWZpZWQgYnkgbGltaXQpLiBJZiBzbywgcHVzaCB0aGUgbWF4aW11bVxuICAgICAgLy8gZWxlbWVudCB0byB0aGUgYnVmZmVyLCB3ZSBtaWdodCB3YW50IHRvIHNhdmUgaXQgaW4gbWVtb3J5IHRvIHJlZHVjZSB0aGVcbiAgICAgIC8vIGFtb3VudCBvZiBNb25nbyBsb29rdXBzIGluIHRoZSBmdXR1cmUuXG4gICAgICBpZiAoc2VsZi5fbGltaXQgJiYgc2VsZi5fcHVibGlzaGVkLnNpemUoKSA+IHNlbGYuX2xpbWl0KSB7XG4gICAgICAgIC8vIFhYWCBpbiB0aGVvcnkgdGhlIHNpemUgb2YgcHVibGlzaGVkIGlzIG5vIG1vcmUgdGhhbiBsaW1pdCsxXG4gICAgICAgIGlmIChzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpICE9PSBzZWxmLl9saW1pdCArIDEpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBZnRlciBhZGRpbmcgdG8gcHVibGlzaGVkLCBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgIChzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpIC0gc2VsZi5fbGltaXQpICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgXCIgZG9jdW1lbnRzIGFyZSBvdmVyZmxvd2luZyB0aGUgc2V0XCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFyIG92ZXJmbG93aW5nRG9jSWQgPSBzZWxmLl9wdWJsaXNoZWQubWF4RWxlbWVudElkKCk7XG4gICAgICAgIHZhciBvdmVyZmxvd2luZ0RvYyA9IHNlbGYuX3B1Ymxpc2hlZC5nZXQob3ZlcmZsb3dpbmdEb2NJZCk7XG5cbiAgICAgICAgaWYgKEVKU09OLmVxdWFscyhvdmVyZmxvd2luZ0RvY0lkLCBpZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGUgZG9jdW1lbnQganVzdCBhZGRlZCBpcyBvdmVyZmxvd2luZyB0aGUgcHVibGlzaGVkIHNldFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNlbGYuX3B1Ymxpc2hlZC5yZW1vdmUob3ZlcmZsb3dpbmdEb2NJZCk7XG4gICAgICAgIHNlbGYuX211bHRpcGxleGVyLnJlbW92ZWQob3ZlcmZsb3dpbmdEb2NJZCk7XG4gICAgICAgIHNlbGYuX2FkZEJ1ZmZlcmVkKG92ZXJmbG93aW5nRG9jSWQsIG92ZXJmbG93aW5nRG9jKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcbiAgX3JlbW92ZVB1Ymxpc2hlZDogZnVuY3Rpb24gKGlkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX3B1Ymxpc2hlZC5yZW1vdmUoaWQpO1xuICAgICAgc2VsZi5fbXVsdGlwbGV4ZXIucmVtb3ZlZChpZCk7XG4gICAgICBpZiAoISBzZWxmLl9saW1pdCB8fCBzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpID09PSBzZWxmLl9saW1pdClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLnNpemUoKSA+IHNlbGYuX2xpbWl0KVxuICAgICAgICB0aHJvdyBFcnJvcihcInNlbGYuX3B1Ymxpc2hlZCBnb3QgdG9vIGJpZ1wiKTtcblxuICAgICAgLy8gT0ssIHdlIGFyZSBwdWJsaXNoaW5nIGxlc3MgdGhhbiB0aGUgbGltaXQuIE1heWJlIHdlIHNob3VsZCBsb29rIGluIHRoZVxuICAgICAgLy8gYnVmZmVyIHRvIGZpbmQgdGhlIG5leHQgZWxlbWVudCBwYXN0IHdoYXQgd2Ugd2VyZSBwdWJsaXNoaW5nIGJlZm9yZS5cblxuICAgICAgaWYgKCFzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5lbXB0eSgpKSB7XG4gICAgICAgIC8vIFRoZXJlJ3Mgc29tZXRoaW5nIGluIHRoZSBidWZmZXI7IG1vdmUgdGhlIGZpcnN0IHRoaW5nIGluIGl0IHRvXG4gICAgICAgIC8vIF9wdWJsaXNoZWQuXG4gICAgICAgIHZhciBuZXdEb2NJZCA9IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLm1pbkVsZW1lbnRJZCgpO1xuICAgICAgICB2YXIgbmV3RG9jID0gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KG5ld0RvY0lkKTtcbiAgICAgICAgc2VsZi5fcmVtb3ZlQnVmZmVyZWQobmV3RG9jSWQpO1xuICAgICAgICBzZWxmLl9hZGRQdWJsaXNoZWQobmV3RG9jSWQsIG5ld0RvYyk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gVGhlcmUncyBub3RoaW5nIGluIHRoZSBidWZmZXIuICBUaGlzIGNvdWxkIG1lYW4gb25lIG9mIGEgZmV3IHRoaW5ncy5cblxuICAgICAgLy8gKGEpIFdlIGNvdWxkIGJlIGluIHRoZSBtaWRkbGUgb2YgcmUtcnVubmluZyB0aGUgcXVlcnkgKHNwZWNpZmljYWxseSwgd2VcbiAgICAgIC8vIGNvdWxkIGJlIGluIF9wdWJsaXNoTmV3UmVzdWx0cykuIEluIHRoYXQgY2FzZSwgX3VucHVibGlzaGVkQnVmZmVyIGlzXG4gICAgICAvLyBlbXB0eSBiZWNhdXNlIHdlIGNsZWFyIGl0IGF0IHRoZSBiZWdpbm5pbmcgb2YgX3B1Ymxpc2hOZXdSZXN1bHRzLiBJblxuICAgICAgLy8gdGhpcyBjYXNlLCBvdXIgY2FsbGVyIGFscmVhZHkga25vd3MgdGhlIGVudGlyZSBhbnN3ZXIgdG8gdGhlIHF1ZXJ5IGFuZFxuICAgICAgLy8gd2UgZG9uJ3QgbmVlZCB0byBkbyBhbnl0aGluZyBmYW5jeSBoZXJlLiAgSnVzdCByZXR1cm4uXG4gICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLlFVRVJZSU5HKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIC8vIChiKSBXZSdyZSBwcmV0dHkgY29uZmlkZW50IHRoYXQgdGhlIHVuaW9uIG9mIF9wdWJsaXNoZWQgYW5kXG4gICAgICAvLyBfdW5wdWJsaXNoZWRCdWZmZXIgY29udGFpbiBhbGwgZG9jdW1lbnRzIHRoYXQgbWF0Y2ggc2VsZWN0b3IuIEJlY2F1c2VcbiAgICAgIC8vIF91bnB1Ymxpc2hlZEJ1ZmZlciBpcyBlbXB0eSwgdGhhdCBtZWFucyB3ZSdyZSBjb25maWRlbnQgdGhhdCBfcHVibGlzaGVkXG4gICAgICAvLyBjb250YWlucyBhbGwgZG9jdW1lbnRzIHRoYXQgbWF0Y2ggc2VsZWN0b3IuIFNvIHdlIGhhdmUgbm90aGluZyB0byBkby5cbiAgICAgIGlmIChzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgLy8gKGMpIE1heWJlIHRoZXJlIGFyZSBvdGhlciBkb2N1bWVudHMgb3V0IHRoZXJlIHRoYXQgc2hvdWxkIGJlIGluIG91clxuICAgICAgLy8gYnVmZmVyLiBCdXQgaW4gdGhhdCBjYXNlLCB3aGVuIHdlIGVtcHRpZWQgX3VucHVibGlzaGVkQnVmZmVyIGluXG4gICAgICAvLyBfcmVtb3ZlQnVmZmVyZWQsIHdlIHNob3VsZCBoYXZlIGNhbGxlZCBfbmVlZFRvUG9sbFF1ZXJ5LCB3aGljaCB3aWxsXG4gICAgICAvLyBlaXRoZXIgcHV0IHNvbWV0aGluZyBpbiBfdW5wdWJsaXNoZWRCdWZmZXIgb3Igc2V0IF9zYWZlQXBwZW5kVG9CdWZmZXJcbiAgICAgIC8vIChvciBib3RoKSwgYW5kIGl0IHdpbGwgcHV0IHVzIGluIFFVRVJZSU5HIGZvciB0aGF0IHdob2xlIHRpbWUuIFNvIGluXG4gICAgICAvLyBmYWN0LCB3ZSBzaG91bGRuJ3QgYmUgYWJsZSB0byBnZXQgaGVyZS5cblxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQnVmZmVyIGluZXhwbGljYWJseSBlbXB0eVwiKTtcbiAgICB9KTtcbiAgfSxcbiAgX2NoYW5nZVB1Ymxpc2hlZDogZnVuY3Rpb24gKGlkLCBvbGREb2MsIG5ld0RvYykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9wdWJsaXNoZWQuc2V0KGlkLCBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uRm4obmV3RG9jKSk7XG4gICAgICB2YXIgcHJvamVjdGVkTmV3ID0gc2VsZi5fcHJvamVjdGlvbkZuKG5ld0RvYyk7XG4gICAgICB2YXIgcHJvamVjdGVkT2xkID0gc2VsZi5fcHJvamVjdGlvbkZuKG9sZERvYyk7XG4gICAgICB2YXIgY2hhbmdlZCA9IERpZmZTZXF1ZW5jZS5tYWtlQ2hhbmdlZEZpZWxkcyhcbiAgICAgICAgcHJvamVjdGVkTmV3LCBwcm9qZWN0ZWRPbGQpO1xuICAgICAgaWYgKCFfLmlzRW1wdHkoY2hhbmdlZCkpXG4gICAgICAgIHNlbGYuX211bHRpcGxleGVyLmNoYW5nZWQoaWQsIGNoYW5nZWQpO1xuICAgIH0pO1xuICB9LFxuICBfYWRkQnVmZmVyZWQ6IGZ1bmN0aW9uIChpZCwgZG9jKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNldChpZCwgc2VsZi5fc2hhcmVkUHJvamVjdGlvbkZuKGRvYykpO1xuXG4gICAgICAvLyBJZiBzb21ldGhpbmcgaXMgb3ZlcmZsb3dpbmcgdGhlIGJ1ZmZlciwgd2UganVzdCByZW1vdmUgaXQgZnJvbSBjYWNoZVxuICAgICAgaWYgKHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSA+IHNlbGYuX2xpbWl0KSB7XG4gICAgICAgIHZhciBtYXhCdWZmZXJlZElkID0gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIubWF4RWxlbWVudElkKCk7XG5cbiAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIucmVtb3ZlKG1heEJ1ZmZlcmVkSWQpO1xuXG4gICAgICAgIC8vIFNpbmNlIHNvbWV0aGluZyBtYXRjaGluZyBpcyByZW1vdmVkIGZyb20gY2FjaGUgKGJvdGggcHVibGlzaGVkIHNldCBhbmRcbiAgICAgICAgLy8gYnVmZmVyKSwgc2V0IGZsYWcgdG8gZmFsc2VcbiAgICAgICAgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIC8vIElzIGNhbGxlZCBlaXRoZXIgdG8gcmVtb3ZlIHRoZSBkb2MgY29tcGxldGVseSBmcm9tIG1hdGNoaW5nIHNldCBvciB0byBtb3ZlXG4gIC8vIGl0IHRvIHRoZSBwdWJsaXNoZWQgc2V0IGxhdGVyLlxuICBfcmVtb3ZlQnVmZmVyZWQ6IGZ1bmN0aW9uIChpZCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5yZW1vdmUoaWQpO1xuICAgICAgLy8gVG8ga2VlcCB0aGUgY29udHJhY3QgXCJidWZmZXIgaXMgbmV2ZXIgZW1wdHkgaW4gU1RFQURZIHBoYXNlIHVubGVzcyB0aGVcbiAgICAgIC8vIGV2ZXJ5dGhpbmcgbWF0Y2hpbmcgZml0cyBpbnRvIHB1Ymxpc2hlZFwiIHRydWUsIHdlIHBvbGwgZXZlcnl0aGluZyBhc1xuICAgICAgLy8gc29vbiBhcyB3ZSBzZWUgdGhlIGJ1ZmZlciBiZWNvbWluZyBlbXB0eS5cbiAgICAgIGlmICghIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSAmJiAhIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlcilcbiAgICAgICAgc2VsZi5fbmVlZFRvUG9sbFF1ZXJ5KCk7XG4gICAgfSk7XG4gIH0sXG4gIC8vIENhbGxlZCB3aGVuIGEgZG9jdW1lbnQgaGFzIGpvaW5lZCB0aGUgXCJNYXRjaGluZ1wiIHJlc3VsdHMgc2V0LlxuICAvLyBUYWtlcyByZXNwb25zaWJpbGl0eSBvZiBrZWVwaW5nIF91bnB1Ymxpc2hlZEJ1ZmZlciBpbiBzeW5jIHdpdGggX3B1Ymxpc2hlZFxuICAvLyBhbmQgdGhlIGVmZmVjdCBvZiBsaW1pdCBlbmZvcmNlZC5cbiAgX2FkZE1hdGNoaW5nOiBmdW5jdGlvbiAoZG9jKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBpZCA9IGRvYy5faWQ7XG4gICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLmhhcyhpZCkpXG4gICAgICAgIHRocm93IEVycm9yKFwidHJpZWQgdG8gYWRkIHNvbWV0aGluZyBhbHJlYWR5IHB1Ymxpc2hlZCBcIiArIGlkKTtcbiAgICAgIGlmIChzZWxmLl9saW1pdCAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpKVxuICAgICAgICB0aHJvdyBFcnJvcihcInRyaWVkIHRvIGFkZCBzb21ldGhpbmcgYWxyZWFkeSBleGlzdGVkIGluIGJ1ZmZlciBcIiArIGlkKTtcblxuICAgICAgdmFyIGxpbWl0ID0gc2VsZi5fbGltaXQ7XG4gICAgICB2YXIgY29tcGFyYXRvciA9IHNlbGYuX2NvbXBhcmF0b3I7XG4gICAgICB2YXIgbWF4UHVibGlzaGVkID0gKGxpbWl0ICYmIHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgPiAwKSA/XG4gICAgICAgIHNlbGYuX3B1Ymxpc2hlZC5nZXQoc2VsZi5fcHVibGlzaGVkLm1heEVsZW1lbnRJZCgpKSA6IG51bGw7XG4gICAgICB2YXIgbWF4QnVmZmVyZWQgPSAobGltaXQgJiYgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpID4gMClcbiAgICAgICAgPyBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5nZXQoc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIubWF4RWxlbWVudElkKCkpXG4gICAgICAgIDogbnVsbDtcbiAgICAgIC8vIFRoZSBxdWVyeSBpcyB1bmxpbWl0ZWQgb3IgZGlkbid0IHB1Ymxpc2ggZW5vdWdoIGRvY3VtZW50cyB5ZXQgb3IgdGhlXG4gICAgICAvLyBuZXcgZG9jdW1lbnQgd291bGQgZml0IGludG8gcHVibGlzaGVkIHNldCBwdXNoaW5nIHRoZSBtYXhpbXVtIGVsZW1lbnRcbiAgICAgIC8vIG91dCwgdGhlbiB3ZSBuZWVkIHRvIHB1Ymxpc2ggdGhlIGRvYy5cbiAgICAgIHZhciB0b1B1Ymxpc2ggPSAhIGxpbWl0IHx8IHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgPCBsaW1pdCB8fFxuICAgICAgICBjb21wYXJhdG9yKGRvYywgbWF4UHVibGlzaGVkKSA8IDA7XG5cbiAgICAgIC8vIE90aGVyd2lzZSB3ZSBtaWdodCBuZWVkIHRvIGJ1ZmZlciBpdCAob25seSBpbiBjYXNlIG9mIGxpbWl0ZWQgcXVlcnkpLlxuICAgICAgLy8gQnVmZmVyaW5nIGlzIGFsbG93ZWQgaWYgdGhlIGJ1ZmZlciBpcyBub3QgZmlsbGVkIHVwIHlldCBhbmQgYWxsXG4gICAgICAvLyBtYXRjaGluZyBkb2NzIGFyZSBlaXRoZXIgaW4gdGhlIHB1Ymxpc2hlZCBzZXQgb3IgaW4gdGhlIGJ1ZmZlci5cbiAgICAgIHZhciBjYW5BcHBlbmRUb0J1ZmZlciA9ICF0b1B1Ymxpc2ggJiYgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyICYmXG4gICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSA8IGxpbWl0O1xuXG4gICAgICAvLyBPciBpZiBpdCBpcyBzbWFsbCBlbm91Z2ggdG8gYmUgc2FmZWx5IGluc2VydGVkIHRvIHRoZSBtaWRkbGUgb3IgdGhlXG4gICAgICAvLyBiZWdpbm5pbmcgb2YgdGhlIGJ1ZmZlci5cbiAgICAgIHZhciBjYW5JbnNlcnRJbnRvQnVmZmVyID0gIXRvUHVibGlzaCAmJiBtYXhCdWZmZXJlZCAmJlxuICAgICAgICBjb21wYXJhdG9yKGRvYywgbWF4QnVmZmVyZWQpIDw9IDA7XG5cbiAgICAgIHZhciB0b0J1ZmZlciA9IGNhbkFwcGVuZFRvQnVmZmVyIHx8IGNhbkluc2VydEludG9CdWZmZXI7XG5cbiAgICAgIGlmICh0b1B1Ymxpc2gpIHtcbiAgICAgICAgc2VsZi5fYWRkUHVibGlzaGVkKGlkLCBkb2MpO1xuICAgICAgfSBlbHNlIGlmICh0b0J1ZmZlcikge1xuICAgICAgICBzZWxmLl9hZGRCdWZmZXJlZChpZCwgZG9jKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIGRyb3BwaW5nIGl0IGFuZCBub3Qgc2F2aW5nIHRvIHRoZSBjYWNoZVxuICAgICAgICBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcbiAgLy8gQ2FsbGVkIHdoZW4gYSBkb2N1bWVudCBsZWF2ZXMgdGhlIFwiTWF0Y2hpbmdcIiByZXN1bHRzIHNldC5cbiAgLy8gVGFrZXMgcmVzcG9uc2liaWxpdHkgb2Yga2VlcGluZyBfdW5wdWJsaXNoZWRCdWZmZXIgaW4gc3luYyB3aXRoIF9wdWJsaXNoZWRcbiAgLy8gYW5kIHRoZSBlZmZlY3Qgb2YgbGltaXQgZW5mb3JjZWQuXG4gIF9yZW1vdmVNYXRjaGluZzogZnVuY3Rpb24gKGlkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmICghIHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpICYmICEgc2VsZi5fbGltaXQpXG4gICAgICAgIHRocm93IEVycm9yKFwidHJpZWQgdG8gcmVtb3ZlIHNvbWV0aGluZyBtYXRjaGluZyBidXQgbm90IGNhY2hlZCBcIiArIGlkKTtcblxuICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpKSB7XG4gICAgICAgIHNlbGYuX3JlbW92ZVB1Ymxpc2hlZChpZCk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCkpIHtcbiAgICAgICAgc2VsZi5fcmVtb3ZlQnVmZmVyZWQoaWQpO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICBfaGFuZGxlRG9jOiBmdW5jdGlvbiAoaWQsIG5ld0RvYykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgbWF0Y2hlc05vdyA9IG5ld0RvYyAmJiBzZWxmLl9tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhuZXdEb2MpLnJlc3VsdDtcblxuICAgICAgdmFyIHB1Ymxpc2hlZEJlZm9yZSA9IHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpO1xuICAgICAgdmFyIGJ1ZmZlcmVkQmVmb3JlID0gc2VsZi5fbGltaXQgJiYgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuaGFzKGlkKTtcbiAgICAgIHZhciBjYWNoZWRCZWZvcmUgPSBwdWJsaXNoZWRCZWZvcmUgfHwgYnVmZmVyZWRCZWZvcmU7XG5cbiAgICAgIGlmIChtYXRjaGVzTm93ICYmICFjYWNoZWRCZWZvcmUpIHtcbiAgICAgICAgc2VsZi5fYWRkTWF0Y2hpbmcobmV3RG9jKTtcbiAgICAgIH0gZWxzZSBpZiAoY2FjaGVkQmVmb3JlICYmICFtYXRjaGVzTm93KSB7XG4gICAgICAgIHNlbGYuX3JlbW92ZU1hdGNoaW5nKGlkKTtcbiAgICAgIH0gZWxzZSBpZiAoY2FjaGVkQmVmb3JlICYmIG1hdGNoZXNOb3cpIHtcbiAgICAgICAgdmFyIG9sZERvYyA9IHNlbGYuX3B1Ymxpc2hlZC5nZXQoaWQpO1xuICAgICAgICB2YXIgY29tcGFyYXRvciA9IHNlbGYuX2NvbXBhcmF0b3I7XG4gICAgICAgIHZhciBtaW5CdWZmZXJlZCA9IHNlbGYuX2xpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSAmJlxuICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5taW5FbGVtZW50SWQoKSk7XG4gICAgICAgIHZhciBtYXhCdWZmZXJlZDtcblxuICAgICAgICBpZiAocHVibGlzaGVkQmVmb3JlKSB7XG4gICAgICAgICAgLy8gVW5saW1pdGVkIGNhc2Ugd2hlcmUgdGhlIGRvY3VtZW50IHN0YXlzIGluIHB1Ymxpc2hlZCBvbmNlIGl0XG4gICAgICAgICAgLy8gbWF0Y2hlcyBvciB0aGUgY2FzZSB3aGVuIHdlIGRvbid0IGhhdmUgZW5vdWdoIG1hdGNoaW5nIGRvY3MgdG9cbiAgICAgICAgICAvLyBwdWJsaXNoIG9yIHRoZSBjaGFuZ2VkIGJ1dCBtYXRjaGluZyBkb2Mgd2lsbCBzdGF5IGluIHB1Ymxpc2hlZFxuICAgICAgICAgIC8vIGFueXdheXMuXG4gICAgICAgICAgLy9cbiAgICAgICAgICAvLyBYWFg6IFdlIHJlbHkgb24gdGhlIGVtcHRpbmVzcyBvZiBidWZmZXIuIEJlIHN1cmUgdG8gbWFpbnRhaW4gdGhlXG4gICAgICAgICAgLy8gZmFjdCB0aGF0IGJ1ZmZlciBjYW4ndCBiZSBlbXB0eSBpZiB0aGVyZSBhcmUgbWF0Y2hpbmcgZG9jdW1lbnRzIG5vdFxuICAgICAgICAgIC8vIHB1Ymxpc2hlZC4gTm90YWJseSwgd2UgZG9uJ3Qgd2FudCB0byBzY2hlZHVsZSByZXBvbGwgYW5kIGNvbnRpbnVlXG4gICAgICAgICAgLy8gcmVseWluZyBvbiB0aGlzIHByb3BlcnR5LlxuICAgICAgICAgIHZhciBzdGF5c0luUHVibGlzaGVkID0gISBzZWxmLl9saW1pdCB8fFxuICAgICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpID09PSAwIHx8XG4gICAgICAgICAgICBjb21wYXJhdG9yKG5ld0RvYywgbWluQnVmZmVyZWQpIDw9IDA7XG5cbiAgICAgICAgICBpZiAoc3RheXNJblB1Ymxpc2hlZCkge1xuICAgICAgICAgICAgc2VsZi5fY2hhbmdlUHVibGlzaGVkKGlkLCBvbGREb2MsIG5ld0RvYyk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIGFmdGVyIHRoZSBjaGFuZ2UgZG9jIGRvZXNuJ3Qgc3RheSBpbiB0aGUgcHVibGlzaGVkLCByZW1vdmUgaXRcbiAgICAgICAgICAgIHNlbGYuX3JlbW92ZVB1Ymxpc2hlZChpZCk7XG4gICAgICAgICAgICAvLyBidXQgaXQgY2FuIG1vdmUgaW50byBidWZmZXJlZCBub3csIGNoZWNrIGl0XG4gICAgICAgICAgICBtYXhCdWZmZXJlZCA9IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChcbiAgICAgICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIubWF4RWxlbWVudElkKCkpO1xuXG4gICAgICAgICAgICB2YXIgdG9CdWZmZXIgPSBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgfHxcbiAgICAgICAgICAgICAgICAgIChtYXhCdWZmZXJlZCAmJiBjb21wYXJhdG9yKG5ld0RvYywgbWF4QnVmZmVyZWQpIDw9IDApO1xuXG4gICAgICAgICAgICBpZiAodG9CdWZmZXIpIHtcbiAgICAgICAgICAgICAgc2VsZi5fYWRkQnVmZmVyZWQoaWQsIG5ld0RvYyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBUaHJvdyBhd2F5IGZyb20gYm90aCBwdWJsaXNoZWQgc2V0IGFuZCBidWZmZXJcbiAgICAgICAgICAgICAgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKGJ1ZmZlcmVkQmVmb3JlKSB7XG4gICAgICAgICAgb2xkRG9jID0gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KGlkKTtcbiAgICAgICAgICAvLyByZW1vdmUgdGhlIG9sZCB2ZXJzaW9uIG1hbnVhbGx5IGluc3RlYWQgb2YgdXNpbmcgX3JlbW92ZUJ1ZmZlcmVkIHNvXG4gICAgICAgICAgLy8gd2UgZG9uJ3QgdHJpZ2dlciB0aGUgcXVlcnlpbmcgaW1tZWRpYXRlbHkuICBpZiB3ZSBlbmQgdGhpcyBibG9ja1xuICAgICAgICAgIC8vIHdpdGggdGhlIGJ1ZmZlciBlbXB0eSwgd2Ugd2lsbCBuZWVkIHRvIHRyaWdnZXIgdGhlIHF1ZXJ5IHBvbGxcbiAgICAgICAgICAvLyBtYW51YWxseSB0b28uXG4gICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIucmVtb3ZlKGlkKTtcblxuICAgICAgICAgIHZhciBtYXhQdWJsaXNoZWQgPSBzZWxmLl9wdWJsaXNoZWQuZ2V0KFxuICAgICAgICAgICAgc2VsZi5fcHVibGlzaGVkLm1heEVsZW1lbnRJZCgpKTtcbiAgICAgICAgICBtYXhCdWZmZXJlZCA9IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSAmJlxuICAgICAgICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChcbiAgICAgICAgICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLm1heEVsZW1lbnRJZCgpKTtcblxuICAgICAgICAgIC8vIHRoZSBidWZmZXJlZCBkb2Mgd2FzIHVwZGF0ZWQsIGl0IGNvdWxkIG1vdmUgdG8gcHVibGlzaGVkXG4gICAgICAgICAgdmFyIHRvUHVibGlzaCA9IGNvbXBhcmF0b3IobmV3RG9jLCBtYXhQdWJsaXNoZWQpIDwgMDtcblxuICAgICAgICAgIC8vIG9yIHN0YXlzIGluIGJ1ZmZlciBldmVuIGFmdGVyIHRoZSBjaGFuZ2VcbiAgICAgICAgICB2YXIgc3RheXNJbkJ1ZmZlciA9ICghIHRvUHVibGlzaCAmJiBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIpIHx8XG4gICAgICAgICAgICAgICAgKCF0b1B1Ymxpc2ggJiYgbWF4QnVmZmVyZWQgJiZcbiAgICAgICAgICAgICAgICAgY29tcGFyYXRvcihuZXdEb2MsIG1heEJ1ZmZlcmVkKSA8PSAwKTtcblxuICAgICAgICAgIGlmICh0b1B1Ymxpc2gpIHtcbiAgICAgICAgICAgIHNlbGYuX2FkZFB1Ymxpc2hlZChpZCwgbmV3RG9jKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHN0YXlzSW5CdWZmZXIpIHtcbiAgICAgICAgICAgIC8vIHN0YXlzIGluIGJ1ZmZlciBidXQgY2hhbmdlc1xuICAgICAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2V0KGlkLCBuZXdEb2MpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBUaHJvdyBhd2F5IGZyb20gYm90aCBwdWJsaXNoZWQgc2V0IGFuZCBidWZmZXJcbiAgICAgICAgICAgIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciA9IGZhbHNlO1xuICAgICAgICAgICAgLy8gTm9ybWFsbHkgdGhpcyBjaGVjayB3b3VsZCBoYXZlIGJlZW4gZG9uZSBpbiBfcmVtb3ZlQnVmZmVyZWQgYnV0XG4gICAgICAgICAgICAvLyB3ZSBkaWRuJ3QgdXNlIGl0LCBzbyB3ZSBuZWVkIHRvIGRvIGl0IG91cnNlbGYgbm93LlxuICAgICAgICAgICAgaWYgKCEgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuc2l6ZSgpKSB7XG4gICAgICAgICAgICAgIHNlbGYuX25lZWRUb1BvbGxRdWVyeSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjYWNoZWRCZWZvcmUgaW1wbGllcyBlaXRoZXIgb2YgcHVibGlzaGVkQmVmb3JlIG9yIGJ1ZmZlcmVkQmVmb3JlIGlzIHRydWUuXCIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIF9mZXRjaE1vZGlmaWVkRG9jdW1lbnRzOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX3JlZ2lzdGVyUGhhc2VDaGFuZ2UoUEhBU0UuRkVUQ0hJTkcpO1xuICAgICAgLy8gRGVmZXIsIGJlY2F1c2Ugbm90aGluZyBjYWxsZWQgZnJvbSB0aGUgb3Bsb2cgZW50cnkgaGFuZGxlciBtYXkgeWllbGQsXG4gICAgICAvLyBidXQgZmV0Y2goKSB5aWVsZHMuXG4gICAgICBNZXRlb3IuZGVmZXIoZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkoZnVuY3Rpb24gKCkge1xuICAgICAgICB3aGlsZSAoIXNlbGYuX3N0b3BwZWQgJiYgIXNlbGYuX25lZWRUb0ZldGNoLmVtcHR5KCkpIHtcbiAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLlFVRVJZSU5HKSB7XG4gICAgICAgICAgICAvLyBXaGlsZSBmZXRjaGluZywgd2UgZGVjaWRlZCB0byBnbyBpbnRvIFFVRVJZSU5HIG1vZGUsIGFuZCB0aGVuIHdlXG4gICAgICAgICAgICAvLyBzYXcgYW5vdGhlciBvcGxvZyBlbnRyeSwgc28gX25lZWRUb0ZldGNoIGlzIG5vdCBlbXB0eS4gQnV0IHdlXG4gICAgICAgICAgICAvLyBzaG91bGRuJ3QgZmV0Y2ggdGhlc2UgZG9jdW1lbnRzIHVudGlsIEFGVEVSIHRoZSBxdWVyeSBpcyBkb25lLlxuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQmVpbmcgaW4gc3RlYWR5IHBoYXNlIGhlcmUgd291bGQgYmUgc3VycHJpc2luZy5cbiAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgIT09IFBIQVNFLkZFVENISU5HKVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicGhhc2UgaW4gZmV0Y2hNb2RpZmllZERvY3VtZW50czogXCIgKyBzZWxmLl9waGFzZSk7XG5cbiAgICAgICAgICBzZWxmLl9jdXJyZW50bHlGZXRjaGluZyA9IHNlbGYuX25lZWRUb0ZldGNoO1xuICAgICAgICAgIHZhciB0aGlzR2VuZXJhdGlvbiA9ICsrc2VsZi5fZmV0Y2hHZW5lcmF0aW9uO1xuICAgICAgICAgIHNlbGYuX25lZWRUb0ZldGNoID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gICAgICAgICAgdmFyIHdhaXRpbmcgPSAwO1xuICAgICAgICAgIHZhciBmdXQgPSBuZXcgRnV0dXJlO1xuICAgICAgICAgIC8vIFRoaXMgbG9vcCBpcyBzYWZlLCBiZWNhdXNlIF9jdXJyZW50bHlGZXRjaGluZyB3aWxsIG5vdCBiZSB1cGRhdGVkXG4gICAgICAgICAgLy8gZHVyaW5nIHRoaXMgbG9vcCAoaW4gZmFjdCwgaXQgaXMgbmV2ZXIgbXV0YXRlZCkuXG4gICAgICAgICAgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcuZm9yRWFjaChmdW5jdGlvbiAoY2FjaGVLZXksIGlkKSB7XG4gICAgICAgICAgICB3YWl0aW5nKys7XG4gICAgICAgICAgICBzZWxmLl9tb25nb0hhbmRsZS5fZG9jRmV0Y2hlci5mZXRjaChcbiAgICAgICAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWUsIGlkLCBjYWNoZUtleSxcbiAgICAgICAgICAgICAgZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkoZnVuY3Rpb24gKGVyciwgZG9jKSB7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgTWV0ZW9yLl9kZWJ1ZyhcIkdvdCBleGNlcHRpb24gd2hpbGUgZmV0Y2hpbmcgZG9jdW1lbnRzOiBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gSWYgd2UgZ2V0IGFuIGVycm9yIGZyb20gdGhlIGZldGNoZXIgKGVnLCB0cm91YmxlXG4gICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RpbmcgdG8gTW9uZ28pLCBsZXQncyBqdXN0IGFiYW5kb24gdGhlIGZldGNoIHBoYXNlXG4gICAgICAgICAgICAgICAgICAgIC8vIGFsdG9nZXRoZXIgYW5kIGZhbGwgYmFjayB0byBwb2xsaW5nLiBJdCdzIG5vdCBsaWtlIHdlJ3JlXG4gICAgICAgICAgICAgICAgICAgIC8vIGdldHRpbmcgbGl2ZSB1cGRhdGVzIGFueXdheS5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5RVUVSWUlORykge1xuICAgICAgICAgICAgICAgICAgICAgIHNlbGYuX25lZWRUb1BvbGxRdWVyeSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKCFzZWxmLl9zdG9wcGVkICYmIHNlbGYuX3BoYXNlID09PSBQSEFTRS5GRVRDSElOR1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAmJiBzZWxmLl9mZXRjaEdlbmVyYXRpb24gPT09IHRoaXNHZW5lcmF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIHJlLWNoZWNrIHRoZSBnZW5lcmF0aW9uIGluIGNhc2Ugd2UndmUgaGFkIGFuIGV4cGxpY2l0XG4gICAgICAgICAgICAgICAgICAgIC8vIF9wb2xsUXVlcnkgY2FsbCAoZWcsIGluIGFub3RoZXIgZmliZXIpIHdoaWNoIHNob3VsZFxuICAgICAgICAgICAgICAgICAgICAvLyBlZmZlY3RpdmVseSBjYW5jZWwgdGhpcyByb3VuZCBvZiBmZXRjaGVzLiAgKF9wb2xsUXVlcnlcbiAgICAgICAgICAgICAgICAgICAgLy8gaW5jcmVtZW50cyB0aGUgZ2VuZXJhdGlvbi4pXG4gICAgICAgICAgICAgICAgICAgIHNlbGYuX2hhbmRsZURvYyhpZCwgZG9jKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgICAgd2FpdGluZy0tO1xuICAgICAgICAgICAgICAgICAgLy8gQmVjYXVzZSBmZXRjaCgpIG5ldmVyIGNhbGxzIGl0cyBjYWxsYmFjayBzeW5jaHJvbm91c2x5LFxuICAgICAgICAgICAgICAgICAgLy8gdGhpcyBpcyBzYWZlIChpZSwgd2Ugd29uJ3QgY2FsbCBmdXQucmV0dXJuKCkgYmVmb3JlIHRoZVxuICAgICAgICAgICAgICAgICAgLy8gZm9yRWFjaCBpcyBkb25lKS5cbiAgICAgICAgICAgICAgICAgIGlmICh3YWl0aW5nID09PSAwKVxuICAgICAgICAgICAgICAgICAgICBmdXQucmV0dXJuKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgZnV0LndhaXQoKTtcbiAgICAgICAgICAvLyBFeGl0IG5vdyBpZiB3ZSd2ZSBoYWQgYSBfcG9sbFF1ZXJ5IGNhbGwgKGhlcmUgb3IgaW4gYW5vdGhlciBmaWJlcikuXG4gICAgICAgICAgaWYgKHNlbGYuX3BoYXNlID09PSBQSEFTRS5RVUVSWUlORylcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICBzZWxmLl9jdXJyZW50bHlGZXRjaGluZyA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgLy8gV2UncmUgZG9uZSBmZXRjaGluZywgc28gd2UgY2FuIGJlIHN0ZWFkeSwgdW5sZXNzIHdlJ3ZlIGhhZCBhXG4gICAgICAgIC8vIF9wb2xsUXVlcnkgY2FsbCAoaGVyZSBvciBpbiBhbm90aGVyIGZpYmVyKS5cbiAgICAgICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5RVUVSWUlORylcbiAgICAgICAgICBzZWxmLl9iZVN0ZWFkeSgpO1xuICAgICAgfSkpO1xuICAgIH0pO1xuICB9LFxuICBfYmVTdGVhZHk6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcmVnaXN0ZXJQaGFzZUNoYW5nZShQSEFTRS5TVEVBRFkpO1xuICAgICAgdmFyIHdyaXRlcyA9IHNlbGYuX3dyaXRlc1RvQ29tbWl0V2hlbldlUmVhY2hTdGVhZHk7XG4gICAgICBzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5ID0gW107XG4gICAgICBzZWxmLl9tdWx0aXBsZXhlci5vbkZsdXNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgXy5lYWNoKHdyaXRlcywgZnVuY3Rpb24gKHcpIHtcbiAgICAgICAgICB3LmNvbW1pdHRlZCgpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LFxuICBfaGFuZGxlT3Bsb2dFbnRyeVF1ZXJ5aW5nOiBmdW5jdGlvbiAob3ApIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fbmVlZFRvRmV0Y2guc2V0KGlkRm9yT3Aob3ApLCBvcC50cy50b1N0cmluZygpKTtcbiAgICB9KTtcbiAgfSxcbiAgX2hhbmRsZU9wbG9nRW50cnlTdGVhZHlPckZldGNoaW5nOiBmdW5jdGlvbiAob3ApIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIGlkID0gaWRGb3JPcChvcCk7XG4gICAgICAvLyBJZiB3ZSdyZSBhbHJlYWR5IGZldGNoaW5nIHRoaXMgb25lLCBvciBhYm91dCB0bywgd2UgY2FuJ3Qgb3B0aW1pemU7XG4gICAgICAvLyBtYWtlIHN1cmUgdGhhdCB3ZSBmZXRjaCBpdCBhZ2FpbiBpZiBuZWNlc3NhcnkuXG4gICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLkZFVENISU5HICYmXG4gICAgICAgICAgKChzZWxmLl9jdXJyZW50bHlGZXRjaGluZyAmJiBzZWxmLl9jdXJyZW50bHlGZXRjaGluZy5oYXMoaWQpKSB8fFxuICAgICAgICAgICBzZWxmLl9uZWVkVG9GZXRjaC5oYXMoaWQpKSkge1xuICAgICAgICBzZWxmLl9uZWVkVG9GZXRjaC5zZXQoaWQsIG9wLnRzLnRvU3RyaW5nKCkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChvcC5vcCA9PT0gJ2QnKSB7XG4gICAgICAgIGlmIChzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKSB8fFxuICAgICAgICAgICAgKHNlbGYuX2xpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCkpKVxuICAgICAgICAgIHNlbGYuX3JlbW92ZU1hdGNoaW5nKGlkKTtcbiAgICAgIH0gZWxzZSBpZiAob3Aub3AgPT09ICdpJykge1xuICAgICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLmhhcyhpZCkpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5zZXJ0IGZvdW5kIGZvciBhbHJlYWR5LWV4aXN0aW5nIElEIGluIHB1Ymxpc2hlZFwiKTtcbiAgICAgICAgaWYgKHNlbGYuX3VucHVibGlzaGVkQnVmZmVyICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCkpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5zZXJ0IGZvdW5kIGZvciBhbHJlYWR5LWV4aXN0aW5nIElEIGluIGJ1ZmZlclwiKTtcblxuICAgICAgICAvLyBYWFggd2hhdCBpZiBzZWxlY3RvciB5aWVsZHM/ICBmb3Igbm93IGl0IGNhbid0IGJ1dCBsYXRlciBpdCBjb3VsZFxuICAgICAgICAvLyBoYXZlICR3aGVyZVxuICAgICAgICBpZiAoc2VsZi5fbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMob3AubykucmVzdWx0KVxuICAgICAgICAgIHNlbGYuX2FkZE1hdGNoaW5nKG9wLm8pO1xuICAgICAgfSBlbHNlIGlmIChvcC5vcCA9PT0gJ3UnKSB7XG4gICAgICAgIC8vIElzIHRoaXMgYSBtb2RpZmllciAoJHNldC8kdW5zZXQsIHdoaWNoIG1heSByZXF1aXJlIHVzIHRvIHBvbGwgdGhlXG4gICAgICAgIC8vIGRhdGFiYXNlIHRvIGZpZ3VyZSBvdXQgaWYgdGhlIHdob2xlIGRvY3VtZW50IG1hdGNoZXMgdGhlIHNlbGVjdG9yKSBvclxuICAgICAgICAvLyBhIHJlcGxhY2VtZW50IChpbiB3aGljaCBjYXNlIHdlIGNhbiBqdXN0IGRpcmVjdGx5IHJlLWV2YWx1YXRlIHRoZVxuICAgICAgICAvLyBzZWxlY3Rvcik/XG4gICAgICAgIHZhciBpc1JlcGxhY2UgPSAhXy5oYXMob3AubywgJyRzZXQnKSAmJiAhXy5oYXMob3AubywgJyR1bnNldCcpO1xuICAgICAgICAvLyBJZiB0aGlzIG1vZGlmaWVyIG1vZGlmaWVzIHNvbWV0aGluZyBpbnNpZGUgYW4gRUpTT04gY3VzdG9tIHR5cGUgKGllLFxuICAgICAgICAvLyBhbnl0aGluZyB3aXRoIEVKU09OJCksIHRoZW4gd2UgY2FuJ3QgdHJ5IHRvIHVzZVxuICAgICAgICAvLyBMb2NhbENvbGxlY3Rpb24uX21vZGlmeSwgc2luY2UgdGhhdCBqdXN0IG11dGF0ZXMgdGhlIEVKU09OIGVuY29kaW5nLFxuICAgICAgICAvLyBub3QgdGhlIGFjdHVhbCBvYmplY3QuXG4gICAgICAgIHZhciBjYW5EaXJlY3RseU1vZGlmeURvYyA9XG4gICAgICAgICAgIWlzUmVwbGFjZSAmJiBtb2RpZmllckNhbkJlRGlyZWN0bHlBcHBsaWVkKG9wLm8pO1xuXG4gICAgICAgIHZhciBwdWJsaXNoZWRCZWZvcmUgPSBzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKTtcbiAgICAgICAgdmFyIGJ1ZmZlcmVkQmVmb3JlID0gc2VsZi5fbGltaXQgJiYgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuaGFzKGlkKTtcblxuICAgICAgICBpZiAoaXNSZXBsYWNlKSB7XG4gICAgICAgICAgc2VsZi5faGFuZGxlRG9jKGlkLCBfLmV4dGVuZCh7X2lkOiBpZH0sIG9wLm8pKTtcbiAgICAgICAgfSBlbHNlIGlmICgocHVibGlzaGVkQmVmb3JlIHx8IGJ1ZmZlcmVkQmVmb3JlKSAmJlxuICAgICAgICAgICAgICAgICAgIGNhbkRpcmVjdGx5TW9kaWZ5RG9jKSB7XG4gICAgICAgICAgLy8gT2ggZ3JlYXQsIHdlIGFjdHVhbGx5IGtub3cgd2hhdCB0aGUgZG9jdW1lbnQgaXMsIHNvIHdlIGNhbiBhcHBseVxuICAgICAgICAgIC8vIHRoaXMgZGlyZWN0bHkuXG4gICAgICAgICAgdmFyIG5ld0RvYyA9IHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpXG4gICAgICAgICAgICA/IHNlbGYuX3B1Ymxpc2hlZC5nZXQoaWQpIDogc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KGlkKTtcbiAgICAgICAgICBuZXdEb2MgPSBFSlNPTi5jbG9uZShuZXdEb2MpO1xuXG4gICAgICAgICAgbmV3RG9jLl9pZCA9IGlkO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBMb2NhbENvbGxlY3Rpb24uX21vZGlmeShuZXdEb2MsIG9wLm8pO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGlmIChlLm5hbWUgIT09IFwiTWluaW1vbmdvRXJyb3JcIilcbiAgICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICAgIC8vIFdlIGRpZG4ndCB1bmRlcnN0YW5kIHRoZSBtb2RpZmllci4gIFJlLWZldGNoLlxuICAgICAgICAgICAgc2VsZi5fbmVlZFRvRmV0Y2guc2V0KGlkLCBvcC50cy50b1N0cmluZygpKTtcbiAgICAgICAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuU1RFQURZKSB7XG4gICAgICAgICAgICAgIHNlbGYuX2ZldGNoTW9kaWZpZWREb2N1bWVudHMoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgc2VsZi5faGFuZGxlRG9jKGlkLCBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uRm4obmV3RG9jKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWNhbkRpcmVjdGx5TW9kaWZ5RG9jIHx8XG4gICAgICAgICAgICAgICAgICAgc2VsZi5fbWF0Y2hlci5jYW5CZWNvbWVUcnVlQnlNb2RpZmllcihvcC5vKSB8fFxuICAgICAgICAgICAgICAgICAgIChzZWxmLl9zb3J0ZXIgJiYgc2VsZi5fc29ydGVyLmFmZmVjdGVkQnlNb2RpZmllcihvcC5vKSkpIHtcbiAgICAgICAgICBzZWxmLl9uZWVkVG9GZXRjaC5zZXQoaWQsIG9wLnRzLnRvU3RyaW5nKCkpO1xuICAgICAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuU1RFQURZKVxuICAgICAgICAgICAgc2VsZi5fZmV0Y2hNb2RpZmllZERvY3VtZW50cygpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBFcnJvcihcIlhYWCBTVVJQUklTSU5HIE9QRVJBVElPTjogXCIgKyBvcCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIC8vIFlpZWxkcyFcbiAgX3J1bkluaXRpYWxRdWVyeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm9wbG9nIHN0b3BwZWQgc3VycHJpc2luZ2x5IGVhcmx5XCIpO1xuXG4gICAgc2VsZi5fcnVuUXVlcnkoe2luaXRpYWw6IHRydWV9KTsgIC8vIHlpZWxkc1xuXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47ICAvLyBjYW4gaGFwcGVuIG9uIHF1ZXJ5RXJyb3JcblxuICAgIC8vIEFsbG93IG9ic2VydmVDaGFuZ2VzIGNhbGxzIHRvIHJldHVybi4gKEFmdGVyIHRoaXMsIGl0J3MgcG9zc2libGUgZm9yXG4gICAgLy8gc3RvcCgpIHRvIGJlIGNhbGxlZC4pXG4gICAgc2VsZi5fbXVsdGlwbGV4ZXIucmVhZHkoKTtcblxuICAgIHNlbGYuX2RvbmVRdWVyeWluZygpOyAgLy8geWllbGRzXG4gIH0sXG5cbiAgLy8gSW4gdmFyaW91cyBjaXJjdW1zdGFuY2VzLCB3ZSBtYXkganVzdCB3YW50IHRvIHN0b3AgcHJvY2Vzc2luZyB0aGUgb3Bsb2cgYW5kXG4gIC8vIHJlLXJ1biB0aGUgaW5pdGlhbCBxdWVyeSwganVzdCBhcyBpZiB3ZSB3ZXJlIGEgUG9sbGluZ09ic2VydmVEcml2ZXIuXG4gIC8vXG4gIC8vIFRoaXMgZnVuY3Rpb24gbWF5IG5vdCBibG9jaywgYmVjYXVzZSBpdCBpcyBjYWxsZWQgZnJvbSBhbiBvcGxvZyBlbnRyeVxuICAvLyBoYW5kbGVyLlxuICAvL1xuICAvLyBYWFggV2Ugc2hvdWxkIGNhbGwgdGhpcyB3aGVuIHdlIGRldGVjdCB0aGF0IHdlJ3ZlIGJlZW4gaW4gRkVUQ0hJTkcgZm9yIFwidG9vXG4gIC8vIGxvbmdcIi5cbiAgLy9cbiAgLy8gWFhYIFdlIHNob3VsZCBjYWxsIHRoaXMgd2hlbiB3ZSBkZXRlY3QgTW9uZ28gZmFpbG92ZXIgKHNpbmNlIHRoYXQgbWlnaHRcbiAgLy8gbWVhbiB0aGF0IHNvbWUgb2YgdGhlIG9wbG9nIGVudHJpZXMgd2UgaGF2ZSBwcm9jZXNzZWQgaGF2ZSBiZWVuIHJvbGxlZFxuICAvLyBiYWNrKS4gVGhlIE5vZGUgTW9uZ28gZHJpdmVyIGlzIGluIHRoZSBtaWRkbGUgb2YgYSBidW5jaCBvZiBodWdlXG4gIC8vIHJlZmFjdG9yaW5ncywgaW5jbHVkaW5nIHRoZSB3YXkgdGhhdCBpdCBub3RpZmllcyB5b3Ugd2hlbiBwcmltYXJ5XG4gIC8vIGNoYW5nZXMuIFdpbGwgcHV0IG9mZiBpbXBsZW1lbnRpbmcgdGhpcyB1bnRpbCBkcml2ZXIgMS40IGlzIG91dC5cbiAgX3BvbGxRdWVyeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAvLyBZYXksIHdlIGdldCB0byBmb3JnZXQgYWJvdXQgYWxsIHRoZSB0aGluZ3Mgd2UgdGhvdWdodCB3ZSBoYWQgdG8gZmV0Y2guXG4gICAgICBzZWxmLl9uZWVkVG9GZXRjaCA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcgPSBudWxsO1xuICAgICAgKytzZWxmLl9mZXRjaEdlbmVyYXRpb247ICAvLyBpZ25vcmUgYW55IGluLWZsaWdodCBmZXRjaGVzXG4gICAgICBzZWxmLl9yZWdpc3RlclBoYXNlQ2hhbmdlKFBIQVNFLlFVRVJZSU5HKTtcblxuICAgICAgLy8gRGVmZXIgc28gdGhhdCB3ZSBkb24ndCB5aWVsZC4gIFdlIGRvbid0IG5lZWQgZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnlcbiAgICAgIC8vIGhlcmUgYmVjYXVzZSBTd2l0Y2hlZFRvUXVlcnkgaXMgbm90IHRocm93biBpbiBRVUVSWUlORyBtb2RlLlxuICAgICAgTWV0ZW9yLmRlZmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgc2VsZi5fcnVuUXVlcnkoKTtcbiAgICAgICAgc2VsZi5fZG9uZVF1ZXJ5aW5nKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBZaWVsZHMhXG4gIF9ydW5RdWVyeTogZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgdmFyIG5ld1Jlc3VsdHMsIG5ld0J1ZmZlcjtcblxuICAgIC8vIFRoaXMgd2hpbGUgbG9vcCBpcyBqdXN0IHRvIHJldHJ5IGZhaWx1cmVzLlxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAvLyBJZiB3ZSd2ZSBiZWVuIHN0b3BwZWQsIHdlIGRvbid0IGhhdmUgdG8gcnVuIGFueXRoaW5nIGFueSBtb3JlLlxuICAgICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgbmV3UmVzdWx0cyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgbmV3QnVmZmVyID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG5cbiAgICAgIC8vIFF1ZXJ5IDJ4IGRvY3VtZW50cyBhcyB0aGUgaGFsZiBleGNsdWRlZCBmcm9tIHRoZSBvcmlnaW5hbCBxdWVyeSB3aWxsIGdvXG4gICAgICAvLyBpbnRvIHVucHVibGlzaGVkIGJ1ZmZlciB0byByZWR1Y2UgYWRkaXRpb25hbCBNb25nbyBsb29rdXBzIGluIGNhc2VzXG4gICAgICAvLyB3aGVuIGRvY3VtZW50cyBhcmUgcmVtb3ZlZCBmcm9tIHRoZSBwdWJsaXNoZWQgc2V0IGFuZCBuZWVkIGFcbiAgICAgIC8vIHJlcGxhY2VtZW50LlxuICAgICAgLy8gWFhYIG5lZWRzIG1vcmUgdGhvdWdodCBvbiBub24temVybyBza2lwXG4gICAgICAvLyBYWFggMiBpcyBhIFwibWFnaWMgbnVtYmVyXCIgbWVhbmluZyB0aGVyZSBpcyBhbiBleHRyYSBjaHVuayBvZiBkb2NzIGZvclxuICAgICAgLy8gYnVmZmVyIGlmIHN1Y2ggaXMgbmVlZGVkLlxuICAgICAgdmFyIGN1cnNvciA9IHNlbGYuX2N1cnNvckZvclF1ZXJ5KHsgbGltaXQ6IHNlbGYuX2xpbWl0ICogMiB9KTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGN1cnNvci5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGkpIHsgIC8vIHlpZWxkc1xuICAgICAgICAgIGlmICghc2VsZi5fbGltaXQgfHwgaSA8IHNlbGYuX2xpbWl0KSB7XG4gICAgICAgICAgICBuZXdSZXN1bHRzLnNldChkb2MuX2lkLCBkb2MpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBuZXdCdWZmZXIuc2V0KGRvYy5faWQsIGRvYyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmIChvcHRpb25zLmluaXRpYWwgJiYgdHlwZW9mKGUuY29kZSkgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgLy8gVGhpcyBpcyBhbiBlcnJvciBkb2N1bWVudCBzZW50IHRvIHVzIGJ5IG1vbmdvZCwgbm90IGEgY29ubmVjdGlvblxuICAgICAgICAgIC8vIGVycm9yIGdlbmVyYXRlZCBieSB0aGUgY2xpZW50LiBBbmQgd2UndmUgbmV2ZXIgc2VlbiB0aGlzIHF1ZXJ5IHdvcmtcbiAgICAgICAgICAvLyBzdWNjZXNzZnVsbHkuIFByb2JhYmx5IGl0J3MgYSBiYWQgc2VsZWN0b3Igb3Igc29tZXRoaW5nLCBzbyB3ZVxuICAgICAgICAgIC8vIHNob3VsZCBOT1QgcmV0cnkuIEluc3RlYWQsIHdlIHNob3VsZCBoYWx0IHRoZSBvYnNlcnZlICh3aGljaCBlbmRzXG4gICAgICAgICAgLy8gdXAgY2FsbGluZyBgc3RvcGAgb24gdXMpLlxuICAgICAgICAgIHNlbGYuX211bHRpcGxleGVyLnF1ZXJ5RXJyb3IoZSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRHVyaW5nIGZhaWxvdmVyIChlZykgaWYgd2UgZ2V0IGFuIGV4Y2VwdGlvbiB3ZSBzaG91bGQgbG9nIGFuZCByZXRyeVxuICAgICAgICAvLyBpbnN0ZWFkIG9mIGNyYXNoaW5nLlxuICAgICAgICBNZXRlb3IuX2RlYnVnKFwiR290IGV4Y2VwdGlvbiB3aGlsZSBwb2xsaW5nIHF1ZXJ5OiBcIiArIGUpO1xuICAgICAgICBNZXRlb3IuX3NsZWVwRm9yTXMoMTAwKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHJldHVybjtcblxuICAgIHNlbGYuX3B1Ymxpc2hOZXdSZXN1bHRzKG5ld1Jlc3VsdHMsIG5ld0J1ZmZlcik7XG4gIH0sXG5cbiAgLy8gVHJhbnNpdGlvbnMgdG8gUVVFUllJTkcgYW5kIHJ1bnMgYW5vdGhlciBxdWVyeSwgb3IgKGlmIGFscmVhZHkgaW4gUVVFUllJTkcpXG4gIC8vIGVuc3VyZXMgdGhhdCB3ZSB3aWxsIHF1ZXJ5IGFnYWluIGxhdGVyLlxuICAvL1xuICAvLyBUaGlzIGZ1bmN0aW9uIG1heSBub3QgYmxvY2ssIGJlY2F1c2UgaXQgaXMgY2FsbGVkIGZyb20gYW4gb3Bsb2cgZW50cnlcbiAgLy8gaGFuZGxlci4gSG93ZXZlciwgaWYgd2Ugd2VyZSBub3QgYWxyZWFkeSBpbiB0aGUgUVVFUllJTkcgcGhhc2UsIGl0IHRocm93c1xuICAvLyBhbiBleGNlcHRpb24gdGhhdCBpcyBjYXVnaHQgYnkgdGhlIGNsb3Nlc3Qgc3Vycm91bmRpbmdcbiAgLy8gZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkgY2FsbDsgdGhpcyBlbnN1cmVzIHRoYXQgd2UgZG9uJ3QgY29udGludWUgcnVubmluZ1xuICAvLyBjbG9zZSB0aGF0IHdhcyBkZXNpZ25lZCBmb3IgYW5vdGhlciBwaGFzZSBpbnNpZGUgUEhBU0UuUVVFUllJTkcuXG4gIC8vXG4gIC8vIChJdCdzIGFsc28gbmVjZXNzYXJ5IHdoZW5ldmVyIGxvZ2ljIGluIHRoaXMgZmlsZSB5aWVsZHMgdG8gY2hlY2sgdGhhdCBvdGhlclxuICAvLyBwaGFzZXMgaGF2ZW4ndCBwdXQgdXMgaW50byBRVUVSWUlORyBtb2RlLCB0aG91Z2g7IGVnLFxuICAvLyBfZmV0Y2hNb2RpZmllZERvY3VtZW50cyBkb2VzIHRoaXMuKVxuICBfbmVlZFRvUG9sbFF1ZXJ5OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIC8vIElmIHdlJ3JlIG5vdCBhbHJlYWR5IGluIHRoZSBtaWRkbGUgb2YgYSBxdWVyeSwgd2UgY2FuIHF1ZXJ5IG5vd1xuICAgICAgLy8gKHBvc3NpYmx5IHBhdXNpbmcgRkVUQ0hJTkcpLlxuICAgICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5RVUVSWUlORykge1xuICAgICAgICBzZWxmLl9wb2xsUXVlcnkoKTtcbiAgICAgICAgdGhyb3cgbmV3IFN3aXRjaGVkVG9RdWVyeTtcbiAgICAgIH1cblxuICAgICAgLy8gV2UncmUgY3VycmVudGx5IGluIFFVRVJZSU5HLiBTZXQgYSBmbGFnIHRvIGVuc3VyZSB0aGF0IHdlIHJ1biBhbm90aGVyXG4gICAgICAvLyBxdWVyeSB3aGVuIHdlJ3JlIGRvbmUuXG4gICAgICBzZWxmLl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkgPSB0cnVlO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIFlpZWxkcyFcbiAgX2RvbmVRdWVyeWluZzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX21vbmdvSGFuZGxlLl9vcGxvZ0hhbmRsZS53YWl0VW50aWxDYXVnaHRVcCgpOyAgLy8geWllbGRzXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG4gICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5RVUVSWUlORylcbiAgICAgIHRocm93IEVycm9yKFwiUGhhc2UgdW5leHBlY3RlZGx5IFwiICsgc2VsZi5fcGhhc2UpO1xuXG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHNlbGYuX3JlcXVlcnlXaGVuRG9uZVRoaXNRdWVyeSkge1xuICAgICAgICBzZWxmLl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkgPSBmYWxzZTtcbiAgICAgICAgc2VsZi5fcG9sbFF1ZXJ5KCk7XG4gICAgICB9IGVsc2UgaWYgKHNlbGYuX25lZWRUb0ZldGNoLmVtcHR5KCkpIHtcbiAgICAgICAgc2VsZi5fYmVTdGVhZHkoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbGYuX2ZldGNoTW9kaWZpZWREb2N1bWVudHMoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcblxuICBfY3Vyc29yRm9yUXVlcnk6IGZ1bmN0aW9uIChvcHRpb25zT3ZlcndyaXRlKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICAvLyBUaGUgcXVlcnkgd2UgcnVuIGlzIGFsbW9zdCB0aGUgc2FtZSBhcyB0aGUgY3Vyc29yIHdlIGFyZSBvYnNlcnZpbmcsXG4gICAgICAvLyB3aXRoIGEgZmV3IGNoYW5nZXMuIFdlIG5lZWQgdG8gcmVhZCBhbGwgdGhlIGZpZWxkcyB0aGF0IGFyZSByZWxldmFudCB0b1xuICAgICAgLy8gdGhlIHNlbGVjdG9yLCBub3QganVzdCB0aGUgZmllbGRzIHdlIGFyZSBnb2luZyB0byBwdWJsaXNoICh0aGF0J3MgdGhlXG4gICAgICAvLyBcInNoYXJlZFwiIHByb2plY3Rpb24pLiBBbmQgd2UgZG9uJ3Qgd2FudCB0byBhcHBseSBhbnkgdHJhbnNmb3JtIGluIHRoZVxuICAgICAgLy8gY3Vyc29yLCBiZWNhdXNlIG9ic2VydmVDaGFuZ2VzIHNob3VsZG4ndCB1c2UgdGhlIHRyYW5zZm9ybS5cbiAgICAgIHZhciBvcHRpb25zID0gXy5jbG9uZShzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zKTtcblxuICAgICAgLy8gQWxsb3cgdGhlIGNhbGxlciB0byBtb2RpZnkgdGhlIG9wdGlvbnMuIFVzZWZ1bCB0byBzcGVjaWZ5IGRpZmZlcmVudFxuICAgICAgLy8gc2tpcCBhbmQgbGltaXQgdmFsdWVzLlxuICAgICAgXy5leHRlbmQob3B0aW9ucywgb3B0aW9uc092ZXJ3cml0ZSk7XG5cbiAgICAgIG9wdGlvbnMuZmllbGRzID0gc2VsZi5fc2hhcmVkUHJvamVjdGlvbjtcbiAgICAgIGRlbGV0ZSBvcHRpb25zLnRyYW5zZm9ybTtcbiAgICAgIC8vIFdlIGFyZSBOT1QgZGVlcCBjbG9uaW5nIGZpZWxkcyBvciBzZWxlY3RvciBoZXJlLCB3aGljaCBzaG91bGQgYmUgT0suXG4gICAgICB2YXIgZGVzY3JpcHRpb24gPSBuZXcgQ3Vyc29yRGVzY3JpcHRpb24oXG4gICAgICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLmNvbGxlY3Rpb25OYW1lLFxuICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3RvcixcbiAgICAgICAgb3B0aW9ucyk7XG4gICAgICByZXR1cm4gbmV3IEN1cnNvcihzZWxmLl9tb25nb0hhbmRsZSwgZGVzY3JpcHRpb24pO1xuICAgIH0pO1xuICB9LFxuXG5cbiAgLy8gUmVwbGFjZSBzZWxmLl9wdWJsaXNoZWQgd2l0aCBuZXdSZXN1bHRzIChib3RoIGFyZSBJZE1hcHMpLCBpbnZva2luZyBvYnNlcnZlXG4gIC8vIGNhbGxiYWNrcyBvbiB0aGUgbXVsdGlwbGV4ZXIuXG4gIC8vIFJlcGxhY2Ugc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIgd2l0aCBuZXdCdWZmZXIuXG4gIC8vXG4gIC8vIFhYWCBUaGlzIGlzIHZlcnkgc2ltaWxhciB0byBMb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeVVub3JkZXJlZENoYW5nZXMuIFdlXG4gIC8vIHNob3VsZCByZWFsbHk6IChhKSBVbmlmeSBJZE1hcCBhbmQgT3JkZXJlZERpY3QgaW50byBVbm9yZGVyZWQvT3JkZXJlZERpY3RcbiAgLy8gKGIpIFJld3JpdGUgZGlmZi5qcyB0byB1c2UgdGhlc2UgY2xhc3NlcyBpbnN0ZWFkIG9mIGFycmF5cyBhbmQgb2JqZWN0cy5cbiAgX3B1Ymxpc2hOZXdSZXN1bHRzOiBmdW5jdGlvbiAobmV3UmVzdWx0cywgbmV3QnVmZmVyKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcblxuICAgICAgLy8gSWYgdGhlIHF1ZXJ5IGlzIGxpbWl0ZWQgYW5kIHRoZXJlIGlzIGEgYnVmZmVyLCBzaHV0IGRvd24gc28gaXQgZG9lc24ndFxuICAgICAgLy8gc3RheSBpbiBhIHdheS5cbiAgICAgIGlmIChzZWxmLl9saW1pdCkge1xuICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5jbGVhcigpO1xuICAgICAgfVxuXG4gICAgICAvLyBGaXJzdCByZW1vdmUgYW55dGhpbmcgdGhhdCdzIGdvbmUuIEJlIGNhcmVmdWwgbm90IHRvIG1vZGlmeVxuICAgICAgLy8gc2VsZi5fcHVibGlzaGVkIHdoaWxlIGl0ZXJhdGluZyBvdmVyIGl0LlxuICAgICAgdmFyIGlkc1RvUmVtb3ZlID0gW107XG4gICAgICBzZWxmLl9wdWJsaXNoZWQuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpZCkge1xuICAgICAgICBpZiAoIW5ld1Jlc3VsdHMuaGFzKGlkKSlcbiAgICAgICAgICBpZHNUb1JlbW92ZS5wdXNoKGlkKTtcbiAgICAgIH0pO1xuICAgICAgXy5lYWNoKGlkc1RvUmVtb3ZlLCBmdW5jdGlvbiAoaWQpIHtcbiAgICAgICAgc2VsZi5fcmVtb3ZlUHVibGlzaGVkKGlkKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBOb3cgZG8gYWRkcyBhbmQgY2hhbmdlcy5cbiAgICAgIC8vIElmIHNlbGYgaGFzIGEgYnVmZmVyIGFuZCBsaW1pdCwgdGhlIG5ldyBmZXRjaGVkIHJlc3VsdCB3aWxsIGJlXG4gICAgICAvLyBsaW1pdGVkIGNvcnJlY3RseSBhcyB0aGUgcXVlcnkgaGFzIHNvcnQgc3BlY2lmaWVyLlxuICAgICAgbmV3UmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICAgIHNlbGYuX2hhbmRsZURvYyhpZCwgZG9jKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBTYW5pdHktY2hlY2sgdGhhdCBldmVyeXRoaW5nIHdlIHRyaWVkIHRvIHB1dCBpbnRvIF9wdWJsaXNoZWQgZW5kZWQgdXBcbiAgICAgIC8vIHRoZXJlLlxuICAgICAgLy8gWFhYIGlmIHRoaXMgaXMgc2xvdywgcmVtb3ZlIGl0IGxhdGVyXG4gICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLnNpemUoKSAhPT0gbmV3UmVzdWx0cy5zaXplKCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoXG4gICAgICAgICAgXCJUaGUgTW9uZ28gc2VydmVyIGFuZCB0aGUgTWV0ZW9yIHF1ZXJ5IGRpc2FncmVlIG9uIGhvdyBcIiArXG4gICAgICAgICAgICBcIm1hbnkgZG9jdW1lbnRzIG1hdGNoIHlvdXIgcXVlcnkuIE1heWJlIGl0IGlzIGhpdHRpbmcgYSBNb25nbyBcIiArXG4gICAgICAgICAgICBcImVkZ2UgY2FzZT8gVGhlIHF1ZXJ5IGlzOiBcIiArXG4gICAgICAgICAgICBFSlNPTi5zdHJpbmdpZnkoc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uc2VsZWN0b3IpKTtcbiAgICAgIH1cbiAgICAgIHNlbGYuX3B1Ymxpc2hlZC5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICAgIGlmICghbmV3UmVzdWx0cy5oYXMoaWQpKVxuICAgICAgICAgIHRocm93IEVycm9yKFwiX3B1Ymxpc2hlZCBoYXMgYSBkb2MgdGhhdCBuZXdSZXN1bHRzIGRvZXNuJ3Q7IFwiICsgaWQpO1xuICAgICAgfSk7XG5cbiAgICAgIC8vIEZpbmFsbHksIHJlcGxhY2UgdGhlIGJ1ZmZlclxuICAgICAgbmV3QnVmZmVyLmZvckVhY2goZnVuY3Rpb24gKGRvYywgaWQpIHtcbiAgICAgICAgc2VsZi5fYWRkQnVmZmVyZWQoaWQsIGRvYyk7XG4gICAgICB9KTtcblxuICAgICAgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyID0gbmV3QnVmZmVyLnNpemUoKSA8IHNlbGYuX2xpbWl0O1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIFRoaXMgc3RvcCBmdW5jdGlvbiBpcyBpbnZva2VkIGZyb20gdGhlIG9uU3RvcCBvZiB0aGUgT2JzZXJ2ZU11bHRpcGxleGVyLCBzb1xuICAvLyBpdCBzaG91bGRuJ3QgYWN0dWFsbHkgYmUgcG9zc2libGUgdG8gY2FsbCBpdCB1bnRpbCB0aGUgbXVsdGlwbGV4ZXIgaXNcbiAgLy8gcmVhZHkuXG4gIC8vXG4gIC8vIEl0J3MgaW1wb3J0YW50IHRvIGNoZWNrIHNlbGYuX3N0b3BwZWQgYWZ0ZXIgZXZlcnkgY2FsbCBpbiB0aGlzIGZpbGUgdGhhdFxuICAvLyBjYW4geWllbGQhXG4gIHN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG4gICAgc2VsZi5fc3RvcHBlZCA9IHRydWU7XG4gICAgXy5lYWNoKHNlbGYuX3N0b3BIYW5kbGVzLCBmdW5jdGlvbiAoaGFuZGxlKSB7XG4gICAgICBoYW5kbGUuc3RvcCgpO1xuICAgIH0pO1xuXG4gICAgLy8gTm90ZTogd2UgKmRvbid0KiB1c2UgbXVsdGlwbGV4ZXIub25GbHVzaCBoZXJlIGJlY2F1c2UgdGhpcyBzdG9wXG4gICAgLy8gY2FsbGJhY2sgaXMgYWN0dWFsbHkgaW52b2tlZCBieSB0aGUgbXVsdGlwbGV4ZXIgaXRzZWxmIHdoZW4gaXQgaGFzXG4gICAgLy8gZGV0ZXJtaW5lZCB0aGF0IHRoZXJlIGFyZSBubyBoYW5kbGVzIGxlZnQuIFNvIG5vdGhpbmcgaXMgYWN0dWFsbHkgZ29pbmdcbiAgICAvLyB0byBnZXQgZmx1c2hlZCAoYW5kIGl0J3MgcHJvYmFibHkgbm90IHZhbGlkIHRvIGNhbGwgbWV0aG9kcyBvbiB0aGVcbiAgICAvLyBkeWluZyBtdWx0aXBsZXhlcikuXG4gICAgXy5lYWNoKHNlbGYuX3dyaXRlc1RvQ29tbWl0V2hlbldlUmVhY2hTdGVhZHksIGZ1bmN0aW9uICh3KSB7XG4gICAgICB3LmNvbW1pdHRlZCgpOyAgLy8gbWF5YmUgeWllbGRzP1xuICAgIH0pO1xuICAgIHNlbGYuX3dyaXRlc1RvQ29tbWl0V2hlbldlUmVhY2hTdGVhZHkgPSBudWxsO1xuXG4gICAgLy8gUHJvYWN0aXZlbHkgZHJvcCByZWZlcmVuY2VzIHRvIHBvdGVudGlhbGx5IGJpZyB0aGluZ3MuXG4gICAgc2VsZi5fcHVibGlzaGVkID0gbnVsbDtcbiAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlciA9IG51bGw7XG4gICAgc2VsZi5fbmVlZFRvRmV0Y2ggPSBudWxsO1xuICAgIHNlbGYuX2N1cnJlbnRseUZldGNoaW5nID0gbnVsbDtcbiAgICBzZWxmLl9vcGxvZ0VudHJ5SGFuZGxlID0gbnVsbDtcbiAgICBzZWxmLl9saXN0ZW5lcnNIYW5kbGUgPSBudWxsO1xuXG4gICAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgICAgXCJtb25nby1saXZlZGF0YVwiLCBcIm9ic2VydmUtZHJpdmVycy1vcGxvZ1wiLCAtMSk7XG4gIH0sXG5cbiAgX3JlZ2lzdGVyUGhhc2VDaGFuZ2U6IGZ1bmN0aW9uIChwaGFzZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgbm93ID0gbmV3IERhdGU7XG5cbiAgICAgIGlmIChzZWxmLl9waGFzZSkge1xuICAgICAgICB2YXIgdGltZURpZmYgPSBub3cgLSBzZWxmLl9waGFzZVN0YXJ0VGltZTtcbiAgICAgICAgUGFja2FnZVsnZmFjdHMtYmFzZSddICYmIFBhY2thZ2VbJ2ZhY3RzLWJhc2UnXS5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgICAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJ0aW1lLXNwZW50LWluLVwiICsgc2VsZi5fcGhhc2UgKyBcIi1waGFzZVwiLCB0aW1lRGlmZik7XG4gICAgICB9XG5cbiAgICAgIHNlbGYuX3BoYXNlID0gcGhhc2U7XG4gICAgICBzZWxmLl9waGFzZVN0YXJ0VGltZSA9IG5vdztcbiAgICB9KTtcbiAgfVxufSk7XG5cbi8vIERvZXMgb3VyIG9wbG9nIHRhaWxpbmcgY29kZSBzdXBwb3J0IHRoaXMgY3Vyc29yPyBGb3Igbm93LCB3ZSBhcmUgYmVpbmcgdmVyeVxuLy8gY29uc2VydmF0aXZlIGFuZCBhbGxvd2luZyBvbmx5IHNpbXBsZSBxdWVyaWVzIHdpdGggc2ltcGxlIG9wdGlvbnMuXG4vLyAoVGhpcyBpcyBhIFwic3RhdGljIG1ldGhvZFwiLilcbk9wbG9nT2JzZXJ2ZURyaXZlci5jdXJzb3JTdXBwb3J0ZWQgPSBmdW5jdGlvbiAoY3Vyc29yRGVzY3JpcHRpb24sIG1hdGNoZXIpIHtcbiAgLy8gRmlyc3QsIGNoZWNrIHRoZSBvcHRpb25zLlxuICB2YXIgb3B0aW9ucyA9IGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnM7XG5cbiAgLy8gRGlkIHRoZSB1c2VyIHNheSBubyBleHBsaWNpdGx5P1xuICAvLyB1bmRlcnNjb3JlZCB2ZXJzaW9uIG9mIHRoZSBvcHRpb24gaXMgQ09NUEFUIHdpdGggMS4yXG4gIGlmIChvcHRpb25zLmRpc2FibGVPcGxvZyB8fCBvcHRpb25zLl9kaXNhYmxlT3Bsb2cpXG4gICAgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIHNraXAgaXMgbm90IHN1cHBvcnRlZDogdG8gc3VwcG9ydCBpdCB3ZSB3b3VsZCBuZWVkIHRvIGtlZXAgdHJhY2sgb2YgYWxsXG4gIC8vIFwic2tpcHBlZFwiIGRvY3VtZW50cyBvciBhdCBsZWFzdCB0aGVpciBpZHMuXG4gIC8vIGxpbWl0IHcvbyBhIHNvcnQgc3BlY2lmaWVyIGlzIG5vdCBzdXBwb3J0ZWQ6IGN1cnJlbnQgaW1wbGVtZW50YXRpb24gbmVlZHMgYVxuICAvLyBkZXRlcm1pbmlzdGljIHdheSB0byBvcmRlciBkb2N1bWVudHMuXG4gIGlmIChvcHRpb25zLnNraXAgfHwgKG9wdGlvbnMubGltaXQgJiYgIW9wdGlvbnMuc29ydCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBJZiBhIGZpZWxkcyBwcm9qZWN0aW9uIG9wdGlvbiBpcyBnaXZlbiBjaGVjayBpZiBpdCBpcyBzdXBwb3J0ZWQgYnlcbiAgLy8gbWluaW1vbmdvIChzb21lIG9wZXJhdG9ycyBhcmUgbm90IHN1cHBvcnRlZCkuXG4gIGlmIChvcHRpb25zLmZpZWxkcykge1xuICAgIHRyeSB7XG4gICAgICBMb2NhbENvbGxlY3Rpb24uX2NoZWNrU3VwcG9ydGVkUHJvamVjdGlvbihvcHRpb25zLmZpZWxkcyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGUubmFtZSA9PT0gXCJNaW5pbW9uZ29FcnJvclwiKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IGU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gV2UgZG9uJ3QgYWxsb3cgdGhlIGZvbGxvd2luZyBzZWxlY3RvcnM6XG4gIC8vICAgLSAkd2hlcmUgKG5vdCBjb25maWRlbnQgdGhhdCB3ZSBwcm92aWRlIHRoZSBzYW1lIEpTIGVudmlyb25tZW50XG4gIC8vICAgICAgICAgICAgIGFzIE1vbmdvLCBhbmQgY2FuIHlpZWxkISlcbiAgLy8gICAtICRuZWFyIChoYXMgXCJpbnRlcmVzdGluZ1wiIHByb3BlcnRpZXMgaW4gTW9uZ29EQiwgbGlrZSB0aGUgcG9zc2liaWxpdHlcbiAgLy8gICAgICAgICAgICBvZiByZXR1cm5pbmcgYW4gSUQgbXVsdGlwbGUgdGltZXMsIHRob3VnaCBldmVuIHBvbGxpbmcgbWF5YmVcbiAgLy8gICAgICAgICAgICBoYXZlIGEgYnVnIHRoZXJlKVxuICAvLyAgICAgICAgICAgWFhYOiBvbmNlIHdlIHN1cHBvcnQgaXQsIHdlIHdvdWxkIG5lZWQgdG8gdGhpbmsgbW9yZSBvbiBob3cgd2VcbiAgLy8gICAgICAgICAgIGluaXRpYWxpemUgdGhlIGNvbXBhcmF0b3JzIHdoZW4gd2UgY3JlYXRlIHRoZSBkcml2ZXIuXG4gIHJldHVybiAhbWF0Y2hlci5oYXNXaGVyZSgpICYmICFtYXRjaGVyLmhhc0dlb1F1ZXJ5KCk7XG59O1xuXG52YXIgbW9kaWZpZXJDYW5CZURpcmVjdGx5QXBwbGllZCA9IGZ1bmN0aW9uIChtb2RpZmllcikge1xuICByZXR1cm4gXy5hbGwobW9kaWZpZXIsIGZ1bmN0aW9uIChmaWVsZHMsIG9wZXJhdGlvbikge1xuICAgIHJldHVybiBfLmFsbChmaWVsZHMsIGZ1bmN0aW9uICh2YWx1ZSwgZmllbGQpIHtcbiAgICAgIHJldHVybiAhL0VKU09OXFwkLy50ZXN0KGZpZWxkKTtcbiAgICB9KTtcbiAgfSk7XG59O1xuXG5Nb25nb0ludGVybmFscy5PcGxvZ09ic2VydmVEcml2ZXIgPSBPcGxvZ09ic2VydmVEcml2ZXI7XG4iLCIvLyBzaW5nbGV0b25cbmV4cG9ydCBjb25zdCBMb2NhbENvbGxlY3Rpb25Ecml2ZXIgPSBuZXcgKGNsYXNzIExvY2FsQ29sbGVjdGlvbkRyaXZlciB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHRoaXMubm9Db25uQ29sbGVjdGlvbnMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICB9XG5cbiAgb3BlbihuYW1lLCBjb25uKSB7XG4gICAgaWYgKCEgbmFtZSkge1xuICAgICAgcmV0dXJuIG5ldyBMb2NhbENvbGxlY3Rpb247XG4gICAgfVxuXG4gICAgaWYgKCEgY29ubikge1xuICAgICAgcmV0dXJuIGVuc3VyZUNvbGxlY3Rpb24obmFtZSwgdGhpcy5ub0Nvbm5Db2xsZWN0aW9ucyk7XG4gICAgfVxuXG4gICAgaWYgKCEgY29ubi5fbW9uZ29fbGl2ZWRhdGFfY29sbGVjdGlvbnMpIHtcbiAgICAgIGNvbm4uX21vbmdvX2xpdmVkYXRhX2NvbGxlY3Rpb25zID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgICB9XG5cbiAgICAvLyBYWFggaXMgdGhlcmUgYSB3YXkgdG8ga2VlcCB0cmFjayBvZiBhIGNvbm5lY3Rpb24ncyBjb2xsZWN0aW9ucyB3aXRob3V0XG4gICAgLy8gZGFuZ2xpbmcgaXQgb2ZmIHRoZSBjb25uZWN0aW9uIG9iamVjdD9cbiAgICByZXR1cm4gZW5zdXJlQ29sbGVjdGlvbihuYW1lLCBjb25uLl9tb25nb19saXZlZGF0YV9jb2xsZWN0aW9ucyk7XG4gIH1cbn0pO1xuXG5mdW5jdGlvbiBlbnN1cmVDb2xsZWN0aW9uKG5hbWUsIGNvbGxlY3Rpb25zKSB7XG4gIHJldHVybiAobmFtZSBpbiBjb2xsZWN0aW9ucylcbiAgICA/IGNvbGxlY3Rpb25zW25hbWVdXG4gICAgOiBjb2xsZWN0aW9uc1tuYW1lXSA9IG5ldyBMb2NhbENvbGxlY3Rpb24obmFtZSk7XG59XG4iLCJNb25nb0ludGVybmFscy5SZW1vdGVDb2xsZWN0aW9uRHJpdmVyID0gZnVuY3Rpb24gKFxuICBtb25nb191cmwsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLm1vbmdvID0gbmV3IE1vbmdvQ29ubmVjdGlvbihtb25nb191cmwsIG9wdGlvbnMpO1xufTtcblxuXy5leHRlbmQoTW9uZ29JbnRlcm5hbHMuUmVtb3RlQ29sbGVjdGlvbkRyaXZlci5wcm90b3R5cGUsIHtcbiAgb3BlbjogZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgdmFyIHJldCA9IHt9O1xuICAgIF8uZWFjaChcbiAgICAgIFsnZmluZCcsICdmaW5kT25lJywgJ2luc2VydCcsICd1cGRhdGUnLCAndXBzZXJ0JyxcbiAgICAgICAncmVtb3ZlJywgJ19lbnN1cmVJbmRleCcsICdfZHJvcEluZGV4JywgJ19jcmVhdGVDYXBwZWRDb2xsZWN0aW9uJyxcbiAgICAgICAnZHJvcENvbGxlY3Rpb24nLCAncmF3Q29sbGVjdGlvbiddLFxuICAgICAgZnVuY3Rpb24gKG0pIHtcbiAgICAgICAgcmV0W21dID0gXy5iaW5kKHNlbGYubW9uZ29bbV0sIHNlbGYubW9uZ28sIG5hbWUpO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIHJldDtcbiAgfVxufSk7XG5cblxuLy8gQ3JlYXRlIHRoZSBzaW5nbGV0b24gUmVtb3RlQ29sbGVjdGlvbkRyaXZlciBvbmx5IG9uIGRlbWFuZCwgc28gd2Vcbi8vIG9ubHkgcmVxdWlyZSBNb25nbyBjb25maWd1cmF0aW9uIGlmIGl0J3MgYWN0dWFsbHkgdXNlZCAoZWcsIG5vdCBpZlxuLy8geW91J3JlIG9ubHkgdHJ5aW5nIHRvIHJlY2VpdmUgZGF0YSBmcm9tIGEgcmVtb3RlIEREUCBzZXJ2ZXIuKVxuTW9uZ29JbnRlcm5hbHMuZGVmYXVsdFJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIgPSBfLm9uY2UoZnVuY3Rpb24gKCkge1xuICB2YXIgY29ubmVjdGlvbk9wdGlvbnMgPSB7fTtcblxuICB2YXIgbW9uZ29VcmwgPSBwcm9jZXNzLmVudi5NT05HT19VUkw7XG5cbiAgaWYgKHByb2Nlc3MuZW52Lk1PTkdPX09QTE9HX1VSTCkge1xuICAgIGNvbm5lY3Rpb25PcHRpb25zLm9wbG9nVXJsID0gcHJvY2Vzcy5lbnYuTU9OR09fT1BMT0dfVVJMO1xuICB9XG5cbiAgaWYgKCEgbW9uZ29VcmwpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTU9OR09fVVJMIG11c3QgYmUgc2V0IGluIGVudmlyb25tZW50XCIpO1xuXG4gIHJldHVybiBuZXcgTW9uZ29JbnRlcm5hbHMuUmVtb3RlQ29sbGVjdGlvbkRyaXZlcihtb25nb1VybCwgY29ubmVjdGlvbk9wdGlvbnMpO1xufSk7XG4iLCIvLyBvcHRpb25zLmNvbm5lY3Rpb24sIGlmIGdpdmVuLCBpcyBhIExpdmVkYXRhQ2xpZW50IG9yIExpdmVkYXRhU2VydmVyXG4vLyBYWFggcHJlc2VudGx5IHRoZXJlIGlzIG5vIHdheSB0byBkZXN0cm95L2NsZWFuIHVwIGEgQ29sbGVjdGlvblxuXG4vKipcbiAqIEBzdW1tYXJ5IE5hbWVzcGFjZSBmb3IgTW9uZ29EQi1yZWxhdGVkIGl0ZW1zXG4gKiBAbmFtZXNwYWNlXG4gKi9cbk1vbmdvID0ge307XG5cbi8qKlxuICogQHN1bW1hcnkgQ29uc3RydWN0b3IgZm9yIGEgQ29sbGVjdGlvblxuICogQGxvY3VzIEFueXdoZXJlXG4gKiBAaW5zdGFuY2VuYW1lIGNvbGxlY3Rpb25cbiAqIEBjbGFzc1xuICogQHBhcmFtIHtTdHJpbmd9IG5hbWUgVGhlIG5hbWUgb2YgdGhlIGNvbGxlY3Rpb24uICBJZiBudWxsLCBjcmVhdGVzIGFuIHVubWFuYWdlZCAodW5zeW5jaHJvbml6ZWQpIGxvY2FsIGNvbGxlY3Rpb24uXG4gKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucy5jb25uZWN0aW9uIFRoZSBzZXJ2ZXIgY29ubmVjdGlvbiB0aGF0IHdpbGwgbWFuYWdlIHRoaXMgY29sbGVjdGlvbi4gVXNlcyB0aGUgZGVmYXVsdCBjb25uZWN0aW9uIGlmIG5vdCBzcGVjaWZpZWQuICBQYXNzIHRoZSByZXR1cm4gdmFsdWUgb2YgY2FsbGluZyBbYEREUC5jb25uZWN0YF0oI2RkcF9jb25uZWN0KSB0byBzcGVjaWZ5IGEgZGlmZmVyZW50IHNlcnZlci4gUGFzcyBgbnVsbGAgdG8gc3BlY2lmeSBubyBjb25uZWN0aW9uLiBVbm1hbmFnZWQgKGBuYW1lYCBpcyBudWxsKSBjb2xsZWN0aW9ucyBjYW5ub3Qgc3BlY2lmeSBhIGNvbm5lY3Rpb24uXG4gKiBAcGFyYW0ge1N0cmluZ30gb3B0aW9ucy5pZEdlbmVyYXRpb24gVGhlIG1ldGhvZCBvZiBnZW5lcmF0aW5nIHRoZSBgX2lkYCBmaWVsZHMgb2YgbmV3IGRvY3VtZW50cyBpbiB0aGlzIGNvbGxlY3Rpb24uICBQb3NzaWJsZSB2YWx1ZXM6XG5cbiAtICoqYCdTVFJJTkcnYCoqOiByYW5kb20gc3RyaW5nc1xuIC0gKipgJ01PTkdPJ2AqKjogIHJhbmRvbSBbYE1vbmdvLk9iamVjdElEYF0oI21vbmdvX29iamVjdF9pZCkgdmFsdWVzXG5cblRoZSBkZWZhdWx0IGlkIGdlbmVyYXRpb24gdGVjaG5pcXVlIGlzIGAnU1RSSU5HJ2AuXG4gKiBAcGFyYW0ge0Z1bmN0aW9ufSBvcHRpb25zLnRyYW5zZm9ybSBBbiBvcHRpb25hbCB0cmFuc2Zvcm1hdGlvbiBmdW5jdGlvbi4gRG9jdW1lbnRzIHdpbGwgYmUgcGFzc2VkIHRocm91Z2ggdGhpcyBmdW5jdGlvbiBiZWZvcmUgYmVpbmcgcmV0dXJuZWQgZnJvbSBgZmV0Y2hgIG9yIGBmaW5kT25lYCwgYW5kIGJlZm9yZSBiZWluZyBwYXNzZWQgdG8gY2FsbGJhY2tzIG9mIGBvYnNlcnZlYCwgYG1hcGAsIGBmb3JFYWNoYCwgYGFsbG93YCwgYW5kIGBkZW55YC4gVHJhbnNmb3JtcyBhcmUgKm5vdCogYXBwbGllZCBmb3IgdGhlIGNhbGxiYWNrcyBvZiBgb2JzZXJ2ZUNoYW5nZXNgIG9yIHRvIGN1cnNvcnMgcmV0dXJuZWQgZnJvbSBwdWJsaXNoIGZ1bmN0aW9ucy5cbiAqIEBwYXJhbSB7Qm9vbGVhbn0gb3B0aW9ucy5kZWZpbmVNdXRhdGlvbk1ldGhvZHMgU2V0IHRvIGBmYWxzZWAgdG8gc2tpcCBzZXR0aW5nIHVwIHRoZSBtdXRhdGlvbiBtZXRob2RzIHRoYXQgZW5hYmxlIGluc2VydC91cGRhdGUvcmVtb3ZlIGZyb20gY2xpZW50IGNvZGUuIERlZmF1bHQgYHRydWVgLlxuICovXG5Nb25nby5Db2xsZWN0aW9uID0gZnVuY3Rpb24gQ29sbGVjdGlvbihuYW1lLCBvcHRpb25zKSB7XG4gIGlmICghbmFtZSAmJiAobmFtZSAhPT0gbnVsbCkpIHtcbiAgICBNZXRlb3IuX2RlYnVnKFwiV2FybmluZzogY3JlYXRpbmcgYW5vbnltb3VzIGNvbGxlY3Rpb24uIEl0IHdpbGwgbm90IGJlIFwiICtcbiAgICAgICAgICAgICAgICAgIFwic2F2ZWQgb3Igc3luY2hyb25pemVkIG92ZXIgdGhlIG5ldHdvcmsuIChQYXNzIG51bGwgZm9yIFwiICtcbiAgICAgICAgICAgICAgICAgIFwidGhlIGNvbGxlY3Rpb24gbmFtZSB0byB0dXJuIG9mZiB0aGlzIHdhcm5pbmcuKVwiKTtcbiAgICBuYW1lID0gbnVsbDtcbiAgfVxuXG4gIGlmIChuYW1lICE9PSBudWxsICYmIHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJGaXJzdCBhcmd1bWVudCB0byBuZXcgTW9uZ28uQ29sbGVjdGlvbiBtdXN0IGJlIGEgc3RyaW5nIG9yIG51bGxcIik7XG4gIH1cblxuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLm1ldGhvZHMpIHtcbiAgICAvLyBCYWNrd2FyZHMgY29tcGF0aWJpbGl0eSBoYWNrIHdpdGggb3JpZ2luYWwgc2lnbmF0dXJlICh3aGljaCBwYXNzZWRcbiAgICAvLyBcImNvbm5lY3Rpb25cIiBkaXJlY3RseSBpbnN0ZWFkIG9mIGluIG9wdGlvbnMuIChDb25uZWN0aW9ucyBtdXN0IGhhdmUgYSBcIm1ldGhvZHNcIlxuICAgIC8vIG1ldGhvZC4pXG4gICAgLy8gWFhYIHJlbW92ZSBiZWZvcmUgMS4wXG4gICAgb3B0aW9ucyA9IHtjb25uZWN0aW9uOiBvcHRpb25zfTtcbiAgfVxuICAvLyBCYWNrd2FyZHMgY29tcGF0aWJpbGl0eTogXCJjb25uZWN0aW9uXCIgdXNlZCB0byBiZSBjYWxsZWQgXCJtYW5hZ2VyXCIuXG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMubWFuYWdlciAmJiAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgb3B0aW9ucy5jb25uZWN0aW9uID0gb3B0aW9ucy5tYW5hZ2VyO1xuICB9XG5cbiAgb3B0aW9ucyA9IHtcbiAgICBjb25uZWN0aW9uOiB1bmRlZmluZWQsXG4gICAgaWRHZW5lcmF0aW9uOiAnU1RSSU5HJyxcbiAgICB0cmFuc2Zvcm06IG51bGwsXG4gICAgX2RyaXZlcjogdW5kZWZpbmVkLFxuICAgIF9wcmV2ZW50QXV0b3B1Ymxpc2g6IGZhbHNlLFxuICAgICAgLi4ub3B0aW9ucyxcbiAgfTtcblxuICBzd2l0Y2ggKG9wdGlvbnMuaWRHZW5lcmF0aW9uKSB7XG4gIGNhc2UgJ01PTkdPJzpcbiAgICB0aGlzLl9tYWtlTmV3SUQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgc3JjID0gbmFtZSA/IEREUC5yYW5kb21TdHJlYW0oJy9jb2xsZWN0aW9uLycgKyBuYW1lKSA6IFJhbmRvbS5pbnNlY3VyZTtcbiAgICAgIHJldHVybiBuZXcgTW9uZ28uT2JqZWN0SUQoc3JjLmhleFN0cmluZygyNCkpO1xuICAgIH07XG4gICAgYnJlYWs7XG4gIGNhc2UgJ1NUUklORyc6XG4gIGRlZmF1bHQ6XG4gICAgdGhpcy5fbWFrZU5ld0lEID0gZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIHNyYyA9IG5hbWUgPyBERFAucmFuZG9tU3RyZWFtKCcvY29sbGVjdGlvbi8nICsgbmFtZSkgOiBSYW5kb20uaW5zZWN1cmU7XG4gICAgICByZXR1cm4gc3JjLmlkKCk7XG4gICAgfTtcbiAgICBicmVhaztcbiAgfVxuXG4gIHRoaXMuX3RyYW5zZm9ybSA9IExvY2FsQ29sbGVjdGlvbi53cmFwVHJhbnNmb3JtKG9wdGlvbnMudHJhbnNmb3JtKTtcblxuICBpZiAoISBuYW1lIHx8IG9wdGlvbnMuY29ubmVjdGlvbiA9PT0gbnVsbClcbiAgICAvLyBub3RlOiBuYW1lbGVzcyBjb2xsZWN0aW9ucyBuZXZlciBoYXZlIGEgY29ubmVjdGlvblxuICAgIHRoaXMuX2Nvbm5lY3Rpb24gPSBudWxsO1xuICBlbHNlIGlmIChvcHRpb25zLmNvbm5lY3Rpb24pXG4gICAgdGhpcy5fY29ubmVjdGlvbiA9IG9wdGlvbnMuY29ubmVjdGlvbjtcbiAgZWxzZSBpZiAoTWV0ZW9yLmlzQ2xpZW50KVxuICAgIHRoaXMuX2Nvbm5lY3Rpb24gPSBNZXRlb3IuY29ubmVjdGlvbjtcbiAgZWxzZVxuICAgIHRoaXMuX2Nvbm5lY3Rpb24gPSBNZXRlb3Iuc2VydmVyO1xuXG4gIGlmICghb3B0aW9ucy5fZHJpdmVyKSB7XG4gICAgLy8gWFhYIFRoaXMgY2hlY2sgYXNzdW1lcyB0aGF0IHdlYmFwcCBpcyBsb2FkZWQgc28gdGhhdCBNZXRlb3Iuc2VydmVyICE9PVxuICAgIC8vIG51bGwuIFdlIHNob3VsZCBmdWxseSBzdXBwb3J0IHRoZSBjYXNlIG9mIFwid2FudCB0byB1c2UgYSBNb25nby1iYWNrZWRcbiAgICAvLyBjb2xsZWN0aW9uIGZyb20gTm9kZSBjb2RlIHdpdGhvdXQgd2ViYXBwXCIsIGJ1dCB3ZSBkb24ndCB5ZXQuXG4gICAgLy8gI01ldGVvclNlcnZlck51bGxcbiAgICBpZiAobmFtZSAmJiB0aGlzLl9jb25uZWN0aW9uID09PSBNZXRlb3Iuc2VydmVyICYmXG4gICAgICAgIHR5cGVvZiBNb25nb0ludGVybmFscyAhPT0gXCJ1bmRlZmluZWRcIiAmJlxuICAgICAgICBNb25nb0ludGVybmFscy5kZWZhdWx0UmVtb3RlQ29sbGVjdGlvbkRyaXZlcikge1xuICAgICAgb3B0aW9ucy5fZHJpdmVyID0gTW9uZ29JbnRlcm5hbHMuZGVmYXVsdFJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgeyBMb2NhbENvbGxlY3Rpb25Ecml2ZXIgfSA9XG4gICAgICAgIHJlcXVpcmUoXCIuL2xvY2FsX2NvbGxlY3Rpb25fZHJpdmVyLmpzXCIpO1xuICAgICAgb3B0aW9ucy5fZHJpdmVyID0gTG9jYWxDb2xsZWN0aW9uRHJpdmVyO1xuICAgIH1cbiAgfVxuXG4gIHRoaXMuX2NvbGxlY3Rpb24gPSBvcHRpb25zLl9kcml2ZXIub3BlbihuYW1lLCB0aGlzLl9jb25uZWN0aW9uKTtcbiAgdGhpcy5fbmFtZSA9IG5hbWU7XG4gIHRoaXMuX2RyaXZlciA9IG9wdGlvbnMuX2RyaXZlcjtcblxuICB0aGlzLl9tYXliZVNldFVwUmVwbGljYXRpb24obmFtZSwgb3B0aW9ucyk7XG5cbiAgLy8gWFhYIGRvbid0IGRlZmluZSB0aGVzZSB1bnRpbCBhbGxvdyBvciBkZW55IGlzIGFjdHVhbGx5IHVzZWQgZm9yIHRoaXNcbiAgLy8gY29sbGVjdGlvbi4gQ291bGQgYmUgaGFyZCBpZiB0aGUgc2VjdXJpdHkgcnVsZXMgYXJlIG9ubHkgZGVmaW5lZCBvbiB0aGVcbiAgLy8gc2VydmVyLlxuICBpZiAob3B0aW9ucy5kZWZpbmVNdXRhdGlvbk1ldGhvZHMgIT09IGZhbHNlKSB7XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuX2RlZmluZU11dGF0aW9uTWV0aG9kcyh7XG4gICAgICAgIHVzZUV4aXN0aW5nOiBvcHRpb25zLl9zdXBwcmVzc1NhbWVOYW1lRXJyb3IgPT09IHRydWVcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAvLyBUaHJvdyBhIG1vcmUgdW5kZXJzdGFuZGFibGUgZXJyb3Igb24gdGhlIHNlcnZlciBmb3Igc2FtZSBjb2xsZWN0aW9uIG5hbWVcbiAgICAgIGlmIChlcnJvci5tZXNzYWdlID09PSBgQSBtZXRob2QgbmFtZWQgJy8ke25hbWV9L2luc2VydCcgaXMgYWxyZWFkeSBkZWZpbmVkYClcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGVyZSBpcyBhbHJlYWR5IGEgY29sbGVjdGlvbiBuYW1lZCBcIiR7bmFtZX1cImApO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLy8gYXV0b3B1Ymxpc2hcbiAgaWYgKFBhY2thZ2UuYXV0b3B1Ymxpc2ggJiZcbiAgICAgICEgb3B0aW9ucy5fcHJldmVudEF1dG9wdWJsaXNoICYmXG4gICAgICB0aGlzLl9jb25uZWN0aW9uICYmXG4gICAgICB0aGlzLl9jb25uZWN0aW9uLnB1Ymxpc2gpIHtcbiAgICB0aGlzLl9jb25uZWN0aW9uLnB1Ymxpc2gobnVsbCwgKCkgPT4gdGhpcy5maW5kKCksIHtcbiAgICAgIGlzX2F1dG86IHRydWUsXG4gICAgfSk7XG4gIH1cbn07XG5cbk9iamVjdC5hc3NpZ24oTW9uZ28uQ29sbGVjdGlvbi5wcm90b3R5cGUsIHtcbiAgX21heWJlU2V0VXBSZXBsaWNhdGlvbihuYW1lLCB7XG4gICAgX3N1cHByZXNzU2FtZU5hbWVFcnJvciA9IGZhbHNlXG4gIH0pIHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBpZiAoISAoc2VsZi5fY29ubmVjdGlvbiAmJlxuICAgICAgICAgICBzZWxmLl9jb25uZWN0aW9uLnJlZ2lzdGVyU3RvcmUpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gT0ssIHdlJ3JlIGdvaW5nIHRvIGJlIGEgc2xhdmUsIHJlcGxpY2F0aW5nIHNvbWUgcmVtb3RlXG4gICAgLy8gZGF0YWJhc2UsIGV4Y2VwdCBwb3NzaWJseSB3aXRoIHNvbWUgdGVtcG9yYXJ5IGRpdmVyZ2VuY2Ugd2hpbGVcbiAgICAvLyB3ZSBoYXZlIHVuYWNrbm93bGVkZ2VkIFJQQydzLlxuICAgIGNvbnN0IG9rID0gc2VsZi5fY29ubmVjdGlvbi5yZWdpc3RlclN0b3JlKG5hbWUsIHtcbiAgICAgIC8vIENhbGxlZCBhdCB0aGUgYmVnaW5uaW5nIG9mIGEgYmF0Y2ggb2YgdXBkYXRlcy4gYmF0Y2hTaXplIGlzIHRoZSBudW1iZXJcbiAgICAgIC8vIG9mIHVwZGF0ZSBjYWxscyB0byBleHBlY3QuXG4gICAgICAvL1xuICAgICAgLy8gWFhYIFRoaXMgaW50ZXJmYWNlIGlzIHByZXR0eSBqYW5reS4gcmVzZXQgcHJvYmFibHkgb3VnaHQgdG8gZ28gYmFjayB0b1xuICAgICAgLy8gYmVpbmcgaXRzIG93biBmdW5jdGlvbiwgYW5kIGNhbGxlcnMgc2hvdWxkbid0IGhhdmUgdG8gY2FsY3VsYXRlXG4gICAgICAvLyBiYXRjaFNpemUuIFRoZSBvcHRpbWl6YXRpb24gb2Ygbm90IGNhbGxpbmcgcGF1c2UvcmVtb3ZlIHNob3VsZCBiZVxuICAgICAgLy8gZGVsYXllZCB1bnRpbCBsYXRlcjogdGhlIGZpcnN0IGNhbGwgdG8gdXBkYXRlKCkgc2hvdWxkIGJ1ZmZlciBpdHNcbiAgICAgIC8vIG1lc3NhZ2UsIGFuZCB0aGVuIHdlIGNhbiBlaXRoZXIgZGlyZWN0bHkgYXBwbHkgaXQgYXQgZW5kVXBkYXRlIHRpbWUgaWZcbiAgICAgIC8vIGl0IHdhcyB0aGUgb25seSB1cGRhdGUsIG9yIGRvIHBhdXNlT2JzZXJ2ZXJzL2FwcGx5L2FwcGx5IGF0IHRoZSBuZXh0XG4gICAgICAvLyB1cGRhdGUoKSBpZiB0aGVyZSdzIGFub3RoZXIgb25lLlxuICAgICAgYmVnaW5VcGRhdGUoYmF0Y2hTaXplLCByZXNldCkge1xuICAgICAgICAvLyBwYXVzZSBvYnNlcnZlcnMgc28gdXNlcnMgZG9uJ3Qgc2VlIGZsaWNrZXIgd2hlbiB1cGRhdGluZyBzZXZlcmFsXG4gICAgICAgIC8vIG9iamVjdHMgYXQgb25jZSAoaW5jbHVkaW5nIHRoZSBwb3N0LXJlY29ubmVjdCByZXNldC1hbmQtcmVhcHBseVxuICAgICAgICAvLyBzdGFnZSksIGFuZCBzbyB0aGF0IGEgcmUtc29ydGluZyBvZiBhIHF1ZXJ5IGNhbiB0YWtlIGFkdmFudGFnZSBvZiB0aGVcbiAgICAgICAgLy8gZnVsbCBfZGlmZlF1ZXJ5IG1vdmVkIGNhbGN1bGF0aW9uIGluc3RlYWQgb2YgYXBwbHlpbmcgY2hhbmdlIG9uZSBhdCBhXG4gICAgICAgIC8vIHRpbWUuXG4gICAgICAgIGlmIChiYXRjaFNpemUgPiAxIHx8IHJlc2V0KVxuICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24ucGF1c2VPYnNlcnZlcnMoKTtcblxuICAgICAgICBpZiAocmVzZXQpXG4gICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5yZW1vdmUoe30pO1xuICAgICAgfSxcblxuICAgICAgLy8gQXBwbHkgYW4gdXBkYXRlLlxuICAgICAgLy8gWFhYIGJldHRlciBzcGVjaWZ5IHRoaXMgaW50ZXJmYWNlIChub3QgaW4gdGVybXMgb2YgYSB3aXJlIG1lc3NhZ2UpP1xuICAgICAgdXBkYXRlKG1zZykge1xuICAgICAgICB2YXIgbW9uZ29JZCA9IE1vbmdvSUQuaWRQYXJzZShtc2cuaWQpO1xuICAgICAgICB2YXIgZG9jID0gc2VsZi5fY29sbGVjdGlvbi5maW5kT25lKG1vbmdvSWQpO1xuXG4gICAgICAgIC8vIElzIHRoaXMgYSBcInJlcGxhY2UgdGhlIHdob2xlIGRvY1wiIG1lc3NhZ2UgY29taW5nIGZyb20gdGhlIHF1aWVzY2VuY2VcbiAgICAgICAgLy8gb2YgbWV0aG9kIHdyaXRlcyB0byBhbiBvYmplY3Q/IChOb3RlIHRoYXQgJ3VuZGVmaW5lZCcgaXMgYSB2YWxpZFxuICAgICAgICAvLyB2YWx1ZSBtZWFuaW5nIFwicmVtb3ZlIGl0XCIuKVxuICAgICAgICBpZiAobXNnLm1zZyA9PT0gJ3JlcGxhY2UnKSB7XG4gICAgICAgICAgdmFyIHJlcGxhY2UgPSBtc2cucmVwbGFjZTtcbiAgICAgICAgICBpZiAoIXJlcGxhY2UpIHtcbiAgICAgICAgICAgIGlmIChkb2MpXG4gICAgICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24ucmVtb3ZlKG1vbmdvSWQpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoIWRvYykge1xuICAgICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5pbnNlcnQocmVwbGFjZSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIFhYWCBjaGVjayB0aGF0IHJlcGxhY2UgaGFzIG5vICQgb3BzXG4gICAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnVwZGF0ZShtb25nb0lkLCByZXBsYWNlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IGVsc2UgaWYgKG1zZy5tc2cgPT09ICdhZGRlZCcpIHtcbiAgICAgICAgICBpZiAoZG9jKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCBub3QgdG8gZmluZCBhIGRvY3VtZW50IGFscmVhZHkgcHJlc2VudCBmb3IgYW4gYWRkXCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLmluc2VydCh7IF9pZDogbW9uZ29JZCwgLi4ubXNnLmZpZWxkcyB9KTtcbiAgICAgICAgfSBlbHNlIGlmIChtc2cubXNnID09PSAncmVtb3ZlZCcpIHtcbiAgICAgICAgICBpZiAoIWRvYylcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIHRvIGZpbmQgYSBkb2N1bWVudCBhbHJlYWR5IHByZXNlbnQgZm9yIHJlbW92ZWRcIik7XG4gICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5yZW1vdmUobW9uZ29JZCk7XG4gICAgICAgIH0gZWxzZSBpZiAobXNnLm1zZyA9PT0gJ2NoYW5nZWQnKSB7XG4gICAgICAgICAgaWYgKCFkb2MpXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCB0byBmaW5kIGEgZG9jdW1lbnQgdG8gY2hhbmdlXCIpO1xuICAgICAgICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhtc2cuZmllbGRzKTtcbiAgICAgICAgICBpZiAoa2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICB2YXIgbW9kaWZpZXIgPSB7fTtcbiAgICAgICAgICAgIGtleXMuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IG1zZy5maWVsZHNba2V5XTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgICAgICAgICAgIGlmICghbW9kaWZpZXIuJHVuc2V0KSB7XG4gICAgICAgICAgICAgICAgICBtb2RpZmllci4kdW5zZXQgPSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbW9kaWZpZXIuJHVuc2V0W2tleV0gPSAxO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmICghbW9kaWZpZXIuJHNldCkge1xuICAgICAgICAgICAgICAgICAgbW9kaWZpZXIuJHNldCA9IHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtb2RpZmllci4kc2V0W2tleV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnVwZGF0ZShtb25nb0lkLCBtb2RpZmllcik7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkkgZG9uJ3Qga25vdyBob3cgdG8gZGVhbCB3aXRoIHRoaXMgbWVzc2FnZVwiKTtcbiAgICAgICAgfVxuICAgICAgfSxcblxuICAgICAgLy8gQ2FsbGVkIGF0IHRoZSBlbmQgb2YgYSBiYXRjaCBvZiB1cGRhdGVzLlxuICAgICAgZW5kVXBkYXRlKCkge1xuICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnJlc3VtZU9ic2VydmVycygpO1xuICAgICAgfSxcblxuICAgICAgLy8gQ2FsbGVkIGFyb3VuZCBtZXRob2Qgc3R1YiBpbnZvY2F0aW9ucyB0byBjYXB0dXJlIHRoZSBvcmlnaW5hbCB2ZXJzaW9uc1xuICAgICAgLy8gb2YgbW9kaWZpZWQgZG9jdW1lbnRzLlxuICAgICAgc2F2ZU9yaWdpbmFscygpIHtcbiAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5zYXZlT3JpZ2luYWxzKCk7XG4gICAgICB9LFxuICAgICAgcmV0cmlldmVPcmlnaW5hbHMoKSB7XG4gICAgICAgIHJldHVybiBzZWxmLl9jb2xsZWN0aW9uLnJldHJpZXZlT3JpZ2luYWxzKCk7XG4gICAgICB9LFxuXG4gICAgICAvLyBVc2VkIHRvIHByZXNlcnZlIGN1cnJlbnQgdmVyc2lvbnMgb2YgZG9jdW1lbnRzIGFjcm9zcyBhIHN0b3JlIHJlc2V0LlxuICAgICAgZ2V0RG9jKGlkKSB7XG4gICAgICAgIHJldHVybiBzZWxmLmZpbmRPbmUoaWQpO1xuICAgICAgfSxcblxuICAgICAgLy8gVG8gYmUgYWJsZSB0byBnZXQgYmFjayB0byB0aGUgY29sbGVjdGlvbiBmcm9tIHRoZSBzdG9yZS5cbiAgICAgIF9nZXRDb2xsZWN0aW9uKCkge1xuICAgICAgICByZXR1cm4gc2VsZjtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmICghIG9rKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYFRoZXJlIGlzIGFscmVhZHkgYSBjb2xsZWN0aW9uIG5hbWVkIFwiJHtuYW1lfVwiYDtcbiAgICAgIGlmIChfc3VwcHJlc3NTYW1lTmFtZUVycm9yID09PSB0cnVlKSB7XG4gICAgICAgIC8vIFhYWCBJbiB0aGVvcnkgd2UgZG8gbm90IGhhdmUgdG8gdGhyb3cgd2hlbiBgb2tgIGlzIGZhbHN5LiBUaGVcbiAgICAgICAgLy8gc3RvcmUgaXMgYWxyZWFkeSBkZWZpbmVkIGZvciB0aGlzIGNvbGxlY3Rpb24gbmFtZSwgYnV0IHRoaXNcbiAgICAgICAgLy8gd2lsbCBzaW1wbHkgYmUgYW5vdGhlciByZWZlcmVuY2UgdG8gaXQgYW5kIGV2ZXJ5dGhpbmcgc2hvdWxkXG4gICAgICAgIC8vIHdvcmsuIEhvd2V2ZXIsIHdlIGhhdmUgaGlzdG9yaWNhbGx5IHRocm93biBhbiBlcnJvciBoZXJlLCBzb1xuICAgICAgICAvLyBmb3Igbm93IHdlIHdpbGwgc2tpcCB0aGUgZXJyb3Igb25seSB3aGVuIF9zdXBwcmVzc1NhbWVOYW1lRXJyb3JcbiAgICAgICAgLy8gaXMgYHRydWVgLCBhbGxvd2luZyBwZW9wbGUgdG8gb3B0IGluIGFuZCBnaXZlIHRoaXMgc29tZSByZWFsXG4gICAgICAgIC8vIHdvcmxkIHRlc3RpbmcuXG4gICAgICAgIGNvbnNvbGUud2FybiA/IGNvbnNvbGUud2FybihtZXNzYWdlKSA6IGNvbnNvbGUubG9nKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgfVxuICAgIH1cbiAgfSxcblxuICAvLy9cbiAgLy8vIE1haW4gY29sbGVjdGlvbiBBUElcbiAgLy8vXG5cbiAgX2dldEZpbmRTZWxlY3RvcihhcmdzKSB7XG4gICAgaWYgKGFyZ3MubGVuZ3RoID09IDApXG4gICAgICByZXR1cm4ge307XG4gICAgZWxzZVxuICAgICAgcmV0dXJuIGFyZ3NbMF07XG4gIH0sXG5cbiAgX2dldEZpbmRPcHRpb25zKGFyZ3MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKGFyZ3MubGVuZ3RoIDwgMikge1xuICAgICAgcmV0dXJuIHsgdHJhbnNmb3JtOiBzZWxmLl90cmFuc2Zvcm0gfTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2hlY2soYXJnc1sxXSwgTWF0Y2guT3B0aW9uYWwoTWF0Y2guT2JqZWN0SW5jbHVkaW5nKHtcbiAgICAgICAgZmllbGRzOiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihPYmplY3QsIHVuZGVmaW5lZCkpLFxuICAgICAgICBzb3J0OiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihPYmplY3QsIEFycmF5LCBGdW5jdGlvbiwgdW5kZWZpbmVkKSksXG4gICAgICAgIGxpbWl0OiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihOdW1iZXIsIHVuZGVmaW5lZCkpLFxuICAgICAgICBza2lwOiBNYXRjaC5PcHRpb25hbChNYXRjaC5PbmVPZihOdW1iZXIsIHVuZGVmaW5lZCkpXG4gICAgICB9KSkpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICB0cmFuc2Zvcm06IHNlbGYuX3RyYW5zZm9ybSxcbiAgICAgICAgLi4uYXJnc1sxXSxcbiAgICAgIH07XG4gICAgfVxuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBGaW5kIHRoZSBkb2N1bWVudHMgaW4gYSBjb2xsZWN0aW9uIHRoYXQgbWF0Y2ggdGhlIHNlbGVjdG9yLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCBmaW5kXG4gICAqIEBtZW1iZXJvZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge01vbmdvU2VsZWN0b3J9IFtzZWxlY3Rvcl0gQSBxdWVyeSBkZXNjcmliaW5nIHRoZSBkb2N1bWVudHMgdG8gZmluZFxuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdXG4gICAqIEBwYXJhbSB7TW9uZ29Tb3J0U3BlY2lmaWVyfSBvcHRpb25zLnNvcnQgU29ydCBvcmRlciAoZGVmYXVsdDogbmF0dXJhbCBvcmRlcilcbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMuc2tpcCBOdW1iZXIgb2YgcmVzdWx0cyB0byBza2lwIGF0IHRoZSBiZWdpbm5pbmdcbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMubGltaXQgTWF4aW11bSBudW1iZXIgb2YgcmVzdWx0cyB0byByZXR1cm5cbiAgICogQHBhcmFtIHtNb25nb0ZpZWxkU3BlY2lmaWVyfSBvcHRpb25zLmZpZWxkcyBEaWN0aW9uYXJ5IG9mIGZpZWxkcyB0byByZXR1cm4gb3IgZXhjbHVkZS5cbiAgICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLnJlYWN0aXZlIChDbGllbnQgb25seSkgRGVmYXVsdCBgdHJ1ZWA7IHBhc3MgYGZhbHNlYCB0byBkaXNhYmxlIHJlYWN0aXZpdHlcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gb3B0aW9ucy50cmFuc2Zvcm0gT3ZlcnJpZGVzIGB0cmFuc2Zvcm1gIG9uIHRoZSAgW2BDb2xsZWN0aW9uYF0oI2NvbGxlY3Rpb25zKSBmb3IgdGhpcyBjdXJzb3IuICBQYXNzIGBudWxsYCB0byBkaXNhYmxlIHRyYW5zZm9ybWF0aW9uLlxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMuZGlzYWJsZU9wbG9nIChTZXJ2ZXIgb25seSkgUGFzcyB0cnVlIHRvIGRpc2FibGUgb3Bsb2ctdGFpbGluZyBvbiB0aGlzIHF1ZXJ5LiBUaGlzIGFmZmVjdHMgdGhlIHdheSBzZXJ2ZXIgcHJvY2Vzc2VzIGNhbGxzIHRvIGBvYnNlcnZlYCBvbiB0aGlzIHF1ZXJ5LiBEaXNhYmxpbmcgdGhlIG9wbG9nIGNhbiBiZSB1c2VmdWwgd2hlbiB3b3JraW5nIHdpdGggZGF0YSB0aGF0IHVwZGF0ZXMgaW4gbGFyZ2UgYmF0Y2hlcy5cbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMucG9sbGluZ0ludGVydmFsTXMgKFNlcnZlciBvbmx5KSBXaGVuIG9wbG9nIGlzIGRpc2FibGVkICh0aHJvdWdoIHRoZSB1c2Ugb2YgYGRpc2FibGVPcGxvZ2Agb3Igd2hlbiBvdGhlcndpc2Ugbm90IGF2YWlsYWJsZSksIHRoZSBmcmVxdWVuY3kgKGluIG1pbGxpc2Vjb25kcykgb2YgaG93IG9mdGVuIHRvIHBvbGwgdGhpcyBxdWVyeSB3aGVuIG9ic2VydmluZyBvbiB0aGUgc2VydmVyLiBEZWZhdWx0cyB0byAxMDAwMG1zICgxMCBzZWNvbmRzKS5cbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMucG9sbGluZ1Rocm90dGxlTXMgKFNlcnZlciBvbmx5KSBXaGVuIG9wbG9nIGlzIGRpc2FibGVkICh0aHJvdWdoIHRoZSB1c2Ugb2YgYGRpc2FibGVPcGxvZ2Agb3Igd2hlbiBvdGhlcndpc2Ugbm90IGF2YWlsYWJsZSksIHRoZSBtaW5pbXVtIHRpbWUgKGluIG1pbGxpc2Vjb25kcykgdG8gYWxsb3cgYmV0d2VlbiByZS1wb2xsaW5nIHdoZW4gb2JzZXJ2aW5nIG9uIHRoZSBzZXJ2ZXIuIEluY3JlYXNpbmcgdGhpcyB3aWxsIHNhdmUgQ1BVIGFuZCBtb25nbyBsb2FkIGF0IHRoZSBleHBlbnNlIG9mIHNsb3dlciB1cGRhdGVzIHRvIHVzZXJzLiBEZWNyZWFzaW5nIHRoaXMgaXMgbm90IHJlY29tbWVuZGVkLiBEZWZhdWx0cyB0byA1MG1zLlxuICAgKiBAcGFyYW0ge051bWJlcn0gb3B0aW9ucy5tYXhUaW1lTXMgKFNlcnZlciBvbmx5KSBJZiBzZXQsIGluc3RydWN0cyBNb25nb0RCIHRvIHNldCBhIHRpbWUgbGltaXQgZm9yIHRoaXMgY3Vyc29yJ3Mgb3BlcmF0aW9ucy4gSWYgdGhlIG9wZXJhdGlvbiByZWFjaGVzIHRoZSBzcGVjaWZpZWQgdGltZSBsaW1pdCAoaW4gbWlsbGlzZWNvbmRzKSB3aXRob3V0IHRoZSBoYXZpbmcgYmVlbiBjb21wbGV0ZWQsIGFuIGV4Y2VwdGlvbiB3aWxsIGJlIHRocm93bi4gVXNlZnVsIHRvIHByZXZlbnQgYW4gKGFjY2lkZW50YWwgb3IgbWFsaWNpb3VzKSB1bm9wdGltaXplZCBxdWVyeSBmcm9tIGNhdXNpbmcgYSBmdWxsIGNvbGxlY3Rpb24gc2NhbiB0aGF0IHdvdWxkIGRpc3J1cHQgb3RoZXIgZGF0YWJhc2UgdXNlcnMsIGF0IHRoZSBleHBlbnNlIG9mIG5lZWRpbmcgdG8gaGFuZGxlIHRoZSByZXN1bHRpbmcgZXJyb3IuXG4gICAqIEBwYXJhbSB7U3RyaW5nfE9iamVjdH0gb3B0aW9ucy5oaW50IChTZXJ2ZXIgb25seSkgT3ZlcnJpZGVzIE1vbmdvREIncyBkZWZhdWx0IGluZGV4IHNlbGVjdGlvbiBhbmQgcXVlcnkgb3B0aW1pemF0aW9uIHByb2Nlc3MuIFNwZWNpZnkgYW4gaW5kZXggdG8gZm9yY2UgaXRzIHVzZSwgZWl0aGVyIGJ5IGl0cyBuYW1lIG9yIGluZGV4IHNwZWNpZmljYXRpb24uIFlvdSBjYW4gYWxzbyBzcGVjaWZ5IGB7ICRuYXR1cmFsIDogMSB9YCB0byBmb3JjZSBhIGZvcndhcmRzIGNvbGxlY3Rpb24gc2Nhbiwgb3IgYHsgJG5hdHVyYWwgOiAtMSB9YCBmb3IgYSByZXZlcnNlIGNvbGxlY3Rpb24gc2Nhbi4gU2V0dGluZyB0aGlzIGlzIG9ubHkgcmVjb21tZW5kZWQgZm9yIGFkdmFuY2VkIHVzZXJzLlxuICAgKiBAcmV0dXJucyB7TW9uZ28uQ3Vyc29yfVxuICAgKi9cbiAgZmluZCguLi5hcmdzKSB7XG4gICAgLy8gQ29sbGVjdGlvbi5maW5kKCkgKHJldHVybiBhbGwgZG9jcykgYmVoYXZlcyBkaWZmZXJlbnRseVxuICAgIC8vIGZyb20gQ29sbGVjdGlvbi5maW5kKHVuZGVmaW5lZCkgKHJldHVybiAwIGRvY3MpLiAgc28gYmVcbiAgICAvLyBjYXJlZnVsIGFib3V0IHRoZSBsZW5ndGggb2YgYXJndW1lbnRzLlxuICAgIHJldHVybiB0aGlzLl9jb2xsZWN0aW9uLmZpbmQoXG4gICAgICB0aGlzLl9nZXRGaW5kU2VsZWN0b3IoYXJncyksXG4gICAgICB0aGlzLl9nZXRGaW5kT3B0aW9ucyhhcmdzKVxuICAgICk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IEZpbmRzIHRoZSBmaXJzdCBkb2N1bWVudCB0aGF0IG1hdGNoZXMgdGhlIHNlbGVjdG9yLCBhcyBvcmRlcmVkIGJ5IHNvcnQgYW5kIHNraXAgb3B0aW9ucy4gUmV0dXJucyBgdW5kZWZpbmVkYCBpZiBubyBtYXRjaGluZyBkb2N1bWVudCBpcyBmb3VuZC5cbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEBtZXRob2QgZmluZE9uZVxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBbc2VsZWN0b3JdIEEgcXVlcnkgZGVzY3JpYmluZyB0aGUgZG9jdW1lbnRzIHRvIGZpbmRcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICAgKiBAcGFyYW0ge01vbmdvU29ydFNwZWNpZmllcn0gb3B0aW9ucy5zb3J0IFNvcnQgb3JkZXIgKGRlZmF1bHQ6IG5hdHVyYWwgb3JkZXIpXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBvcHRpb25zLnNraXAgTnVtYmVyIG9mIHJlc3VsdHMgdG8gc2tpcCBhdCB0aGUgYmVnaW5uaW5nXG4gICAqIEBwYXJhbSB7TW9uZ29GaWVsZFNwZWNpZmllcn0gb3B0aW9ucy5maWVsZHMgRGljdGlvbmFyeSBvZiBmaWVsZHMgdG8gcmV0dXJuIG9yIGV4Y2x1ZGUuXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gb3B0aW9ucy5yZWFjdGl2ZSAoQ2xpZW50IG9ubHkpIERlZmF1bHQgdHJ1ZTsgcGFzcyBmYWxzZSB0byBkaXNhYmxlIHJlYWN0aXZpdHlcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gb3B0aW9ucy50cmFuc2Zvcm0gT3ZlcnJpZGVzIGB0cmFuc2Zvcm1gIG9uIHRoZSBbYENvbGxlY3Rpb25gXSgjY29sbGVjdGlvbnMpIGZvciB0aGlzIGN1cnNvci4gIFBhc3MgYG51bGxgIHRvIGRpc2FibGUgdHJhbnNmb3JtYXRpb24uXG4gICAqIEByZXR1cm5zIHtPYmplY3R9XG4gICAqL1xuICBmaW5kT25lKC4uLmFyZ3MpIHtcbiAgICByZXR1cm4gdGhpcy5fY29sbGVjdGlvbi5maW5kT25lKFxuICAgICAgdGhpcy5fZ2V0RmluZFNlbGVjdG9yKGFyZ3MpLFxuICAgICAgdGhpcy5fZ2V0RmluZE9wdGlvbnMoYXJncylcbiAgICApO1xuICB9XG59KTtcblxuT2JqZWN0LmFzc2lnbihNb25nby5Db2xsZWN0aW9uLCB7XG4gIF9wdWJsaXNoQ3Vyc29yKGN1cnNvciwgc3ViLCBjb2xsZWN0aW9uKSB7XG4gICAgdmFyIG9ic2VydmVIYW5kbGUgPSBjdXJzb3Iub2JzZXJ2ZUNoYW5nZXMoe1xuICAgICAgYWRkZWQ6IGZ1bmN0aW9uIChpZCwgZmllbGRzKSB7XG4gICAgICAgIHN1Yi5hZGRlZChjb2xsZWN0aW9uLCBpZCwgZmllbGRzKTtcbiAgICAgIH0sXG4gICAgICBjaGFuZ2VkOiBmdW5jdGlvbiAoaWQsIGZpZWxkcykge1xuICAgICAgICBzdWIuY2hhbmdlZChjb2xsZWN0aW9uLCBpZCwgZmllbGRzKTtcbiAgICAgIH0sXG4gICAgICByZW1vdmVkOiBmdW5jdGlvbiAoaWQpIHtcbiAgICAgICAgc3ViLnJlbW92ZWQoY29sbGVjdGlvbiwgaWQpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gV2UgZG9uJ3QgY2FsbCBzdWIucmVhZHkoKSBoZXJlOiBpdCBnZXRzIGNhbGxlZCBpbiBsaXZlZGF0YV9zZXJ2ZXIsIGFmdGVyXG4gICAgLy8gcG9zc2libHkgY2FsbGluZyBfcHVibGlzaEN1cnNvciBvbiBtdWx0aXBsZSByZXR1cm5lZCBjdXJzb3JzLlxuXG4gICAgLy8gcmVnaXN0ZXIgc3RvcCBjYWxsYmFjayAoZXhwZWN0cyBsYW1iZGEgdy8gbm8gYXJncykuXG4gICAgc3ViLm9uU3RvcChmdW5jdGlvbiAoKSB7XG4gICAgICBvYnNlcnZlSGFuZGxlLnN0b3AoKTtcbiAgICB9KTtcblxuICAgIC8vIHJldHVybiB0aGUgb2JzZXJ2ZUhhbmRsZSBpbiBjYXNlIGl0IG5lZWRzIHRvIGJlIHN0b3BwZWQgZWFybHlcbiAgICByZXR1cm4gb2JzZXJ2ZUhhbmRsZTtcbiAgfSxcblxuICAvLyBwcm90ZWN0IGFnYWluc3QgZGFuZ2Vyb3VzIHNlbGVjdG9ycy4gIGZhbHNleSBhbmQge19pZDogZmFsc2V5fSBhcmUgYm90aFxuICAvLyBsaWtlbHkgcHJvZ3JhbW1lciBlcnJvciwgYW5kIG5vdCB3aGF0IHlvdSB3YW50LCBwYXJ0aWN1bGFybHkgZm9yIGRlc3RydWN0aXZlXG4gIC8vIG9wZXJhdGlvbnMuIElmIGEgZmFsc2V5IF9pZCBpcyBzZW50IGluLCBhIG5ldyBzdHJpbmcgX2lkIHdpbGwgYmVcbiAgLy8gZ2VuZXJhdGVkIGFuZCByZXR1cm5lZDsgaWYgYSBmYWxsYmFja0lkIGlzIHByb3ZpZGVkLCBpdCB3aWxsIGJlIHJldHVybmVkXG4gIC8vIGluc3RlYWQuXG4gIF9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IsIHsgZmFsbGJhY2tJZCB9ID0ge30pIHtcbiAgICAvLyBzaG9ydGhhbmQgLS0gc2NhbGFycyBtYXRjaCBfaWRcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpKVxuICAgICAgc2VsZWN0b3IgPSB7X2lkOiBzZWxlY3Rvcn07XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheShzZWxlY3RvcikpIHtcbiAgICAgIC8vIFRoaXMgaXMgY29uc2lzdGVudCB3aXRoIHRoZSBNb25nbyBjb25zb2xlIGl0c2VsZjsgaWYgd2UgZG9uJ3QgZG8gdGhpc1xuICAgICAgLy8gY2hlY2sgcGFzc2luZyBhbiBlbXB0eSBhcnJheSBlbmRzIHVwIHNlbGVjdGluZyBhbGwgaXRlbXNcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk1vbmdvIHNlbGVjdG9yIGNhbid0IGJlIGFuIGFycmF5LlwiKTtcbiAgICB9XG5cbiAgICBpZiAoIXNlbGVjdG9yIHx8ICgoJ19pZCcgaW4gc2VsZWN0b3IpICYmICFzZWxlY3Rvci5faWQpKSB7XG4gICAgICAvLyBjYW4ndCBtYXRjaCBhbnl0aGluZ1xuICAgICAgcmV0dXJuIHsgX2lkOiBmYWxsYmFja0lkIHx8IFJhbmRvbS5pZCgpIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHNlbGVjdG9yO1xuICB9XG59KTtcblxuT2JqZWN0LmFzc2lnbihNb25nby5Db2xsZWN0aW9uLnByb3RvdHlwZSwge1xuICAvLyAnaW5zZXJ0JyBpbW1lZGlhdGVseSByZXR1cm5zIHRoZSBpbnNlcnRlZCBkb2N1bWVudCdzIG5ldyBfaWQuXG4gIC8vIFRoZSBvdGhlcnMgcmV0dXJuIHZhbHVlcyBpbW1lZGlhdGVseSBpZiB5b3UgYXJlIGluIGEgc3R1YiwgYW4gaW4tbWVtb3J5XG4gIC8vIHVubWFuYWdlZCBjb2xsZWN0aW9uLCBvciBhIG1vbmdvLWJhY2tlZCBjb2xsZWN0aW9uIGFuZCB5b3UgZG9uJ3QgcGFzcyBhXG4gIC8vIGNhbGxiYWNrLiAndXBkYXRlJyBhbmQgJ3JlbW92ZScgcmV0dXJuIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWRcbiAgLy8gZG9jdW1lbnRzLiAndXBzZXJ0JyByZXR1cm5zIGFuIG9iamVjdCB3aXRoIGtleXMgJ251bWJlckFmZmVjdGVkJyBhbmQsIGlmIGFuXG4gIC8vIGluc2VydCBoYXBwZW5lZCwgJ2luc2VydGVkSWQnLlxuICAvL1xuICAvLyBPdGhlcndpc2UsIHRoZSBzZW1hbnRpY3MgYXJlIGV4YWN0bHkgbGlrZSBvdGhlciBtZXRob2RzOiB0aGV5IHRha2VcbiAgLy8gYSBjYWxsYmFjayBhcyBhbiBvcHRpb25hbCBsYXN0IGFyZ3VtZW50OyBpZiBubyBjYWxsYmFjayBpc1xuICAvLyBwcm92aWRlZCwgdGhleSBibG9jayB1bnRpbCB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCBhbmQgdGhyb3cgYW5cbiAgLy8gZXhjZXB0aW9uIGlmIGl0IGZhaWxzOyBpZiBhIGNhbGxiYWNrIGlzIHByb3ZpZGVkLCB0aGVuIHRoZXkgZG9uJ3RcbiAgLy8gbmVjZXNzYXJpbHkgYmxvY2ssIGFuZCB0aGV5IGNhbGwgdGhlIGNhbGxiYWNrIHdoZW4gdGhleSBmaW5pc2ggd2l0aCBlcnJvciBhbmRcbiAgLy8gcmVzdWx0IGFyZ3VtZW50cy4gIChUaGUgaW5zZXJ0IG1ldGhvZCBwcm92aWRlcyB0aGUgZG9jdW1lbnQgSUQgYXMgaXRzIHJlc3VsdDtcbiAgLy8gdXBkYXRlIGFuZCByZW1vdmUgcHJvdmlkZSB0aGUgbnVtYmVyIG9mIGFmZmVjdGVkIGRvY3MgYXMgdGhlIHJlc3VsdDsgdXBzZXJ0XG4gIC8vIHByb3ZpZGVzIGFuIG9iamVjdCB3aXRoIG51bWJlckFmZmVjdGVkIGFuZCBtYXliZSBpbnNlcnRlZElkLilcbiAgLy9cbiAgLy8gT24gdGhlIGNsaWVudCwgYmxvY2tpbmcgaXMgaW1wb3NzaWJsZSwgc28gaWYgYSBjYWxsYmFja1xuICAvLyBpc24ndCBwcm92aWRlZCwgdGhleSBqdXN0IHJldHVybiBpbW1lZGlhdGVseSBhbmQgYW55IGVycm9yXG4gIC8vIGluZm9ybWF0aW9uIGlzIGxvc3QuXG4gIC8vXG4gIC8vIFRoZXJlJ3Mgb25lIG1vcmUgdHdlYWsuIE9uIHRoZSBjbGllbnQsIGlmIHlvdSBkb24ndCBwcm92aWRlIGFcbiAgLy8gY2FsbGJhY2ssIHRoZW4gaWYgdGhlcmUgaXMgYW4gZXJyb3IsIGEgbWVzc2FnZSB3aWxsIGJlIGxvZ2dlZCB3aXRoXG4gIC8vIE1ldGVvci5fZGVidWcuXG4gIC8vXG4gIC8vIFRoZSBpbnRlbnQgKHRob3VnaCB0aGlzIGlzIGFjdHVhbGx5IGRldGVybWluZWQgYnkgdGhlIHVuZGVybHlpbmdcbiAgLy8gZHJpdmVycykgaXMgdGhhdCB0aGUgb3BlcmF0aW9ucyBzaG91bGQgYmUgZG9uZSBzeW5jaHJvbm91c2x5LCBub3RcbiAgLy8gZ2VuZXJhdGluZyB0aGVpciByZXN1bHQgdW50aWwgdGhlIGRhdGFiYXNlIGhhcyBhY2tub3dsZWRnZWRcbiAgLy8gdGhlbS4gSW4gdGhlIGZ1dHVyZSBtYXliZSB3ZSBzaG91bGQgcHJvdmlkZSBhIGZsYWcgdG8gdHVybiB0aGlzXG4gIC8vIG9mZi5cblxuICAvKipcbiAgICogQHN1bW1hcnkgSW5zZXJ0IGEgZG9jdW1lbnQgaW4gdGhlIGNvbGxlY3Rpb24uICBSZXR1cm5zIGl0cyB1bmlxdWUgX2lkLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCAgaW5zZXJ0XG4gICAqIEBtZW1iZXJvZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge09iamVjdH0gZG9jIFRoZSBkb2N1bWVudCB0byBpbnNlcnQuIE1heSBub3QgeWV0IGhhdmUgYW4gX2lkIGF0dHJpYnV0ZSwgaW4gd2hpY2ggY2FzZSBNZXRlb3Igd2lsbCBnZW5lcmF0ZSBvbmUgZm9yIHlvdS5cbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyB0aGUgZmlyc3QgYXJndW1lbnQgYW5kLCBpZiBubyBlcnJvciwgdGhlIF9pZCBhcyB0aGUgc2Vjb25kLlxuICAgKi9cbiAgaW5zZXJ0KGRvYywgY2FsbGJhY2spIHtcbiAgICAvLyBNYWtlIHN1cmUgd2Ugd2VyZSBwYXNzZWQgYSBkb2N1bWVudCB0byBpbnNlcnRcbiAgICBpZiAoIWRvYykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5zZXJ0IHJlcXVpcmVzIGFuIGFyZ3VtZW50XCIpO1xuICAgIH1cblxuICAgIC8vIE1ha2UgYSBzaGFsbG93IGNsb25lIG9mIHRoZSBkb2N1bWVudCwgcHJlc2VydmluZyBpdHMgcHJvdG90eXBlLlxuICAgIGRvYyA9IE9iamVjdC5jcmVhdGUoXG4gICAgICBPYmplY3QuZ2V0UHJvdG90eXBlT2YoZG9jKSxcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3JzKGRvYylcbiAgICApO1xuXG4gICAgaWYgKCdfaWQnIGluIGRvYykge1xuICAgICAgaWYgKCEgZG9jLl9pZCB8fFxuICAgICAgICAgICEgKHR5cGVvZiBkb2MuX2lkID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgICAgIGRvYy5faWQgaW5zdGFuY2VvZiBNb25nby5PYmplY3RJRCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiTWV0ZW9yIHJlcXVpcmVzIGRvY3VtZW50IF9pZCBmaWVsZHMgdG8gYmUgbm9uLWVtcHR5IHN0cmluZ3Mgb3IgT2JqZWN0SURzXCIpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgZ2VuZXJhdGVJZCA9IHRydWU7XG5cbiAgICAgIC8vIERvbid0IGdlbmVyYXRlIHRoZSBpZCBpZiB3ZSdyZSB0aGUgY2xpZW50IGFuZCB0aGUgJ291dGVybW9zdCcgY2FsbFxuICAgICAgLy8gVGhpcyBvcHRpbWl6YXRpb24gc2F2ZXMgdXMgcGFzc2luZyBib3RoIHRoZSByYW5kb21TZWVkIGFuZCB0aGUgaWRcbiAgICAgIC8vIFBhc3NpbmcgYm90aCBpcyByZWR1bmRhbnQuXG4gICAgICBpZiAodGhpcy5faXNSZW1vdGVDb2xsZWN0aW9uKCkpIHtcbiAgICAgICAgY29uc3QgZW5jbG9zaW5nID0gRERQLl9DdXJyZW50TWV0aG9kSW52b2NhdGlvbi5nZXQoKTtcbiAgICAgICAgaWYgKCFlbmNsb3NpbmcpIHtcbiAgICAgICAgICBnZW5lcmF0ZUlkID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGdlbmVyYXRlSWQpIHtcbiAgICAgICAgZG9jLl9pZCA9IHRoaXMuX21ha2VOZXdJRCgpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9uIGluc2VydHMsIGFsd2F5cyByZXR1cm4gdGhlIGlkIHRoYXQgd2UgZ2VuZXJhdGVkOyBvbiBhbGwgb3RoZXJcbiAgICAvLyBvcGVyYXRpb25zLCBqdXN0IHJldHVybiB0aGUgcmVzdWx0IGZyb20gdGhlIGNvbGxlY3Rpb24uXG4gICAgdmFyIGNob29zZVJldHVyblZhbHVlRnJvbUNvbGxlY3Rpb25SZXN1bHQgPSBmdW5jdGlvbiAocmVzdWx0KSB7XG4gICAgICBpZiAoZG9jLl9pZCkge1xuICAgICAgICByZXR1cm4gZG9jLl9pZDtcbiAgICAgIH1cblxuICAgICAgLy8gWFhYIHdoYXQgaXMgdGhpcyBmb3I/P1xuICAgICAgLy8gSXQncyBzb21lIGl0ZXJhY3Rpb24gYmV0d2VlbiB0aGUgY2FsbGJhY2sgdG8gX2NhbGxNdXRhdG9yTWV0aG9kIGFuZFxuICAgICAgLy8gdGhlIHJldHVybiB2YWx1ZSBjb252ZXJzaW9uXG4gICAgICBkb2MuX2lkID0gcmVzdWx0O1xuXG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG5cbiAgICBjb25zdCB3cmFwcGVkQ2FsbGJhY2sgPSB3cmFwQ2FsbGJhY2soXG4gICAgICBjYWxsYmFjaywgY2hvb3NlUmV0dXJuVmFsdWVGcm9tQ29sbGVjdGlvblJlc3VsdCk7XG5cbiAgICBpZiAodGhpcy5faXNSZW1vdGVDb2xsZWN0aW9uKCkpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX2NhbGxNdXRhdG9yTWV0aG9kKFwiaW5zZXJ0XCIsIFtkb2NdLCB3cmFwcGVkQ2FsbGJhY2spO1xuICAgICAgcmV0dXJuIGNob29zZVJldHVyblZhbHVlRnJvbUNvbGxlY3Rpb25SZXN1bHQocmVzdWx0KTtcbiAgICB9XG5cbiAgICAvLyBpdCdzIG15IGNvbGxlY3Rpb24uICBkZXNjZW5kIGludG8gdGhlIGNvbGxlY3Rpb24gb2JqZWN0XG4gICAgLy8gYW5kIHByb3BhZ2F0ZSBhbnkgZXhjZXB0aW9uLlxuICAgIHRyeSB7XG4gICAgICAvLyBJZiB0aGUgdXNlciBwcm92aWRlZCBhIGNhbGxiYWNrIGFuZCB0aGUgY29sbGVjdGlvbiBpbXBsZW1lbnRzIHRoaXNcbiAgICAgIC8vIG9wZXJhdGlvbiBhc3luY2hyb25vdXNseSwgdGhlbiBxdWVyeVJldCB3aWxsIGJlIHVuZGVmaW5lZCwgYW5kIHRoZVxuICAgICAgLy8gcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgdGhyb3VnaCB0aGUgY2FsbGJhY2sgaW5zdGVhZC5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuX2NvbGxlY3Rpb24uaW5zZXJ0KGRvYywgd3JhcHBlZENhbGxiYWNrKTtcbiAgICAgIHJldHVybiBjaG9vc2VSZXR1cm5WYWx1ZUZyb21Db2xsZWN0aW9uUmVzdWx0KHJlc3VsdCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIHRocm93IGU7XG4gICAgfVxuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBNb2RpZnkgb25lIG9yIG1vcmUgZG9jdW1lbnRzIGluIHRoZSBjb2xsZWN0aW9uLiBSZXR1cm5zIHRoZSBudW1iZXIgb2YgbWF0Y2hlZCBkb2N1bWVudHMuXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kIHVwZGF0ZVxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBzZWxlY3RvciBTcGVjaWZpZXMgd2hpY2ggZG9jdW1lbnRzIHRvIG1vZGlmeVxuICAgKiBAcGFyYW0ge01vbmdvTW9kaWZpZXJ9IG1vZGlmaWVyIFNwZWNpZmllcyBob3cgdG8gbW9kaWZ5IHRoZSBkb2N1bWVudHNcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMubXVsdGkgVHJ1ZSB0byBtb2RpZnkgYWxsIG1hdGNoaW5nIGRvY3VtZW50czsgZmFsc2UgdG8gb25seSBtb2RpZnkgb25lIG9mIHRoZSBtYXRjaGluZyBkb2N1bWVudHMgKHRoZSBkZWZhdWx0KS5cbiAgICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLnVwc2VydCBUcnVlIHRvIGluc2VydCBhIGRvY3VtZW50IGlmIG5vIG1hdGNoaW5nIGRvY3VtZW50cyBhcmUgZm91bmQuXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IFtjYWxsYmFja10gT3B0aW9uYWwuICBJZiBwcmVzZW50LCBjYWxsZWQgd2l0aCBhbiBlcnJvciBvYmplY3QgYXMgdGhlIGZpcnN0IGFyZ3VtZW50IGFuZCwgaWYgbm8gZXJyb3IsIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWQgZG9jdW1lbnRzIGFzIHRoZSBzZWNvbmQuXG4gICAqL1xuICB1cGRhdGUoc2VsZWN0b3IsIG1vZGlmaWVyLCAuLi5vcHRpb25zQW5kQ2FsbGJhY2spIHtcbiAgICBjb25zdCBjYWxsYmFjayA9IHBvcENhbGxiYWNrRnJvbUFyZ3Mob3B0aW9uc0FuZENhbGxiYWNrKTtcblxuICAgIC8vIFdlJ3ZlIGFscmVhZHkgcG9wcGVkIG9mZiB0aGUgY2FsbGJhY2ssIHNvIHdlIGFyZSBsZWZ0IHdpdGggYW4gYXJyYXlcbiAgICAvLyBvZiBvbmUgb3IgemVybyBpdGVtc1xuICAgIGNvbnN0IG9wdGlvbnMgPSB7IC4uLihvcHRpb25zQW5kQ2FsbGJhY2tbMF0gfHwgbnVsbCkgfTtcbiAgICBsZXQgaW5zZXJ0ZWRJZDtcbiAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnVwc2VydCkge1xuICAgICAgLy8gc2V0IGBpbnNlcnRlZElkYCBpZiBhYnNlbnQuICBgaW5zZXJ0ZWRJZGAgaXMgYSBNZXRlb3IgZXh0ZW5zaW9uLlxuICAgICAgaWYgKG9wdGlvbnMuaW5zZXJ0ZWRJZCkge1xuICAgICAgICBpZiAoISh0eXBlb2Ygb3B0aW9ucy5pbnNlcnRlZElkID09PSAnc3RyaW5nJyB8fCBvcHRpb25zLmluc2VydGVkSWQgaW5zdGFuY2VvZiBNb25nby5PYmplY3RJRCkpXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5zZXJ0ZWRJZCBtdXN0IGJlIHN0cmluZyBvciBPYmplY3RJRFwiKTtcbiAgICAgICAgaW5zZXJ0ZWRJZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDtcbiAgICAgIH0gZWxzZSBpZiAoIXNlbGVjdG9yIHx8ICFzZWxlY3Rvci5faWQpIHtcbiAgICAgICAgaW5zZXJ0ZWRJZCA9IHRoaXMuX21ha2VOZXdJRCgpO1xuICAgICAgICBvcHRpb25zLmdlbmVyYXRlZElkID0gdHJ1ZTtcbiAgICAgICAgb3B0aW9ucy5pbnNlcnRlZElkID0gaW5zZXJ0ZWRJZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzZWxlY3RvciA9XG4gICAgICBNb25nby5Db2xsZWN0aW9uLl9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IsIHsgZmFsbGJhY2tJZDogaW5zZXJ0ZWRJZCB9KTtcblxuICAgIGNvbnN0IHdyYXBwZWRDYWxsYmFjayA9IHdyYXBDYWxsYmFjayhjYWxsYmFjayk7XG5cbiAgICBpZiAodGhpcy5faXNSZW1vdGVDb2xsZWN0aW9uKCkpIHtcbiAgICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICAgIHNlbGVjdG9yLFxuICAgICAgICBtb2RpZmllcixcbiAgICAgICAgb3B0aW9uc1xuICAgICAgXTtcblxuICAgICAgcmV0dXJuIHRoaXMuX2NhbGxNdXRhdG9yTWV0aG9kKFwidXBkYXRlXCIsIGFyZ3MsIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgfVxuXG4gICAgLy8gaXQncyBteSBjb2xsZWN0aW9uLiAgZGVzY2VuZCBpbnRvIHRoZSBjb2xsZWN0aW9uIG9iamVjdFxuICAgIC8vIGFuZCBwcm9wYWdhdGUgYW55IGV4Y2VwdGlvbi5cbiAgICB0cnkge1xuICAgICAgLy8gSWYgdGhlIHVzZXIgcHJvdmlkZWQgYSBjYWxsYmFjayBhbmQgdGhlIGNvbGxlY3Rpb24gaW1wbGVtZW50cyB0aGlzXG4gICAgICAvLyBvcGVyYXRpb24gYXN5bmNocm9ub3VzbHksIHRoZW4gcXVlcnlSZXQgd2lsbCBiZSB1bmRlZmluZWQsIGFuZCB0aGVcbiAgICAgIC8vIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIHRocm91Z2ggdGhlIGNhbGxiYWNrIGluc3RlYWQuXG4gICAgICByZXR1cm4gdGhpcy5fY29sbGVjdGlvbi51cGRhdGUoXG4gICAgICAgIHNlbGVjdG9yLCBtb2RpZmllciwgb3B0aW9ucywgd3JhcHBlZENhbGxiYWNrKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJlbW92ZSBkb2N1bWVudHMgZnJvbSB0aGUgY29sbGVjdGlvblxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCByZW1vdmVcbiAgICogQG1lbWJlcm9mIE1vbmdvLkNvbGxlY3Rpb25cbiAgICogQGluc3RhbmNlXG4gICAqIEBwYXJhbSB7TW9uZ29TZWxlY3Rvcn0gc2VsZWN0b3IgU3BlY2lmaWVzIHdoaWNoIGRvY3VtZW50cyB0byByZW1vdmVcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyBpdHMgYXJndW1lbnQuXG4gICAqL1xuICByZW1vdmUoc2VsZWN0b3IsIGNhbGxiYWNrKSB7XG4gICAgc2VsZWN0b3IgPSBNb25nby5Db2xsZWN0aW9uLl9yZXdyaXRlU2VsZWN0b3Ioc2VsZWN0b3IpO1xuXG4gICAgY29uc3Qgd3JhcHBlZENhbGxiYWNrID0gd3JhcENhbGxiYWNrKGNhbGxiYWNrKTtcblxuICAgIGlmICh0aGlzLl9pc1JlbW90ZUNvbGxlY3Rpb24oKSkge1xuICAgICAgcmV0dXJuIHRoaXMuX2NhbGxNdXRhdG9yTWV0aG9kKFwicmVtb3ZlXCIsIFtzZWxlY3Rvcl0sIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgfVxuXG4gICAgLy8gaXQncyBteSBjb2xsZWN0aW9uLiAgZGVzY2VuZCBpbnRvIHRoZSBjb2xsZWN0aW9uIG9iamVjdFxuICAgIC8vIGFuZCBwcm9wYWdhdGUgYW55IGV4Y2VwdGlvbi5cbiAgICB0cnkge1xuICAgICAgLy8gSWYgdGhlIHVzZXIgcHJvdmlkZWQgYSBjYWxsYmFjayBhbmQgdGhlIGNvbGxlY3Rpb24gaW1wbGVtZW50cyB0aGlzXG4gICAgICAvLyBvcGVyYXRpb24gYXN5bmNocm9ub3VzbHksIHRoZW4gcXVlcnlSZXQgd2lsbCBiZSB1bmRlZmluZWQsIGFuZCB0aGVcbiAgICAgIC8vIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIHRocm91Z2ggdGhlIGNhbGxiYWNrIGluc3RlYWQuXG4gICAgICByZXR1cm4gdGhpcy5fY29sbGVjdGlvbi5yZW1vdmUoc2VsZWN0b3IsIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIGNhbGxiYWNrKGUpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIHRocm93IGU7XG4gICAgfVxuICB9LFxuXG4gIC8vIERldGVybWluZSBpZiB0aGlzIGNvbGxlY3Rpb24gaXMgc2ltcGx5IGEgbWluaW1vbmdvIHJlcHJlc2VudGF0aW9uIG9mIGEgcmVhbFxuICAvLyBkYXRhYmFzZSBvbiBhbm90aGVyIHNlcnZlclxuICBfaXNSZW1vdGVDb2xsZWN0aW9uKCkge1xuICAgIC8vIFhYWCBzZWUgI01ldGVvclNlcnZlck51bGxcbiAgICByZXR1cm4gdGhpcy5fY29ubmVjdGlvbiAmJiB0aGlzLl9jb25uZWN0aW9uICE9PSBNZXRlb3Iuc2VydmVyO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBNb2RpZnkgb25lIG9yIG1vcmUgZG9jdW1lbnRzIGluIHRoZSBjb2xsZWN0aW9uLCBvciBpbnNlcnQgb25lIGlmIG5vIG1hdGNoaW5nIGRvY3VtZW50cyB3ZXJlIGZvdW5kLiBSZXR1cm5zIGFuIG9iamVjdCB3aXRoIGtleXMgYG51bWJlckFmZmVjdGVkYCAodGhlIG51bWJlciBvZiBkb2N1bWVudHMgbW9kaWZpZWQpICBhbmQgYGluc2VydGVkSWRgICh0aGUgdW5pcXVlIF9pZCBvZiB0aGUgZG9jdW1lbnQgdGhhdCB3YXMgaW5zZXJ0ZWQsIGlmIGFueSkuXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kIHVwc2VydFxuICAgKiBAbWVtYmVyb2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBzZWxlY3RvciBTcGVjaWZpZXMgd2hpY2ggZG9jdW1lbnRzIHRvIG1vZGlmeVxuICAgKiBAcGFyYW0ge01vbmdvTW9kaWZpZXJ9IG1vZGlmaWVyIFNwZWNpZmllcyBob3cgdG8gbW9kaWZ5IHRoZSBkb2N1bWVudHNcbiAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMubXVsdGkgVHJ1ZSB0byBtb2RpZnkgYWxsIG1hdGNoaW5nIGRvY3VtZW50czsgZmFsc2UgdG8gb25seSBtb2RpZnkgb25lIG9mIHRoZSBtYXRjaGluZyBkb2N1bWVudHMgKHRoZSBkZWZhdWx0KS5cbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyB0aGUgZmlyc3QgYXJndW1lbnQgYW5kLCBpZiBubyBlcnJvciwgdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2N1bWVudHMgYXMgdGhlIHNlY29uZC5cbiAgICovXG4gIHVwc2VydChzZWxlY3RvciwgbW9kaWZpZXIsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKCEgY2FsbGJhY2sgJiYgdHlwZW9mIG9wdGlvbnMgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLnVwZGF0ZShzZWxlY3RvciwgbW9kaWZpZXIsIHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgICBfcmV0dXJuT2JqZWN0OiB0cnVlLFxuICAgICAgdXBzZXJ0OiB0cnVlLFxuICAgIH0sIGNhbGxiYWNrKTtcbiAgfSxcblxuICAvLyBXZSdsbCBhY3R1YWxseSBkZXNpZ24gYW4gaW5kZXggQVBJIGxhdGVyLiBGb3Igbm93LCB3ZSBqdXN0IHBhc3MgdGhyb3VnaCB0b1xuICAvLyBNb25nbydzLCBidXQgbWFrZSBpdCBzeW5jaHJvbm91cy5cbiAgX2Vuc3VyZUluZGV4KGluZGV4LCBvcHRpb25zKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghc2VsZi5fY29sbGVjdGlvbi5fZW5zdXJlSW5kZXgpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIF9lbnN1cmVJbmRleCBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgc2VsZi5fY29sbGVjdGlvbi5fZW5zdXJlSW5kZXgoaW5kZXgsIG9wdGlvbnMpO1xuICB9LFxuXG4gIF9kcm9wSW5kZXgoaW5kZXgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCFzZWxmLl9jb2xsZWN0aW9uLl9kcm9wSW5kZXgpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIF9kcm9wSW5kZXggb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIHNlbGYuX2NvbGxlY3Rpb24uX2Ryb3BJbmRleChpbmRleCk7XG4gIH0sXG5cbiAgX2Ryb3BDb2xsZWN0aW9uKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoIXNlbGYuX2NvbGxlY3Rpb24uZHJvcENvbGxlY3Rpb24pXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIF9kcm9wQ29sbGVjdGlvbiBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgc2VsZi5fY29sbGVjdGlvbi5kcm9wQ29sbGVjdGlvbigpO1xuICB9LFxuXG4gIF9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uKGJ5dGVTaXplLCBtYXhEb2N1bWVudHMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCFzZWxmLl9jb2xsZWN0aW9uLl9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCBfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbiBvbiBzZXJ2ZXIgY29sbGVjdGlvbnNcIik7XG4gICAgc2VsZi5fY29sbGVjdGlvbi5fY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbihieXRlU2l6ZSwgbWF4RG9jdW1lbnRzKTtcbiAgfSxcblxuICAvKipcbiAgICogQHN1bW1hcnkgUmV0dXJucyB0aGUgW2BDb2xsZWN0aW9uYF0oaHR0cDovL21vbmdvZGIuZ2l0aHViLmlvL25vZGUtbW9uZ29kYi1uYXRpdmUvMi4yL2FwaS9Db2xsZWN0aW9uLmh0bWwpIG9iamVjdCBjb3JyZXNwb25kaW5nIHRvIHRoaXMgY29sbGVjdGlvbiBmcm9tIHRoZSBbbnBtIGBtb25nb2RiYCBkcml2ZXIgbW9kdWxlXShodHRwczovL3d3dy5ucG1qcy5jb20vcGFja2FnZS9tb25nb2RiKSB3aGljaCBpcyB3cmFwcGVkIGJ5IGBNb25nby5Db2xsZWN0aW9uYC5cbiAgICogQGxvY3VzIFNlcnZlclxuICAgKi9cbiAgcmF3Q29sbGVjdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCEgc2VsZi5fY29sbGVjdGlvbi5yYXdDb2xsZWN0aW9uKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIHJhd0NvbGxlY3Rpb24gb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIH1cbiAgICByZXR1cm4gc2VsZi5fY29sbGVjdGlvbi5yYXdDb2xsZWN0aW9uKCk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJldHVybnMgdGhlIFtgRGJgXShodHRwOi8vbW9uZ29kYi5naXRodWIuaW8vbm9kZS1tb25nb2RiLW5hdGl2ZS8yLjIvYXBpL0RiLmh0bWwpIG9iamVjdCBjb3JyZXNwb25kaW5nIHRvIHRoaXMgY29sbGVjdGlvbidzIGRhdGFiYXNlIGNvbm5lY3Rpb24gZnJvbSB0aGUgW25wbSBgbW9uZ29kYmAgZHJpdmVyIG1vZHVsZV0oaHR0cHM6Ly93d3cubnBtanMuY29tL3BhY2thZ2UvbW9uZ29kYikgd2hpY2ggaXMgd3JhcHBlZCBieSBgTW9uZ28uQ29sbGVjdGlvbmAuXG4gICAqIEBsb2N1cyBTZXJ2ZXJcbiAgICovXG4gIHJhd0RhdGFiYXNlKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoISAoc2VsZi5fZHJpdmVyLm1vbmdvICYmIHNlbGYuX2RyaXZlci5tb25nby5kYikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbiBvbmx5IGNhbGwgcmF3RGF0YWJhc2Ugb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIH1cbiAgICByZXR1cm4gc2VsZi5fZHJpdmVyLm1vbmdvLmRiO1xuICB9XG59KTtcblxuLy8gQ29udmVydCB0aGUgY2FsbGJhY2sgdG8gbm90IHJldHVybiBhIHJlc3VsdCBpZiB0aGVyZSBpcyBhbiBlcnJvclxuZnVuY3Rpb24gd3JhcENhbGxiYWNrKGNhbGxiYWNrLCBjb252ZXJ0UmVzdWx0KSB7XG4gIHJldHVybiBjYWxsYmFjayAmJiBmdW5jdGlvbiAoZXJyb3IsIHJlc3VsdCkge1xuICAgIGlmIChlcnJvcikge1xuICAgICAgY2FsbGJhY2soZXJyb3IpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGNvbnZlcnRSZXN1bHQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgY2FsbGJhY2sobnVsbCwgY29udmVydFJlc3VsdChyZXN1bHQpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICB9XG4gIH07XG59XG5cbi8qKlxuICogQHN1bW1hcnkgQ3JlYXRlIGEgTW9uZ28tc3R5bGUgYE9iamVjdElEYC4gIElmIHlvdSBkb24ndCBzcGVjaWZ5IGEgYGhleFN0cmluZ2AsIHRoZSBgT2JqZWN0SURgIHdpbGwgZ2VuZXJhdGVkIHJhbmRvbWx5IChub3QgdXNpbmcgTW9uZ29EQidzIElEIGNvbnN0cnVjdGlvbiBydWxlcykuXG4gKiBAbG9jdXMgQW55d2hlcmVcbiAqIEBjbGFzc1xuICogQHBhcmFtIHtTdHJpbmd9IFtoZXhTdHJpbmddIE9wdGlvbmFsLiAgVGhlIDI0LWNoYXJhY3RlciBoZXhhZGVjaW1hbCBjb250ZW50cyBvZiB0aGUgT2JqZWN0SUQgdG8gY3JlYXRlXG4gKi9cbk1vbmdvLk9iamVjdElEID0gTW9uZ29JRC5PYmplY3RJRDtcblxuLyoqXG4gKiBAc3VtbWFyeSBUbyBjcmVhdGUgYSBjdXJzb3IsIHVzZSBmaW5kLiBUbyBhY2Nlc3MgdGhlIGRvY3VtZW50cyBpbiBhIGN1cnNvciwgdXNlIGZvckVhY2gsIG1hcCwgb3IgZmV0Y2guXG4gKiBAY2xhc3NcbiAqIEBpbnN0YW5jZU5hbWUgY3Vyc29yXG4gKi9cbk1vbmdvLkN1cnNvciA9IExvY2FsQ29sbGVjdGlvbi5DdXJzb3I7XG5cbi8qKlxuICogQGRlcHJlY2F0ZWQgaW4gMC45LjFcbiAqL1xuTW9uZ28uQ29sbGVjdGlvbi5DdXJzb3IgPSBNb25nby5DdXJzb3I7XG5cbi8qKlxuICogQGRlcHJlY2F0ZWQgaW4gMC45LjFcbiAqL1xuTW9uZ28uQ29sbGVjdGlvbi5PYmplY3RJRCA9IE1vbmdvLk9iamVjdElEO1xuXG4vKipcbiAqIEBkZXByZWNhdGVkIGluIDAuOS4xXG4gKi9cbk1ldGVvci5Db2xsZWN0aW9uID0gTW9uZ28uQ29sbGVjdGlvbjtcblxuLy8gQWxsb3cgZGVueSBzdHVmZiBpcyBub3cgaW4gdGhlIGFsbG93LWRlbnkgcGFja2FnZVxuT2JqZWN0LmFzc2lnbihcbiAgTWV0ZW9yLkNvbGxlY3Rpb24ucHJvdG90eXBlLFxuICBBbGxvd0RlbnkuQ29sbGVjdGlvblByb3RvdHlwZVxuKTtcblxuZnVuY3Rpb24gcG9wQ2FsbGJhY2tGcm9tQXJncyhhcmdzKSB7XG4gIC8vIFB1bGwgb2ZmIGFueSBjYWxsYmFjayAob3IgcGVyaGFwcyBhICdjYWxsYmFjaycgdmFyaWFibGUgdGhhdCB3YXMgcGFzc2VkXG4gIC8vIGluIHVuZGVmaW5lZCwgbGlrZSBob3cgJ3Vwc2VydCcgZG9lcyBpdCkuXG4gIGlmIChhcmdzLmxlbmd0aCAmJlxuICAgICAgKGFyZ3NbYXJncy5sZW5ndGggLSAxXSA9PT0gdW5kZWZpbmVkIHx8XG4gICAgICAgYXJnc1thcmdzLmxlbmd0aCAtIDFdIGluc3RhbmNlb2YgRnVuY3Rpb24pKSB7XG4gICAgcmV0dXJuIGFyZ3MucG9wKCk7XG4gIH1cbn1cbiIsIi8qKlxuICogQHN1bW1hcnkgQWxsb3dzIGZvciB1c2VyIHNwZWNpZmllZCBjb25uZWN0aW9uIG9wdGlvbnNcbiAqIEBleGFtcGxlIGh0dHA6Ly9tb25nb2RiLmdpdGh1Yi5pby9ub2RlLW1vbmdvZGItbmF0aXZlLzIuMi9yZWZlcmVuY2UvY29ubmVjdGluZy9jb25uZWN0aW9uLXNldHRpbmdzL1xuICogQGxvY3VzIFNlcnZlclxuICogQHBhcmFtIHtPYmplY3R9IG9wdGlvbnMgVXNlciBzcGVjaWZpZWQgTW9uZ28gY29ubmVjdGlvbiBvcHRpb25zXG4gKi9cbk1vbmdvLnNldENvbm5lY3Rpb25PcHRpb25zID0gZnVuY3Rpb24gc2V0Q29ubmVjdGlvbk9wdGlvbnMgKG9wdGlvbnMpIHtcbiAgY2hlY2sob3B0aW9ucywgT2JqZWN0KTtcbiAgTW9uZ28uX2Nvbm5lY3Rpb25PcHRpb25zID0gb3B0aW9ucztcbn07Il19
