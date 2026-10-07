/**
 * SCADIA Scheduler Service
 *
 * Event-driven scheduler with master control enforcement.
 * Uses node-schedule for cron-style job scheduling.
 */

'use strict';

const schedule = require('node-schedule');
var Events = require('../events');
const utils = require('../utils');

var logger;
var runtime;

// Track active node-schedule jobs by event ID
var activeJobs = new Map();

// Track scheduler writes to prevent loops
var schedulerWriting = new Set();

// Track active Event Mode schedules (key: tagId, value: { endTime, schedulerId, deviceName, eventIndex })
var activeEventModeSchedules = new Map();

/**
 * Initialize
 */
function init(settings, _logger, _runtime) {
    runtime = _runtime;
    logger = _logger || console;

    // Listen for tag changes to enforce master control
    runtime.events.on('tag-value:changed', onTagChanged);

    // Listen for EVERY client connection to send current event states
    runtime.io.on('connection', (socket) => {
        setAllInitialStates();
    });

    // Load existing schedulers and create jobs
    loadSchedulers();

    return Promise.resolve({
        updateScheduler,
        stopScheduler
    });
}

/**
 * Load all schedulers from DB and create node-schedule jobs
 */
async function loadSchedulers() {
    try {
        const schedulers = await runtime.schedulerStorage.getAllSchedulers();

        // Get project data to access deviceActions from property
        let projectData = null;
        try {
            projectData = await runtime.project.getProject(null, null);
        } catch (err) {
            logger.error('Failed to load project data:', err.message);
        }

        for (const scheduler of schedulers) {
            if (scheduler.id && scheduler.data) {
                await syncDeviceActionsFromProject(scheduler, projectData);
                await createSchedulerJobs(scheduler.id, scheduler.data);
            }
        }

    } catch (error) {
        logger.error(`Error loading schedulers: ${error.message}`);
    }
}

/**
 * Recover a scheduler's device actions from the project if the stored data lost them.
 *
 * WHY THIS EXISTS: the scheduler gauge keeps its device actions in the view item's `property`, and
 * `scheduler.data.settings.deviceActions` is a copy written when the gauge is edited. A project that
 * was saved by an older build - or edited outside the gauge - can have the actions in the view and
 * nothing in the scheduler record, and then no action ever fires. This pass copies them back and
 * saves.
 *
 * Extracted from loadSchedulers so it can be tested: it is a data recovery path that only runs at
 * startup, which is exactly the kind of code that breaks without anyone noticing.
 *
 * @returns {Promise<boolean>} whether actions were recovered and saved
 */
async function syncDeviceActionsFromProject(scheduler, projectData) {
    if (!scheduler || !scheduler.id || !scheduler.data) {
        return false;
    }
    // Already present: the stored copy wins, and nothing is written.
    if (scheduler.data.settings?.deviceActions) {
        return false;
    }
    if (!projectData?.hmi?.views) {
        return false;
    }

    for (const view of projectData.hmi.views) {
        if (!view || !view.items) {
            continue;
        }
        for (const itemId in view.items) {
            const item = view.items[itemId];
            if (item && item.id === scheduler.id && item.property?.deviceActions) {
                if (!scheduler.data.settings) {
                    scheduler.data.settings = {};
                }
                scheduler.data.settings.deviceActions = item.property.deviceActions;
                await runtime.schedulerStorage.setSchedulerData(scheduler.id, scheduler.data);
                return true;
            }
        }
    }

    return false;
}

/**
 * Set initial states for ALL schedulers (called after runtime ready)
 */
async function setAllInitialStates() {
    try {
        const schedulers = await runtime.schedulerStorage.getAllSchedulers();

        for (const scheduler of schedulers) {
            if (scheduler.id && scheduler.data) {
                await setInitialStates(scheduler.id, scheduler.data);
                await notifyEventStates(scheduler.id, scheduler.data);
            }
        }

    } catch (error) {
        logger.error(`Error setting initial states: ${error.message}`);
    }
}

/**
 * Notify clients of all event states for a scheduler
 */
async function notifyEventStates(schedulerId, schedulerData) {
    const summary = { broadcast: 0, skippedNoDays: 0 };

    try {
        if (!schedulerData.settings?.devices) {
            return summary;
        }

        for (const device of schedulerData.settings.devices) {
            const schedules = schedulerData.schedules?.[device.name] || [];

            schedules.forEach((event, eventIndex) => {
                // eventDayNumbers tolerates a missing days array; the inline `.map` did not, and a
                // throw here silenced every remaining event of this scheduler.
                const dayNumbers = eventDayNumbers(event);

                // An event with no day selected can never be active, so there is no state to
                // broadcast - and asking the day check anyway made it log an error per event, which
                // is noise that hides real failures. Counted so it is visible rather than dropped.
                if (dayNumbers.length === 0) {
                    summary.skippedNoDays++;
                    return;
                }

                checkAndNotifyEventState(schedulerId, device, buildEventPayload(device.name, event), eventIndex, dayNumbers);
                summary.broadcast++;
            });
        }

        return summary;
    } catch (error) {
        logger.error(`Error notifying event states: ${error.message}`);
        summary.error = error.message;
        return summary;
    }
}

/**
 * Set initial tag states based on current scheduler state
 */
async function setInitialStates(schedulerId, schedulerData) {
    const summary = { devices: [], failed: 0 };

    try {
        if (!schedulerData.settings?.devices) {
            return summary;
        }

        for (const device of schedulerData.settings.devices) {
            const schedules = schedulerData.schedules?.[device.name] || [];
            const isTimerModeActive = checkIfAnyEventActive(schedules);
            const isEventModeActive = checkIfAnyEventModeActive(device.name, schedulerId);

            // THE LATCH, stated once: the tag is 1 when the device is under this scheduler's control
            // RIGHT NOW (a clock-driven event is inside its window, or an event-mode event is armed),
            // and 0 when it is not. Everything else in this file reads or writes this same tag, so
            // this is where the value the whole feature rests on is decided.
            const expectedValue = (isTimerModeActive || isEventModeActive) ? 1 : 0;

            const applied = await writeTagFromEvent(device.variableId, expectedValue, `Initial state for ${device.name}`);
            summary.devices.push({
                deviceName: device.name,
                variableId: device.variableId,
                expectedValue: expectedValue,
                applied: applied
            });
            if (!applied) {
                summary.failed++;
                // A latch that could not be set is a real operational state, not a detail: the device
                // is left in whatever state it was, and the scheduler believes it is enforced.
                logger.warn('Scheduler initial state not applied - scheduler ' + schedulerId + ', device ' +
                    device.name + ', tag ' + device.variableId);
            }
        }
    } catch (error) {
        logger.error(`Error setting initial states: ${error.message}`);
        summary.failed++;
        summary.error = error.message;
    }

    return summary;
}

/**
 * Create node-schedule jobs for all events in a scheduler
 */
async function createSchedulerJobs(schedulerId, schedulerData) {
    const summary = { subscribed: [], eventsAttempted: 0 };

    try {
        if (!schedulerData.settings?.devices) {
            return summary;
        }

        for (const device of schedulerData.settings.devices) {
            const schedules = schedulerData.schedules?.[device.name] || [];

            if (device.variableId) {
                // Subscribing is what makes the runtime announce this tag at all. Without it master
                // control never sees an external change, so the subscription is as load-bearing as
                // the job itself.
                runtime.events.emit('tag-change:subscription', device.variableId);
                summary.subscribed.push(device.variableId);
            }

            for (let i = 0; i < schedules.length; i++) {
                await createEventJob(schedulerId, device, schedules[i], i);
                summary.eventsAttempted++;
            }
        }

        return summary;
    } catch (error) {
        logger.error(`Error creating scheduler jobs: ${error.message}`);
        summary.error = error.message;
        return summary;
    }
}

/**
 * Create a single event job for a device
 */
async function createEventJob(schedulerId, device, event, eventIndex) {
    try {
        const isEventMode = event.eventMode === true && event.duration !== undefined;

        const eventData = {
            label: buildEventLabel(device.name, event),
            startTime: event.startTime,
            endTime: event.endTime,
            days: event.days,
            months: event.months,
            daysOfMonth: event.daysOfMonth,
            monthMode: event.monthMode,
            recurring: event.recurring !== false,
            eventMode: event.eventMode || false,
            duration: event.duration,
            id: event.id
        };

        // Indices shift when events are added/deleted, but IDs are stable
        const jobId = `${schedulerId}_${device.name}_${event.id}`;

        if (activeJobs.has(jobId)) {
            activeJobs.get(jobId).cancel();
            activeJobs.delete(jobId);
        }

        // Everything the recurrence rule needs, or null when the event cannot be scheduled.
        // Extracted (see buildEventScheduleSpec) so this validation and the index mapping can be
        // tested without standing up node-schedule.
        const spec = buildEventScheduleSpec(event, isEventMode);
        if (!spec) {
            return;
        }

        const startRule = new schedule.RecurrenceRule();
        if (spec.isMonthMode) {
            startRule.month = spec.monthNumbers;
            startRule.date = spec.dayOfMonthNumbers;
        } else {
            startRule.dayOfWeek = spec.dayNumbers;
        }
        startRule.hour = spec.startHour;
        startRule.minute = spec.startMin;

        let startJob = null;
        let endJob = null;

        try {
            startJob = schedule.scheduleJob(startRule, async () => {
                await writeTagFromEvent(device.variableId, 1, `Event "${eventData.label}" started`).catch(err => {
                    logger.error(`Error in START callback: ${err.message}`);
                });

                // Execute server-side device actions (Set Value, Run Script, etc.)
                const schedulers = await runtime.schedulerStorage.getAllSchedulers();
                const scheduler = schedulers.find(s => s.id === schedulerId);

                if (scheduler?.data?.settings) {
                    await executeDeviceActions(schedulerId, device.name, 'on', scheduler.data.settings);
                }

                if (runtime.io) {
                    runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                        schedulerId: schedulerId,
                        deviceName: device.name,
                        eventIndex: eventIndex,
                        eventId: event.id,
                        eventData: eventData,
                        active: true
                    });
                }

                if (isEventMode) {
                    // THE CHECK COMES FIRST, and that order is the whole point.
                    //
                    // It used to come AFTER writeTagFromEvent(device.variableId, 1) and after the
                    // active:true frame. An event-mode event with no id cannot be tracked - nothing
                    // can ever end it, because the end is a timeout armed here - so the early return
                    // left the device's master-control tag at 1 with no timer, no interval and no
                    // entry in activeEventModeSchedules. The device stayed latched to a scheduler
                    // that would never release it, and the client had already been told it was
                    // active. Nothing would ever correct either one.
                    if (!canArmEventMode(event)) {
                        logger.error('Event missing ID! Cannot track Event Mode event - releasing the ' +
                            'control tag instead of leaving the device latched.');
                        await writeTagFromEvent(device.variableId, 0, `Untrackable Event Mode event "${eventData.label}"`).catch(err => {
                            logger.error(`Error releasing untrackable event: ${err.message}`);
                        });
                        if (runtime.io) {
                            runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                                schedulerId: schedulerId,
                                deviceName: device.name,
                                eventIndex: eventIndex,
                                eventId: null,
                                eventData: eventData,
                                active: false
                            });
                        }
                        return;
                    }

                    const durationMs = event.duration * 1000;
                    const startTime = Date.now();
                    const endTime = startTime + durationMs;
                    const eventKey = eventTrackId(event);
                    const activeData = {
                        endTime: endTime,
                        schedulerId: schedulerId,
                        deviceName: device.name,
                        eventIndex: eventIndex,
                        eventId: event.id,
                        variableId: device.variableId
                    };
                    activeEventModeSchedules.set(eventKey, activeData);

                    const remainingTimeInterval = setInterval(() => {
                        const remainingMs = activeData.endTime - Date.now();
                        const remaining = Math.max(0, Math.floor(remainingMs / 1000));

                        if (runtime.io) {
                            runtime.io.emit(Events.IoEventTypes.SCHEDULER_REMAINING, {
                                schedulerId: activeData.schedulerId,
                                deviceName: activeData.deviceName,
                                eventIndex: activeData.eventIndex,
                                eventId: activeData.eventId,
                                remaining: remaining
                            });
                        }
                    }, 1000);
                    activeData.interval = remainingTimeInterval;

                    const endTimeout = setTimeout(async () => {
                        const tracked = activeEventModeSchedules.get(eventKey);

                        if (tracked && tracked.interval) {
                            clearInterval(tracked.interval);
                        }

                        activeEventModeSchedules.delete(eventKey);

                        const targetDevice = tracked ? tracked.deviceName : device.name;
                        const targetIndex = tracked ? tracked.eventIndex : eventIndex;
                        const targetVariableId = tracked ? tracked.variableId : device.variableId;

                        await writeTagFromEvent(targetVariableId, 0, `Event "${eventData.label}" ended after duration`).catch(err => {
                            logger.error(`Error in duration END callback: ${err.message}`);
                        });

                        // Execute server-side device actions (Set Value, Run Script, etc.)
                        const schedulers = await runtime.schedulerStorage.getAllSchedulers();
                        const scheduler = schedulers.find(s => s.id === schedulerId);
                        if (scheduler?.data?.settings) {
                            await executeDeviceActions(schedulerId, targetDevice, 'off', scheduler.data.settings);
                        }

                        // The day list comes from the spec, for the same reason as the end callback
                        // below: the local `dayNumbers` this used to read was removed when the rule
                        // building was extracted.
                        await handleEventCompletion(schedulerId, targetDevice, targetIndex, eventData, spec.dayNumbers);
                    }, durationMs);
                    activeData.endTimeout = endTimeout;
                }
            });
        } catch (scheduleError) {
            logger.error(`Error scheduling START job: ${scheduleError.message}`);
        }

        if (!isEventMode) {
            const endRule = new schedule.RecurrenceRule();
            if (spec.isMonthMode) {
                endRule.month = spec.monthNumbers;
                endRule.date = spec.dayOfMonthNumbers;
            } else {
                endRule.dayOfWeek = spec.dayNumbers;
            }
            endRule.hour = spec.endHour;
            endRule.minute = spec.endMin;

            try {
                endJob = schedule.scheduleJob(endRule, async () => {
                    await writeTagFromEvent(device.variableId, 0, `Event "${eventData.label}" ended`).catch(err => {
                        logger.error(`Error in END callback: ${err.message}`);
                    });

                    // Execute server-side device actions (Set Value, Run Script, etc.)
                    const schedulers = await runtime.schedulerStorage.getAllSchedulers();
                    const scheduler = schedulers.find(s => s.id === schedulerId);
                    if (scheduler?.data?.settings) {
                        await executeDeviceActions(schedulerId, device.name, 'off', scheduler.data.settings);
                    }

                    // The day list comes from the spec: before the rule-building was extracted, this
                    // read a local `dayNumbers`, and that name went away with the extraction.
                    await handleEventCompletion(schedulerId, device.name, eventIndex, eventData, spec.dayNumbers);
                });
            } catch (scheduleError) {
                logger.error(`Error scheduling END job: ${scheduleError.message}`);
            }
        }

        if (startJob) {
            activeJobs.set(`${jobId}_start`, startJob);
        }
        if (endJob) {
            activeJobs.set(`${jobId}_end`, endJob);
        }

        if (isEventMode) {
            if (!canArmEventMode(event)) {
                logger.error(`Event missing ID! Cannot check for transfer.`);
                return;
            }

            const activeKey = eventTrackId(event);
            if (activeEventModeSchedules.has(activeKey)) {
                const activeData = activeEventModeSchedules.get(activeKey);

                if (activeData.interval) {
                    clearInterval(activeData.interval);
                    activeData.interval = null;
                }

                activeData.deviceName = device.name;
                activeData.eventIndex = eventIndex;
                activeData.variableId = device.variableId;
                activeEventModeSchedules.set(activeKey, activeData);

                await writeTagFromEvent(device.variableId, 1, `Transferred Event Mode event started on ${device.name}`);

                if (runtime.io) {
                    const remainingTime = Math.max(0, Math.ceil((activeData.endTime - Date.now()) / 1000));
                    runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                        schedulerId: schedulerId,
                        deviceName: device.name,
                        eventIndex: eventIndex,
                        eventId: event.id,
                        eventData: eventData,
                        active: true,
                        remainingTime: remainingTime
                    });

                    const transferredInterval = setInterval(() => {
                        const remainingMs = activeData.endTime - Date.now();
                        const remaining = Math.max(0, Math.floor(remainingMs / 1000));

                        if (runtime.io && remaining > 0) {
                            runtime.io.emit(Events.IoEventTypes.SCHEDULER_REMAINING, {
                                schedulerId: activeData.schedulerId,
                                deviceName: activeData.deviceName,
                                eventIndex: activeData.eventIndex,
                                eventId: activeData.eventId,
                                remaining: remaining
                            });
                        } else if (remaining <= 0) {
                            clearInterval(transferredInterval);
                        }
                    }, 1000);
                    activeData.interval = transferredInterval;
                }
            }
        }

    } catch (error) {
        logger.error(`Error creating job for event: ${error.message}`);
        logger.error(error.stack);
    }
}

/**
 * Check if event should be active right now and notify clients
 */
function checkAndNotifyEventState(schedulerId, device, eventData, eventIndex, dayNumbers) {
    try {
        const now = new Date();
        const currentDay = now.getDay();
        const currentHour = now.getHours();
        const currentMin = now.getMinutes();
        const currentTimeInMinutes = currentHour * 60 + currentMin;

        if (eventData.eventMode === true) {
            if (!eventData.id) {
                // Event has no ID, treat as inactive
                if (runtime.io) {
                    runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                        schedulerId: schedulerId,
                        deviceName: device.name,
                        eventIndex: eventIndex,
                        eventData: eventData,
                        active: false
                    });
                }
                return;
            }

            const eventKey = eventData.id;
            const activeEventMode = activeEventModeSchedules.get(eventKey);
            const isActive = !!(activeEventMode && activeEventMode.endTime > Date.now());

            if (runtime.io) {
                runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                    schedulerId: schedulerId,
                    deviceName: device.name,
                    eventIndex: eventIndex,
                    eventId: eventData.id,
                    eventData: eventData,
                    active: isActive
                });

                if (isActive && eventData.duration) {
                    const remainingMs = activeEventMode.endTime - Date.now();
                    const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
                    runtime.io.emit(Events.IoEventTypes.SCHEDULER_REMAINING, {
                        schedulerId: schedulerId,
                        deviceName: device.name,
                        eventIndex: eventIndex,
                        eventId: eventData.id,
                        remaining: remainingSeconds
                    });
                }
            }
            return;
        }

        if (!dayNumbers.includes(currentDay)) {
            if (runtime.io) {
                runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                    schedulerId: schedulerId,
                    deviceName: device.name,
                    eventIndex: eventIndex,
                    eventId: eventData.id,
                    eventData: eventData,
                    active: false
                });
            }
            return;
        }

        if (!eventData.endTime) {
            return;
        }

        const [startHour, startMin] = eventData.startTime.split(':').map(Number);
        const [endHour, endMin] = eventData.endTime.split(':').map(Number);
        const startTimeInMinutes = startHour * 60 + startMin;
        const endTimeInMinutes = endHour * 60 + endMin;

        let isActive = false;
        if (endTimeInMinutes > startTimeInMinutes) {
            isActive = currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes;
        } else {
            isActive = currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes < endTimeInMinutes;
        }

        if (runtime.io) {
            runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                schedulerId: schedulerId,
                deviceName: device.name,
                eventIndex: eventIndex,
                eventId: eventData.id,
                eventData: eventData,
                active: isActive
            });
        }
    } catch (error) {
        logger.error(`Error checking event state: ${error.message}`);
    }
}

/**
 * The display label for one event, or undefined when there is nothing to show.
 *
 * WHY THIS IS ONE FUNCTION. The same event is labelled in three places - the creation state pass
 * (setInitialStates), the start/end/duration callbacks in createEventJob, and the deletion path in
 * handleEventDeletions - and they did NOT agree. With an explicit label they all used it, so the
 * inconsistency hid; without one, the fallback differed by site:
 *
 *   setInitialStates / the callbacks   `${deviceName}_${startTime}-${endTime}`   (or _Event_Xs)
 *   handleEventDeletions              `${deviceName}_Event`
 *
 * So the label a client saw CHANGED as the event progressed. For a one-time event the ending frame
 * is emitted BEFORE removeOneTimeEvent deletes it, so the big screen showed the detailed label and
 * then, in the same second, the generic one - visibly losing the schedule's times - before the event
 * disappeared. Every emit and every log line carries this string.
 *
 * Years of debugging have gone into "the label said something different this time", which is why the
 * rule now lives in one place and is tested.
 *
 * @returns {string|undefined}
 */
function buildEventLabel(deviceName, event) {
    if (!event) {
        return undefined;
    }
    if (event.label) {
        return event.label;
    }

    const name = deviceName || (event.device && event.device.name) || '';
    const isEventMode = event.eventMode === true;

    if (isEventMode) {
        // No endTime to show: an event-mode event ends when its duration runs out.
        return name + '_' + (event.startTime || '') +
            (event.duration !== undefined ? '_Event_' + event.duration + 's' : '_Event');
    }

    if (event.startTime && event.endTime) {
        return name + '_' + event.startTime + '-' + event.endTime;
    }

    return name + '_Event';
}

/**
 * How an Event Mode event is tracked while it runs.
 *
 * The whole Event Mode feature keys its bookkeeping on this string: activeEventModeSchedules is
 * keyed by it, the duration timeout clears it, checkAndNotifyEventState reads it to decide whether
 * the event is still active, and handleEventModifications looks it up to re-arm a changed duration.
 * It is defined in one place so those five call sites cannot drift apart.
 *
 * @returns {string|undefined} undefined when the event has no id and therefore cannot be tracked
 */
function eventTrackId(event) {
    return event && event.id ? event.id : undefined;
}

/**
 * Whether an Event Mode event can be armed at all.
 *
 * An event-mode event ends when the timeout armed at its start fires. Without an id there is nothing
 * to key that timeout on, so the event can start but can never end - which is why callers must ask
 * this BEFORE they write the control tag to 1.
 */
function canArmEventMode(event) {
    return eventTrackId(event) !== undefined;
}

/**
 * What to do when an event completes - the decision, in one place.
 *
 * THIS BLOCK WAS COPIED THREE TIMES, character for character, in the start callback's duration
 * timeout (createEventJob), in the end callback (createEventJob), and in the modified-duration
 * timeout (handleEventModifications). All three decided the same two things and all three carried
 * the same comment explaining the same subtlety:
 *
 *   willDelete  the event does not recur, so its last firing removes it
 *   isLastDay   today is the last scheduled day this week - see isLastDayOfWeekForEvent
 *
 * and then: emit active:false UNLESS the deletion is about to happen, because a deletion emits
 * scheduler:updated which refreshes the UI anyway - so emitting both made the client redraw the same
 * event twice, the second time for an event that no longer exists.
 *
 * The subtlety is exactly the kind that survives in one copy and gets lost in the other two. The
 * three callers differ only in which DEVICE and INDEX they mean (the duration path prefers what was
 * tracked when the event was armed), so those come in as arguments.
 *
 * @param {string} schedulerId
 * @param {string} deviceName   the device to name in the frame and to delete from
 * @param {number} eventIndex   the index to name in the frame
 * @param {object} eventData    the payload already sent to the client for this event
 * @param {number[]} dayNumbers the indices of the days this event is scheduled on
 * @returns {Promise<{willDelete: boolean, isLastDay: boolean, decided: boolean}>}
 */
async function handleEventCompletion(schedulerId, deviceName, eventIndex, eventData, dayNumbers) {
    const willDelete = eventData.recurring === false;
    let isLastDay = false;
    if (willDelete) {
        isLastDay = await isLastDayOfWeekForEvent(dayNumbers, new Date().getDay());
    }

    if (runtime.io && !(willDelete && isLastDay)) {
        runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
            schedulerId: schedulerId,
            deviceName: deviceName,
            eventIndex: eventIndex,
            eventId: eventData.id,
            eventData: eventData,
            active: false
        });
    }

    if (willDelete && isLastDay) {
        await removeOneTimeEvent(schedulerId, deviceName, eventIndex, eventData.id);
    }

    return { willDelete: willDelete, isLastDay: isLastDay, decided: true };
}

/**
 * The day-index list for an event, from the client's boolean array.
 *
 * The client sends `days` as seven booleans; node-schedule and the day-of-week checks want the
 * indices of the true ones. Two call sites did this by hand, and one of them (notifyEventStates)
 * did it WITHOUT checking that `days` is an array at all - so a single event missing `days` threw
 * inside its forEach callback, which the surrounding catch turned into one log line and NO state
 * broadcast for that scheduler: every event after the malformed one went silent on the client.
 *
 * @returns {number[]} the indices whose value is exactly true
 */
function eventDayNumbers(event) {
    if (!event || !Array.isArray(event.days)) {
        return [];
    }
    const dayNumbers = [];
    event.days.forEach((isActive, dayIndex) => {
        if (isActive === true) {
            dayNumbers.push(dayIndex);
        }
    });
    return dayNumbers;
}

/**
 * The event payload that every SCHEDULER_ACTIVE frame carries.
 *
 * WHY THIS IS ONE FUNCTION. The same shape was assembled twice - once in notifyEventStates, once in
 * setInitialStates before calling checkAndNotifyEventState - and the two were NOT identical: the
 * second omitted `days`, `disabled` and `recurring`. So an event's payload depended on which pass
 * produced the frame, and a client that reads one of the missing fields got a different answer on a
 * refresh than on a state change.
 *
 * The field set below is the SMALLER of the two, which is the one clients were written against; the
 * extra fields the other site sent are recorded in the ledger as the thing to confirm with the UI
 * before adding, rather than silently changing the wire shape here.
 */
function buildEventPayload(deviceName, event) {
    return {
        label: buildEventLabel(deviceName, event),
        startTime: event.startTime,
        endTime: event.endTime,
        days: event.days,
        disabled: event.disabled,
        recurring: event.recurring,
        eventMode: event.eventMode,
        duration: event.duration,
        id: event.id
    };
}

/**
 * Everything a recurrence rule needs for one event, or null when the event cannot be scheduled.
 *
 * WHY THIS IS A SEPARATE FUNCTION. It was the first 100 lines of createEventJob, which is 374 lines
 * long, and it is the part that decides whether an event runs at all. Two things live in here that
 * are worth testing on their own:
 *
 *   the VALIDATION ladder - which shapes of event are refused, and which are refused in month mode
 *   only. Getting that wrong means an event that silently never runs, with no job and no log.
 *
 *   the INDEX MAPPING - the client sends boolean arrays (days/months/daysOfMonth) and node-schedule
 *   wants index lists. The three use DIFFERENT bases: days are 0-based as sent, months are 0-11 as
 *   sent, and daysOfMonth are 1-31 so they are shifted by one. Only the last one is shifted, and
 *   that is exactly the kind of detail a future edit gets wrong.
 *
 * The `isEventMode` flag changes the ladder: an event-mode event needs a positive duration and no
 * end time, a timer-mode event needs an end time. Passing the wrong flag silently refuses events.
 *
 * @param {object} event
 * @param {boolean} isEventMode
 * @returns {object|null} { isMonthMode, dayNumbers, monthNumbers, dayOfMonthNumbers, startHour, startMin }
 */
function buildEventScheduleSpec(event, isEventMode) {
    if (!event) {
        return null;
    }
    if (!event.days && !event.monthMode) {
        return null;
    }
    if (event.monthMode && (!event.months || !event.daysOfMonth)) {
        return null;
    }
    if (!event.startTime) {
        return null;
    }
    if (!isEventMode && !event.endTime) {
        return null;
    }
    if (isEventMode && (event.duration === undefined || event.duration <= 0)) {
        return null;
    }

    const startParts = event.startTime.split(':');
    if (startParts.length !== 2) {
        return null;
    }
    const startHour = parseInt(startParts[0]);
    const startMin = parseInt(startParts[1]);
    if (isNaN(startHour) || isNaN(startMin)) {
        return null;
    }

    let endHour;
    let endMin;
    if (!isEventMode) {
        const endParts = event.endTime.split(':');
        if (endParts.length !== 2) {
            return null;
        }
        endHour = parseInt(endParts[0]);
        endMin = parseInt(endParts[1]);
        if (isNaN(endHour) || isNaN(endMin)) {
            return null;
        }
    }

    const dayNumbers = [];
    if (Array.isArray(event.days)) {
        event.days.forEach((isActive, dayIndex) => {
            if (isActive === true) {
                dayNumbers.push(dayIndex);
            }
        });
    }

    const monthNumbers = [];
    if (Array.isArray(event.months)) {
        event.months.forEach((isActive, monthIndex) => {
            if (isActive === true) {
                monthNumbers.push(monthIndex); // Months are 0-11 (node-schedule format)
            }
        });
    }

    const dayOfMonthNumbers = [];
    if (Array.isArray(event.daysOfMonth)) {
        event.daysOfMonth.forEach((isActive, dayIndex) => {
            if (isActive === true) {
                dayOfMonthNumbers.push(dayIndex + 1); // Days are 1-31
            }
        });
    }

    const isMonthMode = event.monthMode === true;

    if (isMonthMode) {
        if (monthNumbers.length === 0 || dayOfMonthNumbers.length === 0) {
            logger.warn('Month mode schedule rejected: no months or days selected');
            return null;
        }
    } else if (dayNumbers.length === 0) {
        return null;
    }

    return {
        isMonthMode: isMonthMode,
        dayNumbers: dayNumbers,
        monthNumbers: monthNumbers,
        dayOfMonthNumbers: dayOfMonthNumbers,
        startHour: startHour,
        startMin: startMin,
        endHour: endHour,
        endMin: endMin
    };
}

/**
 * Check if the current day is the last scheduled day in the current week
 */
async function isLastDayOfWeekForEvent(dayNumbers, currentDay) {
    const remainingDays = dayNumbers.filter(day => day >= currentDay);

    if (remainingDays.length === 0) {
        return true;
    }

    remainingDays.sort((a, b) => a - b);
    return currentDay === remainingDays[remainingDays.length - 1];
}

/**
 * Remove a one-time event after it has executed
 */
async function removeOneTimeEvent(schedulerId, deviceName, eventIndex, eventId) {
    const summary = { removed: false, reason: null, removedBy: null, jobKeys: [] };

    try {
        const schedulerData = await runtime.schedulerStorage.getSchedulerData(schedulerId);
        if (!schedulerData) {
            logger.warn(`Cannot remove one-time event: scheduler ${schedulerId} not found`);
            summary.reason = 'scheduler-not-found';
            return summary;
        }

        const deviceSchedules = schedulerData.schedules?.[deviceName];
        if (!deviceSchedules || !Array.isArray(deviceSchedules)) {
            logger.warn(`Cannot remove one-time event: no schedules for device ${deviceName}`);
            summary.reason = 'no-schedules-for-device';
            return summary;
        }

        // Find event by ID (most reliable) or fallback to index
        let actualEventIndex = -1;
        if (eventId) {
            actualEventIndex = deviceSchedules.findIndex(e => e.id === eventId);
        }
        if (actualEventIndex === -1 && eventIndex >= 0 && eventIndex < deviceSchedules.length) {
            actualEventIndex = eventIndex;
        }

        if (actualEventIndex < 0 || actualEventIndex >= deviceSchedules.length) {
            // THE REFUSAL THAT MATTERS: the event is still in the stored data, so it will run again.
            // The caller has no way to tell this from "removed", which is why it is reported now.
            logger.warn(`Cannot remove one-time event: event not found (id=${eventId}, index=${eventIndex})`);
            summary.reason = 'not-found';
            return summary;
        }

        summary.removedBy = (eventId && deviceSchedules[actualEventIndex].id === eventId) ? 'id' : 'index';

        const removedEvent = deviceSchedules.splice(actualEventIndex, 1)[0];

        // Clean up any active Event Mode data for this event BEFORE saving/emitting
        // This prevents race conditions where notifyEventStates() sees stale active data
        if (eventId && activeEventModeSchedules.has(eventId)) {
            const activeData = activeEventModeSchedules.get(eventId);
            if (activeData.interval) {
                clearInterval(activeData.interval);
            }
            if (activeData.endTimeout) {
                clearTimeout(activeData.endTimeout);
            }
            activeEventModeSchedules.delete(eventId);
        }

        summary.jobKeys = [`${jobIdBaseFor(schedulerId, deviceName, eventId, actualEventIndex)}_start`,
            `${jobIdBaseFor(schedulerId, deviceName, eventId, actualEventIndex)}_end`];

        await runtime.schedulerStorage.setSchedulerData(schedulerId, schedulerData);

        // Cancel jobs using event ID if available
        const jobIdBase = jobIdBaseFor(schedulerId, deviceName, eventId, actualEventIndex);
        const startJobKey = `${jobIdBase}_start`;
        const endJobKey = `${jobIdBase}_end`;

        if (activeJobs.has(startJobKey)) {
            activeJobs.get(startJobKey).cancel();
            activeJobs.delete(startJobKey);
        }
        if (activeJobs.has(endJobKey)) {
            activeJobs.get(endJobKey).cancel();
            activeJobs.delete(endJobKey);
        }

        if (runtime.io) {
            runtime.io.emit(Events.IoEventTypes.SCHEDULER_UPDATED, { id: schedulerId, data: schedulerData });
        }

        summary.removed = true;
        return summary;

    } catch (error) {
        // NOTE: the splice above happens BEFORE the save, so a failed save leaves the in-memory copy
        // without the event while the stored copy still has it - it comes back on the next load. The
        // summary says which stage failed rather than reporting a bare "not removed".
        logger.error(`Error removing one-time event: ${error.message}`);
        logger.error(error.stack);
        summary.reason = 'storage-failed';
        return summary;
    }
}

/**
 * The job-id base for one event.
 *
 * The id is used when there is one and the INDEX otherwise, which is what the scheduler stores its
 * jobs under. Both the removal and the creation side build this string, so it lives in one place.
 */
function jobIdBaseFor(schedulerId, deviceName, eventId, eventIndex) {
    return eventId ? `${schedulerId}_${deviceName}_${eventId}` : `${schedulerId}_${deviceName}_${eventIndex}`;
}

/**
 * Write tag value from event (with loop prevention)
 */
/**
 * Write a tag because a scheduler decided to, and report whether the write took effect.
 *
 * The `schedulerWriting` set is a LOOP BREAK, and the 1000 ms is the whole point of it: this write
 * causes a tag change, which the runtime announces, and onTagChanged would then read that change as
 * an EXTERNAL one and enforce master control back - a loop. Holding the tag id here for a second
 * makes onTagChanged ignore the echo.
 *
 * @returns {Promise<boolean>} whether the value was applied
 */
async function writeTagFromEvent(tagId, value, reason) {
    try {
        schedulerWriting.add(tagId);

        const result = await runtime.devices.setTagValue(tagId, value);

        if (result) {
            const deviceId = getDeviceIdFromTag(tagId);
            if (deviceId) {
                const values = {};
                values[tagId] = {
                    id: tagId,
                    value: value,
                    timestamp: Date.now()
                };
                runtime.events.emit('device-value:changed', { id: deviceId, values: values });
            }
            setTimeout(() => {
                schedulerWriting.delete(tagId);
            }, 1000);
            return true;
        }

        // A REFUSED write. setTagValue resolves false; it does not throw, so this path used to fall
        // out of the function with no log, no publish and no caller-visible answer - the same defect
        // class the action handlers had (see executeDeviceActions).
        logger.error('Scheduler write not applied (' + (reason || 'no reason given') + '): ' + tagId);
        schedulerWriting.delete(tagId);
        return false;

    } catch (error) {
        logger.error(`Error writing tag: ${error.message}`);
        schedulerWriting.delete(tagId);
        return false;
    }
}

/**
 * Get device ID from tag ID
 */
function getDeviceIdFromTag(tagId) {
    try {
        const parts = tagId.split('.');
        if (parts.length > 1) {
            return parts[0];
        }
        return 'SCADIAServer';
    } catch (err) {
        return null;
    }
}

/**
 * MASTER CONTROL: When tag changes externally, check if event should override it
 */
async function onTagChanged(tagEvent) {
    const tagId = tagEvent.id;
    const currentValue = tagEvent.value ? 1 : 0;

    if (schedulerWriting.has(tagId)) {
        return;
    }

    try {
        const schedulers = await runtime.schedulerStorage.getAllSchedulers();

        let device = null;
        let controllingScheduler = null;

        for (const scheduler of schedulers) {
            if (scheduler.data?.settings?.devices) {
                device = scheduler.data.settings.devices.find(d => d.variableId === tagId);
                if (device) {
                    controllingScheduler = scheduler;
                    break;
                }
            }
        }

        if (!device || !controllingScheduler) {
            return;
        }

        const schedules = controllingScheduler.data.schedules?.[device.name] || [];

        let isEventModeActive = false;
        for (const [key, eventInfo] of activeEventModeSchedules.entries()) {
            if (eventInfo.variableId === tagId && eventInfo.endTime > Date.now()) {
                isEventModeActive = true;
                break;
            }
        }

        const isTimerModeActive = checkIfAnyEventActive(schedules);
        const isEventActive = isEventModeActive || isTimerModeActive;
        const expectedValue = isEventActive ? 1 : 0;

        if (currentValue !== expectedValue) {
            await writeTagFromEvent(tagId, expectedValue, 'Master control enforcement');
        }

    } catch (error) {
        logger.error(`Error in onTagChanged: ${error.message}`);
    }
}

/**
 * Check if any event is currently active
 */
function checkIfAnyEventActive(schedules) {
    if (!schedules || schedules.length === 0) {
        return false;
    }

    const now = new Date();
    const currentDay = now.getDay();
    const currentMonth = now.getMonth(); // 0-11
    const currentDate = now.getDate(); // 1-31
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const event of schedules) {
        // Check day-of-week mode
        if (!event.monthMode && event.days && event.days.length > 0) {
            if (event.days[currentDay] !== true) {
                continue;
            }
        }
        // Check month mode
        else if (event.monthMode && event.months && event.daysOfMonth) {
            if (event.months[currentMonth] !== true || event.daysOfMonth[currentDate - 1] !== true) {
                continue;
            }
        }
        else {
            continue;
        }

        if (event.eventMode === true) {
            continue;
        }

        if (!event.endTime) {
            continue;
        }

        const [startHour, startMin] = event.startTime.split(':').map(Number);
        const [endHour, endMin] = event.endTime.split(':').map(Number);
        const startMinutes = startHour * 60 + startMin;
        const endMinutes = endHour * 60 + endMin;

        let inRange = false;
        if (endMinutes < startMinutes) {
            inRange = currentMinutes >= startMinutes || currentMinutes < endMinutes;
        } else {
            inRange = currentMinutes >= startMinutes && currentMinutes < endMinutes;
        }

        if (inRange) {
            return true;
        }
    }

    return false;
}

/**
 * Check if any Event Mode events are currently active for a device
 */
function checkIfAnyEventModeActive(deviceName, schedulerId) {
    for (const [key, eventInfo] of activeEventModeSchedules.entries()) {
        if (eventInfo.deviceName === deviceName && eventInfo.schedulerId === schedulerId) {
            return true;
        }
    }
    return false;
}

/**
 * Update scheduler
 */
async function updateScheduler(schedulerId, schedulerData, oldData = null) {
    try {
        if (!oldData) {
            const schedulers = await runtime.schedulerStorage.getAllSchedulers();
            const previousScheduler = schedulers.find(s => s.id === schedulerId);
            oldData = previousScheduler?.data;
        }

        if (oldData) {
            await handleTagChanges(schedulerId, oldData, schedulerData);
        }

        // Handle Event Mode duration changes BEFORE stopping/recreating jobs
        if (oldData) {
            await handleEventModifications(schedulerId, oldData, schedulerData);
        }

        if (oldData) {
            await handleEventDeletions(schedulerId, oldData, schedulerData);
        }

        stopScheduler(schedulerId);
        await createSchedulerJobs(schedulerId, schedulerData);
        await setInitialStates(schedulerId, schedulerData);

        // Notify all event states after update to ensure client has correct indices
        await notifyEventStates(schedulerId, schedulerData);

    } catch (error) {
        logger.error(`Error in updateScheduler: ${error.message}`);
    }
}

/**
 * Handle tag changes - reset old tags to 0 when device tag changes
 */
/**
 * Reset the tag of a device that this scheduler no longer controls.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: the tag being reset is the scheduler's master-control input.
 * If a device is removed from a scheduler, or pointed at a different tag, and the OLD tag is left
 * at 1, then the old tag still reads as "this device is under scheduler control" to anything
 * watching it - and the runtime's own master-control enforcement reads it that way too. The reset
 * is the thing that unlatches the device.
 *
 * It used to `await writeTagFromEvent(...)` and ignore the answer, which was fine while that
 * function returned nothing. It now returns whether the write took effect, so a reset that did NOT
 * happen is recorded instead of vanishing.
 *
 * @returns {Promise<{checked: number, reset: number, failed: number, resets: Array}>}
 */
async function handleTagChanges(schedulerId, oldData, newData) {
    const summary = { checked: 0, reset: 0, failed: 0, resets: [] };

    if (!oldData?.settings?.devices) {
        return summary;
    }

    const oldDevicesByName = new Map();
    for (const device of oldData.settings.devices) {
        oldDevicesByName.set(device.name, device);
    }

    const newDevicesByName = new Map();
    if (newData?.settings?.devices) {
        for (const device of newData.settings.devices) {
            newDevicesByName.set(device.name, device);
        }
    }

    for (const [deviceName, oldDevice] of oldDevicesByName) {
        const newDevice = newDevicesByName.get(deviceName);

        let reason = null;
        if (!newDevice) {
            reason = 'Device deleted from scheduler';
        } else if (oldDevice.variableId !== newDevice.variableId) {
            reason = 'Tag change - resetting old tag';
        }

        if (!reason) {
            continue;
        }

        summary.checked++;
        const applied = await writeTagFromEvent(oldDevice.variableId, 0, reason);
        summary.resets.push({ deviceName: deviceName, variableId: oldDevice.variableId, reason: reason, applied: applied });
        if (applied) {
            summary.reset++;
        } else {
            summary.failed++;
            logger.warn('Master control latch not released - scheduler ' + schedulerId + ', device ' +
                deviceName + ', tag ' + oldDevice.variableId + ': ' + reason);
        }
    }

    return summary;
}

/**
 * Handle Event Mode duration changes for RUNNING events
 */
async function handleEventModifications(schedulerId, oldData, newData) {
    if (!oldData?.settings?.devices || !newData?.settings?.devices) {
        return;
    }

    // Check each device for events that exist in both old and new data
    for (const device of newData.settings.devices) {
        const oldSchedules = oldData.schedules?.[device.name] || [];
        const newSchedules = newData.schedules?.[device.name] || [];

        for (const newEvent of newSchedules) {
            if (!newEvent.eventMode || !newEvent.id) continue;

            // Find the corresponding old event by ID
            const oldEvent = oldSchedules.find(e => e.id === newEvent.id);
            if (!oldEvent) continue; // Event is new, not modified

            // Check if duration changed
            if (oldEvent.duration !== newEvent.duration) {
                // Check if this event is currently running
                const eventKey = newEvent.id;
                const activeData = activeEventModeSchedules.get(eventKey);

                if (activeData) {
                    // Clear the old interval and timeout
                    if (activeData.interval) {
                        clearInterval(activeData.interval);
                        activeData.interval = null;
                    }
                    if (activeData.endTimeout) {
                        clearTimeout(activeData.endTimeout);
                        activeData.endTimeout = null;
                    }

                    const newDurationMs = newEvent.duration * 1000;
                    const newEndTime = Date.now() + newDurationMs;
                    activeData.endTime = newEndTime;

                    // Create new countdown interval
                    const newInterval = setInterval(() => {
                        const remainingMs = activeData.endTime - Date.now();
                        const remaining = Math.max(0, Math.floor(remainingMs / 1000));

                        if (runtime.io) {
                            runtime.io.emit(Events.IoEventTypes.SCHEDULER_REMAINING, {
                                schedulerId: activeData.schedulerId,
                                deviceName: activeData.deviceName,
                                eventIndex: activeData.eventIndex,
                                eventId: activeData.eventId,
                                remaining: remaining
                            });
                        }
                    }, 1000);
                    activeData.interval = newInterval;

                    // Create new END timeout with updated event data
                    const newEndTimeout = setTimeout(async () => {
                        const tracked = activeEventModeSchedules.get(eventKey);

                        if (tracked && tracked.interval) {
                            clearInterval(tracked.interval);
                        }

                        activeEventModeSchedules.delete(eventKey);

                        const targetDevice = tracked ? tracked.deviceName : device.name;
                        const targetIndex = tracked ? tracked.eventIndex : newSchedules.indexOf(newEvent);
                        const targetVariableId = tracked ? tracked.variableId : device.variableId;

                        await writeTagFromEvent(targetVariableId, 0, `Event ended after modified duration`).catch(err => {
                            logger.error(`Error in modified duration END callback: ${err.message}`);
                        });

                        // The payload is the shared one, so the frame this path emits carries the
                        // same fields as every other frame - the inline object that used to be here
                        // omitted recurring, days and disabled.
                        await handleEventCompletion(schedulerId, targetDevice, targetIndex,
                            buildEventPayload(device.name, newEvent), eventDayNumbers(newEvent));
                    }, newDurationMs);
                    activeData.endTimeout = newEndTimeout;

                    // Update the stored activeData
                    activeEventModeSchedules.set(eventKey, activeData);

                    // Immediately emit the new remaining time to client
                    if (runtime.io) {
                        runtime.io.emit(Events.IoEventTypes.SCHEDULER_REMAINING, {
                            schedulerId: schedulerId,
                            deviceName: device.name,
                            eventIndex: newSchedules.indexOf(newEvent),
                            eventId: newEvent.id,
                            remaining: newEvent.duration
                        });
                    }
                }
            }
        }
    }
}

/**
 * Handle event deletions
 */
async function handleEventDeletions(schedulerId, oldData, newData) {
    const summary = { deleted: 0, resets: [] };

    if (!oldData?.settings?.devices || !newData?.settings?.devices) {
        return summary;
    }

    const oldEventsByDevice = new Map();
    for (const device of oldData.settings.devices) {
        const schedules = oldData.schedules?.[device.name] || [];
        for (const event of schedules) {
            if (!oldEventsByDevice.has(device.name)) {
                oldEventsByDevice.set(device.name, []);
            }
            oldEventsByDevice.get(device.name).push({ device, event });
        }
    }

    const newEventsByDevice = new Map();
    for (const device of newData.settings.devices) {
        const schedules = newData.schedules?.[device.name] || [];
        for (const event of schedules) {
            if (!newEventsByDevice.has(device.name)) {
                newEventsByDevice.set(device.name, []);
            }
            newEventsByDevice.get(device.name).push(event);
        }
    }

    for (const [deviceName, oldDeviceEvents] of oldEventsByDevice) {
        const newDeviceEvents = newEventsByDevice.get(deviceName) || [];
        const newEventIds = new Set(newDeviceEvents.map(e => e.id));

        const deletedEvents = oldDeviceEvents.filter(({ event }) => !newEventIds.has(event.id));

        if (deletedEvents.length > 0) {
            summary.deleted += deletedEvents.length;
            for (const { device, event } of deletedEvents) {
                const startJobId = `${schedulerId}_${device.name}_${event.id}_start`;
                const endJobId = `${schedulerId}_${device.name}_${event.id}_end`;

                let wasTransferred = false;
                if (event.eventMode && event.duration !== undefined) {
                    for (const [otherDeviceName, otherDeviceEvents] of newEventsByDevice) {
                        if (otherDeviceName !== deviceName) {
                            const matchingEvent = otherDeviceEvents.find(e => e.id === event.id);
                            if (matchingEvent) {
                                const oldEventIndex = oldDeviceEvents.findIndex(({ event: e }) => e === event);

                                // THE INDEX MUST COME FROM THE TARGET DEVICE'S LIST. This used
                                // `newDeviceEvents`, which is the NEW data for THE OLD DEVICE - and
                                // by definition that device no longer has this event, so findIndex
                                // always answered -1. The moved event was then tracked with
                                // eventIndex -1 while the countdown interval reports its
                                // SCHEDULER_REMAINING frames against the NEW device's index, so every
                                // remaining-time frame named an index that does not exist on the
                                // device it named. A client matching frames by (device, index) had
                                // nothing to match.
                                const movedToEvents = newEventsByDevice.get(otherDeviceName) || [];
                                const newEventIndex = movedToEvents.findIndex(e => e.id === event.id);
                                const oldEventKey = event.id;
                                const newEventKey = event.id;
                                let activeData = null;

                                if (activeEventModeSchedules.has(oldEventKey)) {
                                    activeData = activeEventModeSchedules.get(oldEventKey);
                                } else {
                                    const oldEventKeyIndex = `${schedulerId}_${device.name}_${oldEventIndex}`;
                                    if (activeEventModeSchedules.has(oldEventKeyIndex)) {
                                        activeData = activeEventModeSchedules.get(oldEventKeyIndex);
                                    }
                                }

                                if (activeData) {
                                    if (runtime.io) {
                                        runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                                            schedulerId: schedulerId,
                                            deviceName: device.name,
                                            eventIndex: oldEventIndex,
                                            eventId: event.id,
                                            eventData: {
                                                label: `Transferred from ${device.name}`,
                                                startTime: event.startTime,
                                                eventMode: true,
                                                duration: event.duration,
                                                id: event.id
                                            },
                                            active: false
                                        });
                                    }

                                    if (activeEventModeSchedules.has(oldEventKey)) {
                                        activeEventModeSchedules.delete(oldEventKey);
                                    } else {
                                        const oldEventKeyIndex2 = `${schedulerId}_${device.name}_${oldEventIndex}`;
                                        activeEventModeSchedules.delete(oldEventKeyIndex2);
                                    }

                                    activeData.deviceName = otherDeviceName;
                                    activeData.eventIndex = newEventIndex;
                                    activeData.variableId = newData.settings.devices.find(d => d.name === otherDeviceName)?.variableId || activeData.variableId;

                                    activeEventModeSchedules.set(newEventKey, activeData);
                                    wasTransferred = true;
                                }
                                break;
                            }
                        }
                    }
                }

                if (!wasTransferred) {
                    if (activeJobs.has(startJobId)) {
                        activeJobs.get(startJobId).cancel();
                        activeJobs.delete(startJobId);
                    }

                    if (activeJobs.has(endJobId)) {
                        activeJobs.get(endJobId).cancel();
                        activeJobs.delete(endJobId);
                    }

                    // If this is an Event Mode event that's currently running, stop it immediately
                    if (event.eventMode && event.id) {
                        // Find the event index in oldDeviceEvents
                        const oldEventIndex = oldDeviceEvents.findIndex(({ event: e }) => e === event);

                        // Find the event in activeEventModeSchedules - it could be keyed by ID or other patterns
                        const possibleKeys = [
                            event.id,
                            `${schedulerId}_${device.name}_${event.id}`,
                            oldEventIndex,
                            `${schedulerId}_${device.name}_${oldEventIndex}`
                        ];

                        let activeData = null;
                        let foundKey = null;

                        for (const key of possibleKeys) {
                            if (activeEventModeSchedules.has(key)) {
                                activeData = activeEventModeSchedules.get(key);
                                foundKey = key;
                                break;
                            }
                        }

                        if (activeData) {
                            // Clear the remaining time interval (stored as 'interval', not 'intervalId')
                            if (activeData.interval) {
                                clearInterval(activeData.interval);
                                activeData.interval = null;
                            }

                            // Clear the END timeout (stored as 'endTimeout', not 'endTimeoutId')
                            if (activeData.endTimeout) {
                                clearTimeout(activeData.endTimeout);
                                activeData.endTimeout = null;
                            }

                            // Remove from active schedules using the key we found
                            activeEventModeSchedules.delete(foundKey);

                            // Also try to delete any other possible keys just to be thorough
                            for (const key of possibleKeys) {
                                if (key !== foundKey) {
                                    activeEventModeSchedules.delete(key);
                                }
                            }

                            // Emit INACTIVE state to client
                            if (runtime.io) {
                                runtime.io.emit(Events.IoEventTypes.SCHEDULER_ACTIVE, {
                                    schedulerId: schedulerId,
                                    deviceName: device.name,
                                    eventIndex: activeData.eventIndex,
                                    eventId: event.id,
                                    eventData: {
                                        label: buildEventLabel(device.name, event),
                                        startTime: event.startTime,
                                        eventMode: true,
                                        duration: event.duration,
                                        id: event.id
                                    },
                                    active: false
                                });
                            }

                            // Write tag to 0 immediately. The answer used to be discarded, so a
                            // refused write left the device latched with nothing to show for it.
                            const released = await writeTagFromEvent(device.variableId, 0, 'Event deleted while active');
                            summary.resets.push({ deviceName: device.name, variableId: device.variableId, applied: released });
                        }
                    }
                }
            }

            const remainingActive = checkIfAnyEventActive(newDeviceEvents);

            if (!remainingActive) {
                const device = deletedEvents[0].device;
                const released = await writeTagFromEvent(device.variableId, 0, 'Event deletion');
                summary.resets.push({ deviceName: device.name, variableId: device.variableId, applied: released });
            }
        }
    }

    return summary;
}

/**
 * Stop every job that belongs to one scheduler, and report how many were stopped.
 *
 * A JOB ID IS `${schedulerId}_${deviceName}_${eventId}_${start|end}`, so the test for "belongs to
 * this scheduler" has to be "equals the id, or starts with the id FOLLOWED BY THE SEPARATOR". A bare
 * `startsWith(schedulerId)` is a prefix match that ignores the boundary, so stopping `s1` also
 * cancelled every job of `s10`, `s11`, ... - a scheduler being toggled off took other schedulers'
 * jobs down with it, silently, because nothing reports what was cancelled.
 *
 * The id separator is defined once, here, and jobIdBaseFor builds ids to match.
 *
 * @returns {{cancelled: number, cancelledIds: string[]}}
 */
function stopScheduler(schedulerId) {
    const result = { cancelled: 0, cancelledIds: [] };

    for (const [jobId, job] of activeJobs) {
        if (!jobBelongsToScheduler(jobId, schedulerId)) {
            continue;
        }
        job.cancel();
        activeJobs.delete(jobId);
        result.cancelledIds.push(jobId);
        result.cancelled++;
    }

    return result;
}

/** Whether a job id was minted for this scheduler. Ids are `${schedulerId}_${rest}`. */
function jobBelongsToScheduler(jobId, schedulerId) {
    if (typeof jobId !== 'string' || typeof schedulerId !== 'string' || schedulerId === '') {
        return false;
    }
    return jobId === schedulerId || jobId.startsWith(schedulerId + '_');
}

/** Test/inspection seam: a job id registered for a scheduler, without node-schedule. */
function registerJobForTest(jobId, job) {
    activeJobs.set(jobId, job || { cancel() {} });
}

/** Test/inspection seam: the ids of every registered job, sorted. */
function registeredJobIds() {
    return Array.from(activeJobs.keys()).sort();
}

/** Test/inspection seam: forget every registered job. */
function clearAllJobsForTest() {
    activeJobs.clear();
}

/**
 * Remove scheduler completely
 */
async function removeScheduler(schedulerId) {
    try {
        const schedulers = await runtime.schedulerStorage.getAllSchedulers();
        const scheduler = schedulers.find(s => s.id === schedulerId);

        if (scheduler?.data?.settings?.devices) {
            for (const device of scheduler.data.settings.devices) {
                await writeTagFromEvent(device.variableId, 0, 'Scheduler deleted');
            }
        }

        stopScheduler(schedulerId);

    } catch (error) {
        logger.error(`Error in removeScheduler: ${error.message}`);
    }
}

/**
 * Execute device actions (Set Value, Toggle Value, Run Script) when a scheduler event fires
 * @param {string} schedulerId - Scheduler ID
 * @param {string} deviceName - Device name that triggered
 * @param {string} trigger - 'on' or 'off'
 * @param {object} schedulerSettings - Scheduler settings containing deviceActions
 */
async function executeDeviceActions(schedulerId, deviceName, trigger, schedulerSettings) {
    const summary = { schedulerId: schedulerId, deviceName: deviceName, total: 0, applied: 0, skipped: 0, failed: 0, results: [] };

    if (!schedulerSettings?.deviceActions || !Array.isArray(schedulerSettings.deviceActions)) {
        return summary;
    }

    // Filter actions for this device and trigger type
    const deviceActions = schedulerSettings.deviceActions.filter(action =>
        action.deviceName === deviceName &&
        (action.eventTrigger === trigger || (!action.eventTrigger && trigger === 'on'))
    );

    if (deviceActions.length === 0) {
        return summary;
    }

    summary.total = deviceActions.length;

    for (const action of deviceActions) {
        if (!action.action) {
            continue;
        }

        // WHAT THIS SUMMARY IS FOR
        //
        // Every caller used to `await` this function and throw the answer away, because there was no
        // answer: each handler logged and returned undefined on every path, including the paths where
        // the write had been REFUSED by the device layer (setTagValue resolves false - it does not
        // throw). A scheduler that could not apply its action therefore looked exactly like one that
        // applied it, and the operator's only clue was a line in a log file they were not reading.
        //
        // The callers still ignore it today - that is deliberate, this batch changes no behaviour -
        // but the outcome is now available, and a caller that wants to surface it can.
        let outcome;
        try {
            // Handle SERVER-SIDE actions only (Set Value, Toggle Value, Run Script)
            switch (action.action) {
                case 'onSetValue':
                    outcome = await handleSetValue(action);
                    break;

                case 'onToggleValue':
                    outcome = await handleToggleValue(action);
                    break;

                case 'onRunScript':
                    outcome = await handleRunScript(action);
                    break;

                default:
                    logger.warn('Unknown or unsupported action type: ' + action.action);
                    outcome = { applied: false, reason: 'unsupported-action' };
                    break;
            }
        } catch (error) {
            // The handlers catch their own failures; this is the belt for anything they miss.
            logger.error('Action execution error - Device: ' + deviceName + ', Action: ' + action.action + ', Error: ' + error.message);
            outcome = { applied: false, reason: 'threw', message: error.message };
        }

        const recorded = Object.assign({ action: action.action }, outcome || { applied: false, reason: 'no-outcome' });
        if (recorded.applied) { summary.applied++; }
        else if (recorded.reason === 'missing-variable' || recorded.reason === 'missing-script') { summary.skipped++; }
        else { summary.failed++; }
        summary.results.push(recorded);

        if (!recorded.applied) {
            logger.warn('Scheduler action not applied - scheduler ' + schedulerId + ', device ' + deviceName +
                ', action ' + action.action + ', reason ' + recorded.reason);
        }
    }

    return summary;
}

/**
 * Handle Set Value action server-side
 */
async function handleSetValue(action) {
    if (!action.actoptions?.variable?.variableId) {
        logger.warn('Missing variable ID for set value action');
        return { applied: false, reason: 'missing-variable' };
    }

    const variableId = action.actoptions.variable.variableId;
    let value = action.actparam || '0';

    // Parse value based on variable type
    const variableRaw = action.actoptions.variable.variableRaw;
    if (variableRaw && variableRaw.type === 'number') {
        value = parseFloat(value);
    } else if (variableRaw && variableRaw.type === 'boolean') {
        // One boolean mapping for the whole server (batch 60); the numeric 1 keeps
        // meaning true, which is what this line already did.
        value = utils.parseBoolean(value);
    }

    // Get device ID from tag ID
    const deviceId = runtime.devices.getDeviceIdFromTag(variableId);
    if (!deviceId) {
        logger.error('Device not found for variable: ' + variableId);
        return { applied: false, reason: 'device-not-found' };
    }

    // Handle function (add/remove)
    if (action.actoptions.function) {
        const currentValueObj = runtime.devices.getDeviceValue(deviceId, variableId);
        const currentValue = currentValueObj ? currentValueObj.value : 0;
        if (action.actoptions.function === 'add') {
            value = (parseFloat(currentValue) || 0) + parseFloat(value);
        } else if (action.actoptions.function === 'remove') {
            value = (parseFloat(currentValue) || 0) - parseFloat(value);
        }
    }

    try {
        const result = await runtime.devices.setTagValue(variableId, value);

        if (result) {
            // Get the actual current value from the device to ensure it's properly typed
            const currentValueObj = runtime.devices.getDeviceValue(deviceId, variableId);
            const actualValue = currentValueObj ? currentValueObj.value : value;

            // Directly broadcast to all clients via Socket.IO (bypass subscription filtering)
            const values = {};
            values[variableId] = {
                id: variableId,
                value: actualValue,
                timestamp: Date.now()
            };

            // Force broadcast to ALL clients
            runtime.io.emit('device-values', {
                id: deviceId,
                values: [values[variableId]]
            });
            return { applied: true };
        }
        // The write reported failure. It used to be logged nowhere at all - this function returned
        // undefined on every path, so a scheduler that could not apply its action was
        // indistinguishable from one that applied it.
        logger.error('Scheduler set value not applied: ' + variableId);
        return { applied: false, reason: 'write-refused' };
    } catch (error) {
        logger.error('Error setting value: ' + error.message);
        return { applied: false, reason: 'threw', message: error.message };
    }
}

/**
 * Handle Toggle Value action server-side
 */
async function handleToggleValue(action) {
    if (!action.actoptions?.variable?.variableId) {
        logger.warn('Missing variable ID for toggle action');
        return { applied: false, reason: 'missing-variable' };
    }

    const variableId = action.actoptions.variable.variableId;
    const bitmask = action.actoptions.variable.bitmask;

    // Get device ID from tag ID
    const deviceId = runtime.devices.getDeviceIdFromTag(variableId);
    if (!deviceId) {
        logger.error('Device not found for variable: ' + variableId);
        return { applied: false, reason: 'device-not-found' };
    }

    const currentValueObj = runtime.devices.getDeviceValue(deviceId, variableId);
    const currentValue = currentValueObj ? currentValueObj.value : 0;

    let newValue;
    if (bitmask) {
        // Toggle specific bit(s)
        newValue = (parseInt(currentValue) || 0) ^ bitmask;
    } else {
        // Toggle boolean
        newValue = currentValue ? 0 : 1;
    }

    try {
        const result = await runtime.devices.setTagValue(variableId, newValue);

        if (result) {
            // Get the actual current value to confirm
            const actualValueObj = runtime.devices.getDeviceValue(deviceId, variableId);
            const actualValue = actualValueObj ? actualValueObj.value : newValue;

            // Directly broadcast to all clients via Socket.IO (bypass subscription filtering)
            const values = {};
            values[variableId] = {
                id: variableId,
                value: actualValue,
                timestamp: Date.now()
            };

            // Force broadcast to ALL clients
            runtime.io.emit('device-values', {
                id: deviceId,
                values: [values[variableId]]
            });
            return { applied: true };
        }
        logger.error('Scheduler toggle not applied: ' + variableId);
        return { applied: false, reason: 'write-refused' };
    } catch (error) {
        logger.error('Error toggling value: ' + error.message);
        return { applied: false, reason: 'threw', message: error.message };
    }
}

/**
 * Handle Run Script action server-side
 */
async function handleRunScript(action) {
    if (!action.actparam) {
        logger.warn('Missing script ID for run script action');
        return { applied: false, reason: 'missing-script' };
    }

    const scriptId = action.actparam;

    // Create script object to execute
    const script = {
        id: scriptId,
        name: null,
        parameters: action.actoptions?.params || null,
        notLog: true
    };

    try {
        await runtime.scriptsMgr.runScript(script, true);

        // After script execution, broadcast all SCADIA Server device tags to ensure clients see any changes
        // Scripts can modify internal tags, so we need to force an update by triggering a device value change event
        const allDeviceValues = runtime.devices.getDevicesValues();

        // Emit device-value:changed for each device that has values
        for (const deviceId in allDeviceValues) {
            const deviceTags = allDeviceValues[deviceId];
            if (deviceTags && Object.keys(deviceTags).length > 0) {
                // Build values object with current tag values
                const values = {};
                for (const tagId in deviceTags) {
                    const tagValue = runtime.devices.getDeviceValue(deviceId, tagId);
                    if (tagValue) {
                        values[tagId] = tagValue;
                    }
                }

                if (Object.keys(values).length > 0) {
                    // Directly broadcast to all clients via Socket.IO
                    runtime.io.emit('device-values', {
                        id: deviceId,
                        values: Object.values(values)
                    });
                }
            }
        }
        return { applied: true };
    } catch (error) {
        logger.error('Script execution error: ' + error.message);
        return { applied: false, reason: 'threw', message: error.message };
    }
}

module.exports = {
    init,
    updateScheduler,
    stopScheduler,
    removeScheduler,
    /**
     * Test seam: the action executor, so its outcome summary can be asserted without standing up
     * node-schedule jobs, a storage backend and a live device.
     */
    executeDeviceActions: executeDeviceActions,
    /**
     * Test seam: the two pieces of master control. Both are reached from a tag-change event, which
     * cannot be arranged from outside the module without a storage backend.
     */
    writeTagFromEvent: writeTagFromEvent,
    checkIfAnyEventActive: checkIfAnyEventActive,
    /**
     * Test seam: the state broadcast and the week-edge helper. Both are reached from a scheduled
     * job, and arranging a real node-schedule job to observe one emit is not a test of this code.
     */
    checkAndNotifyEventState: checkAndNotifyEventState,
    isLastDayOfWeekForEvent: isLastDayOfWeekForEvent,
    /**
     * Test seam: the master-control latch release. Reached from updateScheduler, which needs a
     * storage backend and node-schedule to drive from outside.
     */
    handleTagChanges: handleTagChanges,
    /**
     * Test seam: the deletion path. Reached from updateScheduler, which needs storage and
     * node-schedule to drive from outside.
     */
    handleEventDeletions: handleEventDeletions,
    /** Test seam: the recurrence-rule input, without node-schedule. */
    buildEventScheduleSpec: buildEventScheduleSpec,
    /** Test seam: the one-time removal path and its job-id rule. */
    removeOneTimeEvent: removeOneTimeEvent,
    jobIdBaseFor: jobIdBaseFor,
    /** Test seams: job bookkeeping, without node-schedule. */
    registerJobForTest: registerJobForTest,
    registeredJobIds: registeredJobIds,
    clearAllJobsForTest: clearAllJobsForTest,
    jobBelongsToScheduler: jobBelongsToScheduler,
    /** Test seams: the two per-device passes, without storage or node-schedule. */
    setInitialStates: setInitialStates,
    createSchedulerJobs: createSchedulerJobs,
    /** Test seam: the one label builder every emit and log line goes through. */
    buildEventLabel: buildEventLabel,
    /** Test seams: the shared payload and day-index builders, and the notify pass. */
    buildEventPayload: buildEventPayload,
    eventDayNumbers: eventDayNumbers,
    notifyEventStates: notifyEventStates,
    /** Test seam: the startup device-actions recovery. */
    syncDeviceActionsFromProject: syncDeviceActionsFromProject,
    /** Test seam: the completion decision shared by the duration, end and modified-duration paths. */
    handleEventCompletion: handleEventCompletion,
    /** Test seams: the Event Mode tracking key and the "can this be armed" question. */
    eventTrackId: eventTrackId,
    canArmEventMode: canArmEventMode,
    getActiveEventModeSchedules: () => activeEventModeSchedules,
    /** Test seam: one event job, with node-schedule replaced by the test. */
    createEventJob: createEventJob,
    /** Test seam: the update pass that sequences the four paths above. */
    updateScheduler: updateScheduler
};
