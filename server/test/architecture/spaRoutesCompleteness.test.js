/**
 * The two route tables must say the same thing - guarded, because nothing did.
 *
 * A client route that the server does not answer with index.html is reachable by in-app
 * navigation only. A reload, a bookmark, a shared link or a popup window hits the server
 * directly and gets a 404 body, which the browser paints as a blank page with no error
 * anywhere - the single most expensive defect this project has produced (defect P0-1: the
 * table held 15 of the 29 client routes, so 14 pages white-screened on refresh).
 *
 * The two lists are still handwritten in two languages, and they cannot be merged: one is an
 * Angular Routes array, the other is a list of express static mounts. What CAN be removed is
 * the silence. This guard compares the two sides, in both directions:
 *
 *   - a client route missing from SHELL_ROUTES fails (the white screen comes back);
 *   - a server entry naming no client route fails (a mount nobody can reach, which is how a
 *     dead table entry hides);
 *   - duplicates fail on both sides, because a duplicate is how a hand-merged list loses track.
 *
 * Parse, do not count: both tables are read out of the source text, so the guard also fails
 * when a route is added in the editor and the build is never re-run.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');
const ROUTING_FILE = path.join(CLIENT_SRC, 'app', 'app.routing.ts');
const HMI_MODEL = path.join(CLIENT_SRC, 'app', '_models', 'hmi.ts');
const MAIN_FILE = path.join(SERVER_ROOT, 'main.js');

/** Block comments, line comments and string literals are not route data. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .map((line) => line.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
        .join('\n');
}

/** DEVICE_READONLY is a constant, not a literal: resolve it the way Angular would. */
function deviceReadonlyValue() {
    const src = fs.readFileSync(HMI_MODEL, 'utf8');
    const m = /DEVICE_READONLY\s*=\s*'([^']+)'/.exec(src);
    expect(m, 'client/src/app/_models/hmi.ts no longer declares DEVICE_READONLY as a string').to.not.equal(null);
    return m[1];
}

/** The literal path of every { path: ..., component: ... } entry, minus the wildcard. */
function clientRoutes() {
    const src = stripComments(fs.readFileSync(ROUTING_FILE, 'utf8'));
    const body = src.split('const appRoutes')[1];
    expect(body, 'app.routing.ts no longer declares const appRoutes').to.not.equal(undefined);
    const value = deviceReadonlyValue();
    const routes = [];
    const re = /\{\s*path\s*:\s*([^,]+?)\s*,/g;
    let m;
    while ((m = re.exec(body))) {
        const raw = m[1].trim();
        const literal = raw === 'DEVICE_READONLY' ? value : raw.replace(/^'|'$/g, '');
        if (literal === '**') { continue; }        // the catch-all is not a route
        routes.push(literal);
    }
    return routes;
}

/** Every entry of the SHELL_ROUTES array, in order. */
function shellRoutes() {
    const src = stripComments(fs.readFileSync(MAIN_FILE, 'utf8'));
    const body = src.split('const SHELL_ROUTES = [')[1];
    expect(body, 'main.js no longer declares const SHELL_ROUTES').to.not.equal(undefined);
    const list = body.split('];')[0];
    return list
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter((line) => line.length > 0)
        .map((line) => {
            const m = /^'([^']*)'$/.exec(line);
            expect(m, 'unparseable SHELL_ROUTES entry: ' + JSON.stringify(line)).to.not.equal(null);
            return m[1];
        });
}

/** '/' and '' are the same route; everything else is compared literally. */
const norm = (p) => (p === '/' || p === '' ? '(root)' : p.replace(/^\//, ''));

describe('spa routes (a refresh must never 404 a page the app can navigate to)', () => {
    const client = clientRoutes().map(norm);
    const shell = shellRoutes().map(norm);

    it('the client routing table is parsed, not assumed', function () {
        expect(client.length, 'app.routing.ts parsed to nothing').to.be.greaterThan(20);
        expect(shell.length, 'SHELL_ROUTES parsed to nothing').to.be.greaterThan(20);
    });

    it('no client route is missing from SHELL_ROUTES', function () {
        const missing = client.filter((p) => shell.indexOf(p) === -1);
        expect(missing, 'these client routes would 404 on a reload / bookmark / shared link: ' +
            missing.join(', ')).to.deep.equal([]);
    });

    it('no SHELL_ROUTES entry names a client route that does not exist', function () {
        const extra = shell.filter((p) => client.indexOf(p) === -1);
        expect(extra, 'SHELL_ROUTES mounts pages the Angular router cannot reach: ' +
            extra.join(', ')).to.deep.equal([]);
    });

    it('neither table carries a duplicate', function () {
        const dup = (list) => list.filter((p, i) => list.indexOf(p) !== i);
        expect(dup(client), 'duplicate client routes').to.deep.equal([]);
        expect(dup(shell), 'duplicate SHELL_ROUTES entries').to.deep.equal([]);
    });

    it('the two tables are the same length, so a "both lists" edit is visible as one number', function () {
        expect(client.length).to.equal(shell.length);
    });
});
