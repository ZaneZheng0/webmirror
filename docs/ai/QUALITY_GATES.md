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
- Native Messaging reconnects after helper restart.
- Captured output excludes credentials and form values.

## Beta

- At least 18 of 20 benchmark pages produce runnable mirrors.
- Eligible pages meet P90 under 120 seconds.
- Complete results have zero local asset 404 responses.
- No P0 or P1 defects remain.
