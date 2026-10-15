/**
 * GB28181 (国标) tests.
 *
 * Two layers:
 *   1. pure protocol units — SIP codec, digest, MANSCDP XML, PTZ byte layout
 *   2. a real end-to-end run: a full GB28181 device simulator talks to the
 *      service over loopback UDP (REGISTER 401 -> digest REGISTER 200 ->
 *      keepalive -> catalog -> PTZ -> INVITE/ACK -> BYE).
 *
 * The E2E deliberately goes over real sockets: SIP is where signallers usually
 * break, and a mocked socket would hide exactly the bugs worth catching.
 */

'use strict';

const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sip = require('../../runtime/cameras/gb28181/sip-message');
const manscdp = require('../../runtime/cameras/gb28181/manscdp');
const charsetUtil = require('../../runtime/cameras/gb28181/charset');
const media = require('../../runtime/cameras/media-gateway');
const service = require('../../runtime/cameras/gb28181/gb28181-service');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const DEVICE_ID = '34020000001320000001';
const CH1 = '34020000001320000101';
const CH2 = '34020000001320000102';
const REALM = '3402000000';
const SIP_ID = '34020000002000000001';
const PASSWORD = '12345678';

function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 2000);
    return new Promise((resolve, reject) => {
        const tick = () => {
            Promise.resolve()
                .then(() => predicate())
                .then((ok) => {
                    if (ok) { resolve(true); return; }
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition'))); return; }
                    setTimeout(tick, 10);
                })
                .catch((err) => {
                    if (Date.now() > deadline) {
                        reject(new Error('timed out waiting for ' + (label || 'condition') + ': ' + err.message));
                        return;
                    }
                    setTimeout(tick, 10);
                });
        };
        tick();
    });
}

// ------------------------------------------------------------ protocol units

describe('GB28181 SIP codec', () => {

    it('parses a REGISTER request with headers and folded values', () => {
        const text = [
            'REGISTER sip:3402000000 SIP/2.0',
            'Via: SIP/2.0/UDP 10.0.0.5:5060;rport;branch=z9hG4bK1',
            'From: <sip:34020000001320000001@3402000000>;tag=abc',
            'To: <sip:34020000001320000001@3402000000>',
            'Call-ID: call-1',
            'CSeq: 1 REGISTER',
            'Contact: <sip:34020000001320000001@10.0.0.5:5060>',
            'Expires: 3600',
            'Content-Length: 0',
            '',
            ''
        ].join('\r\n');

        const msg = sip.parse(text);
        assert.strictEqual(msg.type, 'request');
        assert.strictEqual(msg.method, 'REGISTER');
        assert.strictEqual(msg.uri, 'sip:3402000000');
        assert.strictEqual(sip.header(msg, 'call-id'), 'call-1');
        assert.strictEqual(sip.addressUser(sip.header(msg, 'from')), DEVICE_ID);
        const hp = sip.addressHostPort(sip.header(msg, 'contact'));
        assert.deepStrictEqual(hp, { host: '10.0.0.5', port: 5060 });
    });

    it('parses a response and its 3-digit status code', () => {
        const msg = sip.parse('SIP/2.0 401 Unauthorized\r\nCSeq: 1 REGISTER\r\n\r\n');
        assert.strictEqual(msg.type, 'response');
        assert.strictEqual(msg.statusCode, 401);
        assert.strictEqual(msg.reason, 'Unauthorized');
    });

    it('extracts header parameters (nonce, tag) with quotes stripped', () => {
        const p = sip.params('Digest realm="3402000000", qop="auth", nonce="deadbeef"');
        assert.strictEqual(p.realm, '3402000000');
        assert.strictEqual(p.qop, 'auth');
        assert.strictEqual(p.nonce, 'deadbeef');
        assert.strictEqual(sip.params('<sip:a@b>;tag=xyz').tag, 'xyz');
    });

    it('builds a response that echoes Via/From/Call-ID/CSeq and adds a To tag', () => {
        const req = sip.parse([
            'MESSAGE sip:x@1.2.3.4:5060 SIP/2.0',
            'Via: SIP/2.0/UDP 1.2.3.4:5060;rport;branch=z9hG4bK9',
            'From: <sip:x@d>;tag=f1',
            'To: <sip:x@d>',
            'Call-ID: c9',
            'CSeq: 7 MESSAGE',
            'Content-Length: 0',
            '', ''
        ].join('\r\n'));
        const res = sip.parse(sip.buildResponse(req, { statusCode: 200, toTag: 'ours' }));
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(sip.header(res, 'call-id'), 'c9');
        assert.strictEqual(sip.header(res, 'cseq'), '7 MESSAGE');
        assert.ok(/branch=z9hG4bK9/.test(sip.header(res, 'via')));
        assert.ok(/;tag=ours/.test(sip.header(res, 'to')));
    });

    it('verifies a no-qop digest and rejects a wrong password', () => {
        const nonce = 'abc123';
        const uri = `sip:${REALM}`;
        const ha1 = sip.md5(`${DEVICE_ID}:${REALM}:${PASSWORD}`);
        const ha2 = sip.md5(`REGISTER:${uri}`);
        const response = sip.md5(`${ha1}:${nonce}:${ha2}`);
        const text = [
            'REGISTER sip:3402000000 SIP/2.0',
            `Authorization: Digest username="${DEVICE_ID}", realm="${REALM}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`,
            'Call-ID: c1',
            'CSeq: 2 REGISTER',
            'Content-Length: 0',
            '', ''
        ].join('\r\n');
        const req = sip.parse(text);
        assert.strictEqual(sip.verifyDigest(req, PASSWORD), true);
        assert.strictEqual(sip.verifyDigest(req, 'wrong-password'), false);
        assert.strictEqual(sip.verifyDigest(sip.parse(text.replace('Authorization:', 'X-Auth:')), PASSWORD), false);
    });

    it('verifies a qop=auth digest (RFC 2617 with nc/cnonce)', () => {
        const nonce = 'n1', cnonce = 'c1', nc = '00000001', qop = 'auth';
        const uri = `sip:${REALM}`;
        const ha1 = sip.md5(`${DEVICE_ID}:${REALM}:${PASSWORD}`);
        const ha2 = sip.md5(`REGISTER:${uri}`);
        const response = sip.md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
        const text = [
            'REGISTER sip:3402000000 SIP/2.0',
            `Authorization: Digest username="${DEVICE_ID}", realm="${REALM}", nonce="${nonce}", uri="${uri}", response="${response}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"`,
            'Call-ID: c2', 'CSeq: 3 REGISTER', 'Content-Length: 0', '', ''
        ].join('\r\n');
        assert.strictEqual(sip.verifyDigest(sip.parse(text), PASSWORD), true);
    });
});

describe('GB28181 PTZ command encoding', () => {

    it('matches the production byte layout (A5 0F 01 cmd p1 p2 p3 checksum)', () => {
        // 0x02 = down, speed 0xFF, zoom nibble 0x10 -> checksum 0xC5
        assert.strictEqual(manscdp.encodePtzCommand(0x02, 0xFF, 0x10), 'A50F0102FFFF10C5');
    });

    it('maps directions and applies the default speed', () => {
        // up = 0x08, default speed 0xFF, default zoom nibble 0x10
        assert.strictEqual(manscdp.ptzCommandFor('up'), 'A50F0108FFFF10CB');
        // combined diagonals OR the bits (left 0x02 | up 0x08 = 0x0A)
        assert.strictEqual(manscdp.ptzCommandFor('leftUp'), 'A50F010AFFFF10CD');
        assert.strictEqual(manscdp.ptzCommandFor('stop'), 'A50F0100FFFF10C3');
    });

    it('scales a 1..100 UI speed onto the 0..255 wire value', () => {
        const slow = manscdp.ptzCommandFor('up', { speed: 1 });
        const fast = manscdp.ptzCommandFor('up', { speed: 100 });
        assert.ok(/^A50F0108/.test(slow) && /^A50F0108/.test(fast));
        assert.notStrictEqual(slow, fast);
        assert.strictEqual(fast.slice(8, 12), 'FFFF');
    });

    it('encodes FI (preset) commands with the index in data1', () => {
        assert.strictEqual(manscdp.encodeFiCommand('presetGoto', 3), 'A50F01820300003A');
        assert.throws(() => manscdp.encodeFiCommand('nope', 1), /unknown FI command/);
    });
});

describe('GB28181 MANSCDP XML', () => {

    const CATALOG = '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
        '<Response>\r\n<CmdType>Catalog</CmdType>\r\n<SN>2</SN>\r\n<DeviceID>' + DEVICE_ID + '</DeviceID>\r\n' +
        '<SumNum>2</SumNum>\r\n<DeviceList Num="2">\r\n' +
        '<Item><DeviceID>' + CH1 + '</DeviceID><Name>采区A 皮带机</Name><Manufacturer>Hikvision</Manufacturer>' +
        '<Model>DS-2CD</Model><Owner>矿方</Owner><CivilCode>340200</CivilCode><Address>主井</Address>' +
        '<Parental>0</Parental><ParentID>' + DEVICE_ID + '</ParentID><SafetyWay>0</SafetyWay><RegisterWay>1</RegisterWay>' +
        '<Secrecy>0</Secrecy><Status>ON</Status><PTZType>1</PTZType></Item>\r\n' +
        '<Item><DeviceID>' + CH2 + '</DeviceID><Name>副井口</Name><Status>OFF</Status></Item>\r\n' +
        '</DeviceList>\r\n</Response>\r\n';

    it('flattens a Catalog response into channels', async () => {
        const doc = await manscdp.parse(CATALOG);
        assert.strictEqual(doc.root, 'Response');
        assert.strictEqual(doc.cmdType, 'Catalog');
        assert.strictEqual(doc.sn, '2');
        assert.strictEqual(doc.sumNum, 2);
        assert.strictEqual(doc.channels.length, 2);
        assert.strictEqual(doc.channels[0].id, CH1);
        assert.strictEqual(doc.channels[0].name, '采区A 皮带机');
        assert.strictEqual(doc.channels[0].ptzType, 1);
        assert.strictEqual(doc.channels[1].status, 'OFF');
    });

    it('parses a Keepalive notify', async () => {
        const doc = await manscdp.parse('<?xml version="1.0"?><Notify><CmdType>Keepalive</CmdType>' +
            '<SN>5</SN><DeviceID>' + DEVICE_ID + '</DeviceID><Status>OK</Status></Notify>');
        assert.strictEqual(doc.root, 'Notify');
        assert.strictEqual(doc.cmdType, 'Keepalive');
        assert.strictEqual(doc.status, 'OK');
    });

    it('builds platform queries and device control bodies', () => {
        const q = manscdp.catalogQuery(DEVICE_ID, 7, 'GB2312');
        assert.ok(q.indexOf('<?xml version="1.0" encoding="GB2312"?>') === 0);
        assert.ok(q.includes('<CmdType>Catalog</CmdType>') && q.includes('<SN>7</SN>'));
        const c = manscdp.deviceControlPtz(CH1, 8, 'A50F0108FFFF10CB', 'UTF-8');
        assert.ok(c.includes('<CmdType>DeviceControl</CmdType>'));
        assert.ok(c.includes('<DeviceID>' + CH1 + '</DeviceID>'));
        assert.ok(c.includes('<PTZCmd>A50F0108FFFF10CB</PTZCmd>'));
        assert.ok(c.includes('<ControlPriority>5</ControlPriority>'));
    });
});

describe('GB28181 charset detection', () => {

    it('decodes a UTF-8 declared body with Chinese intact', () => {
        const xml = '<?xml version="1.0" encoding="UTF-8"?><Notify><Name>采区A 皮带机</Name></Notify>';
        const dec = charsetUtil.decodeXml(Buffer.from(xml, 'utf8'));
        assert.strictEqual(dec.charset, 'utf-8');
        assert.ok(dec.text.includes('采区A 皮带机'));
    });

    it('routes a GB2312 declaration to the gb18030 decoder when available', () => {
        const buf = Buffer.from('<?xml version="1.0" encoding="GB2312"?><Notify/>', 'latin1');
        const dec = charsetUtil.decodeXml(buf);
        if (charsetUtil.supports('gb18030')) {
            assert.strictEqual(dec.charset, 'gb18030');
        } else {
            assert.strictEqual(dec.charset, 'utf-8'); // documented graceful fallback
        }
    });
});

// ------------------------------------------------------- end-to-end over UDP

function memoryStorage() {
    const devices = new Map();
    const channels = new Map();
    return {
        getGbDevice: async (id) => devices.get(id) || null,
        saveGbDevice: async (d) => {
            devices.set(d.deviceId, Object.assign({}, devices.get(d.deviceId) || {}, d));
            return devices.get(d.deviceId);
        },
        getGbDevices: async () => Array.from(devices.values()),
        markGbDevicesOffline: async () => { devices.forEach(d => { d.online = false; }); },
        deleteGbDevice: async (id) => { devices.delete(id); channels.delete(id); return { changes: 1 }; },
        replaceGbChannels: async (id, list) => {
            channels.set(id, list || []);
            const d = devices.get(id);
            if (d) { d.channelCount = (list || []).length; }
            return (list || []).length;
        },
        getGbChannels: async (id) => channels.get(id) || [],
        getGbChannel: async (id, cid) => (channels.get(id) || []).find(c => c.id === cid) || null,
        getAllGbChannels: async () => {
            const out = [];
            channels.forEach((list, deviceId) => list.forEach(c => out.push(Object.assign({ deviceId: deviceId }, c))));
            return out;
        }
    };
}

/** A GB28181 device simulator: registers, keeps alive, answers catalog/PTZ/INVITE/BYE. */
function createDeviceSim() {
    const sock = dgram.createSocket('udp4');
    const state = {
        self: { host: '127.0.0.1', port: 0 },
        platform: null,
        challenges: 0,
        lastNonce: null,
        registerOk: 0,
        keepalives: 0,
        catalogQueries: 0,
        deviceInfoQueries: 0,
        controls: [],
        invites: 0,
        inviteCallId: null,
        inviteSdp: null,
        acks: 0,
        byes: 0,
        byeCallId: null
    };
    let cseq = 10;

    function send(text, dest) {
        const to = dest || state.platform;
        if (!to) { return Promise.reject(new Error('device has no platform address yet')); }
        const buf = Buffer.from(text, 'utf8');
        return new Promise((resolve, reject) => {
            sock.send(buf, 0, buf.length, to.port, to.address, err => err ? reject(err) : resolve());
        });
    }

    function register(auth) {
        const uri = `sip:${REALM}`;
        const headers = ['Expires: 3600'];
        if (auth) {
            const ha1 = sip.md5(`${DEVICE_ID}:${REALM}:${PASSWORD}`);
            const ha2 = sip.md5(`REGISTER:${uri}`);
            const response = sip.md5(`${ha1}:${auth.nonce}:${ha2}`);
            headers.push(`Authorization: Digest username="${DEVICE_ID}", realm="${REALM}", nonce="${auth.nonce}", ` +
                `uri="${uri}", response="${response}", algorithm=MD5`);
        }
        return send(sip.buildRequest({
            method: 'REGISTER',
            uri: uri,
            via: { host: state.self.host, port: state.self.port, branch: sip.newBranch() },
            from: { uri: `sip:${DEVICE_ID}@${REALM}`, tag: 'devtag' },
            to: { uri: `sip:${DEVICE_ID}@${REALM}` },
            callId: 'dev-call-1',
            cseq: cseq++,
            contact: `sip:${DEVICE_ID}@${state.self.host}:${state.self.port}`,
            userAgent: 'gb28181-test-device',
            headers: headers
        }));
    }

    function keepalive() {
        return send(messageBody('Keepalive',
            '<Notify><CmdType>Keepalive</CmdType><SN>1</SN><DeviceID>' + DEVICE_ID + '</DeviceID><Status>OK</Status></Notify>'));
    }

    function catalogResponse() {
        const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Response><CmdType>Catalog</CmdType><SN>2</SN><DeviceID>' + DEVICE_ID + '</DeviceID>' +
            '<SumNum>2</SumNum><DeviceList Num="2">' +
            '<Item><DeviceID>' + CH1 + '</DeviceID><Name>采区A 皮带机</Name><Manufacturer>Hikvision</Manufacturer>' +
            '<Model>DS-2CD</Model><Owner>矿方</Owner><CivilCode>340200</CivilCode><Address>主井</Address>' +
            '<Parental>0</Parental><ParentID>' + DEVICE_ID + '</ParentID><SafetyWay>0</SafetyWay>' +
            '<RegisterWay>1</RegisterWay><Secrecy>0</Secrecy><Status>ON</Status><PTZType>1</PTZType></Item>' +
            '<Item><DeviceID>' + CH2 + '</DeviceID><Name>副井口</Name><Status>OFF</Status></Item>' +
            '</DeviceList></Response>';
        return send(messageBody('Catalog', xml));
    }

    function messageBody(_cmdType, xml) {
        return sip.buildRequest({
            method: 'MESSAGE',
            uri: `sip:${SIP_ID}@${(state.platform && state.platform.address) || '127.0.0.1'}:${(state.platform && state.platform.port) || 5060}`,
            via: { host: state.self.host, port: state.self.port, branch: sip.newBranch() },
            from: { uri: `sip:${DEVICE_ID}@${REALM}`, tag: 'devtag' },
            to: { uri: `sip:${SIP_ID}@${REALM}` },
            callId: 'dev-call-' + (cseq++),
            cseq: cseq++,
            userAgent: 'gb28181-test-device',
            contentType: 'Application/MANSCDP+xml',
            body: xml
        });
    }

    sock.on('message', (buf, rinfo) => {
        if (!state.platform) { state.platform = { address: rinfo.address, port: rinfo.port }; }
        let msg;
        try { msg = sip.parse(buf.toString('utf8')); } catch (err) { return; }

        if (msg.type === 'response') {
            if (msg.statusCode === 401) {
                state.challenges++;
                const p = sip.params(sip.header(msg, 'www-authenticate'));
                state.lastNonce = p.nonce || null;
            } else if (msg.statusCode === 200) {
                state.registerOk++;
            }
            return;
        }

        if (msg.method === 'MESSAGE') {
            const body = msg.body || '';
            send(sip.buildResponse(msg, { statusCode: 200, toTag: 'devtotag' }), rinfo).catch(() => {});
            if (body.includes('<CmdType>Catalog</CmdType>')) {
                state.catalogQueries++;
                catalogResponse().catch(() => {});
            } else if (body.includes('<CmdType>DeviceInfo</CmdType>')) {
                state.deviceInfoQueries++;
            } else if (body.includes('<CmdType>DeviceControl</CmdType>')) {
                state.controls.push(body);
            } else if (body.includes('<CmdType>Keepalive</CmdType>')) {
                state.keepalives++;
            }
            return;
        }

        if (msg.method === 'INVITE') {
            state.invites++;
            state.inviteCallId = sip.header(msg, 'call-id');
            state.inviteSdp = msg.body || '';
            send(sip.buildResponse(msg, {
                statusCode: 200,
                toTag: 'devtotag',
                contentType: 'APPLICATION/SDP',
                body: 'v=0\r\no=' + DEVICE_ID + ' 0 0 IN IP4 127.0.0.1\r\ns=Play\r\nt=0 0\r\n'
            }), rinfo).catch(() => {});
            return;
        }

        if (msg.method === 'ACK') { state.acks++; return; }

        if (msg.method === 'BYE') {
            state.byes++;
            state.byeCallId = sip.header(msg, 'call-id');
            send(sip.buildResponse(msg, { statusCode: 200, toTag: 'devtotag' }), rinfo).catch(() => {});
            return;
        }
    });

    return {
        state: state,
        register: register,
        keepalive: keepalive,
        catalogResponse: catalogResponse,
        setPlatform: (port, host) => { state.platform = { address: host || '127.0.0.1', port: port }; },
        start: () => new Promise((resolve) => {
            sock.bind(0, '127.0.0.1', () => {
                const a = sock.address();
                state.self = { host: a.address, port: a.port };
                resolve(a.port);
            });
        }),
        close: () => new Promise((resolve) => { try { sock.close(() => resolve()); } catch (e) { resolve(); } })
    };
}

describe('GB28181 end-to-end over SIP/UDP', function () {
    this.timeout(20000);

    let storage;
    let sim;
    let gbSettings;
    const mediaOriginals = {};

    before(async () => {
        storage = memoryStorage();
        gbSettings = {
            enabled: true,
            sipId: SIP_ID,
            sipDomain: REALM,
            sipPassword: PASSWORD,
            sipPort: 0,                 // ephemeral, so tests never fight over 5060
            sipHost: '127.0.0.1',
            mediaIp: '127.0.0.1',
            mediaPort: 0,
            rtpTransport: 'UDP',
            offlineAfterMs: 60000,
            allowAnonymous: false
        };
        sim = createDeviceSim();
        await sim.start();
        const info = await service.init({ gb28181: gbSettings }, silentLogger,
            { cameraFusion: null }, storage);
        assert.strictEqual(info.enabled, true);
        assert.ok(info.port > 0, 'SIP server must bind a real port');
        gbSettings.sipPort = info.port;
        sim.setPlatform(info.port);   // a real device learns this from its config
    });

    after(async () => {
        Object.keys(mediaOriginals).forEach(k => { media[k] = mediaOriginals[k]; });
        await service.stop();
        await sim.close();
    });

    it('challenges an unauthenticated REGISTER, then accepts the digest one', async () => {
        await sim.register(false);
        await waitFor(() => sim.state.challenges >= 1, 3000, '401 challenge');
        assert.ok(sim.state.lastNonce, 'challenge must carry a nonce');

        await sim.register({ nonce: sim.state.lastNonce });
        await waitFor(() => sim.state.registerOk >= 1, 3000, '200 OK for REGISTER');

        const devices = await service.listDevices();
        const dev = devices.find(d => d.deviceId === DEVICE_ID);
        assert.ok(dev, 'registered device must be persisted');
        assert.strictEqual(dev.online, true);
        assert.strictEqual(dev.port, sim.state.self.port);
    });

    it('answers DeviceInfo + Catalog after the first registration and stores channels', async () => {
        await waitFor(() => sim.state.catalogQueries >= 1, 5000, 'catalog query');
        await waitFor(() => sim.state.deviceInfoQueries >= 1, 5000, 'device info query');

        await waitFor(async () => (await storage.getGbChannels(DEVICE_ID)).length === 2, 3000, 'channel persistence');
        const channels = await service.getChannels(DEVICE_ID);
        assert.strictEqual(channels.length, 2);
        assert.strictEqual(channels[0].id, CH1);
        assert.strictEqual(channels[0].name, '采区A 皮带机');
        assert.strictEqual(channels[0].ptzType, 1);
    });

    it('updates liveness from a keepalive MESSAGE', async () => {
        const before = (await service.getDevice(DEVICE_ID)).keepaliveTime;
        await new Promise(r => setTimeout(r, 5));
        await sim.keepalive();
        await waitFor(async () => {
            const d = await service.getDevice(DEVICE_ID);
            return d.keepaliveTime && d.keepaliveTime !== before;
        }, 3000, 'keepalive timestamp');
        assert.strictEqual((await service.getDevice(DEVICE_ID)).online, true);
    });

    it('sends a PTZ command the device can decode', async () => {
        const res = await service.ptz(DEVICE_ID, CH1, { code: 'up', speed: 100 });
        assert.strictEqual(res.ptzCmd, 'A50F0108FFFFF0AB');
        await waitFor(() => sim.state.controls.length >= 1, 3000, 'DeviceControl');
        assert.ok(sim.state.controls[0].includes('<PTZCmd>' + res.ptzCmd + '</PTZCmd>'),
            'device must receive the exact PTZCmd bytes');
        assert.ok(sim.state.controls[0].includes('<DeviceID>' + CH1 + '</DeviceID>'));
    });

    it('sends a preset FI command', async () => {
        const res = await service.preset(DEVICE_ID, CH1, 'presetGoto', 3);
        assert.strictEqual(res.fiCmd, 'A50F01820300003A');
        await waitFor(() => sim.state.controls.length >= 2, 3000, 'FI control');
        assert.ok(sim.state.controls[1].includes('<FIcmd>' + res.fiCmd + '</FIcmd>'));
    });

    it('invites a channel into the media server, ACKs, then BYEs inside the dialog', async () => {
        mediaOriginals.isConfigured = media.isConfigured;
        mediaOriginals.openRtpServer = media.openRtpServer;
        mediaOriginals.closeRtpServer = media.closeRtpServer;
        mediaOriginals.rtpPlayback = media.rtpPlayback;
        media.isConfigured = () => true;
        media.openRtpServer = async () => ({ port: 30500, stream: 'gb_test', app: 'rtp', tcpMode: 1 });
        media.closeRtpServer = async () => true;
        media.rtpPlayback = (settings, stream, ssrc, rtpPort) => ({
            media: 'zlmediakit', protocol: 'gb28181', app: 'rtp',
            stream: stream, ssrc: ssrc, rtpPort: rtpPort,
            hls: 'http://127.0.0.1:8080/rtp/' + stream + '/hls.m3u8'
        });

        const play = await service.play(DEVICE_ID, CH1);
        assert.strictEqual(play.invite, 200);
        assert.strictEqual(play.rtpPort, 30500);
        assert.strictEqual(play.app, 'rtp');
        assert.strictEqual(play.ssrc, service.buildSsrc(CH1));

        await waitFor(() => sim.state.invites >= 1, 3000, 'INVITE');
        await waitFor(() => sim.state.acks >= 1, 3000, 'ACK');
        assert.ok(/a=rtpmap:96 PS\/90000/.test(sim.state.inviteSdp), 'SDP must announce PS/90000');
        assert.ok(sim.state.inviteSdp.includes('y=' + play.ssrc), 'SDP must carry the SSRC');

        const sessions = service.getSessions();
        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0].deviceId, DEVICE_ID);

        const stop = await service.stopStream(DEVICE_ID, CH1);
        assert.strictEqual(stop.stopped, true);
        await waitFor(() => sim.state.byes >= 1, 3000, 'BYE');
        assert.strictEqual(sim.state.byeCallId, sim.state.inviteCallId,
            'BYE must stay inside the INVITE dialog (same Call-ID)');
        assert.strictEqual(service.getSessions().length, 0);
    });

    it('rejects control of an offline/unknown device with a stable error code', async () => {
        await assert.rejects(() => service.ptz('00000000000000000000', CH1, { code: 'up' }),
            (err) => err.code === 'GB_DEVICE_NOT_FOUND');
    });

    it('removes a device together with its channels', async () => {
        await service.removeDevice(DEVICE_ID);
        assert.strictEqual(await service.getDevice(DEVICE_ID), null);
        assert.strictEqual((await service.getChannels(DEVICE_ID)).length, 0);
    });
});

// ------------------------------------------- real SQLite schema round-trip

describe('GB28181 storage schema (SQLite)', () => {
    it('creates gb_devices/gb_channels and round-trips a catalog', async () => {
        const storage = require('../../runtime/cameras/camera-storage');
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb28181-store-'));
        try {
            await storage.init({ workDir: workDir }, silentLogger);
            await storage.saveGbDevice({
                deviceId: DEVICE_ID, host: '10.0.0.9', port: 5060, expires: 3600,
                transport: 'UDP', charset: 'GB2312', toTag: 't1', online: true,
                registerTime: new Date().toISOString(), keepaliveTime: new Date().toISOString()
            });
            const n = await storage.replaceGbChannels(DEVICE_ID, [
                { id: CH1, name: '采区A 皮带机', manufacturer: 'Hikvision', model: 'DS-2CD', status: 'ON', ptzType: 1 },
                { id: CH2, name: '副井口', status: 'OFF' }
            ]);
            assert.strictEqual(n, 2);

            const dev = await storage.getGbDevice(DEVICE_ID);
            assert.strictEqual(dev.deviceId, DEVICE_ID);
            assert.strictEqual(dev.online, true);
            assert.strictEqual(dev.channelCount, 2);

            const chans = await storage.getGbChannels(DEVICE_ID);
            assert.strictEqual(chans.length, 2);
            assert.strictEqual(chans[0].name, '采区A 皮带机');
            assert.strictEqual(chans[0].ptzType, 1);
            assert.strictEqual((await storage.getAllGbChannels()).length, 2);

            const chan = await storage.getGbChannel(DEVICE_ID, CH2);
            assert.strictEqual(chan.status, 'OFF');

            await storage.markGbDevicesOffline();
            assert.strictEqual((await storage.getGbDevice(DEVICE_ID)).online, false);

            await storage.deleteGbDevice(DEVICE_ID);
            assert.strictEqual(await storage.getGbDevice(DEVICE_ID), null);
            assert.strictEqual((await storage.getGbChannels(DEVICE_ID)).length, 0);
        } finally {
            await storage.close();
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (err) { /* windows may hold the file */ }
        }
    });
});
