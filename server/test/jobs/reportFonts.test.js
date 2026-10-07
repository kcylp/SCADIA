'use strict';

/**
 * A PDF never substitutes a missing glyph: it draws nothing, throws nothing and logs
 * nothing. The report generator used Roboto for every language, and Roboto has no CJK
 * glyphs at all, so Chinese reports - the master language - were produced with an invisible
 * header and blank text, completely silently.
 *
 * These tests keep that specific failure impossible to reintroduce: they check the font
 * actually chosen for each shipped language, and they build a real PDF to prove the glyphs
 * end up embedded.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const coverage = require(path.join(SERVER_ROOT, 'runtime', 'jobs', 'helper', 'font-coverage'));

const ROBOTO = coverage.LATIN_FAMILY.normal;

describe('report fonts (a PDF draws nothing for a glyph the font lacks)', () => {

    it('the coverage probe reads the font correctly', () => {
        // Sanity: the tool must be able to tell scripts apart, otherwise every other
        // assertion below is meaningless.
        expect(fs.existsSync(ROBOTO), 'bundled Roboto is missing').to.equal(true);
        expect(coverage.coversScript(ROBOTO, 'latin')).to.equal(true);
        expect(coverage.coversScript(ROBOTO, 'cyrillic')).to.equal(true);
        expect(coverage.coversScript(ROBOTO, 'cjk')).to.equal(false);
    });

    it('reports exactly which Chinese characters Roboto cannot draw', () => {
        const missing = coverage.missingCharacters(ROBOTO, '开诚智枢 SCADIA');
        expect(missing).to.deep.equal(['开', '诚', '智', '枢']);
    });

    it('maps each shipped language to its script', () => {
        expect(coverage.languageScript('zh-cn')).to.equal('cjk');
        expect(coverage.languageScript('ru')).to.equal('cyrillic');
        expect(coverage.languageScript('en')).to.equal('latin');
    });

    it('uses a Cyrillic-capable font for Russian and English', () => {
        for (const language of ['ru', 'en']) {
            const resolved = coverage.resolveReportFont(language);
            expect(resolved.covered, language + ' has no usable font').to.equal(true);
            expect(coverage.coversScript(resolved.family.normal, resolved.script)).to.equal(true);
        }
    });

    it('uses a CJK-capable font for Simplified Chinese when one is available', () => {
        const resolved = coverage.resolveReportFont('zh-cn');
        if (resolved.covered) {
            expect(resolved.family, 'a covered result must name the font it chose').to.be.a('string');
            expect(coverage.coversScript(resolved.family, 'cjk'),
                'the font chosen for Chinese does not actually cover CJK').to.equal(true);
        } else {
            // No CJK font on this machine: the resolver must say so rather than pretend.
            expect(resolved.source).to.contain('no CJK glyphs');
        }
    });

    it('tries a configured CJK font first, and reports it when it cannot be used', () => {
        // Roboto is configured but cannot draw CJK: it must be skipped rather than trusted,
        // and the fact must be visible - a silently ignored setting is its own support ticket.
        const rejected = coverage.resolveReportFont('zh-cn', { cjkFontPath: ROBOTO });
        expect(rejected.configuredRejected, 'a rejected configured font must be reported').to.equal(true);
        expect(rejected.source, 'a font that cannot draw CJK must not be selected').to.not.equal(ROBOTO);

        // A configured font that does cover CJK wins over the built-in candidates.
        const usable = coverage.CJK_CANDIDATES.find(c => fs.existsSync(c) && coverage.coversScript(c, 'cjk'));
        if (usable) {
            const resolved = coverage.resolveReportFont('zh-cn', { cjkFontPath: usable });
            expect(resolved.family).to.equal(usable);
            expect(resolved.configuredRejected).to.equal(false);
        }
    });

    it('embeds a CJK-capable font in a real Chinese PDF', async function () {
        this.timeout(30000);
        const resolved = coverage.resolveReportFont('zh-cn');
        if (!resolved.covered) {
            this.skip(); // no CJK font installed here; covered by the honesty test above
        }
        const Pdfmake = require(path.join(SERVER_ROOT, 'node_modules', 'pdfmake'));
        const pdfmake = new Pdfmake({
            Roboto: { normal: resolved.family, bold: resolved.family, italics: resolved.family, bolditalics: resolved.family }
        });
        const binary = await new Promise((resolve, reject) => {
            try {
                const doc = pdfmake.createPdfKitDocument({ content: [{ text: '开诚智枢 报警时间：' }] });
                const chunks = [];
                doc.on('data', c => chunks.push(c));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.end();
            } catch (err) { reject(err); }
        });
        expect(binary.slice(0, 5).toString()).to.equal('%PDF-');
        const text = binary.toString('latin1');
        // pdfkit subsets the face and names it after the source font.
        expect(text, 'the PDF does not embed the CJK font').to.match(/SimHei|NotoSansSC|SourceHanSans|Deng|PingFang|wqy/i);
    });

    it('leaves a visible trace when a Chinese report falls back to a Latin-only font', () => {
        // The old behaviour produced a blank document with no signal at all. The generator
        // logs a warning in that case; this asserts the warning text exists in the source.
        const report = fs.readFileSync(path.join(SERVER_ROOT, 'runtime', 'jobs', 'report.js'), 'utf8');
        expect(report).to.contain('resolveReportFont');
        expect(report).to.contain('report.font.missing.glyphs');
    });
});
