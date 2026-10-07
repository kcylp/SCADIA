/**
 * Layout tolerance probe - drives the REAL permission filter with a project whose layout row is
 * incomplete, and reports what came back instead of what the guard hopes came back.
 *
 * Why a child process with a stubbed dependency:
 *
 *   _filterProjectPermission() is not exported, and it is the only place that reads
 *   hmi.layout.navigation / hmi.layout.header. Exporting it would mean shipping a function
 *   that exists for the test. Instead this probe loads the real module and intercepts its ONE
 *   dependency on the persistence layer (./prjstorage), so init() binds no database but every
 *   line of the filter, the optional chaining and the permission loop is the shipped code.
 *
 *   The project data is seeded through the module's own public seam (setProjectData,
 *   the same path the editor uses on every save), so the fixture travels the real code path
 *   instead of being poked into a private variable.
 *
 * The scenarios are NOT invented: {start:'x'} without navigation/header is exactly what the
 * showroom project had, and 'start' alone is what the editor's layout section writes when the
 * user has never opened the navigation or header tabs. A layout row that is not an object at
 * all is what a hand-edited database or an old export produces.
 *
 * The answer goes to a FILE, not stdout: capturing a child's piped stdout hangs in this
 * environment (same reason routing-probe.js writes a file).
 *
 * usage: node layout-fallback-probe.js <output-file>
 */

'use strict';

const fs = require('fs');
const Module = require('module');
const path = require('path');

function probe(outFile) {

    const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
    const PROJECT_MODULE = path.join(SERVER_ROOT, 'runtime', 'project', 'index.js');

    // Every call the filter makes is recorded, so "did it silently do nothing" is distinguishable
    // from "it worked": a filter that never asks about permission is not filtering.
    const systemCalls = [];

    const runtimeStub = {
        checkPermission: function (userPermission, contextPermission, isHeader, isViewItem) {
            systemCalls.push({ contextPermission: contextPermission, isHeader: !!isHeader, isViewItem: !!isViewItem });
            // Show everything, enable everything: this probe measures tolerance, not authorisation.
            return { show: true, enabled: true };
        }
    };

    const loggerStub = {
        info: function () {}, debug: function () {}, warn: function () {}, error: function () {}
    };

    // The persistence layer is the only thing replaced. Nothing else in the module is touched.
    const prjstorageStub = {
        init: function () { return Promise.resolve(true); },
        TableType: {
            GENERAL: 'general', DEVICES: 'devices', VIEWS: 'views', DEVICESSECURITY: 'devicesSecurity',
            TEXTS: 'texts', ALARMS: 'alarms', RECIPES: 'recipes', NOTIFICATIONS: 'notifications',
            SCRIPTS: 'scripts', REPORTS: 'reports', LOCATIONS: 'locations', ARMARKERS: 'arMarkers'
        },
        getSection: function () { return Promise.resolve([]); },
        setSection: function () { return Promise.resolve(); },
        setSections: function () { return Promise.resolve(); },
        deleteSection: function () { return Promise.resolve(); },
        clearAll: function () { return Promise.resolve(); },
        setDefault: function () { return Promise.resolve(); }
    };

    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (/^\.\/prjstorage$/.test(request) && parent && /runtime[\\/]project[\\/]index\.js$/.test(parent.filename || '')) {
            return prjstorageStub;
        }
        return realLoad.apply(this, arguments);
    };

    let project;
    try {
        project = require(PROJECT_MODULE);
    } finally {
        Module._load = realLoad;
    }

    /**
     * One incomplete layout a real project has actually carried.
     *
     * ORDER MATTERS: this is one process with one in-memory project, which is how the module
     * behaves in the server. Every scenario therefore states its own layout explicitly, and the
     * first one seeds nothing so that "no layout row at all" is measured on a pristine project
     * rather than on the leftovers of the previous scenario. The test asserts this order.
     */
    const SCENARIOS = [
        {
            id: 'layout-never-written',
            from: 'a project whose layout row was never written',
            layout: undefined,
            views: [{ id: 'view1', name: 'view1', type: 'svg', svgcontent: '<svg id="view1"></svg>' }]
        },
        {
            id: 'start-only',
            from: "a hand-written layout row: {start:'view1'}",
            layout: { start: 'view1' },
            views: [{ id: 'view1', name: 'view1', type: 'svg', svgcontent: '<svg id="view1"><title>view1</title></svg>' }],
            navigationExpected: false,
            headerExpected: false
        },
        {
            id: 'empty-layout',
            from: 'an empty layout row: {}',
            layout: {},
            views: [{ id: 'view1', name: 'view1', type: 'svg', svgcontent: '<svg id="view1"></svg>' }],
            navigationExpected: false,
            headerExpected: false
        },
        {
            id: 'layout-with-navigation-only',
            from: 'a layout that has navigation but no header',
            layout: { start: 'view1', navigation: { items: [{ id: 'nav1', property: {} }] } },
            views: [{ id: 'view1', name: 'view1', type: 'svg', svgcontent: '<svg id="view1"></svg>' }],
            navigationExpected: true,
            headerExpected: false
        },
        {
            id: 'one-screen',
            from: 'a project with a single screen and a layout row that says nothing',
            layout: {},
            views: [{ id: 'view1', name: 'view1', type: 'svg', svgcontent: '<svg id="view1"></svg>' }]
        }
    ];

    const results = [];

    (async function run() {
        await project.init({}, loggerStub, runtimeStub);
        // The module keeps the project in memory and fills it in load(). Seeding before load()
        // would write into an object load() then replaces, which is how a probe ends up measuring
        // its own fixture instead of the shipped path.
        await project.load();

        for (const scenario of SCENARIOS) {
            const record = { id: scenario.id, from: scenario.from };
            systemCalls.length = 0;
            try {
                // Seed through the module's own public seam.
                if (scenario.layout !== undefined) {
                    await project.setProjectData('layout', scenario.layout);
                }
                for (const view of scenario.views) {
                    await project.setProjectData('set-view', view);
                }
                const out = await project.getProject('admin', false, {});
                record.ok = true;
                record.status = 200;
                record.layoutKeys = out && out.hmi && out.hmi.layout
                    ? Object.keys(out.hmi.layout).sort()
                    : null;
                record.hasNavigationItems = !!(out && out.hmi && out.hmi.layout && out.hmi.layout.navigation && out.hmi.layout.navigation.items);
                record.hasHeaderItems = !!(out && out.hmi && out.hmi.layout && out.hmi.layout.header && out.hmi.layout.header.items);
                record.viewCount = out && out.hmi && Array.isArray(out.hmi.views) ? out.hmi.views.length : null;
                record.permissionChecks = systemCalls.length;
            } catch (err) {
                record.ok = false;
                record.status = 400;
                record.error = (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err));
            }
            results.push(record);
        }

        fs.writeFileSync(outFile, JSON.stringify({ results: results }, null, 2), 'utf8');
        process.exit(0);
    })().catch((err) => {
        fs.writeFileSync(outFile, JSON.stringify({ fatal: (err && err.stack) || String(err) }, null, 2), 'utf8');
        process.exit(1);
    });
}

// Mocha --recursive loads EVERY .js under test/ as a spec file, so this module must do nothing
// at all when it is required rather than run. Guarded, and enforced by scannerContract.test.js.
if (require.main === module) {
    const outFile = process.argv[2];
    if (!outFile) { throw new Error('layout-fallback-probe: an output file path is required'); }
    probe(outFile);
}
