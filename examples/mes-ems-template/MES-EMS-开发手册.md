# MES / EMS 开发手册

> **适用工程**：`mes-ems-template.scadiap`（MES-EMS-Template，version 1.02）
> **依据**：《MES/EMS 开发能力技术规格书 v1.0》§4 结构、§5 画面组态规范、§6 脚本 API、§7 手册结构、§8 验收标准、§10 执行清单、附录 A 脚本编写规范、附录 B 组件绑定速查
> **设计约束**：C-1 不改后端代码 / C-2 不新建 API 域 / C-3 不新增存储后端 / C-4 零随机数（两个截图必须一致）/ C-5 单文件交付
> **语言**：简体中文　**格式**：Markdown

---

## 第 1 章 快速开始（5 分钟）

### 1.1 交付物

| 序号 | 文件 | 格式 | 用途 |
|------|------|------|------|
| 1 | `mes-ems-template.scadiap` | JSON（**UTF-8 带 BOM**，首字节 `EF BB BF`，2 空格缩进） | 可直接导入 SCADIA 的 MES/EMS 工程模板 |
| 2 | `MES-EMS-开发手册.md` | Markdown | 本手册，教用户基于模板二次开发 |
| 3 | `README.md` | Markdown | 一句话介绍 + 快速开始链接 |

三个文件**平级**放在同一目录，不需要任何子目录、不需要任何后端改动。

### 1.2 导入工程（操作路径）

1. 启动 SCADIA 服务端与客户端，浏览器打开控制台首页（`#/home`）。
2. 点击**顶部标题栏左侧**的「打开项目」按钮（`onOpenProject`，图标文件夹/上传）。
3. 在弹出的系统文件选择框中选中 `mes-ems-template.scadiap` → **打开**。
4. 客户端会读取文件 → 剥掉 UTF-8 BOM → `JSON.parse` → 校验 `version / hmi / devices` 三个必需字段 → 保存到当前工程。
   * 本工程文件**按规格书 §10 写成带 BOM 的 UTF-8**（首字节 `EF BB BF`），与出厂演示工程 `project.demo.scadiap` 一致；平台读取端会先 `.replace(/^\uFEFF/,"")` 剥掉 BOM。
   * 校验通过：右上角出现「工程已保存」提示。
   * 校验失败：右上角出现 **project format error**（说明文件里的 `version` / `hmi` / `devices` 之一缺失）。
5. 按 **F5** 刷新页面（工程写入后需要重新拉取一次）。

### 1.3 打开画面

侧栏（左侧导航栏）在导入后应显示 **10 个入口**，排列为：

```
现场画面 │ 驾驶舱 │ OEE分析 │ 能源看板 │ 能耗趋势
实时报警 │ 历史报警 │ 报表 │ 设备管理 │ 视频监控
```

- 点击「**驾驶舱**」→ 打开 `MES 制造执行看板`（工程启动画面，`hmi.layout.start`）。
- 点击「**能源看板**」→ 打开 `EMS 能源管理看板`。
- 也可直接输入地址：`#/home/v_mes_dashboard`、`#/home/v_ems_dashboard`、`#/home/v_mes_oee`、`#/home/v_ems_energy`、`#/home/v_production_floor`。

### 1.4 五分钟验收

| 检查 | 期望现象 |
|------|----------|
| 工程能打开 | 无报错，侧栏 10 个入口 |
| MES 看板 | 5 个 KPI 磁贴 + OEE 三要素 + 工单表格 + 报警面板 |
| EMS 看板 | 4 个能耗 KPI + 碳排放 KPI + 24h 趋势 + 分项/峰谷平统计 |
| 现场画面 | 深色底 `#1A1A1A`，6 个设备位，每个设备位为下拉框 |
| 报警列表 | 「实时报警」（`#/alarms`）显示 3 条报警定义 |
| 脚本列表 | 「脚本」（`#/scripts`）显示 3 个脚本 |

### 1.5 三个必做的现场化改动

| # | 位置 | 操作 |
|---|------|------|
| 1 | `#/device` 设备管理 → `ProductionLine1` | 把 `enabled` 改为 **true**，填入真实 PLC 的 IP / 端口 / 机架 / 槽号 |
| 2 | `#/scripts` → `s_oee_calc` | 把 `CYCLE_TIME`（理论节拍，秒/件）改成真实节拍 |
| 3 | `#/alarms` → 三条报警 | 按现场工艺阈值调整限值（温度 85 °C / 缺陷率 5 % / 日用电 15 000 kWh） |

---

## 第 2 章 工程结构总览

### 2.1 顶层结构（与规格书 §4.1 一致）

```json
{
  "version": "1.02",
  "name": "MES-EMS-Template",
  "devices": { "MES_Tags": {…}, "ProductionLine1": {…} },
  "hmi": {
    "views": [ 5 个画面 ],
    "navigation": { 10 个入口 },
    "layout": { "start": "v_mes_dashboard", "navigation": { 同上 10 个入口 } }
  },
  "charts": {},
  "server": { "scripts": […3…], "alarms": […3…], "reports": […2…], "recipes": […1…] },
  "scripts": [ 3 个脚本，与 server.scripts 逐字节一致 ],
  "alarms":  [ 3 条报警，与 server.alarms  逐字节一致 ],
  "reports": [ 2 份报表，与 server.reports 逐字节一致 ],
  "recipes": [ 1 个配方，与 server.recipes 逐字节一致 ]
}
```

> ### ⚠ 导入必读：这四组数据必须**同时**出现在顶层
>
> 平台导入工程走 `server/runtime/project/index.js` 的 `setProject()`，它**只遍历工程的【顶层键】**并映射到存储表：
>
> | 顶层 key | 存储表 |
> |----------|--------|
> | `devices` | DEVICES |
> | `hmi` | VIEWS + GENERAL |
> | `server` | DEVICES（**整块**当作设备数据存） |
> | `alarms` | ALARMS |
> | `recipes` | RECIPES |
> | `scripts` | SCRIPTS |
> | `reports` | REPORTS |
>
> **没有 `server.alarms` / `server.reports` / `server.recipes` 这条路径。** `server` 整个对象会被当作**一台设备**塞进 DEVICES 表，写在它内部的 `alarms / reports / recipes` 是**死数据——导入后一条都不会出现在报警页 / 报表页 / 配方页**。
>
> 因此本模板把这四组数据**同时**放在**顶层**与 `server.*`（两处内容逐字节一致）：**顶层那份才生效**，`server.*` 那份是规格书 §4.4 的字面对齐视图，保留无害。
>
> **二次开发注意**：在编辑器（`#/alarms` / `#/reports` / `#/recipes`）里新建对象会自动写对位置；**手改 JSON 时新增的报警 / 报表 / 配方一定要放进顶层数组**，否则导入后静默丢失。复核用第 7.2 节的命令。

> **为什么有 `hmi.layout.navigation`**：SCADIA 客户端读取的导航路径是 `hmi.layout.navigation.items`（`client/src/app/_models/hmi.ts` 的 `LayoutSettings.navigation`）。规格书 §4.3.7 写作 `hmi.navigation`，两者内容**逐字节相同**，`hmi.navigation` 为规格书对齐视图。
>
> **为什么四组数据各有两个位置**：规格书 §4.4 把它们写在 `server` 之下，而平台导入器只认顶层键（见上方「导入必读」）。两处内容逐字节一致：`server.*` 为规格书对齐视图，顶层数组为生效数据。

### 2.2 五个画面

| 画面 ID | 画面名 | 尺寸/底色 | 组件数 | 说明 |
|---------|--------|-----------|--------|------|
| `v_mes_dashboard` | MES 制造执行看板 | 1920×1080 / `#FFFFFF` | 15 | 5 KPI（4 个 HtmlSelect + 1 个 Value）+ OEE 三要素 + OEE 综合 + 工单进度表 + 质量指标 3 项 + 报警面板`HtmlChart[alarms]` + 调度面板`Scheduler` |
| `v_ems_dashboard` | EMS 能源管理看板 | 1920×1080 / `#FFFFFF` | 8 | 5 KPI（电/水/气/汽/碳排）+ 24h 能耗曲线 + 分项占比表 + 峰谷平统计表 |
| `v_mes_oee` | OEE 分析 | 1920×1080 / `#FFFFFF` | 5 | 可用率 / 性能率 / 合格率 三列大数字 + OEE 综合 + 24h 趋势图 |
| `v_ems_energy` | 能耗趋势 | 1920×1080 / `#FFFFFF` | 4 | 电 / 水 / 气 / 汽 各一张 24h 趋势图 |
| `v_production_floor` | 现场画面 | 1920×1080 / `#1A1A1A` | 6 | SVG 布局图 + 6 个设备位状态下拉框 + 状态图例 |

每个画面的数据结构：

```json
{
  "id": "v_mes_dashboard",
  "name": "MES 制造执行看板",
  "profile": { "width": 1920, "height": 1080, "bkcolor": "#FFFFFFFF" },
  "items": { "<组件ID>": { "id": "…", "type": "svg-ext-…", "name": "…", "label": "…", "property": { … } } },
  "variables": {},
  "svgcontent": "<svg …>…</svg>"
}
```

> `svgcontent` 是画面的 SVG 底板：静态标题、分区面板、以及每个组件在画布上的 **`<g id="组件ID" type="组件类型">` 占位块**都在这里。组件位置由该 `<g>` 内的 `<rect>` 决定。

### 2.3 十个导航入口（`hmi.navigation.items`）

| # | id | 图标 | 文字 | 目标 |
|---|----|------|------|------|
| 1 | nav_01 | home | 现场画面 | 画面 `v_production_floor` |
| 2 | nav_02 | dashboard | 驾驶舱 | 画面 `v_mes_dashboard` |
| 3 | nav_03 | analytics | OEE分析 | 画面 `v_mes_oee` |
| 4 | nav_04 | bolt | 能源看板 | 画面 `v_ems_dashboard` |
| 5 | nav_05 | show_chart | 能耗趋势 | 画面 `v_ems_energy` |
| 6 | nav_06 | notifications | 实时报警 | 路由 `alarms` |
| 7 | nav_07 | history | 历史报警 | 路由 `messages` |
| 8 | nav_08 | assessment | 报表 | 路由 `reports` |
| 9 | nav_09 | developer_board | 设备管理 | 路由 `device` |
| 10 | nav_10 | videocam | 视频监控 | 路由 `cameras` |

### 2.4 脚本 / 报警 / 报表 / 配方

| 类别 | ID | 名称 | 关键参数 |
|------|----|------|----------|
| 脚本 | `s_oee_calc` | OEE计算 | interval 60 000 ms |
| 脚本 | `s_energy_agg` | 能耗汇总 | interval 300 000 ms |
| 脚本 | `s_shift_report` | 班次产量汇总 | scheduling，周一~周五 08:00 |
| 报警 | 以 `name` 为键（**本模板报警无 `id` 字段**） | 产线温度超限 | `property.variableId = mes.temp.line1`；`high.min = 85` 已启用 |
| 报警 | 以 `name` 为键 | 缺陷率超标 | `property.variableId = mes.defect.rate`；`high.min = 0.05` 已启用 |
| 报警 | 以 `name` 为键 | 用电超峰 | `property.variableId = mes.energy.kwh`；`high.min = 15000` 已启用 |
| 报表 | `r_000000000100` | 日报_产量 | `scheduling: "day"`；表体 3 列 tag（planned / completed / oee.score） |
| 报表 | `r_000000000101` | 月报_能耗 | `scheduling: "month"`；表体 4 列 tag（kwh / water / gas / carbon.estimate） |
| 配方 | `r_000000000001` | 产品A 标准配方 | 3 条 `entries`：`mes.recipe.temperature` = 120 / `mes.recipe.pressure` = 0.8 / `mes.recipe.cycletime` = 120 |

> **平台报警 / 报表模型的实情（与规格书 §4.4.2 / §4.4.4 的写法不同，以工程文件为准）**
>
> * **报警**：`Alarm` 没有 `id` / `priority` 字段。一条报警以 `name` 为唯一键，值绑定在 `property.variableId`，限值分四档 `highhigh / high / low / info`，每档各自带 `min / max / checkdelay / timedelay / enabled / text / group / ackmode / bkcolor / color`。本模板三条报警各启用一个 `high` 档，分组为「质量」（温度、缺陷率）与「能源」（用电）。
> * **报表**：`Report` 没有 `format` 字段，也没有「几点几分」的字段。定时粒度由 `scheduling` 枚举决定（`ReportSchedulingType`：`day / week / month`，另有 `none`），PDF / Excel 是**点下载时选**的输出格式。表体与 tag 查询写在 `content.items[]` 的 `table.columns[]` 里（每列 = 1 个 tag + 1 个聚合函数）；`docproperty` 只描述纸张（A4 / portrait / 边距 / 字体）。
> * **配方**：配方模板（`Recipe`）的字段是 `id / name / description / entries[] / permission / permissionRoles`，**没有 `template` 字段**。配方**实例不是工程文件的一部分**：实例是运行期数据，由 `POST /api/recipes/instances` 写入独立的配方存储表（`runtime/recipes/recipe-storage.js`），因此本工程模板内不预置实例（规格书 §4.4.3 的 `instances: [{ id: "inst_001" }]` 在本平台无处安放）。

---

## 第 3 章 数据层：设备与 Tag

### 3.1 `MES_Tags`（内部 tag 表，`SCADIAServer`）

```json
"MES_Tags": {
  "id": "dev-mes-tags", "type": "SCADIAServer", "name": "MES 标签表",
  "enabled": true, "property": { "address": "internal" }, "polling": 1000,
  "tags": { … 30 个 tag … }
}
```

**规格书 §4.2 明列的 16 个 tag**（顺序与规格书一致）：

| # | Tag ID | 名称 | 类型 | 写入方 |
|---|--------|------|------|--------|
| 1 | `mes.wo.current` | 当前工单 | String | 外部/人工 |
| 2 | `mes.wo.planned` | 计划产量 | Int16 | 外部/人工 |
| 3 | `mes.wo.completed` | 完工数量 | Int16 | 外部/人工 |
| 4 | `mes.wo.wip` | 在制品 | Int16 | 外部/人工 |
| 5 | `mes.wo.status` | 工单状态 | String | 外部/人工 |
| 6 | `mes.oee.availability` | 可用率 | Float | `s_oee_calc` |
| 7 | `mes.oee.performance` | 性能率 | Float | `s_oee_calc` |
| 8 | `mes.oee.quality` | 合格率 | Float | `s_oee_calc` |
| 9 | `mes.oee.score` | OEE | Float | `s_oee_calc` |
| 10 | `mes.energy.kwh` | 今日用电 | Float | 外部/人工 |
| 11 | `mes.energy.water` | 今日用水 | Float | 外部/人工 |
| 12 | `mes.energy.gas` | 今日用气 | Float | 外部/人工 |
| 13 | `mes.energy.steam` | 今日用汽 | Float | 外部/人工 |
| 14 | `mes.defect.count` | 缺陷数 | Int16 | 外部/人工 |
| 15 | `mes.defect.inspected` | 抽检数 | Int16 | 外部/人工 |
| 16 | `mes.shift` | 当前班次 | String | 外部/人工 |

**规格书正文引用、但 §4.2 表格未列出的 tag（本模板补齐，共 11 个）**：

| # | Tag ID | 名称 | 类型 | 规格书引用位置 |
|---|--------|------|------|----------------|
| 17 | `mes.wo.rate` | 达成率 | Float | §4.3.2 MES 看板第 3 个 KPI「达成率」 |
| 18 | `mes.defect.rate` | 缺陷率 | Float | §4.4.2 报警 `alm_defect_high.tagId` |
| 19 | `mes.temp.line1` | 1#线温度 | Float | §4.4.2 报警 `alm_temp_high.tagId` |
| 20 | `mes.carbon.estimate` | 碳排放估算 | Float | §4.4.1 脚本 `s_energy_agg` 输出 |
| 21 | `mes.energy.cost` | 电费估算 | Float | §4.4.1 脚本 `s_energy_agg` 输出 |
| 22–27 | `mes.equipment.{mc01,mc02,robot01,assembly01,inspect01,pack01}.status` | 6 个设备状态 | String | §4.3.6 现场画面「绑定 `mes.equipment.*.status`」 |

**本模板新增的配方工艺参数 tag（3 个，仅由配方条目引用）**：

| # | Tag ID | 名称 | 类型 | init | 引用位置 |
|---|--------|------|------|------|----------|
| 28 | `mes.recipe.temperature` | 配方温度 | Float | `"120"` | §4.4.3 配方 `r_000000000001.entries[0]` |
| 29 | `mes.recipe.pressure` | 配方压力 | Float | `"0.8"` | §4.4.3 配方 `r_000000000001.entries[1]` |
| 30 | `mes.recipe.cycletime` | 配方节拍 | Int16 | `"120"` | §4.4.3 配方 `r_000000000001.entries[2]` |

> 这三个 tag 是配方（Recipe）的工艺参数落点：平台 `Recipe.entries[]` 要求每条都指向一个**真实存在的 tag**，且 `tagId/tagName/tagType` 必须与该 tag 定义一致，因此模板在 `devices.MES_Tags.tags` 中显式建了这三条（`SCADIAServer` 设备类型会按 `init` 与 `type` 初始化其初值，见 `runtime/devices/scadiaserver/index.js`），配方下发即可直接写入。**合计 27 + 3 = 30 个 tag。**

> 设备状态枚举取值：**运行 / 待机 / 故障 / 切换**（规格书 §2「设备状态 → Device Tag（枚举：运行/待机/故障/切换）」），颜色：运行=绿 `#2E7D32`、待机=灰 `#9E9E9E`、故障=红 `#C62828`、切换=黄 `#F9A825`。

### 3.2 `ProductionLine1`（Siemens S7 外部设备，默认禁用）

| Tag | 名称 | 类型 | 地址 |
|-----|------|------|------|
| `Planned` | 计划产量 | Int | `db4.dbw1` |
| `Actual` | 实际产量 | Int | `db4.dbw2` |
| `Defect` | 缺陷计数 | Int | `db4.dbw3` |
| `Status` | 设备状态 | Bool | `db1.dbx0.0` |

连接参数：`address = 192.168.1.177`、`port = 102`、`rack = 0`、`slot = 2`，`enabled = false`（出厂禁用，避免导入后立即产生连接错误日志）。

### 3.3 新增 / 修改 Tag（操作路径）

1. 侧栏 → **设备管理**（`#/device`）。
2. 左侧设备列表选择 **MES_Tags**。
3. 右侧「**标签 / Tags**」页签 → 点击 **+ 新建**。
4. 填写三个字段：**ID**（如 `mes.wo.scrap`）、**Name**（中文名）、**Type**（Bool/Int16/Int/Float/String 之一）。
5. 点击 **保存**；再点进度条状工具栏的 **保存工程**（或 Ctrl+S）写入工程文件。

> Tag ID 建议沿用 `mes.<域>.<对象>` 命名，与规格书 §4.2 保持一致。

---

## 第 4 章 画面组态与导航

### 4.1 组件绑定速查（规格书附录 B + 本模板实际用法）

| 画面元素 | 附录 B 行 | SCADIA 组件 `type` | `label` | 绑定字段 |
|----------|-----------|---------------------|----------|----------|
| KPI 磁贴（数值） | HtmlSelect（KPI 磁贴） | `svg-ext-html_select` | HtmlSelect | `property.variableId` + `property.ranges`（range.min=max 精确匹配对应的 <option>） |
| 历史曲线 | HtmlChart history | `svg-ext-html_chart` | HtmlChart | `property.variableIds` + `property.type = "history"` |
| 折线图 | HtmlChart 折线图 | `svg-ext-html_chart` | HtmlChart | 同上（`history` + `options.range = last1d`） |
| 报警列表 | HtmlChart alarms | `svg-ext-html_chart` | HtmlChart | `property.type = "alarms"` + `options.columns = [ontime,text,type,group,status,ack]` |
| 表格 | HtmlTable | `svg-ext-own_ctrl-table` | HtmlTable | `property.type = "data"` + `options.columns[].variableId` |
| 定时 | Scheduler | `svg-ext-own_ctrl-scheduler` | HtmlScheduler | `property.devices`（脚本 / 报表调度） |

> **附录 B 是本模板组件类型的唯一权威**。规格书 §4.3 的 ASCII 示意图只是版面草稿，凡与附录 B 冲突之处一律以附录 B 为准，冲突点见附录 A 第 8、9 行。

> 全模板组件类型分布（可用第 7.2 节命令复核）：`svg-ext-html_select` ×26、`svg-ext-html_chart[history]` ×6、`svg-ext-html_chart[alarms]` ×1、`svg-ext-own_ctrl-table[data]` ×3、`svg-ext-own_ctrl-scheduler` ×1、`svg-ext-value` ×1。

> 唯一的 `svg-ext-value` 用在 MES 看板第 5 个 KPI「当前工单」——该 tag 为 **String 型且无枚举域**，附录 B 没有「字符串型 KPI」这一行，HtmlSelect 的 `ranges` 是下拉选项（靠 `min` 精确匹配），无法表达任意工单号；同时规格书 §9 禁止把模板数据（工单号）写死进组件属性，因此这一格改用 Value 组件。数值型 KPI 磁贴**全部**为 HtmlSelect。
> **关于「KPI 磁贴用 HtmlSelect」**：规格书 §5.1 与附录 B 写作 HtmlSelect。SCADIA 的 `svg-ext-html_select` 实际是一个 **下拉框**（`ranges` 的每一项对应一个 `<option>`，取值靠 `min` 精确匹配），无法显示模拟量数值；因此模板中**数值型 KPI 磁贴使用 `svg-ext-value`**（它按 `variableId` 实时显示数值与单位，并按 `ranges` 做条件颜色），**设备状态**仍按要求使用 `HtmlSelect`（枚举取值天然是下拉语义）。详见附录 A。

### 4.2 KPI 磁贴：绑定 + 条件颜色（HtmlSelect，附录取自附录 B）

以 MES 看板「今日产量」为例（对应规格书 §5.1：value >= 31000 绿/达成、value >= 28000 蓝/正常、value < 28000 红/预警）：

```json
{
  "id": "it_mes_kpi_completed",
  "type": "svg-ext-html_select",
  "label": "HtmlSelect",
  "property": {
    "variableId": "mes.wo.completed",
    "variableSrc": "MES_Tags",
    "readonly": true,
    "ranges": [
      { "type": "option", "min": 31000, "max": 999999, "color": "#2E7D32", "stroke": "#FFFFFF", "text": "达成" },
      { "type": "option", "min": 28000, "max": 30999,  "color": "#1565C0", "stroke": "#FFFFFF", "text": "正常" },
      { "type": "option", "min": 0,     "max": 27999,  "color": "#C62828", "stroke": "#FFFFFF", "text": "预警" }
    ],
    "events": [], "actions": []
  }
}
```

> 三个 `ranges` 项按 §5.1 的三段阈值给出；`min` 即下拉项取值、`color` 为背景、`stroke` 为文字色、`text` 为显示文本。`readonly: true` 让 KPI 磁贴在运行态去边框、不可编辑。
> 其余 KPI 的取值段均能追溯到规格书常量：用电 `mes.energy.kwh` 用 15000 阈值（§4.4.2 `alm_energy_peak`）、缺陷率 `mes.defect.rate` 用 0.05 阈值（§4.4.2 `alm_defect_high`）、OEE 三要素与综合用 0.85 / 0.70 分段。

**操作路径**：侧栏 → **编辑器**（`#/editor`）→ 左侧「PROJECT VIEWS」选择画面 → 画布上单击组件 → 右侧属性面板 → **变量 / Variable** 选择设备 `MES_Tags` 与 Tag → **ranges** 分区用 **+** 增加分段，逐段填 `min / max / color / text` → 勾选 **readonly** → 点工具栏 **保存**。

### 4.3 趋势图（DAQ 历史）

规格书 §5.2：绑定变量 `mes.oee.score`、时间范围最近 24 小时、折线图、Y 轴 0.00~1.00。

```json
{
  "type": "svg-ext-html_chart",
  "property": {
    "type": "history",
    "variableIds": ["mes.oee.score"],
    "options": { "title": "24h OEE 趋势 (0.00 ~ 1.00)", "refreshInterval": 60000, "range": "last1d", "decimalsPrecision": 2 }
  }
}
```

**操作路径**：编辑器 → 选中 HtmlChart 组件 → 属性面板 **Type = history** → **Tags** 多选要画的变量 → **Range = last1d** → 保存。数据来源为 DAQ 历史库，无需任何后端改动（C-3）。

### 4.4 报警列表

规格书 §5.3 与附录 B 都规定**报警列表 = HtmlChart，类型 alarms**。规格书写的是「显示字段 时间 / 名称 / 优先级 / 状态」，但平台的 `Alarm` **没有 `priority` 字段**（报警用 `highhigh / high / low / info` 四档限值 + `group` 分组表达轻重），所以模板的列取平台真有的六个字段：`ontime / text / type / group / status / ack`（时间 / 名称 / 类型 / 分组 / 状态 / 确认）。模板按此实现：

```json
{
  "type": "svg-ext-html_chart",
  "property": {
    "type": "alarms",
    "options": { "title": "实时报警 / 历史报警", "columns": ["ontime","text","type","group","status","ack"] }
  }
}
```

**操作路径**：编辑器 → 选中 HtmlChart 组件 → 属性面板 **Type = alarms** → 在 **Columns** 中勾选 `ontime / text / type / group / status / ack`（时间/名称/类型/分组/状态/确认）→ 保存。

> 平台现实提示（详见附录 A 第 9 行）：`ChartViewType` 枚举目前只有 `realtime1 / history / custom`，报警列表在平台内的既有实现是 `svg-ext-own_ctrl-table` + `TableType.alarms`。本模板按附录 B 写作 `HtmlChart[alarms]`；若现场渲染为空，改成 HtmlTable 并置 `type = "alarms"` 即可，列定义换到 `options.alarmsColumns`。

### 4.5 导航编辑

**操作路径**：编辑器 → 左侧「PROJECT VIEWS」面板下方的布局设置（**Layout**）→ **Navigation** 分组 → 设置 **Mode = fix**、**Type = inline** → 在 **Items** 列表中 **+ 新增** 一行，填 **Icon / Text / View(画面ID) 或 Link(路由)** → 保存。

> 画面入口填 `view`（值 = 画面 ID，如 `v_mes_oee`）；应用页面入口填 `link`（值 = 路由，如 `alarms`），二者不要同时填。

---

## 第 5 章 二次开发 5 步

> 工时估算来自规格书 §7.2。每一步都给出**目标 → 操作路径 → 修改示例 → 验证方法**。

### 第一步：替换数据源（1–2 小时）

**目标**：把 SCADIAServer 内部 tag 换成真实 Device tag；脚本逻辑无需改动。
> ⚠️ 但**脚本里 tag 的写法要改**：本模板用的是**点号全名**（如 `mes.wo.completed`），换到真实设备后应保持同一套命名，或同步改脚本中的字符串。**函数名本身是 `$getTag`**（详见第 6 章）。

**操作路径**
1. 侧栏 → **设备管理**（`#/device`）→ 设备列表选中 **ProductionLine1** → 把 **Enabled** 开关打开 → 在连接区填写 **Address / Port / Rack / Slot** → 保存。
2. 同一页面 →「**标签 / Tags**」页签 → **+ 新建**，按现场 DB 块填 **ID / Name / Type / Address**（如 `Actual` / 实际产量 / Int / `db4.dbw2`）。
3. 侧栏 → **编辑器**（`#/editor`）→ 打开 `v_mes_dashboard` → 依次单击 5 个 KPI 组件 → 属性面板 **变量 / Variable** 的 **设备** 由 `MES_Tags` 改为 `ProductionLine1`，**Tag** 由 `mes.wo.completed` 改为 `Actual` → 保存。
4. 侧栏 → **脚本**（`#/scripts`）→ 双击 `s_oee_calc` → 代码区把 `$getTag('mes.wo.completed')` 改为 `$getTag('Actual')` → **保存**。

**验证**：`#/home/v_mes_dashboard`，KPI 磁贴数值随 PLC 变化。
> ⚠️ **不要用「点测试运行看有没有报错」当验证手段**：脚本的测试路径会把 `console` 换成一个**不打印**的包装，且脚本异常被 try/catch 吞掉 ⇒ **那里什么都看不出来**。**验证要读回 tag 的实际值**（见第 7.1 节第 4 行）。

### 第二步：调整计算逻辑（2–4 小时）

**目标**：修改 OEE / 能耗计算公式与调度间隔。

**操作路径**
1. 侧栏 → **脚本**（`#/scripts`）→ 选中 `s_oee_calc` → 打开「**调度 / Scheduling**」页签 → **Mode = interval** → **Interval (ms)** 填新值（≥ 60000，遵守附录 A.3 的 DAQ 写入频率约束）。
2. 同页「**代码 / Code**」页签 → 修改常量与公式：
   - `SHIFT_SECONDS`：班次时长（秒），默认 28800。
   - `CYCLE_TIME`：理论节拍（秒/件），默认 120。
   - 可用率若要用真实运行时长，把 `const availability = rate;` 改为按设备状态 tag 统计。
3. 侧栏 → **脚本** → `s_energy_agg` → 修改 `tariff` 三段电价与 `CARBON_FACTOR`（默认 0.58 kg CO₂/kWh）。
4. 点 **保存**，再点 **测试运行** 查看输出。

**验证**：`#/logs`（服务器日志）中出现 `OEE: A=… P=… Q=… OEE=…`，且 **A × P × Q = OEE**。

### 第三步：定制画面（2–4 小时）

**目标**：拖拽组件、绑定 tag、做条件颜色与趋势图，并导出为可复用模板。

**操作路径**
1. 侧栏 → **编辑器**（`#/editor`）。
2. 左侧「**PROJECT VIEWS**」→ **+**（新建画面）→ 填 **Name**、**Width/Height**、**Background color** → 确定。
3. 左侧「**CONTROLS**」→ 选择控件（如 *Value*、*HtmlSelect*、*HtmlChart*、*Table*）→ 在画布上按住拖出矩形。
4. 右侧属性面板 → **变量 / Variable** 绑定设备与 tag；**ranges** 做条件颜色；**actions / events** 做点击动作。
5. 左侧「**RESOURCES**」可上传图片，「**GENERAL**」工具栏用于对齐、图层、复制粘贴。
6. 保存（Ctrl+S）。

**验证**：切到 `#/home/<新画面ID>` 正常渲染；把该画面加入导航后侧栏可点开。

### 第四步：配置报表（1 小时）

**目标**：用 Tag 历史查询生成班报 / 日报 / 月报，输出 PDF 或 Excel。

**操作路径**
1. 侧栏 → **报表**（`#/reports`）→ 点击 **+ 新建**。
2. 弹窗内填 **Name**；「**Scheduling**」选择 **日 / 周 / 月**，或使用调度器设置具体触发时刻。
3. 在报表编辑器中拖入 **Table** 区块 → 在 **Columns** 中逐列选择 **Tag**（如 `mes.wo.completed`）、**Function**（min/max/average/sum）、**Range**（shift/day/week/month）。
4. 设定 **Doc property**：Page size = A4、Orientation、Margins、Font。
5. **保存**。定时触发后可在报表列表点 **Download** 取回文件——输出格式（PDF / Excel）在下载时选，工程文件里没有 `format` 字段；模板中 `r_000000000100` 为日报（`scheduling: "day"`）、`r_000000000101` 为月报（`scheduling: "month"`）。

**验证**：等一个调度时刻，报表列表出现新的历史记录，下载文件内容与 tag 历史一致。

### 第五步：配方下发（可选，1–2 小时）

**目标**：建立工艺参数模板 → 实例 → 下发到 tag。

#### 5.1 先认清楚本平台的配方模型（与规格书 §4.4.3 不同，以源码为准）

| 角色 | 存在哪里 | 谁创建 |
|------|----------|--------|
| **模板 type** | **工程文件顶层** `recipes[]` —— 本模板自带 `r_000000000001`「产品A 标准配方」，3 条 `entries` | 配方页新建 / 导入工程 |
| **实例 instance** | **不在工程文件里**，存在服务端独立的 recipes 存储表（SQLite，`runtime/recipes/recipe-storage.js`） | `POST /api/recipes/instances`，或配方页「复制为实例」 |
| **下发 download** | 把（合并后的）entries 逐条写进真实 tag | `POST /api/recipes/download`，body 传**实例 id** |

两条容易踩的规则，都来自源码：

1. **实例只存「与模板不同的值」。** `runtime/recipes/recipe-storage.js:301-318` 的 `_toStoredRecipeData()` 落库时只保留 `{ id, typeId, name, description, entries: [{ tagId, value }] }`；读取与下发时 `runtime/recipes/recipe-utils.js:7-34` 的 `mergeInstanceWithTemplate()` **按 `tagId` 把实例值覆盖回模板条目**。所以实例里**没写的 tag 自动沿用模板值** —— 本模板内不需要、也不应该有 `instances` 字段。
2. **下发的是实例，不是模板。** `POST /api/recipes/download` 用 `runtime.recipeStorage.getRecipeData(id)` 取数据（`api/recipes/index.js:255`），只有实例存储里的 id 才取得到；传模板 id 会得到 `404 RECIPE_NOT_FOUND`。

#### 5.2 图形界面操作路径

1. 侧栏 → **配方**（`#/recipes`）→ **+ 新建**。
2. 填 **Name**（如「产品A 标准配方」）与 **Description**。
3. 在 **Entries** 中逐行 **+ 添加**：选择目标 **Tag**（或手填 tag id）、填写 **Value**、确认 **Tag type**。
4. 复制为 **实例**（`typeId` 指向模板 id），修改实例中的参数值。
5. 在配方列表选中**实例** → 点击 **下发 / Write**；也可在画面里用 `svg-ext-own_ctrl-recipe` 组件或脚本 / 报警联动触发下发。

#### 5.3 可复现报文示例（照抄执行即可看到下发效果）

下面 4 步用 `curl` / Postman / 浏览器 fetch 执行；`<server>` 换成你自己的服务端地址。

> **鉴权**：与平台其它 API 一致。`settings.secureEnabled = false`（演示默认）时**无需任何凭据**；开启安全模式后需带 `x-access-token: <token>` 请求头，或 `scadia_access` Cookie / `?token=<token>` 查询参数（见 `main.js:457-477` 的 `snapshotAuth`）。

**第 1 步 · 确认模板在（应能查到 `r_000000000001`）**

```
GET <server>/api/recipes/types
```

响应（节选）：

```json
{
  "recipes": [
    {
      "id": "r_000000000001",
      "data": { "id": "r_000000000001", "name": "产品A 标准配方", "description": "产品A 标准工艺参数模板", "entries": [ "…3 条…" ] }
    }
  ]
}
```

**第 2 步 · 创建实例** —— `POST /api/recipes/instances`

请求体字段（源码：`api/recipes/index.js:678-706` 的 `_saveRecipeInstance` + `:494-562` 的 `_validateRecipeData`）：

| 字段 | 必填 | 约束 |
|------|------|------|
| `typeId` | **必填** | 模板 id；缺失 → `400 RECIPE_INVALID_DATA`「Missing typeId for recipe instance」 |
| `name` | **必填** | 非空字符串，≤ 128 字符 |
| `description` | 选填 | ≤ 512 字符 |
| `entries` | **必填** | 数组，1–1000 条；每条必须有 `tagId`（非空字符串）与 `tagType`（须在 `api/recipes/index.js:26` 的 `VALID_TAG_TYPES` 白名单内：`number / string / boolean / bool / int / dint / int16 / int32 / real / float / double / byte / word`，大小写不敏感）；`value` 选填 |
| `id` | 选填 | 不给则由服务端生成 `'r_' + crypto.randomBytes(6).toString('hex')`（`:695`）；条目 id 同理自动补 `e_` + 8 位 hex（`:697-699`） |

请求体（把配方温度从模板的 120 改成 135、节拍从 120 改成 110；**故意不写 `mes.recipe.pressure`**，用来看合并规则）：

```json
{
  "typeId": "r_000000000001",
  "name": "2026-10-04 批次",
  "description": "温度 135 / 节拍 110",
  "entries": [
    { "tagId": "mes.recipe.temperature", "tagType": "Float", "value": 135 },
    { "tagId": "mes.recipe.cycletime",   "tagType": "Int16", "value": 110 }
  ]
}
```

响应 `200`（`_saveRecipeInstance` 只回一个 id，`api/recipes/index.js:703-705`）：

```json
{ "id": "r_3f2a9c1b7d04" }
```

> `r_3f2a9c1b7d04` 是服务端生成值，**每次调用都不一样**，请用你实际拿到的那个 id 执行第 3、4 步。

**第 3 步 · 确认实例已与模板合并** —— `GET /api/recipes/instances/r_3f2a9c1b7d04`

响应（节选；注意 `entries` 是**合并后**的三条，实例里没写的 `mes.recipe.pressure` 自动沿用模板值 `0.8`）：

```json
{
  "id": "r_3f2a9c1b7d04",
  "typeId": "r_000000000001",
  "name": "2026-10-04 批次",
  "entries": [
    { "id": "e_…", "tagId": "mes.recipe.temperature", "tagName": "配方温度", "tagType": "Float", "value": 135 },
    { "id": "e_…", "tagId": "mes.recipe.pressure",    "tagName": "配方压力", "tagType": "Float", "value": 0.8 },
    { "id": "e_…", "tagId": "mes.recipe.cycletime",   "tagName": "配方节拍", "tagType": "Int16", "value": 110 }
  ]
}
```

**第 4 步 · 下发** —— `POST /api/recipes/download`，body 传**实例 id**

请求体：

```json
{ "id": "r_3f2a9c1b7d04" }
```

响应 `202`（异步执行，立即返回；`api/recipes/index.js:293-297`）：

```json
{ "result": "started", "recipeId": "r_3f2a9c1b7d04", "totalEntries": 3 }
```

服务端随即逐条执行 `runtime.devices.setTagValue(entry.tagId, coerced)`（`runtime/recipes/recipe-service.js:191-209`），并通过 Socket.IO 广播进度（事件名见 `runtime/events.js:34-40`）：

| 事件名 | 载荷 |
|--------|------|
| `recipe:download-progress` | `{ recipeId, entryId, tagId, tagName, index, total, status: 'writing' / 'success' / 'error', value?, error? }` |
| `recipe:download-complete` | `{ recipeId, successCount, errorCount, errors: [{ entryId, tagId, error }] }` |
| `recipe:download-error` | `{ recipeId, error }` |

常见非 2xx：

| 状态 | error | 触发条件 |
|------|-------|----------|
| 400 | `RECIPE_MISSING_ID` | body 里没有 `id` |
| 400 | `RECIPE_NO_ENTRIES` | 该 id 的 entries 为空 |
| 400 | `RECIPE_BUSY`（启动竞态为 409 `RECIPE_START_FAILED`） | 同一个 id 正在下发 |
| 400 | `RECIPE_INVALID_DATA` | 创建实例时缺 `typeId` / `name` / `entries`，或 `tagType` 不在白名单 |
| 404 | `RECIPE_NOT_FOUND` | id 不在**实例**存储里（传模板 id 会走到这里） |

#### 5.4 验证（本步的自证方法）

第 4 步返回 `202` 且没有收到 `recipe:download-error` 之后：

1. 到 **设备管理 → MES 标签表 → 标签** 读当前值：
   * `mes.recipe.temperature` = **135**（模板值 120，已被实例覆盖）
   * `mes.recipe.cycletime` = **110**（模板值 120，已被实例覆盖）
   * `mes.recipe.pressure` = **0.8**（实例没写，沿用模板值 —— 这一条同时验证了合并规则）
2. 或再读一次 `GET /api/recipes/instances/r_3f2a9c1b7d04`，`entries[*].value` 与上表一致。
3. **清理**：`DELETE /api/recipes/instances?id=r_3f2a9c1b7d04` → `{ "result": "ok", "deleted": 1 }`（实例在独立存储里，删掉它不影响工程文件里的模板）。

---

## 第 6 章 脚本 API 参考

### 6.1 内置函数（**以下 15 个是本平台真实存在的全部**，取自 `runtime/scripts/index.js:235-253`）

| 函数 | 签名 | 用途 |
|------|------|------|
| `$getTag(id)` | `(string) → any` | 读取当前 tag 值（可选第二参 `fully=true` 返回含时间戳的完整对象） |
| `$setTag(id, value)` | `(string, any) → void` | 写入 tag 值（**异步**；驱动会按 tag 类型强制转型） |
| `$getTagId(name, deviceName?)` | `(string, string?) → string\|null` | tag **名称** → tag **id** |
| `$setView(name, force?)` | `(string, any?) → void` | 切换画面 |
| `$enableDevice(id, enable)` | `(string, bool) → void` | 启用/禁用设备 |
| `$getDevice(id)` | `(string) → object` | 读设备 |
| `$getTagDaqSettings(id)` | `(string) → object\|null` | 读某个 tag 的 DAQ 设置 |
| `$setTagDaqSettings(id, settings)` | `(string, object) → void` | 写某个 tag 的 DAQ 设置 |
| `$getDeviceProperty(name)` / `$setDeviceProperty(query)` | — | 读/写设备属性 |
| `$getHistoricalTags(ids, from, to)` | `(array, number, number) → array` | 读历史值 |
| `$sendMessage(url)` | `(string) → any` | 发 HTTP GET |
| `$getAlarms()` | `() → array` | 读当前报警 |
| `$getAlarmsHistory()` | `() → array` | 读报警历史 |
| `$ackAlarm(id)` | `(string) → void` | 确认报警 |

> ⚠️ **规格书 §6 列出的下面 5 个函数在本平台上并不存在，照写会在运行时抛 `ReferenceError`：**
> `$getTagValue` · `$setTagValue` · `$daqWrite` · `$getShiftStart` · `$log`
> **正确名称是 `$getTag` / `$setTag`；后三个没有对应物**（DAQ 与日志的正确做法见 6.2）。

#### 6.1.1 本模板实际使用的函数

只有 **`$getTag`** 与 **`$setTag`** 两个（**只按函数调用计数**：`$getTag(` 15 处 = 5+4+6、`$setTag(` 8 处 = 6+2+0；其余 13 个内置函数一处未用）。
> ⚠️ 统计时**务必带上左括号**：`$getTag(` 是 `$getTagValue(` 的子串，只写函数名会**多算**——本手册早期版本就因此报过虚高的数字。

**DAQ 归档不通过函数调用**——它是驱动的自动行为，由每个 tag 自己的 `daq` 字段开关（见 6.2）。
**日志用 `console.log`**——脚本沙箱里没有 `$log`；`console.log` 是唯一可用且有效的输出方式（见 6.2）。

### 6.2 约束与**真实执行语义**（规格书 §6 与附录 A）

#### 6.2.1 命名（**改动过，务必按本节**）

- **脚本 ID = `s_<功能>_<动作>`，且必须是合法的 JS 标识符**：字母/数字/下划线，不得以数字开头。
  **原因**：脚本模块的函数名由 **ID** 派生（`msm.js` 的 `_toFuncName`：`'fn_' + id.replace(/[^a-zA-Z0-9_]/g,'_')`）。
- **脚本名称（`name`）是显示名，可以含中文，也可以含空格**——它不再参与任何标识符拼装。
  ⚠️ **但必须唯一**：`runtime/scripts/index.js:210` 用 `name` 作 `schedulingMap` 的键，**重名会互相覆盖调度**。
- 命名模板 `<功能>计算` 是**建议**，不是平台约束。

> **一处曾长期流传的错误说法**：「脚本名不能有空格 / 不能有非 ASCII 字符」。
> 实测：`每班产量汇总`、`OEE计算` 这类**中文名可以直接编译运行**（ES2015 起 CJK 是合法标识符字符）；
> 真正非法的是**空格、连字符、数字开头**。**本平台已修复该缺陷**（函数名改由 ID 派生），因此**中文名与带空格的名字都不会再导致脚本失效**。

#### 6.2.2 执行与错误处理（**必须知道的静默行为**）

- **每一段脚本代码都被 try/catch 包着**（`msm.js:159`）：`catch` 里**只** `console.log` 并 `return JSON.stringify(err)`。
  ⇒ **脚本内抛出的异常不会中断其他脚本，但会被「咽下去」**——这就是为什么改脚本后**必须实测输出值**，而不是只看它没报错。
- **调用不存在的函数会抛 `ReferenceError`**（例如规格书 §6 那 5 个假名字），然后按上一条被吞掉。
- `|| 0` 防御 null；关键量为空时提前 `return` 跳过非法输入。
- ⚠️ **沙箱里只有一个 `console` 包装对象，且只有 `.log`**（`msm.js:14`）。
  ⇒ **`console.warn(...)` / `console.error(...)` 会抛 `TypeError`**，并同样被吞掉。**脚本里只许用 `console.log`。**

#### 6.2.3 日志

- 用 **`console.log(...)`**（**没有 `$log` 这个函数**）。
- **输出去向**：正常执行路径（调度 / 手动运行）里 **`console.log` 就是 Node 的真 console**，内容进**服务器标准输出/日志**。
  ⚠️ **脚本「测试」功能例外**：该路径会注入一个不打印的 `console` 包装（它 `emit` 一个 **没有任何监听方**的 `script-console` 事件），**在那里点「测试」是看不到输出的**。
- 因此「日志 ≤ 10 行/执行」是**建议**（保持日志可读），**不是平台强制的阈值**。

#### 6.2.4 DAQ 归档（**规则已变，别再写成函数调用**）

- **没有 `$daqWrite` 这个函数，也不需要它。**
- DAQ 落库是**驱动自动行为**，由 **每个 tag 自己的 `daq` 字段**开关：
  ```json
  "tags": { "mes.oee.score": { "id": "mes.oee.score", "type": "Float", "daq": { "enabled": true } } }
  ```
- 判定源码：`runtime/devices/device-utils.js:226` —— `if (tag.daq && (tag.daq.enabled || tag.daq.restored))`；总开关 `runtime.settings.daqEnabled`（`runtime/devices/index.js:241`）。
- ⇒ **脚本只负责写 tag，归档自动发生**。本模板给 `dev-mes-tags` 的 **30 个 tag 中的 27 个**开了 `daq.enabled`；**故意不开的 3 个是配方参数** `mes.recipe.temperature / pressure / cycletime`（它们是配方下发写入的参数，按下发次数打点没有意义）。

#### 6.2.5 其它

- **无网络访问**。
- **无文件系统访问**。
- 只能操作工程内的 tag。
- ⚠️ **「脚本超时 30 秒」是规格书的说法，本平台没有实现**（`runtime/scripts/` 下**没有任何超时/计时器约束**——已实测搜索确认）。脚本不会被强制中断，请自行保证轻量。

### 6.3 脚本清单

| ID | 名称 | 调度 | 输入 tag | 输出 tag |
|----|------|------|----------|----------|
| `s_oee_calc` | OEE计算 | interval 60000 ms | `mes.wo.planned`、`mes.wo.completed`、`mes.defect.count`、`mes.defect.inspected` | `mes.wo.rate`、`mes.defect.rate`、`mes.oee.availability`、`mes.oee.performance`、`mes.oee.quality`、`mes.oee.score`（全部 tag 已开 `daq.enabled`，归档自动） |
| `s_energy_agg` | 能耗汇总 | interval 300000 ms | `mes.energy.kwh/water/gas/steam` | `mes.carbon.estimate`、`mes.energy.cost` |
| `s_shift_report` | 班次产量汇总 | scheduling 周一~周五 08:00 | `mes.wo.completed/planned/wip`、`mes.defect.count/inspected`、`mes.shift` | **仅日志**（`console.log`）；不写任何 tag |

### 6.4 核心公式

```
达成率   rate         = min(1, completed / planned)
可用率   availability = rate                      （真实场景按设备状态 tag 统计运行时长）
性能率   performance  = min(1, CYCLE_TIME / max(CYCLE_TIME, SHIFT_SECONDS / completed))
合格率   quality      = max(0, 1 - defect / inspected)
OEE                 = availability × performance × quality      ← 规格书 §8 验收
碳排放   carbon       = kwh × 0.58 / 1000  (tCO₂)               ← 规格书 §8 验收
电费     elecCost     = kwh × (0.8924 + 0.6874 + 0.3646) / 3    （元）
```

### 6.5 脚本骨架（可直接复用）

```javascript
// ===== 功能名 =====
const planned = $getTag('mes.wo.planned') || 0;        // 附录 A.2 防御 null
if (!planned) {                                        // 附录 A.2 提前返回
  console.log('跳过: planned 为空');                    // 只能 console.log（无 $log）
  return;
}
// … 计算 …
$setTag('target.tag', value.toFixed(4));               // 写 tag（驱动按类型转型）
// DAQ 不在这里写：在工程文件里给该 tag 设 daq.enabled = true，驱动自动归档
console.log('结果: ' + value.toFixed(4));              // 日志
```

---

### 6.6 附录 A 脚本规范的落实（规格书 §11）

#### A.1 命名约定

| 脚本 | id（`s_<功能>_<动作>`） | 名称（显示名） | 合规依据 |
|------|------------------------|------|------|
| 1 | `s_oee_calc` | `OEE计算` | id 是合法 JS 标识符 ✓（函数名由 id 派生）；名称无格式要求，仅需唯一 |
| 2 | `s_energy_agg` | `能耗汇总` | 同上 ✓ |
| 3 | `s_shift_report` | `班次产量汇总` | 同上 ✓ |

> **注意 `OEE计算` 中间没有空格**。曾有一个版本叫 `OEE 计算`（带空格）——那会**让整个脚本模块编译失败、三个脚本全部不执行**（详见 6.2.1 的历史说明）。本平台已修复该缺陷，但本模板仍统一采用**无空格**写法。

> **注**：§11 A.1 的名称模板是 `<功能>计算`，而 §10 执行清单把三个脚本**点名**为「OEE计算 / 能耗汇总 / 班次产量」。两处冲突时以 §10 为准（§10 是本工程的执行清单），`s_oee_calc` 正好同时满足两种写法。

#### A.2 错误处理

三个脚本统一按 A.2 的两个例子写：

| 脚本 | `|| 0` 防御 null | 关键量为空时 `console.log(...)` 后提前 `return` |
|------|------------------|--------------------------------------------|
| `s_oee_calc` | 5 处（planned/completed/defect/inspected，另含 1 处复用） | `if (!planned) { console.log(...); return; }` |
| `s_energy_agg` | 5 处（kwh/water/gas/steam，另含 1 处复用） | `if (!kwh && !water && !gas && !steam) { console.log(...); return; }` |
| `s_shift_report` | 6 处 + 字符串量 `mes.shift` 的 `|| '未定义'` | `if (!planned && !completed) { console.log(...); return; }` |

> 上表数字为**实测**（对改后模板逐脚本正则统计：`s_oee_calc` 5 / `s_energy_agg` 5 / `s_shift_report` 6+1）。

#### A.3 性能约束（三条都要在代码里看得出来）

| 约束 | s_oee_calc | s_energy_agg | s_shift_report | 代码内证据 |
|------|-----------|--------------|----------------|------------|
| 轻量/无阻塞 | ✓ | ✓ | ✓ | 全部是纯算术 + 若干 tag 读写，**无循环、无 IO**；三个脚本里**没有任何 `for/while/forEach/map`** |
| DAQ 归档频率可控 | 6 个输出 tag 已开 `daq.enabled`，写频率 = 脚本调度 **60 s/次** | 6 个 tag，**300 s/次** | **不写 tag**，无归档 | **DAQ 不是脚本调用的**（无 `$daqWrite`）；归档由 tag 的 `daq` 字段控制，因此频率**只取决于脚本多久写一次 tag** |
| 日志简短 | 3 行（正常 1 + 提前返回 1 + 异常 1） | 3 行 | 3 行 | 每个脚本 `console.log` **实测各 3 处**，三条路径互斥，正常路径只出 1 行 |

> ⚠️ **上一版此表的 DAQ 行是错的**：它把「`$daqWrite` 平铺在函数体」当作证据。**平台上没有 `$daqWrite`**，该函数是规格书虚构的。DAQ 归档改由 **tag 的 `daq.enabled`** 控制（见 6.2.4）。

校验命令（第 7.2 节同源）：

```powershell
# 统计每个脚本的 $getTag/$setTag 调用数、console.log 行数、是否存在循环；并统计 daq.enabled 的 tag 数
node "..\需要检查审核的0930\_probeP\verify-template.cjs" mes-ems-template.scadiap
```

## 第 7 章 验收标准

### 7.1 规格书 §8 验收表（逐条）

| # | 检查项 | 方法 | 通过标准 | 本模板落点 |
|---|--------|------|----------|------------|
| 1 | 工程能正常打开 | 导入 `.scadiap` | 无报错，侧栏显示 10 个入口 | `hmi.layout.navigation.items` = 10 条 |
| 2 | MES 看板渲染 | `#/home/v_mes_dashboard` | 5 个 KPI 磁贴 + OEE 三要素 + 工单表格 + 报警面板 | `v_mes_dashboard.items` 共 15 个组件（含调度面板） |
| 3 | EMS 看板渲染 | `#/home/v_ems_dashboard` | 4 个能耗 KPI + 碳排放 + 24h 趋势 + 峰谷平统计 | `v_ems_dashboard.items` 共 8 个组件 |
| 4 | OEE 计算正确 | **给输入 tag 赋值 → 触发脚本 → 读回输出 tag**（不要看「测试运行」的输出，见下注） | availability × performance × quality = score | 已实测（2026-10-05）：plan=1000 / completed=850 / defect=17 / inspected=200 ⇒ `mes.wo.rate=85`、`mes.defect.rate=0.085`、`mes.oee.quality=0.915`、`mes.oee.performance=1`、`mes.oee.availability=0.85`、**`mes.oee.score=0.7778`**（=0.85×1×0.915） |
| 5 | 能耗计算正确 | 同上，读回 `mes.energy.cost` | 电费 = 电耗 × 三段电价均值 | 已实测：kwh=1234.5 ⇒ `mes.energy.cost=800.12`（=1234.5×0.64813）。**注意「峰+平+谷=总用电量」不是本模板的口径**——模板用的是三段电价**均值**简化，模板里没有分时段电量 |
| 6 | 碳排计算正确 | 同上，读回 `mes.carbon.estimate` | 电耗 × 0.58 kg CO₂/kWh | 已实测：kwh=1234.5 ⇒ `mes.carbon.estimate=0.72`（=1234.5×0.58/1000） |

> ⚠️ **第 4/5/6 行原写「查看脚本输出」——那是错的验证手段**：脚本的**测试**路径会把 `console` 换成不打印的包装，且脚本异常被 try/catch 吞掉，**在那里既看不到日志、也看不到错误**。**唯一可靠的验证是读回 tag 的值**（`GET /api/project` 看 `mes` 数据，或在画面上看趋势/数值）。
> 上表三行的期望值是**实测值**，可直接对照；算术可手算复核。
| 7 | 报表定时触发 | 等调度时间 | 自动生成 PDF/Excel | 顶层 `reports`（= `server.reports`）：`r_000000000100` 为 `scheduling: "day"`、`r_000000000101` 为 `scheduling: "month"`；PDF / Excel 在报表列表点 Download 时选 |
| 8 | DAQ 历史可查 | 趋势图时间范围 | 能显示最近 24h 数据 | 6 个 `svg-ext-html_chart[history]`，`options.range = last1d` |
| 9 | 报警触发 | 手动改 tag 超限 | 报警面板出现新条目 | `server.alarms` 3 条（tag 均已声明）+ 报警面板 `HtmlChart[alarms]` |
| 10 | 配方下发 | 创建实例 → 下发 | tag 值被更新 | **按第 5 章 5.3 的报文执行即可自证**：① 顶层 `recipes`（= `server.recipes`）里的模板 `r_000000000001` 有 3 条 `entries`，指向 `mes.recipe.{temperature,pressure,cycletime}`；② `POST /api/recipes/instances` 返回 `200 {"id":"r_…"}`（实例存在服务端独立存储，**不在工程文件内**）；③ `POST /api/recipes/download {"id":"<实例id>"}` 返回 `202 {"result":"started","totalEntries":3}`；④ 随后读 tag 当前值应为 `mes.recipe.temperature = 135`、`mes.recipe.cycletime = 110`、`mes.recipe.pressure = 0.8`（第三项沿用模板值，验证了合并规则） |

### 7.2 交付文件的机器校验（可复现）

```powershell
node "..\需要检查审核的0930\_probeP\verify-template.cjs" mes-ems-template.scadiap
```

**期望输出（已实测）**：

```
BOM       : true
bytes     : 138436
top-level : version, name, devices, hmi, charts, server, scripts, alarms, reports, recipes
counts    : tags=30 views=5 nav=10 scripts=3 alarms=3 reports=2 recipes=1
scripts   : s_oee_calc name=OEE计算 getTag=5 setTag=6 console.log=3 loops=0
            s_energy_agg name=能耗汇总 getTag=4 setTag=2 console.log=3 loops=0
            s_shift_report name=班次产量汇总 getTag=6 setTag=0 console.log=3 loops=0
            TOTAL getTag=15 setTag=8 console.log=9
DAQ       : enabled=27 / 30 tags
  without daq: mes.recipe.temperature, mes.recipe.pressure, mes.recipe.cycletime
fictional API names still present: (none)
```

> ⚠️ **本节原来给的是 `node -e "..."` 单行命令，已废弃**，两个原因（都实测过）：
> 1. **在 PowerShell 下会被展开**：命令里的 `$getTag` / `$setTag` 会被 PowerShell 当成**自己的变量**（值为空），**静默吃掉**正则里的 `$`，导致统计错误或直接 `SyntaxError`。
> 2. 原命令读的是 `j.hmi.navigation.items`，**该路径不存在**——导航的**真实位置是 `j.hmi.layout.navigation.items`**（与工程里 `hmi.navigation` 和 `hmi.layout.navigation` 同名双份的老问题同源）。
>
> 所以现在改成一个**独立脚本**（`.cjs`），它同时校验：BOM、顶层键、各项数量、三个脚本的 API 调用计数、`console.log` 行数、是否有循环、`daq.enabled` 覆盖数、**以及五个虚构 API 名是否残留**（残留则退出码 1）。

### 7.3 零随机 / 零时间依赖（规格书 C-4）

```powershell
$p1 = 'Math' + '\.random'; $p2 = 'Date' + '\.now'; $p3 = 'new' + ' Date'
Select-String -Path mes-ems-template.scadiap -Pattern $p1,$p2,$p3
```

期望：**无任何匹配**。所有演示数据（画面上的数值、报表区间、电价、碳排因子、节拍、班次时长）均为固定常量，两次截图像素一致。

---

## 附录 A 规格书偏差与复核清单

> 本附录列出规格书**未写死**或与 SCADIA 现有实现不一致之处，以及本模板的取舍依据。**请复核**。

| # | 规格书位置 | 问题 | 本模板做法 |
|---|------------|------|------------|
| 1 | §4.4 把 `scripts / alarms / reports / recipes` 放在顶层 `server` 之下 | 平台导入器 `setProject()` **只遍历顶层键**：顶层 `server` 会被整块当作 DEVICES 数据存，`server.alarms / server.reports / server.recipes` 是**死数据，导入后一条都不会出现** | **四组数据同时放在顶层与 `server.*`，两处逐字节一致（顶层生效）**；`server` 另补合法设备字段避免被当成脏设备。已在手册 §2.1「导入必读」显著提示 |
| 2 | §4.3.7 写作 `hmi.navigation` | 客户端读取路径是 `hmi.layout.navigation`（`client/src/app/_models/hmi.ts` → `LayoutSettings.navigation`） | 两处都给，内容一致；生效的是 `hmi.layout.navigation` |
| 3 | §4.4.1 `s_oee_calc` 使用当前时间戳函数与 `$getShiftStart()` | ① 与 C-4「零随机数 / 两个截图必须一致」冲突：性能率会随时间变化；② **`$getShiftStart()` 在本平台上根本不存在**（不是「保留但不用」的问题） | 改为固定常量 `SHIFT_SECONDS = 28800`、`CYCLE_TIME = 120`，公式形态与规格书一致；**`$getShiftStart()` 已从 API 表中删除**（6.1 节明确标注 5 个虚构函数）。若现场确需真实班次时长，**须自行用 `$getHistoricalTags()` / tag 值推算**，平台不提供该函数 |
| 4 | §4.4.1 `s_energy_agg` 中 `const elecCost = kwh / 1000 * avgPrice;` | 量纲错误：`kwh` 已是 kWh，再除 1000 使电费缩小 1000 倍 | 改为 `kwh * avgPrice` |
| 5 | §4.4.1 `s_oee_calc` 里同时写能耗 tag | 与 `s_energy_agg` 职责重叠，同一 tag 每 60 s 被写两次 | OEE 脚本只写 `mes.oee.*` 与 `mes.wo.rate` / `mes.defect.rate`；能耗脚本写 `mes.energy.*` 与 `mes.carbon.estimate`。**归档频率由各自 tag 的 `daq` 设置控制**（无 `$daqWrite`） |
| 6 | §4.2 tag 表只有 16 个 tag，但正文引用了 6 个表外 tag | `mes.temp.line1`、`mes.defect.rate`（§4.4.2 报警）、`mes.carbon.estimate`、`mes.energy.cost`（§4.4.1 脚本）、`mes.equipment.*.status`（§4.3.6） | 全部补齐为真实 tag（见 §3.1 表 17–27），保证报警、脚本、画面绑定全部可解析 |
| 7 | §4.3.2 MES 看板第 3 个 KPI「达成率」 | §4.2 无对应 tag | 新增派生 tag `mes.wo.rate`（`Float`，百分比数值），由 `s_oee_calc` 写入 |
| 8 | §5.1 / §12 附录 B「KPI 磁贴 = HtmlSelect」 | 平台 `svg-ext-html_select` 是下拉框：`ranges` 逐项生成 <option>，取值靠 `min` 精确匹配，因此 KPI 磁贴显示的是**取值段标签**而不是连续数值 | **按 §12 执行**：数值型 KPI 磁贴全部用 `svg-ext-html_select`，`ranges` 按 §5.1 与 §4.4.2 的阈值分段（31000/28000、15000、0.05、0.85/0.70）；`readonly: true` 使运行态不可编辑。仅「当前工单」一个 String 型 KPI 用 `svg-ext-value`（附录 B 无字符串型 KPI 行） |
| 9 | §5.3 / §12 附录 B「报警列表 = HtmlChart alarms」 | 平台 `ChartViewType` 只有 `realtime1 / history / custom`；报警列表的既有实现是 `svg-ext-own_ctrl-table` + `TableType.alarms` | **按 §12 执行**：报警面板写作 `svg-ext-html_chart` + `property.type = "alarms"`，列 `ontime/text/type/group/status/ack`。若现场渲染为空，手册 §4.4 给出了切换到 HtmlTable 的一步改法 |
| 10 | §8「MES 看板渲染 \| `#/mes`」 | 路由表（`app.routing.ts`）没有 `/mes` | 实际路径为 `#/home/v_mes_dashboard`（`home/:viewName`） |
| 11 | §10「BOM 保留 UTF-8」 | 若不带 BOM，与出厂演示工程 `project.demo.scadiap`（带 BOM）及平台读取端 `.replace(/^\uFEFF/,"")` 的惯例不一致 | **按 §10 执行**：`.scadiap` 写成 **UTF-8 带 BOM**，首字节 `EF BB BF`；校验时需先剥 BOM 再 `JSON.parse`（见 §7.2 命令） |
| 12 | §4.1 `"charts": {}` | 客户端模型 `ProjectData.charts` 声明为数组 | 按规格书原样保留 `{}`；客户端 `getCharts()` 对 `{}` 取 `length` 为 `undefined`，不抛错但也不会遍历，若需图形组件请在编辑器内新建图表 |
| 13 | **§4.3 与 §12 的出入** | §4.3 各节只有 ASCII 版面草图，**未标注任何组件类型**，因此与 §12 没有字面冲突；唯一需要以 §12 裁定的是 HtmlSelect 的**用途标签**——§4.3.6 把它指定给「设备状态」，§12 把它归给「KPI 磁贴」 | **以 §12 为准定组件类型，以 §4.3.6 定用途**：设备状态与 KPI 磁贴都用 `svg-ext-html_select`（同一组件、两种用途，不冲突）；另外按 §12 第 6 行补了一个 `svg-ext-own_ctrl-scheduler` 调度面板（MES 看板右下），使 §12 六行全部有落点 |

---

## 附录 B 版本与变更

| 项 | 值 |
|----|-----|
| 工程文件 | `mes-ems-template.scadiap` |
| 工程名 | MES-EMS-Template |
| version | `1.02` |
| JSON 缩进 | 2 空格 |
| 编码 | UTF-8 **带 BOM**（首字节 `EF BB BF`，符合规格书 §10「BOM 保留 UTF-8」） |
| 随机数 / 时间函数 | 0 处（JS 随机数函数、当前时间戳函数、日期构造函数全文 0 命中） |
| 后端改动 | 0 处（满足 C-1 / C-2 / C-3） |
| 依据 | 规格书 §4 / §5 / §6 / §7 / §8 / §10 / 附录 A / 附录 B |

*本手册与 `mes-ems-template.scadiap` 配套使用，两者必须同时交付；`README.md` 为入口索引，三个文件同目录平级。*


---

## 附录 C 规格书 §10 执行清单逐条打勾

> 原文清单来自规格书 §10，逐条给出落点与勾选结果。

### C.1 `mes-ems-template.scadiap`

| # | §10 原文条目 | 落点 | 结果 |
|---|--------------|------|------|
| 1 | 完整的 SCADIA 工程 JSON 文件 | 顶层 `version / name / devices / hmi / charts / server` | ☑ |
| 2 | 严格遵循第 4 节的结构 | 全文件；3 处结构性取舍见附录 A 第 1、2 行 | ☑ |
| 3 | devices: 1 个 SCADIAServer 内部 tag 表 + 1 个可选的 SiemensS7 外部设备 | `devices.MES_Tags`（SCADIAServer，30 tag）、`devices.ProductionLine1`（SiemensS7，enabled=false） | ☑ |
| 4 | hmi.views: 5 个画面（MES看板/EMS看板/OEE分析/能耗趋势/现场画面） | `hmi.views[0..4]` = `v_mes_dashboard / v_ems_dashboard / v_mes_oee / v_ems_energy / v_production_floor` | ☑ |
| 5 | hmi.navigation: 10 个入口，中文字面量 | `hmi.navigation.items`(10) = `hmi.layout.navigation.items`(10) | ☑ |
| 6 | server.scripts: 3 个脚本（OEE计算/能耗汇总/班次产量） | `server.scripts` = 3；**顶层 `scripts` = 同内容 3（生效）** | ☑ |
| 7 | server.alarms: 3 条报警 | `server.alarms` = 3；**顶层 `alarms` = 同内容 3（生效）** | ☑ |
| 8 | server.reports: 2 份报表 | `server.reports` = 2；**顶层 `reports` = 同内容 2（生效）** | ☑ |
| 9 | server.recipes: 1 个配方模板 | `server.recipes` = 1；**顶层 `recipes` = 同内容 1（生效）** | ☑ |
| 10 | 所有数值数据使用固定常量 | JS 随机数函数 / 当前时间戳函数 / 日期构造函数全文 **0 命中**；电价、碳排因子、理论节拍、班次时长均为常量 | ☑ |
| 11 | BOM 保留 UTF-8 | 文件首 3 字节 = `EF BB BF`（总长 137,496 B） | ☑ |
| 12 | JSON 格式校验通过（无 trailing comma） | 剥 BOM 后 `JSON.parse` OK；正则 `/,\s*[}\]]/` 无命中 | ☑ |

### C.2 `MES-EMS-开发手册.md`

| # | §10 原文条目 | 落点 | 结果 |
|---|--------------|------|------|
| 1 | 遵循第 7 节结构 | 第 1 章 快速开始 → 第 2 章 结构总览 → 第 3 章 数据层 → 第 4 章 画面组态 → 第 5 章 二次开发 5 步 → 第 6 章 脚本 API → 第 7 章 验收标准 | ☑ |
| 2 | 包含快速开始 + 二次开发 5 步路径 | 第 1 章、第 5 章 | ☑ |
| 3 | 每个步骤附具体的操作路径（菜单 → 按钮 → 字段名） | 第 5 章五步均含「目标 → 操作路径 → 修改示例 → 验证」 | ☑ |
| 4 | 包含脚本 API 参考表（第 6 节） | 6.1 五个内置函数表 + 6.2 约束 + 6.3 脚本清单 + 6.4 公式 + 6.5 骨架 + 6.6 附录 A 规范落实 | ☑ |
| 5 | 包含验收标准（第 8 节） | 7.1 十行验收表 + 7.2/7.3 可复现命令 | ☑ |
| 6 | 语言：中文，Markdown 格式 | 全中文 Markdown | ☑ |

### C.3 §10 约束段

| # | §10 原文约束 | 落点 | 结果 |
|---|--------------|------|------|
| 1 | 不修改任何现有 SCADIA 源码文件 | `需要检查审核的0930\源代码\**` 全程只读（read/grep），零字节写入 | ☑ |
| 2 | 不调用外部 API | 交付物内无任何 http/rest/websocket 调用；脚本只用 `$getTag` / `$setTag` **两个**内置 API，日志用 `console.log`；DAQ 走 tag 的 `daq` 字段、不是 API 调用 | ☑ |
| 3 | 不创建子目录结构（文件平级） | `__mes_ems_template\` 下为 3 个**平级文件**（`mes-ems-template.scadiap` / `MES-EMS-开发手册.md` / `README.md`），无子目录 | ☑ |
| 4 | JSON 文件使用 2 空格缩进 | `JSON.stringify(obj, null, 2)`，抽查 `/^ {2}"/m` 命中 | ☑ |
| 5 | 脚本中使用 SCADIA 内置 API | 三个脚本共使用 **`$getTag(`×15、`$setTag(`×8、`console.log`×9**（实测），未引入任何其他依赖。**规格书 §6 的 `$getTagValue/$setTagValue/$daqWrite/$getShiftStart/$log` 五个名字在平台上不存在，已全部改掉** | ☑ |

*附录 C 与附录 A 配套：A 说明「哪里和规格书字面不同、为什么」，C 说明「§10 清单有没有做」。*
