/**
 * 'cameras/vendor-presets': vendor URL builders for IP cameras.
 *
 * Only public, documented URL shapes are used (no vendor SDK, no binaries):
 *  - Hikvision  : RTSP Streaming/Channels + ISAPI snapshot
 *  - Dahua      : RTSP /cam/realmonitor + CGI snapshot
 *  - Uniview    : RTSP /media/videoN + CGI snapshot
 *  - ONVIF      : generic RTSP profile + generic snapshot path
 *  - custom     : operator supplied RTSP + snapshot templates
 *
 * Templates use {user} {pass} {host} {port} {channel} {subtype} {channelId}.
 */

'use strict';

const VENDORS = {
    hikvision: {
        label: '海康威视 (Hikvision)',
        defaultPort: 554,
        defaultHttpPort: 80,
        // channelId: 1 main -> 101, 2 sub -> 102
        rtsp: 'rtsp://{user}:{pass}@{host}:{port}/Streaming/Channels/{channelId}',
        snapshot: 'http://{host}:{httpPort}/ISAPI/Streaming/channels/{channelId}/picture',
        // Hikvision can serve MJPEG straight over ISAPI on many firmwares
        mjpeg: 'http://{host}:{httpPort}/ISAPI/Streaming/channels/{channelId}/httpPreview',
        channelId: (channel, subtype) => String((Number(channel) || 1) * 100 + (subtype === 1 ? 2 : 1)),
        auth: 'digest'
    },
    dahua: {
        label: '大华 (Dahua)',
        defaultPort: 554,
        defaultHttpPort: 80,
        rtsp: 'rtsp://{user}:{pass}@{host}:{port}/cam/realmonitor?channel={channel}&subtype={subtype}',
        snapshot: 'http://{host}:{httpPort}/cgi-bin/snapshot.cgi?channel={channel}',
        mjpeg: null,
        auth: 'digest',
        requireAuthInRtsp: true
    },
    uniview: {
        label: '宇视 (Uniview)',
        defaultPort: 554,
        defaultHttpPort: 80,
        // Uniview media/video1 = main, video2 = sub
        rtsp: 'rtsp://{user}:{pass}@{host}:{port}/media/video{subtypeChannel}',
        snapshot: 'http://{host}:{httpPort}/cgi-bin/snapshot.cgi?channel={channel}',
        mjpeg: null,
        auth: 'digest',
        subtypeChannel: (channel, subtype) => String((Number(channel) || 1) * 2 - (subtype === 1 ? 1 : 0))
    },
    onvif: {
        label: 'ONVIF 通用',
        defaultPort: 554,
        defaultHttpPort: 80,
        rtsp: 'rtsp://{user}:{pass}@{host}:{port}/onvif{streamIndex}',
        snapshot: 'http://{host}:{httpPort}/onvif-http/snapshot',
        mjpeg: null,
        auth: 'digest'
    },
    custom: {
        label: '自定义 (Custom)',
        defaultPort: 554,
        defaultHttpPort: 80,
        rtsp: '{rtsp}',
        snapshot: '{snapshot}',
        mjpeg: '{mjpeg}',
        auth: 'digest'
    }
};

function vendorList() {
    return Object.keys(VENDORS).map(id => ({
        id: id,
        label: VENDORS[id].label,
        defaultPort: VENDORS[id].defaultPort,
        defaultHttpPort: VENDORS[id].defaultHttpPort,
        supportsMjpeg: !!VENDORS[id].mjpeg
    }));
}

function fill(tpl, vars) {
    if (!tpl) { return null; }
    return tpl.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined && vars[key] !== null ? vars[key] : ''));
}

/** Percent-encode credentials for embedding in a URL userinfo segment. */
function enc(v) {
    return encodeURIComponent(v === undefined || v === null ? '' : String(v));
}

/**
 * Build the resolved URL set for a camera record.
 * @returns {{rtsp, snapshot, mjpeg, vendorLabel, auth}}
 */
function resolveEndpoints(camera) {
    const v = VENDORS[camera.vendor] || VENDORS.custom;
    const channel = Number(camera.channel) || 1;
    const subtype = Number(camera.subtype) === 1 ? 1 : 0;
    const channelId = v.channelId ? v.channelId(channel, subtype) : String(channel);

    const vars = {
        user: enc(camera.username),
        pass: enc(camera.password),
        host: camera.host,
        port: camera.port || v.defaultPort,
        httpPort: camera.httpPort || v.defaultHttpPort,
        channel: channel,
        subtype: subtype,
        channelId: channelId,
        subtypeChannel: v.subtypeChannel ? v.subtypeChannel(channel, subtype) : String(channel),
        streamIndex: subtype === 1 ? '2' : '1',
        rtsp: camera.rtspTemplate || '',
        snapshot: camera.snapshotTemplate || '',
        mjpeg: camera.mjpegTemplate || ''
    };

    return {
        vendorLabel: v.label,
        auth: camera.auth || v.auth || 'digest',
        rtsp: fill(v.rtsp, vars),
        snapshot: fill(v.snapshot, vars),
        mjpeg: fill(v.mjpeg, vars)
    };
}

module.exports = {
    VENDORS: VENDORS,
    vendorList: vendorList,
    resolveEndpoints: resolveEndpoints
};
