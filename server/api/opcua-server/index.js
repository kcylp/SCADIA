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
const { projectGuard } = require('../_domain');

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
        app.use(projectGuard(() => runtime, { noStore: true }));

        // Status is readable by an AUTHENTICATED viewer: it is operational metadata, not project
        // content - and "operational metadata" is exactly what an unauthenticated caller should not
        // be able to enumerate (whether the server is up, on which port, under which resource path,
        // with how many tags and cameras published).
        //
        // WHY THE CHECK LOOKS LIKE THIS (batch 53, decisions on N-30 / N-41).
        //
        // A guard used to sit here reading `auth.isGuest && !auth.userId`, which could never fire:
        // authContext() always returns a userId, falling back to the literal 'guest'. The dead guard
        // was reported as a cosmetic finding; measuring it showed the opposite - the shared
        // middleware does not refuse a tokenless caller either (`jwt-helper.verifyToken` mints a
        // guest identity and calls next()), so in secure mode this endpoint answered 200 to a
        // request that presented nothing.
        //
        // The rule is now the one the rest of the codebase already uses for an authorisation
        // refusal (`auth.secureEnabled && auth.isGuest` -> 401, as in api/recipes and api/scheduler),
        // and the 401 code is a domain code rather than the platform-wide 'unauthorized_error'.
        //
        // It is applied to THIS domain only, and that limit is deliberate: 13 of the 16 API domains
        // never check isGuest, and most of them filter per item through
        // `runtime.checkPermission` - which answers {`show: true, enabled: true`} to a
        // `userPermission === undefined` caller. That is the product's guest-display path, and
        // changing it is a product decision with a much larger blast radius than this endpoint.
        // What this batch does instead is stop NEW domains from joining that set: see
        // test/architecture/apiGuestSurface.test.js, which measures the open set and pins it.
        app.get('/api/opcua-server/status', secureFnc, (req, res) => {
            const auth = authContext(req);
            if (auth.secureEnabled && auth.isGuest) {
                res.status(401).json({ error: 'OPCUA_UNAUTHENTICATED', message: 'authentication required' });
                return;
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
