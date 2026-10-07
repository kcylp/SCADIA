/**
 * R1 from the UI standard, the part that can be checked without taste: a theme token has to exist
 * in BOTH themes, or the rule that reads it silently stops applying in one of them.
 *
 * THE FAILURE THIS CATCHES, measured, not imagined. The dark theme declared
 * `workPanelExpandBackground`; the default theme did not. report-list.component.css:132 reads
 * `var(--workPanelExpandBackground)`, so in the light theme the declaration was invalid at
 * computed-value time and the rule simply did not apply - no error, no warning, just one panel
 * that looks wrong in one theme. The dark theme separately carried `toolboxButton: '##313131'`,
 * a doubled hash, which killed its one consumer the same way.
 *
 * WHAT MAKES THIS A GUARD RATHER THAN A STYLE OPINION. It never asks which colour is right. It asks
 * two mechanical questions:
 *
 *   1. is every token declared in both themes? (a one-sided token is at best dead, at worst a
 *      silently missing rule)
 *   2. does something actually read it? (an unread token is why nobody noticed #1)
 *
 * A one-sided token that IS read is an error. A one-sided token that is NOT read is dead weight,
 * reported as debt with its owner, because deleting it is a judgement call about intent.
 *
 * Snapshot of the day this landed: 42 dark tokens, 40 default tokens, and exactly one token read
 * from outside the config file (`workPanelExpandBackground`).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const APP_DIR = path.join(CLIENT_SRC, 'app');
const THEME_FILE = path.join(APP_DIR, '_config', 'theme.config.ts');

/** One-sided tokens that nothing reads. Recorded, not fixed: removing them is an intent question. */
const DEAD_ONE_SIDED_TOKENS = [
    {
        token: 'tableHeaderColor',
        theme: 'dark',
        why: 'declared in THEMES.dark and read by nothing (no var(--tableHeaderColor) anywhere in the client). ' +
            'Either a table header style was never written, or the token is a leftover.'
    }
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', 'i18n-parked']);

/** Every .ts/.html/.css/.scss the client ships, minus the vendor bundles. */
function clientFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (/\.(ts|html|css|scss)$/.test(entry.name)) { out.push(full); }
        }
    };
    walk(CLIENT_SRC);
    return out;
}

/** Read one theme object out of theme.config.ts, one member per line. */
function readTheme(name) {
    const source = fs.readFileSync(THEME_FILE, 'utf8');
    const start = source.indexOf('\n    ' + name + ': {');
    if (start < 0) { return null; }
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') { depth++; }
        else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) { return null; }
    const members = {};
    source.slice(open + 1, end).split(/\r?\n/).forEach((line) => {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'\s*,?/.exec(line);
        if (m) { members[m[1]] = m[2]; }
    });
    return members;
}

/** Every token name read through var(--x) outside the config file. */
function tokensReadByCss() {
    const read = new Map();
    clientFiles().forEach((file) => {
        if (file === THEME_FILE) { return; }
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            const re = /var\(\s*--([A-Za-z_$][\w$]*)\s*\)/g;
            let m;
            while ((m = re.exec(line))) {
                if (!read.has(m[1])) { read.set(m[1], []); }
                read.get(m[1]).push(path.relative(CLIENT_SRC, file).split(path.sep).join('/') + ':' + (index + 1));
            }
        });
    });
    return read;
}

describe('UI consistency R1 (a token missing from one theme is a rule that silently stops applying)', () => {
    const defaultTheme = readTheme('default');
    const darkTheme = readTheme('dark');

    it('both shipped themes were parsed', function () {
        expect(defaultTheme, 'THEMES.default not found in theme.config.ts').to.not.equal(null);
        expect(darkTheme, 'THEMES.dark not found in theme.config.ts').to.not.equal(null);
        expect(Object.keys(defaultTheme).length).to.be.greaterThan(30);
        expect(Object.keys(darkTheme).length).to.be.greaterThan(30);
    });

    it('every token read by a stylesheet is declared by BOTH themes', function () {
        const read = tokensReadByCss();
        const broken = [];
        read.forEach((where, token) => {
            const inDefault = token in defaultTheme;
            const inDark = token in darkTheme;
            if (inDefault !== inDark) {
                broken.push('--' + token + ' is declared in ' + (inDefault ? 'default only' : 'dark only') +
                    ' but read at ' + where.slice(0, 3).join(', ') +
                    (where.length > 3 ? ' (+' + (where.length - 3) + ')' : ''));
            }
        });
        expect(broken, 'in the theme that lacks the token, var(--x) resolves to nothing and the rule ' +
            'is discarded with no error:\n' + broken.join('\n')).to.deep.equal([]);
    });

    it('the one-sided tokens that remain are exactly the recorded, unread ones', function () {
        const read = tokensReadByCss();
        const oneSided = [];
        Object.keys(darkTheme).forEach((t) => { if (!(t in defaultTheme)) { oneSided.push({ token: t, theme: 'dark' }); } });
        Object.keys(defaultTheme).forEach((t) => { if (!(t in darkTheme)) { oneSided.push({ token: t, theme: 'default' }); } });
        const unread = oneSided.filter((entry) => !read.has(entry.token));
        const unexpected = unread.filter((entry) => !DEAD_ONE_SIDED_TOKENS.some((pin) => pin.token === entry.token));
        expect(unexpected.map((e) => e.token + ' (only in ' + e.theme + ')'),
            'a token declared in one theme and read by nothing is how a missing rule stays invisible. ' +
            'Either declare it in both themes, or record it in DEAD_ONE_SIDED_TOKENS with why:')
            .to.deep.equal([]);
    });

    it('no recorded one-sided token has quietly been fixed or deleted', function () {
        // A pin is an exact set: if someone declares the token in both themes, this tells them to
        // retire the entry instead of leaving a stale note behind.
        const stillOneSided = DEAD_ONE_SIDED_TOKENS.filter((pin) => {
            const inDefault = pin.token in defaultTheme;
            const inDark = pin.token in darkTheme;
            return inDefault !== inDark;
        });
        expect(stillOneSided.map((p) => p.token),
            'these pinned tokens are now declared in both themes - delete their entries from ' +
            'DEAD_ONE_SIDED_TOKENS').to.deep.equal(DEAD_ONE_SIDED_TOKENS.map((p) => p.token));
    });
});
