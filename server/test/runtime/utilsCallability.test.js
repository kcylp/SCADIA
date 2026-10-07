'use strict';

/**
 * Every function in runtime/utils.js must at least be able to RUN.
 *
 * WHY THIS EXISTS. utils is imported across the whole backend, and one of its methods -
 * isPlainObject - was copied out of lodash together with five of lodash's INTERNAL helpers that
 * this file never imported. Every call threw ReferenceError: isObjectLike is not defined. Nothing
 * noticed, because nothing called it, and no tool could see it:
 *
 *   - node --check passes a file whose function bodies reference undefined names (measured);
 *   - require() passes it too - the reference only fails when the body runs (measured);
 *   - there is no ESLint in this repository, so there was no no-undef rule.
 *
 * ESLint's no-undef over runtime/ found it in one run, along with thirty other real ones (batch 31).
 * That tool is not a dependency of this project, so this file is the cheap behavioural half of the
 * same guard: CALL everything with a plausible argument and fail if a call dies with a
 * ReferenceError. That is precisely the signature of the defect - a body that names something which
 * does not exist - and it needs no parser.
 *
 * It is deliberately not a fuzz test: the goal is "the body is reachable and does not explode on
 * ordinary input", not "the returned value is correct". Value correctness for each helper belongs in
 * its own test, and where those exist they are better evidence than this.
 */

const path = require('path');
const { expect } = require('chai');

const utils = require('../../runtime/utils');

/**
 * Plausible arguments per method. A missing entry means "call it with a couple of innocuous values":
 * the point is to reach the body, not to exercise every branch.
 */
const ARGUMENTS = {
    domStringSplitter: ['<b>hello</b>', 'b', 0],
    ipv4ToInt: ['10.0.0.1'],
    intToIpv4: [16909060],
    getBroadcastAddress: ['10.0.0.1', '255.255.255.0'],
    isNullOrUndefined: [null],
    isObject: [{}],
    isBoolean: [true],
    isEmptyObject: [{}],
    endTime: [Date.now()],
    formatFromString: ['hello {{value}}', { value: 1 }],
    getFormatFromString: ['hello {{value}}'],
    getValueFromFormat: ['hello 1', 'hello {{value}}', { value: 1 }],
    stringToBoolean: ['true'],
    toBoolean: ['true'],
    isNumeric: ['1'],
    isNumber: [1],
    isFloat: [1.5],
    isInt: [1],
    isString: ['a'],
    isArray: [[]],
    isFunction: [() => {}],
    isJsonString: ['{}'],
    toJson: ['{}'],
    escapeRegExp: ['a.b'],
    sanitize: ['x'],
    hash: ['abc'],
    compareHash: ['abc', 'abc'],
    mergeDeep: [{}, {}],
    clone: [{}]
};

describe('runtime/utils.js is callable end to end', () => {
    it('exposes functions, and the list is not empty', function () {
        const fnNames = Object.keys(utils).filter((k) => typeof utils[k] === 'function');
        expect(fnNames.length, 'utils stopped exposing functions').to.be.greaterThan(10);
    });

    it('no helper dies with a ReferenceError, which is how isPlainObject was broken', function () {
        const broken = [];
        for (const name of Object.keys(utils)) {
            if (typeof utils[name] !== 'function') { continue; }
            const args = ARGUMENTS[name] || [undefined, {}];
            try {
                utils[name].apply(utils, args);
            } catch (err) {
                // A ReferenceError means the body names something that does not exist in this file:
                // exactly the isPlainObject defect. Anything else (a TypeError from an argument this
                // helper does not accept) is not what this test is about.
                if (err instanceof ReferenceError) {
                    broken.push(name + ': ' + err.message);
                }
            }
        }
        expect(broken, 'these helpers reference names that do not exist:\n  ' + broken.join('\n  '))
            .to.deep.equal([]);
    });

    it('isPlainObject is gone, and nothing replaced it silently', function () {
        // Removed rather than repaired: it had ZERO callers in the whole repository and could only
        // throw. Pinned so its return is a deliberate act with a test, not an accident.
        expect(utils.isPlainObject, 'do not reintroduce it without an implementation and a test')
            .to.equal(undefined);
    });

    it('the helpers this file always had still work', function () {
        // A small set of value assertions, so the test above cannot pass by the module being empty.
        // NOTE: ipv4ToInt / intToIpv4 / getBroadcastAddress are module-private (used by
        // getNetworkInterfaces), not exports - so they are not asserted here. Observed while writing
        // this, not assumed.
        expect(utils.isNullOrUndefined(null)).to.equal(true);
        expect(utils.isNullOrUndefined(0)).to.equal(false);
        expect(utils.isBoolean(false)).to.equal(true);
        expect(utils.isEmptyObject({})).to.equal(true);
        expect(utils.isEmptyObject({ a: 1 })).to.equal(false);
        expect(utils.isObject({})).to.equal(true);
        expect(utils.isNumber(1)).to.equal(true);
        expect(utils.chunkArray([1, 2, 3, 4, 5], 2)).to.deep.equal([[1, 2], [3, 4], [5]]);
        expect(utils.dayOfYear(new Date(2024, 0, 1))).to.equal(1);
    });
});
