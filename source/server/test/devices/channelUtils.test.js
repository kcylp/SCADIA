/**
 * 'devices/channel-utils' unit tests (B4).
 *
 * The channel layer is the rule set that decides which channel a tag belongs to
 * and what happens when a channel is created, renamed or removed. It is pure, so
 * it is tested here directly, with no runtime and no storage.
 */

const channelUtils = require('../../runtime/devices/channel-utils');
const tagIo = require('../../runtime/devices/tag-io');

const { expect } = require('chai');

describe('channel-utils (B4)', () => {
    function legacyDevice() {
        return {
            id: 'd1',
            tags: {
                t1: { id: 't1', name: 'a', address: '1' },
                t2: { id: 't2', name: 'b', address: '2' }
            }
        };
    }

    function channelledDevice() {
        return {
            id: 'd1',
            channels: [{ id: 'c1', name: 'one' }, { id: 'c2', name: 'two' }],
            tags: {
                t1: { id: 't1', address: '1', channelId: 'c1' },
                t2: { id: 't2', address: '2', channelId: 'c1' },
                t3: { id: 't3', address: '3', channelId: 'c2' },
                t4: { id: 't4', address: '4' }
            }
        };
    }

    describe('channelIdOf', () => {
        it('defaults a tag with no channel to the implicit default channel', () => {
            expect(channelUtils.channelIdOf({ id: 'x' })).to.equal('');
            expect(channelUtils.channelIdOf(null)).to.equal('');
        });

        it('trims a declared channel id', () => {
            expect(channelUtils.channelIdOf({ channelId: ' c1 ' })).to.equal('c1');
        });
    });

    describe('getChannels', () => {
        it('gives a plain two-layer device exactly one implicit default channel', () => {
            const channels = channelUtils.getChannels(legacyDevice());
            expect(channels).to.have.lengthOf(1);
            expect(channels[0].id).to.equal('');
            expect(channels[0].isDefault).to.equal(true);
            expect(channels[0].tagCount).to.equal(2);
        });

        it('lists declared channels with their tag counts, default last', () => {
            const channels = channelUtils.getChannels(channelledDevice());
            const ids = channels.map(c => c.id);
            expect(ids).to.deep.equal(['c1', 'c2', '']);
            expect(channels[0].tagCount).to.equal(2);
            expect(channels[2].tagCount).to.equal(1);
        });

        it('keeps a channel that is still referenced but no longer declared visible', () => {
            const device = legacyDevice();
            device.tags.t1.channelId = 'ghost';
            const channels = channelUtils.getChannels(device);
            const ghost = channels.find(c => c.id === 'ghost');
            expect(ghost).to.exist;
            expect(ghost.declared).to.equal(false);
            expect(ghost.tagCount).to.equal(1, 'its tag must not disappear from the channel view');
        });
    });

    describe('createChannel', () => {
        it('uses the given id', () => {
            const r = channelUtils.createChannel(legacyDevice(), { id: 'c1', name: 'one' });
            expect(r.error).to.equal(undefined);
            expect(r.channel.id).to.equal('c1');
            expect(r.device.channels).to.have.lengthOf(1);
        });

        it('derives an id from the name when none is given', () => {
            const r = channelUtils.createChannel(legacyDevice(), { name: 'Boiler A' });
            expect(r.channel.id).to.equal('boiler-a');
        });

        it('keeps non-ascii names usable as ids', () => {
            const r = channelUtils.createChannel(legacyDevice(), { name: '1号机组' });
            expect(r.channel.id).to.equal('1号机组');
        });

        it('refuses a channel with neither id nor name', () => {
            expect(channelUtils.createChannel(legacyDevice(), {}).error).to.equal('channel needs an id or a name');
        });

        it('refuses the reserved default id', () => {
            expect(channelUtils.createChannel(legacyDevice(), { id: '' }).error).to.match(/id or a name|reserved/);
        });

        it('refuses a duplicate id', () => {
            const r = channelUtils.createChannel(channelledDevice(), { id: 'c1', name: 'again' });
            expect(r.error).to.equal("channel 'c1' already exists");
        });

        it('does not mutate the input device', () => {
            const device = legacyDevice();
            channelUtils.createChannel(device, { id: 'c1', name: 'one' });
            expect(device.channels).to.equal(undefined);
        });
    });

    describe('updateChannel', () => {
        it('renames a channel and repoints every tag that used it', () => {
            const r = channelUtils.updateChannel(channelledDevice(), 'c1', { id: 'c9', name: 'nine' });
            expect(r.error).to.equal(undefined);
            expect(r.channel.id).to.equal('c9');
            expect(r.device.tags.t1.channelId).to.equal('c9');
            expect(r.device.tags.t2.channelId).to.equal('c9');
            expect(r.device.tags.t3.channelId).to.equal('c2');
        });

        it('updates only the fields that were given', () => {
            const r = channelUtils.updateChannel(channelledDevice(), 'c1', { description: 'x' });
            expect(r.channel.name).to.equal('one');
            expect(r.channel.description).to.equal('x');
        });

        it('refuses to edit the default channel', () => {
            expect(channelUtils.updateChannel(channelledDevice(), '', { name: 'x' }).error).to.equal('the default channel cannot be edited');
        });

        it('refuses an unknown channel', () => {
            expect(channelUtils.updateChannel(channelledDevice(), 'nope', { name: 'x' }).error).to.equal("channel 'nope' not found");
        });

        it('refuses a rename onto an existing channel', () => {
            expect(channelUtils.updateChannel(channelledDevice(), 'c1', { id: 'c2' }).error).to.equal("channel 'c2' already exists");
        });
    });

    describe('removeChannel', () => {
        it('reassigns its tags to the default channel and never deletes them', () => {
            const r = channelUtils.removeChannel(channelledDevice(), 'c2');
            expect(r.error).to.equal(undefined);
            expect(r.reassigned).to.equal(1);
            expect(r.device.tags.t3).to.exist;
            expect(r.device.tags.t3.channelId).to.equal(undefined);
            expect(r.device.channels.map(c => c.id)).to.deep.equal(['c1']);
        });

        it('can reassign to another live channel instead', () => {
            const r = channelUtils.removeChannel(channelledDevice(), 'c2', { reassignTo: 'c1' });
            expect(r.device.tags.t3.channelId).to.equal('c1');
        });

        it('refuses a reassign target that does not exist', () => {
            expect(channelUtils.removeChannel(channelledDevice(), 'c2', { reassignTo: 'nope' }).error).to.equal("reassign target 'nope' not found");
        });

        it('refuses to remove the default channel', () => {
            expect(channelUtils.removeChannel(channelledDevice(), '').error).to.equal('the default channel cannot be removed');
        });
    });

    describe('assignTags', () => {
        it('moves tags into a channel', () => {
            const r = channelUtils.assignTags(channelledDevice(), ['t4'], 'c2');
            expect(r.moved).to.deep.equal(['t4']);
            expect(r.device.tags.t4.channelId).to.equal('c2');
        });

        it('moves tags back to the default channel by dropping the field', () => {
            const r = channelUtils.assignTags(channelledDevice(), ['t1'], '');
            expect(r.moved).to.deep.equal(['t1']);
            expect(r.device.tags.t1.channelId).to.equal(undefined);
        });

        it('reports unknown tags instead of silently dropping them', () => {
            const r = channelUtils.assignTags(channelledDevice(), ['t4', 'ghost'], 'c2');
            expect(r.moved).to.deep.equal(['t4']);
            expect(r.errors).to.deep.equal([{ id: 'ghost', error: 'unknown tag' }]);
        });

        it('fails when nothing could be moved', () => {
            const r = channelUtils.assignTags(channelledDevice(), ['ghost'], 'c2');
            expect(r.error).to.equal('unknown tag');
            expect(r.device).to.equal(undefined);
        });

        it('refuses a target channel that does not exist', () => {
            expect(channelUtils.assignTags(channelledDevice(), ['t1'], 'nope').error).to.equal("channel 'nope' not found");
        });

        it('accepts {id} objects as well as ids', () => {
            const r = channelUtils.assignTags(channelledDevice(), [{ id: 't4' }], 'c2');
            expect(r.moved).to.deep.equal(['t4']);
        });
    });

    describe('normalizeDevice', () => {
        it('drops a channel reference to a channel the device does not declare', () => {
            const device = legacyDevice();
            device.channels = [{ id: 'c1', name: 'one' }];
            device.tags.t1.channelId = 'c1';
            device.tags.t2.channelId = 'ghost';
            const r = channelUtils.normalizeDevice(device);
            expect(r.device.tags.t1.channelId).to.equal('c1');
            expect(r.device.tags.t2.channelId).to.equal(undefined);
            expect(r.warnings).to.have.lengthOf(1);
            expect(r.warnings[0].id).to.equal('t2');
        });

        it('removes the stored field for a tag in the default channel', () => {
            const device = legacyDevice();
            device.tags.t1.channelId = '';
            const r = channelUtils.normalizeDevice(device);
            expect(r.device.tags.t1.channelId).to.equal(undefined);
        });

        it('dedupes the channel list and reports the drop', () => {
            const device = legacyDevice();
            device.channels = [{ id: 'c1', name: 'one' }, { id: 'c1', name: 'dup' }];
            const r = channelUtils.normalizeDevice(device);
            expect(r.device.channels).to.have.lengthOf(1);
            expect(r.warnings.length).to.equal(1);
        });

        it('is idempotent and never mutates the input', () => {
            const device = channelledDevice();
            const before = JSON.stringify(device);
            const once = channelUtils.normalizeDevice(device).device;
            const twice = channelUtils.normalizeDevice(once).device;
            expect(JSON.stringify(device)).to.equal(before, 'input untouched');
            expect(JSON.stringify(twice)).to.equal(JSON.stringify(once));
        });

        it('keeps a plain two-layer device free of a channels key it never had', () => {
            const r = channelUtils.normalizeDevice(legacyDevice());
            expect(r.device.channels).to.equal(undefined);
        });
    });

    describe('validateDeviceChannels', () => {
        it('flags a duplicate channel id as an error', () => {
            const v = channelUtils.validateDeviceChannels({ channels: [{ id: 'a' }, { id: 'a' }] });
            expect(v.ok).to.equal(false);
            expect(v.errors).to.have.lengthOf(1);
        });

        it('flags an unknown channel reference as a warning, not an error', () => {
            const v = channelUtils.validateDeviceChannels({ tags: { x: { id: 'x', channelId: 'nope' } } });
            expect(v.ok).to.equal(true);
            expect(v.warnings).to.have.lengthOf(1);
        });

        it('accepts a well-formed device', () => {
            expect(channelUtils.validateDeviceChannels(channelledDevice()).ok).to.equal(true);
        });
    });

    describe('round-trip through tag-io', () => {
        it('exports the channel assignment of a tag', () => {
            const doc = tagIo.exportDeviceTags(channelledDevice(), {});
            expect(doc.tags.t1.channelId).to.equal('c1');
            expect(doc.tags.t4.channelId).to.equal(undefined);
        });

        it('imports a tag into the channel named in the file', () => {
            const device = channelledDevice();
            const merged = tagIo.mergeDeviceTags(device, [
                { id: 't9', address: '9', channelId: 'c2' }
            ], {});
            expect(merged.added).to.deep.equal(['t9']);
            expect(device.tags.t9.channelId).to.equal('c2');
        });
    });
});
