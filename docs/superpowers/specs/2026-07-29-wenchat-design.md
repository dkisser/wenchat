# WenChat 设计文档

**日期**：2026-07-29  
**主题**：局域网内基于 WebRTC 的终端 P2P 通讯客户端  
**状态**：待实现

---

## 1. 概述

WenChat 是一个运行在终端（TUI）内的局域网 P2P 通讯工具，支持：

- 文字聊天
- 文件传输
- 基于 mDNS 的自动发现
- 一对一 WebRTC 数据通道连接

项目采用 **Bun workspace monorepo** 结构，运行时仍为 **Node.js**，使用 **Biome** 统一代码格式与检查。

---

## 2. 目标

- 在局域网内实现“零配置”发现对端并建立连接
- 提供可交互的终端界面（TUI）
- 支持稳定的文字聊天与文件传输
- 核心逻辑与 UI 解耦，便于测试和复用
- 代码覆盖率不低于 80%

## 3. 非目标

- 跨 NAT/公网中继（本项目仅限局域网）
- 多人群聊（第一阶段只支持一对一）
- 端到端身份验证（默认信任局域网内 peer，后续可扩展 PIN 码）
- 持久化聊天记录

---

## 4. 技术选型

| 层级 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js | 兼容成熟 WebRTC 库，保持与现有生态一致 |
| 包管理/构建 | Bun | 安装与构建速度快，支持 workspace |
| WebRTC | `werift-webrtc` | 纯 TypeScript 实现，无原生依赖，Bun 友好 |
| 局域网发现 | `bonjour-service` | 纯 JS 的 mDNS/Bonjour 实现，跨平台一致 |
| TUI | `ink` | React 风格组件，TypeScript 友好，维护活跃 |
| 序列化 | JSON + 二进制 buffer | 聊天用 JSON，文件传输用二进制 chunk |
| 日志 | `pino` | 结构化日志，支持文件落盘 |
| 格式化/Lint | `biome` | 用户指定，统一配置 |

---

## 5. 仓库结构

```text
wenchat/
├── apps/
│   └── cli/
│       ├── package.json
│       └── src/
│           ├── main.tsx      # 入口，解析命令行参数
│           └── App.tsx       # ink 根组件
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── discovery.ts  # mDNS 服务发布与浏览
│   │       ├── peer.ts       # WebRTC peer 封装
│   │       ├── signaling.ts  # 轻量 HTTP 信令端点
│   │       └── transport.ts  # 数据通道发送/接收
│   ├── protocol/
│   │   └── src/
│   │       ├── message.ts    # 消息类型与 envelope
│   │       ├── codec.ts      # 序列化/反序列化
│   │       └── file.ts       # 文件分片与重组协议
│   └── ui/
│       └── src/
│           ├── ChatView.tsx
│           ├── InputBox.tsx
│           ├── PeerList.tsx
│           └── StatusBar.tsx
├── biome.json
├── bunfig.toml
├── package.json              # workspace 配置
└── tsconfig.json
```

---

## 6. 核心组件

### 6.1 DiscoveryService

- 通过 mDNS 发布 `_wenchat._tcp.local` 服务
- 浏览同类型服务，维护在线 peer 列表
- 每个 peer 携带：ID、显示名、信令端点地址

### 6.2 SignalingServer

- 每个 peer 启动一个轻量 HTTP server
- 提供两个端点：
  - `POST /offer`：接收并返回 answer
  - `POST /candidate`：交换 ICE candidate
- 信令完成后，连接走 WebRTC 数据通道

### 6.3 PeerConnection

- 封装 `werift-webrtc` 的 `RTCPeerConnection`
- 创建/管理 `RTCDataChannel`
- 处理 ICE candidate、连接状态变化

### 6.4 DataTransport

- 在 DataChannel 上发送/接收消息
- 处理背压与连接断开重连

### 6.5 ProtocolCodec

- 定义消息 envelope：`{ type: 'text' | 'file-start' | 'file-chunk' | 'file-end', payload, id, timestamp }`
- 编码为 JSON 或二进制 buffer
- 校验消息边界与类型

### 6.6 FileTransfer

- 发送端：读取文件 → 分片 → 按序发送
- 接收端：缓存 chunk → 校验 → 写入目标路径
- 记录传输进度，支持取消

---

## 7. 数据流

### 7.1 连接建立

1. 启动 `DiscoveryService`，发布本机服务并浏览其他 peer
2. 用户从 UI 选择一个 peer
3. 发起方通过 HTTP 向对端 `/offer` 发送 SDP offer
4. 接收方返回 SDP answer
5. 双方通过 `/candidate` 交换 ICE candidate
6. WebRTC 数据通道建立，HTTP 信令端点可关闭或保留备用

### 7.2 消息发送

```
用户输入 ──► ui/App.tsx
              │
              ▼
         core/DataTransport.send(message)
              │
              ▼
         protocol/codec.encode(message)
              │
              ▼
         werift DataChannel ──► 对端 Peer
              │
              ▼
         对端 protocol/codec.decode
              │
              ▼
         对端 ui/ChatView 渲染
```

### 7.3 文件传输

- 发送前发送 `file-start` 消息，包含文件名、大小、chunk 大小、校验和
- 逐片发送 `file-chunk` 消息
- 发送 `file-end` 消息，接收端校验并落盘

---

## 8. 错误处理

| 场景 | 处理策略 |
|---|---|
| mDNS 服务启动失败 | 提示用户，降级为手动输入对端 IP:端口 |
| 未发现任何 peer | UI 显示扫描状态，支持手动刷新或手动输入 |
| WebRTC 连接失败 | 重试 2 次，失败后断开并提示，记录日志 |
| 数据通道意外关闭 | 尝试重建连接，UI 显示离线状态 |
| 文件传输中断 | 提示已接收进度，清理临时文件 |
| 收到无法解析的消息 | 记录错误，不崩溃，UI 显示异常 |
| 对端拒绝连接 | 友好提示，不重试 |

日志写入 `~/.wenchat/logs/wenchat-<date>.log`，默认级别 `info`，`--verbose` 开启 `debug`。

---

## 9. 安全边界

- mDNS 和 HTTP 信令只在局域网内暴露
- HTTP 信令端点绑定局域网接口，不监听 `0.0.0.0`
- WebRTC 数据通道通过 DTLS 加密
- 第一阶段不验证用户身份，后续可扩展 PIN 码机制

---

## 10. 测试策略

### 10.1 单元测试

- `protocol/codec`：编码/解码、非法 payload、边界情况
- `protocol/file`：分片、重组、校验和
- `core/transport`：模拟 DataChannel 测试发送/接收/背压
- `core/discovery`：模拟 mDNS 测试服务发布与浏览

### 10.2 集成测试

- 启动两个 `core` 实例，用内存信令通道交换 SDP
- 验证数据通道建立与双向消息收发
- 文件端到端传输后校验文件哈希一致

### 10.3 E2E 测试

- 启动两个 CLI 进程
- 通过脚本输入文字消息
- 验证 TUI 输出包含预期内容

### 10.4 测试约定

- 测试文件与源码同目录，命名 `*.test.ts`
- 外部依赖默认 mock
- 临时文件使用 `tmpdir`，测试后清理

---

## 11. 实现顺序

1. 搭建 monorepo 与 Biome 配置
2. 实现 `protocol` 包（消息定义与 codec）
3. 实现 `core` 包的 `DiscoveryService` 与 `SignalingServer`
4. 实现 `core` 包的 `PeerConnection` 与 `DataTransport`
5. 实现 `protocol` 文件传输逻辑
6. 实现 `ui` 组件与 `apps/cli` 入口
7. 集成测试与 E2E 测试
8. 文档与使用说明

---

## 12. 待确认事项

无。所有关键技术选型与架构已在本设计文档中确认。
