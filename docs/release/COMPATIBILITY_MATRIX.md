# Compatibility Matrix

Last updated: 2026-07-22

## Current Environment

| Dimension                      | Available evidence                                                             |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Operating system               | Windows 11 Pro 10.0.26200 x64                                                  |
| Automated extension browser    | Playwright Chromium 149.0.7827.55                                              |
| Installed Chrome               | 150.0.7871.127                                                                 |
| Installed Edge                 | Not available                                                                  |
| Authorized pages in repository | Basic static fixture, WebGL fixture, and temporary real-page regression inputs |

## Executed Scenarios

| Environment           | Scenario                                         | Result |
| --------------------- | ------------------------------------------------ | ------ |
| Windows 11 / Chromium | CDP capture of the basic fixture                 | Pass   |
| Windows 11 / Chromium | Installed Native Host end-to-end mirror          | Pass   |
| Windows 11 / Chromium | Static mirror, rewrite, preview, and validation  | Pass   |
| Windows 11 / Chromium | WebGL, Worker, JSON, BIN, and texture replay     | Pass   |
| Windows 11 / Chromium | Cancellation without false success               | Pass   |
| Windows 11 / Chromium | Failed-resource retry from partial to complete   | Pass   |
| Windows 11 / Chromium | Scripted click replay and perceptual checkpoints | Pass   |

Commands:

```powershell
pnpm test:e2e
pnpm verify
```

On 2026-07-22, the complete E2E command passed 8/8 scenarios and the repository
verification command passed formatting, linting, type checking, 26 test files,
304 tests, and all workspace builds. The 0.0.23 release ZIP smoke check also
ran the extracted Helper, matched Helper/runtime/browser hashes, and validated
the SPDX 2.3 SBOM.

## Required Matrix

| Operating system | Chrome                                        | Edge                                          |
| ---------------- | --------------------------------------------- | --------------------------------------------- |
| Windows 10       | Not available                                 | Not available                                 |
| Windows 11       | Store or managed-policy installation required | Browser and approved installation unavailable |

The Playwright Chromium development run is useful regression evidence but is
not a substitute for the required branded-browser rows. A system Chrome 150
automation attempt did not load the development extension, and both extension
tests timed out while waiting for its service worker.

## Page Coverage

- Required authorized pages: 20.
- Repeatable authorized pages available in this workspace: 2.
- The temporary real-page WebGL benchmark is not committed or distributed and
  cannot provide a repeatable matrix row from this workspace.
- Installed-extension temporary regressions passed for Because Recollection,
  MakeMePulse 2019, Landon Norris, and Shopify Editions Winter 2026 with
  non-local HTTP/WebSocket blocked during loopback replay.
- Those real-site regressions were executed serially. Parallel capture stress
  is not part of the current compatibility claim because it can saturate the
  local CDP response-body command budget.

## Status

`BETA-001` is blocked. Completion requires 20 authorized page inputs,
resettable Windows 10 and Windows 11 environments, Chrome and Edge with an
approved extension installation path, and recorded results for every required
matrix cell.
