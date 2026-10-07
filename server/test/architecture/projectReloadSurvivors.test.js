/**
 * A project reload must not disable the services whose data is not project data (batch 75).
 *
 * WHAT WAS WRONG. restart() = stop() then start(). stop() closed the camera and calibration stores;
 * start() re-starts devices, alarms, notificator, scripts and jobs - and re-inits neither of those two.
 * So after any `POST /api/project` (the UI's "load project") the camera routes answered 503
 * CAM_NOT_READY and the calibration routes answered 500 "calibration service not initialized",
 * for the rest of the session. Measured on a running instance: before an import GET /api/cameras was
 * 200 {"cameras":[]}, and after it 503 - permanently.
 *
 * WHY IT IS WRONG RATHER THAN MERELY UNTIDY. Cameras and calibration keep their data in the
 * APPLICATION's workDir (<workDir>/_appdata/cameras.scadiap.db, calibration.scadiap.db), not in the
 * project. A project reload has no reason to touch them, and a service that is stopped for a reason
 * that does not apply must not be stopped.
 *
 * The contrast that keeps this honest: opcua-server IS project-dependent (it publishes the project's
 * devices and cameras), so it is deliberately left in stop() - and it is disabled by default.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const RUNTIME = path.join(SERVER_ROOT, 'runtime', 'index.js');
const CAMERAS_API = path.join(SERVER_ROOT, 'api', 'cameras', 'index.js');
const RESOURCES_API = path.join(SERVER_ROOT, 'api', 'resources', 'index.js');

/** Code lines only: a comment that mentions the old call is documentation. */
function code(file) {
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
}

describe('a project reload keeps the services whose data is not project data', () => {
    const runtime = code(RUNTIME);

    it('the files were found', function () {
        [RUNTIME, CAMERAS_API, RESOURCES_API].forEach((f) => {
            expect(fs.existsSync(f), 'missing: ' + f).to.equal(true);
        });
        expect(runtime.length, 'runtime/index.js read as empty').to.be.greaterThan(1000);
    });

    it('stop() no longer closes the camera and calibration stores', function () {
        const stop = runtime.slice(runtime.indexOf('function stop()'));
        const body = stop.slice(0, stop.indexOf('\n}'));
        expect(body, 'stop() exists').to.contain('devices.stop()');
        expect(body, 'cameras keep their data in the app workDir, not in the project: closing the ' +
            'store on a project reload left every camera route at 503 until the process restarted')
            .to.not.match(/cameras\.stop\(/);
        expect(body, 'same for calibration: its routes answered 500 "calibration service not ' +
            'initialized" after every project load').to.not.match(/calibration\.stop\(/);
    });

    it('both are still initialised, so the fix is not "initialise nothing"', function () {
        expect(runtime, 'runtime/index.js no longer initialises cameras').to.contain('cameras.init(settings, logger, runtime)');
        expect(runtime, 'runtime/index.js no longer initialises calibration').to.contain('calibration.init(settings, logger, runtime)');
    });

    it('the camera list answers an empty inventory while the store is unavailable', function () {
        const api = code(CAMERAS_API);
        expect(api, 'the camera list route must tolerate a store that is not open yet: an empty ' +
            'inventory is the honest answer to "which cameras are configured?"').to.contain('listCamerasOrNone');
        expect(api, 'the not-ready case must produce an empty list, not a 500').to.contain('emptyInventory');
        expect(api, 'the other camera routes keep their 503: they name a resource that cannot be served')
            .to.contain('CAM_NOT_READY');
    });

    it('the template routes say 501 instead of throwing into an HTML 500', function () {
        const api = code(RESOURCES_API);
        expect(api, 'runtime.resourcesMgr is never created anywhere - reaching for it is a guaranteed ' +
            'TypeError').to.not.match(/runtime\.resourcesMgr\./);
        const calls = api.split("sendTemplatesNotImplemented(res, '").length - 1;   // call sites only, not the definition
        expect(calls, 'all three template routes (get / set / remove) must answer the coded 501').to.equal(3);
        expect(api).to.contain('RES_TEMPLATES_NOT_IMPLEMENTED');
    });
});
