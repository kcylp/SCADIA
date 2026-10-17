'use strict';

/**
 * 变更项 C：账号活动审计（登录 / 登录失败 / 注销 / 退出 / 会话超时）。
 *
 * 这里守住的是审计本身的可核对性：
 *   · 写进去的字段就是页面上能看到的字段，且不含口令/令牌/Cookie；
 *   · 重启（重新 init）后记录还在 —— 这是"落库"与"只发内存事件"的分界；
 *   · 只有管理员能读；时间窗与分页有上限；
 *   · 退出上报用独立动作码，和注销、超时区分开。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const authJwt = require('../../api/jwt-helper');
const accountsApi = require('../../api/accounts');
const store = require('../../runtime/accounts');

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('Account activity audit', () => {
    let dir, server, base, groups;

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-audit-'));
        const ok = await store.init({ workDir: dir }, logger);
        assert.equal(ok, true);
        groups = -1;
        accountsApi.init(
            { project: {}, accounts: store, logger },
            (_req, _res, next) => next(),
            () => groups
        );
        server = accountsApi.app().listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        base = 'http://127.0.0.1:' + server.address().port;
    });

    after(async () => {
        await new Promise(r => server.close(r));
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it('records every action and never stores credentials', async () => {
        const at = Date.now();
        for (const [action, result] of [['login', 'ok'], ['login_failed', 'denied'], ['logout', 'ok'], ['exit', 'ok'], ['session_timeout', 'ok']]) {
            assert.equal(await store.record({ at, username: 'operator', fullname: '值班员', action, result, clientIp: '10.0.0.8', userAgent: 'test-agent' }), true);
        }
        const { rows, total } = await store.query({ from: at - 1000, to: at + 1000, username: 'operator' });
        assert.equal(total, 5);
        assert.deepEqual(rows.map(r => r.action).sort(), ['exit', 'login', 'login_failed', 'logout', 'session_timeout']);
        const serialized = JSON.stringify(rows);
        assert(!/password|token|cookie/i.test(serialized));
        for (const row of rows) {
            assert.deepEqual(Object.keys(row).sort(), ['action', 'at', 'clientIp', 'fullname', 'id', 'result', 'userAgent', 'username'].sort());
        }
    });

    it('rejects unknown actions and control characters instead of storing them raw', async () => {
        assert.equal(await store.record({ username: 'x', action: 'drop_table' }), false);
        const at = Date.now();
        await store.record({ at, username: 'line\nbreak', action: 'exit', userAgent: 'a\r\nb' });
        const { rows } = await store.query({ from: at - 10, to: at + 10 });
        assert.equal(rows[0].username, 'line break');
        assert.equal(rows[0].userAgent, 'a  b');
    });

    it('survives a restart (records are on disk, not only in memory)', async () => {
        const at = Date.now();
        await store.record({ at, username: 'persisted', action: 'login', result: 'ok' });
        assert.equal(await store.init({ workDir: dir }, logger), true);
        const { rows } = await store.query({ from: at - 10, to: at + 10, username: 'persisted' });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].action, 'login');
    });

    it('lets only administrators read the ledger', async () => {
        groups = 2;
        try {
            const denied = await fetch(base + '/api/accounts/activity');
            assert.equal(denied.status, 403);
        } finally {
            groups = -1;
        }
        const ok = await fetch(base + '/api/accounts/activity?limit=5');
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert(Array.isArray(body.rows));
        assert(body.total >= 1);
        assert(body.limitations.some(text => text.includes('尽力送达')));
    });

    it('validates the query window', async () => {
        const now = Date.now();
        assert.equal((await fetch(base + `/api/accounts/activity?from=${now}&to=${now - 1000}`)).status, 400);
        assert.equal((await fetch(base + `/api/accounts/activity?from=${now - 400 * 86400000}&to=${now}`)).status, 400);
    });

    it('records a beacon exit with the action code that separates it from logout', async () => {
        const token = jwt.sign({ id: 'beacon-user', groups: 2 }, authJwt.secretCode, { expiresIn: 60 });
        const at = Date.now();
        const res = await fetch(base + '/api/session/exit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'beacon-test' },
            body: JSON.stringify({ token, reason: 'exit', sessionId: 'sess-1' })
        });
        assert.equal(res.status, 204);
        // dedupe: the same beacon twice within the window must not double-record
        await fetch(base + '/api/session/exit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'beacon-test' },
            body: JSON.stringify({ token, reason: 'exit', sessionId: 'sess-1' })
        });
        const { rows } = await store.query({ from: at - 1000, to: at + 5000, username: 'beacon-user', action: 'exit' });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].userAgent, 'beacon-test');
    });

    it('ignores an exit without a verifiable identity', async () => {
        const at = Date.now();
        const before = await store.query({ from: at - 1000, to: at + 1000 });
        const res = await fetch(base + '/api/session/exit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'not-a-token', reason: 'exit' })
        });
        assert.equal(res.status, 204);
        const after = await store.query({ from: at - 1000, to: at + 1000 });
        assert.equal(after.total, before.total);
    });
});
