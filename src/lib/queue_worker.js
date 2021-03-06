'use strict';

var Firebase = require('firebase'),
    logger = require('winston'),
    uuid = require('node-uuid'),
    RSVP = require('rsvp'),
    _ = require('lodash');

var MAX_TRANSACTION_ATTEMPTS = 10,
    DEFAULT_ERROR_STATE = 'error',
    DEFAULT_RETRIES = 0;

/**
 * @param {Firebase} tasksRef the Firebase reference for queue tasks.
 * @param {String} processId the ID of the current worker process.
 * @param {Function} processingFunction the function to be called each time a
 *   task is claimed.
 * @return {Object}
 */
function QueueWorker(tasksRef, processId, sanitize, processingFunction) {
  var self = this,
      error;
  if (_.isUndefined(tasksRef)) {
    error = 'No tasks reference provided.';
    logger.debug('QueueWorker(): ' + error);
    throw new Error(error);
  }
  if (!_.isString(processId)) {
    error = 'Invalid process ID provided.';
    logger.debug('QueueWorker(): ' + error);
    throw new Error(error);
  }
  if (!_.isBoolean(sanitize)) {
    error = 'Invalid sanitize option.';
    logger.debug('QueueWorker(): ' + error);
    throw new Error(error);
  }
  if (!_.isFunction(processingFunction)) {
    error = 'No processing function provided.';
    logger.debug('QueueWorker(): ' + error);
    throw new Error(error);
  }

  self.processId = processId + ':' + uuid.v4();
  self.shutdownDeffered = null;

  self.processingFunction = processingFunction;
  self.expiryTimeouts = {};
  self.owners = {};

  self.tasksRef = tasksRef;
  self.processingTasksRef = null;
  self.currentTaskRef = null;
  self.newTaskRef = null;

  self.currentTaskListener = null;
  self.newTaskListener = null;
  self.processingTaskAddedListener = null;
  self.processingTaskRemovedListener = null;

  self.busy = false;
  self.taskNumber = 0;
  self.errorState = DEFAULT_ERROR_STATE;
  self.sanitize = sanitize;

  return self;
}

/**
 * Logs an info message with a worker-specific prefix.
 * @param {String} message The message to log.
 */
QueueWorker.prototype._getLogEntry = function(message) {
  return 'QueueWorker ' + this.processId + ' ' + message;
};

/**
 * Returns the state of a task to the start state.
 * @param {Firebase} taskRef Reference to the Firebase location of the task
 *   that's timed out.
 * @returns {RSVP.Promise} Whether the task was able to be reset.
 */
QueueWorker.prototype._resetTask = function(taskRef, deferred) {
  var self = this,
      retries = 0;

  /* istanbul ignore else */
  if (_.isUndefined(deferred)) {
    deferred = RSVP.defer();
  }

  taskRef.transaction(function(task) {
    /* istanbul ignore if */
    if (_.isNull(task)) {
      return task;
    }
    if (task._state === self.inProgressState) {
      task._state = self.startState;
      task._state_changed = Firebase.ServerValue.TIMESTAMP;
      task._owner = null;
      task._progress = null;
      task._error_details = null;
      return task;
    } else {
      return;
    }
  }, function(error, committed, snapshot) {
    /* istanbul ignore if */
    if (error) {
      if (++retries < MAX_TRANSACTION_ATTEMPTS) {
        logger.debug(self._getLogEntry('reset task errored, retrying'), error);
        setImmediate(self._resetTask.bind(self), taskRef, deferred);
      } else {
        var errorMsg = 'reset task errored too many times, no longer retrying';
        logger.debug(self._getLogEntry(errorMsg), error);
        deferred.reject(new Error(errorMsg));
      }
    } else {
      if (committed && snapshot.exists()) {
        logger.debug(self._getLogEntry('reset ' + snapshot.key()));
      }
      deferred.resolve();
    }
  }, false);

  return deferred.promise;
};

/**
 * Creates a resolve callback function, storing the current task number.
 * @param {Number} taskNumber the current task number
 * @returns {Function} the resolve callback function.
 */
QueueWorker.prototype._resolve = function(taskNumber) {
  var self = this,
      retries = 0,
      deferred = RSVP.defer();

  /*
   * Resolves the current task and changes the state to the finished state.
   * @param {Object} newTask The new data to be stored at the location.
   * @returns {RSVP.Promise} Whether the task was able to be resolved.
   */
  var resolve = function(newTask) {

    if ((taskNumber !== self.taskNumber) || _.isNull(self.currentTaskRef)) {
      if (_.isNull(self.currentTaskRef)) {
        logger.debug(self._getLogEntry('Can\'t resolve task - no task ' +
          'currently being processed'));
      } else {
        logger.debug(self._getLogEntry('Can\'t resolve task - no longer ' +
          'processing current task'));
      }
      deferred.resolve();
      self.busy = false;
      self._tryToProcess(self.nextTaskRef);
    } else {
      var existedBefore;
      self.currentTaskRef.transaction(function(task) {
        existedBefore = true;
        if (_.isNull(task)) {
          existedBefore = false;
          return task;
        }
        var id = self.processId + ':' + self.taskNumber;
        if (task._state === self.inProgressState &&
            task._owner === id) {
          if (_.isNull(self.finishedState)) {
            return null;
          }
          if (!_.isPlainObject(newTask)) {
            newTask = {};
          }
          newTask._state = self.finishedState;
          newTask._state_changed = Firebase.ServerValue.TIMESTAMP;
          newTask._owner = null;
          newTask._progress = 100;
          newTask._error_details = null;
          return newTask;
        } else {
          return;
        }
      }, function(error, committed, snapshot) {
        /* istanbul ignore if */
        if (error) {
          if (++retries < MAX_TRANSACTION_ATTEMPTS) {
            logger.debug(self._getLogEntry('resolve task errored, retrying'),
              error);
            setImmediate(resolve, newTask);
          } else {
            var errorMsg = 'resolve task errored too many times, no longer ' +
              'retrying';
            logger.debug(self._getLogEntry(errorMsg), error);
            deferred.reject(new Error(errorMsg));
          }
        } else {
          if (committed && existedBefore) {
            logger.debug(self._getLogEntry('completed ' + snapshot.key()));
          } else {
            logger.debug(self._getLogEntry('Can\'t resolve task - current ' +
              'task no longer owned by this process'));
          }
          deferred.resolve();
          self.busy = false;
          self._tryToProcess(self.nextTaskRef);
        }
      }, false);
    }

    return deferred.promise;
  };

  return resolve;
};

/**
 * Creates a reject callback function, storing the current task number.
 * @param {Number} taskNumber the current task number
 * @returns {Function} the reject callback function.
 */
QueueWorker.prototype._reject = function(taskNumber) {
  var self = this,
      retries = 0,
      errorString = null,
      deferred = RSVP.defer();

  /**
   * Rejects the current task and changes the state to self.errorState,
   * adding additional data to the '_error_details' sub key.
   * @param {Object} error The error message or object to be logged.
   * @returns {RSVP.Promise} Whether the task was able to be rejected.
   */
  var reject = function(error) {

    if ((taskNumber !== self.taskNumber) || _.isNull(self.currentTaskRef)) {
      if (_.isNull(self.currentTaskRef)) {
        logger.debug(self._getLogEntry('Can\'t reject task - no task ' +
          'currently being processed'));
      } else {
        logger.debug(self._getLogEntry('Can\'t reject task - no longer ' +
          'processing current task'));
      }
      deferred.resolve();
      self.busy = false;
      self._tryToProcess(self.nextTaskRef);
    } else {
      if (!_.isUndefined(error) && !_.isError(error)) {
        error = new Error(error);
      }
      if (!_.isUndefined(error)) {
        errorString = '' + error.message;
      }
      var existedBefore;
      self.currentTaskRef.transaction(function(task) {
        existedBefore = true;
        if (_.isNull(task)) {
          existedBefore = false;
          return task;
        }
        var id = self.processId + ':' + self.taskNumber;
        if (task._state === self.inProgressState &&
            task._owner === id) {
          var attempts = _.get(task, '_error_details.attempts', 0);
          if (attempts >= self.taskRetries) {
            task._state = self.errorState;
          } else {
            task._state = self.startState;
          }
          task._state_changed = Firebase.ServerValue.TIMESTAMP;
          task._owner = null;
          task._error_details = {
            previous_state: self.inProgressState,
            error: errorString,
            error_stack: (error||{}).stack||null,
            attempts: attempts + 1
          };
          return task;
        } else {
          return;
        }
      }, function(error, committed, snapshot) {
        /* istanbul ignore if */
        if (error) {
          if (++retries < MAX_TRANSACTION_ATTEMPTS) {
            logger.debug(self._getLogEntry('reject task errored, retrying'),
              error);
            setImmediate(reject, error);
          } else {
            var errorMsg = 'reject task errored too many times, no longer ' +
              'retrying';
            logger.debug(self._getLogEntry(errorMsg), error);
            deferred.reject(new Error(errorMsg));
          }
        } else {
          if (committed && existedBefore) {
            logger.debug(self._getLogEntry('errored while attempting to ' +
              'complete ' + snapshot.key()));
          } else {
            logger.debug(self._getLogEntry('Can\'t reject task - current task' +
              ' no longer owned by this process'));
          }
          deferred.resolve();
          self.busy = false;
          self._tryToProcess(self.nextTaskRef);
        }
      }, false);
    }
    return deferred.promise;
  };

  return reject;
};

/**
 * Creates an update callback function, storing the current task number.
 * @param {Number} taskNumber the current task number
 * @returns {Function} the update callback function.
 */
QueueWorker.prototype._updateProgress = function(taskNumber) {
  var self = this,
      errorMsg;

  /**
   * Updates the progress state of the task.
   * @param {Number} progress The progress to report.
   * @returns {RSVP.Promise} Whether the progress was updated.
   */
  var updateProgress = function(progress) {
    if (!_.isNumber(progress) ||
        _.isNaN(progress) ||
        progress < 0 ||
        progress > 100) {
      return RSVP.reject(new Error('Invalid progress'));
    }
    if ((taskNumber !== self.taskNumber)  || _.isNull(self.currentTaskRef)) {
      errorMsg = 'Can\'t update progress - no task currently being processed';
      logger.debug(self._getLogEntry(errorMsg));
      return RSVP.reject(new Error(errorMsg));
    }
    return new RSVP.Promise(function(resolve, reject) {
      self.currentTaskRef.transaction(function(task) {
        /* istanbul ignore if */
        if (_.isNull(task)) {
          return task;
        }
        var id = self.processId + ':' + self.taskNumber;
        if (task._state === self.inProgressState &&
            task._owner === id) {
          task._progress = progress;
          return task;
        } else {
          return;
        }
      }, function(error, committed, snapshot) {
        /* istanbul ignore if */
        if (error) {
          errorMsg = 'errored while attempting to update progress';
          logger.debug(self._getLogEntry(errorMsg), error);
          return reject(new Error(errorMsg));
        }
        if (committed && snapshot.exists()) {
          resolve();
        } else {
          errorMsg = 'Can\'t update progress - current task no longer owned ' +
            'by this process';
          logger.debug(self._getLogEntry(errorMsg));
          return reject(new Error(errorMsg));
        }
      }, false);
    });
  };

  return updateProgress;
};

/**
 * Attempts to claim the next task in the queue.
 * @param {Firebase} nextTaskRef Reference to the Firebase location of the next
 *   task.
 */
QueueWorker.prototype._tryToProcess = function(nextTaskRef, deferred) {
  var self = this,
      retries = 0,
      malformed = false;

  /* istanbul ignore else */
  if (_.isUndefined(deferred)) {
    deferred = RSVP.defer();
  }

  if (!self.busy) {
    if (!_.isNull(self.shutdownDeffered)) {
      deferred.reject(new Error('Shutting down - can no longer process new tasks'));
      self.setTaskSpec(null);
      logger.debug(self._getLogEntry('finished shutdown'));
      self.shutdownDeffered.resolve();
    } else {
      nextTaskRef.transaction(function(task) {
        /* istanbul ignore if */
        if (_.isNull(task)) {
          return task;
        }
        if (!_.isPlainObject(task)) {
          malformed = true;
          return {
            _state: self.errorState,
            _state_changed: Firebase.ServerValue.TIMESTAMP,
            _error_details: {
              error: 'Task was malformed',
              original_task: task
            }
          };
        }
        if (_.isUndefined(task._state)) {
          task._state = null;
        }
        if (task._state === self.startState) {
          task._state = self.inProgressState;
          task._state_changed = Firebase.ServerValue.TIMESTAMP;
          task._owner = self.processId + ':' + (self.taskNumber + 1);
          task._progress = 0;
          return task;
        } else {
          return;
        }
      }, function(error, committed, snapshot) {
        /* istanbul ignore if */
        if (error) {
          if (++retries < MAX_TRANSACTION_ATTEMPTS) {
            logger.debug(self._getLogEntry('errored while attempting to claim' +
              ' a new task, retrying'), error);
            return setImmediate(self._tryToProcess.bind(self), nextTaskRef,
              deferred);
          } else {
            var errorMsg = 'errored while attempting to claim a new task too ' +
              'many times, no longer retrying';
            logger.debug(self._getLogEntry(errorMsg), error);
            return deferred.reject(new Error(errorMsg));
          }
        } else if (committed && snapshot.exists()) {
          if (malformed) {
            logger.debug(self._getLogEntry('found malformed entry ' +
              snapshot.key()));
          } else {
            /* istanbul ignore if */
            if (self.busy) {
              // Worker has become busy while the transaction was processing -
              // so give up the task for now so another worker can claim it
              self._resetTask(nextTaskRef);
            } else {
              self.busy = true;
              self.taskNumber += 1;
              logger.debug(self._getLogEntry('claimed ' + snapshot.key()));
              self.currentTaskRef = snapshot.ref();
              self.currentTaskListener = self.currentTaskRef
                  .child('_owner').on('value', function(ownerSnapshot) {
                var id = self.processId + ':' + self.taskNumber;
                /* istanbul ignore else */
                if (ownerSnapshot.val() !== id &&
                    !_.isNull(self.currentTaskRef) &&
                    !_.isNull(self.currentTaskListener)) {
                  self.currentTaskRef.child('_owner').off(
                    'value',
                    self.currentTaskListener);
                  self.currentTaskRef = null;
                  self.currentTaskListener = null;
                }
              });
              var data = snapshot.val();
              if (self.sanitize) {
                [
                  '_state',
                  '_state_changed',
                  '_owner',
                  '_progress',
                  '_error_details'
                ].forEach(function(reserved) {
                  if (snapshot.hasChild(reserved)) {
                    delete data[reserved];
                  }
                });
              }
              var progress = self._updateProgress(self.taskNumber);
              var resolve = self._resolve(self.taskNumber);
              var reject = self._reject(self.taskNumber);
              setImmediate(function() {
                try {
                  self.processingFunction.call(null, data, progress, resolve,
                    reject);
                } catch (error) {
                  reject(error);
                }
              });
            }
          }
        }
        deferred.resolve();
      }, false);
    }
  } else {
    deferred.resolve();
  }

  return deferred.promise;
};

/**
 * Sets up timeouts to reclaim tasks that fail due to taking too long.
 */
QueueWorker.prototype._setUpTimeouts = function() {
  var self = this;

  if (!_.isNull(self.processingTaskAddedListener)) {
    self.processingTasksRef.off(
      'child_added',
      self.processingTaskAddedListener);
    self.processingTaskAddedListener = null;
  }
  if (!_.isNull(self.processingTaskRemovedListener)) {
    self.processingTasksRef.off(
      'child_removed',
      self.processingTaskRemovedListener);
    self.processingTaskRemovedListener = null;
  }

  _.forEach(self.expiryTimeouts, function(expiryTimeout) {
    clearTimeout(expiryTimeout);
  });
  self.expiryTimeouts = {};
  self.owners = {};

  if (self.taskTimeout) {
    self.processingTasksRef = self.tasksRef.orderByChild('_state')
      .equalTo(self.inProgressState);

    var setUpTimeout = function(snapshot) {
      var taskName = snapshot.key();
      var now = new Date().getTime();
      var startTime = (snapshot.child('_state_changed').val() || now);
      var expires = Math.max(0, startTime - now + self.taskTimeout);
      var ref = snapshot.ref();
      self.owners[taskName] = snapshot.child('_owner').val();
      self.expiryTimeouts[taskName] = setTimeout(
        self._resetTask.bind(self),
        expires,
        ref);
    };

    self.processingTaskAddedListener = self.processingTasksRef.on('child_added',
      setUpTimeout,
      /* istanbul ignore next */ function(error) {
        logger.debug(self._getLogEntry('errored listening to Firebase'), error);
      });
    self.processingTaskRemovedListener = self.processingTasksRef.on(
      'child_removed',
      function(snapshot) {
        var taskName = snapshot.key();
        clearTimeout(self.expiryTimeouts[taskName]);
        delete self.expiryTimeouts[taskName];
        delete self.owners[taskName];
      }, /* istanbul ignore next */ function(error) {
        logger.debug(self._getLogEntry('errored listening to Firebase'), error);
      });
    self.processingTasksRef.on('child_changed', function(snapshot) {
      // This catches de-duped events from the server - if the task was removed
      // and added in quick succession, the server may squash them into a
      // single update
      var taskName = snapshot.key();
      if (snapshot.child('_owner').val() !== self.owners[taskName]) {
        setUpTimeout(snapshot);
      }
    }, /* istanbul ignore next */ function(error) {
      logger.debug(self._getLogEntry('errored listening to Firebase'), error);
    });
  } else {
    self.processingTasksRef = null;
  }
};

/**
 * Validates a task spec contains meaningful parameters.
 * @param {Object} taskSpec The specification for the task.
 * @returns {Boolean} Whether the taskSpec is valid.
 */
QueueWorker.prototype._isValidTaskSpec = function(taskSpec) {
  if (!_.isPlainObject(taskSpec)) {
    return false;
  }
  if (!_.isString(taskSpec.inProgressState)) {
    return false;
  }
  if (!_.isUndefined(taskSpec.startState) &&
      !_.isNull(taskSpec.startState) &&
      (
        !_.isString(taskSpec.startState) ||
        taskSpec.startState === taskSpec.inProgressState
      )) {
    return false;
  }
  if (!_.isUndefined(taskSpec.finishedState) &&
      !_.isNull(taskSpec.finishedState) &&
      (
        !_.isString(taskSpec.finishedState) ||
        taskSpec.finishedState === taskSpec.inProgressState ||
        taskSpec.finishedState === taskSpec.startState
      )) {
    return false;
  }
  if (!_.isUndefined(taskSpec.errorState) &&
      !_.isNull(taskSpec.errorState) &&
      (
        !_.isString(taskSpec.errorState) ||
        taskSpec.errorState === taskSpec.inProgressState
      )) {
    return false;
  }
  if (!_.isUndefined(taskSpec.timeout) &&
      !_.isNull(taskSpec.timeout) &&
      (
        !_.isNumber(taskSpec.timeout) ||
        taskSpec.timeout <= 0 ||
        taskSpec.timeout % 1 !== 0
      )) {
    return false;
  }
  if (!_.isUndefined(taskSpec.retries) &&
      !_.isNull(taskSpec.retries) &&
      (
        !_.isNumber(taskSpec.retries) ||
        taskSpec.retries < 0 ||
        taskSpec.retries % 1 !== 0
      )) {
    return false;
  }
  return true;
};

/**
 * Sets up the listeners to claim tasks and reset them if they timeout. Called
 *   any time the task spec changes.
 * @param {Object} taskSpec The specification for the task.
 */
QueueWorker.prototype.setTaskSpec = function(taskSpec) {
  var self = this;

  // Increment the taskNumber so that a task being processed before the change
  // doesn't continue to use incorrect data
  self.taskNumber += 1;

  if (!_.isNull(self.newTaskListener)) {
    self.newTaskRef.off('child_added', self.newTaskListener);
  }

  if (!_.isNull(self.currentTaskListener)) {
    self.currentTaskRef.child('_owner').off(
      'value',
      self.currentTaskListener);
    self._resetTask(self.currentTaskRef);
    self.currentTaskRef = null;
    self.currentTaskListener = null;
  }

  if (self._isValidTaskSpec(taskSpec)) {
    self.startState = taskSpec.startState || null;
    self.inProgressState = taskSpec.inProgressState;
    self.finishedState = taskSpec.finishedState || null;
    self.errorState = taskSpec.errorState || DEFAULT_ERROR_STATE;
    self.taskTimeout = taskSpec.timeout || null;
    self.taskRetries = taskSpec.retries || DEFAULT_RETRIES;

    self.newTaskRef = self.tasksRef
                          .orderByChild('_state')
                          .equalTo(self.startState)
                          .limitToFirst(1);
    logger.debug(self._getLogEntry('listening'));
    self.newTaskListener = self.newTaskRef.on(
      'child_added',
      function(snapshot) {
        self.nextTaskRef = snapshot.ref();
        self._tryToProcess(self.nextTaskRef);
      }, /* istanbul ignore next */ function(error) {
        logger.debug(self._getLogEntry('errored listening to Firebase'), error);
      });
  } else {
    logger.debug(self._getLogEntry('invalid task spec, not listening for new ' +
      'tasks'));
    self.startState = null;
    self.inProgressState = null;
    self.finishedState = null;
    self.errorState = DEFAULT_ERROR_STATE;
    self.taskTimeout = null;
    self.taskRetries = DEFAULT_RETRIES;

    self.newTaskRef = null;
    self.newTaskListener = null;
  }

  self._setUpTimeouts();
};

QueueWorker.prototype.shutdown = function() {
  var self = this;

  logger.debug(self._getLogEntry('shutting down'));

  // Set the global shutdown deferred promise, which signals we're shutting down
  self.shutdownDeffered = RSVP.defer();

  // We can report success immediately if we're not busy
  if (!self.busy) {
    self.setTaskSpec(null);
    logger.debug(self._getLogEntry('finished shutdown'));
    self.shutdownDeffered.resolve();
  }

  return self.shutdownDeffered.promise;
};

module.exports = QueueWorker;

