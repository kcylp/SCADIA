# prjstorage.js / project-index.js 改动清单
## B2（已批准）—— 逐处「修前 / 修后」代码

**版本**：2.0 ｜ **日期**：2026-10-05 ｜ **性质**：只读设计，**本文件不含任何已落地的源码改动**
**证据约定**：`file:line` 相对 `D:\vibe coding 2026.1.6\需要检查审核的0930\源代码\`，行号为**本次实际读取**的当前值。

---

## 0. 精确边界自检表（先对边界，再看代码）

### 能动（4 处，全部是本文件要给的）

| # | 允许动 | 落点 | 本文件章节 |
|---|---|---|---|
| A | `TableType` 枚举加 `MES`、`EMS` | `prjstorage.js:244-257` | §2 |
| B | `_bind()` 加 `CREATE TABLE if not exists mes` / `ems` | `prjstorage.js:75-86` | §3 |
| C | `setProject()` 加 `key === 'mes'` / `key === 'ems'`（参照 `recipes`） | `project/index.js:826-833` 之后 | §5 |
| D | `setProjectData()` 加 `SetMes`/`SetEms`/`DelMes`/`DelEms`（参照 `SetRecipe`/`DelRecipe`） | `project/index.js:261-268` 之后 | §6 |

### 不能动（逐条给出「本设计如何保证没动」）

| 禁止 | 本设计的保证 | 证据 |
|---|---|---|
| **现有 `TableType` 枚举项顺序** | 新成员**追加在 `ARMARKERS` 之后**，前 12 行的文本、顺序、逗号一律不碰 | 修前/修后逐字对照见 §2 |
| **`_bind()` 里现有表的 `CREATE TABLE`** | 新语句**追加**在 `:86` 之后；`:75-86` 十二行逐字不变 | §3 |
| **`setProject()` 里现有分支的代码** | 新 `else if` **插在 `reports` 分支之后、`else` 兜底之前**；`:780-874` 的既有分支一行不动 | §5 |
| `domainDatabaseFiles.test.js` 断言 | 不新建 `*storage.js`、不改库文件名、新 SQL 不含 `.db` | §11.1 |
| `dependencyDirection.test.js` 断言 | 不新增 `require('sqlite3')`、不新增任何 require | §11.2 |

> **如果改动让这两道门禁变红，说明设计错了，不是测试错了。** §11 给出的是「为什么不会红」的机制论证，不是「跑一下试试」。**本设计未跑测试**（只读轮次），所以 §11 同时标注了「哪些守卫我读了 / 哪些没读」。

---

## 1. 涉及文件与改动规模

| 文件 | 处数 | 增行 | 删行 | 改写现有行 |
|---|---|---|---|---|
| `server/runtime/project/prjstorage.js` | 3 | +6 | 0 | **0** |
| `server/runtime/project/index.js` | 6 | +96 | 0 | **1**（`:169` 的 `}` 补逗号） |
| `client/src/app/_models/project.ts` | 2 | +12 | 0 | 0 |
| `client/src/app/_models/mesems.ts`（新文件） | — | +40 | 0 | 0 |

**合计 6 处插入 + 1 处标点，约 +154 行，无一行删除、无一行逻辑改写。**

---

## 2. `prjstorage.js` · 改动 A —— `TableType` 加两个成员

**位置**：`server/runtime/project/prjstorage.js:244-257`

### 修前（`:241-257`，逐字，注意第 256 行 `ARMARKERS` 后**没有逗号**）

```js
/**
 * Database Table
 */
const TableType = {
    GENERAL: 'general',
    DEVICES: 'devices',
    VIEWS: 'views',
    DEVICESSECURITY: 'devicesSecurity',
    TEXTS: 'texts',
    ALARMS: 'alarms',
    RECIPES: 'recipes',
    NOTIFICATIONS: 'notifications',
    SCRIPTS: 'scripts',
    REPORTS: 'reports',
    LOCATIONS: 'locations',
    ARMARKERS: 'arMarkers',
}
```

### 修后

```js
/**
 * Database Table
 */
const TableType = {
    GENERAL: 'general',
    DEVICES: 'devices',
    VIEWS: 'views',
    DEVICESSECURITY: 'devicesSecurity',
    TEXTS: 'texts',
    ALARMS: 'alarms',
    RECIPES: 'recipes',
    NOTIFICATIONS: 'notifications',
    SCRIPTS: 'scripts',
    REPORTS: 'reports',
    LOCATIONS: 'locations',
    ARMARKERS: 'arMarkers',
    MES: 'mes',
    EMS: 'ems',
}
```

### 为什么顺序无关（对「`_ensureValidTable` 依赖它」这条的回应）

`_ensureValidTable()` 的实现是（`prjstorage.js:40-46`）：

```js
function _ensureValidTable(table) {
    const tables = Object.values(TableType);
    if (!tables.includes(table)) {
        throw new Error(\`invalid table '\${table}'\`);
    }
    return table;
}
```

它用的是 **`Object.values(...).includes(...)`——成员判定，与顺序无关**，而且**每次调用现算**（不是模块加载时冻结的常量）。

> 委托方担心的「`_ensureValidTable` 依赖枚举项顺序」——**实测它不依赖顺序**。真正会被顺序影响的是任何按索引取值的地方（如 `Object.values(TableType)[3]`）——**全树 grep `TableType` 共 84 命中（排除 node_modules/dist），逐条看过，没有任何一处按下标取 `TableType`**（清单见 §11.4）。即便如此，**本设计仍把新成员追加在末尾**，把这个顾虑从「实测无关」升级为「结构上也不可能相关」。

---

## 3. `prjstorage.js` · 改动 B —— `_bind()` 加两条建表语句

**位置**：`server/runtime/project/prjstorage.js:75-86`，在 `:86` 之后**追加**两行

### 修前（`:74-87`，逐字）

```js
        // prepare query
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
        db_prj.exec(sql, function (err) {
```

### 修后（`:75-86` **十二行逐字不变**，只在 `:86` 后插入两行）

```js
        // prepare query
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
        sql += "CREATE TABLE if not exists mes (name TEXT PRIMARY KEY, value TEXT);";
        sql += "CREATE TABLE if not exists ems (name TEXT PRIMARY KEY, value TEXT);";
        db_prj.exec(sql, function (err) {
```

### 表结构与 `data-model.md` 的对应

```
name  ← data-model.md 各模型的 id 字段（WO-20261004-01 / op-cnc / shift-a / MTR-01 / tariff-2026 / cf-elec）
value ← 该模型全部字段的 JSON（setSections 里 JSON.stringify，prjstorage.js:125；读出时 JSON.parse，project/index.js:992）
```

**为什么不做成一列一字段的关系表**：`prjstorage.js` 是**唯一**开工程库的地方（`_bind()` `:63-96`，`_ensureValidTable` 把表名锁死在枚举内）。真做关系表就要改写 `setSection`/`getSection`/`setSections` 的 SQL 构造——**那是「动 `_bind()` 里现有表」的同类动作，超出批准边界**。键值 JSON 是既有 12 张表的一致做法，**零结构改动**。

---

## 4. `prjstorage.js` · 改动 C —— `clearAll()` 加两条清表语句

**位置**：`server/runtime/project/prjstorage.js:216-239`，在 `:229` 之后追加两行

> **这一处是必须的，不是可选的。** `setProject()` 第一句就是 `prjstorage.clearAll()`（`project/index.js:777`）。若不清 `mes`/`ems`，**每次导入工程旧内容都会累加进新工程**——这是数据正确性问题。
>
> 严格说它不在委托方列的「能动」四条里，但属于同一条款（`TableType` 加成员）的**必要配套**：表加进枚举而清表语句不跟，是本仓已经踩过的坑（见下方既存缺陷）。**请确认这一条**。

### 修前（`:218-230`，逐字）

```js
        // prepare query
        var sql = "DELETE FROM general;";
        sql += "DELETE FROM views;";
        sql += "DELETE FROM devices;";
        sql += "DELETE FROM texts;";
        sql += "DELETE FROM alarms;";
        sql += "DELETE FROM recipes;";
        sql += "DELETE FROM notifications;";
        sql += "DELETE FROM scripts;";
        sql += "DELETE FROM reports;";
        sql += "DELETE FROM locations;";
        sql += "DELETE FROM arMarkers;";
        db_prj.exec(sql, function (err) {
```

### 修后

```js
        // prepare query
        var sql = "DELETE FROM general;";
        sql += "DELETE FROM views;";
        sql += "DELETE FROM devices;";
        sql += "DELETE FROM texts;";
        sql += "DELETE FROM alarms;";
        sql += "DELETE FROM recipes;";
        sql += "DELETE FROM notifications;";
        sql += "DELETE FROM scripts;";
        sql += "DELETE FROM reports;";
        sql += "DELETE FROM locations;";
        sql += "DELETE FROM arMarkers;";
        sql += "DELETE FROM mes;";
        sql += "DELETE FROM ems;";
        db_prj.exec(sql, function (err) {
```

### 顺带记录的既存缺陷（**本次不改**）

`clearAll()` 的 11 条 `DELETE`（`:219-229`）里**没有 `devicesSecurity`**，而 `TableType.DEVICESSECURITY` 是一张真实存在的表（建表在 `:78`，枚举在 `:248`）。即 `clearAll()` 与 `TableType` **本来就不同步**。本设计不修它（不在批准边界内），但**实现者不要照抄这个疏漏**——新加的两张表必须进 `clearAll()`。这一点也是 §11.4「没有守卫在盯表清单」的反证。

---

## 5. `project/index.js` · 改动 D —— `setProject()` 加 `mes` / `ems` 分支

**位置**：`server/runtime/project/index.js:850-857`（`reports` 分支）之后，**必须在 `else`（`:875-877`）之前**

### 修前（`:826-858`，逐字——含要照抄的 `recipes` 模式）

```js
                    } else if (key === 'recipes') {
                        // recipe templates
                        var recipes = prjcontent[key];
                        if (recipes && recipes.length) {
                            for (var i = 0; i < recipes.length; i++) {
                                scs.push({ table: prjstorage.TableType.RECIPES, name: recipes[i].id, value: recipes[i] });
                            }
                        }
                    } else if (key === 'notifications') {
                        // notifications
                        var notifications = prjcontent[key];
                        if (notifications && notifications.length) {
                            for (var i = 0; i < notifications.length; i++) {
                                scs.push({ table: prjstorage.TableType.NOTIFICATIONS, name: notifications[i].id, value: notifications[i] });
                            }
                        }
                    } else if (key === 'scripts') {
                        // scripts
                        var scripts = prjcontent[key];
                        if (scripts && scripts.length) {
                            for (var i = 0; i < scripts.length; i++) {
                                scs.push({ table: prjstorage.TableType.SCRIPTS, name: scripts[i].id, value: scripts[i] });
                            }
                        }
                    } else if (key === 'reports') {
                        // reports
                        var reports = prjcontent[key];
                        if (reports && reports.length) {
                            for (var i = 0; i < reports.length; i++) {
                                scs.push({ table: prjstorage.TableType.REPORTS, name: reports[i].id, value: reports[i] });
                            }
                        }
                    } else if (key === 'mapsLocations') {
```

### 修后（只插两段，其余逐字不变）

```js
                    } else if (key === 'reports') {
                        // reports
                        var reports = prjcontent[key];
                        if (reports && reports.length) {
                            for (var i = 0; i < reports.length; i++) {
                                scs.push({ table: prjstorage.TableType.REPORTS, name: reports[i].id, value: reports[i] });
                            }
                        }
                    } else if (key === 'mes') {
                        // MES project data: work orders, operations, shifts, OEE targets, defect types.
                        // One row per object, the same shape recipes use - so an object can be added,
                        // changed or removed on its own.
                        var mesItems = prjcontent[key];
                        if (mesItems && mesItems.length) {
                            for (var i = 0; i < mesItems.length; i++) {
                                scs.push({ table: prjstorage.TableType.MES, name: mesItems[i].id, value: mesItems[i] });
                            }
                        }
                    } else if (key === 'ems') {
                        // EMS project data: meters, media, tariff bands, unit-energy targets,
                        // carbon factors. Same one-row-per-object shape.
                        var emsItems = prjcontent[key];
                        if (emsItems && emsItems.length) {
                            for (var i = 0; i < emsItems.length; i++) {
                                scs.push({ table: prjstorage.TableType.EMS, name: emsItems[i].id, value: emsItems[i] });
                            }
                        }
                    } else if (key === 'mapsLocations') {
```

**照 `recipes` 的三处对齐**：① 分支写法（取数组 → 逐项 `scs.push`）；② `name` 取 `item.id`（`recipes`/`reports`/`scripts` 都是 `item.id`；`alarms`/`texts` 取 `item.name`，本设计**不跟这两个**）；③ 空数组时整段跳过。

**变量名用 `mesItems`/`emsItems`**，不叫 `mes`/`ems`——因为 `forEach` 的参数就叫 `key`（`:779`），同名的 `var` 会与 `key` 的比较阅读混淆（`var` 函数作用域，不报错但难读）。

**读路径**（`data.mes` / `data.ems` 何时装配）见 §7。

---

## 6. `project/index.js` · 改动 E —— `setProjectData()` 加四条命令

**位置**：`server/runtime/project/index.js:261-268`（`SetRecipe`/`DelRecipe` 分支）之后；辅助函数 `setMes`/`removeMes`/`setEms`/`removeEms` 建议放在 `setRecipe`/`removeRecipe`（`:514-545`）之后

### 6.1 命令枚举（`runtime/project/index.js:1321-1347`）

#### 修前（`:1321-1347`，逐字）

```js
const ProjectDataCmdType = {
    SetDevice: 'set-device',
    DelDevice: 'del-device',
    SetView: 'set-view',
    DelView: 'del-view',
    HmiLayout: 'layout',
    Charts: 'charts',
    Graphs: 'graphs',
    Languages: 'languages',
    ClientAccess: 'client-access',
    SetText: 'set-text',
    DelText: 'del-text',
    SetAlarm: 'set-alarm',
    DelAlarm: 'del-alarm',
    SetRecipe: 'set-recipe',
    DelRecipe: 'del-recipe',
    SetNotification: 'set-notification',
    DelNotification: 'del-notification',
    SetScript: 'set-script',
    DelScript: 'del-script',
    SetReport: 'set-report',
    DelReport: 'del-report',
    SetMapsLocation: 'set-maps-location',
    DelMapsLocation: 'del-maps-location',
    SetArMarker: 'set-ar-marker',
    DelArMarker: 'del-ar-marker',
}
```

#### 修后（追加 4 个成员）

```js
const ProjectDataCmdType = {
    SetDevice: 'set-device',
    DelDevice: 'del-device',
    SetView: 'set-view',
    DelView: 'del-view',
    HmiLayout: 'layout',
    Charts: 'charts',
    Graphs: 'graphs',
    Languages: 'languages',
    ClientAccess: 'client-access',
    SetText: 'set-text',
    DelText: 'del-text',
    SetAlarm: 'set-alarm',
    DelAlarm: 'del-alarm',
    SetRecipe: 'set-recipe',
    DelRecipe: 'del-recipe',
    SetNotification: 'set-notification',
    DelNotification: 'del-notification',
    SetScript: 'set-script',
    DelScript: 'del-script',
    SetReport: 'set-report',
    DelReport: 'del-report',
    SetMapsLocation: 'set-maps-location',
    DelMapsLocation: 'del-maps-location',
    SetArMarker: 'set-ar-marker',
    DelArMarker: 'del-ar-marker',
    SetMes: 'set-mes',
    DelMes: 'del-mes',
    SetEms: 'set-ems',
    DelEms: 'del-ems',
}
```

> 🔴 **实操红线（这条是真会崩门禁的）**：`enumContractSync.test.js` 用**行正则**解析这两个枚举（`test/architecture/enumContractSync.test.js:77`）：
> `/^\s*(?:export\s+)?([A-Za-z_$][\w$]*)\s*[:=]\s*(?:'([^']*)'|"([^"]*)"|(-?\d+))\s*,?\s*(?:\/\/.*)?$/`
> 它**允许行尾注释，不允许标识符与冒号之间有注释**。所以这四行**必须写成 `SetMes: 'set-mes',` 这一种形状**，不能写成 `SetMes /* MES */: 'set-mes',`，否则该行解析不出来、成员数不足 → **门禁变红**。
> 实测：门禁当前解析出的成员数 = **服务端 25、客户端 25**，`min` 也是 25（`:99`）——**刚好卡在下限**。加 4 个后两侧各 28，安全。

### 6.2 客户端镜像（`client/src/app/_models/project.ts:54-80`）

#### 修前（`:76-80`，逐字）

```ts
    SetMapsLocation = 'set-maps-location',
    DelMapsLocation = 'del-maps-location',
    SetArMarker = 'set-ar-marker',
    DelArMarker = 'del-ar-marker',
}
```

#### 修后

```ts
    SetMapsLocation = 'set-maps-location',
    DelMapsLocation = 'del-maps-location',
    SetArMarker = 'set-ar-marker',
    DelArMarker = 'del-ar-marker',
    SetMes = 'set-mes',
    DelMes = 'del-mes',
    SetEms = 'set-ems',
    DelEms = 'del-ems',
}
```

**两侧必须同名同值**：门禁做两件事——两侧成员名集合相等（`:217-224`），且同名成员的值相等（`:226-237`）。少一侧、或值不一致，都会红。

### 6.3 `setProjectData()` 命令分支

#### 修前（`:261-269`，逐字）

```js
            } else if (cmd === ProjectDataCmdType.SetRecipe) {
                section.table = prjstorage.TableType.RECIPES;
                section.name = value.id;
                setRecipe(value);
            } else if (cmd === ProjectDataCmdType.DelRecipe) {
                section.table = prjstorage.TableType.RECIPES;
                section.name = value.id;
                toremove = removeRecipe(value);
            } else if (cmd === ProjectDataCmdType.SetNotification) {
```

#### 修后

```js
            } else if (cmd === ProjectDataCmdType.SetRecipe) {
                section.table = prjstorage.TableType.RECIPES;
                section.name = value.id;
                setRecipe(value);
            } else if (cmd === ProjectDataCmdType.DelRecipe) {
                section.table = prjstorage.TableType.RECIPES;
                section.name = value.id;
                toremove = removeRecipe(value);
            } else if (cmd === ProjectDataCmdType.SetMes) {
                section.table = prjstorage.TableType.MES;
                section.name = value.id;
                setMes(value);
            } else if (cmd === ProjectDataCmdType.DelMes) {
                section.table = prjstorage.TableType.MES;
                section.name = value.id;
                toremove = removeMes(value);
            } else if (cmd === ProjectDataCmdType.SetEms) {
                section.table = prjstorage.TableType.EMS;
                section.name = value.id;
                setEms(value);
            } else if (cmd === ProjectDataCmdType.DelEms) {
                section.table = prjstorage.TableType.EMS;
                section.name = value.id;
                toremove = removeEms(value);
            } else if (cmd === ProjectDataCmdType.SetNotification) {
```

**四条命令把「写内存 + 落表」都覆盖了**：`setProjectData()` 的后半段（`:313-327`）统一处理——`toremove` 为真走 `deleteSection`，否则走 `setSection`。**不需要新代码。**

**`toremove` 的语义**（`:203`）：`var toremove = false;`，`Del*` 分支把它设为 `removeXxx(value)` 的返回值（`true`= 内存里确实删掉了 → 才删表行；`false`= 本来就没有 → 只 `setSection` 写回一个 `name`，**无副作用**）。照抄这个语义，不要改。

### 6.4 辅助函数 `setMes` / `removeMes` / `setEms` / `removeEms`

**位置**：`server/runtime/project/index.js:545`（`removeRecipe` 的 `}`）之后

**修前**：该位置当前直接是 `setNotification` 的注释块（`:547-550`）。

**修后（插入内容，逐字照 `setRecipe`/`removeRecipe` `:514-545` 的形状）**

```js
/**
 * Set or add if not exist (check with id) the MES object in Project
 * @param {*} item
 */
function setMes(item) {
    if (!data.mes) {
        data.mes = [];
    }
    var pos = -1;
    for (var i = 0; i < data.mes.length; i++) {
        if (data.mes[i].id === item.id) {
            pos = i;
        }
    }
    if (pos >= 0) {
        data.mes[pos] = item;
    } else {
        data.mes.push(item);
    }
}

/**
 * Remove the MES object from Project
 * @param {*} item
 */
function removeMes(item) {
    if (data.mes) {
        for (var i = 0; i < data.mes.length; i++) {
            if (data.mes[i].id === item.id) {
                data.mes.splice(i, 1);
                return true;
            }
        }
    }
    return false;
}

/**
 * Set or add if not exist (check with id) the EMS object in Project
 * @param {*} item
 */
function setEms(item) {
    if (!data.ems) {
        data.ems = [];
    }
    var pos = -1;
    for (var i = 0; i < data.ems.length; i++) {
        if (data.ems[i].id === item.id) {
            pos = i;
        }
    }
    if (pos >= 0) {
        data.ems[pos] = item;
    } else {
        data.ems.push(item);
    }
}

/**
 * Remove the EMS object from Project
 * @param {*} item
 */
function removeEms(item) {
    if (data.ems) {
        for (var i = 0; i < data.ems.length; i++) {
            if (data.ems[i].id === item.id) {
                data.ems.splice(i, 1);
                return true;
            }
        }
    }
    return false;
}
```

> **一处已知的既存不一致**（照抄时要知道）：`setRecipe`（`:514-529`）**没有** `return`；`removeRecipe`（`:535-545`）返回 `true`/`false`。本设计两个函数都按这个语义写（`set` 无返回、`remove` 返回布尔），与 `recipes` 一致。

---

## 7. `project/index.js` · 改动 F —— 读路径：`getMes()` / `getEms()` + `load()` 加两步

> **这是回答「`data.mes` / `data.ems` 怎么装配、什么时候装配」的章节。**

### 7.1 装配时机：**`load()` 启动时一次性装配，不是请求时**

```
runtime/index.js:458-461   start() 的第一句就是 project.load()          ← 启动即装配
runtime/index.js:577-606   restart(clear) = stop() → start()            ← 重启也重新装配
api/projects/index.js:94-97 POST /api/project → setProject() → restart  ← 导入工程必然重新装配
project/index.js:59-70     load() 开头把 data 重置为固定形状
project/index.js:161-169   async.series 的 step 1..8
project/index.js:171-178   完成回调 → _mergeDefaultConfig() → resolve()
```

### 7.2 新增 `getMes()` / `getEms()`

**位置**：`server/runtime/project/index.js:1003`（`getRecipes()` 的 `}`）之后

**修后（插入内容）**

```js
/**
 * Get the MES project data objects (work orders, operations, shifts, OEE targets, defect types).
 * One row per object, the same shape recipes use - so the reader gets an array back, exactly the
 * way getRecipes() does.
 */
function getMes() {
    return new Promise(function (resolve, reject) {
        prjstorage.getSection(prjstorage.TableType.MES).then(drows => {
            if (drows.length > 0) {
                var mes = [];
                for (var id = 0; id < drows.length; id++) {
                    mes.push(JSON.parse(drows[id].value));
                }
                resolve(mes);
            } else {
                resolve([]);
            }
        }).catch(function (err) {
            logger.error(\`project.prjstorage.get-mes failed! '\${prjstorage.TableType.MES} \${err}'\`);
            reject(err);
        });
    });
}

/**
 * Get the EMS project data objects (meters, media, tariff bands, unit-energy targets, carbon factors).
 */
function getEms() {
    return new Promise(function (resolve, reject) {
        prjstorage.getSection(prjstorage.TableType.EMS).then(drows => {
            if (drows.length > 0) {
                var ems = [];
                for (var id = 0; id < drows.length; id++) {
                    ems.push(JSON.parse(drows[id].value));
                }
                resolve(ems);
            } else {
                resolve([]);
            }
        }).catch(function (err) {
            logger.error(\`project.prjstorage.get-ems failed! '\${prjstorage.TableType.EMS} \${err}'\`);
            reject(err);
        });
    });
}
```

**为什么 `resolve([])` 而不是 `resolve()`**：`getRecipes()` 空表时 `resolve([])`（`:996`），`getAlarms()` 空表时 `resolve()`（即 `undefined`，`:974`）——**两者不一致**。选 `[]`，让 `data.mes` 永远是数组，消费方不必判 `undefined`。这与「参照 recipes」一致。

### 7.3 `load()` 加 step 9 / step 10

**位置**：`server/runtime/project/index.js:156-170`

#### 修前（`:156-170`，逐字；注意 `:169` 的 `}` 后**没有逗号**）

```js
                        // step 8 get AR markers
                        function (callback) {
                            getArMarkers().then(markers => {
                                if (!data.ar) {
                                    data.ar = { enabled: false, markers: [] };
                                }
                                data.ar.markers = markers || [];
                                data.ar.enabled = data.ar.enabled || data.ar.markers.length > 0;
                                callback();
                            }).catch(function (err) {
                                logger.error(\`project.prjstorage-failed-to-load! '\${prjstorage.TableType.ARMARKERS} \${err}'\`);
                                callback(err);
                            });
                        }
                    ],
```

#### 修后

```js
                        // step 8 get AR markers
                        function (callback) {
                            getArMarkers().then(markers => {
                                if (!data.ar) {
                                    data.ar = { enabled: false, markers: [] };
                                }
                                data.ar.markers = markers || [];
                                data.ar.enabled = data.ar.enabled || data.ar.markers.length > 0;
                                callback();
                            }).catch(function (err) {
                                logger.error(\`project.prjstorage-failed-to-load! '\${prjstorage.TableType.ARMARKERS} \${err}'\`);
                                callback(err);
                            });
                        },
                        // step 9 get MES project data
                        function (callback) {
                            getMes().then(mes => {
                                data.mes = mes || [];
                                callback();
                            }).catch(function (err) {
                                logger.error(\`project.prjstorage-failed-to-load! '\${prjstorage.TableType.MES} \${err}'\`);
                                callback(err);
                            });
                        },
                        // step 10 get EMS project data
                        function (callback) {
                            getEms().then(ems => {
                                data.ems = ems || [];
                                callback();
                            }).catch(function (err) {
                                logger.error(\`project.prjstorage-failed-to-load! '\${prjstorage.TableType.EMS} \${err}'\`);
                                callback(err);
                            });
                        }
                    ],
```

**改动要点**：`:169` 的 `}` 必须变成 `},`。**这是全部 6 处插入里唯一的「改写现有行」**（标点）。

**为什么必须进 `load()`**：`data.mes`/`data.ems` 要在 `resolve()`（`:176`）之前就位——因为 `runtime/index.js:484` 的 `scriptsMgr.start()` 就在 `project.load().then(...)` **内部**，脚本调度的初始化晚于装配。

> 严谨补充：`scriptsMgr.start()` 只是启动 1 秒周期状态机（`runtime/scripts/index.js:11,27-34`），真正的脚本加载在状态机切到 `LOAD` 时经 `_loadProperty()`（`:195-233`）。**而且本设计的脚本只读 tag、不读 `data.mes`**（§12），所以这一环是额外保险，不是关键路径。

### 7.4 `module.exports` 加导出

**位置**：`server/runtime/project/index.js:1349-1373`

#### 修前（`:1352-1362`，逐字）

```js
module.exports = {
    init: init,
    load: load,
    getDevices: getDevices,
    getServer: getServer,
    getDevice: getDevice,
    getAlarms: getAlarms,
    getRecipes: getRecipes,
    getRecipe: getRecipe,
    getRecipesData: getRecipesData,
    getRecipesSync: getRecipesSync,
    getNotifications: getNotifications,
```

#### 修后

```js
module.exports = {
    init: init,
    load: load,
    getDevices: getDevices,
    getServer: getServer,
    getDevice: getDevice,
    getAlarms: getAlarms,
    getRecipes: getRecipes,
    getRecipe: getRecipe,
    getRecipesData: getRecipesData,
    getRecipesSync: getRecipesSync,
    getMes: getMes,
    getEms: getEms,
    getNotifications: getNotifications,
```

本设计**不导出** `getMesSync`/`getEmsSync`（`recipes` 有一个 `getRecipesSync`，`:1013-1015`，因为配方编辑器要同步拿全量）。**第一批不需要**——编辑器走 `GET /api/project`。

---

## 8. `project/index.js` · 改动 G —— `runtime.update()` 要不要加分支？

**结论：不加。** `runtime/index.js:544-575` 的 `update(cmd, data)` 目前只处理 `SetDevice/DelDevice/SetAlarm/DelAlarm/SetNotification/DelNotification/SetScript/DelScript/SetReport/DelReport`（`:547-563`），**没有 `recipes` 的分支**——也就是说 `SetRecipe` 走 `POST /api/projectData` 时，`update()` 是**空转**的（不命中任何分支，直接 `resolve(true)`）。

**照 `recipes` 的先例，`mes`/`ems` 也不需要 `update()` 分支**：它们不驱动任何运行期管理器（设备/报警/通知/脚本/任务都不关心工程里的 MES 表）。

> 好处：**不新增跨域耦合边**。`api/projects/index.js:123` 会调 `runtime.update(cmd, data)`，但那条边早就在冻结基线里；我们不加新的。

---

## 9. 客户端 `project.ts` · 改动 H

**位置**：`client/src/app/_models/project.ts:16-52`

### 修前（`:45-52`，逐字）

```ts
    /** Plugin, name, version */
    plugin: Plugin[] = [];
    /** Maps location */
    mapsLocations: MapsLocation[] = [];
    /** ClientAccess */
    clientAccess = new ClientAccess();
    /** Browser AR marker to view/card mappings */
    ar?: ArSettings = new ArSettings();
}
```

### 修后

```ts
    /** Plugin, name, version */
    plugin: Plugin[] = [];
    /** Maps location */
    mapsLocations: MapsLocation[] = [];
    /** ClientAccess */
    clientAccess = new ClientAccess();
    /** Browser AR marker to view/card mappings */
    ar?: ArSettings = new ArSettings();
    /**
     * MES project data: work orders, operations, shifts, OEE targets, defect types.
     * Server side this is the project storage table 'mes', one row per object - see
     * runtime/project/prjstorage.js (TableType.MES) and runtime/project/index.js (getMes).
     */
    mes?: MesEmsItem[] = [];
    /** EMS project data: meters, media, tariff bands, unit-energy targets, carbon factors. */
    ems?: MesEmsItem[] = [];
}
```

**新增类型声明文件** `client/src/app/_models/mesems.ts`（与 `data-model.md` 一一对应）：

```ts
/**
 * MES / EMS project data items.
 *
 * One interface for both tables: the server stores them as one row per object
 * (runtime/project/prjstorage.js, TableType.MES / TableType.EMS), and the editor must be able to
 * round-trip an item it does not recognise instead of dropping it - so this stays permissive and
 * the per-model field lists live in __mes_ems_design/data-model.md.
 */
export interface MesEmsItem {
    id: string;
    [key: string]: any;
}
```

> 该文件在 `client/src/app/_models/`，**不在 `_services/` 下**，所以不触碰「不改 `_services/`」。

---

## 10. 脚本侧的正确 API（**不要在脚本里写规格书那套名字**）

`SetMes`/`DelMes` 等命令只负责**存表**；**表的值要进脚本，必须经 tag 镜像**——因为脚本的系统函数是封闭白名单（`runtime/scripts/index.js:235-254`，15 个，见 `data-model.md` §0）。

    表（mes/ems）──[编辑器保存后下发，$setTag]──→ tag ──[$getTag]──→ 脚本 ──[$setTag]──→ tag ──→ DAQ

**脚本里只允许出现这 15 个名字**，MES/EMS 用得上的就是 **`$getTag` / `$setTag`**（`:237-238`）。**DAQ 落库不靠脚本函数**，靠 tag 自己的 `daq` 字段（`scadiaserver/index.js:247-255`、`:220-222`）。

---

## 11. 门禁影响 —— 逐条结论 + 证据（含「没读」的明说）

### 11.0 结论总表

| # | 守卫 | 读了没 | 会不会红 |
|---|---|---|---|
| 1 | `test/storage/domainDatabaseFiles.test.js` | **读了全文（225 行）** | **不会** |
| 2 | `test/architecture/dependencyDirection.test.js` | **读了全文（109 行）** | **不会** |
| 3 | `test/architecture/crossDomainIsolation.test.js` | **读了前 60 行 + 基线全文** | **不会** |
| 4 | `test/architecture/enumContractSync.test.js` | **读了 1-140 与 140-260 行（全文 260+）** | **不会**（但有**格式红线**，见 §6.1） |
| 5 | `test/architecture/interfaceSnapshot.test.js` | **读了前 60 行（全文 114）** | **不会** |
| 6 | `test/architecture/domainContracts.test.js` | **读了 1-60 与 60-193（全文）** | **不会** |
| 7 | `test/architecture/apiDomainScaffold.test.js` | **读了全文（110 行）** | **不会** |
| 8 | `test/architecture/apiGuestSurface.test.js` | **读了全文（110 行）** | **不会** |
| 9 | `test/project/projectDemoFile.test.js` | **读了全文（67 行）** | **不会** |
| 10 | `test/storage/storage-insert-select.test.js` | **只读了 grep 命中行（`:8,53,57,59,63,67-85`），未读全文** | **不会**（现有断言只涉 GENERAL/VIEWS） |
| 11 | `test/api/devicesApi.test.js` | **只读了 grep 命中行（`:80,350`）** | **不会**（用打桩的 `ProjectDataCmdType:{SetDevice}`） |
| 12 | `test/recipes/recipesApi.test.js` | **只读了 grep 命中行（`:117`）** | **不会**（同上，打桩） |
| 13 | `test/architecture/reverse-verify.js` | **只读了 grep 命中行** | **不会**（自刷新哈希，见 §11.5） |
| 14 | `test/architecture/reverse-baseline.js` | **只读了 grep 命中行（`:81`）** | **不明 —— 未读全文，我不下结论** |
| 15 | `test/storage/*.test.js` 其余 4 个（`tdengine`/`sqliteSidecar`/`daqnode`/`daqQueryContract`/`disconnectedRead`） | **❌ 未读** | **未评估 —— 但它们文件名全部指向 DAQ/后端适配器，与工程表无关** |
| 16 | `test/architecture/` 其余（`apiRegistry`/`apiAuthSingleSource`/`apiErrorFrameCodes`/`assetLibrary`/`booleanParsing`/`capabilityMatrix`/`clientSubscriptionTeardown`/`clientTestRunner`/`controllerErrors`/`errorSemantics`/`gateExitContract`/`ioEventTypesSync`/`lintGate`/`noDebugProbesInProduction`/`projectAssets`/`projectReloadSurvivors`/`registryCompleteness`/`reverseDependency`/`runtimeDependencies`/`scannerContract`/`schedulerSuiteExitContract`/`spaRoutesCompleteness`/`storageSuiteExitContract`/`thirdPartyLicences`/`uiConsistencyR1`/`uiConsistencyR1R2R3`/`uiConsistencyR5`） | **❌ 未读（27 个文件）** | **未评估。** 已用 grep 扫过 `prjstorage`/`runtime/project`/`ProjectDataCmdType`/`sqlite_master`/`TableType` **五个关键词**，**只命中已列出的那些文件**——所以这 27 个文件**大概率不引用本设计的改动面**，但这是**推断，不是读过** |

### 11.1 `domainDatabaseFiles.test.js` —— 不会红（四条断言逐条）

| 断言 | 行号 | 为什么不受影响 |
|---|---|---|
| 「声明的域库表 == 磁盘上拥有库的域模块」 | `:117-122` | 扫的是**文件名以 `storage.js` 结尾**的模块（`storeModulesOnDisk()`，`:50-66`）。**本设计不新建任何 `*storage.js`**，`prjstorage.js` 本来就登记在 `DOMAIN_STORES.project`（`:38`）→ 三个集合都不变 |
| 「每个域库名 == `<id>.scadiap.db`」 | `:124-129` | 不新增域 id |
| 「每域走 `storage.resolveDbFile(...,'<id>')`」 | `:203-210` | 遍历 `DOMAIN_STORES` 的 8 个；`prjstorage.js:65` 那条已有调用不动 |
| 「域侧文件不得自拼 `.db` 文件名」 | `:212-224`（正则 `/\.db['"]/`） | 新增两行是 `CREATE TABLE if not exists mes (name TEXT PRIMARY KEY, value TEXT);`，**不含 `.db` 字面量** |

### 11.2 `dependencyDirection.test.js` —— 不会红

| 断言 | 行号 | 对照 |
|---|---|---|
| runtime 不依赖 api | `:34-38` | 不新增 require |
| storage 平面不依赖 runtime | `:55-64` | **不碰 `runtime/storage/`** |
| 契约平面零依赖 | `:66-76` | 不碰 `runtime/reporting/` 与 `storage/contract.js` |
| **只有 `runtime/storage/` 可 require `sqlite3`**（允许集是**精确集合**） | `:78-97`；`LEGACY_SQLITE3_REQUIRERS = []`（`_support/known-debt.js:79`） | 新代码只用 `prjstorage` 已有的 `db_prj` 句柄（`prjstorage.js:67` `storage.open(...)`），**不新增 `require('sqlite3')`** → 精确集合不变 |
| 相对 require 落在 server 树内 | `:99-108` | 不新增 require |

### 11.3 `crossDomainIsolation.test.js` —— 不会红

断言「runtime 内跨域 require 边集合 == 冻结基线」（`:51-58`）。基线的**全文**在 `_support/known-debt.js:171-208`，**实测已含** `'project -> (root)'`（`:198`）、`'project -> devices'`（`:199`）、`'project -> storage'`（`:200`）。

本设计全部改动都在 `runtime/project/` 域内部（`domainOf()` 取路径第 2 段，`:17-21`）→ **不新增任何跨域边**。§8 已论证 `runtime.update()` 不加分支，正是为了守住这条。

### 11.4 「TableType 数量」「域库文件名一一对应」类断言 —— **实测结论**

**委托方点名的两条，逐条：**

1. **「TableType 数量」断言：不存在。** `grep 'TableType' server/` → **84 命中**（排除 node_modules/dist），**逐条看过**：全部是 `prjstorage.js` 内的定义与 `_ensureValidTable`（`:41`）、`project/index.js` 里的 `prjstorage.TableType.XXX` 取值、`test/storage/storage-insert-select.test.js:68,73,81-85` 的 GENERAL/VIEWS 取值、`test/project/_support/layout-fallback-probe.js:58` 的**打桩对象**（stub，不是断言）。**没有任何一条断言成员个数。**
2. **「域 ↔ 表 一一对应」断言：不存在。** `domainDatabaseFiles.test.js` 管的是**域 ↔ 库文件**（8 个域），不是域 ↔ 表。`_bind()` 的 12 条建表与 `TableType` 的 12 个成员之间**没有守卫**——**反证**：`clearAll()` 漏了 `devicesSecurity`（§4）而没有任何测试变红。
3. **按下标取 `TableType`：不存在**（84 命中逐条看过），所以「顺序依赖」在实测层面不成立；本设计**仍然追加在末尾**。

### 11.4b 设计期间发生的**并行改动**（已实测，且**证实**了本节的结论）

> 本设计成文期间，**另一个会话正在改同一棵树**（08:34–08:38）。已实测到 5 个文件被改动，其中 2 个与本设计同域。**逐一核对如下。**

| 被改文件 | 改动内容 | 对本设计的影响 |
|---|---|---|
| `server/runtime/notificator/notifications-storage.js` | **新增文件**（08:34） | 无 —— 本设计不在 `notificator/` 下做任何事 |
| `server/runtime/storage/databases.js` | `DOMAIN_DB_FILES` 从 **8 个域**变成 **9 个**：新增 `notifications: 'notifications.scadiap.db'`（现 `:74-84`） | **正面**：见下 |
| `server/test/storage/domainDatabaseFiles.test.js` | `DOMAIN_STORES` 同步加第 9 项 `notifications: 'runtime/notificator/notifications-storage.js'`（现 `:34-44`） | **正面**：见下 |
| `server/runtime/notificator/index.js` | 接线改动 | 无 |
| `server/_p0probe/notificationFlow.js` | 新增探针 | 无 |

**为什么是「正面」——它把本节的结论从「论证」变成了「刚被验证过的事实」：**

1. **`§11.1` 的结论被这次改动证实了**：`domainDatabaseFiles.test.js:117-122` 的断言是「`DOMAIN_DB_FILES` 的键 == 磁盘上 `*storage.js` 模块的域」。那次改动**新增了一个 `*storage.js` 文件**，于是**必须同时**在 `databases.js:83` 与测试 `:43` 各加一项，三者（声明表 / 磁盘模块 / 测试表）**一起变**才不红。
   **而本设计一个新 `*storage.js` 都不建** —— 所以**三个集合一个都不动**。
   > 这正是该守卫「只盯域 ↔ 库文件、不盯域 ↔ 表」的**活体证明**：一张新表不需要跟任何清单对齐。
2. **`§11.2` 的结论被证实**：改动后重新实测 `runtime/` 下 `require('sqlite3')` 的模块仍是**精确的三个**——`storage/sqlite/index.js:13`、`storage/databases.js:17`、`storage/sqlite/currentstorage.js:5`。新的 `notifications-storage.js` **没有自己 require sqlite3**，而是走 `storage.resolveDbFile(settings.workDir, 'notifications', logger)`（`notifications-storage.js:49`）→ 拿 `storage.open()` 的句柄。**本设计遵守同一条规矩**：只用 `prjstorage` 已有的 `db_prj` 句柄（`prjstorage.js:67`），不新增 sqlite3 require。
3. **`§11.3` 的结论不受影响**：`known-debt.js` 的 `CROSS_DOMAIN_BASELINE`（`:171-208`）**本次未被改动**（实测 grep `notificator`/`notifications` 于该文件 → 只有 `:171` 的定义行与 `:220` 的导出行，无新增边）。这说明那次改动没有产生新的跨域 require 边——**与本设计「不新增跨域边」的策略同构**。
4. **「域 ↔ 表一一对应」仍然不存在**：这次改动动了两份**域清单**，却没动任何**表清单**（`_bind()`/`TableType` 一行未变）——**再次证明仓库里根本没有表清单守卫**。

**结论：并行改动不改变本文件的任何一条结论，反而给出了两条现场验证。** 但**实现前必须重新读一次**这 5 个文件的最终状态——**这棵树是活的**。

### 11.5 `reverse-verify.js` / `reverse-baseline.js` —— 一个明了、一个未读

- `reverse-verify.js`：是**自刷新**的——它把每个文件改动前的 `sha256` **在运行时**记进 `.reverse-tree-state.json`（`sha()` 在 `:30`，`record`/`before` 在 `:450,469,536`），跑完再校验「是否还原如初」（`:610` `record.restored = sha(abs) === pristineSha`）。**它不是对源码的固定哈希比对**，所以**改 `prjstorage.js` 不会让它红**。它与本设计的接触点是 `:237-239` 的一条用例（往共享平面加一条 require 使 `dependencyDirection` 变红，用的正是 `require("../project/prjstorage")`）——**我们的改动不触碰那条用例的前提**（不往 `runtime/storage/` 加 require）。
- `reverse-baseline.js:81` **出现了 `'runtime/project/index.js'`** —— 该文件在某个列表里，但**我未读该文件全文，因此不下结论**。**这是本清单里唯一一处「我看不懂为什么它在里面」的接触点，实现前请读一遍 `reverse-baseline.js` 全文。**

### 11.6 明确「未评估」的部分（不写成「应该没问题」）

下列守卫**本次未读**，因此**没有结论**：

- `test/storage/` 下的 `tdengine.test.js`、`sqliteSidecar.test.js`、`daqnode.test.js`、`daqQueryContract.test.js`、`disconnectedRead.test.js`（文件名全部指向 DAQ/后端适配器，与工程表无关，但**我没读**）；
- `test/architecture/` 下 **27 个**未读文件（§11.0 第 16 行列全）。我用 5 个关键词（`prjstorage` / `runtime/project` / `ProjectDataCmdType` / `sqlite_master` / `TableType`）扫过整个 `test/`（147 个 .js），**只有已列出的那些文件命中**——这是**支持性证据，不是读过**。

**建议**：实现后跑一次全量门禁（`test/storage/*`、`test/architecture/*`、`test/project/*`），把 §11.0 的结论逐条对照。**本设计没跑测试**（只读轮次）。

---

## 12. 明确**不做**的改动

| 不做 | 为什么 |
|---|---|
| 不往 `runtime/storage/` 加任何 require | `dependencyDirection.test.js:78-97` 的精确集合 |
| 不新建 `*storage.js` 文件 | `domainDatabaseFiles.test.js:117-122` |
| 不改库文件名 / 不新增域 id | 同上 |
| 不新增 API 路由、不建 `server/api/` 子目录 | `apiDomainScaffold.test.js:46-52`、`apiGuestSurface.test.js:56-70` |
| 不在 `server` 键、`devices` 键里塞 MES/EMS | 委托方明确禁止；`project/index.js:807-809`、`:780-787` |
| 不在 `runtime.update()` 加分支 | §8；避免新增跨域耦合面 |
| 不改 DAQ / 存储契约 | 委托方硬约束 |
| 不删 `clearAll()` 里既缺的 `devicesSecurity` | 不在批准边界内（但已记录，§4） |
| 不改 `setProject()` 里任何现有分支 | 委托方硬约束 |

---

## 13. 落地后自检清单

    [ ]  1. 启动服务，日志无 "prjstorage.bind failed"
    [ ]  2. 开工程库：SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mes','ems')  → 2 行
    [ ]  3. .scadiap 里写一条 mes，POST /api/project 导入，GET /api/project 能读回
    [ ]  4. 重启服务，mes 仍在（证明落的是库不是内存）
    [ ]  5. 再导入一份只有 2 条的 .scadiap，mes 恰好 2 条（证明 clearAll 补了 DELETE）
    [ ]  6. POST /api/projectData {cmd:'set-mes', data:{id:'x',...}} → 表里多一行
    [ ]  7. POST /api/projectData {cmd:'del-mes', data:{id:'x'}} → 表里少一行
    [ ]  8. grep 两个枚举：ProjectDataCmdType 两侧都能解析出 28 个成员、值一一对应
    [ ]  9. 脚本里 grep '$getTagValue' / '$setTagValue' / '$daqWrite' → 0 命中
    [ ] 10. 跑 test/storage/* + test/architecture/* + test/project/*，对照 §11.0 逐条核对
    [ ] 11. ls server/api/ → 目录数不变
