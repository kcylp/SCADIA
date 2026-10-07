/**
 * 'reporting/period': production day, shift table and time period resolution.
 *
 * Every report in this product is time filtered, so this module is the foundation the rest
 * of the reporting stack stands on. Two rules drive the whole design:
 *
 *  1. A production day does not have to start at midnight. Mines and plants close a day at
 *     the hand-over time, so the boundary is configurable (default 08:00).
 *  2. A shift belongs to the production day it works for, not to the calendar day it happens
 *     to fall in. The night shift runs 00:00-08:00 on the NEXT calendar date but is the LAST
 *     shift of the production day that began the previous morning. Without this rule a daily
 *     report never equals the sum of its three shifts, which is the first thing an operator
 *     checks.
 *
 * The server is the authority: a scheduled report is produced with nobody watching, so the
 * numbers must come from one implementation. The client carries a mirror for live UI feedback
 * and test/reporting/periodParity.test.js fails if the two ever disagree.
 */

'use strict';

var MINUTES_PER_DAY = 24 * 60;

/** Default shift table: three eight hour shifts, the usual arrangement on site. */
var DEFAULT_SHIFTS = [
    { id: 'morning', name: '早班', start: '08:00' },
    { id: 'afternoon', name: '中班', start: '16:00' },
    { id: 'night', name: '夜班', start: '00:00' }
];

var DEFAULT_PRODUCTION_DAY_START = '08:00';

/** 'HH:mm' -> minutes since midnight. Throws on anything else: a silent 0 shifts a whole day. */
function parseClock(value, fallback) {
    var text = (value === undefined || value === null || value === '') ? fallback : String(value);
    var m = /^([0-9]{1,2}):([0-9]{2})$/.exec(text.trim());
    if (!m) { throw new Error('invalid time of day: ' + JSON.stringify(value)); }
    var hours = Number(m[1]);
    var minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) { throw new Error('invalid time of day: ' + JSON.stringify(value)); }
    return hours * 60 + minutes;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function formatClock(minutes) {
    var m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/** Local midnight of the calendar date the instant falls in. */
function startOfCalendarDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * Absolute shift, in milliseconds. Correct for durations that really are durations
 * (a rolling 24 hour window), WRONG for calendar arithmetic across a DST change.
 */
function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
}

/**
 * A time of day on a given calendar date, on the wall clock.
 *
 * Shifting a timestamp by 7 * 24 * 60 minutes looks equivalent to "a week earlier" and is not:
 * across a daylight saving change it lands an hour off, so last week starts at 07:00 instead
 * of 08:00 and the report silently includes an hour that belongs to the week before. Plants
 * in DST regions - which the English and Russian markets both include - would see this as a
 * quietly wrong production figure.
 *
 * Everything that means "the same time of day, N days away" goes through these two helpers.
 */
function atTimeOfDay(date, minutesOfDay) {
    var m = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(m / 60), m % 60, 0, 0);
}

/** Wall clock, offset by whole minutes from the START of the given calendar date. */
function atOffset(date, minutesFromDateStart) {
    var carry = Math.floor(minutesFromDateStart / MINUTES_PER_DAY);
    var m = minutesFromDateStart - carry * MINUTES_PER_DAY;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + carry, Math.floor(m / 60), m % 60, 0, 0);
}

/** Calendar day arithmetic that keeps the wall clock time. */
function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), 0, 0);
}

/** Resolve the configured shift table into absolute times of day, in production order. */
function resolveShiftTable(options) {
    var opts = options || {};
    var productionDayStart = parseClock(opts.productionDayStart, DEFAULT_PRODUCTION_DAY_START);
    var source = (Array.isArray(opts.shifts) && opts.shifts.length) ? opts.shifts : DEFAULT_SHIFTS;

    var withOffset = source.map(function (shift, index) {
        var start = parseClock(shift && shift.start, null);
        // Distance from the production day boundary, so a night shift at 00:00 on the next
        // calendar date sorts after the evening shift instead of before the morning one.
        var offset = ((start - productionDayStart) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
        return {
            id: (shift && shift.id) || ('shift' + (index + 1)),
            name: (shift && shift.name) || ('班次' + (index + 1)),
            start: start,
            offset: offset
        };
    });

    withOffset.sort(function (a, b) { return a.offset - b.offset; });

    return {
        productionDayStart: productionDayStart,
        shifts: withOffset.map(function (shift, index) {
            var next = withOffset[index + 1];
            var length = (next ? next.offset : MINUTES_PER_DAY) - shift.offset;
            return {
                id: shift.id,
                name: shift.name,
                index: index,
                startClock: shift.start,
                startOffset: shift.offset,
                lengthMinutes: length,
                endOffset: shift.offset + length
            };
        })
    };
}

/** Start of the production day that contains the given instant. */
function startOfProductionDay(date, table) {
    var resolved = table || resolveShiftTable();
    var midnight = startOfCalendarDay(date);
    var candidate = atTimeOfDay(midnight, resolved.productionDayStart);
    if (date.getTime() < candidate.getTime()) {
        candidate = addDays(candidate, -1);
    }
    return candidate;
}

/** Index of the shift containing the instant, or -1. */
function shiftIndexAt(date, table) {
    var resolved = table || resolveShiftTable();
    var dayStart = startOfProductionDay(date, resolved);
    var elapsed = Math.floor((date.getTime() - dayStart.getTime()) / 60000);
    for (var i = 0; i < resolved.shifts.length; i++) {
        var shift = resolved.shifts[i];
        if (elapsed >= shift.startOffset && elapsed < shift.endOffset) { return i; }
    }
    return -1;
}

function startOfWeek(date) {
    var d = startOfCalendarDay(date);
    var dow = (d.getDay() + 6) % 7; // Monday based week
    return addMinutes(d, -dow * MINUTES_PER_DAY);
}

/**
 * Resolve a report period.
 *
 * kind: realtime | hour | shift | day | week | month | quarter | year | rolling | custom
 * reference: the instant the period is measured around (usually now, or a picked date)
 * options: { productionDayStart, shifts, shiftIndex, rollingHours, from, to, now }
 *
 * Returns { kind, from, to, complete, shiftId, shiftName } where to is EXCLUSIVE and complete
 * tells the caller whether the period has actually finished - a partial period must never be
 * reported as if it were a full one.
 */
function resolvePeriod(kind, reference, options) {
    var opts = options || {};
    var table = resolveShiftTable(opts);
    var ref = reference ? new Date(reference.getTime()) : new Date();
    var from;
    var to;
    var shiftId = null;

    switch (kind) {
        case 'hour':
            from = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), ref.getHours(), 0, 0, 0);
            to = atOffset(startOfCalendarDay(from), from.getHours() * 60 + 60);
            break;
        case 'shift': {
            var index = (opts.shiftIndex === undefined || opts.shiftIndex === null)
                ? shiftIndexAt(ref, table)
                : Number(opts.shiftIndex);
            if (index < 0 || index >= table.shifts.length) { throw new Error('no shift covers ' + ref.toISOString()); }
            var shift = table.shifts[index];
            var dayStartForShift = startOfCalendarDay(startOfProductionDay(ref, table));
            from = atOffset(dayStartForShift, table.productionDayStart + shift.startOffset);
            to = atOffset(dayStartForShift, table.productionDayStart + shift.endOffset);
            shiftId = shift.id;
            break;
        }
        case 'day':
            from = startOfProductionDay(ref, table);
            to = addDays(from, 1);
            break;
        case 'week': {
            var dayStart = startOfProductionDay(ref, table);
            from = atTimeOfDay(startOfWeek(dayStart), table.productionDayStart);
            if (from.getTime() > dayStart.getTime()) { from = addDays(from, -7); }
            to = addDays(from, 7);
            break;
        }
        case 'month': {
            from = atTimeOfDay(new Date(ref.getFullYear(), ref.getMonth(), 1, 0, 0, 0, 0), table.productionDayStart);
            if (from.getTime() > startOfProductionDay(ref, table).getTime()) {
                from = atTimeOfDay(new Date(ref.getFullYear(), ref.getMonth() - 1, 1, 0, 0, 0, 0), table.productionDayStart);
            }
            to = atTimeOfDay(new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0), table.productionDayStart);
            break;
        }
        case 'quarter': {
            var q = Math.floor(ref.getMonth() / 3) * 3;
            from = atTimeOfDay(new Date(ref.getFullYear(), q, 1, 0, 0, 0, 0), table.productionDayStart);
            if (from.getTime() > startOfProductionDay(ref, table).getTime()) {
                from = atTimeOfDay(new Date(ref.getFullYear(), q - 3, 1, 0, 0, 0, 0), table.productionDayStart);
            }
            to = atTimeOfDay(new Date(from.getFullYear(), from.getMonth() + 3, 1, 0, 0, 0, 0), table.productionDayStart);
            break;
        }
        case 'year': {
            from = atTimeOfDay(new Date(ref.getFullYear(), 0, 1, 0, 0, 0, 0), table.productionDayStart);
            if (from.getTime() > startOfProductionDay(ref, table).getTime()) {
                from = atTimeOfDay(new Date(ref.getFullYear() - 1, 0, 1, 0, 0, 0, 0), table.productionDayStart);
            }
            to = atTimeOfDay(new Date(from.getFullYear() + 1, 0, 1, 0, 0, 0, 0), table.productionDayStart);
            break;
        }
        case 'rolling': {
            var hours = Number(opts.rollingHours || 24);
            to = ref;
            from = addMinutes(ref, -hours * 60);
            break;
        }
        case 'realtime':
            from = ref;
            to = ref;
            break;
        case 'custom':
            if (!opts.from || !opts.to) { throw new Error('custom period needs from and to'); }
            from = new Date(opts.from);
            to = new Date(opts.to);
            if (to.getTime() <= from.getTime()) { throw new Error('custom period must end after it starts'); }
            break;
        default:
            throw new Error('unknown period kind: ' + kind);
    }

    var now = opts.now ? new Date(opts.now) : new Date();
    var shiftName = null;
    if (shiftId) {
        for (var s = 0; s < table.shifts.length; s++) {
            if (table.shifts[s].id === shiftId) { shiftName = table.shifts[s].name; }
        }
    }

    return {
        kind: kind,
        from: from,
        to: to,
        // Exclusive end. A period that has not finished yet must be labelled as such:
        // reporting a partial shift as a complete one is how wrong production numbers start.
        complete: kind === 'realtime' ? false : to.getTime() <= now.getTime(),
        shiftId: shiftId,
        shiftName: shiftName,
        productionDayStart: formatClock(table.productionDayStart)
    };
}

/** Every production day overlapping [from, to), for iterating a multi-day report. */
function productionDaysBetween(from, to, options) {
    var table = resolveShiftTable(options);
    var days = [];
    var cursor = startOfProductionDay(new Date(from), table);
    while (cursor.getTime() < to.getTime()) {
        var next = addDays(cursor, 1);
        days.push({ from: new Date(cursor.getTime()), to: next });
        cursor = next;
    }
    return days;
}


/**
 * The period that has just FINISHED before the given instant.
 *
 * A scheduled report always describes a closed period: the daily report that runs at 03:00
 * covers the production day that ended at 08:00 ... no, at the boundary that has passed, and
 * never the day that is still running. Reporting a partial period as a complete one is how a
 * production figure ends up wrong without anybody noticing.
 *
 * Returns the same shape as resolvePeriod.
 */
function resolvePreviousPeriod(kind, reference, options) {
    var opts = options || {};
    var table = resolveShiftTable(opts);
    var ref = reference ? new Date(reference.getTime()) : new Date();
    var current = resolvePeriod(kind, ref, opts);
    var from;
    var to = current.from;
    var shiftId = null;
    var shiftName = null;

    switch (kind) {
        case 'shift': {
            var index = shiftIndexAt(ref, table);
            if (index < 0) { throw new Error('no shift covers ' + ref.toISOString()); }
            var dayStartDate = startOfCalendarDay(startOfProductionDay(ref, table));
            if (index > 0) {
                var previous = table.shifts[index - 1];
                from = atOffset(dayStartDate, table.productionDayStart + previous.startOffset);
                shiftId = previous.id;
                shiftName = previous.name;
            } else {
                var last = table.shifts[table.shifts.length - 1];
                var previousDayDate = addDays(dayStartDate, -1);
                from = atOffset(previousDayDate, table.productionDayStart + last.startOffset);
                shiftId = last.id;
                shiftName = last.name;
            }
            break;
        }
        case 'day':
            from = addDays(current.from, -1);
            break;
        case 'week':
            from = addDays(current.from, -7);
            break;
        case 'month':
            from = atTimeOfDay(new Date(current.from.getFullYear(), current.from.getMonth() - 1, 1, 0, 0, 0, 0), table.productionDayStart);
            break;
        case 'quarter':
            from = atTimeOfDay(new Date(current.from.getFullYear(), current.from.getMonth() - 3, 1, 0, 0, 0, 0), table.productionDayStart);
            break;
        case 'year':
            from = atTimeOfDay(new Date(current.from.getFullYear() - 1, 0, 1, 0, 0, 0, 0), table.productionDayStart);
            break;
        case 'hour':
            from = new Date(current.from.getFullYear(), current.from.getMonth(), current.from.getDate(), current.from.getHours() - 1, 0, 0, 0);
            break;
        default:
            throw new Error('no previous period for kind: ' + kind);
    }

    var now = opts.now ? new Date(opts.now) : new Date();
    return {
        kind: kind,
        from: from,
        to: to,
        complete: true,   // by construction: it ended before the reference instant
        shiftId: shiftId,
        shiftName: shiftName,
        productionDayStart: formatClock(table.productionDayStart)
    };
}

module.exports = {
    MINUTES_PER_DAY: MINUTES_PER_DAY,
    DEFAULT_SHIFTS: DEFAULT_SHIFTS,
    DEFAULT_PRODUCTION_DAY_START: DEFAULT_PRODUCTION_DAY_START,
    parseClock: parseClock,
    formatClock: formatClock,
    resolveShiftTable: resolveShiftTable,
    startOfProductionDay: startOfProductionDay,
    shiftIndexAt: shiftIndexAt,
    resolvePeriod: resolvePeriod,
    resolvePreviousPeriod: resolvePreviousPeriod,
    productionDaysBetween: productionDaysBetween
};
