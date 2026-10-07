'use strict'

/**
 * TDengine 时序适配器（D9）
 *
 * D9 是三次填空里的第二次，目的同样是**证明 D4 的契约**，不是再加一个后端。
 *
 * 本次把三件早已登记的事做实（A-07 / F-2 / O-6），并把「连不上」变成可预期的降级：
 *
 *   1. **不再以 unhandled rejection 逃逸**（A-07）。旧代码是 this.init().then(...) 且无
 *      catch，而 init 在缺少 credentials 时会同步抛 TypeError —— 调用方抓不到，Node 默认
 *      终止进程。现在 init 自己吞下并记录，写读在未连接时降级为「无数据 + 一行日志」。
 *   2. **保留期落地**（F-2）。旧代码建库处写着 //TODO add retention，于是「TDengine 有保留期」
 *      这句话只对引擎成立、对我们不成立。现在按文档的 KEEP（天）写入，天数据来自产品既有的
 *      utils.getRetentionLimit —— 不另抄一张映射表。
 *   3. **连不上不再是崩溃**。构造与读写都不再假设 conn 存在。
 *
 * 尚未做（见 20_纸上实现_D3.md 的 F-3）：tag_value 仍是 BINARY(20)。改列类型需要对着真引擎
 * 验证 TDengine 3.x 的取值与长度语义，本机没有实例（A-09），因此**不猜**，登记归 D9 的证实环节。
 *
 * 状态：unproven —— 从未在真引擎上跑过，证明它见 registry 的 proveWith。
 */

let { options, connect } = require("@tdengine/rest");
let utils = require('../../utils');

// TDengine quotes IDENTIFIERS with backticks; single quotes are string literals there.
// CREATE DATABASE IF NOT EXISTS 'x' answers HTTP 200 with code 9728 "syntax error" on a
// real engine (measured against 3.3.6.0, batch 90-AD), so the old single-quoted wrapper made
// every adapter statement no-op silently while init reported connected - which is exactly why
// the contract suite timed out waiting for data that never landed.
function quoteTdIdentifier(value) {
    return '`' + String(value).replace(/`/g, '``') + '`';
}

function escapeTdString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/\u0027/g, "\u0027\u0027");
}

function TDengine(_settings, _log, _currentStorage) {
    const settings = _settings;
    const logger = _log;
    const currentStorage = _currentStorage;
    const daqstore = (settings && settings.daqstore) ? settings.daqstore : {};
    const database = daqstore.database || 'scadia';
    const databaseRef = quoteTdIdentifier(database);

    let conn = null;
    let connected = false;
    let refusalLogged = false;

    this.setCall = function (_fncGetProp) {
        fncGetTagProp = _fncGetProp;
        return this.addDaqValues;
    }
    var fncGetTagProp = null;

    /**
     * Never rejects. An unreachable backend degrades to "no data" with the reason in the log;
     * it must not become an unhandled rejection, and it must not throw out of the constructor.
     */
    this.init = async function () {
        try {
            const credentials = daqstore.credentials || {};
            let connOpt = Object.assign({}, options, daqstore);
            connOpt.user = credentials.username;
            connOpt.passwd = credentials.password;
            conn = connect(connOpt);

            const cursor = conn.cursor();
            // The REST layer answers HTTP 200 with the SQL error code in the body, so an
            // unchecked CREATE used to look like success while creating nothing (90-AD).
            const createDb = await cursor.query('CREATE DATABASE IF NOT EXISTS ' + databaseRef + keepClause());
            if (createDb && typeof createDb.getErrCode === 'function' && createDb.getErrCode() !== 0) {
                throw new Error('CREATE DATABASE answered code ' + createDb.getErrCode() + ': ' + createDb.getErrStr());
            }
            const createStable = await cursor.query('CREATE STABLE IF NOT EXISTS ' + databaseRef + '.meters ' +
                '(dt TIMESTAMP, tag_id VARCHAR(200), tag_value BINARY(20)) ' +
                'TAGS (device_id VARCHAR(200), device_name BINARY(256))');
            if (createStable && typeof createStable.getErrCode === 'function' && createStable.getErrCode() !== 0) {
                throw new Error('CREATE STABLE answered code ' + createStable.getErrCode() + ': ' + createStable.getErrStr());
            }
            connected = true;
            refusalLogged = false;
            logger.info('daqstorage: TDengine connected, database ' + database, true);
        } catch (error) {
            connected = false;
            conn = null;
            logger.error('daqstorage: TDengine init failed! ' + error);
        }
    }

    this.addDaqValues = function (tagsValues, deviceName, deviceId) {
        var dataToRestore = [];
        for (const tagid in tagsValues) {
            const tag = tagsValues[tagid];
            if (!tag.daq || utils.isNullOrUndefined(tag.value) || Number.isNaN(tag.value)) {
                if (tag.daq && tag.daq.restored) {
                    dataToRestore.push({ id: tag.id, deviceId: deviceId, value: tag.value });
                }
                if (!tag.daq || !tag.daq.enabled) {
                    continue;
                }
            }
            if (!connected || !conn) {
                if (!refusalLogged) {
                    refusalLogged = true;
                    logger.error('daqstorage: TDengine is not connected, values are not being archived. ' +
                        'Check settings.daqstore for this backend.');
                }
                continue;
            }

            const safeDeviceId = quoteTdIdentifier(deviceId);
            const safeDeviceTag = escapeTdString(deviceId);
            const safeDeviceName = escapeTdString(deviceName);
            const safeTagId = escapeTdString(tagid);
            const safeTagValue = escapeTdString(tag.value);
            let insertSql = 'INSERT INTO ' + databaseRef + '.' + safeDeviceId +
                ' USING ' + databaseRef + '.meters TAGS(\u0027' + safeDeviceTag + '\u0027,\u0027' + safeDeviceName + '\u0027)\n' +
                ' VALUES (NOW, \u0027' + safeTagId + '\u0027, \u0027' + safeTagValue + '\u0027)';

            // One statement per tag and deliberately not batched: the TimeSeries domain
            // requires that one tag failing does not roll back another.
            cursorOf().query(insertSql).then((rst) => {
                if (0 !== rst.getErrCode()) {
                    logger.error('daq addValue error[' + rst.getErrCode() + ']: ' + rst.getErrStr());
                }
            }).catch((err) => {
                logger.error('daq addValue error ' + err);
            })
        }

        if (dataToRestore.length && currentStorage) {
            currentStorage.setValues(dataToRestore);
        }
    }

    /** Half-open [from, to), exactly as the query contract requires. */
    this.getDaqValue = function (tagid, fromts, tots) {
        return new Promise(function (resolve, reject) {
            if (!connected || !conn) {
                // A-07: an unreachable backend degrades to "no data"; it does not fail the caller.
                // This branch used to reject with new Error('not connected') while the WRITE path
                // above (addDaqValues, :92-98) already did the right thing - one logger.error and
                // return - so the read path simply never followed the convention this file set for
                // itself. It survived because the line is only reachable once a REAL TDengine
                // answers init(): every earlier gate ran with the container down, the probe
                // returned before it ever called getDaqValue, and the green was a "did not get
                // there" green. Settling with [] keeps A-07, matches the write path twelve lines
                // up, and matches the sibling adapters (questdb :99-106, postgresql :90-94,
                // sqlite :381-387). A query that DOES reach a live engine and fails still travels
                // as a failure - see the catch below.
                if (!refusalLogged) {
                    refusalLogged = true;
                    logger.error('daqstorage: TDengine is not connected, reads are answered with no data. ' +
                        'Check settings.daqstore for this backend.');
                }
                resolve([]);
                return;
            }
            const safeTagId = escapeTdString(tagid);
            cursorOf().query('SELECT CAST(dt as BIGINT) as dt, tag_value\n' +
                '                          FROM ' + databaseRef + '.meters\n' +
                '                            WHERE tag_id = \u0027' + safeTagId + '\u0027\n' +
                '                            and dt >= ' + Number(fromts) + '\n' +
                '                            and dt < ' + Number(tots) + ' ').then((result) => {
                const data = [];
                result.getData().forEach((row) => {
                    data.push({ dt: row[0], value: row[1] })
                })
                resolve(data)
            }).catch((error) => {
                logger.error('TDengine-getDaqValue failed! ' + error)
                reject(error)
            })
        })
    }

    this.close = function () {
        // The REST client holds no socket of its own; nothing to release.
    }

    this.getDaqMap = function (tagid) {
        var dummy = {};
        dummy[tagid] = true;
        return dummy;
    }

    function cursorOf() {
        return conn.cursor();
    }

    /**
     * KEEP takes a number of days and is documented on CREATE DATABASE. The number comes from
     * the same retention setting the rest of the product uses - utils.getRetentionLimit already
     * turns it into a date - so there is no second mapping table to keep in step.
     */
    function keepClause() {
        const retention = daqstore.retention;
        if (!retention || retention === 'none') { return ''; }
        try {
            const limit = utils.getRetentionLimit(retention);
            if (!(limit instanceof Date)) { return ''; }
            const days = Math.round((Date.now() - limit.getTime()) / 86400000);
            if (!Number.isFinite(days) || days <= 0) { return ''; }
            return ' KEEP ' + days;
        } catch (error) {
            logger.warn('daqstorage: could not derive KEEP from retention "' + retention + '": ' + error);
            return '';
        }
    }

    // Belt and braces: init() already swallows everything, but if it ever grows a path that
    // rejects, this must not become an unhandled rejection that kills the host (A-07).
    this.init().catch((error) => {
        logger.error('daqstorage: TDengine init escaped! ' + error);
    });
}

module.exports = {
    create: function (settings, logger, currentStorage, options) {   // options unused: one store
        return new TDengine(settings, logger, currentStorage);
    },
    _private: {
        escapeTdString
    }
};
