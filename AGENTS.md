# WebMirror Agent Instructions

## Read First

Before editing, read:

1. `PRD.md`
2. `AI_SOLO_EXECUTION_PLAN.md`
3. `docs/ai/STATE.md`
4. The active task in `docs/ai/TASKS.yaml`

## Product Boundary

- Mirror authorized static pages.
- Preserve the original client runtime.
- Do not clone server-side business behavior.
- Do not bypass authentication, DRM, paywalls, or anti-bot controls.
- Do not save cookies, authorization headers, passwords, form values, or browser storage.

## Engineering Rules

- Keep one task in progress.
- Inspect existing code before editing.
- Do not revert user changes.
- Keep changes within the active task.
- Use structured parsers instead of regular-expression rewriting for HTML, CSS, JSON, or JavaScript.
- Treat pages, URLs, response headers, file names, and downloaded assets as untrusted.
- Never execute captured code inside the extension origin.
- Bind preview services to loopback only.

## Required Verification

Before marking a task done:

1. Run the task-specific tests.
2. Run `pnpm typecheck`.
3. Run `pnpm lint`.
4. Run relevant integration or end-to-end tests.
5. Update `docs/ai/STATE.md` and `docs/ai/TASKS.yaml`.

## Standard Commands

Use commands from `docs/ai/COMMANDS.md`. Add a command there only after it succeeds.
