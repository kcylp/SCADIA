/**
 * 存储平面 · 五域契约（D4 冻结）
 *
 * 单一事实来源。人读的 22_契约06_存储平面五域契约.md 由本文件生成，禁止手改。
 * 由 test/architecture/domainContracts.test.js 守卫。
 *
 * 这份文件不描述某个后端怎么做，只描述**每个域要什么**：
 *   - requires 里的能力，是域成立的前提；
 *   - 某个交付后端对某个 requires 能力实测为 no 时，该后端必须出现在 notOn 里并写明原因；
 *     这条不是注释，是守卫会算的等式（见 domainContracts.test.js）。
 *
 * 能力名一律取自 19_能力矩阵_存储后端.json 的能力轴，本文件不另立一套词汇。
 */

'use strict';

const CONTRACT_VERSION = 1;

/** 裁决 12 命名的交付后端。D-2 已裁决 InfluxDB / QuestDB 不进交付列表。 */
const DELIVERY_BACKENDS = ['sqlite', 'postgresql', 'tdengine', 'dameng', 'mysql'];

/** 四域。 */
const DOMAINS = [
    {
        id: 'config',
        label: '配置域',
        responsibility: '工程与身份的可编辑定义：工程/画面/设备与 Tag 定义/报警定义/脚本/报表定义/配方/调度/用户与角色/API Key/相机与 GB 通道/校准配置',
        owner: [
            'runtime/project/prjstorage.js',
            'runtime/users/usrstorage.js',
            'runtime/apikeys/apiKeysStorage.js',
            'runtime/recipes/recipe-storage.js',
            'runtime/scheduler/scheduler-storage.js',
            'runtime/cameras/camera-storage.js',
            'runtime/calibration/calibration-storage.js'
        ],
        key: '分区名或表名 + 行主键；一段配置可以整体替换',
        requires: ['durability', 'atomic-batch'],
        optional: ['schema-evolution'],
        notOn: {
            tdengine: 'TDengine 对业务数据没有事务（官方口径，见 20_纸上实现_D3.md F-1），整段配置的「整体替换」无法保证要么全成要么全不成。'
        },
        degradation: 'atomic-batch 缺失时逐条写入并逐条回报结果，调用方必须能看到部分失败，不得静默继续。',
        invariants: [
            '整段配置写入要么整体生效，要么整体不生效；做不到就必须让调用方看见部分失败。',
            '配置的读取不因写入失败而看到半截状态。'
        ]
    },
    {
        id: 'event',
        label: '事件域',
        responsibility: '报警与事件历史：只追加的不可变记录',
        owner: ['runtime/alarms/alarmstorage.js'],
        key: '码（报警身份 nametype）+ 自增序号',
        requires: ['durability'],
        optional: ['atomic-batch'],
        notOn: {},
        degradation: 'atomic-batch 缺失时逐条追加；已追加的记录不回滚，历史本身只追加。',
        storedFields: ['code', 'sourceTextZh', 'generatedLang'],
        neverStored: ['translatedText'],
        invariants: [
            '裁决 3：只存「码 + 中文原文快照 + 生成时语言」，绝不存译文；翻译只发生在渲染时。',
            '历史只追加：确认（ack）是状态变更，不是删除。',
            '裁决 6：英/俄区不保留录音，只存文本转写与审计。'
        ],
        knownGap: '实测 runtime/alarms/alarmstorage.js 的 chronicle 表列为 (Sn, nametype, type, status, text, grp, ontime, offtime, acktime, userack, value)，没有语言列；码即 nametype，中文原文快照即 text/grp。缺 generatedLang 一列，迁移归 D7。'
    },
    {
        id: 'timeseries',
        label: '时序域',
        responsibility: 'DAQ 归档采样：tag 身份 + 时间戳 + 值',
        owner: [
            'runtime/storage/daqstorage.js',
            'runtime/storage/sqlite/index.js',
            'runtime/storage/influxdb/index.js',
            'runtime/storage/tdengine/index.js',
            'runtime/storage/questdb/index.js'
        ],
        key: 'tag 身份 + 时间戳；同一 tag 同一时刻只有一条',
        requires: ['durability', 'ts-range'],
        optional: ['ts-aggregate', 'retention'],
        notOn: {},
        degradation: 'retention 缺失时由产品层滚动（现状：删除整个归档文件）；ts-aggregate 缺失时把原始点拉回来再算（runtime/storage/calculator.js）。',
        invariants: [
            '查询语义沿用既有契约：半开区间 [from,to)、不插值、缺口显式上报、超限显式拒绝、状态与数据分离。',
            '写入不因某个 tag 失败而回滚其它 tag。'
        ]
    },
    {
        id: 'object',
        label: '对象域',
        responsibility: '不可变的二进制对象：抓拍图、报告附件、录音（按裁决 6，英/俄区不保留录音）',
        owner: [],
        key: '不可变 key（内容寻址或 UUID）；对象写入后不再修改，替换即写新 key',
        requires: ['durability', 'binary-object'],
        optional: [],
        notOn: {},
        degradation: 'binary-object 缺失时该后端不承载对象域，不得退化成把二进制塞进文本列。',
        invariants: [
            '不放进配置域与事件域的文本列。',
            '只增不改：替换 = 写新 key。'
        ],
        status: 'reserved-seam',
        noConsumerToday: '实测：runtime/ 下没有任何 BLOB 列，也没有任何对象存储实现（唯一出现二进制的列是 TDengine 适配器里的 BINARY(20)/(256)，那是文本）。按裁决 14「预留位置，而非现在实现」，本域只留缝、不留 TODO，且不得先于消费者实现。'
    }
];

/**
 * 第五条：实时**不**抽象。
 * 它不是第五个域，而是一条边界——说明什么不进这套接口。
 */
const REALTIME_BOUNDARY = {
    id: 'realtime-not-abstracted',
    label: '实时不抽象',
    statement: '当前值与实时推送不进入存储平面接口。',
    notAbstracted: ['当前值读取与订阅', '变更推送', '历史回放的实时化'],
    instead: '当前值由 runtime/storage/sqlite/currentstorage.js 单一实现持有，只作重启恢复源；实时推送走 socket.io，完全不经过存储接口。',
    evidence: [
        'currentstorage.js 只被 runtime/devices/index.js 与 runtime/storage/daqstorage.js 直接引用（D1 依赖图实测）。',
        '适配器实例契约在 D1 已冻结为 5 个方法，其中没有任何订阅或推送语义。'
    ],
    forbiddenInAdapterContract: ['subscribe', 'unsubscribe', 'watch', 'stream', 'push', 'listen', 'onChange']
};

module.exports = {
    CONTRACT_VERSION,
    DELIVERY_BACKENDS,
    DOMAINS,
    REALTIME_BOUNDARY
};
