/**
 * An error status must carry a CODE, not a sentence.
 *
 * Every REST domain in this tree answers a failure with { error, message }: the error field is a
 * stable machine-readable code (CAM_NOT_FOUND, CAL_STATE_CONFLICT, RECIPE_BUSY - or one of the
 * platform-wide lowercase ones such as unauthorized_error), and the message is what a human
 * reads. The client is written against exactly that pair, in 30 places:
 *
 *     const code = err && err.error && err.error.error ? err.error.error : '';
 *     const msg  = err && err.error && err.error.message ? err.error.message : (err.message || err);
 *
 * A frame that puts a SENTENCE in the error field breaks both halves at once: the code comes out
 * as prose (so nothing can branch on it) and there is no message at all. recipes did that in 38
 * frames until batch 65 - while its own authentication errors already answered with a RECIPE_
 * code, and while its client showed err.error?.error straight to the operator.
 *
 * The rule is deliberately about ERROR statuses only: a 200 whose payload happens to have an
 * `error` field is a data shape, not an error frame (api/cameras answers polling status that way).
 *
 * What is left over is recorded as debt below rather than fixed here, so the inventory cannot
 * grow quietly and the next batch has a list.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const API_DIR = path.join(SERVER_ROOT, 'api');

/**
 * Frames still putting prose in the error field, keyed '<relative path>::<the prose>' with the
 * reason it is still there. Deleting an entry here means fixing the frame, not forgetting it.
 */
/**
 * Empty since batch 66: scheduler and reporting were the last two domains answering prose (and
 * scheduler was also answering { error: <an Error object> }, which serialises to {} over JSON -
 * eight frames that carried no error text at all). Kept as a named constant because the shape is
 * the point: a frame that cannot name a code goes here with a reason, it does not get invented.
 */
const RECORDED_DEBT = {};

/**
 * Not debt under this rule, but recorded: api/command answers { error: 'error' } - a literal that
 * is code-SHAPED and says nothing. The command API is the surface external scripts call, so
 * renaming its code is a published-contract decision, not a cleanup; N-45 owns it.
 */
const RECORDED_ELSEWHERE = ['command/index.js'];

/** A code: UPPER_SNAKE domain code or a lowercase platform code. Anything else is prose. */
const CODE = /^[A-Z][A-Z0-9_]*$|^[a-z][a-z0-9_]*$/;

/** api-relative, forward slashes. */
const rel = (file) => path.relative(API_DIR, file).split(path.sep).join('/');

/** Every .js under api/, excluding node_modules. */
function apiFiles() {
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
    walk(API_DIR);
    return out.sort();
}

/** res.status(4xx|5xx).json({ ... error: 'literal' ... }) - the literal, per file. */
function proseFrames() {
    const found = [];
    apiFiles().forEach((file) => {
        const text = fs.readFileSync(file, 'utf8');
        const re = /res\s*\.\s*status\s*\(\s*(\d{3})\s*\)\s*\.\s*json\s*\(\s*\{([^}]*)\}/g;
        let m;
        while ((m = re.exec(text))) {
            const status = Number(m[1]);
            if (status < 400) { continue; }
            const body = m[2];
            const value = /error\s*:\s*([^,}]+)/.exec(body);
            if (!value) { continue; }
            const raw = value[1].trim();
            const literal = /^'([^']*)'$/.exec(raw) || /^"([^"]*)"$/.exec(raw);
            if (literal) {
                if (CODE.test(literal[1])) { continue; }
                found.push({ file: rel(file), text: literal[1] });
                continue;
            }
            // Not a literal. Three shapes are how a code legitimately travels:
            //   error: code                     a holder named like a code
            //   error: err.code                 the code riding on the error object
            //   error: prefix + '_FORBIDDEN'    a domain prefix composed with a code-shaped suffix
            // Anything else is flagged, and the one that matters is the caught exception itself:
            // an Error serialises to {} over JSON, so { error: err } carries no error text at all.
            if (/^(code|errorCode|errCode)$/.test(raw)) { continue; }
            if (/\.code$/.test(raw)) { continue; }
            if (/\+/.test(raw)) {
                const parts = raw.split('+').map((p) => p.trim());
                const quoted = parts.filter((p) => /^['"]/.test(p));
                // '_FORBIDDEN' is a code FRAGMENT: uppercase with a leading underscore.
                if (quoted.length && quoted.every((p) => /^_?[A-Z][A-Z0-9_]*$/.test(p.slice(1, -1)))) { continue; }
            }
            found.push({ file: rel(file), text: '<expression: ' + raw + '>' });
        }
    });
    return found;
}

describe('an error frame names a code, not a sentence', () => {
    const frames = proseFrames();

    it('the scan really scanned something', function () {
        // A guard whose path is wrong reports a clean tree - this project has paid for that four times.
        const files = apiFiles();
        expect(files.length, 'no API files found under ' + API_DIR).to.be.greaterThan(20);
        // Any domain answering with a code-shaped literal, in either quote style: the point is
        // that the tree this guard walks really contains coded frames to compare against.
        const codes = apiFiles().filter((file) => /error\s*:\s*["'][A-Za-z_][A-Za-z0-9_]*["']/.test(
            fs.readFileSync(file, 'utf8')));
        expect(codes.length, 'no domain answered with a coded error frame - the scan is looking at the wrong place')
            .to.be.greaterThan(3);
    });

    it('every error status carries a code, except the recorded debt', function () {
        const offenders = frames
            .filter((f) => !RECORDED_DEBT[f.file + '::' + f.text])
            .map((f) => f.file + '::' + f.text);
        expect(offenders, 'these frames answer an error status with a sentence instead of a code:\n' +
            offenders.join('\n')).to.deep.equal([]);
    });

    it('the recorded debt is exactly what is left, each entry with a reason', function () {
        // Unique: a domain may answer the same sentence from two routes (scheduler does), and the
        // inventory is about which sentences exist, not how often.
        const left = [...new Set(frames.map((f) => f.file + '::' + f.text))].sort();
        expect(left, 'the debt list has drifted from the tree: fix the frame, then remove its entry here')
            .to.deep.equal(Object.keys(RECORDED_DEBT).sort());
        Object.keys(RECORDED_DEBT).forEach((key) => {
            expect(RECORDED_DEBT[key].length, key + ' is recorded without a reason').to.be.greaterThan(25);
        });
    });

    it('recipes, the domain this rule was written for, is clean', function () {
        const left = frames.filter((f) => f.file.indexOf('recipes/') === 0);
        expect(left, 'recipes went back to answering prose: ' + JSON.stringify(left)).to.deep.equal([]);
    });
});
