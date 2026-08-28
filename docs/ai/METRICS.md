# Metrics

## Current Automated Baseline

- Unit/integration test files: 33
- Unit/integration tests: 493
- Helper E2E scenarios: 7
- Extension E2E scenarios: 3
- Scripted validation E2E scenarios: 1
- Total automated E2E scenarios: 11
- Workspace packages with type checks/builds: 7
- Native Messaging protocol version: 2
- Validation report schema version: 2
- Default mirror download concurrency: 8
- Capture quiet window: 2 seconds
- Capture maximum duration: 30 seconds for ordinary pages and 45 seconds
  for interactive/WebGL captures
- Interactive/WebGL minimum observation duration: 20 seconds
- Browser response-body read concurrency: 8
- Browser response-body chunk size: 512 KiB raw
- Browser response-body limit: 20 MiB per resource, 50 MiB per task
- Browser response-body scopes: same-origin plus privacy-qualified public
  cross-origin static GET responses
- Runtime resource recovery: exact captured URL mapping for Fetch, XHR, Worker,
  SharedWorker, and dynamic media/resource element properties
- Deferred static recovery: provable JavaScript callback aliases, lexical and
  bound arguments, finite template domains, structured nested asset
  containers, and exact JSON mappings
- Native Host pending-handler limit: 256
- Recursive discovery rounds: 8
- Default mirror resource limit: 1,500
- Default mirror total download budget: 512 MiB
- Default same-origin navigation page limit: 8
- Content cache schema: filesystem CAS v1
- Cache validator coverage: ETag and Last-Modified
- Warm-cache E2E: source offline, 4/4 resources reused from CAS
- Declarative validation actions: click, scroll, key, and drag
- Maximum scripted actions per validation: 32
- Visual reference limits: 20 MiB per PNG, 50 MiB per validation
- Decoded screenshot comparison limit: 8 megapixels
- Default perceptual tolerance: `threshold=0.15`,
  `maxDifferenceRatio=0.02`, `partialDifferenceRatio=0.15`
- Interaction replay isolation: ephemeral Context, Service Workers/downloads
  disabled, non-local HTTP/WebSocket blocked, WebRTC/WebTransport disabled
- Recoverable client-runtime policy: only known React hydration recovery
  messages and browser-generated media playback cancellations are downgraded
  to warnings, and only after entry, resources, visual evidence, diagnostics,
  remote-request checks, and all configured interactions pass
- Closed Shadow DOM policy: actual/reference/diff screenshots are not
  persisted, and Canvas evidence is marked truncated so the result cannot be
  complete
- Cancellation finalization: cancellation remains accepted through the
  `ready` progress send; validation JSON/report artifacts are removed before a
  cancelled terminal result
- Release SBOM format: SPDX 2.3
- High-confidence secret scan: HTML, JSON, JavaScript/text credentials,
  private keys, JWTs, and common provider tokens
- Open-folder verification: installed-extension E2E clicks the popup action
  and requires a visible Explorer window for the exact mirror directory
- Launch-script verification: installed-extension E2E requires `launch.cmd`
  to reference the actual packaged Helper executable
- Installer E2E isolation: existing Chrome and Edge Native Host registrations
  are snapshotted and restored after the temporary install/uninstall flow

## Authorized Real-Page Regression Benchmarks

Temporary real-page inputs and outputs were not committed or distributed.
The BUG-009 acceptance results below were produced serially with installed
Helper `0.0.60`, Native Messaging protocol 2, and non-local HTTP/WebSocket
traffic blocked during loopback replay.

### Shopify Editions Winter 2026

- Evidence:
  `.codex-runtime/real-site-regressions/www-shopify-com-1786869703983/result.json`
- Downloaded/total resources: 884/895
- Downloaded bytes: 380,189,578
- Fast validation score: 99 (`partial`)
- Local replay HTTP/request failures: 0
- Remote replay requests: 0
- Blocking runtime errors: 0
- Action failures: 0
- Interaction result: all eight planned long-page scroll actions passed
- Partial reason: bounded discovery omitted unrelated linked routes, nine
  optional media dependencies remained unavailable, and recoverable runtime
  events were retained as warnings only after all replay checks passed

### MakeMePulse 2019

- Evidence:
  `.codex-runtime/real-site-regressions/2019-makemepulse-com-1786871456388/result.json`
- Downloaded/total resources: 211/212
- Downloaded bytes: 51,700,591
- Fast validation score: 99 (`partial`)
- Local replay HTTP/request failures: 0
- Remote replay requests: 0
- Blocking runtime errors: 0
- Action failures: 0
- Interaction result: all five configured entry, start, drag, and progression
  actions passed
- Partial reason: the source server itself returned HTTP 403 for
  `landing_center.jpg`

### Because Recollection

- Evidence:
  `.codex-runtime/real-site-regressions/www-because-recollection-com-1786871696186/result.json`
- Downloaded/total resources: 586/631
- Downloaded bytes: 162,897,190
- Fast validation score: 99 (`partial`)
- Local replay HTTP/request failures: 0
- Remote replay requests: 0
- Blocking runtime errors: 0
- Action failures: 0
- Interaction result: both held-click transitions passed and the offline flow
  reached `/laurent-garnier`
- Partial reason: 45 unexercised online dependencies remained reported, while
  the validated artist-transition path stayed fully local

### Active Theory Work

- Evidence:
  `.codex-runtime/real-site-regressions/activetheory-net-1786872287610/result.json`
- Downloaded/total resources: 826/982
- Downloaded bytes: 388,157,665
- Fast validation score: 99 (`partial`)
- Local replay HTTP/request failures: 0
- Remote replay requests: 0
- Blocking runtime errors: 0
- Action failures: 0
- Interaction result: the work listing opened `/work/racer` offline
- Partial reason: optional/unexercised media dependencies and redacted
  credential literals remained reported without affecting the validated flow

### Same-Day Control Runs

The same BUG-009 cycle also retained two generic controls captured with the
immediately preceding Helper `0.0.57`; both passed the same loopback network
isolation checks before the final lifecycle, favicon, and installer hardening:

- KodeClubs:
  `.codex-runtime/real-site-regressions/www-kodeclubs-com-1786864237923/result.json`;
  `partial / 99`, 87/94 resources, 96,122,421 bytes, three checkpoints, and
  zero local failures, remote requests, blocking errors, or action failures.
- MANA:
  `.codex-runtime/real-site-regressions/en-manayerbamate-com-1786860070403/result.json`;
  `partial / 99`, 493/514 resources, 30,594,499 bytes, and zero local failures,
  remote requests, blocking errors, or action failures.

### Established Serial Regression Set

Earlier installed-Helper regressions remain useful compatibility evidence:

- Corn Revolution: `complete / 100`, 94/94 resources, nonblank Canvas, and no
  replay failures.
- Because Recollection: `complete / 100`, 589/589 resources, and both
  held-click artist transitions passed.
- MakeMePulse 2019: `partial / 99`, 211/212 resources; entry, Start, drag, and
  Next passed. The source returned HTTP 403 for `landing_center.jpg`.
- Landon Norris: `partial / 99`, 311/315 resources; menu, On Track, and scroll
  passed.
- Shopify Editions Winter 2026: `partial / 99`, 1,495/1,500 resources; all
  planned scroll actions passed.
- Blind Three.js animation-keyframes regression: `partial / 99`, 260/266
  resources; model drag passed.

Every established flow above completed with no replay remote requests,
blocking runtime errors, local request failures, or action failures.

### Regression Execution Boundary

- A three-process stress run caused 17 Landon response-body reads and 4 worker
  initialization commands to exceed the 3-second CDP command bound. The
  resulting mirror failed because hotlink-protected assets then returned HTTP
  403 to the credential-free fallback.
- The required one-click path was rerun serially and passed. Parallel
  real-site captures are excluded from the current compatibility claim and
  are not a supported user workflow.

### Other Authorized Benchmarks

- Messenger, Igloo, and Species in Pieces retain their previously recorded
  interaction evidence. Their closed-Shadow-DOM and bounded-capture
  limitations remain documented in `KNOWN_ISSUES.md`.

Real-page `regressionPassed=true` means the planned offline replay completed
without local failures, remote requests, or blocking runtime errors. It does
not mean that the resource graph was unbounded or that a real-page perceptual
comparison was executed.

## Release Measurements

Use `packaging/release/dist/release-manifest.json` as the source of truth for
artifact bytes and SHA-256 values. The current Windows bundle is 157,938,278
bytes compressed because it includes the validation browser.

- Release version: `0.0.60`
- Installed Helper SHA-256:
  `8d9965216819c8b087a1d2d9fe42636b668f6030f685c35649ac831c66a5eff7`
- Windows Native Host ZIP SHA-256:
  `58a5549fef022cf9d330f6cad7ae6aba4d67f51b9f1d8a88527ea2f57b415185`
- Chromium extension ZIP SHA-256:
  `6a66b510e4873d8f8911be402922ce620cb19fa91e82b677da9ac686d5577c24`
- SPDX SBOM SHA-256:
  `d792ddf158c7eabb6d5f23af926f20c8aa2e3b9fba9d6ea4cbfe88d632473ee9`
- Authenticode state: unavailable/unsigned in the current development
  environment

## Next Measurements

- P50/P90 `ready_ms` across the 20-page beta matrix
- Peak helper memory by asset count and total bytes
- Cache hit rate across the 20-page beta matrix
- Cross-GPU perceptual similarity at desktop and mobile viewports
- Real-page interaction success for start, next, drag, scroll, and keyboard
  flows
