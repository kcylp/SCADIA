/**
 * A driver may not publish tag values or connection status by itself.
 *
 * WHY THIS IS A GUARD AND NOT A STYLE RULE
 *
 * Fifteen drivers each carried their own copy of `_emitValues`, and thirteen of them also carried
 * a copy of the superseded-binding guard (contract 09 section 4.3):
 *
 *     if (!deviceUtils.shouldEmitForBinding(data, runtime, bindingCache)) { ... return; }
 *
 * Three did not: modbus, gpio and webcam published unconditionally, so a read that came back after
 * the device was rebound was stored against the NEW binding - the exact defect the guard exists to
 * prevent, in the three places where nobody had re-pasted it.
 *
 * The lesson is the shape of the defect, not the three files: a rule that has to be copied into
 * every new driver will be missing from the next one. So the guard moved into the emitter, and this
 * test keeps it there - a driver that reaches for the event bus directly fails, and the failure
 * message says what to call instead.
 *
 * The two exemptions are real and named:
 *   - runtime/index.js owns the event bus itself (it is the subscriber, not a producer);
 *   - the device-utils emitter is the one place allowed to emit.
 * A test double inside a driver is not exempt: a double that emits is a driver that emits.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const DEVICES_DIR = path.join(SERVER_ROOT, 'runtime', 'devices');
const ALLOWED_EMITTER = path.join(DEVICES_DIR, 'device-utils.js');

/** Every .js under runtime/devices, except the shared helper that is allowed to emit. */
function driverFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.js') && full !== ALLOWED_EMITTER) { out.push(full); }
        }
    };
    walk(DEVICES_DIR);
    return out.sort();
}

/** Comment lines are not code: several drivers keep the old emit as a documented example. */
function codeLines(file) {
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ text: line, number: index + 1 }))
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text));
}

const rel = (file) => path.relative(SERVER_ROOT, file).split(path.sep).join('/');

describe('driver emit discipline (a guard that must be re-pasted is a guard that will be missing)', () => {
    const files = driverFiles();

    it('the driver tree was found and is not empty', function () {
        expect(files.length, 'no driver files under ' + DEVICES_DIR).to.be.greaterThan(10);
    });

    it("no driver emits 'device-value:changed' directly", function () {
        const offenders = [];
        files.forEach((file) => {
            codeLines(file).forEach((line) => {
                if (line.text.indexOf("'device-value:changed'") !== -1) {
                    offenders.push(rel(file) + ':' + line.number + '  ' + line.text.trim());
                }
            });
        });
        expect(offenders, 'publish through deviceUtils.emitValues(data, runtime, bindingCache, values) ' +
            'instead - it applies the superseded-binding guard (contract 09 section 4.3) that three ' +
            'drivers had lost:\n' + offenders.join('\n')).to.deep.equal([]);
    });

    it("no driver emits 'device-status:changed' directly", function () {
        const offenders = [];
        files.forEach((file) => {
            codeLines(file).forEach((line) => {
                if (line.text.indexOf("'device-status:changed'") !== -1) {
                    offenders.push(rel(file) + ':' + line.number + '  ' + line.text.trim());
                }
            });
        });
        expect(offenders, 'publish through deviceUtils.emitStatus(data, status) instead: ' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('every driver that publishes values routes through the shared emitter', function () {
        const withEmitter = [];
        const without = [];
        files.forEach((file) => {
            const source = fs.readFileSync(file, 'utf8');
            if (!/_emitValues\s*[=(]/.test(source)) { return; }
            withEmitter.push(rel(file));
            if (!/deviceUtils\.emitValues\(/.test(source)) { without.push(rel(file)); }
        });
        expect(withEmitter.length, 'no driver has an _emitValues at all - the scan is looking at the ' +
            'wrong tree').to.be.greaterThan(5);
        expect(without, 'these drivers still publish values their own way: ' + without.join(', '))
            .to.deep.equal([]);
    });

    it('every driver that reports status routes through the shared emitter', function () {
        const without = [];
        let count = 0;
        files.forEach((file) => {
            const source = fs.readFileSync(file, 'utf8');
            if (!/_emitStatus\s*[=(]/.test(source)) { return; }
            count++;
            if (!/deviceUtils\.emitStatus\(/.test(source)) { without.push(rel(file)); }
        });
        expect(count, 'no driver reports status - the scan is looking at the wrong tree').to.be.greaterThan(5);
        expect(without, 'these drivers still report status their own way: ' + without.join(', '))
            .to.deep.equal([]);
    });

    it('every driver that uses the shared emitter also holds a binding cache to hand it', function () {
        // The shared guard reads cache.revision. A driver that calls emitValues with an undefined
        // cache would still emit, but the snapshot would never be taken or re-armed - a silent
        // downgrade to "no guard at all", which is the defect this batch closed.
        const missing = [];
        files.forEach((file) => {
            const source = fs.readFileSync(file, 'utf8');
            if (!/deviceUtils\.emitValues\(/.test(source)) { return; }
            if (!/var\s+bindingCache\s*=\s*\{\s*revision:\s*null\s*\}/.test(source)) {
                missing.push(rel(file) + ' has no bindingCache declaration');
            }
            if (!/resetBindingCache\(bindingCache\)/.test(source)) {
                missing.push(rel(file) + ' never re-arms it in load()');
            }
        });
        expect(missing, 'without a cache that is declared and re-armed the guard silently does ' +
            'nothing: ' + missing.join('; ')).to.deep.equal([]);
    });
});
/**
 * The device event bus is the RUNTIME's emitter, not the events module (batch 74).
 *
 * WHAT WAS WRONG. device-utils published with `require('../events').emit(...)`, and runtime/events.js
 * exports { create, IoEventTypes } - a factory, with no emit(). Every publish therefore threw
 * "TypeError: require(...).emit is not a function"; the drivers' poll loops catch and log, so with any
 * ENABLED device the values were read from the device and then thrown away, and the operator's screen
 * simply stopped moving. Nothing caught it: the project this build is demoed against has no enabled
 * device (so the line is never reached), and the tests above exercise the binding guard, not the emit.
 *
 * The bus is the emitter the runtime subscribes on and hands out as runtime.events
 * (runtime/index.js: `var events = Events.create()`, `events.on('device-value:changed', updateDeviceValues)`).
 * emitValues already received the runtime; emitStatus now takes it as its fourth parameter, and every
 * driver passes it.
 */
describe('the shared emitter publishes on the runtime event bus', () => {
    const deviceUtils = require('../../runtime/devices/device-utils');
    // A local list: `files` above belongs to the first describe block's scope.
    const driverList = driverFiles();

    /** A runtime whose bus records what is published on it. */
    function recordingRuntime() {
        const emitted = [];
        return {
            emitted: emitted,
            events: { emit: function (name, payload) { emitted.push({ name: name, payload: payload }); } }
        };
    }

    it('emitValues publishes device-value:changed on runtime.events', function () {
        const runtime = recordingRuntime();
        const data = { id: 'dev-1', bindingRevision: 1 };
        const published = deviceUtils.emitValues(data, runtime, { revision: null }, { t1: 42 },
            { logger: { warn: function () {} } });
        expect(published).to.equal(true);
        expect(runtime.emitted.map((e) => e.name)).to.deep.equal(['device-value:changed']);
        expect(runtime.emitted[0].payload.id).to.equal('dev-1');
        expect(runtime.emitted[0].payload.values).to.deep.equal({ t1: 42 });
    });

    it('emitStatus publishes device-status:changed on runtime.events', function () {
        const runtime = recordingRuntime();
        let seen = null;
        const status = deviceUtils.emitStatus({ id: 'dev-2' }, 'connect-ok',
            { onEmit: function (s) { seen = s; } }, runtime);
        expect(status).to.equal('connect-ok');
        expect(seen, 'the driver callback still runs before the event').to.equal('connect-ok');
        expect(runtime.emitted.map((e) => e.name)).to.deep.equal(['device-status:changed']);
        expect(runtime.emitted[0].payload).to.deep.equal({ id: 'dev-2', status: 'connect-ok' });
    });

    it('a missing bus is raised where the wiring is wrong, not swallowed', function () {
        // The old code did not fail loudly - it threw a TypeError from a line nobody could reach
        // with an empty project, and the only trace was a caught-and-logged line.
        expect(() => deviceUtils.emitStatus({ id: 'dev-3' }, 'connect-ok', {}, {})).to.throw(/no runtime event bus/);
        expect(() => deviceUtils.emitStatus({ id: 'dev-3' }, 'connect-ok', {}, undefined)).to.throw(/runtime/);
    });

    it('runtime/events.js is a factory with no emit - which is why the module must not be used as a bus', function () {
        const events = require('../../runtime/events');
        expect(typeof events.create, 'events.create is the factory').to.equal('function');
        expect(typeof events.emit, 'if the module ever grows an emit(), revisit the comment above: the ' +
            'drivers and the runtime must then agree on WHICH emitter carries device events').to.equal('undefined');
    });

    it('device-utils never publishes on the events module', function () {
        const source = fs.readFileSync(path.join(DEVICES_DIR, 'device-utils.js'), 'utf8');
        const code = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
        expect(code, 'require(...).emit on the events module always throws: it has no emit').to.not.match(/require\('\.\.\/events'\)\.emit/);
        if (/require\('\.\.\/events'\)/.test(code)) {
            expect(code, 'the events module is required AND used as a bus').to.not.match(/events\.emit\(/);
        }
    });

    it('every driver hands the runtime to emitStatus', function () {
        const missing = [];
        let count = 0;
        driverList.forEach((file) => {
            const source = fs.readFileSync(file, 'utf8');
            if (source.indexOf('deviceUtils.emitStatus(') < 0) { return; }
            count++;
            // Slice the whole call: its options object contains a `;` (the onEmit body), so a
            // single-line regex would stop short of the runtime argument.
            const at = source.indexOf('deviceUtils.emitStatus(');
            const call = source.slice(at, source.indexOf(');', at) + 2);
            if (!/\bruntime\b/.test(call)) {
                missing.push(rel(file) + ' calls emitStatus without the runtime');
            }
        });
        expect(count, 'no driver calls emitStatus - the scan is looking at the wrong tree').to.be.greaterThan(5);
        expect(missing, 'without the runtime there is no bus to publish on: ' + missing.join('; ')).to.deep.equal([]);
    });

    it('the ODBC driver takes a runtime like every other driver', function () {
        // It did not: create() was declared with four parameters while device.js calls it with five,
        // the same shape batch 34 fixed in scadiaserver - and without a runtime the status emitter
        // has no bus at all.
        const odbc = require('../../runtime/devices/odbc');
        expect(odbc.create.length, 'odbc.create must declare five parameters, as the Device wrapper calls it')
            .to.equal(5);
    });
});

