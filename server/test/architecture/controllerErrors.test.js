/**
 * Every controller diagnostic must say WHAT failed.
 *
 * Two shapes are banned, because both were actually in the tree and both make a field report
 * unfalsifiable:
 *
 *   !TOFIX            a marker that names no defect, no owner and no condition. It reads as a
 *                     TODO, so it never gets fixed and never gets deleted, and it survives
 *                     review because it looks like it is already tracked somewhere.
 *
 *   console.error('Error loadHMI')
 *                     a static single-argument message. Six files logged exactly this one, so
 *                     "the page is blank and the console says Error loadHMI" was all anybody
 *                     had - no error, no view id, no element. The 76 console.error calls in
 *                     client/src are mostly fine precisely because they pass a second argument
 *                     or build a message; the nine static ones are recorded in
 *                     _support/known-debt.js instead of being rewritten here.
 *
 * The second rule is deliberately narrow: it matches a SINGLE static literal argument only.
 * `console.error('Error loadHMI', err)` and `console.error(\`view ${id} failed\`)` both pass,
 * because both answer "what failed".
 *
 * Reverse verification (test/architecture/_support/reverse-verify.js) puts a !TOFIX back and
 * demands this file goes red on that exact check.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const debt = require('./_support/known-debt');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', '.git', 'coverage', 'i18n-parked']);

/** Every TypeScript file the client actually ships, tests and fixtures excluded by name. */
function clientTsFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) { out.push(full); }
        }
    };
    walk(CLIENT_SRC);
    return out.sort();
}

const rel = (abs) => path.relative(CLIENT_SRC, abs).split(path.sep).join('/');

/** Line number (1-based) of every match of a global regex, per file. */
function scan(re) {
    const hits = [];
    for (const file of clientTsFiles()) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            const detector = new RegExp(re.source, re.flags);
            if (detector.test(line)) {
                hits.push({ where: rel(file) + ':' + (index + 1), text: line.trim() });
            }
        });
    }
    return hits;
}

/** !TOFIX, in any comment form. */
const TOFIX = /!TOFIX/;

/**
 * console.error(...) whose ONLY argument is a static string: no second argument to carry the
 * error, no interpolation, no concatenation. Those tell the reader nothing they did not
 * already know from the fact that something was logged.
 */
const STATIC_MESSAGE = /console\.error\(\s*(?:'[^'\\$]*'|"[^"\\$]*")\s*\)/;

describe('controller diagnostics (a marker must name a defect, a log must name a failure)', () => {
    it('the client source was found and is not empty', function () {
        expect(clientTsFiles().length, 'no client .ts files under ' + CLIENT_SRC).to.be.greaterThan(100);
    });

    it("no '!TOFIX' marker is left in client/src", function () {
        const hits = scan(TOFIX);
        expect(hits.map((h) => h.where + '  ' + h.text),
            'a !TOFIX marker names no defect, no owner and no condition. Replace it with a real ' +
            'comment that says what is wrong, or delete it.').to.deep.equal([]);
    });

    it('every static single-argument console.error is a recorded one', function () {
        const found = scan(STATIC_MESSAGE).map((h) => h.where);
        const recorded = debt.CLIENT_STATIC_CONSOLE_ERRORS;
        const newOnes = found.filter((where) => recorded.indexOf(where) === -1);
        expect(newOnes,
            'these console.error calls log a message that cannot identify the failure. Pass the ' +
            'error / the id / the element as a second argument: ' + newOnes.join(', ')).to.deep.equal([]);
    });

    it('no recorded entry has quietly disappeared', function () {
        // A pin is an exact set: fixing one of these is good news that has to be written down,
        // otherwise the list slowly becomes a place findings go to be forgotten.
        const found = scan(STATIC_MESSAGE).map((h) => h.where);
        const stale = debt.CLIENT_STATIC_CONSOLE_ERRORS.filter((where) => found.indexOf(where) === -1);
        expect(stale,
            'these entries are pinned in _support/known-debt.js but no longer match the source. ' +
            'If the message was improved, delete the entry; if the line moved, update it: ' +
            stale.join(', ')).to.deep.equal([]);
    });
});
