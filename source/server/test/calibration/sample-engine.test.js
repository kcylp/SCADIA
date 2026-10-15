const assert = require('assert');
const engine = require('../../runtime/calibration/sample-engine');

function run(sampling, values) {
    let i = 0;
    const getter = async () => {
        const v = values[i++];
        return v === undefined ? null : v;
    };
    return new engine.SampleRun('tag', sampling, getter).run();
}

describe('Calibration sample-engine', () => {

    it('collects 8 valid samples and computes stats', async () => {
        const values = Array.from({ length: 8 }, (_, i) => ({ value: 24.9 + 0.01 * i, timestamp: Date.now() + i * 500 }));
        const r = await run({ sampleCount: 8, intervalMs: 1, maxAgeMs: 100000, timeoutMs: 5000 }, values);
        assert.strictEqual(r.acceptedCount, 8);
        assert.strictEqual(r.rejectedCount, 0);
        assert.strictEqual(r.stable, true);
        assert(Math.abs(r.stats.mean - 24.935) < 1e-9);
        assert.strictEqual(r.samples.length, 8);
    });

    it('rejects null / non-finite / stale / duplicate readings', async () => {
        const base = Date.now();
        const values = [
            { value: 1.0, timestamp: base },
            null,
            { value: '  ', timestamp: base + 500 },
            { value: 'abc', timestamp: base + 1000 },
            { value: NaN, timestamp: base + 1500 },
            { value: 2.0, timestamp: base - 99999 },
            { value: 2.0, timestamp: base },
            { value: 1.1, timestamp: base + 2000 },
            { value: 1.2, timestamp: base + 2500 },
            { value: 1.3, timestamp: base + 3000 },
            { value: 1.4, timestamp: base + 3500 },
            { value: 1.5, timestamp: base + 4000 },
            { value: 1.6, timestamp: base + 4500 },
            { value: 1.7, timestamp: base + 5000 },
            { value: 1.8, timestamp: base + 5500 }
        ];
        const r = await run({ sampleCount: 8, intervalMs: 1, maxAgeMs: 10000, timeoutMs: 5000 }, values);
        assert.strictEqual(r.acceptedCount, 8);
        assert.strictEqual(r.rejectedCount, 6);
        const reasons = r.samples.filter(s => !s.accepted).map(s => s.rejectReason);
        assert(reasons.includes('null'));
        assert(reasons.includes('non-finite'));
        assert(reasons.includes('stale'));
        assert(reasons.includes('duplicate'));
    });

    it('MAD filter rejects outliers, keeps cluster', async () => {
        const base = Date.now();
        const clean = [10.0, 10.1, 10.0, 10.1, 10.0, 10.1, 10.0, 10.1, 10.0, 10.1];
        const values = [{ value: 99.0, timestamp: base }].concat(
            clean.map((v, i) => ({ value: v, timestamp: base + 500 * (i + 1) })));
        const r = await run({ sampleCount: 8, intervalMs: 1, maxAgeMs: 100000, timeoutMs: 5000, filter: 'mad', madThreshold: 3.5 }, values);
        assert(r.acceptedCount >= 8);
        assert(r.samples.filter(s => !s.accepted).map(s => s.value).includes(99.0));
        assert(r.stats.mean < 11);
    });

    it('timeout when not enough valid samples', async () => {
        try {
            await run({ sampleCount: 8, intervalMs: 1, maxAgeMs: 100000, timeoutMs: 300 },
                [{ value: 1, timestamp: Date.now() }]);
            assert.fail('should have timed out');
        } catch (err) {
            assert(/CAL_SAMPLE_TIMEOUT/.test(err.message));
        }
    });

    it('cancel rejects immediately and clears timers', async () => {
        const getter = async () => ({ value: Math.random(), timestamp: Date.now() });
        const run = new engine.SampleRun('tag', { sampleCount: 8, intervalMs: 50, maxAgeMs: 100000, timeoutMs: 30000 }, getter);
        const p = run.run();
        setTimeout(() => run.cancel(), 40);
        try {
            await p;
            assert.fail('should have been canceled');
        } catch (err) {
            assert(/CAL_SAMPLE_CANCELED/.test(err.message));
        }
        assert.strictEqual(run.timer, null);
        assert.strictEqual(run.timeoutTimer, null);
    });

    it('unstable data flagged via maxStdDev', async () => {
        const base = Date.now();
        const values = [0, 100, 1, 99, 2, 98, 3, 97].map((v, i) => ({ value: v, timestamp: base + 500 * i }));
        const r = await run({ sampleCount: 8, intervalMs: 1, maxAgeMs: 100000, timeoutMs: 5000, maxStdDev: 1 }, values);
        assert.strictEqual(r.stable, false);
        assert(r.stableViolations.includes('CAL_SAMPLE_STDDEV_HIGH'));
    });
});
