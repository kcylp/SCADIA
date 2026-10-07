/**
 * An enum that exists on both sides of the wire is a CONTRACT, and almost nothing was checking it.
 *
 * The audit that produced this guard counted sixteen same-named enum pairs across the client and
 * the server. Three had a guard (IoEventTypes, SHELL_ROUTES, DaqStore). The rest were maintained
 * by memory, and two had already drifted:
 *
 *   PluginGroupType   the client read 'Chart'/'Service'; the server sends 'chart-report'/'service'
 *                     (plugins/index.js:19-24). Every group case in plugins-list.component.ts was
 *                     therefore dead code, and no plugin ever got its chart or service icon.
 *                     Nobody noticed, because "the icon is generic" is not a symptom anyone reports.
 *   AlarmsTypes       the server grew a fifth member, ACTION, that the client never received.
 *
 * A wire vocabulary that disagrees with itself does not fail loudly. It fails as a feature that
 * silently does nothing.
 *
 * WHICH PAIRS BELONG HERE - the distinction this file exists to make.
 *
 * Same NAME is not the same as same CONTRACT. Reading the sixteen pairs one by one, they fall into
 * three genuinely different situations, and only the first belongs in a sync guard:
 *
 *   1. THE NAME MIRRORS THE OTHER SIDE. Both sides describe the same set of things, the values
 *      travel on the wire, and a member added on one side is a bug on the other. These are below.
 *
 *   2. THE CLIENT VALUES ARE i18n KEYS. AlarmStatusType(client) vs AlarmStatusEnum(server),
 *      AlarmAckMode, ReportDateRangeType, ReportIntervalType, ReportFunctionType,
 *      ReportSchedulingType. The client member names and the server member names describe the same
 *      concept but are NOT required to match - and forcing them to would send translation keys
 *      over the socket, or rename a working client enum for no behaviour change. They are paired
 *      by SEMANTICS in the UI code, not by spelling. Listed in NOT_A_MIRROR below so that nobody
 *      "fixes" them by generating one from the other.
 *
 *   3. THE NAMES ARE LITERALLY UNRELATED. ActionsTypes(server) uses POPUP/SET_VIEW; the client's
 *      AlarmActionsType uses popup/setView whose VALUES are i18n keys. The wire value here is the
 *      client's enum KEY, converted by Utils.getEnumKey (home.component.ts:647) before it is sent,
 *      and the server compares it against ActionsTypes. That translation is real and load-bearing,
 *      so it needs its own test rather than a mirror check - see the note in NOT_A_MIRROR.
 *
 * Reverse verification (test/architecture/_support/reverse-verify.js) changes a server-side value
 * and demands this file goes red on that exact check.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const CLIENT_SRC = path.join(SERVER_ROOT, '..', 'client', 'src');

/**
 * Read the member map out of a declaration, given the text that introduces it.
 *
 * Deliberately line-based: several of these declarations are hand-formatted, and a
 * brace-to-brace regex has already been fooled once in this tree by a nested object literal.
 * A member line is an identifier, a separator, a scalar literal, and optionally a trailing comma
 * and comment - anything else (a nested object, a spread, a computed key) simply does not match,
 * which is the safe direction: the caller asserts a minimum count.
 */
function readMembers(file, where, head) {
    const source = fs.readFileSync(where === 'server' ? path.join(SERVER_ROOT, file) : path.join(CLIENT_SRC, file), 'utf8');
    const start = source.indexOf(head);
    if (start < 0) { return null; }
    const open = source.indexOf('{', start);
    if (open < 0) { return null; }
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') { depth++; }
        else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) { return null; }
    const body = source.slice(open + 1, end);
    const members = {};
    body.split(/\r?\n/).forEach((line) => {
        const m = /^\s*(?:export\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*(?:'([^']*)'|"([^"]*)"|(-?\d+))\s*,?\s*(?:\/\/.*)?$/.exec(line);
        if (!m) { return; }
        members[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    });
    return { file: file, members: members, count: Object.keys(members).length };
}

const serverSide = (file, head) => readMembers(file, 'server', head);
const clientSide = (file, head) => readMembers(file, 'client', head);

/**
 * The pairs whose member names ARE the contract.
 *
 * `min` is the number of members expected. It is not decoration: it turns "the parser silently
 * matched nothing" from a green test into a red one, which is the failure mode that makes a guard
 * worse than no guard.
 */
const MIRRORED = [
    {
        id: 'ProjectDataCmdType',
        server: serverSide('runtime/project/index.js', 'const ProjectDataCmdType = {'),
        client: clientSide('app/_models/project.ts', 'export enum ProjectDataCmdType {'),
        min: 25,
        why: 'the editor sends these; a miss is a silent save failure (the project data simply does not change)'
    },
    {
        id: 'ModbusOptionType',
        server: serverSide('runtime/devices/modbus/index.js', 'ModbusOptionType = {'),
        client: clientSide('app/_models/device.ts', 'export enum ModbusOptionType {'),
        min: 7,
        why: 'Modbus register option'
    },
    {
        id: 'ModbusReuseModeType',
        server: serverSide('runtime/devices/modbus/index.js', 'ModbusReuseModeType = {'),
        client: clientSide('app/_models/device.ts', 'export enum ModbusReuseModeType {'),
        min: 2,
        why: 'Modbus connection reuse mode'
    },
    {
        id: 'ScriptSchedulingMode',
        server: serverSide('runtime/scripts/index.js', 'ScriptSchedulingMode = {'),
        client: clientSide('app/_models/script.ts', 'export enum ScriptSchedulingMode {'),
        min: 3,
        why: 'how a scheduled script repeats'
    },
    {
        id: 'SchedulerType',
        server: serverSide('runtime/scripts/index.js', 'SchedulerType = {'),
        client: clientSide('app/_models/script.ts', 'export enum SchedulerType {'),
        min: 2,
        why: 'weekly schedule vs a single date'
    },
    {
        id: 'PluginGroupType',
        // 'values' deliberately: the two sides NAME these differently (server connectionDevice,
        // client ConnectionDevice) and that is fine - the member name never leaves its own file.
        // The VALUES are what travelled, and they disagreed. See NOT_A_MIRROR for the pairs where
        // even the values are allowed to differ.
        check: 'values',
        server: serverSide('runtime/plugins/index.js', 'const PluginGroupType = {'),
        client: clientSide('app/_models/plugin.ts', 'export enum PluginGroupType {'),
        min: 4,
        why: 'DRIFTED and fixed on 2026-10-02: the client read Chart/Service while the server sends chart-report/service, so every group branch in plugins-list.component.ts was dead code'
    }
];

/**
 * Same-named pairs that are NOT mirrors, with the reason. Recorded so that a later pass does not
 * "unify" them and break the product - each entry names what WOULD break.
 */
const NOT_A_MIRROR = [
    {
        serverName: 'AlarmStatusEnum (runtime/alarms/index.js:716)',
        clientName: 'AlarmStatusType (app/_models/alarm.ts:166)',
        why: 'client values are i18n keys and its member names (N/NF/NA) are its own; the server names (VOID/ON/OFF/ACK) are its own. They are paired by SEMANTICS in the alarm templates. Forcing the names together renames a working client enum for no behaviour change.'
    },
    {
        serverName: 'AlarmAckModeEnum (runtime/alarms/index.js:723)',
        clientName: 'AlarmAckMode (app/_models/alarm.ts:84)',
        why: 'the member names DO agree and the values do not, which is correct: the client value is the label key. Note: alarm-property.component.ts:84 OVERWRITES this enum at runtime with translated text - fixing that is a separate, recorded task.'
    },
    {
        serverName: 'ActionsTypes (runtime/alarms/index.js:737)',
        clientName: 'AlarmActionsType (app/_models/alarm.ts:146)',
        why: 'literally unrelated spellings. The wire sends the client KEY (Utils.getEnumKey at home.component.ts:647), so the mapping client-key -> server-member is real logic and needs its own test, not a mirror check. sendMsg is commented out on the client and SEND_MSG is unused on the server.'
    },
    {
        serverName: 'ReportDateRangeType / ReportSchedulingType (runtime/jobs/report.js)',
        clientName: 'ReportDateRangeType / ReportSchedulingType (app/_models/report.ts)',
        why: 'member names agree, values are i18n keys on the client. A mirror check on values would send translation keys to the server.'
    },
    {
        serverName: 'ReportIntervalType / ReportFunctionType (runtime/storage/calculator.js)',
        clientName: 'ReportIntervalType / ReportFunctionType (app/_models/report.ts)',
        why: 'same as the report pair above: the client sends the member NAME and displays an i18n key, so the two value sets are different on purpose and must stay different.'
    },
    {
        serverName: 'AlarmsTypes (runtime/alarms/index.js:729)',
        clientName: 'AlarmsType (app/_models/alarm.ts:14)',
        why: 'a real divergence, pinned below: the server has a fifth member ACTION that the client cannot display.'
    }
];

/**
 * Real divergences this pass did NOT close, each with the reason it is still open.
 * The test asserts the exact set, so closing one - or adding one - is a deliberate edit.
 */
const PINNED_DIVERGENCE = [
    {
        id: 'AlarmsTypes',
        server: serverSide('runtime/alarms/index.js', 'AlarmsTypes = {'),
        client: clientSide('app/_models/alarm.ts', 'export enum AlarmsType {'),
        serverOnly: ['ACTION'],
        why: 'needs a decision, not a rename: either the client learns to display action rows or the server stops advertising the type. The server USES it (alarms/index.js:82,166,468,545,646), so deleting it is the wrong answer.',
        owner: 'alarm state machine pass'
    }
];

describe('cross-layer enum contracts (a wire vocabulary that disagrees with itself fails silently)', () => {
    it('every mirrored pair was parsed on both sides, and none came out suspiciously empty', function () {
        const problems = [];
        MIRRORED.forEach((pair) => {
            if (!pair.server || pair.server.count < pair.min) {
                problems.push('server ' + pair.id + ' (parsed ' + (pair.server ? pair.server.count : 'nothing') + ', expected >= ' + pair.min + ')');
            }
            if (pair.check === 'values' && Object.keys(pair.server ? pair.server.members : {}).length === 0) {
                problems.push('server ' + pair.id + ' parsed no values at all');
            }
            if (!pair.client || pair.client.count < pair.min) {
                problems.push('client ' + pair.id + ' (parsed ' + (pair.client ? pair.client.count : 'nothing') + ', expected >= ' + pair.min + ')');
            }
        });
        expect(problems, 'these enums could not be read - the guard is not actually checking them: ' +
            problems.join('; ')).to.deep.equal([]);
    });

    MIRRORED.forEach((pair) => {
        describe(pair.id + ' - ' + pair.why, () => {
            if (pair.check !== 'values') {
                it('the two sides name the same members', function () {
                    const serverOnly = Object.keys(pair.server.members).filter((n) => !(n in pair.client.members));
                    const clientOnly = Object.keys(pair.client.members).filter((n) => !(n in pair.server.members));
                    expect(serverOnly, 'the server names members the client does not have: ' + serverOnly.join(', ') +
                        '  (' + pair.server.file + ')').to.deep.equal([]);
                    expect(clientOnly, 'the client names members the server does not have: ' + clientOnly.join(', ') +
                        '  (' + pair.client.file + ')').to.deep.equal([]);
                });

                it('the same member name carries the same value on both sides', function () {
                    const wrong = [];
                    Object.keys(pair.client.members).forEach((name) => {
                        if (!(name in pair.server.members)) { return; }
                        if (String(pair.server.members[name]) !== String(pair.client.members[name])) {
                            wrong.push(name + ': server ' + JSON.stringify(pair.server.members[name]) +
                                ' vs client ' + JSON.stringify(pair.client.members[name]));
                        }
                    });
                    expect(wrong, 'the same member name means two different things on the wire - this is exactly ' +
                        'how the plugin group icons went dead: ' + wrong.join(' | ')).to.deep.equal([]);
                });
            } else {
                // The member names are each side's own business; the VALUES are the wire vocabulary.
                it('the two sides speak the SAME set of values', function () {
                    const sValues = Object.values(pair.server.members).map(String).sort();
                    const cValues = Object.values(pair.client.members).map(String).sort();
                    expect(sValues, 'server values ' + JSON.stringify(sValues) + ' vs client values ' +
                        JSON.stringify(cValues) + ' (' + pair.server.file + ' vs ' + pair.client.file + ')')
                        .to.deep.equal(cValues);
                });

                it('no value is understood by one side only', function () {
                    const sValues = new Set(Object.values(pair.server.members).map(String));
                    const cValues = new Set(Object.values(pair.client.members).map(String));
                    const serverOnly = [...sValues].filter((v) => !cValues.has(v));
                    const clientOnly = [...cValues].filter((v) => !sValues.has(v));
                    expect(serverOnly.concat(clientOnly), 'a value that only one side can produce or read').to.deep.equal([]);
                });
            }
        });
    });

    describe('recorded divergences stay recorded', () => {
        PINNED_DIVERGENCE.forEach((pin) => {
            it(pin.id + ': the divergence is still exactly what was recorded', function () {
                const serverOnly = Object.keys(pin.server.members).filter((n) => !(n in pin.client.members)).sort();
                expect(serverOnly, 'this divergence changed shape. Review it and update the pin - ' + pin.why)
                    .to.deep.equal(pin.serverOnly.slice().sort());
            });
        });
    });

    describe('the pairs that are deliberately NOT mirrors', () => {
        it('each one states what would break if it were unified', function () {
            NOT_A_MIRROR.forEach((entry) => {
                expect(entry.why.length, entry.serverName + ' needs a reason, not just a listing').to.be.greaterThan(60);
            });
        });

        it('the client values of the i18n-key pairs really are i18n keys', function () {
            // The canary: if someone moves one of these into MIRRORED, this stops being true and the
            // guard tells them why instead of failing with a diff nobody can read.
            const alarmStatus = clientSide('app/_models/alarm.ts', 'export enum AlarmStatusType {');
            Object.keys(alarmStatus.members).forEach((name) => {
                expect(String(alarmStatus.members[name]).startsWith('alarm.'),
                    'AlarmStatusType.' + name + ' is no longer an i18n key - if the client switched to wire ' +
                    'codes, move this pair into MIRRORED instead of leaving it out of both lists').to.equal(true);
            });
        });
    });
});
