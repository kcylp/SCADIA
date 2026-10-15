/**
 * 'api/daq': DAQ API to GET/POST storage daq data
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
    app: function () {
        var daqApp = express();
        daqApp.use(function (req, res, next) {
            if (!runtime.project) {
                res.status(404).end();
            } else {
                next();
            }
        });
        
        /**
         * GET daq data
         * Take from daq storage data and reply 
         */
         daqApp.get("/api/daq", secureFnc, function(req, res) {
            try {
                if (req.query && req.query.query) {
                    var query = JSON.parse(req.query.query);
                    const sids = Array.isArray(query.sids) ? [...new Set(query.sids.filter(id => typeof id === 'string' && id.length > 0))] : null;
                    const from = Number(query.from);
                    const to = Number(query.to);
                    const MAX_TAGS = 200;
                    const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
                    if (!sids || !sids.length || sids.length > MAX_TAGS || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > MAX_RANGE_MS) {
                        return res.status(400).json({ error: 'invalid_query', message: 'Invalid tag list or time range' });
                    }
                    const permission = checkGroupsFnc ? checkGroupsFnc(req) : null;
                    for (const sid of sids) {
                        const definition = runtime.devices && typeof runtime.devices.getTagDefinition === 'function'
                            ? runtime.devices.getTagDefinition(sid) : null;
                        if (!definition) { return res.status(403).json({ error: 'forbidden_tag', message: 'Tag is not available' }); }
                        const allowed = runtime.checkPermission ? runtime.checkPermission(permission, definition).enabled : true;
                        if (!allowed) { return res.status(403).json({ error: 'forbidden_tag', message: 'Tag is not available' }); }
                    }
                    var dbfncs = [];
                    for (const sid of sids) {
                        if (to === from) {  // current values
                            dbfncs.push([runtime.devices.getTagValue(sid, true)]);
                        } else {                        // from history
                            dbfncs.push(runtime.daqStorage.getNodeValues(sid, from, to));
                        }
                    }
                    if (to === from) {  // current values
                        res.json(dbfncs);
                    } else {
                        Promise.all(dbfncs).then(values => {
                            if (values) {
                                res.json(values);
                            } else {
                                res.status(404).end();
                                runtime.logger.error("api get daq: Not Found!");
                            }
                        }, reason => {
                            if (reason && reason.stack) {
                                runtime.logger.error(`api get daq: Not Found!: ${reason.stack}`);
                                res.status(400).json({error:"unexpected_error", message: "DAQ query failed"});
                            } else {
                                runtime.logger.error(`api get daq: Not Found!: ${reason}`);
                                res.status(400).json({error:"unexpected_error", message: "DAQ query failed"});
                            }
                        });
                    }
                } else {
                    res.status(404).end();
                    runtime.logger.error("api get daq: Not Found!");
                }
            } catch (err) {
                if (err && err.code) {
                    res.status(400).json({error:err.code, message: err.message});
                } else {
                    res.status(400).json({error:"unexpected_error", message:err.toString()});
                }
                runtime.logger.error("api get daq: " + err.message);
            }
        });
        return daqApp;
    }
}