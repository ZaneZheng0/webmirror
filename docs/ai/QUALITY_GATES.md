# Quality Gates

## Repository Green

- Formatting passes.
- Lint passes.
- Type checking passes.
- Unit and integration tests pass.
- All packages build.

## POC

- A simple page is captured and replayed without public network access.
- A WebGL fixture or authorized benchmark renders a nonblank canvas.
- Native Messaging completes an installed-host mirror flow.
- Captured output excludes credentials and form values.
- Same-origin browser response bodies pass address policy, length, SHA-256,
  cancellation, cleanup, and secret-scan tests.
- Declarative click, scroll, key, and drag actions run only in an isolated
  validation context.
- Interaction-triggered non-local HTTP and WebSocket requests are blocked
  before reaching sentinel servers.
- Local redirects, Worker requests, CONNECT tunnels, and WebTransport attempts
  cannot bypass the exact-preview-endpoint proxy.
- Page-controlled diagnostic values are fingerprinted, event evidence is
  bounded, and truncation cannot produce `COMPLETE`.
- Canvas evidence is bounded and reports omitted surfaces instead of growing
  validation artifacts without limit.
- Visible form controls are masked in screenshots. Closed Shadow DOM fails
  closed: screenshots and reference/diff artifacts are omitted, while Canvas
  evidence is truncated and cannot produce `COMPLETE`.
- Cancellation remains authoritative through validation artifact writes and
  the `ready` progress send; stale complete reports are removed.
- Trusted PNG references produce tolerant checkpoint similarity and diff
  evidence without requiring strict pixel equality.

Current status: passed.

Current evidence: `pnpm verify` passed formatting, lint, type checks, 493
tests across 33 files, and all workspace builds on 2026-08-16.

## Beta

- At least 18 of 20 benchmark pages produce runnable mirrors.
- Eligible pages meet P90 under 120 seconds.
- Complete results have zero local asset 404 responses.
- No P0 or P1 defects remain.

Current status: pending the full benchmark and OS/browser matrix.

## Release

- Extension and Native Host ZIPs build from one command.
- Release ZIP entries use portable `/` paths and contain required files.
- SHA-256 values in `release-manifest.json` match generated artifacts.
- SPDX SBOM generation succeeds.
- Native Host installs, diagnoses, and uninstalls from the extracted release
  package.
- Authenticode signature and timestamp are valid.
- Privacy policy and support URLs are public.

Current status: engineering gates passed; signing and publication gates remain
external.

Current evidence: `pnpm test:e2e` passed all 11 scenarios and
`pnpm package:release` generated the `0.0.60` extension, Windows Native Host,
and SPDX SBOM artifacts on 2026-08-16.
