'use strict';

/**
 * Guard the content dictionary: the mechanism that translates the words INSIDE a drawing.
 *
 * A project is authored in Simplified Chinese, so a view's labels are literal text in the
 * SVG ("报警时间：") rather than @keys. LanguageService resolves those literals against the
 * project's language-text library and, failing that, against the built-in seed
 * (client/src/app/_helpers/content-seed.ts).
 *
 * This file keeps the seed honest. A seed entry that is missing one of the shipped
 * languages, that collides with another source string, or that merely repeats the Chinese
 * is worse than no entry at all: it looks translated and is not.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const SEED_FILE = path.join(CLIENT_SRC, 'app', '_helpers', 'content-seed.ts');
const SETTINGS_FILE = path.join(CLIENT_SRC, 'app', '_models', 'settings.ts');

/** Read a top-level array literal out of a TypeScript module without a compiler. */
function readArrayLiteral(file, declaration) {
    const text = fs.readFileSync(file, 'utf8');
    const start = text.indexOf(declaration);
    expect(start, declaration + ' not found in ' + path.basename(file)).to.be.greaterThan(-1);
    // Start after the assignment: a declaration may carry a type such as
    // "ContentSeedEntry[]" whose brackets would otherwise be mistaken for the array.
    const assign = text.indexOf('=', start);
    expect(assign, declaration + ' has no assignment').to.be.greaterThan(-1);
    const open = text.indexOf('[', assign);
    let depth = 0;
    let end = -1;
    let inString = null;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') { i++; continue; }
            if (ch === inString) { inString = null; }
            continue;
        }
        if (ch === '"' || ch === "'") { inString = ch; continue; }
        if (ch === '[') { depth++; }
        else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    expect(end, 'unterminated array for ' + declaration).to.be.greaterThan(-1);
    const literal = text.slice(open, end + 1);
    // The literal only contains strings, objects and arrays, so it is safe to evaluate.
    return new Function('return ' + literal + ';')();
}

describe('content dictionary (translating the words inside a drawing)', () => {
    const shippedLanguages = readArrayLiteral(SETTINGS_FILE, 'SHIPPED_APP_LANGUAGES');
    const seed = readArrayLiteral(SEED_FILE, 'export const CONTENT_SEED');
    const dynamicGaps = readArrayLiteral(SEED_FILE, 'CONTENT_SEED_DYNAMIC_GAPS');

    it('ships at least the three declared languages', () => {
        expect(shippedLanguages).to.deep.equal(['zh-cn', 'en', 'ru']);
    });

    it('has a usable number of seeded entries', () => {
        expect(seed.length).to.be.greaterThan(20);
    });

    it('every entry carries a non-empty translation for every shipped language except the master', () => {
        const missing = [];
        for (const entry of seed) {
            for (const language of shippedLanguages) {
                if (language === 'zh-cn') { continue; } // the source itself
                const value = entry.translations && entry.translations[language];
                if (!value || !String(value).trim()) {
                    missing.push(JSON.stringify(entry.source) + ' is missing ' + language);
                }
            }
        }
        expect(missing, 'incomplete seed entries:\n  ' + missing.join('\n  ')).to.deep.equal([]);
    });

    it('no source string is listed twice', () => {
        const seen = new Map();
        const duplicates = [];
        for (const entry of seed) {
            if (seen.has(entry.source)) { duplicates.push(entry.source); }
            seen.set(entry.source, true);
        }
        expect(duplicates).to.deep.equal([]);
    });

    it('no translations are empty, whitespace only, or a copy of the Chinese source', () => {
        const problems = [];
        for (const entry of seed) {
            if (!String(entry.source || '').trim()) {
                problems.push('an entry has no source text');
                continue;
            }
            for (const [language, value] of Object.entries(entry.translations || {})) {
                const text = String(value || '');
                if (!text.trim()) { problems.push(entry.source + ' -> ' + language + ' is empty'); continue; }
                // Latin and Cyrillic translations must differ from the Chinese source;
                // identical text means the entry was added but never translated.
                if (text.trim() === String(entry.source).trim()) {
                    problems.push(entry.source + ' -> ' + language + ' repeats the source');
                }
            }
        }
        expect(problems, 'seed problems:\n  ' + problems.join('\n  ')).to.deep.equal([]);
    });

    it('lists the strings that cannot be translated as literals', () => {
        // A text node holding both a label and a live value ("共计 123294830 次") can never
        // match the dictionary once the value changes. Those have to be split in the drawing,
        // so they are recorded here instead of being silently left in Chinese.
        expect(dynamicGaps.length).to.be.greaterThan(0);
        for (const gap of dynamicGaps) {
            expect(gap.source, 'a dynamic gap needs its original text').to.be.a('string');
            expect(gap.note, gap.source + ' needs a note explaining what to change').to.be.a('string');
            expect(gap.note.length).to.be.greaterThan(10);
        }
    });

    it('uses resolution helpers in the language service, not ad-hoc maps', () => {
        const service = fs.readFileSync(path.join(CLIENT_SRC, 'app', '_services', 'language.service.ts'), 'utf8');
        expect(service).to.contain('resolveSeed');
        expect(service).to.contain('valueIndex');
        expect(service).to.contain('CONTENT_MASTER_LANGUAGE');
    });
});
