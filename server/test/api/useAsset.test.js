/**
 * POST /api/resources/useAsset - "put this library asset into MY project".
 *
 * The built-in library ships with the software and is shared by every project. A screen must not
 * reference it directly: a library update would then silently change the screen a plant was
 * signed off with. So using an asset copies it into the project's own images folder, and the
 * copy is what the view points at.
 *
 * Driven over a real HTTP request against the real express app, with only the two permission
 * functions stubbed - the path containment, the copy and the naming are the shipping code.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const LIBRARY_DIR = path.join(SERVER_ROOT, '_assets');

function postJson(port, urlPath, payload) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const req = http.request({
            host: '127.0.0.1', port: port, path: urlPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = data ? JSON.parse(data) : null; } catch (err) { parsed = data; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

describe('POST /api/resources/useAsset (library asset into the project)', () => {
    let expect;
    let server;
    let port;
    let imagesDir;
    let assetName;

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;

        imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadia-use-asset-'));
        const manifest = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'manifest.json'), 'utf8'));
        assetName = manifest.assets[0].file;

        const runtime = {
            project: { name: 'test' },
            settings: { assetsDir: LIBRARY_DIR, imagesFileDir: imagesDir },
            logger: { info: () => {}, warn: () => {}, error: () => {} }
        };
        const resources = require('../../api/resources');
        // -1 is the admin group id the real permission checker returns for an administrator.
        resources.init(runtime, (req, res, next) => next(), () => -1);

        // The server composes the api apps behind a JSON body parser; driving the sub-app on
        // its own has to reproduce that, or req.body is undefined and every call fails for a
        // reason that has nothing to do with the endpoint.
        const express = require('express');
        const composed = express();
        composed.use(express.json());
        composed.use(resources.app());

        server = http.createServer(composed);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(() => {
        if (server) { server.close(); }
        try { fs.rmSync(imagesDir, { recursive: true, force: true }); } catch (err) { /* disposable */ }
    });

    it('copies the asset into the project and answers with the web path', async () => {
        const res = await postJson(port, '/api/resources/useAsset', { file: assetName });

        expect(res.status, JSON.stringify(res.body)).to.equal(200);
        expect(res.body.path).to.equal('_images/library/' + assetName.split(path.sep).join('/'));
        const copied = path.join(imagesDir, 'library', assetName);
        expect(fs.existsSync(copied), 'the copy must exist: ' + copied).to.equal(true);
    });

    it('copies the bytes intact, not a re-encode', async () => {
        const source = fs.readFileSync(path.join(LIBRARY_DIR, assetName));
        const copied = fs.readFileSync(path.join(imagesDir, 'library', assetName));
        expect(copied.equals(source), 'the project art must be byte-identical to the library art').to.equal(true);
    });

    it('reuses the copy when the same asset is used twice', async () => {
        const before = fs.readdirSync(path.join(imagesDir, 'library')).length;
        const res = await postJson(port, '/api/resources/useAsset', { file: assetName });

        expect(res.status).to.equal(200);
        expect(res.body.path).to.equal('_images/library/' + assetName.split(path.sep).join('/'));
        expect(fs.readdirSync(path.join(imagesDir, 'library')).length,
            'using an asset again must not litter the project with near-identical copies')
            .to.equal(before);
    });

    it('refuses an asset the library does not have', async () => {
        const res = await postJson(port, '/api/resources/useAsset', { file: 'no-such-asset.png' });
        expect(res.status).to.equal(400);
        expect(res.body.error).to.equal('unknown_asset');
    });

    it('refuses to be walked out of the library', async () => {
        // The containment helper is the shipping one, so this is the real answer to a real
        // request - not a claim about what the helper would do.
        for (const attempt of ['../server/package.json', '..\\package.json', '/etc/passwd', 'a/../../b.png']) {
            const res = await postJson(port, '/api/resources/useAsset', { file: attempt });
            expect(res.status, 'must refuse: ' + attempt).to.equal(400);
            expect(res.body.error, 'must refuse: ' + attempt).to.equal('unknown_asset');
        }
    });
});
