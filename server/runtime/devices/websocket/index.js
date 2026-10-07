/**
 * 'websocket': device driver for endpoints that PUSH tag values over a
 * WebSocket, the subscription-style counterpart of the MQTT driver.
 *
 * Why a second subscription driver: a lot of the equipment we have to integrate
 * (robot fleets, 矿鸿 devices, third-party gateways) exposes a plain WebSocket
 * and will not run a broker. Putting them on a broker just to reuse the MQTT
 * driver would add a moving part in the field.
 *
 * Contract (same as every other driver, see device.js):
 *   connect, disconnect, isConnected, polling, load, getValue, getValues,
 *   setValue, getStatus, getTagProperty, bindAddDaq, bindGetProperty,
 *   lastReadTimestamp, getTagDaqSettings, setTagDaqSettings, browse
 *
 * Incoming payloads are matched to tags by the tag `address`, which is a key
 * path in the message. Three shapes are accepted, because gateways disagree:
 *
 *   1. flat map        {"pit.level": 1.2, "pit.run": true}
 *   2. addressed item  {"topic":"pit.level","value":1.2}   (also key/address/tag)
 *   3. a batch         [ {...}, {...} ]  of either shape above
 *
 * A tag of type 'json' with `options.subs` + `memaddress` reads one field out of
 * the (stringified) value, exactly like the MQTT driver, so the same project
 * export keeps working.
 */

'use strict';

const WebSocket = require('ws');
const utils = require('../../utils');
const deviceUtils = require('../device-utils');

const RECONNECT_MS = 5000;

/** Keys a gateway may use to name the addressed tag. */
const ADDRESS_KEYS = ['topic', 'address', 'key', 'tag', 'path', 'name'];
/** Keys a gateway may use to carry the value. */
const VALUE_KEYS = ['value', 'val', 'data'];

/**
 * @param {*} _data Device data { id, name, tags, property, ... }
 * @param {*} _logger
 * @param {*} _events
 * @param {*} _runtime
 */
function WebsocketClient(_data, _logger, _events, _runtime) {
    var data = _data;                   // Current device data
    // Per-driver binding snapshot for the superseded-binding guard (contract 09 section 4.3)
    var bindingCache = { revision: null };
    var logger = _logger;
    var events = _events;
    var runtime = _runtime;

    var working = false;                // guard: never overlap connect/polling
    var overloading = 0;
    var lastStatus = '';                // last connection status
    var varsValue = {};                 // last emitted values { id, value, type }
    var lastTimestampValue;             // timestamp of the last read
    var getProperty = null;
    var devicesMap = {};                // address -> [tag]
    var socket = null;
    var reconnectTimer = null;
    var stopped = false;                // set by disconnect() to stop reconnecting
    var pendingFrames = [];             // frames received while nobody was listening
    var seenAddresses = {};             // every address ever seen, for browse()

    /**
     * Index tags by their address so an incoming key can find its tag(s).
     * Several tags may legitimately share one address (different `subs` fields).
     */
    var _mapTagsAddress = function (tags) {
        var map = {};
        (tags || []).forEach(function (tag) {
            if (!tag || !tag.address) { return; }
            if (!map[tag.address]) { map[tag.address] = []; }
            map[tag.address].push(tag);
        });
        devicesMap = map;
    };

    var _emitStatus = function (status) {
        // The event and the assignment it must precede live in the shared emitter, so every
        // driver reports status the same way.
        deviceUtils.emitStatus(data, status, { onEmit: function (s) { lastStatus = s; } }, runtime);
        };

    var _emitValues = function (values) {
        // The superseded-binding guard lives in the shared emitter (contract 09 section 4.3):
        // fifteen drivers had copied it, three had not, and a guard that must be re-pasted is a
        // guard that will be missing from the next driver.
        deviceUtils.emitValues(data, runtime, bindingCache, values, {
        id: data.name,
            logger: logger, source: 'websocket'
        });
    };

    /**
     * Apply one {address, value} pair to every tag registered on that address.
     * @returns {Array} the tags that were touched (for compose + DAQ)
     */
    var _applyValue = function (address, rawValue) {
        var tags = devicesMap[address];
        if (!tags || !tags.length) { return []; }

        // Keep the native JSON type: a WebSocket frame is not a byte payload like
        // an MQTT message, so stringifying would turn boolean true into 'true'
        // for no reason. Only structured values are serialised.
        var text;
        if (rawValue === null || rawValue === undefined) { text = null; }
        else if (typeof rawValue === 'object') { text = JSON.stringify(rawValue); }
        else { text = rawValue; }

        var touched = [];
        for (var i = 0; i < tags.length; i++) {
            var tag = data.tags[tags[i].id];
            if (!tag) { continue; }
            var oldValue = tag.rawValue;
            var next = text;

            // 'json' tags read a single field out of the payload; on a missing
            // field the previous value is kept rather than nulled, so one
            // incomplete frame does not blank a live tag.
            if (tag.type === 'json' && tag.options && tag.options.subs && tag.memaddress) {
                try {
                    var obj = (rawValue !== null && typeof rawValue === 'object')
                        ? rawValue
                        : JSON.parse(typeof text === 'string' ? text : String(text));
                    if (!utils.isNullOrUndefined(obj[tag.memaddress])) {
                        next = (typeof obj[tag.memaddress] === 'object')
                            ? JSON.stringify(obj[tag.memaddress]) : obj[tag.memaddress];
                    } else {
                        next = oldValue;
                    }
                } catch (err) {
                    logger.warn(`'${data.name}' tag '${tag.id}' is configured as json but the payload is not: ${err.message}`);
                    next = oldValue;
                }
            }

            tag.rawValue = next;
            tag.timestamp = new Date().getTime();
            tag.changed = oldValue !== next;
            touched.push(tag);
        }
        return touched;
    };

    /**
     * Decode one frame into a list of {address, value}.
     * Exported for tests: this is where every gateway dialect is absorbed.
     * @returns {{items: Array<{address, value}>, discovered: Array<string>}}
     */
    function decodeFrame(text) {
        var items = [];
        var discovered = [];
        // Addressed items are unambiguous intent, so they win over flat scalars
        // anywhere in the tree: an envelope like
        // {"ts":..., "payload":{"topic":"a","value":7}} must route to 'a',
        // not to a bogus 'ts' tag.
        var addressed = [];
        var addressedDiscovered = [];

        var collectAddressed = function (node) {
            if (node === null || node === undefined) { return; }
            if (Array.isArray(node)) { node.forEach(collectAddressed); return; }
            if (typeof node !== 'object') { return; }

            var address = null;
            for (var i = 0; i < ADDRESS_KEYS.length && address === null; i++) {
                if (typeof node[ADDRESS_KEYS[i]] === 'string') { address = node[ADDRESS_KEYS[i]]; }
            }
            if (address !== null) {
                for (var j = 0; j < VALUE_KEYS.length; j++) {
                    if (node[VALUE_KEYS[j]] !== undefined) {
                        addressed.push({ address: address, value: node[VALUE_KEYS[j]] });
                        addressedDiscovered.push(address);
                        return;
                    }
                }
            }
            for (var c in node) { collectAddressed(node[c]); }
        };

        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            // A bare scalar frame has no address and cannot be routed.
            return { items: [], discovered: [] };
        }

        collectAddressed(parsed);
        if (addressed.length) {
            return { items: addressed, discovered: addressedDiscovered };
        }

        // No addressed item anywhere: fall back to reading the top level as a
        // flat map of address -> value.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (var k in parsed) {
                if (ADDRESS_KEYS.indexOf(k) >= 0 || VALUE_KEYS.indexOf(k) >= 0) { continue; }
                var v = parsed[k];
                if (v !== null && typeof v === 'object' && !Array.isArray(v)) { continue; }
                items.push({ address: k, value: v });
                discovered.push(k);
            }
        }
        return { items: items, discovered: discovered };
    }

    /**
     * Compose one tag's rawValue into the value the UI sees, and remember it.
     * Composition must happen exactly once per value: tagValueCompose applies
     * deadband against the previous value, so composing twice would report two
     * different results for the same reading.
     */
    var _composeTag = async function (tag) {
        var previous = varsValue[tag.id] ? varsValue[tag.id].value : null;
        tag.value = await deviceUtils.tagValueCompose(tag.rawValue, previous, tag, runtime);
        varsValue[tag.id] = tag;
        return tag.value;
    };

    /** Handle one incoming frame: route values, compose, then emit. */
    var _onFrame = function (raw) {
        var text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        var decoded;
        try {
            decoded = decodeFrame(text);
        } catch (err) {
            logger.warn(`'${data.name}' cannot decode frame: ${err.message}`);
            return;
        }
        if (!decoded.items.length) {
            logger.warn(`'${data.name}' received an unroutable frame (no address found)`);
            return;
        }

        // Remember every address the endpoint sends: browse() answers from this
        // record, so discovery does not depend on catching a live frame while
        // the operator happens to have the dialog open.
        for (var s = 0; s < decoded.discovered.length; s++) {
            seenAddresses[decoded.discovered[s]] = true;
        }

        var matched = [];
        for (var i = 0; i < decoded.items.length; i++) {
            var hit = _applyValue(decoded.items[i].address, decoded.items[i].value);
            for (var j = 0; j < hit.length; j++) {
                if (matched.indexOf(hit[j]) < 0) { matched.push(hit[j]); }
            }
        }

        if (!matched.length) {
            // Nothing we know yet: keep the frame so browse() can report the
            // addresses without making the operator wait for a second frame.
            pendingFrames.push(decoded);
            if (pendingFrames.length > 20) { pendingFrames.shift(); }
            return;
        }

        // Compose before emitting: emitting first would push the previous value
        // and the UI would show a reading one frame behind.
        Promise.all(matched.map(_composeTag)).then(function () {
            lastTimestampValue = new Date().getTime();
            _emitValues(varsValue);
        }).catch(function (err) {
            logger.error(`'${data.name}' value compose failed: ${err.message}`);
        });
    };

    /** Send the subscribe frame the endpoint expects, if any is configured. */
    var _sendSubscribe = function () {
        if (!socket || socket.readyState !== WebSocket.OPEN) { return; }
        var property = data.property || {};
        var addresses = Object.keys(devicesMap);
        if (property.subscribe === false || property.subscribe === 'false') { return; }
        try {
            if (property.subscribeFrame) {
                // honour a configured template, e.g. {"type":"sub","params":["{{tags}}"]}
                var frame = String(property.subscribeFrame).replace('{{tags}}', addresses.join(','));
                socket.send(frame);
            } else if (addresses.length) {
                socket.send(JSON.stringify({ type: 'subscribe', tags: addresses }));
            }
        } catch (err) {
            logger.warn(`'${data.name}' subscribe frame failed: ${err.message}`);
        }
    };

    var _scheduleReconnect = function () {
        if (stopped || reconnectTimer) { return; }
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            if (stopped) { return; }
            // connect() is idempotent, so a concurrent manual connect is safe
            _open().catch(function (err) {
                logger.error(`'${data.name}' reconnect failed: ${err.message}`);
            });
        }, RECONNECT_MS);
        if (reconnectTimer.unref) { reconnectTimer.unref(); }
    };

    /** Open the socket once (no retry loop of its own; reconnect is scheduled). */
    var _open = function () {
        return new Promise(function (resolve, reject) {
            if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
                resolve();
                return;
            }
            var property = data.property || {};
            if (!property.address) {
                reject(new Error('missing websocket address'));
                return;
            }
            var options = { handshakeTimeout: Number(property.timeout) || 10000 };
            if (property.username) { options.username = property.username; }
            if (property.password || property.pwd) { options.password = property.password || property.pwd; }
            if (property.headers) {
                try {
                    options.headers = (typeof property.headers === 'string')
                        ? JSON.parse(property.headers) : property.headers;
                } catch (err) {
                    logger.warn(`'${data.name}' headers property is not valid JSON, ignoring it`);
                }
            }
            // wss with a self-signed certificate is the norm on a plant LAN; the
            // operator opts in explicitly rather than us silently accepting any.
            if (property.selfSignedCertificate) { options.rejectUnauthorized = false; }

            try {
                socket = new WebSocket(property.address, property.protocol ? [property.protocol] : [], options);
            } catch (err) {
                reject(err);
                return;
            }

            socket.on('open', function () {
                logger.info(`'${data.name}' connected ${property.address}`, true);
                _emitStatus('connect-ok');
                _sendSubscribe();
                resolve();
            });
            socket.on('message', _onFrame);
            socket.on('error', function (err) {
                logger.error(`'${data.name}' websocket error: ${err.message}`);
                _emitStatus('connect-error');
                reject(err);
            });
            socket.on('close', function () {
                _emitStatus('connect-off');
                if (!stopped) { _scheduleReconnect(); }
            });
        });
    };

    // --------------------------------------------------------------- lifecycle

    /**
     * Connect to the endpoint.
     */
    this.connect = function () {
        return new Promise(function (resolve, reject) {
            if (_checkWorking(true)) {
                stopped = false;
                _open().then(function () {
                    _checkWorking(false);
                    resolve();
                }).catch(function (err) {
                    _checkWorking(false);
                    _emitStatus('connect-error');
                    if (!stopped) { _scheduleReconnect(); }
                    reject(err);
                });
            } else {
                resolve();
            }
        });
    };

    /**
     * Close the socket and stop trying to reconnect.
     */
    this.disconnect = function () {
        return new Promise(function (resolve) {
            stopped = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            if (!socket) {
                _emitStatus('connect-off');
                resolve(true);
                return;
            }
            var closing = socket;
            socket = null;
            try {
                closing.removeAllListeners('close');
                closing.close();
            } catch (err) {
                logger.warn(`'${data.name}' close failed: ${err.message}`);
            }
            _emitStatus('connect-off');
            resolve(true);
        });
    };

    /**
     * Settle DAQ: values are composed as frames arrive (see _onFrame), so this
     * only decides which of the changed values are due to be written to history.
     * Keeping DAQ here preserves the deadband/interval semantics of the other
     * drivers without composing values a second time.
     */
    this.polling = async function () {
        if (_checkWorking(true)) {
            try {
                var timestamp = new Date().getTime();
                var changed = {};
                for (var id in data.tags) {
                    var tag = data.tags[id];
                    if (utils.isNullOrUndefined(tag.rawValue)) { continue; }
                    if (!varsValue[id]) { continue; }   // never composed yet
                    if (this.addDaq && deviceUtils.tagDaqToSave(tag, timestamp)) {
                        changed[id] = tag;
                    }
                }
                lastTimestampValue = new Date().getTime();
                if (this.addDaq && !utils.isEmptyObject(changed)) {
                    this.addDaq(changed, data.name, data.id);
                }
            } catch (err) {
                logger.error(`'${data.name}' polling error: ${err}`);
            }
            _checkWorking(false);
        }
    };

    /**
     * Discover the addresses the endpoint actually sends.
     *
     * A pushing endpoint has no catalogue to browse, so the honest answer is
     * "watch the live stream and report what came in": we connect, collect the
     * addresses seen during a short window, and return them.
     */
    this.browse = function (path, callback) {
        return new Promise(function (resolve, reject) {
            var timeoutMs = Number((data.property && data.property.timeout) || 0) || 3000;
            var collected = {};
            var settled = false;

            // Seed from what the stream has already sent, so opening the dialog
            // on an already-connected device lists its tags immediately.
            Object.keys(seenAddresses).forEach(function (a) {
                collected[a] = true;
                if (callback) { callback({ topic: a, msg: '' }); }
            });
            var finish = function () {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                if (socket) { socket.removeListener('message', collector); }
                resolve(Object.keys(collected).map(function (a) { return { id: a, name: a }; }));
            };

            var collector = function (raw) {
                var text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
                try {
                    var decoded = decodeFrame(text);
                    decoded.discovered.forEach(function (a) {
                        if (!collected[a]) {
                            collected[a] = true;
                            if (callback) { callback({ topic: a, msg: '' }); }
                        }
                    });
                } catch (err) { /* a malformed frame must not end the browse */ }
            };

            var timer = setTimeout(finish, timeoutMs);

            _open().then(function () {
                if (!socket) { finish(); return; }
                socket.on('message', collector);
                // If frames were already buffered (device was up before the
                // browse), report those immediately instead of waiting.
                if (pendingFrames.length) {
                    pendingFrames.forEach(function (d) {
                        d.discovered.forEach(function (a) {
                            if (!collected[a]) {
                                collected[a] = true;
                                if (callback) { callback({ topic: a, msg: '' }); }
                            }
                        });
                    });
                }
            }).catch(function (err) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    };

    this.isConnected = function () {
        return !!socket && socket.readyState === WebSocket.OPEN;
    };

    // bindAddDaq / addDaq / getValue come from the shared installer: thirteen to fifteen drivers
    // had these bodies verbatim, and a method that must be re-pasted is a method that will be
    // missing from the next driver (see device-utils.installCommonDriverApi).
    deviceUtils.installCommonDriverApi(this, {
        getVarsValue: function () { return varsValue; },
        getLastTimestamp: function () { return lastTimestampValue; }
    });

    this.lastReadTimestamp = function () {
        return lastTimestampValue;
    };

    this.bindGetProperty = function (fnc) {
        getProperty = fnc;
    };

    /**
     * Load tags and index them by address (called on start and on change).
     */
    this.load = function (_data) {
        // A new binding: re-arm the guard so its first emit is judged against THIS binding.
        deviceUtils.resetBindingCache(bindingCache);
        varsValue = {};
        pendingFrames = [];
        seenAddresses = {};
        data = utils.clone(_data);
        data.tags = data.tags || {};
        try {
            _mapTagsAddress(Object.values(data.tags));
            var count = Object.keys(data.tags).length;
            for (var id in data.tags) {
                data.tags[id].timestamp = data.tags[id].timestamp || null;
                data.tags[id].changed = false;
                if (utils.isNullOrUndefined(data.tags[id].rawValue)) {
                    data.tags[id].rawValue = null;
                }
            }
            logger.info(`'${data.name}' data loaded (${count})`, true);
        } catch (err) {
            logger.error(`'${data.name}' load error! ${err}`);
        }
    };

    this.getValues = function () {
        return data.tags;
    };

    /**
     * Write a tag: send it to the endpoint as {address, value}.
     * Optimistic local update so the UI reflects the command immediately; the
     * pushed value from the device will overwrite it on the next frame.
     */
    this.setValue = async function (tagId, value) {
        var tag = data.tags[tagId];
        if (!tag) { return false; }
        if (!this.isConnected()) { return false; }

        var payload = await deviceUtils.tagRawCalculator(value, tag, runtime);
        try {
            if (tag.type === 'json') {
                var obj = {};
                obj[tag.memaddress || 'value'] = payload;
                socket.send(JSON.stringify(obj));
            } else if (tag.options && tag.options.writeFrame) {
                socket.send(String(tag.options.writeFrame).replace('{{value}}', payload));
            } else {
                socket.send(JSON.stringify({ address: tag.address, value: payload }));
            }
        } catch (err) {
            logger.error(`'${data.name}' setValue(${tagId}) failed: ${err.message}`);
            return false;
        }
        tag.value = payload;
        tag.changed = true;
        varsValue[tagId] = tag;
        return true;
    };

    this.getStatus = function () {
        return lastStatus;
    };

    this.getTagProperty = function (address) {
        if (data.tags[address]) {
            return {
                id: address,
                name: data.tags[address].name,
                type: data.tags[address].type,
                format: data.tags[address].format
            };
        }
        return null;
    };

    this.getTagDaqSettings = function (tagId) {
        return data.tags[tagId] ? data.tags[tagId].daq : null;
    };

    this.setTagDaqSettings = function (tagId, settings) {
        if (data.tags[tagId]) {
            utils.mergeObjectsValues(data.tags[tagId].daq, settings);
        }
    };

    /**
     * Manage async connection/polling so they never overlap.
     */
    var _checkWorking = function (check) {
        if (check && working) {
            overloading++;
            logger.warn(`'${data.name}' working (connection || polling) overload! ${overloading}`);
            if (overloading >= 3) {
                try { if (socket) { socket.close(); } } catch (e) { /* ignore */ }
            } else {
                return false;
            }
        }
        working = check;
        overloading = 0;
        return true;
    };

    // exposed for tests
    this._decodeFrame = decodeFrame;
    this._onFrame = _onFrame;
}

module.exports = {
    init: function () {
    },
    create: function (data, logger, events, runtime) {
        return new WebsocketClient(data, logger, events, runtime);
    }
};
