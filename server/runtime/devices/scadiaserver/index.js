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
    // Found by ESLint's no-undef (batch 31) and traced through device.js in batch 34.
    var runtime = _runtime;
    var data = utils.clone(_data); // Current Device data { id, name, tags, enabled, ... }
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
        // Clear IN PLACE - do NOT reassign.
        //
        // deviceUtils.installCommonDriverApi(this, { varsValue }) (this file, below) captures this
        // object BY REFERENCE at construction time. Reassigning the variable here therefore leaves
        // the installed getValue() reading the dead map from before the first load: it answers null
        // for every tag, for the life of the device. device.js:305 delegates its own getValue() to
        // comm.getValue(), and runtime/devices/index.js getTagValue()/getDeviceAlarmValue() go
        // through that, so this one line silently blinded alarms, scripts, calibration and camera
        // fusion to every internal SCADIA-Server tag. Measured: GET /api/getTagValue returned
        // value:null for all six internal tags while the driver's own getValues() had them loaded.
        for (var _vkey in varsValue) { delete varsValue[_vkey]; }
        data = utils.clone(_data);
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
            var val = deviceUtils.parseValue(value, varsValue[id].type);
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

    // bindAddDaq / addDaq / getValue come from the shared installer: thirteen to fifteen drivers
    // had these bodies verbatim, and a method that must be re-pasted is a method that will be
    // missing from the next driver (see device-utils.installCommonDriverApi).
    deviceUtils.installCommonDriverApi(this, {
        varsValue: varsValue,
        getLastTimestamp: function () { return lastTimestampValue; }
    });

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
        // The superseded-binding guard lives in the shared emitter (contract 09 section 4.3):
        // fifteen drivers had copied it, three had not, and a guard that must be re-pasted is a
        // guard that will be missing from the next driver.
        deviceUtils.emitValues(data, runtime, bindingCache, values, {
        id: data.name,
            logger: logger, source: 'scadiaserver'
        });
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
                // This branch has now been wrong twice, in the two ways a bare call can be wrong.
                // First `disconnect()` - no such binding, so a ReferenceError exactly when it was
                // needed: three-deep in overlapping work, the one moment the connection must be
                // broken. Then the repair, `this.disconnect()`, which is also wrong here: _checkWorking
                // is a local called bare, and under this file's 'use strict' `this` is undefined inside
                // it, so the branch threw a TypeError instead - with no try/catch, straight out of
                // polling(). It never broke the connection either.
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
