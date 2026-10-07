/**
 * 'cameras/camera-client': minimal HTTP client that speaks Basic/Digest auth
 * so the server can pull a snapshot (or MJPEG chunk) from an IP camera without
 * leaking credentials to the browser and without CORS problems.
 *
 * No third-party dependency: node http/https + crypto only.
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

const DEFAULT_TIMEOUT = 5000;

function md5(s) {
    return crypto.createHash('md5').update(s).digest('hex');
}

function parseAuthHeader(header) {
    // e.g. Digest realm="IP Camera", nonce="...", qop="auth", ...
    const out = { scheme: 'basic', params: {} };
    if (!header) { return out; }
    const idx = header.indexOf(' ');
    const scheme = (idx === -1 ? header : header.slice(0, idx)).toLowerCase();
    out.scheme = scheme.indexOf('digest') >= 0 ? 'digest' : 'basic';
    const rest = idx === -1 ? '' : header.slice(idx + 1);
    const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
        out.params[m[1]] = (m[2] !== undefined ? m[2] : m[3]).trim();
    }
    return out;
}

function buildDigest(parsed, method, uri, username, password) {
    const p = parsed.params;
    const realm = p.realm || '';
    const nonce = p.nonce || '';
    const qop = p.qop ? p.qop.split(',')[0].trim() : null;
    const opaque = p.opaque;
    const algorithm = (p.algorithm || 'MD5').toUpperCase();
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');

    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    let response;
    if (qop) {
        response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    } else {
        response = md5(`${ha1}:${nonce}:${ha2}`);
    }

    let h = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
        `response="${response}"`;
    if (algorithm) { h += `, algorithm=${algorithm}`; }
    if (qop) { h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`; }
    if (opaque) { h += `, opaque="${opaque}"`; }
    return h;
}

/**
 * Generic request (GET/PUT/POST/DELETE) with an optional Authorization header.
 * Resolves { status, headers, body(Buffer) }.
 */
function rawRequest(method, target, authHeader, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
        const parsed = new url.URL(target);
        const lib = parsed.protocol === 'https:' ? https : http;
        const payload = opts.body !== undefined && opts.body !== null
            ? (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body)))
            : null;
        const options = {
            method: method || 'GET',
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: {
                'User-Agent': 'KaichengSCADA/1.0'
            },
            timeout: opts.timeoutMs || DEFAULT_TIMEOUT,
            // cameras usually use self-signed certs
            rejectUnauthorized: false
        };
        if (authHeader) { options.headers.Authorization = authHeader; }
        if (payload) {
            options.headers['Content-Type'] = opts.contentType || 'application/octet-stream';
            options.headers['Content-Length'] = payload.length;
        }

        const req = lib.request(options, res => {
            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if (opts.maxBytes && size > opts.maxBytes) {
                    req.destroy();
                    reject(new Error('response too large'));
                    return;
                }
                chunks.push(c);
            });
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

function rawGet(target, authHeader, timeoutMs, maxBytes) {
    return rawRequest('GET', target, authHeader, { timeoutMs: timeoutMs, maxBytes: maxBytes });
}

/**
 * Authenticated request handling a Digest (or Basic) challenge.
 * @returns {Promise<{status, headers, body}>}
 */
async function requestWithAuth(method, target, username, password, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
    const maxBytes = opts.maxBytes || 1 * 1024 * 1024;

    let res = await rawRequest(method, target, undefined,
        { timeoutMs: timeoutMs, maxBytes: maxBytes, body: opts.body, contentType: opts.contentType });

    if ((res.status === 401 || res.status === 403) && username) {
        const www = res.headers['www-authenticate'];
        const parsed = parseAuthHeader(www);
        let header;
        if (parsed.scheme === 'digest') {
            const u = new url.URL(target);
            header = buildDigest(parsed, method || 'GET', u.pathname + u.search, username, password || '');
        } else {
            header = 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
        }
        res = await rawRequest(method, target, header,
            { timeoutMs: timeoutMs, maxBytes: maxBytes, body: opts.body, contentType: opts.contentType });
    }
    return res;
}

/**
 * GET a camera resource handling a Digest (or Basic) challenge.
 * @returns {Promise<Buffer>}
 */
async function getWithAuth(target, username, password, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
    const maxBytes = opts.maxBytes || 5 * 1024 * 1024;

    let res = await rawGet(target, undefined, timeoutMs, maxBytes);

    if (res.status === 401 && username) {
        const www = res.headers['www-authenticate'];
        const parsed = parseAuthHeader(www);
        let header;
        if (parsed.scheme === 'digest') {
            const uri = new url.URL(target).pathname + new url.URL(target).search;
            header = buildDigest(parsed, 'GET', uri, username, password || '');
        } else {
            header = 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
        }
        res = await rawGet(target, header, timeoutMs, maxBytes);
    }

    if (res.status >= 400) {
        const err = new Error('camera responded ' + res.status);
        err.status = res.status;
        throw err;
    }
    return { status: res.status, headers: res.headers, body: res.body };
}

/** Fetch a single JPEG frame. */
async function getSnapshot(target, username, password, timeoutMs) {
    return getWithAuth(target, username, password, { timeoutMs: timeoutMs, maxBytes: 8 * 1024 * 1024 });
}

module.exports = {
    rawRequest: rawRequest,
    requestWithAuth: requestWithAuth,
    getWithAuth: getWithAuth,
    getSnapshot: getSnapshot
};
