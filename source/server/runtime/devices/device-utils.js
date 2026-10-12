'use strict';
const utils = require('../utils');
const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
dayjs.extend(duration);

/**
 * Value produced by the most recent `tagValueCompose` call, before the deadband
 * hold was applied. Module-scope on purpose: `tagValueCompose` keeps its
 * (value, oldValue, tag, runtime) signature so no driver has to change, and the
 * value is read back synchronously right after the awaited call, so concurrent
 * drivers cannot interleave between the write and the read.
 */
var rawComposed = null;

/**
 * Should this driver emit the values it just read?
 *
 * A device is rebound IN PLACE (updateDevice -> stop -> loadDevice on the same object),
 * which rebuilds the driver tag maps. A read that was already awaiting its transport can
 * still answer after that, and storing it would mix a superseded binding into the current
 * one (contract 09 section 4.3; mechanism in devices/binding-guard).
 *
 * Called from a driver's _emitValues with a per-driver cache, so the snapshot is taken
 * ONCE per loaded binding and retaken after the next rebind. Without that reset a driver
 * would stay permanently muted once its device had been rebound.
 *
 * `param {object} data     driver device data (a clone carrying data.bindingRevision)
 * `param {object} runtime  driver runtime
 * `param {object} cache    mutable object owned by the driver, e.g. { revision: null }
 * `returns {boolean} true when the values belong to the current binding
 */
function shouldEmitForBinding(data, runtime, cache) {
    const guard = require('./binding-guard');
    const live = guard.bindingRevisionOf(data, runtime);
    if (cache && cache.revision === null) { cache.revision = live; }
    return !guard.bindingChangedSince(data, cache ? cache.revision : live, runtime);
}

module.exports = {

    shouldEmitForBinding: shouldEmitForBinding,

    /**
     * Re-arm a driver's binding snapshot. Call from load() so the very first emit of a new
     * binding is evaluated against that binding rather than the previous one.
     */
    resetBindingCache: function (cache) {
        if (cache) { cache.revision = null; }
    },

    tagDaqToSave: function (tag, timestamp) {
        if (tag.daq && (tag.daq.enabled || tag.daq.restored)) {
            tag.timestamp = timestamp;
            if (tag.changed && (tag.daq.changed || tag.daq.restored)) {
                return true;
            } else if (!tag.daq.lastDaqSaved || (tag.daq.interval && timestamp - parseInt(tag.daq.interval) * 1000 > tag.daq.lastDaqSaved)) {
                tag.daq.lastDaqSaved = timestamp;
                return true;
            }
        }
        return false;
    },

    tagValueCompose: async function (value, oldValue, tag, runtime = undefined) {
        var obj = {value: null };
        if (tag) {
            try {
                if (tag.scaleReadFunction) {
                    value = await callScaleScript(tag.scaleReadFunction, tag.scaleReadParams ? tag.scaleReadParams : undefined, runtime, true, value);
                }
                const type = tag?.type;
                if (!(type === 'String' || type === 'ByteString' || type === 'string') && utils.isNumber(value, obj)) {
                    value = obj.value;
                    // **Keep the value the tag actually measured, before the deadband hold.**
                    //
                    // The deadband below substitutes `oldValue` for the fresh reading, which is a
                    // *publication* decision (do not churn the bus / do not archive noise). It must
                    // never become the value an alarm is evaluated against: with last=99, deadband=10
                    // and an alarm threshold of 100, a new reading of 101 satisfies |101-99| <= 10 and
                    // would be replaced by 99, silently suppressing the alarm.
                    //
                    // `rawComposed` carries the deadband-free value so alarm evaluation can use it.
                    // See 09_契约02 门禁 G-TAG-7 and the regression test in
                    // test/devices/deadbandAlarm.test.js.
                    rawComposed = value;
                    if (tag.deadband && tag.deadband.value && !utils.isNullOrUndefined(oldValue)) {
                        if (Math.abs(value - oldValue) <= tag.deadband.value) {
                            value = oldValue;
                        }
                    }
                    if (tag.scale) {
                        if (tag.scale.mode === 'linear') {
                            value = (tag.scale.scaledHigh - tag.scale.scaledLow) * (value - tag.scale.rawLow) / (tag.scale.rawHigh - tag.scale.rawLow) + tag.scale.scaledLow;
                        } else if (tag.scale.mode === 'convertDateTime' && tag.scale.dateTimeFormat) {
                            value = dayjs(value).format(tag.scale.dateTimeFormat);
                        } else if (tag.scale.mode === 'convertTickTime' && tag.scale.dateTimeFormat) {
                            value = durationToTimeFormat(dayjs.duration(value), tag.scale.dateTimeFormat);
                        } else if (tag.scale.mode === 'expression' && tag.scale.readExpression) {
                            value = evaluateExpression(tag.scale.readExpression, value);
                        }
                    }
                    if (tag.format) {
                        value = +value.toFixed(tag.format);
                    }
                }
            } catch (err) {
                console.error(err);
            }
            // Hand the deadband-free value to the caller's container so it travels with the
            // tag through drivers and into the alarm path (devices.getDeviceAlarmValue).
            tag.rawComposed = rawComposed;
        }
        return value;
    },

    tagRawCalculator: async function (value, tag, runtime = undefined) {
        var obj = {value: null };

        if (tag) {
            try {
                if (utils.isNumber(value, obj)) {
                    value = obj.value;
                    if (tag.scale && tag.scale.mode === 'linear') {
                        value = tag.scale.rawLow + ((tag.scale.rawHigh - tag.scale.rawLow) * (value - tag.scale.scaledLow)) / (tag.scale.scaledHigh - tag.scale.scaledLow);
                    } else if (tag.scale && tag.scale.mode === 'expression' && tag.scale.writeExpression) {
                        value = evaluateExpression(tag.scale.writeExpression, value);
                    }
                }
                if (tag.scaleWriteFunction) {
                    value = await callScaleScript(tag.scaleWriteFunction, tag.scaleWriteParams ? tag.scaleWriteParams : undefined, runtime, false, value);
                }
            } catch (err) {
                console.error(err);
            }
        }
        return value;
    },


    parseValue: function (value, type) {
        if (type === 'number') {
            return parseFloat(value);
        } else if (type === 'boolean') {
            if (value === null || value === undefined || value === '') {
                return false;
            }
            if (typeof value === 'string') {
                const lowerValue = value.toLowerCase().trim();
                return lowerValue === 'true' || lowerValue === '1';
            }
            return Boolean(value);
        } else if (type === 'string') {
            return value;
        } else {
            let val = parseFloat(value);
            if (Number.isNaN(val)) {
                // maybe boolean
                val = Number(value);

                if (Number.isNaN(val)) {
                    val = value;
                }
            } else {
                val = parseFloat(val.toFixed(5));
            }
            return val;
        }
    }
}

const durationToTimeFormat = (duration, format) => {
  const pattern = /^([H]+)?([:|-])?([m]+)?([:|-])?([s]+)?$/;
  const match = format.match(pattern);

  if (!match) {
    return null; // Format not valid
  }

  const [, hoursPart, separator1, minutePart, separator2, secondPart] = match;

  const nbDays = duration.get('days');
  const nbHours = duration.get('hours');
  const nbMinutes = duration.get('minute');
  const nbSeconds = duration.get('seconds');

  var count = nbDays * 24 + nbHours;
  var result = '';
  if (hoursPart) {
    result += `${count.toString().padStart(hoursPart.length, '0')}${separator1 ?? ''}`;
    count = nbMinutes;
  } else {
    count = count * 60 + nbMinutes;
  }
  if (minutePart) {
    result += `${count.toString().padStart(minutePart.length, '0')}${separator2 ?? ''}`;
    count = nbSeconds;
  } else {
    count = count * 60 + nbSeconds;
  }
  if (secondPart) {
    result += `${count.toString().padStart(secondPart.length, '0')}`;
  }
  return result;
}

const callScaleScript = async (scriptId, params, runtime, isRead, value) => {
    if (scriptId && runtime !== undefined) {
        let parameters = [
            { name: 'value', type: 'value', value: value }
        ];
        let tagParams = [];
        if (params) {
            try {
                tagParams = JSON.parse(params);
            } catch (error) {
                runtime.logger.error(`'${params}' error decoding ${isRead ? 'read' : 'write' } scale script params ${error.toString()}`);
            }
            parameters = [...parameters, ...tagParams];
        }
        const script = {
            id: scriptId,
            name: null,
            parameters: parameters,
            notLog: true
        };
        try {
            value = await runtime.scriptsMgr.runScript(script, false);
        } catch (error) {
            runtime.logger.error(`'${params}' ${isRead ? 'read' : 'write'} script error! ${error.toString()}`);
        }
        return value;
    }
    return value;
}

const evaluateExpression = (expression, value) => {
    try {
        // Create a function with 'this' bound to the value
        const func = new Function('return ' + expression);
        return func.call(value);
    } catch (error) {
        console.error(`Expression evaluation error: ${error.toString()}`);
        return null; // Return null to indicate failure, preventing wrong values
    }
}
