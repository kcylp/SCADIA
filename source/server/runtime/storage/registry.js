/**
 * 存储后端注册表（D5）
 *
 * 唯一声明「系统支持哪些后端、每个后端由谁实现、怎么选中它、怎么构造它」的地方。
 * 它同时是 D4 冻结契约（./contract.js）的第一个消费者——在它出现之前，契约只是一个
 * 没有读者的模块，守卫也因此把它登记成孤儿；现在那条登记必须被删除，否则守卫变红。
 *
 * 这张表不重复声明能力（那是 19_能力矩阵_存储后端.json 的事），只声明身份与构造方式；
 * 两者的一致性由 test/architecture/registryCompleteness.test.js 交叉核对。
 */

'use strict';

const contract = require('./contract');

/**
 * Adapter loaders, written as literal require() calls on purpose.
 *
 * A registry that resolves its own dependencies by string hides them from every static
 * reader: the architecture guard could no longer prove which adapters can be reached from
 * main.js, and a bundler could not either. The reference is a function, so an adapter is
 * still only loaded when a store is actually created.
 */
const ADAPTER_LOADERS = {
    postgresql: function () { return require('./postgresql'); },
    sqlite: function () { return require('./sqlite'); },
    influxdb: function () { return require('./influxdb'); },
    tdengine: function () { return require('./tdengine'); },
    questdb: function () { return require('./questdb'); }
};

/**
 * 后端。adapter 为 null 表示「位置已留、实现未写」（裁决 14：留缝，不留 TODO）。
 * perDeviceNode 为 true 表示该后端按设备分片，同一后端会有多个实例。
 */
const BACKENDS = [
    {
        id: 'sqlite',
        label: 'SQLite',
        adapter: './sqlite',
        load: 'sqlite',
        status: 'delivered',
        provenOn: 'in-process on every guard run; contract suite 8/8',
        delivery: true,
        perDeviceNode: true,
        retention: { native: false, strategy: 'file-rolling', wired: true }
    },
    {
        id: 'postgresql',
        label: 'PostgreSQL',
        adapter: './postgresql',
        load: 'postgresql',
        // delivered, because it HAS run: against PostgreSQL 18 in a container, the whole
        // shared contract suite, 8/8. Being proven is an EVENT, and it is recorded as one -
        // a machine without a database is a property of the machine, not of the backend.
        status: 'delivered',
        provenOn: 'PostgreSQL 18 (docker compose), contract suite 8/8',
        delivery: true,
        perDeviceNode: false,
        retention: { native: false, strategy: 'product-rolling', wired: false }
    },
    {
        id: 'tdengine',
        label: 'TDengine',
        adapter: './tdengine',
        load: 'tdengine',
        // unproven: the adapter now follows the contract and wires KEEP, but no TDengine
        // instance has ever accepted a write from it (ledger A-09).
        //
        // offered: it HAS been selectable in shipped versions. The "never offer something
        // unproven" rule exists to stop us promising a backend that does not exist yet - it
        // is not a licence to withdraw an option operators may already be running on.
        status: 'unproven',
        offered: true,
        delivery: true,
        perDeviceNode: false,
        retention: { native: true, strategy: 'database-keep', wired: true },
        proveWith: 'npm run test:backends:up && npm run test:contract'
    },
    {
        id: 'dameng',
        label: '达梦（Oracle 系）',
        adapter: null,
        status: 'reserved',
        delivery: true,
        perDeviceNode: false,
        retention: { native: false, strategy: 'product-rolling', wired: false }
    },
    {
        id: 'mysql',
        label: 'MySQL 系',
        adapter: null,
        status: 'reserved',
        delivery: true,
        perDeviceNode: false,
        retention: { native: false, strategy: 'product-rolling', wired: false }
    },
    {
        id: 'influxdb',
        label: 'InfluxDB',
        adapter: './influxdb',
        load: 'influxdb',
        status: 'legacy',
        delivery: false,
        perDeviceNode: false,
        retention: { native: true, strategy: 'retention-policy', wired: false }
    },
    {
        id: 'questdb',
        label: 'QuestDB',
        adapter: './questdb',
        load: 'questdb',
        status: 'legacy',
        delivery: false,
        perDeviceNode: false,
        retention: { native: true, strategy: 'table-ttl', wired: false }
    }
];

/**
 * 选择值 -> 后端。canonical 是规范写法；别写法的存在是因为它们**已经在用户的
 * 工程文件里**，不是给人继续用的。
 */
const SELECTION_TYPES = [
    { value: 'SQlite', backend: 'sqlite', canonical: true },
    { value: 'influxDB', backend: 'influxdb', canonical: true },
    { value: 'influxDB18', backend: 'influxdb', canonical: true },
    { value: 'TDengine', backend: 'tdengine', canonical: true },
    { value: 'questDB', backend: 'questdb', canonical: true },
    // 客户端 DaqStoreType 历史上发的是这个写法（带空格），服务端一度只认 influxDB18，
    // 于是「选 InfluxDB 1.8」静默落进了 SQLite（台账 A-02）。
    { value: 'influxDB 1.8', backend: 'influxdb', canonical: false, aliasOf: 'influxDB18' },
    // daqstorage 的旧代码里比较过 'QuestDB'（大写 Q），而交付取值从来是 'questDB'（台账 A-06a）。
    { value: 'QuestDB', backend: 'questdb', canonical: false, aliasOf: 'questDB' }
];

const DEFAULT_TYPE = 'SQlite';

function backendById(id) {
    const found = BACKENDS.filter((b) => b.id === id)[0];
    if (!found) { throw new Error('storage registry: unknown backend id "' + id + '"'); }
    return found;
}

function selectionFor(value) {
    return SELECTION_TYPES.filter((s) => s.value === value)[0] || null;
}

/** 所有可用的选择写法，用于报错时告诉运维到底能填什么。 */
function knownTypes() {
    return SELECTION_TYPES.filter((s) => s.canonical).map((s) => s.value);
}

/**
 * 把 settings.daqstore.type 归一化到规范写法，并就地写回。
 *
 * 就地写回不是顺手：适配器内部会按 settings.daqstore.type 分支（influxdb/index.js:36
 * 比较 'influxDB18' 来选版本），如果只有路由认了别名而适配器还在读旧写法，同一个
 * 配置会在两个地方得到两个答案。归一化一次，全链路只有一个词。
 */
function normalise(settings, logger) {
    const daqstore = settings ? settings.daqstore : null;
    const raw = daqstore && daqstore.type ? daqstore.type : DEFAULT_TYPE;

    const selected = selectionFor(raw);
    if (!selected) {
        const message = 'daqstore.type "' + raw + '" 不是已知的存储后端。可用取值：' +
            knownTypes().join(', ') + '。已拒绝启动，不猜测意图。';
        if (logger) { logger.error('daqstorage: ' + message); }
        throw new Error(message);
    }

    if (!selected.canonical) {
        if (logger) {
            logger.warn('daqstorage: daqstore.type "' + raw + '" 是历史写法，已归一化为 "' +
                selected.aliasOf + '"；请把它改成规范写法。');
        }
        if (daqstore) { daqstore.type = selected.aliasOf; }
    }

    return {
        backendId: selected.backend,
        type: selected.canonical ? selected.value : selected.aliasOf,
        backend: backendById(selected.backend)
    };
}

/**
 * 构造一个适配器实例。所有后端的签名统一为
 *   create(settings, logger, currentStorage, options)
 * options.nodeId 只在 perDeviceNode 的后端上有意义（A-05 由这次统一关闭）。
 */
function create(backendId, settings, logger, currentStorage, options) {
    const backend = backendById(backendId);
    if (!backend.adapter) {
        throw new Error('storage registry: backend "' + backendId +
            '" 只有位置没有实现（裁决 14）。请在实现它之后再选择它。');
    }
    return adapterOf(backend).create(settings, logger, currentStorage, options || {});
}

function adapterOf(backend) {
    const load = ADAPTER_LOADERS[backend.load];
    if (!load) {
        throw new Error('storage registry: backend "' + backend.id + '" has no loader; ' +
            'declaring an adapter path without a loader is half a registration.');
    }
    return load();
}

/**
 * 保留期：产品层的回滚策略。
 *
 * 后端的原生保留期（TDengine 的 KEEP、QuestDB 的 TTL）由各适配器在建库时声明；
 * 这一支是**后端没有原生保留期时产品层自己滚动**的那条路，目前只有 SQLite 有实现
 * （删除整个归档文件）。收进注册表是为了让门面不再需要认识任何一个具体后端——
 * F-2 要求的「保留期是接口的一部分」在这里落地。
 */
function rollRetention(backendId, settings, dtlimit, onRemoved, onError) {
    const backend = backendById(backendId);
    if (!backend.retention || !backend.retention.wired) { return false; }
    if (backend.retention.strategy !== 'file-rolling') { return false; }
    adapterOf(backend).checkRetention(dtlimit, settings.dbDir, onRemoved, onError);
    return true;
}

/** 诊断用：把这张表讲成人话。 */
function describe() {
    return BACKENDS.map((b) => ({
        id: b.id,
        label: b.label,
        status: b.status,
        delivery: b.delivery,
        adapter: b.adapter,
        perDeviceNode: b.perDeviceNode,
        retention: b.retention,
        proveWith: b.proveWith || null,
        provenOn: b.provenOn || null
    }));
}

/**
 * Identity only - the fields that describe WHICH backend this is. Anything that renders or
 * validates a backend list should read them from here instead of keeping its own copy, so
 * that adding a backend stays a one-entry change.
 */
function identity() {
    return BACKENDS.map((b) => ({
        id: b.id,
        label: b.label,
        adapter: b.adapter,
        status: b.status,
        delivery: b.delivery,
        proveWith: b.proveWith || null,
        provenOn: b.provenOn || null
    }));
}

module.exports = {
    CONTRACT_VERSION: contract.CONTRACT_VERSION,
    DEFAULT_TYPE,
    BACKENDS,
    SELECTION_TYPES,
    backendById,
    selectionFor,
    knownTypes,
    normalise,
    create,
    adapterOf,
    rollRetention,
    describe,
    identity
};
