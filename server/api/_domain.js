'use strict';

/**
 * The REST domain scaffold: the one place a domain's entry guard is written.
 *
 * Every domain under api/ used to open its app() with its own copy of the same
 * middleware - "404 while there is no project, then next()" - and the copies had already
 * split into two readings (batch 62 measured all 18):
 *
 *   - 11 domains answered 404 and called next() (no cache header);
 *   - 5 added `Cache-Control: no-store` (cameras, devices, opcua-server with an early
 *     return; calibration and recipes inside the else branch - the same behaviour written
 *     two ways);
 *   - two domains (auth, reporting) take different init() arguments, which is recorded in
 *     apiRegistry.test.js and is not this module's business.
 *
 * The cache header is a POLICY, not a bug to be averaged away, so it stays a per-domain
 * parameter and the policy of every domain is pinned by
 * test/architecture/apiDomainScaffold.test.js. recipes/index.js carries the reason the
 * header exists at all: Express sends ETags, the browser revalidates, the answer is 304,
 * and Angular's HttpClient treats 304 as an error - `no-store` forces a fresh 200 every
 * time. Whether the other eleven domains should send it too is a separate finding (N-44 in
 * 20_代码进度.md), not something this refactor decides.
 *
 * The runtime is read through a getter because init() runs AFTER the module is loaded;
 * capturing its value here would freeze `undefined`.
 *
 * @param {function(): object} getRuntime  returns the runtime handed to init()
 * @param {{noStore?: boolean}} [options]
 * @returns {import('express').RequestHandler}
 */
function projectGuard(getRuntime, options) {
    const noStore = !!(options && options.noStore);
    return function (req, res, next) {
        if (!getRuntime().project) {
            res.status(404).end();
            return;
        }
        if (noStore) {
            res.setHeader('Cache-Control', 'no-store');
        }
        next();
    };
}

/**
 * The last resort for a handler that threw SYNCHRONOUSLY - before the domain's own promise handler
 * could see it.
 *
 * WHY THIS EXISTS. Express does catch a synchronous throw inside a route, but only to hand it to an
 * error middleware; with none registered it falls back to its own default, which answers **500 with
 * an HTML page**. Every domain here has a `service()` that refuses while the domain is still booting
 * (CAL_NOT_READY / CAM_NOT_READY -> 503), and the routes call it as an ARGUMENT:
 *
 *     handle(service().getProfiles(), res, ...)      // the throw happens BEFORE handle() is entered
 *
 * so `handle()`'s .catch never runs and the client gets "we are broken" instead of "come back".
 *
 * MEASURED (2026-10-06) by holding the boot window open - service absent, project present:
 *     GET /api/calibration/profiles -> 500, content-type: text/html, body "<!DOCTYPE html>..."
 * The boot-race test only sees this when a request happens to land in a millisecond-wide window,
 * which is why the defect presented as "non-deterministically green" rather than as a failure.
 *
 * @param {function(object, Error): void} sendError the domain's own renderer, so the answer is
 *        identical whether the error was thrown or rejected (codes and statuses stay in one place)
 * @param {function(): object} getLogger
 * @returns {import('express').ErrorRequestHandler}
 */
function domainErrorBoundary(sendError, getLogger) {
    return function (err, req, res, next) {
        if (res.headersSent) { return next(err); }
        try {
            const logger = getLogger();
            if (logger && logger.error) {
                logger.error('api domain error boundary [' + req.method + ' ' + req.originalUrl + ']: ' +
                    ((err && err.code) || '') + ' ' + ((err && err.message) || String(err)));
            }
        } catch (loggingFailure) { /* logging must never mask the answer */ }
        sendError(res, err);
    };
}

module.exports = { projectGuard, domainErrorBoundary };
