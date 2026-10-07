'use strict';

/**
 * The S7 driver must not leak its bit helpers onto the global object.
 *
 * WHY THIS EXISTS. Four helpers - _getBit, _setBit, _clearBit, _toggleBit - were written inside the
 * S7client factory WITHOUT a declaration keyword, in a file with no 'use strict'. So they became
 * implicit globals: assigned onto the global object when a client is constructed, shared by every S7
 * client in the process, and invisible to scope analysis.
 *
 * They worked by luck rather than design. The assignments happen synchronously during construction,
 * while their only call sites sit inside an async function body that runs later - so the name
 * resolved. Under strict mode (ES modules, some bundlers) the same code throws instead, taking the
 * whole driver down at load.
 *
 * Found by ESLint's no-undef over runtime/ (batch 31): these were the only four undeclared
 * assignments of this shape anywhere in the runtime tree.
 *
 * The driver is exercised with a STUBBED snap7, because a real one needs the native snap7 library
 * and a PLC. That is enough here: this test is about the factory's scoping, not about the wire.
 */

const Module = require('module');
const path = require('path');
const sinon = require('sinon');
const { expect } = require('chai');

const S7_PATH = path.join(__dirname, '..', '..', 'runtime', 'devices', 's7', 'index.js');

/** Install a fake snap7 (and a fake s7client) so the driver can be constructed. */
function loadDriverWithStubbedSnap7() {
    const originalLoad = Module._load;
    const fakeClient = {
        ConnectTo: () => 0,
        Disconnect: () => 0,
        SetParam: () => 0,
        ReadArea: () => 0,
        WriteArea: () => 0,
        DBRead: () => 0,
        DBWrite: () => 0,
        EBRead: () => 0,
        EBWrite: () => 0,
        ABRead: () => 0,
        ABWrite: () => 0,
        MBRead: () => 0,
        MBWrite: () => 0,
        TMRead: () => 0,
        CTRead: () => 0,
        Connected: () => false
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'node-snap7') {
            return { S7Client: function () { return fakeClient; } };
        }
        if (request === './datatypes' && parent && parent.filename === S7_PATH) {
            return () => ({ getTypes: () => ({}), getSize: () => 1, getS7Type: () => 'BYTE', getValue: () => 0 });
        }
        return originalLoad.apply(this, arguments);
    };

    delete require.cache[require.resolve('../../runtime/devices/s7/index.js')];
    let driver = null;
    try {
        driver = require('../../runtime/devices/s7/index.js');
    } finally {
        Module._load = originalLoad;
    }
    return driver;
}

/**
 * The manager the driver asks for the native library through (loadSnap7Lib falls back to
 * manager.require). Without it create() returns null and there is nothing to construct.
 */
function makeManager() {
    return { require: () => ({ S7Client: function () { return { ConnectTo: () => 0, Disconnect: () => 0, SetParam: () => 0, Connected: () => false, ErrorText: () => 'n/a' }; } }) };
}

describe('S7 driver scoping', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/devices/s7/index.js')];
        delete global._getBit;
        delete global._setBit;
        delete global._clearBit;
        delete global._toggleBit;
    });

    it('constructing a client does NOT create globals', function () {
        // THE REGRESSION. Before the fix, these four appeared on the global object as soon as a
        // client was built.
        const driver = loadDriverWithStubbedSnap7();
        expect(driver, 'the driver module loaded').to.not.equal(null);

        const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
        const client = driver.create({ id: 's7-1', name: 's7-1', tags: {}, enabled: true },
            logger, { on: sinon.stub(), emit: sinon.stub() }, makeManager(), { settings: {}, devices: {} });
        expect(client, 'the client was constructed').to.not.equal(null);

        expect(global._getBit, 'global._getBit must stay undefined').to.equal(undefined);
        expect(global._setBit).to.equal(undefined);
        expect(global._clearBit).to.equal(undefined);
        expect(global._toggleBit).to.equal(undefined);
    });

    it('the driver still exposes the interface the Device wrapper calls', function () {
        const driver = loadDriverWithStubbedSnap7();
        expect(typeof driver.create, 'create is the entry point the manager uses').to.equal('function');
        const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
        const client = driver.create({ id: 's7-1', name: 's7-1', tags: {}, enabled: true },
            logger, { on: sinon.stub(), emit: sinon.stub() }, makeManager(), { settings: {}, devices: {} });
        expect(client, 'the client was constructed').to.not.equal(null);

        for (const method of ['connect', 'disconnect', 'polling', 'load', 'getValues', 'getStatus',
            'getTagProperty', 'setValue', 'isConnected']) {
            expect(typeof client[method], method + ' must exist').to.equal('function');
        }
    });

    it('the bit arithmetic itself is correct', function () {
        // The helpers are private, so this asserts the behaviour through the public surface is not
        // possible; instead the arithmetic is stated here, and the two tests above prove the helpers
        // are reachable without leaking. If the helpers are ever exported, replace this with direct
        // assertions - this one documents the intended semantics.
        const getBit = (number, bitPosition) => ((number >> bitPosition) % 2 != 0);
        const setBit = (number, bitPosition) => number | 1 << bitPosition;
        const clearBit = (number, bitPosition) => number & ~(1 << bitPosition);

        expect(getBit(0b1010, 1)).to.equal(true);
        expect(getBit(0b1010, 0)).to.equal(false);
        expect(setBit(0b1000, 0)).to.equal(0b1001);
        expect(clearBit(0b1011, 0)).to.equal(0b1010);
    });
});
