# Known Issues

- The Windows Native Host release candidate is not Authenticode signed and is
  distributed as a ZIP rather than an MSI/MSIX installer.
- Chrome Web Store and Microsoft Edge Add-ons publication has not been
  performed.
- Source-bound same-origin and privacy-qualified public cross-origin static GET
  resources already received by the browser can use a verified response body
  without forwarding credentials. Credential-bound resources, private/no-store
  responses, POST bodies, DRM, and server-side state may still be partial or
  fail.
- A source resource that returns 403, 404, or another unrecoverable response is
  reported as missing; WebMirror does not bypass access controls.
- Runtime-generated URLs that exactly match an already-downloaded public
  resource are remapped locally for supported Fetch, XHR, Worker, and dynamic
  element paths. Deferred JavaScript and JSON graphs are expanded only when
  lexical values, callback arguments, and template domains are provably
  finite. URLs that were not captured or cannot be identified safely remain
  blocked/reportable online dependencies because JavaScript rewriting is
  intentionally conservative.
- Browser response-body reuse is limited to 20 MB per resource and 50 MB per
  task. Larger resources use the credential-free Helper download path.
- Real-site regression captures are run serially. Three simultaneous
  interactive captures on the current workstation caused CDP
  `Network.getResponseBody` and worker `Network.enable` commands to exceed
  their 3-second command bound. The same Landon Norris flow passed when rerun
  alone. A body-read timeout can still make a hotlink-protected public asset
  partial because the credential-free Helper fallback does not forward
  browser credentials or captured request headers.
- A MakeMePulse replay launched immediately after a roughly 380 MB Shopify
  WebGL regression remained in the source runtime's shader-compilation loader
  even though the mirror files were byte-identical to a passing run and no
  local, remote, console, or page failure occurred. The same mirror and a full
  installed-extension rerun passed in a clean browser process. Back-to-back
  high-GPU-load stability remains part of the pending compatibility matrix;
  the regression runner does not silently downgrade an action failure.
- CacheStorage fallback is read-only and limited to observed same-origin
  Service Worker responses without `Vary`, `private`, or `no-store`
  ambiguity. Other cache variants are intentionally skipped.
- The persistent CAS currently performs lazy integrity repair but does not yet
  expose user-facing age/size cleanup or full orphan-object garbage
  collection.
- High-confidence credential findings quarantine the affected resource and
  block ZIP export. Ambiguous page text is not rewritten or silently redacted.
- Fast validation checks runtime errors, local HTTP failures, remote requests,
  screenshots, and Canvas/WebGL nonblank output. Optional deep validation now
  supports declarative click, scroll, key, and drag actions plus tolerant PNG
  comparison when a trusted adapter supplies reference images.
- The one-click flow does not automatically infer Canvas semantics or capture
  live source action-state baselines. Random animation, video, font, and
  cross-GPU comparison still require stable adapter-specific references and
  the pending compatibility matrix.
- Large pages remain bounded by the Helper's default 1,500-resource and
  512 MiB total-download limits, with up to 8 same-origin navigation pages.
  Runtime-critical scripts, modules, workers, styles, fonts, and directly
  rendered media are prioritized before optional resources. When a page
  exceeds those limits, the manifest reports a capability boundary and the
  result remains `PARTIAL`. Byte-budget omissions are retained as skipped
  resource records; resource-count overflow is currently summarized by count
  and does not list every omitted URL.
- A real-page `regressionPassed` result means the planned offline replay had no
  local failures, remote requests, or blocking runtime errors. It does not
  mean every reachable resource was retained or that pixel-level perceptual
  comparison was run.
- Validation recognizes a narrow set of recoverable client-runtime events:
  known React hydration recovery messages and browser-generated media
  playback cancellations caused by `pause()`, a new load, or removal of the
  media element. These events are retained as warnings and keep the result
  `PARTIAL` only after the local entry, resources, screenshots, Canvas,
  diagnostics, optional perceptual checks, and all planned interactions pass
  with no unexpected remote request. Any unrelated runtime error, diagnostic
  truncation, action failure, or local resource failure remains blocking.
- A page that creates closed Shadow DOM is validated conservatively. Because
  form controls and Canvas surfaces inside that tree cannot be inspected
  completely without changing page semantics, screenshot/reference/diff
  artifacts are omitted and the result cannot be `COMPLETE`.
- Validation reports intentionally replace remote URL origins and paths with
  keyed fingerprints. This protects form and page data but means an individual
  dependency path is not recoverable from the report.
- The bundled browser and Playwright runtime make the Windows package large
  (approximately 158 MB compressed).
- The full 20-page beta matrix and Windows 10/11 plus Edge compatibility matrix
  remain to be executed.
