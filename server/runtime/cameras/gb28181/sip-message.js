/**
 * 'cameras/gb28181/sip-message': minimal, dependency-free SIP/2.0 codec.
 *
 * GB28181 signalling only needs a small, well-defined slice of SIP: REGISTER
 * (with MD5 digest challenge), MESSAGE (MANSCDP bodies), INVITE/ACK/BYE and the
 * matching responses. Implementing it directly keeps the platform free of a
 * heavyweight SIP stack and keeps every byte testable.
 *
 * Reference: RFC 3261 (SIP), RFC 2617 (HTTP/SIP digest), GB/T 28181-2016 §9.
 */

'use strict';

const crypto = require('crypto');

const CRLF = '\r\n';
const VERSION = 'SIP/2.0';

const REASONS = {
    100: 'Trying', 180: 'Ringing', 200: 'OK', 202: 'Accepted',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 481: 'Call/Transaction Does Not Exist',
    486: 'Busy Here', 500: 'Server Internal Error', 501: 'Not Implemented', 503: 'Service Unavailable'
};

// ------------------------------------------------------------------ parsing

/**
 * Parse a SIP message (request or response).
 * @returns {{type:'request'|'response', method, statusCode, reason, uri, startLine,
 *            headers:Object, list:Array<{name,value}>, body:string}}
 */
function parse(text) {
    if (typeof text !== 'string' || !text.length) {
        throw new Error('empty SIP message');
    }
    // Normalise line endings first: some devices emit bare LF.
    const norm = text.replace(/\r\n/g, '\n');
    const sep = norm.indexOf('\n\n');
    const head = sep >= 0 ? norm.slice(0, sep) : norm;
    const body = sep >= 0 ? norm.slice(sep + 2) : '';

    const lines = head.split('\n');
    const startLine = (lines.shift() || '').trim();
    if (!startLine) { throw new Error('missing SIP start line'); }

    const list = [];
    const headers = {};
    let lastName = null;
    for (const raw of lines) {
        if (!raw) { continue; }
        if (/^[ \t]/.test(raw) && lastName) {          // folded continuation
            list[list.length - 1].value += ' ' + raw.trim();
            headers[lastName] = list[list.length - 1].value;
            continue;
        }
        const i = raw.indexOf(':');
        if (i < 0) { continue; }
        const name = raw.slice(0, i).trim();
        const value = raw.slice(i + 1).trim();
        const key = name.toLowerCase();
        list.push({ name: name, value: value });
        headers[key] = headers[key] === undefined ? value : headers[key] + ', ' + value;
        lastName = key;
    }

    const msg = {
        type: 'request', method: null, statusCode: null, reason: null, uri: null,
        version: VERSION, startLine: startLine, headers: headers, list: list, body: body
    };

    if (/^SIP\/2\.0\s/.test(startLine)) {
        const m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(startLine);
        if (!m) { throw new Error('malformed SIP status line: ' + startLine); }
        msg.type = 'response';
        msg.statusCode = Number(m[1]);
        msg.reason = m[2] || REASONS[msg.statusCode] || '';
        return msg;
    }

    const m = /^([A-Za-z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(startLine);
    if (!m) { throw new Error('malformed SIP request line: ' + startLine); }
    msg.method = m[1].toUpperCase();
    msg.uri = m[2];
    return msg;
}

function header(msg, name) {
    const v = msg && msg.headers ? msg.headers[String(name).toLowerCase()] : undefined;
    return v === undefined ? null : v;
}

function headers(msg, name) {
    const key = String(name).toLowerCase();
    return (msg && msg.list ? msg.list : []).filter(h => h.name.toLowerCase() === key).map(h => h.value);
}

/**
 * Extract `key=value` parameters from a header value into an object.
 *
 * Handles both SIP header parameters (`;tag=abc;rport`) and the comma-packed
 * WWW-Authenticate/Authorization form (`Digest realm="x", qop="auth", nonce="y"`),
 * which is why this scans for pairs instead of splitting on a separator.
 * Quoted values are unquoted.
 */
function params(value) {
    const out = {};
    if (!value) { return out; }
    const re = /([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|([^,;\s]*))/g;
    let m;
    while ((m = re.exec(String(value))) !== null) {
        out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] || '');
    }
    return out;
}

/**
 * Extract the user part from an address header, e.g.
 *   `"IPC" <sip:34020000001320000001@10.0.0.5:5060>;tag=abc` -> '34020000001320000001'
 */
function addressUser(value) {
    if (!value) { return null; }
    const m = /<sips?:([^@>;]+)@|<sips?:([^>;]+)>/i.exec(value);
    if (m) { return (m[1] || m[2] || '').trim() || null; }
    const m2 = /sips?:([^@>;]+)@/i.exec(value);
    if (m2) { return m2[1].trim(); }
    const m3 = /sips?:([^@>;]+)/i.exec(value);
    return m3 ? m3[1].trim() : null;
}

/** Extract `host:port` from an address header / URI (port may be absent). */
function addressHostPort(value) {
    if (!value) { return null; }
    const m = /sips?:[^@>;]*@\[?([^\]>;:]+)\]?(?::(\d+))?/i.exec(value);
    if (!m) { return null; }
    return { host: m[1], port: m[2] ? Number(m[2]) : null };
}

// ----------------------------------------------------------------- building

function newBranch() { return 'z9hG4bK' + crypto.randomBytes(6).toString('hex'); }
function newTag() { return crypto.randomBytes(8).toString('hex'); }
function newCallId() { return crypto.randomBytes(10).toString('hex') + '@' + Date.now(); }

/**
 * Build a SIP request.
 * @param {Object} o method, uri, via{host,port,branch,transport}, from{uri,tag},
 *                   to{uri,tag}, callId, cseq, contact, subject, userAgent,
 *                   contentType, body, headers[]
 */
function buildRequest(o) {
    if (!o || !o.method || !o.uri) { throw new Error('method and uri are required'); }
    const via = o.via || {};
    const lines = [];
    lines.push(`${o.method} ${o.uri} ${VERSION}`);
    lines.push(`Via: SIP/2.0/${via.transport || 'UDP'} ${via.host}:${via.port};rport;branch=${via.branch || newBranch()}`);
    lines.push(`From: <${o.from.uri}>${o.from.tag ? ';tag=' + o.from.tag : ''}`);
    lines.push(`To: <${o.to.uri}>${o.to.tag ? ';tag=' + o.to.tag : ''}`);
    lines.push(`Call-ID: ${o.callId || newCallId()}`);
    lines.push(`CSeq: ${o.cseq} ${o.method}`);
    lines.push(`Max-Forwards: ${o.maxForwards || 70}`);
    if (o.contact) { lines.push(`Contact: <${o.contact}>`); }
    if (o.subject) { lines.push(`Subject: ${o.subject}`); }
    if (o.userAgent) { lines.push(`User-Agent: ${o.userAgent}`); }
    for (const h of (o.headers || [])) { lines.push(h); }
    if (o.body) { lines.push(`Content-Type: ${o.contentType || 'Application/MANSCDP+xml'}`); }
    lines.push(`Content-Length: ${Buffer.byteLength(o.body || '', 'utf8')}`);
    return lines.join(CRLF) + CRLF + CRLF + (o.body || '');
}

/**
 * Build a SIP response to a request: Via/From/Call-ID/CSeq are echoed verbatim,
 * which is what devices validate.
 */
function buildResponse(req, o) {
    o = o || {};
    const code = o.statusCode || 200;
    const lines = [`${VERSION} ${code} ${o.reason || REASONS[code] || ''}`];
    for (const v of headers(req, 'via')) { lines.push(`Via: ${v}`); }
    lines.push(`From: ${header(req, 'from')}`);
    let to = header(req, 'to');
    if (o.toTag && to && !/;tag=/i.test(to)) { to += ';tag=' + o.toTag; }
    lines.push(`To: ${to}`);
    lines.push(`Call-ID: ${header(req, 'call-id')}`);
    lines.push(`CSeq: ${header(req, 'cseq')}`);
    if (o.contact) { lines.push(`Contact: <${o.contact}>`); }
    if (o.wwwAuthenticate) { lines.push(`WWW-Authenticate: ${o.wwwAuthenticate}`); }
    for (const h of (o.headers || [])) { lines.push(h); }
    if (o.body) { lines.push(`Content-Type: ${o.contentType || 'Application/MANSCDP+xml'}`); }
    lines.push(`Content-Length: ${Buffer.byteLength(o.body || '', 'utf8')}`);
    return lines.join(CRLF) + CRLF + CRLF + (o.body || '');
}

// ------------------------------------------------------------------- digest

function md5(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }

function makeNonce() { return crypto.randomBytes(16).toString('hex'); }

/** WWW-Authenticate challenge as sent by wvp/GB platforms. */
function challenge(realm, nonce) {
    return `Digest realm="${realm}", qop="auth", nonce="${nonce}", algorithm=MD5`;
}

/** Parse an Authorization header value into its fields. */
function parseAuthorization(value) {
    if (!value) { return null; }
    const m = /^\s*Digest\s+(.*)$/i.exec(value);
    if (!m) { return null; }
    const out = {};
    const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g;
    let x;
    while ((x = re.exec(m[1])) !== null) {
        out[x[1].toLowerCase()] = x[2] !== undefined ? x[2] : x[3];
    }
    out.username = out.username || null;
    out.realm = (out.realm || '').trim() || null;
    return out;
}

/**
 * Compute the digest response for one qop mode.
 * qop === null reproduces the classic RFC 2069 (no qop) formula that a lot of
 * GB28181 firmware still uses even after receiving a qop challenge.
 */
function digestResponse(auth, method, password, useQop) {
    const ha1 = md5(`${auth.username}:${auth.realm}:${password}`);
    const ha2 = md5(`${String(method).toUpperCase()}:${auth.uri}`);
    let kd = `${ha1}:${auth.nonce}`;
    if (useQop) {
        kd += `:${auth.nc || '00000001'}:${auth.cnonce || ''}:${auth.qop || 'auth'}`;
    }
    return md5(`${kd}:${ha2}`);
}

/**
 * Verify a request's Authorization header against a plaintext password.
 * Both qop and no-qop digests are accepted because device firmware is
 * inconsistent about honouring the challenge's qop.
 */
function verifyDigest(req, password) {
    const auth = parseAuthorization(header(req, 'authorization'));
    if (!auth || !auth.username || !auth.realm || !auth.nonce || !auth.uri || !auth.response) {
        return false;
    }
    const candidates = [digestResponse(auth, req.method, password, false)];
    if (auth.qop) { candidates.push(digestResponse(auth, req.method, password, true)); }
    const got = String(auth.response).toLowerCase();
    return candidates.some(c => c === got);
}

module.exports = {
    CRLF: CRLF,
    VERSION: VERSION,
    REASONS: REASONS,
    parse: parse,
    header: header,
    headers: headers,
    params: params,
    addressUser: addressUser,
    addressHostPort: addressHostPort,
    buildRequest: buildRequest,
    buildResponse: buildResponse,
    newBranch: newBranch,
    newTag: newTag,
    newCallId: newCallId,
    md5: md5,
    makeNonce: makeNonce,
    challenge: challenge,
    parseAuthorization: parseAuthorization,
    digestResponse: digestResponse,
    verifyDigest: verifyDigest
};
