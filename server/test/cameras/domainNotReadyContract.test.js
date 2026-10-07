/**
 * The not-ready contract, HELD OPEN instead of raced.
 *
 * WHAT THIS PINS. A domain service that is still booting must answer **503 + the domain's own JSON
 * error frame** - "come back" - and never 500, and never an HTML page. The sibling test
 * (domainBootRace.test.js) tries to catch the same defect by starting a real server and polling
 * through a boot window that is MILLISECONDS wide, so it catches it only by luck: it was reported
 * as "non-deterministically green" for weeks.
 *
 * Here the window cannot close. Every route is mounted with a runtime whose domain services are
 * absent - exactly the state a route sees during boot - and each GET route is called once. The
 * reason the window had to be held open is in api/_domain.js: the routes call their guard as an
 * ARGUMENT (`handle(service().getProfiles(), ...)`), so a synchronous throw escapes before the
 * module's own .catch can run, and Express's default handler answers 500 + HTML.
 *
 * MEASURED before the fix (2026-10-06):
 *     GET /api/calibration/profiles -> 500, content-type text/html, body "<!DOCTYPE html>..."
 * MEASURED after: -> 503 application/json {"error":"CAL_NOT_READY",...}
 */

'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');

/**
 * Every GET path an app serves, with :params filled in so they can be called.
 * Recurses into mounted sub-apps and routers - the domain app is mounted with app.use(), so its
 * routes live one level down (the first version of this helper found zero routes and the test
 * reported "no GET route was found", which is the vacuity guard doing its job).
 */
/**
 * Every GET path the app serves directly, with :params filled in so they can be called.
 *
 * NO PREFIX PARAMETER, ON PURPOSE: the first version of this helper took one and pushed
 * `prefix + path` - so calling it as getRoutesOf(app) produced paths like
 * "undefined/api/calibration/profiles", every request answered 400, and the test still "passed"
 * its two negative assertions (400 is neither a 5xx nor HTML). The diagnostic on the positive
 * assertion is what exposed it. A helper that can silently prefix a path with undefined is not
 * worth keeping; if these domains ever move their routes into a sub-router, the
 * 'registers GET routes to exercise' guard below goes red instead.
 */
function getRoutesOf(app) {
    const stack = (app && app._router && app._router.stack) || [];
    const out = [];
    for (const layer of stack) {
        if (!layer.route) { continue; }
        if (!layer.route.methods || !layer.route.methods.get) { continue; }
        out.push(layer.route.path.replace(/:([A-Za-z0-9_]+)/g, 'probe-$1'));
    }
    return out;
}

function get(port, urlPath) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, timeout: 5000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: body.slice(0, 300) }));
        });
        req.on('error', (e) => resolve({ status: 0, type: '', body: 'ERR ' + e.code }));
        req.end();
    });
}

/** Mount one api module with its domain services ABSENT, and call every GET route. */
async function probeDomain(modulePath) {
    delete require.cache[require.resolve(path.join(SERVER_ROOT, modulePath))];
    const api = require(path.join(SERVER_ROOT, modulePath));
    const silent = { error() { }, warn() { }, info() { }, debug() { } };
    // `project` is present (so projectGuard lets the request through) but the domain services are
    // NOT: that is the boot window.
    const runtime = {
        project: { id: 'probe' },
        settings: { secureEnabled: false, calibration: { enabled: true, writeEnabled: true }, cameras: { enabled: true } },
        logger: silent
    };
    api.init(runtime, (req, res, next) => next(), () => true, () => true);

    // Listen on the domain's OWN app: mounting it inside another express() would hide its routes
    // one level down (app.use() records a single layer), which is what made the first version of
    // this probe find nothing to call.
    const app = api.app();
    const routes = getRoutesOf(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const answers = [];
    for (const routePath of routes) {
        const answer = await get(port, routePath);
        answers.push({ routePath, ...answer });
    }
    server.close();
    return answers;
}

describe('a domain that is still booting (held open, not raced)', function () {
    this.timeout(30000);

    for (const domain of ['api/calibration', 'api/cameras']) {
        describe(domain, () => {
            let answers;

            before(async () => { answers = await probeDomain(domain); });

            it('registers GET routes to exercise (guards against a vacuous run)', () => {
                expect(answers.length, 'no GET route was found - the probe is not testing anything').to.be.greaterThan(0);
            });

            it('never answers a 5xx other than 503', () => {
                const bad = answers.filter(a => a.status >= 500 && a.status !== 503);
                expect(bad.map(b => b.routePath + ' -> ' + b.status + ' ' + JSON.stringify(b.body.slice(0, 80)))).to.deep.equal([]);
            });

            it('never answers HTML - every refusal is the module\'s own JSON frame', () => {
                const html = answers.filter(a => /text\/html/i.test(a.type));
                expect(html.map(h => h.routePath + ' -> ' + h.status)).to.deep.equal([]);
            });

            it('answers 503 with an error code while the service is absent', () => {
                const three = answers.filter(a => a.status === 503);
                expect(three.length, 'expected at least one route to report "not ready" while the service is absent; observed: ' +
                    JSON.stringify(answers.map(a => a.routePath + '=' + a.status))).to.be.greaterThan(0);
                for (const answer of three) {
                    expect(answer.type, answer.routePath).to.match(/application\/json/);
                    expect(JSON.parse(answer.body).error, answer.routePath).to.be.a('string');
                }
            });
        });
    }
});
