/**
 * 'devices/tag-io': portable export/import of a device's tag definitions.
 *
 * Pure functions (no I/O, no storage) so the rules that decide what a file may
 * change in a project are testable on their own. The API layer performs the
 * persistence.
 *
 * Deliberate asymmetry:
 *   - EXPORT is lossless for the *definition* fields (the things an engineer
 *     configures) and excludes runtime state (value/timestamp/changed), which
 *     would be stale the moment it is written to a file.
 *   - IMPORT is additive only. It never deletes a tag and never silently
 *     overwrites an existing one: an id that already exists is reported as
 *     skipped unless the caller explicitly asks to overwrite. A bad import file
 *     must not be able to destroy a working project.
 */

'use strict';

/** Fields that describe a tag (portable) — runtime state is excluded on purpose. */
const DEFINITION_FIELDS = [
    'id', 'name', 'label', 'type', 'address', 'memaddress', 'divisor',
    'format', 'init', 'description', 'unsPath', 'scale', 'deadband', 'daq',
    'options', 'direction', 'edge', 'access', 'sysType',
    // which KIND of data the tag carries (measured / derived / predicted) — part of
    // the definition an engineer configures, so it must survive export/import
    'dataDomain',
    // the channel a tag belongs to is part of its definition (device -> channel
    // -> tag), so an exported file keeps the tag in its configured channel
    'channelId'
];

/** Fields that are runtime state and must never be imported. */
const RUNTIME_FIELDS = ['value', 'rawValue', 'timestamp', 'changed', 'lastDaqSaved'];

const MAX_TAGS_PER_IMPORT = 5000;

function isStr(v) { return typeof v === 'string' && v.trim().length > 0; }

function clone(v) {
    if (v === null || v === undefined) { return v; }
    if (typeof v === 'object') { return JSON.parse(JSON.stringify(v)); }
    return v;
}

/**
 * One tag -> a portable definition (only the configured fields that exist).
 */
function toDefinition(tag) {
    const out = {};
    if (!tag || typeof tag !== 'object') { return out; }
    for (const f of DEFINITION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(tag, f) && tag[f] !== undefined) {
            out[f] = clone(tag[f]);
        }
    }
    return out;
}

/**
 * Export a device's tags as a portable document.
 *
 * @param {object} device
 * @param {object} [opts] { includeValues: boolean, values: {tagId: value} }
 */
function exportDeviceTags(device, opts) {
    const o = opts || {};
    const tags = {};
    for (const id of Object.keys((device && device.tags) || {})) {
        const def = toDefinition(device.tags[id]);
        if (!isStr(def.id)) { def.id = id; }
        if (o.includeValues && o.values && Object.prototype.hasOwnProperty.call(o.values, id)) {
            def.value = o.values[id];
        }
        tags[id] = def;
    }
    return {
        format: 'kaicheng-scada/device-tags',
        version: 1,
        exportedAt: new Date().toISOString(),
        device: {
            id: device && device.id,
            name: device && device.name,
            type: device && device.type
        },
        count: Object.keys(tags).length,
        tags: tags
    };
}

/**
 * Accept several import shapes, because operators paste whatever they have:
 *   - the document produced by exportDeviceTags  ({ tags: { id: {...} } })
 *   - a bare map                                 ({ id: {...} })
 *   - a list of tags                             ([ {...}, {...} ])
 *   - a single tag                               ({ id, address, ... })
 *
 * @returns {{list: Array, error: string|null}}
 */
function normalizeImport(input) {
    if (input === null || input === undefined) {
        return { list: [], error: 'no content to import' };
    }
    let source = input;

    // a JSON string is accepted so a pasted file body works too
    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch (err) {
            return { list: [], error: 'content is not valid JSON' };
        }
    }

    if (source && typeof source === 'object' && !Array.isArray(source)) {
        if (source.tags !== undefined) { source = source.tags; }
        else if (source.devices !== undefined) { source = source.devices; }
    }

    let list = [];
    if (Array.isArray(source)) {
        list = source.filter(t => t && typeof t === 'object');
    } else if (source && typeof source === 'object') {
        for (const key of Object.keys(source)) {
            const item = source[key];
            if (!item || typeof item !== 'object') { continue; }
            const copy = Object.assign({}, item);
            if (!isStr(copy.id)) { copy.id = key; }
            list.push(copy);
        }
    }

    if (list.length > MAX_TAGS_PER_IMPORT) {
        return { list: [], error: `too many tags in one import (max ${MAX_TAGS_PER_IMPORT})` };
    }
    return { list: list, error: null };
}

/**
 * Validate one incoming tag definition and strip runtime state.
 * @returns {{ok:true, tag:object}|{ok:false, id:any, error:string}}
 */
function validateTag(raw) {
    // An array passes `typeof === 'object'` but is not a tag definition; reject
    // it explicitly so the error says what is actually wrong.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, id: null, error: 'not an object' };
    }
    const tag = toDefinition(raw);
    // runtime fields must never come in from a file
    for (const f of RUNTIME_FIELDS) { delete tag[f]; }

    if (!isStr(tag.id) && !isStr(tag.name)) {
        return { ok: false, id: tag.id, error: 'tag has neither id nor name' };
    }
    if (!isStr(tag.id)) { tag.id = tag.name.trim(); }
    if (!isStr(tag.name)) { tag.name = tag.id; }
    // A tag with no address cannot be read or written by any driver; accepting
    // it would create a dead entry that looks configured but never updates.
    if (!isStr(tag.address) && !isStr(tag.memaddress)) {
        return { ok: false, id: tag.id, error: 'tag has no address' };
    }
    if (!isStr(tag.type)) { tag.type = 'number'; }
    return { ok: true, tag: tag };
}

/**
 * Merge incoming definitions into a device.
 *
 * @param {object} device      the current device (mutated copy is returned)
 * @param {Array}  incoming    raw tag definitions
 * @param {object} [opts]      { overwrite: boolean, generateId: boolean }
 * @returns {{device:object, added:Array, updated:Array, skipped:Array, errors:Array}}
 */
function mergeDeviceTags(device, incoming, opts) {
    const o = opts || {};
    const out = {
        device: device,
        added: [],
        updated: [],
        skipped: [],
        errors: []
    };
    if (!device || typeof device !== 'object') {
        out.errors.push({ id: null, error: 'device not found' });
        return out;
    }
    device.tags = device.tags || {};

    for (const raw of (incoming || [])) {
        const check = validateTag(raw);
        if (!check.ok) {
            out.errors.push({ id: check.id, error: check.error });
            continue;
        }
        const tag = check.tag;
        const exists = Object.prototype.hasOwnProperty.call(device.tags, tag.id);

        if (exists && !o.overwrite) {
            out.skipped.push({ id: tag.id, reason: 'exists' });
            continue;
        }
        if (exists) {
            // overwrite keeps the previous value out of the picture: the
            // definition changes, the live value is whatever the driver next reads
            const previous = device.tags[tag.id];
            device.tags[tag.id] = Object.assign({}, tag, { value: previous ? previous.value : null });
            out.updated.push(tag.id);
        } else {
            device.tags[tag.id] = Object.assign({}, tag, { value: null });
            out.added.push(tag.id);
        }
    }
    return out;
}

module.exports = {
    DEFINITION_FIELDS: DEFINITION_FIELDS,
    RUNTIME_FIELDS: RUNTIME_FIELDS,
    MAX_TAGS_PER_IMPORT: MAX_TAGS_PER_IMPORT,
    toDefinition: toDefinition,
    exportDeviceTags: exportDeviceTags,
    normalizeImport: normalizeImport,
    validateTag: validateTag,
    mergeDeviceTags: mergeDeviceTags
};
