/*
* Report: get data, create/send/store pdf
*/
const utils = require('../utils');
const Pdfmake = require('pdfmake');
var fs = require('fs')
var path = require('path');
var imageGenerator = require('./helper/image-generator');
var fontCoverage = require('./helper/font-coverage');
var period = require('../reporting/period');
var contract = require('../reporting/contract');
const { time } = require('console');

'use strict';

function Report(_property, _runtime) {
    var property = _property;
    var runtime = _runtime;
    var logger = runtime.logger;
    var currentTime = 0;
    var lastExecuted;

    this.execute = function (time, force) {
        currentTime = time;
        return new Promise(async function (resolve, reject) {
            try {
                if (!_isToExecute(time) && !force) {
                    resolve(true);
                } else {
                    await _createPdfBinary().then(filepath => {
                        if (property.receiver) {
                            let subject = `Report ${property.name}`;
                            let attachments = { path: filepath };
                            runtime.notificatorMgr.sendMailMessage(null, property.receiver, subject, '', null, attachments).then(function () {
                                logger.info(`report.sended.successful: ${new Date()} ${property.receiver} ${property.name}`);
                            }).catch(function (senderr) {
                                logger.error(`report.send.failed: ${senderr}`);
                            });
                        }
                        lastExecuted = currentTime;
                        resolve(filepath);
                    }).catch(function (err) {
                        reject(err);
                    });
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    this.getProperty = function () {
        return property;
    }

    this.getChartImage = function (itemChart, values) {
        return _getChartImage(itemChart, values);
    }

    var _getSampleValues = function (lines, timeRange) {
        let result = {};
        lines.forEach(line => {
            result[line.id] = [{x: timeRange.begin, y: Math.floor(Math.random() * 100)},
                {x: timeRange.end, y: Math.floor(Math.random() * 100)}];
        });
        return result;
    }

    var _isToExecute = function (date) {
        if (inTimeToExecute(date.getHours()) && utils.dayOfYear(lastExecuted) !== utils.dayOfYear(date)) {
            if (property.scheduling === ReportSchedulingType.day) {
                return true;
            } else if (property.scheduling === ReportSchedulingType.week && date.getDay() === 1) {      // monday
                return true;
            } else if (property.scheduling === ReportSchedulingType.month && date.getDate() === 1) {
                return true;
            }
        }
        return false;
    }

    var _createPdfBinary = function () {
        return new Promise(async function (resolve, reject) {
            // The font has to match the report's language. Roboto covers Latin and Cyrillic
            // but has no CJK glyphs, so a Chinese report needs a CJK-capable font or its text
            // is drawn as nothing - silently, with no error and no log line.
            const reportLanguage = (property && property.language) || 'zh-cn';
            const resolved = fontCoverage.resolveReportFont(reportLanguage, {
                cjkFontPath: runtime.settings && runtime.settings.reportFonts && runtime.settings.reportFonts.cjk
            });
            if (!resolved.covered) {
                logger.warn('report.font.missing.glyphs: language=' + reportLanguage
                    + ' font=' + resolved.source
                    + ' - text in this language will be missing from the PDF.'
                    + ' Configure settings.reportFonts.cjk with a CJK-capable TTF.');
            }
            const bundled = fontCoverage.LATIN_FAMILY;
            // The family keeps the name pdfmake already defaults to, so a document property
            // somewhere in a project that spells out font: 'Roboto' still resolves. Only the
            // files behind the name change with the language.
            var fonts = (resolved.script === 'cjk' && resolved.covered)
                // One face for every weight: SimHei and friends ship a single weight, and
                // pointing bold at Roboto would mix scripts inside one sentence.
                ? { Roboto: { normal: resolved.family, bold: resolved.family, italics: resolved.family, bolditalics: resolved.family } }
                : { Roboto: { normal: bundled.normal, bold: bundled.bold, italics: bundled.italics, bolditalics: bundled.bolditalics } };
            let pdfmake = new Pdfmake(fonts);
            await _getPdfContent(property).then(content => {
                let docPath = path.join(runtime.settings.reportsDir,`${property.name}_${utils.getDate(new Date())}.pdf`);
                // DECLARED, because this file IS 'use strict' - so an undeclared assignment THROWS
                // a ReferenceError instead of leaking to global. Measured, not assumed: that is the
                // difference between this file and the s7 driver, where the same mistake silently
                // created globals.
                var pdfDoc = pdfmake.createPdfKitDocument(content, {});
                const stream = fs.createWriteStream(docPath);
                pdfDoc.pipe(stream);
                pdfDoc.end();
                stream.on("finish", function() {
                    resolve(docPath);
                });
            }).catch(function (err) {
                reject(err);
            });
        });
    }

    var _getPdfContent = function (report) {
        return new Promise(async function (resolve, reject) {
            try {
                let docDefinition = {...report.docproperty };
                // Customer-facing document header. 'kcylp' is the UPSTREAM SCADIA author
                // (the package scope in package.json, kept for provenance), not this product:
                // attributing the report to it was simply wrong. Use the product name.
                docDefinition['header'] = { text: '开诚智枢 SCADIA', style:[{fontSize: 6}]};
                docDefinition['footer'] = function(currentPage, pageCount) {
                    return { text: currentPage.toString() + ' / ' + pageCount, style:[{alignment: 'right', fontSize: 8}]} ;
                },
                docDefinition['content'] = [];
                for (let i = 0; i < report.content.items.length; i++) {
                    let item = report.content.items[i];
                    if (item.type === contract.REPORT_ITEM_TYPE.text) {
                        docDefinition['content'].push({ text: item.text, style: [{ alignment: item.align, fontSize: item.size }] });
                    } else if (item.type === contract.REPORT_ITEM_TYPE.table) {
                        await _getTableContent(item).then(itemTable => {
                            const tableDateRange = _getDateRange(item.range);
                            docDefinition['content'].push({ text: `${tableDateRange.begin.toLocaleDateString()} - ${tableDateRange.end.toLocaleDateString()}`,
                                style: [{ fontSize: item.size }] });
                            docDefinition['content'].push(itemTable);
                        });
                    } else if (item.type === contract.REPORT_ITEM_TYPE.alarms) {
                        await _getAlarmsContent(item).then(itemAlarms => {
                            const alarmsDateRange = _getDateRange(item.range);
                            docDefinition['content'].push({ text: `${alarmsDateRange.begin.toLocaleDateString()} - ${alarmsDateRange.end.toLocaleDateString()}`,
                                style: [{ fontSize: item.size }] });
                            docDefinition['content'].push(itemAlarms);
                        });
                    } else if (item.type === contract.REPORT_ITEM_TYPE.chart) {
                        await _getChartContent(item).then(itemChart => {
                            docDefinition['content'].push(itemChart);
                        });
                    }
                }
                resolve(docDefinition);
            } catch (err) {
                reject(err);
            }
        });
    }

    var _getTableContent = function (item) {
        return new Promise(async function (resolve, reject) {
            try {
                let content = { layout: 'lightHorizontalLines', fontSize: item.size }; // optional
                let header = item.columns.map(col => {
                    return { text: col.label || col.tag.label || col.tag.name, bold: true, style: [{ alignment: col.align }] }
                });
                //item.columns.map(col => col.tag.address || '');
                let values = [];
                let tagsids = item.columns.filter(col => col.type !== 0).map(col => col.tag.id);
                let fncs = item.columns.filter(col => col.type !== 0).map(col => col.function);
                let formats = item.columns.filter(col => col.type !== 0).map(col => runtime.devices.getTagFormat(col.tag.id));
                let timeRange = _getDateRange(item.range);
                let options = { interval: item.interval, functions: fncs, formats: formats };
                await runtime.daqStorage.getNodesValues(tagsids, timeRange.begin.getTime(), timeRange.end.getTime(), options).then(result => {
                    if (!result || !result.length) {
                        values = [item.columns.map(col => { return {text: ''}})];
                    } else {
                        values = result;
                    }
                }).catch(function (err) {
                    values = [item.columns.map(col => { return {text: 'ERROR'}})];
                });
                content['table'] = {
                    // headers are automatically repeated if the table spans over multiple pages
                    // you can declare how many rows should be treated as headers
                    headerRows: 1,
                    widths: item.columns.map(col => col.width), //[ '*', 'auto', 100],
                    body: [
                        header,
                        ...values
                    ]
                }
                resolve(content);
            } catch (err) {
                reject(err);
            }
        });
    }

    var _getChartContent = function (itemChart) {
        return new Promise(async function (resolve, reject) {
            try {
                let values = {};
                let tagsids = itemChart.chart.lines.map(line => line.id);
                let timeRange = _getDateRange(itemChart.range);
                await runtime.daqStorage.getNodesValues(tagsids, timeRange.begin.getTime(), timeRange.end.getTime(), null).then(result => {
                    if (!result) {
                        values = {};
                    } else {
                        values = result;
                    }
                }).catch(function (err) {
                    values = {};
                });
                await _getChartImage(itemChart, values).then((imageData) => {
                    // Same defect class as pdfDoc above: undeclared in a strict file, so this threw on
                    // every chart render. NOTE that the identical-looking `content` in
                    // _getTableContent and _getAlarmsContent IS declared - which is exactly why the
                    // omission here was easy to miss and why no linter noise surrounded it.
                    var content = {
                        layout: 'lightHorizontalLines',
                        image: `data:image/png;base64,${imageData.toString('base64')}`,
                        // if you specify both width and height - image will be stretched
                        width: itemChart.width || 500,
                        height: itemChart.height || 350,
                        // height: 70
                    }
                    resolve(content);
                }).catch(function (err) {
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    var _getChartImage = function (itemChart, values) {
        return new Promise(async function (resolve, reject) {
            const timeRange = _getDateRange(itemChart.range);
            if (!values) {
                values = _getSampleValues(itemChart.chart.lines, timeRange);
            }
            try {
                // TODO wait compatibility with arm
                imageGenerator.createImage(itemChart, values).then((content) => {
                    resolve(content.toString('base64'));
                }).catch(function (err) {
                    reject(err);
                    logger.error("createImage: " + err);
                });
            }  catch {
                reject('TODO node create image from canvas is not supported!');
            }
        });
    }

    /**
     * Range of a report item, resolved on the production calendar.
     *
     * The old implementation used calendar midnight and a 23:59:59 end. Two consequences
     * were wrong for a plant: a daily report covered 00:00-24:00 instead of the hand-over to
     * hand-over day the operators actually work, and a week started on whatever day the
     * previous run happened to land on. Both are now derived from the same period engine the
     * rest of the reporting stack uses, with the production day boundary configured per site
     * (default 08:00) and the three shift table understood.
     *
     * Scheduled reports always describe a FINISHED period, so the previous one is taken.
     */
    var _rangeOptions = function () {
        var reporting = (runtime.project && runtime.project.getReportingSettings && runtime.project.getReportingSettings()) || {};
        return {
            productionDayStart: reporting.productionDayStart,
            shifts: reporting.shifts,
            now: new Date(currentTime || Date.now())
        };
    }

    var _getDateRange = function (dateRange) {
        var options = _rangeOptions();
        var reference = new Date(currentTime || Date.now());
        var kind = contract.canonicalValue('ReportDateRangeType', dateRange);

        if (kind === contract.REPORT_DATE_RANGE.none) {
            // 'none' means "as of now": the report describes the current instant, not a period.
            return { begin: reference, end: reference };
        }

        if (!kind) {
            // Anything outside the contract must not fall through to "as of now". It used to,
            // which turned a client/server mismatch into a well formed report of the wrong
            // period, delivered silently.
            logger.error('report.range.unknown: ' + JSON.stringify(dateRange)
                + ' is not part of the report contract; refusing to guess a period.');
            throw new Error('unknown report date range: ' + JSON.stringify(dateRange));
        }

        var resolved = period.resolvePreviousPeriod(kind, reference, options);
        return {
            begin: resolved.from,
            // The consumers below treat the end as inclusive, so step back a millisecond
            // instead of leaking the next period's first instant into this one.
            end: new Date(resolved.to.getTime() - 1)
        };
    }

    var _getAlarmsContent = function (item) {
        return new Promise(async function (resolve, reject) {
            try {
                let content = { layout: 'lightHorizontalLines', fontSize: item.size }; // optional
                let header = Object.values(item.propertyText).map(col => {
                    return { text: col, bold: true, style: [{ alignment: 'left' }] }
                });
                let values = [];
                const timeRange = _getDateRange(item.range);
                const query = { start: timeRange.begin.getTime(), end: timeRange.end.getTime() };
                await runtime.alarmsMgr.getAlarmsHistory(query, -1).then(result => {
                    if (!result || !result.length) {
                        values = [Object.values(item.propertyText).map(col => {
                            return { text: '', style: [{ alignment: 'left' }] }
                        })];
                     } else {
                        const property = Object.keys(item.property).filter(prop => { if (item.property[prop]) return prop; });
                        values = result.filter(alr => {
                            if (item.priority[alr.type] && (!item.alarmFilter || !!item.alarmFilter.find(name => name === alr.name))) {
                                return alr;
                            }
                        });
                        values = values.map(alr => {
                            let row = [];
                            property.forEach((prop) => {
                                var text = '';
                                if (prop === 'ontime' && alr.ontime) text = utils.getFormatDate(new Date(Number(alr.ontime)), 'ymd');
                                else if (prop === 'offtime' && alr.offtime) text = utils.getFormatDate(new Date(Number(alr.offtime)), 'ymd');
                                else if (prop === 'acktime' && alr.acktime) text = utils.getFormatDate(new Date(Number(alr.acktime)), 'ymd');
                                else if (prop === 'text') text = alr.text;
                                else if (prop === 'group') text = alr.group;
                                else if (prop === 'userack') text = alr.userack;
                                else if (prop === 'status') text = item.statusText[alr.status];
                                else if (prop === 'type') text = item.priorityText[alr.type];
                                row.push({text: text, style: [{fillColor: alr.bkcolor, color: alr.color}]});
                            });
                            return row;
                        })
                     }
                }).catch(function (err) {
                    console.error(err);
                    values = [Object.values(item.propertyText).map(col => { return {text: 'ERROR'}})];
                });
                content['table'] = {
                    // headers are automatically repeated if the table spans over multiple pages
                    // you can declare how many rows should be treated as headers
                    headerRows: 1,
                    widths: Object.values(item.propertyText).map(col => '*'), //[ '*', 'auto', 100],
                    body: [
                        header,
                        ...values
                    ]
                }
                resolve(content);
            } catch (err) {
                reject(err);
            }
        });
    }
}

function inTimeToExecute(hour) {
    return (hour >= 2 && hour <= 3);
}

const ReportSchedulingType = {
    none: 'none',
    day: 'day',
    week: 'week',
    month: 'month',
}

const ReportDateRangeType = {
    none: 'none',
    day: 'day',
    week: 'week',
    month: 'month',
    quarter: 'quarter',
    year: 'year',
    shift: 'shift',
}

module.exports = {
    create: function (property, runtime) {
        return new Report(property, runtime);
    },
    ReportSchedulingType: ReportSchedulingType
}
