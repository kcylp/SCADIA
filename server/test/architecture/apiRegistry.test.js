/**
 * Every REST domain on disk must be in the registry table, and the table must be the only place a
 * domain is mounted.
 *
 * WHAT THIS REPLACES
 *
 * api/index.js used to carry forty hand-written lines: eighteen identical init+use pairs and three
 * that differ. Nothing could tell you whether a domain had been registered at all - a new
 * `api/something/index.js` that nobody added to the list simply did not exist at runtime, with no
 * error and no log. Nor could anything tell you whether the MOUNT ORDER had drifted, and order is
 * load-bearing here: express matches in registration order and the middleware above the block runs
 * first for every request.
 *
 * Two of the three exceptions are asserted as exceptions, not averaged away: the auth domain takes
 * the JWT configuration instead of the group checker, and reporting takes no group checker at all.
 * A later "simplification" to "everyone takes the same three arguments" would quietly change how
 * those two authenticate, so the table is checked for those exact entries.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const API_DIR = path.join(SERVER_ROOT, 'api');
const API_INDEX = path.join(API_DIR, 'index.js');

/**
 * Domains that are registered without an api/<name>/index.js.
 *
 * `reports` is the only one, and the difference is real rather than an oversight: it is the one API
 * domain written in TypeScript (api/reports/reports.service.ts), compiled to server/dist and required
 * from there. It therefore has no `index.js` for this guard to find - and, worth knowing, editing
 * the .ts without running `npm run build` edits a dead file.
 */
const NO_INDEX_JS_DOMAINS = ['reports'];

/** Directories under api/ that are a REST domain: they own an index.js. */
function domainDirectories() {
    return fs.readdirSync(API_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => fs.existsSync(path.join(API_DIR, entry.name, 'index.js')))
        .map((entry) => entry.name)
        .sort();
}

/** The `name` values declared in the API_REGISTRY table, in order. */
function registryNames() {
    const source = fs.readFileSync(API_INDEX, 'utf8');
    const start = source.indexOf('const API_REGISTRY = [');
    expect(start, 'api/index.js no longer declares const API_REGISTRY').to.be.greaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = source.indexOf('[', start); i < source.length; i++) {
        if (source[i] === '[') { depth++; }
        else if (source[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    expect(end, 'the API_REGISTRY array is not closed').to.be.greaterThan(-1);
    const body = source.slice(start, end);
    const names = [];
    const re = /\{\s*name:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(body))) { names.push(m[1]); }
    return names;
}

describe('the API registry is the single place a domain is mounted', () => {
    const onDisk = domainDirectories();
    const registered = registryNames();

    it('the domain list and the table were both read', function () {
        expect(onDisk.length, 'no API domains found under ' + API_DIR).to.be.greaterThan(15);
        expect(registered.length, 'API_REGISTRY parsed to nothing').to.be.greaterThan(15);
    });

    it('every domain on disk is registered', function () {
        const missing = onDisk.filter((name) => registered.indexOf(name) === -1);
        expect(missing, 'these API domains exist but are never mounted - the routes answer 404 ' +
            'with no error anywhere: ' + missing.join(', ')).to.deep.equal([]);
    });

    it('the table registers nothing that is not a domain on disk', function () {
        const extra = registered
            .filter((name) => onDisk.indexOf(name) === -1)
            .filter((name) => NO_INDEX_JS_DOMAINS.indexOf(name) === -1);
        expect(extra, 'API_REGISTRY mounts something that has no api/<name>/index.js: ' + extra.join(', '))
            .to.deep.equal([]);
    });

    it('the domains without an index.js are exactly the recorded ones', function () {
        // So the exemption cannot quietly grow to cover a domain that simply forgot its index.js.
        const missingIndex = registered.filter((name) => onDisk.indexOf(name) === -1);
        expect(missingIndex.sort()).to.deep.equal(NO_INDEX_JS_DOMAINS.slice().sort());
    });

    it('no domain is registered twice', function () {
        const dup = registered.filter((name, i) => registered.indexOf(name) !== i);
        expect(dup, 'a domain mounted twice would run its middleware twice per request: ' + dup.join(', '))
            .to.deep.equal([]);
    });

    it('the mount order is exactly the recorded one', function () {
        // Frozen deliberately: the order is behaviour (express matches in registration order), so
        // changing it has to be an edit here as well as there.
        expect(registered).to.deep.equal([
            'projects', 'users', 'alarms', 'auth', 'plugins', 'diagnose', 'daq', 'scheduler',
            'recipes', 'scripts', 'resources', 'command', 'calibration', 'cameras',
            'opcua-server', 'devices', 'reports', 'apikeys', 'reporting'
        ]);
    });

    it('the two domains with their own init signature still declare it', function () {
        const source = fs.readFileSync(API_INDEX, 'utf8');
        const table = source.slice(source.indexOf('const API_REGISTRY = ['), source.indexOf('];', source.indexOf('const API_REGISTRY = [')));
        expect(table, 'the auth domain must take the JWT configuration, not the group checker')
            .to.contain('authJwt.tokenExpiresIn');
        expect(table, 'the reporting domain must take no group checker')
            .to.contain('ctx.authMiddleware');
        expect(source, 'reports is a class from the compiled TypeScript service and must be instantiated')
            .to.contain('ReportsApiService');
    });

    it('the hand-written init+use pairs are gone for good', function () {
        // The whole point: one mounting mechanism, not two.
        const source = fs.readFileSync(API_INDEX, 'utf8');
        const code = source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
        const pairs = code.match(/\w+Api\.init\(/g) || [];
        expect(pairs.length, 'the per-domain variable pairs are back: ' + pairs.join(', ')).to.equal(0);
    });
});
