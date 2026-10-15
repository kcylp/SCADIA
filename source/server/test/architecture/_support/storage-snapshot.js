/**
 * D1 / class 3 support - the storage interface snapshot.
 *
 * The plan is to re-implement the same five domain contracts on PostgreSQL, TDengine
 * and Dameng. That only works if the interface is FROZEN before those fills begin:
 * a signature that drifts while three backends are being written is discovered three
 * times, at three different depths.
 *
 * So the exact public surface of the storage plane is captured here as data. Any
 * change is a deliberate act: the snapshot must be regenerated on purpose.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const arch = require('./architecture');

/** The storage plane's public surface, in dependency order (adapters first). */
const STORAGE_MODULES = [
    'runtime/storage/sqlite/index.js',
    'runtime/storage/sqlite/currentstorage.js',
    'runtime/storage/influxdb/index.js',
    'runtime/storage/tdengine/index.js',
    'runtime/storage/questdb/index.js',
    'runtime/storage/calculator.js',
    'runtime/storage/databases.js',
    'runtime/storage/registry.js',
    'runtime/storage/daqstorage.js'
];

/** The modules that must expose a create() factory: the swappable backends. */
const BACKEND_ADAPTERS = [
    'runtime/storage/sqlite/index.js',
    'runtime/storage/postgresql/index.js',
    'runtime/storage/influxdb/index.js',
    'runtime/storage/tdengine/index.js',
    'runtime/storage/questdb/index.js'
];

const SNAPSHOT_PATH = path.join(__dirname, 'storage-interface.snapshot.json');

/**
 * The methods every adapter instance must provide. Measured: all four shipped backends
 * expose these five, whatever else they add on top.
 */
const ADAPTER_CORE = ['addDaqValues', 'close', 'getDaqMap', 'getDaqValue', 'setCall'];

function capture() {
    const modules = {};
    for (const relPath of STORAGE_MODULES) {
        const abs = path.join(arch.SERVER_ROOT, relPath);
        const shape = arch.exportShape(abs);
        if (shape.error) { throw new Error(relPath + ' could not be loaded: ' + shape.error); }
        modules[relPath] = shape;
    }
    const adapters = {};
    for (const relPath of BACKEND_ADAPTERS) {
        adapters[relPath] = arch.instanceMethods(path.join(arch.SERVER_ROOT, relPath));
    }
    return { modules: modules, adapters: adapters };
}

function write(snapshot) {
    const payload = {
        _readme: [
            'Frozen public surface of the storage plane (D1 / class 3).',
            'Regenerate deliberately, never to make a red guard green:',
            '  ARCH_SNAPSHOT_UPDATE=1 npx mocha test/architecture/interfaceSnapshot.test.js',
            'A change here is a change to an interface three future backends must implement (D8-D10).'
        ],
        generatedFor: 'D1 architecture guard',
        modules: snapshot.modules,
        adapters: snapshot.adapters
    };
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return payload;
}

function read() {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

module.exports = { STORAGE_MODULES, BACKEND_ADAPTERS, ADAPTER_CORE, SNAPSHOT_PATH, capture, write, read };
