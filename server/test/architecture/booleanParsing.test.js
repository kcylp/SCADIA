/**
 * No ninth copy of the boolean mapping.
 *
 * Batch 60 found eight, and they disagreed: httprequest read the string 'false' as TRUE,
 * adsclient read the string '0' as TRUE, and a numeric value threw. Folding today's eight
 * into utils.parseBoolean fixes today's eight. The cost of the duplication was never the
 * eight copies - it was that copying is the path of least resistance for the ninth driver
 * somebody adds next month.
 *
 * The rule is deliberately narrow: what a file may not do is SPELL the mapping itself. Two
 * files keep their own spelling on purpose and are listed below with the reason, so a later
 * reader does not "finish the job" by migrating the wrong one.
 *
 * Reverse verification cannot use this file cheaply (it needs a new copy to appear rather
 * than an existing line to change), so the rule is proven by the migration itself: before
 * batch 60 this guard would have named device-utils, scadiaserver, scheduler-service,
 * httprequest, adsclient and opcua.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const RUNTIME_DIR = path.join(SERVER_ROOT, 'runtime');
const CANONICAL = path.join(RUNTIME_DIR, 'utils.js');

/**
 * Files allowed to compare against the literals 'true' / 'false' / '1' themselves.
 * Keyed by runtime-relative path with forward slashes.
 */
const ALLOWED = {
    'utils.js': 'this IS the canonical parser (parseBoolean); every other file calls it',
    'recipes/recipe-service.js': "coerceValue is not a boolean parser: it passes an unparseable value " +
        'through unchanged instead of deciding (its documented contract, covered by test/recipes/recipeService.test.js)',
    'opcua-server/datatype.js': 'coerce() answers a DIFFERENT question - "can this value be represented ' +
        'as a Boolean at all?" - and answers ok:false instead of guessing, so an OPC UA client sees Bad ' +
        'quality rather than a fabricated false (its own documented contract, batch 20)',
    'devices/websocket/index.js': 'property.subscribe is a device CONFIG flag, not an incoming value: ' +
        'anything that is not literally false means "subscribe". The reading is unchanged on purpose - ' +
        'see N-43 in 20_代码进度.md'
};

/**
 * The spelling each divergent exemption is allowed to keep, pinned so the exemption cannot
 * quietly become a different rule. Recorded divergences stay recorded (the known-debt
 * pattern used by ioEventTypesSync).
 */
const EXEMPT_SPELLING = {
    'recipes/recipe-service.js': "if (lower === 'true' || lower === '1') {",
    'opcua-server/datatype.js': "if (['true', '1', 'on', 'yes'].indexOf(s) >= 0) {"
};

/** A line that spells a boolean mapping: it names 'true' AND '1', or it tests against 'false'. */
function spellsBooleanMapping(line) {
    if (/'true'/.test(line) && /'1'/.test(line)) {
        return "spells the true-family ('true' / '1') by hand";
    }
    if (/!==\s*'false'/.test(line) || /===\s*'false'/.test(line)) {
        return "spells the false-family ('false') by hand";
    }
    return null;
}

/** Every .js under runtime/, node_modules excluded. */
function runtimeFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.js')) { out.push(full); }
        }
    };
    walk(RUNTIME_DIR);
    return out.sort();
}

const relative = (file) => path.relative(RUNTIME_DIR, file).split(path.sep).join('/');

/**
 * Call sites that had their own parser and now must keep asking the shared one. Pinned by
 * file so that deleting the call (rather than the copy) is visible too.
 */
const SHARED_CALL_SITES = [
    'devices/httprequest/index.js',
    'devices/scadiaserver/index.js',
    'devices/adsclient/index.js',
    'devices/opcua/index.js',
    'scheduler/scheduler-service.js',
    'devices/device-utils.js'
];

describe('the boolean mapping is spelled in one place', () => {
    const files = runtimeFiles();

    it('the scan really scanned something', function () {
        // The lesson this project has paid for four times: a guard whose path is wrong
        // reports a clean tree. Assert the walk found a tree first.
        expect(files.length, 'the runtime/ walk found almost nothing - check RUNTIME_DIR').to.be.greaterThan(90);
        expect(files.map(relative)).to.include('utils.js');
    });

    it('the canonical parser is still exported', function () {
        const source = fs.readFileSync(CANONICAL, 'utf8');
        expect(source, 'runtime/utils.js no longer defines parseBoolean').to.match(/parseBoolean:\s*function/);
        expect(typeof require(CANONICAL).parseBoolean).to.equal('function');
    });

    it('no file outside the recorded exemptions spells the mapping itself', function () {
        const offenders = [];
        files.forEach((file) => {
            const rel = relative(file);
            if (ALLOWED[rel]) { return; }
            fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) { return; }      // a comment is documentation
                const why = spellsBooleanMapping(line);
                if (why) {
                    offenders.push(rel + ':' + (index + 1) + ' ' + why + ': ' + line.trim());
                }
            });
        });
        expect(offenders, 'these files re-derive a boolean instead of calling utils.parseBoolean:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('the exemptions are exactly the recorded ones, each with a reason', function () {
        const spelling = files
            .filter((file) => {
                const rel = relative(file);
                return fs.readFileSync(file, 'utf8').split(/\r?\n/)
                    .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && spellsBooleanMapping(line));
            })
            .map(relative)
            .sort();
        expect(spelling, 'the exemption list has drifted from the tree').to.deep.equal(Object.keys(ALLOWED).sort());
        Object.keys(ALLOWED).forEach((rel) => {
            expect(ALLOWED[rel].length, rel + ' is exempt without a reason').to.be.greaterThan(20);
        });
    });

    it('the divergent exemptions still spell exactly what was recorded', function () {
        Object.keys(EXEMPT_SPELLING).forEach((rel) => {
            const source = fs.readFileSync(path.join(RUNTIME_DIR, rel), 'utf8');
            expect(source.indexOf(EXEMPT_SPELLING[rel]),
                rel + ' no longer contains its recorded spelling: ' + EXEMPT_SPELLING[rel] +
                ' - if the rule moved, move it to utils.parseBoolean, do not re-record it blindly')
                .to.be.greaterThan(-1);
        });
    });

    it('the migrated call sites still route through the shared parser', function () {
        const missing = SHARED_CALL_SITES.filter((rel) => {
            const source = fs.readFileSync(path.join(RUNTIME_DIR, rel), 'utf8');
            return !/parseBoolean\(/.test(source) && !/parseValue\(/.test(source);
        });
        expect(missing, 'these files stopped asking the shared parser: ' + missing.join(', ')).to.deep.equal([]);
    });
});
