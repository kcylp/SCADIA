# 批次 P3：TDengine 断开读语义修复 + 同族核对

**严重度**：P0 — 门禁 errorSemantics 失败，阻塞 90-A 结案  
**执行方**：DeepSeek  
**预计工期**：1 天  
**依赖**：P0 通知系统修复（可并行，但建议先 P0）

---

## 1. 问题定义

`runtime/storage/tdengine/index.js:130` 的 `getDaqValue` 在断开连接时 `reject(new Error('not connected'))`，而：

1. **同文件写入路径**（`:92-95`）在断开时是 `logger.error` + `continue`（不抛）
2. **其他后端**（sqlite/postgresql/questdb/influxdb）在断开/不可用时都是 `resolve([])` 或 `Promise.resolve([])`（空数据，不抛）
3. **A-07 契约**要求：读取断开后端应 settle 成空数据，不挂起、不 reject
4. **errorSemantics.test.js** 断言：`readWhenDisconnected` 必须返回空数据

**根因**：TDengine 读路径的异常处理与写路径、与其他后端、与契约不一致。

**历史现象**：之前门禁一直绿灯，因为 Docker 容器没跑，探针没走到 `getDaqValue`。现在容器跑起来了，这条用例才暴露真缺陷。

---

## 2. 精确改动

### 改动 1：修复 TDengine getDaqValue

**文件**：`server/runtime/storage/tdengine/index.js`  
**位置**：第 130 行

**修前**：
```javascript
if (!connected || !conn) {
    reject(new Error('not connected'));
    return;
}
```

**修后**：
```javascript
if (!connected || !conn) {
    // A-07 契约：断开时返回空数据，不抛异常。对齐同文件写入路径（:92-95）的
    // logger.error + continue 写法，以及 questdb/postgresql/sqlite/influxdb 的
    // resolve([]) / Promise.resolve([]) 行为。
    logger.error('daqstorage: TDengine is not connected, getDaqValue returns empty.');
    resolve([]);
    return;
}
```

---

### 改动 2：核对同族后端

逐个检查以下后端的 `getDaqValue` 在断开/不可用时的行为：

| 后端 | 文件 | 断开行为 | 是否一致 |
|------|------|----------|----------|
| **TDengine** | `runtime/storage/tdengine/index.js:127-149` | 修后 `resolve([])` | ✅ 标准 |
| **QuestDB** | `runtime/storage/questdb/index.js:97-131` | `resolve([])`（:101） | ✅ 已是标准 |
| **PostgreSQL** | `runtime/storage/postgresql/index.js:89-110` | `Promise.resolve([])`（:93） | ✅ 已是标准 |
| **SQLite** | `runtime/storage/sqlite/index.js:351-387` | `resolve([])`（:386） | ✅ 已是标准 |
| **InfluxDB** | `runtime/storage/influxdb/index.js:178-220` | 无显式断开检查，靠 `try-catch` | ⚠️ 需确认 |

**InfluxDB 需要补充吗？**

检查 `influxdb/index.js:178-220`：如果没有显式的 `!connected || !pool` 检查，则补充：

```javascript
this.getDaqValue = function (tagid, fromts, tots) {
    return new Promise(function (resolve, reject) {
        if (!pool) {
            resolve([]);  // 与 A-07 契约对齐
            return;
        }
        // ... 现有代码 ...
    });
}
```

---

## 3. 新增守卫：不依赖后端的 TDengine 断开读测试

**文件**：`server/test/storage/tdengine/disconnect-read.test.js`（新建）

**目的**：让这个缺陷永远不能再偷偷回来。

**测试逻辑**：
```javascript
const { expect } = require('chai');
const tdengine = require('../../../../runtime/storage/tdengine/index.js');

describe('TDengine getDaqValue disconnect semantics (A-07)', () => {

    it('returns empty array when disconnected, does not reject', function () {
        // 构造一个 disconnected 状态的实例（不连接真实 TDengine）
        const storage = new tdengine.TDengineStorage();
        // 模拟断开状态
        storage.connected = false;
        storage.conn = null;

        return storage.getDaqValue('some.tag', Date.now() - 3600000, Date.now())
            .then(result => {
                expect(result).to.deep.equal([]);
            })
            .catch(err => {
                // 如果走到这里，说明还是 reject，测试失败
                throw new Error('Expected resolve([]), got reject: ' + err.message);
            });
    });

});
```

**对照实验**（必须做，记录在账里）：
1. 临时将 `resolve([])` 改回 `reject(new Error('not connected'))`
2. 运行测试 → 必须失败（证明守卫有效）
3. 改回 `resolve([])`
4. 运行测试 → 必须通过（证明修复正确）

---

## 4. 验证清单

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| TDengine 断开读不抛 | 运行新建的 `disconnect-read.test.js` | 通过 |
| TDengine 断开读返回空数组 | 同上 | `result === []` |
| 守卫反向验证 | 临时改回 reject → 跑测试 → 改回 resolve | 失败 → 通过 |
| errorSemantics 绿灯 | `npm test`（Docker 容器运行） | errorSemantics 通过 |
| 同族一致性 | 检查 5 个后端的 getDaqValue | 全部 resolve([]) 或等效 |
| lint | `npx eslint server/runtime/storage/tdengine/` | exit 0 |
| ng build | `npx ng build` | exit 0 |

---

## 5. 不做的

- 不改 TDengine 写入路径（`:92-95` 已经是正确写法）
- 不改其他后端的写入路径
- 不新建 DAQ 存储表或修改存储契约
- 不改前端代码

---

## 6. 预期结果

- `errorSemantics.test.js` 绿灯
- `gate` 全绿（932 passing / 0 failing）
- 回退点快照刷新
- 90-A / 90-B / 90-C 全部结案

---

*本任务卡为最终版本，执行方按 §2-§4 一次性完成。对照实验必须做，账里记录实验输出。*
