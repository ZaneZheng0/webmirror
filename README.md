# WebMirror

**授权网页离线镜像工具 / Authorized offline mirror for static web experiences**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue.svg)](./docs/installation/windows-native-host.md)
[![Browsers](https://img.shields.io/badge/browsers-Chrome%20%7C%20Edge-4285F4.svg)](./docs/validation/SUPPORT_BOUNDARIES.md)

中文 | [English](#english)

## 中文

### 项目简介

WebMirror 是一个面向 Chrome 和 Microsoft Edge 的浏览器扩展与本地辅助程序，用于把用户当前打开且有权保存的网页，快速转换为可在本机离线运行的高保真镜像。

它保存的是网页已经使用的运行资源和前端逻辑，而不是简单截图或重新生成一个相似页面。对于适合的静态页面和互动作品，WebMirror 可以保留 HTML、CSS、JavaScript、字体、图片、音频、视频、Web Worker、WASM、GLB/BIN 等资源，并通过本地 HTTP 预览服务重建原页面需要的运行环境。

项目的核心定位是：

> 一键捕获、原运行时优先、本地处理、离线验证、明确报告边界。

WebMirror 不试图复制网站的服务器端业务，也不绕过登录、付费墙、验证码、DRM 或反爬虫控制。它适合页面归档、互动作品备份、设计评审、视觉回归测试、授权迁移和离线演示。

### 当前状态

当前仓库包含可运行的 MVP / release candidate 工程，已完成以下能力：

- Manifest V3 扩展，支持当前标签页的一键捕获。
- 基于 Chrome DevTools Protocol 的网络记录、iframe/Worker 目标接入和动态资源发现。
- Native Messaging protocol v2，支持进度、取消、重试和恢复。
- HTML、CSS、JSON 以及受控 JavaScript URL 本地化。
- 同源响应体复用、公共跨域静态资源下载和 Service Worker CacheStorage 回退。
- 并发下载、SHA-256 校验、内容寻址缓存和 HTTP 缓存重新验证。
- 本地 HTTP 预览、SPA History API 回退、MIME/Range/CORS/字体/WASM 支持。
- Canvas/WebGL、Web Worker、压缩资源和常见三维资源的处理。
- 声明式 click、scroll、key、drag 交互回放和截图感知相似度验证。
- Windows Native Host 打包、安装、升级、诊断、卸载和 SPDX SBOM 生成。
- 资源缺失、在线依赖、阻断错误和能力边界的可读报告。

当前版本为 `0.0.60`。Windows 辅助程序仍是未签名的开发版；代码签名、公开隐私政策、商店发布和完整兼容性矩阵属于后续发布门槛。

### 支持范围与边界

| 类型                                              | 当前行为                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| 普通静态 HTML/CSS/JS 页面                         | 通常可以完整离线运行                                                      |
| 静态 SPA 和前端路由                               | 支持已捕获路由及其资源，范围受发现和页面数量限制                          |
| Canvas/WebGL/Three.js 互动页面                    | 支持已观察到并成功捕获的运行资源；GPU、动态加载和大型媒体可能导致部分完成 |
| 图片、字体、音频、普通视频、WASM、GLB/BIN、Worker | 支持符合响应体、大小和安全策略的资源                                      |
| 登录态、支付、订单、数据库、实时 API              | 不复制服务端业务；通常会报告为在线依赖或不支持                            |
| DRM、付费墙、验证码、反爬虫、访问控制             | 不绕过，也不承诺可镜像                                                    |
| 大型流媒体、持续连接、实时数据                    | 通常只能得到部分镜像                                                      |
| 关闭的 Shadow DOM、设备/GPU 专属行为              | 可能无法完成严格视觉验证                                                  |

“完整”表示在当前捕获范围和验证动作内，本地入口、资源和交互都通过检查；它不表示获得了网站的服务器端功能，也不改变第三方内容的版权归属。详细边界见 [支持范围说明](./docs/validation/SUPPORT_BOUNDARIES.md)。

### 工作方式

```text
Chrome / Edge
    │
    ├─ WebMirror Extension
    │    ├─ 当前标签页预检查
    │    ├─ CDP 网络监听与动态资源发现
    │    └─ 通过 Native Messaging 发送控制消息和元数据
    │
    ▼
Local Helper
    ├─ 资源下载、校验和内容寻址缓存
    ├─ HTML/CSS/JSON/受控 JavaScript 本地化
    ├─ 本地 HTTP 预览服务
    ├─ 离线交互与视觉验证
    └─ 镜像目录、报告和 ZIP 输出
```

流程的关键原则是先保存浏览器已加载的真实运行时，再对资源做保守本地化；不在关键路径上用截图或 AI 重新生成页面。

### 快速开始

#### 环境要求

- Windows 10 或 Windows 11。
- Node.js 24 或更高版本。
- pnpm 11。
- Chrome 或 Microsoft Edge 125 或更高版本。

#### 安装依赖并验证

在仓库根目录执行：

```powershell
pnpm install
pnpm exec playwright install chromium
pnpm verify
```

构建 Windows release candidate：

```powershell
pnpm package:release
```

发行目录会生成在 `packaging/release/dist/`，但该目录被 `.gitignore` 排除，不会进入 Git 历史：

```text
webmirror-extension-chromium.zip
webmirror-windows-native-host.zip
webmirror-sbom.spdx.json
release-manifest.json
```

#### 本地加载扩展

1. 执行 `pnpm --filter @webmirror/extension build`。
2. 打开 `chrome://extensions` 或 Edge 的扩展管理页。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”。
5. 选择 `apps/extension/dist`。
6. 记录 Chrome 和 Edge 各自生成的扩展 ID。

#### 安装 Native Host

从仓库构建安装：

```powershell
.\scripts\windows\install-native-host.ps1 `
  -ChromeExtensionId '<chrome-extension-id>' `
  -EdgeExtensionId '<edge-extension-id>'
```

或者解压 `webmirror-windows-native-host.zip` 后，在解压目录中运行同一个脚本。安装完成后重启浏览器。默认镜像目录为 `%USERPROFILE%\Documents\WebMirror`，共享缓存位于 `%LOCALAPPDATA%\WebMirror\cache\v1`。

### 开发与验证

常用命令：

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify
pnpm test:e2e
pnpm package:release
```

真实站点回归必须串行执行，并且只针对用户拥有或明确获准归档的页面：

```powershell
node scripts/real-site-regression.mjs `
  --plan scripts/real-site-plans/www.kodeclubs.com.json
```

真实页面的临时输入、镜像输出、截图和报告保存在 `.codex-runtime/`，该目录默认不会被 Git 跟踪。

### 输出结构

每个镜像任务通常包含：

```text
mirror-output/
├─ site/                 # 可运行的本地镜像
├─ screenshots/          # 验证截图
├─ mirror.json           # 来源、资源、Hash 和状态
├─ validation.json       # 自动化验证结果
├─ report.html           # 人类可读报告
└─ launch.cmd            # 本地启动入口
```

### 隐私与安全

- 默认在本机处理，不上传页面内容到 WebMirror 云服务。
- 不把 Cookie、Authorization、密码、表单值、LocalStorage 或 SessionStorage 写入镜像。
- 浏览器响应体会经过 URL、大小、MIME、长度和 SHA-256 校验。
- 持久化缓存只接受符合安全条件的无凭据公共响应。
- 私钥、JWT、访问凭据和常见供应商 Token 会触发脱敏或隔离。
- 本地预览服务只绑定 `127.0.0.1`，并限制 Host、路径穿越和网络访问范围。
- 镜像中的第三方 JavaScript 仍然是第三方代码；打开或再分发前应先阅读报告。

请先阅读 [授权使用说明](./docs/legal/AUTHORIZED_USE.md)、[隐私政策草案](./docs/legal/PRIVACY_POLICY_DRAFT.md) 和 [威胁模型](./docs/security/THREAT_MODEL.md)。

### 仓库结构

```text
apps/                 # 浏览器扩展和 Windows Helper
packages/capture/     # CDP 捕获与响应体处理
packages/mirror/      # 下载、发现、重写、缓存和预览
packages/validation/  # 离线验证、交互回放和报告
packages/shared/      # 共享协议、状态和脱敏工具
fixtures/             # 本地运行时与 WebGL 回归页面
scripts/              # Windows、发布和真实站点回归脚本
docs/                 # 安装、法律、验证和发布文档
```

### 许可证与第三方内容

本仓库中的 WebMirror 源代码以 [MIT License](./LICENSE) 发布。MIT License 只适用于本仓库代码，不自动授予任何第三方网站、图片、字体、视频、模型、商标或其他抓取内容的使用权。

请只对自己拥有或明确获准保存、测试和再分发的页面执行镜像。项目不会帮助绕过访问控制，也不鼓励利用镜像进行冒充、钓鱼或未经授权的再发布。

### 项目文档

- [产品需求文档](./PRD.md)
- [项目计划](./PROJECT_PLAN.md)
- [AI 独立开发执行计划](./AI_SOLO_EXECUTION_PLAN.md)
- [Windows Native Host 安装指南](./docs/installation/windows-native-host.md)
- [脚本与视觉验证说明](./docs/validation/SCRIPTED_VALIDATION.md)
- [支持范围说明](./docs/validation/SUPPORT_BOUNDARIES.md)
- [发布清单](./docs/release/PUBLISHING_CHECKLIST.md)

---

## English

### What is WebMirror?

WebMirror is a Chrome and Microsoft Edge extension paired with a local Windows helper that turns an authorized, currently open web page into a high-fidelity offline mirror.

It captures the runtime resources the browser actually used instead of taking a screenshot or generating a look-alike page. For suitable static pages and interactive experiences, WebMirror can preserve HTML, CSS, JavaScript, fonts, images, audio, video, Web Workers, WASM, GLB/BIN assets, and related runtime dependencies, then replay them through a local HTTP preview server.

The project is built around four ideas:

> One click to capture, preserve the original runtime, keep processing local, and report limitations honestly.

WebMirror does not reproduce server-side business logic and does not bypass authentication, paywalls, CAPTCHA, DRM, anti-bot controls, or access restrictions. It is intended for authorized archiving, interactive-demo backup, design review, visual regression, migration work, and offline presentations.

### Current status

The repository contains a working MVP / release-candidate codebase with:

- A Manifest V3 extension for one-click capture of the active tab.
- Chrome DevTools Protocol recording, iframe/Worker target handling, and deferred asset discovery.
- Native Messaging protocol v2 with progress, cancellation, retry, and recovery support.
- Structured HTML, CSS, JSON, and conservative JavaScript URL localization.
- Same-origin response-body reuse, public cross-origin static downloads, and Service Worker CacheStorage fallback.
- Concurrent downloads, SHA-256 verification, content-addressed caching, and HTTP cache revalidation.
- A loopback HTTP preview server with SPA history fallback and MIME/Range/CORS/font/WASM handling.
- Canvas/WebGL, Web Worker, compressed asset, and common 3D-resource support.
- Declarative click, scroll, key, and drag replay with checkpoint screenshots and perceptual comparison.
- Windows Native Host packaging, installation, upgrade, diagnostics, uninstall, and SPDX SBOM generation.
- Human-readable reports for missing resources, online dependencies, blocking errors, and capability boundaries.

The current version is `0.0.60`. The Windows helper is still an unsigned development build; code signing, a public privacy policy, store publication, and the full compatibility matrix remain release gates.

### Support boundaries

| Area                                                             | Current behavior                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary static HTML/CSS/JS                                      | Usually works as a complete offline mirror                                                                                       |
| Static SPAs and client-side routes                               | Captures exercised routes within discovery and page limits                                                                       |
| Canvas/WebGL/Three.js experiences                                | Works for observed and successfully captured runtime assets; GPU, deferred loading, and large media can produce a partial result |
| Images, fonts, audio, ordinary video, WASM, GLB/BIN, and Workers | Supported when they satisfy response-body, size, and security policies                                                           |
| Authenticated sessions, payments, databases, and realtime APIs   | Server-side behavior is not copied; dependencies are reported or unsupported                                                     |
| DRM, paywalls, CAPTCHA, anti-bot, and access controls            | Not bypassed and not guaranteed to mirror                                                                                        |
| Large streaming media, persistent connections, and live data     | Usually results in a partial mirror                                                                                              |
| Closed Shadow DOM and device/GPU-specific behavior               | May prevent complete visual verification                                                                                         |

“Complete” means the local entry point, captured resources, and configured validation actions passed within the declared capture scope. It does not mean that server-side functionality was copied or that third-party content changed ownership. See [Support Boundaries](./docs/validation/SUPPORT_BOUNDARIES.md) for details.

### Quick start

Requirements:

- Windows 10 or Windows 11.
- Node.js 24 or newer.
- pnpm 11.
- Chrome or Microsoft Edge 125 or newer.

From the repository root:

```powershell
pnpm install
pnpm exec playwright install chromium
pnpm verify
pnpm package:release
```

For unpacked development, build the extension, open `chrome://extensions` or the Edge extensions page, enable Developer mode, and load `apps/extension/dist`. Install the Native Host with `scripts/windows/install-native-host.ps1`, passing the extension IDs for the browsers you use.

Generated release candidates are placed under `packaging/release/dist/` and are intentionally ignored by Git because the Windows bundle includes a large validation browser runtime.

### Development

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify
pnpm test:e2e
pnpm package:release
```

Real-site regressions must run serially and only against pages that you own or are explicitly authorized to archive. Temporary real-site evidence is kept under `.codex-runtime/` and is not part of the repository.

### Security and privacy

- Processing is local by default; captures are not uploaded to a WebMirror cloud service.
- Cookies, authorization headers, passwords, form values, LocalStorage, and SessionStorage are not written into mirrors.
- Browser response bodies are checked against URL, size, MIME, length, and SHA-256 policies.
- Persistent caching accepts only safe credential-free public responses.
- Private keys, JWTs, credentials, and common provider tokens are redacted or quarantined.
- Preview servers bind to `127.0.0.1` and enforce Host, path-traversal, and network-scope protections.
- Mirrored JavaScript remains third-party code; review the report before opening or redistributing an output.

Please read [Authorized Use](./docs/legal/AUTHORIZED_USE.md), the [Privacy Policy Draft](./docs/legal/PRIVACY_POLICY_DRAFT.md), and the [Threat Model](./docs/security/THREAT_MODEL.md).

### License and third-party content

WebMirror source code in this repository is released under the [MIT License](./LICENSE). The license applies to this repository's code; it does not grant rights to third-party websites, images, fonts, videos, models, trademarks, or other captured content.

Use the project only for pages you own or are authorized to archive, test, and redistribute. WebMirror is not intended to bypass access controls or facilitate impersonation, phishing, or unauthorized republication.

### Documentation

- [Product requirements](./PRD.md)
- [Project plan](./PROJECT_PLAN.md)
- [AI solo execution plan](./AI_SOLO_EXECUTION_PLAN.md)
- [Windows Native Host guide](./docs/installation/windows-native-host.md)
- [Scripted and visual validation](./docs/validation/SCRIPTED_VALIDATION.md)
- [Support boundaries](./docs/validation/SUPPORT_BOUNDARIES.md)
- [Publishing checklist](./docs/release/PUBLISHING_CHECKLIST.md)
