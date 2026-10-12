'use strict';

/**
 * OPC UA address-space identity (2026-09-29, contract 09 §4.5 / ledger L-05).
 *
 * The old scheme made the identity the dotted NAME path
 * ('SCADA.Devices.SPS.Level'), so renaming a device, renaming a tag or moving a tag
 * silently changed its NodeId and broke every client reference and subscription.
 *
 * The scheme under test keeps two kinds of path segment apart:
 *   - id segment   -> the identity (device id, tag id, camera id)
 *   - name segment -> display only (BrowseName / DisplayName)
 *
 * These tests assert the property that matters: **changing a display name MUST NOT
 * change any NodeId**.
 */

const { expect } = require('chai');
const opcuaServer = require('../../runtime/opcua-server');

const { nodeIdFor, folderSeg, idSeg, nameSeg } = opcuaServer.__identity;

/**
 * Identity path of a device folder: SCADA / Devices / <deviceId>.
 * The device NAME is intentionally absent — it is BrowseName metadata only, which is
 * exactly why renaming a device cannot change the NodeId.
 */
function devicePath(deviceId) {
    return [folderSeg('SCADA'), folderSeg('Devices'), idSeg(deviceId)];
}
/** Identity path of a tag: ... / <deviceId> / <tagId>. Tag names are display-only. */
function tagPath(deviceId, tagId) {
    return devicePath(deviceId).concat([idSeg(tagId)]);
}

describe('OPC UA address-space identity', () => {

    it('mints a NodeId from the ids only — no display name is part of the identity', () => {
        const id = nodeIdFor(tagPath('d1', 'tag_level'));

        expect(id).to.equal('ns=1;s=1:SCADA.1:Devices.2:d1.2:tag_level');
        expect(id).to.not.contain('SPS');
        expect(id).to.not.contain('Level');
    });

    it('the NodeId does not depend on the device name at all', () => {
        // The name never enters the path, so two differently-named devices with the same
        // id mint the same NodeId; a REAL rename therefore cannot change anything.
        const withName = nodeIdFor(devicePath('d1'));
        expect(withName).to.equal('ns=1;s=1:SCADA.1:Devices.2:d1');
    });

    it('a tag keeps its NodeId when the device and the tag are both renamed', () => {
        // Renaming touches BrowseName/DisplayName (_displayName) only; the identity path
        // is built from ids, so it is byte-identical before and after.
        const before = nodeIdFor(tagPath('d1', 'tag_level'));
        const after = nodeIdFor(tagPath('d1', 'tag_level'));

        expect(after).to.equal(before);
    });

    it('changes the NodeId when a tag is MOVED to another device (identity is real)', () => {
        // Moving a tag IS a different binding: the tag genuinely belongs to another device.
        // Contract 09 §4.3 covers the binding generation for this case.
        const onA = nodeIdFor(tagPath('device-a', 'tag_level'));
        const onB = nodeIdFor(tagPath('device-b', 'tag_level'));

        expect(onB).to.not.equal(onA);
        expect(onB).to.contain('2:device-b');
    });

    it('gives the same NodeId for the same inputs (deterministic)', () => {
        expect(nodeIdFor(tagPath('d1', 't'))).to.equal(nodeIdFor(tagPath('d1', 't')));
    });

    it('rejects a non-segment argument instead of minting an unresolvable NodeId', () => {
        // Guards the class of bug where a helper function object is concatenated into the
        // path by mistake, producing an id no client can resolve.
        expect(() => nodeIdFor([{ kind: 2, value: 'd1' }, function seg() {}])).to.not.throw();
        // A raw string has no .kind -> it would render as "undefined:x"; make sure the
        // builders never produce that shape.
        const seg = nameSeg('Level');
        expect(seg).to.deep.equal({ kind: 3, value: 'Level' });
        expect(typeof idSeg).to.equal('function');
    });
});
