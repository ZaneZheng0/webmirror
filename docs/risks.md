# Risk Register

| ID    | Risk                                                      | Probability | Impact   | Mitigation                                                           | Status                                           |
| ----- | --------------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| R-001 | CDP misses resources loaded by workers or service workers | Medium      | High     | Target auto-attach, response-body fallback, CacheStorage, discovery  | Mitigated; monitor real-page recall              |
| R-002 | Minified JavaScript contains hard-coded absolute URLs     | High        | High     | AST-directed conservative rewriting and online dependency reporting  | Partially mitigated                              |
| R-003 | Local helper exposes filesystem or network capabilities   | Medium      | Critical | Loopback isolation, Host checks, SSRF/path validation, exact origins | Mitigated; continue audit                        |
| R-004 | WebGL output varies across GPU environments               | High        | Medium   | Nonblank checks, tolerant PNG comparison, closed-Shadow fail-closed  | Mitigated in validator; cross-GPU matrix pending |
| R-005 | Native Messaging installation creates onboarding friction | Medium      | High     | Release ZIP, per-user installer, diagnostics, upgrade, uninstall     | Partially mitigated; signed installer pending    |
