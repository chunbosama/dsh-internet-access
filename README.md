# dsh-internet-access · DSH 公网访问插件

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.1--rc.2-purple.svg)](https://github.com/deepseek-ai/deepseek-harness)

> 一键把 DeepSeek Harness 的 Web GUI 暴露到互联网：Cloudflare quick tunnel（免费、无账号、无域名）+ 简单访问口令门禁。

**没有扫码配对、没有设备令牌、没有配队功能**——这是与 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 的 `dsh-remote-web-ui` 最本质的区别：拿掉整套配对机制，只留「隧道 + 口令」。

---

## 目录

- [为什么需要它](#为什么需要它)
- [功能特性](#功能特性)
- [截图预览](#截图预览)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [架构与原理](#架构与原理)
- [API 参考](#api-参考)
- [安全模型](#安全模型)
- [常见问题](#常见问题)
- [开发与调试](#开发与调试)
- [与 dsh-remote-web-ui 的关系](#与-dsh-remote-web-ui-的关系)
- [许可](#许可)

---

## 为什么需要它

DeepSeek Harness 的 `dsh web` GUI 默认只绑定 `127.0.0.1`，你在家/在办公室以外就访问不了它。常见的解决思路有：

| 方案 | 问题 |
| --- | --- |
| `--host 0.0.0.0` 直接暴露局域网 | 手机/远程仍进不来公网；且 SDK 对非回环 Host 的 `/api` 有围栏，暴露后需要 `--trusted-host`，绕过配对门禁 |
| 自己搭 frp / ngrok / nginx | 要注册域名、要维护服务、要配证书 |
| 全家桶的 dsh-remote-web-ui | 功能强，但默认开启 `requirePairingForLan` 配对围栏——远程电脑打开会撞「此设备未配对」拦截页，需要扫码配对流程 |

`dsh-internet-access` 只做一件事：**一条命令开隧道，一个口令控访问**。它不引入配对体系，适合「我就想把 GUI 开到公网，分享给信任的几个人」的场景。

---

## 功能特性

- 🚀 **一键公网隧道**：设置页卡片点「开启公网访问」→ Cloudflare quick tunnel 自动启动（`cloudflared` 二进制随包分发，无账号/无域名/无配置），崩溃按指数退避自动重启
- 🔑 **简单访问口令门禁**：自动生成强随机口令并落盘（`$DSH_HOME/public-access-token.json`，0600 权限）；非本机回环来源打开 GUI 先见口令门禁页，输入正确口令才放行
- 🛡️ **口令即凭据**：HttpOnly + SameSite=Lax cookie，有效期一年；重新生成口令后旧 cookie 立即失效
- 🖥️ **设置页卡片（唯一入口）**：隧道启停、公网链接一键复制、口令查看/复制/重新生成，全部在「设置 → 公网访问」完成，不占侧边栏
- 🔀 **/public 门禁通道**：浏览器自动把 `/api`、`/sidebar`、`/git`、`/pet` 改写为 `/public` 通道；host 侧校验口令后以 loopback 形态转发回本机，绕过 SDK 对非回环 Host 的围栏，同时保持 SDK 特权方法（settings/credentials/host 对话框等）仅本机可达
- 📡 **围栏姿态探测**：自动探测 SDK 的 `/api` 围栏是否对公网主机敞开（例如配置了 `--trusted-host` 或 `--host 0.0.0.0`），若敞开则在卡片红色告警
- 🌐 **手动隧道兼容**：配置 `publicBaseUrl` 即可接自建 Cloudflare named tunnel / nginx 反代，无需本插件开隧道
- 📱 **移动端可用**：公网链接在手机浏览器同样可打开（响应式 GUI + 口令门禁）

---

## 截图预览

> 即将补充。卡片位于：**设置 → 公网访问**。

| 设置页卡片 | 公网口令门禁页 |
| --- | --- |
| 隧道状态 / 公网链接 / 启停 / 口令管理 | 非本机打开时的口令输入页 |

---

## 安装

### 方式一：从本仓库（推荐，开发调试）

```sh
git clone https://github.com/chunbosama/dsh-internet-access.git
cd dsh-internet-access
dsh plugin --profile web add link:$(pwd)
```

### 方式二：从 npm

```sh
dsh plugin --profile web add dsh-internet-access
```

### 方式三：手动声明

编辑 `~/.dsh/profiles/web/package.json`，在 `dependencies` 加：

```json
"dsh-internet-access": "github:chunbosama/dsh-internet-access"
```

再把它加入 `dsh.profile.bundles` 数组：

```json
"bundles": [ "...", "dsh-internet-access" ]
```

然后 `cd ~/.dsh/profiles/web && pnpm install`。

> ⚠️ 无论哪种方式，安装后都需**重启 `dsh web`**（或重启桌面端）让插件生效。

---

## 快速开始

1. 重启 `dsh web`，打开 **设置 → 公网访问** 卡片；
2. 点 **「开启公网访问」**——隧道启动后卡片显示公网链接（`https://xxx.trycloudflare.com`），点「复制公网链接」；
3. 把链接和访问口令（卡片「复制」按钮）发给需要访问的人；
4. 对方打开链接 → 输入口令 → 进入完整 Web GUI，所有数据请求经 `/public` 通道加密转发。

停止：本机卡片点 **「停止公网访问」** → 隧道关闭，公网链接立即失效。

---

## 配置说明

所有配置项都在 profile patch（`cordis.patch.yml`）或 `dsh plugin` 安装时的 config 里设置：

```yaml
- id: dsh-internet-access
  name: dsh-internet-access
  config:
    enabled: true            # 主开关（默认 true）
    accessToken: ""          # 访问口令；空 = 自动生成并落盘（推荐）
    requireToken: true       # 非本机访问是否需要口令（默认 true）
    autoTunnel: false        # true = 插件启动即自动开隧道（默认 false）
    publicBaseUrl: ""        # 手动隧道公网地址，如 https://foo.example.com
    cookieName: "dsh_public_access"   # 口令 cookie 名
    tokenFile: ""            # 口令文件路径（默认 $DSH_HOME/public-access-token.json）
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 主开关；false 时不注册任何路由、不启动隧道 |
| `accessToken` | string | `''` | 共享访问口令。留空 = 首次启动自动生成强随机口令并持久化；显式指定后不再自动生成 |
| `requireToken` | boolean | `true` | 是否要求口令。**false = 完全公开**（任何拿到链接的人都能操作 agent，危险） |
| `autoTunnel` | boolean | `false` | 启动插件时自动开公网隧道 |
| `publicBaseUrl` | string | `''` | 手动隧道公网 base URL；设置后卡片展示它，不启用本插件隧道 |
| `cookieName` | string | `dsh_public_access` | 口令 cookie 名 |
| `tokenFile` | string | `''` | 口令持久化文件绝对路径 |

---

## 架构与原理

```
                    ┌──────────────────────────────────────────────┐
 公网浏览器          │                  dsh web（本机）               │
 ┌──────────┐       │  ┌────────────┐    ┌──────────────────────┐   │
 │ 门禁页     │◄──────┼─►│ /public 通道│───►│ 口令校验 → 转发 127.0.0.1│  │
 │ 口令输入   │       │  │ (改写后)    │    │ (Host 重写/丢弃 cookie) │  │
 └──────────┘       │  └────────────┘    └──────────────────────┘   │
      │  HTTPS        │  ┌──────────────────────────────────────┐   │
      ▼ (cloudflared) │  │ /api/public-access/*                  │   │
 ┌──────────────┐     │  │  status/start/stop/verify/authorized │   │
 │ quick tunnel │     │  └──────────────────────────────────────┘   │
 └──────────────┘     └──────────────────────────────────────────────┘
```

- **静态资源**（HTML/JS/CSS）对任何人开放——拿到链接就能加载页面；
- **数据请求**（`/api/*` 等）被浏览器半区改写为 `/public/*`，经口令门禁后才转发回本机 loopback；
- **SDK 围栏**：`dsh web` 对非回环 Host 的 `/api` 默认 403，因此即使绕过门禁页也无法直连数据（除非配了 `--trusted-host`，插件会告警）；
- **特权隔离**：`settings.*`、`credentials.*`、`host.*` 等 SDK loopback-only 方法经 `/public` 通道一律 403。

### 浏览器通道改写

移植自 dsh-remote-web-ui 的 `remote-channel.ts`（Apache-2.0），改动点：

- 前缀 `/remote` → `/public`；
- 配对 cookie 门禁 → 共享口令 cookie 门禁；
- 去掉 `/api/pair/*` 保留逻辑，改为保留 `/api/public-access/*`（门禁探测与口令校验必须直连）；
- 去掉更新端点（`/api/update/*`）等全家桶专属保留。

---

## API 参考

### 控制面（仅本机回环）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/public-access/status` | 隧道状态、公网链接、口令配置、围栏姿态、局域网地址 |
| POST | `/api/public-access/start` | 启动 quick tunnel |
| POST | `/api/public-access/stop` | 停止隧道 |
| POST | `/api/public-access/regenerate-token` | 重生成访问口令（旧 cookie 立即失效） |

### 门禁面（任意来源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/public-access/authorized` | 门禁探测：口令 cookie 有效 → 200；否则 403 `token-required` |
| POST | `/api/public-access/verify` | 校验口令并签发 cookie（门禁页提交） |

### 通道面（经 /public）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| 任意 | `/public/api/*`、`/public/sidebar/*`、`/public/git/*`、`/public/pet/*` | 口令门禁后转发回 127.0.0.1 |
| UPGRADE | `/public/api/events.mux` 等 5 条 | WebSocket 升级通道（事件流 / 终端） |

---

## 安全模型

- **口令是唯一凭据**：任何拿到链接 + 口令的人都能完整操作 agent（bash、文件、凭据）。请只分享给可信的人，并定期「重新生成」口令。
- **cookie 门禁**：口令以 HttpOnly + SameSite=Lax cookie 下发，路径 `/`，有效期一年；重新生成后旧 cookie 立即失效。
- **控制面隔离**：`/api/public-access/*` 控制端点仅本机回环可达；`/public` 通道对它们一律 403。
- **特权面隔离**：SDK 的 loopback-only 方法（`settings.*`、`credentials.*`、`host.pickDirectory`、`llm.discoverModels` 等）经 `/public` 通道一律 403。
- **姿态探测**：若 `--trusted-host` 或 `--host 0.0.0.0` 让 SDK 的 `/api` 围栏对公网主机敞开，卡片红字告警——此时口令门禁只能挡住 UI，挡不住直连 `/api` 的调用方，请移除这些 flag。
- **隧道特性**：quick tunnel 的公网 URL 每次启动随机；隧道重启后需从卡片重新复制链接。Cloudflare 不保证 uptime，且 quick tunnel 不转发 Server-Sent Events（移动端实时推送会降级为轮询，桌面端 WebSocket 不受影响）。

---

## 常见问题

### 公网链接打开后一直转圈 / 显示「此设备未配对」？

本插件没有配对机制。若看到「未配对」拦截页，说明是 **dsh-remote-web-ui（全家桶）** 的 `requirePairingForLan` 围栏在起作用，与本插件无关。请在 `cordis.patch.yml` 禁用它：

```yaml
- id: web-ui-remote-web-ui
  disabled: true
```

### 卡片显示红色「/api 围栏对公网主机敞开」？

你在用 `--trusted-host <域名>` 或 `--host 0.0.0.0` 启动 `dsh web`。这样公网任何人都能绕过口令门禁直连 `/api`。请去掉这些 flag，让本插件的 `/public` 通道承担转发。

### 隧道启动失败 / 没有公网链接？

- 首次使用会下载 cloudflared 平台二进制（约几十 MB），需要网络；
- 检查卡片「失败原因」提示（超时 / 二进制获取失败 / 进程退出）；
- 公司网络/防火墙可能阻止 `trycloudflare.com` 出站，可改用 `publicBaseUrl` 接自建隧道。

### 我想完全公开（不要口令）？

把 `requireToken: false`。**强烈不建议**——任何拿到链接的人都能完整操作 agent。

### 口令忘了？

口令不会以明文展示在卡片上（卡片只提供复制）。若自动生成的口令文件丢失，可在卡片点「重新生成」，或删除 `$DSH_HOME/public-access-token.json` 后重启插件（会自动生成新口令）。

---

## 开发与调试

```sh
cd dsh-internet-access
node --check lib/index.js     # host 半区语法
node --check lib/client.js    # 浏览器半区语法

# 本地安装到 profile（开发模式）
dsh plugin --profile web add link:$(pwd)
```

- host 半区：`lib/index.js`（`name` / `inject` / `Config` / `apply`，cordis 插件约定）
- 浏览器半区：`lib/client.js`（`window.__ModuleLoader__.load({ id, factory })` 约定，由 dsh-client-modules 扫描 `dsh.client` 声明自动挂载）
- 挂载声明：`cordis.patch.yml`（bundle patch，插入单条插件行，双半区一次挂载）

### 依赖

| 包 | 用途 |
| --- | --- |
| `cloudflared` (^0.7.3) | Cloudflare quick tunnel 二进制与进程管理 |
| `@deepseek-ai/schemastery` | DSH 标准配置 schema 校验 |

---

## 与 dsh-remote-web-ui 的关系

本插件**不是** dsh-remote-web-ui 的分支或替代品，而是取其隧道 + 通道思想、砍掉配对的轻量实现：

| | dsh-remote-web-ui | dsh-internet-access |
| --- | --- | --- |
| 公网隧道 | ✅ autoTunnel | ✅ 一键 quick tunnel |
| 扫码配对 | ✅ 二维码/一次性令牌/设备会话 | ❌ **无** |
| 远程桌面门禁 | ✅ `/remote` + 配对 cookie | ✅ `/public` + 口令 cookie |
| 移动端 `/m/` 界面 | ✅ | ❌ 无（手机直接用桌面 GUI） |
| 全家桶自更新 | ✅ | ❌ 无 |
| 侧边栏入口 | ✅ 手机图标 | ❌ 仅设置页卡片 |

---

## 许可

MIT。参考了 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（Apache-2.0）的架构与代码片段，特此致谢。
