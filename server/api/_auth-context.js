/**
 * The request authorisation context, and the action gate built on it - written once.
 *
 * WHY THIS EXISTS
 *
 * Four API domains had hand-copied the same thirty lines: cameras, devices, calibration and
 * opcua-server (recipes kept a fifth, older variant). They were not identical, and both
 * differences were accidental:
 *
 *   - `userId` was missing from the recipes copy. Nothing reads it today, so nothing broke - which
 *     is exactly why nobody noticed, and exactly how a security-relevant field drifts.
 *   - Two copies spelled the check `!!(runtime.settings && runtime.settings.secureEnabled)` and one
 *     spelled it `!!runtime.settings?.secureEnabled`. Same answer, two spellings, so a reader has
 *     to compare them by hand to be sure.
 *
 * An authorisation check that has to be re-pasted into every new domain is a check that will be
 * pasted differently in the next one. That is the same failure the driver emit guard was written
 * against, one layer up.
 *
 * WHAT IS DELIBERATELY KEPT PER DOMAIN
 *
 * Only the error CODE PREFIX and the human message. `CAM_FORBIDDEN` and `DEV_FORBIDDEN` are
 * contract: clients match on them, and collapsing them into one code would be an API change nobody
 * asked for. So the prefix is a parameter, not an accident.
 *
 * The severity ladder is also per domain, on purpose: calibration allows 'view' while secure mode is
 * off, cameras and devices do not. That difference is real (an operator must be able to watch a
 * calibration session on an unsecured bench), so it is declared in the action map rather than
 * averaged away.
 */

'use strict';

const authJwt = require('./jwt-helper');

/** Actions that only need an authenticated viewer. */
const VIEW_ACTIONS = new Set(['view', 'operate']);
/** Actions that additionally require admin permission. */
const ADMIN_ACTIONS = new Set(['admin', 'approve', 'write']);

/**
 * Build the two helpers for one API domain.
 *
 * @param {object}   options
 * RUNTIME IS READ AT CALL TIME, not captured. The first version of this module took the runtime
 * object directly and the devices API test caught it immediately: the helpers are built while the
 * module is being loaded, and `init()` assigns the runtime afterwards, so the captured value was
 * still undefined. Everything that is set up later - the runtime, the permission callback - has to
 * be reached through a function, or the shared helper silently depends on module load order.
 *
 * @param {object}   options
 * @param {function} options.getRuntime     returns the runtime, called per request
 * @param {function} options.getCheckGroups returns the permission callback, called per request
 * @param {string}   options.codePrefix     e.g. 'CAM' -> CAM_FORBIDDEN
 * @param {string}   options.domain         human name used in the messages, e.g. 'cameras'
 * @param {string[]} [options.extraViewActions] additional actions treated as view-only
 * @returns {{authContext: function, requireAction: function}}
 */
function createAuthHelpers(options) {
    const getRuntime = options.getRuntime;
    const getCheckGroups = options.getCheckGroups;
    const prefix = options.codePrefix;
    const domain = options.domain;
    const viewActions = new Set(VIEW_ACTIONS);
    const adminActions = new Set(ADMIN_ACTIONS);
    (options.extraViewActions || []).forEach((action) => {
        viewActions.add(action);
        adminActions.delete(action);
    });

    /**
     * Who is asking, and on what footing.
     *
     * Insecure mode answers as a fully trusted administrator because there is nothing to
     * authenticate against; the action gate is what refuses writes in that mode.
     *
     * @param {*} req
     * @returns {{secureEnabled: boolean, isGuest: boolean, isAdmin: boolean, userId: string}}
     */
    function authContext(req) {
        const runtime = getRuntime() || {};
        const secureEnabled = !!(runtime.settings && runtime.settings.secureEnabled);
        if (!secureEnabled) {
            return { secureEnabled: false, isGuest: false, isAdmin: true, userId: (req && req.userId) || 'guest' };
        }
        const permission = getCheckGroups()(req);
        return {
            secureEnabled: true,
            isGuest: authJwt.isGuestUser(req.userId, req.userGroups),
            isAdmin: authJwt.haveAdminPermission(permission),
            userId: req.userId || 'guest'
        };
    }

    /**
     * Return the auth context, or send the refusal and return null.
     *
     * @param {*} req
     * @param {*} res
     * @param {string} action one of: view, operate, admin, approve, write
     * @returns {object|null} null means the response has already been sent - the caller MUST return
     */
    function requireAction(req, res, action) {
        const auth = authContext(req);
        if (adminActions.has(action) && !auth.secureEnabled) {
            res.status(403).json({
                error: prefix + '_SECURITY_DISABLED',
                message: 'Secure mode is disabled: ' + domain + ' write operations are not allowed'
            });
            return null;
        }
        if (viewActions.has(action)) {
            return auth;
        }
        if (auth.isGuest) {
            res.status(401).json({
                error: prefix + '_UNAUTHENTICATED',
                message: 'Guest users cannot operate ' + domain
            });
            return null;
        }
        if (adminActions.has(action) && !auth.isAdmin) {
            res.status(403).json({
                error: prefix + '_FORBIDDEN',
                message: action === 'admin'
                    ? 'Admin permission required'
                    : 'Admin permission required for ' + action
            });
            return null;
        }
        // An action nobody declared: fail closed rather than fall through as allowed. A new action
        // name added to a route without being listed here must not become an unguarded write.
        if (!viewActions.has(action) && !adminActions.has(action)) {
            res.status(403).json({
                error: prefix + '_FORBIDDEN',
                message: 'Unknown action gate: ' + action
            });
            return null;
        }
        return auth;
    }

    return { authContext: authContext, requireAction: requireAction };
}

module.exports = { createAuthHelpers: createAuthHelpers, VIEW_ACTIONS: VIEW_ACTIONS, ADMIN_ACTIONS: ADMIN_ACTIONS };
