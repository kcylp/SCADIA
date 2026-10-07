/**
 * The plugin dispatcher must route by EQUALITY, and must never guess.
 *
 * loadPlugin(type, module) is the single entry point that binds an installed plugin package to
 * the driver that will use it (runtime/plugins/index.js:161). Every branch compared the type by
 * equality except Modbus, which read:
 *
 *     } else if (DeviceEnum.ModbusTCP.startsWith(type)) {
 *
 * Two things are wrong with that line, and only one of them is stylistic.
 *
 * 1. The direction. It asks whether the CONSTANT starts with the incoming VARIABLE, so any type
 *    that is a prefix of 'ModbusTCP' matched: 'Modbus', 'ModbusT', 'ModbusTCP', and even 'M'.
 * 2. The effect. A match does not fail loudly - it requires the plugin module and hands it to
 *    the Modbus client. A project describing a device as 'Modbus' would have been wired to a
 *    Modbus client it never asked for, and the symptom would be "the device does not respond",
 *    with nothing in any log pointing at the dispatcher.
 *
 * The fix is an explicit whitelist: `type === ModbusTCP || type === ModbusRTU`.
 *
 * HOW THIS IS MEASURED. The dispatcher is a require() switch, and a require() is observable:
 * Node records the resolved file in require.cache. So each case clears the cache, calls the
 * real exported loadPlugin, and then asks whether the module was actually pulled in. No source
 * parsing and no mocked dispatcher - the function under test is the shipped one.
 *
 * NOTE ON ModbusRTU: binding a ModbusRTU plugin now succeeds where it was silently ignored
 * before. That is the intended reading of the whitelist, and ModbusRTU is a real DeviceEnum
 * member (device.js:660) whose non-plugin path is device.js:246. The driver still has to be
 * registered as a plugin for this to matter in the field; the point of the assertion is that
 * the dispatcher no longer refuses a type it shares a driver file with.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const device = require('../../runtime/devices/device');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const FAKE_MODULE = path.join(SERVER_ROOT, 'test', 'devices', '_dispatch-probe.js');

/** Every type the product declares, read from the real enum. */
const DEVICE_ENUM = {
    S7: 'SiemensS7',
    OPCUA: 'OPCUA',
    ModbusRTU: 'ModbusRTU',
    ModbusTCP: 'ModbusTCP',
    BACnet: 'BACnet',
    WebAPI: 'WebAPI',
    MQTTclient: 'MQTTclient',
    EthernetIP: 'EthernetIP',
    OmronEthernetIP: 'OmronEthernetIP',
    SCADIAServer: 'SCADIAServer',
    ODBC: 'ODBC',
    ADSclient: 'ADSclient',
    GPIO: 'GPIO',
    internal: 'internal',
    WebCam: 'WebCam',
    MELSEC: 'MELSEC',
    REDIS: 'REDIS',
    WebSocket: 'WebSocket'
};

/**
 * Types with no plugin branch, and why - asserted below so the list cannot grow silently.
 *
 *   internal   the runtime's own value store; it is not a driver package.
 *   WebCam     required statically at device.js:19 and created at device.js:125, so there is
 *              nothing for a plugin to bind to.
 */
const NO_PLUGIN_BRANCH = ['internal', 'WebCam'];

/**
 * The module the dispatcher is asked to bind. Created on demand so the guard is self-contained:
 * a guard that depends on a helper someone might delete is a guard that stops guarding.
 */
function probeModule() {
    if (!fs.existsSync(FAKE_MODULE)) {
        fs.writeFileSync(FAKE_MODULE,
            "'use strict';\n\n/** Stand-in for an installed driver plugin package. */\nmodule.exports = { __driverDispatchProbe: true };\n",
            'utf8');
    }
    return FAKE_MODULE;
}

probeModule();

/** Hand the dispatcher a path-shaped specifier and see whether Node cached it. */
function binding(type) {
    const resolved = require.resolve(FAKE_MODULE);
    delete require.cache[resolved];
    device.loadPlugin(type, FAKE_MODULE);
    return !!require.cache[resolved];
}

/** A module that has been loaded once and never verified afterwards. */
function loadTwice(type) {
    const resolved = require.resolve(FAKE_MODULE);
    delete require.cache[resolved];
    device.loadPlugin(type, FAKE_MODULE);
    const first = !!require.cache[resolved];
    delete require.cache[resolved];
    device.loadPlugin(type, FAKE_MODULE);
    return first && !!require.cache[resolved];
}

describe('driver plugin dispatch (a prefix is not an identifier)', () => {
    it('the shipped enum still has the values this file asserts against', function () {
        // If a member is renamed, this guard must follow it rather than silently shrink.
        const src = require('fs').readFileSync(path.join(SERVER_ROOT, 'runtime', 'devices', 'device.js'), 'utf8');
        const enumBlock = src.split('var DeviceEnum = {')[1].split('}')[0];
        Object.keys(DEVICE_ENUM).forEach((member) => {
            expect(new RegExp('\\b' + member + '\\s*:').test(enumBlock),
                'DeviceEnum.' + member + ' no longer exists - update this guard').to.equal(true);
        });
    });

    it('every declared type except the two with no plugin branch binds its module', function () {
        const unbindable = [];
        Object.keys(DEVICE_ENUM).forEach((member) => {
            if (NO_PLUGIN_BRANCH.indexOf(member) !== -1) { return; }
            if (!binding(DEVICE_ENUM[member])) { unbindable.push(member); }
        });
        expect(unbindable, 'these declared device types have no plugin branch in loadPlugin, so ' +
            'installing a plugin for them does nothing at all: ' + unbindable.join(', ')).to.deep.equal([]);
    });

    it('the two types with no plugin branch really have none', function () {
        // The other half of the assertion above: an allowlist that is never checked is a hole.
        const bound = NO_PLUGIN_BRANCH.filter((member) => binding(DEVICE_ENUM[member]));
        expect(bound, 'these types ARE handled by loadPlugin now - move them out of NO_PLUGIN_BRANCH, ' +
            'because the other test currently skips them').to.deep.equal([]);
    });

    it('a type that is a PREFIX of a real type binds NOTHING', function () {
        // This is the defect: under `DeviceEnum.ModbusTCP.startsWith(type)` every one of these
        // was routed to the Modbus client. 'M' is the extreme case and it matched too.
        const prefixes = ['M', 'Mo', 'Modbus', 'ModbusT', 'ModbusTCP'.slice(0, 3)];
        const wronglyBound = prefixes.filter((type) => binding(type));
        expect(wronglyBound, 'these non-types were routed to a driver: ' + wronglyBound.join(', '))
            .to.deep.equal([]);
    });

    it('a type that has a real type as its PREFIX binds nothing either', function () {
        // The direction mattered: 'ModbusTCPGateway'.startsWith('ModbusTCP') is true, but the old
        // code asked the opposite question. Either way, a type nobody declared must not dispatch.
        const lookalikes = ['ModbusTCPGateway', 'ModbusTCPPlus', 'ModbusRTU2', 'OPCUA2', 'MQTTclientX'];
        const wronglyBound = lookalikes.filter((type) => binding(type));
        expect(wronglyBound, 'these unknown types were routed to a driver: ' + wronglyBound.join(', '))
            .to.deep.equal([]);
    });

    it('an unknown type is ignored, not thrown', function () {
        // The installed-plugin list can carry anything a project file says. Ignoring is right;
        // throwing would take the whole runtime start down for one bad device row.
        expect(() => device.loadPlugin('not-a-real-type', FAKE_MODULE)).to.not.throw();
        expect(binding('not-a-real-type')).to.equal(false);
    });

    it('an empty or missing type binds nothing', function () {
        ['', null, undefined].forEach((type) => {
            expect(() => device.loadPlugin(type, FAKE_MODULE)).to.not.throw();
            expect(binding(type), 'type ' + JSON.stringify(type) + ' dispatched a driver').to.equal(false);
        });
    });

    it('the dispatcher is repeatable: the same type binds every time it is called', function () {
        // runtime/plugins/index.js calls loadPlugin again on every plugin add. A dispatcher that
        // only worked while the module cache was cold would fail on the second plugin install.
        ['ModbusTCP', 'SiemensS7', 'OPCUA'].forEach((type) => {
            expect(loadTwice(type), type + ' bound once and not twice').to.equal(true);
        });
    });
});
