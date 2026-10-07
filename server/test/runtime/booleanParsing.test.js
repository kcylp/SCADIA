/**
 * One boolean parsing rule, written down.
 *
 * Eight places in this server turned an incoming value into a boolean, and they did not
 * agree (batch 60 measured all of them):
 *
 *   - the strict reading ("'true' / '1' is true, everything else is false") in
 *     device-utils, scadiaserver, scheduler and opcua;
 *   - httprequest answered Boolean(value), so the STRING 'false' became TRUE - a boolean
 *     write performed the opposite of what it was asked to do;
 *   - adsclient answered value.toLowerCase() !== 'false', so the string '0' became TRUE and
 *     a numeric value threw a TypeError;
 *   - the copy inside runtime/utils.js said everything except 'false' was true;
 *   - recipes' coerceValue deliberately passes an unparseable value through instead of
 *     deciding (its own contract, covered by test/recipes/recipeService.test.js).
 *
 * They now all go through utils.parseBoolean, and this file is the statement of what that
 * function means. The direction of the decision is the point: in a control system a value
 * nobody can read must fall to FALSE, never to TRUE, because a true is what closes a
 * contactor or starts a pump.
 */

'use strict';

const { expect } = require('chai');
const utils = require('../../runtime/utils');
const deviceUtils = require('../../runtime/devices/device-utils');

/** [input, the boolean it must mean] */
const TRUTH_TABLE = [
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    ['true', true],
    ['TRUE', true],
    [' true ', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    [' false ', false],
    ['0', false],
    ['', false],
    ['yes', false],
    ['on', false],
    ['2', false],
    [null, false],
    [undefined, false]
];

function show(value) {
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

describe('the boolean parser (one rule for devices, recipes and the scheduler)', () => {
    it('utils.parseBoolean is exported and callable', function () {
        expect(typeof utils.parseBoolean, 'utils.parseBoolean is gone - the call sites have nowhere to go')
            .to.equal('function');
    });

    it('the truth table holds', function () {
        const wrong = TRUTH_TABLE
            .filter(([input, expected]) => utils.parseBoolean(input) !== expected)
            .map(([input, expected]) => show(input) + ' -> ' + utils.parseBoolean(input) + ', expected ' + expected);
        expect(wrong, wrong.join(' | ')).to.deep.equal([]);
    });

    it('nothing unreadable is EVER true (the safe direction)', function () {
        // Stated separately from the table above because it is the one property the incident
        // was about: every one of these once meant true somewhere in the tree.
        const dangerous = ['false', '0', '', 'no', 'off', 'x', 'null', 'undefined', ' '];
        const turnedOn = dangerous.filter((value) => utils.parseBoolean(value) === true);
        expect(turnedOn, 'these unreadable values now write TRUE to a device: ' + turnedOn.join(', '))
            .to.deep.equal([]);
    });

    it('parseValue(value, "boolean") uses the same reading', function () {
        const wrong = TRUTH_TABLE
            .filter(([input, expected]) => utils.parseValue(input, 'boolean') !== expected)
            .map(([input]) => show(input));
        expect(wrong, wrong.join(', ')).to.deep.equal([]);
    });

    it('deviceUtils.parseValue uses the same reading (melsec, redis and scadiaserver read through it)', function () {
        const wrong = TRUTH_TABLE
            .filter(([input, expected]) => deviceUtils.parseValue(input, 'boolean') !== expected)
            .map(([input]) => show(input));
        expect(wrong, wrong.join(', ')).to.deep.equal([]);
    });

    it('the two defects that were fixed here stay fixed', function () {
        // httprequest used to answer Boolean('false') === true at its write call site, and
        // adsclient used to answer 1 for the string '0'. Both now ask this function.
        expect(deviceUtils.parseValue('false', 'boolean'), "the string 'false' must not mean true").to.equal(false);
        expect(deviceUtils.parseValue('0', 'boolean'), "the string '0' must not mean true").to.equal(false);
        expect(utils.parseBoolean(2), 'a non-zero number keeps its JavaScript meaning').to.equal(true);
    });

    it('the other types are untouched by the boolean work', function () {
        expect(utils.parseValue('42', 'number')).to.equal(42);
        expect(utils.parseValue('3.14159', 'number')).to.equal(3.14159);
        expect(utils.parseValue('run', 'string')).to.equal('run');
        expect(utils.parseValue(12, undefined)).to.equal(12);
        expect(utils.parseValue('12', undefined)).to.equal(12);
        expect(utils.parseValue('run', undefined)).to.equal('run');
    });
});
