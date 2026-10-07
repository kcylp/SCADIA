# 组态界面草案
## 4 个编辑器 —— 照「配方列表 + 配方编辑器」的模式

**版本**：2.0 ｜ **日期**：2026-10-05 ｜ **性质**：只读设计
**证据约定**：`file:line` 相对 `D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\`，行号为本次实际读取。

---

## 0. 统一架构

### 0.1 批次划分

| 编辑器 | 实体 | 批次 |
|---|---|---|
| **E1 工单模板** | `WorkOrder` | **第一批** |
| E2 班次配置 | `Shift` | 第二批 |
| E3 计量点配置 | `Meter` | 第二批 |
| E4 电价时段 | `TariffBand` | 第二批 |

（MES 侧还有 `Operation` / `OeeTarget` / `Defect`，EMS 侧还有 `Media` / `EnergyProfile` / `CarbonFactor`，都复用 E1 的骨架，随第二批或更后。）

### 0.2 落点：**不新开路由**

配置界面挂在 **`/mes`** 与 **`/ems`** 两个**已存在**的路由上，做成标签页：

- `client/src/app/app.routing.ts:55-56` 已有 `{ path: 'mes', component: MesBoardComponent }` 与 `{ path: 'ems', component: EmsBoardComponent }`
- 两者已在默认导航里：`client/src/app/_models/default-navigation.ts:69-70`

**不新增客户端路由**的理由：新增路由要**同时**改 `app.routing.ts:35-70` 与 `server/main.js` 的 `SHELL_ROUTES`（`:485` 起），门禁 `test/architecture/spaRoutesCompleteness.test.js:99-119` 要求两表**等长、不重复**。规避掉最省事。

    /mes  →  <mat-tab-group>
              ├─ tab「看板」      → <app-mes-board>            （已有，不动）
              └─ tab「工单模板」   → <app-mes-workorder-list>    （新）   ← 第一批
          第二批补：tab「工序」/「班次」/「OEE 目标」/「缺陷类型」/「实时看板」
    /ems  →  <mat-tab-group>
              ├─ tab「看板」      → <app-ems-board>            （已有，不动）
              ├─ tab「计量点」     → <app-ems-meter-list>        （新）   ← 第二批
              └─ tab「电价时段」   → <app-ems-tariff-list>       （新）   ← 第二批

### 0.3 组件骨架：完全照配方

配方是**两件组件对一个概念**：一个列表 + 一个对话框编辑器。

| 配方侧 | 行号 | MES/EMS 侧（照抄） |
|---|---|---|
| `RecipeListComponent`，`displayedColumns` 常量 | `recipes/recipe-list/recipe-list.component.ts:22` | `MesWorkorderListComponent` 等 |
| `dataSource = new MatTableDataSource<any>([])` + `@ViewChild(MatSort)` | `:23,27` | 同 |
| 列表 HTML：`mat-table` + 每列 `ng-container matColumnDef` + `sticky` 表头 | `recipes/recipe-list/recipe-list.component.html:11-90` | 同 |
| 空态 `*ngIf="!loading && dataSource.data.length === 0"` | `:92-95` | 同 |
| 右下角浮动新增 `mat-fab` | `:99-101` | 同 |
| 删除确认 `ConfirmDialogComponent` | `:94-114` | 同 |
| `MatDialog.open(Editor,{width:'980px',disableClose:true,data:{...}})` | `:67-78`、`:80-92` | 同 |
| 编辑器表单 `UntypedFormBuilder` + `mat-dialog-title/content/actions` | `recipes/recipe-editor/recipe-editor.component.ts:36-39`、`.html:1-80` | 同 |
| 内嵌子表 `<table mat-table>` + `[(ngModel)]="row.f" [ngModelOptions]="{standalone:true}"` | `recipe-editor.component.html:28-65`（值输入 `:48-49`） | **E4 电价时段直接用这个** |

### 0.4 保存通道（**与配方不同：走单条命令，不整工程 POST**）

**配方是怎么存的**：`RecipeService` → `POST /api/recipes/types` → `runtime.project.setProjectData(SetRecipe, data)`（`server/api/recipes/index.js:673`）。**不是整工程保存。**

**本设计照它走**（B2 已批准 `SetMes`/`SetEms`/`DelMes`/`DelEms`）：

    [编辑器对话框「确定」]
       ↓
    POST /api/projectData  { cmd: 'set-mes', data: <该对象的完整 JSON> }
       ↓                                   （client/src/app/_services/rcgi/reswebapi.service.ts:55-59）
    server/api/projects/index.js:114-136     ← 已有路由，要求 admin（:118-120）
       ↓
    runtime.project.setProjectData('set-mes', data)      （server/runtime/project/index.js:200）
       ↓  → setMes(data) 写内存 → prjstorage.setSection({table:'mes', name:data.id, value:data})
       ↓
    runtime.update('set-mes', data)          （server/api/projects/index.js:123）
       → runtime/index.js:544-575 无 mes 分支 → 直接 resolve(true)  ← 空转，符合预期

**删除**：`POST /api/projectData { cmd: 'del-mes', data: { id } }` → `removeMes` → `prjstorage.deleteSection`。

| 项 | 说明 |
|---|---|
| ✅ **不触发整机重启** | `/api/projectData` 调 `runtime.update()`（`server/api/projects/index.js:123`），**不是** `runtime.restart()`。这是相对「整工程 POST」的**决定性好处的**：`POST /api/project` 会 `runtime.restart(true)`（`:94-97`），而那会重启设备/报警/脚本/任务 |
| ⚠️ **但整工程 POST 仍然存在** | 用户点「保存工程」/导入 `.scadiap` 时走的是 `POST /api/project`（`client/src/app/_services/project.service.ts:157-177` → `reswebapi.service.ts:47-53`）。**所以 `setProject()` 的 `mes`/`ems` 分支照样需要**——两条路都要通：`projectData` 是日常编辑，`project` 是导入/整体保存 |
| ⚠️ 保存要求 admin | `server/api/projects/index.js:118-120`（`!authJwt.haveAdminPermission(permission)` → 401） |
| **id 生成** | **不得用 `Math.random()`**（C-4）。配方编辑器在这点是**反面样本**（`recipe-editor.component.ts:66`：`'e_' + Math.random().toString(16).substring(2,10)`）；`Utils.getGUID()` 同样是随机（`_helpers/utils.ts:197,209`）。**本设计用确定性 id**：用户在表单里填（工单号 / 计量点号） |
| **不新增 service 文件** | 硬约束「不改 `_services/`」。若需要一个门面类，**放在新组件目录里**（如 `mes/mes-workorder-list/mes-data.service.ts`），不放 `_services/` |
| **不新开路由** | 见 §0.2 |

### 0.5 共用校验

| 校验 | 时机 | 实现 |
|---|---|---|
| 必填 | 表单 `Validators.required` | 照 `recipe-editor.component.ts:36-39` |
| id 唯一 | 保存前 | 在数组里 `find(x => x.id === newId && x !== editing)` |
| 外键存在 | 下拉只列已存在的项 | `mat-select` 的 `*ngFor` 来自同一数组 |
| 删除被引用项 | 删除前 | 扫全表列出引用者，要求先解除 |
| 保存失败 | `err` 回调 | 照 `recipe-editor.component.ts:147-153`（`toastr.error(err.error?.message \|\| err.error?.error ...)`） |

### 0.6 「下发到实时点」（表 → tag）

脚本读不到工程表（系统函数封闭，`server/runtime/scripts/index.js:235-254`），只能读 tag。**表的值要进脚本，必须镜像成 tag。**

**正确 API（只用真名）**：`$setTag(tagId, value)`（`:238`）。**不存在 `$setTagValue`、不存在 `$daqWrite`**；DAQ 落库靠 tag 自己的 `daq` 字段（`scadiaserver/index.js:247-255`、`:220-222`）。

**下发走既有接口，不新建 API 域**：`POST /api/runSysFunction { params: { functionName: '$setTag', parameters: [tagId, value] } }`（`server/api/scripts/index.js:63-85`；白名单校验在 `:72`，参数展开在 `runtime/scripts/index.js:123-125`；要求 admin，`:67-69`）。

> ⚠️ **一处必须知道的限制**：`SCADIAServer.setValue` 对**未知 tag id** 直接 `return false`（`server/runtime/devices/scadiaserver/index.js:169-178`），**静默失败**。而**新增 tag 属于改设备定义**，只走得到既有的设备保存通道（`POST /api/projectData` 的 `set-device`，`server/runtime/project/index.js:221-224`），**不在本编辑器的范围内**。
> **第一批收口**：工程里**预置固定的一组镜像 tag**（以及 `mes.` 前缀的运行期 tag），编辑器只在已有 tag 范围内使用。见 `delivery-plan.md` §2.5。

---

# E1 ｜ 工单模板编辑器（`mes.workOrders`）

**第一批。**

## E1.1 页面清单

| 项 | 内容 |
|---|---|
| 承载路由 | `/mes`（`app.routing.ts:55`，已存在，**不改路由**） |
| 容器改造 | `MesBoardComponent` 外包一层 `mat-tab-group`；tab「工单模板」内放列表组件 |
| 列表组件（新） | `client/src/app/mes/mes-workorder-list/` |
| 编辑组件（新） | `client/src/app/mes/mes-workorder-editor/`（`MatDialog`） |
| 字段 | `data-model.md` → `WorkOrder` |
| 目标表 | `mes`（`TableType.MES`） |
| 读数据 | `GET /api/project` → `projectData.mes` 里 `WorkOrder` 形态的项 |

> **`projectData.mes` 里混着多种对象**（WorkOrder / Operation / Shift / OeeTarget / Defect 都在同一个数组里，因为它们同住一张表）。列表组件必须**按字段形状筛**：`mes.filter(x => x.operationId && x.plannedQty !== undefined)` 之类。**更好的做法**：约定一个 `kind` 判别字段（如 `kind: 'workOrder'`），见 §E1.6。

## E1.2 复用哪个现有组件

| 复用 | 来源 | 程度 |
|---|---|---|
| `MatTableModule` + `MatTableDataSource` + `MatSortModule` | `recipe-list.component.ts:3-4`、`:23,27` | 逐行照抄结构 |
| `MatDialogModule` + `MAT_DIALOG_DATA` | `recipe-editor.component.ts:2,30-34` | 逐行照抄 |
| `UntypedFormBuilder` + `Validators` | `recipe-editor.component.ts:2,36-39` | 逐行照抄 |
| `ToastrService` + `TranslateService` | `recipe-editor.component.ts:5-6,32-33` | 逐行照抄 |
| `ConfirmDialogComponent` | `recipe-list.component.ts:14,96-100` | 逐行照抄 |
| **不用** `DeviceTagSelectionComponent` | `device/device-tag-selection/device-tag-selection.component.ts:244-248` | 工单模板**不选点位**（那是 E3 计量点编辑器的事） |

## E1.3 字段 ↔ 控件（对照 `data-model.md` → `WorkOrder`）

**列表列**（`displayedColumns`）：

| 列 key | 表头 | 值 |
|---|---|---|
| `select` | （新增/编辑 icon） | 照 `recipe-list.component.html:13-24` |
| `id` | 工单号 | `row.id` |
| `name` | 名称 | `row.name` |
| `product` | 产品 | `row.product` |
| `operationId` | 工序 | 查 `mes` 里的 `Operation` 显示 `name` |
| `shiftId` | 班次 | 查 `mes` 里的 `Shift` 显示 `name` |
| `plannedQty` | 计划量 | `row.plannedQty` |
| `plannedStart` | 计划开始 | `row.plannedStart` |
| `status` | 状态 | `row.status` + 着色 pill |
| `remove` | （删除 icon） | 照 `:70-86` |

**编辑对话框**：

| 字段 | 控件 | 校验 | 默认值 | 来源（`data-model.md` 口径） |
|---|---|---|---|---|
| `id` | `<input type="text">` | required、唯一、`^WO-\d{8}-\d{2}$` | 建议值 `WO-<YYYYMMDD>-01` | 用户输入 |
| `name` | `<input type="text" maxlength="128">` | required | `''` | 用户输入 |
| `product` | `<input type="text" maxlength="128">` | required | `''` | 用户输入 |
| `operationId` | `<mat-select>` | required | 第一项 | 用户输入 |
| `shiftId` | `<mat-select>` | required | 第一项 | 用户输入 |
| `plannedQty` | `<input type="number" min="0">` | required、≥0 | `0` | 用户输入 |
| `plannedStart` | `<input type="datetime-local">` | required | `''` | 用户输入 |
| `plannedEnd` | `<input type="datetime-local">` | ≥ `plannedStart` | `''` | 用户输入 |
| `status` | `<mat-select>` | required | `'pending'` | 用户输入 |
| `priority` | `<input type="number" min="0" max="9">` | | `5` | 用户输入 |
| `cycleTimeSec` | `<input type="number" min="0">` | | `0` | 用户输入 |
| `note` | `<textarea rows="3" maxlength="512">` | | `''` | 用户输入 |

**`datetime-local` 的 value 天然是字符串**（形如 `"2026-10-04T08:00"`），**直接存**，与 `data-model.md` 的「时间一律字符串」约定一致。**不要**转 `Date` 再 `toISOString()`——那会引入时区漂移，破坏 C-4 的可复现性。

**运行期字段（`completedQty` / `scrapQty` / `completionRate`）不在这个编辑器里**。它们来自 `tag: mes.wo.completed` / `tag: mes.defect.count` / `脚本: s_oee_calc`（`data-model.md` → `WorkOrder`）。若要在列表里显示，做成**只读列**，值通过既有的 tag 订阅拿到，**不写回表**。

## E1.4 操作路径

    菜单：左侧导航「数据」组 → 「MES 制造执行看板」         （default-navigation.ts:69 → 路由 /mes）
      ↓
    页面顶部标签：点「工单模板」                              （新 mat-tab）
      ↓
    新增：点右下角 ⊕ 浮动按钮（或表头 ⊕）                    （recipe-list.component.html:99-101 / :15-17）
      ↓
    对话框《新建工单模板》
        字段顺序：工单号 → 名称 → 产品 → 工序 → 班次
                 → 计划量 → 计划开始 → 计划结束 → 状态 → 优先级 → 节拍(秒) → 备注
      ↓
    点「确定」                                                （recipe-editor.component.html:76-78）
      ↓
    POST /api/projectData { cmd:'set-mes', data:{...} }
      ↓
    toastr 成功/失败 → 列表刷新（重新 GET /api/project）
    编辑：列表行首 ✎ → 同对话框（工单号禁用，改主键等于换行）
    删除：列表行尾 ✕ → 确认框 → POST /api/projectData { cmd:'del-mes', data:{ id } }

## E1.5 校验清单

| 校验 | 消息 |
|---|---|
| 工单号格式 | 「工单号须形如 WO-20261004-01」 |
| 工单号唯一 | 「工单号已存在」 |
| 计划结束 ≥ 计划开始 | 「计划结束不能早于计划开始」 |
| 工序/班次下拉为空 | 「请先建立工序 / 班次」 |

## E1.6 ⚠️ 一个必须现在决定的设计点：`mes` 数组里的类型判别

`mes` 表存**五种对象**（`WorkOrder` / `Operation` / `Shift` / `OeeTarget` / `Defect`），它们在同一个 JSON 数组里。列表组件必须能分辨它们。

**两个方案**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **(a) 加 `kind` 判别字段**（推荐） | 每个对象多一个 `kind: 'workOrder'｜'operation'｜'shift'｜'oeeTarget'｜'defect'` | 多一个字段，但判别**可靠且自解释**；`data-model.md` 需补一行 |
| (b) 按字段形状猜 | `x.operationId && x.plannedQty !== undefined` | 零字段成本，但**脆弱**：字段重名就误判 |

**本设计推荐 (a)**，并把 `kind` 加进 `data-model.md` 每个模型的字段表（**本文件提交时尚未加，属待办**）。

---

# E2 ｜ 班次配置编辑器（`mes.shifts`）

**第二批。**

## E2.1 页面清单

| 项 | 内容 |
|---|---|
| 承载 | `/mes` → tab「班次」 |
| 列表组件（新） | `client/src/app/mes/mes-shift-list/` |
| 编辑组件（新） | `client/src/app/mes/mes-shift-editor/` |
| 字段 | `data-model.md` → `Shift` |
| 目标表 | `mes` |

## E2.2 复用

与 E1 相同的六项（`MatTable` / `MatDialog` / `UntypedFormBuilder` / `Toastr` / `Translate` / `ConfirmDialog`）。额外：`MatSlideToggleModule`（`crossMidnight`）、`<input type="time">`。

## E2.3 字段 ↔ 控件

| 字段 | 控件 | 校验 | 默认值 | 来源 |
|---|---|---|---|---|
| `id` | `<input type="text">` | required、唯一、`^[a-z0-9-]+$` | `shift-a` | 用户输入 |
| `name` | `<input type="text" maxlength="64">` | required | `'A 班'` | 用户输入 |
| `startTime` | `<input type="time">` | required | `'08:00'` | 用户输入 |
| `endTime` | `<input type="time">` | required | `'16:00'` | 用户输入 |
| `crossMidnight` | `<mat-slide-toggle>` | | `false` | 用户输入 |
| `breakMinutes` | `<input type="number" min="0" max="480">` | 0..480 | `0` | 用户输入 |
| `currentShiftId` | 只读 | | | 脚本: `s_shift_boundary` |
| `elapsedMin` | 只读 | | | 脚本: `s_shift_boundary` |

**跨班校验（对整组做，不是单条）**：各段 `[start, end)`（`crossMidnight` 时 end += 24h）互不重叠，且分钟数之和 == 1440。

## E2.4 操作路径

    左侧导航「数据」→「MES 制造执行看板」→ 标签「班次」
      ↓
    右下角 ⊕ →《新建班次》
        班次标识 → 班次名 → 开始时间 → 结束时间 → 跨零点 → 班中停机(分)
      ↓
    确定 → POST /api/projectData { cmd:'set-mes' } → 刷新
    （重叠/未覆盖 → 红条：「班次时段必须无缝覆盖 24 小时」）

---

# E3 ｜ 计量点配置编辑器（`ems.meters`）

**第二批。**

## E3.1 页面清单

| 项 | 内容 |
|---|---|
| 承载 | `/ems` → tab「计量点」 |
| 列表组件（新） | `client/src/app/ems/ems-meter-list/` |
| 编辑组件（新） | `client/src/app/ems/ems-meter-editor/` |
| 字段 | `data-model.md` → `Meter` |
| 目标表 | `ems` |
| 依赖 | 介质下拉来自 `ems` 里的 `Media` 对象 |

## E3.2 复用（**这里才用得上 `DeviceTagSelectionComponent`**）

| 复用 | 来源 | 说明 |
|---|---|---|
| 六件套（列表/对话框/表单/提示） | 同 E1 | |
| **`DeviceTagSelectionComponent`** | 契约在 `device/device-tag-selection/device-tag-selection.component.ts:244-248`（`DeviceTagSelectionData{variableId?,multiSelection?,variablesId?}`）；配方里的用法在 `recipe-editor.component.ts:11,48-79` | **只用在这一处**——计量点确实要绑真实点位（`sourceTagId`），与配方选点是**同一种需求**，不是语义借用 |
| `ProjectService.getTagFromId()` / `getDeviceFromTagId()` | `_services/project.service.ts:1361,1370` | 显示 tag 所属设备名 |
| `MatCheckboxModule` | | `isMain` / `enabled` |

## E3.3 字段 ↔ 控件

| 字段 | 控件 | 校验 | 默认值 | 来源 |
|---|---|---|---|---|
| `id` | `<input type="text">` | required、唯一、`^MTR-\d{2,}$` | 按现有最大序号 +1 | 用户输入 |
| `name` | `<input type="text" maxlength="128">` | required | `''` | 用户输入 |
| `mediaId` | `<mat-select>` | required | 第一项 | 用户输入 |
| `sourceTagId` | 只读框 + 「选择点位」按钮 | required | `''` | 用户输入 |
| `location` | `<input type="text" maxlength="128">` | | `''` | 用户输入 |
| `multiplier` | `<input type="number" step="0.001">` | >0 | `1` | 用户输入 |
| `unit` | `<input type="text" maxlength="16">` | required | `'kWh'` | 用户输入 |
| `isMain` | `<mat-checkbox>` | | `false` | 用户输入 |
| `enabled` | `<mat-checkbox>` | | `true` | 用户输入 |
| `currentValue` | 只读 | | | 脚本: `s_ems_energy_agg` |

**选择点位的交互**（照 `recipe-editor.component.ts:48-79`，但**不照抄它的 id 生成**）：

    this.dialog.open(DeviceTagSelectionComponent, {
        disableClose: true,
        position: { top: '60px' },
        data: <DeviceTagSelectionData>{ variableId: null, multiSelection: false }
    }).afterClosed().subscribe(result => {
        const tagId = result?.variableId || result?.variablesId?.[0];
        const tag = tagId ? this.projectService.getTagFromId(tagId) : null;
        if (tag) { this.myForm.patchValue({ sourceTagId: tagId }); }
    });

> ⚠️ **不要照抄 `recipe-editor.component.ts:66` 的 `'e_' + Math.random()...`**——那是 C-4 违规。计量点整行只有一个 `id`，由用户填或按序号生成，**不产生子条目 id**。

## E3.4 操作路径

    左侧导航「数据」→「EMS 能源管理看板」→ 标签「计量点」
      ↓
    右下角 ⊕ →《新建计量点》
        计量点号 → 名称 → 能源介质(下拉) → 采集点位(「选择点位」按钮)
        → 安装位置 → 变比倍率 → 单位 → 是否总表 → 启用
      ↓
    「选择点位」→《选择点位》对话框 → 左侧设备树 → 勾选 → 确定
      ↓
    确定 → POST /api/projectData { cmd:'set-ems' } → 刷新
    删除：行尾 ✕ → 若有 EnergyProfile 引用 → 拒绝并列出引用者

---

# E4 ｜ 电价时段编辑器（`ems.tariffs`）

**第二批。**

## E4.1 页面清单

| 项 | 内容 |
|---|---|
| 承载 | `/ems` → tab「电价时段」 |
| 列表组件（新） | `client/src/app/ems/ems-tariff-list/` |
| 编辑组件（新） | `client/src/app/ems/ems-tariff-editor/`（外层对话框 + 内嵌子表） |
| 字段 | `data-model.md` → `TariffBand`（含内嵌 `bands[]`） |
| 目标表 | `ems` |

## E4.2 复用 —— **照的是报表编辑器的「主表 + 内嵌子项」结构**

| 复用 | 来源 | 说明 |
|---|---|---|
| 外层对话框 + 内嵌 `<table mat-table>` | `client/src/app/reports/report-editor/`（子项组件 `report-item-table/` 等） | 报表是「一份报表 + 若干 item」；电价是「一套方案 + 若干时段」，**结构同构** |
| 子表内联编辑 `[(ngModel)]="row.f" [ngModelOptions]="{standalone:true}"` | `recipes/recipe-editor/recipe-editor.component.html:48-49` | 时段表每格直接编辑 |
| 子表增/删行 | `recipe-editor.component.ts:48-83` | `onAddBand` / `onRemoveBand` |
| 六件套 | 同 E1 | |

## E4.3 字段 ↔ 控件

**外层（方案级）**：

| 字段 | 控件 | 校验 | 默认值 | 来源 |
|---|---|---|---|---|
| `id` | `<input type="text">` | required、唯一 | `tariff-2026` | 用户输入 |
| `name` | `<input type="text" maxlength="128">` | required | `'2026 年电价'` | 用户输入 |
| `effectiveFrom` | `<input type="date">` | required | `''` | 用户输入 |
| `currency` | `<input type="text" maxlength="8">` | | `'CNY'` | 用户输入 |

**内嵌 `bands[]` 子表**（`displayedColumns = ['periodKey','label','startTime','endTime','crossMidnight','pricePerUnit','color','actions']`）：

| 字段 | 控件 | 校验 | 默认值 | 来源 |
|---|---|---|---|---|
| `periodKey` | `<mat-select>`（sharp/peak/flat/valley） | required、组内唯一 | — | 用户输入 |
| `label` | `<input type="text">` | | `''` | 用户输入 |
| `startTime` | `<input type="time">` | required | — | 用户输入 |
| `endTime` | `<input type="time">` | required、≠ `startTime` | — | 用户输入 |
| `crossMidnight` | `<mat-checkbox>` | | `false` | 用户输入 |
| `pricePerUnit` | `<input type="number" step="0.0001" min="0">` | >0 | — | 用户输入 |
| `color` | `<input type="color">` | | `'#607D8B'` | 用户输入 |
| （actions） | ✕ | | | |

外层还有两个只读显示：`currentPeriod` / `currentPrice`（来源 `脚本: s_ems_tariff`）。

## E4.4 必须强校验（四条）

| # | 规则 | 消息 |
|---|---|---|
| 1 | `periodKey` 互不相同 | 「时段类型重复」 |
| 2 | `crossMidnight` 处理后各段分钟数之和 == 1440 | 「四个时段合计必须正好 24 小时，当前 X 小时 Y 分」 |
| 3 | 各段互不重叠 | 「时段 Z 与 W 重叠 M 分钟」 |
| 4 | `pricePerUnit > 0` | 「单价必须大于 0」 |

**校验函数（纯函数，可单测）**：

```ts
/** "HH:MM" → 当天分钟数 */
function toMin(hhmm: string): number {
    const [h, m] = (hhmm || '').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

/** [from, to)，跨零点时 to += 1440 */
function bandRange(b: any): { from: number; to: number } {
    const from = toMin(b.startTime);
    let to = toMin(b.endTime);
    if (to <= from) { to += 1440; }
    return { from, to };
}

function validateBands(bands: any[]): string[] {
    const errs: string[] = [];
    const keys = bands.map(b => b.periodKey);
    if (new Set(keys).size !== keys.length) { errs.push('时段类型重复'); }
    bands.forEach(b => {
        if (!b.startTime || !b.endTime) { return; }
        if (toMin(b.startTime) === toMin(b.endTime)) { errs.push('开始与结束时刻不能相同'); }
        if (!(b.pricePerUnit > 0)) { errs.push('单价必须大于 0'); }
    });
    const ranges = bands.map((b, i) => ({ i, ...bandRange(b) }));
    const total = ranges.reduce((n, r) => n + (r.to - r.from), 0);
    if (total !== 1440) {
        errs.push(\`四个时段合计必须正好 24 小时，当前 \${Math.floor(total / 60)} 小时 \${total % 60} 分\`);
    }
    for (let a = 0; a < ranges.length; a++) {
        for (let b = a + 1; b < ranges.length; b++) {
            const overlap = Math.min(ranges[a].to, ranges[b].to) - Math.max(ranges[a].from, ranges[b].from);
            if (overlap > 0) { errs.push(\`时段 \${bands[ranges[a].i].label} 与 \${bands[ranges[b].i].label} 重叠 \${overlap} 分钟\`); }
        }
    }
    return errs;
}
```

> 注意 `to <= from` 时把 `to` 加 1440：这样 `"23:00" → "07:00"` 得 480 分钟（正确），但 `"08:00" → "08:00"` 也会被当成 1440 分钟的整日段——**所以第 4 条独立校验（start ≠ end）是必需的，不是冗余**。

## E4.5 操作路径

    左侧导航「数据」→「EMS 能源管理看板」→ 标签「电价时段」
      ↓
    右下角 ⊕ →《新建电价方案》
        方案标识 → 方案名 → 生效日期 → 币种
      ↓
    内嵌「时段明细」子表 → ⊕ 加行（连加 4 行）：
        时段类型(尖/峰/平/谷) → 名称 → 开始 → 结束 → 跨零点 → 单价(元/kWh) → 颜色
      ↓
    确定
      ↓
    ✗ 校验失败 → 对话框内红字列出全部错误，不关闭、不保存
    ✓ 通过 → POST /api/projectData { cmd:'set-ems', data:<整方案> } → 刷新

---

## E5 ｜ 四个编辑器对 `data-model.md` 的覆盖自检

| 模型 | 编辑器 | 批次 |
|---|---|---|
| `WorkOrder` | **E1** | **第一批** |
| `Shift` | E2 | 第二批 |
| `Meter` | E3 | 第二批 |
| `TariffBand` | E4 | 第二批 |
| `Operation` | 同 E1 骨架 | 第二批 |
| `OeeTarget` | 同 E1 骨架（4 数值 + 4 只读） | 第二批 |
| `Defect` | 同 E1 骨架 | 第二批 |
| `Media` | 同 E1 骨架 | 第二批 |
| `EnergyProfile` | 同 E1 骨架 | 第二批 |
| `CarbonFactor` | 同 E1 骨架 + `type="date"` | 第二批 |
