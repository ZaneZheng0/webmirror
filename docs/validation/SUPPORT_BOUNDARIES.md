# WebMirror Support Boundaries

WebMirror mirrors authorized client-side experiences. It preserves the
captured browser runtime and static resources; it does not recreate the
source server.

## Expected To Work

- One active public or otherwise authorized page.
- HTML, CSS, JavaScript, ES modules, JSON, images, fonts, audio, and ordinary
  video available through static `GET` requests.
- Static SPA routes and up to 8 discovered same-origin navigation pages.
- Worker, SharedWorker, WASM, GLB, GLTF, BIN, DDS, KTX, common compressed
  textures, and other captured WebGL assets.
- Runtime-composed Fetch, XHR, Worker, media, model, shader, and texture URLs
  when the exact resource was observed by the browser or the construction is
  provably finite during static analysis.
- Canvas and WebGL pages whose required rendering capability profile is
  available in the validation browser.
- Pages within the default 1,500-resource and 512 MiB task limits.

## Expected Partial Results

- A source resource returns 403, 404, 5xx, or exceeds the 20 MiB per-resource
  safety limit.
- The reachable graph exceeds 1,500 resources, 512 MiB, or 8 same-origin
  navigation pages.
- A lazy URL is neither observed during capture nor safely provable from
  JavaScript or JSON.
- Optional analytics, consent, advertising, telemetry, or large media is
  unavailable while the static experience remains runnable.
- Recoverable framework hydration errors occur without local resource or
  interaction failures.
- Closed Shadow DOM prevents complete screenshot, form, or Canvas inspection.
- Browser, GPU, or compressed-texture capability differences require a
  different runtime asset variant.

A `PARTIAL` result can still be a fully usable exercised page. The report must
state the missing resources and capability boundaries; it must not relabel
the result as complete.

## Not Supported

- Authentication, private APIs, database state, payments, checkout, order
  processing, admin behavior, or other server-side business logic.
- Saving or replaying Cookie, Authorization, passwords, form values,
  LocalStorage, SessionStorage, or browser identity tokens.
- Bypassing login, CAPTCHA, DRM, paywalls, anti-bot systems, or access
  controls.
- Live WebSocket, WebRTC, WebTransport, multiplayer, collaboration, chat, or
  continuously changing backend state.
- DRM or adaptive streaming media and unrestricted large-file archival.
- Guaranteed pixel identity across different browsers, operating systems, or
  GPUs.
- Automatic semantic testing of arbitrary controls drawn only inside Canvas.

## Completion And Timing

- `COMPLETE` requires a runnable local entry, no missing retained resources,
  no unexpected remote requests, no blocking runtime error, and sufficient
  validation evidence.
- `PARTIAL` means the exercised local page runs but one or more source,
  capability, evidence, or bounded-capture limitations remain.
- `FAILED` means no runnable entry was produced or a blocking error prevents
  the exercised flow.
- The P90 target below 120 seconds applies only to a single page with at most
  500 resources, at most 50 MiB total, no individual resource above 20 MiB,
  and stable network throughput of at least 20 Mbps.
- Larger pages continue while the Helper reports progress. The extension
  treats 10 consecutive minutes without a matching job progress event as an
  inactive Helper operation and requests cancellation.

Real-page regression commands run serially. Parallel interactive captures are
outside the current supported workflow because they can saturate the local
CDP response-body command budget.
