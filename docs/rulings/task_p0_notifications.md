# 批次 P0：通知系统修复 — 恢复存储层

**严重度**：P0 — 功能有壳无肉，通知无法持久化、邮件从不发出  
**执行方**：DeepSeek  
**预计工期**：2-3 天  
**依赖**：无

---

## 1. 问题定义

通知系统的前端界面（`/notifications`）、数据模型（`Notification` 类）、调度循环（每 20 秒检查）都完整存在。但**存储层被注释掉**，导致：

- `notifystorage.js` 的 `require` 被注释（`index.js:8`）
- `_init()` 直接 `resolve()`，不初始化数据库（`index.js:130-141`）
- `_loadNotifications()` 直接 `resolve()`，不从数据库读取（`index.js:207-236`）
- `clearNotifications()` 直接 `resolve()`，不执行清除（`index.js:68-77`）

**结果**：通知能配置、能触发、能发邮件（如果 SMTP 配置正确），但：
1. 通知状态不持久化 → 服务重启后所有通知状态丢失
2. 通知历史不记录 → 无法追溯谁在什么时候收到了什么通知
3. `clearNotifications` 空操作 → 通知历史无限堆积（如果有存储的话）

---

## 2. 修复范围

### 2.1 文件清单

| 文件 | 改动 |
|------|------|
| `server/runtime/notificator/index.js` | 取消注释 + 恢复存储层调用 |
| `server/runtime/notificator/notifystorage.js` | 检查是否存在，若不存在则新建 |

### 2.2 精确改动

#### 改动 1：取消 notifystorage 的 require

**位置**：`server/runtime/notificator/index.js:8`

**修前**：
```js
// const notifystorage = require('./notifystorage');
```

**修后**：
```js
const notifystorage = require('./notifystorage');
```

---

#### 改动 2：恢复 _init()

**位置**：`server/runtime/notificator/index.js:130-141`

**修前**：
```js
var _init = function () {
    return new Promise(function (resolve, reject) {
        resolve();
        // notifystorage.init(settings, logger).then(result => {
        //     logger.info('notificator.notifystorage-init-successful!', true);
        //     resolve();
        // }).catch(function (err) => {
        //     logger.error('notificator.notifystorage.failed-to-init: ' + err);
        //     reject(err);
        // });
    });
}
```

**修后**：
```js
var _init = function () {
    return new Promise(function (resolve, reject) {
        notifystorage.init(settings, logger).then(result => {
            logger.info('notificator.notifystorage-init-successful!', true);
            resolve();
        }).catch(function (err) {
            logger.error('notificator.notifystorage.failed-to-init: ' + err);
            reject(err);
        });
    });
}
```

---

#### 改动 3：恢复 _loadNotifications()

**位置**：`server/runtime/notificator/index.js:207-236`

**修前**：
```js
var _loadNotifications = function () {
    return new Promise(function (resolve, reject) {
        resolve();
        // if (clearNotifications) {
        //     notifystorage.clearNotifications().then(result => {
        //         resolve();
        //         clearNotifications = false;
        //     }).catch(function (err) => {
        //         logger.error('notificator.clear-current.failed: ' + err);
        //         reject(err);
        //     });
        // } else {
        //     notifystorage.getNotifications().then(result => {
        //         Object.keys(notificationsSubsctiption).forEach(subkey => {
        //             notificationsSubsctiption[subkey].forEach(notification => {
        //                 var currentNotify = result.find(currentNotify => currentNotify.id === notification.id);
        //                 if (currentNotify) {
        //                     notification.ontime = currentNotify.ontime;
        //                     notification.notifytime = currentNotify.notifytime;
        //                 }
        //             });
        //         });
        //         resolve();
        //     }).catch(function (err) => {
        //         logger.error('notificator.load-current.failed: ' + err);
        //         reject(err);
        //     });
        // }
    });
}
```

**修后**：
```js
var _loadNotifications = function () {
    return new Promise(function (resolve, reject) {
        if (clearNotifications) {
            notifystorage.clearNotifications().then(result => {
                resolve();
                clearNotifications = false;
            }).catch(function (err) {
                logger.error('notificator.clear-current.failed: ' + err);
                reject(err);
            });
        } else {
            notifystorage.getNotifications().then(result => {
                Object.keys(notificationsSubsctiption).forEach(subkey => {
                    notificationsSubsctiption[subkey].forEach(notification => {
                        var currentNotify = result.find(currentNotify => currentNotify.id === notification.id);
                        if (currentNotify) {
                            notification.ontime = currentNotify.ontime;
                            notification.notifytime = currentNotify.notifytime;
                        }
                    });
                });
                resolve();
            }).catch(function (err) => {
                logger.error('notificator.load-current.failed: ' + err);
                reject(err);
            });
        }
    });
}
```

---

#### 改动 4：恢复 clearNotifications()

**位置**：`server/runtime/notificator/index.js:68-77`

**修前**：
```js
this.clearNotifications = function (all) {
    return new Promise(function (resolve, reject) {
        resolve();
        // notifystorage.clearNotifications(all).then((result) => {
        //     resolve(true);
        // }).catch(function (err) => {
        //     reject(err);
        // });
    });
}
```

**修后**：
```js
this.clearNotifications = function (all) {
    return new Promise(function (resolve, reject) {
        notifystorage.clearNotifications(all).then((result) => {
            resolve(true);
        }).catch(function (err) => {
            reject(err);
        });
    });
}
```

---

### 2.3 新建 notifystorage.js

**路径**：`server/runtime/notificator/notifystorage.js`

如果该文件不存在，按以下模板创建：

```js
/*
* Notification storage: init DB, CRUD notifications, clear history
*/

'use strict';
const path = require('path');
const fs = require('fs');

var logger;
var db;

function init(settings, log) {
    logger = log;
    return new Promise(function (resolve, reject) {
        const dbFile = path.join(settings.userDir, '_appdata', 'notifications.db');
        const sqlite3 = require('sqlite3').verbose();
        db = new sqlite3.Database(dbFile, function (err) {
            if (err) {
                logger.error('notifystorage.init.failed: ' + err);
                reject(err);
                return;
            }
            db.serialize(function () {
                db.run("CREATE TABLE IF NOT EXISTS notifications (" +
                    "id TEXT PRIMARY KEY, " +
                    "name TEXT, " +
                    "type TEXT, " +
                    "enabled INTEGER, " +
                    "receiver TEXT, " +
                    "text TEXT, " +
                    "ontime INTEGER, " +
                    "notifytime INTEGER, " +
                    "mode TEXT, " +
                    "options TEXT, " +
                    "subscriptions TEXT)", function (err) {
                    if (err) {
                        logger.error('notifystorage.create-table.failed: ' + err);
                        reject(err);
                    } else {
                        logger.info('notifystorage.init-successful!', true);
                        resolve(true);
                    }
                });
            });
        });
    });
}

function getNotifications() {
    return new Promise(function (resolve, reject) {
        const sql = "SELECT * FROM notifications";
        db.all(sql, [], function (err, rows) {
            if (err) {
                logger.error('notifystorage.get.failed: ' + err);
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

function clearNotifications(all) {
    return new Promise(function (resolve, reject) {
        const sql = all ? "DELETE FROM notifications" : "DELETE FROM notifications WHERE notifytime < ?";
        const params = all ? [] : [Date.now() - 7 * 24 * 60 * 60 * 1000]; // 7 days ago
        db.run(sql, params, function (err) {
            if (err) {
                logger.error('notifystorage.clear.failed: ' + err);
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

module.exports = {
    init: init,
    getNotifications: getNotifications,
    clearNotifications: clearNotifications
};
```

**约束**：
- 如果 `notifystorage.js` 已存在（可能在其他路径），读取现有实现，只恢复被注释的部分，不覆盖
- 使用 sqlite3（已有依赖），数据库文件放在 `<userDir>/_appdata/notifications.db`
- 表结构与 `Notification` 类的字段一一对应

---

## 3. 验证清单

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 通知能持久化 | 1. 在 `/notifications` 创建一个通知 2. 重启服务 3. 再次打开 `/notifications` | 通知仍在，`ontime`/`notifytime` 保持 |
| 报警触发邮件 | 1. 配置 SMTP（在 `settings.js` 中）2. 触发一个报警 3. 查看邮箱 | 收到邮件，主题 = 通知名称，内容 = 报警摘要 |
| 登录/登出通知 | 1. 配置 access 类型通知 2. 登录/登出系统 | 收到邮件 |
| 通知历史 | 查询 `notifications.db` | 有记录，包含 `ontime`/`notifytime` |
| 清除历史 | 调用 `clearNotifications(true)` | 数据库清空 |
| 门禁 | `npm test` | 无新失败 |
| lint | `npx eslint server/runtime/notificator/` | exit 0 |

---

## 4. 不做的

- 不改前端代码（`/notifications` 界面已经完整）
- 不改 `Notification` 数据模型（`client/src/app/_models/notification.ts` 已有完整定义）
- 不改 SMTP 配置逻辑（`sendMail` 函数已经完整）
- 不改报警触发逻辑（`_checkNotifications` 已经完整）

---

*本任务卡为最终版本，执行方按精确改动项一次性完成。*
