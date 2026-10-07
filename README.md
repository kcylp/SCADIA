![SCADIA](client/src/favicon.ico)

# 开诚智枢 · Kaicheng SCADIA

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%20LTS-green)](https://nodejs.org/)

**开诚智枢 SCADIA** 是一套**基于 Web 的组态式 SCADA / HMI 平台**，面向工业自动化、物联网与实时过程可视化。浏览器即可查看实时画面、读写设备数据、下发命令；工程（画面 / 设备 / 报警 / 配方 / 报表 / 脚本）全部在浏览器里组态，无需安装客户端。

> 血缘：基于开源 **FUXA**（MIT，Copyright 2019–2025 frangoteam）二次开发，叠加中文本地化、三层设备模型、校准标定、视频监控 / GB28181 / AI 分析、OPC UA Server、Node-RED 集成等能力。上游 README 留存于 `docs/README-FUXA-upstream.md`。

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 功能总览](#2-功能总览)
- [3. 使用说明](#3-使用说明)
- [4. 软件架构](#4-软件架构)
- [5. 附录](#5-附录)

---

## 1. 快速开始

### 1.1 环境要求

| 项 | 要求 |
|---|---|
| Node.js | 18 LTS 或更高（开发机实测 24.x 可用） |
| 包管理 | npm |
| 浏览器 | Chrome / Edge 现代版本 |
| 可选 | Docker Desktop（跑 Postgres / TDengine 等测试后端） |

### 1.2 安装与启动

前后端**分开安装**；前端构建产物由后端直接托管，所以**只需对外暴露一个端口**。

```bash
# 1) 后端依赖
cd server
npm install

# 2) 前端依赖 + 构建（产物输出到 client/dist）
cd ../client
npm install
npx ng build

# 3) 启动（回到 server）
cd ../server
npm start
```

打开 **http://127.0.0.1:1881/** 即可。

> **端口说明**：默认 UI 端口 **1881**（`server/settings.default.js` 的 `uiPort`，可用环境变量 `PORT` 覆盖）；另有 `httpPort: 8080` 用于内部 HTTP 服务。
> 首次启动会在工作目录下自动创建 `_appdata`（数据库）、`_db`、`_logs`、`_images` 等目录。

### 1.3 指定工程数据目录（推荐）

用 `--userDir` 把某份工程数据独立出来，便于一机多工程：

```bash
node main.js --port 1881 --userDir "D:\scada-projects\demo"
```

目录解析规则（`server/main.js`）：

```
rootDir = --userDir（默认 server/ 自身）
workDir = <rootDir>/_appdata     ← 工程库 project.scadiap.db 在这里
<rootDir>/_db  /_logs  /_images   ← 历史库 / 日志 / 图片
```

> ⚠️ **不要**把 `project/_appdata` 再拷进 `server/`，否则会嵌套成 `_appdata/_appdata`。用 `--userDir` 直接指过去即可。

### 1.4 默认登录

安全关闭时通常**无需登录**。若开启安全（`settings.js` 的 `secureEnabled: true`），默认管理员：

```
用户名：admin
密码：  123456
```

> 首次部署后请立即修改。

### 1.5 Docker

仓库带 `Dockerfile` 与 `compose.yml`：

```bash
docker compose up -d
```

---

## 2. 功能总览

### 2.1 工业协议接入（16 个驱动，`server/runtime/devices/`）

| 类别 | 驱动 |
|---|---|
| 现场总线 / PLC | `modbus`（RTU / TCP）、`s7`（Siemens S7）、`melsec`（三菱）、`ethernetip`（Allen-Bradley）、`omron-ethernetip`（欧姆龙）、`adsclient`（Beckhoff ADS） |
| 楼宇 / 通用 | `bacnet`、`opcua`、`mqtt`、`redis`、`odbc`（数据库直读） |
| 其它 | `httprequest`（REST）、`websocket`、`gpio`（树莓派）、`webcam`、`scadiaserver`（平台内部虚拟设备） |

### 2.2 组态与 HMI

- **全 Web 组态编辑器**：画面基于 SVG，拖拽式绘制，支持动画、管道、阀、泵、仪表、图表、开关、滑块等图元。
- **HTML 扩展控件**：`svg-ext-html_*` 系列（chart / slider / switch / select / bag / scheduler / recipe …）把富控件嵌进 SVG 画面。
- **多画面与导航**：工程可定义任意多个画面 + 侧栏导航（支持 `fix` / `over` / `push` 三种模式）。
- **分辨率自适应**：
  - 画面支持 `contain` / `cover` / `stretch` / `width` / `fill` / `none` 六种缩放模式（`fill` = 背景满幅 + 画布不裁切）；
  - 外壳与 SCADA 设计系统随视口宽度连续缩放（1920 为设计基准，夹在 0.8–1.6）。

### 2.3 数据与历史

- **DAQ 历史库**，多后端可选（`server/runtime/storage/`）：**SQLite**（默认）、**InfluxDB**、**PostgreSQL**、**QuestDB**、**TDengine**。
- 每个 Tag 用自己的 `daq` 字段控制是否归档、变化是否即存、最小间隔——**归档是驱动自动行为，不需要脚本调用**。
- 历史查询走 `$getHistoricalTags()` 或趋势图控件。

### 2.4 报警与通知

- 四级报警（高高 / 高 / 低 / 提示），每组可独立设置阈值、延时、确认方式、颜色、分组。报警需在设备 Tag 上声明。
- **通知系统**：报警 / 触发器 / 登录事件可发邮件或走内部消息；通知历史独立持久化（`notifications.scadiap.db`）。

### 2.5 脚本引擎

- 工程内 JavaScript 脚本，支持**定时（interval）**、**日历排程（scheduling）**、**启动执行**。
- 内置 API 见 [3.6](#36-脚本内置-api)。

### 2.6 配方、报表、调度

- **配方**：模板（存工程）与实例（存独立库）分离，支持合并下发与进度事件。
- **报表**：可视化报表编辑器，A4 版面 / 表格 / 文本 / 定时调度，导出 PDF / Excel。
- **计划任务（Scheduler）**：日历式任务与动作绑定。

### 2.7 视频与 AI

- 多厂商摄像机接入（RTSP / 快照）、**视频墙**；
- **GB28181** 国标接入；
- **AI 检测**：检测结果接入画面与报警流。

### 2.8 平台化能力

- **用户 / 角色 / 权限**：页面级与控件级可见、可写控制。
- **API 密钥**：对外 REST 访问。
- **OPC UA Server**：把平台作为 OPC UA 服务端对外提供数据。
- **Node-RED 集成**：内置节点，可在流程里读写平台数据。
- **多语言**：中 / 英 / 俄 等。
- **插件机制**、**AR 标记 / AR 视图**、**地图点位**、**校准标定（Calibration）**。

---

## 3. 使用说明

### 3.1 登录与界面骨架

界面分三层：

```
┌─────────────────────────────────────────────┐
│  顶栏 app-header：工程保存 / 设置 / 语言 / 用户 │  ← 全局，所有页面都在
├──────────┬──────────────────────────────────┤
│  侧栏     │                                  │
│ sidenav  │   主内容区 router-outlet          │
│（仅首页） │   ├ 画面（ScadiaView 画布）        │
│          │   └ 各功能页（设备/报警/脚本/…）    │
└──────────┴──────────────────────────────────┘
        右下角：全局 FAB 菜单（编辑器 / 实验室 / 首页）
```

> **注意**：左侧栏只挂在**首页**。进入 `/device`、`/reports` 等子页后侧栏会消失，用右下角 **FAB 菜单 → 首页** 返回。

### 3.2 组态一个画面

1. 顶栏进入 **编辑器（Editor）**；
2. 新建 / 打开一个 **View**，设定设计尺寸（如 1920×1080）；
3. 从左侧图元面板拖入控件，在右侧属性面板绑定 **设备 → Tag**；
4. 配置动画、事件（点击 / 变化触发动作）；
5. **保存**——工程数据写入 `project.scadiap.db`；
6. 回到 **首页** 查看实际运行效果。

### 3.3 接入一台设备

1. **设备管理**（`/device`）→ 新建设备，选择驱动类型（如 Modbus TCP）；
2. 填连接参数（地址 / 端口 / 站号 …）；
3. 打开 **Enabled**；
4. 在「标签 / Tags」页签逐个新建 Tag（ID / 名称 / 类型 / 地址），或使用驱动的**批量扫描 / 发现**功能；
5. 需要历史归档的 Tag，打开该 Tag 的 **daq** 设置。

### 3.4 配置报警 / 通知

- **报警**：在 Tag 上声明报警条件（高高/高/低/提示 + 阈值），可设延时与确认方式；报警页（`/alarms`）与历史报警（`/messages`）查看。
- **通知**（`/notifications`）：配置收件人、订阅哪些报警等级、延迟与重复间隔；登录 / 登出等访问事件也可触发。

### 3.5 配方与下发

- 配方**模板**存在工程里；
- 配方**实例**存在服务端独立库，通过 REST 管理：

```http
POST /api/recipes/instances
{
  "typeId": "r_product_a",
  "name": "2026-10-05 批次",
  "parameters": { "temperature": 125, "pressure": 0.85, "cycleTime": 115 }
}
→ 200 { "id": "r_3f2a9c1b7d04" }

POST /api/recipes/download  { "id": "<实例id>" }
→ 202 { "result": "started", "recipeId": "...", "totalEntries": 3 }
```

下发时**逐条写 Tag**，并通过 Socket.IO 广播进度。实例里没写的项自动**沿用模板值**。

### 3.6 脚本（内置 API）

平台真实提供 **15 个**内置函数（`server/runtime/scripts/index.js`）：

| 函数 | 用途 |
|---|---|
| `$getTag(id)` | 读 Tag 值 |
| `$setTag(id, value)` | 写 Tag 值 |
| `$getTagId(name, deviceName?)` | Tag 名称 → id |
| `$setView(name, force?)` | 切换画面 |
| `$enableDevice(id, enable)` | 启用 / 禁用设备 |
| `$getDevice(id)` | 读设备 |
| `$getTagDaqSettings(id)` / `$setTagDaqSettings(id, settings)` | 读 / 写 Tag 的 DAQ 设置 |
| `$getDeviceProperty(name)` / `$setDeviceProperty(query)` | 读 / 写设备属性 |
| `$getHistoricalTags(ids, from, to)` | 读历史值 |
| `$sendMessage(url)` | 发 HTTP GET |
| `$getAlarms()` / `$getAlarmsHistory()` | 读当前 / 历史报警 |
| `$ackAlarm(id)` | 确认报警 |

**三条必须知道的行为**：

1. **脚本名（`name`）只是显示名**，可以含中文甚至空格——函数名由**脚本 ID** 派生。但 **`id` 必须是合法 JS 标识符**（`s_<功能>_<动作>`）。
2. **整段脚本被 try/catch 包着**，异常会被吞掉并返回 JSON 字符串。⇒ **改完脚本一定要实测输出的 Tag 值**，不要只看「没报错」。
3. **沙箱里的 `console` 只有 `.log`**，`console.warn` / `console.error` 会抛错且同样被吞。**日志只用 `console.log`。**

**DAQ 归档不用写代码**：在工程里给 Tag 设 `"daq": { "enabled": true }` 即可，驱动自动归档。

### 3.7 报表与历史（DAQ）

- 报表在 **报表编辑器**（`/reports`）设计，可设 `scheduling`（日 / 周 / …）自动生成；
- 导出格式（PDF / Excel）**在下载时选择**，工程文件里没有 `format` 字段；
- 历史趋势由 Tag 的 DAQ 归档支撑，趋势控件设时间范围即可。

### 3.8 工程文件与备份

| 内容 | 位置 |
|---|---|
| 工程库（画面/设备/报警/配方/脚本/报表…） | `<userDir>/_appdata/project.scadiap.db` |
| 通知运行态 | `<userDir>/_appdata/notifications.scadiap.db` |
| 用户 / 相机 / 标定 / 调度 | `_appdata/*.scadiap.db` |
| 历史 / 时序 | `_db/`（SQLite 或外部时序库） |
| 图片资源 | `_images/` |
| 日志 | `_logs/` |

**备份**：整目录复制 `<userDir>` 即可。
**导入 / 导出**：编辑器支持导出 `.scadiap` 工程文件；也可调 `POST /api/project` 直接提交整个工程 JSON。

> ⚠️ **`POST /api/project` 会先 `clearAll()` 再写库，并触发 `runtime.restart`**——即整机重启。因此界面上的「**保存到工程**」（低频）与「**下发到实时点**」（高频 `$setTag`）必须是两个独立动作。

---

## 4. 软件架构

### 4.1 总体形态

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器                                                       │
│  Angular 18 (TypeScript)                                     │
│   ├ 组态编辑器（SVG + vendored svg-edit）                     │
│   ├ 运行画面 ScadiaView（SVG 画布 + HTML 扩展控件）            │
│   ├ 功能页：设备/报警/通知/脚本/配方/报表/相机/校准/用户…        │
│   └ Socket.IO 客户端（实时值 / 事件）                          │
└───────────────▲──────────────────────────┬───────────────────┘
                │ HTTP REST                │ WebSocket (Socket.IO)
┌───────────────┴──────────────────────────▼───────────────────┐
│  Node.js / Express 服务端（server/）                           │
│   api/        19 个 REST 域                                    │
│   runtime/    运行时：devices / project / alarms / daq / …      │
│   integrations/  Node-RED 等                                   │
│   main.js     启动、路由挂载、静态托管 client/dist              │
└───────┬──────────────────┬──────────────────┬────────────────┘
        │                  │                  │
   ┌────▼────┐        ┌────▼─────┐       ┌────▼─────┐
   │ 工程库   │        │ 历史库    │       │ 现场设备  │
   │ SQLite  │        │ SQLite/  │       │ PLC/仪表  │
   │ *.db    │        │ Influx/PG│       │ 相机/…   │
   └─────────┘        │ /QuestDB │       └──────────┘
                      │ /TDengine│
                      └──────────┘
```

### 4.2 目录结构

```
server/
├── main.js                 启动入口：参数解析、目录解析、路由挂载、静态托管
├── settings.default.js     默认配置（端口、安全、存储后端、留存策略…）
├── api/                    19 个 REST 域
│   ├── auth/ users/ apikeys/              认证与权限
│   ├── projects/                          工程读写（/api/project、/api/projectData）
│   ├── devices/                           设备与 Tag
│   ├── alarms/                            报警
│   ├── recipes/                           配方模板与实例、下发
│   ├── reports/ reporting/                报表与报表引擎
│   ├── scripts/ scheduler/                脚本与计划任务
│   ├── cameras/ calibration/              视频与标定
│   ├── command/ daq/ diagnose/            命令、历史、诊断
│   └── opcua-server/ plugins/ resources/
├── runtime/                运行时（核心）
│   ├── index.js            运行时装配与生命周期
│   ├── devices/            16 个协议驱动 + device 抽象 + 通道/标签模型
│   ├── project/            工程数据：prjstorage.js（表定义）/ index.js（装配与读写）
│   ├── alarms/             报警引擎
│   ├── notificator/        通知引擎（含独立运行态存储）
│   ├── scripts/            脚本容器 msm.js（编译/执行）+ 调度
│   ├── recipes/            配方服务
│   ├── scheduler/          计划任务
│   ├── cameras/            摄像机与 GB28181
│   ├── calibration/        校准标定
│   └── storage/            存储平面：sqlite / influxdb / postgresql / questdb / tdengine
├── integrations/node-red/  Node-RED 节点
└── test/                   测试：architecture（架构守卫）/ contract / storage / 各域

client/
├── src/app/
│   ├── home/               首页（承载画面 + 侧栏）
│   ├── sidenav/ header/    外壳导航
│   ├── scadia-view/        画面渲染核心（SVG + 控件 + 缩放适配）
│   ├── editor/             组态编辑器
│   ├── device/ alarms/ notifications/ scripts/ recipes/ reports/
│   ├── cameras/ calibration/ maps/ ar/ logs/ users/ plugins/ …
│   ├── gauges/             图元与 HTML 扩展控件实现
│   └── _models/ _services/ _helpers/   模型、服务、工具
└── src/scada.css           控制室风格设计系统（.scada 命名空间，令牌化）
```

### 4.3 几个关键设计点（接手必读）

**① 工程数据的存储与装配**

- 表由 `runtime/project/prjstorage.js` 的 `TableType` 定义（`general/views/devices/alarms/recipes/notifications/scripts/reports/locations/arMarkers/mes/ems`）；
- 读路径：`project/index.js` 的 `load()` 用 `async.series` 逐步把各表装配进内存 `data`；
- **写路径**：`setProject()` 遍历工程顶层键 → 逐项落表；**末尾有一个 `else` 兜底把未知键写进 `general`**，所以新增顶层键**必须**在它之前加分支，否则会被静默写错表；
- `GET /api/project` 返回的是**内存 data**，不是直接查库。

**② 设备 → 通道 → 标签**

驱动把物理点映射成 **Tag**；Tag 的 `daq` 字段决定归档行为；脚本与画面统一按 **Tag id** 读写。

**③ 脚本执行模型**

`msm.js` 把工程里所有脚本**拼成同一个模块**再编译：

```js
async function <fn> (params) { try { <脚本代码> } catch (e) { console.log(e); return JSON.stringify(e); } }
```

函数名由**脚本 id** 派生（`fn_` + 净化后的 id）。⇒ **一个脚本出错不影响其它脚本**，但**异常会被吞掉**。

**④ 存储平面**

`runtime/storage/databases.js` 是域库文件名登记表；只有 `runtime/storage/` 可以 `require('sqlite3')`。历史后端可整体切换（SQLite / InfluxDB / Postgres / QuestDB / TDengine），架构测试会校验契约一致性。

**⑤ 架构守卫**

`server/test/architecture/` 下有一批**架构守卫测试**（依赖方向、跨域隔离、域库文件登记、枚举契约同步、API 开放面冻结等）——它们把架构约束变成**可执行断言**。**改架构前先跑它们。**

### 4.4 运行与测试命令

```bash
cd server

npm start                    # 启动服务
npm test                     # 全量 mocha
npm run test:lint            # ESLint（门禁口径）
npm run test:gate            # ★ 主要门禁：各域 + architecture + contract
npm run test:architecture    # 架构守卫
npm run test:contract        # 存储适配器契约（需后端容器）
npm run test:storage         # 存储测试

npm run test:backends:up     # 起 Postgres / TDengine 测试容器（需 Docker）
npm run test:backends:down   # 停容器

cd ../client
npx ng build                 # 构建前端（产物 client/dist，由后端托管）
npx ng test                  # 前端单测
```

> `test:gate` 是**停机容器**下也可跑的主力门禁；若容器未起，存储契约用例会显示为 **pending** 而非失败——属正常。

---

## 5. 附录

### 5.1 详细文档

| 文档 | 内容 |
|---|---|
| `docs/Getting-Started.md`、`docs/Installing-and-Running.md` | 安装与启动 |
| `docs/HowTo-*.md`（20+ 篇） | 设备与标签、绑定控件 / 图形、动画、事件、脚本、报警、配方、报表、调度、UI 布局、Node-RED、ODBC、WebSocket 等分主题操作 |
| `docs/zh/01_架构手册.md` | **完整架构手册**（系统定位、进程与端口、后端运行时、前端架构、数据流、存储平面、协议驱动、安全、部署形态） |
| `docs/zh/02_程序编制手册.md` | **开发手册**（环境、构建、测试、代码约定、**扩展指南**：加驱动 / 控件 / 接口 / 路由 / 语言 / 图元） |
| `docs/zh/25_模块总览.md` | 模块清单与边界 |
| `docs/zh/12_前端融合与UI一致性规范.md` | 前端设计基因与一致性硬规则 |
| `docs/zh/22_契约06_存储平面五域契约.md` | 存储平面契约 |
| `docs/zh/19_能力矩阵_存储后端.md` | 各存储后端能力对照 |
| `docs/zh/24_第三方组件与许可清单.md` | 第三方组件与许可 |
| `internal/核查与风险报告.md`、`internal/疑难与未解清单.md` | 已知缺陷与未解项（**接手前务必读**） |
| `internal/开发与验收账.md` | 逐批次开发与验收账（最完整的追溯记录） |
| `internal/TDengine许可边界裁决.md` | TDengine 使用与许可边界裁决 |

> `internal/` 放的是**内部工程过程资料**（核查报告、未解清单、逐批次开发账、许可裁决）。它们记录了缺陷与决策的来龙去脉，对二次开发很有价值，但不是产品文档，故与 `docs/` 分开。

### 5.2 示例工程（`examples/`）

本仓带两份**可直接导入运行的示例工程**：

| 目录 | 内容 | 怎么用 |
|---|---|---|
| `examples/mes-ems-template/` | **MES/EMS 工程模板**（`.scadiap`）+ 开发手册 + README | 编辑器导入 `mes-ems-template.scadiap`；手册说明工单 / OEE / 能耗 / 碳排的建模与脚本 |
| `examples/mes-ems-design/` | MES/EMS 落地设计（数据模型、prjstorage 改动、组态界面草稿、交付计划） | 二次开发时对照阅读 |
| `examples/exhibition-project/` | **展厅 / AI 检测示例工程**（8 个画面：AI 检测、数据展示、视频监控、报警查询、顶部标题栏、左列表、报警图片预览、进入平台）+ 全部图片素材 | 用 `--userDir` 指到该目录启动即可看到完整示例 |

**导入示例工程**：

```bash
# 方式一：作为整个运行目录（推荐，含图片素材）
cd server
node main.js --port 1881 --userDir "../../examples/exhibition-project"

# 方式二：在编辑器里导入 .scadiap 模板工程
#   编辑器 → 打开工程 → 导入 examples/mes-ems-template/mes-ems-template.scadiap
```

> ⚠️ **示例工程已做安全清洗**：其中 `settings.js` / `mysettings.json` 的 `secretCode` 已替换为占位符、SMTP 口令已清空；`users.scadiap.db`（含管理员口令散列）**未随仓发布**。
> ⇒ **首次运行示例前请自行设置 `secretCode`，并按需创建管理员账号。**

### 5.3 许可


本项目 **MIT License**（见 `LICENSE`）。上游 FUXA 同为 MIT。第三方组件、字体与图标字体的许可见 `docs/zh/24_第三方组件与许可清单.md`。

### 5.4 安全提示

- 生产部署请开启 `secureEnabled`，并**立即修改默认口令**。
- 配置文件（`settings.js` / `mysettings.json`）与运行目录（`_appdata` / `_db` / `_logs`）**不要提交进版本库**——本仓已通过 `.gitignore` 排除。
- 对外暴露前请评估 OPC UA Server、API 密钥、Node-RED 的开放面。
