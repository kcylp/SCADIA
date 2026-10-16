/*
* Jobs manager: check, reports, ...
*/

var Report = require('./report');
var Cleaner = require('./cleaner');
var fs = require('fs');

'use strict';

var JOBS_CHECK_STATUS_INTERVAL = 1000 * 60 * 30;    // 30 min.
var MILLI_MINUTE = 60000;

function JobsManager(_runtime) {
    var runtime = _runtime;
    var events = runtime.events;        // Events to commit change to runtime
    var logger = runtime.logger;        // Logger
    var jobsCheckStatus = null;         // TimerInterval to check Jobs status
    var working = false;                // Working flag to manage overloading of check notificator status
    var jobsList = [];                  // Jobs list to process
    var status = JobsStatusEnum.INIT;   // Current status (StateMachine)
    var lastCheck = 0;                  // Timestamp to check intervall only in IDLE
    var forceCheck = true;              // Flag to manage the forcing of check jobs
    var reportStatus = {};              // report.id -> last build result (accepted vs really done)
    var pendingForced = {};             // report.id -> 已接受但尚未执行的强制请求代号（在配置重载中存活）
    var reportGeneration = 0;           // 每次接受请求递增；终态回调只允许写自己代号的状态

    /**
     * Start TimerInterval to check Jobs
     */
    this.start = function () {
        return new Promise(function (resolve, reject) {
            logger.info('jobs check start', true);
            jobsCheckStatus = setInterval(function () {
                _checkStatus();     // check in 20 seconds interval
            }, 5000);
        });
    }

    /**
     * Stop StateMachine, break TimerInterval (_checkStatus)
     */
    this.stop = function () {
        return new Promise(function (resolve, reject) {
            logger.info('jobs.stop-checkstatus!', true);
            if (jobsCheckStatus) {
                clearInterval(jobsCheckStatus);
                jobsCheckStatus = null;
                status = JobsStatusEnum.INIT;
                working = false;
            }
            resolve();
        });
    }

    this.reset = function () {
        status = JobsStatusEnum.LOAD;
    }

    this.forceReport = function (report) {
        if (!report || !report.id) { return false; }
        var found = jobsList.some(item => item.type === JobType.Report && item.job.getProperty().id === report.id);
        if (!found && status !== JobsStatusEnum.LOAD && status !== JobsStatusEnum.INIT) {
            // 稳态下不在任务列表：真正的未知报表，维持原有 not_found 语义。
            return false;
        }
        // 重载窗口（LOAD/INIT）内先接受请求：重载完成后若报表仍不存在，_loadJobs 的孤儿检查会显式失败，
// 而不是像旧实现那样把 force 挂在即将被替换的 Job 对象上、重载后静默丢失。
        reportGeneration += 1;
        pendingForced[report.id] = reportGeneration;
        reportStatus[report.id] = { state: 'running', at: new Date().getTime(), gen: reportGeneration };
        forceCheck = true;
        return true;
    }

    /**
     * Last build result of a forced/scheduled report run: {state: running|completed|failed, at, error?}
     */
    this.getReportStatus = function (id) {
        var entry = reportStatus[id];
        return entry ? { state: entry.state, at: entry.at, error: entry.error, file: entry.file } : { state: 'unknown' };
    }

    /**
     * Check the Jobs state machine
     */
    var _checkStatus = function () {
        if (status === JobsStatusEnum.INIT) {
            if (_checkWorking(true)) {
                _init().then(function () {
                    status = JobsStatusEnum.LOAD;
                    _checkWorking(false);
                }).catch(function (err) {
                    _checkWorking(false);
                });
            }
        } else if (status === JobsStatusEnum.LOAD) {
            if (_checkWorking(true)) {
                _loadJobs().then(function () {
                    status = JobsStatusEnum.IDLE;
                    _failOrphanedForcedRequests();
                    _checkWorking(false);
                }).catch(function (err) {
                    _checkWorking(false);
                });
            }
        } else if (status === JobsStatusEnum.IDLE) {
            if (jobsList.length) {
                var current = new Date().getTime();
                if (forceCheck || current - lastCheck > JOBS_CHECK_STATUS_INTERVAL) {
                    lastCheck = current;
                    forceCheck = false;
                    if (_checkWorking(true)) {
                        _checkJobs().then(function () {
                            _checkWorking(false);
                        }).catch(function (err) {
                            _checkWorking(false);
                        });
                    }
                }
            }
        }
    }

    /**
     * Init Jobs resource
     */
    var _init = function () {
        return new Promise(function (resolve, reject) {
            resolve();
        });
    }

    var _checkWorking = function (check) {
        if (check && working) {
            logger.warn('jobs working (check) overload!');
            return false;
        }
        working = check;
        return true;
    }

    /**
     * Load current Jobs: Reports
     */
    var _loadJobs = function () {
        return new Promise(function (resolve, reject) {
            jobsList = [];
            // cleaner
            try {
                var cleaner = Cleaner.create(runtime);
                var job = new Job(cleaner, JobType.Cleaner);
                jobsList.push(job);    
            } catch (err) {
                logger.error(`_loadJobs.cleaner.failed: ${err}`);
            }    
            // reports
            runtime.project.getReports().then(function (result) {
                if (result) {
                    result.forEach(rptProperty => {
                        if (rptProperty.scheduling !== Report.ReportSchedulingType.none) {
                            var report = Report.create(rptProperty, runtime);
                            var job = new Job(report, JobType.Report);
                            jobsList.push(job);
                        }
                    });
                }
                resolve();
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    /**
     * 重载完成后，为已接受但无法继续的强制请求给出显式失败终态：
     * 报表已删除或调度为 none 都不会被加载进任务列表，请求不能永远留在 running。
     */
    var _failOrphanedForcedRequests = function () {
        var loaded = {};
        jobsList.forEach(function (item) {
            if (item.type === JobType.Report) { loaded[item.job.getProperty().id] = true; }
        });
        Object.keys(pendingForced).forEach(function (id) {
            if (loaded[id]) { return; }
            var gen = pendingForced[id];
            delete pendingForced[id];
            var entry = reportStatus[id];
            if (entry && entry.state === 'running' && entry.gen === gen) {
                reportStatus[id] = { state: 'failed', at: new Date().getTime(), gen: gen,
                    error: '报表未加载：已删除或调度类型为 none，无法生成' };
            }
        });
    }

    /**
     * Check Jobs status
     */
    var _checkJobs = function () {
        return new Promise(async function (resolve, reject) {
            var jobsExecute = []
            try {
                jobsList.forEach(item => {
                    if (item.job['execute']) {
                        var forced = false, gen = 0;
                        if (item.type === JobType.Report) {
                            var reportId = item.job.getProperty().id;
                            if (pendingForced[reportId] != null) {
                                // 消费已接受的强制请求（可能在配置重载期间提交，因此不能依赖 Job 对象上的标志）。
                                gen = pendingForced[reportId];
                                delete pendingForced[reportId];
                                forced = true;
                                reportStatus[reportId] = { state: 'running', at: new Date().getTime(), gen: gen };
                            }
                        }
                        var run = item.job['execute'](new Date(), forced);
                        if (item.type === JobType.Report) {
                            (function (rid, rgen, rforced) {
                                run.then(function (value) {
                                    var entry = reportStatus[rid];
                                    // 仅本次请求自己的回调可以写终态：旧请求晚到不得串改新请求。
                                    if (!entry || entry.state !== 'running' || entry.gen !== rgen) { return; }
                                    if (!rforced) {
                                        // 非强制轮空（resolve(true) 的“本次不执行”）不改写请求状态。
                                        return;
                                    }
                                    if (typeof value === 'string' && fs.existsSync(value)) {
                                        reportStatus[rid] = { state: 'completed', at: new Date().getTime(), gen: rgen, file: value };
                                    } else {
                                        // 强制请求却拿到轮空/无文件：这是丢失或异常，必须显式失败。
                                        reportStatus[rid] = { state: 'failed', at: new Date().getTime(), gen: rgen,
                                            error: '报表生成未产生可读取的文件（' + (value === true ? '调度轮空' : '写盘失败') + '）' };
                                    }
                                }, function (err) {
                                    var entry = reportStatus[rid];
                                    if (!entry || entry.state !== 'running' || entry.gen !== rgen) { return; }
                                    reportStatus[rid] = { state: 'failed', at: new Date().getTime(), gen: rgen, error: String(err && err.message || err) };
                                });
                            })(reportId, gen, forced);
                        }
                        jobsExecute.push(run);
                        item.force = false;
                    }
                });
                Promise.all(jobsExecute).then(values => {
                    resolve(values);
                }, reason => {
                    if (reason && reason.stack) {
                        logger.error(`checkJobs: ${reason.stack}`);
                    } else {
                        logger.error(`checkJobs: ${reason}`);
                    }
                    reject(reason);
                });
            } catch (err) {
                logger.error(`checkJobs.failed: ${err}`);
                reject(err);
            }                
        });
    }
}

module.exports = {
    create: function (runtime) {
        return new JobsManager(runtime);
    }
}

/**
 * State of Jobs manager
 */
const JobsStatusEnum = {
    INIT: 'init',
    LOAD: 'load',
    IDLE: 'idle',
}

function Job(_job, _type) {
    this.job = _job;
    this.type = _type;
    this.force = false;
}

const JobType = {
    Report: 1,
    Cleaner: 2,
}