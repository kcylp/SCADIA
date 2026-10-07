/**
 * D2 support - the capability matrix: one machine-readable source, two renderings.
 *
 * The JSON is the truth. The Markdown is a pure function of it, so the human document can
 * never say something the machine document does not. Three disciplines are enforced here
 * rather than trusted to review:
 *
 *   - a cell that is not "unverified" must carry evidence;
 *   - the driver column is MEASURED from package.json and node_modules, never typed;
 *   - a "measured" cell for the default backend is re-derived from a live probe on every
 *     run, so it cannot drift away from reality.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const arch = require('./architecture');

/**
 * Identity comes from the registry, not from a second copy in the matrix.
 *
 * The matrix answers "what can this backend do, and how do we know" - that is the part that
 * needs evidence and review. WHAT the backend is (its label, its adapter file, whether it is
 * delivered) is a fact about the code, and the code already states it once. Keeping a copy
 * here meant adding a backend required editing two lists and keeping them in step by hand.
 */
const registry = require(path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'registry'));

const PROJECT_ROOT = path.resolve(arch.SERVER_ROOT, '..', '..');
const MATRIX_JSON = path.join(PROJECT_ROOT, '19_能力矩阵_存储后端.json');
const MATRIX_MD = path.join(PROJECT_ROOT, '19_能力矩阵_存储后端.md');

/** The default backend whose verdicts are re-proven by a live probe. */
const PROBED_BACKEND = 'sqlite';

const VERDICTS = ['yes', 'no', 'partial', 'unverified'];

/** Backtick, built rather than written: a literal one would end the template above. */
const BT = String.fromCharCode(96);
const code = (s) => BT + s + BT;

function load() {
    return JSON.parse(fs.readFileSync(MATRIX_JSON, 'utf8'));
}

/**
 * The registry stores an adapter as a require specifier ('./sqlite'), because that is what the
 * loader needs. A document wants the file, so turn one into the other in one place.
 */
function adapterPathOf(known) {
    if (!known || !known.adapter) { return null; }
    const spec = known.adapter;
    if (spec.endsWith('.js')) { return 'runtime/storage/' + spec.replace('./', ''); }
    return 'runtime/storage/' + spec.replace('./', '') + '/index.js';
}

/** Every backend x axis cell, with the unstated ones filled in as unverified. */
function materialize(matrix) {
    const m = matrix || load();
    return m.backends.map((b) => {
        const cells = {};
        for (const axis of m.axes) {
            const stated = b.verdicts ? b.verdicts[axis.id] : undefined;
            cells[axis.id] = stated
                ? { verdict: stated.verdict, evidence: stated.evidence || null }
                : { verdict: 'unverified', evidence: null };
        }
        const known = registry.identity().filter((k) => k.id === b.id)[0] || null;
        return {
            id: b.id,
            label: known ? known.label : b.id,
            status: known ? known.status : 'unknown',
            role: b.role,
            provenance: b.provenance,
            adapterFile: adapterPathOf(known),
            driver: b.driver || null,
            cells: cells
        };
    });
}

/** What is actually installed, measured rather than declared. */
function driverFacts() {
    const pkg = JSON.parse(fs.readFileSync(path.join(arch.SERVER_ROOT, 'package.json'), 'utf8'));
    const declared = Object.assign({}, pkg.dependencies, pkg.optionalDependencies, pkg.devDependencies);
    return {
        declared: (name) => (Object.prototype.hasOwnProperty.call(declared, name) ? declared[name] : null),
        installed: (name) => fs.existsSync(path.join(arch.SERVER_ROOT, 'node_modules', name))
    };
}

/** Backend directories that actually exist on disk under runtime/storage. */
function adapterDirectories() {
    const root = path.join(arch.SERVER_ROOT, 'runtime', 'storage');
    return fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
}

/** The one rendering of the matrix that a human reads. Deterministic by construction. */
function renderMarkdown(matrix) {
    const m = matrix || load();
    const rows = materialize(m);
    const facts = driverFacts();
    const lines = [];

    lines.push('# 19 · 存储后端能力矩阵（人读）');
    lines.push('');
    lines.push('> **本文件由 ' + code('19_能力矩阵_存储后端.json') + ' 生成，禁止手改。**');
    lines.push('> 机器读的是 JSON，人读的是本文件，两者永远一致。');
    lines.push('> 交付物：' + m.deliverable + '（存储平面）');
    lines.push('');
    lines.push('## 怎么读');
    lines.push('');
    lines.push('| 词 | 含义 |');
    lines.push('|---|---|');
    for (const k of Object.keys(m.vocabulary.capability)) {
        lines.push('| ' + code(k) + ' | ' + m.vocabulary.capability[k] + ' |');
    }
    lines.push('');
    lines.push('**' + code('no') + ' 不是缺陷，是对契约的约束：契约不得要求一个后端做不到的事。**');
    lines.push('');
    lines.push('未证实的格子（' + code('unverified') + '）由 **' + m.unverifiedClosesAt + '** 拿真实文档走接口后填入。');
    lines.push('在此之前，任何人不得到处替它下结论。');
    lines.push('');

    lines.push('## 能力轴（' + m.axes.length + ' 条）');
    lines.push('');
    lines.push('| 轴 | 问题 | 为什么要问 | 出处 |');
    lines.push('|---|---|---|---|');
    for (const a of m.axes) {
        lines.push('| ' + code(a.id) + ' | ' + a.question + ' | ' + a.why + ' | ' + a.origin + ' |');
    }
    lines.push('');

    lines.push('## 矩阵');
    lines.push('');
    lines.push('| 轴 \\ 后端 | ' + rows.map((r) => r.label).join(' | ') + ' |');
    lines.push('|---|' + rows.map(() => '---').join('|') + '|');
    for (const a of m.axes) {
        const cells = rows.map((r) => {
            const c = r.cells[a.id];
            return c.verdict === 'unverified' ? 'unverified' : '**' + c.verdict + '**';
        });
        lines.push('| ' + code(a.id) + ' | ' + cells.join(' | ') + ' |');
    }
    lines.push('');

    lines.push('## 后端');
    lines.push('');
    lines.push('| 后端 | 状态 | 角色 | 适配器（现状） | 驱动包 | 出处 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of rows) {
        let driver = '—';
        if (r.driver) {
            const version = facts.declared(r.driver);
            driver = code(r.driver) + ' ' + (version ? version : '(未声明)') +
                (facts.installed(r.driver) ? ' · 已安装' : ' · **未安装**');
        }
        lines.push('| ' + r.label + ' | ' + r.status + ' | ' + r.role + ' | ' +
            (r.adapterFile ? code(r.adapterFile) : '尚未编写（预留位置）') + ' | ' + driver + ' | ' + r.provenance + ' |');
    }
    lines.push('');

    lines.push('## 证据（每一格不是 unverified 的判断）');
    lines.push('');
    const evidenced = [];
    for (const r of rows) {
        for (const a of m.axes) {
            const c = r.cells[a.id];
            if (c.verdict !== 'unverified' && c.evidence) {
                evidenced.push('| ' + code(r.id) + ' | ' + code(a.id) + ' | ' + code(c.verdict) + ' | ' + c.evidence + ' |');
            }
        }
    }
    if (evidenced.length) {
        lines.push('| 后端 | 轴 | 判断 | 证据 |');
        lines.push('|---|---|---|---|');
        lines.push.apply(lines, evidenced);
    } else {
        lines.push('（暂无）');
    }
    lines.push('');

    lines.push('## 已决（本窗口依授权裁决，可回退）');
    lines.push('');
    lines.push('| 编号 | 事项 | 裁决 | 依据 | 可回退 |');
    lines.push('|---|---|---|---|---|');
    for (const d of m.decisions) {
        lines.push('| ' + d.id + ' | ' + d.what + ' | ' + d.decision + ' | ' + d.why + ' | ' + d.reversible + ' |');
    }
    lines.push('');

    lines.push('## 待办与登记项（未决）');
    lines.push('');
    lines.push('| 编号 | 事项 | 归口 | 谁拍板 |');
    lines.push('|---|---|---|---|');
    for (const o of m.openItems) {
        lines.push('| ' + o.id + ' | ' + o.what + ' | ' + o.closesAt + ' | ' + o.decidedBy + ' |');
    }
    lines.push('');

    lines.push('## 重新生成');
    lines.push('');
    lines.push('    ARCH_MATRIX_UPDATE=1 npx mocha test/architecture/capabilityMatrix.test.js');
    lines.push('');
    lines.push('会先写盘再故意失败，逼迫改动被看一遍才提交。');
    lines.push('');

    return lines.join('\n');
}

function writeMarkdown(matrix) {
    fs.writeFileSync(MATRIX_MD, renderMarkdown(matrix), 'utf8');
    return MATRIX_MD;
}

module.exports = {
    PROJECT_ROOT,
    MATRIX_JSON,
    MATRIX_MD,
    PROBED_BACKEND,
    VERDICTS,
    load,
    materialize,
    driverFacts,
    adapterDirectories,
    renderMarkdown,
    writeMarkdown
};
