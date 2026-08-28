# Publishing Checklist

The repository can produce an engineering-complete release candidate, but
store publication requires credentials, legal URLs, signing identities, and
human approval.

## Engineering Candidate

- [x] `pnpm verify` passes.
- [x] Helper mirror E2E passes.
- [x] Extension capture E2E passes.
- [x] Installed Native Host E2E passes.
- [x] `pnpm package:release` generates extension ZIP, Windows ZIP, SBOM, and
      release manifest.
- [x] Release ZIP entries use `/` separators and contain required files.
- [x] Artifact sizes and SHA-256 values match `release-manifest.json`.
- [x] Windows package includes the Playwright runtime and Chromium Headless
      Shell used for validation.

## Authorization And Privacy

- [ ] Approve the authorized-use policy.
- [ ] Replace every placeholder in `PRIVACY_POLICY_DRAFT.md`.
- [ ] Publish the privacy policy at a stable HTTPS URL.
- [ ] Publish a support/contact URL and monitored email address.
- [ ] Confirm store disclosures match actual local storage, active-tab access,
      debugger access, Native Messaging, and direct resource downloads.
- [ ] Confirm all screenshots, benchmark sites, logos, and listing media are
      owned or licensed for publication.

## Windows Native Host

- [ ] Sign `webmirror-helper.exe` with the approved Authenticode identity.
- [ ] Apply a trusted timestamp.
- [ ] Run `scripts/windows/update-hashes.ps1 -RequireValidSignature`.
- [ ] Re-run `pnpm package:release` after signing and hash refresh.
- [ ] Install the signed package with `-RequireValidSignature`.
- [ ] Run diagnostics with `-RequireValidSignature -AsJson`.
- [ ] Archive the signed executable, refreshed hashes, SBOM, release manifest,
      diagnostic JSON, and signing evidence.
- [ ] Decide whether the first public release remains ZIP-based or receives a
      separately built MSI/WiX installer.

## Browser Listing

- [ ] Freeze product name, version, short description, detailed description,
      category, language, icon, screenshots, and support text.
- [ ] Explain why `activeTab`, `debugger`, `nativeMessaging`, and `storage` are
      required.
- [ ] State clearly that WebMirror is for authorized pages and primarily static
      content.
- [ ] State that the Native Host is required on Windows.
- [ ] Provide installation and uninstall instructions.
- [ ] Verify the final store-generated extension IDs and rebuild Native Host
      manifests/install instructions with those exact IDs.

## Compatibility Matrix

- [ ] Test at least 20 authorized pages, including basic static, iframe,
      Worker, WebGL, large asset sets, redirects, compressed responses, and
      expected partial failures.
- [ ] Record Chrome and Edge results on Windows 10 and Windows 11.
- [ ] Confirm complete mirrors have zero local 404s and zero unexpected remote
      requests.
- [ ] Confirm P90 eligible-page completion remains below 120 seconds.
- [ ] Review all failed and partial reports; do not relabel them as complete.

## Submission And Rollout

- [ ] Upload through the authorized Chrome Web Store account.
- [ ] Upload through the authorized Microsoft Edge Add-ons account.
- [ ] Complete each store's privacy and data-use declarations from the final
      build behavior.
- [ ] Use a limited or unlisted beta rollout first.
- [ ] Monitor installation failures, Native Host diagnostics, mirror success
      rate, and support requests.
- [ ] Promote to wider availability only after beta exit criteria pass.

## External Gates Still Open

The current repository does not contain signing credentials, store account
access, a public privacy-policy host, publication rights for third-party
benchmark pages, or human legal approval. Those items cannot be completed by
the build alone.
