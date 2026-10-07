const assert = require('assert');
const fitEngine = require('../../runtime/calibration/fit-engine');

function pts(pairs) {
    return pairs.map((p, i) => ({ id: 'p' + i, mean: p[0], referenceValue: p[1] }));
}
const C = 1e-9;

describe('Calibration fit-engine', () => {

    it('perfect line y = 2x + 3', () => {
        const r = fitEngine.fitLinear(pts([[1, 5], [2, 7], [3, 9], [4, 11]]));
        assert(Math.abs(r.gain - 2) < C);
        assert(Math.abs(r.offset - 3) < C);
        assert(Math.abs(r.r2 - 1) < C);
        assert(Math.abs(r.rmse) < C);
        assert(r.qualityPassed === true);
    });

    it('noisy points still fit slope ~2 with high R2', () => {
        const r = fitEngine.fitLinear(pts([[0, 0.1], [10, 20.2], [20, 39.8], [30, 60.4]]));
        assert(Math.abs(r.gain - 2.0) < 0.1);
        assert(r.r2 > 0.99);
    });

    it('two-point exact fit', () => {
        const r = fitEngine.fitLinear(pts([[0, 1], [10, 21]]));
        assert.strictEqual(r.gain, 2);
        assert.strictEqual(r.offset, 1);
    });

    it('rejects identical raw values', () => {
        assert.throws(() => fitEngine.fitLinear(pts([[5, 1], [5, 2], [5, 3]])), /CAL_FIT_ZERO_RAW_SPAN/);
    });

    it('rejects tiny raw span', () => {
        assert.throws(() => fitEngine.fitLinear(pts([[1, 1], [1.0000000001, 2]])), /CAL_FIT_ZERO_RAW_SPAN/);
    });

    it('constant y: gain 0, r2 1', () => {
        const r = fitEngine.fitLinear(pts([[1, 5], [2, 5], [3, 5]]));
        assert.strictEqual(r.r2, 1);
        assert(Math.abs(r.gain) < C);
    });

    it('negative slope', () => {
        const r = fitEngine.fitLinear(pts([[0, 10], [5, 0], [10, -10]]));
        assert(Math.abs(r.gain + 2) < C);
        assert(Math.abs(r.offset - 10) < C);
    });

    it('mixed magnitudes', () => {
        const r = fitEngine.fitLinear(pts([[0.001, 0.002], [1000, 2000]]));
        assert(Math.abs(r.gain - 2) < 1e-6);
    });

    it('rejects NaN/Infinity and < 2 points', () => {
        assert.throws(() => fitEngine.fitLinear(pts([[NaN, 1], [2, 2]])), /CAL_FIT_NON_FINITE/);
        assert.throws(() => fitEngine.fitLinear(pts([[Infinity, 1], [2, 2]])), /CAL_FIT_NON_FINITE/);
        assert.throws(() => fitEngine.fitLinear(pts([[1, 1]])), /CAL_FIT_MIN_POINTS/);
        assert.throws(() => fitEngine.fitLinear([]), /CAL_FIT_MIN_POINTS/);
    });

    it('quality violations and stable hash', () => {
        const r = fitEngine.fitLinear(pts([[0, 0], [10, 20], [20, 41]]), { minR2: 0.999999 });
        assert.strictEqual(r.qualityPassed, false);
        assert(r.violations.includes('CAL_FIT_R2_LOW'));
        assert.strictEqual(fitEngine.computeFitHash(r), fitEngine.computeFitHash(JSON.parse(JSON.stringify(r))));
        assert(/^sha256:[0-9a-f]{64}$/.test(fitEngine.computeFitHash(r)));
    });
});
