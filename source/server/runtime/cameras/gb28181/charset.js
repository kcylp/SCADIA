/**
 * 'cameras/gb28181/charset': decode GB28181 XML datagrams.
 *
 * GB28181 devices are all over the place encoding-wise: older domestic firmware
 * still emits GB2312/GBK (the standard's own examples do), newer ones UTF-8.
 * Node's TextDecoder supports gb18030 (a superset of GBK/GB2312) when built with
 * full ICU — which Node 20 bundles — so we honour the XML declaration instead of
 * guessing. Falls back to UTF-8 when the label is unsupported.
 */

'use strict';

const DECL_RE = /<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i;

function labelOf(str) {
    const m = DECL_RE.exec(str);
    return m ? m[1].toLowerCase() : null;
}

function supports(label) {
    try {
        new TextDecoder(label);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Decode an XML datagram buffer to a JS string using the declared encoding.
 * @param {Buffer|string} buf
 * @returns {{text:string, charset:string}}
 */
function decodeXml(buf) {
    if (typeof buf === 'string') {
        return { text: buf, charset: labelOf(buf) || 'utf-8' };
    }
    // The declaration itself is ASCII, so a latin1 peek is always safe.
    const peek = buf.toString('latin1', 0, Math.min(buf.length, 256));
    let charset = labelOf(peek) || 'utf-8';
    if (charset === 'utf8') { charset = 'utf-8'; }
    if (charset === 'gb2312' || charset === 'gbk') { charset = 'gb18030'; }
    if (!supports(charset)) { charset = 'utf-8'; }
    try {
        return { text: new TextDecoder(charset).decode(buf), charset: charset };
    } catch (err) {
        return { text: buf.toString('utf8'), charset: 'utf-8' };
    }
}

/** Charset label to put in outgoing XML (platform -> device). */
function normaliseLabel(label) {
    const l = String(label || 'GB2312').toLowerCase();
    if (l === 'gb18030' || l === 'gbk') { return 'GB2312'; }
    if (l === 'utf-8' || l === 'utf8') { return 'UTF-8'; }
    return 'GB2312';
}

module.exports = {
    decodeXml: decodeXml,
    normaliseLabel: normaliseLabel,
    supports: supports
};
