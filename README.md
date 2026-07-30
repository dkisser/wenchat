# WenChat

局域网内基于 WebRTC 的终端 P2P 通讯工具。

## 功能

- 文字聊天
- 文件传输
- mDNS 自动发现局域网 peer
- 终端交互界面（TUI）

## 技术栈

- Node.js（CLI 运行时 — Bun 在 macOS 上对 `multicast-dns` 的 dgram bind 错误处理有 bug，会绕过 uncaughtException 直接终止进程）
- Bun（包管理/构建/测试）
- `werift`
- `bonjour-service`
- `ink`
- `tsx`（直接运行 .ts/.tsx 源码）
- Biome

## 安装

```bash
bun install
```

## 运行

在终端 A：

```bash
bun run cli alice
```

在终端 B：

```bash
bun run cli bob
```

> 第一个位置参数（`alice` / `bob`）是 wenchat 在局域网内的对等节点昵称（mDNS 服务实例名），**不会修改本机系统主机名**。如果系统设置或终端提示出现"名称已更改"的提醒，那是 macOS mDNSResponder 把 Bonjour 服务名反射回共享/网络视图，与 wenchat 代码无关。

> wenchat TUI 使用 VT100 alternate screen buffer（与 `vim` / `htop` / `less` 等相同）：进入时切换到全新背景，**退出（`/exit` 或 Ctrl+C）后自动恢复之前的 shell 历史**，不会留下残影。在非 TTY 环境（如 `bun run cli > out.log`）下自动跳过此行为。

用方向键选择 peer，回车连接，输入文字发送。发送文件：

```
/file /path/to/file.txt
```

## 测试

```bash
bun test
```

## 构建

```bash
bun run build
```

## 项目结构

- `apps/cli` – 终端应用入口
- `packages/protocol` – 共享消息协议和序列化
- `packages/core` – WebRTC 信令、mDNS 发现和网络逻辑
- `packages/ui` – 可复用的终端 UI 组件
