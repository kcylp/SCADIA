/**
 * 'cameras/ai/mqtt-ingest': subscribe to a detection engine's MQTT topic.
 *
 * Frigate (and engines that mimic it) publish detections to MQTT, which is the
 * lowest-friction integration for a camera NVR: no inbound port, no polling.
 * This is a small, purpose-built subscriber — the SCADIA device layer's MQTT
 * client is built around tag polling/publishing and carries a lot of state that
 * has nothing to do with event ingest.
 */

'use strict';

const mqtt = require('mqtt');

function create(settings, logger) {
    let client = null;
    let connected = false;

    function cfg() {
        return (settings && settings.ai && settings.ai.mqtt) || {};
    }

    function isEnabled() { return cfg().enabled === true && !!cfg().url; }

    function start(onPayload) {
        if (!isEnabled()) { return Promise.resolve(false); }
        const c = cfg();
        const options = {
            connectTimeout: Number(c.connectTimeout) || 10000,
            reconnectPeriod: Number(c.reconnectPeriod) || 5000,
            clean: true
        };
        if (c.clientId) { options.clientId = c.clientId; }
        if (c.username) { options.username = c.username; }
        if (c.password) { options.password = c.password; }

        try {
            client = mqtt.connect(c.url, options);
        } catch (err) {
            if (logger) { logger.error('ai mqtt: connect failed: ' + err.message); }
            return Promise.resolve(false);
        }

        const topic = c.topic || 'frigate/events';

        client.on('connect', () => {
            connected = true;
            if (logger) { logger.info(`ai mqtt: connected ${c.url}`); }
            client.subscribe(topic, { qos: Number(c.qos) || 0 }, (err) => {
                if (err && logger) { logger.error('ai mqtt: subscribe failed: ' + err.message); }
                else if (logger) { logger.info(`ai mqtt: subscribed ${topic}`); }
            });
        });
        client.on('message', (t, msg) => {
            let payload;
            try {
                payload = JSON.parse(msg.toString('utf8'));
            } catch (err) {
                if (logger) { logger.warn(`ai mqtt: ignoring non-JSON message on ${t}`); }
                return;
            }
            onPayload(payload, 'mqtt').catch(err => {
                if (logger) { logger.warn(`ai mqtt: ingest rejected (${err.code || err.message})`); }
            });
        });
        client.on('reconnect', () => { if (logger) { logger.warn('ai mqtt: reconnecting ...'); } });
        client.on('close', () => { connected = false; });
        client.on('error', (err) => { if (logger) { logger.error('ai mqtt: ' + err.message); } });

        return Promise.resolve(true);
    }

    function stop() {
        return new Promise((resolve) => {
            if (!client) { resolve(); return; }
            const c = client;
            client = null;
            connected = false;
            try { c.end(true, () => resolve()); } catch (err) { resolve(); }
        });
    }

    return { isEnabled: isEnabled, start: start, stop: stop, isConnected: () => connected };
}

module.exports = { create: create };
