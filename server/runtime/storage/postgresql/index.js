/**
 * PostgreSQL 时序适配器（D8）
 *
 * 这是一个「填空」：目的不是再加一个后端，而是**证明 D4 冻结的契约真的能被第二个引擎实现**。
 * 填空失败就修接口，不打补丁（铁律 ③）。
 *
 * 状态：**unproven**。适配器按契约写完，但本机没有 PostgreSQL 实例，它**从未在真引擎上跑过**。
 * 证明它只需要一条命令（见 registry 的 proveWith 与 docker-compose.test.yml）：
 * 起一个容器，然后 npm run test:contract -- --grep postgresql。
 * 在那之前，能力矩阵里 PostgreSQL 那一列仍然是 unverified —— 不因为这里写了代码就变成 yes。
 *
 * 与 QuestDB 适配器的三点不同，都来自契约而不是偏好：
 *   1. 写入按 tag 独立成句：TimeSeries 域的不变量要求「不因某个 tag 失败而回滚其它 tag」，
 *      所以这里**刻意不**把整批写包进一个事务；
 *   2. 读取严格半开 [from, to)，由 SQL 的 >= / < 保证，不靠调用方过滤；
 *   3. 值分列存放（数值列 / 文本列），并保留布尔的可读形态。
 */

'use strict';

const { Pool } = require('pg');
let utils = require('../../utils');

const DEFAULT_TABLE = 'scadia_daq';

function Postgres(_settings, _log, _currentStorage) {
    const settings = _settings;
    const logger = _log;
    const currentStorage = _currentStorage;
    const table = getTableName();

    let pool = null;
    let ready = false;

    this.setCall = function (_fncGetProp) {
        fncGetTagProp = _fncGetProp;
        return this.addDaqValues;
    };
    var fncGetTagProp = null;

    this.init = async function () {
        try {
            pool = new Pool(getPoolConfig());
            await ensureSchema();
            ready = true;
            logger.info('postgresql: connected, table ' + table, true);
        } catch (error) {
            // Never escape as an unhandled rejection: a backend that cannot be reached must
            // degrade to "no data", with the reason in the log (the A-07 lesson).
            ready = false;
            logger.error('postgresql: init failed! ' + error);
        }
    };

    this.addDaqValues = function (tagsValues, deviceName, deviceId) {
        const dataToRestore = [];
        const rows = [];

        for (const tagid in tagsValues) {
            const tag = tagsValues[tagid];
            if (!tag.daq) { continue; }
            if (tag.daq.restored) {
                dataToRestore.push({ id: tag.id, deviceId: deviceId, value: tag.value });
            }
            if (!tag.daq.enabled || utils.isNullOrUndefined(tag.value) || Number.isNaN(tag.value)) {
                continue;
            }
            rows.push({
                tagid: tagid,
                deviceId: deviceId,
                deviceName: deviceName || '',
                value: tag.value,
                ts: tag.timestamp || Date.now()
            });
        }

        // One statement per tag, deliberately outside any transaction: see the header.
        for (const row of rows) {
            writeRow(row).catch((error) => {
                logger.error('postgresql: addDaqValues failed for tag ' + row.tagid + ': ' + error);
            });
        }

        if (dataToRestore.length && currentStorage) {
            currentStorage.setValues(dataToRestore);
        }
    };

    this.getDaqValue = function (tagid, fromts, tots) {
        if (!ready || !pool) {
            // An unreachable backend answers empty; init() already recorded why. A backend
            // that IS reachable but fails is a different thing - see the catch below.
            //
            // The guard used to be `!pool` alone, which did not hold the line it claims to: pg's
            // Pool is built BEFORE anything is proven reachable, so a failed init (server down)
            // leaves pool non-null with ready false, and the read fell through to a query and
            // rejected with ECONNREFUSED - measured, see the batch-90-B probe. Keying on ready
            // makes "not connected" mean what it says (A-07). init() sets ready only after the
            // schema is in place, so a reachable backend is unaffected, and a failure AFTER a
            // successful init still travels as a failure below.
            return Promise.resolve([]);
        }
        // Half-open [from, to) in SQL, parameterised - never string-built.
        const sql = 'SELECT ts, value_num, value_text ' +
            'FROM ' + table + ' WHERE tag_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts';
        return query(sql, [tagid, new Date(Number(fromts)), new Date(Number(tots))])
            .then((result) => result.rows.map((row) => ({
                dt: new Date(row.ts).getTime(),
                value: !utils.isNullOrUndefined(row.value_num) ? Number(row.value_num) : row.value_text
            })))
            .catch((error) => {
                // "no data" and "the backend failed" must not look alike - removing that
                // conflation is what the query contract exists for, so a failure travels as
                // a failure instead of arriving as an empty result.
                logger.error('postgresql: getDaqValue failed for tag ' + tagid + ': ' + error);
                throw error;
            });
    };

    this.close = function () {
        if (!pool) { return; }
        const closing = pool;
        pool = null;
        ready = false;
        closing.end().catch((error) => logger.error('postgresql: close failed! ' + error));
    };

    /** One database, one owner: the adapter always owns every tag it is asked about. */
    this.getDaqMap = function (tagid) {
        const dummy = {};
        dummy[tagid] = true;
        return dummy;
    };

    async function ensureSchema() {
        await pool.query('CREATE TABLE IF NOT EXISTS ' + table + ' (' +
            'ts TIMESTAMPTZ NOT NULL, ' +
            'tag_id TEXT NOT NULL, ' +
            'device_id TEXT, ' +
            'device_name TEXT, ' +
            'value_num DOUBLE PRECISION, ' +
            'value_text TEXT)');
        await pool.query('CREATE INDEX IF NOT EXISTS ' + table + '_tag_ts ON ' + table + ' (tag_id, ts)');
    }

    async function writeRow(row) {
        if (!ready || !pool) { return; }
        const parsed = normalizeValue(row.value);
        await pool.query('INSERT INTO ' + table +
            ' (ts, tag_id, device_id, device_name, value_num, value_text) VALUES ($1,$2,$3,$4,$5,$6)',
            [new Date(Number(row.ts)), row.tagid, row.deviceId, row.deviceName, parsed.numberValue, parsed.stringValue]);
    }

    /** Runs the query and lets a failure be a failure; callers decide what it means. */
    function query(sql, params) {
        return pool.query(sql, params);
    }

    function getPoolConfig() {
        const daqstore = settings.daqstore || {};
        const credentials = daqstore.credentials || {};
        return {
            host: daqstore.host || '127.0.0.1',
            port: Number(daqstore.port) || 5432,
            database: daqstore.database || 'scadia',
            user: credentials.username || 'scadia',
            password: credentials.password || '',
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        };
    }

    function getTableName() {
        const name = String(settings.daqstore && settings.daqstore.tableName ? settings.daqstore.tableName : DEFAULT_TABLE).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { return name.toLowerCase(); }
        logger.warn('postgresql: invalid tableName "' + name + '", falling back to ' + DEFAULT_TABLE);
        return DEFAULT_TABLE;
    }

    function normalizeValue(value) {
        if (utils.isNullOrUndefined(value)) { return { numberValue: null, stringValue: null }; }
        if (utils.isBoolean(value)) { return { numberValue: value ? 1 : 0, stringValue: null }; }
        if (typeof value === 'number' && Number.isFinite(value)) { return { numberValue: value, stringValue: null }; }
        const asNumber = Number(value);
        if (String(value).trim() !== '' && Number.isFinite(asNumber)) { return { numberValue: asNumber, stringValue: null }; }
        return { numberValue: null, stringValue: String(value) };
    }

    this.init();
}

module.exports = {
    create: function (settings, logger, currentStorage, options) {   // options unused: one store
        return new Postgres(settings, logger, currentStorage);
    }
};
