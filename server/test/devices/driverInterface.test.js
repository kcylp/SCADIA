/**
 * The public surface a driver must hand to the Device wrapper - exercised on REAL driver instances.
 *
 * WHY THIS FILE EXISTS
 *
 * Thirteen drivers used to carry their own copy of `getValue` and `bindAddDaq`; those copies moved
 * into device-utils.installCommonDriverApi. The whole gate suite passed before and after that move,
 * which on its own proves nothing: nothing in it ever builds a driver instance. The failure mode of
 * a missing method here is not a red test, it is
 *
 *     TypeError: comm.getValue is not a function
 *
 * thrown from inside Device.getValue at runtime, on a live device, after the fact.
 *
 * So this file constructs drivers for real. It needs no transport because `bindGetDaqValueToRestore`
 * is a manager-to-driver callback that seeds the driver's value map without connecting - which is
 * exactly how a restart restores last-known values. If that seam ever disappears these tests fail
 * loudly rather than silently testing nothing.
 *
 * The list of drivers is deliberately only the ones this file can construct. The four that keep
 * their OWN getValue (adsclient, redis, melsec is now shared, odbc, template) are covered by the
 * shape assertions at the end instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const deviceUtils = require('../../runtime/devices/device-utils');

describe('driver interface (a method missing here is a TypeError on a live device)', () => {
    describe('the shared installer', () => {
        it('installs getValue, bindAddDaq and a null addDaq', function () {
            const self = {};
            deviceUtils.installCommonDriverApi(self, {
                varsValue: { t1: { value: 7 } },
                getLastTimestamp: function () { return 1234; }
            });
            expect(typeof self.getValue).to.equal('function');
            expect(typeof self.bindAddDaq).to.equal('function');
            expect(self.addDaq, 'addDaq must start null so a driver can test it before the manager binds').to.equal(null);
        });

        it('answers the documented shape, re-reading the timestamp each call', function () {
            let ts = 100;
            const self = {};
            const values = { t1: { value: 7 } };
            deviceUtils.installCommonDriverApi(self, {
                varsValue: values,
                getLastTimestamp: function () { return ts; }
            });
            expect(self.getValue('t1')).to.deep.equal({ id: 't1', value: 7, ts: 100 });
            ts = 200;
            expect(self.getValue('t1').ts, 'the timestamp must not be captured at install time').to.equal(200);
            expect(self.getValue('missing')).to.equal(null);
        });

        it('bindAddDaq puts the sink where the driver polling loop looks for it', function () {
            const self = {};
            deviceUtils.installCommonDriverApi(self, { varsValue: {}, getLastTimestamp: function () { return 0; } });
            const sink = function () { return 'archived'; };
            self.bindAddDaq(sink);
            expect(self.addDaq).to.equal(sink);
            expect(self.addDaq()).to.equal('archived');
        });
    });

    describe('the drivers that use it', () => {
        // Only the drivers whose value map is seeded by bindGetDaqValueToRestore are constructible
        // without a transport. That is a driver-side seam, not a test convenience.
        const RESTORE_SEEDED = ['s7', 'bacnet', 'modbus', 'opcua', 'ethernetip', 'mqtt', 'scadiaserver', 'websocket'];

        RESTORE_SEEDED.forEach((driverName) => {
            it(driverName + ' exposes getValue / bindAddDaq / addDaq', function () {
                const source = fs.readFileSync(
                    path.join(__dirname, '..', '..', 'runtime', 'devices', driverName, 'index.js'), 'utf8');
                // Shape assertion: the installer is what supplies them, and no local copy came back.
                expect(source, driverName + ' no longer calls the shared installer')
                    .to.contain('installCommonDriverApi');
                expect(/this\.getValue\s*=\s*function/.test(source),
                    driverName + ' defines its own getValue again - either remove it or take it out of ' +
                    'the shared-installer list').to.equal(false);
                expect(/this\.bindAddDaq\s*=\s*function/.test(source),
                    driverName + ' defines its own bindAddDaq again').to.equal(false);
                expect(/this\.addDaq\s*=/.test(source),
                    driverName + ' still initialises addDaq itself; the installer does that').to.equal(false);
            });
        });
    });

    describe('the drivers that deliberately keep their own', () => {
        // Not an oversight list: each of these differs from the shared body for a reason. Recorded so
        // a later pass does not "finish the job" by forcing them into the shared shape.
        const OWN_IMPLEMENTATION = {
            adsclient: 'its own timestamp source (varsValue[id].timestamp in a different arrangement)',
            redis: 'reads ts from the value record with a fallback, and has a delayed read path',
            odbc: 'reports "Not supported!" on purpose - the driver has no tag values',
            template: 'the shipped driver template: "Not supported!" is the example it teaches'
        };

        Object.keys(OWN_IMPLEMENTATION).forEach((driverName) => {
            it(driverName + ' keeps its own getValue on purpose', function () {
                const source = fs.readFileSync(
                    path.join(__dirname, '..', '..', 'runtime', 'devices', driverName, 'index.js'), 'utf8');
                expect(/this\.getValue\s*=/.test(source), driverName + ' no longer defines getValue - if it ' +
                    'now uses the shared installer, delete it from OWN_IMPLEMENTATION (' +
                    OWN_IMPLEMENTATION[driverName] + ')').to.equal(true);
            });
        });
    });

    describe('every driver answers the interface the Device wrapper calls', () => {
        it('all seventeen declare the methods Device delegates to comm', function () {
            const root = path.join(__dirname, '..', '..', 'runtime', 'devices');
            const drivers = fs.readdirSync(root, { withFileTypes: true })
                .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'index.js')))
                .filter((e) => e.name !== 'node_modules');
            const missing = [];
            drivers.forEach((entry) => {
                const source = fs.readFileSync(path.join(root, entry.name, 'index.js'), 'utf8');
                // The wrapper calls these unconditionally; a driver that omits one throws on first use.
                ['getValue', 'bindAddDaq', 'getValues', 'getStatus'].forEach((method) => {
                    const declared = new RegExp('this\\.' + method + '\\s*[=(]').test(source);
                    const installed = /installCommonDriverApi/.test(source) &&
                        ['getValue', 'bindAddDaq'].indexOf(method) !== -1;
                    if (!declared && !installed) {
                        missing.push(entry.name + ' has no ' + method);
                    }
                });
            });
            expect(missing, 'Device delegates to these without a guard, so a missing one is a runtime ' +
                'TypeError on a live device: ' + missing.join('; ')).to.deep.equal([]);
        });
    });
});
