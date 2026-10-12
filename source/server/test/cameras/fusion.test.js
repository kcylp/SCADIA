const assert = require('assert');

const storage = require('../../runtime/cameras/camera-storage');
const fusion = require('../../runtime/cameras/fusion');

/**
 * 视数融合 unit tests.
 *
 * The SCADIA tag bus is faked so these run without a live runtime; the goal is to
 * lock the two contracts the UI depends on:
 *   - data -> video: OSD text is formatted deterministically from live tag values
 *   - video -> data: status/alarm events are written only to tags that exist
 */

/**
 * @param {object} tags       tagId -> live value
 * @param {object} [definitions] tagId -> { dataDomain } (project definitions). A tag
 *                              with no definition models an unknown tag; a definition
 *                              without a domain models a measured tag.
 */
function fakeRuntime(tags, definitions) {
    const defs = definitions || {};
    return {
        devices: {
            getTagDefinition: (tagId) => (tagId in defs ? defs[tagId] : null),
            getTagValue: (tagId) => {
                if (!(tagId in tags)) { return null; }
                return { value: tags[tagId], timestamp: Date.now() };
            },
            getDeviceIdFromTag: (tagId) => (tagId in tags ? tagId.split('/')[0] : null),
            setTagValue: async (tagId, value) => {
                if (!(tagId in tags)) { return null; }
                tags[tagId] = value;
                return true;
            }
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} }
    };
}

function stubCamera(camera) {
    const original = storage.getCamera;
    storage.getCamera = async (id) => (camera && camera.id === id ? camera : null);
    return () => { storage.getCamera = original; };
}

describe('Camera fusion (视数融合)', () => {

    afterEach(() => {
        fusion.init(null);
    });

    it('resolves a value OSD item with label, unit and decimals from a live tag', async () => {
        const tags = { 'S7-1200/level': 3.14159 };
        fusion.init(fakeRuntime(tags));
        const restore = stubCamera({
            id: 'cam1',
            osd: { items: [{ type: 'value', tagId: 'S7-1200/level', label: '液位', unit: 'm', decimals: 2, position: 'bottom-right' }] }
        });
        const res = await fusion.resolveOsd('cam1');
        restore();

        assert.strictEqual(res.items.length, 1);
        assert.strictEqual(res.items[0].position, 'bottom-right');
        assert.strictEqual(res.items[0].quality, 'good');
        assert.strictEqual(res.items[0].text, '液位 3.14 m');
    });

    it('marks a missing tag as bad quality but still renders the label/unit', async () => {
        fusion.init(fakeRuntime({}));
        const restore = stubCamera({
            id: 'cam2',
            osd: { items: [{ type: 'value', tagId: 'S7-1200/missing', label: '压力', unit: 'kPa', decimals: 1 }] }
        });
        const res = await fusion.resolveOsd('cam2');
        restore();

        assert.strictEqual(res.items[0].quality, 'bad');
        assert.strictEqual(res.items[0].text, '压力 -- kPa');
        assert.strictEqual(res.items[0].position, 'top-left'); // defaulted
    });

    it('formats time items and keeps plain text items verbatim', async () => {
        fusion.init(fakeRuntime({}));
        const restore = stubCamera({
            id: 'cam3',
            osd: { items: [
                { type: 'text', text: '采区A — 皮带机', position: 'top-left' },
                { type: 'time', format: 'datetime', position: 'top-right' }
            ] }
        });
        const res = await fusion.resolveOsd('cam3');
        restore();

        assert.strictEqual(res.items[0].text, '采区A — 皮带机');
        assert.match(res.items[1].text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('rejects resolveOsd for an unknown camera with CAM_NOT_FOUND', async () => {
        fusion.init(fakeRuntime({}));
        const restore = stubCamera(null);
        await assert.rejects(() => fusion.resolveOsd('nope'), (err) => {
            restore();
            assert.strictEqual(err.code, 'CAM_NOT_FOUND');
            return true;
        });
    });

    it('refuses to write an alarm event to a non-existent tag', async () => {
        fusion.init(fakeRuntime({ 'S7-1200/ok': 0 }));
        await assert.rejects(() => fusion.writeEvent('S7-1200/nope', 1), (err) => {
            assert.strictEqual(err.code, 'CAM_TAG_NOT_FOUND');
            return true;
        });
    });

    it('writes a boolean event as 1/0 to a tag declared as a derived (software) target', async () => {
        const tags = { 'S7-1200/alarm': 0 };
        fusion.init(fakeRuntime(tags, { 'S7-1200/alarm': { id: 'S7-1200/alarm', dataDomain: 'derived' } }));
        const on = await fusion.writeEvent('S7-1200/alarm', true);
        assert.strictEqual(on.value, 1);
        assert.strictEqual(tags['S7-1200/alarm'], 1);
        const off = await fusion.writeEvent('S7-1200/alarm', false);
        assert.strictEqual(off.value, 0);
        assert.strictEqual(tags['S7-1200/alarm'], 0);
    });

    it('refuses a video event that targets a MEASURED tag', async () => {
        // A camera event is an observation the platform derived; writing it into a
        // measured tag would overwrite what the device actually reported.
        const tags = { 'S7-1200/level': 0 };
        fusion.init(fakeRuntime(tags, { 'S7-1200/level': { id: 'S7-1200/level' } }));   // no domain => measured
        await assert.rejects(() => fusion.writeEvent('S7-1200/level', 1), (err) => {
            assert.strictEqual(err.code, 'CAM_TAG_DOMAIN_REFUSED');
            assert.strictEqual(err.reason, 'would-overwrite-measured');
            return true;
        });
        assert.strictEqual(tags['S7-1200/level'], 0, 'the measured tag must be untouched');
    });

    it('refuses a video event when the tag has no project definition', async () => {
        const tags = { 'S7-1200/ghost': 0 };
        fusion.init(fakeRuntime(tags));                                                  // no definition at all
        await assert.rejects(() => fusion.writeEvent('S7-1200/ghost', 1), (err) => {
            assert.strictEqual(err.code, 'CAM_TAG_DOMAIN_REFUSED');
            assert.strictEqual(err.reason, 'unknown-tag');
            return true;
        });
    });

    it('accepts a video event on a PREDICTED tag', async () => {
        const tags = { 'ai/score': 0 };
        fusion.init(fakeRuntime(tags, { 'ai/score': { id: 'ai/score', dataDomain: 'predicted' } }));
        const res = await fusion.writeEvent('ai/score', true);
        assert.strictEqual(res.value, 1);
        assert.strictEqual(tags['ai/score'], 1);
    });

    it('polls only enabled cameras and caches their online state', async () => {
        fusion.init(fakeRuntime({}));
        const original = storage.getCameras;
        storage.getCameras = async () => ([
            { id: 'on', name: 'enabled', enabled: true, vendor: 'hikvision', host: '10.0.0.1', snapshotTemplate: null },
            { id: 'off', name: 'disabled', enabled: false, vendor: 'hikvision', host: '10.0.0.2' }
        ]);
        const results = await fusion.pollOnce();
        storage.getCameras = original;

        assert.strictEqual(results.length, 1, 'disabled cameras must be skipped');
        assert.strictEqual(results[0].id, 'on');
        assert.strictEqual(fusion.getStatus()['off'], undefined);
    });
});
