# 交付计划
## 最小切片 + P1 产物命运

**版本**：2.0 ｜ **日期**：2026-10-05 ｜ **性质**：只读设计
**证据约定**：`file:line` 相对 `D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\`，行号为本次实际读取。

---

## 1. 批次划分（委托方指定）

| 批次 | 交付物 |
|---|---|
| **第一批** | ① `mes.workOrders` 表 **+** 工单模板编辑器 **+** MES 看板；② OEE 脚本 **`s_oee_calc`** 绑定 workOrders 数据 |
| **第二批** | **EMS 全部**（`ems` 表的界面 + 五个 EMS 脚本）；另补 MES 的 `Operation`/`Shift`/`OeeTarget`/`Defect` 编辑器 |

**「EMS 放第二批，不在第一批交付物里」的执行口径：**

| 项 | 第一批做不做 |
|---|---|
| `ems` **表本身**（`TableType.EMS` / `CREATE TABLE ems` / `setProject()` 的 `ems` 分支 / `SetEms`/`DelEms`） | ⚠️ **要做** —— 理由是它和 `mes` 是**同一批 SQL、同一个 if/else 链、同一组枚举**（`prjstorage-changes.md` §2-§6 全部是一处改动）。分批做要**改两次同一个函数**，且会破坏 `enumContractSync.test.js` 的两侧同步（一次只加一侧 = 门禁红） |
| `ems` **的界面**、EMS 五个脚本、EMS 看板接线 | ❌ **不做**，全在第二批 |

> `ems` 表建好后是空的（`[]`），`setProject()` 的 `ems` 分支遇空数组直接跳过——**零运行成本**。若委托方坚持连表都不建，则 `TableType`/`_bind()`/`setProject()`/`setProjectData()` 要再动一次，**这与「不改现有分支」的边界精神一致但成本更高**，请明确。

---

## 2. 第一批的逐项定义

### 2.1 交付物清单

| # | 交付物 | 类型 | 依据 |
|---|---|---|---|
| S1-1 | `prjstorage.js` 三处：`TableType` +2、`_bind()` +2、`clearAll()` +2 | 后端 | `prjstorage-changes.md` §2-§4 |
| S1-2 | `project/index.js` 五处：`ProjectDataCmdType` +4、`setProjectData()` 分支 +4、`setMes`/`removeMes`/`setEms`/`removeEms`、`getMes()`/`getEms()`、`load()` step 9/10、exports +2 | 后端 | `prjstorage-changes.md` §5-§7 |
| S1-3 | `ProjectData` 加 `mes`/`ems`；新增 `_models/mesems.ts` | 客户端模型 | §9 |
| S1-4 | `/mes` 外包 `mat-tab-group`，加「工单模板」tab | 客户端页面 | `editor-drafts.md` §0.2 / E1.1 |
| S1-5 | `MesWorkorderListComponent` + `MesWorkorderEditorComponent` | 客户端组件（新） | `editor-drafts.md` E1 |
| S1-6 | 脚本 **`s_oee_calc`**（+ `s_shift_boundary`，见 §2.4） | 脚本（工程数据） | `data-model.md` §3 |
| S1-7 | **MES 看板**：新增「实时看板」tab，`WorkOrder` 列表 + OEE 四值来自工程数据/tag | 客户端组件（新） | §2.3 |
| S1-8 | `mes-ems-template.scadiap` 降级为样例工程（**3 个工单 + 3 个班次**） | 数据文件 | §3 |

### 2.2 S1 的 `mes` 表初始内容（**3 个工单 + 3 个班次**）

> 委托方指定：模板**只保留示范数据结构（3 个工单、3 个班次）**。`Operation` 必须同时存在——`WorkOrder.operationId` 是必填外键（`data-model.md` → `WorkOrder`），编辑器要能列出工序。**取 3 个工序，与 3 个工单一一对应。**

```jsonc
"mes": [
  // ── 工序（3）──────────────────────────────────────────────
  { "kind": "operation", "id": "op-cnc",  "name": "机加工", "seq": 10, "stdCycleSec": 120,
    "idealRatePerHour": 30, "equipmentKeys": [] },
  { "kind": "operation", "id": "op-press","name": "压装",   "seq": 20, "stdCycleSec": 90,
    "idealRatePerHour": 40, "equipmentKeys": [] },
  { "kind": "operation", "id": "op-assy", "name": "装配",   "seq": 30, "stdCycleSec": 150,
    "idealRatePerHour": 24, "equipmentKeys": [] },

  // ── 班次（3）──────────────────────────────────────────────
  { "kind": "shift", "id": "shift-a", "name": "A 班",
    "startTime": "08:00", "endTime": "16:00", "crossMidnight": false, "breakMinutes": 30 },
  { "kind": "shift", "id": "shift-b", "name": "B 班",
    "startTime": "16:00", "endTime": "00:00", "crossMidnight": false, "breakMinutes": 30 },
  { "kind": "shift", "id": "shift-c", "name": "C 班",
    "startTime": "00:00", "endTime": "08:00", "crossMidnight": false, "breakMinutes": 30 },

  // ── 工单（3）──────────────────────────────────────────────
  { "kind": "workOrder", "id": "WO-20261004-01", "name": "示范工单 1",
    "product": "产品A", "operationId": "op-cnc",  "shiftId": "shift-a",
    "plannedQty": 2400, "plannedStart": "2026-10-04T08:00", "plannedEnd": "2026-10-04T16:00",
    "status": "done",    "priority": 5, "cycleTimeSec": 120, "note": "" },
  { "kind": "workOrder", "id": "WO-20261004-02", "name": "示范工单 2",
    "product": "产品B", "operationId": "op-press","shiftId": "shift-b",
    "plannedQty": 3200, "plannedStart": "2026-10-04T16:00", "plannedEnd": "2026-10-05T00:00",
    "status": "running", "priority": 3, "cycleTimeSec": 90,  "note": "" },
  { "kind": "workOrder", "id": "WO-20261004-03", "name": "示范工单 3",
    "product": "产品C", "operationId": "op-assy", "shiftId": "shift-c",
    "plannedQty": 1600, "plannedStart": "2026-10-05T00:00", "plannedEnd": "2026-10-05T08:00",
    "status": "pending", "priority": 1, "cycleTimeSec": 150, "note": "" }
]
```

**全部是固定常量**（C-4）：三份截图一致，任何数字可手算。`kind` 字段见 `editor-drafts.md` §E1.6。

### 2.3 MES 看板接线（S1-7）

**现状（实测）**：`client/src/app/mes/mes-board/mes-board.component.ts` **全部是 `readonly` 常量**（`:28-138`），注释写明这是刻意的（`:6-11`：「A READ-ONLY DEMO BOARD ... every number below is a fixed constant」）。

**委托方要求**：「MES 看板」在第一批里，且模板**不再有硬编码的 readonly 值，数据从工程文件加载**。

**因此：**

| | 处置 |
|---|---|
| `MesBoardComponent`（现有） | **保留不动**——它是既有演示资产，全常量、可复现。**但它在第一批交付物里的角色变了**：不再是「MES 看板」，而是「画面模板的示例」。 |
| **新增** `MesWorkorderBoardComponent`（第一批交付物里的「MES 看板」） | **新组件**，放在 `/mes` 的「实时看板」tab。它：① 从 `projectData.mes` 读 `WorkOrder` 列表并按 `status` 分组/着色；② OEE 四个值从 **tag** 读（`mes.oee.availability` 等）；③ `completedQty`/`scrapQty` 从 **tag** 读；④ 达成率/进度等**派生量现算**，不存。 |

**为什么不是改 `MesBoardComponent`**：改了它，那份「两份截图必须一致」的演示数据就没了（C-4 的初衷），而它正是 P1 产物要降级保留的部分（§3）。**新开一个 tab 是两全。**

### 2.4 脚本清单（第一批）

| 脚本 | 必需性 | 读（`$getTag`） | 写（`$setTag`） |
|---|---|---|---|
| **`s_oee_calc`** | ✅ **委托方点名** | `mes.wo.completed`, `mes.defect.count`, `mes.defect.inspected`, `mes.op.stdcycle`, `mes.equip.downtime.min`, `mes.shift.elapsed.min` | `mes.oee.availability`, `.performance`, `.quality`, `.score` |
| `s_shift_boundary` | ⚠️ 建议同批 | `mes.shift.a.start`/`.end`、`mes.shift.b.*`、`mes.shift.c.*` | `mes.shift.current`, `mes.shift.elapsed.min` |

**`s_oee_calc` 的完整代码**（只用真 API：**`$getTag` / `$setTag`**；**不出现 `$getTagValue` / `$setTagValue` / `$daqWrite`**）：

```js
// OEE = availability x performance x quality
// 输入全部来自 tag（表的值经「下发」镜像成 tag；脚本读不到工程表）
var completed   = $getTag('mes.wo.completed')       || 0;
var defect      = $getTag('mes.defect.count')       || 0;
var inspected   = $getTag('mes.defect.inspected')   || 0;
var downtimeMin = $getTag('mes.equip.downtime.min') || 0;
var runMin      = $getTag('mes.shift.elapsed.min')  || 0;
var cycleSec    = $getTag('mes.op.stdcycle')        || 0;

var effMin = Math.max(0, runMin - downtimeMin);
var availability = runMin > 0 ? effMin / runMin : 0;
var performance  = (effMin > 0 && cycleSec > 0)
    ? Math.min(1, (completed * cycleSec / 60) / effMin) : 0;
var quality = inspected > 0 ? Math.max(0, (inspected - defect) / inspected) : 0;
var score = availability * performance * quality;

$setTag('mes.oee.availability', availability);
$setTag('mes.oee.performance',  performance);
$setTag('mes.oee.quality',      quality);
$setTag('mes.oee.score',        score);
```

**DAQ 落库**：由 `mes.oee.*` 这四个 tag 自己的 `daq` 字段控制（`server/runtime/devices/scadiaserver/index.js:247-255`、`:220-222`），**不需要 `$daqWrite`（该函数不存在）**。

**`s_shift_boundary` 的降级选项**：若要把第一批压到最小，可先**不写这个脚本**，把 `mes.shift.elapsed.min` 手工设成常数（8h − 30min = 450）。**代价**：可用率在那之前是半静态的。**建议写**——约 30 行，没有它 OEE 不可信。

### 2.5 「OEE 脚本绑定 workOrders 数据」怎么落地

委托方原话是「OEE 脚本 `s_oee_calc` 绑定 workOrders 数据」。**这里的「绑定」必须说清机制**，因为脚本拿不到工程表：

```
mes 表（WorkOrder.cycleTimeSec / Operation.stdCycleSec）
   │  编辑器保存后「下发」，POST /api/runSysFunction { functionName:'$setTag' }
   ▼
tag  mes.op.stdcycle             （tag 是表的镜像）
   │  $getTag
   ▼
脚本 s_oee_calc  ──$setTag──▶  mes.oee.*  ──▶  DAQ 历史  ──▶  看板 / 报表
```

**「绑定」= 表 → tag 的镜像 + 脚本读 tag。** 不是脚本直接读表（那需要一个不存在的系统函数，见 `data-model.md` §0）。

**第一批的实际绑定面极小**：只有 **`Operation.stdCycleSec` → `mes.op.stdcycle`** 一个值需要下发。班次的 start/end 由 `s_shift_boundary` 用（§2.4）。

### 2.6 第一批验收（可机械检查）

| # | 检查 | 方法 | 通过标准 |
|---|---|---|---|
| 1 | 两张表建出来了 | `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mes','ems')` | 2 行 |
| 2 | `mes` 能被导入 | 拖入样例工程 → `GET /api/project` | 响应含 `mes`，**9 条**（3 工序 + 3 班次 + 3 工单） |
| 3 | **重启后仍在** | 重启服务 → `GET /api/project` | `mes` 仍 9 条 |
| 4 | **不残留** | 再导入一份**只有 1 条**的 `.scadiap` → `GET /api/project` | `mes` 恰好 1 条（证明 `clearAll()` 补了 `DELETE`） |
| 5 | 单条命令能用 | `POST /api/projectData {cmd:'set-mes',data:{kind:'workOrder',id:'WO-X',...}}` | 表里多一行 |
| 6 | 单条删除能用 | `POST /api/projectData {cmd:'del-mes',data:{id:'WO-X'}}` | 表里少一行 |
| 7 | 界面能增删改 | `/mes` → tab「工单模板」→ 新增/编辑/删除 → F5 | 三项都持久 |
| 8 | 校验生效 | 填 `WO-1` → 确定 | 被拒并提示格式 |
| 9 | OEE 可手算 | 手工 `$setTag('mes.wo.completed', 1800)` → 等下周期 | `mes.oee.score` == `availability × performance × quality`，手算一致 |
| 10 | **脚本用真名** | grep 脚本源码 `$getTagValue|$setTagValue|$daqWrite` | **0 命中** |
| 11 | 零随机数 | grep 新增文件 `Math.random` | 0 命中 |
| 12 | 门禁 | 跑 `test/storage/*`、`test/architecture/*`、`test/project/*` | 对照 `prjstorage-changes.md` §11.0 逐条核对；**未读的守卫（§11.6）此时补测** |
| 13 | 无新 API 域 | `ls server/api/` | 目录数不变 |

### 2.7 依赖顺序

    S1-1/2/3  后端三件 ──→ [验收 1-6]      ← 生死线，先做
            ↓
    S1-8  样例工程 ────→ [验收 2]          （可与上并行）
            ↓
    S1-5  工单模板编辑器 ──→ [验收 7、8]
            ↓
    S1-6  s_oee_calc ───→ [验收 9、10]
            ↓
    S1-7  实时看板 tab ──→ （最后）

**后端三件是唯一硬前置。** 它们不通，后面全部作废。

### 2.8 工作量（相对量）

| 项 | 相对量 | 说明 |
|---|---|---|
| S1-1/2/3 | **小** | 约 +154 行、6 处插入 + 1 处标点 |
| S1-8 | 小 | 改一个 JSON 文件 |
| S1-5 | **大** | 列表 + 对话框两组件，是第一批主体 |
| S1-4 | 小 | 一次页面外壳改造 |
| S1-6 | 中 | `s_oee_calc` + `s_shift_boundary`，各 30-40 行 |
| S1-7 | 中 | 一个新看板组件 |
| 验收 | 中 | 13 项，1-6 需起服务 |

---

## 3. P1 产物的命运：`__mes_ems_template\mes-ems-template.scadiap`

### 3.1 结论

> **降级为「B 能力的样例工程」。** 不再有硬编码的 readonly 值，数据从工程文件加载；模板只保留**示范数据结构（3 个工单、3 个班次）**，用户复制后可直接在编辑器里改。

### 3.2 「降级」的三条具体含义

| # | 含义 | 现状 | 降级后 |
|---|---|---|---|
| 1 | **业务数字从「组件常量」搬到「工程文件」** | `mes-board.component.ts:28-138` 里 13 组 `readonly` 常量 | 这些数字属于**画面模板的示例**；**业务数据的权威源是 `mes` 表**。看板组件新增的那个从 `projectData.mes` + tag 取数 |
| 2 | **工程文件自带示范数据** | 无 `mes` 键 | `mes` 有 **9 条**（§2.2：3 工序 + 3 班次 + 3 工单） |
| 3 | **用户复制即可改** | 改数据要改代码 | 改数据在**编辑器里改**（`editor-drafts.md` E1） |

### 3.3 现有 `mes-ems-template.scadiap` 的 4 处收敛

上一版设计（`__route_b_design.md` §5）的清单，依然有效，另加 B2 的新键：

| # | 改动 | 为什么 | 依据 |
|---|---|---|---|
| **M1** | 顶层加 `mes` / `ems` 两个数组（`mes` 按 §2.2 填 9 条，`ems` 为空 `[]`） | B2 的落点 | `prjstorage-changes.md` §5 |
| **M2** | **删除 `server` 下的 `scripts`/`alarms`/`reports`/`recipes` 四个重复块** | **死数据**：`server` 键整块被当作一个 device 存进 DEVICES 表（`server/runtime/project/index.js:807-809`），`server.scripts` 等**永不被读取**；真正生效的是**顶层**四个键（`:842-857`） | 实测：产物里 `server.scripts(3)` 与顶层 `scripts(3)` 内容重复，`server.alarms(3)`/`reports(2)`/`recipes(1)` 同理 |
| **M3** | `scripts[].mode` 由 `"server"` 改成 `"SERVER"` | 客户端枚举是 `ScriptMode.SERVER = 'SERVER'`（`client/src/app/_models/script.ts:339-342`）；现在靠 `!= 'CLIENT'`（`runtime/scripts/index.js:209`）侥幸能跑，但任何 `=== 'SERVER'` 比较会**静默失效** | 实测产物 `scripts[0].mode === "server"` |
| **M4** | `server.id` 由数字 `0` 改成字符串 `"0"` | 平台默认是字符串（`runtime/project/prjstorage.js:105`）；JS 对象键会强转所以**无功能影响**，但类型应与平台一致 | 实测产物 `"id":0` |

### 3.4 第二批顺手做的 3 处

| # | 改动 | 依据 |
|---|---|---|
| M5 | 删除顶层重复的 `hmi.navigation` | 客户端只读 `hmi.layout.navigation`（`client/src/app/_models/hmi.ts:51`、`home.component.ts:309-310,365`）；顶层那份会被 `setProject()` 的 `hmi.<非 views 键>` 分支存进 GENERAL 表（`runtime/project/index.js:801-804`），是死数据 |
| M6 | 核对我报的 `content.items` 与 `runtime/reporting/contract.js:24-91` 一致 | 现有产物已用 `type:"table"` / `function:"sum"` / `range` / `interval`，**已正确**，只需核对 |
| M7 | 核对报警的 `ackmode` 值 | 客户端 `AlarmAckMode` 的值是 **i18n key**（`client/src/app/_models/alarm.ts:84-88`：`float = 'alarm.ack-float'` 等），产物写的是 `'ackactive'`/`'float'` 裸串。**未验证是否有比较依赖它**——记为待查 |

### 3.5 降级**不是重做**

现有产物的 **5 个画面**（`v_mes_dashboard` / `v_ems_dashboard` / `v_mes_oee` / `v_ems_energy` / `v_production_floor`）、**30 个 tag**、**3 个脚本**、**3 条报警**、**2 份报表**全部保留。降级只做两件事：**顶层挂上 `mes`/`ems`** + **清掉 M2/M3/M4 三处死数据与类型问题**。

**实测产物里画面是对的**：`hmi.layout.navigation` 存在且与客户端枚举**键**一致（`mode:"fix"` / `type:"inline"`，对应 `client/src/app/_models/hmi.ts:114-126`，而 `home.component.ts:309` 正是按键取值）；视图元件用的是正确的 TypeTag（`"svg-ext-html_select"`，对应 `client/src/app/gauges/controls/html-select/html-select.component.ts:17`）。

---

## 4. 交付顺序总图

    ┌─ 第一批 ──────────────────────────────────────────────────┐
    │ 1. prjstorage.js 三处（TableType/_bind/clearAll）          │
    │ 2. project/index.js 五处（命令枚举/setProjectData/读写路径）│  ← 生死线
    │ 3. ProjectData + mesems.ts                                 │
    │ 4. mes-ems-template.scadiap 降级（M1-M4 + 9 条示范数据）    │
    │ 5. 工单模板编辑器（列表 + 对话框）   ← 第一批主体            │
    │ 6. /mes 加 tab「工单模板」                                  │
    │ 7. s_oee_calc（+ s_shift_boundary）                        │
    │ 8. /mes 加 tab「实时看板」                                  │
    └────────────────────────────────────────────────────────────┘
                              ↓
    ┌─ 第二批 ──────────────────────────────────────────────────┐
    │ 9.  EMS 五个脚本（能耗/电价/费用/碳排/单耗）                │
    │ 10. 计量点编辑器 / 电价时段编辑器                          │
    │ 11. 班次 / 工序 / OEE 目标 / 缺陷类型 / 介质 / 单耗 / 因子   │
    │ 12. /ems 加 tab                                            │
    │ 13. 模板补 M5-M7                                          │
    └────────────────────────────────────────────────────────────┘

---

## 5. 每批次的红线

| 批次 | 红线 |
|---|---|
| **第一批** | 后端改动**只在 `prjstorage.js` 与 `project/index.js` 两文件内插入**；不新建文件、不新建目录、不加 API 路由、不改 DAQ/存储契约 |
| **第一批** | 脚本一律用 **`$getTag` / `$setTag`**；**不得出现 `$getTagValue` / `$setTagValue` / `$daqWrite` / `$getShiftStart` / `$log`**（这些在 `server/` 全树 0 命中）。DAQ 靠 tag 的 `daq` 字段 |
| **第一批** | 新代码 **0 处 `Math.random()`**、**0 处 `Utils.getGUID()`** |
| **第一批** | `ProjectDataCmdType` 两侧**各加 4 个成员，同名同值**；这四行**不得带行内注释**（`enumContractSync.test.js:77` 的行正则不允许标识符与冒号之间有注释） |
| **第一批** | 不往 `server` 键、`devices` 键里塞 MES/EMS |
| **第一批** | 不新增客户端路由（配置界面挂在已存在的 `/mes` `/ems` 的 tab 里） |
| **第二批** | 同上；另加：`ems` 的界面不得新增路由；EMS 脚本沿用同一套真 API |

---

## 6. 与 `25_模块总览.md §7.1.1` 的措辞对齐

委托方在账本里写定的口径（`20_代码进度.md:6044`）：

> MES/EMS **仍不作为后端子系统、仍不加 API 域**，但**数据模型上升到平台级（工程内可组态的表）**。

| 口径 | 本设计的对应事实 |
|---|---|
| 不作为后端子系统 | 不新建 `runtime/mes/` / `runtime/ems/` 目录；不新建 `*storage.js`；不加任何 `api/` 目录 |
| 不加 API 域 | `server/api/` 零改动；读写走既有的 `GET /api/project`、`POST /api/project`、`POST /api/projectData`（`server/api/projects/index.js:31,86,114`）与 `POST /api/runSysFunction`（`server/api/scripts/index.js:63`） |
| 数据模型上升到平台级 | `TableType.MES` / `TableType.EMS` 与 `RECIPES`/`REPORTS`/`SCRIPTS` 同级；`setProject()` 的 `mes`/`ems` 分支与 `recipes` 分支同形 |

---

## 7. 待裁决（影响第一批能否开工）

| # | 事项 | 不裁决的后果 |
|---|---|---|
| **V-1** | `ems` 表要不要与 `mes` 同批建（§1） | 若否，`TableType`/`_bind()`/`setProject()`/`setProjectData()` 要动两次，且 `enumContractSync` 的两侧同步会被拆成两次 |
| **V-2** | `mes` 数组里要不要 `kind` 判别字段（`editor-drafts.md` §E1.6） | 不加则列表组件只能按字段形状猜，**脆弱** |
| **V-3** | `clearAll()` 补两条 `DELETE` 是否在批准边界内（`prjstorage-changes.md` §4） | 不加则**每次导入工程旧 MES 数据残留** |
| **V-4** | MES 看板取「新开实时看板 tab」还是「改写 `mes-board`」（§2.3） | 改写会毁掉那份可复现的演示资产 |
| **V-5** | `mes`/`ems` 对**访客**可见（`_filterProjectPermission` 不删顶层键，`runtime/project/index.js:1171-1250`） | 若须保密 → 必须改权限过滤器 → **与「只加分支」冲突** |
| **V-6** | `test/architecture/reverse-baseline.js:81` 为何列了 `'runtime/project/index.js'` —— **本次未读该文件全文，不下结论** | 实现前需读一遍 |
| **V-7** | 第一批镜像 tag 的数量上限（`editor-drafts.md` §0.6） | `$setTag` 对未知 tag **静默失败**（`scadiaserver/index.js:169-178`） |

---

## 8. ⚠️ 本设计成文期间，工作树是**活的**（已实测）

08:34–08:38 期间**另一个会话改了同一棵树**，实测到 5 个文件变动，其中 2 个与本设计同域：

| 文件 | 变动 |
|---|---|
| `server/runtime/storage/databases.js` | `DOMAIN_DB_FILES` 从 8 域 → **9 域**（新增 `notifications`，现 `:74-84`） |
| `server/test/storage/domainDatabaseFiles.test.js` | `DOMAIN_STORES` 同步加第 9 项（现 `:34-44`） |
| `server/runtime/notificator/notifications-storage.js` | **新增**（`:49` 调 `storage.resolveDbFile(...,'notifications',...)`） |
| `server/runtime/notificator/index.js` | 接线 |
| `server/_p0probe/notificationFlow.js` | 新增探针 |

**对本设计的影响：零。核对结果写在 `prjstorage-changes.md` §11.4b**，而且它**当场验证了本设计的两条机制论证**——
① 新增一个 `*storage.js` 文件必须同时改 `databases.js` 与 `domainDatabaseFiles.test.js`（三处一起变才不红）；**本设计一个新 `*storage.js` 都不建，所以三处一个都不动**；
② 那个新模块**没有**自己 `require('sqlite3')`，而是走 `storage.resolveDbFile` + `storage.open` —— 与「本设计只用 `prjstorage` 已有句柄」是同一条规矩。

**给实现者的硬要求**：开工前**重新读一遍**这 5 个文件的最终状态，并重新确认 `runtime/` 下 `require('sqlite3')` 的模块仍是精确的三个（`storage/sqlite/index.js:13`、`storage/databases.js:17`、`storage/sqlite/currentstorage.js:5`）。**这棵树是活的，本文件的每个行号都有保鲜期。**
