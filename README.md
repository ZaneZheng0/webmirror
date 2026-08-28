# WebMirror

WebMirror is a Chrome and Microsoft Edge extension plus a local Windows helper
that creates an authorized offline mirror of the active static web page.

## Status

The repository is a functional MVP and release candidate:

- MV3 capture through `chrome.debugger` and the Chrome DevTools Protocol.
- Native Messaging protocol v2 with progress, cancellation, recovery, and
  retry actions, plus bounded browser-response-body transfer.
- Concurrent downloading, bounded recursive resource discovery, URL
  localization, local preview, ZIP export, and automated validation.
- Optional declarative click, scroll, key, and drag replay with checkpoint
  screenshots and tolerant PNG perceptual comparison.
- Filesystem content-addressed caching with SHA-256 verification, HTTP
  freshness, and ETag/Last-Modified conditional revalidation.
- Same-origin `Network.getResponseBody` reuse and conservative Service Worker
  CacheStorage fallback without forwarding Cookie or Authorization headers.
- HTML, CSS, JSON, and conservative JavaScript URL rewriting.
- Web Worker, iframe, Canvas, WebGL, gzip, deflate, Brotli, and zstd coverage.
- Windows SEA helper packaging with a bundled Playwright runtime and Chromium
  Headless Shell.
- Chrome/Edge per-user installation, upgrade, diagnostics, and uninstall
  scripts.

The generated Windows helper is currently an **unsigned development release
candidate**. Store publication, Authenticode signing, a public privacy-policy
URL, and the full beta compatibility matrix remain external release gates.

## Supported Scope

WebMirror targets public or otherwise authorized, primarily static pages whose
visible experience can be reconstructed from GET-accessible resources. It does
not promise a complete clone of authenticated sessions, backend APIs, payment
flows, server-side behavior, DRM content, or arbitrary application state.

For same-origin static GET resources that the browser already received,
WebMirror can transfer the verified response body without transferring browser
credentials. The Helper still applies the private-network policy, and
cross-origin resources use the ordinary credential-free download path.

Missing or forbidden source resources produce a partial mirror rather than
silently fabricating content.

See [Support Boundaries](./docs/validation/SUPPORT_BOUNDARIES.md) for the
current complete, partial, and unsupported behavior matrix.

## Quick Start

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

Generated release candidates:

```text
packaging/release/dist/
  webmirror-extension-chromium.zip
  webmirror-windows-native-host.zip
  webmirror-sbom.spdx.json
  release-manifest.json
```

For unpacked development, load `apps/extension/dist` from the browser's
extension developer page and record the extension ID for each browser.

Install the Native Host from the repository build:

```powershell
.\scripts\windows\install-native-host.ps1 `
  -ChromeExtensionId '<chrome-extension-id>' `
  -EdgeExtensionId '<edge-extension-id>'
```

For a release ZIP, extract `webmirror-windows-native-host.zip`, open PowerShell
in the extracted directory, and run:

```powershell
.\scripts\windows\install-native-host.ps1 `
  -ChromeExtensionId '<chrome-extension-id>' `
  -EdgeExtensionId '<edge-extension-id>'
```

Restart the browser after installing the Native Host. Mirrors are written
under `%USERPROFILE%\Documents\WebMirror` by default. The shared response cache
is stored under `%LOCALAPPDATA%\WebMirror\cache\v1`.

## Verification

```powershell
pnpm verify
pnpm exec playwright test tests/e2e/helper-mirror.spec.ts
pnpm exec playwright test `
  tests/e2e/extension-capture.spec.ts `
  tests/e2e/extension-mirror.spec.ts
pnpm package:release
```

`release-manifest.json` is the source of truth for release file sizes and
SHA-256 hashes.

## Security And Privacy

- Use WebMirror only for pages you own or have explicit permission to archive.
- The extension does not send captures to a WebMirror cloud service.
- Cookies, authorization headers, request bodies, and form values are not
  forwarded to the downloader.
- Browser response bodies are limited to 20 MB each and 50 MB per task, staged
  in private temporary files, and verified by length and SHA-256.
- The persistent cache accepts only credential-free public responses. Browser
  bodies, sensitive query URLs, `private`/`no-store`, `Set-Cookie`, and
  unsupported `Vary` responses bypass it.
- High-confidence private-key, credential, JWT, and provider-token findings
  quarantine the resource, prevent a complete result, and disable ZIP export.
- Page-controlled URL origins/paths and diagnostic text are stored as keyed
  fingerprints with bounded event evidence rather than raw values.
- Validation screenshots mask visible form controls. If closed Shadow DOM
  prevents complete inspection, screenshots and perceptual reference/diff
  artifacts are not persisted and Canvas evidence cannot produce a complete
  result.
- Preview servers bind to `127.0.0.1`, validate the `Host` header, and apply
  restrictive browser security headers.
- Mirrored code is still third-party code. Review the validation report before
  redistributing or trusting an output.

See [Authorized Use](./docs/legal/AUTHORIZED_USE.md),
[Privacy Policy Draft](./docs/legal/PRIVACY_POLICY_DRAFT.md), and the
[Publishing Checklist](./docs/release/PUBLISHING_CHECKLIST.md).

## Project Documents

- [Product requirements](./PRD.md)
- [Project plan](./PROJECT_PLAN.md)
- [AI execution plan](./AI_SOLO_EXECUTION_PLAN.md)
- [Windows Native Host guide](./docs/installation/windows-native-host.md)
- [Scripted and perceptual validation](./docs/validation/SCRIPTED_VALIDATION.md)
- [Support boundaries](./docs/validation/SUPPORT_BOUNDARIES.md)
- [Threat model](./docs/security/THREAT_MODEL.md)
