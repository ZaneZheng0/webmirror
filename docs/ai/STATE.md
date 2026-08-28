# Current State

- Current phase: release handoff and beta readiness.
- Active task: none. `BUG-009` is complete; external release and compatibility
  matrix tasks remain blocked on their documented gates.
- Last verified date: 2026-08-16.
- Current build: extension, Helper source, Windows Native Host package, and
  release manifest report `0.0.60`.
- Installed Native Host:
  `C:\Users\zzp\AppData\Local\Programs\WebMirror\stable`.
- Installed Helper SHA-256:
  `8d9965216819c8b087a1d2d9fe42636b668f6030f685c35649ac831c66a5eff7`.
- Installation diagnostics:
  - Packaged and installed Helper hashes match.
  - Chrome and Edge Registry32/Registry64 registrations point to the stable
    `0.0.60` installation.
  - Chrome-style and Edge-style protocol-2 handshakes return Helper `0.0.60`.
  - Installation succeeds even when the parent environment contains both
    `NO_COLOR` and `FORCE_COLOR`.
  - The only diagnostic warning is the expected unsigned development build.
- `BUG-009` generic hardening result:
  - Required scripts, styles, JSON, WASM, models, binaries, images, fonts,
    audio, and video reject incompatible response bodies instead of accepting
    SPA fallback HTML.
  - Public storefront configuration and client identifiers no longer trigger
    credential quarantine, while private credentials remain blocking.
  - Interactive capture keeps a 20-second minimum discovery window and cannot
    finish on a stale root `load` event before the refreshed root document is
    observed.
  - Equal-content timestamped runtime aliases can merge safely; aliases with
    different or unknown hashes remain ambiguous.
  - Deep activity pages traverse only their active route subtree instead of
    downloading unrelated global navigation trees.
  - Initial source navigation retries only bounded transient Chromium network
    errors.
  - Browser-generated implicit `/favicon.ico` requests no longer downgrade an
    otherwise complete mirror; explicitly linked or parameterized icons are
    still captured.
  - Native Host command probes isolate machine-readable output from conflicting
    terminal color variables.
  - No source-domain branch was added.
- Installed-extension real-site evidence with non-local HTTP/WebSocket blocked
  during loopback replay:
  - Shopify Editions Winter 2026:
    `.codex-runtime/real-site-regressions/www-shopify-com-1786869703983/result.json`;
    `partial / 99`, 884/895 resources, 380,189,578 bytes, all eight scroll
    actions passed, and zero local failures, remote requests, blocking errors,
    or action failures.
  - MakeMePulse 2019:
    `.codex-runtime/real-site-regressions/2019-makemepulse-com-1786871456388/result.json`;
    `partial / 99`, 211/212 resources, all five interactions passed, and zero
    local failures, remote requests, blocking errors, or action failures. The
    source itself returns HTTP 403 for `landing_center.jpg`.
  - Because Recollection:
    `.codex-runtime/real-site-regressions/www-because-recollection-com-1786871696186/result.json`;
    `partial / 99`, 586/631 resources, both held-click transitions reached
    `/laurent-garnier`, and zero local failures, remote requests, blocking
    errors, or action failures.
  - Active Theory Work:
    `.codex-runtime/real-site-regressions/activetheory-net-1786872287610/result.json`;
    `partial / 99`, 826/982 resources, reached `/work/racer`, and zero local
    failures, remote requests, blocking errors, or action failures.
  - KodeClubs and MANA controls also pass at
    `.codex-runtime/real-site-regressions/www-kodeclubs-com-1786864237923/result.json`
    and
    `.codex-runtime/real-site-regressions/en-manayerbamate-com-1786860070403/result.json`.
- Regression execution boundary:
  - Real-site captures remain serial. Concurrent interactive captures can
    exhaust the bounded CDP command budget and are outside the supported
    one-job workflow.
  - One MakeMePulse replay launched immediately after the 380 MB Shopify run
    stalled in client WebGL shader compilation despite byte-identical mirror
    files and zero network/runtime failures. A clean-browser replay and the
    complete installed-extension rerun passed; the transient remains visible
    as compatibility-matrix evidence rather than being hidden.
- Quality gates:
  - Focused lifecycle, favicon, installer, engine, rewrite, and regression
    tests passed.
  - `pnpm verify`: formatting, lint, type checks, 493/493 tests across 33 test
    files, and all workspace builds passed.
  - `pnpm test:e2e`: 11/11 scenarios passed.
  - `pnpm package:release`: generated the `0.0.60` extension ZIP, Windows
    Native Host ZIP, SPDX SBOM, and release manifest.
  - Extension ZIP SHA-256:
    `6a66b510e4873d8f8911be402922ce620cb19fa91e82b677da9ac686d5577c24`.
  - Windows Native Host ZIP SHA-256:
    `58a5549fef022cf9d330f6cad7ae6aba4d67f51b9f1d8a88527ea2f57b415185`.
  - SPDX SBOM SHA-256:
    `d792ddf158c7eabb6d5f23af926f20c8aa2e3b9fba9d6ea4cbfe88d632473ee9`.
- Known external gates: Authenticode signing, public legal/support URLs,
  browser-store accounts, and the 20-page Windows/Chrome/Edge compatibility
  matrix.
- Next task: `BETA-001` after the required authorized site set and Windows/Edge
  test environments are available.
