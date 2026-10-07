/**
 * R1, R2 and R3 from the UI standard (12_前端融合与UI一致性规范.md §R1-R3), as far as they can be
 * checked mechanically. R4 (i18n), R5 (dialogs/toasts) and R6 (routes) already have gates; these
 * three had NONE, so every batch so far has been re-deciding them by eye.
 *
 *   R1 colours   only var(--token); a NEW semantic colour goes into theme.config.ts (both themes)
 *   R2 components only Angular Material + gui-helpers; no second design system
 *   R3 icons     material-icons only; no image/SVG icon sets
 *
 * WHAT A GUARD CAN AND CANNOT SAY. It cannot say a colour is tasteful, and it cannot decide that an
 * existing literal SHOULD become a token - that is a design change per site. What it can do is stop
 * the number from growing, and hold the files that were just cleaned at zero. That is the same
 * shape as the known-debt ledger this project already uses, and the floor is measured, not guessed.
 *
 * HONEST BASELINE (measured when this landed, and NOT zero):
 *   231 colour literals in .ts, 531 in .scss, 13 in inline template styles.
 * Those are pre-existing, in files no batch has touched, and each one needs a design decision
 * about which token it should become. They are recorded here so the NEXT one cannot be added
 * invisibly. The batch that did the work (N-18) cleaned calibration-workbench completely, and it is
 * pinned at ZERO below - a file that has been cleaned may not quietly go back.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

// Three levels up: this test/architecture -> test -> server -> the workspace that holds both trees.
// Note the shape is the same as every other guard, but it is written out rather than shared, because
// the one constant that matters (how many levels) is exactly what a copy gets wrong.
const CLIENT_ROOT = path.resolve(__dirname, '..', '..', '..', 'client');
const CLIENT_SRC = path.join(CLIENT_ROOT, 'src');
const APP_DIR = path.join(CLIENT_SRC, 'app');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', 'i18n-parked']);
/** Vendored code (jQuery, svg-edit and their extensions): rewriting a vendor bundle is not a fix. */
const VENDOR = new Set(['lib', 'i18n-parked']);

/**
 * Colour-shaped literals only: #rgb / #rrggbb / #rrggbbaa, and rgb()/rgba() function calls.
 *
 * The three-digit case was never the gap - {3} was in here all along. The gap was EIGHT digits:
 * with the old '#{6}\b|#{3}\b' a '#3059afcc' matched neither alternative, because {6} consumed six
 * hex digits and then '\b' failed against the seventh. Modern stylesheets write alpha as
 * #rrggbbaa, so a literal in that form was invisible to the ceiling guard.
 */
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGB = /rgba?\s*\(/;

/** Every shipped client file with the given extension, minus vendor trees. */
function clientFiles(extensions) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name) || VENDOR.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (extensions.test(entry.name)) { out.push(full); }
        }
    };
    walk(APP_DIR);
    return out.sort();
}

const rel = (file) => path.relative(CLIENT_SRC, file).split(path.sep).join('/');

/** Lines carrying a colour literal, ignoring comment lines. */
function colourLines(file) {
    const hits = [];
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(text)) { return; }
        if (HEX.test(text) || RGB.test(text)) { hits.push({ line: index + 1, text: text.trim() }); }
    });
    return hits;
}

/** Inline style attributes in a template that carry a colour literal. */
function inlineStyleColours(file) {
    const hits = [];
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, index) => {
        if (!/style=/.test(text)) { return; }
        if (HEX.test(text) || RGB.test(text)) { hits.push({ line: index + 1, text: text.trim() }); }
    });
    return hits;
}

const WORKBENCH = path.join(APP_DIR, 'calibration', 'calibration-workbench');

describe('UI consistency R1/R2/R3 (now with gates instead of re-deciding by eye)', () => {

    it('R1: the files this batch cleaned hold ZERO colour literals', function () {
        const offenders = [];
        const template = path.join(WORKBENCH, 'calibration-workbench.component.html');
        const stylesheet = path.join(WORKBENCH, 'calibration-workbench.component.css');
        colourLines(template).forEach((h) => offenders.push(rel(template) + ':' + h.line + '  ' + h.text));
        inlineStyleColours(template).forEach((h) => offenders.push(rel(template) + ':inline-style:' + h.line + '  ' + h.text));
        // The stylesheet is where the colours are ALLOWED to live - but only as var() references.
        fs.readFileSync(stylesheet, 'utf8').split(/\r?\n/).forEach((text, index) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(text)) { return; }
            if (!(HEX.test(text) || RGB.test(text))) { return; }
            if (/var\(\s*--/.test(text) || /--sc-[\w-]+\s*:/.test(text)) { return; }
            offenders.push(rel(stylesheet) + ':' + (index + 1) + '  ' + text.trim());
        });
        expect(offenders, 'N-18 tokenised this file; a literal here means the cleanup came undone. ' +
            'Use var(--sc-*) (or add a token to the .scada block, which is where this file declares its ' +
            'two measured chart colours):\n' + offenders.join('\n')).to.deep.equal([]);
    });

    it('R1: the literal ceiling did not grow (measured, per extension)', function () {
        // Ceilings, not targets. Each remaining literal needs a design decision about which token it
        // becomes; this asserts only that the next batch cannot add one without being seen.
        // MEASURED, not guessed: ts 238, scss 569, and 13 inline-style colour lines in templates.
        // Reproduced from the guard's own counter with the widened HEX pattern (batch 90-A).
        //
        // Two different things moved these numbers, and only one of them is this batch:
        //   ts   233 -> 238 : the regex now sees eight-digit hex. All five are genuine
        //                     ('#ffffffff' defaults in hmi.ts/project.service.ts/view-property,
        //                     '#f9f9f9ff' fills in html-recipe/html-scheduler). Until now a
        //                     literal written as #rrggbbaa was INVISIBLE to this ceiling.
        //   scss 531 -> 532 : the same widening, one line (svg-selector.component.scss:55,
        //                     '#9c9c9c36').
        // Both numbers were read back from THIS guard's own counter, by forcing the ceilings to
        // zero and reading the failure. A hand-written counting script got scss wrong by 37 because
        // it walked files this guard excludes - so trust the counter the assertion actually uses.
        // The three-digit case was never a gap: {3} was in the old pattern all along.
        // ts 231 -> 233 in batch 88-A: the sidenav foreground had no token at all (theme.config.ts
        // declared sidenavBackground but no sidenavColor), and that missing token is exactly why the
        // menu inherited body.dark-theme's white onto a light grey background - 1.09:1 contrast, the
        // labels were unreadable. The two new lines ARE the two theme definitions of that token:
        // '#1D1D1D' in default and '#FFFFFF' in dark. "Tokenise it" cannot apply to the file whose
        // job is to define tokens - every token in theme.config.ts is a literal by construction.
        // Reason recorded in 20_代码进度.md (batch 88-A) as this guard requires.
        // The first two numbers are several times the first estimate ("92") because that estimate
        // counted MATCHING LINES OF A GREP over a narrower pattern, while this counts every literal
        // line the guard actually sees. The number that matters is not its size - it is that it can
        // no longer grow unseen.
        const ceilings = { ts: 238, scss: 532 };
        const actual = {};
        actual.ts = clientFiles(/\.ts$/).reduce((n, f) => n + colourLines(f).length, 0);
        actual.scss = clientFiles(/\.scss$/).reduce((n, f) => n + colourLines(f).length, 0);
        // Report EVERY extension that is over, then fail once.
        //
        // This used to be a forEach of expects, which throws on the first failure - so as soon as
        // .ts went over (batch 88-A) this test never evaluated .scss, and .scss quietly drifted by
        // 37 unreviewed literals across several batches while the guard sat red pointing at .ts.
        // A ceiling guard that can only see one extension per run is the reason a baseline goes
        // stale without anyone noticing; collect first, assert last.
        const over = Object.keys(ceilings).filter((ext) => actual[ext] > ceilings[ext]);
        expect(over.map((ext) => ext + ': ' + actual[ext] + ' > ' + ceilings[ext]),
            'colour literals grew past the recorded ceilings. If the new ones are right, tokenise ' +
            'them or raise the ceiling AND say why in 20_代码进度.md. Measured now: ' +
            JSON.stringify(actual) + ' against ceilings ' + JSON.stringify(ceilings) + '.').to.deep.equal([]);
    });

    it('R1: every token the cleaned stylesheet reads is declared by BOTH themes or by .scada', function () {
        // The R1 guard (uiConsistencyR1) checks theme.config.ts. This checks the OTHER namespace the
        // client actually has - the .scada industrial surface - so a var(--sc-*) that nothing
        // declares cannot silently do nothing.
        // Comments are stripped FIRST: a comment that documents the pattern ("instead of var(--sc-*)
        // at the use site") is not a token reference, and reading it as one produced a token named
        // "--sc-" that nothing declares. Same rule as the R5 guard: prose is not code.
        const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
            .map((line) => line.replace(/\/\/.*$/, '')).join('\n');
        const stylesheet = stripComments(fs.readFileSync(path.join(WORKBENCH, 'calibration-workbench.component.css'), 'utf8'));
        const scadaCss = stripComments(fs.readFileSync(path.join(CLIENT_SRC, 'scada.css'), 'utf8'));
        const read = new Set();
        let m;
        // A token name may contain a hyphen: --sc-panel, --sc-ink-3. A class without it stops at
        // the hyphen and reports a token called "sc" - which is how a first version of this check
        // managed to look broken while it was reading nothing at all.
        const re = /var\(\s*--([A-Za-z_$][A-Za-z0-9_$-]*)/g;
        while ((m = re.exec(stylesheet))) { read.add(m[1]); }
        expect(read.size, 'the cleaned stylesheet reads no tokens at all').to.be.greaterThan(5);
        const missing = [];
        read.forEach((token) => {
            const declaredScada = new RegExp('--' + token + '\s*:').test(scadaCss);
            const declaredHere = new RegExp('--' + token + '\s*:').test(stylesheet);
            const declaredTheme = fs.readFileSync(path.join(APP_DIR, '_config', 'theme.config.ts'), 'utf8');
            const declaredInTheme = new RegExp(token + '\s*:').test(declaredTheme);
            if (!declaredScada && !declaredHere && !declaredInTheme) {
                missing.push('--' + token);
            }
        });
        expect(missing, 'a var() that resolves to nothing is a rule that silently does nothing: ' +
            missing.join(', ')).to.deep.equal([]);
    });

    it('R2: no second design system is declared', function () {
        const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8'));
        const declared = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies));
        const forbidden = declared.filter((name) =>
            /^(element-ui|element-plus|antd|ant-design|bootstrap|ng-bootstrap|@ng-bootstrap|primeng|ng-zorro|@ng-zorro|@clr|clarity-angular|@material-ui|@mui|@chakra-ui)/.test(name));
        expect(forbidden, 'the standard allows Angular Material + gui-helpers only; a second design ' +
            'system shows up as a screen whose inputs and buttons do not match: ' + forbidden.join(', '))
            .to.deep.equal([]);
        // And the one system it does allow must still be there (otherwise this rule points nowhere).
        expect(declared, 'Angular Material is gone - R2 has no reference system left')
            .to.include('@angular/material');
    });

    it('R3: no image-based icon set in a template', function () {
        const offenders = [];
        clientFiles(/\.html$/).forEach((file) => {
            fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, index) => {
                const where = rel(file) + ':' + (index + 1) + '  ' + text.trim();
                // (a) an icon shipped as a FILE. A literal src is the tell: a bound [src] is content
                // the operator or a device supplies (a navigation button's own image, a camera
                // snapshot), which is not this rule's business.
                if (/<img\b/.test(text) && /src\s*=\s*["'][^"']+\.(svg|png|gif|ico)["']/i.test(text)) {
                    offenders.push(where);
                }
                // (b) a sprite sheet, which is an icon set in everything but name.
                if (/<use\b[^>]*xlink:href\s*=\s*["']#/.test(text) || /class\s*=\s*["'][^"']*sprite/i.test(text)) {
                    offenders.push(where);
                }
            });
        });
        expect(offenders, 'the standard allows material-icons names only. An icon shipped as an ' +
            'image or a sprite is what makes icon weight and rounding drift from the rest of the shell: ' +
            offenders.join(' | ')).to.deep.equal([]);
    });
});
