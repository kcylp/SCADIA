/**
 * A new API domain must not hand-roll its own authorisation context.
 *
 * Four domains carried the same thirty-line copy, and the copies had already drifted: one was
 * missing `userId`, one spelled the settings check differently, and each had its own idea of which
 * actions need an admin. None of that showed up in review, because reading four near-identical
 * blocks side by side is not something review does.
 *
 * Folding them into api/_auth-context.js fixes today's four. This guard is about the fifth: the
 * cost of the duplication was never the four copies, it was that copying is the path of least
 * resistance for the next domain.
 *
 * The rule is deliberately about the COMBINATION of three calls, not about a single word: a domain
 * may call authJwt for other reasons, and it may reach the shared helpers however it likes. What it
 * may not do is re-derive "is this request an admin" from scratch.
 *
 * Reverse verification could not use this file cheaply (it needs a new file to exist rather than an
 * existing line to change), so the rule is proven by the four migrations themselves: before them,
 * this test would have listed cameras, devices, calibration and recipes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const API_DIR = path.join(SERVER_ROOT, 'api');
const SHARED = path.join(API_DIR, '_auth-context.js');

/** Every API module except the shared one. */
function apiFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.js') && full !== SHARED) { out.push(full); }
        }
    };
    walk(API_DIR);
    return out.sort();
}

/** Code only: a comment that mentions the old pattern is documentation. */
function codeText(file) {
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
}

describe('API authorisation is derived in one place', () => {
    it('the shared module exists and exports the factory', function () {
        expect(fs.existsSync(SHARED), '_auth-context.js is gone - every domain would have to hand-roll again').to.equal(true);
        const shared = require(SHARED);
        expect(typeof shared.createAuthHelpers).to.equal('function');
    });

    it('a module that derives guest-and-admin together does it through the shared factory', function () {
        // Narrowed on purpose, and the narrowing is a finding rather than a convenience.
        //
        // The first version of this guard flagged any file calling both authJwt helpers, and it
        // named api/index.js and api/scheduler/index.js as well. Reading them showed the rule was
        // wrong, not the code: those call sites are authorisation-shaped BUSINESS decisions -
        // "an admin gets the full settings object, everyone else gets the sanitised one"
        // (api/index.js:136-139), "a non-admin may change a schedule but not its scheduler
        // settings" (api/scheduler/index.js:77-80). They are interleaved with storage reads and
        // response shaping, so moving them into a gate would move business logic into an entry
        // check. Their real debt is a different one - they answer with the platform-wide
        // 'unauthorized_error' code instead of a domain code - and it is recorded in
        // 20_代码进度.md rather than silently enforced here.
        //
        // What this guard DOES enforce is the thing that actually drifted: a module inventing its
        // own context reader or its own gate. That is the shape four domains had.
        const offenders = [];
        apiFiles().forEach((file) => {
            const text = codeText(file);
            if (!/createAuthHelpers/.test(text)) { return; }
            // A module using the factory must not ALSO keep its own copy of the derivation.
            if (/authJwt\.isGuestUser\s*\(/.test(text) || /authJwt\.haveAdminPermission\s*\(/.test(text)) {
                offenders.push(path.relative(SERVER_ROOT, file).split(path.sep).join('/') +
                    ' uses the shared factory and still derives guest/admin by hand');
            }
        });
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });

    it('the jwt helper itself is exempt, and api/index.js is not a gate', function () {
        // Stated so a later reader does not "finish the job" by migrating the wrong two files.
        const jwtHelper = path.join(API_DIR, 'jwt-helper.js');
        expect(codeText(jwtHelper)).to.contain('function isGuestUser');
        const apiIndex = codeText(path.join(API_DIR, 'index.js'));
        expect(apiIndex, 'api/index.js is the router and the settings endpoint, not an API domain')
            .to.contain('/api/settings');
    });

    it('every domain that gates an action goes through the shared gate', function () {
        // A domain is welcome to use only authContext (recipes does - it has its own per-type
        // authorisation). What it may not do is invent a third naming for the same thing.
        const offenders = [];
        apiFiles().forEach((file) => {
            const text = codeText(file);
            if (/function\s+requireAction\s*\(/.test(text) && !/createAuthHelpers/.test(text)) {
                offenders.push(path.relative(SERVER_ROOT, file).split(path.sep).join('/') + ' defines its own requireAction');
            }
            if (/function\s+_?getAuthContext\s*\(/.test(text) && !/createAuthHelpers/.test(text)) {
                offenders.push(path.relative(SERVER_ROOT, file).split(path.sep).join('/') + ' defines its own auth context reader');
            }
        });
        expect(offenders, offenders.join('\n')).to.deep.equal([]);
    });
    it('an authorisation refusal says WHICH rule refused, with a domain code (N-23)', function () {
        // The finding this closes, in the words it was recorded with: "scheduler and the heartbeat
        // answer with the platform-wide 'unauthorized_error' code instead of a domain code - not a
        // security hole (the decision itself is right), an outward inconsistency". The sibling
        // branch of the same heartbeat handler already answered 'identity_store_unavailable', so the
        // endpoint was inconsistent with ITSELF.
        //
        // The rule is scoped to the files this batch changed, on purpose. A whole-tree rule would
        // demand a domain code from the transport-level gates too (jwt-helper, verify-api-or-token,
        // the api-keys domain), where 'unauthorized_error' is about the CALLER rather than about a
        // domain - and rewriting those is a protocol change, not a cleanup.
        const scoped = [
            path.join(API_DIR, 'scheduler', 'index.js')
        ];
        const offenders = [];
        scoped.forEach((file) => {
            const text = codeText(file);
            if (/unauthorized_error/.test(text)) {
                offenders.push(path.relative(SERVER_ROOT, file).split(path.sep).join('/') +
                    " still answers the platform-wide 'unauthorized_error'");
            }
            // Either quote style: what matters is the string VALUE, not how the file spells it.
            if (!/SCH_FORBIDDEN/.test(text)) {
                offenders.push(path.relative(SERVER_ROOT, file).split(path.sep).join('/') +
                    ' lost its domain code');
            }
        });
        expect(offenders, offenders.join('\n')).to.deep.equal([]);

        // api/index.js still answers 'unauthorized_error' for /api/heartbeat's OTHER branch (a
        // tokenless caller), which is a transport-level refusal and deliberately untouched. What it
        // must not do is answer it for the branch that a domain code now covers.
        const apiIndex = codeText(path.join(API_DIR, 'index.js'));
        expect(apiIndex, 'the heartbeat user-record branch lost its domain code')
            .to.contain('heartbeat_user_not_found');
    });
});
