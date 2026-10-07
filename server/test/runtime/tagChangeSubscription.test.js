/**
 * A subscribed tag must announce its new value to the in-process consumers.
 *
 * `tagsSubscription` is a Map of tag id -> true, fed by 'tag-change:subscription'. Three real
 * consumers subscribe to the RESULT:
 *
 *   runtime/scheduler/scheduler-service.js:33   a scheduler step triggered by a tag value
 *   runtime/opcua-server/index.js:587           an OPC UA client's monitored item
 *   runtime/devices/mqtt/index.js:417           republishing a tag onto MQTT
 *
 * The emission was `tagsSubscription.forEach((key, value) => ... event.values[value] ...)`.
 * Map.forEach hands (value, key), so the lookup was event.values[true] - always undefined -
 * and 'tag-value:changed' never fired from this path at all. No error, no log: the scheduler
 * simply never triggered, and the OPC UA server never pushed an update. This is the shape of
 * bug the whole architecture pass exists to make impossible to reintroduce.
 *
 * The test asserts the wiring, not the caller: it emits through the exported seam and watches
 * what arrives, so it fails both when the callback arguments are swapped back and when the
 * payload stops being a single tag.
 */

'use strict';

const { expect } = require('chai');

const runtime = require('../../runtime');

describe('tag-value:changed emission', () => {
    const received = [];
    const listener = (payload) => received.push(payload);

    before(() => { runtime.events.on('tag-value:changed', listener); });
    after(() => { runtime.events.removeListener('tag-value:changed', listener); });
    beforeEach(() => { received.length = 0; });

    it('announces the tag record it was given, unchanged', function () {
        const tag = { id: 't_temp', name: 't_temp', value: 41.5, timestamp: 1700000000000, quality: 'good' };
        expect(runtime.emitTagValueChanged(tag)).to.equal(true);
        expect(received).to.deep.equal([tag]);
    });

    it('does not announce a value it does not have', function () {
        // A consumer cannot tell "no value" from "value undefined", and would treat it as a
        // change: an OPC UA client would get a null update, a scheduler step could fire on it.
        expect(runtime.emitTagValueChanged(undefined)).to.equal(false);
        expect(runtime.emitTagValueChanged(null)).to.equal(false);
        expect(runtime.emitTagValueChanged('t_temp')).to.equal(false);
        expect(runtime.emitTagValueChanged(42)).to.equal(false);
        expect(received).to.deep.equal([]);
    });

    it('announces each subscribed tag reference on its own, as the loop in updateDeviceValues does', function () {
        // Mirrors updateDeviceValues: one event per subscribed tag, carrying event.values[tagId].
        const values = {
            t_temp: { id: 't_temp', value: 41.5, timestamp: 1, quality: 'good' },
            t_press: { id: 't_press', value: 2.5, timestamp: 1, quality: 'good' }
        };
        const subscriptions = new Map([['t_temp', true], ['t_press', true], ['t_unused', false]]);

        subscriptions.forEach((subscribed, tagId) => {
            if (subscribed) { runtime.emitTagValueChanged(values[tagId]); }
        });

        expect(received.map((tag) => tag.id)).to.deep.equal(['t_temp', 't_press'],
            'a false subscription flag must not announce anything, and a subscribed tag with no ' +
            'value must not announce undefined');
    });
});
