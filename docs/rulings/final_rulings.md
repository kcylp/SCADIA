# 最终裁决：V-1 / V-2 / P0 / B2 / 容器

**日期**：2026-10-05  
**执行方**：DeepSeek + Kun  
**状态**：已批准，可执行

---

## 一、V-1：脚本 API 真名（必须修正）

**裁决**：用真名，不用假名。

实际 API（runtime/scripts/index.js:237-253）：
```javascript
$getTag(tagId)           // 读 tag
$setTag(tagId, value)    // 写 tag
$getTagId(tagName)       // tag 名称→ID
$setView(viewName)       // 切换画面
$enableDevice(deviceId)  // 启用/禁用设备
$getDevice(deviceId)     // 读设备属性
$getTagDaqSettings(tagId)    // 读 DAQ 设置
$setTagDaqSettings(tagId, settings) // 写 DAQ 设置
$getHistoricalTags(tagIds, from, to) // 读历史
$sendMessage(url)        // HTTP GET
$getAlarms()             // 读当前报警
$getAlarmsHistory()      // 读报警历史
$ackAlarm(alarmId)       // 确认报警
```

**P1 模板中的 3 个脚本必须重写**：
- `$getTagValue` → `$getTag`
- `$setTagValue` → `$setTag`
- `$daqWrite` → **删除**（不存在此函数；DAQ 落库是驱动自动行为，由每个 tag 的 `daq.enabled` 字段控制）

**为什么必须改**：
- 调用不存在的函数名会抛 ReferenceError
- 错误被 try/catch 吞掉（runtime/scripts/msm.js:113），只写 logger.error
- 脚本静默算出错的结果，无人报警
- 这不是"响亮的坏"，是"安静的错"

**错误处理约束**：
```javascript
// 正确写法：防御 null
const planned = $getTag('mes.wo.planned') || 0;
// 错误写法：不会抛错，但会静默失败
const planned = $getTagValue('mes.wo.planned');
```

---

## 二、V-2：访客可见性

**裁决**：接受。MES/EMS 模板数据对访客可见。

理由：
1. 现有 recipes 域对访客也开放（同等级别）
2. MES/EMS 模板是演示数据，不含敏感信息
3. 真实 MES/EMS 对接时，按规矩先出契约再审批
4. 与"只加分支、不动权限过滤器"的 B2 路线一致

**不需要改**：权限过滤器、apiGuestSurface、ProjectDataCmdType

---

## 三、P0 通知系统：走 A 路线

**裁决**：A（修复存储层，不新建表）

A 路线内容：
1. 取消 `notifystorage.js` 的 require 注释（index.js:8）
2. 恢复 `_init()` 中的 notifystorage.init() 调用（index.js:130-141）
3. 恢复 `_loadNotifications()` 中的 notifystorage 调用（index.js:207-236）
4. 恢复 `clearNotifications()` 中的 notifystorage 调用（index.js:68-77）

**为什么走 A**：
- notifications 表已存在于 prjstorage.js:82（CREATE TABLE if not exists notifications）
- 存储层代码 `notifystorage.js` 已存在（只是被注释掉）
- 不需要新建表、不需要新建文件
- 风险最小、改动最小

**不需要做**：
- 新建 notifications-storage.js（已有）
- 新建表（已有）
- 改前端代码（已有）

---

## 四、B2 路线：批准执行

**裁决**：B2 是正确方案。立即进入代码执行。

### 4.1 为什么 B2

- B1 不可接受：alarms 表存报警定义、recipes 表存配方，语义固定
- B3 不可接受：纯脚本退化为"改脚本"，不是"可组态"
- B2 是唯一符合"工程内可组态"的方案

### 4.2 B2 合法性确认

**不违反"不新建后端域"边界**，因为：
1. 新增的是**工程数据表**（mesOrders, emsMeters），不是**后端域**
2. 后端域 = server/api/ 下的新目录 + 新路由
3. 工程数据表 = prjstorage.js TableType 枚举 + SQLite 表
4. 先例：notifications 表就是这么加的（prjstorage.js:82）

**不触碰任何守卫**：
- apiGuestSurface：管的是 server/api/ 目录，工程表不在其内
- enumContractSync：管的是 ProjectDataCmdType 枚举，B2 不新增枚举成员
- domainDatabaseFiles：管的是域 ↔ 库文件一一对应，工程表不是域
- dependencyDirection：B2 不新增 import 依赖

### 4.3 精确改动清单

#### 改动 1：prjstorage.js 加两张表

**文件**：`server/runtime/project/prjstorage.js`

**位置 1**：TableType 枚举（约第 244 行）

**修前**：
```javascript
const TableType = {
    GENERAL: 'general',
    DEVICES: 'devices',
    DEVICESSECURITY: 'devicesSecurity',
    TEXTS: 'texts',
    ALARMS: 'alarms',
    RECIPES: 'recipes',
    NOTIFICATIONS: 'notifications',
    SCRIPTS: 'scripts',
    REPORTS: 'reports',
    LOCATIONS: 'locations',
    ARMARKERS: 'arMarkers'
};
```

**修后**：
```javascript
const TableType = {
    GENERAL: 'general',
    DEVICES: 'devices',
    DEVICESSECURITY: 'devicesSecurity',
    TEXTS: 'texts',
    ALARMS: 'alarms',
    RECIPES: 'recipes',
    NOTIFICATIONS: 'notifications',
    SCRIPTS: 'scripts',
    REPORTS: 'reports',
    LOCATIONS: 'locations',
    ARMARKERS: 'arMarkers',
    MESORDERS: 'mesOrders',      // B2: MES 工单表
    EMSMETERS: 'emsMeters'        // B2: EMS 计量点表
};
```

---

**位置 2**：_bind() 建表语句（约第 75-86 行）

**修前**：
```javascript
var sql = "CREATE TABLE if not exists general (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists views (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists devices (name TEXT PRIMARY KEY, value TEXT, connection TEXT, cntid TEXT, cntpwd TEXT);";
sql += "CREATE TABLE if not exists devicesSecurity (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists texts (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists alarms (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists recipes (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists notifications (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists scripts (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists reports (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists locations (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists arMarkers (name TEXT PRIMARY KEY, value TEXT);";
```

**修后**：
```javascript
var sql = "CREATE TABLE if not exists general (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists views (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists devices (name TEXT PRIMARY KEY, value TEXT, connection TEXT, cntid TEXT, cntpwd TEXT);";
sql += "CREATE TABLE if not exists devicesSecurity (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists texts (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists alarms (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists recipes (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists notifications (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists scripts (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists reports (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists locations (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists arMarkers (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists mesOrders (name TEXT PRIMARY KEY, value TEXT);";      // B2
sql += "CREATE TABLE if not exists emsMeters (name TEXT PRIMARY KEY, value TEXT);";        // B2
```

---

**位置 3**：clearAll() 追加 DELETE（约第 216-239 行）

**修前**：
```javascript
function clearAll() {
    return new Promise(function (resolve, reject) {
        var tables = ['general', 'views', 'devices', 'devicesSecurity', 'texts', 'alarms', 'recipes', 'notifications', 'scripts', 'reports', 'locations', 'arMarkers'];
        // ... 逐条 DELETE
    });
}
```

**修后**：
```javascript
function clearAll() {
    return new Promise(function (resolve, reject) {
        var tables = ['general', 'views', 'devices', 'devicesSecurity', 'texts', 'alarms', 'recipes', 'notifications', 'scripts', 'reports', 'locations', 'arMarkers', 'mesOrders', 'emsMeters']; // B2
        // ... 逐条 DELETE
    });
}
```

---

#### 改动 2：project/index.js 读路径装配

**文件**：`server/runtime/project/index.js`

**位置**：load() 函数（约第 161-169 行）

**修前**：
```javascript
// 第 8 步：加载 notifications
prjstorage.getSection(prjstorage.TableType.NOTIFICATIONS).then(notifications => {
    data.notifications = notifications;
    callback();
});
```

**修后**（在第 8 步后追加两步）：
```javascript
// 第 8 步：加载 notifications
prjstorage.getSection(prjstorage.TableType.NOTIFICATIONS).then(notifications => {
    data.notifications = notifications;
    // 第 9 步：加载 MES 工单
    prjstorage.getSection(prjstorage.TableType.MESORDERS).then(mesOrders => {
        data.mesOrders = mesOrders;
        // 第 10 步：加载 EMS 计量点
        prjstorage.getSection(prjstorage.TableType.EMSMETERS).then(emsMeters => {
            data.emsMeters = emsMeters;
            callback();
        }).catch(function (err) {
            logger.error(`project.prjstorage-failed-to-load! '${prjstorage.TableType.EMSMETERS}' ${err}`);
            callback(err);
        });
    }).catch(function (err) {
        logger.error(`project.prjstorage-failed-to-load! '${prjstorage.TableType.MESORDERS}' ${err}`);
        callback(err);
    });
});
```

---

**位置**：setProject() 函数（约第 807-809 行）

**修前**：
```javascript
} else if (key === 'server') {
    // server
    scs.push({ table: prjstorage.TableType.DEVICES, name: key, value: prjcontent[key] });
```

**修后**（追加 mesOrders/emsMeters 分支）：
```javascript
} else if (key === 'server') {
    // server
    scs.push({ table: prjstorage.TableType.DEVICES, name: key, value: prjcontent[key] });
} else if (key === 'mesOrders') {
    // B2: MES 工单
    Object.values(prjcontent[key]).forEach((order) => {
        scs.push({ table: prjstorage.TableType.MESORDERS, name: order.id, value: order });
    });
} else if (key === 'emsMeters') {
    // B2: EMS 计量点
    Object.values(prjcontent[key]).forEach((meter) => {
        scs.push({ table: prjstorage.TableType.EMSMETERS, name: meter.id, value: meter });
    });
```

---

#### 改动 3：setProjectData() 加分支（可选，建议加）

**文件**：`server/runtime/project/index.js`

**位置**：setProjectData() 函数（约第 309 行之后）

**追加**：
```javascript
} else if (cmd === ProjectDataCmdType.SetMesOrder) {
    section.table = prjstorage.TableType.MESORDERS;
    section.name = value.id;
    setMesOrder(value);
} else if (cmd === ProjectDataCmdType.DelMesOrder) {
    section.table = prjstorage.TableType.MESORDERS;
    section.name = value.id;
    toremove = removeMesOrder(value);
} else if (cmd === ProjectDataCmdType.SetEmsMeter) {
    section.table = prjstorage.TableType.EMSMETERS;
    section.name = value.id;
    setEmsMeter(value);
} else if (cmd === ProjectDataCmdType.DelEmsMeter) {
    section.table = prjstorage.TableType.EMSMETERS;
    section.name = value.id;
    toremove = removeEmsMeter(value);
```

**注意**：如果设计代理判断"不新增 ProjectDataCmdType"，则跳过此项。B2 最小可行路径不需要它（setProject 已覆盖工程导入场景）。

---

### 4.4 验证清单

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 表创建成功 | 导入含 mesOrders/emsMeters 的工程 | 无 SQL 错误 |
| 数据持久化 | 创建 MES/EMS 数据 → 重启 → 读取 | 数据仍在 |
| clearAll() 清干净 | 导入工程 → clearAll() → 检查 DB | mesOrders/emsMeters 表空 |
| setProject() 导入 | POST /api/project 含 mesOrders/emsMeters | 无错误，数据入库 |
| GET /api/project 导出 | GET /api/project | mesOrders/emsMeters 在 JSON 中 |
| 门禁 | npm test | 无新失败 |
| lint | npx eslint server/runtime/project/ | exit 0 |

---

## 五、资源 ID 前缀修正

**裁决**：改报表和配方，设备先不动。

| 类型 | 当前前缀 | 正确前缀 | 动作 |
|------|----------|----------|------|
| 报表 | rpt_ | r_ | 改（12 个） |
| 配方 | rcp_ | r_ | 改（12 个） |
| 设备 | dev- | d_ | 不动（先例：demo 工程也是 dev-，改动面太大） |

**改的范围**：
- P1 模板中的报表 ID（rpt_daily_production → r_daily_production）
- P1 模板中的配方 ID（rcp_product_a → r_product_a）
- 客户端引用这些 ID 的地方同步改

---

## 六、配方实例验收项

**裁决**：(b) 手册第五步补可复现报文示例。

**不做什么**：
- 不改工程文件结构（配方实例不在 .scadiap 内）
- 不改 API（POST /api/recipes/instances 已存在）

**做什么**：
- 在 MES-EMS-开发手册.md 的"第五步：配方下发"中，添加：
  ```
  示例报文：
  POST /api/recipes/instances
  {
    "typeId": "r_product_a",
    "name": "2026-10-05 批次",
    "parameters": {
      "temperature": 125,
      "pressure": 0.85,
      "cycleTime": 115
    }
  }
  ```
- 说明：配方实例通过 REST API 管理，不在工程文件内

---

## 七、测试容器

**裁决**：现在停。

```bash
npm run test:backends:down
```

P3 已完成（TDengine 修复 + 同族核对 + 守卫）。90-B 已结。审计已复跑完。

---

## 八、删除旧文件

**裁决**：删除 __route_b_design.md

内容已拆进 __mes_ems_design/ 的 4 个文件。旧文件保留会造成混淆。

```powershell
Remove-Item D:\vibe coding 2026.1.6\__route_b_design.md
```

---

## 九、P1 .scadiap 脚本必须重写

**当前状态**：P1 模板中的 3 个脚本使用了错误 API（$getTagValue/$setTagValue/$daqWrite）

**必须做**：在交付前重写为正确 API

**正确版本示例**：
```javascript
// OEE 计算脚本（正确版本）
const planned = $getTag('mes.wo.planned') || 0;
const completed = $getTag('mes.wo.completed') || 0;
const defect = $getTag('mes.defect.count') || 0;
const inspected = $getTag('mes.defect.inspected') || 0;

const availability = planned > 0 ? Math.min(1, completed / planned) : 0;
const cycleTime = 120;
const shiftStart = Date.now() / 1000 - 3600; // 演示用：1小时前
const actualRate = completed > 0 ? (Date.now() / 1000 - shiftStart) / completed : 0;
const performance = Math.min(1, cycleTime / Math.max(cycleTime, actualRate));
const defectRate = inspected > 0 ? defect / inspected : 0;
const quality = Math.max(0, 1 - defectRate);
const oee = availability * performance * quality;

$setTag('mes.oee.availability', availability.toFixed(4));
$setTag('mes.oee.performance', performance.toFixed(4));
$setTag('mes.oee.quality', quality.toFixed(4));
$setTag('mes.oee.score', oee.toFixed(4));
```

**DAO 落库说明**：
- DAQ 历史存储由 tag 自身的 `daq.enabled` 字段控制
- 在 devices 定义中开启 tag 的 daq 即可：
  ```json
  "mes.oee.score": {
    "id": "mes.oee.score",
    "name": "OEE",
    "type": "Float",
    "daq": { "enabled": true }
  }
  ```
- 不需要在脚本中调用 $daqWrite

---

## 十、执行顺序（最终版）

```
现在立即执行：
1. 停止测试容器（npm run test:backends:down）
2. 删除 __route_b_design.md

P0 通知系统修复（2-3 天）：
- 取消 notifystorage require 注释
- 恢复 _init()/_loadNotifications()/clearNotifications()
- 验证通知能持久化、能发邮件

P3 TDengine 修复（已完成）：
- 验证通过，无需再动

B2 代码执行（1-2 周）：
- prjstorage.js 加 2 个 TableType + 建表语句 + clearAll()
- project/index.js 读路径装配 + setProject() 分支
- 创建 __mes_ems_design/ 下的 4 个设计文件
- 生成 P1 模板（.scadiap + 手册），脚本用正确 API

P2 启用向导（3-5 天，在 B2 完成后）：
- capabilities-wizard 组件
- 引导用户启用 5 个默认关闭的功能

P1 模板重写（在 B2 完成后）：
- 用正确 API 重写 3 个脚本
- 修正资源 ID 前缀（rpt_ → r_，rcp_ → r_）
- 配方实例验收项改为 (b) 方案
```

---

## 十一、给 DeepSeek 的精确指令

```
你是 SCADIA 平台的代码生成代理。现在执行以下任务，严格按步骤来，不要多做也不要少做。

任务 1：P0 通知系统修复
文件：server/runtime/notificator/index.js
改动：
  1. 第 8 行：取消注释 // const notifystorage = require('./notifystorage');
  2. 第 130-141 行：恢复 _init() 中的 notifystorage.init() 调用
  3. 第 207-236 行：恢复 _loadNotifications() 中的 notifystorage 调用
  4. 第 68-77 行：恢复 clearNotifications() 中的 notifystorage 调用
验证：重启服务 → 创建通知 → 重启 → 通知仍在

任务 2：B2 工程数据表
文件 1：server/runtime/project/prjstorage.js
  1. TableType 枚举加 MESORDERS/EMSMETERS
  2. _bind() 建表语句加两条 CREATE TABLE
  3. clearAll() 的 tables 数组加 'mesOrders', 'emsMeters'

文件 2：server/runtime/project/index.js
  1. load() 函数在第 8 步后追加第 9 步（mesOrders）和第 10 步（emsMeters）
  2. setProject() 函数追加 mesOrders/emsMeters 分支

验证：
  1. npm test → 无新失败
  2. 导入含 mesOrders/emsMeters 的工程 → 无 SQL 错误
  3. GET /api/project → 包含 mesOrders/emsMeters

任务 3：P1 模板脚本重写
文件：__mes_ems_template/mes-ems-template.scadiap
改动：
  1. s_oee_calc 脚本：$getTagValue → $getTag，$setTagValue → $setTag，删除 $daqWrite
  2. s_energy_agg 脚本：同上
  3. s_shift_report 脚本：同上
  4. 在 devices 定义中开启 tag 的 daq.enabled = true（需要 DAQ 的 tag）

约束：
- 不修改任何现有 SCADIA 源码文件（除了任务 1 和 2 指定的文件）
- 不新建 API 路由
- 不新建 ProjectDataCmdType
- DAQ 靠 tag.daq.enabled 控制，不在脚本中调用 $daqWrite

完成后：
1. 运行 npm test，记录输出
2. 运行 npx eslint，记录输出
3. 更新 20_代码进度.md
```

---

*本文件为最终版本，所有裁决已确定，执行方按顺序一次性完成。*
