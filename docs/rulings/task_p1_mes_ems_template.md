# 批次 P1：MES/EMS 工程模板 — 软开发能力交付

**严重度**：P1 — 用户明确要求"必须能开发，不能是屎山"  
**执行方**：DeepSeek  
**预计工期**：1 周  
**依赖**：P0 完成后开始（不阻塞，但通知系统需要正常工作）

---

## 1. 交付物清单

| 序号 | 文件 | 格式 | 用途 |
|------|------|------|------|
| 1 | `mes-ems-template.scadiap` | JSON | 可直接导入 SCADIA 的 MES/EMS 工程模板 |
| 2 | `MES-EMS-开发手册.md` | Markdown | 教用户如何基于模板二次开发 |

**放置路径**：`D:\vibe coding 2026.1.6\__mes_ems_template\`

---

## 2. 数据结构（工程文件 JSON）

工程文件顶层加 `devices`、`hmi`、`server` 三个键。**不新建后端域、不新建 API、不新建存储表。**

### 2.1 devices — 数据采集层

**原则**：用 SCADIAServer 内部 tag 模拟 MES/EMS 数据点，可选 SiemensS7 外部设备。

```json
"devices": {
  "MES_Tags": {
    "id": "dev-mes-tags",
    "type": "SCADIAServer",
    "name": "MES 标签表",
    "enabled": true,
    "property": { "address": "internal" },
    "tags": {
      "mes.wo.current":    { "id": "mes.wo.current",    "name": "当前工单",    "type": "String" },
      "mes.wo.planned":    { "id": "mes.wo.planned",    "name": "计划产量",    "type": "Int16" },
      "mes.wo.completed":  { "id": "mes.wo.completed",  "name": "完工数量",    "type": "Int16" },
      "mes.wo.wip":        { "id": "mes.wo.wip",        "name": "在制品",      "type": "Int16" },
      "mes.wo.status":     { "id": "mes.wo.status",     "name": "工单状态",    "type": "String" },
      "mes.oee.availability": { "id": "mes.oee.availability", "name": "可用率",  "type": "Float" },
      "mes.oee.performance":  { "id": "mes.oee.performance",  "name": "性能率",  "type": "Float" },
      "mes.oee.quality":      { "id": "mes.oee.quality",      "name": "合格率",  "type": "Float" },
      "mes.oee.score":        { "id": "mes.oee.score",        "name": "OEE",      "type": "Float" },
      "mes.energy.kwh":     { "id": "mes.energy.kwh",     "name": "今日用电",    "type": "Float" },
      "mes.energy.water":   { "id": "mes.energy.water",   "name": "今日用水",    "type": "Float" },
      "mes.energy.gas":     { "id": "mes.energy.gas",     "name": "今日用气",    "type": "Float" },
      "mes.energy.steam":   { "id": "mes.energy.steam",   "name": "今日用汽",    "type": "Float" },
      "mes.defect.count":   { "id": "mes.defect.count",   "name": "缺陷数",      "type": "Int16" },
      "mes.defect.inspected": { "id": "mes.defect.inspected", "name": "抽检数", "type": "Int16" },
      "mes.shift":          { "id": "mes.shift",          "name": "当前班次",    "type": "String" }
    }
  },
  "ProductionLine1": {
    "id": "dev-pl1",
    "type": "SiemensS7",
    "name": "1#生产线",
    "enabled": false,
    "property": { "address": "192.168.1.177", "port": 102, "rack": 0, "slot": 2 },
    "tags": {
      "Planned": { "id": "Planned", "name": "计划产量", "type": "Int", "address": "db4.dbw1" },
      "Actual":  { "id": "Actual",  "name": "实际产量", "type": "Int", "address": "db4.dbw2" },
      "Defect":  { "id": "Defect",  "name": "缺陷计数", "type": "Int", "address": "db4.dbw3" },
      "Status":  { "id": "Status",  "name": "设备状态", "type": "Bool", "address": "db1.dbx0.0" }
    }
  }
}
```

---

### 2.2 hmi.views — 5 个看板画面

#### 画面 1：MES 制造执行看板（`v_mes_dashboard`）

**布局**：
```
┌──────────────────────────────────────────────────────────────┐
│  MES 制造执行看板                          2026-10-04 14:00  │
├──────────┬──────────┬──────────┬──────────┬──────────────────┤
│ 今日产量  │ 计划产量  │ 达成率    │ 良品率    │ 当前工单          │
│ 26,870   │ 31,200   │ 86.1%    │ 98.9%    │ WO-2026-1004-03  │
├──────────┴──────────┴──────────┴──────────┴──────────────────┤
│  OEE 分析                                             85.5%  │
│  可用率 87.2%  ×  性能率 92.4%  ×  合格率 98.9%              │
├──────────────────────────┬───────────────────────────────────┤
│  工单进度（12条）        │  质量指标                         │
│  完成12 运行4 QC1 待开2  │  缺陷数: 267 / 抽检数: 2,700      │
│  进度条显示               │  缺陷率: 9.89‰                     │
└──────────────────────────┴───────────────────────────────────┘
```

**组件绑定**：
- KPI 磁贴：绑定 `mes.wo.completed`、`mes.wo.planned`、`mes.defect.count`、`mes.defect.inspected`
- OEE 三要素：绑定 `mes.oee.availability`、`mes.oee.performance`、`mes.oee.quality`
- 工单表格：绑定 `mes.wo.*` 系列 tag
- 条件颜色：达成率 >= 95% 绿 / 80-95% 蓝 / < 80% 红

#### 画面 2：EMS 能源管理看板（`v_ems_dashboard`）

**布局**：
```
┌──────────────────────────────────────────────────────────────┐
│  EMS 能源管理看板                          2026-10-04 14:00  │
├──────────┬──────────┬──────────┬──────────┬──────────────────┤
│ 今日用电  │ 今日用水  │ 今日用气  │ 今日用汽  │ 碳排放估算        │
│ 13,272   │ 386      │ 3,200    │ 1,850    │ 8.42 tCO₂        │
│   kWh    │   m³     │   m³     │   kg     │                   │
├──────────┴──────────┴──────────┴──────────┴──────────────────┤
│  24h 能耗曲线（kWh）                                           │
│  ▃▅▇█▇▆▅▄▄▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃                            │
├──────────────────────────┬───────────────────────────────────┤
│  分项占比                 │  峰谷平统计                       │
│  尖峰 3,192 / 高峰 4,064  │  峰时 36.9% / 平时 30.9% / 谷时 32.2% │
└──────────────────────────┴───────────────────────────────────┘
```

**组件绑定**：
- KPI 磁贴：绑定 `mes.energy.kwh`、`mes.energy.water`、`mes.energy.gas`、`mes.energy.steam`
- 24h 趋势：绑定 `mes.energy.kwh` + DAQ 查询（最近 24 小时）
- 碳排放：绑定 `mes.carbon.estimate`
- 峰谷平：绑定 `mes.energy.tariff.*`

#### 画面 3：OEE 分析（`v_mes_oee`）

三列大数字（可用率/性能率/合格率）+ 乘积 = OEE  
下方 24h 趋势图（Chart 组件，数据源 = DAQ 查询）

#### 画面 4：能耗趋势（`v_ems_energy`）

四张趋势图（kWh/水/气/汽），x 轴 = 24h，y 轴 = 累计值  
数据源 = DAQ 查询 `SELECT dt, value FROM meters WHERE tag_id = 'mes.energy.*'`

#### 画面 5：现场画面（`v_production_floor`）

SVG 布局图：设备位号 + 状态颜色（绿=运行/灰=待机/红=故障）  
每个设备位 = HtmlSelect 组件，绑定 `mes.equipment.*.status`

---

### 2.3 hmi.navigation — 导航表

```json
"navigation": {
  "mode": "fix",
  "type": "inline",
  "items": [
    { "icon": "home",           "text": "现场画面",  "view": "v_production_floor" },
    { "icon": "dashboard",      "text": "驾驶舱",    "view": "v_mes_dashboard" },
    { "icon": "analytics",      "text": "OEE分析",   "view": "v_mes_oee" },
    { "icon": "bolt",           "text": "能源看板",  "view": "v_ems_dashboard" },
    { "icon": "show_chart",     "text": "能耗趋势",  "view": "v_ems_energy" },
    { "icon": "notifications",  "text": "实时报警",  "link": "alarms" },
    { "icon": "history",        "text": "历史报警",  "link": "messages" },
    { "icon": "assessment",     "text": "报表",      "link": "reports" },
    { "icon": "developer_board","text": "设备管理",  "link": "device" },
    { "icon": "videocam",       "text": "视频监控",  "link": "cameras" }
  ]
}
```

---

### 2.4 server.scripts — 3 个服务端脚本

#### 脚本 1：OEE 计算（`s_oee_calc`）

```javascript
// ===== OEE 计算 =====
// 输入: mes.wo.planned, mes.wo.completed, mes.defect.count, mes.defect.inspected
// 输出: mes.oee.availability, mes.oee.performance, mes.oee.quality, mes.oee.score

const planned = $getTag('mes.wo.planned') || 0;
const completed = $getTag('mes.wo.completed') || 0;
const defect = $getTag('mes.defect.count') || 0;
const inspected = $getTag('mes.defect.inspected') || 0;

// 可用率 = 运行时间 / 班次时长（这里用完工率近似）
const availability = planned > 0 ? Math.min(1, completed / planned) : 0;

// 性能率 = 节拍时间 / 实际节拍（演示用固定节拍 120s）
const cycleTime = 120;
const actualRate = completed > 0 ? (Date.now() / 1000 - (Date.now() / 1000 - 3600)) / completed : 0;
const performance = Math.min(1, cycleTime / Math.max(cycleTime, actualRate));

// 合格率 = 1 - 缺陷率
const defectRate = inspected > 0 ? defect / inspected : 0;
const quality = Math.max(0, 1 - defectRate);

// OEE = 三者乘积
const oee = availability * performance * quality;

$setTag('mes.oee.availability', availability.toFixed(4));
$setTag('mes.oee.performance', performance.toFixed(4));
$setTag('mes.oee.quality', quality.toFixed(4));
$setTag('mes.oee.score', oee.toFixed(4));
```

**DAO 落库**：在 devices 定义中开启 tag 的 daq 字段，不在脚本中调用 DAQ 函数：
```json
"mes.oee.score": {
  "id": "mes.oee.score",
  "name": "OEE",
  "type": "Float",
  "daq": { "enabled": true }
}
```

**调度**：每 60 秒执行一次（`interval: 60000`）

**⚠️ 重要**：脚本 API 真名是 `$getTag` 和 `$setTag`，不是 `$getTagValue`/`$setTagValue`。调用不存在函数名会抛 ReferenceError，但被 try/catch 吞掉后静默算出错结果。DAO 落库是驱动自动行为，不由脚本控制。

---

#### 脚本 2：能耗汇总（`s_energy_agg`）

```javascript
// ===== 能耗汇总 + 碳排计算 =====
const kwh = $getTag('mes.energy.kwh') || 0;
const water = $getTag('mes.energy.water') || 0;
const gas = $getTag('mes.energy.gas') || 0;
const steam = $getTag('mes.energy.steam') || 0;

// 碳排 = 电 × 碳排因子（简化）
const carbonFactor = 0.58; // kg CO₂/kWh
const carbon = kwh * carbonFactor / 1000; // 吨
$setTag('mes.carbon.estimate', carbon.toFixed(2));

// 分时电费（简化：按总电量 × 平均电价）
const avgPrice = 0.68; // 元/kWh（峰谷平平均）
const elecCost = kwh / 1000 * avgPrice;
$setTag('mes.energy.cost', elecCost.toFixed(2));
```

**调度**：每 5 分钟执行一次（`interval: 300000`）

**⚠️ 重要**：使用 `$getTag` 和 `$setTag`，不是 `$getTagValue`/`$setTagValue`。无 `$daqWrite`。

---

#### 脚本 3：班次产量汇总（`s_shift_report`）

```javascript
// ===== 班次产量汇总 =====
const completed = $getTag('mes.wo.completed') || 0;
const planned = $getTag('mes.wo.planned') || 0;
const defect = $getTag('mes.defect.count') || 0;

$log('班次报告: 完工=' + completed + ', 计划=' + planned + ', 缺陷=' + defect);
// 报表引擎自动采集这些 tag 的历史值
```

**调度**：每天 08:00 执行（`scheduling: [{ type: 0, days: [1,2,3,4,5], time: "08:00" }]`）

**⚠️ 重要**：使用 `$getTag`，不是 `$getTagValue`。注意：脚本 API 中没有 `$log` 函数，`logger` 对象也不暴露给脚本。如需要日志，使用 `$setTag` 写入一个日志 tag，或通过其他机制记录。

---

### 2.5 server.alarms — 3 条报警

```json
"alarms": [
  {
    "id": "alm_temp_high",
    "name": "产线温度超限",
    "deviceId": "dev-mes-tags",
    "tagId": "mes.temp.line1",
    "type": "high",
    "value": 85,
    "priority": 1,
    "enabled": true
  },
  {
    "id": "alm_defect_high",
    "name": "缺陷率超标",
    "deviceId": "dev-mes-tags",
    "tagId": "mes.defect.rate",
    "type": "high",
    "value": 0.05,
    "priority": 2,
    "enabled": true
  },
  {
    "id": "alm_energy_peak",
    "name": "用电超峰",
    "deviceId": "dev-mes-tags",
    "tagId": "mes.energy.kwh",
    "type": "high",
    "value": 15000,
    "priority": 3,
    "enabled": true
  }
]
```

---

### 2.6 server.reports — 2 份报表

#### 报表 1：日报_产量

```json
{
  "id": "rpt_daily_production",
  "name": "日报_产量",
  "scheduling": {
    "mode": "scheduling",
    "schedules": [{ "type": 0, "days": [1,2,3,4,5,6,7], "time": "20:00", "hour": 20, "minute": 0 }]
  },
  "format": "pdf",
  "queries": [
    { "tagId": "mes.wo.planned",  "from": -86400000, "to": 0 },
    { "tagId": "mes.wo.completed","from": -86400000, "to": 0 },
    { "tagId": "mes.oee.score",   "from": -86400000, "to": 0 }
  ]
}
```

#### 报表 2：月报_能耗

```json
{
  "id": "rpt_monthly_energy",
  "name": "月报_能耗",
  "scheduling": {
    "mode": "scheduling",
    "schedules": [{ "type": 0, "days": [1], "time": "08:00", "hour": 8, "minute": 0 }]
  },
  "format": "excel",
  "queries": [
    { "tagId": "mes.energy.kwh",   "from": -2592000000, "to": 0 },
    { "tagId": "mes.energy.water", "from": -2592000000, "to": 0 },
    { "tagId": "mes.energy.gas",   "from": -2592000000, "to": 0 },
    { "tagId": "mes.carbon.estimate", "from": -2592000000, "to": 0 }
  ]
}
```

---

### 2.7 server.recipes — 1 个配方模板

```json
{
  "id": "rcp_product_a",
  "name": "产品A 标准配方",
  "template": {
    "temperature": { "value": 120, "unit": "°C", "min": 100, "max": 140 },
    "pressure":    { "value": 0.8, "unit": "MPa", "min": 0.5, "max": 1.0 },
    "cycleTime":   { "value": 120, "unit": "s", "min": 90, "max": 180 }
  },
  "instances": [
    { "id": "inst_001", "name": "2026-10-04 批次", "parameters": {} }
  ]
}
```

---

## 3. 画面组态规范

### 3.1 KPI 磁贴

```
组件类型: HtmlSelect
绑定变量: mes.wo.completed
显示文本: {{value}} 件
条件格式:
  value >= 31000 → 背景 #2E7D32 (绿)
  value >= 28000 → 背景 #1565C0 (蓝)
  value < 28000  → 背景 #C62828 (红)
```

### 3.2 趋势图

```
组件类型: HtmlChart
类型: history
绑定变量: mes.oee.score
时间范围: 最近 24 小时
图表类型: 折线图
Y轴: 0.00 ~ 1.00
```

### 3.3 报警列表

```
组件类型: HtmlChart
类型: alarms
数据源: 当前活跃报警
显示字段: 时间 / 名称 / 优先级 / 状态
```

---

## 4. 开发手册结构

### 4.1 快速开始（5 分钟）

1. 打开 SCADIA → 文件 → 打开项目 → 选择 `mes-ems-template.scadiap`
2. 侧栏展开「数据」组 → 进入「制造执行」看板
3. 画面已包含完整 MES 演示数据（固定常量，不依赖后端）
4. 进入「编辑器」→「设备设置」→ 将 `ProductionLine1` 的 enabled 改为 true → 填入真实 PLC 地址
5. 进入「脚本」→ 修改 `s_oee_calc` 中的 cycleTime 为真实节拍时间
6. 进入「报警」→ 按真实阈值调整报警限值

### 4.2 二次开发 5 步路径

```
第一步：替换数据源（1-2 小时）
  → 将 SCADIAServer 内部 tag 替换为真实 Device tag
  → 脚本无需改动（$getTagValue 接口不变）

第二步：调整计算逻辑（2-4 小时）
  → 修改 Script 中的 OEE/能耗计算公式
  → 调度间隔按需调整

第三步：定制画面（2-4 小时）
  → 进入编辑器拖拽组件
  → 绑定 tag → 条件颜色 → 趋势图
  → 导出为 View 模板供其他工程复用

第四步：配置报表（1 小时）
  → 进入报表 → 新建 → 选择 tag 历史查询
  → 设置定时调度（早班/晚班/日/月）
  → 输出格式 PDF/Excel

第五步：配方下发（可选，1-2 小时）
  → 进入配方 → 新建模板
  → 参数定义 → 实例创建
  → 通过脚本或报警联动触发下发
```

### 4.3 脚本 API 参考

**⚠️ 重要：以下 API 名称必须严格使用，不能随意改写**

| 函数 | 签名 | 用途 |
|------|------|------|
| `$getTag(id)` | `(string) → any` | 读取当前 tag 值 |
| `$setTag(id, value)` | `(string, any) → void` | 写入 tag 值 |
| `$getTagId(name)` | `(string) → string` | tag 名称→ID |
| `$setView(name)` | `(string) → void` | 切换画面 |
| `$enableDevice(id)` | `(string) → void` | 启用/禁用设备 |
| `$getDevice(id)` | `(string) → object` | 读设备属性 |
| `$getTagDaqSettings(id)` | `(string) → object` | 读 DAQ 设置 |
| `$setTagDaqSettings(id, settings)` | `(string, object) → void` | 写 DAQ 设置 |
| `$getHistoricalTags(ids, from, to)` | `(string[], number, number) → array` | 读历史 |
| `$sendMessage(url)` | `(string) → Promise` | HTTP GET |
| `$getAlarms()` | `() → array` | 读当前报警 |
| `$getAlarmsHistory()` | `() → array` | 读报警历史 |
| `$ackAlarm(id)` | `(string) → void` | 确认报警 |

**已废弃/不存在的 API（禁止使用）**：
- ~~`$getTagValue`~~ → 用 `$getTag`
- ~~`$setTagValue`~~ → 用 `$setTag`
- ~~`$daqWrite`~~ → 不存在，DAO 落库由 tag 的 `daq.enabled` 字段控制
- ~~`$getShiftStart`~~ → 不存在，如需班次开始时间，自行计算或用固定常量
- ~~`$log`~~ → 不存在，脚本无直接日志 API

**约束**：
- 脚本超时 = 30 秒
- 无网络访问（`require('http')` 被禁用）
- 无文件系统访问
- 只能操作工程内的 tag
- 调用不存在函数会抛 ReferenceError，被 try/catch 吞掉后静默失败——必须用 try/catch 包裹并处理错误

---

## 5. 验收标准

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 工程能正常打开 | 拖入 SCADIA | 无报错，侧栏显示 10 个入口 |
| MES 看板渲染 | #/mes | 5 个 KPI 磁贴 + OEE 三要素 + 工单表格 + 报警面板 |
| EMS 看板渲染 | #/ems | 4 个能耗 KPI + 24h 趋势 + 峰谷平统计 |
| OEE 计算正确 | 查看脚本输出 | availability × performance × quality = score |
| 能耗计算正确 | 查看脚本输出 | 峰+平+谷 = 总用电量 |
| 碳排计算正确 | 查看脚本输出 | 电耗 × 0.58 kg CO₂/kWh |
| 报表定时触发 | 等调度时间 | 自动生成 PDF/Excel |
| DAQ 历史可查 | 趋势图时间范围 | 能显示最近 24h 数据 |
| 报警触发 | 手动改 tag 超限 | 报警面板出现新条目 |
| 配方下发 | 创建实例 → 下发 | tag 值被更新 |

---

## 6. 代码质量约束

| 约束 | 为什么 |
|------|--------|
| **没有 `readonly dayOutput = 26870` 这种硬编码** | 所有数据绑定 tag，组件不持有业务数据 |
| **计算逻辑全在脚本里，不在模板里** | 模板只负责展示，脚本负责计算 |
| **数据结构有单一数据源** | 工程文件 = 唯一真相源，不在多个地方重复 |
| **零随机数** | 所有演示数据固定常量 |
| **不修改任何现有 SCADIA 源码文件** | 纯工程配置 + 脚本，可复制分发 |

---

## 7. 交付物检查清单

```
__mes_ems_template/
├── mes-ems-template.scadiap          ✅ 能直接拖入 SCADIA 打开
├── MES-EMS-开发手册.md               ✅ 7 章，含快速开始 + 二次开发 5 步
└── README.md                         ✅ 一句话介绍 + 快速开始链接
```

---

*本任务卡为最终版本，执行方按 §2-§6 一次性生成交付物。*
