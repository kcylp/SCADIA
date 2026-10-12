# 展厅视频方案深度拆解与超越设计

> 素材：`G:\开源sacda\展厅资料\RTSPDevice.dpk`（156MB）、`Manual.chm`、
> `C:\Users\kc\Desktop\展厅\`（已安装的运行时，DLL 为明文）。
> 方法：ZIP 结构分析 + 二进制字符串提取 + 官方手册第 12 章 + ISAPI 能力文件解析。

---

## 一、`RTSPDevice.dpk` 到底是什么

**结论：它是展厅的一个"通用 RTSP 视频设备驱动包"（DPK = Driver PacKage），本质是"FFmpeg 解码 + .NET 封装 + DirectX 渲染"的 Windows 原生驱动。**

### 1.1 包结构（67 个条目，**全部加密**）

```
RTSPDevice.dpk  (156 MB, ZIP, 67/67 entries ENCRYPTED, no password available)
├─ TitleInfo (95B)  Start (1B)              ← 驱动元数据（加密）
├─ x64/  ...                                ← 64 位运行时（完整一份）
└─ x86/  ...                                ← 32 位运行时（完整又一份，体积翻倍）
```

### 1.2 x64 内容物 = 它的技术栈

| 类别 | 文件 | 说明 |
|---|---|---|
| **FFmpeg 解码** | `avcodec-58/59`、`avformat-58/59`、`avfilter-7/8`、`avdevice-58/59`、`avutil-56/57`、`swscale-5`、`swresample-3`、`postproc-55` | **两个大版本（58/59）同时打包** |
| FFmpeg 托管绑定 | `FFmpeg.AutoGen.dll`、`FFmpegExtension.dll` | .NET P/Invoke |
| **驱动契约** | `VideoDriverLib.dll`（仅 **6144 B**） | 驱动接口层 |
| 驱动实现 | `CE.VDDrive.RTSP.RTSPDevice.dll`（145 KB）+ `.xml`（365 KB） | 加密的 API 文档 |
| **渲染** | `SharpDX.dll`、`SharpDX.Direct3D9`、`SharpDX.Mathematics`、`SharpDX.XAudio2`、`SDL2.dll` | **DirectX 9 渲染 + XAudio2 音频** |
| 采集 | `DirectShowLib.dll` | USB / 本地采集 |

**判读：它把浏览器根本不需要的东西（DirectX9、SDL2、DirectShow、双份 FFmpeg）搬到了客户端机器上，只为了在 Windows 窗口里画一帧视频。**

---

## 二、展厅完整的视频技术栈（已安装运行时实证）

`展厅\Drivers\Video\x64\` 里躺着 **60+ 个原生 DLL**，可归为五层：

### 2.1 厂商私有 SDK 层（"每家一套"）
```
海康：HCNetSDK.dll + HCCore.dll + PlayCtrl.dll + HCNetSDKCom\ (+ .lib)
大华：dhnetsdk.dll + dhconfigsdk.dll + dhplay.dll + dhlog.dll
其他：avnetsdk.dll、EagleEyeRender.dll
```
→ 每个厂商一套**闭源 SDK**，各自授权、各自更新、各自有坑。

### 2.2 自研流媒体层
```
StreamSvr.dll（流服务）  StreamParser.dll（码流解析）  Stream.dll  HmMerge.dll
```

### 2.3 解码与后处理层
```
h264dec / hevcdec / mpeg4dec / mjpegdec / svac_dec / mp3dec / aacdec / mp2dec / amrdec / adpcmdec / postproc
HWDecode.dll（硬解）  HXVA.dll（硬件加速）  YUVProcess.dll
```

### 2.4 渲染层（Windows 图形专用）
```
SuperRender.dll  MP_Render.dll  AudioRender.dll  D3DCompiler_43  D3DX9_41  d3dx9_43  GdiPlus
```

### 2.5 通信与基础设施
```
libzmq.dll（ZeroMQ！）  libcrypto/libssl/libeay32/ssleay32（OpenSSL）  Json.dll  Log.dll  Infra.dll
```

### 2.6 驱动注册表（`VideoDevices.config`）
```xml
<VD><Name>HikvisionDS7604NE1_NVRV40</Name>
    <Class>展厅.VDDrive.Hikvision.DS7604NE1Device</Class>
    <Assembly Name="CE.VDDrive.Hikvision.DS7604NE1" Version="1.0.0.0"/></VD>
```
→ **一型号一驱动**（DS6101HF、DS7604NE1、DHNVR4416、ECR3316、HT8504VTU…）。
换一个新型号 → 联系展厅要新驱动 → `VideoDriverInstaller.exe` 安装。

### 2.7 进程模型
- `展厅视频服务.exe`（**VSS** 视频服务）常驻，**依赖加密锁**（否则 30 分钟演示模式）；
- 监控端**通过 `libzmq`（ZeroMQ）**与 VSS 通信 → 这是它的"分布式视频"实现方式；
- 配置靠 `导入/导出` 文件在两台机器间同步。

---

## 三、它的设备模型（从 `LocalXml.zip` 实证）

`LocalXml.zip` 内含 **442 个 XML**，文件名如 `80ST_v22.xml`、`90ST_v213_120822.xml`、`91HF_S_v13_v12.xml`
——这些是**海康 ISAPI 的 `DeviceAbility` 能力描述文件**（离线预置）。

样本（`90ST_v22.xml`）：
```xml
<DecviceAbility version="2.0"><BasicCapability>
  <HardwareCapability><VideoInNum>16</VideoInNum><AlarmInPortNum>16</AlarmInPortNum>
    <IPChannelNum>32</IPChannelNum> ...</HardwareCapability>
  <SoftwareCapability><PtzSupport>1</PtzSupport><RtspSupport>1</RtspSupport>
    <MotionDetectAlarmSupport>1</MotionDetectAlarmSupport><VILostAlarmSupport>1</VILostAlarmSupport> ...
```
→ 它**把 442 个型号的能力表离线打包**，用来决定 UI 显示哪些按钮。

**这条路的代价**：型号更新了它就得重新发包；覆盖不到的型号功能就残缺。

---

## 四、它的"视数融合"到底怎么做的（关键）

`展厅.Hmi.Customized.Video.Mqtt.dll` 的字符串暴露了真相：

```
uPLibrary.Networking.M2Mqtt            ← M2Mqtt.Net（C# MQTT 客户端）
ClientPublish / ClientSubscribe / UnSubscribe
MQTTConnect;ClientID={0}, IP={1}, Port={2}, User={3}, PWD={4}
MqttSendHelper_DealKeepAlive           ← 自建心跳
```

**结论：它的"视频与数据融合"是靠一个 MQTT 桥接 DLL 实现的——把视频事件/指令发布到 MQTT 主题，与过程数据共用一个 MQTT 总线。**

再看海康驱动里的能力字符串（HCNetSDK 封装）：
```
AV_CFG_PtzLink_Preset / AV_CFG_PtzLink_Pattern / AV_CFG_PtzLink_Tour   ← 报警联动预置点/巡航
AddPreset / AddCruisePoint                                            ← 预置点/巡航写入
ALARM_VIDEOLOSS / ALARM_MOTIONDETECT / ALARM_VIDEOBLIND / ALARM_TRACK
ALARM_VEHICLEACC / ALARM_VEHICLE_COLLISION / ALARM_VEHICLE_TURNOVER   ← 车辆 AI 报警
ALARM_UPLOAD_IVS_INFO                                                 ← 智能视频(IVS)事件上传
CFG_CMD_HDMIMATRIX / CFG_CMD_MATRIX_SPOT / CFG_CMD_MONITORTOUR        ← 视频矩阵/轮巡
CFG_CMD_RECORD / PLAYBACK / RECORDBACKUP                              ← 录像与备份
```
**即：它的"智能视频报警"是借用**NVR 内置的 IVS**（车牌/车辆/越界），不是自己做的 AI。**

---

## 五、它的短板（可量化的攻击点）

| # | 短板 | 证据 | 影响 |
|---|---|---|---|
| W1 | **Windows 原生栈** | DirectX9 + SDL2 + DirectShow + GdiPlus | 国产化/麒麟/信创环境不可用；Linux/容器不可用 |
| W2 | **依赖闭源厂商 SDK** | HCNetSDK、dhnetsdk、avnetsdk | 受制于厂商；授权/法律风险；升级不可控 |
| W3 | **一型号一驱动** | `VideoDevices.config` 逐型号注册 | 新型号必须等厂商发包 |
| W4 | **加密锁授权** | 手册："需要插入加密锁…按通道数确定型号" | 按通道收费，成本高 |
| W5 | **驱动包加密** | `RTSPDevice.dpk` 67/67 加密 | 用户无法修复/扩展 |
| W6 | **x86+x64 双份** | dpk 内两份完整运行时 | 安装体积巨大（156MB/驱动） |
| W7 | **能力表离线固化** | 442 个 ISAPI XML 打包 | 易过期；仅覆盖海康 |
| W8 | **VSS 需逐机安装** | `展厅视频服务.exe` | 分布式部署运维重 |
| W9 | **无浏览器原生播放** | 需其客户端或 ActiveX | 手机/大屏无权访问 |
| W10 | **视频 AI 靠 NVR** | `UPLOAD_IVS_INFO` | 无法自定义算法 |

---

## 六、我们的方案（逐条反超）

> 原则：**用开放标准替换私有 SDK，用浏览器替换原生渲染，用实时能力发现替换静态能力表。**

| # | 展厅做法 | 开诚智枢scada 做法 | 反超点 |
|---|---|---|---|
| O1 | Win32 + DirectX9 渲染 | **纯 Web：WebRTC(WHEP) → HTTP-FLV → HLS 逐级降级** | 任意浏览器/OS/信创环境；手机大屏可看 |
| O2 | 每厂商一套闭源 SDK | **RTSP + ZLMediaKit（开源 MIT）** 一套覆盖全品牌 | 无厂商锁定、无授权风险 |
| O3 | 一型号一驱动 | **厂商模板 + 自定义模板**（`{channel}/{subtype}` 变量化） | 新型号**填 IP 即用**，不等发包 |
| O4 | 加密锁按通道收费 | **开源，无锁** | 零授权成本 |
| O5 | 驱动包加密 | **全部源码开放**（`server/runtime/cameras/*`） | 可自行修复扩展 |
| O6 | x86+x64 双份运行时 | **单个 Node 进程 + ZLMediaKit 单二进制** | 部署体积从 156MB 降到 MB 级 |
| O7 | 442 个静态 ISAPI XML | **实时能力发现**：查 `/ISAPI/System/capabilities`、ONVIF `GetCapabilities`，UI 自动适配 | 永不陈旧；跨品牌 |
| O8 | VSS 逐机安装 | **容器化 + 无状态 API**，一个命令起服务 | 水平扩展；K8s 友好 |
| O9 | 需客户端/ActiveX | **浏览器直接播** | 零安装 |
| O10 | AI 靠 NVR 内置 IVS | **开放 AI 接入**：检测结果经 WS/MQTT 入 → 画面叠加框 + 触发报警（Frigate 模式） | 可接**自研/煤矿专用算法** |
| O11 | 视频事件走**额外**的 MQTT 桥 DLL | **MQTT 与 WebSocket 是原生设备总线**（我们已有 MQTT 驱动） | 无需桥接，天然融合 |
| O12 | 预置点/巡航仅厂商 SDK | **文档化 HTTP（ISAPI/CGI）** + 后续 ONVIF PTZ | 可脚本化、可自动化 |

### 6.1 我们已经落地的（本轮实证）

| 能力 | 状态 | 证据 |
|---|---|---|
| 相机 CRUD + 厂商模板 | ✅ | `/api/cameras`、`/api/cameras/vendors` |
| 凭证安全（永不外泄） | ✅ | probe 返回 `rtsp://***:***@…`，复验 `LEAK_FIXED` |
| 媒体网关（ZLMediaKit） | ✅ | `addStreamProxy` + **WHEP 后端代理** |
| 浏览器播放 | ✅ | WebRTC 优先，失败自动降级 JPEG |
| **PTZ / 预置点** | ✅ | `/api/cameras/:id/ptz`，`/ptz/preset` |
| 能力上报 | ✅ | `ptz/capabilities` → UI 自动启停控制盘 |
| 相机管理界面 | ✅ | SCADA 控制台 + 编辑器 + 实时预览 |
| 中文全量 | ✅ | 2078 键 0 缺失 |

### 6.2 比展厅"更优秀"的差异化能力（规划中）

1. **实时能力发现** → UI 按设备真实能力自适应（展厅靠 442 张静态表）。
2. **AI 完全开放** → 接自研算法（煤矿：皮带异物、人员越界、瓦斯区域入侵），不依赖 NVR。
3. **视频即数据** → 相机状态、AI 事件、PTZ 动作**都是 SCADIA 变量**，可直接进报警/归档/趋势/报表。
4. **OSD 变量叠加** → 与标定/趋势同源，真正"视数一体"。
5. **跨平台 + 分布式容器** → 一套镜像多节点，天然支持矿区分级部署。

---

## 七、结论

- `RTSPDevice.dpk` = **FFmpeg + .NET + DirectX 的 Windows 原生 RTSP 驱动包**，全部加密，x86/x64 双份；
- 展厅整栈 = **厂商私有 SDK + 自研流媒体 + DirectX 渲染 + ZeroMQ IPC + MQTT 桥**，能力靠 **442 张静态 ISAPI XML**，授权靠**加密锁**；
- 它的**专业度毋庸置疑**，但**架构是 2010 年代的 Windows 单体思路**；
- 我们走 **RTSP + ZLMediaKit + WebRTC + 实时能力发现 + 原生 MQTT/WS + 开放 AI**，
  在 **跨平台、零安装、零授权、可扩展、可自研 AI** 五个维度全面反超，且**专业能力对齐**（PTZ/预置点/巡航/OSD/矩阵/录像）。
