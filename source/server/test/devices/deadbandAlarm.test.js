'use strict';

/**
 * Deadband must never suppress an alarm — regression test (2026-09-29).
 *
 * Reported risk (Codex review item 1-2 / ledger L-10):
 *   last value 99, tag deadband 10, alarm threshold 100, new reading 101.
 *   101 does not satisfy the archive/noise gate (|101-99| <= 10), which is a
 *   legitimate *publication* decision — but it must still be judged by the alarm.
 *
 * Before the fix, `tagValueCompose` replaced the reading with the previous value
 * and that replaced value is what the alarm engine read, so the alarm never fired.
 * The fix keeps `rawComposed` (deadband NOT applied) and the alarm engine reads it
 * through `getDeviceAlarmValue`.
 *
 * The integration case below drives the REAL AlarmsManager and the REAL
 * alarmstorage in a temp dir, so it would have failed before the fix.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const deviceUtils = require('../../runtime/devices/device-utils');
const alarmstorage = require('../../runtime/alarms/alarmstorage');
const alarms = require('../../runtime/alarms');

const DEADBAND = 10;
const LAST = 99;
const READING = 101;   // crosses the 100 threshold, but only by 2 < deadband
const THRESHOLD = 100;

const makeLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} });
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('deadband vs alarm evaluation (regression)', () => {

    describe('tagValueCompose keeps the deadband-free value', () => {
        it('returns the held (deadband) value but exposes rawComposed = the real reading', async () => {
            const tag = { id: 'tag-temp', type: 'number', deadband: { value: DEADBAND } };

            const composed = await deviceUtils.tagValueCompose(READING, LAST, tag);

            // Publication/storage view: held at the previous value (unchanged behaviour).
            expect(composed).to.equal(LAST);
            // Alarm view: the value the sensor actually reported.
            expect(tag.rawComposed).to.equal(READING);
        });

        it('reports both views identically when the reading moves past the deadband', async () => {
            const tag = { id: 'tag-temp', type: 'number', deadband: { value: DEADBAND } };

            const composed = await deviceUtils.tagValueCompose(LAST + DEADBAND + 1, LAST, tag);

            expect(composed).to.equal(LAST + DEADBAND + 1);
            expect(tag.rawComposed).to.equal(LAST + DEADBAND + 1);
        });

        it('does not invent rawComposed for tags without a deadband', async () => {
            const tag = { id: 'tag-plain', type: 'number' };

            const composed = await deviceUtils.tagValueCompose(READING, LAST, tag);

            expect(composed).to.equal(READING);
            expect(tag.rawComposed).to.equal(READING);
        });

        it('keeps rawComposed aligned through scale', async () => {
            const tag = {
                id: 'tag-scaled', type: 'number',
                deadband: { value: 10 },
                scale: { mode: 'linear', rawLow: 0, rawHigh: 100, scaledLow: 0, scaledHigh: 1000 }
            };

            const composed = await deviceUtils.tagValueCompose(10.1, 9.9, tag);

            // Order of operations in tagValueCompose is: deadband -> scale -> format.
            // |10.1 - 9.9| = 0.2 <= deadband 10, so the *held* value 9.9 is scaled:
            // 9.9 / 100 * 1000 = 99 -> rounded to 99.
            expect(composed).to.equal(99);
            // rawComposed is the value BEFORE the hold: the raw reading 10.1.
            expect(tag.rawComposed).to.equal(10.1);
        });
    });

    describe('AlarmsManager judges on the deadband-free value', () => {
        let workDir;
        let manager;
        let storageOpen;

        afterEach(() => {
            if (manager) { manager.stop(); }
            if (storageOpen) { alarmstorage.close(); }
            if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {} }
            workDir = null; manager = null; storageOpen = false;
        });

        // A "highhigh" alarm is in range when value >= min && value <= max, so the band
        // has to sit ABOVE the passing reading for the negative case to mean anything.
        function makeRuntime(deviceTag, band = { min: THRESHOLD - 10, max: 1000 }) {
            return {
                settings: {},
                logger: makeLogger(),
                events: { on: () => {}, emit: () => {}, removeListener: () => {} },
                project: {
                    getAlarms: () => Promise.resolve([{
                        name: 'temp-high',
                        property: { variableId: 'device-a^~^tag-temp' },
                        highhigh: {
                            enabled: true, checkdelay: 1, timedelay: 0,
                            min: band.min, max: band.max,
                            ackmode: 'ackactive', text: 'temp high', group: 'default',
                            bkcolor: '#ffffff', color: '#000000'
                        },
                        high: { enabled: false }, low: { enabled: false }, info: { enabled: false }
                    }])
                },
                // This is the real production surface the alarm engine calls.
                // _loadProperty() derives the variableSource deviceId through
                // getDeviceIdFromTag(); without it the alarm is registered but never
                // evaluated (the harness, not the product, would be at fault).
                devices: {
                    getDeviceIdFromTag: () => 'device-a',
                    getDeviceValue: () => Object.assign({}, deviceTag),
                    getDeviceAlarmValue: () => Object.assign({}, deviceTag, { value: deviceTag.rawComposed })
                },
                checkPermission: () => ({ show: true, enabled: true })
            };
        }

        /** Poll a predicate until it holds or the deadline passes (condition-based, not sleep-based). */
        async function waitUntil(predicate, timeoutMs, label) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                if (await predicate()) { return true; }
                if (Date.now() > deadline) { return false; }
                await delay(100);
            }
        }

        /**
         * Drive the REAL AlarmsManager and report whether an alarm was raised.
         *
         * The manager runs a 1s status machine (INIT -> LOAD -> IDLE) and only then evaluates
         * alarms, and a rule additionally needs two passes (checkdelay) to activate. A fixed
         * sleep therefore made this test flaky under load — the same class of defect the
         * session opened with. It waits for the CONDITION instead.
         *
         * @param {boolean} expectAlarm when true, wait for an alarm to appear; otherwise give
         *                              the manager a generous window to prove it does NOT.
         */
        async function runCheck(deviceTag, band, expectAlarm) {
            workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-deadband-'));
            const runtime = makeRuntime(deviceTag, band);
            runtime.settings.workDir = workDir;
            manager = alarms.create(runtime);
            await alarmstorage.init(runtime.settings, runtime.logger);
            storageOpen = true;
            manager.start();

            const historySince = async () =>
                manager.getAlarmsHistory({ start: 0, end: Number.MAX_SAFE_INTEGER });

            if (expectAlarm) {
                const raised = await waitUntil(async () => (await historySince()).length > 0, 20000, 'alarm raised');
                if (!raised) {
                    console.warn('   [deadbandAlarm] no alarm within the deadline — the manager state machine may still be settling');
                }
            } else {
                // Give it ample time to reach IDLE and evaluate; then assert it produced nothing.
                await waitUntil(async () => false, 6000, 'settle');
            }

            manager.stop();
            return historySince();
        }

        it('raises the alarm for 99 -> 101 with deadband 10 and threshold 100', async () => {
            const history = await runCheck(
                { id: 'tag-temp', value: LAST, rawComposed: READING, timestamp: Date.now(), quality: 'good' },
                undefined, true
            );

            expect(history).to.have.length.greaterThan(0);
            expect(history[0].name).to.equal('temp-high');
            // The alarm must report the value that actually tripped it.
            expect(Number(history[0].value)).to.equal(READING);
        });

        it('does not raise the alarm while the reading stays below the alarm band', async () => {
            // Band starts at 200, reading is 95 -> out of range, no alarm.
            const history = await runCheck(
                { id: 'tag-temp', value: 95, rawComposed: 95, timestamp: Date.now(), quality: 'good' },
                { min: 200, max: 1000 }, false
            );

            expect(history).to.have.lengthOf(0);
        });

        it('does not raise the alarm when the deadband holds a reading that never moved', async () => {
            // Reading equals the previous value: deadband holds it, and being in the
            // alarm band must NOT create an alarm out of an unchanged value.
            const history = await runCheck(
                { id: 'tag-temp', value: 50, rawComposed: 50, timestamp: Date.now(), quality: 'good' },
                { min: 200, max: 1000 }, false
            );

            expect(history).to.have.lengthOf(0);
        });
    });
});
