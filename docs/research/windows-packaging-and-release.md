# WebMirror Windows 本地辅助程序打包与发布方案

## 1. 文档信息

| 字段     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 产品     | WebMirror                                                |
| 主题     | Windows 本地辅助程序、Native Messaging 与浏览器商店发布  |
| 适用范围 | Chrome、Microsoft Edge、Windows 10/11 x64                |
| 文档状态 | 实施建议                                                 |
| 调研日期 | 2026-07-18                                               |
| 关联文档 | `PRD.md`、`PROJECT_PLAN.md`、`AI_SOLO_EXECUTION_PLAN.md` |

本文中的产品名、发布者域名、扩展 ID 和证书主体均为占位值。首次公开 Beta 前必须确定最终发布者名称和域名；Native Messaging host 名称一旦公开发布，后续变更需要扩展和安装包协同迁移。

## 2. 决策摘要

MVP 采用以下发布基线：

1. 本地辅助程序使用 TypeScript 开发，以 Node.js 24 LTS 为运行基线。
2. TypeScript 入口先由 esbuild 打包为单个 CommonJS 文件，再使用 Node.js Single Executable Applications（SEA）生成独立 Windows EXE。
3. Node.js 24 的 SEA 仍标记为 Active development，因此在 POC 阶段设置独立退出门；生产构建固定 Node 精确版本、二进制 SHA-256 和 `postject` 版本。
4. Windows 安装包使用当前受支持的 WiX Toolset 版本生成 MSI。MVP 默认按当前用户安装，不要求管理员权限。
5. 安装目录使用 `%LOCALAPPDATA%\Programs\WebMirror\<channel>\`，Native Messaging 注册写入 `HKCU`。
6. Chrome 和 Edge 分别写入自己的 Native Messaging 注册表键，不依赖 Edge 对 Chrome 注册表键的兼容回退。
7. 开发、Beta、Stable 使用不同的 host 名称、扩展 ID、安装目录、UpgradeCode 和应用数据目录，允许并存。
8. EXE 在 SEA 注入完成后进行 Authenticode 签名；MSI 在包含已签名 EXE 后单独签名。
9. Chrome/Edge 商店只上传扩展 ZIP，不把 EXE 或 MSI 放入扩展包。插件检测不到 helper 时，引导用户从官方 HTTPS 页面下载已签名 MSI。
10. 扩展、helper、通信协议和镜像输出格式独立版本化，通过启动握手协商能力，不要求精确锁步版本。
11. CI 负责可重复构建、测试、签名、安装验证和上传为草稿；公开发布保留人工审批门。
12. Chrome 使用商店原生回滚；Edge 和 helper 默认采用“旧代码重新构建为更高版本”的前向回滚。

MVP 明确不采用：

- 要求用户预装 Node.js 的分发方式。
- Windows Service、开机启动项或常驻系统托盘进程。
- MSIX 作为首版安装技术。
- helper 静默自更新。
- 在 Native Messaging 消息中传输大文件或任意二进制内容。
- 将 Chrome 和 Edge 生产版绑定为同一个扩展 ID。
- 在公开 CI 中保存 PFX 文件或长期代码签名私钥。

## 3. 目标和质量门

### 3.1 目标

- 用户安装一个签名 MSI 后，Chrome 和 Edge 均能发现对应的 Native Messaging host。
- 用户无需安装 Node.js、npm、Python、Visual C++ Build Tools 或其他开发环境。
- 扩展升级和 helper 升级可以独立进行，兼容窗口内不阻断抓取。
- 安装、升级、修复和卸载可以通过标准 Windows Installer 流程完成。
- Stable 发布物可追溯到唯一 Git commit、依赖锁文件、Node 二进制和 CI 运行。
- helper、MSI 和下载清单均可校验签名或 SHA-256。

### 3.2 发布质量门

公开 Beta 前必须满足：

- Windows 10 和 Windows 11 x64 的全新安装、N-1 升级、修复和卸载测试通过。
- Chrome 和 Edge 当前稳定版及前两个主要版本均能完成 host 发现和握手。
- helper EXE 与 MSI 的 Authenticode 验证通过，签名带可信时间戳。
- 稳定版注册表不包含开发版扩展 ID。
- 卸载后 Native Messaging 注册表和程序文件清理完成，用户镜像输出不被删除。
- 不兼容版本能返回明确错误，不能进入抓取流程后再失败。
- Chrome 和 Edge 商店包由同一 Git commit 构建，差异仅来自经过审查的商店 overlay。
- 已至少完成一次扩展回滚演练和一次 helper 前向回滚演练。

## 4. 发布拓扑

```text
Monorepo
  |
  +-- apps/helper (TypeScript)
  |     |
  |     +-- esbuild bundle
  |     +-- Node SEA blob
  |     +-- inject into pinned node.exe
  |     +-- Authenticode sign
  |     +-- WiX MSI
  |
  +-- apps/extension
  |     |
  |     +-- shared Chromium build
  |     +-- Chrome manifest overlay
  |     +-- Edge manifest overlay
  |     +-- deterministic ZIP packages
  |
  +-- packages/protocol
        |
        +-- JSON Schema
        +-- generated TypeScript types
        +-- compatibility tests
```

发布物分为：

| 发布物     | 示例名称                                     | 分发位置                          |
| ---------- | -------------------------------------------- | --------------------------------- |
| helper EXE | `webmirror-helper.exe`                       | 包含在 MSI 内，不单独面向普通用户 |
| Stable MSI | `WebMirror-Helper-1.4.2-x64.msi`             | 官方下载页                        |
| Beta MSI   | `WebMirror-Helper-Beta-1.5.0-beta.3-x64.msi` | Beta 下载页                       |
| Chrome ZIP | `webmirror-chrome-1.4.2.17.zip`              | Chrome Web Store                  |
| Edge ZIP   | `webmirror-edge-1.4.2.17.zip`                | Microsoft Edge Add-ons            |
| SBOM       | `webmirror-helper-1.4.2.cdx.json`            | CI artifact 和发布归档            |
| 发布清单   | `release-manifest.json`                      | CI artifact 和官方发布目录        |
| 校验文件   | `SHA256SUMS.txt`                             | 官方发布目录                      |

helper 不捆绑完整 Chromium。验证流程优先调用用户已安装的 Chrome 或 Edge；如果后续必须分发浏览器运行时，应作为独立组件评审其体积、许可、更新和安全责任。

## 5. Node/TypeScript Helper 打包

### 5.1 技术选型

首选 Node SEA，而不是已经停止维护的旧 `vercel/pkg` 项目。选择理由：

- Node SEA 是 Node.js 官方能力，减少对第三方运行时分叉的依赖。
- 输出是标准 Windows PE 可执行文件，可以使用 Authenticode 签名。
- 用户不需要安装 Node.js。
- 可将纯 JavaScript 依赖打包进入单一入口。
- Node.js 官方文档给出了 Windows 下移除原签名、注入 SEA blob 和重新签名的流程。

2026-07-18 时，Node 24 是 LTS 基线；Node 26 仍属于 Current 线。较新的 Node 文档已经提供直接生成 SEA 可执行文件的 `--build-sea` 流程，但 Stable 发布不应在 Node 26 进入 LTS 并通过完整回归前切换。迁移必须通过 ADR，不能只因为构建命令更短而升级运行时。

备选方案只在 SEA POC 失败时启用：

| 方案                 | 使用条件                                         | 限制                                                   |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `@yao-pkg/pkg`       | SEA 无法兼容关键依赖，且该工具在评审时仍持续维护 | 第三方运行时补丁和升级风险                             |
| 普通 Node 运行时目录 | SEA/打包工具均无法通过测试                       | 不是单 EXE，但仍可由 MSI 捆绑私有 Node，不要求系统安装 |
| Rust 重写 helper     | Node 运行时成为明确的性能、安全或体积瓶颈        | 不进入 MVP，迁移成本高                                 |

### 5.2 依赖约束

SEA 入口应遵循以下约束：

- 使用 esbuild 将所有纯 JavaScript 依赖打入一个 CommonJS 入口。
- 入口只通过普通 `require()` 使用 Node 内置模块；第三方模块必须在 bundle 阶段解决。
- MVP 禁止引入原生 `.node` addon。若必须使用，需单独设计资产提取、ABI、签名和多架构测试。
- 不在 helper 中捆绑 Playwright 浏览器二进制，优先使用 `playwright-core` 和系统 Chrome/Edge。
- 不依赖当前工作目录。程序目录从 `path.dirname(process.execPath)` 获取，用户数据目录显式解析到 `%LOCALAPPDATA%\WebMirror\<channel>\`。
- `NODE_OPTIONS` 不得改变生产 helper 行为。
- 构建入口不得使用运行时从源码目录扫描模块、模板或迁移文件的机制；必要资产必须显式列入 SEA `assets` 或 MSI。
- 生产包不包含源代码、测试 fixture、未压缩 source map 或发布凭据。

### 5.3 SEA 配置基线

Node 24 构建配置建议：

```json
{
  "main": "dist/sea/main.cjs",
  "output": "dist/sea/webmirror-helper.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false,
  "execArgvExtension": "none",
  "assets": {
    "licenses/THIRD_PARTY_NOTICES.txt": "dist/legal/THIRD_PARTY_NOTICES.txt"
  }
}
```

初期关闭 snapshot 和 code cache，原因是：

- 先减少构建差异和动态导入限制。
- helper 启动时间通常不是两分钟镜像指标的主要瓶颈。
- 只有在获得 P50/P95 启动基线后，才值得增加 SEA 构建复杂度。

### 5.4 构建顺序

构建工具必须作为锁定的 `devDependency` 调用，禁止在发布任务中使用未指定版本的 `npx <package>@latest`。

```powershell
npm ci
npm run lint
npm run typecheck
npm run test
npm run build:helper-bundle

node --experimental-sea-config tools/sea/sea-config.json
Copy-Item "$env:NODE_BINARY" "dist/sea/webmirror-helper.exe"

signtool remove /s "dist/sea/webmirror-helper.exe"
npm run stamp:helper-version
node "node_modules/postject/dist/cli.js" `
  "dist/sea/webmirror-helper.exe" `
  NODE_SEA_BLOB `
  "dist/sea/webmirror-helper.blob" `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

npm run sign:helper
npm run verify:helper
```

约束：

- 生成 blob 的 Node 可执行文件必须与被注入的 Node 可执行文件为同一精确版本。
- Node ZIP、`node.exe` 和 `postject` 必须记录 SHA-256。
- 版本资源先写入未签名的 Node EXE，再注入 SEA blob，避免后续 PE 资源工具意外覆盖注入内容。
- 注入和版本资源写入都会改变 PE 文件，因此 Authenticode 签名必须最后执行。
- 构建结束后运行 `webmirror-helper.exe --version-json` 和协议级自检。

### 5.5 EXE 命令面

同一个 EXE 支持以下受控模式：

| 参数                                                     | 用途                                       |
| -------------------------------------------------------- | ------------------------------------------ |
| 浏览器传入的 extension origin，及可选 parent-window 参数 | Native Messaging stdio host                |
| `--version-json`                                         | 输出版本、协议范围、channel、commit 和架构 |
| `--self-test`                                            | 检查可写目录、端口绑定、配置和运行时资产   |
| `--diagnostics <path>`                                   | 生成脱敏诊断包，必须由用户主动触发         |

Chrome/Edge 启动 host 时会把调用扩展的 origin 作为第一个参数传入；Windows 上还可能提供父窗口句柄参数。CLI 解析器必须先区分受信任的维护命令和浏览器启动形态，并将 origin 与当前 channel 的允许列表再次比对。该检查属于 manifest `allowed_origins` 之外的纵深防御，不能代替浏览器注册约束。

不得提供：

- 执行任意 shell 命令的参数。
- 从页面消息指定任意本地文件并返回内容的参数。
- 接收未签名远程脚本或模块的加载参数。
- 以管理员权限运行抓取任务的参数。

### 5.6 打包验收

- 在未安装 Node.js 的干净 Windows VM 中可以启动。
- EXE 不从仓库目录或全局 npm 目录加载模块。
- `--version-json` 与发布清单完全一致。
- Native Messaging 首次握手 P95 小于 1 秒。
- 进程收到 stdin EOF 后必须取消或持久化未完成任务，并在 2 秒内退出，不能留下失去浏览器监督的 Native host 进程。
- EXE 启动、退出和异常不会生成控制台窗口。
- x64 EXE 在 Windows 11 ARM64 的 x64 模拟环境仅作为兼容性观察项，不计入 MVP 正式支持。

## 6. Native Messaging Host

### 6.1 扩展声明

Chrome/Edge 扩展的 `manifest.json` 必须包含：

```json
{
  "manifest_version": 3,
  "permissions": ["nativeMessaging"]
}
```

host 由扩展使用长连接 API 启动。对于镜像任务，应使用 `connectNative()` 维持端口，而不是为每条消息重复调用一次性消息 API。

### 6.2 Host 命名

最终域名前的建议占位名称：

| Channel | Host 名称                   |
| ------- | --------------------------- |
| Dev     | `com.webmirror.helper.dev`  |
| Beta    | `com.webmirror.helper.beta` |
| Stable  | `com.webmirror.helper`      |

名称必须保持小写、点分隔，并符合 Chrome 对 Native Messaging host 名称的字符约束。Stable 名称公开后不再重命名。

### 6.3 Host manifest

Stable 示例：

```json
{
  "name": "com.webmirror.helper",
  "description": "WebMirror local helper",
  "path": "webmirror-helper.exe",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<CHROME_STABLE_EXTENSION_ID>/",
    "chrome-extension://<EDGE_STABLE_EXTENSION_ID>/"
  ]
}
```

实现要求：

- host manifest 与 EXE 安装在同一目录。
- Windows 允许 `path` 相对于 host manifest 目录；这样无需在构建时写死用户名或系统盘。
- 注册表默认值必须是 host manifest 的绝对路径。
- `allowed_origins` 只列出确切扩展 ID，必须保留末尾 `/`，禁止通配符。
- Beta 和 Dev 使用各自 manifest，不能把 Dev ID 放入 Stable manifest。
- 安装包中的 manifest 由已知商店 ID 生成，不能在用户机器上联网获取 ID。
- manifest 内容进入安装包前执行 JSON Schema 和 ID 格式校验。

### 6.4 Windows 注册表

当前用户安装写入：

```text
HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.webmirror.helper
  (Default) = C:\Users\<user>\AppData\Local\Programs\WebMirror\stable\com.webmirror.helper.json

HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.webmirror.helper
  (Default) = C:\Users\<user>\AppData\Local\Programs\WebMirror\stable\com.webmirror.helper.json
```

Beta 和 Dev 使用自己的键名与 manifest。

实施要求：

- WiX RegistryValue 使用 `[INSTALLFOLDER]com.webmirror.helper.json` 写入绝对路径。
- x64 安装包必须验证注册值落入浏览器实际查询的 registry view。
- Edge 虽可兼容查询 Chrome 注册位置，安装包仍显式写 Edge 键，减少浏览器行为变化带来的风险。
- 卸载时只删除本产品创建的精确键，不递归删除父级 `NativeMessagingHosts`。
- 企业版如果需要所有用户安装，后续增加独立的 per-machine MSI，写入 HKLM；不得让一个 MSI 在运行时混合切换 HKCU/HKLM。

### 6.5 开发版注册

开发版不使用正式 MSI，可提供仓库脚本：

```text
scripts/windows/register-native-host-dev.ps1
scripts/windows/unregister-native-host-dev.ps1
```

脚本职责：

- 解析 helper 和 manifest 的绝对路径。
- 只写入 `.dev` 注册表键。
- 输出写入的完整键和值。
- 重复运行保持幂等。
- 卸载脚本只删除 `.dev` 键。
- 不要求管理员权限。

脚本不进入 Stable 用户安装流程。

### 6.6 消息 framing 与大小

Native Messaging 使用本机字节序的 4 字节无符号长度前缀加 UTF-8 JSON，不是 JSON Lines。

设计限制：

- 单条控制消息目标小于 64KB。
- helper 发往浏览器的消息绝不接近 Chrome 的 1MB 上限。
- 资源 body、截图、模型、压缩包和日志文件不通过 Native Messaging 传输。
- 大数据由 helper 直接落盘；消息中只返回任务 ID、状态、计数、相对输出路径和错误摘要。
- 接收端先校验长度上限，再分配 buffer 和解析 JSON。
- 所有消息必须通过版本化 JSON Schema 校验。
- 未知消息类型、重复 ID、超长消息和无效 UTF-8 均返回稳定错误并记录脱敏诊断。

## 7. 版本协商

### 7.1 独立版本

至少维护四个版本：

| 版本           | 示例       | 作用                   |
| -------------- | ---------- | ---------------------- |
| 扩展版本       | `1.4.2.17` | 商店更新顺序           |
| helper SemVer  | `1.4.2`    | Windows 安装和运行时   |
| protocol major | `2`        | 扩展与 helper 消息契约 |
| output schema  | `3`        | 镜像清单和任务结果格式 |

不能用扩展版本代替协议版本，也不能假设同版本号必然兼容。

### 7.2 握手示例

扩展启动后第一条消息：

```json
{
  "id": "019f735b-2b6a-7602-9b5d-b376cfe6d8ea",
  "type": "hello",
  "protocolMin": 1,
  "protocolMax": 2,
  "extension": {
    "version": "1.4.2.17",
    "channel": "stable",
    "browser": "chrome"
  }
}
```

helper 响应：

```json
{
  "id": "019f735b-2b6a-7602-9b5d-b376cfe6d8ea",
  "type": "hello.ok",
  "protocol": 2,
  "helper": {
    "version": "1.4.2",
    "channel": "stable",
    "arch": "x64",
    "commit": "0123456789abcdef"
  },
  "outputSchema": 3,
  "capabilities": ["capture.v1", "preview.v1", "export.zip.v1"]
}
```

### 7.3 协商规则

1. 双方协议范围必须有交集，选择共同支持的最高 protocol major。
2. protocol major 内只允许新增可选字段和能力；删除字段或改变语义必须增加 major。
3. 接收端忽略未知可选字段，但拒绝未知的必填行为。
4. 新功能以 capability 检查为准，不以 helper 版本字符串硬编码判断。
5. channel 必须匹配。Stable 扩展不能连接 Dev/Beta helper。
6. helper 必须验证浏览器传入的扩展 origin，并与 manifest/channel 一致。
7. 不兼容时只允许显示升级说明、打开官方下载安装页和导出诊断，不允许开始抓取。
8. output schema 读取器至少支持当前版和上一版，迁移必须是幂等且保留原文件。

### 7.4 兼容窗口

- Stable 扩展必须兼容当前 Stable helper 和上一 Stable helper。
- Stable helper 必须兼容当前 Stable 扩展和上一 Stable 扩展。
- 新 capability 先发布 helper，再发布依赖该 capability 的扩展。
- 扩展遇到旧 helper 时显示“需要更新本地组件”，不能循环重连。
- helper hotfix 如果不改变协议，可以独立发布。
- 紧急修复不得降低 `protocolMin`/`protocolMax` 的测试覆盖。

## 8. Windows 安装、升级与卸载

### 8.1 安装技术

MVP 使用 WiX Toolset 生成 MSI，原因：

- 可以声明式安装 EXE、manifest 和注册表。
- Windows Installer 提供事务与失败回滚。
- 支持标准修复、升级、卸载和企业软件分发。
- 不需要编写高权限常驻 updater。
- 比 MSIX 更直接地满足当前 Native Messaging 注册和本地 EXE 布局。

使用仓库锁定的受支持 WiX major 和精确版本，不使用已弃用的 WiX v3 工具链。WiX 升级作为依赖升级单独评审。

### 8.2 安装范围和目录

Stable 当前用户安装：

```text
%LOCALAPPDATA%\Programs\WebMirror\stable\
  webmirror-helper.exe
  com.webmirror.helper.json
  THIRD_PARTY_NOTICES.txt
```

运行数据：

```text
%LOCALAPPDATA%\WebMirror\stable\
  config\
  cache\
  logs\
  temp\
```

用户镜像默认位于用户主动选择的输出目录，不属于安装包所有，不随卸载删除。

### 8.3 MSI 身份

每个 channel 和架构使用独立身份：

| 字段                 | 规则                                                |
| -------------------- | --------------------------------------------------- |
| UpgradeCode          | 同一 channel/arch 永久稳定                          |
| ProductCode          | 每次 Major Upgrade 生成新值                         |
| PackageCode          | 每次构建唯一                                        |
| ProductVersion       | 使用 Windows Installer 可比较的三段数字             |
| FileVersion          | 使用四段数字并与发布构建对应                        |
| InformationalVersion | 在 EXE 元数据和发布清单中记录完整 SemVer/预发布信息 |
| ProductName          | 明确包含 WebMirror Helper 及 Beta/Stable channel    |
| Manufacturer         | 与代码签名证书发布者一致                            |

Stable、Beta 不共享 UpgradeCode，避免一个通道卸载或升级另一个通道。

### 8.4 全新安装

安装顺序：

1. 验证 Windows 版本和 x64 架构。
2. 安装已签名 helper EXE、host manifest 和法律声明。
3. 写入 Chrome 和 Edge HKCU Native Messaging 注册。
4. 完成后运行轻量安装校验，不启动浏览器、不创建后台服务。
5. 安装日志包含 MSI 状态和错误码，但不包含用户抓取数据。

安装成功标准：

- 文件存在且签名通过。
- 两个浏览器注册表值均指向存在的 JSON manifest。
- manifest 中 EXE 相对路径可解析。
- `webmirror-helper.exe --version-json` 返回预期版本和 channel。
- 安装器退出码为 0。

### 8.5 升级

采用 MSI Major Upgrade：

- 禁止覆盖式复制 EXE。
- 禁止从高版本静默降级到低版本。
- helper 收到浏览器端口关闭后应迅速退出，减少升级文件锁。
- 如果 helper 正在执行任务，扩展先要求用户完成或取消任务，再启动安装。
- MSI 使用 Restart Manager 处理仍被占用的文件；避免高风险自定义操作。
- N-1 到 N 的升级必须保留用户配置和镜像目录。
- 如果配置需要迁移，helper 在首次启动时执行版本化、可回滚迁移；MSI 不解析业务配置。

升级命令测试示例：

```powershell
msiexec.exe /i WebMirror-Helper-1.4.2-x64.msi /qn /norestart /l*v install.log
```

### 8.6 修复

MSI Repair 应恢复：

- 丢失或损坏的 helper EXE。
- host manifest。
- Chrome/Edge Native Messaging 注册表值。

Repair 不重置用户配置，不删除 cache 和镜像。

### 8.7 卸载

卸载必须：

- 删除本 channel 的两个浏览器注册表键。
- 删除程序目录中的 EXE、manifest 和安装文件。
- 不删除用户创建的镜像输出。
- 默认删除 helper 自有的 config、cache、logs 和 temp；WiX 只对固定的应用数据目录声明精确 `RemoveFile`/`RemoveFolder` 规则，不能对用户选择的输出路径使用通配删除。
- 不删除其他 channel 的注册、程序或数据。
- 不尝试删除 Chrome/Edge 扩展本身。

卸载完成后，扩展再次连接应收到浏览器标准的 “native host not found” 状态，并显示重新安装入口。

### 8.8 自动更新策略

MVP 不实现静默自更新，采用：

1. helper 或扩展只检查版本元数据，不下载或执行任意代码。
2. 发现必须升级时打开官方 HTTPS 下载页。
3. 用户主动运行签名 MSI。
4. 安装后扩展重新握手。

后续若引入自动更新，必须单独完成：

- 签名更新清单。
- 防回滚和 channel 隔离。
- 原子下载与 SHA-256 校验。
- Authenticode 发布者验证。
- 断电恢复。
- 代理、企业策略和离线行为。
- 独立威胁模型和渗透测试。

## 9. 代码签名

### 9.1 证书和密钥

优先使用 Microsoft Artifact Signing 或等价的云端 HSM 代码签名服务，通过 CI OIDC/短期身份完成签名。若所在地、账号或预算无法使用，再选择受信任 CA 的组织验证或 EV 代码签名证书，并将私钥保存在硬件令牌或受控 Key Vault/HSM 中。

禁止：

- 将 PFX 提交到 Git。
- 将 PFX 作为长期明文 CI artifact。
- 在普通 PR workflow 中暴露签名凭据。
- 使用自签名证书发布给公众。

### 9.2 签名顺序

```text
TypeScript bundle
  -> SEA blob
  -> copy pinned node.exe
  -> remove original Node signature
  -> stamp PE version/icon
  -> inject SEA blob
  -> sign helper EXE
  -> verify helper EXE
  -> build MSI containing signed EXE
  -> sign MSI
  -> verify MSI
```

任何发生在签名后的二进制修改都会使签名失效。

### 9.3 SignTool 基线

使用 SHA-256 文件摘要和 RFC 3161 时间戳：

```powershell
signtool sign `
  /fd SHA256 `
  /td SHA256 `
  /tr "<RFC3161_TIMESTAMP_URL>" `
  /a `
  "dist/sea/webmirror-helper.exe"

signtool verify /pa /all /v "dist/sea/webmirror-helper.exe"
signtool verify /pa /all /v "dist/installer/WebMirror-Helper-x64.msi"
```

如果使用 Artifact Signing，具体签名命令由 Microsoft 官方 action/SignTool 插件替代，但验证步骤保持一致。

### 9.4 签名验收

- `Get-AuthenticodeSignature` 状态为 `Valid`。
- SignTool `/pa /all /v` 返回成功。
- Publisher 与官网、MSI Manufacturer 和隐私政策主体一致。
- 时间戳在证书有效期内且可验证。
- 下载后的文件 SHA-256 与发布清单一致。
- Windows Defender 扫描通过。
- Stable 和 Beta 使用同一受信任发布者，Dev 可使用无签名本地构建但不得混入发布目录。

代码签名不保证立刻获得 SmartScreen 声誉。应保持一致的发布者主体、稳定下载域名和低误报率，不频繁更换证书身份。

## 10. Chrome 与 Edge 扩展包

### 10.1 构建原则

- Chrome 和 Edge 共用核心源码。
- 每个商店使用单独 manifest overlay 和单独 ZIP。
- ZIP 根目录直接包含 `manifest.json`，不能再套一层项目目录。
- 扩展包不包含 MSI、EXE、Node 运行时、测试文件和 source map。
- 生产 manifest 不包含非必要的 `update_url`。
- 构建结果应确定性排序，CI 记录每个 ZIP 的 SHA-256。

### 10.2 商店差异

overlay 只允许包含：

- 商店专用扩展名称或支持链接。
- 商店特定权限说明或策略链接。
- 商店构建标识。
- 已审查的浏览器兼容配置。

禁止在两个 overlay 中维护不同业务逻辑。差异需要通过构建期常量和测试显式覆盖。

### 10.3 版本映射

Chrome/Edge manifest `version` 使用一到四段数字。建议：

```text
SemVer:       1.4.2
Store version 1.4.2.17
version_name: 1.4.2 (build 17, commit 01234567)
```

规则：

- 第四段为每个 listing 单调递增的 build counter。
- CI 在上传前读取商店当前版本并拒绝非递增版本。
- Beta 和 Stable 是不同 listing，因此各自维护 counter。
- helper 使用独立 SemVer，不与 store build counter 绑定。
- Git tag 只指向一次不可变源码发布；重试构建不能覆盖已有 artifact。

### 10.4 固定扩展 ID

在生成 Stable host manifest 前必须先创建两个商店草稿，获得：

- Chrome Stable extension ID。
- Edge Stable extension ID。
- 如发布 Beta，再分别获得两个 Beta ID。

本地 Chrome 测试可以使用 manifest `key` 固定与商店一致的扩展 ID。`key` 只包含公钥，不是签名私钥；仍应只放入明确的开发/测试 overlay。Edge 的本地测试 ID单独记录，不假设与 Chrome 一致。

建议顺序：

1. 在两个商店创建最小草稿 listing。
2. 记录 ID 到受审查的 release 配置。
3. 生成 Stable/Beta host manifests。
4. 构建并签名 MSI。
5. 上传带正式 host 名称的扩展包。

### 10.5 商店材料

两个商店均需准备：

- 单一用途说明：授权网页的高保真离线镜像。
- `nativeMessaging`、`debugger`、当前标签页和下载/存储权限的逐项用途。
- 本地 helper 为什么必要、处理哪些数据、数据存储位置。
- 明确说明页面内容默认不上传。
- 隐私政策、使用条款、支持邮箱和官方下载安装页。
- 安装、升级和卸载步骤。
- 审核人员可复现的测试页面与操作说明。
- helper 安装包 SHA-256、签名发布者和病毒扫描结果。

Beta listing 必须在名称、图标或描述中清楚标记为测试版本，避免用户误认为 Stable。

### 10.6 商店 API

Chrome：

- 新 listing 和首次发布保留人工操作。
- 后续更新使用 Chrome Web Store API V2。
- Chrome Web Store API V1 将于 2026-10-15 停止服务，因此本项目不新增 V1 集成。
- CI 只自动上传为 draft；发布或扩大分发范围需要受保护环境审批。

Edge：

- 新 listing 和首次提交保留人工操作。
- 后续更新使用 Microsoft Edge Add-ons API v1.1。
- API 凭据存入受保护 CI environment，设置到期提醒并定期轮换。
- 上传、提交和发布状态分别记录，不能把上传成功视为已发布。

## 11. 发布通道

| 项目        | Dev                        | Beta                        | Stable                 |
| ----------- | -------------------------- | --------------------------- | ---------------------- |
| 扩展安装    | Unpacked                   | 独立测试 listing            | 公开 listing           |
| Host        | `com.webmirror.helper.dev` | `com.webmirror.helper.beta` | `com.webmirror.helper` |
| 程序目录    | `...\WebMirror\dev`        | `...\WebMirror\beta`        | `...\WebMirror\stable` |
| 数据目录    | `...\WebMirror\dev`        | `...\WebMirror\beta`        | `...\WebMirror\stable` |
| UpgradeCode | Dev 脚本，无 MSI           | Beta 专用                   | Stable 专用            |
| 签名        | 可不签名                   | 正式可信签名                | 正式可信签名           |
| 更新        | 手动构建                   | 受控测试发布                | 分阶段/人工发布        |

通道规则：

- Dev、Beta、Stable 可以同时存在。
- 不共享可变配置数据库，避免新 schema 污染 Stable。
- 内容寻址的只读资源缓存是否跨通道共享，需在安全和锁测试通过后再启用；MVP 默认不共享。
- Stable 扩展不能主动发现或连接 Beta/Dev host。
- Beta 用户迁移到 Stable 使用独立安装，不直接把 Beta MSI 转换为 Stable。

## 12. CI/CD 设计

### 12.1 Workflow 分层

建议拆分为：

| Workflow                | 触发             | 是否签名   | 结果                                      |
| ----------------------- | ---------------- | ---------- | ----------------------------------------- |
| `ci.yml`                | PR、main         | 否         | lint、typecheck、unit、协议和 bundle 测试 |
| `package-helper.yml`    | release tag/手动 | 需审批     | 已签名 EXE、MSI、SBOM、校验值             |
| `package-extension.yml` | release tag/手动 | 否         | Chrome/Edge ZIP                           |
| `release-smoke.yml`     | package 完成     | 使用发布物 | 安装、握手、升级、卸载和浏览器 E2E        |
| `publish-draft.yml`     | smoke 通过       | 商店凭据   | 上传 Chrome/Edge draft                    |
| `promote-release.yml`   | 人工审批         | 商店凭据   | 提交审核或发布                            |

签名和商店发布 job 必须使用受保护 environment，不能由来自 fork 的 PR 触发。

### 12.2 Helper 构建流水线

1. Checkout 固定 commit。
2. 校验 tag、版本文件和 changelog 一致。
3. 安装固定 Node LTS；校验下载的官方 Node 二进制 SHA-256。
4. `npm ci`，拒绝 lockfile 变化。
5. 运行 lint、typecheck、unit、协议和安全测试。
6. esbuild bundle，生成许可证清单。
7. 生成 SEA blob并注入 Node EXE。
8. 写入文件版本、产品名、架构和 commit。
9. 在受保护签名 job 中签名 EXE。
10. 验证 EXE 并运行 `--version-json`、`--self-test`。
11. 生成 WiX MSI。
12. 签名并验证 MSI。
13. 生成 CycloneDX SBOM、SHA-256 和发布清单。
14. 上传不可变 CI artifact。

### 12.3 扩展构建流水线

1. 从同一 tag/commit 构建共享扩展。
2. 应用 Chrome overlay，校验 manifest 和权限快照。
3. 应用 Edge overlay，校验 manifest 和权限快照。
4. 运行单元测试和浏览器 E2E。
5. 生成两个确定性 ZIP。
6. 解压检查根目录、禁止文件和包大小。
7. 输出 manifest diff，只允许白名单字段不同。
8. 生成 SHA-256 并上传 artifact。

### 12.4 安装与升级测试

发布 smoke 使用全新 Windows VM，至少覆盖：

```text
全新安装 N
  -> 查询 Chrome/Edge 注册表
  -> helper 签名校验
  -> Native Messaging hello
  -> 创建最小镜像任务
  -> MSI repair
  -> N-1 升级到 N
  -> 再次握手和任务
  -> 卸载
  -> 注册表和程序文件不存在
  -> 用户输出仍存在
```

CI 中增加负向测试：

- Stable 扩展连接 Beta host。
- 篡改 host manifest。
- 篡改 helper EXE。
- 注册表指向不存在文件。
- 协议范围无交集。
- helper 在升级时仍运行。
- 尝试安装低版本。
- MSI 安装中途失败并触发 Windows Installer rollback。

GitHub 托管 Windows runner不能替代真实 Windows 10/11 客户端验证。正式候选应使用可重置的自托管 VM 或 Azure Windows 客户端镜像，并在测试后销毁或恢复快照。

### 12.5 供应链控制

- npm lockfile 和 WiX/Node/postject/esbuild 精确版本进入版本控制。
- GitHub Actions 使用固定 major 至少不够；关键发布 action应固定 commit SHA。
- 生成依赖许可证和 SBOM。
- 发布 artifact 开启不可变保留策略。
- 记录 Node 下载 URL、SHA-256、签名状态和来源。
- Store API、时间戳服务、签名服务失败时停止发布，禁止生成“部分签名”的 Stable 版本。
- CI artifact 与最终官网文件再次比对 SHA-256。
- Release manifest 至少包含：

```json
{
  "product": "WebMirror Helper",
  "version": "1.4.2",
  "channel": "stable",
  "arch": "x64",
  "commit": "0123456789abcdef",
  "nodeVersion": "24.x.y",
  "protocolMin": 1,
  "protocolMax": 2,
  "outputSchema": 3,
  "files": [
    {
      "name": "WebMirror-Helper-1.4.2-x64.msi",
      "sha256": "<SHA256>"
    }
  ]
}
```

## 13. 发布顺序

普通功能发布：

1. 合并协议兼容实现和测试。
2. 构建、签名并发布向后兼容的 helper。
3. 验证下载、安装、升级和握手。
4. 等待 Beta 观测窗口。
5. 构建扩展并上传 Chrome/Edge draft。
6. 完成商店审核说明和 E2E。
7. 先发布 Beta listing。
8. 指标稳定后发布 Stable。

仅扩展修复：

1. 确认不提高最低 helper/protocol 要求。
2. 构建两个商店包。
3. Beta 发布和回归。
4. Stable 发布。

仅 helper hotfix：

1. 保持协议范围不变。
2. 构建并签名更高 helper/MSI 版本。
3. 完成 N-1 升级测试。
4. 更新官网下载和兼容提示。
5. 扩展无需重新提交商店。

## 14. 回滚策略

### 14.1 三类回滚

| 类型            | 含义                       | 方法                                                |
| --------------- | -------------------------- | --------------------------------------------------- |
| 安装事务回滚    | MSI 安装过程失败           | 依赖 Windows Installer 自动恢复文件和注册表         |
| helper 发布回滚 | 新 helper 已发布但存在问题 | 用旧代码构建一个更高版本并正常升级                  |
| 扩展商店回滚    | 新扩展已发布但存在问题     | Chrome 使用原生 rollback；Edge 提交更高版本的旧代码 |

### 14.2 Chrome

Chrome Web Store 支持从开发者后台回滚到最近一次已发布版本。商店会以新的、更高版本号重新发布旧包，通常无需重新审核。执行前仍需：

- 确认旧扩展能读取当前 `chrome.storage` 数据。
- 确认旧扩展仍兼容当前 helper。
- 保存回滚原因、操作人、时间和结果。
- 回滚后立即生成修复分支，不能把商店回滚当作永久版本策略。

### 14.3 Edge

截至本文调研日期，引用的 Edge 发布文档未提供与 Chrome 等价的即时回滚流程。计划默认：

1. 暂停或撤销有问题的提交/分发。
2. 从上一已知正常 commit 构建相同代码。
3. 提升 manifest 版本。
4. 上传并提交新的 Edge 包。
5. 在认证等待期间通过支持页说明问题。

因此 Edge Stable 发布必须先经过 Beta，并预留商店认证延迟。

### 14.4 Helper

不直接安装更低 MSI 版本。推荐“前向回滚”：

```text
1.4.2 有缺陷
  -> 取 1.4.1 的代码
  -> 应用必要的版本/兼容补丁
  -> 发布为 1.4.3
```

优点：

- 保持 Windows Installer 版本单调。
- 不要求用户先卸载。
- 不破坏配置和注册。
- 可使用标准 N-1 到 N 升级测试。

始终保留：

- 最近三个 Stable 的源 commit。
- 最近三个已签名 MSI。
- 对应 SBOM、SHA-256、构建日志和发布清单。
- 每个版本的扩展/helper/protocol/output 兼容矩阵。

### 14.5 回滚触发条件

出现以下情况立即停止扩大发布并评估回滚：

- helper 无法启动或 host 发现失败率明显增加。
- 安装/升级失败率超过发布门阈值。
- 出现凭据、Cookie、Token 或用户文件泄漏。
- helper 可被任意网页调用。
- 本地服务出现任意文件读取或命令执行风险。
- 抓取核心成功率较上一 Stable 下降 3 个百分点以上。
- 崩溃率或不可恢复任务比例较上一 Stable 翻倍。
- 代码签名、下载 Hash 或发布来源无法验证。

安全事件不等待完整指标窗口，直接暂停下载和商店发布。

## 15. 优化路线

### 15.1 构建速度

优先级顺序：

1. 缓存 npm 下载和固定 Node ZIP。
2. esbuild 单入口增量构建用于 Dev，Release 仍全量构建。
3. helper、installer、extension 并行构建，但签名和最终发布串行审批。
4. 只有源/依赖发生变化时重建 helper；文档变化不触发签名。
5. Windows VM 镜像预装 WiX、Windows SDK 和浏览器，运行时仍校验版本。

### 15.2 安装可靠性

- 尽量只使用 WiX 声明式文件和注册表组件。
- 避免 deferred custom action。
- 不启动服务、不写系统 PATH、不安装浏览器策略。
- 不修改 Chrome/Edge 安装目录。
- 不在安装时联网下载运行依赖。
- 不在安装时扫描用户镜像目录。

### 15.3 EXE 体积和启动

- 接受 Node SEA 的基础体积，MVP 不以极端压缩换取不透明构建。
- 使用 MSI 压缩减少下载体积。
- 排除 source map、测试数据和重复许可证文件。
- 测量冷启动 P50/P95 后再评估 SEA code cache。
- helper 进程在长连接期间复用，不为每个进度事件重启。

### 15.4 发布速度

- Chrome 和 Edge 包从同一构建并行上传为 draft。
- 商店说明、截图和测试账号在功能冻结前完成。
- Beta 与 Stable 使用独立 listing，避免测试包污染公开用户。
- 每次 Stable 发布前自动生成权限 diff、manifest diff 和兼容矩阵。
- 先自动化高频、可逆步骤；首次 listing、权限扩大和最终发布保持人工审批。

### 15.5 后续候选

以下优化不进入 MVP：

- Node 26 LTS 后迁移到内置 `--build-sea`。
- Windows ARM64 原生 helper 和独立 MSI。
- 差分更新。
- 静默后台更新。
- 企业 HKLM 安装包和组策略部署模板。
- Microsoft Store/MSIX 分发。
- 跨通道共享内容缓存。
- 自动化多阶段商店 rollout。

## 16. 分阶段执行任务

### 阶段 A：身份和 POC

任务：

- 确定最终发布者域名、产品名和 Native host namespace。
- 创建 Chrome/Edge 草稿 listing，预留 Stable/Beta ID。
- 用最小 TypeScript 程序完成 esbuild + Node 24 SEA。
- 在未安装 Node.js 的 Windows 10/11 VM 运行。
- 验证签名前注入、签名后启动和 Native Messaging framing。

退出标准：

- EXE 可独立启动并返回版本。
- Chrome 和 Edge 均能通过手工注册 host 完成 hello。
- 方案不存在必须依赖原生 addon 的阻断项。

### 阶段 B：正式 Helper 构建

任务：

- 建立可重复 SEA 构建脚本。
- 固定 Node/postject/esbuild 版本和 Hash。
- 实现 `--version-json`、`--self-test`。
- 加入协议 Schema、消息大小限制和 origin 校验。
- 生成 SBOM、许可证和 release manifest。

退出标准：

- 两次干净构建的业务 bundle Hash 一致。
- EXE 在干净 VM 通过自检。
- 畸形 framing 和超长消息测试通过。

### 阶段 C：WiX 安装包

任务：

- 建立 per-user x64 MSI。
- 安装 EXE、manifest 和 Chrome/Edge HKCU 注册。
- 配置 channel 独立 UpgradeCode。
- 实现 Major Upgrade、Repair 和 Uninstall。
- 验证用户数据保留。

退出标准：

- 全新安装、升级、修复和卸载矩阵通过。
- 没有高权限 custom action。
- 失败安装可自动回滚。

### 阶段 D：生产签名

任务：

- 申请并验证代码签名主体。
- 接入 Artifact Signing/HSM。
- 建立受保护 CI environment。
- 签名 EXE 和 MSI并自动验证。
- 建立证书过期、时间戳和密钥轮换告警。

退出标准：

- 公共 Beta 文件在干净 VM 显示预期 Publisher。
- 无私钥进入仓库或普通 CI artifact。

### 阶段 E：浏览器商店包

任务：

- 建立 Chrome/Edge overlay。
- 固定商店 ID 和 host allowed origins。
- 实现数字版本递增检查。
- 准备权限说明、隐私政策和审核手册。
- 完成 Beta listing 提交。

退出标准：

- 两个 ZIP 的差异仅限白名单字段。
- 安装商店扩展后可发现已签名 helper。

### 阶段 F：CI 发布和回滚

任务：

- 建立 package、smoke、draft upload、promote workflows。
- 接入 Chrome API V2 和 Edge API v1.1。
- 完成 N-1 升级测试。
- 演练 Chrome rollback。
- 演练 Edge 扩展和 helper 前向回滚。

退出标准：

- 从 Git tag 到 draft artifact 全流程可重复。
- 发布审批、审计记录和回滚手册可由非当前会话执行。

## 17. 最终检查清单

### Helper

- [ ] Node 精确版本和 SHA-256 已锁定。
- [ ] SEA blob 与目标 Node EXE 版本一致。
- [ ] EXE 在注入和版本写入后签名。
- [ ] 无原生 addon 或未声明外部依赖。
- [ ] `--version-json` 与发布清单一致。
- [ ] stdin EOF、崩溃和取消任务行为已测试。

### Native Messaging

- [ ] Chrome/Edge 注册表键均存在。
- [ ] registry view 已在 x64 VM 验证。
- [ ] manifest 只允许对应 channel 的确切扩展 ID。
- [ ] Stable 不包含 Dev/Beta ID。
- [ ] framing、消息上限和 Schema 校验已测试。
- [ ] 资源内容不经过 Native Messaging。

### Installer

- [ ] 全新安装、Major Upgrade、Repair、Uninstall 通过。
- [ ] 无管理员权限即可完成默认安装。
- [ ] 不安装服务、计划任务或浏览器策略。
- [ ] 卸载不删除用户镜像。
- [ ] 失败安装可回滚。

### Signing

- [ ] EXE 和 MSI 的 Authenticode 有效。
- [ ] RFC 3161 时间戳有效。
- [ ] Publisher 与官网主体一致。
- [ ] CI 无长期私钥泄漏。
- [ ] 官网下载文件与 CI artifact Hash 一致。

### Store

- [ ] Chrome/Edge ZIP 根目录正确。
- [ ] 版本严格递增。
- [ ] 权限和 manifest diff 已审查。
- [ ] 隐私政策、安装说明和 reviewer steps 已发布。
- [ ] Beta 已完成真实安装和升级观察。

### Rollback

- [ ] Chrome 原生回滚已演练。
- [ ] Edge 旧代码高版本包已演练。
- [ ] helper 前向回滚 MSI 已演练。
- [ ] 最近三个 Stable artifact 和兼容矩阵可访问。

## 18. 官方资料与工具文档

以下资料均在 2026-07-18 核对；浏览器商店 API、Node SEA 和签名服务仍可能变化，实施前应再次确认。

### Node.js

1. [Node.js releases and LTS schedule](https://nodejs.org/en/about/previous-releases)
2. [Node.js 24 LTS: Single executable applications](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html)
3. [Node.js current: Single executable applications](https://nodejs.org/api/single-executable-applications.html)
4. [Node.js postject tool](https://github.com/nodejs/postject)

### Chrome

5. [Chrome Extensions: Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
6. [Chrome extension manifest: key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
7. [Chrome extension manifest: version](https://developer.chrome.com/docs/extensions/reference/manifest/version)
8. [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
9. [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
10. [Chrome Web Store service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
11. [Roll back a Chrome Web Store release](https://developer.chrome.com/docs/webstore/rollback)

### Microsoft Edge

12. [Microsoft Edge extensions: Native messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
13. [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
14. [Microsoft Edge Add-ons API v1.1](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)

### Windows 安装与签名

15. [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
16. [Microsoft Artifact Signing overview](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
17. [Windows Installer installation context](https://learn.microsoft.com/en-us/windows/win32/msi/installation-context)
18. [Windows Installer rollback installation](https://learn.microsoft.com/en-us/windows/win32/msi/rollback-installation)
19. [WiX Toolset MajorUpgrade element](https://docs.firegiant.com/wix/schema/wxs/majorupgrade/)

### CI 供应链

20. [GitHub Actions artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
