# 调研：Muse 和 ChatGPT Dots 能否改成直接调接口

> 目标：像 Grok Bot、Cue 那样，用登录后的凭据直接收发消息，不再在后台开一个网页窗口。
> 调研日期 2026-11-04。Muse 用的是你已登录的会话，通过新加的网络记录工具观察（只记录接口形状，不记录消息内容和凭据）；Dots 没有账号，只做了外部检查。

## 结论

**两个都不建议改成直接调接口。继续用后台网页，但让它对用户完全不可见、更稳。**

| | Muse | ChatGPT Dots |
|---|---|---|
| 聊天走什么通道 | 端到端加密的 WebSocket（Noise 协议），连到你自己的 Muse 虚拟机 `{vm}.hatch.metaaivm.com` | `chatgpt.com/backend-api/…`，带反机器人校验 |
| 直接调用的难度 | 很高：要在 AgentStudio 里重新实现远程证明校验、Noise 握手和内层协议，而协议代码不在网页的主脚本里 | 很高：每次请求要过 Cloudflare 和 ChatGPT 的 sentinel 校验（工作量证明、Turnstile） |
| 稳定性 | 对方改一次协议就全部失效，且难以排查（加密） | 这是一场长期的攻防，随时被拦 |
| 结论 | 不做 | 不做 |

## Muse：观察到的情况

打开 muse.ai 后，页面只发了很少几个普通的 HTTP 请求：

| 请求 | 作用 |
|---|---|
| `GET /api/consent/status` | 隐私同意状态 |
| `POST /api/hatch/stateful-sharing` | 返回 `{enabled}` |
| `POST /api/hatch/vm/wake {vm_id, retry_count, connect_attempt_id}` | 唤醒你的 Muse 虚拟机，返回 `{status}` |
| `POST /api/falco`、`/view`、Next.js server action | 埋点和页面数据 |

**聊天本身不走 HTTP**，而是一个 WebSocket：`wss://hatch.metaaivm.com/v1/noise`。一次页面加载里收发了 200 多个帧，全部是二进制密文，帧长 88、224、356 字节这样的。

网页代码里能看到它是怎么建立信任的：
- 浏览器先校验虚拟机的 **AMD SEV-SNP 远程证明**（`attestation_bundle.proto`、`revocation_list.proto`、透明度日志），确认对面是 Meta 发布的、未被篡改的镜像。
- 然后用证明里绑定的 X25519 公钥做 **Noise 握手**，之后的消息都端到端加密。

也就是说，Muse 的设计目的就是让中间任何人（包括 Meta 的服务器）都看不到对话内容。要直接调用，AgentStudio 得完整复刻这套客户端：证明校验、加密握手、内层消息格式。而内层协议的代码不在页面的主脚本里（推测在 Worker 或 WASM 中），还需要继续拆解。工作量大，对方任何一次升级都会让它失效，也很难排查。

## ChatGPT Dots：外部检查

- 不带浏览器环境直接请求 `https://chatgpt.com/`，连首页都返回 403（Cloudflare 拦截）。
- ChatGPT 网页的聊天接口在 `backend-api` 下，众所周知每次发消息前都要先拿 `openai-sentinel-*` 系列令牌，令牌依赖浏览器里算的工作量证明和 Turnstile 校验。
- 没有 Dots 账号，看不到 Dots 自己的接口，这一部分未验证。

## 建议

1. **保留后台网页的做法，但窗口永远不弹出来。**
   - 现在只在两种情况下会显示：你在 Connect 里点"Open"，或在卡片上选"Open Muse"。
   - 建议把这两个入口改名为"在 Muse 里查看"，说明是打开对方的页面，而不是 AgentStudio 出了什么问题；或者改成在系统浏览器里打开 muse.ai。
2. **让后台网页更稳。**
   - 页面显示"Connection error"时（就是你截图里那个），自动刷新重连，并在 AgentStudio 里显示"重新连接中"，而不是一直卡着。
   - 用这次加的网络记录工具，监听 `/api/hatch/vm/wake` 和 WebSocket 的状态，比从页面文字里判断更可靠。
3. **登录体验说明清楚。** Muse 和 Dots 只能在 AgentStudio 的窗口里登录：它们的登录状态存在浏览器 Cookie 里，AgentStudio 读不到你系统浏览器的 Cookie。如果用 Google 账号登录被拦，可以改用对方支持的其它登录方式（Muse 是 Meta 账号）。

## 这次留下的工具

`AGENTSTUDIO_CONNECTOR_TRACE_NETWORK=1`：记录 Muse、Dots 后台网页发出的接口调用形状（方法、地址、请求头名称、JSON 的字段和类型，以及加载了哪些脚本），写到 `userData/connector-traces/network-<日期>.jsonl`。不记录消息内容、令牌和 Cookie。以后对方改版时，可以用它快速看出改了什么。
