/**
 * Architecture guard - the pinned debt register.
 *
 * A guard that is red on the day it lands is not a gate. A guard that silently
 * ignores what it found is a lie. So every architecture rule that does NOT hold
 * yet is written down here, with its evidence and the deliverable that closes it,
 * and the tests assert the pin itself:
 *
 *   - a NEW violation fails immediately (the pin is an exact set, not a count);
 *   - RETIRING a pin also fails (fixing the debt forces the pin to be deleted,
 *     so the pin can never quietly outlive the defect).
 *
 * Nothing may be added here without a file:line or a command that shows it.
 *
 * D5 closed four pins (A-03, A-05, A-06, A-08) and corrected one report (A-02).
 * Closed pins are kept as a record below, but they are no longer exported and no
 * longer assert anything - the rules they guarded are now unconditional.
 */

'use strict';

/* ------------------------------------------------------------------ closed ---

 * A-01  runtime/storage/calculator.js exported `getSum: this.getSum`, which is
 *       undefined at module scope. FIXED in the D1 pass; the value is asserted by
 *       interfaceSnapshot, and injection 7 puts the defect back to prove it turns red.
 *
 * A-02  REPORTED TOO STRONGLY, THEN CORRECTED. The original claim was "choosing
 *       InfluxDB 1.8 in the UI silently stores to SQLite". That is WRONG, and the
 *       way it was wrong matters:
 *         - client/src/app/_models/settings.ts does declare
 *               influxDB18 = 'influxDB 1.8'
 *           but that is the enum VALUE, the dropdown LABEL.
 *         - the template binds `[value]="type.key"` and EnumToArrayPipe maps key to
 *           Object.keys(enum), i.e. the member NAME. What the UI actually sends is
 *           `influxDB18`, which the server always understood.
 *       Measured, not assumed: routing-probe.js shows the string 'influxDB 1.8' does
 *       fall through to SQLite, but nothing on the live path sends that string.
 *       What survives is a real but LATENT trap: the field is typed as the enum VALUE
 *       while the UI stores a member NAME - identical for four of the five members,
 *       different for influxDB18 alone. D5 answered it by giving the server ONE
 *       normalising entry point (runtime/storage/registry.js) that accepts both
 *       spellings, logs the rewrite, and refuses anything it does not know.
 *
 * A-03  An unknown settings.daqstore.type degraded to SQLite with no diagnostic.
 *       CLOSED at D5: registry.normalise() refuses it and names the known values.
 *       errorSemantics.test.js now asserts the refusal.
 *
 * A-05  Backend create() signatures disagreed (4 args vs 3, first parameter named
 *       `data` while called with settings). CLOSED at D5: every adapter is
 *       create(settings, logger, currentStorage, options); the node id travels in
 *       options because only a per-device backend has one.
 *
 * A-06  Dead branch and dead module. CLOSED at D5:
 *         - the `=== 'QuestDB'` comparison is gone with _getDbType(); the spelling
 *           survives only as a documented alias in the registry;
 *         - runtime/notificator/notifystorage.js was required by nothing live and was
 *           deleted, which also removed one of the nine direct sqlite3 connections.
 *
 * A-08  The legacy read path rejected with `['ERR', ...]`: cause dropped, nothing
 *       logged, sentinel understood by nobody. CLOSED at D5: the real error is logged
 *       and propagated; report.js still renders its ERROR cells from the .catch().
 *
 * -------------------------------------------------------------------------- */

/**
 * A-04  Direct sqlite3 connections outside the storage plane.
 *       Handoff section 3 (D7) names SIX domains: project / alarms / users / cameras /
 *       calibration / recipe+scheduler, which is SEVEN files. The measured set was
 *       EIGHT live files: runtime/apikeys/apiKeysStorage.js is live (required by
 *       runtime/apikeys/index.js) and D7 did not name it.
 *       (A ninth, runtime/notificator/notifystorage.js, was dead and has been deleted.)
 *
 *       CLOSED at D7: all eight now ask runtime/storage/databases.js for a connection and
 *       keep their SQL verbatim, so the list is empty. The interesting part of A-04 was
 *       never the count - it was that a plan written from memory undercounted the work by
 *       one live module, and only a measurement found it.
 */
const LEGACY_SQLITE3_REQUIRERS = [];
const LEGACY_SQLITE3_CLOSES_AT = 'D7';

/** Where D7 as written in the handoff stops, for the report. */
const D7_NAMED_FILES = [
    'runtime/alarms/alarmstorage.js',
    'runtime/calibration/calibration-storage.js',
    'runtime/cameras/camera-storage.js',
    'runtime/project/prjstorage.js',
    'runtime/recipes/recipe-storage.js',
    'runtime/scheduler/scheduler-storage.js',
    'runtime/users/usrstorage.js'
];

/**
 * A-07  CLOSED at D9.
 *
 *       An adapter used to refuse an unusable configuration by crashing on a property read,
 *       and because tdengine/index.js called this.init().then(...) with no rejection handler,
 *       it escaped as an UNHANDLED REJECTION - uncatchable by the caller, and process-fatal
 *       under Node's default policy.
 *
 *       D9 rewrote the adapter: construction never throws, init() logs and degrades, reads
 *       while disconnected settle with no data, and a write while disconnected says so once.
 *       errorSemantics.test.js now asserts that behaviour, measured in a child process by
 *       backend-config-probe.js, and reverse verification puts the missing catch back.
 */

/**
 * Socket.IO event names declared by the client's IoEventTypes but NOT by the server's.
 *
 * CLOSED in this pass, and kept as the empty baseline the guard asserts against.
 *
 * The two exceptions were real: SCRIPT_COMMAND (emitted by runtime/index.js:746 from the
 * constant, so the name never appeared in runtime/events.js) and RECIPE_CANCEL (a client TO
 * server name, handled as socket.on('recipe:cancel-execution') at runtime/index.js:434).
 * Both are now declared in runtime/events.js and referenced through the constant there, so
 * every socket name this product speaks exists in exactly two places - the two enumerations -
 * and the guard can check ALL of them instead of all-but-two.
 *
 * Keeping the constant as an empty array is deliberate: a third client-only member has to make
 * the guard fail and be answered here, rather than quietly joining an exemption list.
 */
const CLIENT_ONLY_IO_EVENT_MEMBERS = [];

/**
 * Client controller diagnostics - the static ones, frozen as an exact SET.
 *
 * Rule (test/architecture/controllerErrors.test.js): a console.error call must carry
 * something that identifies WHAT failed. `console.error('Error loadHMI')` does not - it is
 * the same string in six files, and it is the reason "the page is blank" reports were
 * unfalsifiable. The fix is a second argument (the error, the view id, the element), which
 * is what most of the tree already does: 76 console.error calls, 9 of them static.
 *
 * These nine are PRE-EXISTING and are recorded rather than rewritten here, because touching
 * six components to improve a log message is not what closed this stage. A NEW static
 * message fails the guard immediately; fixing one of these also fails it, so the entry has
 * to be retired deliberately - which is how a baseline stops being a place findings go to die.
 *
 * paths are relative to client/src, 1-based line numbers.
 */
const CLIENT_STATIC_CONSOLE_ERRORS = [
    'app/app.component.ts:101',
    'app/app.component.ts:118',
    'app/editor/editor.component.ts:202',
    'app/editor/editor.component.ts:764',
    'app/gauges/controls/html-iframe/html-iframe.component.ts:72',
    'app/header/header.component.ts:84',
    'app/lab/lab.component.ts:50',
    'app/view/view.component.ts:47',
// 2026-10-02: three entries moved by +2/+3 lines because batch 4 added imports above them.
// The guard reported it instead of re-baselining silently, which is the point of pinning - but it
// also shows the cost: an unrelated import anywhere above invalidates the pin. See the note in
// controllerErrors.test.js about pinning by message instead of by line.
];

/**
 * Orphan modules: never reached by any live require() from runtime, api, test or main.js.
 * Only one is deliberate today, so this is an exact allowlist with a stated reason - a
 * new orphan fails the guard, and an entry whose file has been wired up (or deleted)
 * fails it too.
 */
const ALLOWED_ORPHANS = {
    'runtime/devices/template/index.js': 'shipped driver template; intentionally not wired into the loader'
};

/**
 * Cross-domain require edges inside runtime/, frozen as an exact SET.
 * '(root)' is a module directly under runtime/ (utils.js, events.js, index.js).
 * New coupling between two domains fails; removing coupling also fails, so the
 * baseline gets edited deliberately.
 */
const CROSS_DOMAIN_BASELINE = [
    '(root) -> alarms',
    '(root) -> apikeys',
    '(root) -> calibration',
    '(root) -> cameras',
    '(root) -> devices',
    '(root) -> jobs',
    '(root) -> notificator',
    '(root) -> opcua-server',
    '(root) -> plugins',
    '(root) -> project',
    '(root) -> recipes',
    '(root) -> scheduler',
    '(root) -> scripts',
    '(root) -> storage',
    '(root) -> users',
    'alarms -> (root)',
    'alarms -> storage',
    'apikeys -> storage',
    'calibration -> storage',
    'cameras -> devices',
    'cameras -> storage',
    'devices -> (root)',
    'jobs -> (root)',
    'jobs -> reporting',
    // P0：通知域向存储平面要一个域库句柄（notifications-storage.js 里的
    // require('../storage/databases')），与 alarms/apikeys/scheduler 等域同一条规矩。
    'notificator -> storage',
    'plugins -> (root)',
    'plugins -> devices',
    'project -> (root)',
    'project -> devices',
    'project -> storage',
    'recipes -> (root)',
    'recipes -> storage',
    'scheduler -> (root)',
    'scheduler -> storage',
    'scripts -> (root)',
    'storage -> (root)',
    'users -> storage'
];

/** The runtime assembler is allowed to reach into every domain. */
const RUNTIME_ASSEMBLER = 'runtime/index.js';

module.exports = {
    CLIENT_ONLY_IO_EVENT_MEMBERS,
    CLIENT_STATIC_CONSOLE_ERRORS,
    LEGACY_SQLITE3_REQUIRERS,
    LEGACY_SQLITE3_CLOSES_AT,
    D7_NAMED_FILES,
    ALLOWED_ORPHANS,
    CROSS_DOMAIN_BASELINE,
    RUNTIME_ASSEMBLER
};
