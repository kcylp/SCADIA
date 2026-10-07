/**
 * 'api/reporting': period resolution for the report editor.
 *
 * The client must not work out report periods itself. It used to, with a copy of the old
 * calendar-midnight logic, so the preview in the editor and the PDF the generator produced
 * could disagree - and both were wrong in the same way, covering 00:00-24:00 instead of the
 * hand-over to hand-over production day.
 *
 * The server owns the calendar. This endpoint exists so the editor can show the operator what
 * a selection actually means ("2026-03-10 08:00 -> 2026-03-11 08:00, production day, complete")
 * without reimplementing it.
 */

'use strict';

var express = require('express');
var period = require('../../runtime/reporting/period');
var contract = require('../../runtime/reporting/contract');
const { projectGuard } = require('../_domain');

var runtime;
var secureFnc;

/**
 * The status every error code of this domain answers with. Mirrors the shape the rest of the
 * tree uses ({ error: CODE, message }); the extra fields this endpoint carries (kind, accepted,
 * reference) are data the caller needs and are merged in by sendReportingError below.
 */
const ERR_HTTP = {
    REPORT_UNKNOWN_PERIOD: 400,
    REPORT_INVALID_REFERENCE: 400,
    REPORT_PERIOD_FAILED: 400
};

/** One error frame for the domain: a code, a message a human can read, and the query data. */
function sendReportingError(res, code, message, extra) {
    if (res.headersSent) { return; }
    res.status(ERR_HTTP[code] || 500).json(Object.assign({ error: code, message: message }, extra || {}));
}

/** Build the options the period engine reads from a request plus the project settings. */
function periodOptions(query) {
    var reporting = (runtime.project && runtime.project.getReportingSettings && runtime.project.getReportingSettings()) || {};
    var options = {
        productionDayStart: reporting.productionDayStart,
        shifts: reporting.shifts
    };
    if (query.shiftIndex !== undefined && query.shiftIndex !== '') { options.shiftIndex = Number(query.shiftIndex); }
    if (query.rollingHours !== undefined && query.rollingHours !== '') { options.rollingHours = Number(query.rollingHours); }
    if (query.from) { options.from = query.from; }
    if (query.to) { options.to = query.to; }
    return options;
}

module.exports = {
    init: function (_runtime, _secureFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
    },
    app: function () {
        var reportingApp = express();

        reportingApp.use(projectGuard(() => runtime));

        /**
         * GET /api/report-period?kind=day&reference=2026-03-10T03:00:00Z
         *
         * Returns the resolved boundaries of a report period. 'previous=1' asks for the period
         * that has just finished, which is what a scheduled report always describes.
         */
        reportingApp.get('/api/report-period', secureFnc, function (req, res) {
            try {
                var query = req.query || {};
                var kind = contract.canonicalValue('ReportDateRangeType', query.kind);
                if (!kind) {
                    // Same rule as the generator: an unknown period is an error, not an
                    // invitation to report the current instant instead.
                    return sendReportingError(res, 'REPORT_UNKNOWN_PERIOD',
                        'unknown period kind', {
                            kind: query.kind,
                            accepted: contract.acceptedValues('ReportDateRangeType')
                        });
                }

                var reference = query.reference ? new Date(query.reference) : new Date();
                if (isNaN(reference.getTime())) {
                    return sendReportingError(res, 'REPORT_INVALID_REFERENCE',
                        'invalid reference instant', { reference: query.reference });
                }

                var options = periodOptions(query);
                var resolved;
                if (kind === contract.REPORT_DATE_RANGE.none) {
                    resolved = { kind: kind, from: reference, to: reference, complete: false, shiftId: null, shiftName: null };
                } else if (String(query.previous) === '1') {
                    resolved = period.resolvePreviousPeriod(kind, reference, options);
                } else {
                    resolved = period.resolvePeriod(kind, reference, options);
                }

                var table = period.resolveShiftTable(options);
                res.json({
                    kind: resolved.kind,
                    from: resolved.from.toISOString(),
                    to: resolved.to.toISOString(),
                    complete: resolved.complete,
                    shiftId: resolved.shiftId || null,
                    shiftName: resolved.shiftName || null,
                    productionDayStart: period.formatClock(table.productionDayStart),
                    shifts: table.shifts.map(function (shift) {
                        return { id: shift.id, name: shift.name, startOffset: shift.startOffset, lengthMinutes: shift.lengthMinutes };
                    })
                });
            } catch (err) {
                sendReportingError(res, 'REPORT_PERIOD_FAILED', err.message);
            }
        });

        return reportingApp;
    }
};
