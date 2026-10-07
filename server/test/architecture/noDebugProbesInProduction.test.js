/**
 * No ad-hoc debug instrumentation may reach the production tree (N-46, batch 79).
 *
 * WHAT WAS WRONG. api/cameras/index.js carried
 *     runtime.logger.error('PROBE-STACK ' + (err && err.stack));   // TEMPORARY probe
 * inside the camera list route's "not ready" branch. Since batch 76 that branch is a NORMAL path
 * (a store that is not open yet answers an empty inventory), so every not-ready list request wrote
 * a full stack trace into the operator's log. Seen in the field: _probe75/probe.log lines 32 and 52.
 * A shipped product must not shout PROBE-STACK at its operator, and the line above it already logs
 * the failure by domain code - so the probe was pure noise.
 *
 * WHY THIS GUARD IS NARROW (measured, not guessed). "PROBE" and "TEMPORARY" are legitimate
 * identifiers in this repository: PROBE_TIMEOUT (runtime/cameras/fusion.js), SCRIPT_PROBES
 * (runtime/jobs/helper/font-coverage.js), PROBE_TAG and PROBED_BACKEND (test/**). A guard that
 * banned the words would be all false positives. So it bans the two measured IDIOMS of an ad-hoc
 * debug probe instead:
 *   - the string literal marker PROBE-STACK   (how the offender named itself in the log)
 *   - a comment reading "TEMPORARY probe"     (how the offender labelled itself in the source)
 * The scan set mirrors the production half of `npm run test:lint` - test/** is deliberately out of
 * scope, because tests may legitimately use probe helpers.
 *
 * THE SCAN ITSELF IS ASSERTED. A guard that silently scans zero files reports green forever
 * (batch 52 paid for this lesson), so the file count and two known members are asserted, and the
 * matcher is fed the exact offending line to prove it still fires.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const DIRS = ['api', 'runtime', 'integrations', 'scripts'];
const ROOT_FILES = ['main.js', 'scadia.js', 'paths.js', 'envParams.js', 'settings.default.js'];

/** Every production .js file, with the path relative to the server root. */
function productionFiles() {
    const out = [];
    const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            const r = rel ? rel + '/' + entry.name : entry.name;
            if (entry.isDirectory()) walk(full, r);
            else if (entry.name.endsWith('.js')) out.push(r);
        }
    };
    for (const d of DIRS) {
        const full = path.join(SERVER_ROOT, d);
        if (fs.existsSync(full)) walk(full, d);
    }
    for (const f of ROOT_FILES) if (fs.existsSync(path.join(SERVER_ROOT, f))) out.push(f);
    return out;
}

const MARKERS = [
    { name: 'a PROBE-STACK string literal', re: /['"`][^'"`]*PROBE-STACK/ },
    { name: 'a "TEMPORARY probe" comment', re: /\/\/.*TEMPORARY\s+probe/i }
];

describe('production code carries no ad-hoc debug instrumentation (N-46)', () => {
    const files = productionFiles();

    it('the scan actually scanned the production tree', function () {
        expect(files.length, 'scanned .js files under api/runtime/integrations/scripts + root files')
            .to.be.greaterThan(100);
        expect(files, 'the file that carried the probe must be in scope').to.include('api/cameras/index.js');
        expect(files, 'runtime must be in scope').to.include('runtime/index.js');
        expect(files.filter((f) => f.startsWith('test/')), 'test/** is deliberately out of scope').to.deep.equal([]);
    });

    it('the matcher still fires on the exact line that shipped', function () {
        const offender = "        runtime.logger.error('PROBE-STACK ' + (err && err.stack));   // TEMPORARY probe";
        for (const m of MARKERS) expect(m.re.test(offender), m.name + ' must match the shipped line').to.equal(true);
        const legitimate = [
            "const PROBE_TIMEOUT = 4000;",
            "const PROBE_TAG = 'contract-probe';",
            "const PROBED_BACKEND = 'sqlite';",
            "// a temporary file is written next to the report"
        ];
        for (const line of legitimate) {
            for (const m of MARKERS) {
                expect(m.re.test(line), m.name + ' must NOT match legitimate code: ' + line).to.equal(false);
            }
        }
    });

    it('no production file writes a PROBE-STACK line to the log', function () {
        const hits = [];
        for (const rel of files) {
            const text = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
            text.split(/\r?\n/).forEach((line, i) => {
                if (MARKERS[0].re.test(line)) hits.push(rel + ':' + (i + 1) + '  ' + line.trim());
            });
        }
        expect(hits, 'PROBE-STACK must not appear in production code').to.deep.equal([]);
    });

    it('no production file is labelled "TEMPORARY probe"', function () {
        const hits = [];
        for (const rel of files) {
            const text = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
            text.split(/\r?\n/).forEach((line, i) => {
                if (MARKERS[1].re.test(line)) hits.push(rel + ':' + (i + 1) + '  ' + line.trim());
            });
        }
        expect(hits, 'a probe left in the tree under a TEMPORARY label').to.deep.equal([]);
    });

    it('the fix removed the probe, not the real logging underneath it', function () {
        const api = fs.readFileSync(path.join(SERVER_ROOT, 'api', 'cameras', 'index.js'), 'utf8');
        expect(api, 'the camera list route must still report failures with its domain code')
            .to.contain('api cameras ');
        expect(api, 'and still route them through the shared error frame').to.contain('sendError(res, err)');
    });
});
