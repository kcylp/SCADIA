# 开诚智枢 · Kaicheng SCADIA — 架构评审文档

> 本文档用于架构评审：从产品定位 → 调研预期 → 架构设计 → 代码成果，完整呈现，供 reviewer 逐层检查。

---

## 一、产品定位（我要做出什么）

**一句话**：开诚智枢 SCADIA 是一套 **Web 组态 SCADA / HMI 工业智能中枢**，覆盖**采集 / 视频 / 诊断 / 预测**四项核心能力，面向煤矿、矿山、水处理等工控场景，**非程序员工控人员也能上手**。

**版本**：V1.0（当前已完成品牌化 + 底座增强，架构重构进行中）

**四核心能力**：
| 能力 | 含义 | 落地 |
|---|---|---|
| 采集 | 现场数据接入 | Modbus TCP/RTU、S7、OPC UA(客户端+服务端)、MQTT、WebSocket、HTTP/WebAPI、BACnet、EtherNet/IP、FTP(待做) |
| 视频 | 视频监控 + AI 分析 | RTSP/GB28181 国标接入、视频墙、视数融合、AI 检测框叠加 |
| 诊断 | 报警 + 趋势 | 报警引擎、实时趋势、历史查询 |
| 预测 | 趋势外推 + 预警 | 基于历史数据趋势外推、阈值预警(待做) |

**扩展方向**（已调研、纳入规划）：
- **数字孪生**：Three.js 嵌入组态画面，无缝接入
- **AI 视觉模型**：VLX-Seek（细粒度检测）、VLX-Flow（流式视频理解）、VLX-VR（视频推理）、VLX-Go（具身导航）
- **智能体网关**：REST + WebSocket 对接煤矿智能体
- **数据库**：SQL Server / MySQL / PostgreSQL（当前 SQLite 为主）

---

## 二、核心架构铁律（最高优先级）

**这是一套「取其精华、弃其糟粕」的大集合体**：拼接了多个开源项目的精华功能（视频/GB28181、OPC UA Server、WebSocket 驱动、AI 视觉、标定、三层模型等）。

**架构铁律：模块解耦、相互独立、互不影响 —— 不能「改一处而动全身」。**

每个功能都必须是**可独立启停、独立测试、独立替换**的模块：

| 解耦维度 | 要求 |
|---|---|
| 功能隔离 | 新增/停用一个功能，不牵动其他功能 |
| 实现隔离 | 改一个驱动的实现，不影响其他驱动或数据层 |
| 数据稳定 | tagId 全局主键不变 → **历史归档(DAQ)/报警/标定/调度/报表/趋势图表/实时图表/配方/脚本/OPC UA 发布** 全部零改动（tagId 是这些数据消费者的统一引用锚点） |
| 独立替换 | AI 模型、数据库后端、视频网关可单独替换，不动核心 |

**落地机制**：
- 设备驱动走统一外壳 `device.js` + `loadPlugin`/注册表，新增驱动不改核心派发
- 各子系统（视频/AI/GB28181/OPC UA/标定）独立 `init/stop`，关闭互不影响
- 数据层多后端走 `storage/` 抽象层，配置切换
- 新增能力一律「旁挂」而非「侵入」：如 AI 推理服务在外部进程，平台只做接入层

---

## 三、调研预期（爬虫得到的"样子"）

对 GitHub 同类项目做了全量摸底（star>100、活跃维护、宽松许可）。结论：**没有一个开源项目同时满足全部需求**，精华分散在各处：

| 参考项目 | Stars | 许可 | 取其精华 |
|---|---|---|---|
| FUXA（底座） | 5.1k | MIT | Web组态编辑器、设备管理、非程序员友好 |
| dgiot | 4.8k | Apache-2.0 | 300+ 协议广度 |
| Frigate | 36.2k | MIT | AI 视频分析/NVR 架构（RTSP→检测→MQTT 事件） |
| VLX-Seek/Flow/VR/Go | 1.2k~180 | Apache-2.0 | 端侧视觉语言模型（检测/流式/推理/导航） |
| realvirtual-WEB | 147 | — | Three.js 数字孪生 HMI |
| node-opcua | 1.6k | MIT | OPC UA Server（补缺口） |

**明确不取（糟粕）**：加密锁授权、随包分发系统 DLL、ActiveX/OCX、GPL/AGPL 传染组件（jessibuca、TDengine、Grafana、ultralytics）。

**选型定稿**：
| 能力 | 选型 | 理由 |
|---|---|---|
| 视频网关 | ZLMediaKit | 唯一同时覆盖 WebRTC+HLS+HTTP-FLV+GB28181 |
| 浏览器播放 | WebRTC(WHEP) 首选 → HTTP-FLV → HLS | 延迟 200-500ms 起步，逐级降级 |
| AI 检测 | Frigate 模式（RTSP→检测→MQTT/WS 事件） | 36k star 验证的架构 |
| OPC UA Server | node-opcua | 与现有 Node 栈一致 |
| 智能体 | REST + WebSocket + MCP 兼容层 | 与煤矿智能体复用 |

---

## 四、架构设计

### 3.1 总体分层

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 (Angular SPA)                   │
│  组态画面(SVG) | 视频监控 | 数字孪生(Three.js) | 报警趋势 │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP/S + Socket.IO :1881
               ▼
┌─────────────────────────────────────────────────────────┐
│              SCADIA Server (Node.js 20)                  │
│  ┌───────────┐ ┌──────────┐ ┌────────┐ ┌────────────┐  │
│  │ Express   │ │ Socket.IO│ │ Runtime│ │   REST     │  │
│  │ 静态前端  │ │ 实时通道  │ │  总线  │ │   API      │  │
│  └───────────┘ └──────────┘ └────────┘ └────────────┘  │
│                                                         │
│  ┌────────────┐ ┌────────────┐ ┌─────────────────────┐ │
│  │ 设备驱动层  │ │ 视频/AI层  │ │     数据层           │ │
│  │ Modbus/S7  │ │ GB28181    │ │ SQLite(默认)        │ │
│  │ OPC UA     │ │ RTSP/RTP   │ │ MySQL/PostgreSQL    │ │
│  │ MQTT       │ │ VLX-Seek   │ │ DAQ历史(时序)       │ │
│  │ WebSocket  │ │ VLX-Flow   │ │                     │ │
│  │ HTTP/FTP   │ │ VLX-VR     │ │                     │ │
│  │            │ │ VLX-Go     │ │                     │ │
│  └────────────┘ └────────────┘ └─────────────────────┘ │
│                                                         │
│  OPC UA Server :4840  │  AI WS :1890  │  GB28181 :5060 │
└─────────────────────────────────────────────────────────┘
```

### 3.2 关键数据流

**采集链**：`现场设备 → 驱动轮询 → device 外壳 → 运行总线 → ①内存值表 ②变化检测(deadband) ③报警判断 → ④Socket.IO 推浏览器 ⑤DAQ 归档`

**操作链（写）**：`浏览器 → Socket.IO → device.setValue → 驱动打包协议帧下发 → 等设备确认才回报成功`（诚实写语义）

**视频链**：`摄像机(RTSP/GB28181) → cameras 子系统 → ZLMediaKit 转码 → 浏览器 WebRTC/HLS；AI 结果经 MQTT/WS 进平台 → 归一化 → 叠加框 + 报警回写 Tag`

### 3.3 核心设计决策

1. **设备→通道→变量 三层模型**（B4）：`device.channels`（可选分组）+ `device.tags[tagId]`（扁平主键，tag 带 `channelId` 属性）。**关键取舍**：通道是 tag 的**属性**而非**容器**，tagId 不变 → 历史归档/报警/标定/调度/报表/图表/趋势/配方/OPC UA 发布 全部零改动，老工程无缝加载。

2. **OPC UA Server**（B1）：把内部变量/相机状态/AI 报警对外发布，地址空间 `SCADA/Devices|Cameras|Ai/...`。**关键坑**：node-opcua 变量绑 `get` 闭包会废掉 `setValueFromSource`，订阅永远收不到推送 → 改为标准 OPC UA 模型（变化事件推送 + tagPollMs 扫描兜底）。

3. **视数融合**（A5）：OSD 叠加（服务端解析 Tag 值 → 前端 1Hz 轮询）、在线状态回写（VD/VC 状态变量）、报警联动（AI/IVS 事件写 Tag）。**服务端解析 OSD**，前端不接触 HMI socket 内部结构。

4. **AI 检测框归一化**（A9）：引擎像素框/归一化框统一转 `region{x,y,w,h}∈0..1`，服务端完成归一化，前端只按百分比定位。**框是易失数据**（ttlMs 默认 5s，不落盘）。

5. **品牌化 + 数据兼容**（本次）：`FUXA→SCADIA`、`.fuxap.db→.scadiap.db`，`device.js` 保留 `'FuxaServer'→'SCADIAServer'` 运行时归一化，老工程数据无缝迁移。

### 3.4 诊断能力（实时报警 + 历史报警 + 趋势）

| 能力 | 模块位置 | 机制 |
|---|---|---|
| **实时报警** | `runtime/alarms/index.js`（AlarmsManager 报警引擎） | 定时检查报警规则（`setInterval` 轮询）→ 命中即产生实时报警 → Socket.IO 推浏览器报警条 → 可 Ack/Resume |
| **历史报警** | `runtime/alarms/alarmstorage.js` + `_appdata/alarms.scadiap.db` | 报警历史落库；`getAlarmsHistory(start,end)` 按时间范围查询历史报警 |
| **报警定义/查询 API** | `api/alarms/index.js` | 报警规则 CRUD + 历史查询 |
| **实时趋势** | Socket.IO 实时值通道 → 前端图表控件（uPlot/ngx-chart） | tagId 订阅实时值，1Hz 刷新曲线 |
| **历史趋势** | `runtime/storage/*`（DAQ）+ `getHistoricalTags(tags,from,to)` | 按 tagId 拉历史时间序列，渲染趋势/报表 |

**关键**：实时报警、历史报警、趋势、报表**全部靠 tagId 引用测点**——报警规则绑 tagId、报警历史按 tagId 记录、趋势/报表按 tagId 取数。所以 tagId 稳定 = 诊断能力的全部历史数据绑定都稳定。

### 3.5 归档 + AI 分析/诊断/预测（四能力之"预测"）

**① 归档触发机制（采集侧，复用现有 DAQ 引擎）**：
- **变化触发归档**：变量值变化超过死区（deadband）才记录 —— 减少存储、只留有意义的变化
- **周期归档**：任意设定时间间隔记录（如 5s / 1min / 1h）
- 归档存储：DAQ 引擎统一写入，后端可切换（SQLite / InfluxDB / QuestDB / TDengine）

**② AI 分析子系统（预测能力，新增）**：

数据流：`归档数据 → 知识库增强 → 领域门控 → 模型推理 → 结构化输出 → 反馈闭环`

| 环节 | 设计 | 解耦要点 |
|---|---|---|
| **数据读取** | 走 DAQ 统一查询 API `getHistoricalTags(tags, from, to)` 读归档数据，**不直接碰物理数据库** | AI 模块只依赖 tagId + 时间范围，换存储后端（SQLite→MySQL→TDengine）零改动 |
| **变量启用** | 变量定义时标记 `tag.aiAnalysis.enabled=true`，**只有选中的变量才参与分析** | 未选中变量不产生分析成本/token |
| **知识库(RAG)** | 导入 MD 文件（资深工程师知识/手册/规程）→ 向量化 → 本地知识库 → 检索相关片段增强 prompt | 知识库独立可更新，换模型/换知识不耦合 |
| **领域边界门控** | 检索相关性低于阈值 → 判定「与项目无关」→ **拦截并提示「提问跑偏」** | 防跑题，不做无效推理、不烧 token |
| **模型接入** | 三层可配：①云端 API 大模型 ②本地部署大模型（Ollama/vLLM）③**CCSwitch 兼容中转站**（拉模型列表/切换/**Token 消耗**统计） | 模型来源可替换，分析核心逻辑与模型商解耦 |
| **结构化输出** | 结果带**类型契约**：`analysis`(文本解读)/`chart`(趋势预测曲线)/`report`(分析报告)/`alarm`(预测异常→报警)/`metric`(预测值·置信度，可绑定 tag) | 结果可直接绑定画面图表/报表/报警条，不是死文本 |
| **反馈闭环(持续学习)** | 人工对结果打标(对/错/修正) → 回写知识库/校准参数 → 下次预测更准 | 学习是旁路闭环，不阻塞分析主链路 |

**关键取舍（呼应"改一处不动全身"）**：
1. AI 分析是**旁挂**能力，只"读"归档数据（经统一 API）不"写"回归档库，不侵入 DAQ/报警/趋势既有链路
2. 变量是否参与分析是**定义时的一个标记**，不是另起数据模型——tagId 仍是唯一锚点
3. 模型、知识库、输出目标是**三个可替换适配器**，分析核心逻辑（选变量→取数→检索→组 prompt→收结果）与它们解耦
4. **领域门控**是独立前置环节，跑偏直接拦截，不进模型——既省 token，又保证输出始终围绕本项目工控数据

---

## 五、代码成果（现状）

### 4.1 目录结构（关键路径）

```
开诚智枢 · Kaicheng SCADIA/
├─ 00_交付说明.md / 01_架构手册.md / 02_PLAN_集成规划.md / 03_PLAN_展厅画面.md
├─ 04_展厅产物/          # images/ views/ render/（展厅画面转换产物）
├─ project/             # 工程数据（_appdata/*.scadiap.db、_images、_db）
└─ source/
   ├─ server/           # Node.js 后端
   │  ├─ main.js        # 入口（Express + Socket.IO + 静态前端）
   │  ├─ scadia.js      # 门面（init/start/stop）
   │  ├─ runtime/       # 运行核心
   │  │  ├─ index.js    # 运行总线（事件派发 + Socket.IO 推送）
   │  │  ├─ devices/    # 设备驱动（18 个驱动 + channel-utils + tag-io）
   │  │  ├─ cameras/    # 视频/GB28181/AI/融合
   │  │  ├─ opcua-server/  # OPC UA 服务端
   │  │  ├─ storage/    # DAQ（SQLite/InfluxDB/QuestDB/TDengine）
   │  │  ├─ alarms/ scripts/ scheduler/ recipes/ calibration/ users/
   │  │  └─ project/    # 工程存取（SQLite prjstorage）
   │  ├─ api/           # REST（19 个域）
   │  └─ tools/         # ic-to-scadia.js（画面迁移）、verify-views.js
   └─ client/           # Angular 18 前端
      └─ src/app/       # 组态编辑器 + 设备/视频/报警/标定等页面
```

### 4.2 已完成的增强（相对底座）

| 模块 | 能力 | 门禁 |
|---|---|---|
| A1-A9 视频 | 相机后端、ZLMediaKit 网关、相机管理页、视频墙、视数融合、PTZ、GB28181 国标、AI 视频分析 | G1-G7 全过 |
| B1 | OPC UA Server | 15 单测 + 真实客户端 E2E |
| B2 | WebSocket 设备驱动 | 19 单测 + WS 回环 |
| B3 | HTTP 批量写/长轮询/导入导出 | 49 单测 |
| B4 第1步 | 设备→通道→变量三层（后端） | 56 单测 |
| 标定 | 传感器标定模块 | 完整 |
| 品牌化 | FUXA→SCADIA 全量替换 + 数据迁移 | 本次完成 |

**全量测试基线**：436 passing（含既存 2 条 Windows 环境失败）。

### 4.3 数据模型

```
工程(Project)
├─ 设备(Device) → 通道(Channel,可选) → 变量(Tag, tagId 全局主键)
├─ 画面(View, SVG + items)
├─ 报警/配方/脚本/定时任务/报表/用户/相机
```

存储：SQLite `_appdata/project.scadiap.db`（12 表，`name TEXT PRIMARY KEY, value TEXT` 结构）。

---

## 六、待办（架构重构路线）

| Phase | 内容 | 状态 |
|---|---|---|
| Phase 1 | 品牌化 + 数据迁移 | ✅ 已完成 |
| Phase 2 | 多数据库（MySQL/PostgreSQL/SQL Server + 可视化写回） | ⏳ |
| Phase 3 | FTP 驱动 + 驱动注册表 | ⏳ |
| Phase 4 | AI 视频（VLX 系列 + 海思/Jetson 推理接入） | ⏳ |
| Phase 5 | **AI 分析诊断预测**（归档数据 → 云端/本地/中转站大模型分析；变量启用标记；Token 消耗统计） | ⏳ |
| Phase 6 | Three.js 数字孪生嵌入 | ⏳ |
| Phase 7 | 展厅画面收尾 + V1.0 验收 | ⏳ |

---

## 七、请 reviewer 重点检查

1. **解耦性（最高优先）**：现有模块边界是否真解耦？有无隐性耦合会"改一处动全身"？
2. **数据稳定性**：tagId 作为统一引用锚点，历史归档/实时报警/历史报警/报表/图表/趋势/AI 分析等数据消费者是否真能做到"改通道/改设备不破坏既有数据绑定"？
3. **AI 分析数据读取**：走 DAQ 统一 API 读归档数据（不直接碰物理库）这个取舍是否正确？有无更优解？
4. 三层模型"通道是 tag 属性而非容器"取舍有无隐患
5. 品牌化 + 数据兼容方案（运行时归一化 + .db 重命名）是否稳妥
6. AI 视频"外部推理 + 平台接入"是否真能独立替换模型
7. AI 分析"变量启用标记 + 模型可替换 + 中转站 token 统计"设计是否完整、有无解耦隐患
8. Phase 2-7 优先级与风险点
