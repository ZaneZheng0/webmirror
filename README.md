# WebMirror

WebMirror captures an authorized static web page and rebuilds it as a local, offline mirror.

The project contains:

- A Chrome and Edge Manifest V3 extension.
- A local helper process.
- Capture, mirror, and validation libraries.
- Deterministic fixture pages and end-to-end tests.

See [PRD.md](./PRD.md), [PROJECT_PLAN.md](./PROJECT_PLAN.md), and
[AI_SOLO_EXECUTION_PLAN.md](./AI_SOLO_EXECUTION_PLAN.md).

## Development

```powershell
pnpm install
pnpm verify
pnpm dev:fixtures
pnpm dev:extension
pnpm dev:helper
```
