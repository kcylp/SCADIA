# 新窗口交接（写于 2026-10-06，本轮：发布 GitHub + 缺陷修复）

> **GitHub 仓库（最终交付物）**：https://github.com/kcylp/SCADIA — **门禁 958 passing / 16 pending / 0 failing**
> ⚠️ **HEAD sha 不要写死在这份文件里**：它每提交一次就过期一次（`256fed8` 那次就是这么把 `b46f62f` 写进交接头的）。**以 `git log -1` 为准。** 本文件最后一次校准：`2a9c48a`（密钥卫生 + 交接校正）。
> 发布树（要改代码就改这里再推）：`D:\vibe coding 2026.1.6\__scadia_publish\`
> 源树（可跑门禁，因为**有 node_modules**）：`D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\`
> 进度账（最完整）：`需要检查审核的0930\20_代码进度.md`；仓库内副本 `internal/开发与验收账.md`

---

## 〇、开工前必读：这个仓库的**三条硬事实**

### 1. 🔴 发布树没有 node_modules，门禁必须在源树跑

`__scadia_publish\` **没有** `node_modules`（被 `.gitignore` 正确排除）。所以：
- **跑测试 / 门禁 → 在源树**：`cd 需要检查审核的0930\源代码\server`
- **改完要发布 → 把改动复制到发布树**，再 commit + push

```powershell
# 典型循环
cd "D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\server"
npm run test:gate            # 必须 exit 0
# 然后同步到发布树
cd "D:\vibe coding 2026.1.6"
Copy-Item "需要检查审核的0930\源代码\server\runtime\xxx.js" "__scadia_publish\server\runtime\xxx.js" -Force
cd __scadia_publish; git add -A; git commit -m "..."; git push origin master
```

### 2. 🔴 仓库根 = `D:\vibe coding 2026.1.6\.git`（整个工作区），**不要**在里面 `git add -A`

那个仓库混着**几百条与本产品无关**的未跟踪项（专利 PDF、投标文档、其他项目）。
**产品仓库是 `__scadia_publish\`（它自己 `.git`，remote = `kcylp/SCADIA`）。**

### 3. ⚠️ 发布前必做密钥扫描（已踩过两次）

已经抓到过：
- `app/electron/settings.app.js:76` 的 `secretCode: '<redacted>'`（已占位化）
- 展厅示例 `_appdata/settings.js`、`my_settings.json` 里的 `<redacted>`（已清洗）
- `users.scadiap.db`（含管理员口令散列）**不随仓发布**

**扫描脚本（已搬进产品仓）**：`server/tools/scan-secrets.cjs` —— 随仓发布，**纯 node 标准库，发布树没有 node_modules 也能跑**。

```powershell
cd "D:\vibe coding 2026.1.6\__scadia_publish\server"
npm run test:secrets         # 必须 exit 0 才能推；默认扫本仓根，也可 node tools/scan-secrets.cjs "需要检查审核的0930\源代码"
```

`_probeP\scan-secrets.cjs` 现在只是**转发壳**（唯一实现只有仓里那一份，避免两份漂移）。

- **已串进 `test:gate`**：`test:gate` 的**第一步**就是它（`node tools/scan-secrets.cjs && mocha …`）⇒ **有 block 项时门禁直接失败，mocha 根本不跑**。所以「门禁绿」现在同时意味着「密钥扫描干净」。

- **命中分档**：`block`（GitHub/OpenAI/AWS token、私钥、Bearer、**裸 `SECRET = '...'` 常量**）与 `info`（secretCode/password/apiKey 赋值，多为占位符）。
  **只有 block 决定退出码：有 block ⇒ exit 1，不要发布**；info 只是打印出来要人看一眼。
- **别再犯 256fed8 那次的错**：那次只扫了自己刚写的两份文档，于是漏掉了 `server/test/authorization/heartbeatSecurity.test.js:8` —— 那里硬编码着厂商历史 JWT 签名密钥，**5 个提交里都在，公开历史可见**。改前的规则表没有「裸 SECRET 常量」这一类，所以扫了也报 0。
- **遗留**：该值仍在公开 git 历史里。当前处置是**接受暴露**（生产代码 `api/jwt-helper.js` 用 `utils.generateSecretCode()`，`settings.default.js` 的 `secretCode` 是注释掉的，本仓无使用点）；**改写历史（filter-repo + force-push）需委托方明确授权**，未做。若现场任何实例的持久化 settings 里仍留着该值 ⇒ 轮换。

---

## 一、本轮做完了什么（5 次推送）

| 提交 | 内容 |
|---|---|
| `0cdeca8` | 首次发布：1463 文件 / 19.06 MB，含 **430 行** README（功能 / 使用 / 架构） |
| `7296c96` | 追加：`examples/`（MES/EMS 模板 + 设计、展厅示例工程 8 画面）+ `docs/rulings/` + `internal/` |
| `f0c2116` | 修：脚本沙箱 `console` 桩只定义 `log`（warn/error 抛错被吞→脚本静默停摆）+ 删 `runtime/index.js` 调试残留与**死订阅** |
| **`b46f62f`** | 修：**A-1 权限过滤三处缺陷**（P1「触发即画面损坏」）+ 20 例回归测试 |
| `256fed8` | 补记 90-U 到仓库账；更新新窗口交接；脱敏**文档里**复现的历史密钥串 |
| **`2a9c48a`** | **密钥卫生**：测试里硬编码的厂商历史 JWT 密钥清除 + 扫描器补规则并改为命中即失败；交接/账目的 sha、推送次数、批次、README 行数校正 |
| （本批） | **A-3** 抽公共调度：start/subscribe 管道下沉 `startAndFollowHmi()` + 9 例客户端测试 + 无头双向验证；**C-1** 补 `21_存储平面状态汇总.md` 进仓根 + 架构 README 路径修正 |
| （本批 2） | **缺陷 #1 修完**：启动期不再 500+HTML（`domainErrorBoundary` + cameras 另外 4 条）+ 8 例确定性回归；**C-2 首轮长稳**（15 分钟 / 28,590 请求 / 0 错误）；文档链收口（补 20、06；`交付说明.md` 加"本文描述的是另一个包"说明） |

### 关键修复细节（新窗口别重查）

**console 桩**：`msm.js` 的 `eventsIncludes` 现在定义 `log/warn/error/info/debug` 全套，各按 `console.<level>` 上报 type，日志失败也不影响脚本。测试 `test/runtime/scriptConsoleStub.test.js`（6 例）。

**死订阅**：`runtime/index.js` 里 `updateDevice(event)` 只做 `console.log`，而它订阅的 `project-device:change` **全仓从未被 emit**（唯一命中就是这行订阅）。已删函数+订阅。注意 `runtime.devices.updateDevice` 是**另一条活路径**，未受影响。删除后 `N-46`（生产代码不得留调试）守卫恢复绿。

**A-1 三处**（报告 §4.6 P1）：
1. 隐藏控件用 `indexOf(item.id)` + 固定偏移插 `visibility="hidden"` → id 出现在 `<title>` 或作为更长 id 子串时**属性写进文本**：控件没隐藏、文本被破坏。→ 新增 `utils.domStringSetAttributeOnId()`（按 id **属性**匹配开标签，找不到返回 `null` + warn）
2. 禁用控件把 `indexOf` 偏移交给 `domStringSplitter` 向后找 `foreignObject` → 偏移指错时**禁用错元素的控件**。→ 新增 `utils.domStringForeignObjectOfId()`（以元素自身为锚，闭合到它自己的 `</foreignObject>`）
3. `utils.domStringSetAttribute` **本身破坏标签**：实测 `'<button id="y">'` → `'<bdisabled utton id="y">'`、`'<button>'` → `'<buttondisabled>'`。三个独立缺陷：`indexOf('>')` 与标签名 length 比较、外层循环每轮从原始串重来且末次覆盖、条件赋值丢弃未处理标签。**已重写为单次正则替换。**

> ⚠️ **2026-10-06 历史已改写**（清除历史里的厂商 JWT 密钥串）⇒ **上表是改写后的 sha**，**旧 sha 对照有意不列**（它们仍能从 GitHub 按 SHA 取到，列出来等于给密钥指路）—— 完整对照只在本地账与本地备份里；其余旧引用一律以 `git log` 为准。

**测试**：`test/runtime/permissionSvgInjection.test.js`（20 例）；`test/help/runtimeUtils.test.js` 的旧断言**钉的是属性插入「位置」**（`<button disabled >` 的游离空格），**位置不是契约、禁用才是**，已改为断言行为。

---

## 二、下一窗口的三件待办（含 A-2 的结论）

### ✅ A-2 已核实：**早已存在，无需新增代码**
`test/architecture/enumContractSync.test.js:96-101` 已对 `ProjectDataCmdType` 做**服务端↔客户端成员名与值的双向断言**，带 `min:25` 防解析落空仍变绿；实跑 **16 passing**，且在 `test:gate` 的 glob 内。**别再重做。**

### ✅ A-3 已做完：start/subscribe 管道下沉到共享工厂
- 工厂新增 **`startAndFollowHmi()`**：订阅一次 `onLoadHmi`（可选）后无条件 `start()`；**`stop() 同时取消订阅**。`child` 归属守卫**留在 `scadia-view.ngOnInit` 调用方**。
- 两个入口现在各 **一行**；`initScheduledScripts()`、`subscriptionScheduledScripts` 字段与其 ngOnDestroy 取消订阅已删；`scadia-view.ngAfterViewInit` 里 10 行注释掉的旧调度尝试也删了。
- ⚠️ `onLoadHmi` 必须用**取值函数**传入（`() => this.projectService.onLoadHmi`）：调用点在**字段初始化器**里，立即读会 **TS2729**（`ng test` 抓到的，不是我猜的）。
- **验证口径与结果（别重做）**：同工程同脚本（`s_titlebar_live`，`interval=1` 写 SVG 时钟）——`/home` 与 `/view?name=v_zc_g3` **各每秒恰好 1 次**执行、画面**各走秒**；同一页面里切画面（`/home`→数据展示界面→视频监控画面）**始终保持 1 次/秒，无累加**。探针：`_probeP\a3-route-scheduling.cjs`、`a3-route-scheduling-nav.cjs`。
- ⚠️ **量具教训**：只数"所有 `window.eval`"会得到 2 次/秒（另有一个空串 eval），看着像 P0-3 复发；**必须按脚本自身代码过滤**。

### ✅ C-1 已做完（但拖出两条新的）
- `21_存储平面状态汇总.md` 没丢（在工作区 `开诚智枢 · Kaicheng SCADIA\`，21871 B），**已拷进发布仓根目录** —— README 原文要求 "at the project root"，放 `docs/zh` 反而不对。
- 那个 README 里的 `cd source/server` 也改成 `cd server`（两个树里都对）。
- 🔴 **新发现（未修）**：21 号文的"阅读顺序"还指向 **`20_纸上实现_D3.md`** 与 **`06_未闭环项台账.md`** —— **两者都不在包里**。补不补、进 `internal/` 还是 `docs/`，需委托方定。
- 🔴 **新发现 2（未修）**：`docs/交付说明.md` 整篇是**旧交付包**的说明（`cd source/server`、`cp -r project/_appdata …`）—— 本仓既无 `source/` 也无 `project/`。**指错路**，但内容可能有价值，故未改写：建议整篇重写或移入 `internal/`。

### ⏸ C-2 长稳测试 → **需委托方执行**（报告 Q-19 自述：所有【实测】结论都基于同一次运行实例，无压力/长稳/断线验证）

---

## 三、仍未闭合的既有缺陷（账里已记，勿重复发现）

| # | 缺陷 | 状态 |
|---|---|---|
| 1 | ~~`test/cameras/domainBootRace.test.js` **非稳定绿**~~ | ✅ **已修（90-Z）**：根因是路由把守卫当**实参**调用 ⇒ `service()` 同步 throw 越过 `handle()` 的 `.catch`，Express 无错误中间件 ⇒ **500+HTML**。修法：`api/_domain.js` 新增 `domainErrorBoundary()`，两个域在所有路由后注册；顺带修掉 cameras 另外 4 条启动期 500（`fusion()`/`vendorPresets()` 用了 `CAM_INTERNAL_ERROR`）。**确定性回归**：`test/cameras/domainNotReadyContract.test.js`（撑开窗口 + 遍历 25 条 GET 路由，8 例）。门禁 958→**966** |
| 2 | TDengine 契约 fixture **永远 pending** | 🟡 **根因已修（90-AA）**：fixture 手写 `{host,port,user,passwd}` 没有 scheme/path ⇒ 驱动拼出 `undefined://127.0.0.1:6041undefined` ⇒ node-fetch **Invalid URL**，**与容器无关**。改为从驱动自己的默认 options 起（同适配器）。**仍未闭合**：本机 Docker 守护进程没跑，真引擎起不来 ⇒ 8 条用例仍 pending；闭合靠 `test:backends:up && npm run test:contract` |
| 3 | 通知历史**无限堆积**（`reset()` 只删 7 天前）；`access` 类型通知**无写入点** | P0 明说未做 |
| 4 | **报警邮件从未实测**（无 SMTP；卡 §4 禁改 SMTP 配置） | 未验证 |
| 5 | `scriptsMap` 用 **name** 作键 ⇒ 脚本重名会**互相覆盖调度** | ✅ **已修（90-AA）**：两个 map 改成 **id 优先/name 兜底**（`msm.scriptKey`）；被挤掉的脚本过去不但不被调度，还会因 `getScript()` 找不到而**判成无权限**且无任何日志。新增 `test/runtime/duplicateScriptNames.test.js`（3 例，含真调度器集成）+ 顺带修 `ScriptsManager.start()` 返回**永不 settle 的 Promise** |
| 6 | mes/ems **嵌套对象形态**落成 1 行 `name=null`（契约形状=数组，已验证通过；嵌套属容错路径） | **根因未查明** |
| 7 | 权限过滤 **仍走服务端字符串注入**（A-1 已让它不再损坏画面，但报告建议的「改模型层」未做）；客户端**不读** per-item 权限标记 | 部分修 |

---

## 四、环境与常用路径

| 用途 | 路径 |
|---|---|
| 产品仓库（发布用） | `D:\vibe coding 2026.1.6\__scadia_publish\` |
| 源树（跑门禁） | `D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\` |
| 进度账 | `需要检查审核的0930\20_代码进度.md`（记至批次 90-V） |
| 缺陷清单 | `__scadia_publish\internal\核查与风险报告.md`、`internal\疑难与未解清单.md` |
| 密钥扫描脚本 | `需要检查审核的0930\_probeP\scan-secrets.cjs` |
| Playwright 审计脚本 | `_probeP\ui-audit.cjs`、`board-measure.cjs`、`click-exact.cjs`、`nav-verify2.cjs` |
| 展厅示例工程 | `__scadia_publish\examples\exhibition-project\` |
| MES/EMS 模板 | `__scadia_publish\examples\mes-ems-template\` |

**服务**：1881 端口，`node main.js --port 1881 --userDir "<dir>"`（**不会自动重启**）。
**容器**：`scadia-test-tdengine`/`scadia-test-postgres` 当前**停着** ⇒ 契约用例显示 pending 属正常。

---

## 五、开工命令

```powershell
cd "D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\server"
npm run test:lint            # 应 exit 0
npm run test:gate            # 应 969 passing / 16 pending / 0 failing / exit 0

cd /d "D:\vibe coding 2026.1.6\__scadia_publish"
git log --oneline -3         # 应见本次密钥卫生提交在顶（其后是 256fed8）
git status -sb               # 应与 origin/master 同步

cd /d "D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\client"
npm test                     # 应 28/28 SUCCESS —— 客户端用例**不在** 958 里
npm run build                # AOT 编译，应 exit 0（改过 client 就必须跑这两条）

cd /d "D:\vibe coding 2026.1.6\__scadia_publish\server"
npm run test:secrets         # 发布前必做：应 exit 0（无 node_modules 也能跑）
```

**门禁基线**：服务端 **969 / 16 / 0**（`exit 0`，90-AA 起；966 → 90-Z，958 → 90-Z 之前）；客户端 **28/28**（karma 无头）+ `ng build` exit 0。**两个数分开看**：958 里没有一个客户端用例，改了 `client/` 而只跑服务端门禁等于没验。

`test:gate` 现在**先跑密钥扫描再跑用例**：看到 `✅ 无阻断项` 才轮到 mocha；若先看到 `❌ 阻断项 N 处`，门禁是红的，且**与用例无关 —— 去处理那个字符串，不要去动测试**。
