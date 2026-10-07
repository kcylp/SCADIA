/**
 * One entry guard per domain, and the cache policy stays visible in one table.
 *
 * Eighteen domains opened app() with their own copy of the same middleware (batch 62
 * measured every one of them). The copies had already split: eleven answered 404 and moved
 * on, five also sent `Cache-Control: no-store`, and the five wrote it two different ways
 * (early return vs else branch). None of that is visible by reading the files one at a time,
 * which is exactly why the copies survived.
 *
 * The header is a POLICY rather than an accident: recipes/index.js carries the reason -
 * Express sends ETags, the browser revalidates, the answer is 304, and Angular's HttpClient
 * treats 304 as an error, so `no-store` forces a fresh 200 every time. The five that send it
 * and the eleven that do not are therefore recorded below instead of being averaged away.
 * Whether the eleven SHOULD send it is N-44, a finding in 20_代码进度.md - not something a
 * refactor gets to decide quietly.
 *
 * Reverse verification cannot use this file cheaply (it needs a copy to reappear rather than
 * a line to change), so the rule is proven by the migration: before batch 62 this guard
 * would have named all eighteen domains.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const API_DIR = path.join(SERVER_ROOT, 'api');
const SHARED = path.join(API_DIR, '_domain.js');

/**
 * The domains whose entry guard sends Cache-Control: no-store, with the reason that domain
 * is on the list. A domain that moves on or off this list must be moved here in the same
 * change, with a reason - that is the point of the table.
 */
const NO_STORE = {
    'cameras': 'camera list/metadata feeds a video wall that must not show a stale frame',
    'devices': 'device + tag documents an integration script re-reads after every edit',
    'calibration': 'a calibration session changes under the operator between polls',
    'recipes': 'recipes/index.js documents it: ETag revalidation answers 304, which Angular HttpClient reports as an error',
    'opcua-server': 'publishing status is polled while the operator toggles the server'
};

/** A REST domain: a directory under api/ that owns an index.js. */
function domains() {
    return fs.readdirSync(API_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => fs.existsSync(path.join(API_DIR, entry.name, 'index.js')))
        .map((entry) => entry.name)
        .sort();
}

function source(domain) {
    return fs.readFileSync(path.join(API_DIR, domain, 'index.js'), 'utf8');
}

describe('the API domain entry guard is written once', () => {
    const list = domains();

    it('the scan really scanned something', function () {
        expect(list.length, 'no API domains found under ' + API_DIR).to.be.greaterThan(15);
        expect(fs.existsSync(SHARED), 'api/_domain.js is gone - every domain would hand-roll again').to.equal(true);
        expect(typeof require(SHARED).projectGuard, 'api/_domain.js no longer exports projectGuard').to.equal('function');
    });

    it('no domain hand-writes the project guard any more', function () {
        const offenders = [];
        list.forEach((domain) => {
            const text = source(domain);
            const lines = text.split(/\r?\n/);
            lines.forEach((line, index) => {
                if (!/\.use\(\s*function\s*\(/.test(line)) { return; }
                const block = lines.slice(index, index + 12).join('\n');
                if (block.indexOf('runtime.project') >= 0) {
                    offenders.push('api/' + domain + '/index.js:' + (index + 1) +
                        ' still carries its own project guard');
                }
            });
        });
        expect(offenders, 'these domains write the entry guard by hand again; call ' +
            'projectGuard(() => runtime) from api/_domain.js:\n' + offenders.join('\n')).to.deep.equal([]);
    });

    it('every domain applies the shared guard', function () {
        const missing = list.filter((domain) => source(domain).indexOf('projectGuard(') < 0);
        expect(missing, 'these domains never apply the entry guard at all: ' + missing.join(', '))
            .to.deep.equal([]);
    });

    it('the cache policy is exactly the recorded table', function () {
        const sends = list.filter((domain) => /projectGuard\(\s*\(\)\s*=>\s*runtime\s*,\s*\{\s*noStore:\s*true\s*\}/.test(source(domain)));
        expect(sends.sort(), 'a domain changed its Cache-Control policy without changing the table above')
            .to.deep.equal(Object.keys(NO_STORE).sort());
        Object.keys(NO_STORE).forEach((domain) => {
            expect(list, domain + ' is recorded in the policy table but is not a domain').to.include(domain);
            expect(NO_STORE[domain].length, domain + ' is on the no-store list without a reason').to.be.greaterThan(30);
        });
    });

    it('a domain that imports the guard also calls it', function () {
        // Importing without calling is how a copy-paste refactor loses the 404-even-without-a-project
        // behaviour silently: the routes would answer 500s instead.
        const inert = list.filter((domain) => {
            const text = source(domain);
            return text.indexOf("require('../_domain')") >= 0 && text.indexOf('projectGuard(') < 0;
        });
        expect(inert, 'these domains import projectGuard and never call it: ' + inert.join(', ')).to.deep.equal([]);
    });
});
