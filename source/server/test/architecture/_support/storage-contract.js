/**
 * D4 support - the frozen storage domain contract: one machine-readable source and a
 * renderer, exactly like the capability matrix.
 *
 * Two derivations live here because both the human document and the guard need them, and
 * two implementations of the same rule is how a document starts lying:
 *
 *   impliedExclusions() - a delivery backend that is proven unable to do something a
 *                         domain REQUIRES must be named in that domain notOn, with a
 *                         reason. The guard checks the equation; the document shows it.
 *   freezeBlockers()    - the (backend, capability) pairs a domain requires that are still
 *                         unverified. While any of these is unproven, the freeze is on
 *                         paper only, and the list must not grow silently.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const arch = require('./architecture');
const matrix = require('./capability-matrix');

const PROJECT_ROOT = matrix.PROJECT_ROOT;
const CONTRACT_MD = path.join(PROJECT_ROOT, '22_契约06_存储平面五域契约.md');
const CONTRACT_JS = path.join(arch.SERVER_ROOT, 'runtime', 'storage', 'contract.js');

const BT = String.fromCharCode(96);
const code = (s) => BT + s + BT;

function load() {
    return require(CONTRACT_JS);
}

/** verdict of one backend on one capability axis, or null when either is unknown. */
function verdictOf(rows, backendId, capabilityId) {
    const row = rows.filter((r) => r.id === backendId)[0];
    if (!row) { return null; }
    const cell = row.cells[capabilityId];
    return cell ? cell.verdict : null;
}

/**
 * Backends that a domain requires something from, and that are proven unable to give it.
 * Returns { backendId: [capabilityId, ...] }.
 */
function impliedExclusions(domain, rows) {
    const out = {};
    for (const backend of load().DELIVERY_BACKENDS) {
        const lacking = domain.requires.filter((cap) => verdictOf(rows, backend, cap) === 'no');
        if (lacking.length) { out[backend] = lacking; }
    }
    return out;
}

/**
 * The (backend, capability) pairs that any domain requires and that are still unverified,
 * deduplicated across domains. This is the honest size of "what the freeze still rests on".
 */
function freezeBlockers(contract, rows) {
    const seen = new Set();
    for (const domain of contract.DOMAINS) {
        for (const backend of contract.DELIVERY_BACKENDS) {
            for (const cap of domain.requires) {
                if (verdictOf(rows, backend, cap) === 'unverified') { seen.add(backend + '/' + cap); }
            }
        }
    }
    return [...seen].sort();
}

function renderMarkdown() {
    const contract = load();
    const rows = matrix.materialize(matrix.load());
    const lines = [];

    lines.push('# 22 · 契约 06 —— 存储平面五域契约（D4 冻结）');
    lines.push('');
    lines.push('> **机器读的是 ' + code('runtime/storage/contract.js') + '，本文件由它生成，禁止手改。**');
    lines.push('> 守卫：' + code('test/architecture/domainContracts.test.js') + '。');
    lines.push('> 能力名一律取自 ' + code('19_能力矩阵_存储后端.json') + ' 的十条能力轴，本契约不另立一套词汇。');
    lines.push('');
    lines.push('## 为什么是这五个');
    lines.push('');
    lines.push('四个**域**（配置 / 事件 / 时序 / 对象）加一条**边界**（实时不抽象）。');
    lines.push('域是「谁的数据、按什么键、要什么保证」；边界说的是**什么不进这套接口**——');
    lines.push('把不该抽象的东西也抽象掉，是接口腐化的开始。');
    lines.push('');
    lines.push('## 交付后端（裁决 12）');
    lines.push('');
    lines.push('| 后端 | ' + rows.filter((r) => contract.DELIVERY_BACKENDS.includes(r.id)).map((r) => r.label).join(' | ') + ' |');
    lines.push('|---|' + contract.DELIVERY_BACKENDS.map(() => '---').join('|') + '|');
    lines.push('| 是否交付 | ' + contract.DELIVERY_BACKENDS.map(() => '是').join(' | ') + ' |');
    lines.push('');
    lines.push('InfluxDB 与 QuestDB 不在交付列表内（已决 D-2）；两者代码保留、不删、不承诺。');
    lines.push('');

    const numeral = ['一', '二', '三', '四'];
    contract.DOMAINS.forEach((d, i) => {
        const implied = impliedExclusions(d, rows);
        lines.push('## ' + numeral[i] + '、' + d.label + ' ' + code(d.id));
        lines.push('');
        lines.push('| 项 | 内容 |');
        lines.push('|---|---|');
        lines.push('| 责任 | ' + d.responsibility + ' |');
        lines.push('| 今天的归属模块 | ' + (d.owner.length ? d.owner.map(code).join('、') : '**无**（见下）') + ' |');
        lines.push('| 键 | ' + d.key + ' |');
        lines.push('| **必需能力** | ' + d.requires.map(code).join('、') + ' |');
        lines.push('| 可选能力 | ' + (d.optional.length ? d.optional.map(code).join('、') : '—') + ' |');
        const notOn = Object.keys(d.notOn);
        lines.push('| 不在哪些后端 | ' + (notOn.length ? notOn.map((b) => code(b) + '：' + d.notOn[b]).join('<br>') : '—') + ' |');
        lines.push('| 能力缺失时的降级 | ' + d.degradation + ' |');
        lines.push('| 不变量 | ' + d.invariants.join('<br>') + ' |');
        if (d.storedFields) { lines.push('| 必须存 | ' + d.storedFields.map(code).join('、') + ' |'); }
        if (d.neverStored) { lines.push('| 绝不存 | ' + d.neverStored.map(code).join('、') + ' |'); }
        if (d.knownGap) { lines.push('| 实测差距 | ' + d.knownGap + ' |'); }
        if (d.status) { lines.push('| 状态 | ' + code(d.status) + ' —— ' + d.noConsumerToday + ' |'); }
        lines.push('');
        if (Object.keys(implied).length) {
            lines.push('> 守卫算式：本域必需 ' + d.requires.map(code).join('、') + '，而 ');
            lines.push('> ' + Object.keys(implied).map((b) => code(b) + ' 对 ' + implied[b].map(code).join('、') + ' 实测为 no').join('；'));
            lines.push('> —— 因此 ' + Object.keys(implied).map(code).join('、') + ' 必须出现在「不在哪些后端」里，否则守卫视同契约自相矛盾。');
            lines.push('');
        }
    });

    lines.push('## 五、' + contract.REALTIME_BOUNDARY.label + ' ' + code(contract.REALTIME_BOUNDARY.id));
    lines.push('');
    lines.push('**' + contract.REALTIME_BOUNDARY.statement + '**');
    lines.push('');
    lines.push('| 项 | 内容 |');
    lines.push('|---|---|');
    lines.push('| 不抽象的东西 | ' + contract.REALTIME_BOUNDARY.notAbstracted.join('、') + ' |');
    lines.push('| 那它们在哪 | ' + contract.REALTIME_BOUNDARY.instead + ' |');
    lines.push('| 依据 | ' + contract.REALTIME_BOUNDARY.evidence.join('<br>') + ' |');
    lines.push('| 适配器契约里禁止出现的名字 | ' + contract.REALTIME_BOUNDARY.forbiddenInAdapterContract.map(code).join('、') + ' |');
    lines.push('');

    lines.push('## 冻结仍待证实的格子');
    lines.push('');
    const blockers = freezeBlockers(contract, rows);
    lines.push('D4 只做到「把要求写清楚」。下面 ' + blockers.length + ' 个 (后端, 能力) 对是各域**必需**、却仍未证实的：');
    lines.push('');
    lines.push('| # | 后端 / 能力 |');
    lines.push('|---|---|');
    blockers.forEach((b, i) => lines.push('| ' + (i + 1) + ' | ' + code(b) + ' |'));
    lines.push('');
    lines.push('它们归尚未完成的后端填空（D9–D10）用真实实例证实。**这份清单一旦增项，守卫立即变红**——');
    lines.push('冻结不能靠遗忘扩大。');
    lines.push('');

    lines.push('## 重新生成');
    lines.push('');
    lines.push('    ARCH_CONTRACT_UPDATE=1 npx mocha test/architecture/domainContracts.test.js');
    lines.push('');
    lines.push('会先写盘再故意失败，逼迫改动被看一遍才提交。');
    lines.push('');

    return lines.join('\n');
}

function writeMarkdown() {
    fs.writeFileSync(CONTRACT_MD, renderMarkdown(), 'utf8');
    return CONTRACT_MD;
}

module.exports = {
    CONTRACT_MD,
    CONTRACT_JS,
    load,
    verdictOf,
    impliedExclusions,
    freezeBlockers,
    renderMarkdown,
    writeMarkdown
};
