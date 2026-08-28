# Scripted And Perceptual Validation

`@webmirror/validation` supports an optional deep-validation recipe in
`RunValidationOptions`. Recipes are supplied only by trusted WebMirror code,
site adapters, or test harnesses. A mirrored page cannot provide JavaScript or
configure its own validation recipe.

## Declarative Actions

Every action has a unique `id` and one of four fixed types:

```ts
const actions = [
  { id: 'start', type: 'click', selector: '#start' },
  { id: 'next', type: 'key', selector: '#next', key: 'Enter' },
  { id: 'scroll', type: 'scroll', selector: '.panel', deltaY: 480 },
  {
    id: 'drag',
    type: 'drag',
    selector: 'canvas',
    from: { x: 120, y: 180 },
    to: { x: 420, y: 180 },
    steps: 16,
  },
] satisfies ValidationAction[];
```

The runtime accepts at most 32 actions. It rejects unknown action types,
additional fields, duplicate IDs, oversized selectors, invalid coordinates,
and action-provided script strings. Key actions are rejected while an editable
form control is focused.

Actions run sequentially in a fresh Playwright browser context with:

- an ephemeral profile and browser sandbox;
- Service Workers disabled;
- downloads disabled;
- a loopback-only streaming proxy that forwards only the preview endpoint and
  denies every other HTTP request, redirect target, CONNECT tunnel, and
  WebSocket upgrade;
- page/frame WebRTC and WebTransport constructors disabled before page scripts
  run, with Worker transport egress contained by the same proxy and browser
  transport flags;
- unexpected additional pages closed;
- bounded navigation, action, settle, and total timeouts.

An action failure skips later dependent actions. Deep-validation failures
produce a partial result; they do not turn an otherwise runnable mirror into a
false complete result.

## Reference Screenshots

Trusted callers can provide PNG bytes keyed by `initial` or an action ID:

```ts
await runValidation({
  entryUrl,
  outputDirectory,
  actions,
  visualReferences: {
    initial: initialPng,
    start: startPng,
  },
  perceptual: {
    threshold: 0.15,
    maxDifferenceRatio: 0.02,
    partialDifferenceRatio: 0.15,
  },
});
```

References are byte arrays, not arbitrary filesystem paths. Each image is
limited to 20 MiB, the complete reference set is limited to 50 MiB, and PNG
dimensions are checked before decode against an 8-megapixel budget. Validation
viewports are also bounded before Chromium allocates screenshot surfaces.
Interlaced PNGs are rejected before decode because the selected decoder cannot
apply a hard inflated-output limit to that format.

Pixel comparison uses `pixelmatch` and decoded PNG pixels. Anti-aliasing is
ignored by default, and callers configure both the color threshold and the
allowed differing-pixel ratios. Results are:

- `match`: within the accepted ratio;
- `partial`: outside the accepted ratio but inside the wider tolerance;
- `mismatch`: outside the wider tolerance;
- `error`: unreadable PNG or incompatible dimensions;
- `not-compared`: no trusted reference was supplied.

Perceptual variance never fails solely because pixels are not exactly equal.
GPU, font, animation, video, and randomized content still require stable
same-environment baselines or adapter-specific tolerance. Abort signals are
checked before decode and between decode, pixel-diff, and PNG-encode phases;
the pixel budget bounds each synchronous phase.

Visible input, textarea, select, and contenteditable controls are masked before
an actual screenshot is persisted. Closed Shadow Root creation is monitored
before page scripts run and through the browser protocol. If a closed root is
observed, the validator does not persist actual, reference, or diff PNGs
because complete form-value masking cannot be proven without changing page
semantics.

Canvas evidence is limited to 32 frames and 128 retained surface records. A
larger page is marked partial and reports the omitted evidence count instead of
serializing an unbounded array. Closed Shadow DOM also marks Canvas evidence
as truncated, so an undiscoverable blank Canvas cannot produce a complete
result.

## Evidence

`validation.json` schema version 2 records:

- each action result and duration;
- action-specific HTTP, runtime, and blocked-request evidence;
- initial and post-action checkpoint screenshots;
- reference and diff artifact paths;
- perceptual settings, dimensions, difference ratio, and similarity.

`report.html` renders the same evidence under a script-free Content Security
Policy. All labels are HTML escaped. Page-controlled URLs, URL origins and
paths, console errors, page errors, network failures, custom methods, and
unexpected MIME values are persisted only as process-keyed fingerprints or
fixed categories.

HTTP failures, console errors, page errors, and remote-dependency events each
retain at most 64 events and share a 64 KiB estimated event-byte budget.
`checks.diagnostics` records retained and dropped counts. Truncation prevents a
`complete` result, and a dropped error already classified as blocking preserves
failed severity.

Caller cancellation stays active while validation JSON and HTML artifacts are
written. The Helper also rechecks cancellation after delivering the `ready`
progress event and closes the cancellation window before sending a successful
terminal result. A late accepted cancellation removes stale validation JSON and
HTML report artifacts.
