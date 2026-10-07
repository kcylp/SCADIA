# MES/EMS 开发能力技术规格书
## SCADIA 平台现有能力模式化交付 — 不改后端、不新建域、零架构债务

**版本**：1.0  
**日期**：2026-10-05  
**状态**：已批准，可执行  
**执行方**：DeepSeek 代码生成  
**验收标准**：交付物能直接复制到 SCADIA 工程里运行，不修改任何 `runtime/`、`server/`、`client/src/app/_services/` 下的现有文件

---

## 0. 设计约束（铁律，违反即驳回）

| 编号 | 约束 | 为什么 |
|------|------|--------|
| C-1 | **不改后端代码** | `runtime/`、`server/` 下所有 `.js` 零改动；所有能力通过**工程配置**（`.scadiap`）+ **脚本** + **组态画面** 实现 |
| C-2 | **不新建 API 域** | 不碰 `apiGuestSurface` 冻结的 13 个面；对外接口走现有 REST + OPC UA + WebSocket |
| C-3 | **不新增存储后端** | DAQ 多后端（TDengine/QuestDB/PostgreSQL/SQLite/InfluxDB）已经存在，直接使用 |
| C-4 | **零随机数** | 所有演示/模板数据必须是固定常量，两个截图必须一致 |
| C-5 | **单文件交付** | 最终产物是一个可直接导入的 `.scadiap` 工程文件 + 一份开发手册 |

---

## 1. 为什么不需要新子系统

SCADIA 的运行时已经具备 MES/EMS 所需的全部原子能力：

| MES/EMS 需求 | SCADIA 现有能力 | 对应文件 |
|--------------|-----------------|----------|
| 实时数据采集 | 17 个驱动（OPC UA/S7/Modbus/MQTT/WebSocket/REST/ODBC） | `runtime/devices/*/index.js` |
| 标签/点位管理 | Tag 模型 + DAQ 历史存储 | `runtime/devices/tag-domain.js`、`runtime/storage/*/index.js` |
| 计算（OEE/能耗/节拍） | 服务端脚本，支持定时/触发调度 | `runtime/scripts/index.js` |
| 报警（质量/能源超限） | 四限报警 + 联动脚本 | `runtime/alarms/index.js` |
| 报表（班报/日报/月报） | 报表引擎 + PDF/Excel + 定时调度 | `client/src/app/reports/` |
| 配方（工艺参数模板） | 配方模板 + 实例 + 下发 | `runtime/recipes/recipe-service.js` |
| 看板画面 | 组态画面编辑器 + 调度器 | `client/src/app/editor/` |
| 对外接口 | REST API + API 密钥 + WebSocket | `server/runtime/index.js` |
| 视频监控 | 视频墙 + AI 检测框 | `client/src/app/cameras/video-wall/` |

**唯一缺失的是"开发模式"**：如何用这些现有能力组合出 MES/EMS 工程。这正是本规格书要交付的。

---

## 2. 数据映射：MES/EMS 概念 → SCADIA 原语

```
MES 概念                  SCADIA 实现
─────────────────────────────────────────────────────────────
工单 (Work Order)        → Device Tag（字符串型，如 "WO-2026-1004-01"）
                          + Script 计算结果写回 Tag
工序 (Operation)         → Tag 集合（planned/completed/wip 三个 tag）
                          + Alarm 定义（质量限、节拍限）
班次 (Shift)             → ScriptScheduling（定时触发）+ Tag 快照
OEE                      → Script 计算（availability × performance × quality）
                          + 结果写回 Tag → 画面绑定 → 报表定时采集
产量计数                 → Device Tag（整型）+ DAQ 历史存储
质量缺陷                 → Alarm（高限）+ Script 统计
设备状态                 → Device Tag（枚举：运行/待机/故障/切换）
                          + ConnectionStatus
能耗计量点               → Device Tag（浮点，kWh/m³/°C）
                          + DAQ 历史存储
峰谷平电价              → Script 常量表 + 时段判断
碳排因子                → Script 常量表 + 能耗 × 因子
报表                     → Report 引擎 + 定时调度（班/日/月）
                          + 数据源 = Tag 历史查询
配方下发                 → Recipe 模板 + 实例
看板画面                 → View（组态画面）+ Navigation 入口
```

---

## 3. 交付物清单

| 序号 | 文件 | 格式 | 用途 |
|------|------|------|------|
| 1 | `mes-ems-template.scadiap` | JSON | 可直接导入 SCADIA 的 MES/EMS 工程模板 |
| 2 | `MES-EMS-开发手册.md` | Markdown | 教用户如何基于模板二次开发 |

---

## 4. `mes-ems-template.scadiap` 结构

### 4.1 顶层键（与现有工程完全兼容）

```json
{
  "version": "1.02",
  "name": "MES-EMS-Template",
  "devices": { /* 见 4.2 */ },
  "hmi": { /* 见 4.3 */ },
  "charts": {},
  "server": { /* 见 4.4 */ }
}
```

### 4.2 `devices` — 数据采集层

**原则**：不新建 Device 类型，用现有 SCADIAServer 内部 tag + 可选 OPC UA/S7 外部设备。

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

### 4.3 `hmi` — 画面 + 导航 + 组态

#### 4.3.1 视图定义（5 个看板画面）

```json
"hmi": {
  "views": [
    {
      "id": "v_mes_dashboard",
      "name": "MES 制造执行看板",
      "profile": { "width": 1920, "height": 1080, "bkcolor": "#FFFFFFFF" },
      "items": { /* 见 4.3.2 */ }
    },
    {
      "id": "v_ems_dashboard",
      "name": "EMS 能源管理看板",
      "profile": { "width": 1920, "height": 1080, "bkcolor": "#FFFFFFFF" },
      "items": { /* 见 4.3.3 */ }
    },
    {
      "id": "v_mes_oee",
      "name": "OEE 分析",
      "profile": { "width": 1920, "height": 1080, "bkcolor": "#FFFFFFFF" },
      "items": { /* 见 4.3.4 */ }
    },
    {
      "id": "v_ems_energy",
      "name": "能耗趋势",
      "profile": { "width": 1920, "height": 1080, "bkcolor": "#FFFFFFFF" },
      "items": { /* 见 4.3.5 */ }
    },
    {
      "id": "v_production_floor",
      "name": "现场画面",
      "profile": { "width": 1920, "height": 1080, "bkcolor": "#FF1A1A1A" },
      "items": { /* 见 4.3.6 */ }
    }
  ],
```

#### 4.3.2 MES 看板画面结构（`v_mes_dashboard`）

```
┌──────────────────────────────────────────────────────────────┐
│  MES 制造执行看板                          2026-10-04 14:00  │
├──────────┬──────────┬──────────┬──────────┬──────────────────┤
│ 今日产量  │ 计划产量  │ 达成率    │ 良品率    │ 当前工单          │
│ 26,870   │ 31,200   │ 86.1%    │ 98.9%    │ WO-2026-1004-03  │
├──────────┴──────────┴──────────┴──────────┴──────────────────┤
│  OEE 分析                                             85.5%  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  可用率 87.2%  ×  性能率 92.4%  ×  合格率 98.9%      │   │
│  └─────────────────────────────────────────────────────┘   │
├──────────────────────────┬───────────────────────────────────┤
│  工单进度                 │  质量指标                         │
│  ┌────┬────┬────┬────┐  │  缺陷数: 267                      │
│  │ 12 │  3 │  4 │  2 │  │  抽检数: 2,700                   │
│  │完成│运行│ QC │待开│  │  缺陷率: 9.89‰                   │
│  └────┴────┴────┴────┘  │                                   │
├──────────────────────────┴───────────────────────────────────┤
│  报警面板                   实时报警 / 历史报警                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 产线温度超限  14:32  高  质量部  已确认               │   │
│  │ 设备状态异常  14:28  紧急 生产部  待处理              │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

#### 4.3.3 EMS 看板画面结构（`v_ems_dashboard`）

```
┌──────────────────────────────────────────────────────────────┐
│  EMS 能源管理看板                          2026-10-04 14:00  │
├──────────┬──────────┬──────────┬──────────┬──────────────────┤
│ 今日用电  │ 今日用水  │ 今日用气  │ 今日用汽  │ 碳排放估算        │
│ 13,272   │ 386      │ 3,200    │ 1,850    │ 8.42 tCO₂        │
│   kWh    │   m³     │   m³     │   kg     │                   │
├──────────┴──────────┴──────────┴──────────┴──────────────────┤
│  24h 能耗曲线                                                  │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  ▃▅▇█▇▆▅▄▄▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃  (kWh)       │     │
│  │  00 04 08 12 16 20                                    │     │
│  └─────────────────────────────────────────────────────┘     │
├──────────────────────────┬───────────────────────────────────┤
│  分项占比                 │  峰谷平统计                       │
│  尖峰  3,192 kWh  24.1%  │  峰时  4,892 kWh  36.9%           │
│  高峰  4,064 kWh  30.6%  │  平时  4,105 kWh  30.9%           │
│  平段  3,916 kWh  29.5%  │  谷时  4,275 kWh  32.2%           │
│  谷电  2,100 kWh  15.8%  │                                   │
└──────────────────────────┴───────────────────────────────────┘
```

#### 4.3.4 OEE 分析画面（`v_mes_oee`）

三列大数字：可用率 / 性能率 / 合格率 → 乘积 = OEE  
下方：24h 趋势图（Chart 组件，数据源 = DAQ 查询）

#### 4.3.5 能耗趋势画面（`v_ems_energy`）

四张趋势图（kWh/水/气/汽 各一张），x 轴 = 24h，y 轴 = 累计值  
数据源 = DAQ 查询 `SELECT dt, value FROM meters WHERE tag_id = 'mes.energy.*'`

#### 4.3.6 现场画面（`v_production_floor`）

SVG 布局图：设备位号 + 状态颜色（绿=运行/灰=待机/红=故障）  
每个设备位 = HtmlSelect 组件，绑定 `mes.equipment.*.status`

#### 4.3.7 Navigation 导航表

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

### 4.4 `server` — 脚本 + 报表 + 配方 + 报警

#### 4.4.1 Scripts（服务端定时计算）

```json
"server": {
  "scripts": [
    {
      "id": "s_oee_calc",
      "name": "OEE 计算",
      "mode": "server",
      "scheduling": {
        "mode": "interval",
        "interval": 60000,
        "schedules": []
      },
      "code": "// ===== OEE 计算 =====\n// 输入: mes.wo.planned, mes.wo.completed, mes.shift\n// 输出: mes.oee.availability, mes.oee.performance, mes.oee.quality, mes.oee.score\n\nconst planned = $getTagValue('mes.wo.planned');\nconst completed = $getTagValue('mes.wo.completed');\nconst defect = $getTagValue('mes.defect.count');\nconst inspected = $getTagValue('mes.defect.inspected');\nconst shiftStart = $getShiftStart(); // 内置函数，返回当前班次开始时间戳\n\n// 可用率 = 运行时间 / 班次时长（这里用完工率近似，真实场景从设备状态 tag 取）\nconst availability = planned > 0 ? Math.min(1, completed / planned) : 0;\n\n// 性能率 = 节拍时间 / 实际节拍（这里用固定节拍 120s 演示）\nconst cycleTime = 120; // 秒/件\nconst actualRate = completed > 0 ? (Date.now() / 1000 - shiftStart) / completed : 0;\nconst performance = Math.min(1, cycleTime / Math.max(cycleTime, actualRate));\n\n// 合格率 = 1 - 缺陷率\nconst defectRate = inspected > 0 ? defect / inspected : 0;\nconst quality = Math.max(0, 1 - defectRate);\n\n// OEE = 三者乘积\nconst oee = availability * performance * quality;\n\n$setTagValue('mes.oee.availability', availability.toFixed(4));\n$setTagValue('mes.oee.performance', performance.toFixed(4));\n$setTagValue('mes.oee.quality', quality.toFixed(4));\n$setTagValue('mes.oee.score', oee.toFixed(4));\n\n// 写 DAQ 历史\n$daqWrite('mes.oee.score', oee);\n$daqWrite('mes.energy.kwh', $getTagValue('mes.energy.kwh'));\n$daqWrite('mes.energy.water', $getTagValue('mes.energy.water'));"
    },
    {
      "id": "s_energy_agg",
      "name": "能耗汇总",
      "mode": "server",
      "scheduling": {
        "mode": "interval",
        "interval": 300000,
        "schedules": []
      },
      "code": "// ===== 能耗汇总 + 碳排计算 =====\n// 峰谷平电价常量\nconst tariff = {\n  peak:    0.8924,  // 元/kWh 尖峰 14:00-19:00\n  normal:  0.6874,  // 元/kWh 平时 8:00-14:00, 19:00-22:00\n  valley:  0.3646   // 元/kWh 谷时 23:00-7:00\n};\n// 碳排因子（kg CO₂/kWh）\nconst carbonFactor = 0.58;\n\nconst kwh = $getTagValue('mes.energy.kwh') || 0;\nconst water = $getTagValue('mes.energy.water') || 0;\nconst gas = $getTagValue('mes.energy.gas') || 0;\nconst steam = $getTagValue('mes.energy.steam') || 0;\n\n// 碳排 = 电 × 碳排因子（水/气/蒸汽简化处理）\nconst carbon = kwh * carbonFactor / 1000; // 吨\n\n$setTagValue('mes.carbon.estimate', carbon.toFixed(2));\n\n// 分时电费（简化：按总电量 × 平均电价）\nconst avgPrice = (tariff.peak + tariff.normal + tariff.valley) / 3;\nconst elecCost = kwh / 1000 * avgPrice;\n$setTagValue('mes.energy.cost', elecCost.toFixed(2));"
    },
    {
      "id": "s_shift_report",
      "name": "班次产量汇总",
      "mode": "server",
      "scheduling": {
        "mode": "scheduling",
        "interval": 0,
        "schedules": [{ "type": 0, "days": [1,2,3,4,5], "time": "08:00", "hour": 8, "minute": 0 }]
      },
      "code": "// ===== 早班产量汇总 =====\nconst completed = $getTagValue('mes.wo.completed') || 0;\nconst planned = $getTagValue('mes.wo.planned') || 0;\nconst defect = $getTagValue('mes.defect.count') || 0;\n\n$log('班次报告: 完工=' + completed + ', 计划=' + planned + ', 缺陷=' + defect);\n// 报表引擎自动采集这些 tag 的历史值，见 Reports 配置"
    }
  ],
```

#### 4.4.2 Alarms（质量 + 能源阈值）

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
      "enabled": true,
      "note": "温度高于 85°C 触发"
    },
    {
      "id": "alm_defect_high",
      "name": "缺陷率超标",
      "deviceId": "dev-mes-tags",
      "tagId": "mes.defect.rate",
      "type": "high",
      "value": 0.05,
      "priority": 2,
      "enabled": true,
      "note": "缺陷率高于 5%"
    },
    {
      "id": "alm_energy_peak",
      "name": "用电超峰",
      "deviceId": "dev-mes-tags",
      "tagId": "mes.energy.kwh",
      "type": "high",
      "value": 15000,
      "priority": 3,
      "enabled": true,
      "note": "单日用电超 15,000 kWh"
    }
  ],
```

#### 4.4.3 Reports（定时报表）

```json
  "reports": [
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
    },
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
  ],
```

#### 4.4.4 Recipes（工艺参数模板）

```json
  "recipes": [
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
  ]
}
```

---

## 5. 画面组态规范

### 5.1 KPI 磁贴（通用组件）

每个 KPI 磁贴 = 一个 `HtmlSelect` + 绑定 tag + 条件颜色：

```
组件类型: HtmlSelect
绑定变量: mes.wo.completed
显示文本: {{value}} 件
条件格式:
  value >= 31000 → 背景 #2E7D32 (绿，达成)
  value >= 28000 → 背景 #1565C0 (蓝，正常)
  value < 28000  → 背景 #C62828 (红，预警)
```

### 5.2 趋势图

```
组件类型: HtmlChart
类型: history
绑定变量: mes.oee.score
时间范围: 最近 24 小时
图表类型: 折线图
Y轴: 0.00 ~ 1.00 (百分比)
```

### 5.3 报警列表

```
组件类型: HtmlChart
类型: alarms
数据源: 当前活跃报警
显示字段: 时间 / 名称 / 优先级 / 状态
```

---

## 6. 脚本 API 参考

SCADIA 服务端脚本运行时提供以下内置函数：

| 函数 | 签名 | 用途 |
|------|------|------|
| `$getTagValue(id)` | `(string) → any` | 读取当前 tag 值 |
| `$setTagValue(id, value)` | `(string, any) → void` | 写入 tag 值 |
| `$daqWrite(id, value)` | `(string, any) → void` | 写入 DAQ 历史存储 |
| `$getShiftStart()` | `() → number` | 返回当前班次开始时间戳（ms） |
| `$log(msg)` | `(string) → void` | 写服务器日志 |

**约束**：
- 脚本超时 = 30 秒
- 无网络访问（`require('http')` 被禁用）
- 无文件系统访问
- 只能操作工程内的 tag

---

## 7. 开发手册结构

### 7.1 快速开始（5 分钟）

1. 打开 SCADIA → 文件 → 打开项目 → 选择 `mes-ems-template.scadiap`
2. 侧栏展开「数据」组 → 进入「制造执行」看板
3. 画面已包含完整 MES 演示数据（固定常量，不依赖后端）
4. 进入「编辑器」→「设备设置」→ 将 `ProductionLine1` 的 enabled 改为 true → 填入真实 PLC 地址
5. 进入「脚本」→ 修改 `s_oee_calc` 中的 cycleTime 为真实节拍时间
6. 进入「报警」→ 按真实阈值调整报警限值

### 7.2 二次开发路径

```
第一步：替换数据源（1-2 小时）
  → 将 SCADIAServer 内部 tag 替换为真实 Device tag
  → 脚本无需改动（$getTagValue 接口不变）

第二步：调整计算逻辑（2-4 小时）
  → 修改 Script 中的 OEE/能耗计算公式
  → 调度间隔按需调整（interval 毫秒）

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

---

## 8. 验收标准（可执行检查）

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

## 9. 禁止事项

| 禁止 | 原因 |
|------|------|
| 新建 `MES_` 或 `EMS_` 前缀的后端文件 | C-1：不改后端代码 |
| 新建 API 路由 `/api/mes/*` | C-2：不新建 API 域 |
| 新建数据库表 | C-3：不新增存储后端 |
| 在 `.scadiap` 中使用 Math.random() | C-4：零随机数 |
| 将模板数据写死到画面组件属性里（应该绑定 tag） | 可维护性 |
| 修改 `runtime/`、`server/`、`client/src/app/_services/` 下任何文件 | C-1 |

---

## 10. 执行清单（给 DeepSeek 的单次任务指令）

```
任务：生成两个文件，放入 D:\vibe coding 2026.1.6\__mes_ems_template\

1. mes-ems-template.scadiap
   - 完整的 SCADIA 工程 JSON 文件
   - 严格遵循第 4 节的结构
   - devices: 1 个 SCADIAServer 内部 tag 表 + 1 个可选的 SiemensS7 外部设备
   - hmi.views: 5 个画面（MES看板/EMS看板/OEE分析/能耗趋势/现场画面）
   - hmi.navigation: 10 个入口，中文字面量
   - server.scripts: 3 个脚本（OEE计算/能耗汇总/班次产量）
   - server.alarms: 3 条报警
   - server.reports: 2 份报表
   - server.recipes: 1 个配方模板
   - 所有数值数据使用固定常量
   - BOM 保留 UTF-8
   - JSON 格式校验通过（无 trailing comma）

2. MES-EMS-开发手册.md
   - 遵循第 7 节结构
   - 包含快速开始 + 二次开发 5 步路径
   - 每个步骤附具体的操作路径（菜单 → 按钮 → 字段名）
   - 包含脚本 API 参考表（第 6 节）
   - 包含验收标准（第 8 节）
   - 语言：中文，Markdown 格式

约束：
- 不修改任何现有 SCADIA 源码文件
- 不调用外部 API
- 不创建子目录结构（两个文件平级）
- JSON 文件使用 2 空格缩进
- 脚本中的 $getTagValue/$setTagValue/$daqWrite/$log 是 SCADIA 内置 API，直接使用
```

---

## 11. 附录 A：脚本编写规范

### A.1 命名约定
```
s_<功能>_<动作>    脚本 ID
<功能>计算         脚本名称
```

### A.2 错误处理
```javascript
const val = $getTagValue('some.tag') || 0; // 防御 null
if (!planned) { $log('跳过：planned 为空'); return; } // 提前返回
```

### A.3 性能约束
- 单次脚本执行 ≤ 30 秒
- DAQ 写入频率 ≤ 1 次/分钟（避免刷库）
- 日志输出 ≤ 10 行/执行

---

## 12. 附录 B：画面组件绑定速查

| 组件 | 绑定目标 | 数据流向 |
|------|----------|----------|
| HtmlSelect（KPI 磁贴） | tag → value | 实时 |
| HtmlChart history | tag + DAQ | 按需查询 |
| HtmlChart alarms | alarm 引擎 | 实时推送 |
| HtmlChart 折线图 | tag + DAQ | 按需查询 |
| HtmlTable | tag 集合 | 实时 |
| Scheduler | 脚本 + 报表 | 定时 |

---

*本规格书为最终版本，执行方 DeepSeek 按 §10 执行清单一次性生成交付物。*
