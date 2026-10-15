'use strict';

/**
 * Guard against re-introducing an upstream author's or an earlier product's identity into
 * anything a customer actually sees, or ships inside.
 *
 * This product went through two renames, and twice a rename left the previous owner's name on
 * something user-facing:
 *   - 'powered by frango team' in the two About dialogs   (frango = the first upstream author)
 *   - 'SCADIA by kcylp' as the PDF report header          (kcylp = the SCADIA author)
 *   - 'kcylp SCADIA OPC UA Server' / 'urn:kcylp:scadia'   (shown to third-party OPC UA clients)
 *
 * Those were fixed. This test keeps them fixed: it is cheap, it names the exact strings, and it
 * explains WHY each remaining occurrence is allowed rather than silently skipping it.
 *
 * A brand guard fails in two boring ways, and this file is written against both.
 *
 * COVERAGE. Only the server sources and client/src were scanned. The built client bundle - the
 * bytes that actually ship - was not, and a stale build is exactly how a renamed string
 * survives a tidy source-level cleanup.
 *
 * EXEMPTIONS. An exemption used to switch off EVERY rule for a whole file. The three files that
 * legitimately hold '@frango.*' preference keys were therefore also exempt from the
 * product-name rule, so a previous product name dropped into the device page would have passed
 * this guard unnoticed. Exemptions are now scoped to the rule they are actually about.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const CLIENT_BUNDLE = path.join(SERVER_ROOT, '..', 'client', 'dist');

const SKIP_DIRS = new Set(['node_modules', '.angular', 'dist', '.git', 'coverage']);

/**
 * Escape hatch for a line that legitimately has to contain a forbidden string.
 * Put the marker in a comment on that exact line so the exception stays local and
 * reviewed: a file-wide exemption would hide the next leak in the same file.
 */
const ALLOW_MARKER = 'branding-guard:allow';

/**
 * Occurrences that are legitimate and must NOT be flagged, scoped to the RULES they excuse.
 *
 * 'rules: ["*"]' means every rule, and is reserved for files that are not part of the product
 * at all (provenance metadata, fixtures). Anything that IS part of the product should name the
 * one rule it needs, so the remaining rules still apply to that file.
 */
const EXEMPTIONS = [
    {
        rules: ['*'],
        files: [/package\.json$/, /package-lock\.json$/, /LICENSE$/],
        why: 'npm package scope and provenance metadata: the upstream project real coordinates'
    },
    {
        rules: ['*'],
        files: [/[\\/]test[\\/]/],
        why: 'test fixtures may use any string as a secret or a sample, and this guard has to name the forbidden names to forbid them'
    },
    {
        rules: ['kcylp-owner'],
        files: [/kiosk-widgets[\\/]kiosk-widgets\.service\.ts$/],
        why: 'the community widget gallery really lives in the upstream author GitHub repository; changing the owner would break the widget browser - a functional dependency, not branding'
    },
    {
        rules: ['powered-by-frango'],
        files: [/[\\/]device\.component\.ts$/, /[\\/]editor\.component\.ts$/, /[\\/]lab\.component\.ts$/],
        why: 'browser preference keys were already persisted under the frango scope, and renaming them would silently reset every existing user saved view and layout. Scoped to the frango rule deliberately: these files are still scanned for every other rule'
    }
];

/** The rule id a file is exempt from (or null). */
function exemptFrom(file, ruleId) {
    for (const exemption of EXEMPTIONS) {
        if (exemption.rules.indexOf('*') === -1 && exemption.rules.indexOf(ruleId) === -1) { continue; }
        if (exemption.files.some((re) => re.test(file))) { return exemption; }
    }
    return null;
}

/** Any exemption at all, for the tests that reason about exemptions themselves. */
function exemptFromAnything(file) {
    return EXEMPTIONS.some((exemption) => exemption.files.some((re) => re.test(file)));
}

function walk(dir, out, pattern, skip) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return out; }
    for (const e of entries) {
        if (skip.has(e.name)) { continue; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, out, pattern, skip); }
        else if (pattern.test(e.name)) { out.push(full); }
    }
    return out;
}

/** Brand strings that must never reach user-facing output. */
const FORBIDDEN = [
    { id: 'powered-by-frango', text: 'powered by frango', pattern: /powered by frango/i, why: 'the very first upstream author, was shown in the About dialogs' },
    { id: 'kcylp-owner',       text: 'by kcylp',          pattern: /by kcylp/i,          why: 'an upstream SCADIA author, was the PDF report header' },
    { id: 'kcylp-urn',         text: 'urn:kcylp',         pattern: /urn:kcylp/i,         why: 'upstream identity, was advertised to OPC UA clients' },
    { id: 'kcylp-opcua',       text: 'kcylp SCADIA',      pattern: /kcylp SCADIA/i,      why: 'upstream identity in the OPC UA application name' },
    // The product is Kaicheng SCADIA. No earlier product name may survive anywhere in the
    // repository - not in code, not in an asset file name, not in a comment that ends up
    // shipped inside a bundle. Only a line carrying ALLOW_MARKER is exempt.
    //
    // This is deliberately scoped to the product name. The separate 'powered by frango' rule
    // above covers the first upstream author, and stays phrase-based on purpose: the broader
    // word also lives in browser preference keys that are already persisted on customer
    // machines and must not be renamed (see EXEMPTIONS).
    { id: 'previous-product-name', text: 'a previous product name', pattern: /fuxa/i, why: 'the product is Kaicheng SCADIA and nothing else' }
];

describe('branding guard (upstream identity must not leak to users)', () => {
    const serverFiles = walk(SERVER_ROOT, [], /\.(js|ts|html)$/, SKIP_DIRS);
    const clientSourceFiles = walk(CLIENT_SRC, [], /\.(js|ts|html)$/, SKIP_DIRS);

    /**
     * The built bundle - the bytes that actually ship - so a stale build cannot outlive a
     * source-level cleanup.
     *
     * Source maps are excluded, and that is a MEASURED decision rather than convenience:
     * vendor.js.map is one line of base64 VLQ in which 'fuxa' occurs as a coincidental
     * substring of the encoding ('IAA+Fuxa,eAAe'). Flagging that would teach the next reader
     * to ignore this guard. No coverage is lost - the sources a map points at are scanned
     * directly in client/src, and the map itself is a debugging artefact, not shipped text.
     */
    const bundleFiles = walk(CLIENT_BUNDLE, [], /\.js$/, new Set(['node_modules', '.git']));

    const files = serverFiles.concat(clientSourceFiles, bundleFiles);

    it('scans a meaningful number of files, including the bundle that ships', () => {
        expect(serverFiles.length).to.be.greaterThan(100);
        expect(clientSourceFiles.length).to.be.greaterThan(100);
        expect(bundleFiles.length, 'the built client bundle must be covered, or a stale build ships unnoticed')
            .to.be.greaterThan(0);
    });

    it('keeps the escape hatch narrow: every exemption states a reason', () => {
        const exemptions = [];
        for (const file of files) {
            if (exemptFromAnything(file)) { continue; }
            let content;
            try { content = fs.readFileSync(file, 'utf8'); } catch (err) { continue; }
            content.split(/\r?\n/).forEach((line, index) => {
                if (line.includes(ALLOW_MARKER)) {
                    exemptions.push({ file: path.relative(SERVER_ROOT, file), line: index + 1, text: line });
                }
            });
        }
        for (const exemption of exemptions) {
            // The marker must be followed by an explanation, not just the bare tag.
            const reason = exemption.text.split(ALLOW_MARKER)[1] || '';
            expect(reason.trim().length, 'exemption at ' + exemption.file + ':' + exemption.line + ' needs a reason')
                .to.be.greaterThan(10);
        }
    });

    it('keeps every file-level exemption scoped to a rule that exists', () => {
        const ids = FORBIDDEN.map((rule) => rule.id);
        for (const exemption of EXEMPTIONS) {
            expect(exemption.why, 'an exemption without a stated reason is a hole nobody can review')
                .to.be.a('string');
            expect(exemption.why.length).to.be.greaterThan(20);
            for (const id of exemption.rules) {
                expect(id === '*' || ids.indexOf(id) !== -1,
                    'exemption names the rule ' + JSON.stringify(id) + ', which is not a rule any more - ' +
                    'a stale exemption is worse than none, because it reads as reviewed')
                    .to.equal(true);
            }
        }
    });

    it('a narrow exemption still lets every other rule catch that same file', () => {
        // This is the reverse verification of the fix above. The three browser-preference files
        // used to be exempt from EVERY rule, so a previous product name dropped into the device
        // page would have passed the guard. The assertion below fails against that old shape.
        const devicePage = files.filter((file) => /[\\/]device\.component\.ts$/.test(file));
        expect(devicePage.length, 'the file holding @frango.* preference keys must still exist').to.equal(1);

        expect(exemptFrom(devicePage[0], 'powered-by-frango'),
            'exempt where it has to be: the persisted preference key')
            .to.not.equal(null);
        expect(exemptFrom(devicePage[0], 'previous-product-name'),
            'but NOT exempt from the product name - that is the hole this closed')
            .to.equal(null);
        expect(exemptFrom(devicePage[0], 'kcylp-owner'),
            'and not exempt from the upstream author either')
            .to.equal(null);
    });

    it('can still fail: a forbidden string in a scanned file is reported', () => {
        // A guard nobody has seen fail is a guard nobody should trust. The rule engine is
        // exercised against a string the scanner would meet, without touching the tree.
        const rule = FORBIDDEN.filter((r) => r.id === 'previous-product-name')[0];
        const sampled = path.join(SERVER_ROOT, 'runtime', 'devices', 'device.js');
        const marked = fs.readFileSync(sampled, 'utf8').split(/\r?\n/)
            .filter((line) => line.includes(ALLOW_MARKER));

        expect(marked.length, 'the legacy identifier is kept reviewable by one local marker').to.equal(1);
        expect(rule.pattern.test(marked[0]),
            'the rule must still match the real legacy identifier it exists to forbid').to.equal(true);
        expect(exemptFrom(sampled, rule.id),
            'and that marker - not a file-wide exemption - is the only thing keeping it green')
            .to.equal(null);
    });

    for (const rule of FORBIDDEN) {
        it('never shows ' + rule.text + ' to a user (' + rule.why + ')', () => {
            const offenders = [];
            for (const file of files) {
                if (exemptFrom(file, rule.id)) { continue; }
                // A stale name must not survive in an asset name either: renaming the file
                // is exactly how a leftover logo or editor bundle is missed.
                if (rule.pattern.test(path.basename(file))) {
                    offenders.push(path.relative(SERVER_ROOT, file) + ' (file name)');
                }
                let content;
                try { content = fs.readFileSync(file, 'utf8'); } catch (err) { continue; }
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(ALLOW_MARKER)) { continue; }
                    if (rule.pattern.test(lines[i])) {
                        offenders.push(path.relative(SERVER_ROOT, file) + ':' + (i + 1));
                    }
                }
            }
            expect(offenders, 'these locations still expose a previous product identity: ' + offenders.join(', '))
                .to.deep.equal([]);
        });
    }

    it('keeps the product name in the report header both server- and client-side', () => {
        const serverReport = fs.readFileSync(path.join(SERVER_ROOT, 'runtime', 'jobs', 'report.js'), 'utf8');
        const clientReport = fs.readFileSync(
            path.join(SERVER_ROOT, '..', 'client', 'src', 'app', 'reports', 'report-editor', 'report-editor.component.ts'), 'utf8');
        expect(serverReport).to.contain('开诚智枢 SCADIA');
        expect(clientReport).to.contain('开诚智枢 SCADIA');
    });
});
