/**
 * 'reporting/contract': the wire format shared by the report editor (client) and the report
 * generator (server).
 *
 * The two sides have to agree on a set of bare identifiers: the client writes them into a
 * saved report, the server switches on them when producing the PDF. Until now that agreement
 * was implicit - the client's enums used the identifier as the enum KEY, and the server
 * hand-wrote an object whose values happened to match, with the item types not declared
 * anywhere at all but spelled out as string literals at each comparison.
 *
 * Nothing checked it, and it drifted. The client could not express the quarter, year and
 * shift ranges the server had learned, and the "no range" case was even spelled differently
 * on the two sides ('one' against 'none'). Because the server treated an unrecognised range
 * as "as of now", a mismatch produced a plausible looking report of the wrong period instead
 * of an error - the worst possible failure mode for a production figure.
 *
 * This file is the single source. test/reporting/contract.test.js asserts that the client
 * enums and the server comparisons both match it, so drift fails the build instead of
 * reaching a customer.
 */

'use strict';

var REPORT_ITEM_TYPE = {
    text: 'text',
    table: 'table',
    alarms: 'alarms',
    chart: 'chart'
};

/**
 * Period of a report item.
 *
 * 'none' means as-of-now. It used to be spelled 'one' on the client; the server still accepts
 * that alias so reports saved by an older build keep working, but nothing new may use it.
 */
var REPORT_DATE_RANGE = {
    none: 'none',
    shift: 'shift',
    day: 'day',
    week: 'week',
    month: 'month',
    quarter: 'quarter',
    year: 'year'
};

/** Values accepted but not produced by the current build. Each needs a reason. */
var REPORT_DATE_RANGE_ALIASES = {
    // Written by builds before the contract existed. Accepted, logged, never generated.
    one: 'none'
};

/** Sampling interval inside a table item. */
var REPORT_INTERVAL = {
    min5: 'min5',
    min10: 'min10',
    min15: 'min15',
    min30: 'min30',
    hour: 'hour',
    day: 'day'
};

/** Aggregation applied to a tag column. */
var REPORT_FUNCTION = {
    min: 'min',
    max: 'max',
    average: 'average',
    sum: 'sum'
};

var REPORT_SCHEDULING = {
    none: 'none',
    day: 'day',
    week: 'week',
    month: 'month'
};

/** How a table column is filled: the timestamp column, or a tag. */
var REPORT_COLUMN_TYPE = {
    timestamp: 'timestamp',
    tag: 'tag'
};

var CONTRACTS = {
    ReportItemType: REPORT_ITEM_TYPE,
    ReportDateRangeType: REPORT_DATE_RANGE,
    ReportIntervalType: REPORT_INTERVAL,
    ReportFunctionType: REPORT_FUNCTION,
    ReportSchedulingType: REPORT_SCHEDULING,
    ReportTableColumnType: REPORT_COLUMN_TYPE
};

/** Every legal value of a contract, aliases included. */
function acceptedValues(name) {
    var base = Object.keys(CONTRACTS[name] || {});
    var aliases = name === 'ReportDateRangeType' ? Object.keys(REPORT_DATE_RANGE_ALIASES) : [];
    return base.concat(aliases);
}

/** Map a received value onto its canonical form, or null when it is not part of the contract. */
function canonicalValue(name, value) {
    if (value === undefined || value === null) { return null; }
    var text = String(value);
    if (name === 'ReportDateRangeType' && REPORT_DATE_RANGE_ALIASES[text]) {
        return REPORT_DATE_RANGE_ALIASES[text];
    }
    var table = CONTRACTS[name];
    if (!table) { return null; }
    return Object.prototype.hasOwnProperty.call(table, text) ? table[text] : null;
}

module.exports = {
    REPORT_ITEM_TYPE: REPORT_ITEM_TYPE,
    REPORT_DATE_RANGE: REPORT_DATE_RANGE,
    REPORT_DATE_RANGE_ALIASES: REPORT_DATE_RANGE_ALIASES,
    REPORT_INTERVAL: REPORT_INTERVAL,
    REPORT_FUNCTION: REPORT_FUNCTION,
    REPORT_SCHEDULING: REPORT_SCHEDULING,
    REPORT_COLUMN_TYPE: REPORT_COLUMN_TYPE,
    CONTRACTS: CONTRACTS,
    acceptedValues: acceptedValues,
    canonicalValue: canonicalValue
};
