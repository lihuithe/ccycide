# Web 版

在浏览器里直接做主控端：打开网页，输入被控端的设备码和密码，就能远程使用那台机器上的终端和 Claude Code。界面与桌面版是同一套 React 代码，协议、服务端、被控端都没有改动。

## 安全模型

- **端到端加密在浏览器里完成**：SPAKE2 口令认证 + ChaCha20-Poly1305，和桌面版一样。服务端（信令、中继、静态文件服务器）只看到密文，看不到终端内容和密码。没有任何“网关”代理。
- **设备私钥只存在本浏览器档案里**（IndexedDB）。没有钥匙串保护，所以页面用严格的 CSP：只允许加载本站脚本、不允许内联脚本、不使用 `eval`（protobuf 用静态生成的代码）。
- **Web 端只做主控端**。浏览器里没有 PTY，不能被别人连接；认证时带 `accept:false`，别人用它的设备码连会得到“设备不在线”。

## 设备身份与标签页

| 情况 | 行为 |
|---|---|
| 不同电脑 | 各自一台设备，连接、会话、终端互相独立 |
| 同一台电脑的不同浏览器 / 无痕窗口 | 各自一台设备（无痕窗口关闭后身份就丢了） |
| 同一个浏览器的多个标签页 | **同一台设备，同一时刻只有一个活动标签页**（Web Locks）。第二个标签页提示“已在另一个标签页打开”，点“接管”后原标签页刷新并看到同样的提示。要同时开多个会话，在同一个标签页里开多个终端标签 |
| 清除站点数据 / 换浏览器 | 变成新设备，设备码变化，被控端里记住的设备要重新信任 |

被控端按设备（公钥）区分终端归属：开着“终端隔离”时互相看不到对方的终端；关掉后能看到列表，但一个终端同一时间只有一个设备能附着（`TERM_BUSY`，不能抢占）。这是被控端现有行为，Web 端不改它。

## 与桌面版的差别

- 没有被控功能：侧栏只显示本设备的设备码；设置里没有“被控”和“应用”分组；没有自动更新、开机自启、托盘。
- 浏览器拿不到本地文件路径：选文件、拖放时给每个文件分配虚拟路径 `web-file:<编号>/<文件名>`，上传时用它找回 `File`。读取剪贴板里的“文件”不支持，粘贴图片可以。
- Argon2id（19MiB）在浏览器主线程里算，连接时有约 1 秒的计算。

## 代码位置

| 路径 | 说明 |
|---|---|
| `apps/desktop/src/backend/web/web.ts` | `Backend` 接口的 Web 实现：设备身份、已记住设备、设置、事件、终端输出路由、标签页锁 |
| `.../session.ts` | 控制端会话（对应 Rust `controller/*`）：Hello、心跳、自动重连与按偏移续传、终端、上传流控 |
| `.../relay.ts` | 中继连接、SPAKE2 握手、加密多路复用（交互队列优先于批量队列） |
| `.../crypto.ts` | Argon2id、SPAKE2(Ed25519Group)、HKDF、AEAD 记录层，与 Rust 逐字节一致 |
| `.../signal.ts`、`identity.ts`、`terms.ts`、`storage.ts` | 信令客户端、注册、终端表与去重、IndexedDB |
| `.../rterm.pb.js` | 由 `proto/rterm.proto` 生成：`npm run proto:web` |

`getBackend()` 在 Tauri 里用 `tauri.ts`，`--mode web` 构建用 `web/web.ts`，其余（`npm run dev`）用演示用的 `mock.ts`。

## 构建与测试

```bash
cd apps/desktop
npm run build:web          # 产物在 dist-web/
npm run dev:web            # 本地开发（需要自己起服务端，并让 /v1/* 同源可达，见下）
npx vitest run             # 单元测试（加密、终端去重等）
```

与真实 Rust 被控端的联调测试默认跳过。本地起 `server` 的 `npm run dev:all` 和 `rterm-cli host` 后：

```bash
RTERM_WEB_LIVE_API=http://127.0.0.1:8080 RTERM_WEB_LIVE_CODE=<设备码> RTERM_WEB_LIVE_PW=<密码> npx vitest run src/backend/web/live
```

覆盖握手（SPAKE2 / Argon2id / HKDF / Ed25519）、终端输入输出、断线自动重连并续传、历史输出回放、文件上传、密码错误识别。

## 部署

见《部署指南.md》11.2 节。页面与 `/v1/*` 必须同源（Caddy 在同一个域名下反代 API），所以服务端不需要 CORS；信令和中继的 WebSocket 由页面直接连它们各自的域名。
