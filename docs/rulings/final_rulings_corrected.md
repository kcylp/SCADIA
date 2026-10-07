# 最终裁决修正版：P0 / B2 / V-1 / V-2 / 容器

**日期**：2026-10-05  
**执行方**：DeepSeek + Kun  
**状态**：已批准，可执行  
**前置**：本文件替代 __final_rulings.md 中已被证明错误的指令

---

## 一、P0 通知系统：撤回任务卡字面指令，按实测验收

**撤销**：`__task_p0_notifications.md` 中的 4 条"取消注释/恢复调用"指令。

**原因**：
- `notifystorage.js` 在 D5 已被删除（known-debt.js:57-58）
- P0 代理已新建 `notifications-storage.js`（注意带 's'，5,668 B，照 alarmstorage.js 模子）
- index.js:8 已被改为 `require('./notifications-storage')`
- 按旧指令执行 = require 不存在的模块 = 服务启动即崩

**正确验收方式**：
```
重启服务 → 在 /notifications 创建一条通知 → 重启服务 → 通知仍在
```
能通过这条 = P0 完成。不需要再改 notificator/index.js。

---

## 二、B2 数据表：接受设计稿命名，不加 ProjectDataCmdType

**裁决**：
- 表名用设计稿的 `mes` / `ems`（不是 mesOrders/emsMeters）
- **不新增** ProjectDataCmdType 成员

**原因**：
- `mes` / `ems` 更简洁，与现有 `devices`/`alarms`/`recipes` 命名风格一致
- 不加 cmd 枚举 = 保存走整工程 POST /api/project（会重启），这是可接受的代价
- 界面必须拆成两个动作：「保存到工程」（低频，POST /api/project）与「下发到实时点」（高频，$setTag）

**精确改动**：

#### prjstorage.js

**位置 1**：TableType（约第 244 行）
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
    MES: 'mes',        // B2
    EMS: 'ems'          // B2
};
```

**位置 2**：_bind() 建表（约第 75-86 行）
```javascript
sql += "CREATE TABLE if not exists notifications (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists scripts (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists reports (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists locations (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists arMarkers (name TEXT PRIMARY KEY, value TEXT);";
sql += "CREATE TABLE if not exists mes (name TEXT PRIMARY KEY, value TEXT);";      // B2
sql += "CREATE TABLE if not exists ems (name TEXT PRIMARY KEY, value TEXT);";      // B2
```

**位置 3**：clearAll()（约第 216-239 行）
```javascript
var tables = ['general', 'views', 'devices', 'devicesSecurity', 'texts', 'alarms',
    'recipes', 'notifications', 'scripts', 'reports', 'locations', 'arMarkers',
    'mes', 'ems']; // B2
```

---

#### project/index.js

**位置 1**：load()（约第 161-169 行，第 8 步后追加）
```javascript
// 第 8 步：加载 notifications
prjstorage.getSection(prjstorage.TableType.NOTIFICATIONS).then(notifications => {
    data.notifications = notifications;
    // 第 9 步：加载 mes
    prjstorage.getSection(prjstorage.TableType.MES).then(mes => {
        data.mes = mes;
        // 第 10 步：加载 ems
        prjstorage.getSection(prjstorage.TableType.EMS).then(ems => {
            data.ems = ems;
            callback();
        }).catch(function (err) {
            logger.error(`project.prjstorage-failed-to-load! '${prjstorage.TableType.EMS}' ${err}`);
            callback(err);
        });
    }).catch(function (err) {
        logger.error(`project.prjstorage-failed-to-load! '${prjstorage.TableType.MES}' ${err}`);
        callback(err);
    });
});
```

**位置 2**：setProject()（约第 807-809 行，server 分支后追加）
```javascript
} else if (key === 'server') {
    scs.push({ table: prjstorage.TableType.DEVICES, name: key, value: prjcontent[key] });
} else if (key === 'mes') {
    Object.values(prjcontent[key]).forEach((item) => {
        scs.push({ table: prjstorage.TableType.MES, name: item.id, value: item });
    });
} else if (key === 'ems') {
    Object.values(prjcontent[key]).forEach((item) => {
        scs.push({ table: prjstorage.TableType.EMS, name: item.id, value: item });
    });
```

---

## 三、V-1：脚本 API 真名（必须修正）

**实际 API**（runtime/scripts/index.js:237-253）：
```javascript
$getTag(id)           // 读 tag
$setTag(id, value)    // 写 tag
$getTagId(name)       // tag 名称→ID
$setView(name)       // 切换画面
$enableDevice(id)    // 启用/禁用设备
$getDevice(id)       // 读设备属性
$getTagDaqSettings(id)    // 读 DAQ 设置
$setTagDaqSettings(id, settings) // 写 DAQ 设置
$getHistoricalTags(ids, from, to) // 读历史
$sendMessage(url)     // HTTP GET
$getAlarms()          // 读当前报警
$getAlarmsHistory()   // 读报警历史
$ackAlarm(id)         // 确认报警
```

**P1 模板脚本必须改**：
- `$getTagValue` → `$getTag`
- `$setTagValue` → `$setTag`
- `$daqWrite` → **删除**（不存在）
- `$getShiftStart` → **删除**（不存在）
- `$log` → **删除**（不存在）

**DAO 落库**：在 devices 定义中开启 tag 的 `daq.enabled = true`，不在脚本中调用 DAQ 函数。

**⚠️ 关键验证要求**：脚本重写后必须**实测跑一次看输出值**，不能只做语法检查。
- 调用不存在函数抛 ReferenceError
- 错误被 try/catch 吞掉（runtime/scripts/msm.js:113）
- catch 只调被替换成桩的 console.log（msm.js:14）
- **结果：脚本静默算出错数，无人报警**

---

## 四、V-2：访客可见性

**裁决**：接受。MES/EMS 数据对访客可见。

与 recipes 同级，模板数据不含敏感信息。

---

## 五、资源 ID 前缀

**裁决**：改报表和配方。

| 类型 | 当前 | 改为 |
|------|------|------|
| 报表 | rpt_ | r_ |
| 配方 | rcp_ | r_ |
| 设备 | dev- | d_（不动） |

---

## 六、配方实例验收

**裁决**：(b) 手册第五步补可复现报文示例。

```json
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

---

## 七、测试容器

**裁决**：现在停。

```bash
npm run test:backends:down
```

P3 已完成，90-B 已结。

---

## 八、V-6 reverse-baseline.js

**必须先检查**：在修改 project/index.js 之前，确认 reverse-baseline.js 的内容。

如果它引用了 project/index.js 的具体行号或结构，修改后需要同步更新。

**操作**：让 DeepSeek 在读 project/index.js 之前，先读 reverse-baseline.js。

---

## 九、执行顺序（最终版，修正后）

```
立即执行：
1. 停止测试容器（npm run test:backends:down）
2. 删除 __route_b_design.md

P0 通知（不干预，等 P0 代理交付）：
- 验收标准：重启 → 建通知 → 重启 → 通知还在
- 不按字面执行任务卡

B2 工程数据表（1-2 周）：
- prjstorage.js 加 TableType.MES/EMS + 建表语句 + clearAll()
- project/index.js 读路径装配 + setProject() 分支
- 先读 reverse-baseline.js，确认不冲突
- 创建 __mes_ems_design/ 下的设计文件

P1 模板（B2 完成后）：
- 用正确 API 重写 3 个脚本（$getTag/$setTag）
- 实测脚本输出值（不能只查语法）
- 修正资源 ID 前缀（rpt_→r_，rcp_→r_）
- 配方实例验收项改为 (b)

P2 启用向导（P1 完成后，3-5 天）：
- capabilities-wizard 组件
```

---

## 十、给 DeepSeek 的最终指令

```
你是 SCADIA 平台的代码生成代理。按以下顺序执行，每步完成后验证再进入下一步。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
任务 1：停止测试容器 + 清理旧文件
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 运行：npm run test:backends:down
2. 删除：Remove-Item "D:\vibe coding 2026.1.6\__route_b_design.md"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
任务 2：检查 V-6 reverse-baseline.js（必须先做）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
文件：server/test/architecture/_support/reverse-baseline.js
目的：确认它是否引用了 project/index.js 的具体行号或结构
如果引用：记录引用位置，在修改 project/index.js 后同步更新
如果不引用：记录"无引用"，继续任务 3

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
任务 3：B2 工程数据表
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
文件 1：server/runtime/project/prjstorage.js

改动 A：TableType 枚举（约第 244 行）
  在 ARMARKERS 后追加：
    MES: 'mes',
    EMS: 'ems'

改动 B：_bind() 建表语句（约第 75-86 行）
  在 arMarkers 后追加：
    sql += "CREATE TABLE if not exists mes (name TEXT PRIMARY KEY, value TEXT);";
    sql += "CREATE TABLE if not exists ems (name TEXT PRIMARY KEY, value TEXT);";

改动 C：clearAll()（约第 216-239 行）
  在 tables 数组末尾追加：'mes', 'ems'

---

文件 2：server/runtime/project/index.js

改动 D：load() 函数（约第 161-169 行）
  在第 8 步（notifications）的 callback() 之前，追加嵌套的 mes → ems 加载：
    prjstorage.getSection(prjstorage.TableType.MES).then(mes => {
        data.mes = mes;
        prjstorage.getSection(prjstorage.TableType.EMS).then(ems => {
            data.ems = ems;
            callback();
        }).catch(...)
    }).catch(...)

改动 E：setProject() 函数（约第 807-809 行）
  在 server 分支后追加：
    } else if (key === 'mes') {
        Object.values(prjcontent[key]).forEach((item) => {
            scs.push({ table: prjstorage.TableType.MES, name: item.id, value: item });
        });
    } else if (key === 'ems') {
        Object.values(prjcontent[key]).forEach((item) => {
            scs.push({ table: prjstorage.TableType.EMS, name: item.id, value: item });
        });
    }

验证：
  1. npm test → 无新失败
  2. 导入含 mes/ems 的工程 → 无 SQL 错误
  3. GET /api/project → 包含 mes/ems

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
任务 4：P1 模板脚本重写（B2 完成后）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
文件：__mes_ems_template/mes-ems-template.scadiap

改动：
  1. s_oee_calc：$getTagValue→$getTag, $setTagValue→$setTag, 删除 $daqWrite/$getShiftStart/$log
  2. s_energy_agg：同上
  3. s_shift_report：同上
  4. 在 devices 中开启需要 DAQ 的 tag 的 daq.enabled = true

⚠️ 必须实测脚本输出值：
  1. 将修改后的脚本导入工程
  2. 手动运行脚本
  3. 检查输出的 tag 值是否合理（不是 null、不是 NaN、不是 0）
  4. 如果输出错误，检查是否调用了不存在的 API

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
任务 5：修正资源 ID 前缀
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
在 __mes_ems_template/mes-ems-template.scadiap 中：
  - 报表 ID：rpt_* → r_*
  - 配方 ID：rcp_* → r_*
  - 设备 ID：不动

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
任务 6：手册配方实例验收项改为 (b)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
文件：__mes_ems_template/MES-EMS-开发手册.md
在"第五步：配方下发"中追加：
  "配方实例通过 REST API 管理，不在工程文件内。示例报文：
   POST /api/recipes/instances
   {
     'typeId': 'r_product_a',
     'name': '2026-10-05 批次',
     'parameters': { 'temperature': 125, 'pressure': 0.85, 'cycleTime': 115 }
   }"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
完成后
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 运行 npm test，记录输出
2. 运行 npx eslint，记录输出
3. 更新 20_代码进度.md
4. 通知用户验收
```

---

*本文件为最终版本，已修正所有已知错误。执行方按任务 1→6 顺序执行，每步验证后再进入下一步。*
