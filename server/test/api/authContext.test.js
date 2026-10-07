/**
 * The shared request-authorisation gate, tested directly.
 *
 * WHY THIS FILE EXISTS NOW
 *
 * The gate was copy-pasted into four API domains, and each domain was tested only through its own
 * routes - so the two copies that had drifted (a missing `userId`, a differently-spelled settings
 * check) were invisible: no test had ever looked at them side by side. Consolidating them into
 * api/_auth-context.js makes one implementation serve four domains, which raises the stakes: a bug
 * here is a bug everywhere. So the gate gets its own tests, and the per-domain code prefixes are
 * asserted too, because they are contract - clients match on CAM_FORBIDDEN vs DEV_FORBIDDEN.
 *
 * The severity ladder is the interesting part, and it is asserted as a TABLE rather than described:
 * a view action is allowed while secure mode is off, every write action is refused. That difference
 * is deliberate (an operator must be able to watch a calibration session on an unsecured bench) and
 * it is the kind of thing a later "simplification" would flatten.
 */

'use strict';

const { expect } = require('chai');
const { createAuthHelpers, VIEW_ACTIONS, ADMIN_ACTIONS } = require('../../api/_auth-context');
const authJwt = require('../../api/jwt-helper');

/** A response double that records what the gate sent. */
function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

/** Build the helpers exactly the way a domain does - through functions, never captured values. */
function build(options) {
    const state = {
        runtime: options.runtime,
        checkGroups: options.checkGroups
    };
    const helpers = createAuthHelpers({
        getRuntime: () => state.runtime,
        getCheckGroups: () => state.checkGroups,
        codePrefix: options.codePrefix,
        domain: options.domain,
        extraViewActions: options.extraViewActions
    });
    return { helpers, state };
}

const ADMIN_GROUP = authJwt.adminGroups[0];

describe('shared API authorisation gate (api/_auth-context.js)', () => {
    describe('the runtime is read at call time', () => {
        it('init() assigning the runtime AFTER the helpers were built still works', function () {
            // This is the bug the devices API suite caught on the first attempt: the helpers are
            // built while the module loads, init() runs later, and a captured value would be
            // undefined for every request afterwards.
            const { helpers, state } = build({ runtime: undefined, checkGroups: () => null, codePrefix: 'T', domain: 'things' });
            expect(state.runtime).to.equal(undefined);
            state.runtime = { settings: { secureEnabled: true } };
            const auth = helpers.authContext({ userId: 'u1', userGroups: null });
            expect(auth.secureEnabled, 'the runtime assigned after construction was not seen').to.equal(true);
        });

        it('the permission callback is also resolved per call', function () {
            const { helpers, state } = build({ runtime: { settings: { secureEnabled: true } }, checkGroups: null, codePrefix: 'T', domain: 'things' });
            state.checkGroups = () => ADMIN_GROUP;
            expect(helpers.authContext({ userId: 'u1', userGroups: null }).isAdmin).to.equal(true);
        });
    });

    describe('authContext', () => {
        it('insecure mode answers as a trusted administrator with a userId', function () {
            const { helpers } = build({ runtime: { settings: { secureEnabled: false } }, checkGroups: () => null, codePrefix: 'T', domain: 'things' });
            const auth = helpers.authContext({ userId: 'whoever' });
            expect(auth).to.deep.equal({ secureEnabled: false, isGuest: false, isAdmin: true, userId: 'whoever' });
        });

        it('insecure mode still reports a userId when the request has none', function () {
            // The recipes copy never set userId at all. Nothing reads it today, which is exactly
            // why the omission survived - so it is asserted here.
            const { helpers } = build({ runtime: { settings: { secureEnabled: false } }, checkGroups: () => null, codePrefix: 'T', domain: 'things' });
            expect(helpers.authContext({}).userId).to.equal('guest');
        });

        it('a missing settings object is treated as insecure, not as a crash', function () {
            const { helpers } = build({ runtime: {}, checkGroups: () => null, codePrefix: 'T', domain: 'things' });
            expect(() => helpers.authContext({})).to.not.throw();
            expect(helpers.authContext({}).secureEnabled).to.equal(false);
        });

        it('secure mode reports guest / admin from the jwt helper', function () {
            const { helpers } = build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => ADMIN_GROUP, codePrefix: 'T', domain: 'things' });
            const admin = helpers.authContext({ userId: 'admin-1', userGroups: null });
            expect(admin.isAdmin).to.equal(true);
            expect(admin.isGuest).to.equal(false);

            const guest = build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => null, codePrefix: 'T', domain: 'things' }).helpers;
            const authGuest = guest.authContext({ userId: 'guest', userGroups: null });
            expect(authGuest.isGuest).to.equal(true);
            expect(authGuest.isAdmin).to.equal(false);
        });
    });

    describe('requireAction - the ladder', () => {
        const secureOff = () => build({ runtime: { settings: { secureEnabled: false } }, checkGroups: () => null, codePrefix: 'T', domain: 'things' });
        const secureOnGuest = () => build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => null, codePrefix: 'T', domain: 'things' });
        const secureOnViewer = () => build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => 'viewers', codePrefix: 'T', domain: 'things' });
        const secureOnAdmin = () => build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => ADMIN_GROUP, codePrefix: 'T', domain: 'things' });

        it('every view action passes while secure mode is OFF, and every write action does not', function () {
            // The table, not a description. This is the rule a later refactor would flatten.
            VIEW_ACTIONS.forEach((action) => {
                const res = makeRes();
                const auth = secureOff().helpers.requireAction({ userId: 'u' }, res, action);
                expect(auth, action + ' should be allowed while secure mode is off').to.not.equal(null);
                expect(res.statusCode, action + ' must not have been refused').to.equal(null);
            });
            ADMIN_ACTIONS.forEach((action) => {
                const res = makeRes();
                const auth = secureOff().helpers.requireAction({ userId: 'u' }, res, action);
                expect(auth, action + ' must be refused while secure mode is off').to.equal(null);
                expect(res.statusCode).to.equal(403);
                expect(res.body.error).to.equal('T_SECURITY_DISABLED');
            });
        });

        it('a guest passes view and is refused everything that writes', function () {
            VIEW_ACTIONS.forEach((action) => {
                const res = makeRes();
                expect(secureOnGuest().helpers.requireAction({ userId: 'guest' }, res, action), action).to.not.equal(null);
            });
            ADMIN_ACTIONS.forEach((action) => {
                const res = makeRes();
                expect(secureOnGuest().helpers.requireAction({ userId: 'guest' }, res, action), action).to.equal(null);
                expect(res.statusCode, action).to.equal(401);
                expect(res.body.error, action).to.equal('T_UNAUTHENTICATED');
            });
        });

        it('a signed-in non-admin passes view/operate and is refused the admin actions', function () {
            expect(secureOnViewer().helpers.requireAction({ userId: 'u1', userGroups: null }, makeRes(), 'view')).to.not.equal(null);
            expect(secureOnViewer().helpers.requireAction({ userId: 'u1', userGroups: null }, makeRes(), 'operate')).to.not.equal(null);
            ADMIN_ACTIONS.forEach((action) => {
                const res = makeRes();
                expect(secureOnViewer().helpers.requireAction({ userId: 'u1', userGroups: null }, res, action), action).to.equal(null);
                expect(res.statusCode, action).to.equal(403);
                expect(res.body.error, action).to.equal('T_FORBIDDEN');
            });
        });

        it('an admin passes everything', function () {
            VIEW_ACTIONS.forEach((action) => {
                expect(secureOnAdmin().helpers.requireAction({ userId: 'admin-1', userGroups: null }, makeRes(), action), action).to.not.equal(null);
            });
            ADMIN_ACTIONS.forEach((action) => {
                expect(secureOnAdmin().helpers.requireAction({ userId: 'admin-1', userGroups: null }, makeRes(), action), action).to.not.equal(null);
            });
        });

        it('an action nobody declared fails CLOSED', function () {
            // A new route added with a new action string must not become an unguarded write. The
            // first version of this gate would have fallen through and returned the auth context.
            const res = makeRes();
            const auth = secureOnAdmin().helpers.requireAction({ userId: 'admin-1', userGroups: null }, res, 'publish');
            expect(auth, 'an undeclared action was allowed through').to.equal(null);
            expect(res.statusCode).to.equal(403);
            expect(res.body.message).to.contain('publish');
        });

        it('the messages name the domain, and the codes carry the prefix', function () {
            const res = makeRes();
            build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => null, codePrefix: 'CAM', domain: 'cameras' })
                .helpers.requireAction({ userId: 'guest' }, res, 'admin');
            expect(res.body.error).to.equal('CAM_UNAUTHENTICATED');
            expect(res.body.message).to.contain('cameras');
        });
    });

    describe('the per-domain prefixes stay distinct', () => {
        it('four domains produce four different forbidden codes', function () {
            // Collapsing these into one shared code would be an API change: clients match on them.
            const domains = [
                { prefix: 'CAM', domain: 'cameras' },
                { prefix: 'DEV', domain: 'devices' },
                { prefix: 'CAL', domain: 'calibration' },
                { prefix: 'RECIPE', domain: 'recipes' }
            ];
            const codes = domains.map((d) => {
                const res = makeRes();
                build({ runtime: { settings: { secureEnabled: true } }, checkGroups: () => 'viewers', codePrefix: d.prefix, domain: d.domain })
                    .helpers.requireAction({ userId: 'u1', userGroups: null }, res, 'admin');
                return res.body.error;
            });
            expect(codes).to.deep.equal(['CAM_FORBIDDEN', 'DEV_FORBIDDEN', 'CAL_FORBIDDEN', 'RECIPE_FORBIDDEN']);
            expect(new Set(codes).size).to.equal(4);
        });
    });
});
