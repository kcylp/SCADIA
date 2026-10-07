/**
 * Chinese must be Chinese: a zh-cn value may not still be the English one (R4, batch 80).
 *
 * WHY THIS GUARD EXISTS. `i18nCoverage.test.js` already pins the shape of the three language files
 * (every key present, placeholders balanced, values non-empty). None of that notices the defect that
 * actually reached the operator: 126 keys in zh-cn.json carried the ENGLISH value verbatim - the
 * alarm import dialog, the editor's control palette, the script function tooltips, the report
 * filter, the alarm export toasts. The file looked complete and the UI was half English.
 *
 * HOW IT DECIDES. A value is "still English" when it contains a Latin word of four or more letters
 * and no CJK character at all. That rule alone would flag 46 legitimate entries, so the exemptions
 * are named and each one is checked:
 *   - key ends with -text     : the signature the script editor INSERTS ($setTag (TagID, value)).
 *                               It is code, not prose - translating it would break the inserted script.
 *   - key ends with -params   : the parameter placeholders shown next to that signature.
 *   - value starts with $     : a signature under some other key name.
 *   - TOKENS below            : product names, protocol names and symbols (SCADIA, JSON, RTSP...).
 * The exemptions are bounded on purpose: if the pattern ever swallows the file, or the token list
 * grows, this fails rather than silently forgiving. Every token must still exist AND still be
 * English-looking, so a stale entry fails instead of rotting.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const CLIENT_I18N = path.join(__dirname, '..', '..', '..', 'client', 'src', 'assets', 'i18n');
const ZH = path.join(CLIENT_I18N, 'zh-cn.json');
const EN = path.join(CLIENT_I18N, 'en.json');

/** Product names, protocol names, symbols. Each is a thing, not a translation. */
const TOKENS = [
    'dlg.info-title',                        // SCADIA - the product's own name
    'dlg.app-settings-node-red',             // Node-RED - product name
    'dlg.app-settings-swagger',              // Swagger - product name
    'dlg.app-settings-smtp',                 // SMTP - protocol name
    'camera.endpoint.rtsp',                  // RTSP - protocol name
    'device.property-melsec-ascii',          // ASCII - encoding name
    'devices.export-json',                   // JSON - format name
    'device.topic-json',                     // json - format name
    'editor.interactivity-class'             // class: - the HTML attribute itself
];

/** Both shapes occur in these files: flat dotted keys AND nesting. Flatten to dotted paths. */
function flatten(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, prefix + k + '.'));
        else out[prefix + k] = v;
    }
    return out;
}

/** True when the string is English prose rather than a symbol, a number or Chinese. */
function isEnglishLooking(value) {
    if (typeof value !== 'string') return false;
    if (/[\u4e00-\u9fff]/.test(value)) return false;      // it contains Chinese: it is translated
    return /[A-Za-z]{4,}/.test(value);                       // ... and it carries a real Latin word
}

function exemptedByPattern(key, value) {
    if (key.endsWith('-text')) return 'the signature the script editor inserts';
    if (key.endsWith('-params')) return 'a parameter placeholder';
    if (typeof value === 'string' && value.trim().startsWith('$')) return 'a signature';
    return null;
}

describe('the Chinese translation file is actually Chinese (R4)', () => {
    const zh = flatten(JSON.parse(fs.readFileSync(ZH, 'utf8')));
    const en = flatten(JSON.parse(fs.readFileSync(EN, 'utf8')));

    it('the file was found and read in full', function () {
        expect(Object.keys(zh).length, 'leaf keys in zh-cn.json').to.be.greaterThan(2000);
        expect(Object.keys(zh).length, 'the two files must describe the same surface')
            .to.equal(Object.keys(en).length);
    });

    it('the detector still fires on the exact shape that shipped', function () {
        expect(isEnglishLooking('Import Alarms'), 'the alarm import title as it shipped').to.equal(true);
        expect(isEnglishLooking('Import alarms failed!')).to.equal(true);
        expect(isEnglishLooking('\\u5bfc\\u5165\\u62a5\\u8b66')).to.equal(false);   // 导入报警
        expect(isEnglishLooking('X')).to.equal(false);
        expect(isEnglishLooking('HH:mm')).to.equal(false);
        expect(isEnglishLooking('x1')).to.equal(false);
    });

    it('no zh-cn value is left in English', function () {
        const unexplained = [];
        for (const [key, value] of Object.entries(zh)) {
            if (!isEnglishLooking(value)) continue;
            if (exemptedByPattern(key, value)) continue;
            if (TOKENS.includes(key)) continue;
            unexplained.push(key + ' = ' + JSON.stringify(value).slice(0, 80));
        }
        expect(unexplained, 'these keys still carry English text in the Chinese file:\n  ' +
            unexplained.join('\n  ')).to.deep.equal([]);
    });

    it('the pattern exemptions cannot quietly swallow the file', function () {
        const byPattern = Object.entries(zh).filter(([k, v]) => isEnglishLooking(v) && exemptedByPattern(k, v));
        expect(byPattern.length, 'signatures + parameter placeholders').to.be.lessThan(60);
    });

    it('every token exemption still exists and still needs it', function () {
        expect(TOKENS.length, 'keep this list short: it is for names, not for untranslated prose')
            .to.be.lessThan(15);
        for (const key of TOKENS) {
            expect(zh[key], 'token exemption no longer in the file: ' + key).to.not.equal(undefined);
            expect(isEnglishLooking(zh[key]), 'token exemption is no longer English-looking, drop it: ' + key)
                .to.equal(true);
        }
    });
});
