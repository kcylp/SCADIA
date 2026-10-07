/**
 * 'api/scheduler': Scheduler API to GET/POST scheduler data
 */

var express = require("express");
const authJwt = require('../jwt-helper');
const { projectGuard } = require('../_domain');

var runtime;
var secureFnc;
var checkGroupsFnc;

/**
 * Error codes for this domain. SCH_ matches the prefix its authorisation frames already use
 * (SCH_FORBIDDEN below), so the whole domain speaks one vocabulary.
 *
 * What this replaced, measured in batch 66: eleven frames answering { error: <a sentence> },
 * and eight of them answering { error: <an Error object> } or { error: err.toString() } - an
 * Error serialises to {} over JSON, so those responses carried NO error text at all.
 */
const ERR_HTTP = {
    SCH_MISSING_ID: 400,
    SCH_INVALID_DATA: 400,
    SCH_STORAGE_ERROR: 400
};

/** One error frame for the domain. Never writes a body after headers were sent. */
function sendSchedulerError(res, code, message) {
    if (res.headersSent) { return; }
    res.status(ERR_HTTP[code] || 500).json({ error: code, message: message });
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        var schedulerApp = express();
        schedulerApp.use(projectGuard(() => runtime));
        
        // GET scheduler data
        schedulerApp.get("/api/scheduler", secureFnc, function(req, res) {
            try {
                if (req.query && req.query.id) {
                    var schedulerId = req.query.id;
                    runtime.schedulerStorage.getSchedulerData(schedulerId).then(result => {
                        if (result) {
                            res.json(result);
                        } else {
                            res.json({ schedules: {} });
                        }
                    }).catch(err => {
                        runtime.logger.error("get scheduler data error! " + err);
                        sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err && err.message ? err.message : err));
                    });
                } else {
                    sendSchedulerError(res, 'SCH_MISSING_ID', 'Missing scheduler id parameter');
                }
            } catch (err) {
                runtime.logger.error("get scheduler data error! " + err);
                sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err && err.message ? err.message : err));
            }
        });

        // POST scheduler data
        schedulerApp.post("/api/scheduler", secureFnc, function(req, res) {
            if (res.statusCode === 403) {
                runtime.logger.error("api post scheduler: Tocken Expired");
                return;
            }
            const permission = checkGroupsFnc(req);
            const isGuest = authJwt.isGuestUser(req.userId, req.userGroups);
            const isAdmin = authJwt.haveAdminPermission(permission);
            if (runtime.settings?.secureEnabled && isGuest) {
                // Domain code, not the platform-wide 'unauthorized_error' (N-23): the 401 already
                // says "not authenticated" at the transport level, so the body can say WHICH
                // authorisation rule refused - the shape api/cameras, api/devices and
                // api/calibration already answer with (CAM_*/DEV_*/CAL_*).
                res.status(401).json({error:"SCH_FORBIDDEN", message: "scheduler writes require an authenticated user"});
                runtime.logger.error("api post scheduler: Unauthorized guest");
                return;
            }
            try {
                if (req.body && req.body.id && req.body.data !== undefined) {
                    var schedulerId = req.body.id;
                    var schedulerData = req.body.data;
                    
                    // LOG INCOMING DATA
                    runtime.logger.info('[API POST SCHEDULER] Received data for scheduler: ' + schedulerId);
                    runtime.logger.info('[API POST SCHEDULER] Settings: ' + JSON.stringify(schedulerData.settings, null, 2));
                    runtime.logger.info('[API POST SCHEDULER] Device Actions: ' + JSON.stringify(schedulerData.settings?.deviceActions, null, 2));

                    runtime.schedulerStorage.getSchedulerData(schedulerId).then(oldData => {
                        if (runtime.settings?.secureEnabled && !isAdmin) {
                            if (!oldData || !oldData.settings) {
                                runtime.logger.error("api post scheduler: Unauthorized scheduler settings change");
                                res.status(401).json({error:"SCH_FORBIDDEN", message: "changing scheduler settings requires an admin; schedules alone may be edited by a non-admin"});
                                return null;
                            }
                            schedulerData = Object.assign({}, oldData, {
                                schedules: schedulerData.schedules || {}
                            });
                        }

                        const validation = validateSchedulerData(schedulerData);
                        if (!validation.valid) {
                            runtime.logger.error("Invalid scheduler data: " + validation.error);
                            sendSchedulerError(res, 'SCH_INVALID_DATA', 'Invalid scheduler data: ' + validation.error);
                            return null;
                        }

                        return runtime.schedulerStorage.setSchedulerData(schedulerId, schedulerData).then(result => {
                            runtime.logger.info('[API POST SCHEDULER] Data saved successfully to database');
                            res.json({ result: 'ok' });
                            if (runtime.schedulerService) {
                                runtime.schedulerService.updateScheduler(schedulerId, schedulerData, oldData);
                            }
                        });
                    }).catch(err => {
                        runtime.logger.error("set scheduler data error! " + err);
                        sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err && err.message ? err.message : err));
                    });
                } else {
                    sendSchedulerError(res, 'SCH_MISSING_ID', 'Missing scheduler id or data in request body');
                }
            } catch (err) {
                runtime.logger.error("set scheduler data error! " + err);
                sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err && err.message ? err.message : err));
            }
        });

        // DELETE scheduler data
        schedulerApp.delete("/api/scheduler", secureFnc, function(req, res) {
            if (res.statusCode === 403) {
                runtime.logger.error("api delete scheduler: Tocken Expired");
                return;
            }
            const permission = checkGroupsFnc(req);
            const isGuest = authJwt.isGuestUser(req.userId, req.userGroups);
            if (runtime.settings?.secureEnabled && (isGuest || !authJwt.haveAdminPermission(permission))) {
                res.status(401).json({error:"SCH_FORBIDDEN", message: "deleting a scheduler requires an admin"});
                runtime.logger.error("api delete scheduler: admin permission required");
                return;
            }
            try {
                if (req.query && req.query.id) {
                    var schedulerId = req.query.id;
                    
                    if (runtime.schedulerService && runtime.schedulerService.removeScheduler) {
                        runtime.schedulerService.removeScheduler(schedulerId).then(() => {
                            return runtime.schedulerStorage.deleteSchedulerData(schedulerId);
                        }).then(result => {
                            res.json({ result: 'ok', deleted: result.changes });
                        }).catch(err => {
                            runtime.logger.error("delete scheduler error! " + err);
                            sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err));
                        });
                    } else {
                        runtime.schedulerStorage.deleteSchedulerData(schedulerId).then(result => {
                            res.json({ result: 'ok', deleted: result.changes });
                        }).catch(err => {
                            runtime.logger.error("delete scheduler data error! " + err);
                            sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err));
                        });
                    }
                } else {
                    sendSchedulerError(res, 'SCH_MISSING_ID', 'Missing scheduler id parameter');
                }
            } catch (err) {
                runtime.logger.error("delete scheduler error! " + err);
                sendSchedulerError(res, 'SCH_STORAGE_ERROR', String(err));
            }
        });

        return schedulerApp;
    }
};

// Validate scheduler data structure
function validateSchedulerData(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: 'Data must be an object' };
    }
    
    if (!data.schedules || typeof data.schedules !== 'object') {
        return { valid: false, error: 'Missing or invalid schedules object' };
    }
    
    if (!data.settings || typeof data.settings !== 'object') {
        return { valid: false, error: 'Missing or invalid settings object' };
    }
    
    if (!data.settings.devices || !Array.isArray(data.settings.devices)) {
        return { valid: false, error: 'Missing or invalid settings.devices array' };
    }
    
    const deviceNames = new Set();
    for (let device of data.settings.devices) {
        if (!device.name || typeof device.name !== 'string') {
            return { valid: false, error: 'Device missing name property' };
        }
        if (!device.variableId || typeof device.variableId !== 'string') {
            return { valid: false, error: `Device "${device.name}" missing variableId` };
        }
        deviceNames.add(device.name);
    }
    
    for (let deviceName in data.schedules) {
        if (!deviceNames.has(deviceName)) {
            console.warn(`Warning: Schedule exists for "${deviceName}" but device not found in settings.devices`);
        }
        
        const schedules = data.schedules[deviceName];
        if (!Array.isArray(schedules)) {
            return { valid: false, error: `Schedules for "${deviceName}" must be an array` };
        }
        
        for (let i = 0; i < schedules.length; i++) {
            const schedule = schedules[i];
            
            if (!schedule.startTime) {
                return { valid: false, error: `Schedule ${i} for "${deviceName}" missing startTime` };
            }
            
            if (!schedule.days || !Array.isArray(schedule.days) || schedule.days.length !== 7) {
                return { valid: false, error: `Schedule ${i} for "${deviceName}" missing or invalid days array` };
            }
            
            if (schedule.deviceName !== deviceName) {
                console.warn(`Warning: Schedule.deviceName "${schedule.deviceName}" doesn't match key "${deviceName}"`);
            }
        }
    }
    
    return { valid: true };
}
