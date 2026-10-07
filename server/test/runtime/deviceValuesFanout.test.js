'use strict';

/**
 * One failing subscriber must not silence the rest - and the fan-out must say WHO failed.
 *
 * WHAT WAS WRONG
 *
 * updateDeviceValues wrapped the entire realtime fan-out in one try/catch:
 *
 *     try {
 *         if (settings.broadcastAll === false) {
 *             sockets.forEach(socket => socket.emit(DEVICE_VALUES, frameFor(socket)));
 *         } else {
 *             io.emit(DEVICE_VALUES, frameForAll);
 *         }
 *         tagsSubscription.forEach(... emitTagValueChanged ...);
 *     } catch (err) { logger.error('Error updating device values: ' + err.message); }
 *
 * Two consequences, both invisible in production:
 *
 *   1. A socket whose emit throws - a half-closed transport, or client state that is not what the
 *      server assumes - aborted the loop for EVERY socket after it in the list, and then skipped the
 *      in-process announce below. One bad subscriber silenced all the others.
 *   2. The log line named neither the socket nor the device, so the report an operator could file was
 *      "values stopped updating" with no way to find out for whom.
 *
 * The fan-out is now a named function, each socket is isolated, and the failure names both. That is
 * a deliberate behaviour change: the old behaviour was not resilience, it was a single point of
 * silence.
 *
 * The loop is exported as a seam precisely because the interesting property - "the second socket
 * still receives its frame" - cannot be asserted from outside otherwise, and booting socket.io to
 * test it would make the test about socket.io.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const runtime = require('../../runtime');
const Events = require('../../runtime/events');

/** A socket double that records what it was sent, and can be made to throw. */
function makeSocket(id, subscribed, options) {
    const opts = options || {};
    return {
        id: id,
        tagsClientSubscriptions: subscribed,
        sent: [],
        emit(event, payload) {
            if (opts.throwOnEmit) { throw new Error('transport closed'); }
            this.sent.push({ event: event, payload: payload });
        }
    };
}

/** An io double with a Map of sockets, plus the global emit. */
function makeIo(sockets) {
    const map = new Map();
    sockets.forEach((socket) => map.set(socket.id, socket));
    return {
        broadcasts: [],
        sockets: { sockets: map },
        emit(event, payload) { this.broadcasts.push({ event: event, payload: payload }); }
    };
}

const DEVICE_VALUES = Events.IoEventTypes.DEVICE_VALUES;

describe('device-values fan-out (one bad socket must not silence the others)', () => {
    const event = {
        id: 'dev1',
        values: {
            t1: { id: 't1', value: 1, timestamp: 10, quality: 'good' },
            t2: { id: 't2', value: 2, timestamp: 10, quality: 'good' }
        }
    };

    it('broadcasts the whole frame to everyone when broadcastAll is not false', function () {
        const io = makeIo([]);
        const result = runtime.fanOutDeviceValues(io, event, { broadcastAll: true });
        expect(result).to.deep.equal({ mode: 'broadcast', sent: 1, failed: 0 });
        expect(io.broadcasts).to.have.length(1);
        expect(io.broadcasts[0].event).to.equal(DEVICE_VALUES);
        expect(io.broadcasts[0].payload.id).to.equal('dev1');
        expect(io.broadcasts[0].payload.values.map((v) => v.id).sort()).to.deep.equal(['t1', 't2']);
    });

    it('sends each socket only the tags THAT socket subscribed to', function () {
        const a = makeSocket('a', ['t1']);
        const b = makeSocket('b', ['t2']);
        const io = makeIo([a, b]);
        runtime.fanOutDeviceValues(io, event, { broadcastAll: false });
        expect(a.sent[0].payload.values.map((v) => v.id)).to.deep.equal(['t1']);
        expect(b.sent[0].payload.values.map((v) => v.id)).to.deep.equal(['t2']);
    });

    it('a socket with no matching subscription still gets its own (empty) frame', function () {
        // The client uses the receipt to know the device spoke; dropping the frame would make a
        // silent device indistinguishable from a device with nothing to say.
        const a = makeSocket('a', ['other']);
        const io = makeIo([a]);
        runtime.fanOutDeviceValues(io, event, { broadcastAll: false });
        expect(a.sent).to.have.length(1);
        expect(a.sent[0].payload.values).to.deep.equal([]);
    });

    it('a throwing socket is reported WITH its id and the device, and the others still get their frame', function () {
        const bad = makeSocket('bad', ['t1'], { throwOnEmit: true });
        const good = makeSocket('good', ['t1']);
        const errors = [];
        const io = makeIo([bad, good]);

        const result = runtime.fanOutDeviceValues(io, event, {
            broadcastAll: false,
            logger: { error: (message) => errors.push(message) }
        });

        expect(result).to.deep.equal({ mode: 'subscribed', sent: 1, failed: 1 });
        expect(good.sent, 'the socket AFTER the failing one never received its values').to.have.length(1);
        expect(errors).to.have.length(1);
        expect(errors[0]).to.contain('bad');
        expect(errors[0]).to.contain('dev1');
        expect(errors[0]).to.contain('transport closed');
    });

    it('a socket missing its subscription list is treated as subscribed to nothing, not as a crash', function () {
        // The old code read socket.tagsClientSubscriptions.includes(...) directly, so a socket shape
        // that lacked the field threw - and took the whole fan-out down with it.
        const odd = { id: 'odd', emit() { this.called = (this.called || 0) + 1; } };
        const io = makeIo([odd]);
        const result = runtime.fanOutDeviceValues(io, event, { broadcastAll: false });
        expect(result.failed).to.equal(0);
        expect(odd.called).to.equal(1);
    });

    it('survives a malformed io object rather than throwing into the caller', function () {
        expect(() => runtime.fanOutDeviceValues({}, event, { broadcastAll: false })).to.not.throw();
        expect(runtime.fanOutDeviceValues({}, event, { broadcastAll: false }).sent).to.equal(0);
    });

    it('an event with no values still produces a frame rather than an exception', function () {
        const a = makeSocket('a', ['t1']);
        const io = makeIo([a]);
        expect(() => runtime.fanOutDeviceValues(io, { id: 'dev1' }, { broadcastAll: false })).to.not.throw();
        expect(a.sent[0].payload.values).to.deep.equal([]);
    });
});
describe('device-values: a LOST update is reported to the client (N-27)', () => {
    const event = {
        id: 'dev1',
        values: { t1: { id: 't1', value: 1, timestamp: 10, quality: 'good' } }
    };

    it('the fan-out result is what distinguishes a LOST update from a served one', function () {
        // updateDeviceValues reports a lost update exactly when `sent === 0 && failed > 0`, and these
        // two calls are where that distinction is produced. Nobody subscribed (empty list) also
        // yields sent 0 - but failed 0, so it is not a loss and must not be reported as one.
        const allBad = makeIo([makeSocket('a', ['t1'], { throwOnEmit: true }), makeSocket('b', ['t1'], { throwOnEmit: true })]);
        const lost = runtime.fanOutDeviceValues(allBad, event, { broadcastAll: false, logger: { error: () => {} } });
        expect(lost.sent, 'every socket refused the frame').to.equal(0);
        expect(lost.failed).to.equal(2);

        const nobody = runtime.fanOutDeviceValues(makeIo([]), event, { broadcastAll: false });
        expect(nobody.sent, 'nobody is subscribed').to.equal(0);
        expect(nobody.failed, 'and nobody FAILED - a device with no subscribers is not a loss').to.equal(0);

        const partial = runtime.fanOutDeviceValues(
            makeIo([makeSocket('a', ['t1'], { throwOnEmit: true }), makeSocket('b', ['t1'])]),
            event, { broadcastAll: false, logger: { error: () => {} } });
        expect(partial.sent, 'a partial failure is not a lost update').to.be.greaterThan(0);
        expect(partial.failed).to.be.greaterThan(0);
    });

    it('a lost update is actually reported, with the device named', function () {
        // The decision lives in updateDeviceValues, which reaches the transport through its own
        // module-level io - not through the getter the export exposes - so it cannot be driven from
        // here without booting the runtime. Read the wiring instead of a copy of it: the frame must
        // be emitted from the fan-out result, and it must carry the device id.
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'runtime', 'index.js'), 'utf8');
        const body = src.slice(src.indexOf('function updateDeviceValues('));
        const decision = body.slice(0, body.indexOf('tagsSubscription.forEach'));

        expect(decision, 'updateDeviceValues no longer emits DEVICE_VALUES_ERROR')
            .to.contain('Events.IoEventTypes.DEVICE_VALUES_ERROR');
        expect(decision, 'the lost-update condition is `failed > 0 && sent === 0`')
            .to.match(/fanOut\.failed > 0\s*&&\s*fanOut\.sent === 0/);
        expect(decision, 'the frame must name the device').to.contain('event && event.id');
    });
});
