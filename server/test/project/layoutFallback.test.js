/**
 * A project whose layout row is incomplete must still answer GET /api/project.
 *
 * The defect this guards (P0-2, the one that produced a showroom full of empty canvases):
 * the layout row in the project database held only {start:'x'}. The permission filter read
 * result.hmi.layout.navigation.items straight through, threw inside the promise chain, and
 * api/projects/index.js turned the throw into a 400 - so the whole project failed to load,
 * the client kept its loading overlay, and nothing anywhere said why.
 *
 * The fix is optional chaining at the two read sites, and it is easy to undo by accident:
 * the next feature that needs a navigation item will happily write the unguarded form again.
 * This test drives the REAL filter (see _support/layout-fallback-probe.js for why it runs as
 * a child process) and asserts, for each shape a real project has carried, that the read
 * completes and that what came back is what the project actually contained.
 *
 * It also asserts the filter RAN. A tolerance test that passes because the code path was
 * skipped is worse than no test: it would stay green if the filter were deleted entirely.
 *
 * It also asserts nothing was INVENTED. Filling the gaps in - `navigation = navigation || {items: []}` -
 * would make the failure go away while changing what the client sees, and the client decides
 * which screen to open from what is present. Tolerance means reading a partial row, not
 * rewriting it.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. Measured, not assumed:
 *
 *   - it exercises the real module end to end (real getProject, real filter, real layout
 *     handling) against five incomplete layouts, and reports what came back;
 *   - it CANNOT prove the guard by behaviour. With the persistence layer stubbed for the probe,
 *     this fixture never enters the permission block that holds the guard - verified by
 *     removing the optional chaining and watching every scenario still return 200. A suite that
 *     stays green with the defect present is worse than no suite, so the guard itself is pinned
 *     structurally below, where an edit to either condition is a failure by construction.
 *
 * The two halves cover different mistakes: the scenarios catch a filter that starts inventing
 * or dropping layout content, and the structural pin catches the guard being rewritten - which
 * is exactly how it would come back, since "layout.navigation.items" reads perfectly well.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const PROBE = path.join(__dirname, '_support', 'layout-fallback-probe.js');

/** The shapes a shipped project has actually carried. The probe seeds them in this order. */
const SCENARIOS = [
    {
        id: 'layout-never-written',
        note: 'no layout row at all - a project given nothing but screens',
        provided: []
    },
    {
        id: 'start-only',
        note: "{start:'view1'} without navigation or header - the shape that blanked the showroom",
        provided: ['start']
    },
    {
        id: 'empty-layout',
        note: '{} - an editor that saved the layout section before it had any content',
        provided: []
    },
    {
        id: 'layout-with-navigation-only',
        note: 'navigation present, header absent - a half-configured layout',
        provided: ['navigation', 'start']
    },
    {
        id: 'one-screen',
        note: 'one screen and a layout row that says nothing',
        provided: []
    }
];

/**
 * The permission filter must read a partial layout row through BOTH guards, and the view loop
 * that follows them is deliberately unguarded (load() always initialises hmi.views to []).
 */
const PROJECT_MODULE = path.join(SERVER_ROOT, 'runtime', 'project', 'index.js');
const NAVIGATION_GUARD = 'if (result.hmi.layout && result.hmi.layout.navigation.items) {';
const HEADER_GUARD = 'if (result.hmi.layout && result.hmi.layout.header.items) {';
/**
 * The views permission loop, in the guarded form N-2 asked for (batch 56).
 *
 * This used to be the UNGUARDED line, and the test asserted that IT was still present - a
 * dependency note, not a requirement. Both the constant and the assertion moved together, which is
 * the only honest way to close a finding that a test was pinning as a known gap.
 */
const VIEWS_LOOP = 'Array.isArray(result.hmi.views) && i < result.hmi.views.length';
/** The shape that used to be here, and must not come back. */
const VIEWS_LOOP_UNGUARDED = 'for (var i = 0; i < result.hmi.views.length; i++) {';

describe('the layout guards are still written as guards (the shape P0-2 was fixed into)', () => {
    const source = fs.readFileSync(PROJECT_MODULE, 'utf8');

    it('the navigation guard reads result.hmi.layout before its navigation', function () {
        expect(source.split(NAVIGATION_GUARD).length - 1,
            'the navigation permission guard no longer reads: ' + NAVIGATION_GUARD).to.equal(1);
    });

    it('the header guard reads result.hmi.layout before its header', function () {
        expect(source.split(HEADER_GUARD).length - 1,
            'the header permission guard no longer reads: ' + HEADER_GUARD).to.equal(1);
    });

    it('neither guard was replaced by optional chaining alone on the inner read', function () {
        // `result.hmi.layout?.navigation.items` and `result.hmi.layout.navigation?.items` both
        // survive a partial layout, but only the form above also survives an ABSENT one, and the
        // absent case is the one the client hits when a project has never opened the layout tab.
        expect(source.indexOf('result.hmi.layout?.navigation'), 'optional chaining replaced the guard').to.equal(-1);
        expect(source.indexOf('result.hmi.layout.navigation?.items'), 'optional chaining replaced the guard').to.equal(-1);
    });

    it('the view permission loop is guarded too, like its two neighbours (N-2 closed)', function () {
        // This test used to record the OPPOSITE: "the view permission loop is the only layout read
        // without a guard, and it is reachable" - a dependency note saying that only load()'s
        // initialisation of hmi.views kept it from throwing. N-2 was that note being acted on
        // (batch 56): the loop now checks the array it walks, exactly like the navigation and header
        // loops above it. The assertion therefore flipped from "the unguarded form is still there"
        // to "the guarded form is there, and the unguarded one is gone".
        expect(source.indexOf(VIEWS_LOOP), 'the view permission loop moved or was removed').to.be.greaterThan(-1);
        expect(source.indexOf(VIEWS_LOOP_UNGUARDED),
            'the views loop lost its guard again - it would throw on a project with no views, ' +
            'taking the whole /api/project response with it').to.equal(-1);
    });
});

describe('project layout tolerance (an incomplete layout row must not 4xx the whole project)', () => {
    let results;
    let fatal;

    before(function () {
        this.timeout(60000);
        const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-layout-')), 'probe.json');
        try {
            execFileSync(process.execPath, [PROBE, outFile], { cwd: SERVER_ROOT, timeout: 45000 });
        } catch (err) {
            // the probe writes its answer before exiting; a non-zero exit still has output
        }
        const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
        const parsed = raw ? JSON.parse(raw) : {};
        fatal = parsed.fatal || null;
        results = parsed.results || [];
    });

    it('the probe ran and answered for every scenario, in order', function () {
        expect(fatal, 'layout probe fatality: ' + fatal).to.equal(null);
        expect(results.map((r) => r.id)).to.deep.equal(SCENARIOS.map((s) => s.id));
    });

    SCENARIOS.forEach((scenario) => {
        describe(scenario.note, () => {
            let record;

            before(() => { record = results.filter((r) => r.id === scenario.id)[0]; });

            it('reads the project without throwing (what the API turns into HTTP 200)', function () {
                expect(record, 'no probe record for ' + scenario.id).to.not.equal(undefined);
                expect(record.ok, 'the read failed with: ' + (record.error || '')).to.equal(true);
                expect(record.status).to.equal(200);
            });

            it('runs the permission filter over the project', function () {
                // The filter asks about the project itself at least once. If this is 0 the rest
                // of this describe proves nothing: it would pass on an empty code path.
                expect(record.permissionChecks, 'the permission filter never ran').to.be.greaterThan(0);
            });

            it('keeps every screen', function () {
                expect(record.viewCount).to.equal(1);
            });

            it('returns exactly the layout keys the project had, and invents none', function () {
                expect(record.layoutKeys === null ? [] : record.layoutKeys).to.deep.equal(scenario.provided);
            });

            it('never invents navigation or header content', function () {
                // navigation is only ever what the project contained, and header never appears
                // in these fixtures at all - so both answers are fixed for every scenario.
                expect(record.hasHeaderItems, 'header items were invented').to.equal(false);
                expect(record.hasNavigationItems, 'navigation items were invented')
                    .to.equal(scenario.provided.indexOf('navigation') !== -1);
            });
        });
    });
});
