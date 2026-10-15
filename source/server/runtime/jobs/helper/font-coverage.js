/**
 * 'jobs/helper/font-coverage': pick a PDF font that can actually draw the report language.
 *
 * A PDF embeds a font; a character the font has no glyph for is not substituted at
 * render time, it is simply drawn as nothing. The report generator used Roboto for every
 * language: Roboto covers Latin and Cyrillic but has no CJK glyphs at all, so a Chinese
 * report - the master language, the one every project starts in - was being produced with
 * an invisible header and blank text wherever a report item contained Chinese.
 *
 * Nothing threw and nothing logged, which is why it went unnoticed. This module makes the
 * question explicit: for a given language, which font covers it, and if none does, say so.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BUNDLED_FONT_DIR = path.join(__dirname, '..', 'fonts');

/** One representative character per script is enough to prove coverage in practice. */
const SCRIPT_PROBES = {
    cjk: [0x5F00, 0x62A5, 0x8BBE, 0x5165],          // kai bao she ru
    cyrillic: [0x0410, 0x044F, 0x0451],              // A ya yo
    latin: [0x41, 0x7A]                              // A z
};

/** Script a language is written in, for font selection. */
function languageScript(languageId) {
    if (languageId === 'zh-cn') { return 'cjk'; }
    if (languageId === 'ru') { return 'cyrillic'; }
    return 'latin';
}

/** Read the cmap table and answer: does this font contain these code points. */
function readCmap(file) {
    const buf = fs.readFileSync(file);
    const numTables = buf.readUInt16BE(4);
    let cmapOffset = 0;
    for (let i = 0; i < numTables; i++) {
        const record = 12 + i * 16;
        if (buf.toString('ascii', record, record + 4) === 'cmap') {
            cmapOffset = buf.readUInt32BE(record + 8);
            break;
        }
    }
    if (!cmapOffset) { throw new Error('no cmap table'); }

    const subtables = [];
    const count = buf.readUInt16BE(cmapOffset + 2);
    for (let i = 0; i < count; i++) {
        const record = cmapOffset + 4 + i * 8;
        const offset = cmapOffset + buf.readUInt32BE(record + 4);
        subtables.push({ offset, format: buf.readUInt16BE(offset) });
    }

    return function lookup(codePoint) {
        for (const subtable of subtables) {
            if (subtable.format === 4) {
                const segCount = buf.readUInt16BE(subtable.offset + 6) / 2;
                const endBase = subtable.offset + 14;
                const startBase = endBase + segCount * 2 + 2;
                const deltaBase = startBase + segCount * 2;
                const rangeBase = deltaBase + segCount * 2;
                for (let s = 0; s < segCount; s++) {
                    const end = buf.readUInt16BE(endBase + s * 2);
                    const start = buf.readUInt16BE(startBase + s * 2);
                    if (codePoint >= start && codePoint <= end) {
                        const delta = buf.readInt16BE(deltaBase + s * 2);
                        const rangeOffset = buf.readUInt16BE(rangeBase + s * 2);
                        if (rangeOffset === 0) { return (codePoint + delta) & 0xffff; }
                        const glyph = buf.readUInt16BE(rangeBase + s * 2 + rangeOffset + (codePoint - start) * 2);
                        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
                    }
                }
            } else if (subtable.format === 12) {
                const groups = buf.readUInt32BE(subtable.offset + 12);
                for (let g = 0; g < groups; g++) {
                    const group = subtable.offset + 16 + g * 12;
                    const start = buf.readUInt32BE(group);
                    const end = buf.readUInt32BE(group + 4);
                    if (codePoint >= start && codePoint <= end) {
                        return buf.readUInt32BE(group + 8) + (codePoint - start);
                    }
                }
            }
        }
        return 0;
    };
}

/** True when the font file contains a glyph for every probe of the script. */
function coversScript(file, script, cache) {
    if (!file || !fs.existsSync(file)) { return false; }
    try {
        let lookup = cache && cache.get(file);
        if (!lookup) {
            lookup = readCmap(file);
            if (cache) { cache.set(file, lookup); }
        }
        return (SCRIPT_PROBES[script] || []).every(cp => lookup(cp) !== 0);
    } catch (err) {
        return false;
    }
}

/** Characters of the text the font cannot draw. Warn before producing a blank PDF. */
function missingCharacters(file, text, cache) {
    if (!file || !fs.existsSync(file) || !text) { return []; }
    try {
        let lookup = cache && cache.get(file);
        if (!lookup) {
            lookup = readCmap(file);
            if (cache) { cache.set(file, lookup); }
        }
        const missing = [];
        for (const ch of String(text)) {
            const cp = ch.codePointAt(0);
            if (cp > 0x20 && cp !== 0x7f && lookup(cp) === 0 && missing.indexOf(ch) < 0) {
                missing.push(ch);
            }
        }
        return missing;
    } catch (err) {
        return [];
    }
}

/** Platform candidates, best first. A customer can always point at their own font. */
const CJK_CANDIDATES = [
    path.join(BUNDLED_FONT_DIR, 'NotoSansSC-Regular.ttf'),
    path.join(BUNDLED_FONT_DIR, 'SourceHanSansSC-Regular.ttf'),
    path.join(BUNDLED_FONT_DIR, 'simhei.ttf'),
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/Deng.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
    '/System/Library/Fonts/PingFang.ttc'
];

const LATIN_FAMILY = {
    normal: path.join(BUNDLED_FONT_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(BUNDLED_FONT_DIR, 'Roboto-Medium.ttf'),
    italics: path.join(BUNDLED_FONT_DIR, 'Roboto-Italic.ttf'),
    bolditalics: path.join(BUNDLED_FONT_DIR, 'Roboto-MediumItalic.ttf')
};

/**
 * Font family to use for a report in the given language.
 *
 * Returns family, script, covered, source and missing. covered:false means the language
 * characters will not be drawn - the caller is expected to log it rather than ship a
 * silently blank document.
 */
function resolveReportFont(languageId, options) {
    const script = languageScript(languageId);
    const cache = (options && options.cache) || new Map();
    const configured = options && options.cjkFontPath;

    if (script !== 'cjk') {
        const covered = coversScript(LATIN_FAMILY.normal, script, cache);
        return { family: LATIN_FAMILY, script, covered, source: 'bundled Roboto', configuredRejected: false, missing: [] };
    }

    const candidates = [configured].concat(CJK_CANDIDATES).filter(Boolean);
    // A configured font that cannot draw the script is a misconfiguration. It is skipped -
    // a working fallback beats a broken deliberate choice - but the fact is reported so the
    // operator can see that their setting was not honoured instead of wondering why.
    let configuredRejected = false;
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) {
            if (candidate === configured) { configuredRejected = true; }
            continue;
        }
        if (!coversScript(candidate, 'cjk', cache)) {
            if (candidate === configured) { configuredRejected = true; }
            continue;
        }
        return { family: candidate, script, covered: true, source: candidate, configuredRejected, missing: [] };
    }

    return {
        family: LATIN_FAMILY,
        script,
        covered: false,
        source: 'bundled Roboto (no CJK glyphs)',
        configuredRejected,
        missing: []
    };
}

module.exports = {
    SCRIPT_PROBES,
    languageScript,
    coversScript,
    missingCharacters,
    resolveReportFont,
    readCmap,
    CJK_CANDIDATES,
    LATIN_FAMILY
};
