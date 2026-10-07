/**
 * Every i18n key the client reads must exist, and the dates must be Chinese (batch 81).
 *
 * WHAT WAS WRONG. paginator-intl.ts fetched 'table.property-paginator-prev-page' and then read the
 * answer back under 'Ptable.property-paginator-prev-page' - one stray letter. The label came back
 * undefined and the previous-page button had no text. Nothing in the repository could notice: the
 * key files are only checked against each other (i18nCoverage), and a key that is never requested
 * is not "missing". The same shape can appear anywhere a translated value is read back by literal.
 *
 * WHAT IT CHECKS, in two parts:
 *   1. key existence - every dotted key literal the client reads (translation['key'], .instant('key'),
 *      translateService.get('key') and its array form) must exist in en.json;
 *   2. the moment locale - the date pickers read weekdaysMin()/monthsShort() at module level, so the
 *      locale has to be set by an IMPORT that runs before AppModule. Measured before the fix: the
 *      client never called moment.locale() and never imported a locale bundle.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const EN = path.join(CLIENT_SRC, 'assets', 'i18n', 'en.json');

function flatten(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, prefix + k + '.'));
        else out[prefix + k] = v;
    }
    return out;
}

function clientFiles(dir, out = [], ext = ['.ts']) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) clientFiles(full, out, ext);
        else if (ext.some((x) => e.name.endsWith(x)) && !e.name.endsWith('.spec.ts')) out.push(full);
    }
    return out;
}

/** The literal keys a TEMPLATE asks for: {{'key' | translate}} and [translate]="'key'". */
function keysUsedInTemplate(text) {
    const keys = [];
    const patterns = [
        /'([A-Za-z0-9_.-]+)'\s*\|\s*translate/g,
        /\[translate\]\s*=\s*"'([A-Za-z0-9_.-]+)'"/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) keys.push(m[1]);
    }
    return keys;
}

/** The literal keys this source text reads back from a translation table. */
function keysReadIn(text) {
    const keys = [];
    const patterns = [
        /translation(?:s)?\s*\[\s*'([^']+)'\s*\]/g,
        /(?:translateService|translate|scadiaLanguage)\s*\.\s*instant\(\s*'([^']+)'\s*\)/g,
        /(?:translateService|translate|scadiaLanguage)\s*\.\s*get\(\s*'([^']+)'\s*\)/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) keys.push(m[1]);
    }
    const arrRe = /(?:translateService|translate|scadiaLanguage)\s*\.\s*get\(\s*\[([^\]]*)\]/g;
    let a;
    while ((a = arrRe.exec(text)) !== null) {
        const inner = a[1];
        const one = /'([^']+)'/g;
        let k;
        while ((k = one.exec(inner)) !== null) keys.push(k[1]);
    }
    return keys;
}

describe('the client only reads translation keys that exist (i18n keys + moment locale)', () => {
    const known = flatten(JSON.parse(fs.readFileSync(EN, 'utf8')));
    const files = clientFiles(CLIENT_SRC);

    it('the scan actually walked the client sources', function () {
        expect(files.length, 'client .ts files scanned').to.be.greaterThan(150);
        expect(Object.keys(known).length, 'keys known to en.json').to.be.greaterThan(2000);
    });

    it('the detector still fires on the stray letter that shipped', function () {
        const detected = keysReadIn("this.previousPageLabel = translation['Ptable.property-paginator-prev-page'];");
        expect(detected).to.deep.equal(['Ptable.property-paginator-prev-page']);
        expect(known['Ptable.property-paginator-prev-page'], 'and that key really does not exist').to.equal(undefined);
        expect(known['table.property-paginator-prev-page'], 'while the correct one does').to.not.equal(undefined);
    });

    it('no client source reads a key that is not in en.json', function () {
        const bad = [];
        let seen = 0;
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            for (const key of keysReadIn(text)) {
                if (!key.includes('.')) continue;                    // a dotted literal is a key, not a word
                if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;        // skip anything dynamic or interpolated
                seen++;
                if (known[key] === undefined) {
                    bad.push(path.relative(CLIENT_SRC, file).replace(/\\/g, '/') + '  ->  ' + key);
                }
            }
        }
        expect(seen, 'key literals actually inspected').to.be.greaterThan(60);
        expect(bad, 'these keys are read but do not exist in en.json:\n  ' + bad.join('\n  ')).to.deep.equal([]);
    });

    it('every key a template asks for exists too', function () {
        const templates = clientFiles(CLIENT_SRC, [], ['.html']);
        expect(templates.length, 'client .html templates scanned').to.be.greaterThan(100);
        const bad = [];
        let seen = 0;
        for (const file of templates) {
            for (const key of keysUsedInTemplate(fs.readFileSync(file, 'utf8'))) {
                if (!key.includes('.')) continue;
                seen++;
                if (known[key] === undefined) {
                    bad.push(path.relative(CLIENT_SRC, file).replace(/\\/g, '/') + '  ->  ' + key);
                }
            }
        }
        expect(seen, 'template key references inspected').to.be.greaterThan(500);
        expect(bad, 'these keys are used by templates but do not exist:\n  ' + bad.join('\n  ')).to.deep.equal([]);
    });

    it('the template detector fires on the shape the templates use', function () {
        expect(keysUsedInTemplate("<div>{{'ar.no-markers' | translate}}</div>")).to.deep.equal(['ar.no-markers']);
        expect(keysUsedInTemplate(`<div>{{'ar.view-not-found' | translate: {id: x} }}</div>`)).to.deep.equal(['ar.view-not-found']);
    });

    it('the date pickers get a Chinese moment locale before AppModule is evaluated', function () {
        const localeModule = path.join(CLIENT_SRC, 'app', '_helpers', 'moment-locale.ts');
        expect(fs.existsSync(localeModule), 'the locale side-effect module must exist').to.equal(true);
        const localeText = fs.readFileSync(localeModule, 'utf8');
        expect(localeText, 'it must actually set the locale').to.match(/moment\.locale\('zh-cn'\)/);
        expect(localeText, 'and must import the locale bundle, not just call locale()').to.contain("moment/locale/zh-cn");

        const mainText = fs.readFileSync(path.join(CLIENT_SRC, 'main.ts'), 'utf8');
        const localeImport = mainText.indexOf("import './app/_helpers/moment-locale'");
        const appModuleImport = mainText.indexOf("from './app/app.module'");
        expect(localeImport, 'main.ts must import the locale module').to.be.greaterThan(-1);
        expect(localeImport, 'and it must come BEFORE the AppModule import, or the calendar captures ' +
            'the English weekday names while its module is being evaluated')
            .to.be.lessThan(appModuleImport);
    });
});
