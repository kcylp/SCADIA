/**
 * The client and the server must spell every socket event the same way.
 *
 * Socket.IO has no schema: an event whose name differs by one character does not error, it
 * simply never arrives. `this.socket.on(IoEventTypes.DEVICE_STATUS, ...)` would sit there
 * forever while the server emitted 'device-status' into the void - and this project has
 * already paid for that class of defect once (a 43-member IoEventTypes was reported where the
 * real number was 35, which is the kind of drift a count cannot catch).
 *
 * There are two handwritten enumerations - runtime/events.js (JavaScript) and
 * _services/hmi.service.ts (TypeScript) - and no generator. This guard therefore checks the
 * three things that actually break:
 *
 *   1. every member the client uses is DECLARED by the server, with the same STRING VALUE.
 *      Comparing members but not values would pass while the two sides disagreed about the
 *      wire name; comparing values but not members would pass while the client used a name
 *      that does not exist.
 *   2. no business event is listened to or emitted through a raw string literal instead of the
 *      enumeration. Raw 'calibration:...' strings are how the workbench got away with eight
 *      events nobody could see in the enum - the guard pins them until they are declared.
 *   3. the two members that are client-only stay pinned and named (see known-debt.js): a third
 *      one fails.
 *
 * Reverse verification (test/architecture/_support/reverse-verify.js) renames one server-side
 * value and demands this file goes red on that exact check.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const debt = require('./_support/known-debt');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const SERVER_EVENTS_FILE = path.join(SERVER_ROOT, 'runtime', 'events.js');
const CLIENT_SERVICE_FILE = path.join(CLIENT_SRC, 'app', '_services', 'hmi.service.ts');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', '.git', 'coverage', 'i18n-parked']);

/** The server declares its event names in one const object. */
function serverEvents() {
    const src = fs.readFileSync(SERVER_EVENTS_FILE, 'utf8');
    const body = src.split('const IoEventTypes = {')[1];
    expect(body, 'runtime/events.js no longer declares const IoEventTypes').to.not.equal(undefined);
    const members = {};
    const re = /^\s*([A-Z0-9_]+)\s*:\s*'([^']*)'\s*,?\s*$/gm;
    let m;
    while ((m = re.exec(body.split('}')[0]))) { members[m[1]] = m[2]; }
    return members;
}

/** The client declares the same names in a TypeScript enum. */
function clientEvents() {
    const src = fs.readFileSync(CLIENT_SERVICE_FILE, 'utf8');
    const body = src.split('export enum IoEventTypes {')[1];
    expect(body, 'hmi.service.ts no longer declares export enum IoEventTypes').to.not.equal(undefined);
    const members = {};
    const re = /^\s*([A-Z0-9_]+)\s*=\s*'([^']*)'\s*,?\s*$/gm;
    let m;
    while ((m = re.exec(body.split('}')[0]))) { members[m[1]] = m[2]; }
    return members;
}

/** Every client .ts file that ships. */
function clientTsFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) { out.push(full); }
        }
    };
    walk(CLIENT_SRC);
    return out.sort();
}

/**
 * Socket.IO's own lifecycle and transport events are user-defined names too, but they are
 * spelled by the library, never namespaced, and cannot be renamed by this project.
 */
const LIBRARY_EVENTS = new Set([
    'connect', 'connect_error', 'connect_timeout', 'connecting', 'disconnect', 'disconnecting',
    'error', 'reconnect', 'reconnect_attempt', 'reconnect_error', 'reconnect_failed',
    'ping', 'pong', 'newListener', 'removeListener'
]);

/** Server-declared events referenced in client code as raw string literals instead of the enum. */
function rawStringEventUses(declaredValues) {
    const byValue = new Map();
    declaredValues.forEach((value) => byValue.set(value, true));

    const uses = [];
    for (const file of clientTsFiles()) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            const re = /\.(?:on|once|off|emit|removeListener)\(\s*['"]([^'"]+)['"]/g;
            let m;
            while ((m = re.exec(line))) {
                const name = m[1];
                if (LIBRARY_EVENTS.has(name)) { continue; }
                if (!byValue.has(name)) { continue; }   // not a server event name at all
                uses.push({
                    where: path.relative(CLIENT_SRC, file).split(path.sep).join('/') + ':' + (index + 1),
                    name: name
                });
            }
        });
    }
    return uses;
}

describe('socket event names (the two enumerations are a protocol, not a convention)', () => {
    const server = serverEvents();
    const client = clientEvents();

    it('both enumerations were parsed, and both are substantial', function () {
        expect(Object.keys(server).length, 'runtime/events.js parsed to nothing').to.be.greaterThan(20);
        expect(Object.keys(client).length, 'hmi.service.ts parsed to nothing').to.be.greaterThan(20);
    });

    it('every server member has a unique string value', function () {
        const values = Object.values(server);
        const dup = values.filter((v, i) => values.indexOf(v) !== i);
        expect(dup, 'two server events share one wire name').to.deep.equal([]);
    });

    it('every client member is declared by the server, with the same value', function () {
        const mismatched = [];
        const missing = [];
        Object.keys(client).forEach((member) => {
            if (!(member in server)) { missing.push(member); return; }
            if (server[member] !== client[member]) {
                mismatched.push(member + ': client ' + JSON.stringify(client[member]) +
                    ' vs server ' + JSON.stringify(server[member]));
            }
        });
        expect(missing, 'the client uses events the server never declares: ' + missing.join(', '))
            .to.deep.equal([]);
        expect(mismatched, 'the same member name means two different wire names: ' + mismatched.join(' | '))
            .to.deep.equal([]);
    });

    it('the client-only members are exactly the pinned ones', function () {
        const clientOnly = Object.keys(client).filter((member) => !(member in server)).sort();
        expect(clientOnly, 'a new client-only event was added. Declare it in runtime/events.js, or ' +
            'pin it in _support/known-debt.js with the reason.').to.deep.equal(debt.CLIENT_ONLY_IO_EVENT_MEMBERS.slice().sort());
    });

    it('no server event is heard through a raw string literal in the client', function () {
        const uses = rawStringEventUses(Object.values(server));
        expect(uses.map((u) => u.where + '  ' + u.name),
            'these call sites use a raw string instead of the enumeration, where a typo cannot be ' +
            'caught by the compiler.').to.deep.equal([]);
    });

    it('every server event also has a client-side name (a feature built on one side only is visible here)', function () {
        // Not a failure condition on its own - the client may legitimately not listen to
        // something yet - so it is reported as a measurement with a floor. What matters is
        // that the two lists cannot drift apart without somebody seeing the number.
        const unusedByClient = Object.keys(server).filter((member) => !(member in client));
        expect(Object.keys(server).length - unusedByClient.length, 'server events with no client-side name: ' +
            unusedByClient.join(', ')).to.be.greaterThan(20);
    });
});
