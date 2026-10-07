'use strict';

/**
 * The reporting stack stands on this module, so it gets the exhaustive test matrix rather
 * than a couple of happy paths. The case that matters most is the night shift: it runs on the
 * next CALENDAR date but belongs to the production day that started the previous morning. Get
 * that wrong and a daily report never equals the sum of its three shifts.
 */

const { expect } = require('chai');
const path = require('path');

const period = require(path.join(__dirname, '..', '..', 'runtime', 'reporting', 'period'));

const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);
const fmt = (date) => {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate())
        + ' ' + p(date.getHours()) + ':' + p(date.getMinutes());
};

describe('reporting period (production day, shifts, ranges)', () => {

    describe('time of day parsing', () => {
        it('accepts the shapes a person types', () => {
            expect(period.parseClock('08:00')).to.equal(480);
            expect(period.parseClock('8:00')).to.equal(480);
            expect(period.parseClock('00:00')).to.equal(0);
            expect(period.parseClock('23:59')).to.equal(1439);
        });

        it('refuses anything else instead of silently using midnight', () => {
            // A silently defaulted 0 would move every report by a whole day.
            expect(() => period.parseClock('25:00')).to.throw(/invalid time of day/);
            expect(() => period.parseClock('08:60')).to.throw(/invalid time of day/);
            expect(() => period.parseClock('8')).to.throw(/invalid time of day/);
            expect(() => period.parseClock('morning')).to.throw(/invalid time of day/);
        });
    });

    describe('the default three shift table', () => {
        const table = period.resolveShiftTable();

        it('runs morning, afternoon, night in production order', () => {
            expect(table.shifts.map(s => s.name)).to.deep.equal(['早班', '中班', '夜班']);
            expect(table.shifts.map(s => s.startOffset)).to.deep.equal([0, 480, 960]);
            expect(table.shifts.map(s => s.lengthMinutes)).to.deep.equal([480, 480, 480]);
        });

        it('covers exactly 24 hours with no gap and no overlap', () => {
            let cursor = 0;
            for (const shift of table.shifts) {
                expect(shift.startOffset).to.equal(cursor);
                cursor += shift.lengthMinutes;
            }
            expect(cursor).to.equal(period.MINUTES_PER_DAY);
        });
    });

    describe('night shift ownership', () => {
        const table = period.resolveShiftTable();

        it('puts 02:30 on the previous production day, not the current one', () => {
            const instant = at(2026, 3, 10, 2, 30);
            expect(fmt(period.startOfProductionDay(instant, table))).to.equal('2026-03-09 08:00');
            expect(period.shiftIndexAt(instant, table)).to.equal(2); // night
        });

        it('a production day is 08:00 -> 08:00 next day', () => {
            const start = period.startOfProductionDay(at(2026, 3, 10, 9, 0), table);
            expect(fmt(start)).to.equal('2026-03-10 08:00');
            expect(fmt(new Date(start.getTime() + 86400000))).to.equal('2026-03-11 08:00');
        });

        it('treats 08:00 exactly as the first minute of the new day', () => {
            expect(period.shiftIndexAt(at(2026, 3, 10, 8, 0), table)).to.equal(0);
            expect(fmt(period.startOfProductionDay(at(2026, 3, 10, 8, 0), table))).to.equal('2026-03-10 08:00');
        });

        it('treats 00:00 exactly as the first minute of the night shift', () => {
            expect(period.shiftIndexAt(at(2026, 3, 10, 0, 0), table)).to.equal(2);
            expect(fmt(period.startOfProductionDay(at(2026, 3, 10, 0, 0), table))).to.equal('2026-03-09 08:00');
        });

        it('covers each shift by its own boundaries', () => {
            expect(period.shiftIndexAt(at(2026, 3, 10, 15, 59), table)).to.equal(0);
            expect(period.shiftIndexAt(at(2026, 3, 10, 16, 0), table)).to.equal(1);
            expect(period.shiftIndexAt(at(2026, 3, 10, 23, 59), table)).to.equal(1);
            expect(period.shiftIndexAt(at(2026, 3, 11, 7, 59), table)).to.equal(2);
        });
    });

    describe('a day equals the sum of its shifts - the check an operator makes first', () => {
        const table = period.resolveShiftTable();
        const now = at(2026, 3, 12, 12, 0);

        it('shifts tile the production day exactly', () => {
            const day = period.resolvePeriod('day', at(2026, 3, 10, 12, 0), { now });
            let previousEnd = day.from.getTime();
            for (let i = 0; i < table.shifts.length; i++) {
                const shift = period.resolvePeriod('shift', at(2026, 3, 10, 12, 0), { now, shiftIndex: i });
                expect(shift.from.getTime(), 'shift ' + i + ' must start where the previous ended').to.equal(previousEnd);
                previousEnd = shift.to.getTime();
            }
            expect(previousEnd).to.equal(day.to.getTime());
        });

        it('names the shifts it resolved', () => {
            const night = period.resolvePeriod('shift', at(2026, 3, 11, 3, 0), { now });
            expect(night.shiftId).to.equal('night');
            expect(night.shiftName).to.equal('夜班');
            expect(fmt(night.from)).to.equal('2026-03-11 00:00');
            expect(fmt(night.to)).to.equal('2026-03-11 08:00');
        });
    });

    describe('calendar periods follow the production day boundary', () => {
        const table = period.resolveShiftTable();
        const now = at(2026, 6, 1, 12, 0);

        it('a month starts at the production day boundary', () => {
            const march = period.resolvePeriod('month', at(2026, 3, 15, 12, 0), { now });
            expect(fmt(march.from)).to.equal('2026-03-01 08:00');
            expect(fmt(march.to)).to.equal('2026-04-01 08:00');
        });

        it('the small hours of the 1st still belong to the previous month', () => {
            // 02:00 on 1 April is the night shift of the production day that began 31 March.
            const april = period.resolvePeriod('month', at(2026, 4, 1, 2, 0), { now });
            expect(fmt(april.from)).to.equal('2026-03-01 08:00');
            expect(fmt(april.to)).to.equal('2026-04-01 08:00');
        });

        it('quarters and years use the same boundary', () => {
            const q = period.resolvePeriod('quarter', at(2026, 5, 20, 12, 0), { now });
            expect(fmt(q.from)).to.equal('2026-04-01 08:00');
            expect(fmt(q.to)).to.equal('2026-07-01 08:00');
            const y = period.resolvePeriod('year', at(2026, 5, 20, 12, 0), { now });
            expect(fmt(y.from)).to.equal('2026-01-01 08:00');
            expect(fmt(y.to)).to.equal('2027-01-01 08:00');
        });

        it('a week is Monday based and production day aligned', () => {
            const w = period.resolvePeriod('week', at(2026, 3, 11, 12, 0), { now });
            expect(w.from.getDay()).to.equal(1); // Monday
            expect(w.from.getHours()).to.equal(8);
            expect((w.to.getTime() - w.from.getTime()) / 86400000).to.equal(7);
        });
    });

    describe('partial periods are never presented as complete', () => {
        it('a day still running is incomplete', () => {
            const ref = at(2026, 3, 10, 12, 0);
            const partial = period.resolvePeriod('day', ref, { now: at(2026, 3, 10, 12, 5) });
            expect(partial.complete).to.equal(false);
            const finished = period.resolvePeriod('day', ref, { now: at(2026, 3, 11, 9, 0) });
            expect(finished.complete).to.equal(true);
        });

        it('realtime is never complete by definition', () => {
            expect(period.resolvePeriod('realtime', at(2026, 3, 10, 12, 0), {}).complete).to.equal(false);
        });
    });

    describe('rolling and custom ranges', () => {
        it('rolling counts back from the reference instant', () => {
            const r = period.resolvePeriod('rolling', at(2026, 3, 10, 12, 0), { rollingHours: 24, now: at(2026, 3, 10, 12, 0) });
            expect(fmt(r.from)).to.equal('2026-03-09 12:00');
            expect(fmt(r.to)).to.equal('2026-03-10 12:00');
        });

        it('custom takes the given bounds and validates them', () => {
            const c = period.resolvePeriod('custom', null, { from: at(2026, 3, 10, 6, 30), to: at(2026, 3, 10, 18, 45), now: at(2026, 4, 1) });
            expect(fmt(c.from)).to.equal('2026-03-10 06:30');
            expect(fmt(c.to)).to.equal('2026-03-10 18:45');
            expect(() => period.resolvePeriod('custom', null, { from: at(2026, 3, 10, 6, 0), to: at(2026, 3, 10, 6, 0) }))
                .to.throw(/must end after/);
        });

        it('rejects a period kind it does not know', () => {
            expect(() => period.resolvePeriod('fortnight', at(2026, 3, 10))).to.throw(/unknown period kind/);
        });
    });

    describe('a customer can move the boundary and the shift table', () => {
        const options = {
            productionDayStart: '06:00',
            shifts: [
                { id: 'a', name: '甲班', start: '06:00' },
                { id: 'b', name: '乙班', start: '14:00' },
                { id: 'c', name: '丙班', start: '22:00' }
            ]
        };
        const table = period.resolveShiftTable(options);

        it('reorders shifts by their distance from the new boundary', () => {
            expect(table.shifts.map(s => s.name)).to.deep.equal(['甲班', '乙班', '丙班']);
            expect(table.shifts.map(s => s.startOffset)).to.deep.equal([0, 480, 960]);
        });

        it('a production day now starts at 06:00', () => {
            expect(fmt(period.startOfProductionDay(at(2026, 3, 10, 5, 0), table))).to.equal('2026-03-09 06:00');
            const d = period.resolvePeriod('day', at(2026, 3, 10, 12, 0), Object.assign({ now: at(2026, 4, 1) }, options));
            expect(fmt(d.from)).to.equal('2026-03-10 06:00');
            expect(d.productionDayStart).to.equal('06:00');
        });

        it('handles a day boundary that lands on a shift boundary other than 00:00', () => {
            // 22:00 shift on a 06:00 day boundary runs across midnight into the next date.
            expect(period.shiftIndexAt(at(2026, 3, 11, 1, 30), table)).to.equal(2);
            expect(fmt(period.startOfProductionDay(at(2026, 3, 11, 1, 30), table))).to.equal('2026-03-10 06:00');
        });
    });

describe('the previous, finished period - what a scheduled report describes', () => {
        const table = period.resolveShiftTable();
        const now = at(2026, 3, 10, 3, 0);   // 03:00, inside the night shift

        it('a daily report covers the production day that has ended', () => {
            const p = period.resolvePreviousPeriod('day', now, { now });
            expect(fmt(p.from)).to.equal('2026-03-08 08:00');
            expect(fmt(p.to)).to.equal('2026-03-09 08:00');
            expect(p.complete).to.equal(true);
        });

        it('a shift report covers the shift that has ended, on the same production day', () => {
            const p = period.resolvePreviousPeriod('shift', now, { now });
            expect(p.shiftName).to.equal('中班');
            expect(fmt(p.from)).to.equal('2026-03-09 16:00');
            expect(fmt(p.to)).to.equal('2026-03-10 00:00');
        });

        it('the shift before the morning shift is the night shift of the day before', () => {
            // 10:00 is the morning shift; nothing earlier exists on that production day, so the
            // previous shift is the night shift that ran into this morning.
            const p = period.resolvePreviousPeriod('shift', at(2026, 3, 10, 10, 0), { now: at(2026, 3, 10, 10, 0) });
            expect(p.shiftName).to.equal('夜班');
            expect(fmt(p.from)).to.equal('2026-03-10 00:00');
            expect(fmt(p.to)).to.equal('2026-03-10 08:00');
        });

        it('weeks, months, quarters and years roll back whole periods', () => {
            expect(fmt(period.resolvePreviousPeriod('week', now, { now }).from)).to.equal('2026-03-02 08:00');
            expect(fmt(period.resolvePreviousPeriod('month', now, { now }).from)).to.equal('2026-02-01 08:00');
            expect(fmt(period.resolvePreviousPeriod('quarter', now, { now }).from)).to.equal('2025-10-01 08:00');
            expect(fmt(period.resolvePreviousPeriod('year', now, { now }).from)).to.equal('2025-01-01 08:00');
        });

        it('never overlaps the period that is still running', () => {
            const current = period.resolvePeriod('day', now, { now });
            const previous = period.resolvePreviousPeriod('day', now, { now });
            expect(previous.to.getTime()).to.equal(current.from.getTime());
            expect(previous.complete).to.equal(true);
        });

        it('accepts no kind that has no predecessor', () => {
            expect(() => period.resolvePreviousPeriod('rolling', now, { now })).to.throw(/no previous period/);
        });
    });

describe('daylight saving does not move a report boundary', () => {
        // The development machine here is not necessarily in a DST region, so the module is
        // exercised in a child process pinned to a timezone that changes its clocks. Without
        // this the whole class of bug passes unnoticed in China and breaks the English market.
        const { execFileSync } = require('child_process');

        const run = (tz, script) => execFileSync(process.execPath, ['-e', script], {
            env: Object.assign({}, process.env, { TZ: tz }),
            encoding: 'utf8'
        }).trim();

        const script = [
            "const period = require('./runtime/reporting/period');",
            "const f = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');",
            // 2026-03-08 is the US spring forward transition.
            "const now = new Date(2026, 2, 10, 3, 0, 0, 0);",
            "const w = period.resolvePreviousPeriod('week', now, { now: now });",
            "const d = period.resolvePreviousPeriod('day', now, { now: now });",
            "const m = period.resolvePreviousPeriod('month', now, { now: now });",
            "console.log(JSON.stringify([f(w.from), f(w.to), f(d.from), f(m.from)]));"
        ].join(' ');

        it('keeps the 08:00 boundary across a spring forward transition', () => {
            const out = JSON.parse(run('America/New_York', script));
            // A naive 7 * 24 * 60 minute shift lands on 07:00 and quietly pulls an hour of the
            // previous week into this week's production figures.
            expect(out[0]).to.equal('2026-03-02 08:00');
            expect(out[1]).to.equal('2026-03-09 08:00');
            expect(out[2]).to.equal('2026-03-08 08:00');
            expect(out[3]).to.equal('2026-02-01 08:00');
        });

        it('keeps the 08:00 boundary in a zone with no DST at all', () => {
            const out = JSON.parse(run('Asia/Shanghai', script));
            expect(out[0]).to.equal('2026-03-02 08:00');
            expect(out[1]).to.equal('2026-03-09 08:00');
        });

        it('keeps the 08:00 boundary across a fall back transition', () => {
            const autumn = script.replace('new Date(2026, 2, 10, 3, 0, 0, 0)', 'new Date(2026, 10, 5, 3, 0, 0, 0)');
            const out = JSON.parse(run('America/New_York', autumn));
            expect(out[0]).to.equal('2026-10-26 08:00');
            expect(out[1]).to.equal('2026-11-02 08:00');
        });
    });

    describe('the report generator is wired to this engine', () => {
        const fs = require('fs');
        const reportSource = fs.readFileSync(
            path.join(__dirname, '..', '..', 'runtime', 'jobs', 'report.js'), 'utf8');

        it('resolves item ranges through the period engine', () => {
            // The old code built ranges from calendar midnight and a 23:59:59 end, so a daily
            // report covered 00:00-24:00 instead of the hand-over to hand-over day.
            expect(reportSource).to.contain('resolvePreviousPeriod');
            expect(reportSource).to.contain('getReportingSettings');
            expect(reportSource).to.not.match(/getDate\(\) - 1\)/);
        });

        it('offers quarter, year and shift ranges in addition to the old presets', () => {
            expect(reportSource).to.contain("quarter: 'quarter'");
            expect(reportSource).to.contain("year: 'year'");
            expect(reportSource).to.contain("shift: 'shift'");
        });
    });


    describe('iterating the production days inside a range', () => {
        it('starts at the first day boundary and stops at the end', () => {
            const days = period.productionDaysBetween(at(2026, 3, 10, 12, 0), at(2026, 3, 12, 9, 0));
            expect(days.length).to.equal(3);
            expect(fmt(days[0].from)).to.equal('2026-03-10 08:00');
            expect(fmt(days[1].from)).to.equal('2026-03-11 08:00');
            expect(fmt(days[2].from)).to.equal('2026-03-12 08:00');
        });
    });
});
