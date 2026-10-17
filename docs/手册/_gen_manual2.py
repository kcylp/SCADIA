# -*- coding: utf-8 -*-
"""SCADIA 工程配置与修改手册（3.0.0 · 界面收敛版）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _gen_lib import *

doc = build_doc(
    '工程配置与修改手册', '面向实施 / 运维 / 二次开发 · 配置字段逐条图解版',
    '3.0.0',
    [('文档名称', 'SCADIA 工业监控与八场景视频分析系统 · 工程配置与修改手册'),
     ('适用版本', 'SCADIA 3.0.0（界面收敛版，源码基线 2026-10-17）'),
     ('读者对象', '实施工程师、运维工程师、二次开发人员'),
     ('阅读前提', '了解 Windows 基本操作；能看懂目录与文本文件即可'),
     ('编写日期', '2026-10-17'),
     ('配套文档', '《SCADIA 软件使用手册》《部署维护手册》《产品说明书》')],
    'SCADIA 工程配置与修改手册')

h1(doc, '阅读说明与版本记录')
para(doc, '本手册讲的是另一件事：这套软件装在机器上以后，文件都在哪、每个配置项是什么意思、要改某个功能时应该动哪个文件、改完怎么验证、怎么备份和升级。它与《软件使用手册》相互独立，一个面向“用”，一个面向“配”。')
note(doc, '安全红线：project 目录下的配置文件包含相机账号、平台账号、模型密钥等真实凭据，禁止提交到 Git、禁止贴到公共聊天、禁止写入任何手册。本手册所有示例一律使用 <占位符>。')
table(doc, [
    ['版本', '日期', '修改说明'],
    ['1.0', '2026-10-16', '首版：交付组成、启动、配置职责、备份、健康检查、故障处理'],
    ['3.0.0', '2026-10-17', '对齐 3.0.0：逐字段配置详解、常用修改任务、客户端构建与发布、截图'],
    ['3.0.0-r2', '2026-10-17', '界面收敛：菜单与统一分析只保留八算法；新增账号活动审计的库、保留期、接口与备份'],
])
start_body(doc, 'SCADIA 工程配置与修改手册')

h1(doc, '第 1 章  交付物与目录结构')
para(doc, '先建立“这套软件由哪些文件组成”的整体印象。理解这张表，后面所有配置说明都能对号入座。')
table(doc, [
    ['目录 / 文件', '内容', '新机器是否自动获得'],
    ['source/server', 'Node 服务、API、驱动、SQLite 账本、测试', '克隆有源码；依赖需另装'],
    ['source/client', 'Angular 界面与项目配置', '克隆有源码；需要构建'],
    ['source/tools', '视频代理、检测、复核、事件桥接、检查工具', '源码随库；Python / FFmpeg / 模型另装'],
    ['docs', '产品 / 操作 / 部署 / 配置手册与历史文档', '随库'],
    ['project', '现场工程、账号、设备、配置、日志、事件证据', '不随源码；需授权备份恢复'],
    ['models', '人体 / 姿态 / 安全帽 / VLM 等权重', '不随源码；离线预置并记录来源'],
    ['runtime', '可选便携 Node、Python、FFmpeg', '不随源码；自行安装或恢复'],
    ['start-scadia.ps1', '联合启动入口', '随库；依赖上面的实际环境'],
    ['deploy-scenes.ps1', 'Windows 工程重启与版本端点探测', '随库；不是安装器'],
], widths=[4.2, 7.5, 4.0])
figure(doc, '14-home', '图 1-1  系统启动后进入的首页（八场景总览）')
h2(doc, '1.1 最关键的三个位置')
bullets(doc, [
    '源码目录：source —— 升级时替换它的内容。',
    '现场工程目录：project —— 所有现场数据、账号、配置在这里，备份就是备份它。',
    '运行数据目录：project/_appdata —— 数据库、事件、证据图片、各 JSON 配置的实际存放处。',
], numbered=True)
note(doc, '现场路径示例为 D:\\SCADIA-工作站迁移\\SCADIA。若安装到其它目录，所有本地绝对路径（模型、FFmpeg、代理）都要同步检查。')

# ============ 第 2 章 ============
h1(doc, '第 2 章  运行环境与依赖')
para(doc, 'SCADIA 由两类运行时组成：Node.js（平台服务与网页界面）和 Python（视频代理、AI 检测、复核、VLM）。显卡可选，但可见光 / 红外检测与 VLM 复核在 GPU 上更快。')
table(doc, [
    ['组件', '作用', '是否必需'],
    ['Node.js + npm', '平台服务、页面构建', '必需'],
    ['Python 3', '视频代理、检测、复核、VLM', '视频与 AI 场景必需'],
    ['FFmpeg', 'RTSP 取帧转码', '视频代理必需'],
    ['PyTorch / Ultralytics / OpenCV', '目标检测与姿态', 'AI 检测必需'],
    ['NVIDIA 驱动 + CUDA 版 PyTorch', 'GPU 推理加速', '可选'],
    ['本地 VLM 权重（如 Qwen2.5-VL）', '事件复核与巡视描述', '复核功能必需'],
], widths=[5.2, 6.7, 3.8])
para(doc, 'Python 依赖安装入口：')
bullets(doc, [
    'cd source/tools',
    'python -m pip install -r requirements-ai-tracker.txt',
])
note(doc, 'CUDA 版 PyTorch 与 VLM 依赖必须与实际驱动版本匹配，仅执行安装命令并不能证明 GPU 可用。启动后应查看实际 device、模型路径、推理耗时和错误。')

# ============ 第 3 章 ============
h1(doc, '第 3 章  启动、停止与重启')
h2(doc, '3.1 正常启动')
para(doc, '在仓库根目录执行：')
bullets(doc, [
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\start-scadia.ps1',
])
para(doc, '启动脚本会依次检查运行目录，启动视频代理、事件桥接、可见光检测、红外检测、VLM，最后启动平台服务。缺少可选依赖时会输出“跳过”提示；主服务启动不代表所有 AI 子进程都已启动。')
table(doc, [
    ['参数', '含义', '典型用法'],
    ['-Port 1881', '指定平台端口', '端口冲突时改端口并同步客户端'],
    ['-Sandbox', '使用沙箱副本启动，不写真实 project', '演示 / 隔离测试'],
    ['-Rebuild', '启动前重建前端', '源码更新后首次启动'],
    ['-DataDir <路径>', '指定运行数据目录', '多工程并行或恢复验证'],
], widths=[3.6, 7.2, 4.9])
h2(doc, '3.2 停止')
para(doc, '在运行启动脚本的窗口按 Ctrl+C。脚本在 finally 中会停止它自己拉起的子进程。关闭前请确认允许短暂停止业务。')
h2(doc, '3.3 重启（部署用）')
bullets(doc, [
    'powershell -NoProfile -ExecutionPolicy Bypass -File .\\deploy-scenes.ps1',
])
note(doc, 'deploy-scenes.ps1 会中断当前进程：它只停止命令行包含本仓库完整路径的 Node / Python 组件，再用隐藏窗口拉起 start-scadia.ps1，最多探测 /api/version 30 次。它不重编译前端、不备份数据库、不验证相机与推理。执行前必须先构建、备份，并在重启后回读状态。')

# ============ 第 4 章 ============
h1(doc, '第 4 章  配置文件详解（核心）')
para(doc, '以下文件都位于本地 project/_appdata 下。它们包含凭据，禁止提交 Git。本章逐字段说明，所有示例中的 <占位符> 都必须替换为现场实际值，且替换后不要提交。')
table(doc, [
    ['文件', '职责', '维护注意'],
    ['settings.js（mysettings.json）', '服务端口、安全模式、存储、界面收敛与集成', '对照 settings.default.js；改端口要同步客户端'],
    ['accounts.scadiap.db', '账号活动台账（登录 / 失败 / 注销 / 退出 / 超时）', '独立 SQLite；保留期可配置；随 project 备份'],
    ['ai-tracker.json', '可见光相机、取帧源、模型、规则、平台连接', '门口只经受校验的保存流程确认'],
    ['ai-tracker-thermal.json', '红外相机、取帧源、独立模型与输出', 'streamKind=thermal；勿复制可见光几何'],
    ['mjpeg-sources.json', '视频代理的源、认证和 FFmpeg 参数', '可见光 / 红外各一条；勿外泄 RTSP'],
    ['video-events.json', '摄像机原生事件桥接（电子围栏）', '原生事件与视觉候选分开检查'],
    ['vlm.json', '本地 VLM 目录、设备、预算', 'model_dir 必须存在；默认 maxNewTokens=200'],
    ['model-service.json', 'DeepSeek 服务、模型和密钥（由配置服务管理）', '页面不回显密钥'],
], widths=[4.0, 7.2, 4.5])

h2(doc, '4.1 settings.js —— 平台总设置')
para(doc, '该文件实际以 JSON 结构保存（工程内的 mysettings.json），控制端口、安全、存储、界面收敛与集成开关。关键字段如下。')
table(doc, [
    ['字段', '含义', '建议值 / 注意'],
    ['uiPort', '平台网页端口', '现场默认 1881；改动后浏览器地址要跟着改'],
    ['secureEnabled', '安全模式：八场景相关需登录', '正式现场建议开启'],
    ['secretCode', '令牌签名用的本地密钥', '禁止外泄、禁止提交；泄露后应更换'],
    ['tokenExpiresIn', '登录令牌有效期', '按现场安全要求设置，如 1h'],
    ['enableRefreshCookieAuth', '刷新令牌基于 Cookie', '按浏览器策略选择'],
    ['analysisFocus', '统一 AI 分析的模块范围；缺省为 scenes', 'scenes=只开放 V1–V7 + T1；full=恢复全部模块'],
    ['accountActivityRetentionDays', '账号活动台账保留天数；缺省 365', '大于 0 时按天清理；小于等于 0 表示不自动清理'],
    ['nodeRedEnabled / nodeRedAuthMode', '流程（Node-RED）开关与鉴权', '本版本菜单已隐藏流程；不用时保持关闭'],
    ['swaggerEnabled', '是否暴露接口文档', '生产建议关闭'],
    ['smtp', '邮件通知服务器', 'host/port/username 按授权配置填写'],
    ['daqstore / alarms / logs', '历史、报警、日志的保留策略', '按容量与合规要求设置 retention'],
], widths=[4.6, 6.6, 4.5])
note(doc, 'mysettings.json 的默认配置不是生产安全配置。正式上线前必须配置授权账号、开启 secureEnabled、限制监听与防火墙范围，并重新验证读写权限。')

h2(doc, '4.2 ai-tracker.json —— 可见光检测（逐字段）')
para(doc, '这是八场景里 V1–V7 的核心：它告诉检测程序“看哪个相机的哪路流、用什么模型、把结果推给谁”。')
table(doc, [
    ['字段', '含义', '取值 / 说明'],
    ['platform', '平台服务地址', 'http://127.0.0.1:<uiPort>'],
    ['user / password', '检测程序登录平台的账号', '<授权账号>；禁止提交'],
    ['cameraId', '相机在平台中的 ID', '与“摄像机”页中的 ID 一致'],
    ['camera.host / user / password', '摄像机直连信息', '<相机地址与账号>；禁止提交'],
    ['source.snapshot', '取帧地址（经视频代理）', 'http://127.0.0.1:1886/snapshot/<源名>'],
    ['model', '检测模型路径或名称', '如 yolov8n.pt；离线请用绝对路径'],
    ['device', '推理设备', 'auto / cpu / cuda:0'],
    ['imgsz', '推理输入尺寸', '默认 640'],
    ['conf / iou', '置信度 / 交并比阈值', '阈值越高越保守'],
    ['classes', '关注的目标类别', '[0] 表示“人”'],
    ['label', '标签显示名', '如 人员'],
    ['targetFps', '目标处理帧率', '越高越吃资源'],
    ['pushHz', '向平台推送结果的频率', '如 0.2 表示约 5 秒一次'],
    ['tracker', '跟踪器配置', '如 bytetrack.yaml'],
    ['reconnectMs', '断流重连间隔', '毫秒'],
    ['streamKind', '流类型', 'visible（可见光）'],
    ['publicFile', '对外输出文件名', '如 ai-tracks.json'],
], widths=[4.6, 6.2, 4.9])
note(doc, '模型路径不存在时，Ultralytics 可能按名字尝试联网下载；离线部署必须提前准备正确权重并核对文件大小与哈希。')

h2(doc, '4.3 ai-tracker-thermal.json —— 红外辅助（T1）')
para(doc, '红外与可见光是两条独立链路。红外使用独立 cameraId、streamKind 为 thermal、snapshot 后缀为 -thermal、独立输出文件，并使用适合的模型与阈值。不要把可见光的门口几何复制到红外配置里。')
note(doc, 'T1 只提供“相对热源异常候选”，本系统未接真实测温接口，不输出摄氏度、体温或诊断结论。')

h2(doc, '4.4 mjpeg-sources.json —— 视频源与代理')
para(doc, '视频代理（默认端口 1886）按这里的列表拉取 RTSP 并缓存最新帧，供页面与检测程序取用。可见光与红外各配一条。')
table(doc, [
    ['字段', '含义', '说明'],
    ['name', '源名称', '如 kuangqu1、kuangqu1-thermal，供 snapshot 路径引用'],
    ['rtsp', '取流地址', 'rtsp://<用户>:<密码>@<相机IP>:554/...（禁止外泄）'],
    ['fps', '取帧帧率', '按带宽与算力设置'],
    ['cameraId', '对应平台相机 ID', '与 ai-tracker 中的 cameraId 一致'],
], widths=[3.6, 5.0, 7.1])
note(doc, '含账号密码的 RTSP 地址属于敏感信息。对外提供材料前必须脱敏，禁止把该文件提交到任何代码仓库。')

h2(doc, '4.5 video-events.json —— 摄像机原生事件桥接')
para(doc, '把摄像机的原生智能事件（如 VMD 移动侦测）映射为平台事件。电子围栏以相机 FieldDetection 区域多边形表示，坐标为归一化 0..1000，与 /ISAPI/Smart/FieldDetection/1 一致。')
table(doc, [
    ['字段', '含义'],
    ['cameraId / debounceMs', '目标相机与去抖时间（毫秒）'],
    ['fence.points', '围栏多边形顶点（归一化 0..1000）'],
    ['fence.highlightMs', '命中后高亮持续时长'],
], widths=[4.6, 11.1])

h2(doc, '4.6 vlm.json —— 本地视觉语言模型')
table(doc, [
    ['字段', '含义', '说明'],
    ['model_dir', '本地模型目录', '必须是实际存在的绝对路径'],
    ['device / dtype', '推理设备与精度', '如 auto / float16'],
    ['maxNewTokens', '单次生成上限', '默认 200；受硬超时与输入预算限制'],
    ['prompt', '复核提示词', '决定模型描述风格'],
    ['periodic', '周期巡视', 'enabled 控制是否定时看画面'],
    ['maxCaptions / pushToPlatform', '字幕保留上限 / 是否回传平台', '按需设置'],
], widths=[4.6, 5.4, 5.7])

h2(doc, '4.7 模型服务（DeepSeek）配置')
para(doc, '统一 AI 分析的“大脑”是一个 HTTPS 大模型服务，默认指向 DeepSeek。地址、模型名、密钥由配置服务管理，界面不回显密钥，留空表示保留原值。')
table(doc, [
    ['字段', '含义'],
    ['baseUrl', 'HTTPS 服务地址，如 https://api.deepseek.com'],
    ['model', '模型名，如 deepseek-chat'],
    ['apiKey', '授权密钥（<占位符>，禁止提交与截图外泄）'],
], widths=[4.6, 11.1])

# ============ 第 5 章 ============
h1(doc, '第 5 章  常用修改任务（How-to）')
h2(doc, '5.1 新增一台相机')
bullets(doc, [
    '在“摄像机”页登记相机，记录生成的 cameraId。',
    '在 mjpeg-sources.json 增加一条 source，填写 name、rtsp、fps、cameraId。',
    '在 ai-tracker.json（可见光）或 ai-tracker-thermal.json（红外）填写同一 cameraId 与对应 snapshot 地址。',
    '重启视频代理与检测进程，回读相机在线状态与 updatedAt 是否前进。',
], numbered=True)
figure(doc, '05-cameras', '图 5-1  摄像机页：登记与查看相机、核对 cameraId')
h2(doc, '5.2 调整检测灵敏度')
para(doc, '修改 ai-tracker.json 中的 conf（置信度）与 iou。调高 conf 更保守、误报更少但可能漏检；调低 conf 更敏感、可能误报。修改后重启检测进程，并用真实 / 混淆样本分别复测。')
figure(doc, '08-device', '图 5-2  设备与标签页：核对设备连接、协议、采集质量与时间')
h2(doc, '5.3 重新标定门口方向')
para(doc, '门口标定在“AI 检测”画面内完成，属于受校验的保存流程。改动相机角度、分辨率、镜像或裁剪后，旧坐标必须重做并重新做正反通行验证。')
figure(doc, '01-scenes', '图 5-3  AI 检测画面：门口标定与八张场景卡片')
figure(doc, '09-calibrations', '图 5-4  标定页：查看与管理标定版本')
h2(doc, '5.4 修改平台端口')
bullets(doc, [
    '修改 settings.js 的 uiPort（或启动参数 -Port）。',
    '同步修改客户端期望的地址与检测程序 platform 字段。',
    '核对防火墙放行范围；重启后访问 /api/version 确认 200。',
], numbered=True)
h2(doc, '5.5 配置模型服务（DeepSeek）')
para(doc, '管理员从“系统 → 模型服务配置”（/analysis?config=1）打开配置面板，填写 HTTPS 服务地址、模型名与密钥。保存后回读配置状态；密钥留空表示保留原值。')
figure(doc, '17-model-config', '图 5-5  模型服务配置（仅管理员可见）')
note(doc, '“测试连接”成功只说明这一次模型请求成功，不代表八场景准确率通过；密钥不得写入文档或提交仓库。')
h2(doc, '5.6 增加一台红外源（T1）')
bullets(doc, [
    '在 mjpeg-sources.json 增加红外 source，名称与检测程序引用的 snapshot 后缀一致（常见为 -thermal）。',
    '在 ai-tracker-thermal.json 设置独立 cameraId、streamKind=thermal 与 snapshot 地址。',
    '重启红外检测进程，确认 /api/ai/scenes 的 thermal.updatedAt 独立前进。',
    '不要复制可见光 ai-tracker.json 的门口几何到红外配置。',
], numbered=True)

# ============ 第 6 章 ============
h1(doc, '第 6 章  账号与权限')
para(doc, '账号与角色在“系统”分组下管理。安全模式开启时，八场景全局状态、画面、账本、历史证据与统一分析汇总需要管理员权限；未登录返回 401，普通账号访问管理接口返回 403。')
figure(doc, '10-users', '图 6-1  用户管理：新增、禁用与查看账号')
figure(doc, '11-user-roles', '图 6-2  角色管理：为角色分配权限')
note(doc, '首次部署必须按初始化流程设置授权账号，不要沿用公开的固定口令；正式上线前开启 secureEnabled 并限制网络监听范围。')
para(doc, '本版本新增“账号活动”审计：登录、登录失败、注销、退出（关闭页面）与会话超时都会写入独立台账，只有管理员能在“报表 → 账号活动”查看。台账不含口令、令牌或 Cookie。')

# ============ 第 7 章 ============
h1(doc, '第 7 章  界面收敛与账号活动审计')
para(doc, '本版本做了两件互相关联的事：界面只保留八种算法（V1–V7、T1）相关入口；同时把“谁在什么时候登录 / 注销 / 退出”记成独立台账。本章说明这两个开关在哪、怎么回滚、怎么备份和验收。')

h2(doc, '7.1 菜单收敛（MENU_FOCUS）')
para(doc, '菜单在源码里由 source/client/src/app/_models/default-navigation.ts 决定。文件顶部有：')
bullets(doc, [
    'export const MENU_FOCUS: string = \'scenes\';',
])
para(doc, 'scenes 表示只显示与八场景相关的 5 组菜单：总览、监视、数据、资产、系统。改为 full 后重建前端，即恢复完整的七组菜单（含报警中心、历史报警、配方、脚本、流程、通知、多语言、插件、API 密钥、位置、编辑器等）。')
table(doc, [
    ['MENU_FOCUS', '菜单表现', '适用场景'],
    ['scenes（默认）', '只显示八算法交付所需入口', '本项目正式交付'],
    ['full', '恢复平台全部入口', '需要临时使用其它模块，或排障对照'],
], widths=[3.4, 8.0, 4.3])
note(doc, '菜单只是“不显示”，路由仍然保留：直接输入 /alarms、/recipes 等地址依然可以打开。若需要彻底禁止访问，必须在反向代理或权限层限制，而不是依赖隐藏菜单。')

h2(doc, '7.2 统一分析收敛（analysisFocus）')
para(doc, '服务端在 source/server/api/analysis/evidence.js 里按开关过滤模块。开关取值来自 mysettings.json 的 analysisFocus，或环境变量 SCADIA_ANALYSIS_FOCUS；缺省为 scenes。')
table(doc, [
    ['取值', '/api/analysis/modules 返回', '行为'],
    ['scenes（默认 / 缺省）', '只有“八场景与 AI”一个模块', '只开放八场景综合、单事件与 V1–V7、T1'],
    ['full', '完整模块表（SCADA、MES、EMS、报警、配方…）', '恢复原有全部分析模块'],
], widths=[4.2, 7.2, 4.3])
para(doc, '即使有人手工构造 module=intent 请求，服务端也会在 /api/analysis/context 与 /api/analysis/chat 边界拒绝，并返回：')
bullets(doc, [
    'missing[0].code = target_not_allowed',
    'missing[0].message = 统一分析仅开放八场景算法（V1–V7、T1）',
])
note(doc, '修改 analysisFocus 后需要重启服务端；修改 MENU_FOCUS 后需要重建前端（cd source/client && npm run build）。两者互相独立：只改一个，另一半仍是旧范围。')

h2(doc, '7.3 账号活动台账（accounts.scadiap.db）')
para(doc, '审计数据存放在独立 SQLite 库 project/_appdata/accounts.scadiap.db，表名为 account_activity。它不写进项目主库，避免与业务数据相互影响。')
table(doc, [
    ['列', '含义'],
    ['id', '自增主键'],
    ['at', '动作时间（epoch 毫秒）'],
    ['username', '登录名；登录失败时是尝试使用的账号名'],
    ['fullname', '账号姓名（失败时通常为空）'],
    ['action', 'login / login_failed / logout / exit / session_timeout'],
    ['result', 'ok / denied'],
    ['client_ip', '来源地址（同机通常 127.0.0.1）'],
    ['user_agent', '浏览器标识，截断保存'],
    ['session_id', '客户端会话标识（仅用于去重，不含令牌）'],
], widths=[3.4, 12.6])
para(doc, '记录规则：登录成功写 login/ok；口令错误或账号不存在写 login_failed/denied；主动注销写 logout/ok；页面关闭时由浏览器 sendBeacon 上报 exit/ok；客户端发现令牌过期时补记 session_timeout/ok。写入失败只记日志，不影响登录本身。')
h3(doc, '保留期')
para(doc, 'settings.accountActivityRetentionDays 控制保留天数，缺省 365；小于等于 0 表示不自动清理。清理按 at 字段删除早于截止时间的行，不区分账号。')
h3(doc, '查询接口')
table(doc, [
    ['接口', '方法', '权限', '说明'],
    ['/api/accounts/activity?from&to&username&action&limit&offset', 'GET', '仅管理员', '默认最近 7 天；窗口最大 366 天；limit 上限 500'],
    ['/api/session/exit', 'POST', '按令牌 / 刷新 Cookie 识别身份', '永远返回 204；5 秒内同会话去重；支持 reason=exit / session_timeout'],
], widths=[6.6, 1.6, 3.6, 4.2])
note(doc, '“退出”依赖浏览器上报，属于尽力送达：关闭浏览器、断电或网络中断时可能缺失。缺失只能说明“没有收到上报”，不能说明账号仍在登录。台账不记录口令、令牌或 Cookie，因此不能用于找回密码。')

h2(doc, '7.4 收敛与审计的验收')
bullets(doc, [
    'GET /api/analysis/modules 只返回 video 模块，intents 为 all_scenes、scene_event、V1–V7、T1 共 10 项。',
    'POST /api/analysis/context，module=alarms、intent=current_alarms，返回 target_not_allowed。',
    '浏览器菜单只剩 5 组；报警中心、历史报警、配方、脚本、流程、通知、插件、API 密钥、位置、编辑器不出现。',
    '故意输错一次密码，登录失败会在“报表 → 账号活动”出现一行 login_failed / denied，且不含口令。',
    '普通账号访问 /api/accounts/activity 返回 403 admin_required；管理员返回 200 和台账。',
    '重启服务端后再查台账，历史行仍在（说明数据在磁盘，不是内存）。',
], numbered=True)
figure(doc, '07-report-activity', '图 7-1  报表 → 账号活动：登录、失败、注销、退出都能追溯')
figure(doc, '13-analysis', '图 7-2  统一 AI 分析：模块固定为“八场景与 AI”')

# ============ 第 8 章 ============
h1(doc, '第 8 章  运行数据与备份')
para(doc, 'workDir 为当前 userDir 下的 _appdata。备份要备份“整个 project”，而不是只复制一个数据库文件。')
table(doc, [
    ['需备份的内容', '所在位置'],
    ['用户 / 权限、项目定义、设备 / Tag / 报警配置与业务历史', 'project 及其数据库'],
    ['账号活动台账（登录 / 失败 / 注销 / 退出 / 超时）', '_appdata/accounts.scadiap.db'],
    ['事件投递队列、持久事件数据库、复核结果', '_appdata/scene-events 与 scene-events.db'],
    ['事件历史图片与连续帧', '_appdata/scene-evidence'],
    ['计数投影与清零审计、门口配置与标定版本', '相关配置与数据库'],
    ['运行状态与诊断图、必要日志', '_images、_logs'],
    ['模型 / 环境版本清单与授权外置模型', 'models 与版本清单'],
], widths=[9.0, 6.7])
para(doc, '账号活动台帐属于安全审计资料，建议单独保留一份只读副本：复制前先停止写入进程，复制后核对行数与最新时间。按现场合规要求确定保存期限，不要因为“页面看不到”就跳过备份。')
note(doc, '停止该工程全部写入进程后再复制；启用 WAL 的 SQLite 要连同辅助文件用一致性方式备份，避免运行中只复制主文件导致损坏。恢复测试应在隔离目录和不同端口进行。')

# ============ 第 9 章 ============
h1(doc, '第 9 章  日志、健康检查与故障处理')
para(doc, '日志位于 project/_logs：scene-launch、ai-tracker、ai-tracker-thermal、vlm、视频代理和桥接日志。提交支持材料前必须脱敏。')
figure(doc, '12-logs', '图 9-1  日志页：定位启动、检测、复核与代理异常')
h2(doc, '9.1 健康检查顺序')
bullets(doc, [
    '访问 /api/version 返回 200。',
    '登录管理员读取 /api/ai/scenes 与 /api/ai/scene-events。',
    'visible / thermal 各自的 updatedAt 持续前进。',
    '相机代理 X-Frame-Time 前进（有新状态不代表不是重复帧）。',
    '门口 appliedCalibrationVersion 与实际保存版本一致，且无 calibrationError。',
    '报表 → 账号活动能读到最新登录记录，且时间与操作一致。',
], numbered=True)
h2(doc, '9.2 故障处理速查')
table(doc, [
    ['故障', '排查顺序', '恢复判据'],
    ['1881 不响应', 'launcher 日志、端口占用、依赖、settings 语法、目录权限', 'API 200 且可进入'],
    ['新功能未出现', '浏览器缓存、实际 httpStatic、server/dist 与 client/dist、旧进程', '返回 HTML / JS 含本轮入口'],
    ['源离线 / 陈旧', '1886 代理、FFmpeg、网络 / 认证、updatedAt', '两源分别连续前进'],
    ['事件未入账', '投递队列、畸形事件隔离、DB 权限、sceneId / kind / source', '合法事件唯一落库，重启不重复'],
    ['图片 404', 'scene-evidence 文件与 eventId、备份完整性、查看权限', '原事件图片可读；不得用实时图冒充'],
    ['复核长期 pending', 'VLM 模型加载、平台登录、租约、超时、显存', '对原 eventId 产生终态或明确失败码'],
    ['门口无进入', 'gate.enabled / verified、版本回读、线两侧、轨迹稳定性', '真实外→内 +1，内走 / 反向不加'],
    ['账号活动为空', 'secureEnabled、是否真的登录过、保留期、accounts 库权限', '登录 / 失败动作各产生一行'],
    ['DeepSeek 未配置', '配置状态、地址、密钥、网络 / 超时', '测试返回合法结果且不泄露密钥'],
], widths=[3.4, 7.6, 4.7])

# ============ 第 10 章 ============
h1(doc, '第 10 章  测试与验收命令')
para(doc, '在对应实际项目目录执行。以下命令是配置改动后的回归依据，替代“看起来正常”。')
bullets(doc, [
    'cd source/server && npm run test:lint',
    'cd source/server && npm test -- --exit',
    'cd source/server && npx mocha test/api/analysisFocus.test.js test/api/accountsAudit.test.js --timeout 15000',
    'cd source/client && npx tsc --noEmit -p src/tsconfig.app.json',
    'cd source/client && npm run build',
    'python -m unittest discover -s source/tools -p test_scadia_scenes.py',
])
note(doc, '本轮新增的两组测试覆盖：统一分析只暴露八算法、服务端拒绝隐藏目标、账号台账记录 / 权限 / 窗口校验 / 退出上报 / 重启后仍在。npm test 的某些集成模块会留后台句柄，验收请用 -- --exit 明确结束；通过数与 pending 数应分别记录。')

# ============ 第 11 章 ============
h1(doc, '第 11 章  版本升级与 Git 发布')
h2(doc, '11.1 升级顺序')
bullets(doc, [
    '备份现场 project 与当前 commit。',
    '取得新源码，安装兼容依赖，服务端与客户端分别构建。',
    '运行测试，重启服务，回读版本、场景状态、门口版本、历史事件与账号台账。',
    '做业务验收；回滚时用匹配的源码 / 环境与工程快照，不删除新现场数据。',
], numbered=True)
h2(doc, '11.2 发布前检查')
bullets(doc, [
    'git status 与显式文件清单；不要整体加入 project / runtime / models。',
    '逐文件审查代码与手册，检查链接、命令与“已实现 / 待验收”表述。',
    '扫描本地非默认敏感值是否进入候选文件（只输出文件 / 行号，不打印值）。',
    '测试报告保存到本地 _logs，脱敏后再考虑提交。',
    '提交源码、文档、PLAN 与验收记录；推送后核对远端 commit。',
], numbered=True)
figure(doc, '06-reports', '图 11-1  报表页：统计口径与账号活动入口')
figure(doc, '14-home', '图 11-2  首页：升级后首先确认界面与八场景状态')
note(doc, '发布脚本 deploy-scenes.ps1 只重启本仓库的进程并探测 /api/version；它不替代备份、构建和业务验收。推送前请确认远端分支与本地 SHA 一致。')

# ============ 第 12 章 ============
h1(doc, '第 12 章  常见改造场景速查（按目的查）')
para(doc, '本章把“我想改一件事，该动哪里”整理成一张表。改任何配置前，先备份对应文件；改完后必须按“验证方式”一列确认，而不是只看保存成功。')
table(doc, [
    ['我想做的事', '改哪个文件', '关键字段', '验证方式', '风险点'],
    ['新增 / 更换一台相机', 'mjpeg-sources.json', 'sources[].name / rtsp / fps / cameraId', '代理取帧成功，八场景出现新源且更新时间前进', 'RTSP 含凭据，禁止外泄'],
    ['更换可见光检测模型', 'ai-tracker.json', 'model / imgsz / conf / iou', '检测推理耗时正常，轨迹出现', '路径不存在时可能联网下载'],
    ['调整门口进入判定', 'ai-tracker.json（受校验流程）', 'entryGate / 保定点集 / 版本', '外→内 +1，内走与反向不加', '复制示例点集会误判'],
    ['让红外流独立分析', 'ai-tracker-thermal.json', 'streamKind=thermal，独立 cameraId / snapshot', '热源候选独立产生，不影响可见光', '勿复制可见光几何'],
    ['修改平台端口', 'settings.js（uiPort）', 'uiPort', '新端口 /api/version 返回 200', '需同步客户端与防火墙'],
    ['开启安全模式', 'settings.js', 'secureEnabled = true', '未登录 401、普通用户 403', '需先配好授权账号'],
    ['恢复完整菜单', 'default-navigation.ts', 'MENU_FOCUS = \'full\'', '重建前端后菜单出现全部入口', '需重新构建，不是改配置即生效'],
    ['恢复全部分析模块', 'settings.js 或环境变量', 'analysisFocus = \'full\'', '/api/analysis/modules 返回完整表', '重启服务端才生效'],
    ['调整台账保留期', 'settings.js', 'accountActivityRetentionDays', '按天清理后旧行消失，新行仍在', '设为 0 表示不清理'],
    ['配置本地 VLM', 'vlm.json', 'model_dir / device / dtype / maxNewTokens', '事件复核产生终态结论', 'model_dir 必须真实存在'],
    ['接入模型分析服务', '模型服务配置（页面 / 配置服务）', 'baseUrl / model / apiKey', '“测试连接”成功且不回显密钥', '密钥留空保留原值'],
    ['定期备份现场', '整个 project/ 目录', '_appdata/*.db、scene-evidence、scene-events', '副本可打开、图片可读、账号可登录', '运行中只复制单个 db 不安全'],
], widths=[3.0, 3.4, 4.0, 3.2, 2.5])

# ============ 第 13 章 ============
h1(doc, '第 13 章  排错决策树（文字版）')
para(doc, '按“现象 → 先查什么 → 恢复判据”逐层排查。每一步都要看真实返回值，不要凭界面印象判断。')
table(doc, [
    ['现象', '先查什么', '恢复判据'],
    ['1881 打不开', 'launcher 日志 → 端口占用 → 依赖 → settings 语法 → 目录权限', '/api/version 返回 200 且页面可进入'],
    ['界面是新源码配旧 UI', '浏览器缓存 → httpStatic → server/dist 与 client/dist', '返回的 HTML / JS 含本轮入口'],
    ['视频源离线或画面陈旧', '1886 代理 → FFmpeg → 相机网络 / 认证 → updatedAt / frameAt', '可见光与红外各自连续前进'],
    ['事件不入账', 'scene-events 投递队列 → 畸形事件隔离 → DB 权限 → sceneId / kind / source', '合法事件唯一落库，重启不重复'],
    ['历史图片 404', 'scene-evidence 文件与 eventId → 备份完整性 → 查看权限', '原事件图片可读；不得用实时图冒充'],
    ['复核长期 pending', 'VLM 模型加载 → 平台登录 → 任务租约 → worker 超时 → 显存', '对原 eventId 产生终态或明确失败码'],
    ['门口没有进入记录', 'gate.enabled / verified → 版本回读 → 线两侧 → 轨迹稳定性', '真实外→内 +1，内走与反向不加'],
    ['菜单里少了页面', 'MENU_FOCUS 是否为 scenes → client/dist 是否已重建', '目标页面按设定出现 / 隐藏'],
    ['统一分析只有八算法', 'analysisFocus 是否为 scenes', '需要全部模块时改为 full 并重启'],
    ['账号活动没有“退出”', '浏览器是否正常关闭、sendBeacon 是否被拦截', '正常关闭页面后出现 exit 行'],
    ['认证失败（401 / 403）', '登录状态 → 角色与安全模式 → 令牌有效期', '重新登录后恢复；403 属权限结果而非故障'],
], widths=[3.4, 7.0, 5.3])

# ============ 附录 ============
h1(doc, '附录 A  配置字段速查表')
table(doc, [
    ['配置文件', '关键字段'],
    ['settings.js（mysettings.json）', 'uiPort, secureEnabled, secretCode, tokenExpiresIn, analysisFocus, accountActivityRetentionDays, nodeRed*, swaggerEnabled, smtp, retention'],
    ['ai-tracker.json', 'platform, user, cameraId, camera, source.snapshot, model, device, imgsz, conf, iou, classes, targetFps, pushHz, streamKind'],
    ['ai-tracker-thermal.json', '同上 + streamKind=thermal，独立 cameraId / snapshot'],
    ['mjpeg-sources.json', 'sources[].name / rtsp / fps / cameraId'],
    ['video-events.json', 'cameraId, debounceMs, fence.points, fence.highlightMs'],
    ['vlm.json', 'model_dir, device, dtype, maxNewTokens, prompt, periodic'],
    ['model-service.json', 'baseUrl, model, apiKey'],
    ['accounts.scadiap.db', 'account_activity(id, at, username, fullname, action, result, client_ip, user_agent, session_id)'],
], widths=[4.6, 11.1])

h1(doc, '附录 B  脱敏与提交规则')
bullets(doc, [
    '凡是 password、apiKey、secretCode、含账号的 RTSP、完整 token，一律不得进入仓库或公共材料。',
    '手册与文档中的示例必须使用 <占位符>，不得替换为真实值后提交。',
    '日志与测试报告提交前先脱敏，仅保留文件 / 行号定位信息。',
    '账号活动台账属于审计资料：可以导出给授权人员，但不得连同令牌、Cookie 一并传播。',
    'project、runtime、models 目录默认不提交；确需交付时走授权的离线备份渠道。',
], numbered=True)

doc.save(os.path.join(OUT, 'SCADIA_工程配置与修改手册_3.0.0.docx'))
print('OK manual2')
