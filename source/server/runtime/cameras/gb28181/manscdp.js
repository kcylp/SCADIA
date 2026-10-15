/**
 * 'cameras/gb28181/manscdp': MANSCDP XML — the GB28181 device-control body
 * format carried inside SIP MESSAGE (GB/T 28181-2016 §9.2, 附录 A).
 *
 * Platform -> device:  <Query> Catalog / DeviceInfo / DeviceStatus
 *                      <Control> DeviceControl (PTZCmd / FIcmd)
 * Device -> platform:  <Response> Catalog / DeviceInfo / DeviceStatus
 *                      <Notify> Keepalive / Alarm / MediaStatus
 *
 * The XML subset is small and fully specified, so it is parsed here directly
 * instead of pulling in a generic XML library: a MANSCDP body is element-only,
 * and the parser must preserve element-name case (a generic library that
 * normalises names silently breaks `<Response>` vs `<Notify>` dispatch).
 */

'use strict';

const charsetUtil = require('./charset');

/**
 * Front-end (PTZ) command bits, GB/T 28181-2016 附录 A.2 前端控制设备控制命令.
 * Directions combine by OR (e.g. leftUp = left | up).
 */
const PTZ_BITS = {
    stop: 0x00,
    right: 0x01,
    left: 0x02,
    down: 0x04,
    up: 0x08,
    zoomIn: 0x10,
    zoomOut: 0x20
};

/** Preset / cruise / scan commands, GB/T 28181-2016 附录 A.2 预置位等指令. */
const FI_CODES = {
    presetSet: 0x81,
    presetGoto: 0x82,
    presetDelete: 0x83,
    cruiseSet: 0x84,
    cruiseGoto: 0x85,
    cruiseDelete: 0x86
};

const PTZ_SPEED_DEFAULT = 0xFF;
/** Below 16 the wire nibble rounds to 0 and devices simply do not move. */
const ZOOM_SPEED_MIN = 16;
const ZOOM_SPEED_DEFAULT = 0x10;

function num(v) {
    if (v === undefined || v === null || v === '') { return null; }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function esc(v) {
    return String(v === undefined || v === null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function clampByte(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) { return 0; }
    return Math.max(0, Math.min(255, n));
}

// -------------------------------------------------------------- XML parsing

/**
 * Minimal, dependency-free XML reader for MANSCDP documents.
 * @param {string} text
 * @returns {{name:string, attrs:Object, children:Array, text:string}} root node
 */
function parseXml(text) {
    if (typeof text !== 'string' || !text.length) { throw new Error('empty XML'); }
    const n = text.length;
    let i = 0;

    function skipMisc() {
        for (;;) {
            while (i < n && /\s/.test(text[i])) { i++; }
            if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i); i = e < 0 ? n : e + 2; continue; }
            if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
            if (text.startsWith('<!', i)) { const e = text.indexOf('>', i); i = e < 0 ? n : e + 1; continue; }
            return;
        }
    }

    function parseElement() {
        i++;                                            // consume '<'
        const nameStart = i;
        while (i < n && !/[\s/>]/.test(text[i])) { i++; }
        const name = text.slice(nameStart, i);
        const node = { name: name, attrs: {}, children: [], text: '' };

        for (;;) {                                      // attributes / tag end
            while (i < n && /\s/.test(text[i])) { i++; }
            if (text[i] === '/') { i++; if (text[i] === '>') { i++; } return node; }
            if (text[i] === '>') { i++; break; }
            const aStart = i;
            while (i < n && !/[\s=/>]/.test(text[i])) { i++; }
            const aName = text.slice(aStart, i);
            while (i < n && /\s/.test(text[i])) { i++; }
            let aValue = '';
            if (text[i] === '=') {
                i++;
                while (i < n && /\s/.test(text[i])) { i++; }
                const quote = text[i];
                if (quote === '"' || quote === "'") {
                    i++;
                    const e = text.indexOf(quote, i);
                    aValue = text.slice(i, e < 0 ? n : e);
                    i = e < 0 ? n : e + 1;
                } else {
                    const vStart = i;
                    while (i < n && !/[\s/>]/.test(text[i])) { i++; }
                    aValue = text.slice(vStart, i);
                }
            }
            if (aName) { node.attrs[aName] = aValue; }
        }

        for (;;) {                                      // content
            if (i >= n) { break; }
            if (text.startsWith('</', i)) { const e = text.indexOf('>', i); i = e < 0 ? n : e + 1; break; }
            if (text.startsWith('<!--', i)) { const e = text.indexOf('-->', i); i = e < 0 ? n : e + 3; continue; }
            if (text.startsWith('<![CDATA[', i)) {
                const e = text.indexOf(']]>', i);
                node.text += text.slice(i + 9, e < 0 ? n : e);
                i = e < 0 ? n : e + 3;
                continue;
            }
            if (text.startsWith('<?', i)) { const e = text.indexOf('?>', i); i = e < 0 ? n : e + 2; continue; }
            if (text[i] === '<') { node.children.push(parseElement()); continue; }
            const t = text.indexOf('<', i);
            node.text += text.slice(i, t < 0 ? n : t);
            i = t < 0 ? n : t;
        }
        node.text = node.text.trim();
        return node;
    }

    skipMisc();
    if (text[i] !== '<') { throw new Error('not an XML document'); }
    const root = parseElement();
    if (!root || !root.name) { throw new Error('XML root element is missing'); }
    return root;
}

function eqName(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

function child(node, name) {
    if (!node || !node.children) { return null; }
    return node.children.find(c => eqName(c.name, name)) || null;
}

function childrenOf(node, name) {
    if (!node || !node.children) { return []; }
    return node.children.filter(c => eqName(c.name, name));
}

function childText(node, name) {
    const c = child(node, name);
    return c ? c.text : null;
}

/**
 * Parse a MANSCDP document into a flat, UI-friendly object.
 * @param {string} xml
 * @returns {{root, cmdType, sn, deviceId, status, result, errorCode, sumNum,
 *            deviceName, manufacturer, model, firmware, alarmPriority,
 *            alarmMethod, alarmType, channels:Array, tree}}
 */
function parse(xml) {
    const tree = parseXml(xml);
    const out = {
        root: tree.name,
        cmdType: childText(tree, 'CmdType'),
        sn: childText(tree, 'SN'),
        deviceId: childText(tree, 'DeviceID'),
        status: childText(tree, 'Status'),
        result: childText(tree, 'Result'),
        errorCode: num(childText(tree, 'ErrorCode')),
        sumNum: num(childText(tree, 'SumNum')),
        deviceName: childText(tree, 'DeviceName') || childText(tree, 'Name'),
        manufacturer: childText(tree, 'Manufacturer'),
        model: childText(tree, 'Model'),
        firmware: childText(tree, 'Firmware'),
        alarmPriority: childText(tree, 'AlarmPriority'),
        alarmMethod: childText(tree, 'AlarmMethod'),
        alarmType: childText(tree, 'AlarmType'),
        channels: [],
        tree: tree
    };

    // A large catalog may be split over several <DeviceList> blocks.
    for (const list of childrenOf(tree, 'DeviceList')) {
        for (const item of childrenOf(list, 'Item')) {
            out.channels.push({
                id: childText(item, 'DeviceID'),
                name: childText(item, 'Name'),
                manufacturer: childText(item, 'Manufacturer'),
                model: childText(item, 'Model'),
                owner: childText(item, 'Owner'),
                civilCode: childText(item, 'CivilCode'),
                address: childText(item, 'Address'),
                parental: num(childText(item, 'Parental')),
                parentId: childText(item, 'ParentID'),
                safetyWay: num(childText(item, 'SafetyWay')),
                registerWay: num(childText(item, 'RegisterWay')),
                secrecy: num(childText(item, 'Secrecy')),
                status: childText(item, 'Status'),
                ptzType: num(childText(item, 'PTZType')) || 0
            });
        }
    }
    return out;
}

// ---------------------------------------------------------------- PTZ bytes

/**
 * Encode a front-end control command to the 8-byte GB28181 PTZCmd hex string.
 * Byte layout: A5 0F 01 <cmdCode> <param1> <param2> <combineCode2<<4> <checksum>
 * @returns {string} 16 uppercase hex characters
 */
function encodePtzCommand(cmdCode, moveSpeed, zoomSpeed) {
    const code = clampByte(cmdCode);
    const move = moveSpeed === undefined || moveSpeed === null
        ? PTZ_SPEED_DEFAULT : clampByte(moveSpeed);
    let zoom = zoomSpeed === undefined || zoomSpeed === null
        ? ZOOM_SPEED_DEFAULT : clampByte(zoomSpeed);
    if (zoom > 0 && zoom < ZOOM_SPEED_MIN) { zoom = ZOOM_SPEED_MIN; }

    const bytes = [0xA5, 0x0F, 0x01, code, move, move, zoom & 0xF0];
    bytes.push(bytes.reduce((a, b) => a + b, 0) % 0x100);
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** Map a UI/API direction (up/down/left/right/leftUp/zoomIn/...) to a PTZCmd. */
function ptzCommandFor(action, options) {
    const a = String(action || 'stop');
    const opts = options || {};
    let bits;
    switch (a) {
        case 'stop': bits = PTZ_BITS.stop; break;
        case 'up': bits = PTZ_BITS.up; break;
        case 'down': bits = PTZ_BITS.down; break;
        case 'left': bits = PTZ_BITS.left; break;
        case 'right': bits = PTZ_BITS.right; break;
        case 'leftUp': bits = PTZ_BITS.left | PTZ_BITS.up; break;
        case 'rightUp': bits = PTZ_BITS.right | PTZ_BITS.up; break;
        case 'leftDown': bits = PTZ_BITS.left | PTZ_BITS.down; break;
        case 'rightDown': bits = PTZ_BITS.right | PTZ_BITS.down; break;
        case 'zoomIn': bits = PTZ_BITS.zoomIn; break;
        case 'zoomOut': bits = PTZ_BITS.zoomOut; break;
        default: bits = PTZ_BITS.stop; break;
    }
    // speed 1..100 (UI) -> 0..255 (wire); the zoom rate rides the high nibble
    const speed = opts.speed === undefined || opts.speed === null ? null : opts.speed;
    const move = speed === null ? undefined : clampByte((Number(speed) / 100) * 255);
    const zoom = speed === null ? undefined : clampByte((Number(speed) / 100) * 255);
    return encodePtzCommand(bits, move, zoom);
}

/**
 * Encode a preset / cruise / scan (FI) command.
 * Same 8-byte envelope as PTZ, with 数据1 = the preset/cruise index.
 */
function encodeFiCommand(op, index) {
    const code = FI_CODES[op];
    if (code === undefined) {
        const err = new Error('unknown FI command: ' + op);
        err.code = 'GB_VALIDATION_ERROR';
        throw err;
    }
    const bytes = [0xA5, 0x0F, 0x01, code & 0xFF, clampByte(index), 0x00, 0x00];
    bytes.push(bytes.reduce((a, b) => a + b, 0) % 0x100);
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// --------------------------------------------------------------- building

function declaration(charsetLabel) {
    return `<?xml version="1.0" encoding="${charsetUtil.normaliseLabel(charsetLabel)}"?>\r\n`;
}

function catalogQuery(deviceId, sn, charsetLabel) {
    return declaration(charsetLabel) +
        '<Query>\r\n' +
        '<CmdType>Catalog</CmdType>\r\n' +
        `<SN>${esc(sn)}</SN>\r\n` +
        `<DeviceID>${esc(deviceId)}</DeviceID>\r\n` +
        '</Query>\r\n';
}

function deviceInfoQuery(deviceId, sn, charsetLabel) {
    return declaration(charsetLabel) +
        '<Query>\r\n' +
        '<CmdType>DeviceInfo</CmdType>\r\n' +
        `<SN>${esc(sn)}</SN>\r\n` +
        `<DeviceID>${esc(deviceId)}</DeviceID>\r\n` +
        '</Query>\r\n';
}

function deviceStatusQuery(deviceId, sn, charsetLabel) {
    return declaration(charsetLabel) +
        '<Query>\r\n' +
        '<CmdType>DeviceStatus</CmdType>\r\n' +
        `<SN>${esc(sn)}</SN>\r\n` +
        `<DeviceID>${esc(deviceId)}</DeviceID>\r\n` +
        '</Query>\r\n';
}

/**
 * DeviceControl with a PTZCmd. `ptzCmd` is the hex string from
 * encodePtzCommand()/ptzCommandFor().
 */
function deviceControlPtz(channelId, sn, ptzCmd, charsetLabel) {
    return declaration(charsetLabel) +
        '<Control>\r\n' +
        '<CmdType>DeviceControl</CmdType>\r\n' +
        `<SN>${esc(sn)}</SN>\r\n` +
        `<DeviceID>${esc(channelId)}</DeviceID>\r\n` +
        `<PTZCmd>${esc(ptzCmd)}</PTZCmd>\r\n` +
        '<Info>\r\n' +
        '<ControlPriority>5</ControlPriority>\r\n' +
        '</Info>\r\n' +
        '</Control>\r\n';
}

function deviceControlFi(channelId, sn, fiCmd, charsetLabel) {
    return declaration(charsetLabel) +
        '<Control>\r\n' +
        '<CmdType>DeviceControl</CmdType>\r\n' +
        `<SN>${esc(sn)}</SN>\r\n` +
        `<DeviceID>${esc(channelId)}</DeviceID>\r\n` +
        `<FIcmd>${esc(fiCmd)}</FIcmd>\r\n` +
        '<Info>\r\n' +
        '<ControlPriority>5</ControlPriority>\r\n' +
        '</Info>\r\n' +
        '</Control>\r\n';
}

module.exports = {
    PTZ_BITS: PTZ_BITS,
    FI_CODES: FI_CODES,
    parseXml: parseXml,
    parse: parse,
    esc: esc,
    encodePtzCommand: encodePtzCommand,
    ptzCommandFor: ptzCommandFor,
    encodeFiCommand: encodeFiCommand,
    catalogQuery: catalogQuery,
    deviceInfoQuery: deviceInfoQuery,
    deviceStatusQuery: deviceStatusQuery,
    deviceControlPtz: deviceControlPtz,
    deviceControlFi: deviceControlFi,
    declaration: declaration
};
