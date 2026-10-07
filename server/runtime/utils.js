const os = require('os');
const crypto = require('crypto');

function ipv4ToInt(address) {
    return address.split('.').reduce((result, octet) => {
        return ((result << 8) + Number(octet)) >>> 0;
    }, 0);
}

function intToIpv4(value) {
    return [
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255
    ].join('.');
}

function getBroadcastAddress(address, netmask) {
    const addressInt = ipv4ToInt(address);
    const netmaskInt = ipv4ToInt(netmask);
    return intToIpv4((addressInt | (~netmaskInt >>> 0)) >>> 0);
}

'use strict';
var utils = module.exports = {

    SMALLEST_NEGATIVE_INTEGER: -9007199254740991,

    domStringSplitter: function (src, tagsplitter, first) {
        var result = { before: '', tagcontent: '', after: '' };
        var tagStart = '<' + tagsplitter.toLowerCase();
        var tagEnd = '</' + tagsplitter.toLowerCase();
        var text = src.toLowerCase();
        var start = text.indexOf(tagStart, first);
        var end = text.indexOf(tagEnd, start);
        result.before = src.slice(0, start);
        result.tagcontent = src.slice(start, end);
        result.after = src.slice(end);
        return result;
    },

    /**
     * Add attributes to every opening tag named in `tags`.
     *
     * REWRITTEN - the previous version was corrupting the markup it was asked to annotate.
     * Measured: for '<button id="y">' it produced '<bdisabled utton id="y">'.
     *
     * Three separate faults, all of them now pinned by test/runtime/permissionSvgInjection.test.js:
     *   - it compared `text.indexOf('>') === tagStart.length`, i.e. the position of the FIRST '>' in
     *     the whole document against the length of the tag name. That is a position-versus-length
     *     comparison: for all but one coincidence the else-branch ran and the attribute was inserted
     *     with no separating space and at an offset that split the tag name open.
     *   - it accumulated into `temp` from `src` across iterations of the outer loop, so each tag
     *     name restarted from the ORIGINAL string and the last one won - earlier tags were lost.
     *   - `if (temp.length)` then assigned that partial result, dropping every tag not handled last.
     *
     * This version scans once and inserts each attribute immediately before that tag's own '>',
     * so an attribute can never land inside a tag name and one pass cannot undo another.
     */
    domStringSetAttribute: function (src, tags, attribute) {
        if (typeof src !== 'string' || !Array.isArray(tags) || !tags.length || !attribute) {
            return src;
        }
        var names = tags.map(function (t) { return String(t).toLowerCase(); });
        var pattern = new RegExp('<(' + names.join('|') + ')(?=[\\s/>])([^>]*?)(/?)>', 'gi');
        return src.replace(pattern, function (whole, name, rest, selfClose) {
            // Keep whatever the tag already had, then guarantee exactly one space before the new
            // attribute. (An earlier attempt reused the attribute text as the separator, which
            // dropped the space for a bare '<button>' and produced '<buttondisabled>' - the very
            // class of damage this function exists to avoid.)
            var attrs = rest;
            if (attrs.length && !/\s$/.test(attrs)) {
                attrs += ' ';
            }
            return '<' + name + (attrs.length ? attrs : ' ') + attribute + (selfClose || '') + '>';
        });
    },

    /**
     * Add attributes to the OPENING TAG of the element carrying a given id.
     *
     * WHY THIS EXISTS - the permission filter used to do this:
     *
     *     position = svg.indexOf(item.id);
     *     position += item.id.length + 1;
     *     svg = svg.slice(0, position) + ' visibility="hidden" ' + svg.slice(position);
     *
     * indexOf finds the id ANYWHERE, and what it finds first is often not the drawn element: an
     * SVG may mention an id in a <title>, inside a comment, or inside a longer id that merely
     * contains it as a substring. The attribute was then written into that text, which does not
     * hide the element at all - and, worse, corrupts whatever it landed in. With several ids the
     * offsets compound, so the damage is not local. That is the reported P1: configuring
     * permissions could quietly scramble a screen.
     *
     * This walks the opening tags instead and matches on the id ATTRIBUTE, then inserts the
     * attributes immediately before that tag's '>'. A mention in text is therefore never a match.
     *
     * @param {string} svg the view's svgcontent
     * @param {string} id the element id to find
     * @param {string} attrs attributes to add, e.g. 'visibility="hidden"'
     * @returns {string|null} the updated svg, or null when no opening tag carries that id
     */
    domStringSetAttributeOnId: function (svg, id, attrs) {
        if (typeof svg !== 'string' || !id) {
            return null;
        }
        var escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // id="..." or id='...', in either order with other attributes around it
        var tag = new RegExp('<[a-zA-Z][a-zA-Z0-9:\\-]*\\b[^>]*?\\bid\\s*=\\s*["\']' + escaped + '["\'][^>]*>');
        var found = tag.exec(svg);
        if (!found) {
            return null;
        }
        var opening = found[0];
        var replaced = opening.replace(/\s*\/?>$/, ' ' + attrs + (opening.slice(-2) === '/>' ? '/>' : '>'));
        return svg.slice(0, found.index) + replaced + svg.slice(found.index + opening.length);
    },
    /**
     * The element carrying an id, together with the <foreignObject> that encloses it.
     *
     * WHY THIS EXISTS - the same P1 as domStringSetAttributeOnId, in the other half of the filter.
     * Disabling a control used to do indexOf(item.id) and then hand that offset to
     * domStringSplitter(svg, 'foreignobject', offset), which searches FORWARD for the next opening
     * tag. When indexOf matched a mention of the id (a <title>, a longer id) the offset pointed
     * somewhere else entirely and the code disabled the controls of a DIFFERENT element. Here the
     * span is anchored on the element itself and closed at its own </foreignObject>.
     *
     * @returns {{tag: string, before: string, inner: string, after: string}|null} null when the
     *          element has no enclosing foreignObject (nothing is then disabled).
     */
    domStringForeignObjectOfId: function (svg, id) {
        if (typeof svg !== 'string' || !id) {
            return null;
        }
        var escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var tag = new RegExp('<[a-zA-Z][a-zA-Z0-9:\\-]*\\b[^>]*?\\bid\\s*=\\s*["\']' + escaped + '["\'][^>]*>');
        var found = tag.exec(svg);
        if (!found) { return null; }
        var lower = svg.toLowerCase();
        var openAt = lower.lastIndexOf('<foreignobject', found.index);
        if (openAt < 0) { return null; }
        var openEnd = svg.indexOf('>', openAt);
        if (openEnd < 0) { return null; }
        var closeAt = lower.indexOf('</foreignobject', openEnd);
        if (closeAt < 0 || closeAt < found.index) { return null; }
        return {
            tag: svg.slice(openAt, openEnd + 1),
            before: svg.slice(0, openAt),
            inner: svg.slice(openEnd + 1, closeAt),
            after: svg.slice(closeAt)
        };
    },
    domStringSetOverlay: function (htmlString, tagNames) {
        tagNames.forEach(tagName => {
            const lowerTagName = tagName.toLowerCase();
            const regex = new RegExp(`(<${lowerTagName}[^>]*?>.*?</${lowerTagName}>)`, "gis");
            const style = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.5); z-index: 9999; pointer-events: all; display: none;";
            htmlString = htmlString.replace(regex, `<div style="${style}">$1</div>`);
        });

        return htmlString;
    },

    /**
    * Return available interface to use
    */
    getHostInterfaces: function() {
        return new Promise(function (resolve, reject) {
            try {
                let nics = [];
                const osNics = os.networkInterfaces();
                nics.push({ name: 'Default' });
                Object.keys(osNics).forEach((ifname) => {
                    osNics[ifname].forEach((iface) => {
                        if (iface.internal === true) return;
                        if (iface.family !== 'IPv4') return;
                        nics.push({
                            name: ifname,
                            address: iface.address,
                            broadcast: getBroadcastAddress(iface.address, iface.netmask)
                        });
                    });
                });
                resolve(nics);
            } catch (err) {
                reject('gethostinterfaces-error: ' + err);
            }
        });
    },

    endTime: function (startTime) {
        var endTime = new Date();
        return endTime - startTime;
    },

    isEmptyObject: function (value) {
        return !value || (Object.keys(value).length === 0 && value.constructor === Object);
    },

    isObject(value) {
        var type = typeof value;
        return !!value && (type == 'object' || type == 'function');
    },

    isBoolean(value) {
        return (typeof value === 'boolean');
    },

    // isPlainObject WAS HERE, and it was removed rather than repaired. It was copied from lodash
    // together with five of lodash's internal helpers (isObjectLike, objToString, objectTag,
    // isHostObject, isArguments), plus baseForIn and lodash.support.ownLast - NONE of which were ever
    // defined or imported in this file. So the method threw "isObjectLike is not defined" on every
    // single call, and had done for as long as anyone can tell.
    //
    // It was deleted because it had ZERO references anywhere in the repository: every appearance of
    // the name is either this definition or an unrelated private helper inside two i18n test files.
    // A dead method that can only throw is not worth a native reimplementation, and keeping it would
    // preserve a name that invites exactly this mistake again. If a plain-object test is needed,
    // write one then, with a test.
    //
    // Found by running ESLint's no-undef over runtime/ for the first time (batch 31). node --check
    // and require() both pass a file whose function bodies reference undefined names.

    isNullOrUndefined: function (ele) {
        return (ele === null || ele === undefined) ? true : false;
    },

    /**
     * A deep copy, by round-tripping through JSON.
     *
     * VERBATIM the expression the client's Utils.clone uses, so substituting one for the other is
     * equivalence by construction rather than by hope. The client has had this method all along and
     * its clone is literally this line; the server had 35 copies of the same expression with no
     * method to name them (found by the N-14 survey, closed in batch 44).
     *
     * Same limits as any JSON round-trip: undefined values, functions, Dates and class instances do
     * not survive. That is not a regression - it is what the 35 call sites already did.
     */
    clone: function (obj) {
        return JSON.parse(JSON.stringify(obj));
    },

    JsonTryToParse(value) {
        try {
            if (value) {
                return JSON.parse(value);
            }
        } catch { }
    },

    mergeObjectsValues: function (obj1, obj2) {
        if (typeof obj1 === 'object' && typeof obj2 === 'object') {
            for (let key in obj2) {
                if (obj1.hasOwnProperty(key)) {
                    obj1[key] = obj2[key];
                }
            }
        }
        return obj1;
    },

    dayOfYear: function (date) {
        if (date) {
            return Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24);
        }
        return -1;
    },

    getDate: function (dt) {
        var yyyy = dt.getFullYear();
        var mm = dt.getMonth() + 1;
        var dd = dt.getDate();
        if (dd < 10) {
            dd = '0' + dd;
        }
        if (mm < 10) {
            mm = '0' + mm;
        }
        var HH = dt.getHours();
        var MM = dt.getMinutes();
        var SS = dt.getSeconds();
        if (HH < 10) {
            HH = '0' + HH;
        }
        if (MM < 10) {
            MM = '0' + MM;
        }
        if (SS < 10) {
            SS = '0' + SS;
        }
        return `${yyyy}-${mm}-${dd}_${HH}-${MM}-${SS}`;
    },

    getFormatDate: function (dt, format) {
        var yyyy = dt.getFullYear();
        var mm = dt.getMonth() + 1;
        var dd = dt.getDate();
        if (dd < 10) {
            dd = '0' + dd;
        }
        if (mm < 10) {
            mm = '0' + mm;
        }
        var HH = dt.getHours();
        var MM = dt.getMinutes();
        var SS = dt.getSeconds();
        if (HH < 10) {
            HH = '0' + HH;
        }
        if (MM < 10) {
            MM = '0' + MM;
        }
        if (SS < 10) {
            SS = '0' + SS;
        }
        if (format === 'ymd') {
            return `${yyyy}/${mm}/${dd}/ ${HH}:${MM}:${SS}`;
        }
        return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
    },

    isNumber: function(n, v = {value: null}) {
        if (typeof n === 'number') {
            v.value = n;
            return true;
        } else {
            var num = Number(n);
            if (isNaN(num)) {
                return false;
            }
            num = parseFloat(n);
            if (isNaN(num)) {
                return false;
            }
            v.value = num;
            return true;
        }
    },

    isFloat: function (n) {
        return Number(n) === n && n % 1 !== 0;
    },

    parseFloat: function (value, decimals) {
        if (this.isFloat(value)) {
            return parseFloat(value.toFixed(decimals));
        } else {
            return parseFloat(value);
        }
    },

    isValidRange: function (min, max) {
        if (this.isNumber(min) && this.isNumber(max)) {
            return true;
        }
        return false;
    },

    chunkArray: function (array, chunkSize) {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
          chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    },

    chunkTimeRange: (start, end, chunkSize) => {
        const chunks = [];
        let currentStart = start;
        if (chunkSize < 1) {
            return [{ start: start, end: end }];
        }
        while (currentStart < end) {
            const currentEnd = Math.min(currentStart + chunkSize, end);
            chunks.push({ start: currentStart, end: currentEnd });
            currentStart = currentEnd;
        }
        return chunks;
    },

    extractArray: function (object) {
        let index = 0;
        const array = [];

        while (object[index] !== undefined) {
            array.push(object[index]);
            index++;
        }
        return array;
    },

    getNetworkInterfaces: function () {
        const interfaces = os.networkInterfaces();
        var result = [];
        Object.keys(interfaces).forEach((interfaceName) => {
            interfaces[interfaceName].forEach((iface) => {
                if (iface.internal === true) return;
                if (iface.family !== 'IPv4') return;
                result.push(iface.address);
            });
        });
        return result;
    },

    getRetentionLimit: function(retention) {
        var dayToAdd = 0;
        if (retention === 'day1') {
            dayToAdd = 1;
        } else if (retention === 'days2') {
            dayToAdd = 2;
        } else if (retention === 'days3') {
            dayToAdd = 3;
        } else if (retention === 'days7') {
            dayToAdd = 7;
        } else if (retention === 'days14') {
            dayToAdd = 14;
        } else if (retention === 'days30') {
            dayToAdd = 30;
        } else if (retention === 'days90') {
            dayToAdd = 90;
        } else if (retention === 'year1') {
            dayToAdd = 365;
        } else if (retention === 'year3') {
            dayToAdd = 365 * 3;
        } else if (retention === 'year5') {
            dayToAdd = 365 * 5;
        }
        const date = new Date();
        date.setDate(date.getDate() - dayToAdd);
        return date;
    },
    /**
     * THE boolean parser: the one place that decides what an incoming value means as a
     * boolean.
     *
     * It exists because eight call sites in this server each carried their own version, and
     * they did not agree (batch 60 measured them all):
     *
     *   - three sites ("'true' or '1' is true, everything else is false": device-utils,
     *     scadiaserver, scheduler) - the strict reading;
     *   - httprequest called Boolean(value), so the STRING 'false' read as TRUE - a boolean
     *     write turned itself into its opposite;
     *   - adsclient used value.toLowerCase() !== 'false', so the string '0' read as TRUE,
     *     and a numeric value threw a TypeError;
     *   - the copy in this file said everything except 'false' was true;
     *   - recipes' coerceValue is deliberately NOT this function: it passes an unparseable
     *     value through as-is (its documented contract) and keeps its own numeric families.
     *
     * The canonical reading is the strict one, because in a control system the safe
     * direction is "anything that is not an explicit true is false": a garbled value must
     * never become a TRUE written to a device. The turn-on spellings are 'true' and '1'
     * (case-insensitive, surrounding whitespace ignored); the turn-off spellings are
     * 'false', '0' and the empty string; null/undefined are false; numbers and booleans
     * keep their JavaScript meaning.
     *
     * @param {*} value
     * @returns {boolean}
     */
    parseBoolean: function (value) {
        if (typeof value === 'boolean') {
            return value;
        }
        if (value === null || value === undefined) {
            return false;
        }
        if (typeof value === 'string') {
            const lower = value.toLowerCase().trim();
            return lower === 'true' || lower === '1';
        }
        return Boolean(value);
    },

    /**
     * Check and parse the value return converted value
     * @param {*} value as string
     */
    parseValue: function(value, type){
        if (type === 'number') {
            return parseFloat(value);
        } else if (type === 'boolean') {
            return utils.parseBoolean(value);
        } else if (type === 'string') {
            return value;
        } else {
            let val = parseFloat(value);
            if (Number.isNaN(val)) {
                // maybe boolean
                val = Number(value);
                // maybe string
                if (Number.isNaN(val)) {
                    val = value;
                }
            } else {
                val = parseFloat(val.toFixed(5));
            }
            return val;
        }
    },

    /**
     * Recursively fill in the keys that are MISSING from `target`, taking their values
     * from `source`. `target` wins wherever it already defines a key, which is what makes
     * this usable for "old settings file + new defaults": the user's own values survive and
     * only newly introduced fields are added.
     *
     * The recursive call is qualified (`this.deepMerge`) rather than bare. A bare
     * `deepMerge(...)` resolves against the enclosing scope, where no such binding exists,
     * so it threw ReferenceError the moment the recursion was actually entered — i.e. any
     * time a project's settings were older than the current defaults. main.js catches that
     * and calls process.exit(), so the server refused to start with only
     * "Error loading settings file" in the log.
     *
     * @param {object} source defaults
     * @param {object} target user settings (mutated and returned)
     * @param {Set} [seen] guards against reference cycles (a config object that points at
     *                     its own parent), which would otherwise recurse forever
     * @returns {object} target
     */
    deepMerge: function(source, target, seen) {
        const visited = seen || new Set();
        if (visited.has(source) || visited.has(target)) {
            return target;
        }
        visited.add(source);
        visited.add(target);
        for (const key in source) {
            if (!Object.prototype.hasOwnProperty.call(target, key)) {
                target[key] = source[key];
            } else {
                const sourceVal = source[key];
                const targetVal = target[key];

                if (
                    typeof sourceVal === 'object' &&
                    sourceVal !== null &&
                    !Array.isArray(sourceVal) &&
                    typeof targetVal === 'object' &&
                    targetVal !== null &&
                    !Array.isArray(targetVal)
                ) {
                    this.deepMerge(sourceVal, targetVal, visited);
                }
            }
        }
        return target;
    },

    generateSecretCode: function(byteLength = 32) {
        return crypto.randomBytes(byteLength).toString('hex');
    }
}
