/**
 * The three-strike overload branch, and the one way a bare call can be wrong twice.
 *
 * Every driver that allows overlapping polls carries the same little policy: count the
 * strikes, and on the third one break the connection so the driver is not wedged forever.
 * The scadiaserver driver's branch went through a repair that made it worse:
 *
 *   1. a bare call to disconnect() - no such binding anywhere, and this file is 'use strict',
 *      so the branch threw a ReferenceError at the exact moment it was needed;
 *   2. the repair changed it to this.disconnect() - also wrong. _checkWorking is a local
 *      called bare, and under 'use strict' `this` is undefined inside it, so the branch threw
 *      a TypeError instead. This file has no try/catch there, so it came straight out of
 *      polling(). It still never broke the connection.
 *
 * The ODBC driver had the same defect and hid it better: its call sits inside a try/catch
 * whose only reaction is one console.error line, so a connection that could never be dropped
 * looked like nothing at all. It is fixed the same way - capture the instance once, at the
 * top of the factory, and call through it.
 *
 * The general rule this file pins is the one that would have caught both: a LOCAL helper in
 * a driver must not reach for `this`. 117 of them are scanned below; the count is asserted
 * so a guard whose path is wrong cannot report a clean tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const DEVICES_DIR = path.join(SERVER_ROOT, 'runtime', 'devices');
const driver = require('../../runtime/devices/scadiaserver');

const quietLogger = () => ({
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub()
});

/** A driver data document with one numeric tag, enough for load() to arm polling. */
function deviceData() {
    const tag = { id: 't1', name: 't1', type: 'number', address: 't1' };
    return { id: 'scadia', name: 'scadia', enabled: true, tags: { t1: tag } };
}

describe('a driver breaks a wedged connection on the third strike', () => {
    afterEach(() => sinon.restore());

    it('three overlapping polls call disconnect instead of throwing out of polling()', async function () {
        const runtime = { settings: {}, logger: quietLogger(), devices: {} };
        const client = driver.create(deviceData(), quietLogger(),
            { on: sinon.stub(), emit: sinon.stub() }, {}, runtime);
        const disconnect = sinon.spy(client, 'disconnect');
        client.load(deviceData());

        // Started together on purpose: none of them reaches _checkWorking(false) before the
        // next one starts, which is what three-deep means. The FIRST call is the one that sets
        // the working flag and is not counted as a strike, so it takes four overlapping calls
        // to reach the third strike - that is the policy, not a test artefact.
        const settled = await Promise.allSettled([client.polling(), client.polling(), client.polling(), client.polling()]);
        const rejected = settled.filter((r) => r.status === 'rejected')
            .map((r) => String(r.reason && r.reason.message));

        expect(rejected, 'the overload branch threw instead of dropping the connection: ' + rejected.join(' | '))
            .to.deep.equal([]);
        expect(disconnect.callCount, 'three overlapping polls must break the connection exactly once')
            .to.equal(1);
    });

    it('no local helper in any driver reaches for this (the shape both defects had)', function () {
        const offenders = [];
        let helpers = 0;
        const drivers = fs.readdirSync(DEVICES_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .filter((entry) => fs.existsSync(path.join(DEVICES_DIR, entry.name, 'index.js')));

        drivers.forEach((entry) => {
            const file = path.join(DEVICES_DIR, entry.name, 'index.js');
            const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            for (let i = 0; i < src.length; i++) {
                const m = /^\s*(?:var|let|const)\s+(_\w+)\s*=\s*(?:async\s+)?function/.exec(src[i]) ||
                    /^\s*function\s+(_\w+)\s*\(/.exec(src[i]);
                if (!m) { continue; }
                let depth = 0;
                let started = false;
                let end = i;
                for (let j = i; j < Math.min(src.length, i + 120); j++) {
                    for (const ch of src[j]) {
                        if (ch === '{') { depth++; started = true; } else if (ch === '}') { depth--; }
                    }
                    if (started && depth <= 0) { end = j; break; }
                }
                helpers++;
                src.slice(i, end + 1).forEach((line, k) => {
                    if (/^\s*(\/\/|\*)/.test(line)) { return; }          // a comment is documentation
                    if (/\bthis\./.test(line)) {
                        offenders.push('runtime/devices/' + entry.name + '/index.js:' + (i + k + 1) +
                            ' (' + m[1] + ') reaches for this: ' + line.trim());
                    }
                });
                i = end;
            }
        });

        expect(helpers, 'the driver walk found almost no local helpers - check DEVICES_DIR').to.be.greaterThan(80);
        expect(offenders, 'a local helper is called bare, so this is undefined under strict mode:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('the ODBC overload branch reaches a real disconnect, not a swallowed TypeError', function () {
        const source = fs.readFileSync(path.join(DEVICES_DIR, 'odbc', 'index.js'), 'utf8');
        const at = source.indexOf('var _checkWorking');
        const body = source.slice(at, at + 900);
        const code = body.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
        expect(code, 'the ODBC recover branch no longer calls disconnect').to.match(/self\.disconnect\(\)/);
        expect(code, 'the ODBC recover branch went back to reaching for this').to.not.match(/[^.\w]this\.disconnect/);
    });
});
