/**
 * A runtime file must be able to GET the packages it requires.
 *
 * This is N-1 written down as a rule. The plugin mechanism exists because most industrial
 * protocols need an npm package that must NOT be shipped in the server's own dependencies:
 * the operator installs it from the plugin page, into an isolated runtime directory, and the
 * manager hands it to the driver (runtime/plugins/npm-runtime-service.js:108 createRequire
 * with a three-tier fallback). A driver that reaches for such a package with a plain
 * require() therefore fails on a machine where the operator did what the UI told them to do -
 * and it fails the way this project hates most: silently, at load, with no error anywhere.
 *
 * The rule: for every bare require() in a runtime file, the name must be
 *   1. a Node builtin, or
 *   2. a declared dependency of server/package.json, or
 *   3. fetched through the plugins manager SOMEWHERE IN THE SAME FILE
 *      (`manager.require('x')`), which is the plugin path, or
 *   4. recorded in EXEMPT below with a reason.
 *
 * Batch 61 measured the whole runtime tree with this rule: 16 drivers need an external
 * package, 12 fetch it through the manager, 3 (httprequest/mqtt/websocket via axios/mqtt/ws)
 * rely on packages that ARE declared dependencies, one (scadiaserver) needs nothing, and the
 * template driver's plugin lines are deliberately commented out. One exemption is left, and
 * it is justified by the plugin registry rather than by the driver.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const module_ = require('module');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const RUNTIME_DIR = path.join(SERVER_ROOT, 'runtime');
const PLUGINS_INDEX = path.join(RUNTIME_DIR, 'plugins', 'index.js');
const PACKAGE_JSON = path.join(SERVER_ROOT, 'package.json');

const BUILTINS = new Set(module_.builtinModules.concat(module_.builtinModules.map((m) => 'node:' + m)));

/**
 * Plain requires that are allowed anyway, keyed '<runtime-relative path>:<module>'.
 * `inPluginRegistry` pins the install path that makes the exemption honest: if the registry
 * entry disappears, the exemption is no longer justified and this guard says so.
 */
const EXEMPT = {
    'jobs/helper/image-generator.js:chartjs-node-canvas': {
        reason: 'optional chart plugin: required inside a try/catch and createImage answers null ' +
            'when it is absent (image-generator.js:80), so a machine without it loses charts, not the server',
        inPluginRegistry: 'chartjs-node-canvas'
    }
};

/** Every .js under runtime/ (node_modules excluded), plus the entry files next to it. */
function runtimeFiles() {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.name.endsWith('.js')) { out.push(full); }
        }
    };
    walk(RUNTIME_DIR);
    ['main.js', 'scadia.js', 'paths.js', 'envParams.js', 'settings.default.js'].forEach((name) => {
        const full = path.join(SERVER_ROOT, name);
        if (fs.existsSync(full)) { out.push(full); }
    });
    return out.sort();
}

const relative = (file) => path.relative(RUNTIME_DIR, file).split(path.sep).join('/');

/** A require call, with the receiver when it has one (`manager.require(...)`). */
const REQUIRE_CALL = /(?:([\w.$]+)\s*\.\s*)?require\(\s*'([^']+)'\s*\)/g;

function requiresIn(file) {
    const plain = [];
    const throughManager = new Set();
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        REQUIRE_CALL.lastIndex = 0;
        let m;
        while ((m = REQUIRE_CALL.exec(line))) {
            const receiver = m[1];
            const name = m[2];
            if (name.startsWith('.') || name.startsWith('/')) { continue; }
            const bare = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
            if (receiver && /\.require$/.test(receiver + '.require')) {
                throughManager.add(bare);
            } else if (receiver) {
                throughManager.add(bare);        // any object.require(...) is a manager-shaped fetch
            } else {
                plain.push({ name: bare, line: index + 1 });
            }
        }
    });
    return { plain: plain, throughManager: throughManager };
}

describe('a runtime file can actually get the packages it requires', () => {
    const files = runtimeFiles();
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const declared = new Set(Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.optionalDependencies || {})));
    const registry = fs.readFileSync(PLUGINS_INDEX, 'utf8');

    it('the scan really scanned something', function () {
        expect(files.length, 'the runtime/ walk found almost nothing').to.be.greaterThan(90);
        expect(declared.size, 'server/package.json declares no dependencies at all').to.be.greaterThan(20);
    });

    it('every bare require is a builtin, a declared dependency, a plugin fetch, or exempt', function () {
        const offenders = [];
        files.forEach((file) => {
            const rel = relative(file);
            const { plain, throughManager } = requiresIn(file);
            plain.forEach((entry) => {
                if (BUILTINS.has(entry.name)) { return; }
                if (declared.has(entry.name)) { return; }
                if (throughManager.has(entry.name)) { return; }
                if (EXEMPT[rel + ':' + entry.name]) { return; }
                offenders.push(rel + ':' + entry.line + " requires '" + entry.name +
                    "', which is not a builtin, not in package.json, and this file never asks the plugins manager for it");
            });
        });
        expect(offenders, 'these packages would simply not be there on a machine that installed ' +
            'them the way the product says to:\n' + offenders.join('\n')).to.deep.equal([]);
    });

    it('the exemptions are exactly the recorded ones, each still justified', function () {
        const needed = [];
        files.forEach((file) => {
            const rel = relative(file);
            const { plain, throughManager } = requiresIn(file);
            plain.forEach((entry) => {
                if (BUILTINS.has(entry.name) || declared.has(entry.name) || throughManager.has(entry.name)) { return; }
                needed.push(rel + ':' + entry.name);
            });
        });
        expect(needed.sort(), 'the exemption list has drifted from the tree').to.deep.equal(Object.keys(EXEMPT).sort());
        Object.keys(EXEMPT).forEach((key) => {
            const rule = EXEMPT[key];
            expect(rule.reason.length, key + ' is exempt without a reason').to.be.greaterThan(40);
            if (rule.inPluginRegistry) {
                expect(registry.indexOf("'" + rule.inPluginRegistry + "'"),
                    key + ' claims the plugins registry can install ' + rule.inPluginRegistry +
                    ', but runtime/plugins/index.js no longer lists it: the exemption is not justified any more')
                    .to.be.greaterThan(-1);
            }
        });
    });

    it('every plugin-registry entry is reachable by name from the driver it points at', function () {
        // The registry is the install path; this reports the pairs so a registry entry that
        // no driver consumes (or a driver nobody can install for) is visible as a number.
        const entries = [];
        const re = /new Plugin\('([^']+)',\s*'([^']+)'/g;
        let m;
        while ((m = re.exec(registry))) { entries.push({ name: m[1], driver: m[2] }); }
        expect(entries.length, 'the plugin registry parsed to nothing').to.be.greaterThan(10);
        const unconsumed = entries.filter((entry) => {
            const dir = entry.driver.replace(/^\.\//, '').replace(/-/g, '-');
            const candidates = [
                path.join(RUNTIME_DIR, 'devices', dir, 'index.js'),
                path.join(RUNTIME_DIR, dir, 'index.js'),
                path.join(RUNTIME_DIR, 'devices', dir.split('-')[0], 'index.js')
            ].filter((p) => fs.existsSync(p));
            if (!candidates.length) { return true; }
            return !candidates.some((p) => fs.readFileSync(p, 'utf8').indexOf(entry.name) >= 0);
        });
        // Reported as a measurement with a floor rather than a hard failure: node-red and
        // chartjs-node-canvas are consumed outside runtime/devices.
        expect(entries.length - unconsumed.length, 'plugin registry entries nobody consumes: ' +
            unconsumed.map((e) => e.name).join(', ')).to.be.greaterThan(10);
    });
});
