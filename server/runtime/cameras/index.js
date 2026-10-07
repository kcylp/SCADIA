/**
 * 'cameras/index': module facade for the camera/video integration.
 */

'use strict';

const storage = require('./camera-storage');
const service = require('./camera-service');
const presets = require('./vendor-presets');
const media = require('./media-gateway');
const fusion = require('./fusion');
const gb28181 = require('./gb28181');
const ai = require('./ai');

function init(_settings, _log, _runtime) {
    return storage.init(_settings, _log).then(() => {
        fusion.init(_runtime);
        const ms = (_settings && _settings.calibration && _settings.calibration.cameraStatusPollMs) ||
            fusion.DEFAULT_POLL_MS;
        fusion.start(ms);
    }).then(() => {
        // GB28181 needs the camera store (it persists devices/channels there) and
        // is opt-in: a closed 5060 must not break the rest of the runtime.
        return gb28181.init(_settings, _log, _runtime, storage).catch(err => {
            _log.error('runtime.failed-to-init gb28181: ' + (err.message || err));
            return { enabled: false, error: err.message };
        });
    }).then(() => {
        // AI analytics: also opt-in (an unreachable MQTT broker or a busy ingest
        // port must not take the camera module down with it).
        return ai.init(_settings, _log, _runtime, storage).catch(err => {
            _log.error('runtime.failed-to-init ai: ' + (err.message || err));
            return { enabled: false, error: err.message };
        });
    }).then(() => {
        _log.info('runtime init cameras successful!', true);
    });
}

function stop() {
    fusion.stop();
    return ai.stop()
        .catch(() => {})
        .then(() => gb28181.stop())
        .catch(() => {})
        .then(() => storage.close());
}

module.exports = {
    init: init,
    stop: stop,
    storage: storage,
    service: service,
    presets: presets,
    media: media,
    fusion: fusion,
    gb28181: gb28181,
    ai: ai
};
