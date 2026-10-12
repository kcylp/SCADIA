/**
 * The built-in asset library must describe itself truthfully.
 *
 * _assets/ ships with the software (main.js mounts it at /_assets) so that a new project can
 * start from the artwork the product already owns, instead of every site re-drawing the same
 * backdrop. The editor will browse it by reading manifest.json.
 *
 * That makes the manifest a promise, and a manifest that lies fails silently and late: a wrong
 * file name shows a broken thumbnail, a wrong width/height lays the artwork out at the wrong
 * size, an undeclared file is invisible to every future project. So this test checks the
 * manifest against the directory rather than trusting it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const LIBRARY_DIR = path.join(SERVER_ROOT, '_assets');
const MANIFEST = path.join(LIBRARY_DIR, 'manifest.json');

/** Intrinsic size of a PNG or JPEG, read from its header - no image library needed. */
function imageSize(buffer, name) {
    if (/\.png$/i.test(name)) {
        if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) { return null; }
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (/\.jpe?g$/i.test(name)) {
        let i = 2;
        while (i < buffer.length - 9) {
            if (buffer[i] !== 0xFF) { i += 1; continue; }
            const marker = buffer[i + 1];
            if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
            const length = buffer.readUInt16BE(i + 2);
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
            }
            i += 2 + length;
        }
    }
    return null;
}

describe('built-in asset library (the manifest is a promise)', () => {
    let expect;
    let manifest;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
        manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    });

    it('ships a manifest that parses and declares its categories', () => {
        expect(manifest.version, 'a library without a version cannot be updated safely').to.be.a('number');
        expect(manifest.categories.length, 'categories are how the editor browses it').to.be.greaterThan(0);
        expect(manifest.assets.length, 'an empty library is not a library').to.be.greaterThan(0);
    });

    it('declares every asset exactly once, with the fields the editor needs', () => {
        const ids = new Set();
        const categories = manifest.categories.map((c) => c.id);
        for (const asset of manifest.assets) {
            expect(ids.has(asset.id), 'duplicate asset id: ' + asset.id).to.equal(false);
            ids.add(asset.id);
            expect(asset.file, asset.id + ' must name a file').to.be.a('string');
            expect(categories.indexOf(asset.category), asset.id + ' names the unknown category ' + asset.category)
                .to.not.equal(-1);
            // A Chinese reader has to find it later; an English reader has to find it too.
            expect(asset.name, asset.id + ' needs a human name').to.be.a('string');
        }
    });

    it('resolves every declared file to a real file', () => {
        const missing = manifest.assets
            .filter((asset) => !fs.existsSync(path.join(LIBRARY_DIR, asset.file)))
            .map((asset) => asset.id + ' -> ' + asset.file);
        expect(missing, 'declared but absent, so the editor would show a broken tile:\n' + missing.join('\n'))
            .to.deep.equal([]);
    });

    it('states the real pixel size, so the artwork is not laid out wrong', () => {
        const wrong = [];
        for (const asset of manifest.assets) {
            const file = path.join(LIBRARY_DIR, asset.file);
            if (!fs.existsSync(file)) { continue; }
            const size = imageSize(fs.readFileSync(file), asset.file);
            if (!size) { continue; }
            if (size.width !== asset.width || size.height !== asset.height) {
                wrong.push(asset.id + ': manifest says ' + asset.width + 'x' + asset.height +
                    ', the file is ' + size.width + 'x' + size.height);
            }
        }
        expect(wrong, 'the manifest and the artwork disagree:\n' + wrong.join('\n')).to.deep.equal([]);
    });

    it('leaves no artwork undeclared', () => {
        // The other direction: a file dropped into the folder is invisible to every future
        // project until somebody writes it into the manifest, so say so now.
        const declared = new Set(manifest.assets.map((asset) => asset.file));
        const undeclared = fs.readdirSync(LIBRARY_DIR)
            .filter((name) => name !== 'manifest.json')
            .filter((name) => !declared.has(name));
        expect(undeclared, 'present in _assets but missing from the manifest:\n' + undeclared.join('\n'))
            .to.deep.equal([]);
    });

    it('is mounted by the server, so the editor can actually fetch it', () => {
        const main = fs.readFileSync(path.join(SERVER_ROOT, 'main.js'), 'utf8');
        expect(main, 'the library ships with the software and must be served from it')
            .to.contains("'/_assets'");
        expect(main).to.contains('settings.assetsDir');
    });
});
