/**
 * WebAPI/HTTP device enhancements + tag import/export tests (B3).
 *
 * Layers:
 *   1. request shaping   — pure rules: batch body, conditional GET, not-modified
 *   2. tag import/export — the rules that decide what a file may change
 *   3. a real end-to-end run against an in-process HTTP server: batch write in
 *      ONE request, honest failure reporting, and long-poll/ETag reads.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const EventEmitter = require('events');

const builder = require('../../runtime/devices/httprequest/request-builder');
const tagIo = require('../../runtime/devices/tag-io');
const driver = require('../../runtime/devices/httprequest');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 3000);
    return new Promise((resolve, reject) => {
        const tick = () => {
            Promise.resolve()
                .then(() => predicate())
                .then((ok) => {
                    if (ok) { resolve(true); return; }
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition'))); return; }
                    setTimeout(tick, 20);
                })
                .catch((err) => {
                    if (Date.now() > deadline) { reject(new Error('timed out waiting for ' + (label || 'condition') + ': ' + err.message)); return; }
                    setTimeout(tick, 20);
                });
        };
        tick();
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

// ------------------------------------------------------------ request shaping

describe('WebAPI request shaping', () => {

    it('defaults a batch write to POST [{id,value}]', () => {
        const req = builder.buildWriteRequest({ getTags: 'http://h/api' }, [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, 'http://h/api');
        assert.deepStrictEqual(req.body, [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
        assert.strictEqual(req.contentType, 'application/json');
    });

    it('honours a writeMethod and a custom post URL', () => {
        const req = builder.buildWriteRequest({ getTags: 'http://h/get', postTags: 'http://h/set', writeMethod: 'put' },
            [{ id: 'a', value: 1 }]);
        assert.strictEqual(req.method, 'PUT');
        assert.strictEqual(req.url, 'http://h/set');
    });

    it('renders an {{entries}} template as one body', () => {
        const req = builder.buildWriteRequest(
            { getTags: 'http://h/api', postTags: 'http://h/w', writeTemplate: '{"points":{{entries}}}' },
            [{ id: 'a', value: 1 }]);
        assert.strictEqual(req.body, '{"points":[{"id":"a","value":1}]}');
        assert.strictEqual(req.contentType, 'application/json');
    });

    it('renders a per-entry template and keeps the batch in one request', () => {
        const req = builder.buildWriteRequest(
            { getTags: 'http://h/a', postTags: 'http://h/w', writeTemplate: '{"tag":"{{id}}","v":{{value}}}' },
            [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
        assert.strictEqual(req.body, '[{"tag":"a","v":1},{"tag":"b","v":2}]');
    });

    it('leaves an unknown placeholder visible instead of blanking it', () => {
        assert.strictEqual(builder.applyTemplate('{"x":"{{nope}}"}', { id: 'a' }), '{"x":"{{nope}}"}');
        assert.strictEqual(builder.applyTemplate('{"x":"{{id}}"}', { id: 'a' }), '{"x":"a"}');
    });

    it('refuses a write to a plain read document unless a template defines the body', () => {
        // address-only mode is a read document: writing our array there would be
        // a guess, so it is refused until the operator supplies a template.
        assert.strictEqual(builder.buildWriteRequest({ address: 'http://h/doc' }, [{ id: 'a', value: 1 }]), null);
        const withTemplate = builder.buildWriteRequest(
            { address: 'http://h/doc', writeTemplate: '{"k":"{{value}}"}' }, [{ id: 'a', value: 1 }]);
        assert.strictEqual(withTemplate.body, '{"k":"1"}');
    });

    it('refuses a write with no URL at all', () => {
        assert.strictEqual(builder.buildWriteRequest({}, [{ id: 'a', value: 1 }]), null);
    });

    it('normalises headers from an object or a JSON string, and tolerates junk', () => {
        assert.deepStrictEqual(builder.normalizeHeaders({ A: '1' }).headers, { A: '1' });
        assert.deepStrictEqual(builder.normalizeHeaders('{"A":"1"}').headers, { A: '1' });
        const bad = builder.normalizeHeaders('{not json');
        assert.deepStrictEqual(bad.headers, {});
        assert.ok(bad.error, 'a broken headers value must be reported, not thrown');
    });

    it('adds auth headers from username/password or a bearer token', () => {
        const basic = builder.requestConfig({ username: 'u', password: 'p' });
        assert.deepStrictEqual(basic.config.auth, { username: 'u', password: 'p' });
        const bearer = builder.requestConfig({ bearerToken: 'tok' });
        assert.strictEqual(bearer.config.headers.Authorization, 'Bearer tok');
    });

    it('builds a conditional GET for long polling (ETag + hold time + since)', () => {
        const built = builder.buildReadConfig(
            { longPoll: true, etagPlaceholder: true, longPollTimeout: 25000, longPollParam: 'hold', sinceParam: 'since' },
            { etag: 'W/"abc"', since: 1700000000000 });
        assert.strictEqual(built.conditional, true);
        assert.strictEqual(built.config.headers['If-None-Match'], 'W/"abc"');
        assert.strictEqual(built.config.params.hold, 25000);
        assert.strictEqual(built.config.params.since, 1700000000000);
        // the client timeout must outlive the server hold time
        assert.ok(built.config.timeout > 25000, 'long poll timeout must exceed the hold time');
    });

    it('does not send conditional headers when long polling is off', () => {
        const built = builder.buildReadConfig({}, { etag: 'x', since: 1 });
        assert.strictEqual(built.conditional, false);
        assert.strictEqual(built.config.headers['If-None-Match'], undefined);
    });

    it('treats 304, changed:false and an empty body as not-modified', () => {
        assert.strictEqual(builder.isNotModified(304, undefined, {}), true);
        assert.strictEqual(builder.isNotModified(200, { changed: false }, {}), true);
        assert.strictEqual(builder.isNotModified(200, [], {}), true);
        assert.strictEqual(builder.isNotModified(200, '', {}), true);
        assert.strictEqual(builder.isNotModified(200, { a: 1 }, {}), false);
        assert.strictEqual(builder.isNotModified(200, [{ id: 'a', value: 1 }], {}), false);
    });

    it('reads the ETag from either header spelling', () => {
        assert.strictEqual(builder.etagOf({ etag: 'W/"1"' }), 'W/"1"');
        assert.strictEqual(builder.etagOf({ ETag: '"2"' }), '"2"');
        assert.strictEqual(builder.etagOf({}), null);
    });
});

// ---------------------------------------------------------- tag import/export

describe('Device tag export/import', () => {

    function device() {
        return {
            id: 'dev1',
            name: 'API 网关',
            type: 'WebAPI',
            property: { address: 'http://h/api' },
            tags: {
                t1: { id: 't1', name: '液位', type: 'number', address: 'pit.level', format: 2, value: 12.5, timestamp: 1, changed: true },
                t2: { id: 't2', name: '运行', type: 'boolean', address: 'pit.run', value: true }
            }
        };
    }

    it('exports definitions without runtime state', () => {
        const doc = tagIo.exportDeviceTags(device());
        assert.strictEqual(doc.format, 'kaicheng-scada/device-tags');
        assert.strictEqual(doc.count, 2);
        assert.strictEqual(doc.tags.t1.address, 'pit.level');
        assert.strictEqual(doc.tags.t1.format, 2);
        assert.strictEqual(doc.tags.t1.value, undefined, 'a value must not be exported by default');
        assert.strictEqual(doc.tags.t1.timestamp, undefined);
        assert.strictEqual(doc.tags.t1.changed, undefined);
        assert.strictEqual(doc.device.type, 'WebAPI');
    });

    it('can include live values on request', () => {
        const doc = tagIo.exportDeviceTags(device(), { includeValues: true, values: { t1: 42 } });
        assert.strictEqual(doc.tags.t1.value, 42);
        assert.strictEqual(doc.tags.t2.value, undefined, 'only the supplied values are attached');
    });

    it('accepts a document, a bare map, a list and a JSON string', () => {
        assert.strictEqual(tagIo.normalizeImport({ tags: { a: { id: 'a' } } }).list.length, 1);
        assert.strictEqual(tagIo.normalizeImport({ a: { id: 'a' } }).list.length, 1);
        assert.strictEqual(tagIo.normalizeImport([{ id: 'a' }, { id: 'b' }]).list.length, 2);
        assert.strictEqual(tagIo.normalizeImport('{"a":{"id":"a"}}').list.length, 1);
        assert.ok(tagIo.normalizeImport('not json').error);
        assert.ok(tagIo.normalizeImport(null).error);
    });

    it('rejects a tag with no address instead of creating a dead entry', () => {
        const bad = tagIo.validateTag({ id: 'x', name: 'x' });
        assert.strictEqual(bad.ok, false);
        assert.ok(/address/.test(bad.error));
        const good = tagIo.validateTag({ id: 'x', address: 'a.b' });
        assert.strictEqual(good.ok, true);
        assert.strictEqual(good.tag.type, 'number', 'a missing type defaults rather than failing');
    });

    it('never lets runtime state come in from a file', () => {
        const v = tagIo.validateTag({ id: 'x', address: 'a', value: 999, timestamp: 1, changed: true });
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.tag.value, undefined);
        assert.strictEqual(v.tag.timestamp, undefined);
        assert.strictEqual(v.tag.changed, undefined);
    });

    it('adds new tags and skips existing ones by default', () => {
        const dev = device();
        const res = tagIo.mergeDeviceTags(dev, [
            { id: 't3', name: '压力', address: 'pit.pressure', type: 'number' },
            { id: 't1', name: '液位改', address: 'pit.level2', type: 'number' }
        ], {});
        assert.deepStrictEqual(res.added, ['t3']);
        assert.deepStrictEqual(res.skipped.map(s => s.id), ['t1']);
        assert.strictEqual(dev.tags.t1.address, 'pit.level', 'an existing tag must not change without overwrite');
        assert.strictEqual(dev.tags.t3.address, 'pit.pressure');
    });

    it('overwrites only when explicitly asked, keeping the live value', () => {
        const dev = device();
        dev.tags.t1.value = 77;
        const res = tagIo.mergeDeviceTags(dev, [
            { id: 't1', name: '液位改', address: 'pit.level2', type: 'number' }
        ], { overwrite: true });
        assert.deepStrictEqual(res.updated, ['t1']);
        assert.strictEqual(dev.tags.t1.address, 'pit.level2');
        assert.strictEqual(dev.tags.t1.value, 77, 'overwriting a definition must not blank the live value');
    });

    it('never deletes tags, even when the import omits them', () => {
        const dev = device();
        tagIo.mergeDeviceTags(dev, [{ id: 't3', name: '压力', address: 'p', type: 'number' }], { overwrite: true });
        assert.ok(dev.tags.t1 && dev.tags.t2, 'tags absent from the import must survive');
    });

    it('reports per-item errors and still imports the good ones', () => {
        const dev = device();
        const res = tagIo.mergeDeviceTags(dev, [
            { id: 'good', address: 'a' },
            { id: 'bad-no-address' },
            { address: 'no-id-and-no-name' },
            ['not-an-object']
        ], {});
        assert.deepStrictEqual(res.added, ['good']);
        assert.strictEqual(res.errors.length, 3, 'every unusable entry is reported, none is dropped silently');
        const messages = res.errors.map(e => e.error).join(' | ');
        assert.ok(/address/.test(messages), 'the missing address is named');
        assert.ok(/id nor name/.test(messages), 'the missing id/name is named');
        assert.ok(/not an object/.test(messages), 'a non-object entry is named');
        assert.ok(dev.tags.t1 && dev.tags.t2, 'existing tags survive a partly bad import');
    });

    it('round-trips an export back through import unchanged', () => {
        const source = device();
        const doc = tagIo.exportDeviceTags(source);
        const target = { id: 'dev2', name: 'copy', type: 'WebAPI', tags: {} };
        const res = tagIo.mergeDeviceTags(target, tagIo.normalizeImport(doc).list, {});
        assert.strictEqual(res.added.length, 2);
        assert.strictEqual(target.tags.t1.address, source.tags.t1.address);
        assert.strictEqual(target.tags.t1.format, source.tags.t1.format);
        assert.strictEqual(target.tags.t2.type, source.tags.t2.type);
    });
});

// ------------------------------------------------------------ end-to-end HTTP

describe('WebAPI driver (end-to-end over loopback)', function () {
    this.timeout(20000);

    let server = null;
    let port = null;
    let requests = [];
    let handler = null;

    before(async () => {
        port = await freePort();
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const entry = { method: req.method, url: req.url, headers: req.headers, body: body };
                requests.push(entry);
                if (handler) { handler(entry, res); return; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('[]');
            });
        });
        await new Promise(r => server.listen(port, '127.0.0.1', r));
    });

    after(async () => {
        if (server) { await new Promise(r => server.close(r)); server = null; }
    });

    beforeEach(() => {
        requests = [];
        handler = null;
    });

    /**
     * Build a driver in the driver's own WRITABLE convention: getTags/postTags
     * mode (a WebAPI device with `address` only is a read-only document).
     */
    function buildDriver(tags, property) {
        const data = {
            id: 'dev-http', name: 'HTTP GW', type: 'WebAPI', polling: 1000,
            property: Object.assign({
                getTags: `http://127.0.0.1:${port}/api`,
                postTags: `http://127.0.0.1:${port}/api`,
                address: ''
            }, property || {}),
            tags: {}
        };
        (tags || []).forEach(t => { data.tags[t.id] = Object.assign({ changed: false }, t); });
        const events = new EventEmitter();
        const comm = driver.create(data, silentLogger, events, {});
        comm.load(data);
        return comm;
    }

    it('writes many tags in exactly one request', async () => {
        const comm = buildDriver([
            { id: 'a', name: 'A', address: 'pa', type: 'number' },
            { id: 'b', name: 'B', address: 'pb', type: 'number' }
        ]);
        const res = await comm.setValues([{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.written, 2);
        assert.deepStrictEqual(res.failed, []);
        const writes = requests.filter(r => r.method !== 'GET');
        assert.strictEqual(writes.length, 1, 'a batch write must be ONE request, not one per tag');
        assert.deepStrictEqual(JSON.parse(writes[0].body), [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
    });

    it('reports a failure honestly instead of pretending the write succeeded', async () => {
        handler = (req, res) => { res.writeHead(500); res.end('nope'); };
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }]);
        const res = await comm.setValues([{ id: 'a', value: 1 }]);

        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.written, 0);
        assert.strictEqual(res.failed[0].error, 'HTTP 500');
    });

    it('reports unknown tags and still writes the known ones', async () => {
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }]);
        const res = await comm.setValues([{ id: 'a', value: 1 }, { id: 'ghost', value: 2 }]);

        assert.strictEqual(res.written, 1);
        assert.strictEqual(res.failed.length, 1);
        assert.strictEqual(res.failed[0].id, 'ghost');
        assert.strictEqual(res.failed[0].error, 'unknown tag');
    });

    it('setValue returns false when the endpoint rejects the write', async () => {
        handler = (req, res) => { res.writeHead(403); res.end(); };
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }]);
        assert.strictEqual(await comm.setValue('a', 1), false);
    });

    it('sends the configured headers and basic auth on a write', async () => {
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }],
            { headers: { 'X-Plant': 'A' }, username: 'u', password: 'p' });
        await comm.setValues([{ id: 'a', value: 1 }]);

        const w = requests.filter(r => r.method !== 'GET')[0];
        assert.strictEqual(w.headers['x-plant'], 'A');
        assert.ok(/^Basic /.test(w.headers.authorization), 'basic auth must be sent');
    });

    it('reads values in the [{id,value}] format', async () => {
        handler = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{ id: 'a', value: 3.5 }]));
        };
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }]);
        await comm.connect();
        await comm.polling();
        assert.strictEqual(comm.getValue('a').value, 3.5);
    });

    it('treats a 304 as "no change" and keeps the values, not as a failure', async () => {
        let first = true;
        handler = (req, res) => {
            if (first) {
                first = false;
                res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': 'W/"v1"' });
                res.end(JSON.stringify([{ id: 'a', value: 10 }]));
                return;
            }
            res.writeHead(304);
            res.end();
        };
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }], { longPoll: true });
        await comm.connect();

        await comm.polling();
        assert.strictEqual(comm.getValue('a').value, 10);

        await comm.polling();
        assert.strictEqual(comm.getValue('a').value, 10, '304 must keep the previous value');
        assert.strictEqual(comm.getStatus(), 'connect-ok', '304 is a healthy response, not an error');

        // the second poll must have been conditional
        const second = requests[requests.length - 1];
        assert.strictEqual(second.headers['if-none-match'], 'W/"v1"');
    });

    it('skips emitting when the endpoint reports changed:false', async () => {
        let n = 0;
        handler = (req, res) => {
            n++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(n === 1 ? [{ id: 'a', value: 5 }] : { changed: false }));
        };
        const events = new EventEmitter();
        const emitted = [];
        events.on('device-value:changed', e => emitted.push(e));
        const data = {
            id: 'dev-http', name: 'HTTP GW', type: 'WebAPI', polling: 1000,
            property: {
                getTags: `http://127.0.0.1:${port}/api`,
                postTags: `http://127.0.0.1:${port}/api`,
                address: ''
            },
            tags: { a: { id: 'a', name: 'A', address: 'pa', type: 'number' } }
        };
        const comm = driver.create(data, silentLogger, events, {});
        comm.load(data);
        await comm.connect();

        await comm.polling();
        const afterFirst = emitted.length;
        await comm.polling();
        assert.strictEqual(emitted.length, afterFirst, 'an unchanged response must not emit again');
        assert.strictEqual(comm.getValue('a').value, 5);
    });

    it('honours a custom write template end-to-end', async () => {
        const comm = buildDriver([{ id: 'a', name: 'A', address: 'pa', type: 'number' }],
            { postTags: `http://127.0.0.1:${port}/set`, writeTemplate: '{"points":{{entries}}}' });
        const res = await comm.setValues([{ id: 'a', value: 7 }]);
        assert.strictEqual(res.ok, true);
        const w = requests.filter(r => r.method !== 'GET')[0];
        assert.strictEqual(w.url, '/set');
        assert.strictEqual(w.body, '{"points":[{"id":"a","value":7}]}');
    });
});
