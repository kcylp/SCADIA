/**
 * Devices manager, manage all the configurated devices in project
 */

'use strict';
var Device = require('./device');
var channelUtils = require('./channel-utils');

var sharedDevices = {};             // Shared Devices list
var activeDevices = {};             // Actives Devices list
var runtime;                        // Access to application resource like logger/settings
var wokingStatus;                   // Current status (start/stop) to know if is working

const ScadiaServerId = '0';
/**
 * Init by set the access to application resource
 * @param {*} _runtime
 */
function init(_runtime) {
    runtime = _runtime;
}

/**
 * Load and start all Devices actives
 */
function start() {
    wokingStatus = 'starting';
    devices.load();
    return new Promise(function (resolve, reject) {
        // runtime.logger.info('devices.start-all (' + Object.keys(activeDevices).length + ')', true);
        for (var id in activeDevices) {
            activeDevices[id].start();
        }
        resolve();
        wokingStatus = null;
    });
}

/**
 * Stop all Devices
 */
function stop() {
    wokingStatus = 'stopping';
    return new Promise(function (resolve, reject) {
        // runtime.logger.info('devices.stop-all (' + Object.keys(activeDevices).length + ')');
        var deviceStopfnc = [];
        for (var id in activeDevices) {
            deviceStopfnc.push(activeDevices[id].stop());
        }
        return Promise.all(deviceStopfnc).then(values => {
            resolve(true);
            wokingStatus = null;
        }, reason => {
            runtime.logger.error('devices.stop-all: ' + reason);
            resolve(reason);
            wokingStatus = null;
        });
    });
}

/**
 * Update all by restart all devices
 */
function update() {
    devices.stop().then(function () {
        devices.start().then(function () {

        }).catch(function (err) {
            runtime.logger.error('devices.update-start: ' + err);
        });
    }).catch(function (err) {
        runtime.logger.error('devices.ipdate-stop: ' + err);
    });
}

/**
 * Update the device, load and restart it
 * @param {*} device
 */
function updateDevice(device) {
    if (!activeDevices[device.id]) {
        if (devices.loadDevice(device) && device.enabled) {
            activeDevices[device.id].start();
        }
    } else {
        activeDevices[device.id].stop().then(function () {
            devices.loadDevice(device);
            if (device.enabled) {
                activeDevices[device.id].start();
            } else {
                delete activeDevices[device.id];
            }
        }).catch(function (err) {
            runtime.logger.error('devices.update-device ' + device.name + ': ' + err);
        });
    }
}

/**
 * Remove the device, stop it if active and remove from actieDevices list
 * @param {*} device
 */
function removeDevice(device) {
    invalidateTagIndex();
    if (!activeDevices[device.id]) {
        delete activeDevices[device.id];
    } else {
        activeDevices[device.id].stop().then(function () {
            delete activeDevices[device.id];
        }).catch(function (err) {
            delete activeDevices[device.id];
            runtime.logger.error('devices.remove-device by stop ' + device.name + ': ' + err);
        });
    }
}

/**
 * Load the device from project and add or remove of active device for the management
 */
function load() {
    var tempdevices = runtime.project.getDevices();
    var serverDevice = runtime.project.getServer();
    activeDevices = {};
    invalidateTagIndex();
    bindingRevision = Object.create(null);
    runtime.daqStorage.reset();
    if (serverDevice) {
        devices.loadDevice(serverDevice);
    }
    // check existing or to add new
    for (var id in tempdevices) {
        if (serverDevice && id === ScadiaServerId) {
            continue;
        }
        if (tempdevices[id].enabled) {
            if(tempdevices[id].type == 'ModbusRTU'){
                if(!(tempdevices[id].property.address in sharedDevices)){
                    sharedDevices[tempdevices[id].property.address] = [];
                }
                sharedDevices[tempdevices[id].property.address].push(id);
                tempdevices[id].sharedDevices = sharedDevices;
            }
            devices.loadDevice(tempdevices[id]);
        }
    }
    // log remove device not used
    for (var id in activeDevices) {
        if (Object.keys(tempdevices).indexOf(id) < 0) {
            runtime.logger.info(`devices.load-removed: '${activeDevices[id].name}'`, true);
        }
    }
}


/**
 * Binding generation per device (contract 09 section 4.3).
 *
 * A device is REBOUND in place: `updateDevice` stops it and `loadDevice` runs again on
 * the SAME object, rebuilding the driver tag maps from the new project definition.
 * Clearing the polling interval does not cancel a read that is already in flight, so a
 * response belonging to the old binding can still arrive afterwards and be written as
 * if it were current.
 *
 * Every rebind therefore bumps this counter, and the DAQ sink is wrapped so that output
 * routed through a superseded sink no longer reaches the archive.
 *
 * IMPORTANT - what this does NOT do yet: a driver does not carry the revision with the
 * value it produces, so a late response is indistinguishable from a current one by
 * inspection. Closing that gap needs the revision to travel with the read (the driver
 * layer must capture it when the read starts and attach it to the result). This module
 * provides the counter, the accessor and the sink guard that layer will build on.
 */
var bindingRevision = Object.create(null);

/** Current binding generation of a device (0 when it has never been loaded). */
function getBindingRevision(deviceId) {
    return bindingRevision[deviceId] || 0;
}

/**
 * Wrap a value sink so that output produced by a superseded binding is dropped.
 *
 * The wrapped function keeps the original signature, so every existing caller and
 * driver is unaffected. Discarded calls are counted (getStaleValuesDropped) rather than
 * failing silently.
 *
 * Note the limit stated on bindingRevision: this guard covers output routed through a
 * superseded sink. Output that a still-installed driver produces after a rebind is not
 * yet distinguishable, because the revision does not travel with the value.
 *
 * `param {string} deviceId
 * `param {number} revision revision captured at bind time
 * `param {Function} write the real sink
 */
function bindValueSinkToRevision(deviceId, revision, write) {
    return function () {
        if (getBindingRevision(deviceId) !== revision) {
            staleValuesDropped++;
            if (runtime && runtime.logger) {
                runtime.logger.warn(`devices: dropped a value from a superseded binding of '${deviceId}' (revision ${revision}, current ${getBindingRevision(deviceId)})`);
            }
            return false;
        }
        return write.apply(null, arguments);
    };
}

/** Number of values discarded because their binding had been replaced (diagnostics). */
var staleValuesDropped = 0;
function getStaleValuesDropped() { return staleValuesDropped; }
/**
 * Load the device to manage and set on depending of settings
 * @param {*} device
 */
function loadDevice(device) {
    // A rebind of an existing device invalidates everything the previous binding may
    // still have in flight, so bump the generation BEFORE reloading.
    bindingRevision[device.id] = getBindingRevision(device.id) + 1;
    // Hand the generation down with the definition: Device.load() adopts it before the
    // driver rebuilds its tag maps, and drivers can then detect a rebind during a read.
    device.bindingRevision = bindingRevision[device.id];
    if (activeDevices[device.id]) {
        // device exist
        runtime.logger.info(`'${device.name}' exist`, true);
        activeDevices[device.id].load(device);
    } else {
        // device create
        let tdev = Device.create(device, runtime);
         if (tdev && tdev.start) {
            runtime.logger.info(`'${device.name}' created`);
            activeDevices[device.id] = tdev;
            activeDevices[device.id].bindGetProperty(runtime.project.getDeviceProperty);
            activeDevices[device.id].bindUpdateConnectionStatus(setDeviceConnectionStatus);
        } else {
            if (!Device.isInternal(device)) {
                runtime.logger.warn('try to create ' + device.name + ' but plugin is missing!');
            }
            return false;
        }
    }
    if (runtime.settings.daqEnabled) {
        var fncToSaveDaqValue = runtime.daqStorage.addDaqNode(device.id, activeDevices[device.id].getTagProperty);
        // Bind the sink to the generation that produced this wiring: values arriving
        // from a superseded binding are dropped instead of being archived as current.
        activeDevices[device.id].bindSaveDaqValue(
            bindValueSinkToRevision(device.id, getBindingRevision(device.id), fncToSaveDaqValue)
        );
        activeDevices[device.id].bindGetDaqValueToRestore(runtime.daqStorage.getCurrentStorageFnc());
    }
    return true;
}

/**
 * Return all devices status
 */
function getDevicesStatus() {
    var adev = {};
    for (var id in activeDevices) {
        adev[id] = activeDevices[id].getStatus();
    }
    return adev;
}

/**
 * Return all devices values
 */
function getDevicesValues() {
    var adev = {};
    for (var id in activeDevices) {
        adev[id] = activeDevices[id].getValues();
    }
    return adev;
}


/**
 * Get the Device Tag value
 * used from Alarms
 * @param {*} deviceid
 * @param {*} sigid
 * @param {*} value
 */
function getDeviceValue(deviceid, sigid) {
    if (activeDevices[deviceid]) {
        return activeDevices[deviceid].getValue(sigid);
    }
    return null;
}

/**
 * Get the value an ALARM must be evaluated against.
 *
 * This is deliberately NOT the same as `getValue()`. A tag's deadband substitutes the
 * previous reading for a fresh one that has not moved far enough — a *publication*
 * decision that must not be allowed to suppress an alarm. (last=99, deadband=10,
 * threshold=100, new reading 101: |101-99| <= 10, so 99 would be reported and the
 * alarm would never fire.)
 *
 * `tagValueCompose` therefore keeps `rawComposed` — the fully composed value
 * (read script + scale + format) with the deadband NOT applied — and this accessor
 * returns it.
 *
 * `rawComposed` is paired with `value` by construction: both are written by the same
 * `tagValueCompose` statement, so `rawComposed` can never be staler than the composed
 * value it sits next to. When a driver reports without composing (nothing new was read
 * this cycle) neither field changes, so the alarm sees the same instantaneous reading
 * the operator sees.
 *
 * @param {*} deviceid
 * @param {*} sigid
 * @returns {object} tag-like object with at least { value, ts, timestamp }
 */
function getDeviceAlarmValue(deviceid, sigid) {
    if (!activeDevices[deviceid]) {
        return null;
    }
    const tag = activeDevices[deviceid].getValue(sigid);
    if (!tag || typeof tag !== 'object') {
        return tag;
    }
    if (tag.rawComposed !== undefined && tag.rawComposed !== null) {
        // Mirror the composed object but judge on the deadband-free value.
        return Object.assign({}, tag, { value: tag.rawComposed });
    }
    return tag;
}

/**
 * These script-facing accessors all used to look like this:
 *
 *     try { ...; return x; } catch (err) { console.error(err); } return null;
 *
 * Nine copies of it in one file. Two things were wrong with each, and neither is about style:
 *
 *   1. `console.error` writes to stdout, while this runtime's operator diagnostics live in the
 *      logger (file + level). A device lookup that fails at three in the morning was therefore
 *      invisible in the log an operator actually reads.
 *   2. The message was just the error object. "Cannot read properties of undefined" with no idea
 *      whether it came from a tag lookup, a DAQ settings write, or a device enable - which is the
 *      same complaint the controllerErrors guard makes about the client.
 *
 * The BEHAVIOUR is deliberately unchanged: a failure is still logged and still answers null. These
 * are called from scripts, and a script that reads a missing tag must get null rather than throw -
 * changing that would turn a diagnosable gap into a broken automation.
 *
 * @param {string} operation name reported in the log
 * @param {string} subject   the id / name being acted on, for the log
 * @param {*} err            the caught error
 */
function logAccessorFailure(operation, subject, err) {
    const message = err && err.message ? err.message : String(err);
    runtime.logger.error('devices.' + operation + ' failed for "' + subject + '": ' + message);
}

/**
 * Get the Device Tag value
 * used from Alarms, Script
 * @param {*} sigid
 * @param {*} fully, struct with timestamp
 */
 function getTagValue(sigid, fully) {
    let deviceid;
    try {
        deviceid = getDeviceIdFromTag(sigid);
        if (activeDevices[deviceid]) {
            let result = activeDevices[deviceid].getValue(sigid);
            if (fully) {
                return result;
            } else if (result) {
                return result.value;
            }
        }
    } catch (err) {
        logAccessorFailure('getTagValue', sigid, err);
    }
    return null;
}

/**
 * Get the Device Tag Id
 * used from Script
 * @param {*} tagName
 * @param {*} deviceName
 */
function getTagId(tagName, deviceName) {
    try {
        const devices = runtime.project.getDevices();
        for (var id in devices) {
            if (!deviceName || devices[id].name === deviceName) {
                const tag = Object.values(devices[id].tags).find(tag => tag.name === tagName);
                if (tag) {
                    return tag.id;
                }
            }
        }
    } catch (err) {
        logAccessorFailure('getTagId', tagName, err);
    }
    return null;
}

/**
 * Set the Device Tag value
 * used from Scripts
 * @param {*} tagid
 * @param {*} value
 */
async function setTagValue(tagid, value) {
    try {
        let deviceid = getDeviceIdFromTag(tagid)
        if (activeDevices[deviceid]) {
            return  await activeDevices[deviceid].setValue(tagid, value);
        }
    } catch (err) {
        logAccessorFailure('setTagValue', tagid, err);
    }
    return null;
}

/**
 * Get the Device Tag Daq settings
 * used from Scripts
 * @param {*} tagid
 */
function getTagDaqSettings(tagId) {
    try {
        let deviceId = getDeviceIdFromTag(tagId)
        if (activeDevices[deviceId]) {
            return activeDevices[deviceId].getTagDaqSettings(tagId);
        }
    } catch (err) {
        logAccessorFailure('getTagDaqSettings', tagId, err);
    }
    return null;
}

/**
 * Set the Device Tag Daq settings
 * used from Scripts
 * @param {*} tagId
 * @param {*} settings
 */
function setTagDaqSettings(tagId, settings) {
    try {
        let deviceId = getDeviceIdFromTag(tagId);
        if (activeDevices[deviceId]) {
            return activeDevices[deviceId].setTagDaqSettings(tagId, settings);
        }
    } catch (err) {
        logAccessorFailure('setTagDaqSettings', tagId, err);
    }
    return null;
}

/**
 * Enable/disable Device connection
 * used from Scripts
 * @param {*} deviceName
 * @param {*} enable
 */
function enableDevice(deviceName, enable) {
    try {
        let device = runtime.project.getDevice(deviceName);
        enable = (typeof enable === 'string') ? enable === "true" : Boolean(enable);
        if (device && device.enabled !== enable) {
            device.enabled = enable;
            updateDevice(device);
        }
        runtime.logger.info(`devices.enableDevice: '${deviceName} - ${enable}'`, true);
    } catch (err) {
        logAccessorFailure('enableDevice', deviceName, err);
    }
}

/**
 * Get the Device property
 * used from Scripts
 * @param {*} deviceName
 */
function getDeviceProperty(deviceName) {
    try {
        let device = runtime.project.getDevice(deviceName);
        if (device) {
            return device.property;
        }
    } catch (err) {
        logAccessorFailure('getDeviceProperty', deviceName, err);
    }
    return null;
}

/**
 * Set the Device property
 * used from Scripts
 * @param {*} deviceName
 * @param {*} property
 */
function setDeviceProperty(deviceName, property) {
    try {
        let device = runtime.project.getDevice(deviceName);
        if (device) {
            device.property = property;
            updateDevice(device);
        }
    } catch (err) {
        logAccessorFailure('setDeviceProperty', deviceName, err);
    }
    return null;
}

/**
 * return Device object
 * used from Scripts
 * @param {*} deviceName string
 * @param {*} asInterface boolean
 */
function getDevice(deviceName, asInterface) {
    try {
        const device = runtime.project.getDevice(deviceName);
        if (device) {
            return asInterface ? activeDevices[device.id].getComm() : activeDevices[device.id];
        }
        return null;
    } catch (err) {
        logAccessorFailure('getDevice', deviceName, err);
    }
}

/**
 * Get the Device from the tag id
 * used from Alarms
 * @param {*} sigid
 */
 function getDeviceIdFromTag(sigid) {
    var found = resolveTag(sigid);
    return found ? found.deviceId : null;
}

/**
 * tagId -> owning deviceId index, rebuilt lazily whenever the set of active devices
 * changes. Keyed by a cheap structural signature so the index can never go stale
 * without anyone having to remember to invalidate it at each mutation point.
 *
 * Replaces the previous "walk every device and ask its driver" lookup, which was
 * O(devices) per call and — more importantly — silently returned the FIRST device
 * that happened to own a duplicated tagId. Consumers (alarms, scheduler, calibration,
 * fusion) all resolve their tag through here, so a silent mis-resolution is exactly
 * the "tagId stable but binding silently changed" failure the architecture review
 * flagged (ledger L-05, contract 09 §4.2).
 */
var tagIndex = null;
var tagIndexSignature = null;
var tagIndexConflicts = new Map();

function computeTagIndexSignature() {
    return Object.keys(activeDevices).sort().join('\u0000');
}

function buildTagIndex() {
    var index = new Map();
    var conflicts = new Map();
    for (var id in activeDevices) {
        var device = activeDevices[id];
        if (!device || typeof device.getTags !== 'function') { continue; }
        var tags = device.getTags();
        for (var tagId in tags) {
            if (!Object.prototype.hasOwnProperty.call(tags, tagId)) { continue; }
            if (!index.has(tagId)) {
                index.set(tagId, id);
            } else {
                // Duplicate tagId across devices: keep the first owner (matching the
                // historical behaviour so no consumer changes meaning) but record it so
                // the collision is visible instead of silent.
                var list = conflicts.get(tagId) || [index.get(tagId)];
                if (list.indexOf(id) < 0) { list.push(id); }
                conflicts.set(tagId, list);
            }
        }
    }
    tagIndex = index;
    tagIndexConflicts = conflicts;
    tagIndexSignature = computeTagIndexSignature();
    if (conflicts.size && runtime && runtime.logger) {
        var sample = Array.from(conflicts.keys()).slice(0, 10);
        runtime.logger.warn('devices: duplicate tagId(s) across devices — resolution is ambiguous: '
            + sample.join(', ') + (conflicts.size > sample.length ? ' (+' + (conflicts.size - sample.length) + ' more)' : ''));
    }
    return index;
}

function ensureTagIndex() {
    var sig = computeTagIndexSignature();
    if (tagIndex === null || tagIndexSignature !== sig) {
        buildTagIndex();
    }
    return tagIndex;
}

/**
 * Resolve a tagId to its owning device.
 *
 * @param {string} tagId
 * @returns {{deviceId:string, tagId:string, ambiguous:boolean, candidates:string[]}|null}
 */
function resolveTag(tagId) {
    if (tagId === undefined || tagId === null || tagId === '') { return null; }
    var index = ensureTagIndex();
    if (!index.has(tagId)) { return null; }
    var candidates = tagIndexConflicts.get(tagId) || null;
    return {
        deviceId: index.get(tagId),
        tagId: tagId,
        ambiguous: !!candidates,
        candidates: candidates || [index.get(tagId)]
    };
}

/**
 * Every duplicated tagId in the current project, for validation UIs and import checks.
 * Empty object means the project is unambiguous.
 * @returns {Object<string, string[]>}
 */
function getTagConflicts() {
    ensureTagIndex();
    var out = {};
    tagIndexConflicts.forEach(function (list, tagId) { out[tagId] = list.slice(); });
    return out;
}

/** Drop the cached index (call after any change to the active device set). */
function invalidateTagIndex() {
    tagIndex = null;
    tagIndexSignature = null;
}

/**
 * Get the channels of a device (device -> channel -> tag), including the
 * implicit default channel that holds tags with no explicit channel.
 * Returns [] for an unknown device.
 * @param {*} deviceId
 */
function getDeviceChannels(deviceId) {
    var device = getProjectDevice(deviceId);
    return device ? channelUtils.getChannels(device) : [];
}

/**
 * Get the id of the channel a tag belongs to (null when the tag is unknown).
 * @param {*} tagId
 */
function getChannelIdFromTag(tagId) {
    var device = findProjectDeviceByTag(tagId);
    if (!device) { return null; }
    return channelUtils.channelIdOf(device.tags[tagId]);
}

/** The project device by id, or null. */
function getProjectDevice(deviceId) {
    var devices = runtime.project ? runtime.project.getDevices() : null;
    return (devices && devices[deviceId]) || null;
}


/**
 * The project DEFINITION of a tag (device.tags[tagId]), or null when unknown.
 *
 * Definitions (not runtime values) are what carry configuration such as the data
 * domain, so validation paths need them. Resolves through the tag index, so it is
 * O(1) rather than a scan of every device.
 */
function getTagDefinition(tagId) {
    const resolved = resolveTag(tagId);
    if (!resolved) { return null; }
    const dev = getProjectDevice(resolved.deviceId);
    if (!dev || !dev.tags) { return null; }
    return dev.tags[tagId] || null;
}
/**
 * The project device that owns a tag, or null.
 *
 * Uses the same index as getDeviceIdFromTag. When the tag is unknown to the running
 * device set (e.g. the device is disabled) it falls back to a project scan, so a
 * disabled device's channels remain resolvable in the editor.
 */
function findProjectDeviceByTag(tagId) {
    var resolved = resolveTag(tagId);
    var devices = runtime.project ? runtime.project.getDevices() : null;
    if (resolved && devices && devices[resolved.deviceId]) {
        return devices[resolved.deviceId];
    }
    if (!devices) { return null; }
    for (var id in devices) {
        var tags = devices[id].tags;
        if (tags && Object.prototype.hasOwnProperty.call(tags, tagId)) {
            return devices[id];
        }
    }
    return null;
}

/**
 * Get the Tag value format from the tag id
 * used from Report
 * @param {*} sigid
 */
function getTagFormat(sigid) {
    for (var id in activeDevices) {
        var tag = activeDevices[id].getTagProperty(sigid);
        if (tag) {
            return tag.format;
        }
    }
    return null;
}

/**
 * Return if manager is working (started or stopped)
 */
function isWoking() {
    return (wokingStatus) ? true : false;
}

/**
 * Set the Device Tag value
 * @param {*} deviceid
 * @param {*} sigid
 * @param {*} value
 */
async function setDeviceValue(deviceid, sigid, value, fnc) {
    if (activeDevices[deviceid]) {
        await activeDevices[deviceid].setValue(sigid, value, fnc);
    }
}

/**
 * Set connection device status to server tag
 * @param {*} deviceId
 * @param {*} status
 */
function setDeviceConnectionStatus(deviceId, status) {
    if (activeDevices[ScadiaServerId] && activeDevices[ScadiaServerId].setDeviceConnectionStatus) {
        activeDevices[ScadiaServerId].setDeviceConnectionStatus(deviceId, status);
    }
}

/**
 * Return the Device browser result Tags/Nodes
 * @param {*} deviceid
 * @param {*} node
 */
function browseDevice(deviceid, node, callback) {
    return new Promise(function (resolve, reject) {
        if (activeDevices[deviceid] && activeDevices[deviceid].browse) {
            activeDevices[deviceid].browse(node, callback).then(function (result) {
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        } else {
            reject('Device not found!');
        }
    });
}

/**
 * Return Device Tag/Node attribute
 * @param {*} deviceid
 * @param {*} node
 */
function readNodeAttribute(deviceid, node) {
    return new Promise(function (resolve, reject) {
        if (activeDevices[deviceid] && activeDevices[deviceid].readNodeAttribute) {
            activeDevices[deviceid].readNodeAttribute(node).then(function (result) {
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        } else {
            reject('Device not found!');
        }
    });
}

/**
 * Return Device Tags settings
 * @param {*} deviceId
 */
function getDeviceTagsResult(deviceId) {
    return new Promise(function (resolve, reject) {
        if (activeDevices[deviceId] && activeDevices[deviceId].getTagsProperty) {
            activeDevices[deviceId].getTagsProperty().then(function (result) {
                resolve(result);
            }).catch(function (err) {
                reject(err);
            });
        } else {
            reject('Device not found!');
        }
    });
}

/**
 * Write several tags on one device in a single call.
 *
 * The device must be running: a write to a device that is not active would be
 * silently dropped, so it is refused with a clear reason instead.
 *
 * @param {string} deviceId
 * @param {Array<{id, value}>} entries
 */
function setTagsValues(deviceId, entries) {
    return new Promise(function (resolve, reject) {
        const device = activeDevices[deviceId];
        if (!device) {
            reject(new Error('Device not active: ' + deviceId));
            return;
        }
        if (!device.setValues) {
            reject(new Error('Batch write not supported by this device type'));
            return;
        }
        Promise.resolve(device.setValues(entries)).then(resolve).catch(reject);
    });
}

/**
 * Return the property (security mode) supported from device
 * @param {*} endpoint
 * @param {*} type
 */
function getSupportedProperty(endpoint, type) {
    return Device.getSupportedProperty(endpoint, type, runtime.plugins.manager);
}

/**
 * Return result of request
 * @param {*} property
 */
function getRequestResult(property) {
    return Device.getRequestResult(property);
}

/**
 * Return result of get node values
 * @param {*} tagId
 * @param {*} fromDate
 * @param {*} toDate return current datetime if its not a valid date
 */
async function getHistoricalTags(tagIds, fromTs, toTs) {
    return new Promise((resolve, reject) => {
        /*Check if getting date from script is correct*/
        if (isNaN(toTs) || isNaN(fromTs) || toTs < fromTs) {
            runtime.logger.error(`Incorect Date Format ${fromTs} - ${toTs}`);
            reject(`Incorect Date Format ${fromTs} - ${toTs}`);
        }

        runtime.daqStorage.getNodesValues(tagIds, fromTs, toTs).then((res) => {
            resolve(res);
        }).catch((err) => reject(err));
    });
}

/**
 * RESTRICTED raw holding-register read for the calibration module only.
 * Zero-based address; returns array of uint16 words.
 */
function readRawHoldingRegisters(deviceId, startZeroBased, quantity) {
    if (!activeDevices[deviceId]) {
        return Promise.reject(new Error('device not found: ' + deviceId));
    }
    const comm = activeDevices[deviceId].getComm();
    if (!comm || typeof comm.readRawHoldingRegisters !== 'function') {
        return Promise.reject(new Error('raw register read is not supported by this device type'));
    }
    return comm.readRawHoldingRegisters(startZeroBased, quantity);
}

/**
 * RESTRICTED raw holding-register write (FC16) for the calibration module only.
 * Zero-based address; words = uint16 array.
 */
function writeRawHoldingRegisters(deviceId, startZeroBased, words) {
    if (!activeDevices[deviceId]) {
        return Promise.reject(new Error('device not found: ' + deviceId));
    }
    const comm = activeDevices[deviceId].getComm();
    if (!comm || typeof comm.writeRawHoldingRegisters !== 'function') {
        return Promise.reject(new Error('raw register write is not supported by this device type'));
    }
    return comm.writeRawHoldingRegisters(startZeroBased, words);
}

var devices = module.exports = {
    init: init,
    start: start,
    stop: stop,
    load: load,
    loadDevice: loadDevice,
    update: update,
    updateDevice: updateDevice,
    removeDevice: removeDevice,
    getDevicesStatus: getDevicesStatus,
    getDevicesValues: getDevicesValues,
    getDeviceValue: getDeviceValue,
    getDeviceAlarmValue: getDeviceAlarmValue,
    resolveTag: resolveTag,
    getTagDefinition: getTagDefinition,
    getBindingRevision: getBindingRevision,
    getStaleValuesDropped: getStaleValuesDropped,
    bindingGuard: require('./binding-guard'),
    /**
     * The ACTIVE device instance (not the project definition).
     * Exposed for diagnostics and for the binding-revision tests, which need to drive a
     * driver-side emit without standing up a real connection.
     */
    getActiveDevice: function (deviceId) { return activeDevices[deviceId] || null; },
    getTagConflicts: getTagConflicts,
    invalidateTagIndex: invalidateTagIndex,
    getTagValue: getTagValue,
    setTagValue: setTagValue,
    setDeviceValue: setDeviceValue,
    getDeviceIdFromTag: getDeviceIdFromTag,
    getDeviceChannels: getDeviceChannels,
    getChannelIdFromTag: getChannelIdFromTag,
    browseDevice: browseDevice,
    readNodeAttribute: readNodeAttribute,
    getDeviceTagsResult: getDeviceTagsResult,
    setTagsValues: setTagsValues,
    isWoking: isWoking,
    getSupportedProperty: getSupportedProperty,
    getRequestResult: getRequestResult,
    getTagFormat: getTagFormat,
    enableDevice: enableDevice,
    getDevice: getDevice,
    getTagId: getTagId,
    readRawHoldingRegisters: readRawHoldingRegisters,
    writeRawHoldingRegisters: writeRawHoldingRegisters,
    getTagDaqSettings: getTagDaqSettings,
    setTagDaqSettings: setTagDaqSettings,
    getDeviceProperty: getDeviceProperty,
    setDeviceProperty: setDeviceProperty,
    getHistoricalTags: getHistoricalTags
}
