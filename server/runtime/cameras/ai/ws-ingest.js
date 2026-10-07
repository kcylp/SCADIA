/**
 * 'cameras/ai/ws-ingest': WebSocket endpoint for pushing detection results.
 *
 * Detection engines and bridges that cannot reach an MQTT broker (or that prefer
 * a direct socket) POST one JSON payload per message. The service never trusts
 * the socket: payloads go through the same normalisation/filtering as MQTT, and
 * a malformed frame is answered with an error object instead of killing the
 * connection.
 *
 * Protocol (one JSON object per text frame):
 *   -> {"camera":"1#皮带机","label":"person","score":0.91,"region":{"x":..},"normalized":true}
 *   <- {"ok":true,"camera":"cam_x","kept":1}
 *   <- {"ok":false,"error":"AI_BAD_PAYLOAD","message":"..."}
 */

'use strict';

const WebSocket = require('ws');

const MAX_FRAME = 1024 * 1024;

function create(settings, logger) {
    let server = null;
    let boundPort = 0;

    function isEnabled() {
        const c = (settings && settings.ai && settings.ai.ws) || {};
        return c.enabled === true && Number(c.port) >= 0 && c.port !== undefined && c.port !== null;
    }

    /**
     * @param {(payload:object, source:string)=>Promise<object>} onPayload
     * @returns {Promise<{port:number}>}
     */
    function start(onPayload) {
        if (!isEnabled()) { return Promise.resolve({ port: 0 }); }
        const c = settings.ai.ws;
        // port 0 = let the OS choose (tests / side-by-side instances)
        const port = Number(c.port) === 0 ? 0 : Number(c.port);
        const host = c.host || '0.0.0.0';
        server = new WebSocket.Server({ port: port, host: host, maxPayload: MAX_FRAME });

        server.on('connection', (socket, req) => {
            const peer = (req && req.socket && req.socket.remoteAddress) || 'unknown';
            if (logger) { logger.info(`ai ws: client connected ${peer}`); }
            socket.on('message', (data) => {
                let payload;
                try {
                    payload = JSON.parse(String(data));
                } catch (err) {
                    try { socket.send(JSON.stringify({ ok: false, error: 'AI_BAD_PAYLOAD', message: 'frame is not JSON' })); } catch (e) { /* client gone */ }
                    return;
                }
                Promise.resolve()
                    .then(() => onPayload(payload, 'ws'))
                    .then(res => { try { socket.send(JSON.stringify({ ok: true, camera: res.camera, kept: res.kept })); } catch (e) { /* client gone */ } })
                    .catch(err => { try { socket.send(JSON.stringify({ ok: false, error: err.code || 'AI_ERROR', message: err.message })); } catch (e) { /* client gone */ } });
            });
            socket.on('error', (err) => { if (logger) { logger.warn('ai ws: socket error: ' + err.message); } });
            socket.on('close', () => { if (logger) { logger.info(`ai ws: client disconnected ${peer}`); } });
        });
        server.on('error', (err) => { if (logger) { logger.error('ai ws: server error: ' + err.message); } });

        return new Promise((resolve, reject) => {
            server.once('listening', () => {
                boundPort = server.address().port;
                if (logger) { logger.info(`ai ws: listening ws://${host}:${boundPort}`); }
                resolve({ port: boundPort });
            });
            server.once('error', reject);
        });
    }

    function stop() {
        return new Promise((resolve) => {
            if (!server) { resolve(); return; }
            const s = server;
            server = null;
            try { s.close(() => resolve()); } catch (err) { resolve(); }
        });
    }

    return { isEnabled: isEnabled, start: start, stop: stop, port: () => boundPort };
}

module.exports = { create: create };
