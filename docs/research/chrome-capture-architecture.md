# Chrome/Edge 页面抓取架构研究

> 状态：架构研究基线  
> 日期：2026-07-18  
> 适用范围：Manifest V3、Chromium 125+、单标签页静态镜像和 WebGL 运行时镜像  
> 资料范围：Chrome Extensions 官方文档、Chrome DevTools Protocol 官方协议、Microsoft Edge 官方扩展文档

## 1. 结论

这类插件应当保存网站已经交付到浏览器的原始运行时，而不是根据截图重新生成代码。推荐架构是：

```text
Chrome/Edge MV3 扩展
├─ 用户手势和任务 UI
├─ chrome.debugger / CDP 会话编排
├─ Network 响应体捕获
├─ iframe / worker 子会话管理
└─ 小型状态与隐私过滤
          │
          │ Native Messaging 长连接
          ▼
本地宿主
├─ 临时文件和内容寻址存储
├─ 资源去重、路径规划和 URL 重写
├─ 本地 HTTP 回放服务
├─ ZIP 导出
└─ Playwright 验证
```

核心判断如下：

1. 使用 `chrome.debugger` 附加当前标签页，并在刷新前启用 `Network`、`Page`、`Runtime` 和 `Target`。
2. 使用 Chrome 125 起支持的扁平 CDP 子会话处理跨进程 iframe 和 worker。[R1]
3. 为根标签页及每一个子会话分别启用 `Network`。请求标识必须包含会话标识，不能把 `requestId` 当作全局唯一值。
4. 常规响应体使用 `Network.getResponseBody` 获取；大资源流式捕获可试用实验性的 `Network.streamResourceContent`，但必须有稳定路径回退。[R9]
5. `Fetch` 拦截不是默认抓取方式。它会暂停请求，流式取体后请求不能原样继续，容易改变页面时序和行为。[R10]
6. 本地宿主是任务和文件状态的权威来源。扩展 Service Worker 随时可能因浏览器退出、宿主崩溃或调试会话结束而丢失内存状态。
7. Native Messaging 使用 `connectNative()` 长连接。资源数据必须分块并有背压，不能依赖单条大消息。
8. 对于公开、已授权、总资源不超过 50 MB、总请求不超过 500 个的静态站，设计目标可设为 P90 在 120 秒内生成可运行镜像。这个目标不包含后端、WebSocket 业务状态、DRM 和需要人工探索的隐藏场景。

建议将 `minimum_chrome_version` 设为 `125`。原因不是 Manifest V3 本身，而是本项目依赖 `chrome.debugger` 的扁平子会话支持。由于 125 也高于 debugger 会话延长扩展 Service Worker 生命周期所需的 Chrome 118，生命周期策略可以统一。[R1][R4]

## 2. 目标和非目标

### 2.1 架构目标

- 用户点击一次后，捕获当前标签页一次受控重载产生的静态运行资源。
- 覆盖主文档、同进程 iframe、跨进程 iframe、dedicated worker、shared worker 和可观察的 service worker 目标。
- 保存 HTML、CSS、JavaScript、JSON、字体、图片、音频、视频片段、GLB、纹理、WASM 和 worker 脚本。
- 记录足够的响应元数据，使本地服务器能够使用正确的 MIME、Range 和跨源策略回放。
- 不上传页面内容，不在日志中保存 Cookie、Authorization、密码、Token 或表单值。
- 捕获失败时输出结构化缺失报告，不把“页面能打开”等同于“镜像完整”。

### 2.2 明确非目标

- 不复制服务端源码、数据库、支付、登录校验或实时业务状态。
- 不保证 WebSocket、SSE、WebRTC、DRM、远程 API 和第三方登录离线可用。
- 不保证不同 GPU、驱动、字体栅格化环境下 WebGL 逐像素相同。
- 不在扩展上下文中执行抓取到的远程脚本。Manifest V3 禁止扩展依赖远程托管的可执行代码；抓取脚本只能作为导出数据，在隔离的本地站点 Origin 中回放。[R7]
- 不对浏览器内部页、扩展页、Chrome Web Store 等受保护页面承诺支持。

## 3. Manifest V3 设计

### 3.1 最小 Manifest

建议从以下权限集合开始：

```json
{
  "manifest_version": 3,
  "name": "Offline Mirror",
  "version": "0.1.0",
  "minimum_chrome_version": "125",
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },
  "action": {
    "default_title": "Capture current page"
  },
  "permissions": ["activeTab", "debugger", "nativeMessaging", "storage"]
}
```

`background.service_worker` 是 Manifest V3 唯一支持的后台入口，且只能声明一个文件。使用 ES Module 时设置 `"type": "module"`。[R3]

### 3.2 权限用途

| 权限              |       是否必需 | 用途和边界                                                                                         |
| ----------------- | -------------: | -------------------------------------------------------------------------------------------------- |
| `debugger`        |             是 | 通过 `chrome.debugger` 向当前标签页发送 CDP 命令；会产生较强权限警告，应在用户主动点击后才附加。   |
| `nativeMessaging` |             是 | 连接本地宿主，完成文件落盘、任务状态、压缩和本地服务。                                             |
| `storage`         |             是 | 保存轻量设置、最近任务引用和恢复游标；大资源不写入扩展存储。                                       |
| `activeTab`       |           建议 | 将操作限制到用户手势触发的当前标签页，并读取当前标签页必要信息。它不能替代 `debugger` 权限。       |
| `scripting`       |           可选 | 仅在需要注入自动滚动、交互探索或页面内探针时添加。第一阶段可通过 `Runtime.evaluate` 完成最小探测。 |
| `downloads`       | 不建议首版添加 | 本地宿主已经负责文件输出；避免增加无必要权限。                                                     |
| `offscreen`       | 不建议首版添加 | 抓取主流程不需要 DOM；文件和验证任务应放在本地宿主。                                               |

仅使用 `chrome.debugger` 不要求声明全站 `host_permissions`。如果后续由扩展自身跨 Origin `fetch`，或使用 `chrome.scripting` 对非当前标签页注入，则需要重新评估 `host_permissions` 或可选权限。[R2]

### 3.3 `chrome.debugger` 可用协议域

Chrome 官方当前只允许 `chrome.debugger` 使用下列 CDP 域：[R1]

```text
Accessibility, Audits, CacheStorage, Console, CSS, Database,
Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO,
Input, Inspector, Log, Network, Overlay, Page, Performance,
Profiler, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn
```

本项目核心依赖：

| 域             | 用途                                                  |
| -------------- | ----------------------------------------------------- |
| `Target`       | 自动附加跨进程 iframe 和 worker，维护扁平子会话。     |
| `Network`      | 请求、响应、缓存来源、响应体、WebSocket/SSE 诊断。    |
| `Page`         | 页面刷新、帧树、生命周期、截图、MHTML 诊断快照。      |
| `Runtime`      | 执行上下文、子目标解锁、必要的页面探针。              |
| `DOMSnapshot`  | 结束时保存 DOM、布局和有限计算样式快照。              |
| `CacheStorage` | 发现和读取 Service Worker CacheStorage 中的缓存资源。 |
| `Storage`      | 获取存储键、清理或查询与存储相关的辅助信息。          |
| `Fetch`、`IO`  | 特殊响应拦截和流式读取的后备能力。                    |
| `Log`          | 收集页面级错误，辅助判定离线回放是否有效。            |

CDP 协议网站展示的其他域不一定能通过 `chrome.debugger` 使用。例如当前允许列表不包含 `Browser`、`Security`、`ServiceWorker`、`Schema`、`SystemInfo` 和 `IndexedDB`。实现不得因为某命令出现在 tip-of-tree 协议页面就假设扩展一定可以调用。

### 3.4 CDP 版本策略

`chrome.debugger.attach()` 需要传入协议版本。实现可使用稳定的 `"1.3"` 作为连接版本，同时通过以下三层控制实际能力：

1. Manifest 设置 `minimum_chrome_version: "125"`。
2. 每个实验性命令首次调用时捕获 `lastError`，记录能力结果并走回退路径。
3. CI 至少覆盖当前稳定版和前一个稳定版 Chrome/Edge。

CDP 的 tip-of-tree 定义会频繁变化，官方明确说明它可能发生不兼容变更；稳定的 1.3 协议定义较旧，不能代表现代 Chromium 的全部扩展能力。[R8] 因此不能生成一份静态类型后长期不更新，也不能依赖 `Schema` 域进行运行时枚举，因为该域当前不在 `chrome.debugger` 允许列表中。

## 4. 扩展 Service Worker 生命周期

### 4.1 官方生命周期约束

Chrome 通常会在以下情况终止扩展 Service Worker：[R4]

- 30 秒没有收到事件或调用扩展 API。
- 单次事件或 API 调用处理超过 5 分钟。
- `fetch()` 响应超过 30 秒才开始返回。

Chrome 105 起，连接到 Native Messaging 宿主可保持 Service Worker 存活。Chrome 118 起，活动的 `chrome.debugger` 会话也可保持 Service Worker 存活。[R4]

这些改进降低了抓取中途被回收的概率，但不能代替持久化。浏览器退出、扩展更新、用户关闭调试警告条、DevTools 抢占调试连接、标签页崩溃或本地宿主退出都可能结束任务。

### 4.2 推荐状态所有权

| 状态                                         | 权威位置                            | 原因                                               |
| -------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| 任务 ID、阶段、资源清单、临时文件、Hash      | 本地宿主                            | 能跨扩展 Service Worker 重启恢复，并支持流式落盘。 |
| 标签页 ID、根 Debuggee、子会话表、未完成请求 | 扩展内存                            | 与当前调试连接强关联；每次恢复都必须重新验证。     |
| 最近任务 ID、宿主版本、用户设置              | `chrome.storage.local`              | 数据量小，适合扩展持久化。                         |
| 当前短期 UI 进度                             | `chrome.storage.session` 或消息总线 | 浏览器会话内共享，不作为任务真相。                 |
| 页面资源二进制                               | 本地宿主                            | 避免扩展内存、IndexedDB 和消息体压力。             |

所有事件监听器必须在 Service Worker 顶层同步注册，不能在异步初始化完成后才注册，否则 Service Worker 被重新加载时可能错过事件。[R5]

### 4.3 生命周期实现要求

- Service Worker 启动后先从本地宿主查询任务状态，再决定是否恢复 UI。
- 使用一个 `chrome.runtime.connectNative()` 长连接承载整个任务。
- 长连接断开时立即停止继续读取响应体，标记 `host_disconnected`，并尝试有限次数重连。
- `chrome.debugger.onDetach` 必须始终注册，收到事件后终止会话并向宿主发送最终原因。
- 不依赖 JavaScript 全局定时器保证任务正确性；超时截止时间写入宿主。
- 扩展更新或浏览器退出后，未完成临时目录由宿主在下一次启动时清理或恢复。

## 5. `chrome.debugger` 会话模型

### 5.1 根会话

根会话以当前标签页为 Debuggee：

```ts
const root = { tabId };
await chrome.debugger.attach(root, '1.3');
```

在 `attach()` 之前应完成：

1. 建立 Native Messaging 长连接并完成版本握手。
2. 注册 `chrome.debugger.onEvent` 和 `chrome.debugger.onDetach`。
3. 在宿主创建任务和临时目录。
4. 校验 URL 协议、隐私模式和任务配额。

打开 Chrome DevTools 会终止同一标签页上的扩展调试会话。附加后浏览器还会显示调试警告条，用户关闭警告条也会结束会话。[R1][R7] UI 必须将此类结束显示为明确错误，而不是继续生成一个看似成功但缺资源的镜像。

### 5.2 同进程 iframe

同进程 iframe 不会产生独立 CDP Target。它们表现为根页面会话中的多个 frame 和多个 Runtime execution context。[R1]

处理要求：

- 使用 `Page.frameAttached`、`Page.frameNavigated`、`Page.frameDetached` 维护帧树。
- 使用事件中的 `frameId`、`loaderId` 和 `documentURL` 关联网络请求。
- 不假设每个 iframe 都有 `sessionId`。
- DOM 和布局快照由根会话统一捕获。

### 5.3 跨进程 iframe 和 worker

跨进程 iframe 使用独立 Target。Chrome 125 起，`chrome.debugger` 支持扁平会话，事件会附带 `sessionId`，发送子会话命令时也必须带同一个 `sessionId`。[R1]

推荐在根会话执行：

```ts
await send(root, 'Target.setAutoAttach', {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [
    { type: 'iframe', exclude: false },
    { type: 'worker', exclude: false },
    { type: 'shared_worker', exclude: false },
    { type: 'service_worker', exclude: false },
  ],
});
```

`Target.setAutoAttach` 只自动附加当前 Target 的直接子 Target，不会递归。[R11] 因此每次收到 `Target.attachedToTarget` 后都必须：

1. 立即登记 `{sessionId, targetId, type, url, parentSessionId}`。
2. 对该子会话启用 `Runtime` 和 `Network`。
3. 对 page/iframe 类目标按需启用 `Page`。
4. 在该子会话再次调用 `Target.setAutoAttach`，覆盖更深层 iframe 或 worker。
5. 完成初始化后调用 `Runtime.runIfWaitingForDebugger`。

`waitForDebuggerOnStart: true` 能避免 worker 启动脚本和首批请求在启用 `Network` 之前完成。代价是页面时序会被短暂暂停，因此初始化路径必须短且不得等待本地落盘。第一版不要同时启用实验性的 `Network.enable.enableDurableMessages`，官方协议已标注该参数将弃用，并提示它与等待调试器的目标存在死锁风险。[R9]

### 5.4 会话唯一键

`Network.RequestId` 只应视为某一个 CDP 会话内的标识。内部键必须至少是：

```text
SessionKey = rootTabId + ":" + (sessionId || "root")
RequestKey = SessionKey + ":" + requestId + ":" + redirectIndex
```

原因：

- 不同子会话可能产生相同文本形式的 `requestId`。
- 重定向链会在后续 `requestWillBeSent` 中携带 `redirectResponse`，若覆盖原记录会丢失中间响应。
- 一个 URL 可能因请求方法、请求头、内容协商或 Service Worker 状态不同而返回不同内容。

文件存储不能只以 URL 为主键。建议使用内容 Hash 保存实体，再用 Capture Manifest 保存请求到实体的映射。

## 6. Network 捕获模型

### 6.1 启用顺序

根会话推荐顺序：

```text
注册 onEvent / onDetach
→ attach 根标签页
→ Runtime.enable
→ Network.enable
→ Page.enable
→ Page.setLifecycleEventsEnabled
→ Target.setAutoAttach
→ Page.reload
```

`Network.enable` 必须发生在刷新之前。否则首个 HTML、预加载脚本、worker 启动文件和 WebGL 初始化资源可能已经完成。

建议设置有界缓冲参数，但保留不带实验参数的回退调用：

```ts
await send(root, 'Network.enable', {
  maxTotalBufferSize: 96 * 1024 * 1024,
  maxResourceBufferSize: 64 * 1024 * 1024,
  maxPostDataSize: 64 * 1024,
});
```

具体值必须通过 50 MB / 500 请求基准压测调整。扩展不能将所有响应体长期保留在内存中；以上缓冲只是减少 CDP 在响应体尚未读取时淘汰数据的概率。

### 6.2 必须处理的事件

| 事件                                 | 用途                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `Network.requestWillBeSent`          | 请求 URL、方法、发起者、frame、loader、类型、重定向信息。  |
| `Network.requestWillBeSentExtraInfo` | 关联 Cookie、原始请求头和站点隔离信息；到达顺序不保证。    |
| `Network.responseReceived`           | 状态码、MIME、协议、缓存和 Service Worker 来源。           |
| `Network.responseReceivedExtraInfo`  | 原始响应头、Cookie、真实网络状态；到达顺序不保证。         |
| `Network.dataReceived`               | 长度统计；启用实验性流式资源内容后还可携带 base64 数据块。 |
| `Network.loadingFinished`            | 常规响应体读取的入队时点。                                 |
| `Network.loadingFailed`              | 失败、取消、阻止原因和 CORS 错误。                         |
| `Network.webSocket*`                 | 诊断页面依赖实时通道，但不承诺离线业务重放。               |
| `Network.eventSourceMessageReceived` | 诊断 SSE 依赖。                                            |
| `Network.subresourceWebBundle*`      | 记录 WebBundle 内部资源，作为后续兼容项。                  |

`requestWillBeSentExtraInfo` 和 `responseReceivedExtraInfo` 不保证与对应基础事件的先后顺序，而且并非每个请求都一定有 ExtraInfo。[R9] 事件归一化器必须分别暂存，使用 `(SessionKey, requestId, hop)` 合并，不能在收到 `responseReceived` 时就认为 Header 已完整。

### 6.3 请求状态机

建议每一个请求 hop 使用以下状态：

```text
DISCOVERED
→ RESPONSE_HEADERS
→ BODY_QUEUED
→ BODY_READING
→ BODY_STORED
→ VERIFIED

失败分支：
DISCOVERED / RESPONSE_HEADERS / BODY_READING
→ FAILED_RETRYABLE | FAILED_FINAL | SKIPPED_POLICY
```

重定向处理：

1. 收到带 `redirectResponse` 的下一次 `requestWillBeSent`。
2. 将前一个 hop 以重定向响应完成，不尝试将其当作最终资源体。
3. `redirectIndex += 1`，创建同一 `requestId` 的新 hop。
4. Capture Manifest 同时保存原始链和最终规范 URL。

### 6.4 响应体获取策略

#### 稳定默认路径

收到 `Network.loadingFinished` 后，在产生该事件的同一个会话中调用：

```ts
const result = await send(debuggeeForSession, 'Network.getResponseBody', {
  requestId,
});
```

返回值包含：

- `body`: 文本或 base64 字符串。
- `base64Encoded`: 是否需要 base64 解码。[R9]

实现要求：

- 响应结束后尽快读取，不要等整个页面完成才批量读取。
- 使用有界并发队列，初始值建议 4 到 8。
- 二进制体解码后立刻分块送往本地宿主并释放字符串引用。
- `204`、重定向、失败请求和无实体响应不读取 body。
- 读取失败时记录协议错误并按后备顺序处理，不把空字符串当作成功。

#### 实验性大资源路径

`Network.streamResourceContent` 可以让后续 `Network.dataReceived` 事件携带 base64 数据，并返回调用前已经缓冲的数据。[R9] 它不需要暂停页面，适合大模型、音频或视频片段，但该命令是实验性的。

建议：

- 仅对预计大于 8 MB 的资源启用。
- 首次调用失败后对当前浏览器版本禁用该能力。
- 每个数据块立即发往宿主，宿主确认后再扩大窗口。
- 对 gzip、brotli、缓存命中和 Range 响应建立专项 fixture，验证拿到的是回放所需的实体字节。

#### `Fetch` 后备路径

`Fetch.enable` 可以在请求或响应阶段暂停请求，`Fetch.getResponseBody` 或 `Fetch.takeResponseBodyAsStream` 可以读取响应。[R10] 但流式取体后请求不能原样继续，只能取消或重新构造响应，因此会增加行为偏差和实现复杂度。

只在以下场景考虑站点级启用：

- `Network.getResponseBody` 对某类响应稳定失败。
- 必须在响应到页面前修改或复制字节。
- 已经有完整的 `Fetch.fulfillRequest` 回填和一致性测试。

不得在全站默认启用 Fetch 响应拦截。

#### 其他回退

按优先级：

1. `Page.getResourceContent(frameId, url)`，适用于已知 frame 资源，但它是实验性命令。[R12]
2. `CacheStorage.requestCachedResponse`，适用于 Service Worker CacheStorage 中的缓存实体。[R14]
3. 本地宿主重新 GET 公开、幂等、无鉴权的静态 URL。
4. 标记缺失并在结果页展示，不伪造成功。

本地宿主重新请求不是等价捕获。它可能因 Cookie、Authorization、Referer、User-Agent、Accept、临时签名、地理位置、时间和 A/B 分组而得到不同内容。默认不向宿主传递 Cookie 和 Authorization。

### 6.5 压缩和响应头

CDP 返回的 body 表示浏览器可读取的资源内容，而 `dataLength` 与 `encodedDataLength` 还区分未压缩和传输编码长度。[R9] 本地镜像不能把源站 Header 原样复制给已经解码的文件。

本地服务器规则：

- 重新计算 `Content-Length`。
- 不保留 hop-by-hop Header，例如 `Transfer-Encoding` 和 `Connection`。
- 如果实体已解压，移除 `Content-Encoding`。
- 保留或推导正确的 `Content-Type` 和 charset。
- 对音视频、WASM、GLB 和大二进制实现 `Range`。
- CSP、CORP、COEP、CORS 和 SRI 单独进入重写与兼容阶段，不能静默删除后不记录。

必须使用 gzip、brotli、304、disk cache、Service Worker cache 和 Range 响应 fixture 验证上述策略。

### 6.6 Cache 和 Service Worker

默认目标是捕获“用户实际看到的页面”，因此首轮不调用 `Network.setBypassServiceWorker(true)`。`responseReceived.response` 中的 `fromServiceWorker`、`fromDiskCache`、`fromPrefetchCache` 等字段应写入来源信息。[R9]

对于 CacheStorage：

1. 从页面和 worker 会话收集 security origin / storage key。
2. 使用 `CacheStorage.requestCacheNames` 列举缓存。
3. 使用 `requestEntries` 发现 URL。
4. 对网络事件未捕获但镜像引用的条目使用 `requestCachedResponse` 读取 body。[R14]

限制：

- `CacheStorage` 域是实验性的。
- `ServiceWorker` 域当前不在 `chrome.debugger` 允许列表中。
- 已缓存资源并不表示本地页面会自动获得同样的 Service Worker 注册和作用域。
- 第一版应将 CacheStorage 视为资源发现与补漏来源，而不是完整复制原 Service Worker 生命周期。

## 7. 页面、DOM 和视觉证据

Network 是运行资源的主来源，DOM 只作为补充发现和验证。

抓取静默后建议保存：

- `Page.getFrameTree` 结果。
- `DOMSnapshot.captureSnapshot`，仅请求必要计算样式。
- 当前视口截图和整页截图。
- 可选 `Page.captureSnapshot({format: "mhtml"})` 诊断包。
- 控制台错误和失败资源列表。

`DOMSnapshot.captureSnapshot` 可以包含 iframe、模板、导入文档和扁平化的 Shadow DOM，但官方协议明确指出它也会包含 input 和 textarea 的值。[R13] 默认必须在写盘前清除表单值，或完全不保留原始 DOMSnapshot。

`Page.captureSnapshot` 当前仅支持 MHTML，并且是实验性命令。[R12] MHTML 适合诊断和紧急备份，不应作为可维护离线工程的唯一输出。

对于 WebGL：

- 保存原始 JavaScript、WASM、模型、纹理和音频，才是恢复场景的核心。
- DOMSnapshot 不能保存 GPU 内部状态。
- 截图用于视觉基线，Canvas 非空检查用于快速验证。
- 不同 GPU 环境采用感知差异阈值，不做严格逐像素门禁。

## 8. Native Messaging 架构

### 8.1 官方限制

Native Messaging 使用 stdin/stdout 传输带 32 位本机字节序长度前缀的 UTF-8 JSON。[R6]

| 方向                   | 官方单条消息上限 |
| ---------------------- | ---------------: |
| 本地宿主到 Chrome/扩展 |             1 MB |
| Chrome/扩展到本地宿主  |           64 MiB |

额外约束：

- 内容脚本不能直接调用 Native Messaging，只能由扩展页面或 Service Worker 调用。
- `runtime.sendNativeMessage()` 每次调用都会启动一个新宿主进程，收到一个响应后终止。
- `runtime.connectNative()` 创建持续端口，宿主进程保持运行直至端口销毁。
- 宿主的调试日志必须写 stderr，stdout 只能写协议消息。
- Windows 必须将 stdin/stdout 设置为二进制模式。
- Native Host Manifest 的 `allowed_origins` 必须列出准确扩展 Origin，不支持通配符。

### 8.2 推荐连接模式

每个扩展运行实例维护一个 `connectNative()` 端口，多个抓取任务在端口上使用 `taskId` 复用。首版若只允许一个抓取任务，则在宿主层显式实施 WIP=1。

握手：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "extensionVersion": "0.1.0",
  "browser": "chrome",
  "taskId": null
}
```

宿主响应必须远小于 1 MB：

```json
{
  "type": "helloAck",
  "protocolVersion": 1,
  "hostVersion": "0.1.0",
  "capabilities": ["capture-v1", "chunked-body-v1", "local-server-v1"]
}
```

### 8.3 资源分块和背压

即使扩展到宿主单条消息允许 64 MiB，也不得发送接近上限的资源。JSON 和 base64 会增加体积，并导致扩展 Service Worker 出现大字符串和多份内存拷贝。

推荐协议：

```text
resourceStart
→ resourceChunk(seq=0..n, <= 256 KiB encoded payload)
→ resourceEnd(hash, byteLength)
→ resourceStored ack
```

约束：

- 默认块大小 256 KiB，经过压测可调整到 512 KiB。
- 每个资源最多 4 个未确认块，形成显式背压。
- `resourceChunk` 只允许 base64 数据和固定 Schema 字段。
- 宿主边接收边写临时文件并计算 SHA-256。
- `resourceEnd` 的长度和 Hash 不一致时删除临时文件并重试。
- 宿主到扩展只发送进度、ACK 和错误，不回传资源体。
- 不在任何消息中发送 Cookie、Authorization、密码或完整表单数据。

对于公开的普通 GET 资源，可增加 `hostFetch` 快速路径，但它必须是优化而不是正确性基础。宿主下载结果应与捕获到的 ETag、长度、MIME 或后续视觉验证进行核对；无法核对时仍应优先传输浏览器实际接收的 body。

### 8.4 Chrome 和 Edge 安装

Chrome 在 Windows 下从 `HKCU` 或 `HKLM` 的 Chrome NativeMessagingHosts 注册表位置查找宿主 Manifest。[R6]

Microsoft Edge 使用自己的 `Microsoft\Edge\NativeMessagingHosts` 注册表位置；兼容 Chrome 的宿主安装程序需要为两个浏览器分别注册，并在 `allowed_origins` 中加入各商店构建对应的扩展 ID。[R15]

因此：

- Chrome Web Store 和 Edge Add-ons 的扩展 ID 可能不同。
- 安装器不能硬编码单一扩展 Origin。
- 卸载时只删除本产品自己的注册表键和宿主文件。
- CI 需要分别执行 Chrome 和 Edge 的握手测试。

## 9. 推荐端到端实现流程

### 9.1 任务准备

1. 用户点击扩展按钮。
2. 查询当前活动标签页，拒绝不支持的协议和受保护页面。
3. 建立 Native Messaging 端口，校验协议和宿主版本。
4. 宿主创建 `taskId`、临时目录和空 Capture Manifest。
5. 扩展注册调试事件监听器并附加根标签页。

### 9.2 捕获初始化

6. 根会话启用 `Runtime`、`Network`、`Page` 和生命周期事件。
7. 根会话启用扁平 `Target.setAutoAttach`。
8. 为已经存在和后续出现的子 Target 建立递归会话。
9. 记录当前 URL 和帧树。
10. 根据模式执行一次 `Page.reload`：

- 快速模式：允许现有缓存，捕获用户实际状态。
- 确定性模式：`ignoreCache: true`，用于诊断缺失资源。

### 9.3 事件归一化和响应体处理

11. 所有 `chrome.debugger.onEvent` 回调只做解析、敏感字段过滤和队列入队，不在事件回调中等待文件 I/O。
12. 归一化器按会话和重定向 hop 合并基础事件与 ExtraInfo。
13. 收到 `loadingFinished` 后立即进入响应体队列。
14. 响应体解码后分块传给宿主，宿主内容寻址落盘。
15. 网络事件之外，解析 HTML/CSS/DOMSnapshot 和 CacheStorage，形成“已引用但未捕获”清单。
16. 对安全的缺失 GET 资源执行宿主补抓；其余进入缺失报告。

### 9.4 收敛条件

页面不能只等待 `load`，因为 WebGL、SPA 和懒加载资源常在其后出现。建议完成条件：

```text
主文档达到 load 或明确可交互状态
+ 非长连接请求数为 0
+ 连续 2 秒无新资源
+ 最少观察 3 秒
+ 首轮发现硬上限 30 秒
```

忽略 WebSocket、SSE 和已识别的长轮询，但记录其存在。若启用自动滚动或站点动作，每个动作后重新执行静默窗口，整项任务仍受 120 秒产品预算约束。

### 9.5 收尾

17. 捕获 DOM/帧树/截图/MHTML 等验证证据。
18. 等待所有 body 分块得到宿主 ACK。
19. 写入失败请求、跳过原因、动态依赖和隐私清理报告。
20. 主动 `chrome.debugger.detach()`。
21. 宿主根据 Capture Manifest 规划文件路径和 URL 重写。
22. 启动本地 HTTP 服务器执行快速回放验证。
23. 验证通过后原子移动临时目录为最终任务目录，并在后台生成 ZIP。

## 10. Capture Manifest 数据契约

建议由本地宿主维护一个版本化清单：

```json
{
  "schemaVersion": 1,
  "taskId": "uuid",
  "source": {
    "url": "https://example.com/",
    "capturedAt": "2026-07-18T00:00:00Z",
    "browser": "Chrome",
    "browserVersion": "151.x",
    "viewport": {
      "width": 1440,
      "height": 900,
      "deviceScaleFactor": 1
    }
  },
  "limits": {
    "maxResources": 500,
    "maxDecodedBytes": 52428800
  },
  "resources": [],
  "frames": [],
  "targets": [],
  "failures": [],
  "dynamicDependencies": [],
  "privacyActions": []
}
```

单个资源至少包含：

```text
requestKey
sessionKey
frameId
loaderId
request URL 和规范化 URL
method
resourceType
status
mimeType
charset
response source flags
redirect chain
content hash
decoded byte length
stored relative path
capture method
failure reason
```

Header 分为三类：

- 可持久化：`Content-Type`、缓存提示、ETag、Last-Modified 等非敏感诊断字段。
- 仅内存使用：可能用于请求归一化但不应写日志的字段。
- 永不保存：`Cookie`、`Set-Cookie`、`Authorization`、`Proxy-Authorization` 和已识别 Token。

URL 查询参数也可能包含 Token。日志和 UI 使用脱敏 URL；若离线重写必须保留原始查询字符串，只能保存在任务本地清单中，且不得进入遥测。

## 11. 性能优化

### 11.1 优先级最高的优化

1. **发现即读取、读取即落盘**：避免页面完成后再批量处理。
2. **响应体有界并发**：初始 4 到 8，根据 body 失败率和内存动态调整。
3. **内容寻址去重**：SHA-256 相同的资源只存一份。
4. **Native Messaging 小块流水线**：避免大 JSON 和长时间暂停事件循环。
5. **本地宿主常驻**：一个任务只启动一个宿主进程。
6. **不在捕获阶段格式化或转码**：JS 美化、图片转换、模型压缩全部后移。
7. **先可运行、后压缩**：本地服务器验证通过即向用户显示完成，ZIP 后台生成。
8. **失败资源单独重试**：不因一个文件失败重新加载整个页面。

### 11.2 资源优先级

```text
P0: HTML、CSS、入口 JS、worker、WASM、字体
P1: 首屏图片、GLB/GLTF、纹理、关键音频
P2: 其他场景资源、非关键音频、视频片段
P3: 分析、广告、遥测和已知写接口
```

P3 默认记录后阻止导出，但在原页面抓取阶段不要贸然阻断请求，否则可能改变应用初始化。是否在刷新前阻断遥测需要独立 fixture 证明不会影响目标页面。

### 11.3 建议性能预算

| 阶段                 |       P50 |        P90 |
| -------------------- | --------: | ---------: |
| 附加、初始化和刷新   |      3 秒 |       8 秒 |
| 资源发现和响应体保存 |     25 秒 |      70 秒 |
| 补漏和清单生成       |      8 秒 |      20 秒 |
| 本地启动和快速验证   |     12 秒 |      22 秒 |
| 总计                 | 60 秒以内 | 120 秒以内 |

测试口径固定为：

- 单页面。
- 总响应实体不超过 50 MB。
- 不超过 500 个资源请求。
- 不含需要人工操作遍历的隐藏场景。
- 基准网络、CPU、浏览器版本和本地磁盘写入条件固定。

## 12. 隐私和安全

### 12.1 默认拒绝保存

- Cookie、Set-Cookie、Authorization 和代理认证信息。
- password、hidden token、textarea 和用户填写的 input 值。
- LocalStorage、SessionStorage、IndexedDB 全量内容。
- POST 表单体和 GraphQL mutation body。
- WebSocket 消息内容。
- 浏览器个人资料路径和系统环境变量。

### 12.2 远程代码和 Origin 隔离

抓取到的 JavaScript 是页面镜像数据，不得：

- 使用 `eval` 在扩展 Service Worker、Popup 或扩展页面中执行。
- 作为远程更新机制加载到扩展逻辑。
- 注入扩展 Origin。

离线回放必须运行在独立的 `http://127.0.0.1:<port>` Origin。扩展 UI 与回放站点分离，宿主使用随机端口和不可预测任务路径，并只绑定 loopback。

### 12.3 配额和拒绝服务保护

- 默认资源数上限 500。
- 默认解码后总量上限 50 MB。
- 单资源上限建议 64 MB，即使任务总量配置更高也单独确认。
- HTML、CSS、JS 和 JSON 设置解析深度和文件大小上限。
- Native Messaging 所有消息做 JSON Schema 校验。
- 路径生成后调用安全 join，拒绝 `..`、绝对路径、设备名和非法字符。
- ZIP 输出防止 Zip Slip。
- 本地服务器拒绝代理任意远程 URL，避免成为 SSRF 入口。

## 13. 已知风险和缓解

| 风险                           | 影响                           | 缓解                                                          |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------- |
| `debugger` 权限警告较强        | 安装转化和商店审核风险         | 单一明确用途、用户手势启动、权限说明、默认本地处理。          |
| 用户打开 DevTools 或关闭调试条 | 调试会话立即终止               | 监听 `onDetach`，任务标记不完整，支持重试，不输出假成功。     |
| CDP tip-of-tree 变化           | 实验命令在新旧版本行为不同     | 最低浏览器版本、能力探测、稳定回退、双版本 CI。               |
| OOPIF 自动附加不递归           | 深层 iframe 和 worker 资源缺失 | 每个 `attachedToTarget` 子会话递归调用 `setAutoAttach`。      |
| worker 启动过快                | 丢失 worker 首个脚本或请求     | `waitForDebuggerOnStart: true`，快速启用 Network 后解锁。     |
| ExtraInfo 事件乱序或缺失       | Header 和状态关联错误          | 独立缓冲、延迟归并、超时后允许部分完成。                      |
| body 被 CDP 缓冲淘汰           | `getResponseBody` 失败         | 及时读取、有界缓冲、实验流式路径、CacheStorage/Page 回退。    |
| 大 base64 引发内存峰值         | Service Worker 崩溃或任务变慢  | 资源流式路径、小块 Native 消息、立即释放引用、配额。          |
| 压缩 Header 与 body 不匹配     | 本地资源损坏                   | 重算长度、移除过时编码头、gzip/br fixture。                   |
| Service Worker 控制页面        | 资源来源和网络请求不一致       | 默认捕获实际状态，记录来源，CacheStorage 补漏，提供诊断模式。 |
| Native Host 崩溃               | 任务中断和临时文件残留         | 长连接断开检测、宿主状态落盘、可恢复任务、TTL 清理。          |
| Chrome/Edge 扩展 ID 不同       | Native Messaging 握手失败      | 安装器分别注册，`allowed_origins` 包含实际商店 ID。           |
| URL 相同但响应不同             | 文件被错误覆盖                 | 请求指纹、重定向 hop、内容 Hash 和路由清单分离。              |
| CSP、SRI、CORS、CORP、COEP     | 本地页面资源被浏览器拦截       | 结构化重写策略和离线控制台验证，所有降级写入报告。            |
| WebSocket/SSE/API 依赖         | 页面只能显示初始状态           | 标记动态依赖，后续提供有限响应录制，不承诺服务端复刻。        |
| blob、媒体流、DRM              | 无法导出原始实体               | 明确不支持或仅保存当前视觉证据。                              |
| DOMSnapshot/MHTML 含敏感值     | 隐私泄露                       | 默认清除表单值，MHTML 设为可选诊断产物。                      |
| WebGL GPU 差异                 | 视觉测试波动                   | 固定测试环境、Canvas 非空、感知差异而非逐像素。               |
| 页面资源未经授权               | 法律和平台风险                 | 仅支持用户有权备份的页面，产品条款和结果页明确授权责任。      |

## 14. 推荐实现阶段

### 阶段 A：协议 POC

交付：

- MV3 扩展附加当前标签页。
- 根页面 Network 事件记录。
- `getResponseBody` 保存 HTML/CSS/JS/图片。
- Native Messaging 握手和单资源分块落盘。
- `onDetach` 和基础失败报告。

退出条件：

- 简单静态页面在本地 HTTP 服务中打开。
- 资源实体 Hash 与捕获体一致。
- DevTools 抢占时任务正确失败。

### 阶段 B：多 Target

交付：

- 扁平会话管理器。
- OOPIF、dedicated worker、shared worker 递归自动附加。
- 会话级 RequestKey 和重定向状态机。
- ExtraInfo 乱序归一化测试。

退出条件：

- 嵌套跨域 iframe fixture 无资源串会话。
- worker 首个请求召回率达到 100%。

### 阶段 C：补漏和回放

交付：

- DOMSnapshot、HTML/CSS URL 发现。
- CacheStorage 发现和 body 回退。
- MIME、Range、压缩 Header 处理。
- Capture Manifest 和本地 URL 重写。

退出条件：

- gzip/br、304、缓存、WASM、字体、音频、GLB fixture 全部离线加载。
- 无未解释的 404 和致命控制台错误。

### 阶段 D：性能和 WebGL

交付：

- 响应体队列和 Native 背压。
- `Network.streamResourceContent` 能力探测。
- 内容寻址缓存。
- WebGL 页面 Canvas、模型、纹理和音频验证。

退出条件：

- 50 MB / 500 请求基准 P90 小于 120 秒。
- 扩展与宿主总峰值内存在既定预算内。
- WebGL 基准入口和至少一个主要交互场景离线可运行。

### 阶段 E：发布加固

交付：

- Chrome/Edge 安装器和 Native Host 注册。
- 权限说明、隐私策略和数据删除流程。
- 崩溃恢复、版本协商、升级和卸载测试。
- 当前稳定版及前一稳定版浏览器回归。

退出条件：

- Chrome 与 Edge 商店构建均能连接各自注册的宿主。
- 不保存敏感字段的自动化测试通过。
- 任务失败不会留下可被误认为完整镜像的输出。

## 15. 架构决策摘要

| 决策                | 选择                                 | 原因                                                       |
| ------------------- | ------------------------------------ | ---------------------------------------------------------- |
| 捕获核心            | `chrome.debugger` + CDP              | 可观察浏览器实际网络和多 Target，适合原运行时镜像。        |
| 最低 Chrome         | 125                                  | 依赖 flat child sessions。                                 |
| 默认 body 获取      | `Network.getResponseBody`            | 稳定、简单、不主动暂停页面。                               |
| 大资源优化          | `Network.streamResourceContent` 可选 | 降低单资源峰值，但属于实验能力。                           |
| Fetch 拦截          | 非默认、站点级后备                   | 会暂停并可能改变页面行为。                                 |
| 后台运行环境        | MV3 Service Worker                   | 平台要求；不作为大文件或任务真相存储。                     |
| 文件和任务权威      | 本地宿主                             | 支持流式文件 I/O、恢复、本地服务和压缩。                   |
| Native 连接         | `connectNative()`                    | 单进程长连接，减少启动开销并延长 Service Worker 生命周期。 |
| 数据传输            | 小块、有 ACK、有限窗口               | 避免 1 MB/64 MiB 消息限制和内存峰值。                      |
| 存储主键            | 内容 Hash + 请求映射                 | URL 不能唯一代表响应实体。                                 |
| Service Worker 页面 | 捕获实际状态 + CacheStorage 补漏     | 绕过 Service Worker 会改变用户实际看到的页面。             |
| MHTML               | 可选诊断产物                         | 快速备份有效，但不是可维护工程的唯一来源。                 |

## 16. 官方文档引用

所有链接均在 2026-07-18 查阅。

- **[R1] Chrome Extensions: `chrome.debugger` API**  
  权限、允许的协议域、扁平子会话、同进程 iframe、OOPIF 和 DevTools 抢占说明。  
  https://developer.chrome.com/docs/extensions/reference/api/debugger

- **[R2] Chrome Extensions: Declare permissions**  
  Manifest 权限、host permissions、可选权限和最小权限原则。  
  https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions

- **[R3] Chrome Extensions: Manifest `background`**  
  Manifest V3 Service Worker 声明和 ES Module 配置。  
  https://developer.chrome.com/docs/extensions/reference/manifest/background

- **[R4] Chrome Extensions: Extension Service Worker lifecycle**  
  终止条件、持久化建议、Native Messaging 与 debugger 的生命周期改进。  
  https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

- **[R5] Chrome Extensions: Extension Service Worker events**  
  事件监听器需要在全局作用域同步注册。  
  https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events

- **[R6] Chrome Extensions: Native messaging**  
  Host Manifest、`connectNative`、`sendNativeMessage`、消息帧、大小限制和 Windows 注册。  
  https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

- **[R7] Chrome Extensions: Deal with remote hosted code violations**  
  Manifest V3 远程代码限制，以及 `debugger` 会话的用户警告和终止行为。  
  https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code

- **[R8] Chrome DevTools Protocol: Protocol versions**  
  tip-of-tree、稳定 1.3 版本和协议兼容性说明。  
  https://chromedevtools.github.io/devtools-protocol/

- **[R9] Chrome DevTools Protocol: Network domain**  
  Network 事件、ExtraInfo 顺序、`getResponseBody`、缓存来源和实验性流式资源内容。  
  https://chromedevtools.github.io/devtools-protocol/tot/Network/

- **[R10] Chrome DevTools Protocol: Fetch domain**  
  请求暂停、响应体获取和 `takeResponseBodyAsStream` 的行为限制。  
  https://chromedevtools.github.io/devtools-protocol/tot/Fetch/

- **[R11] Chrome DevTools Protocol: Target domain**  
  `setAutoAttach`、扁平会话、过滤器和非递归自动附加。  
  https://chromedevtools.github.io/devtools-protocol/tot/Target/

- **[R12] Chrome DevTools Protocol: Page domain**  
  页面生命周期、资源内容、帧树和 MHTML `captureSnapshot`。  
  https://chromedevtools.github.io/devtools-protocol/tot/Page/

- **[R13] Chrome DevTools Protocol: DOMSnapshot domain**  
  DOM、布局、计算样式、Shadow DOM 和表单值捕获说明。  
  https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/

- **[R14] Chrome DevTools Protocol: CacheStorage domain**  
  CacheStorage 列举、条目读取和缓存响应体获取。  
  https://chromedevtools.github.io/devtools-protocol/tot/CacheStorage/

- **[R15] Microsoft Edge Extensions: Native messaging**  
  Edge Native Messaging Host Manifest、Windows 注册位置和 Chrome 兼容注册。  
  https://learn.microsoft.com/microsoft-edge/extensions/developer-guide/native-messaging
