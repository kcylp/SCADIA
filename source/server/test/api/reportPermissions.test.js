'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
// 通过编译产物加载，与生产 api/index.js 的加载路径一致。
const { ReportsApiService } = require('../../dist/reports.service');

// 隔离的安全模式实例：验证报表读/写/生成/状态/删除接口对游客、普通用户与管理员的边界。
// 现场运行在 legacy-open（匿名即管理员），无法在真实站点验证普通角色，故用独立进程内实例。
describe('Reports API secure-mode permissions', function () {
    this.timeout(15000);
    let dir, server, role, settings;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-report-acl-'));
        fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'reports', 'existing.pdf'), '%PDF-1.4 existing');
        settings = { secureEnabled: true, reportsDir: path.join(dir, 'reports') };
        role = 'ordinary';
        const forced = { id: 'r-acl', name: 'acl-test' };
        const runtime = {
            project: {},
            settings,
            logger: { error() {}, info() {}, warn() {} },
            jobsMgr: {
                forceReport: (report) => report && report.id === forced.id,
                getReportStatus: (id) => (id === forced.id ? { state: 'running' } : { state: 'unknown' })
            }
        };
        const api = new ReportsApiService();
        api.init(runtime,
            (req, res, next) => { req.isAuthenticated = role !== 'guest'; req.userId = role; next(); },
            () => (role === 'admin' ? 255 : role === 'ordinary' ? 1 : 0));
        const host = require('express')();
        host.use(require('express').json({ limit: '1mb' }));
        host.use(api.app());
        server = host.listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
    });
    afterEach(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

    const base = () => 'http://127.0.0.1:' + server.address().port;
    const post = (url, body) => fetch(base() + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const get = (url) => fetch(base() + url);

    it('denies guests and ordinary users at every report write boundary', async () => {
        for (const who of ['guest', 'ordinary']) {
            role = who;
            // 该服务既有设计：无有效管理员权限一律 401（与 cameras API 的 401/403 区分不同）。
            const expected = 401;
            assert.equal((await post('/api/reportBuild', { params: { id: 'r-acl' } })).status, expected, who + ' reportBuild');
            assert.equal((await get('/api/reportStatus?id=r-acl')).status, expected, who + ' reportStatus');
            assert.equal((await post('/api/reportRemoveFile', { params: { fileName: 'existing.pdf' } })).status, expected, who + ' reportRemoveFile');
        }
        // 拒绝路径不得有副作用：文件仍在。
        assert.ok(fs.existsSync(path.join(dir, 'reports', 'existing.pdf')));
    });
    it('permits admin and separates accepted from the real result', async () => {
        role = 'admin';
        assert.equal((await post('/api/reportBuild', { params: { id: 'r-acl' } })).status, 200);
        const status = await (await get('/api/reportStatus?id=r-acl')).json();
        assert.equal(status.status.state, 'running');
        assert.equal((await (await get('/api/reportStatus?id=unknown')).json()).status.state, 'unknown');
        // 路径约束仍生效：越界文件名被拒绝。
        assert.equal((await post('/api/reportRemoveFile', { params: { fileName: '../outside.pdf' } })).status, 400);
        assert.ok(fs.existsSync(path.join(dir, 'reports', 'existing.pdf')));
    });
    it('rejects builds for reports the jobs manager does not know', async () => {
        role = 'admin';
        const response = await post('/api/reportBuild', { params: { id: 'missing-report' } });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error, 'not_found');
    });
});
