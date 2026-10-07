/**
 * 'cameras/ai': AI video analytics (检测结果接入 → 叠加框 → 报警联动).
 *
 * Module facade — mirrors cameras/index.js. Owns the two ingest transports and
 * hands them to the service as a single lifecycle object, so policy
 * (normalise → filter → store → alarm) stays in one place.
 */

'use strict';

const service = require('./ai-service');
const normalize = require('./normalize');
const mqttIngest = require('./mqtt-ingest');
const wsIngest = require('./ws-ingest');

var mqtt = null;
var ws = null;

function ingests() {
    return {
        start: async function (onPayload) {
            const out = { mqtt: false, wsPort: 0 };
            mqtt = mqttIngest.create(_settings, _logger);
            out.mqtt = await mqtt.start(onPayload);
            ws = wsIngest.create(_settings, _logger);
            const w = await ws.start(onPayload);
            out.wsPort = (w && w.port) || 0;
            return out;
        },
        stop: async function () {
            if (ws) { await ws.stop().catch(() => {}); ws = null; }
            if (mqtt) { await mqtt.stop().catch(() => {}); mqtt = null; }
            return true;
        }
    };
}

var _settings = null;
var _logger = null;

function init(settings, log, runtime, storage) {
    _settings = settings;
    _logger = log;
    return service.init(settings, log, runtime, storage, ingests());
}

function stop() {
    const i = { stop: async function () {
        if (ws) { await ws.stop().catch(() => {}); ws = null; }
        if (mqtt) { await mqtt.stop().catch(() => {}); mqtt = null; }
        return true;
    } };
    return service.stop(i);
}

module.exports = {
    init: init,
    stop: stop,
    service: service,
    normalize: normalize,
    mqttIngest: mqttIngest,
    wsIngest: wsIngest
};
