
/**
 * 'runtime': Manager the communication with frontend (socket.io)
 */

var Promise = require('bluebird');
var Events = require('./events');
var events = Events.create();
var devices = require('./devices');
var project = require('./project');
var users = require('./users');
var apiKeys = require('./apikeys');
var alarms = require('./alarms');
var notificator = require('./notificator');
var scripts = require('./scripts');
var plugins = require('./plugins');
var utils = require('./utils');
const jwt = require('jsonwebtoken');
const daqstorage = require('./storage/daqstorage');
const schedulerStorage = require('./scheduler/scheduler-storage');
const schedulerService = require('./scheduler/scheduler-service');
const recipeStorage = require('./recipes/recipe-storage');
const recipeService = require('./recipes/recipe-service');
const calibration = require('./calibration');
const cameras = require('./cameras');
const opcuaServer = require('./opcua-server');
var jobs = require('./jobs');

var api;
var settings
var logger;
var io;
var alarmsMgr;
var notificatorMgr;
var scriptsMgr;
var jobsMgr;
var tagsSubscription = new Map();
var socketPool = new Map();
var socketMutex = new Map();

function isSocketWriteAuthorized(socket) {
    if (!settings || !settings.secureEnabled) {
        return true;
    }
    return !!(socket && socket.isAuthenticated);
}

function isSocketAdminAuthorized(socket) {
    if (!settings || !settings.secureEnabled) {
        return true;
    }
    return !!(socket && socket.isAuthenticated && api?.authJwt?.haveAdminPermission(socket.userGroups));
}

function init(_io, _api, _settings, _log, eventsMain) {
    io = _io;
    settings = _settings;
    logger = _log;
    api = _api;
    // check runtime init dependency and send to main if ready
    var checkInit = function () {
        if (!events.listenerCount('init-plugins-ok') && !events.listenerCount('init-users-ok') && !events.listenerCount('init-project-ok')) {
            eventsMain.emit('init-runtime-ok');
        }
    }
    events.once('init-plugins-ok', checkInit);
    events.once('init-users-ok', checkInit);
    events.once('init-project-ok', checkInit);


    daqstorage.init(settings, logger, runtime);

    // Initialize scheduler services
    schedulerStorage.init(settings, logger, runtime).then(() => {
        return schedulerService.init(settings, logger, runtime);
    }).then(() => {
        logger.info('runtime init scheduler services successful!', true);
    }).catch(err => {
        logger.error('runtime.failed-to-init scheduler services: ' + err);
    });

    // Initialize recipe services
    recipeStorage.init(settings, logger, runtime).then(() => {
        return recipeService.init(settings, logger, runtime);
    }).then(() => {
        logger.info('runtime init recipes successful!', true);
    }).catch(err => {
        logger.error('runtime.failed-to-init recipes: ' + err);
    });

    // Initialize calibration services
    calibration.init(settings, logger, runtime).then(() => {
        logger.info('runtime init calibration successful!', true);
    }).catch(err => {
        logger.error('runtime.failed-to-init calibration: ' + err);
    });

    // Initialize camera / video sources
    cameras.init(settings, logger, runtime).catch(err => {
        logger.error('runtime.failed-to-init cameras: ' + err);
    });

    // Initialize the OPC UA server (publish this project to OPC UA clients).
    // Opt-in, and after the devices/Cameras/AI services exist so the address
    // space can be built from real data.
    opcuaServer.init(settings, logger, runtime).catch(err => {
        logger.error('runtime.failed-to-init opcua-server: ' + (err.message || err));
    });

    plugins.init(settings, logger).then(result => {
        logger.info('runtime init plugins successful!', true);
        events.emit('init-plugins-ok');
    }).catch(function (err) {
        logger.error('runtime.failed-to-init plugins');
    });

    apiKeys.init(settings, logger).then(() => {
        logger.info('runtime init apiKeys successful!', true);
    }).catch(err => {
        logger.error('runtime.failed-to-init apiKeys: ' + err);
    });

    users.init(settings, logger).then(result => {
        logger.info('runtime init users successful!', true);
        events.emit('init-users-ok');
    }).catch(function (err) {
        logger.error('runtime.failed-to-init users');
    });

    project.init(settings, logger, runtime).then(result => {
        logger.info('runtime init project successful!', true);
        events.emit('init-project-ok');
    }).catch(function (err) {
        logger.error('runtime.failed-to-init project');
    });
    alarmsMgr = alarms.create(runtime);
    notificatorMgr = notificator.create(runtime);
    scriptsMgr = scripts.create(runtime);
    jobsMgr = jobs.create(runtime);
    devices.init(runtime);

    events.on('device-value:changed', updateDeviceValues);
    events.on('device-status:changed', updateDeviceStatus);
    events.on('alarms-status:changed', updateAlarmsStatus);
    events.on('tag-change:subscription', subscriptionTagChange);
    events.on('script-console', scriptConsoleOutput);

    io.on('connection', async (socket) => {
        logger.info(`socket.io client connected ${socket.id}`);
        socket.tagsClientSubscriptions = [];
        // check authorizations
        const query = (socket && socket.handshake && socket.handshake.query) ? socket.handshake.query : {};
        var token = query.token;
        if (!query.token || query.token === 'null') {
            token = api.authJwt.getGuestToken();
        }
        socket.userId = null;
        socket.userGroups = null;
        socket.isAuthenticated = !settings.secureEnabled;
        if (settings.secureEnabled) {
            try {
                const decoded = jwt.verify(token, api.authJwt.secretCode);
                socket.userId = decoded.id;
                socket.userGroups = decoded.groups;
                socket.isAuthenticated = decoded.id && decoded.id !== 'guest';
                if (!settings.secureOnlyEditor) {
                    logger.info(`Client connected with ${socket.isAuthenticated ? 'authenticated token' : 'guest access'}`);
                }
            } catch (error) {
                logger.error(`Token error: ${error}`);
                socket.disconnect();
                return;
            }
        }

        socket.on('disconnect', (reason) => {
            logger.info('socket.io disconnection:', socket.id, 'reason', reason);
        });

        // client ask device status
        socket.on(Events.IoEventTypes.DEVICE_STATUS, (message) => {
            if (message === 'get') {
                var adevs = devices.getDevicesStatus();
                for (var id in adevs) {
                    socket.emit(Events.IoEventTypes.DEVICE_STATUS, { id: id, status: adevs[id] });
                }
            } else {
                logger.warn(`${Events.IoEventTypes.DEVICE_STATUS}: rejected client status update from ${socket.userId || 'guest'}`);
            }
        });
        // client ask device property
        socket.on(Events.IoEventTypes.DEVICE_PROPERTY, (message) => {
            try {
                if (!isSocketWriteAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.DEVICE_PROPERTY}: unauthorized request from ${socket.userId || 'guest'}`);
                    return;
                }
                if (message && message.endpoint && message.type) {
                    devices.getSupportedProperty(message.endpoint, message.type).then(result => {
                        message.result = result;
                        socket.emit(Events.IoEventTypes.DEVICE_PROPERTY, message);
                    }).catch(function (err) {
                        logger.error(`${Events.IoEventTypes.DEVICE_PROPERTY}: ${err}`);
                        message.error = err;
                        socket.emit(Events.IoEventTypes.DEVICE_PROPERTY, message);
                    });
                } else {
                    logger.error(`${Events.IoEventTypes.DEVICE_PROPERTY}: wrong message`);
                    message = message || {};
                    message.error = 'wrong message';
                    socket.emit(Events.IoEventTypes.DEVICE_PROPERTY, message);
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_PROPERTY}: ${err}`);
            }
        });
        // client ask device values
        socket.on(Events.IoEventTypes.DEVICE_VALUES, (message) => {
            try {
                if (message === 'get') {
                    var adevs = devices.getDevicesValues();
                    for (var id in adevs) {
                        updateDeviceValues({ id: id, values: adevs[id] || {} });
                    }
                } else if (message.cmd === 'set' && message.var) {
                    if (!isSocketWriteAuthorized(socket)) {
                        logger.warn(`${Events.IoEventTypes.DEVICE_VALUES}: unauthorized write attempt from ${socket.userId || 'guest'}`);
                        return;
                    }
                    devices.setDeviceValue(message.var.source, message.var.id, message.var.value, message.fnc);
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_VALUES}: ${err}`);
            }
        });
        // client ask device browse
        socket.on(Events.IoEventTypes.DEVICE_BROWSE, (message) => {
            try {
                if (!isSocketAdminAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.DEVICE_BROWSE}: unauthorized request from ${socket.userId || 'guest'}`);
                    return;
                }
                if (message) {
                    if (message.device) {
                        devices.browseDevice(message.device, message.node, function (nodes) {
                            socket.emit(Events.IoEventTypes.DEVICE_BROWSE, nodes);
                        }).then(result => {
                            message.result = result;
                            socket.emit(Events.IoEventTypes.DEVICE_BROWSE, message);
                        }).catch(function (err) {
                            logger.error(`${Events.IoEventTypes.DEVICE_BROWSE}: ${err}`);
                            message.error = err;
                            socket.emit(Events.IoEventTypes.DEVICE_BROWSE, message);
                        });
                    }
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_BROWSE}: ${err}`);
            }
        });
        // client ask device node attribute
        socket.on(Events.IoEventTypes.DEVICE_NODE_ATTRIBUTE, (message) => {
            try {
                if (!isSocketAdminAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.DEVICE_NODE_ATTRIBUTE}: unauthorized request from ${socket.userId || 'guest'}`);
                    return;
                }
                if (message) {
                    if (message.device) {
                        devices.readNodeAttribute(message.device, message.node).then(result => {
                            socket.emit(Events.IoEventTypes.DEVICE_NODE_ATTRIBUTE, message);
                        }).catch(function (err) {
                            logger.error(`${Events.IoEventTypes.DEVICE_NODE_ATTRIBUTE}: ${err}`);
                            message.error = err;
                            socket.emit(Events.IoEventTypes.DEVICE_NODE_ATTRIBUTE, message);
                        });
                    }
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_NODE_ATTRIBUTE}: ${err}`);
            }
        });
        // client query DAQ values
        socket.on(Events.IoEventTypes.DAQ_QUERY, (msg) => {
            try {
                if (msg && msg.from && msg.to && msg.sids && msg.sids.length) {
                    const TIME_CHUNK_SIZE = 60 * 60 * 1000 * 6; // Dimensione del chunk in millisecondi (ad esempio, 1 ora)
                    const timeChunks = utils.chunkTimeRange(msg.from, msg.to, msg.chunked ? TIME_CHUNK_SIZE : 0);
                    const processChunks = async () => {
                        var counter = 1;
                        for (const chunk of timeChunks) {
                            try {
                                var dbfncs = [];
                                for (let i = 0; i < msg.sids.length; i++) {
                                    dbfncs.push(daqstorage.getNodeValues(msg.sids[i], chunk.start, chunk.end));
                                }
                                const values = await Promise.all(dbfncs);
                                io.emit(Events.IoEventTypes.DAQ_RESULT, {
                                    gid: msg.gid,
                                    result: values,
                                    chunk: {
                                        index: counter++,
                                        of: timeChunks.length
                                    }
                                });
                            } catch (error) {
                                logger.error(`${Events.IoEventTypes.DAQ_QUERY}: ${error.stack || error}`);
                                // `gid` bare does not exist; the query id is msg.gid, which the
                                // success frame just above sends. A ReferenceError here would fire
                                // WHILE REPORTING a DAQ failure, so the client would get neither the
                                // result nor the error, and would wait for ever.
                                io.emit(Events.IoEventTypes.DAQ_ERROR, { gid: msg.gid, error });
                                return;
                            }
                        }
                    }
                    processChunks();
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DAQ_QUERY}: ${err}`);
            }
        });
        // client ask alarms status
        socket.on(Events.IoEventTypes.ALARMS_STATUS, (message) => {
            if (message === 'get') {
                updateAlarmsStatus(socket);
            }
        });
        // client ask host interfaces
        socket.on(Events.IoEventTypes.HOST_INTERFACES, (message) => {
            try {
                if (!isSocketAdminAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.HOST_INTERFACES}: unauthorized request from ${socket.userId || 'guest'}`);
                    return;
                }
                if (message === 'get') {
                    message = {};
                    utils.getHostInterfaces().then(result => {
                        message.result = result;
                        socket.emit(Events.IoEventTypes.HOST_INTERFACES, message);
                    }).catch(function (err) {
                        logger.error(`${Events.IoEventTypes.HOST_INTERFACES}: ${err}`);
                        message.error = err;
                        socket.emit(Events.IoEventTypes.HOST_INTERFACES, message);
                    });
                } else {
                    logger.error(`${Events.IoEventTypes.HOST_INTERFACES}: wrong message`);
                    message.error = 'wrong message';
                    socket.emit(Events.IoEventTypes.HOST_INTERFACES, message);
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.HOST_INTERFACES}: ${err}`);
            }
        });
        // client ask device webapi request and return result
        socket.on(Events.IoEventTypes.DEVICE_WEBAPI_REQUEST, (message) => {
            try {
                if (!isSocketAdminAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.DEVICE_WEBAPI_REQUEST}: unauthorized request from ${socket.userId || 'guest'}`);
                    return;
                }
                if (message && message.property) {
                    devices.getRequestResult(message.property).then(result => {
                        message.result = result;
                        socket.emit(Events.IoEventTypes.DEVICE_WEBAPI_REQUEST, message);
                    }).catch(function (err) {
                        logger.error(`${Events.IoEventTypes.DEVICE_WEBAPI_REQUEST}: ${err}`);
                        message.error = err;
                        socket.emit(Events.IoEventTypes.DEVICE_WEBAPI_REQUEST, message);
                    });
                } else {
                    logger.error(`${Events.IoEventTypes.DEVICE_WEBAPI_REQUEST}: wrong message`);
                    message = message || {};
                    message.error = 'wrong message';
                    socket.emit(Events.IoEventTypes.DEVICE_WEBAPI_REQUEST, message);
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_WEBAPI_REQUEST}: ${err}`);
            }
        });
        // client ask device tags configurtions, used for connections that load tags dinamically (webapi)
        socket.on(Events.IoEventTypes.DEVICE_TAGS_REQUEST, (message) => {
            try {
                if (!isSocketAdminAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.DEVICE_TAGS_REQUEST}: unauthorized request from ${socket.userId || 'guest'}`);
                    return;
                }
                if (message && message.deviceId) {
                    devices.getDeviceTagsResult(message.deviceId).then(result => {
                        message.result = result;
                        socket.emit(Events.IoEventTypes.DEVICE_TAGS_REQUEST, message);
                    }).catch(function (err) {
                        logger.error(`${Events.IoEventTypes.DEVICE_TAGS_REQUEST}: ${err}`);
                        message.error = err;
                        socket.emit(Events.IoEventTypes.DEVICE_TAGS_REQUEST, message);
                    });
                } else {
                    logger.error(`${Events.IoEventTypes.DEVICE_TAGS_REQUEST}: wrong message`);
                    message.error = 'wrong message';
                    socket.emit(Events.IoEventTypes.DEVICE_TAGS_REQUEST, message);
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_TAGS_REQUEST}: ${err}`);
            }
        });
        socket.on(Events.IoEventTypes.DEVICE_TAGS_SUBSCRIBE, (message) => {
            try {
                socket.tagsClientSubscriptions = message.tagsId
                if (message.sendLastValue) {
                    var adevs = devices.getDevicesValues();
                    for (var id in adevs) {
                        updateDeviceValues({ id: id, values: adevs[id] || {}});
                    }
                }
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_TAGS_SUBSCRIBE}: ${err}`);
            }
        });
        socket.on(Events.IoEventTypes.DEVICE_TAGS_UNSUBSCRIBE, (message) => {
            try {
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_TAGS_UNSUBSCRIBE}: ${err}`);
            }
        });
        socket.on(Events.IoEventTypes.DEVICE_ENABLE, (message) => {
            try {
                if (!isSocketWriteAuthorized(socket)) {
                    logger.warn(`${Events.IoEventTypes.DEVICE_ENABLE}: unauthorized enable attempt from ${socket.userId || 'guest'}`);
                    return;
                }
                devices.enableDevice(message.deviceName, message.enable);
            } catch (err) {
                logger.error(`${Events.IoEventTypes.DEVICE_ENABLE}: ${err}`);
            }
        });
        // client cancel recipe execution
        socket.on(Events.IoEventTypes.RECIPE_CANCEL, (message) => {
            try {
                if (!isSocketWriteAuthorized(socket)) {
                    logger.warn('recipe:cancel-execution: unauthorized request from ' + (socket.userId || 'guest'));
                    return;
                }
                if (message && message.recipeId) {
                    runtime.recipeService.cancelRecipe(message.recipeId);
                }
            } catch (err) {
                logger.error('recipe:cancel-execution: ' + err);
            }
        });
    });

    setInterval(() => {
        io.emit(Events.IoEventTypes.ALIVE, { message: 'SCADIA server is alive!' });
    }, (settings.heartbeatIntervalSec || 10) * 1000);
}

function start() {
    return new Promise(function (resolve, reject) {
        // load project
        project.load().then(result => {
            // start to comunicate with devices
            devices.start().then(function () {
                resolve(true);
            }).catch(function (err) {
                logger.error('runtime.failed-to-start-devices: ' + err);
                reject();
            });
            // start alarms manager
            alarmsMgr.start().then(function () {
                resolve(true);
            }).catch(function (err) {
                logger.error('runtime.failed-to-start-alarms: ' + err);
                reject();
            });
            // start notificator manager
            notificatorMgr.start().then(function () {
                resolve(true);
            }).catch(function (err) {
                logger.error('runtime.failed-to-start-notificator: ' + err);
                reject();
            });
            // start scripts manager
            scriptsMgr.start().then(function () {
                resolve(true);
            }).catch(function (err) {
                logger.error('runtime.failed-to-start-scripts: ' + err);
                reject();
            });
            // start jobs manager
            jobsMgr.start().then(function () {
                resolve(true);
            }).catch(function (err) {
                logger.error('runtime.failed-to-start-jobs: ' + err);
                reject();
            });
        }).catch(function (err) {
            logger.error('runtime.failed-to-start: ' + err);
            reject();
        });
    });
}

function stop() {
    return new Promise(function (resolve, reject) {
        Promise.all([
            devices.stop().catch(function (err) {
                logger.error('runtime.failed-to-stop-devices: ' + err);
            }),
            alarmsMgr.stop().catch(function (err) {
                logger.error('runtime.failed-to-stop-alarms: ' + err);
            }),
            notificatorMgr.stop().catch(function (err) {
                logger.error('runtime.failed-to-stop-notificatorMgr: ' + err);
            }),
            scriptsMgr.stop().catch(function (err) {
                logger.error('runtime.failed-to-stop-scriptsMgr: ' + err);
            }),
            jobsMgr.stop().catch(function (err) {
                logger.error('runtime.failed-to-stop-jobsMgr: ' + err);
            }),
            // calibration and cameras are deliberately NOT stopped here.
            //
            // Measured (batch 75): restart() = stop() then start(), and start() re-starts devices,
            // alarms, notificator, scripts and jobs - but it never re-inits the camera or calibration
            // services. Both of those keep their data in the APPLICATION's workDir
            // (<workDir>/_appdata/cameras.scadiap.db, calibration.scadiap.db), not in the project, so
            // stopping them on a project reload only closed their database handles for good: after any
            // `POST /api/project` (the UI's "load project") every camera route answered 503
            // CAM_NOT_READY and every calibration route "calibration service not initialized", until the
            // process was restarted. Their state is not project state, so a project reload must not
            // touch it.
            opcuaServer.stop().catch(function (err) {
                logger.error('runtime.failed-to-stop-opcua-server: ' + err);
            })
        ]).then(function () {
            resolve(true);
        }).catch(function (err) {
            reject(err);
        });
    });
}

function update(cmd, data) {
    return new Promise(function (resolve, reject) {
        try {
            if (cmd === project.ProjectDataCmdType.SetDevice) {
                devices.updateDevice(data);
                alarmsMgr.reset();
            } else if (cmd === project.ProjectDataCmdType.DelDevice) {
                devices.removeDevice(data);
                alarmsMgr.reset();
            } else if (cmd === project.ProjectDataCmdType.SetAlarm || cmd === project.ProjectDataCmdType.DelAlarm) {
                alarmsMgr.reset();
                notificatorMgr.reset();
            } else if (cmd === project.ProjectDataCmdType.SetNotification || cmd === project.ProjectDataCmdType.DelNotification) {
                notificatorMgr.reset();
            } else if (cmd === project.ProjectDataCmdType.SetScript) {
                scriptsMgr.updateScript(data);
            } else if (cmd === project.ProjectDataCmdType.DelScript) {
                scriptsMgr.removeScript(data);
            } else if (cmd === project.ProjectDataCmdType.SetReport || cmd === project.ProjectDataCmdType.DelReport) {
                jobsMgr.reset();
            }
            resolve(true);
        } catch (err) {
            if (err.stack) {
                logger.error(err.stack);
            } else {
                logger.error(err);
            }
            reject();
        }
    });
}

function restart(clear) {
    return new Promise(function (resolve, reject) {
        try {
            stop().then(function () {
                if (clear) {
                    alarmsMgr.clear();
                    notificatorMgr.clear();
                }
                logger.info('runtime.update-project: stopped!', true);
                // 90-AF: stop() also tears down cameras, calibration and the OPC UA server,
                // but their init only runs at first boot - a hot restart used to leave them
                // dead (the cameras API answered 500 on a null DB handle until the next boot).
                // Re-run their init here, fire-and-forget exactly like the boot path does.
                cameras.init(settings, logger, runtime).catch(err => {
                    logger.error('runtime.failed-to-init cameras (restart): ' + err);
                });
                calibration.init(settings, logger, runtime).then(() => {
                    logger.info('runtime re-init calibration successful!', true);
                }).catch(err => {
                    logger.error('runtime.failed-to-init calibration (restart): ' + err);
                });
                opcuaServer.init(settings, logger, runtime).catch(err => {
                    logger.error('runtime.failed-to-init opcua-server (restart): ' + (err.message || err));
                });
                start().then(function () {
                    logger.info('runtime.update-project: restart!');
                    resolve(true);
                }).catch(function (err) {
                    logger.error('runtime.update-project-start: ' + err);
                    reject();
                });
            }).catch(function (err) {
                logger.error('runtime.update-project-stop: ' + err);
                reject();
            });
        } catch (err) {
            if (err.stack) {
                logger.error(err.stack);
            } else {
                logger.error(err);
            }
            reject();
        }
    });
}


/**
 * Transmit the device values to all frontend
 * @param {*} event
 */
/**
 * Send one device's values to every subscribed socket, or to all of them.
 *
 * EXTRACTED FROM updateDeviceValues SO THAT ITS FAILURE MODE IS TESTABLE - and the failure mode is
 * the point. One try/catch used to wrap the whole fan-out, so a single socket that threw (a
 * half-closed transport, a permission lookup that failed inside the client's own state) aborted the
 * remaining sockets in the list AND the in-process announce below it. The only trace was
 * "Error updating device values", with no socket and no device.
 *
 * So each socket is now isolated: a failure is logged WITH the socket id and the device id, and the
 * loop continues. That is a behaviour change, and the intended one - the previous behaviour was not
 * "resilience", it was "one bad subscriber silences the rest".
 *
 * A PARTIAL failure is logged and the loop continues (batch 9). A TOTAL failure returns the same
 * shape, and the caller reports it to the client (batch 48, N-27): when every socket refused the
 * frame the operator's picture silently stops moving, and one server-side log line is not a signal
 * the operator can see. The counts are what carry that distinction - `sent === 0 && failed > 0`.
 *
 * @param {object} ioLike anything with sockets.sockets (a Map) and emit()
 * @param {object} event  {id: deviceId, values: {tagId: tagRecord}}
 * @param {object} options {broadcastAll, logger}
 * @returns {{mode: string, sent: number, failed: number}}
 */
function fanOutDeviceValues(ioLike, event, options) {
    const opts = options || {};
    const values = (event && event.values) || {};
    if (opts.broadcastAll !== false) {
        // No per-socket isolation here by design: a broadcast is one call, so it either happened or
        // it threw, and the throw belongs to the caller (updateDeviceValues logs it with the device).
        ioLike.emit(Events.IoEventTypes.DEVICE_VALUES, {
            id: event.id,
            values: tagsToSend(values)
        });
        return { mode: 'broadcast', sent: 1, failed: 0 };
    }

    const sockets = ioLike.sockets && ioLike.sockets.sockets
        ? Array.from(ioLike.sockets.sockets.values())
        : [];
    let sent = 0;
    let failed = 0;
    sockets.forEach((socket) => {
        try {
            const subscribed = Array.isArray(socket.tagsClientSubscriptions) ? socket.tagsClientSubscriptions : [];
            const tags = Object.values(values).filter((tag) => subscribed.includes(tag.id));
            socket.emit(Events.IoEventTypes.DEVICE_VALUES, {
                id: event.id,
                values: tagsToSend(tags)
            });
            sent++;
        } catch (err) {
            failed++;
            const message = err && err.message ? err.message : String(err);
            if (opts.logger && typeof opts.logger.error === 'function') {
                opts.logger.error('runtime.failed-to-send-device-values: socket ' +
                    (socket && socket.id ? socket.id : '(no id)') + ', device "' +
                    (event && event.id) + '": ' + message);
            }
        }
    });
    return { mode: 'subscribed', sent: sent, failed: failed };
}

function updateDeviceValues(event) {
    try {
        const fanOut = fanOutDeviceValues(io, event, {
            broadcastAll: settings.broadcastAll,
            logger: logger
        });
        // A LOST update, and only a lost one. "sent 0 / failed N" is exactly the case where nobody
        // received the frame: with no subscribers at all the loop never runs, so sent and failed are
        // both 0 and there is nothing to report. A PARTIAL failure is deliberately not a frame - it
        // is not the operator's problem, and one frame per failing socket under load would be noise.
        // N-27 asked for this contract; the shape follows the frames this project already emits:
        // an id naming WHICH thing failed, plus a message a human can read.
        if (fanOut.mode === 'subscribed' && fanOut.failed > 0 && fanOut.sent === 0) {
            io.emit(Events.IoEventTypes.DEVICE_VALUES_ERROR, {
                id: event && event.id,
                error: 'no subscriber accepted the update: ' + fanOut.failed + ' socket(s) failed',
                sent: fanOut.sent,
                failed: fanOut.failed
            });
        }
        // Map.forEach hands (value, key) - NOT (key, value). Naming them the other way
        // round made `event.values[true]` the lookup, which is always undefined, so this
        // emitter never fired. Its consumers (scheduler tag triggers, the OPC UA server's
        // subscriptions, the MQTT republisher) were dead in the field with no error anywhere.
        tagsSubscription.forEach((subscribed, tagId) => {
            if (subscribed) {
                emitTagValueChanged(event.values[tagId]);
            }
        });
    } catch (err) {
        // Names the device: the previous message could not be traced back to one.
        logger.error('runtime.failed-to-update-device-values: device "' +
            (event && event.id) + '": ' + (err && err.message ? err.message : err));
    }
}

/**
 * Announce one tag's new value to the in-process consumers.
 *
 * Exported so the wiring can be tested without booting the runtime; a tag that carries no
 * value is not announced at all, because a consumer cannot tell "no value" from "value
 * undefined" and would treat it as a change.
 *
 * @param {*} tag value record as stored in the device values map
 * @returns {boolean} whether an event was emitted
 */
function emitTagValueChanged(tag) {
    if (!tag || typeof tag !== 'object') {
        return false;
    }
    events.emit('tag-value:changed', tag);
    return true;
}

/**
 * @param {*} tags
 */
function tagsToSend(tags) {
    return Object.values(tags).map(tag => ({
        id: tag.id,
        value: tag.value,
        timestamp: tag.timestamp,
        quality: tag.quality
    }));
}

function subscriptionTagChange(tagid) {
    try {
        tagsSubscription.set(tagid, true);
    } catch (err) {
    }
}

/**
 * Transmit the device status to all frontend
 * @param {*} event
 */
function updateDeviceStatus(event) {
    try {
        io.emit(Events.IoEventTypes.DEVICE_STATUS, event);
    } catch (err) {
    }
}

/**
 * Transmit the alarms status to all frontend
 */
function getSocketPermission(socket) {
    if (!settings || !settings.secureEnabled) {
        return -1;
    }
    if (settings.userRole && socket?.userId !== 'admin') {
        return users.getUserCache(socket?.userId);
    }
    return socket?.userGroups;
}

function updateAlarmsStatus(socket) {
    try {
        if (socket) {
            alarmsMgr.getAlarmsStatus(getSocketPermission(socket)).then(function (result) {
                socket.emit(Events.IoEventTypes.ALARMS_STATUS, result);
            }).catch(function (err) {
                if (err) {
                    logger.error('runtime.failed-to-update-alarms: ' + err);
                }
            });
        } else {
            Array.from(io.sockets.sockets.values()).forEach((clientSocket) => {
                alarmsMgr.getAlarmsStatus(getSocketPermission(clientSocket)).then(function (result) {
                    clientSocket.emit(Events.IoEventTypes.ALARMS_STATUS, result);
                }).catch(function (err) {
                    if (err) {
                        logger.error('runtime.failed-to-update-alarms: ' + err);
                    }
                });
            });
        }
    } catch (err) {
        logger.error('runtime.failed-to-update-alarms: ' + err);
    }
}

/**
 * Trasmit the scripts console output
 * @param {*} output
 */
function scriptConsoleOutput(output) {
    try {
        io.emit(Events.IoEventTypes.SCRIPT_CONSOLE, output);
    } catch (err) {
    }
}

/**
 * Trasmit the scripts command to frontend (clients)
 * @param {*} command
 * @param {*} parameters
 */
 function scriptSendCommand(command) {
    try {
        io.emit(Events.IoEventTypes.SCRIPT_COMMAND, command);
    } catch (err) {
    }
}

/**
 * for Role show/enabled or 16 bitmask (0-7 enabled / 8-15 show)
 * @param {*} userPermission
 * @param {*} contextPermission permission could be permission or permissionRoles
 * @param {*} forceUndefined return true if params are undefined/null/0
 * @param {*} onlyWithPermission return true if context.permissionRoles or context.permission are undefined/null/0
 * @returns { show: true/false, enabled: true/false }
 */
function checkPermission(userPermission, context, forceUndefined = false, onlyWithPermission = false) {
    if (!userPermission && !context) {
        // No user and No context
        return { show: forceUndefined || !settings.secureEnabled, enabled: forceUndefined || !settings.secureEnabled };
    }
    if (userPermission === -1 || userPermission === 255 || utils.isNullOrUndefined(context)) {
        // admin
        return { show: true, enabled: true };
    }
    const contextPermission = settings.userRole ? context.permissionRoles : context.permission;
    if (onlyWithPermission && contextPermission === undefined) {
        // No context permission, should be used only to check items
        return { show: true, enabled: true };
    }
    if (settings.userRole) {
        if (userPermission && !contextPermission) {
            return { show: true, enabled: false };
        }
    } else {
        if (userPermission && !context && !contextPermission) {
            return { show: true, enabled: false };
        }
    }
    var result = { show: false, enabled : false };
    if (settings.userRole) {
        if (userPermission && userPermission.info && userPermission.info.roles) {
            let voidRole = { show: true, enabled: true };
            if (contextPermission.show && contextPermission.show.length) {
                result.show = userPermission.info.roles.some(role => contextPermission.show.includes(role));
                voidRole.show = false;
            }
            if (contextPermission.enabled && contextPermission.enabled.length) {
                result.enabled = userPermission.info.roles.some(role => contextPermission.enabled.includes(role));
                voidRole.enabled = false;
            }
            if (voidRole.show && voidRole.enabled) {
                return voidRole;
            }
        } else {
            result.show = contextPermission && contextPermission.show && contextPermission.show.length ? false : true;
            result.enabled = contextPermission && contextPermission.enabled && contextPermission.enabled.length ? false : true;
        }
    } else {
        if (userPermission) {
            var mask = (contextPermission >> 8);
            result.show = (mask) ? mask & userPermission : 1;
            mask = (contextPermission & 255);
            result.enabled = (mask) ? mask & userPermission : 1;
        } else {
            result.show = contextPermission ? false : true;
            result.enabled = contextPermission ? false : true;
        }
    }
    return result;
}

var runtime = module.exports = {
    init: init,
    project: project,
    /** Test seam: the tag-value broadcast wiring, without booting runtime + socket.io. */
    emitTagValueChanged: emitTagValueChanged,
    /** Test seam: the per-socket fan-out, so "one bad socket must not silence the rest" is provable. */
    fanOutDeviceValues: fanOutDeviceValues,
    /** Test seam: the whole live-update path, so "a LOST update is reported" (N-27) is provable. */
    updateDeviceValues: updateDeviceValues,
    users: users,
    plugins: plugins,
    start: start,
    stop: stop,
    update: update,
    restart: restart,

    get io() { return io },
    get logger() { return logger },
    get settings() { return settings },
    get devices() { return devices },
    get daqStorage() { return daqstorage },
    get schedulerStorage() { return schedulerStorage },
    get schedulerService() { return schedulerService },
    get recipeStorage() { return recipeStorage },
    get recipeService() { return recipeService },
    get calibrationStorage() { return calibration.storage },
    get calibrationService() { return calibration.service },
    get cameraStorage() { return cameras.storage },
    get cameraService() { return cameras.service },
    get cameraPresets() { return cameras.presets },
    get cameraMedia() { return cameras.media },
    get cameraFusion() { return cameras.fusion },
    get cameraGb28181() { return cameras.gb28181 },
    get cameraAi() { return cameras.ai },
    get opcuaServer() { return opcuaServer },
    get alarmsMgr() { return alarmsMgr },
    get notificatorMgr() { return notificatorMgr },
    get scriptsMgr() { return scriptsMgr },
    get jobsMgr() { return jobsMgr },
    events: events,
    scriptSendCommand: scriptSendCommand,
    checkPermission: checkPermission,
    get socketPool() { return socketPool },
    get socketMutex() {return socketMutex },
    get apiKeys() { return apiKeys }
}
