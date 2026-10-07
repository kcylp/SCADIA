/**
 * 存储平面 · 域库连接的唯一开点（D7）
 *
 * D7 之前，八个域各自 new sqlite3.Database(...)：于是「存储后端到底是什么」这个事实
 * 散落在八个业务文件里，换后端要改八处，架构守卫也只能把它们列成一份例外清单。
 * 这里把它们收到一处 —— **只有存储平面 require sqlite3**，其余模块只拿一个连好的句柄。
 *
 * 逐字搬运（D7 的规矩）：调用方传的路径、回调、以及之后对这个句柄做的一切
 * （run / get / all / serialize / close / 事务）都原样不动。这里不碰 schema、
 * 不封装事务、不改变任何业务语义。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const handles = new Set();
let opened = 0;

/**
 * Open a domain database.
 * Signature is deliberately identical to `new sqlite3.Database(file, callback)`.
 */
function open(file, callback) {
    const db = new sqlite3.Database(file, callback);
    handles.add(db);
    opened += 1;
    return db;
}

/** Diagnostics only: how many handles this process opened, and how many are still live. */
function stats() {
    let live = 0;
    for (const db of handles) {
        if (db.open) { live += 1; } else { handles.delete(db); }
    }
    return { opened: opened, live: live };
}

// ------------------------------------------------------------- 域库文件名清单

/**
 * 八个域库的文件名 —— 唯一事实来源。
 *
 * 现状是一半一半：alarms / apikeys / project / users 是 <域>.scadiap.db，而
 * cameras / recipes / scheduler / calibration 是 <域>.db。这是上一轮品牌改名
 * 只落到前半截留下的：后写的四个域库没跟上，名字于是各写各的，散在八个业务文件里。
 *
 * 规范名一律定为 <域>.scadiap.db（另一条路是把品牌后缀去掉、统一成 <域>.db；没走它，
 * 是因为它要动的是 project.scadiap.db —— 现场里最大的那一份，而且 tools/extract-project-texts.js
 * 与迁移回归测试收的就是 project.scadiap.db）。这里走的是「把没跟上的补上」。
 *
 * 但改名不等于把字符串换掉：换文件名就是换文件，下一次启动会静静地开出一个空库，
 * 而 SCADA 里最不能接受的失败，就是用空数据继续跑。所以这里不替换，只判断：
 *
 *   · 规范名在             → 用它；若旧名也在，按名字拒绝启动
 *   · 规范名不在、旧名在     → 就地沿用旧名，一个字节都不搬，并把这件事喊出来
 *   · 旧名有多个           → 拒绝启动（无法判断哪一份才是现场数据）
 *   · 都不在               → 用规范名（全新现场）
 *
 * 「两个都在就报错」不是这里发明的：契约 05 §5 第 5 条要求「新名优先、旧名回退，
 * 且两者并存时报错」，G-MIG-2 亦然；与 registry 用名字拒绝未知后端是同一个取舍 ——
 * 宁可停下说清楚，也不要挑一份数据继续跑。
 *
 * 真正的搬迁（含 -wal / -shm 伴随文件、备份、原子切换）属于契约 05 的六步流程，
 * 必须由运维在停机窗口显式执行；启动路径不承担搬运，只承担「不丢」。
 *
 * 上一个产品名时代留下的文件名，在本仓库里没有任何可核实的字面量（文档只写过后缀形式，
 * 见契约 05），所以这里不猜某个具体名字，而是按规则去认 —— 规则只有一行，在 legacyNamesFor。
 * 认得出来就够了：目的不是替客户改名，而是不要把它当成不存在。
 */
const DOMAIN_DB_FILES = {
    alarms: 'alarms.scadiap.db',
    apikeys: 'apikeys.scadiap.db',
    users: 'users.scadiap.db',
    project: 'project.scadiap.db',
    cameras: 'cameras.scadiap.db',
    recipes: 'recipes.scadiap.db',
    scheduler: 'scheduler.scadiap.db',
    calibration: 'calibration.scadiap.db',
    notifications: 'notifications.scadiap.db'
};

/**
 * The names a domain database may still be sitting under on an existing site.
 * Rule-based on purpose: the previous product's file-name suffix is not evidenced by any
 * literal in this repository, and enumerating a guess would look more certain than the facts
 * allow.
 */
function legacyNamesFor(id) {
    return [id + '.db', id + '.fuxap.db'];   // branding-guard:allow the previous product's file-name suffix, recognised so an existing site is opened rather than paved over
}

function note(logger, level, message) {
    if (logger && typeof logger[level] === 'function') { logger[level](message); return; }
    if (level === 'warn' || level === 'error') { console.warn(message); }
}

/**
 * Decide which file a domain database lives in, without ever choosing between two files
 * that both hold data.
 *
 * @param {string} workDir directory the domain stores live in
 * @param {string} id domain id, exactly as declared in DOMAIN_DB_FILES
 * @param {*} [logger] logger with warn/error
 * @returns {string} absolute path of the file to open
 */
function resolveDbFile(workDir, id, logger) {
    if (!Object.prototype.hasOwnProperty.call(DOMAIN_DB_FILES, id)) {
        throw new Error('storage.resolveDbFile: no database file is declared for the domain "' + id +
            '". Declare it in DOMAIN_DB_FILES instead of building a path where it is needed - ' +
            'an undeclared name is how this tree ended up half renamed.');
    }

    const canonical = path.join(workDir, DOMAIN_DB_FILES[id]);
    const legacy = legacyNamesFor(id)
        .map((name) => ({ name: name, file: path.join(workDir, name) }))
        .filter((candidate) => fs.existsSync(candidate.file));

    if (fs.existsSync(canonical)) {
        if (legacy.length) {
            throw new Error('storage.resolveDbFile: the ' + id + ' database exists under two names, ' +
                'so which one holds this site data cannot be decided here: "' + canonical +
                '" and "' + legacy.map((candidate) => candidate.file).join('", "') + '". Per contract 05 ' +
                'G-MIG-2 this refuses instead of picking one: reconcile the two files (keep one, move ' +
                'the other out of the directory) and start again.');
        }
        return canonical;
    }

    if (legacy.length > 1) {
        throw new Error('storage.resolveDbFile: the ' + id + ' database is absent under its canonical ' +
            'name "' + canonical + '" and present under more than one old name: "' +
            legacy.map((candidate) => candidate.file).join('", "') + '". Which of them is this ' +
            'site data is not decidable here; reconcile them and start again.');
    }

    if (legacy.length === 1) {
        note(logger, 'warn', 'storage: the ' + id + ' database is still stored under its old name "' +
            legacy[0].file + '" instead of "' + canonical + '". It is opened where it lies - nothing ' +
            'was moved or copied, so no data is at risk. Migrate it in a maintenance window ' +
            '(contract 05): renaming it by hand while the server runs can lose committed ' +
            'transactions, and this database keeps -wal/-shm companions.');
        return legacy[0].file;
    }

    return canonical;
}

module.exports = {
    open: open,
    stats: stats,
    resolveDbFile: resolveDbFile,
    DOMAIN_DB_FILES: DOMAIN_DB_FILES
};
