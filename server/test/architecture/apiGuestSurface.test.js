/**
 * The API's GUEST SURFACE, measured instead of assumed (batch 53, decision on N-41).
 *
 * WHY THIS EXISTS. N-41 was filed as a single endpoint answering 200 to a caller that presented
 * nothing (GET /api/opcua-server/status). Measuring the whole API layer showed it was not one
 * endpoint - it is the SHAPE of the layer: `jwt-helper.verifyToken` does not refuse a tokenless
 * caller, it mints a guest identity and calls next(), and 13 of the 16 API domains never ask
 * whether the caller is a guest. Naming one endpoint was the finding; the layer was the fact.
 *
 * WHAT WAS NOT DONE, AND WHY THAT IS THE DECISION RATHER THAN AN OVERSIGHT. The 13 were NOT all
 * closed in one go. Most of them read through `runtime.checkPermission(userPermission, ...)`, which
 * answers `{show: true, enabled: true}` when `userPermission === undefined` - that is this
 * product's GUEST DISPLAY path (the client computes the same thing for itself in
 * _services/auth.service.ts:checkPermission). Closing it layer-wide would change what a
 * public/kiosk display is allowed to show, which is a product decision, not a cleanup. The one
 * endpoint that was closed is the one that publishes operational metadata with no per-item filter.
 *
 * THE DELEGATING PARTY FROZE THIS SURFACE (batch 54). The 13 below are EXISTING CONNECTION POINTS
 * without a contract of their own, and the instruction was explicit: freeze them as they are, add
 * and change nothing. The storage plane is the model to follow - it is governed by
 * `22_契约06_存储平面五域契约.md`, and that document is what a new module has to satisfy before it
 * is admitted. **A NEW API DOMAIN IS NOT ADMITTED BY THIS GUARD AT ALL**: it needs a contract first
 * and an approval after, so the pin below is a freeze, not a budget to spend.
 *
 * WHAT THIS GUARD DOES, therefore, is the two things that are mechanically true:
 *   1. the set of domains that DO check the guest is pinned - a domain may not quietly leave it;
 *   2. the set that does NOT is pinned EXACTLY - a new domain may not quietly join it.
 * Every entry carries the reason it is open, so the next reader does not have to re-measure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const API_DIR = path.join(SERVER_ROOT, 'api');

/** Domains that refuse a guest, WITH the rule they use. Losing one of these is a regression. */
const CLOSED = {
    'recipes': 'securityRoles/secureEnabled + isGuestId -> 401, per type (has its own authorisation)',
    'scheduler': 'secureEnabled && isGuest -> 401 SCH_FORBIDDEN (batch 51)',
    'opcua-server': 'secureEnabled && isGuest -> 401 OPCUA_UNAUTHENTICATED (batch 53, N-41)'
};

/**
 * Domains that read the guest in their own code but are NOT on the list above.
 * Recorded, not fixed: each one is a per-item permission filter, which is the guest-display path.
 */
const OPEN = [
    'alarms', 'apikeys', 'calibration', 'cameras', 'command', 'daq', 'devices', 'diagnose',
    'plugins', 'projects', 'reporting', 'resources', 'scripts', 'users'
];

function domainFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name === 'index.js') { out.push(full); }
        }
    };
    walk(API_DIR);
    return out.sort();
}

describe('the API guest surface is measured, not assumed', () => {
    const files = domainFiles();

    it('the API layer was actually walked', function () {
        // A guard that scans nothing passes everything. This line is the one that caught a
        // two-levels-short path in the R1/R2/R3 guard the day before (batch 52), and it is written
        // first here for the same reason.
        expect(files.length, 'no API domain index.js files were found under ' + API_DIR)
            .to.be.greaterThan(10);
    });

    it('every domain that refuses a guest still does, and still uses a shared middleware', function () {
        const missing = [];
        Object.keys(CLOSED).forEach((name) => {
            const file = files.find((f) => f.split(path.sep).slice(-2, -1)[0] === name);
            if (!file) { missing.push(name + ' (domain not found)'); return; }
            const text = fs.readFileSync(file, 'utf8');
            if (!/secureFnc/.test(text)) { missing.push(name + ' (no longer gated by the shared middleware)'); }
            if (!/isGuest/.test(text)) { missing.push(name + ' (' + CLOSED[name] + ' - the check is gone)'); }
        });
        expect(missing, 'a domain that refused guests before must keep refusing them:\n' + missing.join('\n'))
            .to.deep.equal([]);
    });

    it('no NEW domain quietly joins the guest-open set', function () {
        const found = files
            .map((f) => f.split(path.sep).slice(-2, -1)[0])
            .filter((name) => name !== 'api' && name !== '_auth-context');
        const open = found.filter((name) => {
            const text = fs.readFileSync(files.find((f) => f.split(path.sep).slice(-2, -1)[0] === name), 'utf8');
            return /secureFnc/.test(text) && !/isGuest/.test(text);
        }).sort();
        expect(open, 'these domains use the shared middleware but never ask whether the caller is a ' +
            'guest. The surface is FROZEN by decision (batch 54): a new API domain is admitted only ' +
            'with a contract of its own (the model is 22_契约06_存储平面五域契约.md) and an approval, ' +
            'NOT by adding a line to OPEN in this file. If a domain genuinely must join, that ' +
            'conversation comes first:\n' + open.join(', ')).to.deep.equal(OPEN.slice().sort());
    });
});
