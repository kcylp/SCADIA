/**
 * 'cameras/gb28181/sip-transport': UDP transport for the GB28181 SIP server.
 *
 * Deliberately thin: it owns one dgram socket, decodes what arrives and emits
 * `message` events. Transaction matching (call-id/CSeq), retransmission and
 * timeouts live in the service, where the SIP semantics belong.
 */

'use strict';

const dgram = require('dgram');
const EventEmitter = require('events');

const MAX_DATAGRAM = 65535;

function create(logger) {
    const events = new EventEmitter();
    let socket = null;
    let bound = null;

    function isOpen() { return !!socket; }

    function listen(port, host) {
        if (socket) { return Promise.resolve(bound); }
        return new Promise((resolve, reject) => {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            sock.on('error', (err) => {
                if (logger) { logger.error('gb28181 sip transport error: ' + err.message); }
                if (!bound) { reject(err); return; }
                events.emit('error', err);
            });
            sock.on('message', (buf, rinfo) => {
                // GB28181 signalling is text (XML/SDP); latin1 keeps bytes intact
                // for messages that were not declared as UTF-8.
                events.emit('message', buf.toString('utf8'), rinfo, buf);
            });
            sock.bind(port || 0, host || '0.0.0.0', () => {
                try {
                    sock.setRecvBufferSize(1024 * 1024);
                    const a = sock.address();
                    bound = { port: a.port, address: a.address };
                    if (logger) { logger.info(`gb28181 sip transport listening udp://${a.address}:${a.port}`); }
                    resolve(bound);
                } catch (err) {
                    reject(err);
                }
            });
            socket = sock;
        });
    }

    function send(text, port, host) {
        if (!socket) { return Promise.reject(new Error('sip transport is not listening')); }
        const buf = Buffer.from(text, 'utf8');
        if (buf.length > MAX_DATAGRAM) {
            return Promise.reject(new Error('SIP message too large: ' + buf.length));
        }
        return new Promise((resolve, reject) => {
            socket.send(buf, 0, buf.length, port, host, (err) => err ? reject(err) : resolve(buf.length));
        });
    }

    function close() {
        return new Promise((resolve) => {
            if (!socket) { resolve(); return; }
            const sock = socket;
            socket = null;
            bound = null;
            try { sock.close(() => resolve()); } catch (e) { resolve(); }
        });
    }

    return {
        on: events.on.bind(events),
        off: events.off.bind(events),
        listen: listen,
        send: send,
        close: close,
        isOpen: isOpen,
        address: () => bound
    };
}

module.exports = { create: create };
