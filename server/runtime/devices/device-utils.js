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

/**
 * Publish a batch of tag values for one device - the ONE way a driver announces a read.
 *
 * WHY THIS IS SHARED
 * Fifteen drivers each hand-wrote the same six lines, and thirteen of them also hand-wrote the
 * superseded-binding guard. Three did not: modbus, gpio and webcam published unconditionally, so
 * for those three a read that came back after a rebind was stored against the new binding
 * (contract 09 section 4.3). The defect is the copy-paste: a guard that has to be re-pasted into
 * every new driver is a guard that will be missing from the next one.
 *
 * Removing the copy is therefore not tidying - it is the fix. The guard is now applied by the
 * function that emits, so a driver cannot forget it, and the per-driver callbacks that differed
 * (a timestamp, a status flag) stay where they belong.
 *
 * @param {object}   data      driver device data (a clone carrying data.bindingRevision)
 * @param {object}   runtime   driver runtime
 * @param {object}   cache     the driver's own { revision: null } binding cache
 * @param {*}        values    the tag values to publish
 * @param {object}   [options] { after: fn() called just before publishing,
 *                               onDrop: fn() called instead of publishing,
 *                               logger, source: driver name for the drop message,
 *                               id: overrides the device id in the payload }
 * @returns {boolean} true when the values were published
 */
function emitValues(data, runtime, cache, values, options) {
    const opts = options || {};
    if (!shouldEmitForBinding(data, runtime, cache)) {
        // Say it once per drop, at warn level: silence here is how the three missing guards stayed
        // invisible, and this is a real event (a device was rebound mid-read).
        if (opts.onDrop) { opts.onDrop(); }
        if (opts.logger && typeof opts.logger.warn === 'function') {
            opts.logger.warn((opts.source || 'device') + ': dropped a value read from a superseded binding');
        }
        return false;
    }
    if (opts.after) { opts.after(); }
    // Five drivers identified their device by data.name rather than data.id. That difference is
    // preserved here on purpose: changing it would change which device the value is attributed to,
    // and that is a behaviour change nobody asked for. (Whether those five SHOULD be keyed by id is
    // a separate question, recorded in 20_代码进度.md as N-6.)
    // THE BUS, NOT THE MODULE. This used to be `require('../events').emit(...)`, and runtime/events.js
    // exports { create, IoEventTypes } - a factory, with no emit(). Every call therefore threw
    // "TypeError: require(...).emit is not a function", which the drivers' poll loops catch and log:
    // with any ENABLED device the values were read from the device and then thrown away. Nothing
    // caught it because the project this build was demoed against has no enabled device, and the
    // gate's driver tests exercise the binding guard above rather than this line.
    //
    // The bus is the emitter the runtime subscribes on (runtime/index.js: `var events = Events.create()`,
    // `events.on('device-value:changed', updateDeviceValues)`, exposed as runtime.events). It is already
    // a parameter of this function, so no call site had to change.
    emitOnRuntimeBus(runtime, 'device-value:changed', { id: opts.id || data.id, values: values }, 'emitValues');
    return true;
}

/**
 * Publish a device connection status - the same dedupe for the status half of the driver contract.
 *
 * Every driver keeps its own `lastStatus` variable because some of them also read it back; the
 * shared part is the event, and the assignment that must happen before it.
 *
 * @param {*} data
 * @param {string} status
 * @param {object} [options] { onEmit: fn(status) }
 * @returns {*} the status that was published
 */
function emitStatus(data, status, options, runtime) {
    const opts = options || {};
    if (opts.onEmit) { opts.onEmit(status); }
    // Same defect as emitValues above, same fix; the runtime is the fourth parameter because this
    // function never had one. Every call site is a driver that already holds the runtime.
    emitOnRuntimeBus(runtime, 'device-status:changed', { id: data.id, status: status }, 'emitStatus');
    return status;
}

/**
 * Publish on the runtime's event bus, or say clearly that there is no bus.
 *
 * WHY IT THROWS INSTEAD OF RETURNING. A device event that silently goes nowhere is exactly the
 * failure this project keeps paying for: the value path ran, the operator's screen stayed still, and
 * the only trace was a caught-and-logged TypeError. A missing bus is a wiring defect, so it is raised
 * where the wiring is wrong.
 *
 * @param {object} runtime  the runtime handed to the driver (runtime.events is the emitter the
 *                          frontend fan-out subscribes on)
 * @param {string} name     event name
 * @param {object} payload  event payload
 * @param {string} from     caller name, for the error message
 */
function emitOnRuntimeBus(runtime, name, payload, from) {
    const bus = runtime && runtime.events;
    if (!bus || typeof bus.emit !== 'function') {
        throw new Error(from + ': no runtime event bus (runtime.events.emit) to publish ' + name +
            ' - the driver was created without the runtime');
    }
    bus.emit(name, payload);
}

/**
 * Install the two driver methods whose bodies were copy-pasted verbatim across thirteen drivers.
 *
 * WHY THESE TWO, AND ONLY THESE TWO
 *
 * An audit counted the "driver interface" as duplicated in eighteen files. Measuring the bodies
 * rather than the names showed three different situations, and only one of them should be shared:
 *
 *   getValue          13 drivers had the SAME body, character for character apart from spaces.
 *                     Five more (adsclient, redis, melsec, odbc, template) are genuinely different -
 *                     a different timestamp source, a delayed read, or a deliberate
 *                     "not supported" - and are left alone.
 *   bindAddDaq        15 drivers had the same body. Every one of them is this two-line callback set.
 *   getTagDaqSettings  only 9 agreed, and the other six differ in how they find the tag. NOT shared.
 *
 * So this is not "the driver interface moved to the base class". It is two methods that were
 * literally the same code, installed from one place. Sharing by name would have quietly changed
 * the behaviour of the five drivers that differ.
 *
 * @param {object} self              the driver instance to decorate
 * @param {object} options
 * @param {function} options.getVarsValue returns the driver's CURRENT value map - see the note below
 * @param {object} [options.varsValue] the driver's value map captured at install time (legacy form)
 * @param {function} options.getLastTimestamp returns the driver's last-read timestamp
 */
function installCommonDriverApi(self, options) {
    // WHY A GETTER, AND NOT THE OBJECT ITSELF
    //
    // Every driver declares its value map once at the top of its module ("var varsValue = [];") and
    // then REASSIGNS it inside load() ("varsValue = [];" / "varsValue = {};"). Reading
    // options.varsValue here captures the object that existed at construction time - the empty stub
    // from before the first load - and no later reassignment becomes visible, because a closure
    // holds the OBJECT, not the variable. The installed getValue() would then answer null for every
    // tag, silently, for the life of the device: device.js delegates its own getValue() to
    // comm.getValue(), and runtime/devices/index.js getTagValue() / getDeviceAlarmValue() go through
    // that, so alarms, scripts ($getTag), calibration and camera fusion all go blind on this driver.
    // Measured on scadiaserver: GET /api/getTagValue returned value:null for all six internal tags
    // while the driver's own getValues() had them loaded correctly.
    //
    // Calling a getter defers the lookup to call time, so getValue() always reads the map the driver
    // is using right now, whatever load() last assigned. The legacy "varsValue" form is still
    // accepted so unconverted callers keep working, but it keeps the defect.
    const getVarsValue = (typeof options.getVarsValue === 'function')
        ? options.getVarsValue
        : function () { return options.varsValue; };
    const getLastTimestamp = options.getLastTimestamp;

    /**
     * The last value this driver holds for a tag, with the timestamp of the read that produced it.
     * @param {string} id
     * @returns {{id: string, value: *, ts: *}|null}
     */
    self.getValue = function (id) {
        const varsValue = getVarsValue() || {};
        if (varsValue[id]) {
            return { id: id, value: varsValue[id].value, ts: getLastTimestamp() };
        }
        return null;
    };

    /**
     * The DAQ store function the manager hands to the driver. Kept on the instance because the
     * driver calls it from inside its polling loop.
     */
    self.bindAddDaq = function (fnc) {
        self.addDaq = fnc;                         // Add the DAQ value to db history
    };
    self.addDaq = null;                            // Add the DAQ value to db history
}

module.exports = {

    shouldEmitForBinding: shouldEmitForBinding,

    installCommonDriverApi: installCommonDriverApi,

    emitValues: emitValues,

    emitStatus: emitStatus,

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


    /**
     * Kept as a named export because drivers call it as `deviceUtils.parseValue`; the body
     * is the shared one. This file used to carry its own copy, and the copies had already
     * drifted in the one branch that decides what is written to a device (batch 60).
     */
    parseValue: function (value, type) {
        return utils.parseValue(value, type);
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
