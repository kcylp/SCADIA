'use strict';
const assert = require('assert');
const http = require('http');
const daq = require('../../api/daq');
function get(server, query) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/daq?query=' + encodeURIComponent(JSON.stringify(query)) }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
}
describe('DAQ read boundary', function () {
    let server, calls;
    beforeEach(function (done) {
        calls = 0;
        const runtime = {
            project: {}, logger: { error() {} },
            devices: { getTagDefinition: id => ['visible','hidden'].includes(id) ? { id } : null,
                findProjectDeviceByTag: () => ({}), getTagValue: id => { calls++; return { id, value: 0 }; } },
            checkPermission: (_p, tag) => ({ show: tag.id !== 'hidden', enabled: tag.id !== 'hidden' }),
            daqStorage: { getNodeValues: async () => { calls++; return []; } }
        };
        daq.init(runtime, (_q, _s, n) => n(), () => 1);
        server = daq.app().listen(0, '127.0.0.1', done);
    });
    afterEach(done => server.close(done));
    it('rejects hidden and unknown tags before any read', async function () {
        for (const id of ['hidden', 'unknown']) {
            assert.equal((await get(server, { sids: [id], from: 0, to: 0 })).status, 403);
        }
        assert.equal(calls, 0);
    });
    it('rejects malformed and excessive windows', async function () {
        for (const q of [{sids:'visible',from:0,to:1},{sids:['visible'],from:2,to:1},{sids:['visible'],from:0,to:367*86400000}]) {
            assert.equal((await get(server, q)).status, 400);
        }
        assert.equal(calls, 0);
    });
    it('retains zero current values and legacy positional array shape', async function () {
        const r = await get(server, { sids: ['visible'], from: 0, to: 0 });
        assert.equal(r.status, 200); assert.equal(r.body.length, 1); assert.equal(r.body[0][0].value, 0); assert.equal(calls, 1);
    });
    it('uses bounded archive contract without fabricating missing data', async function () {
        const r = await get(server, { sids: ['visible'], from: 0, to: 100 });
        assert.equal(r.status, 200); assert.deepEqual(r.body, [[]]); assert.equal(calls, 1);
    });
});
