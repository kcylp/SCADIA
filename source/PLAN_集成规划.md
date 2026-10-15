# 开诚智枢scada 集成规划（PLAN）

> 基线：SCADIA `566f65f` · 文档日期：2026-09-29
> 原则：**取其精华、去其糟粕**——对标展厅平台（展厅平台）做专业级能力，
> 但用 Web 原生架构取代其 ActiveX/加密锁/随包系统 DLL 的老路子。

---

## 一、理解：展厅视频子系统（已读其官方手册第 12 章 + 插件包）

资料位置：`G:\开源sacda\展厅资料\`（`展厅平台标准版 3.0 帮助文档.docx`、`RTSPDevice.dpk`），
运行环境：`C:\Users\kc\Desktop\展厅\`。

### 1.1 它的架构（三层 + 插件驱动）

| 层 | 展厅概念 | 说明 |
|---|---|---|
| 服务层 | **视频服务计算机 / VSS**（`展厅视频服务.exe`） | 独立进程，连接并管理视频设备，向监控端提供视频服务；支持单机与**分布式**多节点 |
| 设备层 | **视频处理器**（VD，如 NVR/DVR/IPC）+ **摄像机**（VC，通道） | 处理器下挂通道；每个设备有**状态变量**（VD=VideDevice、VC=VideoCamera，1 在线 / 0 离线） |
| 呈现层 | **视频监控器**对象 | 四区结构：监控窗口 + 操作盘 + 工具栏 + 资源区 |

### 1.2 驱动插件模型（精华）

```
Drivers/Video/{x86,x64}/CE.VDDrive.<厂商>.<型号>.dll
VideoDevices.config  ← 注册表：Name / Class / Assembly
```
- 已见驱动：海康 `DS6101HF`/`DS7604NE1`、大华 `DHNVR4416`、宇视 `ECR3316`、
  松下 `WJND400KCH`、宏电 `HT8504VTU`、`Eipvision`、`USB`。
- **通用 RTSP 驱动** `RTSPDevice.dpk`：内含 **FFmpeg**（avcodec/avformat/swscale/…）+ `FFmpeg.AutoGen`
  + `VideoDriverLib.dll`（驱动契约）+ SharpDX(D3D9/XAudio2) + SDL2 + DirectShowLib。
  → **结论：一个 FFmpeg 版 RTSP 驱动即可覆盖海康/大华/宇视的绝大多数型号。**
- 驱动安装器 `VideoDriverInstaller.exe`，配置可**导入/导出**在服务端与监控端之间同步。

### 1.3 摄像机能力（可对标项）

- 基本信息：名称/说明/**通道**/**在线状态变量**
- **设备录像**计划（起止时间，由 NVR 执行）
- **预置点**（含"重要"标记→快捷预置点）与**巡航路径**（多预置点 + 停留时间）
- **OSD 字幕**：文本 / 时间日期 / **数值文本（关联工程变量）**
- **独立云台**（外置云台，参数与工程变量关联）
- **摄像机分组**、**导航地图**（矢量/在线/图片）、经纬度动画

### 1.4 视频监控器对象（可对标项）

- **监控窗口**：行列布局、合并/拆分、一个窗口多机**轮巡**（自动/手动 + 切换时间）、
  显示方式（居中/铺满）、**主码流/子码流**切换、选中边框色、右键菜单
- **操作盘**：云台方向（步幅）、预置点（列表/快捷按钮）、巡航、镜头（焦点/焦距/光圈）、
  视频参数（亮度/对比/饱和/色调/音量）、功能区筛选
- **工具栏**：最大化/全屏、手动自动切换、上/下一个、切换摄像机、**监控/图片回放/录像回放**、
  字幕开关、**截图**、**录像**、语音对讲、广播、**布防/撤防**、窗口布局、配置
- **资源区**：摄像机列表/分组/录像/图片
- **在线配置**：运行时改布局、增删预置点与巡航路径

### 1.5 视数融合（展厅的核心卖点，必须对标）

- OSD 显示实时变量；视频设备**报警信号 ↔ 工程变量**双向关联；
- **程序控制**：变量/状态驱动云台、预置点、巡航、录像、截图、广播对讲；
- **视频分析**：调用第三方类库/程序，规则命中→触发工程报警。

### 1.6 明确不取的"糟粕"

- 加密锁授权（按通道售卖）、`展厅视频服务` 必须插锁；
- 随包分发 `kernel32.dll / oleaut32.dll / mscoree.dll / shlwapi.dll` 等系统 DLL；
- ActiveX/OCX、x86+x64 双份二进制、必须逐机安装驱动；
- 驱动闭源、必须联系厂商获取（`RTSPDevice.dpk` 还是加密 ZIP）。

---

## 二、我们的现有底座（已核实，不重复造）

| 能力 | 现状 |
|---|---|
| 设备驱动 | Modbus RTU/TCP、Siemens S7、**OPC UA（仅客户端）**、BACnet、EtherNet/IP、Omron、MELSEC、**MQTT**、**HTTP/WebAPI**、**ODBC(SQL 读)**、ADS、GPIO、Redis、WebCam、内部变量 |
| 变量归档 | **已有** DAQ 历史库：SQLite / InfluxDB / QuestDB / TDengine + `getHistoricalTags(tags, from, to)` |
| 实时通道 | Socket.IO（可复用于视频/AI 事件） |
| 脚本/调度 | scripts、scheduler、Node-RED |
| 安全 | JWT、API Key、组权限、`secureEnabled` |
| 外部写 | `POST /api/setTagValue` |
| 本次新增 | 标定模块（完整）、SCADA 设计系统、中文全量、**相机模块后端+API** |

**缺口清单**：OPC UA **Server**、**WebSocket 设备驱动**、**视频监控**、
**智能体网关**、SQL 的**可视化配置/写回**、归档的**可视化配置界面**。

---

## 三、分期计划

### Phase A — 视频监控（对标展厅第 12 章，Web 原生）

**技术路线（关键决策）**：浏览器零插件。
`RTSP → 服务端网关 → WebRTC(WHEP，低延迟首选) / HLS(兼容) / MJPEG(兜底)`。

| 编号 | 内容 | 状态 |
|---|---|---|
| A1 | 后端：相机存储/CRUD、厂商模板（海康/大华/宇视/ONVIF/自定义）、Basic/Digest 认证取流、快照代理 | ✅ 已完成 |
| A2 | **流媒体网关**：RTSP→WebRTC/HLS/MJPEG 转码；优先对接 **ZLMediaKit**，内置 FFmpeg 作为兜底 | ⏳ |
| A3 | 前端：**相机管理页**（SCADA 风格、实时预览、模板表单） | ✅ 已完成 |
| A4 | 前端：**视频监控器对象**（监控窗口布局/操作盘/工具栏/资源区）+ 可嵌入组态画面 | ✅ 已完成 |
| A5 | 视数融合：**OSD 变量叠加**、VD/VC **状态变量回写**、报警↔变量关联 | ✅ 已完成 |
| A6 | 云台：PTZ/预置点/巡航；本地**截图/录像/回放** | ✅ 云台/预置点已完成 |
| A7 | 分布式：多视频服务节点 + **配置导入/导出**（对标 VSS） | ⏳ |
| A8 | 视频分析/AI：检测结果经 WebSocket 接入 → **画面叠加框** + 触发报警 | ⏳ |

### Phase B — 协议互联（补齐"主力对接方式"）

| 编号 | 内容 |
|---|---|
| B1 | **OPC UA Server**：把内部变量/标定/相机状态对外发布（SCADIA 目前只有客户端） |
| B2 | **WebSocket 设备驱动**：统一订阅式接入（与 MQTT 并列的主力方式） |
| B3 | HTTP/WebAPI 增强：订阅/长轮询、批量写、导入导出 |
| B4 | 设备/通道/冗余模型对齐展厅（设备→通道→变量三层 + 冗余） |

### Phase C — 智能体对接（煤矿智能体可复用）

| 编号 | 内容 |
|---|---|
| C1 | **Agent Gateway**：REST + WebSocket（可加 MCP 风格工具协议），鉴权 + 审计 |
| C2 | 工具集：读/写变量、查历史、读报警、控制相机/PTZ、触发标定、查询设备状态 |
| C3 | 事件推送：报警/阈值/视频分析结果 → 智能体（回调/队列） |

### Phase D — 数据库与归档

| 编号 | 内容 |
|---|---|
| D1 | **SQL 数据源管理**：SQL Server / MySQL / PostgreSQL / Oracle / Access / ODBC，查询与**写回**可视化 |
| D2 | **变量归档配置界面**：对标展厅"变量数据库/变量分组"，复用现有 DAQ 引擎 |
| D3 | 历史趋势 / 报表对象（对标其历史趋势、报表浏览器） |

---

## 四、里程碑

- **M1（视频可用）**：A1+A2+A3 —— 能看、能配、能预览
- **M2（视频专业）**：A4+A5+A6 —— 监控器对象 + 视数融合 + PTZ
- **M3（互联完备）**：B1+B2 —— OPC UA Server + WebSocket
- **M4（智能体）**：C1+C2
- **M5（数据归档）**：D1+D2

## 五、待你决策（影响架构，非小事）

1. **流媒体网关**：优先对接 **ZLMediaKit**（成熟稳定、支持 WebRTC/HLS/GB28181）还是先内置 FFmpeg？
2. 是否需要 **GB28181**（国标平台接入）？
3. **智能体协议**：REST / WebSocket / MQTT / MCP 风格，哪几种必须？
4. **数据库优先级**：SQL Server / MySQL / PostgreSQL / Oracle 先做哪个？
5. 是否接受在服务器侧引入 **FFmpeg 或 ZLMediaKit**（本机目前没有 ffmpeg）？

---

## 六、GitHub 实拉核实（2026-09-29，GitHub API 直连，非记忆）

### 6.1 视频 / 流媒体

| 仓库 | Stars | 语言 | License | 角色 |
|---|---:|---|---|---|
| ZLMediaKit/ZLMediaKit | 17,586 | C++ | MIT（非标准文本） | **网关首选**：WebRTC/RTSP/RTMP/HLS/HTTP-FLV/WS-FLV/HTTP-TS + GB28181 |
| bluenviron/mediamtx | 20,292 | Go | MIT | 备选网关（纯 Go、易部署） |
| AlexxIT/go2rtc | 14,277 | Go | MIT | 轻量多协议，edge 拉流 |
| ossrs/srs | 29,301 | C++ | MIT | 大流量直播 |
| video-dev/hls.js | 16,958 | TS | Apache-2.0 | 浏览器 HLS 播放 |
| xqq/mpegts.js | 2,280 | JS | Apache-2.0 | 浏览器 HTTP-FLV（flv.js 后继，推荐） |
| bilibili/flv.js | 23,186 | JS | Apache-2.0 | 老牌 FLV（2024 停更） |
| langhuihui/jessibuca | 2,909 | C | **GPL-3.0 ⚠️** | 强但传染，默认不引入 |
| deepch/RTSPtoWebRTC | 1,790 | JS | MIT | 轻量 RTSP→WebRTC |
| pion/webrtc | 16,808 | Go | MIT | WebRTC 栈 |
| blakeblackshear/frigate | 36,169 | TS | MIT | **视频+AI 最佳参考**：RTSP + 目标检测 + MQTT 事件 |
| gowvp/owl | 808 | Go | — | GB28181 NVR |
| 648540858/wvp-GB28181-pro | 7,336 | Java | MIT | GB28181 平台（若要国标接入） |
| agsh/onvif | 787 | TS | — | **Node/TS ONVIF 客户端**（发现/PTZ/取流地址） |

### 6.2 协议 / 驱动

| 仓库 | Stars | License | 用途 |
|---|---:|---|---|
| node-opcua/node-opcua | 1,662 | MIT | **OPC UA Server（补 B1 缺口）** |
| Open62541/open62541 | 3,231 | MPL-2.0 | C 版 OPC UA |
| gopcua/opcua | 1,065 | MIT | Go 版 OPC UA |
| FreeOpcUa/opcua-asyncio | 1,485 | LGPL-3.0 | Python 版 |
| emqx/emqx | 16,765 | — | MQTT Broker |
| mqttjs/MQTT.js | 9,115 | — | MQTT 客户端（SCADIA 已用） |
| stephane/libmodbus | 4,259 | LGPL-2.1 | Modbus 参考 |

### 6.3 归档 / 时序库

| 仓库 | Stars | License | 备注 |
|---|---:|---|---|
| apache/iotdb | 6,403 | Apache-2.0 | **工业时序库，归档可选后端** |
| timescale/timescaledb | 23,617 | — | PG 时序扩展 |
| influxdata/influxdb | 31,758 | Apache-2.0 | SCADIA 已内置 |
| questdb/questdb | 17,374 | Apache-2.0 | SCADIA 已内置 |
| taosdata/TDengine | 25,146 | **AGPL-3.0 ⚠️** | SCADIA 已内置（注意授权） |
| VictoriaMetrics | 17,782 | Apache-2.0 | 高压缩 |
| prometheus/prometheus | 66,304 | Apache-2.0 | 指标 |

### 6.4 智能体 / AI

| 仓库 | Stars | License | 用途 |
|---|---:|---|---|
| modelcontextprotocol/servers | 90,656 | — | **MCP 工具协议（智能体对接）** |
| langgenius/dify | 157,464 | — | 智能体/工作流平台 |
| langchain-ai/langchain | 147,234 | MIT | LLM 编排 |
| FlowiseAI/Flowise | 55,489 | — | 低代码智能体 |
| roboflow/supervision | 51,072 | MIT | 检测结果绘制/跟踪（视频叠加） |
| ultralytics/ultralytics | 62,086 | **AGPL-3.0 ⚠️** | YOLO（服务端推理，AGPL 传染） |
| PaddlePaddle/PaddleDetection | 14,434 | Apache-2.0 | **检测模型（可商用）** |

### 6.5 竞品（Web SCADA / HMI）

| 仓库 | Stars | License | 定位 |
|---|---:|---|---|
| kcylp/SCADIA | 5,067 | MIT | **我们底座** |
| thingsboard/thingsboard | 22,490 | Apache-2.0 | IoT 平台（强竞品） |
| grafana/grafana | 76,981 | **AGPL-3.0 ⚠️** | 可视化（授权风险） |
| SCADA-LTS/Scada-LTS | 1,013 | **GPL-2.0 ⚠️** | Web SCADA |
| god-jason/iot-master | 867 | **GPL-3.0 ⚠️** | 国产 IoT（物联大师） |
| RapidScada/scada | 746 | Apache-2.0 | .NET SCADA |

### 6.6 核实结论（已据此修正代码）

1. **`addStreamProxy` / `delStreamProxy`**:`key` 必须是 `vhost/app/stream`（`__defaultVhost__/camera/cam_x`）。原实现写 `app/stream` → **已修正**。
2. **WebRTC 播放**：标准接口是 **`/index/api/whep`**（`Content-Type: application/sdp`，成功 201 + Location）；`/index/api/webrtc` 要求 `application/json`。**已改用 WHEP**。
3. **`secret` 为必填** → 绝不能下发浏览器。**已改为后端代理** `/api/cameras/:id/whep`（顺带消除 CORS）。
4. **`addStreamProxy` 仅支持 H264/H265/aac/G711/opus** —— 覆盖海康/大华/宇视主码流，足够。
5. **授权规避**：默认不引入 GPL/AGPL 组件（jessibuca、TDengine、Grafana、SCADA-LTS、iot-master、ultralytics）。

### 6.7 选型定稿

| 能力 | 选型 | 理由 |
|---|---|---|
| 视频网关 | **ZLMediaKit** | 唯一同时覆盖 WebRTC+HLS+HTTP-FLV+GB28181，中文生态成熟 |
| 浏览器播放 | **WebRTC(WHEP) 首选 → HTTP-FLV(mpegts.js) → HLS(hls.js)** | 延迟 200–500ms 起步，逐级降级 |
| AI 叠加 | **Frigate 模式**（RTSP 分析 → MQTT/WS 事件 → 画面叠加） | 已被 36k star 验证的架构 |
| ONVIF | **agsh/onvif 思路**（TS 客户端做发现/PTZ） | 免手工填地址 |
| OPC UA Server | **node-opcua** | 与现有 Node 栈一致 |
| 归档 | **复用现有 DAQ**，可选加 **Apache IoTDB** | 不重复造，工业场景补强 |
| 智能体 | **REST + WebSocket**（选定）+ MCP 兼容层 | 与煤矿智能体复用 |

---

# 主执行计划（全能力版 · 边写边测）

> 决策已定：**全都要**——视频监控 + GB28181 + AI 视频分析 + 协议互联(OPC UA Server/WebSocket)
> + 智能体(REST+WS+MCP) + SQL 数据库 + 变量归档 + 历史趋势。
> 每项任务都带**测试门禁**：不通过不进入下一项。

## 0. 边写边测规范（强制）

| 门禁 | 命令 | 通过标准 |
|---|---|---|
| G1 语法 | `node --check <file>`（后端） | 无输出 |
| G2 模块加载 | `node -e "require('<mod>')"` | 打印 exports |
| G3 API 冒烟 | `curl -s localhost:1881/api/<ep>` | 预期状态码 + JSON |
| G4 单元测试 | `npx mocha test/<mod>/*.test.js` | 全绿 |
| G5 前端编译 | `cd client && npm run build` | 0 error |
| G6 深链接 | `curl -L localhost:1881/<route>` | 200 |
| G7 端到端 | 见各任务"E2E" | 业务闭环 |

**节奏**：每个任务 → G1→G2→G3→(G4)→ 完成后 G5→G6；里程碑处跑 G7。

---

## 阶段 A｜视频监控（对标展厅第12章）

| 编号 | 任务 | 交付物 | 门禁 |
|---|---|---|---|
| A1 | 相机后端 | storage/service/vendor-presets/camera-client + REST | ✅ 已完成 G1–G3 |
| A2 | 媒体网关 | media-gateway（ZLMediaKit）+ WHEP 后端代理 | ✅ 已完成 G1–G3 |
| A3 | 相机管理页 | 列表 + 编辑器(厂商模板/探测) + 预览 + 路由 + 菜单 + i18n | ✅ G5,G6 |
| A4 | 视频监控器对象 | 布局矩阵(行×列)/操作盘/工具栏/资源区，可嵌入组态画面 | ✅ G5,G6 |
| A5 | 视数融合 | OSD 变量叠加（服务端解析）；状态变量回写 SCADIA Tag；报警↔变量 | ✅ G3,G5,G6,G7 |
| A6 | PTZ/预置点/巡航 | 云台控制 + 预置点 + 巡航；截图/录像/回放 | G3,G7 |
| A7 | 分布式 + 配置导入导出 | 多视频服务节点；配置 JSON 导入/导出 | G3 |
| A8 | GB28181 | 国标接入（SIP 信令 + 目录/PTZ 指令） | ✅ G3,G4,G7 |
| A9 | AI 视频分析 | 检测结果(WS/MQTT) → 画面叠加框 + 触发报警 | ✅ G3,G4,G5,G7 |

**A8 说明**：ZLMediaKit 已支持 GB28181；接入需 SIP 服务。可选 **wvp-GB28181-pro**（7.3k, MIT）作平台，或自实现精简 SIP。

**A9 说明**：采用 **Frigate 模式**（RTSP→检测→MQTT/WS 事件）。检测模型用 **PaddleDetection(Apache-2.0，可商用)**，避开 ultralytics 的 AGPL。后端已留 `aiEnabled/aiEndpoint` 字段。

---

## 阶段 B｜协议互联（补齐主力对接）

| 编号 | 任务 | 交付物 | 门禁 |
|---|---|---|---|
| B1 | **OPC UA Server** | 用 `node-opcua` 把内部变量/标定/相机状态对外发布 | ✅ G1–G4,G7 |
| B2 | **WebSocket 设备驱动** | `devices/websocket`，订阅式接入（与 MQTT 并列） | ✅ G1–G4,G7 |
| B3 | HTTP/WebAPI 增强 | 批量写、订阅/长轮询、导入导出 | ✅ G3,G4 |
| B4 | 设备→通道→变量三层 + 冗余 | 对齐展厅设备模型 | G4,G7 |

---

## 阶段 C｜智能体对接（煤矿智能体复用）

| 编号 | 任务 | 交付物 | 门禁 |
|---|---|---|---|
| C1 | **Agent Gateway** | REST + WebSocket；鉴权(API Key/JWT) + 审计 | G3,G4 |
| C2 | 工具集 | 读/写变量、查历史、读报警、相机/PTZ、触发标定、设备状态 | G3,G7 |
| C3 | 事件推送 | 报警/阈值/AI 结果 → 智能体（WS 推 + Webhook 回调） | G3 |
| C4 | **MCP 兼容层** | MCP 风格工具描述 + stdio/HTTP 传输 | G3 |

---

## 阶段 D｜数据库与归档

| 编号 | 任务 | 交付物 | 门禁 |
|---|---|---|---|
| D1 | **SQL 数据源管理** | SQL Server/MySQL/PostgreSQL/Oracle/Access/ODBC 查询**与写回**可视化 | G3,G4 |
| D2 | **变量归档配置界面** | 对标展厅"变量数据库/变量分组"，复用现有 DAQ | G4,G5,G7 |
| D3 | 历史趋势 / 报表对象 | 趋势图 + 报表（复用 uPlot/pdfmake） | G5,G6 |
| D4 | 可选后端 IoTDB | 归档新增 Apache IoTDB 后端 | G3 |

---

## 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 视频可用** | A3 | 能配相机、能看到实时画面（WebRTC/HTTP-FLV/HLS 降级） |
| **M2 视频专业** | A4,A5,A6 | 监控器对象 + 视数融合 + 云台 |
| **M3 国标与AI** | A8,A9 | GB28181 接入 + AI 叠加报警 |
| **M4 互联完备** | B1,B2 | OPC UA Server + WebSocket 驱动 |
| **M5 智能体** | C1–C4 | 智能体可读写变量、查历史、控相机 |
| **M6 数据归档** | D1–D4 | SQL 可视化 + 归档界面 + 历史趋势 |

## 执行顺序（本轮起）

`A3 → A4 → A5 → A6 → A8 → A9 → B1 → B2 → C1 → C2 → C3 → C4 → D1 → D2 → D3 → D4`

每完成一项：跑该任务门禁 → 更新本文件勾选 → 汇报。

---

# 进度日志

## 2026-09-29 · 第 1 轮（A1–A3）

| 项 | 结果 |
|---|---|
| A1 相机后端 | ✅ storage/service/vendor-presets/camera-client + REST，G1–G3 通过 |
| A2 媒体网关 | ✅ ZLMediaKit（addStreamProxy / WHEP）+ 后端 WHEP 代理，G1–G3 通过 |
| A3 相机管理页 | ✅ 列表 + 编辑器 + 预览 + 路由 + 菜单 + i18n；**G5 0 error / G6 200 / G3 200 / E2E 通过** |
| 安全修复 | ✅ `/probe` 曾泄露明文密码 → 已 maskUrl 修复并复验 |
| GitHub 核实 | ✅ 50+ 仓库实拉（stars/license），修正 3 个 ZLMediaKit 接口误用 |
| 文档 | `PLAN_集成规划.md`(330) · `UI_设计计划.md`(216) · `RESEARCH_展厅RTSPDevice拆解与超越.md`(197) |

## 2026-09-29 · 第 2 轮（A4 + A6-PTZ）

| 项 | 结果 |
|---|---|
| 展厅 dpk 拆解 | ✅ 67 条目全加密；从其**已安装明文 DLL** 反推整栈；`LocalXml.zip`=442 张海康 ISAPI 能力 XML；`Video.Mqtt.dll`=M2Mqtt 视频桥 |
| camera-client 扩展 | ✅ 通用 `rawRequest` + `requestWithAuth`（Digest/Basic，支持 PUT/POST） |
| **A6 PTZ 后端** | ✅ `ptz.js`：海康 ISAPI / 大华 & 宇视 CGI；move / preset(goto,set,delete) / capabilities |
| PTZ 路由 | ✅ `/ptz`、`/ptz/preset`、`/ptz/capabilities`；**E2E：离线→503、onvif→422、海康→200 caps** |
| **A4 视频监控器对象** | ✅ `video-wall`：7 种布局(1×1…4×4、1+5) + 工具栏(轮巡/上一下一/OSD/抓图/全屏) + 操作盘(云台/变倍/聚焦/光圈/速度/预置点) + 资源区 |
| 入口 | ✅ 顶栏 `video_settings` 常驻 + 设置菜单卡片 + `/video` 深链接 |
| 门禁 | ✅ **G5 0 error** · G6 `/video` 200 · 组件 CSS 已入包 |

**下一步**：A8 GB28181 → A9 AI 叠加 → B1 OPC UA Server …

---

## A5 视数融合 —— 实现说明（已完成）

对标展厅「视数融合」，不引入额外桥接 DLL，直接落在 SCADIA 原生 Tag 总线上。

### 双向数据流

| 方向 | 机制 | 入口 |
|---|---|---|
| **数据 → 视频** | OSD 叠加：字幕项引用 SCADIA Tag，**服务端** `getTagValue()` 解析实时值，前端 1Hz 轮询 `/api/cameras/:id/osd` | `fusion.resolveOsd()` |
| **视频 → 数据** | 在线状态回写：后台轮询器探测相机，变化时写 `statusTagId`（1=在线/0=离线，即展厅 VD/VC） | `fusion.probeStatus()` / `pollOnce()` |
| **视频 → 数据** | 报警联动：AI/IVS 事件经 `/api/fusion/event` 写入 SCADIA Tag，触发 SCADIA 报警 | `fusion.writeEvent()` |

### 关键设计点

1. **服务端解析 OSD**：前端只需一条 REST，不接触 HMI socket 内部结构；组态大屏/电视墙复用同一接口。
2. **OSD 项四角锚定**：`top-left / top-right / bottom-left / bottom-right`，可混排文本、时间、实时值。
3. **变量不可用降级**：Tag 缺失/过期 → 显示 `--` 且 `quality=bad`（UI 用告警色 + 删除线，不依赖颜色单通道）。
4. **状态仅在变化时写 Tag**：避免 15s 周期把总线写爆；同一相机并发探测被 `running` 门闩去重。
5. **写入前校验 Tag 存在**：`getDeviceIdFromTag()` 失败 → `CAM_TAG_NOT_FOUND`（404），绝不盲写地址。
6. **存储增量迁移**：`PRAGMA table_info` 检查后 `ALTER TABLE`，老库自动补 `status_tag_id` / `osd_json`。

### 新增/变更文件

```
server/runtime/cameras/fusion.js            # 新增：OSD 解析 + 状态轮询器 + 事件写回
server/runtime/cameras/camera-storage.js    # 迁移：+status_tag_id +osd_json
server/runtime/cameras/camera-service.js    # validate/toPublic 支持 fusion 字段
server/runtime/cameras/index.js             # 启动/停止轮询器
server/runtime/index.js                     # 导出 cameraFusion
server/api/cameras/index.js                 # 5 条融合路由 + 错误码
server/test/cameras/fusion.test.js          # 新增：7 条单测
client/.../camera-view.component.{ts,html,css}   # OSD 叠加层 + 1Hz 轮询
client/.../camera-editor.component.{ts,html,css} # OSD 编辑区 + 实时预览
client/.../camera.service.ts, _models/camera.ts  # fusion API + 类型
client/.../video-wall/video-wall.component.html  # OSD 开关透传
client/src/assets/i18n/{zh-cn,en}.json       # 26 条文案（0 缺失）
client/.../calibration-workbench.component.html  # 修复：SVG aria-label 绑定
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1/G2 语法 + 模块加载 | ✅ `node --check` 全绿；fusion 导出 9 项 |
| G3 API + 鉴权 | ✅ OSD/status/poll/event 全部接线；`operate` 操作 guest→401；未知 Tag→404 |
| G4 存储迁移 | ✅ 启动日志 `migrated: +status_tag_id / +osd_json` |
| G5 前端编译 | ✅ production build 通过（含修复标定页 SVG `[attr.aria-label]`） |
| G6 深链接 | ✅ `/cameras` 301→200，OSD 样式/中文文案进入产物 |
| G7 单元测试 | ✅ `fusion.test.js` 7/7；全量 255 passing |

**验证中修正的真实问题**：`CAM_TAG_NOT_FOUND` 未登记错误码，误报 500 → 已补 404。

---

## A8 GB28181 国标接入 —— 实现说明（已完成）

自实现精简 SIP 服务（不引入 wvp-GB28181-pro 那套 Java 平台，也不依赖外部 SIP 栈），直接落在现有相机/流媒体模块旁边。

### 能力

| 方向 | 机制 | 入口 |
|---|---|---|
| 设备注册 | SIP REGISTER + **MD5 Digest 挑战**（401 → 带 Authorization 的 200），To tag 在挑战与成功之间保持一致 | `gb28181-service.handleRegister()` |
| 保活/在线 | Keepalive `MESSAGE` 刷新 `keepalive_time`；超过 `offlineAfterMs` 由后台 sweep 判离线 | `touchDevice()` / `sweep()` |
| 目录同步 | 首次注册即查 `DeviceInfo` + `Catalog`，通道整体替换入库（中文名按声明编码解码） | `queryCatalog()` / `onCatalog()` |
| 云台控制 | `Control/DeviceControl` + **PTZCmd 8 字节**（`A5 0F 01 <cmd> <p1> <p2> <zoom&F0> <checksum>`）与 FI 预置位指令 | `manscdp.encodePtzCommand/encodeFiCommand` |
| 实时预览 | `INVITE`（PS/90000 + SSRC）→ ZLMediaKit `openRtpServer` → `ACK`；停止走同对话 `BYE` + `closeRtpServer` | `play()` / `stopStream()` |

### 关键设计点

1. **协议字节自行实现并单测锁定**：PTZCmd 布局、SIP 摘要（qop 与无 qop 两种公式都接受，因为国产固件两种都有）、MANSCDP 元素名**区分大小写**（`<Response>` 与 `<Notify>` 靠根元素分派）。
2. **XML 解析自写**：MANSCDP 是纯元素文档，自写解析器保证元素名大小写不被规范化，且不引入来源不明的第三方解析依赖。
3. **编码自适应**：按 `<?xml encoding=?> ` 声明解码，GB2312/GBK 走 gb18030（Node 20 自带 ICU）；无声明或未知标签降级 UTF-8，通道中文名不会乱码。
4. **后台状态是派生数据**：`channel_count` 只由目录写入，心跳/注册的保存不再回写它 —— 否则“目录先到、心跳后到”会把 0 覆盖成真实值。
5. **离线判定不靠存库标志位**：以 `keepalive_time` 与 `offlineAfterMs` 计算，进程重启即全部置离线（重启后没有活跃注册）。
6. **鉴权分层**：SIP 侧 `allowAnonymous=false` 强制摘要校验；REST 侧查询用 `view`、控制/开流用 `operate`（guest → 401）、删除设备用 `admin`。

### 新增/变更文件

```
server/runtime/cameras/gb28181/sip-message.js        # 新增：SIP/2.0 编解码 + Digest 校验
server/runtime/cameras/gb28181/sip-transport.js      # 新增：UDP 传输
server/runtime/cameras/gb28181/manscdp.js            # 新增：MANSCDP XML 解析/构造 + PTZ 指令编码
server/runtime/cameras/gb28181/charset.js            # 新增：GB2312/GBK/UTF-8 自适应解码
server/runtime/cameras/gb28181/gb28181-service.js    # 新增：注册/心跳/目录/PTZ/INVITE 服务
server/runtime/cameras/gb28181/index.js              # 新增：门面
server/runtime/cameras/camera-storage.js             # 迁移：+gb_devices +gb_channels 表
server/runtime/cameras/media-gateway.js              # 新增：openRtpServer/closeRtpServer/rtpPlayback
server/runtime/cameras/index.js                      # 接线 gb28181（关闭时不影响其余运行时）
server/runtime/index.js                              # 导出 cameraGb28181
server/api/cameras/index.js                          # 12 条 GB28181 路由 + 8 个错误码
server/scripts/gb28181-simulate-device.js            # 新增：现场调试/回归用设备模拟器
server/test/cameras/gb28181.test.js                  # 新增：24 条用例（含真实 UDP 端到端）
server/settings.default.js                           # 新增 settings.gb28181 配置块
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1 语法 | ✅ `node --check` 全绿（含新增 9 个文件） |
| G2 模块加载 | ✅ 门面导出 7 项；服务 23 个方法可加载 |
| G3 API + 鉴权 | ✅ 实测 `/api/gb28181/status|devices|channels` 返回真实在线设备（channelCount=3）；`operate` 无 token → **401** |
| G4 存储 | ✅ 启动建 `gb_devices`/`gb_channels`；真实 SQLite 往返（设备+通道+离线标记）通过 |
| G7 端到端 | ✅ **真实 UDP 回环**：401 挑战 → 摘要注册 200 → 保活 → 目录入库（中文名不乱码）→ PTZCmd/FIcmd 字节被设备逐字校验 → INVITE/ACK → 同对话 BYE；`gb28181.test.js` **24/24**，与 `fusion.test.js` 合计 **31 passing**（无回归） |

**验证中修正的真实问题**：① `channel_count` 被心跳覆盖为 0（派生字段归属错误）；② BYE 原本新建 Call-ID 脱离 INVITE 对话（设备会回 481），改为沿用；③ `WWW-Authenticate` 参数按 `;` 拆分导致取不到 nonce；④ MANSCDP 若用会规范化元素名的通用 XML 库会把 `<Response>` 读成 `RESPONSE`，据此改为自写解析器。

**现场使用**：`node scripts/gb28181-simulate-device.js --host <平台IP> --port 5060 --device-id ... --password ... --channels N`（先验证信令链路，再接真机）；真机只需在设备侧填平台 SIP ID/域/密码/IP/端口 5060。

**下一步**：A9 AI 视频分析（检测结果 → 叠加框 + 触发报警）。

---

## A9 AI 视频分析 —— 实现说明（已完成）

对接方式采用 **Frigate 模式**：外部检测引擎（Frigate / PaddleDetection 等，Apache-2.0 可商用，避开 ultralytics 的 AGPL）负责解码+推理，平台只做**结果接入与呈现**，不把模型塞进组态进程。这样引擎可以独立升级/换模型，平台也保持轻量。

### 数据流

```
Frigate / 检测引擎 ──MQTT(frigate/events)──┐
                    ──WebSocket(JSON/frame)─┤→ ai-service.ingest()
                    ──HTTP POST /api/ai/events┘        │
                                                       ├→ 归一化 region(x,y,w,h ∈ 0..1)
                                                       ├→ minScore / labels 过滤
                                                       ├→ 每相机 TTL 缓存（不落盘）
                                                       ├→ GET /api/ai/detections → 前端叠加框
                                                       └→ 报警回写 SCADIA Tag（复用 fusion.writeEvent）
```

### 关键设计点

1. **归一化在服务端完成**：引擎给的框可能是检测分辨率像素，也可能是 0..1。统一转成 `region{x,y,w,h}∈0..1`，前端只用百分比定位，**换分辨率/换模型不需要改前端**。无法归一化的框（没有帧尺寸的像素框）**丢弃并计数**，绝不猜位置——宁可少画一个框，也不画错位置。
2. **框是易失数据**：只有 `ttlMs`（默认 5s）生命期，不写数据库。目标离开画面 = 框自动消失，存储不会无限增长。
3. **过滤不等于清除**：一次被过滤掉的载荷（比如只想看 person，来了 dog）**不会**清掉屏幕上已有的 person 框——别人家的检测结果不能决定另一个目标是否离场。清框只走 `end` 事件或 TTL。
4. **报警是边沿+保持**：检测到达时置 1，之后 `alarmClearMs` 内无新检测才置 0；同一次持续告警**不反复写总线**（避免把 Tag 总线打爆）。Tag 不存在时只告警日志，不影响叠加框。
5. **相机名解析**：引擎用它自己的相机名，平台按「我们的 id 或 name」自动匹配，剩下用 `settings.ai.cameraMap` 覆盖——现场一般不用额外配表。
6. **前端只在 AI 相机上轮询**：`camera.aiEnabled` 为真才拉 `/api/ai/detections`，16 路电视墙不会为永远没有引擎的相机发请求。

### 新增/变更文件

```
server/runtime/cameras/ai/normalize.js        # 新增：Frigate/generic 载荷 → 统一框模型
server/runtime/cameras/ai/ai-service.js       # 新增：摄入/TTL/过滤/报警边沿保持
server/runtime/cameras/ai/mqtt-ingest.js      # 新增：MQTT 订阅（Frigate 默认主题）
server/runtime/cameras/ai/ws-ingest.js        # 新增：WebSocket 推流接入
server/runtime/cameras/ai/index.js            # 新增：门面 + 传输生命周期
server/runtime/cameras/index.js               # 接线 ai（关闭/端口占用不影响其余运行时）
server/runtime/index.js                       # 导出 cameraAi
server/api/cameras/index.js                   # 3 条路由 + 3 个错误码
server/scripts/ai-simulate-detections.js      # 新增：无引擎时的现场验证推流脚本
server/test/cameras/ai.test.js                # 新增：19 条用例（含真实 WS 回环）
client/.../camera-view.component.{ts,html,css} # 检测框叠加层（百分比定位 + 标签/置信度）
client/.../video-wall/video-wall.component.{ts,html} # 工具栏新增检测框开关
client/.../_services/camera.service.ts, _models/camera.ts # API + 类型
client/src/assets/i18n/{zh-cn,en}.json        # 6 条文案
server/settings.default.js                    # 新增 settings.ai 配置块
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1/G2 语法+加载 | ✅ `node --check` 全绿（5 个新文件） |
| G3 API + 鉴权 | ✅ 实测 `/api/ai/status` 返回 `enabled:true`、ttl/阈值/统计；`POST /api/ai/events` 无 token → **401** |
| G4 启动 | ✅ 启动日志 `ai ws: listening ws://0.0.0.0:1890`（WS 接入可用） |
| G5 前端编译 | ✅ production build 0 error；`cam-det` 样式、`wall.detect`/`camera.detections` 文案、`api/ai/detections` 均进入产物 |
| G7 端到端 | ✅ **真实 WS 回环**：推流脚本 → 1890 → 摄入 → `/api/ai/detections` 返回归一化框（`source:"ws"`、`ageMs≈150`）；停止推流后 **TTL 到期自动清空**（`cameras:0`）。`ai.test.js` **19/19**；全量 **298 passing** |

**验证中修正的真实问题**：① 过滤掉的载荷原先会清空该相机全部框（“dog 事件”抹掉“person 框”），改为只由 `end`/TTL 清框；② `getDetections()` 返回结构在命中/未命中/过期三种情况下不一致（缺 `expired`），已统一。

**现场使用**：无引擎时先验链路 —— `node scripts/ai-simulate-detections.js --camera <相机id或名> --transport ws --port 1890`（或 `--transport http`）；接真机时在引擎侧把 MQTT 指向本平台或让它连 WS，并在相机上勾选「AI 启用」。

**下一步**：B1 OPC UA Server（用 `node-opcua` 把内部变量/标定/相机状态对外发布）。

---

## B1 OPC UA Server —— 实现说明（已完成）

工程此前只能**作为客户端**读别人的 OPC UA（`runtime/devices/opcua`）。B1 补上另一个方向：把工程**对外发布**为 OPC UA 服务器，第三方 HMI / MES / 矿方其他系统可以 browse + subscribe。

### 地址空间（namespace 1，挂在 Objects 下）

```
SCADA/Devices/<设备名>/<变量名>      实时变量值（默认只读，可配可写）
SCADA/Cameras/<相机名>/Online        相机在线（RO）
SCADA/Cameras/<相机名>/AiEnabled     是否接入 AI（RO）
SCADA/Ai/<相机名>/Alarm              有检测框即报警（RO）
SCADA/Ai/<相机名>/Detections         当前检测框数（RO）
```

### 关键设计点

1. **类型映射显式且保守**：S7（Bool/Int/Word/DInt/Real）、Modbus（Int16/UInt16/Float32/Int32MLE…）、OPC UA 客户端类型统一映射到 OPC UA 内置类型；**未知类型不猜窄类型**，数值兜底 Double、其余兜底 String。小数写进整型声明一律拒绝（返回 Bad），绝不静默截断。
2. **无值不等于 0**：变量没值/取不到时发布 **Bad 质量**（`BadWaitingForInitialData`），而不是伪造 0 —— 客户端不能把「没有测量」当成「测量为 0」。
3. **值模型：内部值为唯一真值源**（重要取舍）：实测本版本 node-opcua 中，变量一旦绑定 `get` 闭包，`setValueFromSource` 会被完全忽略，**订阅将永远收不到推送**。因此改为标准 OPC UA 模型 —— 绑定即发布初值，变化即推送，另有扫描兜底：
   - 变化事件 `tag-value:changed` → 立即推送（工程已有总线，无需二次轮询）
   - `tagPollMs`（默认 1s）扫描兜底，供不产生变化事件的驱动
   - **只在值真正变化时推送**，避免每个扫描周期把订阅刷爆
4. **写保护**：默认只读；只有 `writeEnabled: true` 才暴露 `CurrentWrite` 位并接受写入。
5. **安全策略只提供 None**：面向厂区局域网。不提供「配了证书但其实没生效」的安全策略，避免虚假安全感。
6. **endpoint 主机名必须显式**：交给库默认会得到 `opc.tcp://undefined:4840/...`（跟随该地址的客户端会解析失败）；现取 `advertiseHost` 或首个非内网 IPv4。

### 新增/变更文件

```
server/runtime/opcua-server/datatype.js     # 新增：类型映射 + 值收敛（纯函数）
server/runtime/opcua-server/index.js        # 新增：OPC UA 服务器 + 地址空间 + 推送
server/runtime/index.js                     # 接线 init/stop + 导出 opcuaServer
server/api/opcua-server/index.js            # 新增：/api/opcua-server/status
server/api/index.js                         # 注册路由
server/settings.default.js                  # 新增 settings.opcuaServer 配置块
server/test/opcua-server/opcua-server.test.js # 新增：15 条用例（含真实客户端 E2E）
server/package.json                         # +node-opcua ^2.150.0
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1/G2 语法+加载 | ✅ `node --check` 全绿；node-opcua 2.150 在 Node 20 上可加载（2.186 为 ESM-only 且要求 Node ≥22，已回退到 CJS 版本） |
| G3 API | ✅ 实测 `/api/opcua-server/status` → `{enabled:true,running:true,port:4840,...}` |
| G4 启动 | ✅ 平台启动即监听 `opc.tcp://10.17.171.192:4840/UA/SCADA`（0.0.0.0，局域网可达） |
| G7 端到端 | ✅ **真实 OPC UA 客户端**（node-opcua 自带客户端，非自实现）连上运行中的平台：拿到 endpoint URL、`Objects → SCADA → Devices/Cameras/Ai` 可浏览；测试内另测 browse / 读值（类型正确）/ Bad 质量 / 拒写 / **订阅推送** / 相机与 AI 状态。`opcua-server.test.js` **15/15**；全量 **313 passing**（连续 8 次全绿） |

**验证中修正的真实问题**：① `value.get` 绑定会静默废掉 `setValueFromSource` → 订阅永远无推送（改为内部值模型）；② NodeId 未带命名空间索引会落到标准命名空间；③ 路径分隔符 `.` 被 `safeName` 一起替换（`SCADA.Devices` → `SCADA_Devices`）导致子节点全部找不到；④ `new StatusCode(<StatusCode>)` 会把状态码退化成 Good；⑤ `{ set: undefined }` 被库拒绝，导致变量全部发布失败；⑥ endpoint 主机名为 `undefined`。

**说明**：全量测试中另有一个既有的时序用例（`test/help/runtimeUtils.test.js` 断言 10ms 定时器须在 60ms 内回调）在 node-opcua 首次加载/启动阻塞事件循环时偶发超时；已通过把依赖加载前移、合并为单台服务器降低干扰，连续 8 次全量全绿。该用例本身与 B1 无关，未改动。

**现场使用**：客户端连 `opc.tcp://<平台IP>:4840/UA/SCADA`（匿名，SecurityPolicy None）；需要账号时设 `allowAnonymous:false` + `users:[{username,password}]`。

**下一步**：B2 WebSocket 设备驱动（`devices/websocket`，与 MQTT 并列的订阅式接入）。

---

## B2 WebSocket 设备驱动 —— 实现说明（已完成）

MQTT 之外补一个**统一订阅式接入**驱动：机器人集群、矿鸿设备、第三方网关大多只提供裸 WebSocket，不会为一个点位专门跑 broker。把它们硬接 broker 只为复用 MQTT 驱动，等于在矿上多一个会坏的环节。

驱动完全遵循既有设备契约（`connect/disconnect/isConnected/polling/load/getValue/getValues/setValue/getStatus/getTagProperty/bindAddDaq/bindGetProperty/lastReadTimestamp`），因此 DAQ、死区、缩放、报警、历史趋势都自动复用，不需要任何旁路。

### 载荷形态（吸收网关方言）

| 形态 | 例子 |
|---|---|
| 扁平映射 | `{"pit.level": 1.2, "pit.run": true}` |
| 带地址条目 | `{"topic":"pit.level","value":1.2}`（也接受 address/key/tag/path/name + value/val/data） |
| 批量帧 | `[{...},{...}]` |
| 嵌套信封 | `{"ts":...,"payload":{"topic":"a","value":7}}` |

匹配规则：**只要帧里出现「带地址条目」，就以它为准**（这是明确的意图），否则才把顶层当作扁平映射。这样 `ts` 这类信封字段不会被误当成变量地址。`json` 类型变量仍用 `options.subs` + `memaddress` 从载荷里取字段，与 MQTT 行为一致。

### 关键设计点

1. **不做无谓的字符串化**：WebSocket 帧本来就是 JSON，保持原生类型（布尔就是布尔、数值就是数值）。只有结构化值才序列化——MQTT 必须字符串化是因为它的载荷本质是字节流，这条不适用于 WS。
2. **值只组装一次**：帧到达即组装并推送（不等到下一个轮询周期，否则界面会慢一拍）；`polling()` 只负责 DAQ 判定。`tagValueCompose` 会按旧值做死区比较，**组装两次会给同一个读数报两个不同结果**，所以必须只有一处。
3. **坏帧不改值**：无法解析的帧只记日志，不发射、不改已有值；`json` 变量缺字段时保留上一次的值，一帧不完整不会把活着的点位置空。
4. **`browse` 诚实作答**：推送型端点没有可查询的目录，所以“浏览”就是**接入后观察真实流量并汇报看到的地址**（并保留历史见过的地址，打开对话框立即有结果），而不是编一份假目录。
5. **写回同步**：`setValue` 在当前 socket 上发 `{address,value}`（或按 `writeFrame`/`json` 组装）；**未连接时返回 `false`**，绝不伪装写入成功。
6. **断线重连**：固定 5s 重连，`disconnect()` 会置停止标志，不会被重连定时器拉回来；自有自签名证书需显式勾选（不静默接受任意证书）。

### 新增/变更文件

```
server/runtime/devices/websocket/index.js   # 新增：WS 设备驱动
server/runtime/devices/device.js            # 注册：require + DeviceEnum.WebSocket + create/browse/bindGetProperty/loadPlugin 分支
server/test/devices/websocket.test.js       # 新增：19 条用例（含真实 WS 回环 + 经 device.js 的集成）
client/.../_models/device.ts                # DeviceType.WebSocket + DeviceNetProperty 新增字段
client/.../device-map/device-map.component.ts   # 可选设备类型里加上 WebSocket
client/.../device-list/device-list.component.ts # 标签增删改/地址显示/可编辑判定按 WebSocket 处理
client/.../device-property/device-property.component.{html,ts} # 属性面板（地址/超时/订阅帧/账号/自签名/握手头）
client/src/assets/i18n/{zh-cn,en}.json      # 5 条文案 ×2
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1 语法 | ✅ 新增/改动 JS `node --check` 全绿 |
| G2 模块加载 | ✅ 驱动导出 `init,create`；`device.DeviceType.WebSocket === 'WebSocket'` |
| G3 注册 | ✅ 经 **真实 `device.js`** 构建设备并收到推送值（缺 require/分支会直接失败）；四个派发点（create/browse/bindGetProperty/loadPlugin）均已接线 |
| G4 单元测试 | ✅ `websocket.test.js` **19/19** |
| G5 前端编译 | ✅ production build 0 error；`device.property-ws-*` 文案与 `WebSocket` 类型已进入产物 |
| G7 端到端 | ✅ **真实 WS 回环**：连接 → `connect-ok` → 订阅帧（`{"type":"subscribe","tags":[...]}`）→ 推值路由到正确标签（布尔保持布尔）→ json 子字段 → 坏帧不改值 → 写回 → DAQ 落库 → browse 发现地址 → 断开状态；全量 **332 passing**（连续 3 次全绿） |

**验证中修正的真实缺陷**：① 帧到达时先发射、后组装，界面会落后一帧（改为组装后发射，且只组装一次）；② 布尔被 `String()` 成 `'true'`（WebSocket 帧是 JSON，不该字符串化原生标量）；③ 嵌套信封被顶层 `ts` 抢路由（改为“带地址条目优先”）；④ `browse` 依赖恰好抓住一帧（改为记录所有见过的地址，打开即用）。

**现场使用**：设备类型选 `WebSocket`，地址填 `ws://<host>:<port>/<path>`；变量“地址”填载荷里的键路径，例如 `pit.level`；`json` 类型配合 `options.subs`+`memaddress` 取子字段。

**下一步**：B3 HTTP/WebAPI 增强（批量写、订阅/长轮询、导入导出）。

---

## B3 HTTP/WebAPI 增强 —— 实现说明（已完成）

补齐 WebAPI/HTTP 接入在工程上真正用得上的三件事：**批量写**、**长轮询/条件请求**、**变量定义导入导出**，并把写入的失败语义改诚实。

### 1. 批量写（一次请求）

- 驱动新增 `setValues(entries)`：一次请求写多个变量，返回 `{ ok, written, failed:[{id,error}] }`。
- `setValue` 改为**等待响应**再返回结果。原实现是 fire-and-forget：请求还没到端点就先返回 `true`，被端点拒绝也报成功（对 UI 是假象）。
- 请求体按驱动既有约定判定：
  - `getTags/postTags` 模式（端点说我们的 `[{id,value}]`）→ 默认体；
  - 仅 `address` 模式（普通只读 JSON 文档）→ **无模板即拒绝**，绝不猜一个体打回去；
  - `writeTemplate` 支持 `{{entries}}`（整批）与 `{{id}}/{{value}}`（逐条，仍合并为一次请求）。
- 新增 `writeMethod`、`postTags` 目标、`headers`、`username/password`、`bearerToken`。

### 2. 长轮询 / 条件请求

- `longPoll` 开启后读请求携带 `If-None-Match`（ETag）与 `sinceParam`/`longPollParam`＋`longPollTimeout`。
- **304 与 `changed:false`、空体一律视为「无变化」，是成功而不是故障**：保留上一次值、不重复发射、并恢复连接状态为 `connect-ok`。
- 客户端超时自动大于服务端 hold 时间（否则每次长轮询都会在服务端应答前被自己掐断）。

### 3. 变量定义导入导出

- 新模块 `runtime/devices/tag-io.js`（纯函数）：
  - 导出**只含定义字段**，剔除运行时状态（value/timestamp/changed）——否则写进文件的那一刻就是过期数据；
  - 导入**只增不删**；已存在的 id 默认 `skipped`，必须显式 `overwrite:true` 才覆盖，且覆盖不丢当前值；
  - 无地址的变量直接拒绝（否则会建出一个"看起来配好了、永远不会更新"的死条目）；
  - 接受 4 种输入形态：导出文档 / 裸映射 / 数组 / JSON 字符串。
- 新 REST `api/devices`：
  - `GET /api/devices` 设备清单（含变量数）
  - `GET /api/devices/:id/tags?values=true&download=true` 导出（可选带实时值 / 触发下载文件名）
  - `POST /api/devices/:id/tags` 导入（**全部条目都无效 → 400 `DEV_IMPORT_FAILED`**，不让调用方把"全被拒"误读成"成功"；有任一成功则 200 并列出 `errors`）
  - `POST /api/devices/:id/write` 批量写（设备不可写 → 422；端点拒绝 → 502 并带回逐条原因；设备未运行 → 409）
  - `POST /api/devices/:id/tags/discover` 让 WebAPI 端点自报其发布的变量（转成可导入的形态）

### 新增/变更文件

```
server/runtime/devices/httprequest/request-builder.js  # 新增：请求构造/条件请求判定（纯函数）
server/runtime/devices/httprequest/index.js            # 批量写、诚实写、长轮询/ETag、headers/auth
server/runtime/devices/tag-io.js                       # 新增：变量定义导入导出（纯函数）
server/runtime/devices/device.js                       # setValues（有则批量，无则逐个，结果形态一致）
server/runtime/devices/index.js                        # setTagsValues（设备未运行明确拒绝）
server/api/devices/index.js                            # 新增：设备 REST（5 条路由 + 9 个错误码）
server/api/index.js                                    # 注册路由
server/test/devices/httprequest.test.js                # 新增：32 条
server/test/api/devicesApi.test.js                     # 新增：17 条
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1 语法 | ✅ 全部改动/新增 JS `node --check` 通过 |
| G2 模块加载 | ✅ `request-builder` / `tag-io` / 驱动 / `api/devices` 均可加载 |
| G3 API | ✅ 真机路由：清单/导出/导入/批量写/发现 5 条；鉴权（读者 403、安全关闭 403、未知设备 404、全无效 400、不可写 422、端点拒 502、未运行 409）**17/17** |
| G4 单元测试 | ✅ `httprequest.test.js` **32/32**（含真实 HTTP 回环）；B3 合计 **49/49**；全量 **381 passing** |

**验证中修正的真实缺陷**：① `setValue` 不等待响应即报成功（改为等待并按 2xx 判定）；② 仅 `address` 模式下会把批量数组写回只读文档（改为无模板即拒绝）；③ 304/`changed:false` 被当成读取失败（改为"无变化"并保留值）；④ 数组条目被 `typeof==='object'` 放过、报错指向错误原因（显式拒绝数组）；⑤ 全部条目无效时返回 200（改为 400）。

**现场使用**：WebAPI 设备填 `getTags`/`postTags` 后即可批量写；长轮询在设备属性里开 `longPoll`；导入导出用 `GET/POST /api/devices/<id>/tags`，批量写用 `POST /api/devices/<id>/write`。

---

## B4 设备→通道→变量三层模型 —— 实现说明（第 1 步：后端兼容层，已完成）

对齐展厅的设备模型，在「设备→变量」之间插入**通道**这一层，并且**不破坏任何既有索引**。

### 关键取舍：扁平 tags + `channelId` 归属（不是把 tag 嵌套进 channel）

- `device.channels = [ { id, name, description, enabled } ]` —— 通道描述（新增、可选）
- `device.tags = { <tagId>: { ..., channelId } }` —— **仍是唯一的扁平定义源，key 仍是 tagId**
- 通道是 tag 的**属性**，不是 tag 的**容器**。理由：
  1. `tagId` 不变 → DAQ 历史（按 tagId 存）、报警、标定、调度、`getDeviceIdFromTag` 全部零改动；
  2. 现有工程照常加载：无 `channels`、无 `channelId` 就是普通两层设备，其 tag 归属到**隐式默认通道**（id `''`，只在读取时派生，永不落盘）；
  3. 驱动一行不用改（`load(data)` 依旧读 `data.tags`），`loadDevice` 也无需改动；
  4. 不存在「同一 tag 存两份」导致的漂移。
- 嵌套存储（tag 物理挂在 channel 下）会复制每个 tag 且两份必然漂移，故不采用。

### 新增能力

- `runtime/devices/channel-utils.js`（纯函数）：`channelIdOf` / `getChannels` / `getChannel` / `tagsOf` /
  `createChannel` / `updateChannel` / `removeChannel` / `assignTags` / `normalizeDevice` / `validateDeviceChannels`。
- `runtime/devices/index.js`：`getDeviceChannels(deviceId)`、`getChannelIdFromTag(tagId)`。
- `tag-io`：`channelId` 进入 `DEFINITION_FIELDS`，导出/导入保留通道归属。
- `api/devices` 新增 6 条通道路由：
  - `GET  /api/devices/:id/channels` 通道清单（含 tagCount；默认通道 `isDefault:true`）
  - `POST /api/devices/:id/channels` 新建（无 id 时由 name 派生；重复 → 409）
  - `PUT  /api/devices/:id/channels/:channelId` 改名/改字段（改名会同步重指其 tag，不产生孤儿）
  - `DELETE /api/devices/:id/channels/:channelId` 删除（tag **只重指不删除**，`?reassignTo=` 指定去向）
  - `POST /api/devices/:id/tags/assign` 批量把 tag 归组（`channelId:''` 回默认通道）
  - `GET  /api/devices/:id/channels/:channelId/tags` 单通道导出（可直接再导入）
  - 默认通道的空 id 无法出现在 URL 路径，用字面量 `default`（或 `~`）表示。

### 新增/变更文件

```
server/runtime/devices/channel-utils.js   # 新增：通道层规则（纯函数）
server/runtime/devices/index.js           # + getDeviceChannels / getChannelIdFromTag
server/runtime/devices/tag-io.js          # + channelId 进 DEFINITION_FIELDS
server/api/devices/index.js               # + 6 条通道路由 + 3 个错误码 + 导入后规范化
server/test/devices/channelUtils.test.js  # 新增：37 条
server/test/api/devicesApi.test.js        # +19 条（B4 通道 API；原 17 条 B3 不变）
```

### 门禁结果

| 门禁 | 结果 |
|---|---|
| G1 语法 | ✅ 4 个改动文件 `node --check` 通过 |
| G2 模块加载 | ✅ `channel-utils` / `runtime/devices` / `api/devices` 均可加载并导出新函数 |
| G3 API（真实 HTTP） | ✅ 通道 6 条路由 + 鉴权/404/409/400 契约 **19/19**（`devicesApi.test.js` 合计 36/36，含 B3 的 17 条） |
| G4 单元测试 | ✅ `channelUtils.test.js` **37/37**；本轮新增 **56 条**；全量 **436 passing**（本机 Windows 下 `test/storage/storage-insert-select.test.js` 有 2 条**既存**失败：临时 SQLite 文件 EBUSY/句柄已关闭，单独跑该文件 **5 passing**，与本轮改动无关） |

**验证中加固的设计点**：① 标签引用了「未声明但仍被引用」的通道时，`getChannels` 会把该通道列为 `declared:false`，否则其 tag 会在通道视图里凭空消失；② 导入的 tag 若指向不存在的通道，落盘前规范化并回 `channelWarnings`，不把坏引用存进工程；③ 删除通道只重指 tag，绝不删 tag。

**下一步**：B4 第 2 步（前端设备页按通道分组 + 通道增删改）+ 第 3 步（冗余/备用设备切换）。

---

## ⏭️ 断点续作（新窗口从这里开始）

**已完成**：A1–A9（视频监控本体 + GB28181 + AI 视频分析）、B1 OPC UA Server、B2 WebSocket 设备驱动、B3 HTTP/WebAPI 增强、**B4 第 1 步（设备→通道→变量三层 · 后端兼容层）**。

**全量测试基线**：

```bash
# 本机（Windows）bash 会话里 Volta 的 node shim 不可用，直接用真实 node：
N="/c/Users/kc/AppData/Local/Volta/tools/image/node/20.18.0/node.exe"
cd "/g/开源sacda/开诚智枢scada/server"
"$N" node_modules/mocha/bin/mocha.js --recursive --timeout 10000   # → 436 passing, 2 failing(既存)
```

**下一步 = B4 第 2 步：前端迁移**（门禁 G5 前端编译 + G7 端到端）。
- 后端通道层已就绪，前端只需消费：`GET /api/devices/:id/channels`（树形分组）、`POST/PUT/DELETE .../channels`（增改删）、`POST /api/devices/:id/tags/assign`（拖拽归组）。
- 影响面：`client/src/app/device/device-list/`、`device-property/`、`_models/device.ts`（加 `channels` + `tag.channelId`）、`assets/i18n/{en,zh-cn}.json`（通道相关文案）。
- 注意：socket 侧设备数据仍带 `tags`（扁平），前端不用改数据来源，只需按 `channelId` 分组渲染。

**B4 第 3 步 = 冗余（备用设备切换）**，放在三层稳定之后单独一步。

**环境**：平台当前仍在运行（1881 网页 / 5060 SIP / 1890 AI-WS / 4840 OPC UA）；`GET /api/devices` 实测 200。**运行中的进程是旧代码**，新代码需重启平台才生效（重启是用户侧动作）。
