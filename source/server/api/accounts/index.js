/**
 * 'api/accounts': 账号活动台账（登录 / 登录失败 / 注销 / 退出 / 会话超时）。
 *
 * 读接口只给管理员：这是一份安全台账，列出谁在什么时候从哪里进来。
 * 写接口只有 /api/session/exit —— 浏览器在页面卸载时用 sendBeacon 上报，
 * 不能带自定义请求头，所以 token 允许放在请求体里，服务端只做校验、不落盘。
 */

'use strict';

var express = require('express');
const jwt = require('jsonwebtoken');
const authJwt = require('../jwt-helper');

const refreshCookieName = 'scadia_refresh';
const MAX_RANGE_MS = 366 * 86400000;
const DEFAULT_RANGE_MS = 7 * 86400000;
const EXIT_DEDUPE_MS = 5000;
const EXIT_ACTIONS = ['exit', 'session_timeout'];

var runtime;
var secureFnc;
var groupsFnc;
const recentExits = new Map();

function permission(req) {
    return groupsFnc ? groupsFnc(req) : null;
}

function text(value, max) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : (forwarded || '');
    return text(String(first).split(',')[0] || req.socket?.remoteAddress || '', 64);
}

function userAgent(req) {
    return text(req.headers['user-agent'] || '', 300);
}

function cookieValue(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
}

/** Who is leaving: access token (body or header), else the refresh cookie. Never persisted. */
function exitIdentity(req) {
    const token = req.headers['x-access-token'] || req.body?.token;
    if (typeof token === 'string' && token) {
        try {
            const decoded = jwt.verify(token, authJwt.secretCode, { ignoreExpiration: true });
            if (typeof decoded.id === 'string' && decoded.id && decoded.id !== 'guest' && decoded.type !== 'refresh') {
                return { username: decoded.id, expired: !!decoded.exp && decoded.exp * 1000 < Date.now() };
            }
        } catch (_) { /* invalid token is not an identity */ }
    }
    const refresh = cookieValue(req, refreshCookieName);
    if (refresh) {
        try {
            const decoded = jwt.verify(refresh, authJwt.secretCode, { ignoreExpiration: true });
            if (decoded.type === 'refresh' && typeof decoded.id === 'string' && decoded.id && decoded.id !== 'guest') {
                return { username: decoded.id, expired: false };
            }
        } catch (_) { /* ignore */ }
    }
    return null;
}

function dedupe(key) {
    const now = Date.now();
    for (const [k, at] of recentExits) {
        if (now - at > EXIT_DEDUPE_MS) recentExits.delete(k);
    }
    if (recentExits.has(key)) return true;
    recentExits.set(key, now);
    return false;
}

module.exports = {
    init: function (_runtime, _secureFnc, _groupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        groupsFnc = _groupsFnc;
    },
    app: function () {
        var accountsApp = express();

        accountsApp.use(function (req, res, next) {
            if (!runtime.project) {
                res.status(404).end();
            } else {
                next();
            }
        });

        /**
         * POST /api/session/exit
         *
         * Body: { token?, reason?: 'exit' | 'session_timeout', sessionId? }
         * Always answers 204: a page that is closing cannot act on an error, and a failure
         * to write one audit row must not surface as a login problem.
         */
        accountsApp.post('/api/session/exit', express.json({ limit: 4096 }), function (req, res) {
            try {
                const identity = exitIdentity(req);
                const reason = req.body?.reason === 'session_timeout' ? 'session_timeout' : 'exit';
                const sessionId = text(req.body?.sessionId, 64);
                if (identity && !dedupe(identity.username + '|' + sessionId + '|' + reason)) {
                    runtime.accounts?.record?.({
                        at: Date.now(),
                        username: identity.username,
                        action: reason,
                        result: 'ok',
                        clientIp: clientIp(req),
                        userAgent: userAgent(req),
                        sessionId
                    });
                }
            } catch (err) {
                runtime.logger?.warn?.('api session exit: ' + (err.message || err));
            }
            res.status(204).end();
        });

        /**
         * GET /api/accounts/activity?from&to&username&action&limit&offset
         * Administrator only. Default window is the last 7 days; the maximum is 366 days.
         */
        accountsApp.get('/api/accounts/activity', secureFnc, async function (req, res) {
            if (!authJwt.haveAdminPermission(permission(req))) {
                return res.status(403).json({ error: 'admin_required', message: '仅管理员可查看账号活动' });
            }
            if (!runtime.accounts) {
                return res.status(503).json({ error: 'audit_unavailable', message: '账号活动库未就绪' });
            }
            const now = Date.now();
            const to = Number(req.query.to);
            const from = Number(req.query.from);
            const end = Number.isSafeInteger(to) && to > 0 ? to : now;
            const start = Number.isSafeInteger(from) && from > 0 ? from : end - DEFAULT_RANGE_MS;
            if (start >= end) {
                return res.status(400).json({ error: 'invalid_window', message: '开始时间必须早于结束时间' });
            }
            if (end - start > MAX_RANGE_MS) {
                return res.status(400).json({ error: 'window_too_large', message: '查询窗口不得超过 366 天' });
            }
            try {
                const result = await runtime.accounts.query({
                    from: start,
                    to: end,
                    username: text(req.query.username, 128),
                    action: text(req.query.action, 32),
                    limit: Number(req.query.limit) || 100,
                    offset: Number(req.query.offset) || 0
                });
                res.json({
                    rows: result.rows,
                    total: result.total,
                    from: start,
                    to: end,
                    limit: result.limit,
                    offset: result.offset,
                    limitations: [
                        '“退出”由浏览器页面卸载时上报，属于尽力送达；关闭浏览器、断电或网络中断时可能缺失，缺失不等于仍在登录。',
                        '“会话超时”在客户端发现令牌过期时补记，时间点是发现时刻，不是令牌实际到期时刻。',
                        '台账只记录账号、动作、结果、来源 IP 与浏览器标识，不记录口令、令牌或 Cookie。'
                    ]
                });
            } catch (err) {
                runtime.logger?.error?.('api accounts activity: ' + (err.message || err));
                res.status(500).json({ error: 'audit_read_failed', message: '账号活动读取失败' });
            }
        });

        return accountsApp;
    }
};
