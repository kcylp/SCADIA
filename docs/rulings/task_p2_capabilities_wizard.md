# 批次 P2：默认功能启用向导

**严重度**：P2 — 5 个完整功能默认关闭，用户感知为"不存在"  
**执行方**：DeepSeek  
**预计工期**：3-5 天  
**依赖**：无

---

## 1. 问题定义

以下 5 个功能**代码完整实现**，但默认关闭，用户看不到、用不了：

| 功能 | 状态 | 代码位置 | 默认值 |
|------|------|----------|--------|
| Node-RED 集成 | 20 个专用节点 + `/flows` 编辑器页面 | `integrations/node-red/` | `nodeRedEnabled: false` |
| GB28181 国标级联 | 完整 SIP 协议栈 | `runtime/cameras/gb28181/` | `gb28181.enabled: false` |
| AI 视频分析 | 检测框叠加 + 报警联动 | `runtime/cameras/ai/` | `ai.enabled: false` |
| OPC UA Server | 对外发布工程数据 | `runtime/opcua-server/` | `opcuaServer.enabled: false` |
| JWT 鉴权 | 登录 + 角色权限 | `api/auth/` + `client/src/app/auth/` | `secureEnabled: false（注释掉）` |

**问题**：
1. 用户安装后不知道这些功能存在
2. 没有启用向导、没有提示
3. 等于代码写了，但用户感知为"不存在"

---

## 2. 交付物

### 2.1 新增组件：`capabilities-wizard.component.ts`

**路径**：`client/src/app/settings/capabilities-wizard/`

**功能**：一个 5 步向导，引导用户启用/配置这些功能。

**步骤**：
```
步骤 1：欢迎页
  - 标题："发现 SCADIA 的更多能力"
  - 说明："检测到 5 个可用功能未启用，点击下一步了解"
  - 按钮：[下一步]

步骤 2：Node-RED 集成
  - 说明："20 个专用节点，可视化编排数据流"
  - 开关：启用 / 禁用
  - 配置项（启用后显示）：
    - Node-RED 服务地址（默认 http://localhost:1880）
    - 认证模式（secure / unsafe）
  - 按钮：[上一步] [下一步]

步骤 3：GB28181 国标级联
  - 说明："接入海康/大华等 GB28181 摄像头"
  - 开关：启用 / 禁用
  - 配置项（启用后显示）：
    - SIP 服务器地址
    - 端口（默认 5060）
    - 设备 ID
  - 按钮：[上一步] [下一步]

步骤 4：AI 视频分析
  - 说明："AI 检测框叠加 + 报警联动"
  - 开关：启用 / 禁用
  - 配置项（启用后显示）：
    - 检测引擎地址（MQTT/WebSocket/HTTP）
    - 最小置信度（默认 0.5）
    - 检测标签（如 person, car, fire）
  - 按钮：[上一步] [下一步]

步骤 5：OPC UA Server
  - 说明："把工程数据发布成 OPC UA 地址空间，供第三方 MES/HMI 读取"
  - 开关：启用 / 禁用
  - 配置项（启用后显示）：
    - OPC UA 端口（默认 4840）
    - 安全模式（None / Sign / SignAndEncrypt）
  - 按钮：[上一步] [完成]

完成页：
  - 显示已启用的功能列表
  - 按钮：[关闭] [重启服务]（提示"部分功能需要重启生效"）
```

---

### 2.2 修改 settings.default.js

**文件**：`server/settings.default.js`

**改动**：在默认配置里加上 `capabilitiesWizardCompleted: false`

```js
capabilitiesWizardCompleted: false,  // 是否已完成能力发现向导
```

**作用**：首次启动时，如果 `capabilitiesWizardCompleted === false`，自动弹出向导。

---

### 2.3 修改 client/src/app/app.component.ts

**文件**：`client/src/app/app.component.ts`

**改动**：在 `ngOnInit()` 里检查 `capabilitiesWizardCompleted`，如果为 false 则弹出向导对话框。

```typescript
ngOnInit() {
  // ... 现有代码 ...

  // 检查是否已完成能力发现向导
  const wizardCompleted = localStorage.getItem('capabilitiesWizardCompleted');
  if (!wizardCompleted) {
    setTimeout(() => {
      this.dialog.open(CapabilitiesWizardComponent, {
        width: '800px',
        maxWidth: '90vw',
        disableClose: true
      }).afterClosed().subscribe(result => {
        if (result?.completed) {
          localStorage.setItem('capabilitiesWizardCompleted', 'true');
        }
      });
    }, 2000); // 延迟 2 秒，等主界面加载完
  }
}
```

---

### 2.4 修改 client/src/app/app.module.ts

**文件**：`client/src/app/app.module.ts`

**改动**：导入 `CapabilitiesWizardComponent` 和 `MatDialogModule`（如果未导入）。

```typescript
import { CapabilitiesWizardComponent } from './settings/capabilities-wizard/capabilities-wizard.component';

@NgModule({
  declarations: [
    // ... 现有声明 ...
    CapabilitiesWizardComponent
  ],
  imports: [
    // ... 现有导入 ...
    MatDialogModule
  ]
})
```

---

## 3. 向导配置持久化

用户完成向导后，配置写入 `settings.js`（通过 REST API）：

```
POST /api/settings
{
  "nodeRedEnabled": true/false,
  "gb28181": { "enabled": true/false, ... },
  "ai": { "enabled": true/false, ... },
  "opcuaServer": { "enabled": true/false, ... },
  "secureEnabled": true/false,
  "capabilitiesWizardCompleted": true
}
```

前端调用：
```typescript
this.appService.updateSettings(settings).subscribe(() => {
  // 提示用户重启服务
});
```

---

## 4. 验证清单

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 向导首次启动弹出 | 清空 localStorage → 重启服务 → 打开浏览器 | 2 秒后弹出向导 |
| 向导不再弹出 | 完成向导 → 重启服务 → 打开浏览器 | 不再弹出 |
| Node-RED 启用 | 向导中启用 → 重启服务 → 访问 `/flows` | 看到 Node-RED 编辑器 |
| GB28181 启用 | 向导中启用 → 重启服务 → 访问 `/cameras` | 看到 GB28181 配置页 |
| AI 视频启用 | 向导中启用 → 重启服务 → 访问 `/video` | 看到 AI 检测框配置 |
| OPC UA Server 启用 | 向导中启用 → 重启服务 → 访问 `/api/opcua-server/status` | 状态显示 "running" |
| JWT 鉴权启用 | 向导中启用 → 访问 `/api/signin` | 返回 JWT token |
| 配置持久化 | 完成向导 → 重启服务 → 检查 `settings.js` | 配置保留 |
| 门禁 | `npm test` | 无新失败 |
| lint | `npx eslint client/src/app/settings/` | exit 0 |

---

## 5. 不做的

- 不改现有功能代码（Node-RED/GB28181/AI/OPC UA/JWT 已经完整）
- 不改 `settings.default.js` 的默认值（保持 `false`，通过向导引导用户启用）
- 不做强制启用（用户可以选择跳过向导）

---

## 6. 界面原型（文字描述）

```
┌──────────────────────────────────────────────────────────────┐
│  ⚙️ 发现 SCADIA 的更多能力                                    │
│                                                              │
│  检测到 5 个可用功能未启用：                                   │
│                                                              │
│  ○ Node-RED 集成（20 个专用节点）                              │
│  ○ GB28181 国标级联                                         │
│  ○ AI 视频分析                                               │
│  ○ OPC UA Server（对外发布）                                   │
│  ○ JWT 鉴权                                                  │
│                                                              │
│  这些功能需要额外配置才能使用。                                 │
│  点击 [下一步] 了解每个功能，选择要启用的。                      │
│                                                              │
│  [跳过向导]                                    [下一步 →]     │
└──────────────────────────────────────────────────────────────┘
```

---

*本任务卡为最终版本，执行方按 §2-§5 一次性完成。*
