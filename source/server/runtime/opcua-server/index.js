/**
 * 'opcua-server': publish the project to OPC UA clients.
 *
 * The project could already *consume* OPC UA (devices/opcua is a client). This is
 * the other direction: third-party HMIs, MES and the mine's other systems can
 * browse and subscribe to our live tags, camera state and AI alarms over
 * opc.tcp, which is the standard plant-floor integration surface.
 *
 * Address space (namespace 1, under Objects):
 *
 *   <root>/Devices/<device name>/<tag name>        live tag value (RW*)
 *   <root>/Cameras/<camera name>/Online            camera reachable (RO)
 *   <root>/Cameras/<camera name>/AiEnabled         analytics attached (RO)
 *   <root>/Ai/<camera name>/Alarm                  detection alarm (RO)
 *   <root>/Ai/<camera name>/Detections             live box count (RO)
 *
 * * writes are refused unless settings.opcuaServer.writeEnabled is true.
 *
 * Design choices:
 *  - SecurityPolicy None only. This server is meant for the plant LAN; enabling
 *    a security policy without certificates would give a false sense of safety,
 *    so it is not offered at all rather than offered broken.
 *  - tag reads go through the device layer on demand, and pushed updates ride the
 *    existing 'tag-value:changed' event; the server never polls the tags itself.
 *  - a value that cannot be represented in its declared OPC UA type is published
 *    as Bad quality, not as a fabricated 0.
 */

'use strict';

const datatype = require('./datatype');
const os = require('os');

const DEFAULT_POLL_MS = 5000;
/** Tag scan cadence: the read-freshness floor for drivers without change events. */
const DEFAULT_TAG_POLL_MS = 1000;
const MAX_TAGS = 20000;

/** OPC UA namespace 0 standard node ids we organise under (no magic strings elsewhere). */
const NODES = {
    rootObjects: 'i=85',
    folders: 'i=61',        // FolderType
    baseDataVariable: 'i=63',
    baseObject: 'i=58'
};

var settings = null;
var logger = { info: function () {}, warn: function () {}, error: function () {} };
var runtime = null;
var opcuaLib = null;
var server = null;
var addressSpaceRef = null;
var namespace = null;

/**
 * OPC UA AccessLevel bitmask: CurrentRead = 0x01, CurrentWrite = 0x02. Passed
 * numerically rather than as a "CurrentRead | CurrentWrite" string so the bits
 * cannot be mis-parsed by the library version in use.
 */
const ACCESS_READ = 1;
const ACCESS_READ_WRITE = 3;

/** tagId -> { variable, opcuaType, tag } */
var tagVariables = new Map();
/** 'cameras/<cameraId>/online' -> { variable, opcuaType } (camera values by path key) */
var cameraVariables = new Map();
var pollTimer = null;
var tagTimer = null;
var boundPort = null;
/** Index of our own namespace; every NodeId we mint must carry it. */
var nsIndex = 1;

function cfg() { return (settings && settings.opcuaServer) || {}; }
function isEnabled() { return cfg().enabled === true; }

/**
 * Host advertised in the endpoint URL.
 *
 * Leaving it to the library produced `opc.tcp://undefined:4840/...`, which a
 * client that follows the advertised endpoint cannot resolve. Prefer an explicit
 * setting, then the first non-internal IPv4, so the plant LAN gets a usable URL.
 */
function advertiseHost() {
    if (cfg().advertiseHost) { return cfg().advertiseHost; }
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name] || []) {
            if (a.family === 'IPv4' && !a.internal) { return a.address; }
        }
    }
    return '127.0.0.1';
}

function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    throw err;
}

/** OPC UA browse names cannot contain '.'; '.' is our hierarchy separator too. */
function safeName(name, fallback) {
    const s = String(name === undefined || name === null ? '' : name).trim();
    if (!s) { return fallback; }
    // '+' and '.' would change the meaning of our string NodeIds, so they are
    // replaced rather than escaped (OPC UA browse names have no escape syntax).
    return s.replace(/[.+/\\]/g, '_').slice(0, 120);
}

/**
 * Address-space identity (contract 09 §4.5).
 *
 * A node's identity is an OPC UA QualifiedName built from path segments. Two kinds
 * of segment exist, and the distinction is what keeps client references alive:
 *
 *   - numeric segment -> a STABLE identifier (device id, tag id). It IS the identity.
 *   - string segment  -> a DISPLAY name (BrowseName / DisplayName only). It is cosmetic.
 *
 * So the path for device 'd1' (named 'SPS') and tag 'tag_level' (named 'Level') is
 * `SCADA.2.d1.3.tag_level`, while the browse tree still shows `SCADA/Devices/SPS/Level`.
 * Renaming the device or the tag changes only what the client DISPLAYS; every
 * NodeId — and therefore every client reference and subscription — is unaffected.
 *
 * This replaces the previous scheme, where the identity WAS the dotted name path
 * ('SCADA.Devices.SPS.Level'). Renaming a device, renaming a tag, or moving a tag to
 * another device silently changed its NodeId and broke the client.
 */
const SEG_STABLE = 2;      // numeric identifier segment (identity)
const SEG_DISPLAY = 3;     // string display-name segment (cosmetic)
const SEG_FOLDER = 1;      // structural folder: identity is its fixed slug

/**
 * Path segments for a node, in order. Accepts several segments at once.
 *
 * Every argument MUST be a segment object produced by one of the seg* helpers; a
 * non-segment is rejected loudly rather than silently producing a NodeId that no
 * client can resolve.
 */
function nodePath(parent, ...segs) {
    for (const s of segs) {
        if (!s || typeof s !== 'object' || typeof s.kind !== 'number' || s.value === undefined) {
            throw new Error('nodePath: not a path segment: ' + JSON.stringify(s));
        }
    }
    const result = (parent.__path ? parent.__path.slice() : []).concat(segs);
    return result;
}

function nodeIdFor(path) {
    return `ns=${nsIndex};s=` + path.map(seg => seg.kind + ':' + seg.value).join('.');
}

/** A display-only segment (folder names, root). */
function displaySeg(value) { return { kind: SEG_FOLDER, value: safeName(value, '_') }; }
/** A stable identity segment. */
function stableSeg(value) { return { kind: SEG_STABLE, value: String(value) }; }
/** A display-name segment (cosmetic, never part of the identity). */
function nameSeg(value) { return { kind: SEG_DISPLAY, value: safeName(value, '_') }; }
/** A fixed, code-controlled slug (camera variable names) — stable by construction. */
function fixedSeg(value) { return { kind: SEG_FOLDER, value: safeName(value, '_') }; }

/** Safe single path component for a BrowseName / DisplayName. */
function safeSeg(name, fallback) {
    const s = String(name === undefined || name === null ? '' : name).trim();
    return s || fallback || '_';
}
// (see displaySeg/stableSeg/nameSeg/fixedSeg above for segment constructors)

// ------------------------------------------------------------------ lifecycle

async function init(_settings, _log, _runtime) {
    settings = _settings;
    if (_log) { logger = _log; }
    runtime = _runtime;

    if (!isEnabled()) {
        logger.info('opcua-server: disabled (settings.opcuaServer.enabled = false)');
        return { enabled: false };
    }

    let opcua;
    try {
        opcua = require('node-opcua');
    } catch (err) {
        logger.error('opcua-server: node-opcua is not installed: ' + err.message);
        return { enabled: false, error: 'node-opcua-missing' };
    }
    opcuaLib = opcua;

    const c = cfg();
    const host = advertiseHost();
    const options = {
        port: Number(c.port) || 4840,
        resourcePath: c.endpoint || '/UA/SCADA',
        hostname: host,
        buildInfo: { productName: 'Kaicheng SCADA', manufacturerName: 'Kaicheng', softwareVersion: '1.0.0' },
        serverInfo: {
            applicationName: { text: c.applicationName || 'Kaicheng SCADA OPC UA Server' },
            applicationUri: c.applicationUri || 'urn:kaicheng:scada'
        },
        // Deliberately None-only: see the module header.
        securityPolicies: [opcua.SecurityPolicy.None],
        securityModes: [opcua.MessageSecurityMode.None],
        allowAnonymous: c.allowAnonymous !== false,
        maxConnections: Number(c.maxConnections) || 20,
        serverCapabilities: { maxSessions: Number(c.maxSessions) || 20 }
    };

    if (Array.isArray(c.users) && c.users.length) {
        options.userManager = {
            isValidUser: (username, password) =>
                c.users.some(u => u && u.username === username && u.password === password)
        };
    }

    server = new opcua.OPCUAServer(options);
    server.on('post_initialize', () => {
        try {
            buildAddressSpace(opcua);
        } catch (err) {
            logger.error('opcua-server: address space build failed: ' + (err.stack || err.message));
        }
    });

    await server.start();
    boundPort = server.endpoints && server.endpoints[0] ? server.endpoints[0].port : options.port;

    subscribeTagChanges();
    startCameraPolling();

    logger.info(`opcua-server: listening opc.tcp://${host}:${boundPort}${options.resourcePath}` +
        ` (devices ${cfg().exposeDevices !== false ? 'on' : 'off'}, cameras ${cfg().exposeCameras !== false ? 'on' : 'off'},` +
        ` write ${cfg().writeEnabled === true ? 'ENABLED' : 'read-only'})`, true);

    return { enabled: true, port: boundPort, resourcePath: options.resourcePath, endpoint: `opc.tcp://${host}:${boundPort}${options.resourcePath}` };
}

function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tagTimer) { clearInterval(tagTimer); tagTimer = null; }
    tagVariables.clear();
    cameraVariables.clear();
    if (runtime && runtime.events && unsubscribeTagChanges) { unsubscribeTagChanges(); }
    unsubscribeTagChanges = null;
    const s = server;
    server = null;
    opcuaLib = null;
    addressSpaceRef = null;
    namespace = null;
    boundPort = null;
    if (!s) { return Promise.resolve(); }
    return s.shutdown(500).then(() => true).catch(err => {
        logger.warn('opcua-server: shutdown failed: ' + err.message);
        return false;
    });
}

// -------------------------------------------------------------- address space

/**
 * Build the folder/variable tree from the current project. Safe to call again
 * (see refreshAddressSpace): variables are reused, not duplicated, so a client's
 * subscriptions survive a device/tag being added.
 */
function buildAddressSpace(opcua) {
    addressSpaceRef = server.engine.addressSpace;
    namespace = addressSpaceRef.getOwnNamespace();
    // Get the namespace index BEFORE minting any NodeId: a NodeId without a
    // namespace index means namespace 0 (the standard one) and the node would be
    // created in the wrong place — or refused.
    nsIndex = namespace.index;

    const rootFolder = addressSpaceRef.rootFolder.objects;
    const rootName = safeSeg(cfg().rootName || 'SCADA', 'SCADA');
    const rootPath = [displaySeg(rootName)];
    let root = addressSpaceRef.findNode(nodeIdFor(rootPath));
    if (!root) {
        root = namespace.addFolder(rootFolder, {
            browseName: rootName,
            nodeId: nodeIdFor(rootPath),
            displayName: rootName
        });
    }
    root.__path = rootPath;

    if (cfg().exposeDevices !== false) { buildDevicesTree(opcua, root); }
    if (cfg().exposeCameras !== false) { buildCamerasTree(opcua, root); }
}

/**
 * Create (or reuse) a folder under @parent@.
 *
 * @param {object} parent      parent node (carries __path)
 * @param {object} seg         identity segment (see nodePath()); when omitted the
 *                             folder is identified by its fixed display slug, which is
 *                             correct for structural folders like Devices/Cameras/Ai
 * @param {string} [displayName] BrowseName/DisplayName; defaults to the segment value
 */
function ensureFolder(parent, segs, displayName) {
    const list = Array.isArray(segs) ? segs : [segs || displaySeg('_')];
    // A node's IDENTITY path holds only stable/structural segments. Any display-name
    // segment passed in here is dropped from the path and used purely for the label,
    // which is what keeps a rename from changing a NodeId.
    const nameSegment = list.find(s => s && s.kind === SEG_DISPLAY);
    const path = nodePath(parent, ...list.filter(s => s.kind !== SEG_DISPLAY));
    const id = nodeIdFor(path);
    // BrowseName/DisplayName is for humans: explicit override, else the dropped name
    // segment, else the last structural segment's slug.
    const label = displayName || (nameSegment && nameSegment.value) || (list[list.length - 1] || {}).value || '_';
    let node = addressSpaceRef.findNode(id);
    if (!node) {
        node = namespace.addFolder(parent, { browseName: label, nodeId: id, displayName: label });
    }
    node.__path = path;
    node.__displayName = label;
    return node;
}

function buildDevicesTree(opcua, root) {
    const devicesFolder = ensureFolder(root, displaySeg('Devices'));

    let devices = {};
    try {
        devices = runtime.project.getDevices() || {};
    } catch (err) {
        logger.warn('opcua-server: cannot read the project devices: ' + err.message);
        return;
    }

    let created = 0;
    let skipped = 0;
    for (const deviceId of Object.keys(devices)) {
        const device = devices[deviceId];
        if (!device || !device.tags) { continue; }
        // Identity is the device id; the device NAME is only what the client displays.
        const deviceName = safeSeg(device.name || deviceId, deviceId);
        // Identity = <device id>.<display name>; the NAME segment is cosmetic, the ID is the identity.
        const deviceFolder = ensureFolder(devicesFolder, [stableSeg(deviceId), nameSeg(deviceName)], deviceName);

        for (const tagId of Object.keys(device.tags)) {
            if (tagVariables.size >= MAX_TAGS) {
                logger.warn(`opcua-server: tag limit (${MAX_TAGS}) reached, remaining tags are not published`);
                return;
            }
            const tag = device.tags[tagId];
            // Identity is the tagId; the tag NAME is only what the client displays.
            const tagName = safeSeg((tag && tag.name) || tagId, tagId);
            const opcuaType = datatype.mapTagType(tag && tag.type);
            const existing = tagVariables.get(tagId);
            if (existing) { continue; }   // already published (refresh pass)

            try {
                        const variable = addTagVariable(opcua, deviceFolder, deviceId, tagId, tagName, opcuaType);
                tagVariables.set(tagId, { variable: variable, opcuaType: opcuaType, tag: tag, deviceId: deviceId });
                // Seed the first value now that the entry exists.
                publishTag(opcua, tagId, readTagRaw(tagId), null, null);
                created++;
            } catch (err) {
                skipped++;
                logger.warn(`opcua-server: tag '${tagId}' not published: ${err.message}`);
            }
        }
    }
    logger.info(`opcua-server: address space — ${created} tag variable(s) published, ${skipped} skipped`);
}

function addTagVariable(opcua, folder, deviceId, tagId, tagName, opcuaType) {
    const writable = cfg().writeEnabled === true;
    const variable = namespace.addVariable({
        componentOf: folder,
        browseName: tagName,
        // Identity = <device id>.<tag id>. The tag NAME is display-only and is 
        // deliberately NOT part of the path: a rename must not change the NodeId.
        nodeId: nodeIdFor(nodePath(folder, stableSeg(tagId))),
        displayName: tagName,
        description: tagId,
        dataType: opcuaType,
        accessLevel: writable ? ACCESS_READ_WRITE : ACCESS_READ,
        userAccessLevel: writable ? ACCESS_READ_WRITE : ACCESS_READ,
        minimumSamplingInterval: 100,
        // No `get`: in this node-opcua version a bound getter makes the variable
        // ignore setValueFromSource, which would silently break every client
        // subscription. The internal value is therefore the single source of
        // truth, kept current by publishTag() (at bind, on change events, and by
        // the scan timer).
        //
        // `value` is omitted entirely for read-only tags: passing
        // `{ set: undefined }` is rejected by the library.
        value: writable ? { set: (variant) => writeTagValue(tagId, variant) } : undefined
    });
    return variable;
}

/** Read the raw device value for a tag (no type handling). */
function readTagRaw(tagId) {
    try {
        const v = runtime.devices.getTagValue(tagId, true);
        if (v && typeof v === 'object') { return v.value !== undefined ? v.value : null; }
        return v === undefined ? null : v;
    } catch (err) {
        return null;
    }
}

/** OPC UA write -> device layer. Only reachable when writeEnabled is true. */
function writeTagValue(tagId, variant) {
    const entry = tagVariables.get(tagId);
    const targetType = entry ? entry.opcuaType : null;
    let value = variant && variant.value !== undefined ? variant.value : null;
    if (targetType && datatype.isNumericType(targetType) && typeof value === 'boolean') {
        value = value ? 1 : 0;
    }
    try {
        runtime.devices.setTagValue(tagId, value);
        logger.info(`opcua-server: client wrote ${tagId} = ${JSON.stringify(value)}`);
    } catch (err) {
        logger.error(`opcua-server: write ${tagId} failed: ${err.message}`);
        throw err;
    }
}

function buildCamerasTree(opcua, root) {
    const camerasFolder = ensureFolder(root, displaySeg('Cameras'));
    const aiFolder = ensureFolder(root, displaySeg('Ai'));
    cameraVariables.set('__folders', { cameras: camerasFolder, ai: aiFolder, opcua: opcua });
}

/**
 * Add/replace the per-camera variables. Cameras are created and deleted at
 * runtime, so this runs on every poll: existing variables are reused (keeping
 * client subscriptions alive) and new ones are added.
 */
async function refreshCameras() {
    const folders = cameraVariables.get('__folders');
    if (!folders || !namespace) { return; }
    const opcua = folders.opcua;

    let cameras = [];
    try {
        cameras = await runtime.cameraStorage.getCameras();
    } catch (err) {
        return;
    }

    for (const cam of (cameras || [])) {
        // Camera identity is cam.id; cam.name is display-only.
        const name = safeSeg(cam.name || cam.id, cam.id);
        const key = cam.id;
        const existing = cameraVariables.get(key);
        if (existing) { continue; }

        const camFolder = ensureFolder(folders.cameras, [stableSeg(cam.id), nameSeg(name)], name);
        const aiCamFolder = ensureFolder(folders.ai, [stableSeg(cam.id), nameSeg(name)], name);
        const vars = {
            online: addBoolVariable(opcua, camFolder, 'Online', (camId) => cameraOnline(camId), cam.id),
            aiEnabled: addBoolVariable(opcua, camFolder, 'AiEnabled', () => cam.aiEnabled === true, cam.id),
            alarm: addBoolVariable(opcua, aiCamFolder, 'Alarm', (camId) => aiAlarm(camId), cam.id),
            detections: addCountVariable(opcua, aiCamFolder, 'Detections', (camId) => aiDetectionCount(camId), cam.id)
        };
        cameraVariables.set(key, { camera: cam, variables: vars });
    }

    // Forget removed cameras so their variables stop being refreshed.
    const liveIds = new Set((cameras || []).map(c => c.id));
    for (const key of Array.from(cameraVariables.keys())) {
        if (key === '__folders') { continue; }
        if (!liveIds.has(key)) { cameraVariables.delete(key); }
    }
}

function addBoolVariable(opcua, folder, browseName, getter, cameraId) {
    return namespace.addVariable({
        componentOf: folder,
        browseName: browseName,
        nodeId: nodeIdFor(nodePath(folder, fixedSeg(browseName))),
        dataType: 'Boolean',
        accessLevel: ACCESS_READ,
        userAccessLevel: ACCESS_READ,
        minimumSamplingInterval: 500,
        value: {
            get: () => new opcua.Variant({ dataType: opcua.DataType.Boolean, value: !!getter(cameraId) })
        }
    });
}

function addCountVariable(opcua, folder, browseName, getter, cameraId) {
    return namespace.addVariable({
        componentOf: folder,
        browseName: browseName,
        nodeId: nodeIdFor(nodePath(folder, fixedSeg(browseName))),
        dataType: 'UInt32',
        accessLevel: ACCESS_READ,
        userAccessLevel: ACCESS_READ,
        minimumSamplingInterval: 500,
        value: {
            get: () => new opcua.Variant({ dataType: opcua.DataType.UInt32, value: Number(getter(cameraId)) || 0 })
        }
    });
}

function cameraOnline(cameraId) {
    try {
        const s = runtime.cameraFusion.getStatus();
        const rec = s && s[cameraId];
        return !!(rec && rec.online);
    } catch (err) {
        return false;
    }
}

function aiAlarm(cameraId) {
    try {
        const svc = runtime.cameraAi && runtime.cameraAi.service;
        if (!svc) { return false; }
        // "Alarm" for a camera means at least one live detection box on it.
        const live = svc.getDetections(cameraId);
        return !!live && live.detections && live.detections.length > 0;
    } catch (err) {
        return false;
    }
}

function aiDetectionCount(cameraId) {
    try {
        const svc = runtime.cameraAi && runtime.cameraAi.service;
        if (!svc) { return 0; }
        const live = svc.getDetections(cameraId);
        return (live && live.detections) ? live.detections.length : 0;
    } catch (err) {
        return 0;
    }
}

// ------------------------------------------------------------------ updates

var unsubscribeTagChanges = null;

/**
 * Publish a tag value to the address space, remembering what was published.
 * Only real changes are pushed: re-publishing an unchanged value every poll
 * would flood every client subscription for no reason.
 */
function publishTag(opcua, tagId, value, statusCode, timestamp) {
    const entry = tagVariables.get(tagId);
    if (!entry || !entry.variable) { return false; }

    const coerced = datatype.coerce(value, entry.opcuaType);
    const bad = !coerced.ok;
    const effectiveStatus = bad ? opcua.StatusCodes.BadWaitingForInitialData : opcua.StatusCodes.Good;
    const next = bad ? null : coerced.value;

    if (entry.published === true && entry.lastStatus === effectiveStatus &&
        sameValue(entry.lastValue, next)) {
        return false;
    }
    entry.published = true;
    entry.lastValue = next;
    entry.lastStatus = effectiveStatus;

    try {
        entry.variable.setValueFromSource(
            new opcua.Variant({ dataType: bad ? opcua.DataType.Null : entry.opcuaType, value: next }),
            effectiveStatus,
            timestamp ? new Date(timestamp) : new Date());
        return true;
    } catch (err) {
        logger.warn(`opcua-server: cannot push tag ${tagId}: ${err.message}`);
        return false;
    }
}

function sameValue(a, b) {
    if (a === b) { return true; }
    if (typeof a === 'number' && typeof b === 'number') { return Number.isNaN(a) && Number.isNaN(b); }
    return false;
}

/**
 * Ride the existing tag-change event: the project already pushes every polled
 * change on it, so no second poll loop is needed for the common case.
 */
function subscribeTagChanges() {
    if (!runtime || !runtime.events || !runtime.events.on) { return; }
    const handler = (tag) => {
        if (!tag || !tag.id || !opcuaLib) { return; }
        publishTag(opcuaLib, tag.id, tag.value, null, tag.timestamp);
    };
    runtime.events.on('tag-value:changed', handler);
    unsubscribeTagChanges = () => runtime.events.removeListener('tag-value:changed', handler);
}

/**
 * Fallback refresh for tags whose driver does not emit change events.
 *
 * OPC UA serves reads from the server's current value, so a tag that never
 * reaches us through the event bus would otherwise be frozen at its bind-time
 * reading forever. This bounded pass re-reads every published tag and pushes
 * only the values that actually moved.
 */
async function refreshTags() {
    if (!opcuaLib) { return 0; }
    let changed = 0;
    for (const [tagId, entry] of tagVariables) {
        if (tagId === '__folders') { continue; }
        if (publishTag(opcuaLib, tagId, readTagRaw(tagId), null, null)) { changed++; }
    }
    return changed;
}

function startCameraPolling() {
    const camMs = Math.max(1000, Number(cfg().cameraPollMs) || DEFAULT_POLL_MS);
    pollTimer = setInterval(() => {
        refreshCameras().catch(err => logger.warn('opcua-server: camera refresh failed: ' + err.message));
    }, camMs);
    if (pollTimer.unref) { pollTimer.unref(); }

    // Tags are scanned more often than cameras: this is the read-freshness floor
    // for drivers that do not emit change events.
    const tagMs = Math.max(200, Number(cfg().tagPollMs) || DEFAULT_TAG_POLL_MS);
    if (tagTimer) { clearInterval(tagTimer); }
    tagTimer = setInterval(() => {
        refreshTags().catch(err => logger.warn('opcua-server: tag refresh failed: ' + err.message));
    }, tagMs);
    if (tagTimer.unref) { tagTimer.unref(); }

    // First passes immediately so a client that connects early sees real data.
    setTimeout(() => {
        refreshCameras().catch(() => {});
        refreshTags().catch(() => {});
    }, 200);
}

// ------------------------------------------------------------------- status

function status() {
    let tagCount = 0;
    for (const key of tagVariables.keys()) { if (key !== '__folders') { tagCount++; } }
    let cameraCount = 0;
    for (const key of cameraVariables.keys()) { if (key !== '__folders') { cameraCount++; } }
    return {
        enabled: isEnabled(),
        running: !!server,
        port: boundPort,
        resourcePath: cfg().endpoint || '/UA/SCADA',
        rootName: cfg().rootName || 'SCADA',
        writeEnabled: cfg().writeEnabled === true,
        allowAnonymous: cfg().allowAnonymous !== false,
        tags: tagCount,
        cameras: cameraCount
    };
}

module.exports = {
    init: init,
    stop: stop,
    status: status,
    // test seams
    __buildAddressSpace: buildAddressSpace,
    __refreshCameras: refreshCameras,
    __refreshTags: refreshTags,
    __publishTag: publishTag,
    __path: nodeIdFor,
    /** Pure identity helpers (no server required) — used by the identity tests. */
    __identity: {
        nodePath: nodePath,
        nodeIdFor: nodeIdFor,
        folderSeg: displaySeg,
        idSeg: stableSeg,
        nameSeg: nameSeg,
        fixedSeg: fixedSeg
    },
    __nodePath: nodePath,
    __displaySeg: displaySeg,
    __stableSeg: stableSeg,
    __nameSeg: nameSeg,
    __fixedSeg: fixedSeg,
    __safeName: safeName
};
