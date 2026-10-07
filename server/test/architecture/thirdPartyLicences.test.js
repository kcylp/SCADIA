/**
 * Every third-party artefact that SHIPS must carry its licence (batch 55).
 *
 * WHY THIS IS A GUARD AND NOT A CHECKLIST ITEM. The inventory (24_第三方组件与许可清单.md,
 * THIRD-PARTY-LICENSES.md) is a human document: it records what was true the day it was written, and
 * nothing makes the next person update it. Measured before this landed: 28 vendored js/css files in
 * client/src/assets/lib, of which 22 had no licence notice in their first 400 bytes and NONE of the
 * component folders had a licence file at all. That is a redistribution gap, and redistribution is
 * what this delivery does.
 *
 * WHAT IT ENFORCES, in the two places where third-party code actually lives:
 *   client/src/assets/lib/<component>/   one licence file per component folder
 *   client/src/assets/fonts/             at least the fonts that ship with their own terms
 *
 * WHAT IT DELIBERATELY ACCEPTS. A component folder may carry any file whose name starts with
 * LICENSE / COPYING / NOTICE, in any case and with any suffix (LICENSE-jquery.txt,
 * LICENSE-MIT.txt, ...): the upstream projects do not agree on a name, and rewriting upstream's
 * choice is how a licence file ends up not matching the text it should be.
 *
 * THE EXEMPTIONS ARE NAMED AND REASONED BELOW, not silently skipped. Adding a new exemption means
 * editing this file, which is the point: the next reader sees the decision.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
// FOUR '..' from test/architecture: architecture -> test -> server -> 源代码 -> the workspace that
// holds both the source tree and the human documents. Counting this wrong is not hypothetical: the
// first version used three, so every path below resolved inside 源代码\, all four checks reported
// "missing", and the guard looked like a working guard with four real findings.
const WORKSPACE = path.resolve(__dirname, '..', '..', '..', '..');
const CLIENT_SRC = path.join(WORKSPACE, '源代码', 'client', 'src');
const LIB_DIR = path.join(CLIENT_SRC, 'assets', 'lib');
const FONT_DIR = path.join(CLIENT_SRC, 'assets', 'fonts');

/** Component folders that legitimately have no licence file of their own. */
const EXEMPT_FOLDERS = {};

/** Fonts that must have a licence text placed alongside them. */
const REQUIRED_FONT_LICENCES = [
    { file: 'LICENSE-roboto.txt', why: 'Roboto ships as 12 weight files in the report folder and as web faces here (Apache-2.0)' },
    { file: 'LICENSE-quicksand.txt', why: 'Quicksand ships as 9 web faces across three weights (SIL OFL 1.1)' }
];

const isLicenceFile = (name) => /^(license|copying|notice)/i.test(name);

describe('third-party licences ship with the artefacts they cover', () => {
    it('the vendored library tree was actually found', function () {
        // A guard that scans nothing passes everything - the lesson this session already paid for
        // twice (R1/R2/R3 in batch 52, apiGuestSurface in batch 53).
        expect(fs.existsSync(LIB_DIR), 'client/src/assets/lib is gone; this guard would be vacuous')
            .to.equal(true);
        const folders = fs.readdirSync(LIB_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
        expect(folders.length, 'no component folders under ' + LIB_DIR).to.be.greaterThan(5);
    });

    it('every component folder under assets/lib carries a licence file', function () {
        const missing = [];
        fs.readdirSync(LIB_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).forEach((entry) => {
            if (EXEMPT_FOLDERS[entry.name]) { return; }
            const files = fs.readdirSync(path.join(LIB_DIR, entry.name));
            if (!files.some(isLicenceFile)) {
                missing.push(entry.name + '  (files present: ' + files.slice(0, 4).join(', ') + ')');
            }
        });
        expect(missing, 'these vendored components ship WITHOUT their licence. Redistribution of MIT/' +
            'BSD code requires the notice to travel with it; put the upstream text next to the ' +
            'component (any name starting with LICENSE/COPYING/NOTICE):\n' + missing.join('\n'))
            .to.deep.equal([]);
    });

    it('the fonts that ship their own terms have their licence text alongside', function () {
        const missing = [];
        REQUIRED_FONT_LICENCES.forEach((entry) => {
            if (!fs.existsSync(path.join(FONT_DIR, entry.file))) {
                missing.push(entry.file + '  (' + entry.why + ')');
            }
        });
        expect(missing, 'a font whose licence is not shipped with it is a font the receiver cannot ' +
            'redistribute:\n' + missing.join('\n')).to.deep.equal([]);
    });

    it('the human inventory exists and names what this guard checks', function () {
        // The inventory and the guard must not drift: if somebody deletes the document, this fails
        // here rather than at release time.
        const doc = path.join(WORKSPACE, 'THIRD-PARTY-LICENSES.md');
        expect(fs.existsSync(doc), 'THIRD-PARTY-LICENSES.md is gone').to.equal(true);
        const text = fs.readFileSync(doc, 'utf8');
        // The last entry is the SECTION the delegating party asked to be recorded (the fonts whose
        // terms are not settled yet). It is checked by its heading, so the wording inside stays
        // free to change while the section cannot quietly disappear.
        ['Roboto', 'Quicksand', 'MIT', '字体授权待后续确认'].forEach((needle) => {
            expect(text, 'the inventory no longer mentions ' + needle).to.contain(needle);
        });
    });
});
