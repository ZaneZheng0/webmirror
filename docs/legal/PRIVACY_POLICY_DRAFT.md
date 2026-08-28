# WebMirror Privacy Policy Draft

This document is a release draft. Replace bracketed placeholders, obtain
appropriate review, and publish the final policy at a stable public URL before
store submission.

**Effective date:** [DATE]

**Operator:** [LEGAL NAME]

**Contact:** [SUPPORT OR PRIVACY EMAIL]

## Summary

WebMirror creates offline copies of pages the user chooses. The extension and
Native Host operate locally and do not send capture data to a WebMirror cloud
service. The helper makes direct network requests to the selected site's
origin and referenced asset hosts to download eligible public resources.

## Data Processed

When the user starts a mirror, WebMirror may process:

- the active tab's URL, title, viewport, and browser version;
- resource URLs, methods, MIME types, response status, transfer size, and
  limited non-sensitive HTTP headers;
- downloaded page files and referenced static resources;
- job progress, errors, validation results, screenshots, and local output
  paths.

WebMirror does not intentionally collect or forward cookies, authorization
headers, request bodies, passwords, form values, or payment information.
Validation URL origins, paths, queries, and page-controlled diagnostic text are
stored as process-keyed fingerprints or fixed categories rather than raw
values. Diagnostic event counts and estimated retained bytes are bounded.

The visible page and downloaded files can still contain personal or
confidential information supplied by the source site. Users must not capture
such material without authorization and an appropriate legal basis.

## Storage And Retention

- Extension job state is stored in the browser's local extension storage.
- Mirror files are stored locally, by default under
  `%USERPROFILE%\Documents\WebMirror`.
- Native Host installation files are stored under
  `%LOCALAPPDATA%\Programs\WebMirror\stable` by default.
- WebMirror does not automatically upload or remotely retain these files.

Users control retention. They can remove extension data through the browser,
delete mirror directories, and uninstall the Native Host with the supplied
script. Uninstalling the Native Host does not delete mirror output.

## Network Communications

WebMirror communicates with:

- the source page and its referenced asset hosts to retrieve eligible
  resources;
- `127.0.0.1` for local preview and validation.

Source-site operators and their infrastructure may receive ordinary network
metadata such as the user's IP address when resources are downloaded. Their
privacy policies apply to those requests.

## Analytics, Advertising, And Sale

The current release candidate contains no WebMirror analytics SDK, advertising
SDK, account system, or data-sale feature. Known third-party analytics
resources are excluded from mirrored output when recognized.

## Security

WebMirror uses exact Native Messaging origins, per-user registry entries,
path validation, SSRF protections, local-only preview binding, restrictive
preview headers, integrity hashes, and persisted-data redaction. No software
can guarantee absolute security. Users should review validation reports and
protect local mirror files according to their sensitivity.

## User Choices

Users choose when to start a capture and may cancel an active job. They may
delete browser extension storage, mirror output, exported ZIP files, and the
Native Host installation at any time.

## Children

WebMirror is not directed to children and should not be used to capture
children's personal information.

## Changes

Material policy changes will be reflected at the public policy URL and, where
required, in extension store disclosures.

## Contact

Questions or requests should be sent to [SUPPORT OR PRIVACY EMAIL].
