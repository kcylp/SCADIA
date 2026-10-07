/**
 * GPIO access and interrupt detection with Node.js on Linux boards like the Raspberry Pi.
 *
 * Note that although it's possible to install onoff on non-Linux systems the functionality offered by onoff is only available on Linux systems.
 */

'use strict';

const {IoEventTypes} = require("../../events");
const utils = require("../../utils");
const deviceUtils = require('../device-utils');
var Gpio;

function GpioClient(_data, _logger, _events, _runtime) {

    var data = utils.clone(_data); // Current Device data { id, name, tags, enabled, ... }
    var logger = _logger;
    var events = _events; // Events to commit change to runtime
    var runtime = _runtime;             // Access runtime config such as scripts
    var tagMap = {}
    var gpioMap = {}
    var varsValue = [];                 // Signal to send to frontend { id, type, value }
    var lastStatus = '';                // Last Device status
    var lastTimestampValue;             // Last Timestamp of asked values
    // Per-driver binding snapshot for the superseded-binding guard (contract 09 section 4.3).
    // Declared here since 2026-10-02: this driver published values without the guard.
    var bindingCache = { revision: null };


    /**
     * Connect to device
     * Emit connection status to clients, clear all Tags values
     */
    this.connect = function () {
        return new Promise(async function (resolve, reject) {
            _emitStatus('connect-ok');
            resolve();
        });
        // events.emit('device-status:changed', { id: data.id, status: 'connect-ok' });
        // events.emit('device-status:changed', { id: data.id, status: 'connect-error' });
    }


    /**
     * Disconnect the device
     * Emit connection status to clients, clear all Tags values
     */
    this.disconnect = function () {
        return new Promise(function (resolve, reject) {
            for(var tagId in data.tags){
                var tag = data.tags[tagId]
                if (gpioMap[tag.id]) {
                    try {
                        gpioMap[tag.id].unexport()
                    } catch (err) {
                    }
                }
            }
            _clearVarsValue()
            _emitStatus('connect-off');
            resolve(true);
        });
    }

    function _readGpio(tagId,gpio){
        return new Promise((resolve, reject) => {
            resolve({id: tagId, value: gpio.readSync()});
        })
    }
    /**
     * Read values in polling mode
     * Update the tags values list, save in DAQ if value changed or in interval and emit values to clients
     */
    this.polling = async function () {
        var readVarsfnc = [];

        for (var gpio in gpioMap) {
            readVarsfnc.push(await _readGpio(gpio,gpioMap[gpio]));
        }

        try {
            const result = await Promise.all(readVarsfnc);
            if (result.length) {
                await _updateVarsValue(result);
            } else {
                // console.error('then error');
            }
            if (lastStatus !== 'connect-ok') {
                _emitStatus('connect-ok');
            }
        } catch (reason) {
            logger.error(`'${data.name}' _readVars error! ${reason}`);
        }
        // events.emit('device-value:changed', { id: data.name, values: values });
    }

    /**
     * Load Tags attribute to read with polling
     */
    this.load = function (_data) {
        // A new binding: re-arm the guard so its first emit is judged against THIS binding.
        deviceUtils.resetBindingCache(bindingCache);
        data = utils.clone(_data);
        gpioMap = {};
        varsValue = [];
        // console.log(data)
        for(var tagId in data.tags){
            var tag = data.tags[tagId]
            try{
            gpioMap[tag.id] = new Gpio(tag.address, tag.direction, tag.edge);
            }catch(err){
                logger.error(`load GPIO failed ${tag.address}`,err)
                continue
            }
            tagMap[tag.id] = tag;
            // use interrupts
            if (tag.edge && tag.edge !== 'none') {
                gpioMap[tag.id].watch((err, val) => {
                    if (err) {
                        logger.error(`read gpio[${tag.id}] err`, err);
                    } else {
                        _updateVarsValue([{id: tag.id, value: val}]);
                    }
                })
            }
        }
        logger.info(`'${data.name}' data loaded `, true);
    }

    /**
     * Return Tags values array { id: <name>, value: <value> }
     */
    this.getValues = function () {
        return varsValue;
    }


    /**
     * Return connection status 'connect-off', 'connect-ok', 'connect-error', 'connect-busy'
     */
    this.getStatus = function () {
        return lastStatus
    }

    /**
     * Return Tag property to show in frontend
     */
    this.getTagProperty = function (tagid) {
        if (data.tags[tagid]) {
            return {
                id: tagid,
                name: data.tags[tagid].name,
                direction: data.tags[tagid].direction,
                edge: data.tags[tagid].edge,
                address: data.tags[tagid].address
            };
        } else {
            return null;
        }
    }

    /**
     * Set the Tag value to device
     */
    this.setValue = function (id, value) {
        const val = parseInt(value);
        if (gpioMap[id]) {
            gpioMap[id].writeSync(val)
            varsValue[id].value = val;
            varsValue[id].changed = true;
            logger.info(`'${data.name}' setValue(${id}, ${value})`, true, true);
            return true;
        }
        return false;
    }

    /**
     * Return if device is connected
     */
    this.isConnected = function () {
        return true;
    }

    // bindAddDaq / addDaq / getValue come from the shared installer: thirteen to fifteen drivers
    // had these bodies verbatim, and a method that must be re-pasted is a method that will be
    // missing from the next driver (see device-utils.installCommonDriverApi).
    deviceUtils.installCommonDriverApi(this, {
        getVarsValue: function () { return varsValue; },
        getLastTimestamp: function () { return lastTimestampValue; }
    });

    /**
     * Return the timestamp of last read tag operation on polling
     * @returns
     */
    this.lastReadTimestamp = () => {
        return lastTimestampValue;
        console.error('Not supported! (gpio.lastReadTimestamp)');
    }

    /**
     * Return the Daq settings of Tag
     * @returns
     */
    this.getTagDaqSettings = (tagId) => {
        return data.tags[tagId] ? data.tags[tagId].daq : null;
    }

    /**
     * Set Daq settings of Tag
     * @returns
     */
    this.setTagDaqSettings = (tagId, settings) => {
        if (data.tags[tagId]) {
            utils.mergeObjectsValues(data.tags[tagId].daq, settings);
        }
    }

    /**
     * Update the Tags values read
     * @param {*} vars
     */
    var _updateVarsValue = async (vars) => {
        const timestamp = new Date().getTime();
        var changed = {};
        vars.forEach((val) => {
            if (!utils.isNullOrUndefined(val)) {
                var valueChanged = !varsValue[val.id] ||varsValue[val.id].value !== val.value;
                varsValue[val.id] = {
                    id: val.id,
                    value: val.value,
                    daq: tagMap[val.id].daq,
                    changed: valueChanged,
                    timestamp: timestamp
                };
                if (this.addDaq && deviceUtils.tagDaqToSave(varsValue[val.id], timestamp)) {
                    changed[val.id] = varsValue[val.id];
                }
                varsValue[val.id].changed = false;
            }
        })
        _emitValues(varsValue);
        if (this.addDaq && !utils.isEmptyObject(changed)) {
            this.addDaq(changed, data.name, data.id);
        }
        return changed;
    }

    /**
     * Clear the Tags values by setting to null
     * Emit to clients
     */
    var _clearVarsValue = function () {
        for (var id in varsValue) {
            varsValue[id].value = null;
        }
        for (var id in tagMap) {
            tagMap[id].value = null;
        }
        _emitValues(varsValue);
    }

    /**
     * Emit the PLC Tags values array { id: <name>, value: <value>, type: <type> }
     * @param {*} values
     */
    var _emitValues = function (values) {
        // Shared emitter: closes the superseded-binding hole this driver used to publish through.
        deviceUtils.emitValues(data, runtime, bindingCache, values, {
            after: function () { lastTimestampValue = new Date().getTime(); },
            logger: logger, source: 'gpio'
        });
    }

    /**
     * Emit the PLC connection status
     * @param {*} status
     */
    var _emitStatus = function (status) {
        // The event and the assignment it must precede live in the shared emitter, so every
        // driver reports status the same way.
        deviceUtils.emitStatus(data, status, { onEmit: function (s) { lastStatus = s; } }, runtime);
        };
}

module.exports = {
    init: function (settings) {
        
    },
    create: function (data, logger, events, manager, runtime) {
        if (!loadGpioLib(manager)) return null;
        return new GpioClient(data, logger, events, runtime);
    }
}

function loadGpioLib(manager) {
    if (!Gpio) {
        let gpioModule = null;
        try { gpioModule = require('onoff'); } catch { }
        if (!gpioModule && manager) { try { gpioModule = manager.require('onoff'); } catch { } }
        Gpio = gpioModule ? gpioModule.Gpio : null;
    }
    return !!Gpio;
}
