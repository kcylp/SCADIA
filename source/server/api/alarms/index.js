/**
 * 'api/alarms': Alarms API to GET/POST alarms data
 */

var express = require("express");
const authJwt = require('../jwt-helper');
var runtime;
var secureFnc;
var checkGroupsFnc;

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function() {
        var alarmsApp = express();
        alarmsApp.use(function(req, res, next) {
            if (!runtime.project) {
                res.status(404).end();
            } else {
                next();
            }
        });

        /**
         * GET current Alarms
         * Take from alarms storage and reply
         */
        alarmsApp.get("/api/alarms", secureFnc, async function(req, res) {
            const permission = checkGroupsFnc(req);
			 if (res.statusCode === 403) {
                runtime.logger.error("api get alarms: Tocken Expired");
            } else {
                try {
                    var filter = req.query.filter ? JSON.parse(req.query.filter) : null;
                    var result = await runtime.alarmsMgr.getAllAlarmsValues(filter, permission);
                    // res.header("Access-Control-Allow-Origin", "*");
                    // res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                    if (result) {
                        res.json(result);
                    } else {
                        res.end();
                    }
                } catch (err) {
                    if (err.code) {
                        res.status(400).json({error:err.code, message: err.message});
                    } else {
                        res.status(400).json({error:"unexpected_error", message:err.toString()});
                    }
                    runtime.logger.error("api get alarms: " + err.message);
                }
			}
        });

                /**
         * GET current Alarms
         * Take from alarms storage and reply
         */
        alarmsApp.get("/api/alarmsHistory", secureFnc, function(req, res) {
            const permission = checkGroupsFnc(req);
			if (res.statusCode === 403) {
                runtime.logger.error("api get alarms: Tocken Expired");
            } else {
                runtime.alarmsMgr.getAlarmsHistory(req.query, permission).then(result => {
                    // res.header("Access-Control-Allow-Origin", "*");
                    // res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                    if (result) {
                        res.json(result);
                    } else {
                        res.end();
                    }
                }).catch(function(err) {
                    if (err.code) {
                        res.status(400).json({error:err.code, message: err.message});
                    } else {
                        res.status(400).json({error:"unexpected_error", message:err.toString()});
                    }
                    runtime.logger.error("api get alarms: " + err.message);
                });
			}
        });

        /**
         * POST Alarm ACK
         * Set alarm ack
         */
        alarmsApp.post("/api/alarmack", secureFnc, function(req, res, next) {
            const permission = checkGroupsFnc(req);
			 if (res.statusCode === 403) {
                runtime.logger.error("api post alarms: Tocken Expired");
            } else {
                const scene = typeof req.body.params === 'string' && req.body.params.startsWith('scene:');
                if (scene && !require('../scene-auth').requireSceneAdmin(req, res, runtime, checkGroupsFnc)) { return; }
                const ack = scene ? runtime.alarmsMgr.setSceneAlarmAck(req.body.params, req.userId, req.userGroups, req.body.expectedOntime) :
                    runtime.alarmsMgr.setAlarmAck(req.body.params, req.userId, permission, req.body.expectedOntime);
                ack.then(function(data) {
                    res.end();
                }).catch(function(err) {
                    if (err.code) {
                        res.status(Number.isInteger(err.code) ? err.code : err.code === 'CAM_NOT_FOUND' ? 404 : 400).json({error:err.code, message: err.message});
                    } else {
                        res.status(400).json({error:"unexpected_error", message:err.toString()});
                    }
                    runtime.logger.error("api post alarm-ack: " + err.message);
                });
		  }
        });

        /**
         * POST Alarms clear
         */
        alarmsApp.post("/api/alarmsClear", secureFnc, function(req, res, next) {
            const permission = checkGroupsFnc(req);
			 if (res.statusCode === 403) {
                runtime.logger.error("api post alarms: Tocken Expired");
            } else if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({error:"unauthorized_error", message: "Unauthorized!"});
                runtime.logger.error("api post alarms: Unauthorized");
            } else {
            runtime.alarmsMgr.clearAlarms(req.body.params).then(function() {
                runtime.alarmsMgr.reset();
                res.end();
            }).catch(function(err) {
                if (err.code) {
                    res.status(400).json({error:err.code, message: err.message});
                } else {
                    res.status(400).json({error:"unexpected_error", message:err.toString()});
                }
                runtime.logger.error("api post alarms-clear: " + err.message);
            });
		  }
        });
        return alarmsApp;
    }
}
