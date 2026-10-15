/**
 * 'api/opcua-server': REST surface for the OPC UA server.
 *
 * The OPC UA server itself is the integration channel; these routes only report
 * its state (is it listening, how much of the project is published) so the
 * operator can confirm connectivity without an OPC UA client at hand.
 */

'use strict';

var express = require('express');
const authJwt = require('../jwt-helper');

var runtime;
var secureFnc;
var checkGroupsFnc;

function authContext(req) {
    const secureEnabled = !!(runtime.settings && runtime.settings.secureEnabled);
    if (!secureEnabled) {
        return { secureEnabled: false, isGuest: false, isAdmin: true, userId: req.userId || 'guest' };
    }
    const permission = checkGroupsFnc(req);
    return {
        secureEnabled: true,
        isGuest: authJwt.isGuestUser(req.userId, req.userGroups),
        isAdmin: authJwt.haveAdminPermission(permission),
        userId: req.userId || 'guest'
    };
}

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        var app = express();
        app.use(function (req, res, next) {
            if (!runtime.project) { res.status(404).end(); return; }
            res.setHeader('Cache-Control', 'no-store');
            next();
        });

        // Status is readable by any authenticated viewer: it is operational
        // metadata, not project content.
        app.get('/api/opcua-server/status', secureFnc, (req, res) => {
            if (runtime.settings && runtime.settings.secureEnabled) {
                const auth = authContext(req);
                if (auth.isGuest && !auth.userId) {
                    res.status(401).json({ error: 'OPCUA_UNAUTHENTICATED', message: 'authentication required' });
                    return;
                }
            }
            if (!runtime.opcuaServer) {
                res.json({ enabled: false });
                return;
            }
            try {
                res.json(runtime.opcuaServer.status());
            } catch (err) {
                res.status(500).json({ error: 'OPCUA_INTERNAL_ERROR', message: err.message });
            }
        });

        return app;
    }
};
