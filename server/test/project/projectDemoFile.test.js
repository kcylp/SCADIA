/**
 * The demo project that ships with the software must be loadable (batch 74).
 *
 * WHAT WAS WRONG. GET /api/projectdemo answered 500 on every call, and the "load the demo project"
 * path could never work, because of one BOM:
 *
 *   runtime/project/index.js  getProjectDemo()
 *     return JSON.parse(fs.readFileSync(demoProject, 'utf8'))
 *
 * and `project.demo.scadiap` begins with a UTF-8 BOM (U+FEFF), which JSON.parse rejects with
 * "Unexpected token". Measured: the file is 268929 bytes and its first code point is U+FEFF;
 * JSON.parse throws on it and succeeds on the same text with the BOM stripped.
 *
 * WHY NOBODY HAD SEEN IT: the hand-off card recorded the demo import as never having been tested
 * ("怎么导入我没有实测过"). It is a two-line path that nothing in the gate walked, so the reader
 * could not read the file it was shipped with and every other test stayed green.
 *
 * WHAT THIS PINS, in two halves, because either one alone would pass while the feature is broken:
 *   1. the demo FILE still starts with a BOM - if somebody strips the BOM from the data, the reader's
 *      normalisation becomes untested, and this file says so rather than silently passing;
 *   2. the READER still normalises it - the assertion is on the real function's source, because
 *      calling it needs a booted settings object and this guard has to stay cheap.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const DEMO_FILE = path.join(SERVER_ROOT, 'project.demo.scadiap');
const READER = path.join(SERVER_ROOT, 'runtime', 'project', 'index.js');

/** The keys the demo document carries - read off the file, not invented. */
const EXPECTED_KEYS = ['devices', 'hmi', 'version', 'name', 'charts', 'server'];

describe('the shipped demo project can actually be loaded', () => {
    it('the demo file exists and is not empty', function () {
        expect(fs.existsSync(DEMO_FILE), 'project.demo.scadiap is gone from ' + SERVER_ROOT).to.equal(true);
        expect(fs.statSync(DEMO_FILE).size, 'the demo file is suspiciously small').to.be.greaterThan(10000);
    });

    it('the file starts with a UTF-8 BOM, which is exactly why the reader must strip it', function () {
        const raw = fs.readFileSync(DEMO_FILE, 'utf8');
        expect(raw.charCodeAt(0), 'the demo file no longer starts with a BOM: if the DATA changed, the ' +
            'reader normalisation below is now untested - update this guard deliberately').to.equal(0xFEFF);
        expect(() => JSON.parse(raw), 'JSON.parse is expected to REJECT this file as it ships').to.throw();
    });

    it('stripping the BOM yields the project document', function () {
        const parsed = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8').replace(/^\uFEFF/, ''));
        expect(parsed).to.be.an('object');
        EXPECTED_KEYS.forEach((key) => {
            expect(parsed, 'the demo project no longer carries ' + key).to.have.property(key);
        });
    });

    it('getProjectDemo() strips the BOM before parsing', function () {
        const source = fs.readFileSync(READER, 'utf8');
        const body = source.slice(source.indexOf('function getProjectDemo()'));
        const fn = body.slice(0, body.indexOf('\n}'));
        expect(fn, 'getProjectDemo no longer exists in runtime/project/index.js').to.contain('getProjectDemo');
        expect(fn, 'getProjectDemo reads the demo file without stripping the BOM: JSON.parse will throw on ' +
            'every call and GET /api/projectdemo will answer 500 again').to.match(/replace\(\/\^\\uFEFF\//);
    });
});
