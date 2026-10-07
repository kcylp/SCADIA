/**
 * The real authorization behaviour of GET /api/opcua-server/status (batch 47, N-30 / N-41).
 *
 * WHY THIS FILE EXISTS
 *
 * The route used to carry a guard that could never fire:
 *
 *     if (auth.isGuest && !auth.userId) { res.status(401).json({ error: 'OPCUA_UNAUTHENTICATED', ... }) }
 *
 * authContext() falls back to the literal `'guest'` when there is no userId (`req.userId || 'guest'`), so
 * `!auth.userId` was always false. A security-looking branch that is dead is worse than no branch:
 * it makes the file read as if a tokenless caller is refused, and nothing says otherwise.
 *
 * DEAD CODE IS NOT THE WHOLE FINDING. The shared middleware does not refuse the caller either:
 * `jwt-helper.verifyToken` assigns a guest identity and calls next(). So with security ON, this endpoint
 * answers 200 to a request that presents nothing. The tests below pin what it ACTUALLY does, in
 * both security modes, so that whoever decides the authorization question (N-41) changes it
 * deliberately instead of discovering it in production.
 */

'use strict';

const http = require('http');
const express = require('express');
const sinon = require('sinon');

const opcuaApi = require('../../api/opcua-server');
const authJwt = require('../../api/jwt-helper');

let expect;

/** The identity `jwt-helper.verifyToken` hands to a caller that presents no token at all. */
const GUEST = { userId: 'guest', userGroups: ['guest'] };
/** A signed-in operator: not a guest, no admin group. */
const VIEWER = { userId: 'viewer-1', userGroups: ['viewer'] };

function request(server) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: '/api/opcua-server/status' }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (err) { parsed = null; }
                resolve({ statusCode: res.statusCode, body: parsed, raw: body });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

describe('Security - OPC UA status authorization', () => {
    let sandbox;
    let server;
    let caller;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    beforeEach(async () => {
        sandbox = sinon.createSandbox();
        caller = GUEST;

        const runtime = {
            settings: { secureEnabled: true },
            project: { id: 'test-project' },
            opcuaServer: {
                status: () => ({
                    enabled: true, running: true, port: 4840, resourcePath: '/UA/SCADA',
                    rootName: 'SCADA', writeEnabled: false, allowAnonymous: true, tags: 3, cameras: 0
                })
            },
            logger: { error() {}, info() {}, warn() {} }
        };

        // The real middleware chain, reduced to what it does to identity: it never refuses a
        // tokenless caller, it labels it a guest.
        function secureFnc(req, res, next) {
            req.userId = caller.userId;
            req.userGroups = caller.userGroups;
            req.isAuthenticated = caller !== GUEST;
            next();
        }
        function checkGroupsFnc(req) {
            return authJwt.isGuestUser(req.userId, req.userGroups) ? ['guest'] : req.userGroups;
        }

        opcuaApi.init(runtime, secureFnc, checkGroupsFnc);
        const app = express();
        app.use(opcuaApi.app());
        server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    });

    afterEach((done) => {
        sandbox.restore();
        server.close(() => done());
    });

    it('refuses a tokenless (guest) caller with a 401 and a domain code', async () => {
        // DECIDED in batch 53 (N-41). This endpoint used to answer 200 to a request that presented
        // nothing - not because anyone chose that, but because the guard that was supposed to refuse
        // it read `auth.isGuest && !auth.userId`, which can never be true. Operational metadata
        // (is it up, on which port, how many tags) is not public information on an SCADA surface.
        caller = GUEST;
        const res = await request(server);

        expect(res.statusCode).to.equal(401);
        expect(res.body.error, 'a domain code, not the platform-wide unauthorized_error')
            .to.equal('OPCUA_UNAUTHENTICATED');
        expect(res.body, 'no operational detail may leak in the refusal').to.not.have.property('port');
    });

    it('answers a signed-in viewer with the status', async () => {
        caller = VIEWER;
        const res = await request(server);

        expect(res.statusCode).to.equal(200);
        expect(res.body).to.include({ enabled: true, rootName: 'SCADA' });
    });

    it('reports a disabled OPC UA server as { enabled: false }', async () => {
        caller = VIEWER;
        const runtime = {
            settings: { secureEnabled: true },
            project: { id: 'test-project' },
            logger: { error() {}, info() {}, warn() {} }
        };
        opcuaApi.init(runtime, (req, res, next) => { req.userId = caller.userId; req.userGroups = caller.userGroups; next(); }, () => ['guest']);
        const app = express();
        app.use(opcuaApi.app());
        const bare = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const res = await request(bare);
            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal({ enabled: false });
        } finally {
            await new Promise((resolve) => bare.close(resolve));
        }
    });

    it('turns a status() failure into OPCUA_INTERNAL_ERROR, not a hung request', async () => {
        caller = VIEWER;
        const runtime = {
            settings: { secureEnabled: true },
            project: { id: 'test-project' },
            opcuaServer: { status: () => { throw new Error('address space missing'); } },
            logger: { error() {}, info() {}, warn() {} }
        };
        opcuaApi.init(runtime, (req, res, next) => { req.userId = caller.userId; req.userGroups = caller.userGroups; next(); }, () => ['guest']);
        const app = express();
        app.use(opcuaApi.app());
        const broken = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const res = await request(broken);
            expect(res.statusCode).to.equal(500);
            expect(res.body.error).to.equal('OPCUA_INTERNAL_ERROR');
            expect(res.body.message).to.equal('address space missing');
        } finally {
            await new Promise((resolve) => broken.close(resolve));
        }
    });
});