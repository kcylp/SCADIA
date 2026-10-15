'use strict';

/**
 * Guard against translation keys reaching the screen as raw text.
 *
 * Every label in the UI is written as {{'some.key' | translate}}. ngx-translate renders the
 * key itself when it cannot resolve it, so a missing or unreachable entry shows up as
 * "dlg.setup-title" in a dialog - which is exactly what happened to the whole setup dialog,
 * the login dialog and part of the alarm table.
 *
 * The language files mix two shapes: flat dotted keys ("dlg.cancel": "取消") and nested
 * objects ("dlg": { ... }). The stock ngx-translate parser only walks the path, so an object
 * named "dlg" hides every flat "dlg.*" key behind it. FlatTranslateParser resolves the
 * literal key first; this test keeps both halves honest:
 *   - every key the code asks for must resolve in the fallback language (en),
 *   - the two shapes must not disagree about the same key.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const I18N_DIR = path.join(CLIENT_SRC, 'assets', 'i18n');

/** Same resolution the app performs: literal key first, then the dotted path walk. */
function resolve(table, key) {
    if (table && Object.prototype.hasOwnProperty.call(table, key) && table[key] !== undefined && table[key] !== null) {
        return table[key];
    }
    const parts = String(key).split('.');
    let current = '';
    let target = table;
    do {
        current += parts.shift();
        if (target && target[current] !== undefined && target[current] !== null
            && (typeof target[current] === 'object' || !parts.length)) {
            target = target[current];
            current = '';
        } else if (!parts.length) {
            target = undefined;
        } else {
            current += '.';
        }
    } while (parts.length);
    return target;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadLanguage(lang) {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, lang + '.json'), 'utf8'));
}

function languageFiles() {
    return fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.json') && !f.includes('.bak'));
}

function sourceFiles(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'assets') {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            sourceFiles(full, out);
        } else if (/\.(ts|html)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const PIPE = /'([A-Za-z][\w-]*(?:\.[\w-]+)+)'\s*\|\s*translate/g;
const CALL = /translate(?:Service)?\.(?:instant|get)\(\s*'([A-Za-z][\w-]*(?:\.[\w-]+)+)'/g;
const DYNAMIC = /'([A-Za-z][\w-]*\.[\w-]*-)'\s*\+/g;

/** Keys the templates and services ask for, plus the prefixes they complete at runtime. */
function collectUsedKeys() {
    const keys = new Map();
    const prefixes = new Map();
    for (const file of sourceFiles(path.join(CLIENT_SRC, 'app'), [])) {
        const text = fs.readFileSync(file, 'utf8');
        const rel = path.relative(CLIENT_SRC, file);
        for (const re of [PIPE, CALL]) {
            re.lastIndex = 0;
            let match;
            while ((match = re.exec(text))) {
                if (!keys.has(match[1])) {
                    keys.set(match[1], new Set());
                }
                keys.get(match[1]).add(rel);
            }
        }
        DYNAMIC.lastIndex = 0;
        let dyn;
        while ((dyn = DYNAMIC.exec(text))) {
            if (!prefixes.has(dyn[1])) {
                prefixes.set(dyn[1], new Set());
            }
            prefixes.get(dyn[1]).add(rel);
        }
    }
    return { keys, prefixes };
}

/** Every key reachable in a language file, flat or nested. */
function allKeys(table, prefix, out) {
    for (const [key, value] of Object.entries(table)) {
        const full = prefix ? prefix + '.' + key : key;
        out.add(full);
        if (isPlainObject(value)) {
            allKeys(value, full, out);
        }
    }
    return out;
}

describe('i18n resolution (no raw keys may reach the screen)', () => {
    const used = collectUsedKeys();

    it('finds translation keys in the client sources', () => {
        expect(used.keys.size).to.be.greaterThan(500);
    });

    it('every language file is valid JSON', () => {
        for (const file of languageFiles()) {
            const table = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
            expect(Object.keys(table).length, file + ' is empty').to.be.greaterThan(100);
        }
    });

    it('every key used in the code resolves in the fallback language (en)', () => {
        const en = loadLanguage('en');
        const unresolved = [];
        for (const key of used.keys.keys()) {
            // A trailing dash marks a prefix the template completes at runtime, e.g.
            // 'item.headertype-' + type; those are checked separately below.
            if (key.endsWith('-')) {
                continue;
            }
            if (resolve(en, key) === undefined) {
                unresolved.push(key + '  <- ' + [...used.keys.get(key)].slice(0, 3).join(', '));
            }
        }
        expect(unresolved, 'these keys render as raw text on screen:\n  ' + unresolved.join('\n  '))
            .to.deep.equal([]);
    });

    it('every runtime key prefix has at least one matching entry', () => {
        const en = loadLanguage('en');
        const reachable = [...allKeys(en, '', new Set())];
        const empty = [];
        for (const prefix of used.prefixes.keys()) {
            if (!reachable.some(k => k.startsWith(prefix))) {
                empty.push(prefix + '  <- ' + [...used.prefixes.get(prefix)].slice(0, 3).join(', '));
            }
        }
        expect(empty, 'these prefixes can never resolve:\n  ' + empty.join('\n  ')).to.deep.equal([]);
    });

    it('the flat and nested shapes never disagree about the same key', () => {
        // FlatTranslateParser prefers the flat entry. If a language file ever carries both a
        // flat "a.b" and a nested a.b with a different value, which one wins would be an
        // accident of the parser - fail loudly instead.
        const problems = [];
        for (const file of languageFiles()) {
            const table = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
            const conflicts = [];
            const walk = (node, prefix) => {
                for (const [key, value] of Object.entries(node)) {
                    const full = prefix ? prefix + '.' + key : key;
                    if (isPlainObject(value)) {
                        walk(value, full);
                        if (Object.prototype.hasOwnProperty.call(table, full) && table[full] !== value) {
                            conflicts.push(full);
                        }
                        continue;
                    }
                    if (prefix && Object.prototype.hasOwnProperty.call(table, full) && table[full] !== value) {
                        conflicts.push(full);
                    }
                }
            };
            walk(table, '');
            if (conflicts.length) {
                problems.push(file + ': ' + conflicts.slice(0, 10).join(', '));
            }
        }
        expect(problems, 'flat and nested values disagree:\n  ' + problems.join('\n  ')).to.deep.equal([]);
    });
});
