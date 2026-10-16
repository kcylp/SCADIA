'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const counters = require('../../runtime/cameras/event-counters');
const cameras = require('../../api/cameras');
const express = require('express');

describe('Event counters reset consistency', function () {
    this.timeout(15000);
    let root, work, images;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-counts-'));
        work = path.join(root, 'work'); images = path.join(root, 'images'); fs.mkdirSync(work); fs.mkdirSync(images);
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    it('clears all days, aliases and unknown kinds, preserves audit, then starts at one', async () => {
        const day = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(path.join(work, 'video-events-count.json'), JSON.stringify({ '2020-01-01': { unexpected: 7 }, [day]: { fielddetection: 6, shelteralarm: 3, tamperdetection: 2, badvideo: 8, motiondetection: 4 } }));
        const result = await counters.reset(work, images, 'admin');
        assert.equal(result.status, 'ok'); assert.deepEqual(result.counts.total, {}); assert.deepEqual(result.counts.byKind, {});
        await counters.bump(work, images, 'motiondetection');
        const pub = read(path.join(images, 'ai-counts.json'));
        assert.deepEqual(pub.total, { VMD: 1 }); assert.equal(pub.clearedBy, 'admin'); assert(pub.clearedAt > 0);
    });
    it('merges legacy aliases without losing counters', () => {
        const day = new Date().toISOString().slice(0, 10);
        const p = counters.project({ [day]: { tamper: 2, shelteralarm: 3, tamperdetection: 4, badvideo: 5, unknown: 6 } }, Date.now());
        assert.equal(p.byKind.tamper, 9); assert.equal(p.total.videoloss, 5); assert.equal(p.total.unknown, 6);
    });
    it('does not report success or discard private counts when public projection fails', async () => {
        await counters.bump(work, images, 'VMD');
        const file = path.join(work, 'video-events-count.json'), before = read(file);
        await assert.rejects(counters.reset(work, path.join(root, 'missing'), 'admin'));
        assert.deepEqual(read(file), before);
        assert(!fs.existsSync(file + '.lock'));
    });
    it('fails closed on malformed private counters', async () => {
        fs.writeFileSync(path.join(work, 'video-events-count.json'), '{bad');
        await assert.rejects(counters.bump(work, images, 'VMD'));
        assert.equal(fs.readFileSync(path.join(work, 'video-events-count.json'), 'utf8'), '{bad');
    });
    it('retries a transient Windows PID read denial without stealing a live lock', async () => {
        const lock = path.join(work, 'video-events-count.json.lock');
        fs.mkdirSync(lock); fs.writeFileSync(path.join(lock,'pid'),String(process.pid));
        const readFile = fs.readFileSync; let denied = false;
        fs.readFileSync = function (file, ...args) {
            if (!denied && file === path.join(lock,'pid')) {
                denied = true;
                const err = new Error('transient delete-sharing denial'); err.code='EPERM'; throw err;
            }
            return readFile.call(fs,file,...args);
        };
        const release = setTimeout(() => fs.rmSync(lock,{recursive:true,force:true}),60);
        try {
            const result = await counters.bump(work,images,'VMD');
            assert(denied); assert.equal(result.counts.total.VMD,1);
        } finally { clearTimeout(release); fs.readFileSync=readFile; }
    });
    it('serializes concurrent writers across processes and after a reset', async () => {
        const modulePath = require.resolve('../../runtime/cameras/event-counters');
        const run = () => new Promise((resolve, reject) => {
            const p = spawn(process.execPath, ['-e', `const c=require(${JSON.stringify(modulePath)}); (async()=>{for(let i=0;i<12;i++)await c.bump(${JSON.stringify(work)},${JSON.stringify(images)},'VMD')})().catch(e=>{console.error(e);process.exit(1)})`]);
            let err = ''; p.stderr.on('data', x => err += x); p.on('error', reject); p.on('close', code => code ? reject(new Error(err)) : resolve());
        });
        await Promise.all([run(), run(), run()]);
        assert.equal(read(path.join(images, 'ai-counts.json')).total.VMD, 36);
        await counters.reset(work, images, 'admin'); await run();
        assert.equal(read(path.join(images, 'ai-counts.json')).total.VMD, 12);
    });
    it('open viewing still validates signed administrator identity for resets', async () => {
        const jwt = require('jsonwebtoken'), authJwt = require('../../api/jwt-helper');
        const secret = 'counter-test-only';
        authJwt.init(false, secret, 60);
        const runtime = { project: {}, settings: { secureEnabled: false, workDir: work, imagesFileDir: images },
            users: { getUserCache: id => ({ admin: { groups: -1 }, viewer: { groups: 2 } })[id] }, logger: { warn() {}, error() {} } };
        cameras.init(runtime, (req, res, next) => next(), () => 1);
        const server = cameras.app().listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        const call = token => fetch('http://127.0.0.1:' + server.address().port + '/api/ai/events/reset', {
            method: 'POST', headers: token ? { 'x-access-token': token } : {}
        });
        try {
            assert.equal((await call()).status, 401);
            assert.equal((await call('invalid')).status, 401);
            assert.equal((await call(jwt.sign({ id: 'viewer', groups: -1 }, secret))).status, 403);
            assert.equal((await call(jwt.sign({ id: 'admin', type: 'refresh' }, secret))).status, 403);
            assert.equal((await call(jwt.sign({ id: 'admin' }, secret, { expiresIn: -1 }))).status, 401);
            const response = await call(jwt.sign({ id: 'admin', groups: -1 }, secret));
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.by, 'admin');
            assert.equal(body.counts.clearedBy, 'admin');
        } finally { await new Promise(r => server.close(r)); }
    });
    it('HTTP denies guest/operator, returns error on failed write and only succeeds for admin', async () => {
        let role = 'guest';
        const runtime = { project: {}, settings: { secureEnabled: true, workDir: work, imagesFileDir: images }, logger: { error() {}, warn() {} } };
        cameras.init(runtime, (req, res, next) => { req.userId = role; req.userGroups = role; req.isAuthenticated = role !== 'guest'; next(); }, () => role === 'admin' ? -1 : 2);
        const server = cameras.app().listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        const call = () => fetch('http://127.0.0.1:' + server.address().port + '/api/ai/events/reset', { method: 'POST' });
        try {
            assert.equal((await call()).status, 401);
            role = 'operator'; assert.equal((await call()).status, 403);
            role = 'admin'; const r = await call(); assert.equal(r.status, 200); assert.equal((await r.json()).status, 'ok');
            runtime.settings.imagesFileDir = path.join(root, 'missing'); assert.equal((await call()).status, 500);
        } finally { await new Promise(r => server.close(r)); }
    });
});
