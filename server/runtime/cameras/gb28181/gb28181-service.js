/**
 * 'cameras/gb28181/gb28181-service': the GB/T 28181 device-access service.
 *
 * Responsibilities
 *   - SIP server: REGISTER (MD5 digest challenge), keepalive tracking
 *   - device catalog: query <Catalog> and persist the channels a device reports
 *   - control: PTZCmd / FIcmd via <Control> MESSAGE
 *   - streaming: open a ZLMediaKit RTP port, INVITE the channel, ACK, BYE
 *
 * Everything is transport-injectable so the whole flow can be exercised against
 * a simulated device over real loopback UDP (see test/cameras/gb28181.test.js).
 */

'use strict';

const os = require('os');
const sip = require('./sip-message');
const manscdp = require('./manscdp');
const charsetUtil = require('./charset');
const transportFactory = require('./sip-transport');
const media = require('../media-gateway');

const T1 = 500;
const DEFAULT_TIMEOUT = 3000;
const DEFAULT_CHARSET = 'GB2312';

var settings = null;
var logger = { info: function () {}, warn: function () {}, error: function () {} };
var storage = null;
var transport = null;
var bound = null;

var pending = new Map();      // callId -> { resolve, reject, timer }
var sessions = new Map();     // deviceId/channelId -> dialog + stream info
var probed = new Set();       // devices we already asked for catalog/device info
var pendingToTag = new Map(); // deviceId -> To tag issued in our 401 (bounded)
var cseqCounter = 0;
var snCounter = 0;
var offlineTimer = null;

// ------------------------------------------------------------------ helpers

function cfg() { return (settings && settings.gb28181) || {}; }
function sipId() { return cfg().sipId || '34020000002000000001'; }
function domain() { return cfg().sipDomain || '3402000000'; }
function userAgent() { return 'KaichengSCADA-GB28181/1.0'; }
function localHost() { return cfg().sipHost || _detectedHost || '127.0.0.1'; }
function localPort() { return (bound && bound.port) || Number(cfg().sipPort) || 5060; }

var _detectedHost = '';

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

function isOnline(device) {
    if (!device) { return false; }
    const limit = Date.now() - (Number(cfg().offlineAfterMs) || 180000);
    const last = Date.parse(device.keepaliveTime || device.registerTime || '') || 0;
    return last >= limit;
}

function sessionKey(deviceId, channelId) { return deviceId + '/' + channelId; }

/** Bounded per-device To tag memory (an unauthenticated peer must not grow it). */
const MAX_PENDING_TAGS = 512;
function newToTag(deviceId) {
    if (pendingToTag.size >= MAX_PENDING_TAGS) {
        pendingToTag.delete(pendingToTag.keys().next().value);
    }
    const tag = sip.newTag();
    pendingToTag.set(deviceId, tag);
    return tag;
}
function rememberToTag(deviceId) { return pendingToTag.get(deviceId) || null; }
function nextCseq() { cseqCounter = (cseqCounter % 100000) + 1; return cseqCounter; }
function nextSn() { snCounter = (snCounter % 999999) + 1; return snCounter; }

function detectLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            if (a.family === 'IPv4' && !a.internal) { return a.address; }
        }
    }
    return '127.0.0.1';
}

function targetUri(device) { return `sip:${device.deviceId}@${device.host}:${device.port}`; }

/**
 * Decode a MESSAGE body from the raw datagram when it is not UTF-8. The SIP
 * headers themselves are ASCII, so re-reading the body bytes with the declared
 * charset is enough and avoids mangled Chinese channel names.
 */
function bodyFromRaw(msg, raw) {
    if (!raw || !Buffer.isBuffer(raw) || !msg.body) { return msg.body; }
    let start = raw.indexOf(Buffer.from('\r\n\r\n'));
    if (start >= 0) {
        start += 4;
    } else {
        const lf = raw.indexOf(Buffer.from('\n\n'));
        start = lf >= 0 ? lf + 2 : -1;
    }
    if (start < 0) { return msg.body; }
    const len = Number(sip.header(msg, 'content-length'));
    const bodyBuf = Number.isFinite(len) && len >= 0 ? raw.slice(start, start + len) : raw.slice(start);
    return charsetUtil.decodeXml(bodyBuf).text;
}

// ------------------------------------------------------------------- lifecycle

async function init(_settings, _log, _runtime, _storage) {
    settings = _settings;
    if (_log) { logger = _log; }
    _runtimeRef = _runtime || null;
    storage = _storage;

    if (!cfg().enabled) {
        logger.info('gb28181: disabled (settings.gb28181.enabled = false)');
        return { enabled: false };
    }
    _detectedHost = detectLocalIp();

    transport = transportFactory.create(logger);
    transport.on('message', onDatagram);
    // sipPort 0 = ephemeral (tests / side-by-side instances)
    const configuredPort = Number(cfg().sipPort);
    const listenPort = configuredPort === 0 ? 0 : (configuredPort || 5060);
    bound = await transport.listen(listenPort, cfg().bindHost || '0.0.0.0');

    // A fresh process holds no live registrations: whatever the store says, the
    // truth today is "not registered yet".
    await storage.markGbDevicesOffline();
    startOfflineSweep();

    logger.info(`gb28181: SIP server listening sip:${sipId()}@${localHost()}:${bound.port} (realm ${domain()})`, true);
    return { enabled: true, port: bound.port, localHost: localHost() };
}

function stop() {
    if (offlineTimer) { clearInterval(offlineTimer); offlineTimer = null; }
    for (const entry of pending.values()) { if (entry.timer) { clearTimeout(entry.timer); } }
    pending.clear();
    sessions.clear();
    probed.clear();
    pendingToTag.clear();
    if (transport) {
        const t = transport;
        transport = null;
        bound = null;
        return t.close ? t.close() : Promise.resolve();
    }
    return Promise.resolve();
}

function startOfflineSweep() {
    const offlineAfter = Number(cfg().offlineAfterMs) || 180000;
    const period = Math.max(5000, Math.floor(offlineAfter / 3));
    offlineTimer = setInterval(() => { sweep().catch(() => {}); }, period);
    if (offlineTimer.unref) { offlineTimer.unref(); }
}

async function sweep() {
    const devices = await storage.getGbDevices();
    for (const d of devices) {
        const online = isOnline(d);
        if (!!d.online !== online && (d.host || !online)) {
            await storage.saveGbDevice(Object.assign({}, d, { online: online }));
            logger.info(`gb28181: device ${d.deviceId} is now ${online ? 'online' : 'offline'}`);
        }
    }
}

// -------------------------------------------------------------- SIP dispatch

async function onDatagram(text, rinfo, raw) {
    let msg;
    try {
        msg = sip.parse(text);
    } catch (err) {
        logger.warn('gb28181: dropping malformed SIP datagram from ' + (rinfo && rinfo.address) + ': ' + err.message);
        return;
    }
    try {
        if (msg.type === 'response') { onResponse(msg); return; }
        await onRequest(msg, rinfo, raw);
    } catch (err) {
        logger.error('gb28181: handling ' + (msg.method || 'message') + ' failed: ' + (err.stack || err.message));
    }
}

async function onRequest(msg, rinfo, raw) {
    switch (msg.method) {
        case 'REGISTER': return handleRegister(msg, rinfo);
        case 'MESSAGE': return handleMessage(msg, rinfo, raw);
        case 'OPTIONS': return reply(msg, rinfo, 200);
        case 'BYE': {
            const from = sip.addressUser(sip.header(msg, 'from'));
            for (const [key, s] of sessions) { if (s.deviceId === from) { sessions.delete(key); } }
            return reply(msg, rinfo, 200);
        }
        case 'ACK': return void 0;                       // no response to ACK
        case 'INVITE': return reply(msg, rinfo, 405);    // this platform does not accept incoming sessions
        default: return reply(msg, rinfo, 405);
    }
}

function onResponse(msg) {
    if (msg.statusCode >= 100 && msg.statusCode < 200) { return; }   // provisional: keep waiting
    const callId = sip.header(msg, 'call-id');
    const entry = callId ? pending.get(callId) : null;
    if (!entry) { return; }                                          // late or unsolicited
    pending.delete(callId);
    entry.resolve(msg);
}

async function reply(req, rinfo, statusCode, extra) {
    if (!transport) { return; }
    const text = sip.buildResponse(req, Object.assign({ statusCode: statusCode }, extra || {}));
    await transport.send(text, rinfo.port, rinfo.address);
}

function sendRaw(text, device) {
    if (!transport) { return Promise.reject(fail('GB_SIP_ERROR', 'SIP transport is not running')); }
    return transport.send(text, device.port, device.host);
}

/**
 * Run one SIP client transaction: send, retransmit once, then time out. The
 * response is matched by Call-ID; the resolved value carries the dialog
 * identifiers the caller needs for ACK/BYE.
 */
function transact(device, method, text, callId, cseq, fromTag, opts) {
    const o = opts || {};
    const maxTries = 1 + (o.retries === undefined ? 1 : o.retries);
    const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT;
    const perTry = Math.max(T1, Math.floor(timeoutMs / maxTries));

    return new Promise((resolve, reject) => {
        let tries = 0;
        const entry = { callId: callId, cseq: cseq, fromTag: fromTag, timer: null };
        const done = (msg) => {
            clearTimeout(entry.timer);
            pending.delete(callId);
            resolve({ callId: callId, cseq: cseq, fromTag: fromTag, response: msg });
        };
        const giveUp = () => {
            pending.delete(callId);
            const err = new Error(`no SIP response from ${device.deviceId} (${method})`);
            err.code = 'GB_TIMEOUT';
            reject(err);
        };
        entry.resolve = done;
        const attempt = () => {
            tries++;
            sendRaw(text, device).catch(err => logger.warn('gb28181: send to ' + device.deviceId + ' failed: ' + err.message));
            entry.timer = setTimeout(() => { if (tries < maxTries) { attempt(); } else { giveUp(); } }, perTry);
        };
        pending.set(callId, entry);
        attempt();
    });
}

/** Build and send a request, then wait for its final response. */
function sendRequest(device, method, opts) {
    const o = opts || {};
    const cseq = nextCseq();
    const callId = sip.newCallId();
    const fromTag = sip.newTag();
    const text = sip.buildRequest({
        method: method,
        uri: targetUri(device),
        via: { host: localHost(), port: localPort(), branch: sip.newBranch(), transport: 'UDP' },
        from: { uri: `sip:${sipId()}@${domain()}`, tag: fromTag },
        to: { uri: targetUri(device), tag: device.toTag || undefined },
        callId: callId,
        cseq: cseq,
        contact: o.noContact ? null : `sip:${sipId()}@${localHost()}:${localPort()}`,
        subject: o.subject,
        userAgent: userAgent(),
        contentType: o.contentType,
        body: o.body
    });
    return transact(device, method, text, callId, cseq, fromTag, o);
}

// ------------------------------------------------------------------ REGISTER

async function handleRegister(msg, rinfo) {
    const deviceId = sip.addressUser(sip.header(msg, 'from')) || sip.addressUser(sip.header(msg, 'to'));
    if (!deviceId) { await reply(msg, rinfo, 400); return; }

    const contactHostPort = sip.addressHostPort(sip.header(msg, 'contact')) || {};
    const host = contactHostPort.host || rinfo.address;
    const port = contactHostPort.port || rinfo.port;
    const expires = Number(sip.header(msg, 'expires') || 3600);
    const known = await storage.getGbDevice(deviceId);
    // Reuse one To tag across the 401 challenge and the 200 OK: firmware that
    // validates the tag would otherwise reject our own successful response.
    const toTag = (known && known.toTag) || rememberToTag(deviceId) || newToTag(deviceId);

    if (expires <= 0) {
        if (known) { await storage.saveGbDevice(Object.assign({}, known, { online: false })); }
        await reply(msg, rinfo, 200, { toTag: toTag });
        logger.info(`gb28181: device ${deviceId} deregistered`);
        return;
    }

    if (cfg().allowAnonymous !== true) {
        if (!sip.header(msg, 'authorization')) {
            await reply(msg, rinfo, 401, { toTag: toTag, wwwAuthenticate: sip.challenge(domain(), sip.makeNonce()) });
            return;
        }
        const password = cfg().sipPassword || '';
        if (!sip.verifyDigest(msg, password)) {
            await reply(msg, rinfo, 401, { toTag: toTag, wwwAuthenticate: sip.challenge(domain(), sip.makeNonce()) });
            logger.warn(`gb28181: device ${deviceId} rejected: digest does not match the configured SIP password`);
            return;
        }
    }

    const nowIso = new Date().toISOString();
    await storage.saveGbDevice({
        deviceId: deviceId,
        name: known ? known.name : null,
        manufacturer: known ? known.manufacturer : null,
        model: known ? known.model : null,
        firmware: known ? known.firmware : null,
        transport: 'UDP',
        host: host,
        port: port,
        expires: expires,
        charset: (known && known.charset) || DEFAULT_CHARSET,
        toTag: toTag,
        online: true,
        channelCount: known ? known.channelCount : 0,
        registerTime: nowIso,
        keepaliveTime: nowIso
    });
    await reply(msg, rinfo, 200, { toTag: toTag });
    logger.info(`gb28181: device ${deviceId} registered from ${host}:${port} (expires ${expires}s)`, true);

    // First contact: learn what the device has. Failures must not break the flow.
    if (!probed.has(deviceId)) {
        probed.add(deviceId);
        refreshDevice(deviceId).catch(err => logger.warn('gb28181: initial catalog query failed for ' + deviceId + ': ' + err.message));
    }
}

// ------------------------------------------------------------------- MESSAGE

async function handleMessage(msg, rinfo, raw) {
    const deviceId = sip.addressUser(sip.header(msg, 'from')) || sip.addressUser(sip.header(msg, 'to'));
    await reply(msg, rinfo, 200);      // a MESSAGE is always acknowledged first

    const body = bodyFromRaw(msg, raw);
    if (!body) { return; }
    let doc;
    try {
        doc = await manscdp.parse(body);
    } catch (err) {
        logger.warn('gb28181: unparsable MANSCDP body from ' + deviceId + ': ' + err.message);
        return;
    }

    await touchDevice(deviceId, rinfo, doc);

    switch (doc.cmdType) {
        case 'Keepalive': return onKeepalive(deviceId, doc);
        case 'Catalog': return onCatalog(deviceId, doc);
        case 'DeviceInfo': return onDeviceInfo(deviceId, doc);
        case 'DeviceStatus': return void 0;   // liveness already updated by touchDevice
        case 'Alarm': return onAlarm(deviceId, doc);
        default:
            logger.info(`gb28181: ${deviceId} sent ${doc.cmdType || doc.root} (not handled)`);
    }
}

/** Every inbound MESSAGE proves the device is alive; refresh its record. */
async function touchDevice(deviceId, rinfo, doc) {
    if (!deviceId) { return; }
    const known = await storage.getGbDevice(deviceId);
    const nowIso = new Date().toISOString();
    const rec = Object.assign({
        deviceId: deviceId, host: rinfo.address, port: rinfo.port, transport: 'UDP',
        charset: DEFAULT_CHARSET, toTag: null, channelCount: 0
    }, known || {});
    if (!rec.host) { rec.host = rinfo.address; }
    if (!rec.port) { rec.port = rinfo.port; }
    rec.online = true;
    rec.keepaliveTime = nowIso;
    if (!rec.registerTime) { rec.registerTime = nowIso; }
    await storage.saveGbDevice(rec);
}

async function onKeepalive(deviceId, doc) {
    if (doc.status && doc.status !== 'OK') {
        logger.warn(`gb28181: device ${deviceId} keepalive status=${doc.status}`);
    }
    if (!probed.has(deviceId)) {
        probed.add(deviceId);
        refreshDevice(deviceId).catch(err => logger.warn('gb28181: catalog query failed for ' + deviceId + ': ' + err.message));
    }
}

async function onCatalog(deviceId, doc) {
    const count = await storage.replaceGbChannels(deviceId, doc.channels || []);
    logger.info(`gb28181: device ${deviceId} catalog: ${count} channel(s)` +
        (doc.sumNum && doc.sumNum > count ? ` (device reported SumNum=${doc.sumNum}, pagination not requested)` : ''));
}

async function onDeviceInfo(deviceId, doc) {
    const known = await storage.getGbDevice(deviceId);
    if (!known) { return; }
    await storage.saveGbDevice(Object.assign({}, known, {
        name: doc.deviceName || known.name,
        manufacturer: doc.manufacturer || known.manufacturer,
        model: doc.model || known.model,
        firmware: doc.firmware || known.firmware,
        charset: doc.charset || known.charset
    }));
}

async function onAlarm(deviceId, doc) {
    logger.warn(`gb28181: alarm from ${deviceId}: type=${doc.alarmType || '-'} priority=${doc.alarmPriority || '-'}`);
    const runtime = _runtimeRef;
    const tagId = cfg().alarmTagId;
    if (runtime && runtime.cameraFusion && tagId) {
        try {
            await runtime.cameraFusion.writeEvent(tagId, 1);
        } catch (err) {
            logger.warn(`gb28181: cannot write alarm to tag ${tagId}: ${err.message}`);
        }
    }
}

var _runtimeRef = null;

// ------------------------------------------------------------------ queries

async function requireDevice(deviceId) {
    const d = await storage.getGbDevice(deviceId);
    if (!d) { fail('GB_DEVICE_NOT_FOUND', 'device not found: ' + deviceId); }
    if (!d.host || !d.port) { fail('GB_DEVICE_OFFLINE', 'device has no known signalling address: ' + deviceId); }
    if (!isOnline(d)) { fail('GB_DEVICE_OFFLINE', 'device is offline: ' + deviceId); }
    return d;
}

async function queryDeviceInfo(deviceId) {
    const d = await requireDevice(deviceId);
    const sn = nextSn();
    const res = await sendRequest(d, 'MESSAGE', {
        body: manscdp.deviceInfoQuery(d.deviceId, sn, d.charset),
        contentType: 'Application/MANSCDP+xml'
    });
    if (res.response.statusCode >= 300) {
        fail('GB_SIP_ERROR', 'device rejected DeviceInfo query: ' + res.response.statusCode);
    }
    return { deviceId: deviceId, sn: sn, statusCode: res.response.statusCode };
}

async function queryCatalog(deviceId) {
    const d = await requireDevice(deviceId);
    const sn = nextSn();
    const res = await sendRequest(d, 'MESSAGE', {
        body: manscdp.catalogQuery(d.deviceId, sn, d.charset),
        contentType: 'Application/MANSCDP+xml'
    });
    if (res.response.statusCode >= 300) {
        fail('GB_SIP_ERROR', 'device rejected Catalog query: ' + res.response.statusCode);
    }
    return { deviceId: deviceId, sn: sn, statusCode: res.response.statusCode };
}

/** DeviceInfo + Catalog in one shot (used right after the first registration). */
async function refreshDevice(deviceId) {
    const out = { deviceId: deviceId };
    try { out.deviceInfo = await queryDeviceInfo(deviceId); } catch (err) { out.deviceInfoError = err.code || err.message; }
    try { out.catalog = await queryCatalog(deviceId); } catch (err) { out.catalogError = err.code || err.message; }
    return out;
}

async function ptz(deviceId, channelId, action) {
    const d = await requireDevice(deviceId);
    const a = action || {};
    const target = channelId || d.deviceId;
    const ptzCmd = a.ptzCmd ? String(a.ptzCmd).toUpperCase() : manscdp.ptzCommandFor(a.code, { speed: a.speed });
    const sn = nextSn();
    const res = await sendRequest(d, 'MESSAGE', {
        body: manscdp.deviceControlPtz(target, sn, ptzCmd, d.charset),
        contentType: 'Application/MANSCDP+xml'
    });
    if (res.response.statusCode >= 300) {
        fail('GB_SIP_ERROR', 'device rejected PTZ command: ' + res.response.statusCode);
    }
    return { deviceId: deviceId, channelId: target, action: a.code || 'stop', ptzCmd: ptzCmd, sn: sn, statusCode: res.response.statusCode };
}

async function preset(deviceId, channelId, op, index) {
    const d = await requireDevice(deviceId);
    const target = channelId || d.deviceId;
    const fiCmd = manscdp.encodeFiCommand(op, index);
    const sn = nextSn();
    const res = await sendRequest(d, 'MESSAGE', {
        body: manscdp.deviceControlFi(target, sn, fiCmd, d.charset),
        contentType: 'Application/MANSCDP+xml'
    });
    if (res.response.statusCode >= 300) {
        fail('GB_SIP_ERROR', 'device rejected preset command: ' + res.response.statusCode);
    }
    return { deviceId: deviceId, channelId: target, op: op, index: Number(index) || 1, fiCmd: fiCmd, sn: sn, statusCode: res.response.statusCode };
}

// ------------------------------------------------------------------- streams

/** GB28181 SSRC: 10 decimal digits, leading 0, tail from the channel id. */
function buildSsrc(channelId) {
    const digits = String(channelId || '').replace(/\D/g, '').slice(-9).padStart(9, '0');
    return '0' + digits;
}

function buildPlaySdp(device, o) {
    const t = String(o.transport || 'UDP').toUpperCase();
    const proto = t === 'UDP' ? 'RTP/AVP' : 'TCP/RTP/AVP';
    const lines = [
        'v=0',
        `o=${device.deviceId} 0 0 IN IP4 ${o.mediaIp}`,
        's=Play',
        `c=IN IP4 ${o.mediaIp}`,
        't=0 0',
        `m=video ${o.port} ${proto} 96 98 97 99`,
        'a=recvonly',
        'a=rtpmap:96 PS/90000',
        'a=rtpmap:98 H264/90000',
        'a=rtpmap:97 MPEG4/90000',
        'a=rtpmap:99 H265/90000'
    ];
    if (t === 'TCP-PASSIVE') { lines.push('a=setup:passive', 'a=connection:new'); }
    else if (t === 'TCP-ACTIVE') { lines.push('a=setup:active', 'a=connection:new'); }
    lines.push(`y=${o.ssrc}`);
    return lines.join('\r\n') + '\r\n';
}

async function sendAck(device, dlg) {
    const text = sip.buildRequest({
        method: 'ACK',
        uri: targetUri(device),
        via: { host: localHost(), port: localPort(), branch: sip.newBranch(), transport: 'UDP' },
        from: { uri: `sip:${sipId()}@${domain()}`, tag: dlg.fromTag },
        to: { uri: targetUri(device), tag: dlg.toTag || undefined },
        callId: dlg.callId,
        cseq: dlg.cseq,
        userAgent: userAgent()
    });
    return sendRaw(text, device);
}

/**
 * Start a live stream: open an RTP port in ZLMediaKit, INVITE the channel, ACK.
 * @returns play URLs for the browser plus the negotiated stream identifiers.
 */
async function play(deviceId, channelId) {
    const d = await requireDevice(deviceId);
    if (!media.isConfigured(settings)) {
        fail('MEDIA_NOT_CONFIGURED', 'GB28181 playback needs settings.mediaServer (ZLMediaKit)');
    }
    const stream = `gb_${d.deviceId}_${channelId}`;
    const ssrc = buildSsrc(channelId);
    const rtp = await media.openRtpServer(settings, {
        streamId: stream,
        port: cfg().mediaPort,
        transport: cfg().rtpTransport
    });

    const sdp = buildPlaySdp(d, {
        mediaIp: cfg().mediaIp || localHost(),
        port: rtp.port,
        ssrc: ssrc,
        transport: cfg().rtpTransport
    });

    let res;
    try {
        res = await sendRequest(d, 'INVITE', {
            body: sdp,
            contentType: 'APPLICATION/SDP',
            subject: `${channelId}:${ssrc},${sipId()}:0`,
            timeoutMs: 8000,
            retries: 0
        });
    } catch (err) {
        await media.closeRtpServer(settings, stream);
        throw err;
    }
    if (res.response.statusCode >= 300) {
        await media.closeRtpServer(settings, stream);
        fail('GB_INVITE_FAILED', 'device refused the invite: ' + res.response.statusCode);
    }

    const toTag = sip.params(sip.header(res.response, 'to')).tag || null;
    await sendAck(d, { callId: res.callId, cseq: res.cseq, fromTag: res.fromTag, toTag: toTag })
        .catch(err => logger.warn('gb28181: ACK failed: ' + err.message));

    const key = sessionKey(deviceId, channelId);
    sessions.set(key, {
        deviceId: deviceId, channelId: channelId, stream: stream, ssrc: ssrc, rtpPort: rtp.port,
        callId: res.callId, fromTag: res.fromTag, toTag: toTag, transport: cfg().rtpTransport, startedAt: Date.now()
    });

    logger.info(`gb28181: streaming ${deviceId}/${channelId} -> rtp://${cfg().mediaIp || localHost()}:${rtp.port} (ssrc ${ssrc})`, true);
    return Object.assign(media.rtpPlayback(settings, stream, ssrc, rtp.port), {
        deviceId: deviceId,
        channelId: channelId,
        invite: res.response.statusCode,
        toTag: toTag
    });
}

async function stopStream(deviceId, channelId) {
    const key = sessionKey(deviceId, channelId);
    const s = sessions.get(key);
    const d = await storage.getGbDevice(deviceId);
    if (!d) { fail('GB_DEVICE_NOT_FOUND', 'device not found: ' + deviceId); }

    if (!s) {
        await media.closeRtpServer(settings, `gb_${deviceId}_${channelId}`);
        return { stopped: false, deviceId: deviceId, channelId: channelId };
    }

    const cseq = nextCseq();
    // The BYE must stay inside the INVITE dialog: same Call-ID, our tag, and the
    // tag the device chose in its 200 OK.
    const callId = s.callId;
    const text = sip.buildRequest({
        method: 'BYE',
        uri: targetUri(d),
        via: { host: localHost(), port: localPort(), branch: sip.newBranch(), transport: 'UDP' },
        from: { uri: `sip:${sipId()}@${domain()}`, tag: s.fromTag },
        to: { uri: targetUri(d), tag: s.toTag || undefined },
        callId: callId,
        cseq: cseq,
        contact: `sip:${sipId()}@${localHost()}:${localPort()}`,
        userAgent: userAgent()
    });
    await transact(d, 'BYE', text, callId, cseq, s.fromTag, { timeoutMs: 2000, retries: 0 })
        .catch(() => null);

    await media.closeRtpServer(settings, s.stream);
    sessions.delete(key);
    logger.info(`gb28181: stream stopped ${deviceId}/${channelId}`);
    return { stopped: true, deviceId: deviceId, channelId: channelId, stream: s.stream };
}

// -------------------------------------------------------------------- status

function status() {
    return {
        enabled: !!cfg().enabled,
        sipId: sipId(),
        domain: domain(),
        port: localPort(),
        localHost: localHost(),
        transport: 'UDP',
        mediaConfigured: media.isConfigured(settings),
        mediaIp: cfg().mediaIp || localHost(),
        rtpTransport: cfg().rtpTransport || 'UDP',
        sessions: sessions.size
    };
}

async function listDevices() {
    const devices = await storage.getGbDevices();
    return devices.map(d => Object.assign({}, d, { online: isOnline(d) }));
}

async function getDevice(deviceId) {
    const d = await storage.getGbDevice(deviceId);
    if (!d) { return null; }
    return Object.assign({}, d, { online: isOnline(d) });
}

async function getChannels(deviceId) { return storage.getGbChannels(deviceId); }
async function listChannels() { return storage.getAllGbChannels(); }
async function removeDevice(deviceId) {
    sessions.forEach((s, key) => { if (s.deviceId === deviceId) { sessions.delete(key); } });
    probed.delete(deviceId);
    await storage.deleteGbDevice(deviceId);
    return { removed: deviceId };
}

function getSessions() {
    const out = [];
    sessions.forEach(s => out.push(Object.assign({}, s)));
    return out;
}

module.exports = {
    init: init,
    stop: stop,
    status: status,
    listDevices: listDevices,
    getDevice: getDevice,
    getChannels: getChannels,
    listChannels: listChannels,
    removeDevice: removeDevice,
    queryCatalog: queryCatalog,
    queryDeviceInfo: queryDeviceInfo,
    refreshDevice: refreshDevice,
    ptz: ptz,
    preset: preset,
    play: play,
    stopStream: stopStream,
    getSessions: getSessions,
    isOnline: isOnline,
    buildSsrc: buildSsrc,
    buildPlaySdp: buildPlaySdp,
    // test seams
    __setTransport: function (t) { transport = t; },
    __setRuntime: function (r) { _runtimeRef = r; },
    __handleDatagram: onDatagram,
    __setBound: function (b) { bound = b; }
};
