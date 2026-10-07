/**
 * D1 - REVERSE VERIFICATION for the architecture guard.
 *
 * A guard nobody has seen fail is a guard nobody should trust. This harness injects one
 * deliberate violation per class, and demands three things of each:
 *
 *   1. the class goes red;
 *   2. it goes red on the SPECIFIC check that owns the rule (not on some incidental
 *      crash), so the rule is proven to be the thing doing the work;
 *   3. once the source is restored, the class is green again - proven by re-running it,
 *      not by assuming the restore worked.
 *
 * Files are checked with a SHA-256 before and after, so a crash mid-run cannot leave the
 * working tree modified without saying so.
 *
 * usage: node test/architecture/_support/reverse-verify.js
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const baseline = require('./reverse-baseline');

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
const MOCHA = path.join(SERVER_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A violation that is never executed: the guard reads source, so it must only be text. */
const deadFunction = (name, body) => '\n\nfunction ' + name + '() { ' + body + ' }\n';

const CASES = [
    {
        id: '1 依赖方向',
        suite: 'dependencyDirection.test.js',
        what: 'a runtime module requires the api layer',
        file: 'runtime/storage/calculator.js',
        append: deadFunction('_archReverseVerify', "return require('../../api/index.js');"),
        expectRed: ['the runtime never depends on the api layer']
    },
    {
        id: '2 反向依赖',
        suite: 'reverseDependency.test.js',
        what: 'runtime/utils.js requires the storage plane, closing a cycle',
        file: 'runtime/utils.js',
        append: deadFunction('_archReverseVerify', "return require('./storage/daqstorage');"),
        expectRed: ['the require graph of runtime + api is acyclic']
    },
    {
        id: '3 接口方法集快照',
        suite: 'interfaceSnapshot.test.js',
        what: 'the storage plane grows a public method nobody froze',
        file: 'runtime/storage/calculator.js',
        append: '\nmodule.exports.__archReverseVerify = function (a, b) {};\n',
        expectRed: ['the frozen surface matches the code, method for method']
    },
    {
        id: '4 错误语义',
        suite: 'errorSemantics.test.js',
        what: 'the storage plane learns to kill the host process',
        file: 'runtime/storage/sqlite/index.js',
        append: deadFunction('_archReverseVerify', 'process.exit(0);'),
        expectRed: ['the storage plane never terminates the process']
    },
    {
        id: '5 注册表完整性',
        suite: 'registryCompleteness.test.js',
        what: 'a delivery backend is added to the registry and registered nowhere else',
        file: 'runtime/storage/registry.js',
        find: 'const BACKENDS = [',
        replace: "const BACKENDS = [\n    {\n        id: 'mysql2', label: 'MySQL2', adapter: null, status: 'reserved', delivery: true, perDeviceNode: false,\n        retention: { native: false, strategy: 'product-rolling', wired: false }\n    },",
        expectRed: ['the registry, the matrix and the frozen contract describe the same world']
    },
    {
        id: '6 跨域隔离',
        suite: 'crossDomainIsolation.test.js',
        what: 'one domain reaches into another domain private store',
        file: 'runtime/alarms/alarmstorage.js',
        append: deadFunction('_archReverseVerify', "return require('../cameras/camera-storage');"),
        expectRed: [
            'the set of cross-domain dependencies is exactly the frozen baseline',
            'no domain reaches into another domain private store (the shared plane is fair game)'
        ]
    },
    {
        id: '7 A-01 regression',
        suite: 'interfaceSnapshot.test.js',
        what: 'the getSum export goes back to this.getSum - the latent defect this pass fixed',
        file: 'runtime/storage/calculator.js',
        find: '    getSum: getSum,',
        replace: '    getSum: this.getSum,',
        expectRed: ['no module exports a binding that can only be undefined']
    },
    {
        id: '8 scanner contract',
        suite: 'scannerContract.test.js',
        what: 'a helper under test/ runs again when mocha loads it, which once truncated the whole suite',
        file: 'test/architecture/_support/routing-probe.js',
        find: 'if (require.main === module) {',
        // A side effect that is loud and harmless. The first version of this case used
        // 'if (true)', which made the probe write its output to process.argv[2] - under
        // mocha that is the SPEC PATH, so the injection overwrote a test file. An
        // injection must never be able to destroy the tree it is verifying.
        replace: 'process.stdout.write("arch-reverse-verify");\nif (require.main === module) {',
        expectRed: ['every helper under test/ does nothing when it is loaded']
    },
    {
        id: '9 adapter instance contract',
        suite: 'interfaceSnapshot.test.js',
        what: 'a backend renames a method the facade calls (the surface D8-D10 must reproduce)',
        file: 'runtime/storage/questdb/index.js',
        find: '    this.getDaqMap = function (tagid) {',
        replace: '    this.getDaqMapRenamed = function (tagid) {',
        expectRed: ['every backend adapter provides the common instance contract']
    },
    {
        id: '10 D2 no claim without evidence',
        suite: 'capabilityMatrix.test.js',
        what: 'a capability verdict is stated with nothing behind it',
        file: '../../19_能力矩阵_存储后端.json',
        find: '        "durability": {\n          "verdict": "yes",\n          "evidence": "measured: test/architecture/_support/capability-probe.js#durability"',
        replace: '        "durability": {\n          "verdict": "yes",\n          "evidence": null',
        expectRed: ['no claim without evidence']
    },
    {
        id: '11 D2 matrix versus reality',
        suite: 'capabilityMatrix.test.js',
        what: 'a measured cell is edited to disagree with the live probe',
        file: '../../19_能力矩阵_存储后端.json',
        find: '        "concurrent-writers": {\n          "verdict": "no",',
        replace: '        "concurrent-writers": {\n          "verdict": "yes",',
        expectRed: ['the measured cells still match a live probe of the default backend']
    },
    {
        id: '12 D2 human document',
        suite: 'capabilityMatrix.test.js',
        what: 'the generated human document is hand-edited',
        file: '../../19_能力矩阵_存储后端.md',
        append: '\n手写补充：这一行不在机器读的 JSON 里。\n',
        expectRed: ['the human document is generated, not written']
    },
    {
        id: '13 D4 contract contradicts the matrix',
        suite: 'domainContracts.test.js',
        what: 'a domain starts requiring a capability a delivery backend is proven not to have, without declaring itself out',
        file: 'runtime/storage/contract.js',
        find: "        requires: ['durability'],",
        replace: "        requires: ['durability', 'atomic-batch'],",
        expectRed: ['a required capability a delivery backend cannot provide forces a declared exclusion']
    },
    {
        id: '14 D4 object seam',
        suite: 'domainContracts.test.js',
        what: 'the object domain pretends to have an implementation',
        file: 'runtime/storage/contract.js',
        find: '        owner: [],',
        replace: "        owner: ['runtime/storage/calculator.js'],",
        expectRed: ['the object domain is a declared seam, not an implementation']
    },
    {
        id: '15 D4 realtime boundary',
        suite: 'domainContracts.test.js',
        what: 'a real backend grows a subscribe(), which the boundary forbids',
        file: 'runtime/storage/questdb/index.js',
        find: '    this.getDaqMap = function (tagid) {',
        replace: '    this.subscribe = function () {};\n    this.getDaqMap = function (tagid) {',
        expectRed: ['the adapter contract stays free of realtime vocabulary']
    },
    {
        id: '16 D5 refuses the unknown',
        suite: 'registryCompleteness.test.js',
        what: 'an unknown backend type quietly falls back again instead of being refused',
        file: 'runtime/storage/registry.js',
        find: '        throw new Error(message);',
        replace: "        return { backendId: 'sqlite', type: 'SQlite', backend: backendById('sqlite') };",
        expectRed: ['an unknown backend type is refused by name']
    },
    {
        id: '17 D5 one routing vocabulary',
        suite: 'registryCompleteness.test.js',
        what: 'the facade starts comparing the setting itself again',
        file: 'runtime/storage/daqstorage.js',
        find: 'function addDaqNode(_id, fncgetprop) {',
        replace: "function addDaqNode(_id, fncgetprop) {\n    if (settings.daqstore.type === 'QuestDB') { daqSelection = registry.normalise(settings, logger); }",
        expectRed: ['the routing vocabulary lives in the registry, not in the facade']
    },
    {
        id: '18 D5 one adapter signature',
        suite: 'interfaceSnapshot.test.js',
        what: 'one adapter drops back to its own create() signature',
        file: 'runtime/storage/questdb/index.js',
        find: '    create: function (settings, logger, currentStorage, options) {   // options unused: one store',
        replace: '    create: function (settings, logger, currentStorage) {',
        expectRed: ['every adapter shares one create() signature']
    },
    {
        id: '19 D6 half-open interval',
        suite: 'contract/sqlite.test.js',
        what: 'the adapter goes back to a SQL BETWEEN, which is closed on both ends',
        file: 'runtime/storage/sqlite/index.js',
        find: 'var sql = "SELECT dt, value FROM data WHERE id = ? AND dt >= ? AND dt < ? ORDER BY dt ASC";',
        replace: 'var sql = "SELECT dt, value FROM data WHERE id = ? AND dt BETWEEN ? and ? ORDER BY dt ASC";',
        expectRed: ['uses a half-open interval: the sample at "to" is outside']
    },
    {
        id: '20 D6 unknown tag is a miss',
        suite: 'contract/sqlite.test.js',
        what: 'the adapter goes back to rejecting when a tag is unknown, instead of answering empty',
        file: 'runtime/storage/sqlite/index.js',
        find: '                // lookup miss is not a failure, and rejecting here made the two look alike.\n                resolve([]);',
        replace: "                reject('tag id ' + tagid + ' not found!');",
        expectRed: ['answers an unknown tag with an empty list, not an error']
    },
    {
        id: '21 D6 coverage honesty',
        suite: 'contract/coverage.test.js',
        what: 'a delivery backend quietly stops being accounted for by the suite',
        file: 'test/contract/_support/backends.js',
        find: '    mysql: {',
        replace: '    mysqlRenamed: {',
        expectRed: ['accounts for every delivery backend']
    },
    {
        id: '22 D7 no private connections',
        suite: 'dependencyDirection.test.js',
        what: 'a domain opens its own sqlite3 connection again, which is what D7 closed',
        file: 'runtime/users/usrstorage.js',
        append: '\n\nfunction _archReverseVerify() { return require("sqlite3"); }\n',
        expectRed: ['only runtime/storage may require the sqlite3 package (A-04 closed at D7)']
    },
    {
        id: '23 D7 the plane stays a leaf',
        suite: 'dependencyDirection.test.js',
        what: 'the shared plane reaches back into a domain',
        file: 'runtime/storage/databases.js',
        append: '\n\nfunction _archReverseVerify() { return require("../project/prjstorage"); }\n',
        expectRed: ['the storage plane depends on nothing inside runtime but utils']
    },
    {
        id: '24 D8 reserved stays unselectable',
        suite: 'contract/coverage.test.js',
        what: 'a backend that has no implementation at all becomes selectable',
        file: 'runtime/storage/registry.js',
        find: "    { value: 'SQlite', backend: 'sqlite', canonical: true },",
        replace: "    { value: 'MySQL', backend: 'mysql', canonical: true },\n    { value: 'SQlite', backend: 'sqlite', canonical: true },",
        expectRed: ['an unproven backend is not offered to users']
    },
    {
        id: '25 D8 unproven cannot claim delivered',
        suite: 'contract/coverage.test.js',
        what: 'the registry calls PostgreSQL delivered while its fixture is still waiting for a server',
        file: 'runtime/storage/registry.js',
        find: "        status: 'unproven',",
        replace: "        status: 'delivered',",
        expectRed: ['the registry and the fixture files tell the same story']
    },
    {
        id: '26 D8 structure is still checkable',
        suite: 'contract/coverage.test.js',
        what: 'an unproven adapter loses the half-open range in its SQL',
        file: 'runtime/storage/postgresql/index.js',
        find: "'FROM ' + table + ' WHERE tag_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts';",
        replace: "'FROM ' + table + ' WHERE tag_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts';",
        expectRed: ['every delivery adapter obeys the shape of the contract']
    },
    {
        id: '27 D9 A-07 stays closed',
        suite: 'architecture/errorSemantics.test.js',
        what: 'the TDengine adapter goes back to letting an unusable configuration escape as an unhandled rejection',
        file: 'runtime/storage/tdengine/index.js',
        edits: [
            {
                find: "            logger.error('daqstorage: TDengine init failed! ' + error);",
                to: "            logger.error('daqstorage: TDengine init failed! ' + error);\n            throw error;"
            },
            {
                find: '    this.init().catch((error) => {',
                to: '    this.init().then((error) => {'
            }
        ],
        expectRed: ['a backend handed an unusable configuration degrades instead of killing the host (A-07, closed at D9)']
    },
    {
        id: '28 D9 disconnected reads settle',
        suite: 'architecture/errorSemantics.test.js',
        what: 'a read from a backend that is not connected rejects instead of settling with no data',
        file: 'runtime/storage/tdengine/index.js',
        find: '            if (!connected || !conn) {\n                resolve([]);\n                return;\n            }',
        replace: "            if (!connected || !conn) {\n                reject(new Error('not connected'));\n                return;\n            }",
        expectRed: ['a backend handed an unusable configuration degrades instead of killing the host (A-07, closed at D9)']
    },
    {
        id: '29 driver dispatch: the prefix form comes back',
        suite: 'devices/driverDispatch.test.js',
        what: 'loadPlugin goes back to DeviceEnum.ModbusTCP.startsWith(type)',
        file: 'runtime/devices/device.js',
        find: '    } else if (type === DeviceEnum.ModbusTCP || type === DeviceEnum.ModbusRTU) {',
        replace: '    } else if (DeviceEnum.ModbusTCP.startsWith(type)) {',
        expectRed: ['a type that is a PREFIX of a real type binds NOTHING']
    },
    {
        id: '29b driver emit: a driver publishes without the guard',
        suite: 'devices/driverEmitDiscipline.test.js',
        what: 'a driver reaches for the event bus instead of the shared emitter, which is how three of them lost the superseded-binding guard',
        file: 'runtime/devices/webcam/index.js',
        find: "    var _emitValues = function (values) {",
        replace: "    var _emitValues = function (values) {\n        events.emit('device-value:changed', { id: data.id, values: values });",
        expectRed: ["no driver emits 'device-value:changed' directly"]
    },
    {
        id: '30 spa routes: a page the server cannot answer',
        suite: 'architecture/spaRoutesCompleteness.test.js',
        what: 'a client route is added and SHELL_ROUTES is not, which is how P0-1 shipped',
        file: '../client/src/app/app.routing.ts',
        find: "    { path: 'ar', component: ArViewComponent },",
        replace: "    { path: 'ar', component: ArViewComponent },\n    { path: 'newDeeperPage', component: ArViewComponent },",
        expectRed: ['no client route is missing from SHELL_ROUTES']
    },
    {
        id: '30b R5: a browser alert comes back',
        suite: 'architecture/uiConsistencyR5.test.js',
        what: 'a controller notifies through the native dialog again, which an iframe suppresses',
        file: '../client/src/app/view/view.component.ts',
        find: "            console.error('Error loadHMI');",
        replace: "            console.error('Error loadHMI');\n            alert('loadHMI failed');",
        expectRed: ['no alert() in the client app']
    },
    {
        id: '30c R1: a token is dropped from one theme',
        suite: 'architecture/uiConsistencyR1.test.js',
        what: 'a theme token is removed from THEMES.default while a stylesheet still reads it',
        file: '../client/src/app/_config/theme.config.ts',
        find: "        workPanelExpandBackground: '#f9f9f9',\n",
        replace: "",
        expectRed: ['every token read by a stylesheet is declared by BOTH themes']
    },
    {
        id: '30d API registry: a hand-written mount pair comes back',
        suite: 'architecture/apiRegistry.test.js',
        what: 'a domain is mounted by hand again instead of through the registry table',
        file: 'api/index.js',
        find: 'const API_REGISTRY = [',
        replace: "prjApi.init(runtime, authMiddleware, verifyGroups);\nconst API_REGISTRY = [",
        expectRed: ['the hand-written init+use pairs are gone for good']
    },
    {
        id: '29c driver interface: getValue goes back to a local copy',
        suite: 'devices/driverInterface.test.js',
        what: 'a driver re-adds its own getValue, which is how thirteen of them drifted apart before',
        file: 'runtime/devices/s7/index.js',
        find: '    deviceUtils.installCommonDriverApi(this, {',
        replace: "    this.getValue = function (id) { return null; };\n    deviceUtils.installCommonDriverApi(this, {",
        expectRed: ['s7 exposes getValue / bindAddDaq / addDaq']
    },
    {
        id: '29d device accessor: the failure goes back to stdout',
        suite: 'devices/deviceAccessors.test.js',
        what: 'an accessor swallows its failure into console.error again, where no operator log sees it',
        file: 'runtime/devices/index.js',
        find: "        logAccessorFailure('getTagValue', sigid, err);",
        replace: '        console.error(err);',
        expectRed: ['getTagValue still answers null, and names the operation']
    },
    {
        id: '29e device-values fan-out: one catch wraps the whole loop again',
        suite: 'runtime/deviceValuesFanout.test.js',
        what: 'the per-socket isolation is removed, so one throwing subscriber silences the rest',
        file: 'runtime/index.js',
        edits: [
            {
                find: '        } catch (err) {\n            failed++;',
                to: '        } catch (err) {\n            throw err;\n            failed++;'
            }
        ],
        expectRed: ['a throwing socket is reported WITH its id and the device, and the others still get their frame']
    },
    {
        id: '31 layout guard: the outer guard is dropped (P0-2)',
        suite: 'project/layoutFallback.test.js',
        what: 'the permission filter reads layout.navigation.items without checking layout first',
        file: 'runtime/project/index.js',
        find: '        if (result.hmi.layout && result.hmi.layout.navigation.items) {',
        replace: '        if (result.hmi.layout.navigation.items) {',
        expectRed: ['the layout guards are still written as guards (the shape P0-2 was fixed into) ' +
            'the navigation guard reads result.hmi.layout before its navigation']
    },
    {
        id: '31b layout guard: optional chaining replaces the guard',
        suite: 'project/layoutFallback.test.js',
        what: 'the guard is "simplified" into result.hmi.layout.navigation?.items, which still throws when layout is absent',
        file: 'runtime/project/index.js',
        find: '        if (result.hmi.layout && result.hmi.layout.navigation.items) {',
        replace: '        if (result.hmi.layout.navigation?.items) {',
        expectRed: ['the layout guards are still written as guards (the shape P0-2 was fixed into) ' +
            'the navigation guard reads result.hmi.layout before its navigation']
    },
    {
        id: '32 controller diagnostics: a !TOFIX comes back',
        suite: 'architecture/controllerErrors.test.js',
        what: 'a controller logs a bare marker instead of naming the failure',
        file: '../client/src/app/view/view.component.ts',
        find: "            console.error('Error loadHMI');",
        replace: "            console.error('!TOFIX', err);",
        expectRed: ["no '!TOFIX' marker is left in client/src"]
    },
    {
        id: '33 socket event names: one side renames an event',
        suite: 'architecture/ioEventTypesSync.test.js',
        what: 'the server changes the wire name of an event the client still asks for',
        file: 'runtime/events.js',
        find: "    DEVICE_STATUS: 'device-status',",
        replace: "    DEVICE_STATUS: 'device-status-changed',",
        expectRed: ['every client member is declared by the server, with the same value']
    },
    {
        id: '34 socket event names: an event is heard through a raw string',
        suite: 'architecture/ioEventTypesSync.test.js',
        what: 'a client call site stops using the enumeration',
        file: '../client/src/app/view/view.component.ts',
        find: "            console.error('Error loadHMI');",
        replace: "            console.error('Error loadHMI');\n            // ARCH REVERSE: listen through a raw string instead of IoEventTypes\n            const s = (window as any).__noSocket; if (s) { s.on('device-status', () => {}); }",
        expectRed: ['no server event is heard through a raw string literal in the client']
    }
];

/** Every .js the guard cares about, so a rogue injection can be detected and undone. */
function walkServer() {
    const skip = new Set(['node_modules', 'dist', '_ui_verify', '_widgets', '_pkg', '.git']);
    const found = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const e of entries) {
            if (skip.has(e.name)) { continue; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); }
            else if (e.name.endsWith('.js')) { found.push(full); }
        }
    };
    walk(SERVER_ROOT);
    return found;
}

function snapshotTree() {
    const map = new Map();
    for (const f of walkServer()) {
        map.set(f, { sha: sha(f), content: fs.readFileSync(f) });
    }
    return map;
}

/**
 * Put the tree back exactly as it was, and report what had drifted.
 * Restoration is by CONTENT, not by the mutation record, so it also repairs damage the
 * injection was never supposed to cause.
 */
function healTree(pristine) {
    const drifted = [];
    const now = new Set(walkServer());
    for (const [f, rec] of pristine) {
        if (!fs.existsSync(f)) {
            fs.writeFileSync(f, rec.content);
            drifted.push('restored a deleted file: ' + path.relative(SERVER_ROOT, f));
            continue;
        }
        if (sha(f) !== rec.sha) {
            fs.writeFileSync(f, rec.content);
            drifted.push('restored a modified file: ' + path.relative(SERVER_ROOT, f));
        }
    }
    for (const f of now) {
        if (!pristine.has(f)) {
            fs.rmSync(f, { force: true });
            drifted.push('removed a created file: ' + path.relative(SERVER_ROOT, f));
        }
    }
    return drifted;
}

/** Run one suite and report its failing test titles. */
function runSuite(suite, timeoutMs) {
    // Suites live under test/architecture; a value with a slash is taken as a path under test/.
    const spec = suite.indexOf('/') === -1 ? path.join('test', 'architecture', suite) : path.join('test', suite);
    const res = spawnSync(process.execPath, [MOCHA, spec,
        '--timeout', String(timeoutMs), '--reporter', 'json'], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        timeout: timeoutMs + 60000
    });
    const stdout = res.stdout || '';
    const start = stdout.indexOf('{');
    if (start === -1) {
        return { ok: false, failures: [], error: 'mocha produced no JSON report. stderr: ' + (res.stderr || '').slice(-400) };
    }
    let report;
    try { report = JSON.parse(stdout.slice(start)); }
    catch (err) { return { ok: false, failures: [], error: 'mocha JSON report did not parse: ' + err.message }; }
    return {
        ok: true,
        status: res.status,
        failures: (report.failures || []).map((f) => f.fullTitle),
        passes: (report.stats || {}).passes || 0
    };
}

function apply(file, mutation) {
    const abs = path.join(SERVER_ROOT, file);
    const before = fs.readFileSync(abs, 'utf8');
    let after;
    if (mutation.append) {
        after = before + mutation.append;
    } else {
        // Line endings differ across this tree: everything under runtime/ is CRLF, while the
        // JSON artefacts written by the guards are LF. An anchor written with plain newlines
        // must still match a CRLF file, or the harness fails for a reason that is not the point.
        const usesCrLf = before.indexOf('\r\n') !== -1;
        const toFile = (s) => (usesCrLf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));

        // Some regressions need two coordinated edits (removing a guard AND the handler that
        // would have caught it); a case may carry an edits array instead of find/replace.
        const steps = mutation.edits || [{ find: mutation.find, to: mutation.replace }];
        after = before;
        for (const step of steps) {
            const anchor = toFile(step.find);
            if (!after.includes(anchor)) {
                throw new Error('mutation anchor not found in ' + file + ': ' +
                    JSON.stringify(step.find.slice(0, 60)) + ' ... the harness must be updated, not skipped');
            }
            after = after.replace(anchor, toFile(step.to));
        }
    }
    fs.writeFileSync(abs, after, 'utf8');
    return { abs: abs, before: before, backupSha: sha(abs) };
}

function restore(abs, content) {
    fs.writeFileSync(abs, content, 'utf8');
}

function main() {
    const results = [];
    let allGood = true;

    // Refuse to adopt a damaged tree as pristine. See reverse-baseline.js for the failure this
    // costs a debugging session to find: a killed run leaves a mutation behind, the next run
    // snapshots it, reports "baseline was not green" for that suite (which reads as "the guard
    // is broken"), and then faithfully RESTORES the damage.
    const drift = baseline.checkBaseline(SERVER_ROOT);
    if (drift.checked && drift.drifted.length) {
        console.log('');
        console.log('reverse verification - BASELINE CHECK FAILED');
        console.log('');
        console.log('  ' + baseline.describeBaseline(drift));
        console.log('  The harness cannot tell an interrupted run from an edit, so it will not guess.');
        drift.drifted.forEach((entry) => console.log('    ' + entry));
        if (drift.hazard.length) {
            console.log('');
            console.log('  These are files an INJECTION mutates, so a previous run most likely did not');
            console.log('  finish restoring them. Review the diff and put them back before trusting any');
            console.log('  result below.');
        }
        if (process.env.SCADIA_REVERSE_ALLOW_DRIFT !== '1') {
            console.log('');
            console.log('  Fix the tree, or re-run with SCADIA_REVERSE_ALLOW_DRIFT=1 to adopt this state.');
            process.exit(1);
        }
        console.log('');
        console.log('  SCADIA_REVERSE_ALLOW_DRIFT=1: continuing, and adopting the drifted state as pristine.');
    }

    const treePristine = snapshotTree();

    for (const c of CASES) {
        const abs = path.join(SERVER_ROOT, c.file);
        const pristine = fs.readFileSync(abs, 'utf8');
        const pristineSha = sha(abs);
        const record = { id: c.id, what: c.what, green: null, red: null, restored: null, detail: '' };

        try {
            // baseline: the class must be green before we break anything
            const baseline = runSuite(c.suite, 90000);
            record.green = baseline.ok && baseline.failures.length === 0;
            if (!record.green) {
                record.detail = 'baseline was not green: ' + JSON.stringify(baseline).slice(0, 300);
                allGood = false;
                results.push(record);
                continue;
            }

            apply(c.file, c);
            const mutated = runSuite(c.suite, 90000);
            // mocha reports fullTitle, which carries the suite prefix: match on the suffix
            const missing = c.expectRed.filter(
                (title) => !mutated.failures.some((f) => f.endsWith(title)));
            record.red = mutated.ok && mutated.failures.length > 0;
            if (!record.red || missing.length) {
                record.detail = missing.length
                    ? 'did NOT go red on: ' + missing.join(' | ') + '  (actual failures: ' + mutated.failures.join(' | ') + ')'
                    : 'did not go red at all: ' + JSON.stringify(mutated).slice(0, 300);
                allGood = false;
            }
        } catch (err) {
            record.detail = 'harness error: ' + err.message;
            allGood = false;
        } finally {
            restore(abs, pristine);
            record.restored = sha(abs) === pristineSha;
            if (!record.restored) {
                record.detail += '  RESTORE FAILED for ' + c.file;
                allGood = false;
            }
            const drifted = healTree(treePristine);
            if (drifted.length) {
                record.detail += '  TREE DRIFT HEALED: ' + drifted.join(' | ');
                record.treeDrift = drifted;
                allGood = false;
            }
        }

        // an independent re-run proves the restore by behaviour, not just by hash
        const after = runSuite(c.suite, 90000);
        record.greenAfterRestore = after.ok && after.failures.length === 0;
        if (!record.greenAfterRestore) {
            record.detail += '  still red after restore: ' + after.failures.join(' | ');
            allGood = false;
        }
        results.push(record);
    }

    console.log('');
    console.log('reverse verification - every deliberate violation must turn its class red');
    console.log('');
    for (const r of results) {
        const verdict = (r.green && r.red && r.restored && r.greenAfterRestore) ? 'OK  ' : 'FAIL';
        console.log('  ' + verdict + '  ' + r.id);
        console.log('        injection : ' + r.what);
        console.log('        tree      : ' + (r.treeDrift ? 'DRIFTED AND HEALED: ' + r.treeDrift.join(' | ') : 'untouched'));
        console.log('        red on    : ' + (r.red ? 'yes' : 'NO') +
            '   restored by hash: ' + (r.restored ? 'yes' : 'NO') +
            '   green after: ' + (r.greenAfterRestore ? 'yes' : 'NO'));
        if (r.detail) { console.log('        detail    : ' + r.detail); }
    }
    console.log('');
    const total = results.filter((r) => r.green && r.red && r.restored && r.greenAfterRestore).length;
    // Record what this run leaves behind, but only when it left a clean tree - a failed run must
    // NOT become the baseline, or the next run would adopt the damage it failed to restore.
    if (allGood) {
        const fileCount = baseline.endSession(SERVER_ROOT);
        console.log('baseline recorded for the next run (' + fileCount + ' files)');
        console.log('');
    } else {
        console.log('baseline NOT recorded: this run did not leave a clean tree.');
        console.log('');
    }
    console.log(allGood ? 'REVERSE VERIFICATION PASSED (' + total + '/' + results.length +
        ' injections turn their check red on demand)'
        : 'REVERSE VERIFICATION FAILED');
    process.exit(allGood ? 0 : 1);
}

// Mocha --recursive loads EVERY .js under test/ as a spec file, and this script both
// spawns nested mocha runs and calls process.exit. It must do nothing when required.
if (require.main === module) {
    main();
}

module.exports = { CASES, runSuite };