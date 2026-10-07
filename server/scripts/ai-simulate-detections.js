#!/usr/bin/env node
/**
 * 'scripts/ai-simulate-detections': push fake AI detections so the overlay can be
 * verified without an engine on the bench.
 *
 * Purpose is commissioning: prove the ingest path (WebSocket or HTTP), the box
 * normalisation and the on-screen overlay before Frigate/PaddleDetection is
 * wired in. It emits a slowly moving box plus a second target, which makes a
 * mis-scaled or mirrored region immediately obvious.
 *
 *   node scripts/ai-simulate-detections.js --camera cam_ab12cd34ef56 \
 *        --transport ws --port 1890 --duration 30000
 *   node scripts/ai-simulate-detections.js --camera cam_ab12cd34ef56 \
 *        --transport http --host 127.0.0.1:1881 --label person
 *
 * `--camera` may be our camera id, our camera name, or the engine's own name
 * (the server resolves it the same way a real engine payload is resolved).
 */

'use strict';

const http = require('http');
const WebSocket = require('ws');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); }
            else { out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; }
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const camera = args.camera;
if (!camera) {
    process.stderr.write('usage: node scripts/ai-simulate-detections.js --camera <id|name> [--transport ws|http] [--duration ms]\n');
    process.exit(2);
}
const transport = (args.transport || 'ws').toLowerCase();
const intervalMs = Number(args.interval || 400);
const durationMs = Number(args.duration || 20000);
const label = args.label || 'person';
const host = args.host || '127.0.0.1';
const wsPort = Number(args.port || 1890);
const httpPort = Number(args.httpPort || 1881);

function log(event, data) {
    process.stdout.write(JSON.stringify(Object.assign({ ts: new Date().toISOString(), event: event }, data || {})) + '\n');
}

/** A box that sweeps left-to-right and drifts down, so scaling errors show up. */
function payload(tick) {
    const phase = (tick % 100) / 100;
    const main = { x: 0.08 + phase * 0.55, y: 0.18 + phase * 0.3, w: 0.16, h: 0.42 };
    const detections = [{ label: label, score: 0.92, region: main, normalized: true }];
    if (phase > 0.4) {
        detections.push({
            label: 'car', score: 0.71,
            region: { x: 0.6 - phase * 0.2, y: 0.7, w: 0.22, h: 0.16 }, normalized: true
        });
    }
    return { camera: camera, detections: detections };
}

function postHttp(body) {
    return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: host, port: httpPort, path: '/api/ai/events', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        }, res => {
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', err => resolve({ status: 0, error: err.message }));
        req.write(data);
        req.end();
    });
}

async function main() {
    let socket = null;
    let tick = 0;

    if (transport === 'ws') {
        socket = new WebSocket(`ws://${host}:${wsPort}`);
        await new Promise((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        log('ws.connected', { url: `ws://${host}:${wsPort}` });
        socket.on('message', (data) => {
            try { log('ws.ack', JSON.parse(String(data))); } catch (e) { log('ws.ack', { raw: String(data) }); }
        });
    } else if (transport !== 'http') {
        process.stderr.write(`unknown transport: ${transport}\n`);
        process.exit(2);
    }

    const timer = setInterval(async () => {
        tick++;
        const body = payload(tick);
        if (socket) { socket.send(JSON.stringify(body)); return; }
        const r = await postHttp(body);
        if (tick === 1) { log('http.post', r); }
        else if (r.status >= 400) { log('http.error', r); }
    }, intervalMs);

    setTimeout(() => {
        clearInterval(timer);
        log('simulator.stopping', { ticks: tick, transport: transport });
        if (socket) { try { socket.close(); } catch (e) { /* ignore */ } }
        process.exit(0);
    }, durationMs);
}

main().catch(err => {
    process.stderr.write('ai-simulate-detections failed: ' + (err.message || err) + '\n');
    process.exit(1);
});
