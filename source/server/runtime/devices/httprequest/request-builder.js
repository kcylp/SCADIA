/**
 * 'httprequest/request-builder': the pure part of the WebAPI driver.
 *
 * Keeping request shaping here (no axios, no state) makes the vendor-specific
 * rules testable on their own: what body a batch write sends, when a response
 * counts as "not modified", and how a template is filled. The driver then only
 * performs I/O.
 */

'use strict';

const DEFAULT_HEADER_TIMEOUT = 10000;

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Normalise the configured headers into an object.
 * Accepts an object or a JSON string; a broken string is ignored rather than
 * throwing, so one bad field cannot take the whole device down.
 * @returns {{headers: Object, error: string|null}}
 */
function normalizeHeaders(raw) {
    if (!raw) { return { headers: {}, error: null }; }
    if (typeof raw === 'object') { return { headers: Object.assign({}, raw), error: null }; }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return { headers: parsed, error: null };
            }
            return { headers: {}, error: 'headers must be a JSON object' };
        } catch (err) {
            return { headers: {}, error: 'headers is not valid JSON' };
        }
    }
    return { headers: {}, error: 'unsupported headers value' };
}

/**
 * Axios config shared by reads and writes: headers + timeout.
 */
function requestConfig(property) {
    const p = property || {};
    const normalized = normalizeHeaders(p.headers);
    const config = { headers: normalized.headers };
    const timeout = Number(p.timeout);
    config.timeout = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_HEADER_TIMEOUT;
    if (isNonEmptyString(p.username)) {
        config.auth = { username: p.username, password: p.password || '' };
    } else if (isNonEmptyString(p.bearerToken)) {
        config.headers.Authorization = 'Bearer ' + p.bearerToken;
    }
    return { config: config, headersError: normalized.error };
}

/**
 * Fill a template: `{{name}}` is replaced from `vars`.
 * Unknown placeholders are left untouched so a mistyped name is visible in the
 * payload instead of silently becoming an empty string.
 */
function applyTemplate(template, vars) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (m, key) =>
        Object.prototype.hasOwnProperty.call(vars || {}, key) ? String(vars[key]) : m);
}

/**
 * Build the batch-write request.
 *
 * Shapes, in order of precedence:
 *   1. `writeTemplate` containing `{{entries}}` -> the whole batch in one body
 *   2. `writeTemplate` with `{{id}}`/`{{value}}` -> per-entry template (joined as
 *      an array when there is more than one entry, so the batch stays one call)
 *   3. default: POST `[{id, value}, ...]`
 *
 * @returns {{method:string, url:string, body:any, contentType:string}|null}
 *          null when the device is not writable (caller reports the failure).
 */
function buildWriteRequest(property, entries) {
    const p = property || {};
    const list = (entries || []).filter(e => e && e.id !== undefined);
    if (!list.length) { return null; }

    // Writable targets, in the driver's own convention:
    //   - `getTags`/`postTags` mode = the endpoint speaks our [{id,value}] schema,
    //     so the default body is right.
    //   - `address`-only mode = the endpoint is a plain read document; a write
    //     there has no defined body, so it is refused unless a template says
    //     exactly what to send.
    const url = p.postTags || p.getTags || p.address;
    if (!isNonEmptyString(url)) { return null; }
    const readDocumentMode = isNonEmptyString(p.address) && !p.postTags && !p.getTags;
    if (readDocumentMode && !isNonEmptyString(p.writeTemplate)) { return null; }

    const method = isNonEmptyString(p.writeMethod) ? String(p.writeMethod).toUpperCase() : 'POST';

    if (isNonEmptyString(p.writeTemplate)) {
        const tpl = p.writeTemplate;
        if (tpl.indexOf('{{entries}}') >= 0) {
            const body = applyTemplate(tpl, { entries: JSON.stringify(list.map(e => ({ id: e.id, value: e.value }))) });
            return { method: method, url: url, body: body, contentType: guessContentType(body) };
        }
        if (tpl.indexOf('{{id}}') >= 0 || tpl.indexOf('{{value}}') >= 0) {
            const parts = list.map(e => applyTemplate(tpl, { id: e.id, value: e.value }));
            if (parts.length === 1) {
                return { method: method, url: url, body: parts[0], contentType: guessContentType(parts[0]) };
            }
            // one request, an array of rendered bodies
            const body = '[' + parts.join(',') + ']';
            return { method: method, url: url, body: body, contentType: 'application/json' };
        }
        // a template without a batch placeholder and without per-entry fields is
        // static: useful for a fixed command, so send it as-is
        return { method: method, url: url, body: tpl, contentType: guessContentType(tpl) };
    }

    const body = list.map(e => ({ id: e.id, value: e.value }));
    return { method: method, url: url, body: body, contentType: 'application/json' };
}

function guessContentType(body) {
    if (typeof body === 'string') {
        const t = body.trim();
        if (t.startsWith('{') || t.startsWith('[')) { return 'application/json'; }
        return 'text/plain';
    }
    return 'application/json';
}

/**
 * Conditional-GET config for long polling / change-only reads.
 *
 * @param {object} property device property
 * @param {object} state    { etag, since }
 * @returns {{config: object, conditional: boolean}}
 */
function buildReadConfig(property, state) {
    const built = requestConfig(property);
    const config = built.config;
    const p = property || {};
    const st = state || {};
    const longPoll = !!p.longPoll;
    let conditional = false;

    if (longPoll) {
        // ETag first: it is the precise "nothing changed" signal.
        if (isNonEmptyString(st.etag)) {
            config.headers['If-None-Match'] = st.etag;
            conditional = true;
        }
        // A server-side hold time is usually expressed as a query parameter.
        const holdMs = Number(p.longPollTimeout);
        if (isNonEmptyString(p.longPollParam) && Number.isFinite(holdMs) && holdMs > 0) {
            config.params = Object.assign({}, config.params, { [p.longPollParam]: holdMs });
            conditional = true;
        } else if (Number.isFinite(holdMs) && holdMs > 0) {
            config.params = Object.assign({}, config.params, { timeout: holdMs });
            conditional = true;
        }
        // "since" style APIs: send the timestamp of the last change we know of.
        if (isNonEmptyString(p.sinceParam) && st.since) {
            config.params = Object.assign({}, config.params, { [p.sinceParam]: st.since });
            conditional = true;
        }
        // Long polls must outlive the server hold time, otherwise every poll
        // aborts just before the server would answer.
        if (conditional && Number.isFinite(holdMs) && holdMs > 0) {
            config.timeout = holdMs + DEFAULT_HEADER_TIMEOUT;
        }
    }
    return { config: config, conditional: conditional, headersError: built.headersError };
}

/**
 * Does this response mean "no new data"?
 * HTTP 304, an explicit `changed:false`, or an empty body all mean the endpoint
 * had nothing to report — which is a success, not a failure.
 */
function isNotModified(status, data, headers) {
    if (status === 304) { return true; }
    if (data && typeof data === 'object' && data.changed === false) { return true; }
    if (Array.isArray(data) && data.length === 0) { return true; }
    if (data === null || data === undefined || data === '') { return true; }
    return false;
}

/** Remember the ETag a response carried, so the next poll can be conditional. */
function etagOf(headers) {
    if (!headers) { return null; }
    const v = headers['etag'] || headers['ETag'];
    return isNonEmptyString(v) ? String(v).trim() : null;
}

module.exports = {
    normalizeHeaders: normalizeHeaders,
    requestConfig: requestConfig,
    applyTemplate: applyTemplate,
    buildWriteRequest: buildWriteRequest,
    buildReadConfig: buildReadConfig,
    isNotModified: isNotModified,
    etagOf: etagOf,
    guessContentType: guessContentType
};
