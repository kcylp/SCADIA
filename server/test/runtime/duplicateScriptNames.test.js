/**
 * Two scripts with the SAME NAME must both be scheduled, and both must stay addressable.
 *
 * THE DEFECT THIS CLOSES (measured 2026-10-06). Both script maps were keyed by the display name:
 *
 *   runtime/scripts/msm.js   result.scriptsMap[script.name] = script;
 *   runtime/scripts/index.js schedulingMap[script.name] = scriptSchedule;
 *
 * A name is free text a project may repeat, so with two scripts called 'Twin':
 *   - the second REPLACED the first in schedulingMap: one of them was never run again, silently;
 *   - the second replaced the first in scriptsMap too, so getScript() could not find it,
 *     isAuthorised() read .permissionRoles off undefined, threw, and answered "not authorised".
 * Nothing was logged anywhere - the project simply behaved as if one script did not exist.
 *
 * Both maps are keyed by script id now (name is only the fallback for scripts without one), which is
 * the identity the platform already uses to name the generated functions (_toFuncName).
 */

'use strict';

const path = require('path');
const { expect } = require('chai');

const msm = require(path.join(__dirname, '..', '..', 'runtime', 'scripts', 'msm'));
const scriptsManager = require(path.join(__dirname, '..', '..', 'runtime', 'scripts', 'index'));

const silentLogger = { info() { }, warn() { }, error() { }, debug() { } };

function twin(id, code) {
    return {
        id: id,
        name: 'Twin',
        code: code,
        sync: false,
        parameters: [],
        // SERVER mode: the /home-vs-/view client question does not apply here, this is the
        // server-side scheduler.
        mode: 'SERVER',
        scheduling: { mode: 'interval', interval: 1, schedules: [] }
    };
}

describe('two scripts with the same name', () => {
    describe('the script module (msm)', () => {
        it('keeps both, addressable by id', () => {
            const mod = msm.create({ emit() { } }, silentLogger);
            const result = mod.loadScripts([twin('s_twin_a', 'return "A";'), twin('s_twin_b', 'return "B";')]);

            expect(Object.keys(result.scriptsMap).length, 'both scripts must survive loadScripts').to.equal(2);
            expect(mod.getScript({ id: 's_twin_a' }).code).to.equal('return "A";');
            expect(mod.getScript({ id: 's_twin_b' }).code).to.equal('return "B";');
        });

        it('runs the one it was asked for, not the one that happens to share its name', async () => {
            const mod = msm.create({ emit() { } }, silentLogger);
            global.__twinRuns = [];
            mod.loadScripts([
                twin('s_twin_a', 'global.__twinRuns.push("A"); return "A";'),
                twin('s_twin_b', 'global.__twinRuns.push("B"); return "B";')
            ]);

            await mod.runScriptWithoutParameter({ id: 's_twin_a' });
            expect(global.__twinRuns).to.deep.equal(['A']);
            await mod.runScriptWithoutParameter({ id: 's_twin_b' });
            expect(global.__twinRuns).to.deep.equal(['A', 'B']);
        });
    });

    describe('the server scheduler (runtime/scripts)', () => {
        it('schedules and runs BOTH, each in its own interval', async function () {
            this.timeout(20000);

            global.__twinRuns = [];
            const scripts = [
                twin('s_twin_a', 'global.__twinRuns.push("A");'),
                twin('s_twin_b', 'global.__twinRuns.push("B");')
            ];
            const runtime = {
                events: { emit() { } },
                logger: silentLogger,
                settings: {},
                devices: {},
                scriptSendCommand() { },
                notificatorMgr: {},
                alarmsMgr: {},
                project: { getScripts: () => Promise.resolve(scripts) }
            };

            const manager = scriptsManager.create(runtime);
            await manager.start();
            try {
                // The manager is a state machine that advances one step per 1000ms tick
                // (INIT -> LOAD -> IDLE); the first IDLE tick runs every script whose interval has
                // elapsed. 4 seconds covers the transitions with room to spare.
                await new Promise(r => setTimeout(r, 4000));
            } finally {
                await manager.stop();
            }

            expect(global.__twinRuns.includes('A'), 'script A (id s_twin_a) never ran').to.equal(true);
            expect(global.__twinRuns.includes('B'), 'script B (id s_twin_b) never ran').to.equal(true);
        });
    });
});
