/**
 * 'calibration/index': module facade and lifecycle
 *
 * init(settings, logger, runtime) -> creates storage + service, runs restore.
 * Exposed on runtime as calibrationStorage / calibrationService.
 */

'use strict';

const storage = require('./calibration-storage');
const serviceFactory = require('./calibration-service');

var service = null;

function init(_settings, _log, _runtime) {
    return storage.init(_settings, _log, _runtime).then(() => {
        service = serviceFactory.create(_runtime);
        return service.restore();
    });
}

function stop() {
    if (service) {
        try { service.stop(); } catch (e) { /* ignore */ }
        service = null;
    }
    return storage.close();
}

module.exports = {
    init: init,
    stop: stop,
    get service() { return service; },
    storage: storage
};
