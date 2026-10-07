# MES / EMS 数据模型
## B2（已批准）：新增工程表 `mes` / `ems`

**版本**：2.0 ｜ **日期**：2026-10-05 ｜ **性质**：只读设计
**证据约定**：`file:line` 相对 `D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\`，行号为本次实际读取。

---

## 0. 脚本 API 的正确名字（**本文件全文只用这一套**）

规格书 §6 写的 `$getTagValue` / `$setTagValue` / `$daqWrite` / `$getShiftStart` / `$log` **在服务端全树零命中**（实测 `grep` 于 `server/`，排除 node_modules/dist → **0 hits**）。已由委托方独立验证。

**真实的系统函数是 15 个，封闭白名单，逐行如下**（`server/runtime/scripts/index.js:235-254`）：

| 函数 | 映射到 | 行 |
|---|---|---|
| **`$getTag(tagId)`** | `runtime.devices.getTagValue` | `:237` |
| **`$setTag(tagId, value)`** | `runtime.devices.setTagValue` | `:238` |
| `$getTagId(tagName, deviceName)` | `runtime.devices.getTagId` | `:239` |
| `$setView(view, force)` | `_setCommandView` | `:240` |
| `$enableDevice` | `runtime.devices.enableDevice` | `:241` |
| `$getDevice` | `runtime.devices.getDevice` | `:242` |
| `$getTagDaqSettings` | `runtime.devices.getTagDaqSettings` | `:243` |
| `$setTagDaqSettings` | `runtime.devices.setTagDaqSettings` | `:244` |
| `$getDeviceProperty` / `$setDeviceProperty` | devices | `:245-246` |
| `$getHistoricalTags` | `runtime.devices.getHistoricalTags` | `:247` |
| `$sendMessage` | notificator | `:248` |
| `$getAlarms` / `$getAlarmsHistory` / `$ackAlarm` | alarms | `:249-251` |

**`$daqWrite` 没有对应物，也不需要。** DAQ 落库是**设备驱动的自动行为**，由**每个 tag 自己的 `daq` 字段**决定：

- `SCADIAServer` 驱动在每个值变化的 tag 上调用 `deviceUtils.tagDaqToSave(data.tags[id], timestamp)`，通过才交给 `this.addDaq`（`server/runtime/devices/scadiaserver/index.js:247-255`）；
- `addDaq` 由共享安装器提供（`scadiaserver/index.js:200-206` → `device-utils.js:162,201`）；
- 驱动读 tag 的 DAQ 开关就是 `data.tags[id].daq`（`scadiaserver/index.js:220-222`）；
- 总开关：`if (runtime.settings.daqEnabled)`（`runtime/devices/index.js:241-248`）。

> **误用后果**：写不存在函数名会抛 `ReferenceError`，但整段 code 被 try/catch 包着（`runtime/scripts/msm.js:113`），catch 只调 `console.log`，而 `console` 是**被替换过的桩**（`msm.js:14`）→ **脚本静默算错的数，无人报警**。

---

## 1. 落表总览

| 表 | `.scadiap` 顶层键 | 行（`name`） | 一行的 `value` |
|---|---|---|---|
| `mes` | `mes` | 对象的 `id` | 该对象的完整 JSON |
| `ems` | `ems` | 对象的 `id` | 该对象的完整 JSON |

**一行一个对象**，照 `recipes` 的模式（`server/runtime/project/index.js:826-833`，`name = recipes[i].id`），加载时逐行 `JSON.parse` 收进数组。得到的收益：**逐条增删改**，且 `setProject()` 分支只需三行。

**不塞进 `server` 键**（那是 server 脚本配置的专属位置，`runtime/project/index.js:807-809` 把它整块当 device 存）、**不塞进 `devices` 键**（那是设备定义，`:780-787`）。

---

## 2. 「来源」列的取值规则（本文件严格遵守）

「来源」列**只允许三种值**：

| 取值 | 含义 | 谁产生 |
|---|---|---|
| `用户输入` | 人在编辑器里填的组态值 | 组态编辑器 |
| `tag: <tagId>` | 从该 tag 读到的**运行期事实** | 现场设备 / 脚本 |
| `脚本: <scriptId>` | 由该脚本**计算产生** | 脚本 |

**不使用**「手动计算」「逻辑判断」「派生」这类模糊来源。

**三个值域纪律**（关系到会不会触发整机重启）：

| 值域 | 住哪 | 为什么 |
|---|---|---|
| 组态值（`用户输入`） | **`mes` / `ems` 表** | 低频改、可重启 |
| 运行期事实（`tag: ...`） | **tag + DAQ** | 高频、**不能**每次写都触发工程保存（`POST /api/project` 会 `runtime.restart(true)`，`server/api/projects/index.js:94-97`） |
| 派生量（比率、率） | **不落任何地方**，界面现算 | 沿用模板既有原则（`client/src/app/mes/mes-board/mes-board.component.ts:19`：「Nothing here is a stored duplicate of another number」） |

---

# MES 侧

## WorkOrder（工单）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 工单号，全局唯一，形如 `WO-20261004-01`。**不得用随机数生成**（C-4） |
| name | string | 是 | 用户输入 | 工单名称，≤128 字符 |
| product | string | 是 | 用户输入 | 产品名称 |
| operationId | string | 是 | 用户输入 | 外键 → `Operation.id` |
| shiftId | string | 是 | 用户输入 | 外键 → `Shift.id` |
| plannedQty | number | 是 | 用户输入 | 计划产量（件），≥0 |
| plannedStart | string | 是 | 用户输入 | 计划开始，**字符串** `"2026-10-04T08:00"` |
| plannedEnd | string | 是 | 用户输入 | 计划结束，**字符串**；须 ≥ `plannedStart` |
| status | string | 是 | 用户输入 | 枚举 `pending/running/paused/qc/done/blocked`，默认 `pending` |
| priority | number | 否 | 用户输入 | 0..9，默认 `5` |
| cycleTimeSec | number | 否 | 用户输入 | 标准节拍（秒/件），默认 `0` |
| note | string | 否 | 用户输入 | 备注，≤512 字符，默认 `""` |
| completedQty | number | 否 | tag: `mes.wo.completed` | 完工数量。**运行期值，不入表**；现场设备写入该 tag |
| scrapQty | number | 否 | tag: `mes.defect.count` | 报废数量。**运行期值，不入表** |
| completionRate | number | 否 | 脚本: `s_oee_calc` | `completedQty / plannedQty`。**派生量，不入表、不进 tag**，界面现算 |

**存档去向**：前 12 行 → `mes` 表；`completedQty`/`scrapQty` → tag `mes.wo.completed` / `mes.defect.count`（`daq` 开启则同时落 DAQ 历史）；`completionRate` → 不存。

---

## Operation（工序）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 工序标识，唯一，形如 `op-cnc` |
| name | string | 是 | 用户输入 | 工序名称 |
| seq | number | 是 | 用户输入 | 工序顺序号，默认 `10` |
| stdCycleSec | number | 是 | 用户输入 | 标准节拍（秒/件），**OEE 性能率的常量来源** |
| idealRatePerHour | number | 否 | 用户输入 | 理论产能（件/小时），默认 `0` |
| equipmentKeys | string[] | 否 | 用户输入 | 关联设备位号字符串数组，默认 `[]` |
| stdCycleMirror | number | 否 | 脚本: `s_oee_calc` | `stdCycleSec` 的 tag 镜像值，读自 `mes.op.stdcycle`；编辑器保存时由 $setTag 写入 |

**存档去向**：前 6 行 → `mes` 表；镜像 → tag `mes.op.stdcycle`。

---

## Shift（班次）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 班次标识，唯一，形如 `shift-a` |
| name | string | 是 | 用户输入 | 班次名称，默认 `"A 班"` |
| startTime | string | 是 | 用户输入 | 开始时刻，**字符串** `"08:00"` |
| endTime | string | 是 | 用户输入 | 结束时刻，**字符串** `"16:00"` |
| crossMidnight | boolean | 否 | 用户输入 | 是否跨零点，默认 `false` |
| breakMinutes | number | 否 | 用户输入 | 班中停机分钟，0..480，默认 `0` |
| currentShiftId | string | 否 | 脚本: `s_shift_boundary` | 当前班次的 id，写入 tag `mes.shift.current` |
| elapsedMin | number | 否 | 脚本: `s_shift_boundary` | 本班已运行分钟，写入 tag `mes.shift.elapsed.min` |

**校验（保存时对整个班次集合做）**：各段 `[start, end)`（`crossMidnight` 时 end += 24h）**互不重叠**，且**分钟数之和 == 1440**。

**存档去向**：前 6 行 → `mes` 表；后 2 行 → tag（`daq` 开启）。

---

## OeeTarget（OEE 目标与结果）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 唯一标识，形如 `oee-line1` |
| scope | string | 是 | 用户输入 | 枚举 `line/station/shift`，默认 `line` |
| scopeId | string | 是 | 用户输入 | 外键 → `Operation.id` 或 `Shift.id` |
| availabilityTarget | number | 否 | 用户输入 | 目标可用率 0..1，默认 `0.90` |
| performanceTarget | number | 否 | 用户输入 | 目标性能率 0..1，默认 `0.95` |
| qualityTarget | number | 否 | 用户输入 | 目标合格率 0..1，默认 `0.99` |
| oeeTarget | number | 否 | 用户输入 | 目标 OEE 0..1，默认 `0.85` |
| availability | number | 否 | 脚本: `s_oee_calc` | 实际可用率，写入 tag `mes.oee.availability` |
| performance | number | 否 | 脚本: `s_oee_calc` | 实际性能率，写入 tag `mes.oee.performance` |
| quality | number | 否 | 脚本: `s_oee_calc` | 实际合格率，写入 tag `mes.oee.quality` |
| score | number | 否 | 脚本: `s_oee_calc` | `availability × performance × quality`，写入 tag `mes.oee.score` |

**存档去向**：前 7 行 → `mes` 表；后 4 行 → tag `mes.oee.*`（`daq` 开启）。

---

## Defect（缺陷类型）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 唯一标识，形如 `defect-01` |
| name | string | 是 | 用户输入 | 缺陷名称 |
| operationId | string | 否 | 用户输入 | 外键 → `Operation.id`，默认 `""` |
| targetRate | number | 否 | 用户输入 | 目标缺陷率上限 0..1，默认 `0` |
| inspectedQty | number | 否 | tag: `mes.defect.inspected` | 抽检数。**运行期值，不入表** |
| defectQty | number | 否 | tag: `mes.defect.count` | 缺陷数。**运行期值，不入表** |
| defectRate | number | 否 | 脚本: `s_oee_calc` | `defectQty / inspectedQty`。**派生量，不存**，界面现算 |

**存档去向**：前 4 行 → `mes` 表；中间 2 行 → tag；`defectRate` → 不存。

---

# EMS 侧（**第二批**，不在第一批交付物内）

## Meter（计量点）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 计量点号，唯一，形如 `MTR-01`。按现有最大序号 +1 生成，**不得用随机数** |
| name | string | 是 | 用户输入 | 计量点名称 |
| mediaId | string | 是 | 用户输入 | 外键 → `Media.id`，默认 `elec` |
| sourceTagId | string | 是 | 用户输入 | 采集该点的真实 tag id（用点位选择对话框选） |
| location | string | 否 | 用户输入 | 安装位置，默认 `""` |
| multiplier | number | 否 | 用户输入 | 变比/倍率，>0，默认 `1` |
| unit | string | 否 | 用户输入 | 单位，默认 `"kWh"` |
| isMain | boolean | 否 | 用户输入 | 是否总表，默认 `false` |
| enabled | boolean | 否 | 用户输入 | 是否参与汇总，默认 `true` |
| currentValue | number | 否 | 脚本: `s_ems_energy_agg` | 当前累计值，写入 tag `ems.meter.<id>.value` |

**存档去向**：前 9 行 → `ems` 表；末行 → tag（`daq` 开启）。

---

## Media（能源介质）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 介质标识，`elec/water/gas/steam/air` 之一 |
| name | string | 是 | 用户输入 | 介质名称 |
| unit | string | 是 | 用户输入 | 单位，默认 `"kWh"` |
| factorId | string | 否 | 用户输入 | 外键 → `CarbonFactor.id`，默认 `""` |
| tariffId | string | 否 | 用户输入 | 外键 → `TariffBand.id`，**仅电有**，默认 `""` |
| totalValue | number | 否 | 脚本: `s_ems_energy_agg` | 该介质当日累计，写入 tag `ems.total.<id>` |
| costValue | number | 否 | 脚本: `s_ems_cost` | 该介质当日费用，写入 tag `ems.cost.<id>` |
| carbonValue | number | 否 | 脚本: `s_ems_carbon` | 该介质当日碳排，写入 tag `ems.carbon.<id>` |

**存档去向**：前 5 行 → `ems` 表；后 3 行 → tag（`daq` 开启）。

---

## TariffBand（电价时段）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 方案标识，唯一，形如 `tariff-2026` |
| name | string | 是 | 用户输入 | 方案名称 |
| effectiveFrom | string | 是 | 用户输入 | 生效日期，**字符串** `"2026-01-01"` |
| currency | string | 否 | 用户输入 | 币种，默认 `"CNY"` |
| bands | object[] | 是 | 用户输入 | 时段明细数组，见下 |
| currentPeriod | string | 否 | 脚本: `s_ems_tariff` | 当前时段键，写入 tag `ems.tariff.period` |
| currentPrice | number | 否 | 脚本: `s_ems_tariff` | 当前电价，写入 tag `ems.tariff.price` |

`bands[]` 每项：

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| periodKey | string | 是 | 用户输入 | 枚举 `sharp/peak/flat/valley`（尖/峰/平/谷），**组内唯一** |
| label | string | 否 | 用户输入 | 显示名，默认 `""` |
| startTime | string | 是 | 用户输入 | 开始时刻，**字符串** `"14:00"` |
| endTime | string | 是 | 用户输入 | 结束时刻，**字符串** `"19:00"`；须 ≠ `startTime` |
| crossMidnight | boolean | 否 | 用户输入 | 是否跨零点，默认 `false` |
| pricePerUnit | number | 是 | 用户输入 | 电价（元/单位），>0 |
| color | string | 否 | 用户输入 | 显示色，`#RRGGBB`，默认 `"#607D8B"` |

**校验（保存时对整套方案做，四条）**：① `periodKey` 互不相同；② `crossMidnight` 处理后各段分钟数之和 == 1440；③ 各段互不重叠；④ `pricePerUnit > 0`。

**存档去向**：`bands` 内嵌在 `ems` 表的一行里；`currentPeriod`/`currentPrice` → tag（`price` 开 `daq`）。

---

## EnergyProfile（单位产品能耗）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 唯一标识，形如 `ue-line1-elec` |
| scopeId | string | 是 | 用户输入 | 外键 → `Operation.id` |
| mediaId | string | 是 | 用户输入 | 外键 → `Media.id` |
| targetPerUnit | number | 否 | 用户输入 | 目标单耗，默认 `0` |
| warnPerUnit | number | 否 | 用户输入 | 预警单耗，默认 `0` |
| baselinePerUnit | number | 否 | 用户输入 | 基线单耗（同比用），默认 `0` |
| actualPerUnit | number | 否 | 脚本: `s_ems_unit` | 实际单耗，写入 tag `ems.unit.<scopeId>.<mediaId>` |

**存档去向**：前 6 行 → `ems` 表；末行 → tag（`daq` 开启）。

---

## CarbonFactor（碳排因子）

| 字段 | 类型 | 必填 | 来源 | 说明 |
|------|------|------|------|------|
| id | string | 是 | 用户输入 | 唯一标识，形如 `cf-elec` |
| name | string | 是 | 用户输入 | 因子名称 |
| mediaId | string | 是 | 用户输入 | 外键 → `Media.id` |
| factor | number | 是 | 用户输入 | 因子值 kgCO₂e/单位 |
| unit | string | 否 | 用户输入 | 单位，默认 `"kgCO2e/kWh"` |
| scope | string | 否 | 用户输入 | 枚举 `"1"`（直接）/ `"2"`（间接），默认 `"2"` |
| source | string | 否 | 用户输入 | 因子出处（标准号/年份），默认 `""` |
| effectiveFrom | string | 否 | 用户输入 | 生效日期，**字符串**，默认 `""` |
| totalCarbon | number | 否 | 脚本: `s_ems_carbon` | 汇总碳排（tCO₂e），写入 tag `ems.carbon.total` |

**存档去向**：前 8 行 → `ems` 表；末行 → tag（`daq` 开启）。

---

# 3. 脚本清单

| 脚本 id | 批次 | 触发 | 读（`$getTag`） | 写（`$setTag`） |
|---|---|---|---|---|
| **`s_oee_calc`** | **第一批** | interval 60s | `mes.wo.planned`, `mes.wo.completed`, `mes.defect.count`, `mes.defect.inspected`, `mes.op.stdcycle`, `mes.equip.downtime.min`, `mes.shift.elapsed.min` | `mes.oee.availability`, `mes.oee.performance`, `mes.oee.quality`, `mes.oee.score` |
| **`s_shift_boundary`** | **第一批** | interval 60s | `mes.shift.<id>.start`, `mes.shift.<id>.end` | `mes.shift.current`, `mes.shift.elapsed.min` |
| `s_ems_energy_agg` | 第二批 | interval 300s | `ems.meter.<id>.value` × N | `ems.total.<media>` |
| `s_ems_tariff` | 第二批 | interval 60s | `ems.tariff.<periodKey>.price` | `ems.tariff.period`, `ems.tariff.price` |
| `s_ems_cost` | 第二批 | interval 300s | `ems.total.*`, `ems.tariff.price` | `ems.cost.<media>` |
| `s_ems_carbon` | 第二批 | interval 300s | `ems.total.*`, `ems.carbon.factor.*` | `ems.carbon.<media>`, `ems.carbon.total` |
| `s_ems_unit` | 第二批 | interval 300s | `ems.meter.<id>.value` × N, `mes.wo.completed` | `ems.unit.<scopeId>.<mediaId>` |

### `s_oee_calc` 完整口径（**只用真 API**）

```js
// 输入
const planned     = $getTag('mes.wo.planned')         || 0;
const completed   = $getTag('mes.wo.completed')       || 0;
const defect      = $getTag('mes.defect.count')       || 0;
const inspected   = $getTag('mes.defect.inspected')   || 0;
const downtimeMin = $getTag('mes.equip.downtime.min') || 0;
const runMin      = $getTag('mes.shift.elapsed.min')  || 0;
const cycleSec    = $getTag('mes.op.stdcycle')        || 0;

// 计算
const effMin = Math.max(0, runMin - downtimeMin);
const availability = runMin > 0 ? effMin / runMin : 0;
const performance  = effMin > 0 && cycleSec > 0
    ? Math.min(1, (completed * cycleSec / 60) / effMin) : 0;
const quality = inspected > 0 ? Math.max(0, (inspected - defect) / inspected) : 0;
const score   = availability * performance * quality;

// 输出（DAQ 由这些 tag 自己的 daq 配置自动落库，不需要 $daqWrite）
$setTag('mes.oee.availability', availability);
$setTag('mes.oee.performance',  performance);
$setTag('mes.oee.quality',      quality);
$setTag('mes.oee.score',        score);
```

**手算自检**：`score` 必须等于三个分量之积，且 `planned` 只参与界面的达成率、**不参与 OEE**（规划量与 OEE 无关，只有 `completed` 进性能率）。

---

# 4. 待裁决项

| # | 事项 | 事实 | 建议 |
|---|---|---|---|
| **V-1** | 规格书 §6 的 `$getTagValue` / `$setTagValue` / `$daqWrite` / `$getShiftStart` / `$log` 不存在 | 全树 0 命中；真名见 §0 | **本文件已按真名写**；规格书 §6 那张表需作废重写 |
| **V-2** | `mes`/`ems` 对**访客**可见 | `_filterProjectPermission` 只过滤 `devices/scripts/hmi.layout.*/hmi.views[].items`（`runtime/project/index.js:1171-1250`），**不删顶层键** | 接受（与 `recipes` 同级）；若须保密 → 必须改权限过滤器 → **与「只加分支」冲突** |
| **V-3** | 没建独立 `Equipment`（设备台账）表 | OEE 的 `scope` 只能到 line/station/shift | 若客户要按设备算 OEE，需增第三张表 |
| **V-4** | 镜像 tag 必须在工程里预先存在 | `SCADIAServer.setValue` 对未知 id 直接 `return false`（`scadiaserver/index.js:169-178`），**静默失败**；而新增 tag 属于改设备定义，不在本次「只加分支」范围内 | 第一批用固定 tag 集 + 数量上限 |
| **V-5** | C-4「零随机数」的适用范围 | 规格书 §9 原文只管 `.scadiap`；客户端源码里已有 5 处 `Math.random()`（`_models/script.ts:273,294`、`recipe-editor.component.ts:66`、`html-recipe.component.ts:503`、`_helpers/utils.ts:197,209`） | 明确：**新代码 0 处**；`Utils.getGUID()` 不可用于新界面 |
