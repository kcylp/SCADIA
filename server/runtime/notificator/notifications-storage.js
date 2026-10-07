/**
 * 通知域 · 运行态计时的持久层
 *
 * 这张表存的是通知的**运行态**，不是通知的**配置**。两者是两回事，别混：
 *
 *   · 配置（id / name / type / receiver / text / delay / interval / mode / options /
 *     subscriptions）住在**项目库**的 notifications 表（runtime/project/prjstorage.js:82，
 *     一个 (name, value) 的 KV 表，value 是整个通知对象的 JSON）。前端 /notifications
 *     页面写的就是它，**这一直是好的**。
 *   · 运行态（ontime / notifytime）是通知器自己的东西，属于**这台机器**而不是某个工程，
 *     所以它落在应用 workDir 的域库里，不进工程文件。
 *
 * 历史：本模块的前身 runtime/notificator/notifystorage.js 在 D5 批次被当作死代码删除
 * （它当时确实没人 require）。任务卡 P0 要恢复存储层，于是按 D7 之后的新规矩重写：
 * 不再自己 new sqlite3，而是向存储平面要一个连好的句柄。
 */

'use strict';

const storage = require('../storage/databases');

var settings;       // Application settings
var logger;         // Application logger
var db = null;      // Database of notification runtime state (null until init succeeds)

/** Log if we have a logger yet; the storage layer may be asked before init. */
function _log(level, message) {
    if (logger && typeof logger[level] === 'function') { logger[level](message); }
}

/**
 * Rows are simply unknown before init: there is no database to read yet.
 *
 * Not an error, and deliberately not a throw. runtime/notificator/index.js:clearNotifications()
 * is part of the manager's public surface and test/runtime/notificatorLifecycle.test.js pins it
 * as callable - a caller reaching it before the first check pass must get the same answer it got
 * when this module did not exist (resolve), not a TypeError from an undefined handle.
 */
function _notReady() {
    var err = new Error('notifications-storage: not initialised yet (call init first)');
    _log('warn', err.message);
    return err;
}

/** Run a statement, resolving with the sqlite3 statement context (changes/lastID). */
function _run(sql, params = []) {
    return new Promise(function (resolve, reject) {
        db.run(sql, params, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this);
            }
        });
    });
}

/**
 * Init and bind the database resource
 * @param {*} _settings
 * @param {*} _log
 */
function init(_settings, _log) {
    settings = _settings;
    logger = _log;

    return new Promise(function (resolve, reject) {
        var dbfile = storage.resolveDbFile(settings.workDir, 'notifications', logger);
        db = storage.open(dbfile, function (err) {
            if (err) {
                db = null;
                logger.error('notifications-storage.failed-to-bind: ' + err);
                reject(err);
            }
        });

        var sql = "CREATE TABLE if not exists notifications (" +
            "id TEXT PRIMARY KEY, name TEXT, type TEXT, enabled INTEGER, receiver TEXT, " +
            "text TEXT, ontime INTEGER, notifytime INTEGER, mode TEXT, options TEXT, subscriptions TEXT);";
        db.exec(sql, function (err) {
            if (err) {
                logger.error('notifications-storage.failed-to-bind: ' + err);
                reject(err);
            } else {
                logger.info('notifications-storage.connected-to ' + dbfile + ' database.', true);
                resolve(true);
            }
        });
    });
}

/** Every row of the runtime-state table. Callers merge ontime/notifytime by id. */
function getNotifications() {
    return new Promise(function (resolve, reject) {
        if (!db) { resolve([]); return; }
        db.all("SELECT * FROM notifications;", [], function (err, rows) {
            if (err) {
                logger.error('notifications-storage.get.failed: ' + err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

/**
 * Persist one notification's runtime state.
 *
 * The timing fields are the point: notifier/index.js decides WHEN to send by comparing
 * `ontime` and `notifytime` against the current clock, and it moves both of them in
 * memory on every pass. Without a write back, the read side (_loadNotifications) merges
 * an always-empty table and a restart silently re-arms every notification's delay window -
 * which is exactly what "notification state is not persisted" means.
 *
 * INSERT OR REPLACE keyed by id: the row is this notification's current state, not a log.
 * @param {*} notification a Notification from runtime/notificator/index.js
 */
function saveNotification(notification) {
    if (!db) { return Promise.reject(_notReady()); }
    var sql = "INSERT OR REPLACE INTO notifications " +
        "(id, name, type, enabled, receiver, text, ontime, notifytime, mode, options, subscriptions) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);";
    var params = [
        notification.id,
        notification.name,
        notification.type,
        notification.enabled ? 1 : 0,
        notification.receiver,
        notification.text,
        notification.ontime,
        notification.notifytime,
        notification.mode === undefined || notification.mode === null ? null : String(notification.mode),
        notification.options === undefined ? null : JSON.stringify(notification.options),
        notification.subscriptions === undefined ? null : JSON.stringify(notification.subscriptions)
    ];
    return _run(sql, params).catch(function (err) {
        // A state write that fails must not take the check pass down with it: the
        // notification still fires this pass, it is the memory of it that is lost.
        logger.error('notifications-storage.save.failed: ' + err);
    });
}

/**
 * Clear the runtime state.
 * @param {*} all true -> every row; otherwise only rows not notified in the last 7 days
 */
function clearNotifications(all) {
    if (!db) { return Promise.resolve(true); }
    var sql = "DELETE FROM notifications;";
    var params = [];
    if (!all) {
        sql = "DELETE FROM notifications WHERE notifytime < ?;";
        params = [Date.now() - 7 * 24 * 60 * 60 * 1000];
    }
    return _run(sql, params).then(function () {
        return true;
    }).catch(function (err) {
        logger.error('notifications-storage.clear.failed: ' + err);
        throw err;
    });
}

module.exports = {
    init: init,
    getNotifications: getNotifications,
    saveNotification: saveNotification,
    clearNotifications: clearNotifications
};
