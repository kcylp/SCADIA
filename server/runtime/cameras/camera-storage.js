/**
 * 'cameras/camera-storage': SQLite persistence for camera configuration.
 * Follows the recipe/calibration storage style. Camera credentials never leave
 * this layer in plaintext through the API (see camera-service.toPublic).
 */

'use strict';

const path = require('path');
const storage = require('../storage/databases');

var settings;
var logger;
var camDB;

/**
 * The connection is opened by an ASYNC callback (see init below), so there is a window where this
 * module exists, the routes are live, and camDB is still null. Before this guard that window
 * produced "Cannot read properties of null (reading 'all')" from inside a promise executor - which
 * is a TypeError, not a rejection, so it escaped the caller's .catch and reached the client as a
 * bare 500. Measured in the field on a first page load (2026-08-04 log). Now it is a rejection with
 * a name, and the API turns it into 503.
 */
function requireConnection() {
    if (!camDB) {
        const err = new Error('camera storage is not connected yet');
        err.code = 'CAM_NOT_READY';
        throw err;
    }
}
function run(sql, params) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        camDB.run(sql, params || [], function (err) {
            if (err) { reject(err); } else { resolve({ changes: this.changes, lastID: this.lastID }); }
        });
    });
}
function get(sql, params) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        camDB.get(sql, params || [], (err, row) => err ? reject(err) : resolve(row));
    });
}
function all(sql, params) {
    return new Promise((resolve, reject) => {
        try { requireConnection(); } catch (err) { reject(err); return; }
        camDB.all(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}
function nowIso() { return new Date().toISOString(); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER,
  http_port INTEGER,
  channel INTEGER DEFAULT 1,
  subtype INTEGER DEFAULT 0,
  username TEXT,
  password TEXT,
  auth TEXT,
  rtsp_template TEXT,
  snapshot_template TEXT,
  mjpeg_template TEXT,
  stream_mode TEXT DEFAULT 'snapshot',
  preview_fps INTEGER DEFAULT 4,
  enabled INTEGER DEFAULT 1,
  ai_enabled INTEGER DEFAULT 0,
  ai_endpoint TEXT,
  status_tag_id TEXT,
  osd_json TEXT,
  group_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cameras_vendor ON cameras(vendor);

-- GB/T 28181 devices registered over SIP (国标设备)
CREATE TABLE IF NOT EXISTS gb_devices (
  device_id TEXT PRIMARY KEY,
  name TEXT,
  manufacturer TEXT,
  model TEXT,
  firmware TEXT,
  transport TEXT DEFAULT 'UDP',
  host TEXT,
  port INTEGER,
  expires INTEGER,
  charset TEXT DEFAULT 'GB2312',
  to_tag TEXT,
  online INTEGER DEFAULT 0,
  channel_count INTEGER DEFAULT 0,
  register_time TEXT,
  keepalive_time TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- GB/T 28181 channels (摄像机通道) reported by the device catalog response
CREATE TABLE IF NOT EXISTS gb_channels (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT,
  manufacturer TEXT,
  model TEXT,
  owner TEXT,
  civil_code TEXT,
  address TEXT,
  parental INTEGER,
  parent_id TEXT,
  safety_way INTEGER,
  register_way INTEGER,
  secrecy INTEGER,
  status TEXT,
  ptz_type INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gb_channels_device ON gb_channels(device_id);
`;

function init(_settings, _log) {
    settings = _settings;
    logger = _log;
    return new Promise((resolve, reject) => {
        const dbPath = storage.resolveDbFile(settings.workDir, 'cameras', logger);
        camDB = storage.open(dbPath, async (err) => {
            if (err) { logger.error('camera-storage DB connection error: ' + err); reject(err); return; }
            try {
                const statements = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
                for (const s of statements) { await run(s); }
                await migrate();
                resolve();
            } catch (e) {
                logger.error('camera-storage schema error: ' + e);
                reject(e);
            }
        });
    });
}

/**
 * Additive column migration: SQLite lacks ADD COLUMN IF NOT EXISTS, so inspect
 * the table and add only what is missing. Safe to run on every start.
 */
async function migrate() {
    const cols = await all('PRAGMA table_info(cameras)');
    const have = new Set((cols || []).map(c => c.name));
    const wanted = [
        ['status_tag_id', 'TEXT'],
        ['osd_json', 'TEXT']
    ];
    for (const [name, type] of wanted) {
        if (!have.has(name)) {
            await run(`ALTER TABLE cameras ADD COLUMN ${name} ${type}`);
            logger.info(`camera-storage migrated: +${name}`);
        }
    }
}

function _map(row) {
    return {
        id: row.id,
        name: row.name,
        vendor: row.vendor,
        host: row.host,
        port: row.port,
        httpPort: row.http_port,
        channel: row.channel,
        subtype: row.subtype,
        username: row.username,
        password: row.password,
        auth: row.auth,
        rtspTemplate: row.rtsp_template,
        snapshotTemplate: row.snapshot_template,
        mjpegTemplate: row.mjpeg_template,
        streamMode: row.stream_mode,
        previewFps: row.preview_fps,
        enabled: !!row.enabled,
        aiEnabled: !!row.ai_enabled,
        aiEndpoint: row.ai_endpoint,
        statusTagId: row.status_tag_id,
        osd: row.osd_json ? JSON.parse(row.osd_json) : null,
        group: row.group_name,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function save(camera) {
    const ts = nowIso();
    return get('SELECT id FROM cameras WHERE id = ?', [camera.id]).then(existing => {
        if (existing) {
            return run(`UPDATE cameras SET name=?, vendor=?, host=?, port=?, http_port=?, channel=?, subtype=?,
                username=?, password=?, auth=?, rtsp_template=?, snapshot_template=?, mjpeg_template=?,
                stream_mode=?, preview_fps=?, enabled=?, ai_enabled=?, ai_endpoint=?, status_tag_id=?, osd_json=?,
                group_name=?, note=?, updated_at=?
                WHERE id=?`,
                [camera.name, camera.vendor, camera.host, camera.port, camera.httpPort, camera.channel, camera.subtype,
                 camera.username, camera.password, camera.auth, camera.rtspTemplate, camera.snapshotTemplate,
                 camera.mjpegTemplate, camera.streamMode, camera.previewFps, camera.enabled ? 1 : 0,
                 camera.aiEnabled ? 1 : 0, camera.aiEndpoint, camera.statusTagId || null,
                 camera.osd ? JSON.stringify(camera.osd) : null,
                 camera.group, camera.note, ts, camera.id])
                .then(() => getCamera(camera.id));
        }
        return run(`INSERT INTO cameras (id, name, vendor, host, port, http_port, channel, subtype, username, password,
                auth, rtsp_template, snapshot_template, mjpeg_template, stream_mode, preview_fps, enabled,
                ai_enabled, ai_endpoint, status_tag_id, osd_json, group_name, note, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [camera.id, camera.name, camera.vendor, camera.host, camera.port, camera.httpPort, camera.channel,
                 camera.subtype, camera.username, camera.password, camera.auth, camera.rtspTemplate,
                 camera.snapshotTemplate, camera.mjpegTemplate, camera.streamMode, camera.previewFps,
                 camera.enabled ? 1 : 0, camera.aiEnabled ? 1 : 0, camera.aiEndpoint, camera.statusTagId || null,
                 camera.osd ? JSON.stringify(camera.osd) : null,
                 camera.group, camera.note, ts, ts])
            .then(() => getCamera(camera.id));
    });
}

function getCamera(id) {
    return get('SELECT * FROM cameras WHERE id = ?', [id]).then(r => r ? _map(r) : null);
}

// ---------------------------------------------------------------- GB28181

function _mapGbDevice(row) {
    return {
        deviceId: row.device_id,
        name: row.name,
        manufacturer: row.manufacturer,
        model: row.model,
        firmware: row.firmware,
        transport: row.transport || 'UDP',
        host: row.host,
        port: row.port,
        expires: row.expires,
        charset: row.charset || 'GB2312',
        toTag: row.to_tag,
        online: !!row.online,
        channelCount: row.channel_count,
        registerTime: row.register_time,
        keepaliveTime: row.keepalive_time,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function _mapGbChannel(row) {
    return {
        id: row.id,
        deviceId: row.device_id,
        name: row.name,
        manufacturer: row.manufacturer,
        model: row.model,
        owner: row.owner,
        civilCode: row.civil_code,
        address: row.address,
        parental: row.parental,
        parentId: row.parent_id,
        safetyWay: row.safety_way,
        registerWay: row.register_way,
        secrecy: row.secrecy,
        status: row.status,
        ptzType: row.ptz_type,
        updatedAt: row.updated_at
    };
}

function saveGbDevice(d) {
    // channel_count is derived state owned by replaceGbChannels(): a keepalive
    // that lands right after (but was read before) the catalog response would
    // otherwise overwrite the real count with a stale zero.
    const ts = nowIso();
    return get('SELECT device_id FROM gb_devices WHERE device_id = ?', [d.deviceId]).then(existing => {
        if (existing) {
            return run(`UPDATE gb_devices SET name=?, manufacturer=?, model=?, firmware=?, transport=?, host=?,
                port=?, expires=?, charset=?, to_tag=?, online=?, register_time=?,
                keepalive_time=?, updated_at=? WHERE device_id=?`,
                [d.name || null, d.manufacturer || null, d.model || null, d.firmware || null, d.transport || 'UDP',
                 d.host, d.port, d.expires, d.charset || 'GB2312', d.toTag || null, d.online ? 1 : 0,
                 d.registerTime || null, d.keepaliveTime || null, ts, d.deviceId])
                .then(() => getGbDevice(d.deviceId));
        }
        return run(`INSERT INTO gb_devices (device_id, name, manufacturer, model, firmware, transport, host,
                port, expires, charset, to_tag, online, register_time, keepalive_time,
                created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [d.deviceId, d.name || null, d.manufacturer || null, d.model || null, d.firmware || null,
                 d.transport || 'UDP', d.host, d.port, d.expires, d.charset || 'GB2312', d.toTag || null,
                 d.online ? 1 : 0, d.registerTime || null, d.keepaliveTime || null, ts, ts])
            .then(() => getGbDevice(d.deviceId));
    });
}

function getGbDevice(deviceId) {
    return get('SELECT * FROM gb_devices WHERE device_id = ?', [deviceId]).then(r => r ? _mapGbDevice(r) : null);
}
function getGbDevices() {
    return all('SELECT * FROM gb_devices ORDER BY device_id').then(rows => rows.map(_mapGbDevice));
}
function markGbDevicesOffline() {
    return run('UPDATE gb_devices SET online = 0, updated_at = ? WHERE online = 1', [nowIso()]);
}
function deleteGbDevice(deviceId) {
    return run('DELETE FROM gb_devices WHERE device_id = ?', [deviceId])
        .then(() => run('DELETE FROM gb_channels WHERE device_id = ?', [deviceId]));
}

/**
 * Replace the whole channel catalog of one device (a catalog response is
 * authoritative for that device). Runs in the same statement batch so a device
 * can never be left with a half-updated channel list.
 */
async function replaceGbChannels(deviceId, channels) {
    const ts = nowIso();
    await run('DELETE FROM gb_channels WHERE device_id = ?', [deviceId]);
    for (const c of (channels || [])) {
        await run(`INSERT INTO gb_channels (id, device_id, name, manufacturer, model, owner, civil_code,
                address, parental, parent_id, safety_way, register_way, secrecy, status, ptz_type, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [c.id, deviceId, c.name || null, c.manufacturer || null, c.model || null, c.owner || null,
                 c.civilCode || null, c.address || null, c.parental === undefined ? null : c.parental,
                 c.parentId || null, c.safetyWay === undefined ? null : c.safetyWay,
                 c.registerWay === undefined ? null : c.registerWay,
                 c.secrecy === undefined ? null : c.secrecy, c.status || null, c.ptzType || 0, ts]);
    }
    await run('UPDATE gb_devices SET channel_count = ?, updated_at = ? WHERE device_id = ?',
        [(channels || []).length, ts, deviceId]);
    return (channels || []).length;
}

function getGbChannels(deviceId) {
    return all('SELECT * FROM gb_channels WHERE device_id = ? ORDER BY id', [deviceId])
        .then(rows => rows.map(_mapGbChannel));
}
function getGbChannel(deviceId, channelId) {
    return get('SELECT * FROM gb_channels WHERE device_id = ? AND id = ?', [deviceId, channelId])
        .then(r => r ? _mapGbChannel(r) : null);
}
function getAllGbChannels() {
    return all('SELECT * FROM gb_channels ORDER BY device_id, id').then(rows => rows.map(_mapGbChannel));
}
function getCameras() {
    return all('SELECT * FROM cameras ORDER BY group_name, name').then(rows => rows.map(_map));
}
function deleteCamera(id) {
    return run('DELETE FROM cameras WHERE id = ?', [id]);
}
function close() {
    return new Promise(resolve => {
        if (camDB) { camDB.close(() => { camDB = null; resolve(); }); } else { resolve(); }
    });
}

module.exports = {
    init: init,
    close: close,
    save: save,
    getCamera: getCamera,
    getCameras: getCameras,
    deleteCamera: deleteCamera,
    saveGbDevice: saveGbDevice,
    getGbDevice: getGbDevice,
    getGbDevices: getGbDevices,
    markGbDevicesOffline: markGbDevicesOffline,
    deleteGbDevice: deleteGbDevice,
    replaceGbChannels: replaceGbChannels,
    getGbChannels: getGbChannels,
    getGbChannel: getGbChannel,
    getAllGbChannels: getAllGbChannels
};