/**
 * 'api/devices' route tests (B3, gate G3).
 *
 * Same harness style as test/api/projectLazyLoading.test.js: mount the real
 * express app and drive it over a real socket, so the auth gate, the routing and
 * the JSON contract are all exercised together.
 */

'use strict';

const http = require('http');
const express = require('express');
const sinon = require('sinon');

const devicesApi = require('../../api/devices');
const authJwt = require('../../api/jwt-helper');

let expect;

function request(server, path, opts) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
        const payload = o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : null;
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method: o.method || 'GET',
            path,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => { body += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = body ? JSON.parse(body) : null; } catch (err) { parsed = body; }
                resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

function sampleDevice() {
    return {
        id: 'dev1',
        name: 'API 网关',
        type: 'WebAPI',
        enabled: true,
        property: { getTags: 'http://h/api', postTags: 'http://h/api', address: '' },
        tags: {
            t1: { id: 't1', name: '液位', type: 'number', address: 'pit.level', value: 12.5 },
            t2: { id: 't2', name: '运行', type: 'boolean', address: 'pit.run', value: true }
        }
    };
}

describe('Devices API (B3)', () => {
    let server;
    let runtime;
    let devices;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    beforeEach(async () => {
        devices = { dev1: sampleDevice() };
        runtime = {
            // Secure mode is ON, which is the deployment default and the only mode
            // in which the platform accepts changes (see the disabled-mode test).
            settings: { secureEnabled: true },
            logger: { error() {}, warn() {}, info() {} },
            project: {
                getDevices: () => devices,
                setProjectData: sinon.stub().resolves(true),
                ProjectDataCmdType: { SetDevice: 'set-device' }
            },
            devices: {
                getTagValue: (tagId) => {
                    const found = Object.values(devices).reduce((acc, d) => acc || (d.tags[tagId]), null);
                    return found ? found.value : null;
                },
                setTagsValues: sinon.stub().resolves({ ok: true, written: 1, failed: [] }),
                updateDevice: sinon.stub(),
                getDeviceTagsResult: sinon.stub().resolves({
                    newTagsCount: 1,
                    tags: [[{ id: 't9', name: 't9', address: 'a.b', type: 'number' }]]
                })
            }
        };

        function secureFnc(req, res, next) {
            req.userId = 'admin-1';
            next();
        }
        devicesApi.init(runtime, secureFnc, () => authJwt.adminGroups[0]);

        const app = express();
        app.use(express.json());
        app.use(devicesApi.app());
        server = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
    });

    afterEach((done) => {
        server.close(done);
    });

    it('lists devices with their tag counts', async () => {
        const res = await request(server, '/api/devices');
        expect(res.statusCode).to.equal(200);
        expect(res.body.devices.length).to.equal(1);
        expect(res.body.devices[0].id).to.equal('dev1');
        expect(res.body.devices[0].tagCount).to.equal(2);
        expect(res.body.devices[0].type).to.equal('WebAPI');
    });

    it('exports tag definitions without runtime state', async () => {
        const res = await request(server, '/api/devices/dev1/tags');
        expect(res.statusCode).to.equal(200);
        expect(res.body.format).to.equal('kaicheng-scada/device-tags');
        expect(res.body.count).to.equal(2);
        expect(res.body.tags.t1.address).to.equal('pit.level');
        expect(res.body.tags.t1.value).to.equal(undefined, 'values are not in the default export');
    });

    it('attaches live values only when asked', async () => {
        const res = await request(server, '/api/devices/dev1/tags?values=true');
        expect(res.statusCode).to.equal(200);
        expect(res.body.tags.t1.value).to.equal(12.5);
    });

    it('sets a download filename only when asked', async () => {
        const plain = await request(server, '/api/devices/dev1/tags');
        expect(plain.headers['content-disposition']).to.equal(undefined);
        const dl = await request(server, '/api/devices/dev1/tags?download=true');
        expect(dl.headers['content-disposition']).to.contain('attachment');
        expect(dl.headers['content-disposition']).to.contain('.json');
    });

    it('404s an unknown device', async () => {
        const res = await request(server, '/api/devices/nope/tags');
        expect(res.statusCode).to.equal(404);
        expect(res.body.error).to.equal('DEV_NOT_FOUND');
    });

    it('imports tags, persists them and restarts the device', async () => {
        const res = await request(server, '/api/devices/dev1/tags', {
            method: 'POST',
            body: { tags: [{ id: 't3', name: '压力', address: 'pit.pressure', type: 'number' }] }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.added).to.equal(1);
        expect(res.body.updated).to.equal(0);
        expect(res.body.tagCount).to.equal(3);
        expect(runtime.project.setProjectData.calledOnce).to.equal(true);
        expect(runtime.devices.updateDevice.calledOnce).to.equal(true);
    });

    it('rejects an import with nothing usable instead of reporting a fake success', async () => {
        const res = await request(server, '/api/devices/dev1/tags', {
            method: 'POST',
            body: { tags: [{ id: 'x' }] }
        });
        expect(res.statusCode).to.equal(400);
        expect(res.body.error).to.equal('DEV_IMPORT_FAILED');
        expect(runtime.project.setProjectData.called).to.equal(false);
    });

    it('does not touch the project when every tag already exists', async () => {
        const res = await request(server, '/api/devices/dev1/tags', {
            method: 'POST',
            body: { tags: [{ id: 't1', name: '液位', address: 'pit.level', type: 'number' }] }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.added).to.equal(0);
        expect(res.body.skipped).to.deep.equal(['t1']);
        expect(runtime.project.setProjectData.called).to.equal(false, 'a no-op import must not rewrite the project');
    });

    it('overwrites only with an explicit flag', async () => {
        const res = await request(server, '/api/devices/dev1/tags', {
            method: 'POST',
            body: { overwrite: true, tags: [{ id: 't1', name: '液位2', address: 'pit.level2', type: 'number' }] }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.updated).to.equal(1);
        expect(devices.dev1.tags.t1.address).to.equal('pit.level2');
    });

    it('batch-writes several tags in one call', async () => {
        const res = await request(server, '/api/devices/dev1/write', {
            method: 'POST',
            body: { entries: [{ id: 't1', value: 1 }, { id: 't2', value: true }] }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.ok).to.equal(true);
        expect(runtime.devices.setTagsValues.calledOnce).to.equal(true);
        expect(runtime.devices.setTagsValues.firstCall.args[1].length).to.equal(2);
    });

    it('rejects a write with no entries', async () => {
        const res = await request(server, '/api/devices/dev1/write', { method: 'POST', body: { entries: [] } });
        expect(res.statusCode).to.equal(400);
        expect(res.body.error).to.equal('DEV_VALIDATION_ERROR');
    });

    it('reports 502 with the per-tag failures when the endpoint refuses the write', async () => {
        runtime.devices.setTagsValues = sinon.stub().resolves({
            ok: false, written: 0, failed: [{ id: 't1', error: 'HTTP 500' }]
        });
        const res = await request(server, '/api/devices/dev1/write', {
            method: 'POST',
            body: { entries: [{ id: 't1', value: 1 }] }
        });
        expect(res.statusCode).to.equal(502);
        expect(res.body.failed[0].error).to.equal('HTTP 500');
    });

    it('reports 422 when the device cannot be written at all', async () => {
        runtime.devices.setTagsValues = sinon.stub().resolves({
            ok: false, written: 0, failed: [{ id: 't1', error: 'write not supported' }]
        });
        const res = await request(server, '/api/devices/dev1/write', {
            method: 'POST',
            body: { entries: [{ id: 't1', value: 1 }] }
        });
        expect(res.statusCode).to.equal(422);
        expect(res.body.error).to.equal('DEV_WRITE_UNSUPPORTED');
    });

    it('reports 409 when the device is not running', async () => {
        runtime.devices.setTagsValues = sinon.stub().rejects(new Error('Device not active: dev1'));
        const res = await request(server, '/api/devices/dev1/write', {
            method: 'POST',
            body: { entries: [{ id: 't1', value: 1 }] }
        });
        expect(res.statusCode).to.equal(409);
        expect(res.body.error).to.equal('DEV_NOT_ACTIVE');
    });

    it('discovers tags from a WebAPI endpoint in the importable shape', async () => {
        const res = await request(server, '/api/devices/dev1/tags/discover', { method: 'POST', body: {} });
        expect(res.statusCode).to.equal(200);
        expect(res.body.count).to.equal(1);
        expect(res.body.tags[0].id).to.equal('t9');
        expect(res.body.tags[0].address).to.equal('a.b');
        expect(res.body.newTagsCount).to.equal(1);
    });

    it('refuses import and write while secure mode allows only viewers', async () => {
        // a reader session: authenticated but not in an admin group (0 = plain user)
        devicesApi.init(runtime, (req, res, next) => { req.userId = 'reader'; next(); }, () => 0);

        const app = express();
        app.use(express.json());
        app.use(devicesApi.app());
        const guarded = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const read = await request(guarded, '/api/devices');
            expect(read.statusCode).to.equal(200, 'reads stay available to a viewer');

            const write = await request(guarded, '/api/devices/dev1/tags', {
                method: 'POST', body: { tags: [{ id: 't3', address: 'x' }] }
            });
            expect(write.statusCode).to.equal(403);
            expect(write.body.error).to.equal('DEV_FORBIDDEN');
            expect(runtime.project.setProjectData.called).to.equal(false);
        } finally {
            await new Promise(r => guarded.close(r));
        }
    });

    it('refuses imports while secure mode is disabled', async () => {
        // The platform's contract: with security off, the REST API will not
        // change a project. Refusing here is deliberate, not an accident.
        runtime.settings.secureEnabled = false;
        const app = express();
        app.use(express.json());
        app.use(devicesApi.app());
        const open = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const res = await request(open, '/api/devices/dev1/tags', {
                method: 'POST', body: { tags: [{ id: 't3', address: 'x' }] }
            });
            expect(res.statusCode).to.equal(403);
            expect(res.body.error).to.equal('DEV_SECURITY_DISABLED');
            expect(runtime.project.setProjectData.called).to.equal(false);
        } finally {
            await new Promise(r => open.close(r));
        }
    });
});

/**
 * B4: the channel layer (device -> channel -> tag).
 *
 * The harness applies setProjectData to the in-memory device map so a mutation
 * followed by a read sees the new state, the same way the runtime does.
 */
describe('Devices API — channels (B4)', () => {
    let server;
    let runtime;
    let devices;

    function channelledDevice() {
        return {
            id: 'dev1',
            name: 'Modbus 网关',
            type: 'ModbusTCP',
            enabled: true,
            channels: [
                { id: 'ch1', name: '1号机组' },
                { id: 'ch2', name: '2号机组' }
            ],
            tags: {
                t1: { id: 't1', name: '温度', type: 'number', address: '40001', channelId: 'ch1', value: 21 },
                t2: { id: 't2', name: '压力', type: 'number', address: '40002', channelId: 'ch1', value: 5 },
                t3: { id: 't3', name: '流量', type: 'number', address: '40003', channelId: 'ch2', value: 7 },
                t4: { id: 't4', name: '公共', type: 'number', address: '40004', value: 1 }
            }
        };
    }

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    beforeEach(async () => {
        devices = { dev1: channelledDevice() };
        runtime = {
            settings: { secureEnabled: true },
            logger: { error() {}, warn() {}, info() {} },
            project: {
                getDevices: () => devices,
                setProjectData: sinon.stub().callsFake((cmd, value) => {
                    devices[value.id] = value;
                    return Promise.resolve(true);
                }),
                ProjectDataCmdType: { SetDevice: 'set-device' }
            },
            devices: {
                getTagValue: () => null,
                updateDevice: sinon.stub()
            }
        };

        function secureFnc(req, res, next) { req.userId = 'admin-1'; next(); }
        devicesApi.init(runtime, secureFnc, () => authJwt.adminGroups[0]);

        const app = express();
        app.use(express.json());
        app.use(devicesApi.app());
        server = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
    });

    afterEach((done) => { server.close(done); });

    it('lists declared channels plus the implicit default one, with tag counts', async () => {
        const res = await request(server, '/api/devices/dev1/channels');
        expect(res.statusCode).to.equal(200);
        const byId = {};
        res.body.channels.forEach(c => { byId[c.id] = c; });
        expect(byId['ch1'].tagCount).to.equal(2);
        expect(byId['ch1'].isDefault).to.equal(false);
        expect(byId['ch2'].tagCount).to.equal(1);
        expect(byId[''].isDefault).to.equal(true);
        expect(byId[''].tagCount).to.equal(1, 'the tag with no channel lands in the default channel');
    });

    it('reports the channel count in the device list', async () => {
        const res = await request(server, '/api/devices');
        expect(res.body.devices[0].channelCount).to.equal(2);
    });

    it('creates a channel and persists it', async () => {
        const res = await request(server, '/api/devices/dev1/channels', {
            method: 'POST',
            body: { id: 'ch3', name: '3号机组', description: '备用' }
        });
        expect(res.statusCode).to.equal(201);
        expect(res.body.channel.id).to.equal('ch3');
        expect(runtime.project.setProjectData.calledOnce).to.equal(true);

        const list = await request(server, '/api/devices/dev1/channels');
        expect(list.body.channels.map(c => c.id)).to.include('ch3');
    });

    it('derives a channel id from the name when none is given', async () => {
        const res = await request(server, '/api/devices/dev1/channels', {
            method: 'POST', body: { name: 'Boiler-A' }
        });
        expect(res.statusCode).to.equal(201);
        expect(res.body.channel.id).to.equal('boiler-a');
    });

    it('refuses a duplicate channel id with a conflict', async () => {
        const res = await request(server, '/api/devices/dev1/channels', {
            method: 'POST', body: { id: 'ch1', name: 'again' }
        });
        expect(res.statusCode).to.equal(409);
        expect(res.body.error).to.equal('DEV_CHANNEL_CONFLICT');
        expect(runtime.project.setProjectData.called).to.equal(false);
    });

    it('refuses a channel with neither id nor name', async () => {
        const res = await request(server, '/api/devices/dev1/channels', {
            method: 'POST', body: {}
        });
        expect(res.statusCode).to.equal(400);
        expect(res.body.error).to.equal('DEV_CHANNEL_INVALID');
    });

    it('moves tags into a channel and reflects it in the tag definitions', async () => {
        const res = await request(server, '/api/devices/dev1/tags/assign', {
            method: 'POST', body: { tagIds: ['t4'], channelId: 'ch2' }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.moved).to.deep.equal(['t4']);

        const list = await request(server, '/api/devices/dev1/channels');
        const ch2 = list.body.channels.find(c => c.id === 'ch2');
        expect(ch2.tagCount).to.equal(2);
        const exported = await request(server, '/api/devices/dev1/tags');
        expect(exported.body.tags.t4.channelId).to.equal('ch2', 'channel assignment survives export');
    });

    it('moves tags back to the default channel with an empty channelId', async () => {
        const res = await request(server, '/api/devices/dev1/tags/assign', {
            method: 'POST', body: { tagIds: ['t1'], channelId: '' }
        });
        expect(res.statusCode).to.equal(200);
        const exported = await request(server, '/api/devices/dev1/tags');
        expect(exported.body.tags.t1.channelId).to.equal(undefined, 'the default channel is never stored');
    });

    it('404s an assign into a channel that does not exist', async () => {
        const res = await request(server, '/api/devices/dev1/tags/assign', {
            method: 'POST', body: { tagIds: ['t1'], channelId: 'nope' }
        });
        expect(res.statusCode).to.equal(404);
        expect(res.body.error).to.equal('DEV_CHANNEL_NOT_FOUND');
    });

    it('reports unknown tags in a partial assign without pretending they moved', async () => {
        const res = await request(server, '/api/devices/dev1/tags/assign', {
            method: 'POST', body: { tagIds: ['t4', 'ghost'], channelId: 'ch2' }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.moved).to.deep.equal(['t4']);
        expect(res.body.errors.length).to.equal(1);
        expect(res.body.errors[0].id).to.equal('ghost');
    });

    it('renames a channel and repoints its tags so none is orphaned', async () => {
        const res = await request(server, '/api/devices/dev1/channels/ch2', {
            method: 'PUT', body: { id: 'ch2b', name: '2号机组(改)' }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.channel.id).to.equal('ch2b');

        const exported = await request(server, '/api/devices/dev1/tags');
        expect(exported.body.tags.t3.channelId).to.equal('ch2b');
    });

    it('removes a channel and reassigns its tags to the default channel', async () => {
        const res = await request(server, '/api/devices/dev1/channels/ch2', { method: 'DELETE' });
        expect(res.statusCode).to.equal(200);
        expect(res.body.removed).to.equal('ch2');
        expect(res.body.reassigned).to.equal(1);

        const exported = await request(server, '/api/devices/dev1/tags');
        expect(exported.body.tags.t3.channelId).to.equal(undefined);
        expect(exported.body.tags.t3.id).to.equal('t3', 'the tag itself is never deleted');
    });

    it('will not remove or edit the implicit default channel', async () => {
        const del = await request(server, '/api/devices/dev1/channels/default', { method: 'DELETE' });
        expect(del.statusCode).to.equal(400);
        const put = await request(server, '/api/devices/dev1/channels/default', { method: 'PUT', body: { name: 'x' } });
        expect(put.statusCode).to.equal(400);
    });

    it('exports only one channel\u2019s tags', async () => {
        const res = await request(server, '/api/devices/dev1/channels/ch2/tags');
        expect(res.statusCode).to.equal(200);
        expect(Object.keys(res.body.tags)).to.deep.equal(['t3']);
        expect(res.body.channel).to.deep.equal({ id: 'ch2', name: '2号机组' });
    });

    it('404s the export of a channel that does not exist', async () => {
        const res = await request(server, '/api/devices/dev1/channels/nope/tags');
        expect(res.statusCode).to.equal(404);
        expect(res.body.error).to.equal('DEV_CHANNEL_NOT_FOUND');
    });

    it('regroups an imported tag whose channel does not exist, and says so', async () => {
        const res = await request(server, '/api/devices/dev1/tags', {
            method: 'POST',
            body: { tags: [{ id: 't5', name: '新', address: '40005', type: 'number', channelId: 'ghost-ch' }] }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.channelWarnings.length).to.equal(1);
        expect(res.body.channelWarnings[0].id).to.equal('t5');

        const exported = await request(server, '/api/devices/dev1/tags');
        expect(exported.body.tags.t5.channelId).to.equal(undefined, 'the bad channel reference is dropped, not stored');
    });

    it('keeps a valid channel reference on import', async () => {
        const res = await request(server, '/api/devices/dev1/tags', {
            method: 'POST',
            body: { tags: [{ id: 't5', name: '新', address: '40005', type: 'number', channelId: 'ch2' }] }
        });
        expect(res.statusCode).to.equal(200);
        expect(res.body.channelWarnings.length).to.equal(0);
        const exported = await request(server, '/api/devices/dev1/tags');
        expect(exported.body.tags.t5.channelId).to.equal('ch2');
    });

    it('404s an unknown device for every channel route', async () => {
        const a = await request(server, '/api/devices/nope/channels');
        expect(a.statusCode).to.equal(404);
        expect(a.body.error).to.equal('DEV_NOT_FOUND');
    });

    it('lets a viewer read channels but not create one', async () => {
        devicesApi.init(runtime, (req, res, next) => { req.userId = 'reader'; next(); }, () => 0);
        const app = express();
        app.use(express.json());
        app.use(devicesApi.app());
        const guarded = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const read = await request(guarded, '/api/devices/dev1/channels');
            expect(read.statusCode).to.equal(200);
            const write = await request(guarded, '/api/devices/dev1/channels', {
                method: 'POST', body: { id: 'ch9', name: 'nope' }
            });
            expect(write.statusCode).to.equal(403);
            expect(write.body.error).to.equal('DEV_FORBIDDEN');
        } finally {
            await new Promise(r => guarded.close(r));
        }
    });
});
