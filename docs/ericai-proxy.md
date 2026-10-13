# EricAI 认证与本地模型并存时的代理冲突：调查与解决方案

日期：以仓库当前代码为准（`internal/proxy`、`internal/model`、`internal/runtime` 现状）
状态：调查完成，方案待实施

---

## 一、问题描述

在**公司开发服务器**上（内外网隔离的环境）：

- EricAI 认证（Microsoft Entra 设备码登录）需要**挂代理走外网**才能连上 `login.microsoftonline.com`；
- 模型是**内网部署**（内网地址 / 内网域名），**一旦挂代理就访问不了**内网；
- PC 上内外网都通，不挂代理一切直连，因此没有暴露这个问题。

期望：**认证走代理、模型请求直连**，在同一台服务器上同时可用。

## 二、代码事实（证据）

程序的"网络路径"决策集中在 `internal/proxy`（见 `proxy.go` 包注释："全程序一个网络路径决策"）。
但它**只实现了"读代理"这一半，没有实现 `NO_PROXY` 那一半**。

### 2.1 代理决议逻辑（`internal/proxy/proxy.go`）

`Resolve()` 的优先级：

1. 环境变量：`HTTPS_PROXY` → `https_proxy` → `HTTP_PROXY` → `http_proxy`（`proxy.go:100-106`）；
2. 没有环境变量时读 Windows 系统代理（`system_windows.go`）：`ProxyEnable` 先决；
   非 Windows 上"系统代理本来就等于环境变量"（`system_other.go`），所以 Linux 服务器只认环境变量；
3. 都没有 → 直连。

`Transport()` 把决议出的代理装进 transport，**没有按目标主机区分**：

- Proxy 函数一旦解析出代理，就把**所有**请求发往该代理；
- 唯一例外：`skipWhenUnreachable` —— 仅当代理是 **loopback**（127.0.0.1 / localhost）且探测到
  端口没在监听时，回退直连（`proxy.go` 的 `loopbackProbeTTL` 逻辑）。
  它**只保护"代理死了"**，不针对"目标主机在内网"这种情况。
- **`NO_PROXY` 完全不读** —— 既不在 `Resolve()` 里，也不在 transport 的 Proxy 函数里。

### 2.2 模型请求（`internal/model/client.go`）

```go
// client.go:132-135
transport, _ := proxy.Transport(route.Verify)   // 走 internal/proxy 的决议
client = &http.Client{Timeout: timeout, Transport: transport}
```

因此：服务器上设置 `HTTPS_PROXY` 后，**发往内网模型的请求同样被转发给代理**。
代理无法访问内网（或被内网拒绝），于是连不上模型。

### 2.3 EricAI 认证请求（`internal/runtime/ericai.go`）

```go
// ericai.go:180  ericPostToken
// ericai.go:247  ericRequestDeviceCode
client := &http.Client{Timeout: 30 * time.Second}   // 零值 transport
```

这是 Go 的**零值 `http.Client`**，走 Go 标准库默认的 `http.ProxyFromEnvironment`：

- 读环境变量 `HTTP_PROXY`/`HTTPS_PROXY`（所以挂代理能登录成功）；
- 不参与 `internal/proxy` 统一决议，也不读 Windows 系统代理；
- 标准库的 `ProxyFromEnvironment` 本身尊重 `NO_PROXY`，但**前提是 `NO_PROXY` 被设置且格式正确**——
  而模型请求那条路（`internal/proxy.Transport`）**不读 `NO_PROXY`**，所以只修环境变量无法解决模型侧。

### 2.4 两套 client 的不一致（根因）

| 流量 | 构造方式 | 代理来源 | 读 NO_PROXY |
|---|---|---|---|
| 模型请求 | `proxy.Transport()`（`client.go`） | `internal/proxy.Resolve()` | **否** |
| web 工具（`builtin/webfetch.go`、`websearch.go`） | 注入 `runtime.httpClient`，零值 transport | 环境变量（标准库） | 标准库语义 |
| EricAI 认证 | 零值 `http.Client`（`ericai.go:180,247`） | 环境变量（标准库） | 标准库语义 |

同一个进程里有至少三套网络路径来源，其中**模型请求这一条**既不读 `NO_PROXY` 也没有任何
按主机绕开的机制，这正是"认证要代理、模型要直连"无法共存的原因。

## 三、根因结论

1. `internal/proxy` 的设计假设是"一台机器的网络路径一次定好"（`proxy.go` 包注释、`composition.go:637-653`
   的 `[network]` 通知），该假设在"全部流量同走代理或同走直连"的机器上成立；
2. EricAI 场景打破了这个假设：**认证要出外网（要代理），模型在内网（不能代理）**；
3. 由于 `internal/proxy` 不读 `NO_PROXY`，**不存在任何环境变量组合**能让当前代码做到
   "认证走代理、模型直连"。

## 四、解决方案

### 方案 A（推荐）：给 `internal/proxy` 补上 `NO_PROXY` 支持

标准做法（curl / Git / Go 标准库 / 各种 SDK 均如此）。

**改动点：**

1. `internal/proxy` 新增对 `NO_PROXY` / `no_proxy` 的解析与匹配，语义对齐
   `golang.org/x/net/http/httpproxy`（Go 标准库 `ProxyFromEnvironment` 的实现）：
   - 逗号分隔列表；`*` 匹配所有主机；
   - `域名` / `.域名` 匹配该域及其子域；
   - `host:port` 精确匹配主机与端口（无端口则匹配任意端口）；
   - CIDR（`10.0.0.0/8`）匹配网段；
   - `localhost` 与 loopback 地址直接匹配。
2. `proxy.Transport` / `transportFor` 生成的 Proxy 函数中，先查 NO_PROXY 命中，
   命中则返回直连（`nil`），否则才返回决议出的代理。
3. 保持 `Resolve()` 与启动 `[network]` 通知不变（通知仍描述"默认路径"），
   避免行为面过度扩大；可在通知文案里补充"NO_PROXY 命中的主机走直连"。

**使用方式（开发服务器上）：**

```bash
export HTTPS_PROXY=http://公司代理地址:端口
export NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,.corp.example.com,<模型内网地址>
```

- EricAI 认证（`login.microsoftonline.com`）不匹配 NO_PROXY → **走代理** ✅
- 模型请求（内网地址）匹配 NO_PROXY → **直连** ✅
- PC 上不设任何变量 → 全部直连，行为不变 ✅

**影响面与验证：**

- 涉及 `internal/proxy`、`internal/model` 的 transport 构造，属于 AGENT.md 规定的"大改动"范围：
  跑全量 `make test` + `make build`（真实二进制校验）；
- `VERSION` 次版本号 +1（用户可感知的新行为）；
- 新增测试：NO_PROXY 命中直连、CIDR 匹配、域名后缀匹配、不命中走代理、
  与 loopback 探活回退叠加时的行为。

### 方案 B（零改动，应急）：挂代理刷新 token 后立即换直连重启

利用"刷新出的 token 有效期约 70 分钟"：

1. 挂代理启动一次，让 `--ericai` 完成登录并把新 token 写回配置；
2. 退出、清掉代理再启动 —— 启动时 token 还新鲜就不刷新，**模型直连可用**；
3. token 临期（剩 <10 分钟）程序会再尝试刷新：没代理会失败，但**刷新失败不拦请求**
   （`authCheck` 吞掉错误，旧 token 继续用），直到 token 真过期后报 401，需重复第 1、2 步。

缺陷：每约一小时要手动重复一次，只适合临时顶一下，不适合长期使用。

### 方案 C（不推荐讨论 / 记录在案）

- 给配置加"按路由走代理"的开关：与 `internal/proxy` "网络路径是机器属性、不做第二个配置源"
  的设计相悖，会导致两处答案漂移（正是该包注释里明确拒绝的方向），**不采纳**；
- 认证侧强制直连：在本场景恰好相反（认证需要代理），不适用。