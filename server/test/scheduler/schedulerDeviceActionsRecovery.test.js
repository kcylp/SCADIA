'use strict';

/**
 * Recovering a scheduler's device actions from the project.
 *
 * Twelfth file of scheduler coverage. `syncDeviceActionsFromProject` runs once, at startup, inside
 * loadSchedulers. It exists because a scheduler's device actions live in TWO places: the gauge view
 * item's `property.deviceActions`, and a copy in `scheduler.data.settings.deviceActions`. When the
 * copy is missing - a project saved by an older build, or edited outside the gauge - NO ACTION EVER
 * FIRES, and the only symptom is a scheduler that runs and does nothing.
 *
 * The precedence is the part worth pinning: the STORED copy wins, and the project is only consulted
 * when it is absent. Getting that backwards would silently overwrite a newer stored configuration
 * with a stale view copy every time the server started.
 */

const sinon = require('sinon');
const { expect } = require('chai');

const scheduler = require('../../runtime/scheduler/scheduler-service');

function loadService() {
    const logger = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
    const saved = [];
    const runtime = {
        logger: logger,
        io: { emit: sinon.stub(), on: sinon.stub() },
        events: { on: sinon.stub(), emit: sinon.stub() },
        devices: { setTagValue: sinon.stub().resolves(true) },
        schedulerStorage: {
            getAllSchedulers: sinon.stub().resolves([]),
            setSchedulerData: (id, data) => { saved.push({ id: id, data: data }); return Promise.resolve(true); }
        },
        scriptsMgr: { runScript: sinon.stub().resolves(true) }
    };
    delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    const service = require('../../runtime/scheduler/scheduler-service');
    service.init({}, logger, runtime);
    return { service: service, logger: logger, saved: saved };
}

/** Project data shaped the way the runtime hands it to this pass. */
function projectWith(views) {
    return { hmi: { views: views } };
}

/** One view holding one gauge item. */
function viewWithItem(itemId, schedulerId, deviceActions) {
    return { items: { [itemId]: { id: schedulerId, property: { deviceActions: deviceActions } } } };
}

const ACTIONS = [{ deviceName: 'device-a', action: 'onSetValue', actparam: '1' }];

describe('scheduler device-actions recovery at startup', () => {
    afterEach(() => {
        sinon.restore();
        delete require.cache[require.resolve('../../runtime/scheduler/scheduler-service')];
    });

    it('copies the actions from the view into the scheduler and saves them', async function () {
        const ctx = loadService();
        const schedulerRecord = { id: 'sch1', data: { settings: {}, schedules: {} } };

        const recovered = await ctx.service.syncDeviceActionsFromProject(
            schedulerRecord, projectWith([viewWithItem('item-1', 'sch1', ACTIONS)]));

        expect(recovered).to.equal(true);
        expect(schedulerRecord.data.settings.deviceActions).to.deep.equal(ACTIONS);
        expect(ctx.saved, 'the recovered actions are persisted, or they are lost again on restart').to.have.length(1);
        expect(ctx.saved[0].id).to.equal('sch1');
    });

    it('creates settings when the record has none at all', async function () {
        const ctx = loadService();
        const schedulerRecord = { id: 'sch1', data: {} };
        await ctx.service.syncDeviceActionsFromProject(
            schedulerRecord, projectWith([viewWithItem('item-1', 'sch1', ACTIONS)]));
        expect(schedulerRecord.data.settings.deviceActions).to.deep.equal(ACTIONS);
    });

    it('the STORED actions win: the project is not consulted and nothing is written', async function () {
        // The precedence that matters. If this were reversed, every server start would overwrite a
        // newer stored configuration with a stale copy from the view.
        const ctx = loadService();
        const stored = [{ deviceName: 'device-z', action: 'onRunScript', actparam: 'newer' }];
        const schedulerRecord = { id: 'sch1', data: { settings: { deviceActions: stored } } };

        const recovered = await ctx.service.syncDeviceActionsFromProject(
            schedulerRecord, projectWith([viewWithItem('item-1', 'sch1', ACTIONS)]));

        expect(recovered).to.equal(false);
        expect(schedulerRecord.data.settings.deviceActions).to.deep.equal(stored);
        expect(ctx.saved).to.deep.equal([]);
    });

    it('finds the item in a LATER view, not just the first', async function () {
        const ctx = loadService();
        const schedulerRecord = { id: 'sch1', data: { settings: {} } };
        const recovered = await ctx.service.syncDeviceActionsFromProject(schedulerRecord, projectWith([
            { items: {} },
            { items: { other: { id: 'sch2', property: { deviceActions: ACTIONS } } } },
            viewWithItem('item-3', 'sch1', ACTIONS)
        ]));
        expect(recovered).to.equal(true);
    });

    it('does not recover another scheduler\'s actions', async function () {
        const ctx = loadService();
        const schedulerRecord = { id: 'sch1', data: { settings: {} } };
        const recovered = await ctx.service.syncDeviceActionsFromProject(
            schedulerRecord, projectWith([viewWithItem('item-1', 'sch2', ACTIONS)]));
        expect(recovered).to.equal(false);
        expect(schedulerRecord.data.settings.deviceActions).to.equal(undefined);
    });

    it('an item with the right id but NO deviceActions is not a match', async function () {
        // Otherwise a gauge that never had actions would clear the record's settings by writing
        // undefined over them.
        const ctx = loadService();
        const schedulerRecord = { id: 'sch1', data: { settings: {} } };
        const recovered = await ctx.service.syncDeviceActionsFromProject(
            schedulerRecord, projectWith([{ items: { i: { id: 'sch1', property: { other: 1 } } } }]));
        expect(recovered).to.equal(false);
    });

    it('malformed project or scheduler input recovers nothing and does not throw', async function () {
        const ctx = loadService();
        for (const project of [null, undefined, {}, { hmi: {} }, { hmi: { views: null } }, { hmi: { views: [] } }]) {
            const recovered = await ctx.service.syncDeviceActionsFromProject({ id: 'sch1', data: { settings: {} } }, project);
            expect(recovered).to.equal(false);
        }
        for (const record of [null, undefined, {}, { id: 'sch1' }, { data: {} }]) {
            expect(await ctx.service.syncDeviceActionsFromProject(record, projectWith([viewWithItem('i', 'sch1', ACTIONS)])))
                .to.equal(false);
        }
    });

    it('a view or item that is null is skipped rather than crashing the startup pass', async function () {
        const ctx = loadService();
        const schedulerRecord = { id: 'sch1', data: { settings: {} } };
        const recovered = await ctx.service.syncDeviceActionsFromProject(schedulerRecord, projectWith([
            null,
            { items: null },
            { items: { good: null, also: { id: 'sch1', property: { deviceActions: ACTIONS } } } }
        ]));
        expect(recovered).to.equal(true);
        expect(schedulerRecord.data.settings.deviceActions).to.deep.equal(ACTIONS);
    });
});
