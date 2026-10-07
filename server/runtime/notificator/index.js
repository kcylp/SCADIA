/*
* Notificator manager: check, save, send mails to notificate alarms, events
*/

'use strict';
const axios = require('axios');
const nodemailer = require('nodemailer');
const notifystorage = require('./notifications-storage');

var NOTIFY_CHECK_STATUS_INTERVAL = 1000 * 60;
var MILLI_MINUTE = 60000;

function NotificatorManager(_runtime) {
    var runtime = _runtime;
    var events = runtime.events;        // Events to commit change to runtime
    var settings = runtime.settings;    // Settings
    var logger = runtime.logger;        // Logger
    var notifyCheckStatus = null;       // TimerInterval to check Notificator status
    var working = false;                // Working flag to manage overloading of check notificator status
    var notificationsSubsctiption = {}; // Notifications matrix, grupped by subscriptions type
    var status = NotifyStatusEnum.INIT; // Current status (StateMachine)
    var clearNotifications = false;     // Flag to clear current notifications from DB
    var lastCheck = 0;                  // Timestamp to check intervall only in IDLE
    var subscriptionStatus = {};        // Status of subscription, to check if there are some change
    var notificationsFound = 0;         // Notifications found to check

    /**
     * Start TimerInterval to check Notifications
     */
    this.start = function () {
        return new Promise(function (resolve, reject) {
            logger.info('notificator check start', true);
            notifyCheckStatus = setInterval(function () {
                _checkStatus();     // check in 20 seconds interval
            }, 20000);
            // WITHOUT THIS the promise never settles and anything awaiting start() hangs for ever.
            // stop() resolves, so the omission was easy to miss - and a caller that awaits start()
            // during boot would simply never continue.
            resolve();
        });
    }

    /**
     * Stop StateMachine, break TimerInterval (_checkStatus)
     */
    this.stop = function () {
        return new Promise(function (resolve, reject) {
            logger.info('notificator.stop-checkstatus!', true);
            if (notifyCheckStatus) {
                clearInterval(notifyCheckStatus);
                notifyCheckStatus = null;
                status = NotifyStatusEnum.INIT;
                working = false;
            }
            resolve();
        });
    }

    this.reset = function () {
        this.clear();
        status = NotifyStatusEnum.LOAD;
    }

    this.clear = function () {
        clearNotifications = true;
    }

    this.clearNotifications = function (all) {
        return new Promise(function (resolve, reject) {
            notifystorage.clearNotifications(all).then((result) => {
                // 解析成 undefined：这是这个方法的既有对外契约
                // （test/runtime/notificatorLifecycle.test.js:110 钉着它），
                // 且全仓没有任何调用方读这个返回值。任务卡写的 resolve(true) 会把它改坏。
                resolve();
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    this.forceCheck = function () {
        lastCheck = 0;
        _checkStatus();
    }

    /**
     * Test seam: the notification objects the check pass actually holds.
     *
     * The persistence claim cannot be observed from outside without it. Every notification
     * whose category is active has its ontime rewritten the first time it is seen
     * (_checkNotifications resets the window on a status change), so reading the database
     * row or watching for a send compares two states that converge. Only the objects
     * themselves show whether _loadNotifications restored the stored window.
     *
     * Read-only: returns the live objects, which is what a caller needs to assert on.
     * Same shape of seam as the Notification constructor export above.
     */
    this.getInMemoryNotifications = function () {
        var result = [];
        Object.keys(notificationsSubsctiption).forEach(subkey => {
            notificationsSubsctiption[subkey].forEach(notification => { result.push(notification); });
        });
        return result;
    }

    /**
     * Check the Notify state machine
     */
    var _checkStatus = function () {
        if (status === NotifyStatusEnum.INIT) {
            if (_checkWorking(true)) {
                _init().then(function () {
                    status = NotifyStatusEnum.LOAD;
                    _checkWorking(false);
                }).catch(function (err) {
                    _checkWorking(false);
                });
            }
        } else if (status === NotifyStatusEnum.LOAD) {
            if (_checkWorking(true)) {
                _loadProperty().then(function () {
                    _loadNotifications().then(function () {
                        status = NotifyStatusEnum.IDLE;
                        _checkWorking(false);
                    }).catch(function (err) {
                        _checkWorking(false);
                    });
                }).catch(function (err) {
                    _checkWorking(false);
                });
            }
        } else if (status === NotifyStatusEnum.IDLE) {
            if (notificationsFound) {
                var current = new Date().getTime();
                if (current - lastCheck > NOTIFY_CHECK_STATUS_INTERVAL) {
                    lastCheck = current;
                    if (_checkWorking(true)) {
                        _checkNotifications().then(function () {
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
     * Init Notificator database
     */
    var _init = function () {
        return new Promise(function (resolve, reject) {
            notifystorage.init(settings, logger).then(result => {
                logger.info('notificator.notifystorage-init-successful!', true);
                resolve();
            }).catch(function (err) {
                logger.error('notificator.notifystorage.failed-to-init: ' + err);
                reject(err);
            });
        });
    }

    var _checkWorking = function (check) {
        if (check && working) {
            logger.warn('notificator working (check) overload!');
            return false;
        }
        working = check;
        return true;
    }

    /**
     * Load Notifications property in local for check
     */
    var _loadProperty = function () {
        return new Promise(function (resolve, reject) {
            notificationsSubsctiption = {};
            notificationsFound = 0;
            runtime.project.getNotifications().then(function (result) {
                if (result) {
                    result.forEach(notification => {
                        if (notification.enabled) {
                            Object.keys(notification.subscriptions).forEach(sub => {
                                if (notification.subscriptions[sub]) {
                                    if (!notificationsSubsctiption[sub]) {
                                        notificationsSubsctiption[sub] = [];
                                    }
                                    var temp = new Notification(notification.id, notification.name, notification.type);
                                    temp.receiver = notification.receiver;
                                    temp.delay = notification.delay;
                                    temp.interval = notification.interval;
                                    temp.enabled = notification.enabled;
                                    temp.text = notification.text;
                                    temp.subscriptions = notification.subscriptions;
                                    temp.options = notification.options;
                                    temp.mode = notification.mode;
                                    notificationsSubsctiption[sub].push(temp);
                                    notificationsFound++;
                                }
                            });
                            if (notification.type === 'access') {
                                if (!notificationsSubsctiption.access) {
                                    notificationsSubsctiption.access = [];
                                }
                                var accessNotification = new Notification(notification.id, notification.name, notification.type);
                                accessNotification.receiver = notification.receiver;
                                accessNotification.enabled = notification.enabled;
                                accessNotification.text = notification.text;
                                accessNotification.options = notification.options;
                                notificationsSubsctiption.access.push(accessNotification);
                                notificationsFound++;
                            }
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
     * Load current Notifications and merge with loaded property
     */
    var _loadNotifications = function () {
        return new Promise(function (resolve, reject) {
            if (clearNotifications) {
                notifystorage.clearNotifications().then(result => {
                    resolve();
                    clearNotifications = false;
                }).catch(function (err) {
                    logger.error('notificator.clear-current.failed: ' + err);
                    reject(err);
                });
            } else {
                notifystorage.getNotifications().then(result => {
                    Object.keys(notificationsSubsctiption).forEach(subkey => {
                        notificationsSubsctiption[subkey].forEach(notification => {
                            var currentNotify = result.find(currentNotify => currentNotify.id === notification.id);
                            if (currentNotify) {
                                notification.ontime = currentNotify.ontime;
                                notification.notifytime = currentNotify.notifytime;
                            }
                        });
                    });
                    resolve();
                }).catch(function (err) {
                    logger.error('notificator.load-current.failed: ' + err);
                    reject(err);
                });
            }
        });
    }

    var _isValidEmail = function (email) {
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        return emailRegex.test(email);
    }

    var _sendAccessNotifications = async function (event, data) {
        // Access notifications have no login/logout subscriptions: every
        // notification configured as type "access" receives both events.
        const notifications = notificationsSubsctiption.access || [];
        const content = event === 'login'
            ? `User${data?.username ? ` "${data.username}"` : ''} logged in (Login)`
            : `User${data?.username ? ` "${data.username}"` : ''} logged out (Logout)`;
        for (const notification of notifications) {
            try {
                if (!_isValidEmail(notification.receiver)) {
                    await runtime.notificatorMgr.postMessage(notification.receiver.replace(/\$\{content\}/g, content));
                } else {
                    await runtime.notificatorMgr.sendMail(new MailMessage(null, notification.receiver, notification.name, content), null);
                }
            } catch (err) {
                logger.error(`notificator.access.send.failed: ${err}`);
            }
        }
    }

    /**
     * Check Notifications status
     */
    var _checkNotifications = function () {
        return new Promise(function (resolve, reject) {
            var time = new Date().getTime();
            // check alarms categorie subscriptions
            try {
                var alarms = runtime.alarmsMgr.getAlarmsValues();
                var alarmsStatus = { highhigh: 0, high: 0, low: 0, info: 0 };
                alarms.forEach(alr => {
                    if (alr.status === 'N') {
                        alarmsStatus[alr.type]++;
                    }
                });
                Object.keys(alarmsStatus).forEach(async stkey => {
                    var isActive = alarmsStatus[stkey];
                    var wasActive = subscriptionStatus[stkey];
                    var statusChanged = !wasActive && isActive || (wasActive && isActive && subscriptionStatus[stkey] < alarmsStatus[stkey]);
                    if (isActive) {
                        if (notificationsSubsctiption[stkey]?.length ) {
                            if (statusChanged) {
                                // Check to reset timing for all notifications in this category
                                for (var i = 0; i < notificationsSubsctiption[stkey].length; i++) {
                                    var notification = notificationsSubsctiption[stkey][i];
                                    if (notification.mode !== NotificationModeEnum.single) {
                                        notification.ontime = time;
                                        notification.notifytime = 0;
                                        // P0(4)：计时改了内存就必须落库，否则重启后这段窗口白算
                                        notifystorage.saveNotification(notification);
                                    }
                                }
                            }
                            for (var i = 0; i < notificationsSubsctiption[stkey].length; i++) {
                                var notification = notificationsSubsctiption[stkey][i];
                                if (notification.checkToNotify(time, statusChanged)) {
                                    try {
                                        // get alarms summary in text format
                                        var alarmsSummary = runtime.alarmsMgr.getAlarmsString(stkey) || 'SCADIA Alarms Error!';

                                        const onSuccess = () => {
                                            notification.setNotify(time, stkey);
                                            // P0(4)：setNotify 只动内存。发出去了却不记住，
                                            // 重启后 interval 窗口重来一遍，同一场报警会重复发报。
                                            notifystorage.saveNotification(notification);
                                            logger.info(`notificator.notify.successful (mail): ${new Date()} ${notification.name} ${stkey} ${alarmsSummary}`);
                                        }

                                        if (!_isValidEmail(notification.receiver)) {
                                            const url = notification.receiver.replace(/\$\{content\}/g, alarmsSummary);
                                            await runtime.notificatorMgr.postMessage(url).then(function () {
                                                onSuccess();
                                            }).catch(function (senderr) {
                                                logger.error(`notificator.notify.send.failed: ${senderr}`);
                                            });
                                        } else {
                                            const mail = new MailMessage(null, notification.receiver, notification.name, alarmsSummary);
                                            await runtime.notificatorMgr.sendMail(mail, null).then(function () {
                                                onSuccess();
                                            }).catch(function (senderr) {
                                                logger.error(`notificator.notify.send.failed: ${senderr}`);
                                            });
                                        }
                                    } catch (e) {
                                        logger.error(`notificator.notify.failed: ${e}`);
                                    }
                                }
                            }
                        }
                    } else if (wasActive) {
                        // to reset
                        var notifications = notificationsSubsctiption[stkey] || [];
                        for (var i = 0; i < notifications.length; i++) {
                            var notification = notifications[i];
                            notification.reset();
                            logger.info(`notificator.notify.toreset: ${notification.name} ${stkey}`);
                        }
                    }
                    subscriptionStatus[stkey] = isActive;
                });
                resolve(true);
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Send mail
     * @returns
     */
    this.sendMail = function (msg, smtp) {
        return new Promise(async function (resolve, reject) {
            try {
                var smtpServer = smtp || settings.smtp;
                if (smtpServer && smtpServer.host && smtpServer.port && smtpServer.username && smtpServer.password) {
                    const transporter = nodemailer.createTransport({
                        host: smtpServer.host,
                        port: smtpServer.port,
                        secure: (smtpServer.port === 465) ? true : false, // true for 465, false for other ports
                        auth: {
                            user: smtpServer.username,
                            pass: smtpServer.password
                        }
                    });
                    if (!msg.from || smtpServer.mailsender) {
                        msg.from = smtpServer.mailsender || smtpServer.username;
                    }
                    let info = await transporter.sendMail(msg);
                    // Was console.log: a send result that only reaches stdout is invisible in the
                    // operator log, which is where someone looks when a notification "did not
                    // arrive". Same class as the scheduler accessors (batch 8).
                    logger.info('notificator.mail.sent: ' + info.messageId);
                    resolve(`Message sent: ${info.messageId}`);
                } else {
                    reject('SMTP data error!');
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    this.postMessage = function (url) {
        return new Promise(function (resolve, reject) {
            axios.get(url).then(res => {
                resolve(res.data);
            }).catch(err => {
                reject(err);
            });
        });
    }

    this.sendMailMessage = function (from, to, subj, text, html, attachments) {
        let mail = new MailMessage(from, to, subj, text, html, attachments);
        return this.sendMail(mail, null);
    }

    // check if alarms status chenaged
    events.on('alarms-status:changed', this.forceCheck);
    events.on('access:login', data => _sendAccessNotifications('login', data));
    events.on('access:logout', data => _sendAccessNotifications('logout', data));
}

module.exports = {
    create: function (runtime) {
        return new NotificatorManager(runtime);
    },
    createMessage: function(from, to, subj, text, html, attachments) {
        return new MailMessage(from, to, subj, text, html, attachments);
    },
    /**
     * Test seam: the notification model, so its delay/interval rule can be exercised directly.
     *
     * The rule decides WHEN a notification is sent and had no coverage, because the only way to
     * reach it was through the manager, which builds notifications from a storage layer that is
     * commented out. Exporting the constructor is the smallest honest way to test the shipped rule
     * instead of a reimplementation of it.
     */
    Notification: Notification,
    createNotification: function (id, name, type) {
        return new Notification(id, name, type);
    }
}

var NotificationModeEnum = {
    all: 0,
    single: 1
}

/**
 * State of Notificator manager
 */
var NotifyStatusEnum = {
    INIT: 'init',
    LOAD: 'load',
    IDLE: 'idle',
}

function Notification(id, name, type) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.receiver;
    this.delay = 1;
    this.interval = 0;
    this.ontime = 0;
    this.notifytime = 0;
    this.notifytype = '';
    this.enabled = true;
    this.text;
    this.subscriptions = {};
    this.options;

    this.hasSubscriptions = function () {
        return Object.keys(this.subscriptions).length ? true : false;
    }

    this.checkToNotify = function (time, changed) {
        if (!this.ontime) {
            this.ontime = time;
            return false;
        }
        var result = true;
        if (this.ontime + (this.delay * MILLI_MINUTE) > time) {
            result = false;
        } else if (this.notifytime && (this.interval <= 0 || this.notifytime + (this.interval * MILLI_MINUTE) > time)) {
            result = false;
        } else if (changed) { // !this.notifytime
            this.ontime = time;
            result = true;
        }
        return result;
    }

    this.setNotify = function (time, type) {
        this.notifytime = time;
        this.notifytype = type;
    }

    this.reset = function () {
        this.ontime = 0;
        this.notifytime = 0;
        this.notifytype = '';
    }
}

function MailMessage(from, to, subj, text, html, attachments) {
    this.from = from;
    this.to = to;
    this.subject = subj;
    this.text = text;
    this.html = html;
    this.attachments = attachments;
}