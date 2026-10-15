#!/usr/bin/env node
/**
 * 'scripts/gb28181-simulate-device': a GB28181 device simulator.
 *
 * Purpose is twofold:
 *  - commissioning: prove the platform's SIP side works before a real IPC/NVR
 *    arrives, and print exactly what the platform sends (catalog queries, PTZ
 *    commands, invites);
 *  - regression: a real device is not always on the bench.
 *
 * It speaks the register/keepalive/catalog/DeviceControl/INVITE subset:
 *
 *   node scripts/gb28181-simulate-device.js --host 127.0.0.1 --port 5060 \
 *        --device-id 34020000001320000001 --password 12345678 --channels 2
 *
 * Every received request is printed as one JSON line so it can be captured and
 * asserted from a shell.
 */

'use strict';

const dgram = require('dgram');
const path = require('path');

const sip = require(path.join(__dirname, '..', 'runtime', 'cameras', 'gb28181', 'sip-message'));

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
const platformHost = args.host || '127.0.0.1';
const platformPort = Number(args.port || 5060);
const deviceId = args['device-id'] || '34020000001320000001';
const realm = args.realm || '3402000000';
const password = args.password || '12345678';
const channelCount = Number(args.channels || 2);
const durationMs = Number(args.duration || 20000);
const keepaliveMs = Number(args.keepalive || 10000);

function log(event, data) {
    process.stdout.write(JSON.stringify(Object.assign({ ts: new Date().toISOString(), event: event }, data || {})) + '\n');
}

function channelId(i) {
    return ('3402000000132000' + String(100 + i)).slice(-20);
}

const channels = [];
for (let i = 0; i < channelCount; i++) {
    channels.push({
        id: channelId(i),
        name: '模拟通道 ' + (i + 1),
        manufacturer: 'GB-SIM',
        model: 'SIM-1',
        owner: 'Owner',
        civilCode: '340200',
        address: '模拟现场',
        parental: 0,
        parentId: deviceId,
        safetyWay: 0,
        registerWay: 1,
        secrecy: 0,
        status: 'ON',
        ptzType: 1
    });
}

const socket = dgram.createSocket('udp4');
let localPort = 0;
let cseq = 1;
let sn = 1;
let toTagReg = 'simtag1';
let platform = { address: platformHost, port: platformPort };
let challengeNonce = null;
let inviteCallId = null;
let registered = false;

function xmlDeclaration() { return '<?xml version="1.0" encoding="UTF-8"?>\r\n'; }

function catalogBody() {
    const items = channels.map(c =>
        '<Item>' +
        `<DeviceID>${c.id}</DeviceID><Name>${c.name}</Name>` +
        `<Manufacturer>${c.manufacturer}</Manufacturer><Model>${c.model}</Model>` +
        `<Owner>${c.owner}</Owner><CivilCode>${c.civilCode}</CivilCode><Address>${c.address}</Address>` +
        `<Parental>${c.parental}</Parental><ParentID>${c.parentId}</ParentID>` +
        `<SafetyWay>${c.safetyWay}</SafetyWay><RegisterWay>${c.registerWay}</RegisterWay>` +
        `<Secrecy>${c.secrecy}</Secrecy><Status>${c.status}</Status><PTZType>${c.ptzType}</PTZType>` +
        '</Item>').join('\r\n');
    return xmlDeclaration() +
        '<Response>\r\n<CmdType>Catalog</CmdType>\r\n' +
        `<SN>${sn}</SN>\r\n<DeviceID>${deviceId}</DeviceID>\r\n` +
        `<SumNum>${channels.length}</SumNum>\r\n` +
        `<DeviceList Num="${channels.length}">\r\n${items}\r\n</DeviceList>\r\n</Response>\r\n`;
}

function send(text, dest) {
    const to = dest || platform;
    const buf = Buffer.from(text, 'utf8');
    socket.send(buf, 0, buf.length, to.port, to.address, () => {});
}

function register(withAuth) {
    const uri = `sip:${realm}`;
    const extra = ['Expires: 3600'];
    if (withAuth && challengeNonce) {
        const ha1 = sip.md5(`${deviceId}:${realm}:${password}`);
        const ha2 = sip.md5(`REGISTER:${uri}`);
        const response = sip.md5(`${ha1}:${challengeNonce}:${ha2}`);
        extra.push(`Authorization: Digest username="${deviceId}", realm="${realm}", ` +
            `nonce="${challengeNonce}", uri="${uri}", response="${response}", algorithm=MD5`);
    }
    send(sip.buildRequest({
        method: 'REGISTER',
        uri: uri,
        via: { host: platformHost, port: localPort, branch: sip.newBranch(), transport: 'UDP' },
        from: { uri: `sip:${deviceId}@${realm}`, tag: 'simfrom' },
        to: { uri: `sip:${deviceId}@${realm}` },
        callId: 'sim-register-1',
        cseq: cseq++,
        contact: `sip:${deviceId}@${platformHost}:${localPort}`,
        userAgent: 'gb28181-simulator/1.0',
        headers: extra
    }));
    log('register.sent', { authenticated: !!withAuth, deviceId: deviceId, uri: uri });
}

function sendMessage(body) {
    send(sip.buildRequest({
        method: 'MESSAGE',
        uri: `sip:${args['platform-id'] || '34020000002000000001'}@${realm}`,
        via: { host: platformHost, port: localPort, branch: sip.newBranch(), transport: 'UDP' },
        from: { uri: `sip:${deviceId}@${realm}`, tag: 'simfrom' },
        to: { uri: `sip:${args['platform-id'] || '34020000002000000001'}@${realm}` },
        callId: 'sim-message-' + (sn++),
        cseq: cseq++,
        userAgent: 'gb28181-simulator/1.0',
        contentType: 'Application/MANSCDP+xml',
        body: body
    }));
}

function keepalive() {
    sendMessage(xmlDeclaration() +
        '<Notify>\r\n<CmdType>Keepalive</CmdType>\r\n' +
        `<SN>${sn++}</SN>\r\n<DeviceID>${deviceId}</DeviceID>\r\n<Status>OK</Status>\r\n</Notify>\r\n`);
    log('keepalive.sent', {});
}

function deviceInfo() {
    sendMessage(xmlDeclaration() +
        '<Response>\r\n<CmdType>DeviceInfo</CmdType>\r\n' +
        `<SN>${sn++}</SN>\r\n<DeviceID>${deviceId}</DeviceID>\r\n` +
        '<Result>OK</Result>\r\n<DeviceName>模拟国标设备</DeviceName>\r\n' +
        '<Manufacturer>GB-SIM</Manufacturer>\r\n<Model>SIM-1</Model>\r\n<Firmware>1.0.0</Firmware>\r\n' +
        '<Channel>1</Channel>\r\n</Response>\r\n');
}

const SDP = [
    'v=0',
    `o=${deviceId} 0 0 IN IP4 ${platformHost}`,
    's=Play',
    `c=IN IP4 ${platformHost}`,
    't=0 0',
    'm=video 0 RTP/AVP 96',
    'a=recvonly',
    'a=rtpmap:96 PS/90000'
].join('\r\n') + '\r\n';

socket.on('message', (buf, rinfo) => {
    let msg;
    try { msg = sip.parse(buf.toString('utf8')); } catch (err) { return; }
    platform = { address: rinfo.address, port: rinfo.port };

    if (msg.type === 'response') {
        if (msg.statusCode === 401) {
            const p = sip.params(sip.header(msg, 'www-authenticate'));
            challengeNonce = p.nonce || null;
            log('register.challenged', { realm: p.realm || null, hasNonce: !!p.nonce });
            register(true);
            return;
        }
        if (msg.statusCode === 200 && sip.header(msg, 'cseq') && /REGISTER/.test(sip.header(msg, 'cseq'))) {
            registered = true;
            log('register.ok', { cseq: sip.header(msg, 'cseq') });
        }
        return;
    }

    const method = msg.method;
    const contentType = sip.header(msg, 'content-type') || '';
    // Always answer a platform request: 200 OK with the same dialog identifiers.
    if (method !== 'ACK') {
        send(sip.buildResponse(msg, { statusCode: 200, toTag: toTagReg }));
    }

    if (method === 'MESSAGE') {
        const body = msg.body || '';
        const cmd = (/<CmdType>([^<]+)<\/CmdType>/.exec(body) || [])[1] || '';
        log('message.received', { cmdType: cmd });
        if (cmd === 'Catalog') { sendMessage(catalogBody()); log('catalog.sent', { channels: channels.length, sn: sn }); }
        else if (cmd === 'DeviceInfo') { deviceInfo(); }
        else if (cmd === 'DeviceControl') {
            const ptz = (/<PTZCmd>([^<]+)<\/PTZCmd>/.exec(body) || [])[1] || null;
            log('ptz.received', { ptzCmd: ptz, channel: (/<DeviceID>([^<]+)<\/DeviceID>/.exec(body) || [])[1] || null });
        }
        return;
    }

    if (method === 'INVITE') {
        inviteCallId = sip.header(msg, 'call-id');
        log('invite.received', {
            callId: inviteCallId,
            subject: sip.header(msg, 'subject') || null,
            sdpHasPs: /PS\/90000/.test(msg.body || ''),
            ssrc: (/y=(\d+)/.exec(msg.body || '') || [])[1] || null
        });
        send(sip.buildResponse(msg, {
            statusCode: 200, toTag: toTagReg, contentType: 'APPLICATION/SDP',
            headers: ['Contact: <sip:' + deviceId + '@' + platformHost + ':' + localPort + '>'],
            body: SDP
        }));
        log('invite.answered', {});
        return;
    }

    if (method === 'ACK') { log('ack.received', {}); return; }

    if (method === 'BYE') {
        log('bye.received', { sameDialog: sip.header(msg, 'call-id') === inviteCallId });
        return;
    }

    log('request.received', { method: method });
});

socket.bind(0, '0.0.0.0', () => {
    localPort = socket.address().port;
    log('simulator.started', {
        deviceId: deviceId, localPort: localPort,
        platform: platformHost + ':' + platformPort, channels: channels.length
    });
    register(false);
    setTimeout(keepalive, 500);
    const ka = setInterval(() => { if (registered) { keepalive(); } }, keepaliveMs);
    setTimeout(() => {
        clearInterval(ka);
        log('simulator.stopping', { registered: registered });
        socket.close();
        process.exit(0);
    }, durationMs);
});

process.on('SIGINT', () => { socket.close(); process.exit(0); });
