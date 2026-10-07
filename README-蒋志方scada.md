# 开诚智枢scada

基于 [SCADIA](https://github.com/kcylp/SCADIA)（基线 commit `566f65f`）二次开发的开源 SCADA 平台，
按照《SCADIA calibration 标定模块完整设计》实现了完整的传感器标定工作流。

## 已实现内容（对应设计文档）

| 设计文档章节 | 实现 |
|---|---|
| §5 后端结构 | `server/runtime/calibration/`（storage / sample-engine / fit-engine / write-planner / write-coordinator / register-codec / locks / validators / audit / service）+ `server/api/calibration/` |
| §9 SQLite | `_appdata/calibration.db`，含 schema 版本表、Profile/Session/Point/Sample/审计表、事务与乐观锁 |
| §10 采样引擎 | 定时采样、过期/空值/非有限/重复时间戳过滤、MAD(Hampel) 异常剔除、均值/中位数/标准差/极差/CV、稳定性门槛、超时与取消（无遗留定时器） |
| §11 拟合引擎 | 最小二乘 `y = kx + b`（k=gain, b=offset）、R²/RMSE/最大绝对误差/残差表、质量门槛、fitHash 绑定 |
| §12 写回 | Tag 模式（setTagValue + 回读 + 逆序回滚）与 Raw Block 模式（受限原始保持寄存器 FC16 接口 + 白名单 + 显式字序 codec：ABCD/BADC/CDAB/DCBA/ABCDEFGH/BADCFEHG/CDABGHEF/GHEFCDAB/HGFEDCBA） |
| §13 权限 | view/operate/approve/write/admin 映射 SCADIA 组；insecure 模式仅可查看（CAL_SECURITY_DISABLED） |
| §14 REST API | `/api/calibration/*` 全套，稳定错误码、Idempotency-Key 幂等、revision 乐观锁 |
| §15 Socket.IO | `calibration:*` 事件（采样进度/完成/错误、拟合、写入、取消），仅推送给已认证客户端 |
| §17 前端 | 标定列表页 + 标定工作台（实时采样进度、样本表、标定点表、拟合卡、写回确认、审计表），中英文 |
| §21 测试 | `server/test/calibration/`：fit-engine 10 项、register-codec 7 项、sample-engine 6 项 |

## 运行

```bash
# 服务端（端口 1881）
cd server
npm install --registry=https://registry.npmjs.org/
npm start

# 前端（首次需要构建）
cd client
npm install --registry=https://registry.npmjs.org/
npm run build          # 产物输出到 client/dist，由服务端直接托管
```

访问 <http://localhost:1881>，默认管理员：**admin / 123456**。

编辑器右上角「设置 → 标定」进入标定列表；直接访问 `http://localhost:1881/#/calibrations` 亦可。

## 配置（server/_appdata/settings.js）

- `secureEnabled: true` — 安全模式（当前已开启；关闭后标定模块自动变为只读）
- `calibration.writeEnabled` — 设备写回总开关（当前已开启，仍需安全模式 + 审批 + 一次性确认令牌）
- `calibration.rawWriteEnabled` + `rawWriteAllowlist` — 原始寄存器块写回（默认关闭，需显式白名单）
- `secretCode` — JWT 签名密钥（已配置，保证重启后会话不失效）

## 状态机

`draft → sampling → ready → fitted → awaiting-approval → approved → writing → verifying → applied / failed / uncertain`

- 批准绑定 `sessionId + revision + fitHash`，默认 10 分钟过期
- `apply` 需一次性确认令牌 + 幂等键；写前快照先持久化、写后回读、失败可回滚、结果不可确认时进入 `uncertain`
- 服务重启自动恢复：采样中→ready，写入/验证中→uncertain，过期审批退回 awaiting-approval

## 测试

```bash
cd server
npx mocha test/calibration/*.test.js   # 23 项单元测试
```

## 与上游的差异

- 产品更名为 开诚智枢scada（页面标题、package 名称、设置菜单入口）
- 新增标定模块（后端 + 前端 + 测试），未修改 Modbus 轮询主流程
- `server/runtime/devices/modbus/index.js` 新增受限 `readRawHoldingRegisters / writeRawHoldingRegisters`（仅标定模块内部使用，不对外注册 API）
