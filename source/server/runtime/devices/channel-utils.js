/**
 * 'devices/channel-utils': the "channel" middle layer of the device model
 * (device -> channel -> tag, matching the 展厅/展厅 device model).
 *
 * Pure functions (no I/O, no runtime state) so the rules that decide how a tag
 * belongs to a channel are testable on their own; the API layer persists.
 *
 * Storage shape (deliberate, see PLAN B4):
 *   device.channels = [ { id, name, description, enabled } ]   <- channel list
 *   device.tags     = { <tagId>: { ..., channelId } }          <- flat, unchanged
 *
 * The tag map stays the single source of truth and its keys stay the tagId, so
 * everything already built on `device.tags[tagId]` (DAQ history, alarms,
 * calibration, scheduler, getDeviceIdFromTag, every driver's load()) keeps
 * working untouched. A channel is an *attribute* of a tag, not a container.
 * Nesting the tags under channels instead would duplicate every tag, and the
 * two copies would drift.
 *
 * Backward compatibility: a device with no `channels` and no tag `channelId`
 * is a plain two-layer device. Its tags resolve to the implicit default
 * channel (id ''), which is only ever *derived*, never written to disk.
 */

'use strict';

/** Id of the implicit channel that holds tags with no explicit channel. */
const DEFAULT_CHANNEL_ID = '';
const DEFAULT_CHANNEL_NAME = '默认通道';

/** Configured (portable) fields of a channel definition. */
const CHANNEL_DEFINITION_FIELDS = ['id', 'name', 'description', 'enabled', 'order'];

const MAX_CHANNELS_PER_DEVICE = 4096;

function isStr(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

function clone(v) {
    if (v === null || v === undefined) { return v; }
    if (typeof v === 'object') { return JSON.parse(JSON.stringify(v)); }
    return v;
}

/** The channel a tag belongs to; unknown/absent -> the default channel. */
function channelIdOf(tag) {
    if (tag && isStr(tag.channelId)) { return tag.channelId.trim(); }
    return DEFAULT_CHANNEL_ID;
}

/** Declared channels as stored, filtered to well-formed entries. */
function declaredChannels(device) {
    const list = device && device.channels;
    if (!Array.isArray(list)) { return []; }
    return list.filter(c => c && typeof c === 'object' && !Array.isArray(c));
}

function tagMap(device) {
    return (device && device.tags && typeof device.tags === 'object' && !Array.isArray(device.tags))
        ? device.tags : {};
}

function tagsOf(device, channelId) {
    const want = channelId === undefined || channelId === null ? DEFAULT_CHANNEL_ID : String(channelId);
    const out = {};
    const tags = tagMap(device);
    for (const id of Object.keys(tags)) {
        if (channelIdOf(tags[id]) === want) { out[id] = tags[id]; }
    }
    return out;
}

function countTagsOf(device, channelId) {
    return Object.keys(tagsOf(device, channelId)).length;
}

/** A channel definition with only the portable fields that exist. */
function toChannelDefinition(channel) {
    const out = {};
    if (!channel || typeof channel !== 'object') { return out; }
    for (const f of CHANNEL_DEFINITION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(channel, f) && channel[f] !== undefined) {
            out[f] = clone(channel[f]);
        }
    }
    return out;
}

/**
 * Check a device's channel wiring without changing anything.
 * @returns {{ok:boolean, errors:Array<{id,error}>, warnings:Array<{id,error}>}}
 */
function validateDeviceChannels(device) {
    const errors = [];
    const warnings = [];
    const seen = {};

    const declared = declaredChannels(device);
    if (declared.length > MAX_CHANNELS_PER_DEVICE) {
        errors.push({ id: null, error: `too many channels (max ${MAX_CHANNELS_PER_DEVICE})` });
    }
    for (const c of declared) {
        if (!isStr(c.id)) {
            errors.push({ id: null, error: `channel '${c.name || ''}' has no id` });
            continue;
        }
        const id = c.id.trim();
        if (seen[id]) {
            errors.push({ id: id, error: 'duplicate channel id' });
            continue;
        }
        seen[id] = true;
    }

    // A tag pointing at a channel that does not exist would silently fall back
    // to the default channel on read; say so instead of hiding the mistake.
    const tags = tagMap(device);
    for (const id of Object.keys(tags)) {
        const cid = channelIdOf(tags[id]);
        if (cid !== DEFAULT_CHANNEL_ID && !seen[cid]) {
            warnings.push({ id: id, error: `tag references unknown channel '${cid}'` });
        }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

/**
 * Canonical stored shape: dedupe the channel list and make every tag's
 * channelId point at a channel that exists (unknown -> default).
 *
 * Returns a copy; never mutates the input. Runtime values on tags are kept.
 * @returns {{device:object, changed:boolean, warnings:Array}}
 */
function normalizeDevice(device) {
    if (!device || typeof device !== 'object') {
        return { device: device, changed: false, warnings: [] };
    }
    const out = clone(device);
    const warnings = [];

    const channels = [];
    const seen = {};
    for (const c of declaredChannels(out)) {
        if (!isStr(c.id)) { continue; }
        const id = c.id.trim();
        if (seen[id]) {
            warnings.push({ id: id, error: 'duplicate channel id dropped' });
            continue;
        }
        seen[id] = true;
        const def = toChannelDefinition(c);
        def.id = id;
        channels.push(def);
    }

    const tags = tagMap(out);
    for (const id of Object.keys(tags)) {
        const tag = tags[id];
        if (!tag || typeof tag !== 'object' || Array.isArray(tag)) { continue; }
        const cid = channelIdOf(tag);
        if (cid === DEFAULT_CHANNEL_ID) {
            // keep the stored form clean: absence means "default channel"
            if (tag.channelId !== undefined) { delete tag.channelId; }
        } else if (!seen[cid]) {
            warnings.push({ id: id, error: `tag references unknown channel '${cid}', moved to default` });
            delete tag.channelId;
        } else {
            tag.channelId = cid;
        }
    }

    if (channels.length || Array.isArray(out.channels)) { out.channels = channels; }

    const changed = JSON.stringify(channels) !== JSON.stringify(device.channels);
    return { device: out, changed: changed, warnings: warnings };
}

/**
 * The effective channel list for a UI/API consumer, including the implicit
 * default channel whenever some tag lives in it, and any channel that is still
 * referenced by a tag but no longer declared (so a tag never disappears from
 * the channel view just because its channel was dropped by hand).
 * @returns {Array<{id,name,description,enabled,isDefault,declared,tagCount}>}
 */
function getChannels(device) {
    const out = [];
    const seen = {};
    for (const c of declaredChannels(device)) {
        if (!isStr(c.id)) { continue; }
        const id = c.id.trim();
        if (seen[id]) { continue; }
        seen[id] = true;
        out.push({
            id: id,
            name: isStr(c.name) ? c.name : id,
            description: c.description,
            enabled: c.enabled !== false,
            order: c.order,
            isDefault: false,
            declared: true,
            tagCount: countTagsOf(device, id)
        });
    }

    // referenced but not declared: keep it visible instead of hiding its tags
    const tags = tagMap(device);
    for (const tagId of Object.keys(tags)) {
        const cid = channelIdOf(tags[tagId]);
        if (cid === DEFAULT_CHANNEL_ID || seen[cid]) { continue; }
        seen[cid] = true;
        out.push({
            id: cid,
            name: cid,
            enabled: true,
            isDefault: false,
            declared: false,
            tagCount: countTagsOf(device, cid)
        });
    }

    const defaultCount = countTagsOf(device, DEFAULT_CHANNEL_ID);
    if (defaultCount > 0 || out.length === 0) {
        out.push({
            id: DEFAULT_CHANNEL_ID,
            name: DEFAULT_CHANNEL_NAME,
            description: undefined,
            enabled: true,
            isDefault: true,
            declared: false,
            tagCount: defaultCount
        });
    }
    return out;
}

/** One channel by id ('' -> the default channel), or null. */
function getChannel(device, channelId) {
    const want = channelId === undefined || channelId === null ? DEFAULT_CHANNEL_ID : String(channelId);
    const found = getChannels(device).find(c => c.id === want);
    return found || null;
}

/**
 * Add a channel. The id is taken from the spec when valid, otherwise derived
 * from the name; it must not collide with an existing channel.
 * @returns {{device:object, channel:object}|{error:string}}
 */
function createChannel(device, spec) {
    if (!device || typeof device !== 'object') { return { error: 'device not found' }; }
    const s = spec || {};
    let id = isStr(s.id) ? s.id.trim() : null;
    if (!id) {
        if (!isStr(s.name)) { return { error: 'channel needs an id or a name' }; }
        id = slugify(s.name);
    }
    if (!id) { return { error: 'channel id could not be derived from the name' }; }
    if (id === DEFAULT_CHANNEL_ID) { return { error: 'channel id is reserved' }; }

    const out = clone(device);
    const channels = Array.isArray(out.channels) ? out.channels.filter(c => c && isStr(c.id)) : [];
    if (channels.some(c => c.id.trim() === id)) {
        return { error: `channel '${id}' already exists` };
    }
    if (channels.length >= MAX_CHANNELS_PER_DEVICE) {
        return { error: `too many channels (max ${MAX_CHANNELS_PER_DEVICE})` };
    }
    const channel = {
        id: id,
        name: isStr(s.name) ? s.name : id,
        description: s.description,
        enabled: s.enabled !== false
    };
    if (s.order !== undefined) { channel.order = s.order; }
    channels.push(channel);
    out.channels = channels;
    return { device: out, channel: channel };
}

/**
 * Update a channel's configured fields. The id can be renamed, in which case
 * every tag that pointed at it is repointed so no tag is orphaned.
 * @returns {{device:object, channel:object}|{error:string}}
 */
function updateChannel(device, channelId, patch) {
    const want = channelId === undefined || channelId === null ? DEFAULT_CHANNEL_ID : String(channelId);
    if (want === DEFAULT_CHANNEL_ID) { return { error: 'the default channel cannot be edited' }; }
    const out = clone(device);
    const channels = Array.isArray(out.channels) ? out.channels : [];
    const idx = channels.findIndex(c => c && isStr(c.id) && c.id.trim() === want);
    if (idx < 0) { return { error: `channel '${want}' not found` }; }

    const p = patch || {};
    const current = channels[idx];
    let newId = want;
    if (p.id !== undefined && String(p.id).trim() !== want) {
        newId = String(p.id).trim();
        if (newId === DEFAULT_CHANNEL_ID) { return { error: 'channel id is reserved' }; }
        if (channels.some((c, i) => i !== idx && c && isStr(c.id) && c.id.trim() === newId)) {
            return { error: `channel '${newId}' already exists` };
        }
    }

    const next = Object.assign({}, current, { id: newId });
    if (p.name !== undefined) { next.name = p.name; }
    if (p.description !== undefined) { next.description = p.description; }
    if (p.enabled !== undefined) { next.enabled = p.enabled !== false; }
    if (p.order !== undefined) { next.order = p.order; }
    channels[idx] = next;
    out.channels = channels;

    if (newId !== want) {
        const tags = tagMap(out);
        for (const id of Object.keys(tags)) {
            if (channelIdOf(tags[id]) === want) { tags[id].channelId = newId; }
        }
    }
    return { device: out, channel: next };
}

/**
 * Remove a channel. Its tags are never deleted: they are repointed to
 * `opts.reassignTo` (the default channel unless a live channel is named).
 * @returns {{device:object, reassigned:number}|{error:string}}
 */
function removeChannel(device, channelId, opts) {
    const want = channelId === undefined || channelId === null ? DEFAULT_CHANNEL_ID : String(channelId);
    if (want === DEFAULT_CHANNEL_ID) { return { error: 'the default channel cannot be removed' }; }
    const o = opts || {};
    const out = clone(device);
    const channels = Array.isArray(out.channels) ? out.channels : [];
    const idx = channels.findIndex(c => c && isStr(c.id) && c.id.trim() === want);
    if (idx < 0) { return { error: `channel '${want}' not found` }; }
    channels.splice(idx, 1);
    out.channels = channels;

    let target = DEFAULT_CHANNEL_ID;
    if (o.reassignTo !== undefined && o.reassignTo !== null && String(o.reassignTo) !== DEFAULT_CHANNEL_ID) {
        target = String(o.reassignTo);
        if (!channels.some(c => c && isStr(c.id) && c.id.trim() === target)) {
            return { error: `reassign target '${target}' not found` };
        }
    }

    let reassigned = 0;
    const tags = tagMap(out);
    for (const id of Object.keys(tags)) {
        if (channelIdOf(tags[id]) === want) {
            if (target === DEFAULT_CHANNEL_ID) { delete tags[id].channelId; }
            else { tags[id].channelId = target; }
            reassigned++;
        }
    }
    return { device: out, reassigned: reassigned };
}

/**
 * Move tags into a channel (or back to the default channel with '').
 * Unknown tags are reported, never silently ignored.
 * @returns {{device:object, moved:Array, errors:Array}|{error:string}}
 */
function assignTags(device, tagIds, channelId) {
    if (!device || typeof device !== 'object') { return { error: 'device not found' }; }
    const want = channelId === undefined || channelId === null ? DEFAULT_CHANNEL_ID : String(channelId);
    const out = clone(device);

    if (want !== DEFAULT_CHANNEL_ID && !getChannels(out).some(c => c.id === want && !c.isDefault)) {
        return { error: `channel '${want}' not found` };
    }

    const tags = tagMap(out);
    const moved = [];
    const errors = [];
    for (const raw of [].concat(tagIds || [])) {
        const id = isStr(raw) ? raw.trim() : (raw && raw.id ? String(raw.id) : null);
        if (!id || !Object.prototype.hasOwnProperty.call(tags, id)) {
            errors.push({ id: id, error: 'unknown tag' });
            continue;
        }
        if (want === DEFAULT_CHANNEL_ID) { delete tags[id].channelId; }
        else { tags[id].channelId = want; }
        moved.push(id);
    }
    if (!moved.length && errors.length) { return { error: errors[0].error, errors: errors }; }
    return { device: out, moved: moved, errors: errors };
}

/** A stable, human-readable id derived from a name (used when none is given). */
function slugify(name) {
    const s = String(name || '').trim().toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return s;
}

module.exports = {
    DEFAULT_CHANNEL_ID: DEFAULT_CHANNEL_ID,
    DEFAULT_CHANNEL_NAME: DEFAULT_CHANNEL_NAME,
    CHANNEL_DEFINITION_FIELDS: CHANNEL_DEFINITION_FIELDS,
    MAX_CHANNELS_PER_DEVICE: MAX_CHANNELS_PER_DEVICE,
    channelIdOf: channelIdOf,
    toChannelDefinition: toChannelDefinition,
    validateDeviceChannels: validateDeviceChannels,
    normalizeDevice: normalizeDevice,
    getChannels: getChannels,
    getChannel: getChannel,
    tagsOf: tagsOf,
    countTagsOf: countTagsOf,
    createChannel: createChannel,
    updateChannel: updateChannel,
    removeChannel: removeChannel,
    assignTags: assignTags,
    slugify: slugify
};
