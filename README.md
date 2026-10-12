# 开诚智枢 · Kaicheng SCADIA

工业智能中枢 —— **采集 + 实时视频 + AI 检测 + 报警** 一体化平台（Web SCADA/HMI）。
本仓库是**完整可运行的交付包**：克隆下来，按"快速开始"五步即可在 Windows 上跑起来，内置矿区 AI 视频监控演示工程。

---

## 一、功能总览（全部真实工作，非静态演示）

| 模块 | 能力 |
|---|---|
| **实时视频** | MJPEG 低延迟流（ffmpeg 拉 RTSP → 本机代理广播，多窗共享一路）；断流自愈（代理重启 10 秒内画面自动恢复，无需刷新） |
| **相机智能事件** | 四类：区域入侵 / 遮挡报警 / 移动侦测 / 视频丢失（海康 ISAPI alertStream → 平台报警 + 计数 + 画面出框） |
| **人体检测与轨迹** | YOLOv8 + ByteTrack，RTSP 子码流推理，检测框 + 运动轨迹实时上屏；有 N 卡自动用 CUDA，无卡回落 CPU |
| **电子围栏** | 相机检测区可视化（虚线多边形 + 四角标），入侵触发 3 秒内转红加粗"入侵中" |
| **报警抓拍** | 报警瞬间经 ISAPI 抓图存档（`project/_images/alarm-shots/`，20 秒节流 / 200 张 / 7 天保留），报警图片预览页可查 |
| **报警查询** | 当前 + 历史库联查、时间/状态筛选、就地确认、看抓拍图 |
| **计数清零** | 管理员一键清零四类告警计数（当日 + 累计，带确认弹窗与审计字段） |
| **云台/镜头控制** | 变倍/聚焦/云台**步进控制**（单击走一小步、按住连续、松开即停），按相机能力自动适配显示 |
| **全屏模式** | 一键隐藏浏览器栏 + 系统任务栏 + 平台图标条，画面 1:1 铺满整屏（Esc/F11 退出） |
| **看板** | 总览首页 / 数据展示（真数据）/ 视频监控（实时大窗 + 最新报警卡）/ MES / EMS 看板 |
| **平台底座** | Tag/DAQ/报警/配方/报表引擎/脚本调度/OPC UA Server/Node-RED，详见 `01_架构手册.md` |

## 二、目录结构

```
├─ start-scadia.ps1        一键启动（前置检查 + 四进程）
├─ README.md               本文件
├─ runtime/node/           自带 Node 运行时（服务端可免安装 Node 直接跑）
├─ source/
│  ├─ client/              前端（Angular 18）；dist/ 已构建，开箱即用
│  ├─ server/              服务端（Node/Express + sqlite；运行时数据在其 userDir）
│  └─ tools/               mjpeg-proxy.cjs（视频代理）/ scadia-event-bridge.cjs（事件桥接）
│                          / scadia-ai-tracker.py（YOLOv8 追踪）/ yolov8n.pt / requirements
├─ project/                演示工程（克隆后即为运行数据目录）
│  ├─ _demos/demo-kuangqu.json   矿区演示工程（全部画面/脚本都在这一个文件里）
│  ├─ _appdata/            相机/代理/追踪器配置（见"摄像头配置"）
│  ├─ _db/                 sqlite（报警历史等演示数据）
│  └─ _images/             画面素材 + AI 计数/轨迹/围栏 + 报警抓拍
└─ 00_交付说明.md / 01_架构手册.md / 02~14…   交付与架构文档
```

## 三、环境要求

| 组件 | 必需性 | 用途 | 没有会怎样 |
|---|---|---|---|
| Windows 10/11 | 必需 | 运行平台 | — |
| **Node.js 18+** | 首次克隆后必需 | `npm install` 装服务端依赖（运行时可用包内 `runtime/node/node.exe`，但它不含 npm） | 装不了依赖，服务端起不来 |
| **ffmpeg**（在 PATH） | 推荐 | 实时视频流 | 自动跳过视频代理，画面回落**抓拍模式**（约 1 帧/秒） |
| Python 3.10+ + `ultralytics` `opencv-python` | 可选 | 人体检测与轨迹 | 跳过追踪服务，其余正常 |
| 海康摄像头（支持 ISAPI） | 可选 | 四类智能事件 + 视频源 | 用演示数据也能看页面结构 |

安装 ffmpeg：`winget install ffmpeg`（或官网下载后加入 PATH）。Python 依赖：`pip install ultralytics opencv-python`。

## 四、快速开始（五步）

```powershell
# 1. 克隆
git clone https://github.com/kcylp/SCADIA.git
cd SCADIA

# 2. 装服务端依赖（只需要这一次；前端 dist 已随仓库构建好）
cd source/server
npm install

# 3. 回到根目录，一键启动
cd ../..
powershell -ExecutionPolicy Bypass -File .\start-scadia.ps1

# 4. 浏览器打开
http://127.0.0.1:1881

# 5. 登录（安全开关默认关闭时无需登录；开启时）
admin / 123456
```

启动脚本会依次：检查依赖与构建产物 → 起**服务端(1881)** → 起**MJPEG 视频代理(1886)** → 起**相机事件桥接器** → 起**人体检测追踪**（Python 可用时），并在缺件时给出明确提示而不是静默失败。

## 五、四个后台进程（start-scadia.ps1 拉起）

| 进程 | 作用 | 挂了会怎样 |
|---|---|---|
| 服务端 :1881 | 平台本体（API/画面/报警/SQLite/OPC UA/Node-RED） | 页面打不开 |
| MJPEG 代理 :1886 | ffmpeg 拉 RTSP → 广播给各视频窗；`/stats` 看状态 | 视频窗黑（画面脚本 10 秒内自动重连恢复） |
| 事件桥接器 | 相机 alertStream → 平台报警/计数/围栏状态/抓拍 | 四类事件不再上报 |
| AI 追踪器 | YOLOv8 推理 → 人员框与轨迹 | 画面上没有人体框/轨迹 |

## 六、摄像头配置（`project/_appdata/`）

| 文件 | 控制什么 |
|---|---|
| `video-events.json` | 相机地址/口令、事件桥接、**电子围栏多边形**（fence.points，归一化 ×1000）、防抖 `debounceMs` |
| `mjpeg-sources.json` | 视频代理拉哪路 RTSP（name/rtsp/fps） |
| `ai-tracker.json` | AI 追踪的 RTSP 子码流、模型、置信度、推送频率 |

> **安全提示**：演示配置中含演示环境的相机地址与口令（192.168.110.21 / 见 json），接入自己的相机后请修改以上三个文件并重启对应进程（桥接器已支持热读部分参数）。平台默认口令 admin/123456，生产环境务必修改。

改完 `video-events.json` 后重启事件桥接器即可；改 `mjpeg-sources.json` 后重启视频代理。

## 七、常见问题

| 现象 | 原因与处置 |
|---|---|
| **改了工程/脚本，画面没变** | 平台热更新不会推给已打开的页面 —— **Ctrl+F5**（第一反应永远是它） |
| 视频窗黑 | 看 `http://127.0.0.1:1886/stats`：有源有帧率 = 流正常（等 10 秒自愈）；无 = ffmpeg 没装或 RTSP 不通 |
| 画面像幻灯片（~1 帧/秒） | 没有 ffmpeg，处于抓拍模式；装 ffmpeg 后重启 |
| 顶栏显示"YOLOv8 · 视频重连中/代理不可达" | 视频代理异常，按文案定位（重连中=代理在但流未建；不可达=1886 连不上） |
| 接口偶发 429 | 平台全站限流 1000 次/5 分钟；高频数据都走静态文件，属异常征兆而非常态 |
| 人体框不出现 | AI 追踪进程没起（看启动日志/Python 依赖） |
| 报警查询空表 | 筛选条件太窄（默认"全部时间+未确认"），切换筛选 |

## 八、二次开发

- **前端**：`cd source/client && npm install && npx ng build`（仅改前端时需要；仓库已含构建产物）
- **画面/脚本**：一切都在 `project/_demos/demo-kuangqu.json` —— 视图 SVG + CLIENT 脚本（每秒重跑，必须幂等；跨帧状态挂 `window`，改脚本要 bump 版本号作废旧定时器）。改完用 `POST /api/project` 灌入，**已打开的页面要 Ctrl+F5**
- **相机参数**：ISAPI（FieldDetection/timeThreshold 等），配置备份在 `_tools/cam-probe/*.BACKUP.xml`（交付机）
- **文档**：`00_交付说明.md`（安装）、`01_架构手册.md`（架构）、`02_PLAN_集成规划.md`（模块清单）、`06_未闭环项台账.md`、`13_交接书`…

## 九、许可与说明

本仓库为交付工程源码。演示工程内的相机口令、平台口令均为演示值，**接入生产前必须修改**。
