/**
 * 'http': webapi wrapper to manage REST API request
 */
'use strict';
const axios = require('axios');
const utils = require('../../utils');
const deviceUtils = require('../device-utils');
const builder = require('./request-builder');

function HTTPclient(_data, _logger, _events, _runtime) {
    var runtime = _runtime;
    var data = _data;                   // Current webapi data
    // Per-driver binding snapshot for the superseded-binding guard (contract 09 section 4.3)
    var bindingCache = { revision: null };
    var logger = _logger;               // Logger var working = false;                // Working flag to manage overloading polling and connection
    var working = false;                // Working flag to manage overloading polling and connection
    var connected = false;              // Connected flag
    var events = _events;               // Events to commit change to runtime
    var lastStatus = '';                // Last webapi status
    var varsValue = [];                 // Signale to send to frontend { id, type, value }
    var requestItemsMap = {};           // Map of request (JSON, CSV, XML, ...) {key: item path, value: tag}
    var overloading = 0;                // Overloading counter to mange the break connection
    var lastTimestampRequest;           // Last Timestamp request
    var lastTimestampValue;             // Last Timestamp of asked values
    var newItemsCount;                  // Count of new items, between load and received

    var apiProperty = { getTags: null, postTags: null, format: 'JSON', ownFlag: true };
    var lastEtag = null;                // ETag of the last read (conditional GET)
    var lastChangeTs = null;            // timestamp of the last value change ('since' param)

    /**
     * Connect the client by make a request
     */
    this.connect = function () {
        return new Promise(function (resolve, reject) {
            if (_checkConnection()) {
                try {
                    if (_checkWorking(true)) {
                        logger.info(`'${data.name}' try to connect ${apiProperty.getTags}`, true);
                        _clearVarsValue();
                        _emitStatus('connect-ok');
                        resolve();
                        connected = true;
                        lastTimestampRequest = new Date().getTime();
                        _checkWorking(false);
                    } else {
                        reject();
                    }
                } catch (err) {
                    logger.error(`'${data.name}' try to connect error! ${err}`);
                    _checkWorking(false);
                    connected = false;
                    _emitStatus('connect-error');
                    _clearVarsValue();
                    reject();
                }
            } else {
                logger.error(`'${data.name}' missing connection data!`);
                connected = false;
                _emitStatus('connect-failed');
                _clearVarsValue();
                reject();
            }
        });
    }

    /**
     * Disconnect the client
     * Emit connection status to clients, clear all Tags values
     */
    this.disconnect = function () {
        return new Promise(function (resolve, reject) {
            _checkWorking(false);
            logger.info(`'${data.name}' disconnected!`, true);
            connected = false;
            _emitStatus('connect-off');
            _clearVarsValue();
            resolve();
        });
    }

    /**
     * Read values in polling mode
     * Update the tags values list, save in DAQ if value changed or in interval and emit values to clients
     */
    this.polling = async function () {
        if (_checkWorking(true)) {
            // check connection status
            let dt = new Date().getTime();
            if ((lastTimestampRequest + (data.polling * 3)) < dt) {
                _emitStatus('connect-error');
                _checkWorking(false);
            }
            try {
                const result = await _readRequest();
                if (result && result.notModified) {
                    // Nothing changed: the request itself proves the endpoint is
                    // alive, so recover the connection status but emit nothing.
                    if (lastStatus !== 'connect-ok') {
                        _emitStatus('connect-ok');
                    }
                    _checkWorking(false);
                    return;
                }
                if (result) {
                    let varsValueChanged = await _updateVarsValue(result);
                    lastTimestampValue = new Date().getTime();
                    lastChangeTs = lastTimestampValue;
                    _emitValues(varsValue);
                    if (this.addDaq && !utils.isEmptyObject(varsValueChanged)) {
                        this.addDaq(varsValueChanged, data.name, data.id);
                    }
                    if (lastStatus !== 'connect-ok') {
                        _emitStatus('connect-ok');
                    }
                }
                _checkWorking(false);
            } catch (reason){
                logger.error(`'${data.name}' _readRequest error! ${reason}`);
                _checkWorking(false);
            };
        } else {
            _emitStatus('connect-busy');
        }
    }

    /**
     * Return if http request is working
     * is disconnected if the last request result is older as 3 polling interval
     */
    this.isConnected = function () {
        return connected;
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
    }

    /**
     * Load Tags to read by polling
     */
    this.load = function (_data) {
        // A new binding: re-arm the guard so its first emit is judged against THIS binding.
        deviceUtils.resetBindingCache(bindingCache);
        varsValue = [];
        data = utils.clone(_data);
        try {
            requestItemsMap = {};
            var count = Object.keys(data.tags).length;
            for (var id in data.tags) {
                const address = data.tags[id].address || data.tags[id].id;
                if (!requestItemsMap[address]) {
                    requestItemsMap[address] = [data.tags[id]];
                } else {
                    requestItemsMap[address].push(data.tags[id]);
                }
            }
            logger.info(`'${data.name}' data loaded (${count})`, true);
        } catch (err) {
            logger.error(`'${data.name}' load error! ${err}`);
        }
    }


    /**
     * Return Tags values array { id: <name>, value: <value>, type: <type> }
     */
    this.getValues = function () {
        return varsValue;
    }

    /**
     * Set one Tag value.
     *
     * This awaits the write: the previous fire-and-forget version returned true
     * before the endpoint answered, so a rejected write looked like a success
     * to the caller (and to the UI).
     */
    this.setValue = async function (tagId, value) {
        const result = await this.setValues([{ id: tagId, value: value }]);
        return result.ok;
    }

    /**
     * Write several tags in ONE request.
     *
     * @param {Array<{id, value}>} entries
     * @returns {Promise<{ok:boolean, written:number, failed:Array<{id, error}>}>}
     */
    this.setValues = async function (entries) {
        const list = (entries || []).filter(e => e && e.id !== undefined && data.tags[e.id]);
        const failed = [];
        for (const e of (entries || [])) {
            if (!e || e.id === undefined || !data.tags[e.id]) {
                failed.push({ id: e && e.id, error: 'unknown tag' });
            }
        }
        if (!list.length) {
            return { ok: false, written: 0, failed: failed };
        }

        // raw (scaled) value per tag, same conversion a single write used
        const prepared = [];
        for (const e of list) {
            const tag = data.tags[e.id];
            const parsed = deviceUtils.parseValue(e.value, tag.type);
            const raw = await deviceUtils.tagRawCalculator(parsed, tag, runtime);
            prepared.push({ id: e.id, value: raw, name: tag.name });
        }

        const req = builder.buildWriteRequest(data.property, prepared);
        if (!req) {
            logger.error(`'${data.name}' setValues not supported (no write URL/own mode)`);
            return { ok: false, written: 0, failed: prepared.map(e => ({ id: e.id, error: 'write not supported' })) };
        }

        try {
            const built = builder.requestConfig(data.property);
            const config = Object.assign({}, built.config, { headers: Object.assign({}, built.config.headers, { 'Content-Type': req.contentType }) });
            const res = await axios.request({
                method: req.method,
                url: req.url,
                data: req.body,
                ...config
            });
            lastTimestampRequest = new Date().getTime();
            // A 2xx is the only answer that counts as written; the endpoint may
            // still reject individual entries in its body, which is reported
            // back to the caller rather than silently ignored.
            if (res.status >= 200 && res.status < 300) {
                for (const e of prepared) {
                    const tag = data.tags[e.id];
                    tag.value = e.value;
                    varsValue[e.id] = tag;
                }
                logger.info(`'${data.name}' wrote ${prepared.length} tag(s)`, true, true);
                return { ok: true, written: prepared.length, failed: failed };
            }
            return { ok: false, written: 0, failed: prepared.map(e => ({ id: e.id, error: 'HTTP ' + res.status })) };
        } catch (err) {
            const status = err && err.response ? err.response.status : null;
            logger.error(`'${data.name}' setValues error! ${status || err.message || err}`);
            return {
                ok: false,
                written: 0,
                failed: prepared.map(e => ({ id: e.id, error: status ? 'HTTP ' + status : (err.message || String(err)) }))
            };
        }
    }

    /**
     * Write one tag, without the batch machinery (single-value endpoint shape).
     * Kept for callers that pass a plain scalar to a dedicated URL.
     */
    this.postValue = async function (tagId, value) {
        if (!data.tags[tagId] || !apiProperty.postTags) {
            logger.error(`'${data.name}' postValue not supported`, true);
            return false;
        }
        try {
            const built = builder.requestConfig(data.property);
            const res = await axios.post(apiProperty.postTags, { id: tagId, value: value }, built.config);
            lastTimestampRequest = new Date().getTime();
            return res.status >= 200 && res.status < 300;
        } catch (err) {
            logger.error(`'${data.name}' postValue error! ${err.message || err}`);
            return false;
        }
    }

    /**
     * Return connection status 'connect-off', 'connect-ok', 'connect-error'
     */
    this.getStatus = function () {
        return lastStatus;
    }

    /**
     * Return Tag property
     */
    this.getTagProperty = function (id) {
        if (data.tags[id]) {
            return { id: id, name: data.tags[id].name, type: data.tags[id].type, format: data.tags[id].format };
        } else {
            return null;
        }
    }

    /**
     * Return Tags property
     */
    this.getTagsProperty = function () {
        return new Promise(function (resolve, reject) {
            try {
                resolve({ tags: Object.values(requestItemsMap), newTagsCount: newItemsCount });
            } catch (err) {
                reject(err);
            }
        });
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

    var _checkConnection = function () {
        if (data.property.address) {
            apiProperty.getTags = data.property.address;
            apiProperty.ownFlag = false;
        } else {
            apiProperty.getTags = data.property.getTags;
            apiProperty.postTags = data.property.postTags;
        }
        return apiProperty.getTags || apiProperty.postTags;
    }

    var _readRequest = function () {
        return new Promise(function (resolve, reject) {
            if (!apiProperty.getTags) {
                reject(new Error('no read URL configured'));
                return;
            }
            var built = builder.buildReadConfig(data.property, { etag: lastEtag, since: lastChangeTs });
            if (built.headersError) {
                logger.warn(`'${data.name}' ${built.headersError}, ignoring headers`);
            }
            axios.get(apiProperty.getTags, built.config).then(res => {
                lastTimestampRequest = new Date().getTime();
                // A held long poll that resolves with nothing new is a success:
                // the caller must not treat it as a value update.
                if (builder.isNotModified(res.status, res.data, res.headers)) {
                    resolve({ notModified: true });
                    return;
                }
                lastEtag = builder.etagOf(res.headers) || lastEtag;
                resolve(res.data);
            }).catch(err => {
                // some servers answer 304 as a rejection instead of resolving it
                if (err && err.response && err.response.status === 304) {
                    lastTimestampRequest = new Date().getTime();
                    resolve({ notModified: true });
                    return;
                }
                reject(err);
            });
        });
    }

    /**
     * Clear the Tags values by setting to null
     * Emit to clients
     */
    var _clearVarsValue = function () {
        for (var id in varsValue) {
            varsValue[id].value = null;
        }
        _emitValues(varsValue);
    }

    /**
     * Update the Tags values read
     * For WebAPI NotOwn: first convert the request data to a flat struct
     * @param {*} reqdata
     */
    var _updateVarsValue = async (reqdata) => {
        const timestamp = new Date().getTime();
        var changed = {};
        if (apiProperty.ownFlag) {
            var newItems = 0;
            for (var i = 0; i < reqdata.length; i++) {
                const id = reqdata[i].id;
                if (id) {
                    if (!data.tags[id]) {
                        newItems++;
                    } else {
                        reqdata[i].daq = data.tags[id].daq;
                    }
                    requestItemsMap[id] = [reqdata[i]];
                    reqdata[i].changed = varsValue[id] && reqdata[i].value !== varsValue[id].value;
                    if (!utils.isNullOrUndefined(reqdata[i].value)) {
                        reqdata[i].value = await deviceUtils.tagValueCompose(reqdata[i].value, varsValue[id] ? varsValue[id].value : null, data.tags[id], runtime);
                        reqdata[i].timestamp = timestamp;
                        if (this.addDaq && deviceUtils.tagDaqToSave(reqdata[i], timestamp)) {
                            changed[id] = reqdata[i];
                        }
                    }
                    reqdata[i].changed = false;
                    varsValue[id] = reqdata[i];
                }
            }
            newItemsCount = newItems;
            return changed;
        } else {
            var someval = false;
            var result = {};
            var items = dataToFlat(reqdata, apiProperty);
            for (var key in items) {
                if (requestItemsMap[key]) {
                    for (var index in requestItemsMap[key]) {
                        var tag = requestItemsMap[key][index];
                        if (tag) {
                            someval = true;
                            result[tag.id] = {
                                id: tag.id,
                                value: (tag.memaddress) ? items[tag.memaddress] : items[key],
                                type: items[key]?.type,
                                daq: tag.daq,
                                tagref: tag
                            };
                        }
                    }
                }
            }
            if (someval) {
                for (var id in result) {
                    result[id].changed = varsValue[id] && result[id].value !== varsValue[id].value;
                    if (!utils.isNullOrUndefined(result[id].value)) {
                        result[id].value = await deviceUtils.tagValueCompose(result[id].value, varsValue[id] ? varsValue[id].value : null, result[id].tagref, runtime);
                        result[id].timestamp = timestamp;
                        if (this.addDaq && deviceUtils.tagDaqToSave(result[id], timestamp)) {
                            changed[id] = result[id];
                        }
                    }
                    result[id].changed = false;
                    varsValue[id] = result[id];
                }
                return changed;
            }
        }
        return null;
    }

    /**
     * Emit the webapi connection status
     * @param {*} status
     */
    var _emitStatus = function (status) {
        // The event and the assignment it must precede live in the shared emitter, so every
        // driver reports status the same way.
        deviceUtils.emitStatus(data, status, { onEmit: function (s) { lastStatus = s; } }, runtime);
        };

    /**
     * Emit the webapi Tags values array { id: <name>, value: <value>, type: <type> }
     * @param {*} values
     */
    var _emitValues = function (values) {
        // The superseded-binding guard lives in the shared emitter (contract 09 section 4.3):
        // fifteen drivers had copied it, three had not, and a guard that must be re-pasted is a
        // guard that will be missing from the next driver.
        deviceUtils.emitValues(data, runtime, bindingCache, values, {
            logger: logger, source: 'httprequest'
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
                connected = false;
                // disconnect();
            } else {
                return false;
            }
        }
        working = check;
        overloading = 0;
        return true;
    }

    // The value parser this driver used to keep here took its arguments the other way round
    // from every other copy ((type, value) instead of (value, type)) and answered a boolean
    // with Boolean(value), so writing the STRING 'false' to a boolean tag wrote TRUE. It is
    // now the shared parser, called with the shared argument order (batch 60).
}

function dataToFlat(data, property) {

    var parseTree = function(nodes, id, parent) {
        let result = {};
        let nodeId = id;
        if (parent) {
            nodeId = parent + ':' + nodeId;
        }
        if (Array.isArray(nodes)) {
            let idx = 0;
            for(var key in nodes) {
                let tres = parseTree(nodes[key], '[' + idx++ + ']', nodeId);
                Object.keys(tres).forEach( key => {
                    result[key] = tres[key];
                });
            }
        } else if (nodes && typeof nodes === 'object') {
            for(var key in nodes) {
                let tres = parseTree(nodes[key], key, nodeId);
                Object.keys(tres).forEach( key => {
                    result[key] = tres[key];
                });
            }
        } else {
            result[nodeId] = nodes;
        }
        return result;
    }

    if (property.format === 'CSV') {

    } else if (property.format === 'JSON') {
        return parseTree(data);
    }
    return data;
}

/**
 * Return the result of http request
 */
function getRequestResult(property) {
    return new Promise(function (resolve, reject) {
        try {
            if (property.method === 'GET') {
                axios.get(property.address).then(res => {
                    resolve(res.data);
                }).catch(err => {
                    reject(err);
                });
            } else {
                reject('getrequestresult-error: method is missing!');
            }
        } catch (err) {
            reject('getrequestresult-error: ' + err);
        }
    });
}

module.exports = {
    init: function (settings) {
        // deviceCloseTimeout = settings.deviceCloseTimeout || 15000;
    },
    create: function (data, logger, events, runtime) {
        return new HTTPclient(data, logger, events, runtime);
    },
    getRequestResult: getRequestResult
}