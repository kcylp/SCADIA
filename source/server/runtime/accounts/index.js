/**
 * 账号活动审计：登录 / 登录失败 / 注销 / 退出 / 会话超时。
 *
 * 为什么要独立一个库：这是按时间顺序的台账，和 users 的账号定义、alarms 的状态机
 * 都不是一回事。单独一个文件便于备份、保留和清理，也不会污染报警计数。
 *
 * 明确不记录：口令、完整 token、Cookie。这里存的是"谁在什么时候做了什么"，
 * 以及来源 IP / 浏览器标识（截断），足以核对，不足以冒充。
 */

'use strict';

const storage = require('../storage/databases');

const ACTIONS = ['login', 'login_failed', 'logout', 'exit', 'session_timeout'];
const RESULTS = ['ok', 'denied'];
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const DEFAULT_RETENTION_DAYS = 365;

let settings;
let logger;
let db = null;

function text(value, max) {
    if (typeof value !== 'string') return '';
    // 去掉控制字符：审计内容要能原样打印、导出 CSV，不能带换行伪造另一行。
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function normalize(entry) {
    const action = ACTIONS.includes(entry?.action) ? entry.action : null;
    if (!action) return null;
    const at = Number.isSafeInteger(entry.at) && entry.at > 0 ? entry.at : Date.now();
    return {
        at,
        username: text(entry.username, 128),
        fullname: text(entry.fullname, 128),
        action,
        result: RESULTS.includes(entry.result) ? entry.result : (action === 'login_failed' ? 'denied' : 'ok'),
        clientIp: text(entry.clientIp, 64),
        userAgent: text(entry.userAgent, 300),
        sessionId: text(entry.sessionId, 64)
    };
}

function init(_settings, _logger) {
    settings = _settings;
    logger = _logger;
    // 重复 init 时先释放旧句柄：否则同一进程里会同时持有两个连接，
    // 停机/测试清理时会因文件仍被占用而删不掉目录。
    if (db) {
        const previous = db;
        db = null;
        try { previous.close(() => { }); } catch (_) { /* already closed */ }
    }
    return new Promise(resolve => {
        try {
            const file = storage.resolveDbFile(settings.workDir, 'accounts', logger);
            db = storage.open(file, err => {
                if (err) {
                    logger.error('accountsstorage.failed-to-bind: ' + err);
                    db = null;
                    resolve(false);
                    return;
                }
                logger.info('accountsstorage.connected-to ' + file + ' database.', true);
            });
            db.exec(
                `CREATE TABLE if not exists account_activity (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    at INTEGER NOT NULL,
                    username TEXT NOT NULL DEFAULT '',
                    fullname TEXT NOT NULL DEFAULT '',
                    action TEXT NOT NULL,
                    result TEXT NOT NULL,
                    client_ip TEXT NOT NULL DEFAULT '',
                    user_agent TEXT NOT NULL DEFAULT '',
                    session_id TEXT NOT NULL DEFAULT '');
                CREATE INDEX if not exists idx_account_activity_at ON account_activity(at);
                CREATE INDEX if not exists idx_account_activity_user ON account_activity(username, at);`,
                err => {
                    if (err) {
                        logger.error('accountsstorage.failed-to-bind: ' + err);
                        db = null;
                        resolve(false);
                        return;
                    }
                    purge().then(() => resolve(true)).catch(() => resolve(true));
                }
            );
        } catch (err) {
            logger.error('accountsstorage.init-failed: ' + (err.message || err));
            db = null;
            resolve(false);
        }
    });
}

/** 保留期清理：默认 365 天，可用 settings.accountActivityRetentionDays 调整（<=0 表示不清理）。 */
function purge() {
    return new Promise(resolve => {
        const days = Number(settings?.accountActivityRetentionDays ?? DEFAULT_RETENTION_DAYS);
        if (!db || !Number.isFinite(days) || days <= 0) return resolve(0);
        const cutoff = Date.now() - days * 86400000;
        db.run('DELETE FROM account_activity WHERE at < ?', [cutoff], function (err) {
            if (!err && this.changes) logger.info('accountsstorage.purged ' + this.changes + ' rows older than ' + days + ' days');
            resolve(err ? 0 : (this.changes || 0));
        });
    });
}

/** 写入一条活动记录。失败只记日志，绝不影响登录/注销本身。 */
function record(entry) {
    const row = normalize(entry);
    if (!row) return Promise.resolve(false);
    if (!db) {
        logger?.warn?.('accountsstorage.record skipped: database unavailable');
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        db.run(
            'INSERT INTO account_activity (at, username, fullname, action, result, client_ip, user_agent, session_id) VALUES (?,?,?,?,?,?,?,?)',
            [row.at, row.username, row.fullname, row.action, row.result, row.clientIp, row.userAgent, row.sessionId],
            err => {
                if (err) {
                    logger?.error?.('accountsstorage.record failed: ' + err.message);
                    resolve(false);
                    return;
                }
                resolve(true);
            }
        );
    });
}

/**
 * 查询活动台账，按时间倒序。
 * filter: { from, to, username, action, limit, offset }
 */
function query(filter = {}) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error('account activity database unavailable'));
        const where = [];
        const params = [];
        if (Number.isSafeInteger(filter.from) && filter.from > 0) { where.push('at >= ?'); params.push(filter.from); }
        if (Number.isSafeInteger(filter.to) && filter.to > 0) { where.push('at < ?'); params.push(filter.to); }
        if (typeof filter.username === 'string' && filter.username.trim()) { where.push('username = ?'); params.push(filter.username.trim().slice(0, 128)); }
        if (ACTIONS.includes(filter.action)) { where.push('action = ?'); params.push(filter.action); }
        const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
        const limit = Math.min(Math.max(Number(filter.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const offset = Math.max(Number(filter.offset) || 0, 0);
        db.get('SELECT COUNT(*) AS total FROM account_activity' + clause, params, (countErr, countRow) => {
            if (countErr) return reject(countErr);
            db.all(
                'SELECT id, at, username, fullname, action, result, client_ip AS clientIp, user_agent AS userAgent FROM account_activity' + clause + ' ORDER BY at DESC, id DESC LIMIT ? OFFSET ?',
                params.concat([limit, offset]),
                (err, rows) => {
                    if (err) return reject(err);
                    resolve({ rows: rows || [], total: countRow?.total || 0, limit, offset });
                }
            );
        });
    });
}

/** 关闭句柄（进程退出或测试清理时用；正常运行时由进程生命周期持有）。 */
function close() {
    return new Promise(resolve => {
        if (!db) return resolve();
        const handle = db;
        db = null;
        try { handle.close(() => resolve()); } catch (_) { resolve(); }
    });
}

module.exports = { init, record, query, purge, close, ACTIONS };
