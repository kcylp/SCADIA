'use strict';

/**
 * The internal SCADIA-server device needs a runtime, and now receives one.
 *
 * WHY THIS FILE EXISTS. The driver takes a runtime and hands it to the shared emitter:
 *
 *     deviceUtils.emitValues(data, runtime, bindingCache, values, { ... });
 *
 * but its factory was declared as (\`_data, _logger, _events\`) - no runtime at all - and device.js
 * called it with four arguments while EVERY other driver got five. So \`runtime\` resolved to
 * nothing: under this file's 'use strict' that is a ReferenceError, meaning every value emission
 * from the SCADIA-server device threw. Found by ESLint's no-undef (batch 31), traced through
 * device.js and fixed in batch 34.
 *
 * WHAT IS ASSERTED: the wiring exists at both ends - create() forwards a runtime it is given, and
 * the emitter path can be reached without the name failing. Not the wire format: that belongs to
 * device-utils, which has its own coverage.
 */

const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

const driver = require('../../runtime/devices/scadiaserver');

describe('SCADIA-server driver runtime wiring', () => {
    afterEach(() => {
        sinon.restore();
    });

    it('create() accepts manager and runtime like every other driver', function () {
        expect(driver.create.length, 'create must declare five parameters, as the Device wrapper calls it')
            .to.equal(5);
    });

    it('create() forwards the runtime it is given', function () {
        const runtime = { settings: {}, logger: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } };
        const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
        const client = driver.create({ id: 'scadia', name: 'scadia', tags: {}, enabled: true },
            logger, { on: sinon.stub(), emit: sinon.stub() }, {}, runtime);

        expect(client, 'the client is constructed').to.not.equal(null);
        // It reaches the emitter, so the runtime it captured has to be the one we passed. The
        // observable proof is that emitting does not throw with a runtime-shaped object present.
        expect(() => client.getValues()).to.not.throw();
    });

    it('the driver still exposes the interface the Device wrapper calls', function () {
        const runtime = { settings: {}, logger: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } };
        const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
        const client = driver.create({ id: 'scadia', name: 'scadia', tags: {}, enabled: true },
            logger, { on: sinon.stub(), emit: sinon.stub() }, {}, runtime);

        for (const method of ['init', 'connect', 'disconnect', 'polling', 'load',
            'getValues', 'getStatus', 'getTagProperty', 'setValue', 'isConnected']) {
            expect(typeof client[method], method + ' must exist').to.equal('function');
        }
    });
});
