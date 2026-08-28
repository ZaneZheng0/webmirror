# Standard Commands

Run commands from the repository root.

```powershell
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @webmirror/validation test
pnpm test:e2e
pnpm exec playwright test tests/e2e/validation-actions.spec.ts
pnpm exec playwright test tests/e2e/helper-mirror.spec.ts
pnpm exec playwright test tests/e2e/extension-capture.spec.ts tests/e2e/extension-mirror.spec.ts
pnpm build
pnpm verify
pnpm package:windows
pnpm package:release
pnpm dev:fixtures
pnpm dev:extension
pnpm dev:helper
node scripts/real-site-regression.mjs http://www.because-recollection.com/christine-and-the-queens --plan scripts/real-site-plans/www.because-recollection.com.json
node scripts/real-site-regression.mjs https://2019.makemepulse.com --plan scripts/real-site-plans/2019.makemepulse.com.json
node scripts/real-site-regression.mjs https://landonorris.com --plan scripts/real-site-plans/landonorris.com.json
node scripts/real-site-regression.mjs https://www.shopify.com/editions/winter2026 --plan scripts/real-site-plans/www.shopify.com-editions-winter2026.json --timeout-ms 900000
node scripts/real-site-regression.mjs https://www.kodeclubs.com/ --plan scripts/real-site-plans/www.kodeclubs.com.json --timeout-ms 900000
node scripts/real-site-regression.mjs https://activetheory.net/work --plan scripts/real-site-plans/activetheory.net-work.json --timeout-ms 900000
```

Run the real-site regression commands serially. Parallel interactive captures
can saturate the local CDP command budget and create response-body timeout
failures that do not reproduce in the supported one-job flow.

Only commands that have succeeded in the current repository should remain in this file.
