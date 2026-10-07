import { Calc, CollectionType, TimeValue } from './calc';

/**
 * The aggregation the charts are drawn from - the first client test in this repository (batch 67, N-5).
 *
 * WHY THIS FILE IS THE FIRST ONE. Everything on the server side is guarded by architecture tests, but
 * those guards read CLIENT SOURCE TEXT: they can prove that a colour is written as a token, or that an
 * error code is read from the right field. They cannot prove that Calc.integral puts a value in the
 * bucket the operator sees on the chart. This is arithmetic, it is pure, and its failure mode is a
 * chart that looks plausible and is wrong.
 *
 * Every number below was MEASURED against the implementation before it was asserted - the first two
 * drafts of this file were wrong in interesting ways, which is the other reason to keep it:
 *
 *   1. This is not "sum the samples in each bucket". Each sample contributes
 *      value x (milliseconds since the previous sample) / 1000, and the contribution is booked against
 *      the bucket the interval ENDS in. A gap is filled by carrying the previous value forward, so it
 *      integrates a step signal rather than averaging.
 *   2. The result is NOT a list of buckets. It is an array whose properties are named by the bucket's
 *      epoch-milliseconds - and since those indices are far above 2^32-1 they are ordinary string
 *      properties, so arr.length stays 0 even when there are buckets in it. Read it with Object.keys
 *      or for-in; arr.length, arr.map and arr.forEach will all tell you it is empty.
 *   3. A single sample produces no buckets at all: the oldest sample only anchors the integral.
 */
describe('Calc.integral (the bucket aggregation behind the charts)', () => {
    const t = (iso: string) => new Date(iso).getTime();
    const sample = (iso: string, value: number): TimeValue => ({ dt: t(iso), value });
    const hourStart = (iso: string) => {
        const d = new Date(iso);
        d.setMinutes(0, 0, 0);
        return String(d.getTime());
    };
    const dayStart = (iso: string) => {
        const d = new Date(iso);
        d.setHours(0, 0, 0, 0);
        return String(d.getTime());
    };
    const keys = (result: any) => Object.keys(result);
    const at = (result: any, key: string) => result[Number(key)];

    it('books value x elapsed seconds against the bucket the interval ends in', function () {
        // 08:00 (v2) -> 08:30 (v4): half an hour carries the value 4, i.e. 4 x 1800 seconds.
        const result = Calc.integral([sample('2026-03-10T08:00:00', 2), sample('2026-03-10T08:30:00', 4)],
            CollectionType.Hour);
        expect(keys(result)).toEqual([hourStart('2026-03-10T08:30:00')]);
        expect(at(result, hourStart('2026-03-10T08:30:00'))).toBeCloseTo(7200, 6);
    });

    it('carries the previous value across a gap instead of dropping the time', function () {
        // 08:00 (v2) then 10:00 (v6): the held value 2 covers 08:00->09:00 and 09:00->10:00. The
        // second sample adds nothing of its own - its interval starts where the carry ended.
        const result = Calc.integral([sample('2026-03-10T08:00:00', 2), sample('2026-03-10T10:00:00', 6)],
            CollectionType.Hour);
        expect(keys(result)).toEqual([
            hourStart('2026-03-10T09:00:00'),
            hourStart('2026-03-10T10:00:00')
        ]);
        expect(at(result, hourStart('2026-03-10T09:00:00'))).toBeCloseTo(7200, 6);
        expect(at(result, hourStart('2026-03-10T10:00:00'))).toBeCloseTo(7200, 6);
    });

    it('books a multi-day gap by minutes of the day, and the last sample still contributes', function () {
        // 03-08 10:00 (v1) -> 03-11 10:00 (v4). Measured: 14 h of v1 into the 03-09 bucket, a full
        // day of v1 into each of the next two, and then v4 for the 10 h left inside the last bucket.
        const result = Calc.integral([sample('2026-03-08T10:00:00', 1), sample('2026-03-11T10:00:00', 4)],
            CollectionType.Day);
        expect(keys(result)).toEqual([
            dayStart('2026-03-09T00:00:00'),
            dayStart('2026-03-10T00:00:00'),
            dayStart('2026-03-11T00:00:00')
        ]);
        expect(at(result, dayStart('2026-03-09T00:00:00'))).toBeCloseTo(50400, 6);    // 14 h x 1
        expect(at(result, dayStart('2026-03-10T00:00:00'))).toBeCloseTo(86400, 6);    // 24 h x 1
        expect(at(result, dayStart('2026-03-11T00:00:00'))).toBeCloseTo(230400, 6);   // 24 h x 1 + 10 h x 4
    });

    it('the oldest bucket is never created - a lone sample produces nothing', function () {
        // The first sample has no elapsed time before it. A chart that expects a value at the left
        // edge would look broken, so the behaviour is stated rather than discovered.
        const alone = Calc.integral([sample('2026-03-10T08:20:00', 3)], CollectionType.Hour);
        expect(keys(alone).length).toBe(0);
        const longer = Calc.integral([sample('2026-03-08T10:00:00', 1), sample('2026-03-11T10:00:00', 4)],
            CollectionType.Day);
        expect(keys(longer)).not.toContain(dayStart('2026-03-08T00:00:00'));
    });

    it('reports length 0 while holding buckets: the indices are epoch-ms, not array slots', function () {
        const result = Calc.integral([sample('2026-03-10T08:00:00', 2), sample('2026-03-10T08:30:00', 4)],
            CollectionType.Hour);
        expect(keys(result).length).toBe(1);
        // Above 2^32-1 a numeric key stops being an array index, so it does not extend length. Code
        // that iterates with .map/.forEach/.length sees an empty result and silently draws nothing.
        expect(result.length).toBe(0);
        expect(Array.isArray(result)).toBe(true);
    });

    it('divides every bucket by the unit it is given (integralForHour divides by 3600)', function () {
        const series = [sample('2026-03-10T08:00:00', 2), sample('2026-03-10T09:00:00', 2)];
        const seconds = Calc.integral(series.map((s) => ({ ...s })), CollectionType.Hour);
        const hours = Calc.integralForHour(series.map((s) => ({ ...s })), CollectionType.Hour);
        expect(at(seconds, hourStart('2026-03-10T09:00:00'))).toBeCloseTo(7200, 6);
        expect(at(hours, hourStart('2026-03-10T09:00:00'))).toBeCloseTo(2, 9);
    });

    it('sorts a series that arrives newest-first, and does not throw on an empty one', function () {
        const unsorted = Calc.integral([sample('2026-03-10T09:00:00', 5), sample('2026-03-10T08:00:00', 2)],
            CollectionType.Hour);
        expect(keys(unsorted)).toEqual([hourStart('2026-03-10T09:00:00')]);
        expect(at(unsorted, hourStart('2026-03-10T09:00:00'))).toBeCloseTo(7200, 6);

        let empty: any = null;
        expect(() => { empty = Calc.integral([], CollectionType.Day); }).not.toThrow();
        expect(keys(empty).length).toBe(0);
    });
});
