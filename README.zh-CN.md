# WenChat

[English](./README.md) · [更新日志](./CHANGELOG.md) · [许可证](./LICENSE)

> **局域网 P2P 终端聊天工具：mDNS 自动发现 + WebRTC 直连，无服务器、无 STUN/TURN、无云中继。**

[![license](https://img.shields.io/github/license/dkisser/wenchat?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![bun](https://img.shields.io/badge/bun-%E2%89%A51.1-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
![typescript](https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)
![tui](https://img.shields.io/badge/tui-ink-61dafb?style=flat-square&logo=react&logoColor=white)
![transport](https://img.shields.io/badge/transport-webrtc_--_data_channel-333333?style=flat-square)
![discovery](https://img.shields.io/badge/discovery-mdns_--_bonjour-0078d4?style=flat-square)

两台机器在同一个 Wi-Fi、有线或 VPN 里，打开两个终端，敲一行命令就能聊——不依赖公网、不需要登录、不上传任何消息。文本支持 Markdown 渲染，可以互发文件，可以双击消息复制原文，按下 `Ctrl+T` 切换鼠标选择模式。

## 目录

- [特性](#特性)
- [预览](#预览)
- [安装](#安装)
- [快速开始](#快速开始本地开发)
- [Slash 命令](#slash-命令)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [配置](#配置)
- [开发](#开发)
- [贡献](#贡献)
- [安全](#安全)
- [许可证](#许可证)

## 特性

**通信**

- 🔍 **mDNS / Bonjour 自动发现** —— 同网段打开即看到彼此，无需输入 IP
- 🔗 **WebRTC DataChannel 直连** —— 纯 P2P，无 STUN / TURN、无中继服务器
- 🛡️ **DTLS in-transit** —— 链路层加密，应用层纯文本（数据通道本身就是明文 SCTP）
- 💓 **应用层心跳** —— 2 s ping / 4 s 超时，自动 pong，链路断开自动清理

**聊天体验**

- ✍️ **Markdown 渲染** —— 标题、列表、引用、代码块（带 `cli-highlight` 语法高亮）、粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 分隔线 / 图片
- 📋 **双击复制** —— 鼠标指向消息行，双击即复制原文到剪贴板；状态栏右侧 2 秒 toast 提示
- 📑 **`/copy [n]` 命令** —— 1-based 倒数第 n 条文本消息，文件 / ping / pong 不计数
- ⌨️ **`/mouse` 命令**（或 `Ctrl+T`）—— 一键切换 SGR 鼠标模式（`?1000h` + `?1006h`），退出 / 终端恢复时自动关闭
- 🧭 **`Tab` 补全** —— 输入 `/fi` 自动补全为 `/file`，再按 `Tab` 加空格提示参数

**文件传输**

- 📎 **`/file <path>`** —— 通过 DataChannel 发送任意本地文件
- 🧩 **分块传输** —— 16 KiB / chunk，起始消息携带 32-bit checksum
- 🗂️ **冲突安全保存** —— 默认存到 `~/Downloads/`，自动用 `foo (1).md`、`foo (2).md` 避让同名文件

**网络弹性**

- 🌐 **多网卡启动选择器** —— 启动时列出本机可绑定地址（LAN / loopback / `0.0.0.0`），`↑/↓ + Enter` 选择
- 🚇 **非 TTY 自动降级** —— 输出被重定向（`> out.log`、CI、SSH 不带 TTY）时跳过选择器，沿用检测到的局域网 IPv4
- 🎯 **`/connect <host:port>`** —— 手动拨打任意信令端点（mDNS 找不到时兜底）

**终端工程**

- 🖼️ **VT100 alt-screen** —— 进入全新背景，退出（`/exit` 或 `Ctrl+C`）后自动恢复原 shell 历史，无残影
- 🪟 **SIGWINCH 自适应** —— 终端尺寸变化时自动重排
- 💾 **持久命令历史** —— `~/.wechat/.wechat_history`，原子写入，上限 100 条
- 🚦 **稳定性保护** —— 已连接时再次选择 peer 会提示「已连接，请先 `/disconnect`」

## 预览

```
┌─ Status ──────────────────────────────────┐
│ Online • alice (192.168.1.42:9001)        │
└───────────────────────────────────────────┘

┌─ Peers ──────────────┐  ┌─ Chat ────────────────────────────────────┐
│ > alice (you)         │  │ [11:23] [peer] 这是一条 **Markdown** 测试 │
│   bob (192.168.1.50)  │  │             *斜体*  `行内代码`             │
│   carol               │  │            > 引用块                      │
│                       │  │             1. 有序列表                   │
│                       │  │             2. 第二项                     │
│                       │  │             ```ts                        │
│                       │  │             const x: number = 42;        │
│                       │  │             ```                         │
│                       │  │ [11:24] [system] File received: foo.md  │
└───────────────────────┘  └──────────────────────────────────────────┘

> /help
```

## 安装

终端用户无需安装 Node.js、Bun 或其他运行时 —— wenchat 以单一可执行文件分发，内部已嵌入 Node 运行时与所有依赖。**不需要 `npm install`**。

### 一行安装（Linux / macOS）

```sh
curl -fsSL https://raw.githubusercontent.com/dkisser/wenchat/main/scripts/install.sh | bash
```

脚本自动识别平台（Linux x86_64 或 Apple Silicon），下载对应二进制并安装到
`$HOME/.local/bin/wenchat`（无需 `sudo`）。若该目录不在你的 `$PATH`，
安装脚本会提示需要追加到 shell rc 的那一行。

### 一行安装（Windows / PowerShell）

```powershell
iwr -useb https://raw.githubusercontent.com/dkisser/wenchat/main/scripts/install.ps1 | iex
```

安装到 `%USERPROFILE%\bin\wenchat.exe` 并自动把该目录追加到用户
`PATH`。完成后请重启 PowerShell。

### 直接下载

从 [最新发布](https://github.com/dkisser/wenchat/releases/latest) 页
挑选与你平台对应的二进制。文件名遵循 `wenchat-v<version>-<platform>[.exe]`
模式（例如 `wenchat-v0.1.0-linux-x64`）。

| 平台 | 架构 |
| --- | --- |
| Linux | x86_64 |
| macOS | Apple Silicon（arm64） |
| Windows | x64 |

Linux / macOS 上：`chmod +x wenchat-*` 后移到 `$PATH` 任意目录。Windows
上：直接双击运行，或放到 `PATH` 中。

### 升级已有安装

```sh
wenchat upgrade              # 下载最新 release 并原地替换
wenchat upgrade --check-only # 仅检查，输出是否有新版本
```

`upgrade` 子命令查询 GitHub API 的最新 release，识别你的平台，下载
对应资源，**原子替换**当前运行的二进制。**Windows 是例外**——
新文件会暂存在旧文件旁边（运行中的 `.exe` 无法被覆盖），脚本会
打印一行手动替换的提示。

### 首次运行说明（macOS / Windows）

未签名的二进制会触发一次性的系统提示：

- **macOS Gatekeeper**：在 Finder 里右键二进制 → 打开 → 确认。
  之后静默运行。
- **Windows SmartScreen**：点击「更多信息」→「仍要运行」。
  之后静默运行。

`deno` / `bun` / `hugo` / `rustup` 等未签名 CLI 工具都是这个流程。
wenchat 不附带 Apple Developer ID 或代码签名证书 —— 它是 CLI 工具，
不是图形化 app。

## 快速开始（本地开发）

> 终端用户请参考上面的 [安装](#安装) 一节。本节面向 wenchat 自身的
> 贡献者与本地调试。

### 前置

- **Node.js ≥ 20**（macOS / Linux / Windows；**不要用 Bun 跑 CLI**——见下方说明）
- **Bun ≥ 1.1**（驱动 install / build / test）

### 安装

```bash
bun install
```

### 运行

在终端 A：

```bash
bun run cli alice
```

在终端 B：

```bash
bun run cli bob
```

无需配置即可看到对方出现在 peer 列表中，`↑/↓ + Enter` 连接即可开始聊天。

> 第一个位置参数（`alice` / `bob`）是 wenchat 在局域网内的对等节点昵称（mDNS 服务实例名），**不会修改本机系统主机名**。若 macOS 系统设置里弹出「名称已更改」提醒，那是 mDNSResponder 把 Bonjour 服务名反射回共享视图，与 wenchat 无关。

### 选择监听地址

多网卡机器（Wi-Fi + 有线 + VPN + 容器网桥）启动时会列出所有可绑定地址：

```
┌────────────────────────────────────────────────────────────┐
│ Select bind address (port: auto)                           │
│ > 192.168.1.42 (en0)                                       │
│   127.0.0.1 (lo0)  local only — LAN peers cannot reach you │
│   0.0.0.0  all interfaces                                  │
│ ↑↓ navigate · Enter to confirm                             │
└────────────────────────────────────────────────────────────┘
```

也可直接传地址跳过选择：

```bash
bun run cli alice 9001 192.168.1.42
```

输出被重定向时（`bun run cli alice > out.log`）自动沿用检测到的局域网 IPv4，不会弹出选择器。

## Slash 命令

输入 `/` 开头任意行即可触发。`Tab` 补全命令名。

| 命令 | 说明 |
| --- | --- |
| `/exit` | 退出 wenchat（关闭 pc、停止 mDNS、释放 alt-screen 与鼠标模式） |
| `/disconnect` | 仅断开当前 WebRTC 会话，保留进程以便重连 |
| `/mouse` | 切换 SGR 鼠标跟踪（与 `Ctrl+T` 等价） |
| `/file <path>` | 通过 DataChannel 发送本地文件 |
| `/help` | 列出全部命令 |
| `/connect <host:port>` | 手动拨打任意信令端点 |
| `/copy [n]` | 复制倒数第 `n` 条文本消息（默认 `n=1`） |

输入框支持：

- `↑` / `Ctrl+P` 上一条历史，`↓` / `Ctrl+N` 下一条；越过最新条目恢复草稿
- `Tab` 补全命令名，再按一次 `Tab` 加空格提示参数
- SGR 鼠标事件会被自动剥离，滚轮滚动不会污染输入

## 技术栈

| 角色 | 技术 |
| --- | --- |
| 包管理 / 构建 / 测试 | Bun（workspace + test runner） |
| CLI 运行时 | Node.js ≥ 20（通过 `tsx` 执行 `.ts` / `.tsx`） |
| 终端 UI | [Ink](https://github.com/vadimdemedes/ink) + React 18 |
| 渲染管线 | `marked`（GFM 关闭）→ `cli-highlight` → SGR 字符串 → `wrap-ansi` |
| 传输 | [`werift`](https://github.com/shinyoshiaki/werift)（纯 JS WebRTC，DataChannel） |
| 自动发现 | [`bonjour-service`](https://github.com/onuteam/bonjour-service)（mDNS） |
| 信令 | 进程内 `http.createServer`，仅暴露 `POST /offer` 和 `POST /candidate` |
| 代码规范 | TypeScript strict + Biome |

### 为什么 CLI 跑在 Node 而不是 Bun？

`multicast-dns` 在 Bun 上 dgram bind 失败时会绕过 `uncaughtException` 直接终止进程（macOS 上的已知 bug，详见 commit `d02de50`）。CLI 因此切到 Node；Bun 仅负责 install / build / test，避开运行时的兼容性坑。

## 项目结构

```
wenchat/
├── apps/
│   └── cli/                 @wenchat/cli  — Ink TUI 入口
├── packages/
│   ├── protocol/            @wenchat/protocol — 共享消息/分块类型与序列化
│   ├── core/                @wenchat/core — WebRTC / mDNS / 信令 / 心跳
│   └── ui/                  @wenchat/ui — 可复用的 Ink 组件
├── docs/                    内部设计文档
├── scripts/                 smoke-lan-bind.ts 等开发期脚本
├── biome.json               Lint / format 配置
└── bunfig.toml              Bun 配置
```

## 配置

CLI 仅通过位置参数配置，**不读环境变量**。

```bash
bun run cli <nickname> [signalingPort] [signalingHost]
```

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `nickname` | mDNS TXT 字段中的展示名（不会修改本机主机名） | `user-<random>` |
| `signalingPort` | 信令 HTTP 端口（`0` = 操作系统分配） | `0` |
| `signalingHost` | 显式绑定地址（交互式启动时省略 → 弹出选择器） | — |

可选 flag：

- `--no-mouse` —— 禁用 SGR 鼠标跟踪（终端不支持 SGR 时使用）

剪贴板行为：先尝试原生工具（`pbcopy` / `clip.exe` / `wl-copy` / `xclip` / `xsel`），都没有就降级到 OSC 52 直写 stdout（iTerm2 需要在 Preferences → Advanced 打开 "Allow clipboard read/write from shell"）。

## 开发

```bash
# 全部单元 + 集成测试（Bun test runner）
bun test

# 单独跑某个包的测试
bun --filter '@wenchat/core' test

# 类型检查 + 编译
bun run build

# Lint / format
bun run lint
bun run format

# 信令 bind 回归检查
bun scripts/smoke-lan-bind.ts
```

集成测试会把两个 `PeerConnection` 架在 `127.0.0.1` 上用 `setInterval` 轮询，单测慢启动属预期（~5 s 超时）。

## 贡献

提交遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat(scope): …` / `fix(scope): …` / `chore: …`）。改动前请：

1. `bun test` 跑通
2. `bun run lint` 通过
3. 信令或 bind 相关改动跑一遍 `bun scripts/smoke-lan-bind.ts`

Bug 与功能请求走 [Issues](https://github.com/dkisser/wenchat/issues)。

## 安全

请阅读 [SECURITY.md](./SECURITY.md)。安全敏感问题**不要**公开提 issue，通过 GitHub Security Advisories 或邮件私下报告。

## 许可证

[MIT](./LICENSE) © 2026 dkisser
