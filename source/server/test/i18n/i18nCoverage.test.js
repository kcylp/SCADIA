'use strict';

/**
 * Every shipped language must be a complete, well-formed copy of the English reference.
 *
 * The UI is translated with {{'key' | translate}}. A key that is missing, or whose value
 * lost its {{placeholder}}, does not throw - it silently shows the raw key or a broken
 * sentence to an operator. This test makes both failure modes impossible to merge:
 *
 *   1. completeness   - every leaf key of en.json exists in every language
 *   2. placeholders   - {{...}} tokens are identical to the English source
 *   3. value shape    - arrays stay arrays with the same length (weekday and month names)
 *   4. key hygiene    - no key carries stray whitespace, which makes it unreachable
 *
 * en.json is the reference and is therefore checked for hygiene only.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const I18N_DIR = path.join(SERVER_ROOT, '..', 'client', 'src', 'assets', 'i18n');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Flat keys and nested paths of a language file, as the app resolves them. */
function collectKeys(table, prefix, out) {
    for (const [key, value] of Object.entries(table)) {
        const full = prefix ? prefix + '.' + key : key;
        out.set(full, value);
        if (isPlainObject(value)) {
            collectKeys(value, full, out);
        }
    }
    return out;
}

/** Literal key first, then the dotted path walk - the same order as FlatTranslateParser. */
function resolve(table, key) {
    if (Object.prototype.hasOwnProperty.call(table, key) && table[key] !== undefined && table[key] !== null) {
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

function placeholders(value) {
    return typeof value === 'string' ? (value.match(/\{\{[^}]*\}\}/g) || []).slice().sort().join('|') : '';
}

function languageFiles() {
    return fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.json') && !f.includes('.bak')).sort();
}

function load(file) {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
}

describe('i18n coverage (every language must be complete)', () => {
    const files = languageFiles();
    const english = load('en.json');
    const englishKeys = collectKeys(english, '', new Map());

    it('ships exactly the supported set of languages', () => {
        // Simplified Chinese is the master; English and Russian serve the export markets.
        // Other translations live in client/i18n-parked and are deliberately not built:
        // a half-translated language renders raw keys, which is worse than not offering it.
        // Adding one back means adding its file here AND to SHIPPED_APP_LANGUAGES.
        expect(files).to.deep.equal(['en.json', 'ru.json', 'zh-cn.json']);
    });

    it('every language file is valid JSON with a plausible size', () => {
        for (const file of files) {
            const table = load(file);
            expect(Object.keys(table).length, file + ' looks truncated').to.be.greaterThan(500);
        }
    });

    it('no key carries stray whitespace', () => {
        // A key like " device.tag-daq-interval" or "shapes. event-mouseup" can never be
        // looked up, so the translation is dead weight and the UI shows the raw key.
        const offenders = [];
        for (const file of files) {
            for (const key of collectKeys(load(file), '', new Map()).keys()) {
                if (key !== key.trim() || /\s\./.test(key) || /\.\s/.test(key)) {
                    offenders.push(file + ': ' + JSON.stringify(key));
                }
            }
        }
        expect(offenders, 'unreachable keys:\n  ' + offenders.join('\n  ')).to.deep.equal([]);
    });

    for (const file of files) {
        const lang = file.replace('.json', '');

        it(lang + ': contains every key of the English reference', () => {
            const table = load(file);
            const missing = [];
            for (const [key, englishValue] of englishKeys) {
                if (isPlainObject(englishValue)) {
                    continue; // the object itself is satisfied by its children
                }
                if (resolve(table, key) === undefined) {
                    missing.push(key);
                }
            }
            expect(missing.length, lang + ' is missing ' + missing.length + ' key(s): '
                + missing.slice(0, 25).join(', ') + (missing.length > 25 ? ' ...' : ''))
                .to.equal(0);
        });

        it(lang + ': keeps every placeholder and value shape', () => {
            const table = load(file);
            const placeholderProblems = [];
            const shapeProblems = [];
            for (const [key, englishValue] of englishKeys) {
                if (isPlainObject(englishValue)) {
                    continue;
                }
                const value = resolve(table, key);
                if (value === undefined) {
                    continue; // reported by the completeness test
                }
                if (Array.isArray(englishValue) !== Array.isArray(value)) {
                    shapeProblems.push(key);
                    continue;
                }
                if (Array.isArray(englishValue) && englishValue.length !== value.length) {
                    shapeProblems.push(key + ' (' + englishValue.length + ' vs ' + value.length + ')');
                    continue;
                }
                if (placeholders(englishValue) !== placeholders(value)) {
                    placeholderProblems.push(key + ' expected [' + placeholders(englishValue)
                        + '] got [' + placeholders(value) + ']');
                }
            }
            expect(placeholderProblems, lang + ' loses placeholders:\n  ' + placeholderProblems.slice(0, 15).join('\n  '))
                .to.deep.equal([]);
            expect(shapeProblems, lang + ' has wrong value shapes:\n  ' + shapeProblems.slice(0, 15).join('\n  '))
                .to.deep.equal([]);
        });
    }
});
