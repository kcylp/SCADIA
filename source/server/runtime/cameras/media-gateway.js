/**
 * 'cameras/media-gateway': bridges camera RTSP to browser-playable streams via
 * ZLMediaKit (WHEP/WebRTC low-latency, HLS compatible, HTTP-FLV fallback).
 *
 * Browsers cannot play RTSP. We ask ZLMediaKit to pull the camera RTSP as a
 * stream proxy and hand the browser the play URLs. Everything degrades
 * gracefully to the server-side snapshot proxy when no media server is set.
 */

'use strict';

const axios = require('axios');
const presets = require('./vendor-presets');

const DEFAULT_TIMEOUT = 5000;

function cfg(settings) {
    return (settings && settings.mediaServer) || {};
}

function isConfigured(settings) {
    const c = cfg(settings);
    return !!(c.enabled && c.apiUrl);
}

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function streamIdFor(camera) {
    return String(camera.id).replace(/[^a-zA-Z0-9_]/g, '_');
}

function appName(settings) {
    return cfg(settings).app || 'camera';
}

/** Browser-facing base URL (may differ from the server-side apiUrl). */
function publicBase(settings) {
    const c = cfg(settings);
    let host = c.publicHost;
    if (!host && c.apiUrl) {
        try { host = new URL(c.apiUrl).hostname; } catch (e) { host = ''; }
    }
    const port = c.httpPort || 8080;
    return `http://${host}:${port}`;
}

async function apiGet(settings, path, params) {
    const c = cfg(settings);
    const base = String(c.apiUrl).replace(/\/+$/, '');
    const url = base + path;
    const query = Object.assign({}, params);
    if (c.secret) { query.secret = c.secret; }
    try {
        const res = await axios.get(url, { params: query, timeout: DEFAULT_TIMEOUT });
        return res.data;
    } catch (err) {
        fail('MEDIA_UNREACHABLE', 'media server unreachable: ' + (err.message || err));
    }
}

async function health(settings) {
    if (!isConfigured(settings)) { return { configured: false, ok: false }; }
    try {
        const data = await apiGet(settings, '/index/api/getMediaList', { app: appName(settings) });
        return { configured: true, ok: data && data.code === 0, count: (data && data.data || []).length };
    } catch (err) {
        return { configured: true, ok: false, error: err.code || err.message };
    }
}

/** Ask ZLMediaKit to pull the camera RTSP. Idempotent for an existing stream. */
async function ensureProxy(settings, camera) {
    const stream = streamIdFor(camera);
    const app = appName(settings);
    const ep = presets.resolveEndpoints(camera);
    if (!ep.rtsp) { fail('CAM_NO_RTSP', 'camera has no RTSP url'); }

    const data = await apiGet(settings, '/index/api/addStreamProxy', {
        vhost: '__defaultVhost__',
        app: app,
        stream: stream,
        url: ep.rtsp,
        enable_hls: 1,
        enable_hls_fmp4: 0,
        enable_mp4: 0,
        enable_rtsp: 1,
        enable_rtmp: 1,
        enable_ts: 1,
        enable_fmp4: 1,
        rtp_type: 0 // 0=tcp, 1=udp
    });

    // code 0 = created; other codes may mean "already exists" -> verify
    if (!data || data.code !== 0) {
        const list = await apiGet(settings, '/index/api/getMediaList', { app: app, stream: stream });
        const exists = list && list.code === 0 && (list.data || []).length > 0;
        if (!exists) {
            fail('MEDIA_STREAM_FAILED', (data && data.msg) || 'media server rejected the stream');
        }
    }
    return stream;
}

async function removeProxy(settings, camera) {
    const stream = streamIdFor(camera);
    const app = appName(settings);
    // ZLMediaKit key format is vhost/app/stream (verified against the HTTP-API docs)
    const vhost = '__defaultVhost__';
    try {
        await apiGet(settings, '/index/api/delStreamProxy', { key: `${vhost}/${app}/${stream}` });
    } catch (err) {
        // best effort: close the stream instead
        try { await apiGet(settings, '/index/api/close_streams', { vhost: vhost, app: app, stream: stream, force: 1 }); } catch (e) { /* ignore */ }
    }
    return true;
}

/**
 * WebRTC (WHEP) signalling, SERVER-SIDE.
 * ZLMediaKit requires the api `secret`; sending it to the browser would leak it
 * and would also hit CORS. So the browser posts its SDP offer to OUR api and we
 * relay it to ZLMediaKit /index/api/whep (standard WHEP, Content-Type: application/sdp).
 * @returns {Promise<{status:number, sdp:string, location:string|null}>}
 */
async function whep(settings, camera, sdpOffer) {
    if (!isConfigured(settings)) {
        fail('MEDIA_NOT_CONFIGURED', 'no media server configured (settings.mediaServer)');
    }
    if (!sdpOffer || typeof sdpOffer !== 'string') {
        fail('CAM_VALIDATION_ERROR', 'SDP offer is required');
    }
    const stream = await ensureProxy(settings, camera);
    const app = appName(settings);
    const c = cfg(settings);
    const base = String(c.apiUrl).replace(/\/+$/, '');
    const query = { app: app, stream: stream };
    if (c.secret) { query.secret = c.secret; }
    try {
        const res = await axios.post(base + '/index/api/whep', sdpOffer, {
            params: query,
            headers: { 'Content-Type': 'application/sdp' },
            timeout: 10000,
            transformRequest: [(d) => d],
            validateStatus: () => true
        });
        if (res.status >= 400) {
            fail('MEDIA_STREAM_FAILED', 'WHEP negotiation failed (' + res.status + ')');
        }
        return {
            status: res.status,
            sdp: typeof res.data === 'string' ? res.data : String(res.data || ''),
            location: (res.headers && res.headers['location']) || null
        };
    } catch (err) {
        if (err.code) { throw err; }
        fail('MEDIA_UNREACHABLE', 'media server unreachable: ' + (err.message || err));
    }
}

/** Resolve play URLs for a camera (starts the proxy on demand). */
async function playback(settings, camera) {
    if (!isConfigured(settings)) {
        fail('MEDIA_NOT_CONFIGURED', 'no media server configured (settings.mediaServer)');
    }
    const stream = await ensureProxy(settings, camera);
    const app = appName(settings);
    const base = publicBase(settings);
    return {
        media: 'zlmediakit',
        app: app,
        stream: stream,
        // WHEP signalling goes through OUR api so the media `secret` never
        // reaches the browser (and CORS is avoided).
        whep: `${'/api/cameras/'}${camera.id}/whep`,
        hls: `${base}/${app}/${stream}/hls.m3u8`,
        flv: `${base}/${app}/${stream}.live.flv`,
        rtsp: `${base}/${app}/${stream}`
    };
}

/**
 * GB28181 streams do not arrive by RTSP pull: the device pushes RTP/PS to a port
 * we own. openRtpServer tells ZLMediaKit to listen on such a port; the PS stream
 * then shows up as app/stream in the media server.
 *
 * ZLMediaKit tcp_mode: 0 = TCP passive, 1 = UDP, 2 = TCP active.
 */
function tcpModeFor(transport) {
    const t = String(transport || 'UDP').toUpperCase();
    if (t === 'TCP-PASSIVE') { return 0; }
    if (t === 'TCP-ACTIVE') { return 2; }
    return 1; // UDP
}

async function openRtpServer(settings, opts) {
    if (!isConfigured(settings)) {
        fail('MEDIA_NOT_CONFIGURED', 'no media server configured (settings.mediaServer)');
    }
    const o = opts || {};
    if (!o.streamId) { fail('CAM_VALIDATION_ERROR', 'streamId is required'); }
    const stream = streamIdFor({ id: o.streamId });
    const c = cfg(settings);
    const data = await apiGet(settings, '/index/api/openRtpServer', {
        port: Number(o.port) || Number(c.rtpPort) || 0,
        tcp_mode: tcpModeFor(o.transport),
        stream_id: stream
    });
    if (!data || data.code !== 0 || !data.port) {
        fail('MEDIA_STREAM_FAILED', (data && data.msg) || 'media server refused to open an RTP port');
    }
    return { port: data.port, stream: stream, app: 'rtp', tcpMode: tcpModeFor(o.transport) };
}

async function closeRtpServer(settings, streamId) {
    if (!isConfigured(settings) || !streamId) { return false; }
    try {
        await apiGet(settings, '/index/api/closeRtpServer', { stream_id: streamIdFor({ id: streamId }) });
        return true;
    } catch (err) {
        return false; // best effort: the port is released when the stream idles out
    }
}

/** Browser play URLs for a GB28181 (RTP/PS) stream already in the media server. */
function rtpPlayback(settings, stream, ssrc, rtpPort) {
    const base = publicBase(settings);
    const s = streamIdFor({ id: stream });
    return {
        media: 'zlmediakit',
        protocol: 'gb28181',
        app: 'rtp',
        stream: s,
        ssrc: ssrc || null,
        rtpPort: rtpPort || null,
        hls: `${base}/rtp/${s}/hls.m3u8`,
        flv: `${base}/rtp/${s}.live.flv`,
        rtsp: `${base}/rtp/${s}`
    };
}

module.exports = {
    isConfigured: isConfigured,
    health: health,
    ensureProxy: ensureProxy,
    removeProxy: removeProxy,
    playback: playback,
    openRtpServer: openRtpServer,
    closeRtpServer: closeRtpServer,
    rtpPlayback: rtpPlayback,
    tcpModeFor: tcpModeFor,
    whep: whep,
    streamIdFor: streamIdFor,
    publicBase: publicBase
};
