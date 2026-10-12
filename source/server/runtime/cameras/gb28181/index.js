/**
 * 'cameras/gb28181': GB/T 28181 (国标) device access.
 *
 * Module facade — mirrors cameras/index.js. The SIP codec is pure and unit
 * tested; the service owns registration state, catalog persistence, control and
 * streaming.
 */

'use strict';

const service = require('./gb28181-service');
const sipMessage = require('./sip-message');
const manscdp = require('./manscdp');
const sipTransport = require('./sip-transport');
const charset = require('./charset');

function init(settings, log, runtime, storage) {
    return service.init(settings, log, runtime, storage);
}

function stop() {
    return service.stop();
}

module.exports = {
    init: init,
    stop: stop,
    service: service,
    sipMessage: sipMessage,
    manscdp: manscdp,
    sipTransport: sipTransport,
    charset: charset
};
