/**
 * 'SCADIAServer': SCADIA as device to use with the scripts
 */
 'use strict';

const utils = require('../../utils');
const deviceUtils = require('../device-utils');

function ScadiaServer(_data, _logger, _events, _runtime) {

    // The overload branch calls a method on the instance from inside a bare-called helper,
    // where 'use strict' makes `this` undefined. Captured here so that call can reach it.
    var self = this;

    // RUNTIME IS NOW PASSED IN, because this driver needs it and never had it. _emitValues below
    // hands it to the shared emitter, and the name resolved to nothing: under 'use strict' that is a
    // ReferenceError, so EVERY value emission from the internal SCADIA-server device threw.
    //
    // It went unnoticed because device.js called ScadiaServer.create with four arguments while every
    // other driver got five - so the parameter was not merely unwired, it was never there to fill.
    // Ported from the source tree (batch 31/34) into the delivery tree 2026-10-09.
    var runtime = _runtime;
    var data = JSON.parse(JSON.stringify(_data)); // Current Device data { id, name, tags, enabled, ... }
    // Per-driver binding snapshot for the superseded-binding guard (contract 09 section 4.3)
    var bindingCache = { revision: null };
    var logger = _logger;
    var working = false;                // Working flag to manage overloading polling and connection
    var events = _events;               // Events to commit change to runtime
    var varsValue = {};                 // Tags to send to frontend { id, type, value }
    var lastTimestampValue;             // Last Timestamp of values
    var tagsMap = {};                   // Map of tag id
    var overloading = 0;                // Overloading counter to mange the break connection
    var tocheck = false;                // Flag that define if there are tags to check by polling
    var connectionTags = [];            // Tags of connection status of devices
    var type;

    /**
     * initialize the server device type
     */
    this.init = function (_type) {
        type = _type;
    }

    /**
     * Connected with itself
     */
    this.connect = function () {
        return new Promise(async function (resolve, reject) {
            resolve();
        });
    }


    /**
     * Disconnect with itself
     * Clear all Tags values
     */
    this.disconnect = function () {
        return new Promise(function (resolve, reject) {
            _clearVarsValue();
            resolve(true);
        });
    }

    /**
     * Read values in polling mode
     * Update the tags values list, save in DAQ if value changed or in interval and emit values to clients
     */
    this.polling = async function () {
        if (_checkWorking(true)) {
            try {
                if (tocheck) {
                    var varsValueChanged = await _checkVarsChanged();
                    lastTimestampValue = new Date().getTime();
                    _emitValues(varsValue);
                    if (this.addDaq && !utils.isEmptyObject(varsValueChanged)) {
                        this.addDaq(varsValueChanged, data.name, data.id);
                    }
                }
                _checkConnectionStatus();
            } catch (err) {
                logger.error(`'${data.name}' polling error: ${err}`);
            }
            _checkWorking(false);
        }
    }

    /**
     * Load Tags attribute to read with polling
     */
    this.load = function (_data) {
        // A new binding: re-arm the guard so its first emit is judged against THIS binding.
        deviceUtils.resetBindingCache(bindingCache);
        varsValue = [];
        data = JSON.parse(JSON.stringify(_data));
        data.tags = data.tags || {};
        tagsMap = {};
        var count = Object.keys(data.tags).length;
        connectionTags = [];
        for (var id in data.tags) {
            tagsMap[id] = data.tags[id];
            const dataTag = data.tags[id];
            const shouldRestore = dataTag.daq && dataTag.daq.restored;
            
            if (shouldRestore) {
                data.tags[id].value = null; 
            } else if (dataTag.init !== undefined && dataTag.init !== null && dataTag.init !== '') {
                data.tags[id].value = deviceUtils.parseValue(dataTag.init, dataTag.type);
            } else {
                if (dataTag.type === 'boolean') {
                    data.tags[id].value = false; 
                } else if (dataTag.type === 'number') {
                    data.tags[id].value = 0; 
                } else if (dataTag.type === 'string') {
                    data.tags[id].value = ''; 
                } else {
                    data.tags[id].value = null; 
                }
            }
            if (dataTag.sysType === TagSystemTypeEnum.deviceConnectionStatus) {
                data.tags[id].timestamp = Date.now();
                connectionTags.push(data.tags[id]);
            }
            varsValue[id] = data.tags[id];
        }
        tocheck = !utils.isEmptyObject(data.tags);
        logger.info(`'${data.name}' data loaded (${count})`, true);
    }

    /**
     * Return Tags values array { id: <tagId>, value: <value> }
     */
    this.getValues = function () {
        return data.tags;
    }

    /**
     * Return Tag value { id: <tagId>, value: <value>, ts: <lastTimestampValue> }
     */
    this.getValue = function (id) {
        if (varsValue[id]) {
            return { id: id, value: varsValue[id].value, ts: lastTimestampValue };
        }
        return null;
    }

    /**
     * Return connection status SCADIA server is always connected, 'connect-ok'
     */
    this.getStatus = function () {
        return 'connect-ok';
    }

    /**
     * Return Tag property to show in frontend
     */
    this.getTagProperty = function (id) {
        if (data.tags[id]) {
            return { id: id, name: data.tags[id].name, type: data.tags[id].type, format: data.tags[id].format };
        } else {
            return null;
        }
    }

    /**
     * Set the Tag value to device
     */
    this.setValue = function (id, value) {
        if (varsValue[id]) {
            var val = _parseValue(value, varsValue[id].type);
            varsValue[id].value = val;
            varsValue[id].changed = true;
            logger.info(`'${data.name}' setValue(${id}, ${value})`, true, true);
            return true;
        }
        return false;
    }

    /**
     * Set the connection status to tag of device sttus
     * @param {*} deviceId
     * @param {*} status
     */
    this.setConnectionStatus = function(deviceId, status) {
        var tag = connectionTags.find(tag => tag.memaddress === deviceId);
        if (tag) {
            tag.value = status;
            tag.timestamp = Date.now();
        }
    }

    /**
     * Return connected with itself
     */
    this.isConnected = function () {
        return true;
    }

    /**
     * Bind the DAQ store function
     */
    this.bindAddDaq = function (fnc) {
        this.addDaq = fnc;                         // Add the DAQ value to db history
    }
    this.addDaq = null;

    /**
     * Return the timestamp of last read tag operation on polling
     * @returns
     */
     this.lastReadTimestamp = () => {
        return lastTimestampValue;
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
     * Cheack and parse the value return converted value
     * @param {*} value as string
     */
    var _parseValue = function (value, type) {
        if (type === 'number') {
            return parseFloat(value);
        } else if (type === 'boolean') {
            // Handle null, undefined, empty string cases
            if (value === null || value === undefined || value === '') {
                return false; // Default to false for safety
            }
            if (typeof value === 'string') {
                // Properly handle boolean string values
                const lowerValue = value.toLowerCase().trim();
                return lowerValue === 'true' || lowerValue === '1';
            }
            return Boolean(value);
        } else if (type === 'string') {
            return value;
        } else {
            let val = parseFloat(value);
            if (Number.isNaN(val)) {
                // maybe boolean
                val = Number(value);
                // maybe string
                if (Number.isNaN(val)) {
                    val = value;
                }
            } else {
                val = parseFloat(val.toFixed(5));
            }
            return val;
        }
    }

    /**
     * Clear Tags value
     */
    var _clearVarsValue = function () {
        for (var id in varsValue) {
            varsValue[id].value = null;
        }
        _emitValues(varsValue);
    }

    /**
     * Return the Tags that have value changed and clear value changed flag of all Tags
     */
    var _checkVarsChanged = async () => {
        const timestamp = new Date().getTime();
        var result = {};
        for (var id in data.tags) {
            if (!utils.isNullOrUndefined(data.tags[id].value)) {
                data.tags[id].value = await deviceUtils.tagValueCompose(data.tags[id].value, varsValue[id] ? varsValue[id].value : null, data.tags[id]);
                data.tags[id].timestamp = timestamp;
                if (this.addDaq && deviceUtils.tagDaqToSave(data.tags[id], timestamp)) {
                    result[id] = data.tags[id];
                }
            }
            data.tags[id].changed = false;
            varsValue[id] = data.tags[id];
        }
        return result;
    }
    /**
     * Emit the Tags values array { id: <name>, value: <value>, type: <type> }
     * @param {*} values
     */
    var _emitValues = function (values) {
        // Do not publish a read that belongs to a binding that has already been replaced
        // (contract 09 section 4.3). bindingCache is per driver instance and re-arms after
        // a rebind, so this never mutes a driver that is legitimately working.
        if (!deviceUtils.shouldEmitForBinding(data, runtime, bindingCache)) {
            logger.warn('scadiaserver: dropped a value read from a superseded binding');
            return;
        }
        events.emit('device-value:changed', { id: data.name, values: values });
    }

    /**
     * Used to manage the async connection and polling automation (that not overloading)
     * @param {*} check
     */
    var _checkWorking = function (check) {
        if (check && working) {
            overloading++;
            logger.warn(`'${data.name}' working (connection || polling) overload! ${overloading}`);
            // !The driver don't give the break connection
            if (overloading >= 3) {
                // This branch has been wrong twice, in the two ways a bare call can be wrong:
                // `disconnect()` has no such binding (ReferenceError exactly when the connection must
                // be broken), and `this.disconnect()` is also wrong because this helper is called bare
                // and 'use strict' leaves `this` undefined (TypeError, straight out of polling()).
                self.disconnect();
            } else {
                return false;
            }
        }
        working = check;
        overloading = 0;
        return true;
    }

    var _checkConnectionStatus = function () {
        var dt = Date.now() - 60000;
        connectionTags.forEach(tag => {
            if (tag.value && tag.timestamp < dt) {
                tag.value = 0;
            }
        });
    }

}

module.exports = {
    init: function (settings) {
    },
    create: function (data, logger, events, manager, runtime) {
        return new ScadiaServer(data, logger, events, runtime);
    }
}

var TagSystemTypeEnum  = {
    deviceConnectionStatus: 1,
}
