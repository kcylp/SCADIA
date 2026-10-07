/**
 * D1 - SCANNER CONTRACT, and the rule that keeps the guard loadable.
 *
 * Two things are tested here:
 *   1. the guard own scanner tells code from comments correctly, so a commented-out
 *      require() is never counted as a dependency and a URL inside a string is never
 *      mistaken for a comment;
 *   2. every helper under test/ does NOTHING when mocha loads it as a spec file.
 *
 * Point 2 is not hypothetical. The documented full-suite command is
 *   npx mocha --recursive --timeout 60000 --reporter dot --exit
 * and --recursive loads EVERY .js under test/, not only *.test.js. Two real incidents came
 * from helpers that ran on require: one called process.exit and silently truncated the whole
 * repository run; another read process.argv[2] at module scope and, one tick later, wrote its
 * JSON there - which under mocha is the SPEC PATH, so it overwrote a test file.
 */

'use strict';

const { expect } = require('chai');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const arch = require('./_support/architecture');

describe('architecture: scanner contract', function () {
    it('tells a require() in code from one inside a comment', function () {
        const cases = [
            { src: "const x = require('./a');", expected: 1, why: 'plain code' },
            { src: "// require('./a')\nconst y = 1;", expected: 0, why: 'line comment' },
            { src: "/* require('./a') */ const z = 1;", expected: 0, why: 'block comment' },
            { src: "const u = 'http://host/path'; const v = require('./b');", expected: 1, why: 'a URL is not a comment' },
            { src: 'const t = "/** not a comment */"; require("./c");', expected: 1, why: 'a comment marker inside a string is data' },
            { src: "if (a) { /* x */ } require('./d');", expected: 1, why: 'an inline block comment' }
        ];
        for (const c of cases) {
            const stripped = arch.stripComments(c.src);
            const count = (stripped.match(/require\(/g) || []).length;
            expect(count, c.why + ': ' + JSON.stringify(c.src)).to.equal(c.expected);
        }
    });

    it('keeps line and column positions, so a reported line number is true', function () {
        const src = "// one\n/* two\n   three */\nconst real = require('./x');";
        const stripped = arch.stripComments(src);
        expect(stripped.split('\n').length).to.equal(src.split('\n').length);
        expect(stripped.length).to.equal(src.length);
        const lineOf = src.slice(0, src.indexOf('./x')).split('\n').length;
        expect(lineOf).to.equal(4);
    });

    it('reports the dependencies of a file, and none of its commentary', function () {
        const facade = arch.requireSpecifiers(path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'daqstorage.js'))
            .map((s) => s.spec);
        expect(facade).to.include('./registry');
        expect(facade).to.include('../utils');
        expect(facade.filter((s) => s === 'fs' || s === 'path')).to.deep.equal(['fs', 'path']);

        // Since D5 the adapters are required by the registry, as literals - that is what
        // keeps them reachable to static analysis.
        const registry = arch.requireSpecifiers(path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'registry.js'))
            .map((s) => s.spec);
        for (const adapter of ['./sqlite', './influxdb', './tdengine', './questdb']) {
            expect(registry, 'the registry must load ' + adapter + ' literally').to.include(adapter);
        }
        expect(registry).to.include('./contract');
    });

    it('keeps an interpolated template expression as code while masking its text', function () {
        const BT = String.fromCharCode(96);
        const src = 'catch (err) { logger.warn(' + BT + 'failed: ' + '$' + '{err.message}' + BT + '); }';
        const masked = arch.maskStringContents(src);
        expect(masked).to.include('err.message');
        expect(masked).to.include('warn');
        expect(masked, 'the literal text of the template is masked').to.not.include('failed');
        expect(masked.split('\n').length).to.equal(src.split('\n').length);
        expect(masked.length).to.equal(src.length);
    });

    it('every helper under test/ does nothing when it is loaded', function () {
        // CHILD PROCESS + SENTINEL. An in-process require can only observe synchronous side
        // effects, and the version of this check that saw only those missed a helper that
        // wrote to process.argv[2] one tick later. Each helper is therefore loaded in its own
        // process, with process.exit trapped, a sentinel path in argv[2], and both stdout and
        // that file watched.
        const testRoot = path.join(arch.SERVER_ROOT, 'test');
        const helpers = arch.listJsFiles(testRoot)
            .map(arch.rel)
            .filter((r) => !r.endsWith('.test.js'));

        expect(helpers.length, 'the guard ships helper modules; if none are found this test is blind')
            .to.be.greaterThan(0);

        const trap = "process.exit=function(c){throw new Error('helper called process.exit('+c+') while being loaded')};" +
            'require(process.argv[1]);';

        const offenders = [];
        for (const relPath of helpers) {
            const abs = path.join(arch.SERVER_ROOT, relPath);
            const sentinel = path.join(os.tmpdir(),
                'helper-inert-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');

            let stdout = '';
            let failure = null;
            try {
                stdout = execFileSync(process.execPath, ['-e', trap, abs, sentinel],
                    { encoding: 'utf8', timeout: 30000 });
            } catch (err) {
                failure = String(err.stderr || err.message).slice(-300);
            }

            if (failure) { offenders.push(relPath + ' failed while being loaded: ' + failure); }
            if (stdout) { offenders.push(relPath + ' wrote to stdout on load: ' + JSON.stringify(stdout.slice(0, 80))); }
            if (fs.existsSync(sentinel)) {
                offenders.push(relPath + ' wrote to the path it found in process.argv[2] - under mocha that is the spec file');
                try { fs.rmSync(sentinel, { force: true }); } catch (err) { /* best effort */ }
            }
        }

        expect(offenders,
            'a helper under test/ runs when it is loaded. mocha --recursive loads every .js ' +
            'under test/ as a spec file, so a helper with a side effect corrupts the whole suite:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });
});
