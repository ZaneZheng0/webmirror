# Risk Register

| ID    | Risk                                                      | Probability | Impact   | Mitigation                                                | Status |
| ----- | --------------------------------------------------------- | ----------- | -------- | --------------------------------------------------------- | ------ |
| R-001 | CDP misses resources loaded by workers or service workers | Medium      | High     | Target auto-attach and multi-source discovery             | Open   |
| R-002 | Minified JavaScript contains hard-coded absolute URLs     | High        | High     | Preserve directory layout and use AST-directed rewriting  | Open   |
| R-003 | Local helper exposes filesystem or network capabilities   | Medium      | Critical | Loopback isolation, tokens, URL evidence, path validation | Open   |
| R-004 | WebGL output varies across GPU environments               | High        | Medium   | Perceptual comparison and nonblank canvas checks          | Open   |
| R-005 | Native Messaging installation creates onboarding friction | Medium      | High     | Health checks, clear diagnostics, signed installer        | Open   |
