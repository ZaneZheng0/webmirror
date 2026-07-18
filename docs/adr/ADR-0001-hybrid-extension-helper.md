# ADR-0001: Hybrid Extension and Local Helper

- Status: Accepted for POC
- Date: 2026-07-18

## Context

The browser extension needs access to the active tab and Chrome DevTools Protocol, while large
asset downloads, filesystem access, local serving, validation, and packaging are better handled by
a local process.

## Decision

Use a Manifest V3 extension for user interaction and capture control. Use a local Node.js helper
for downloads, persistence, local preview, validation, and export. Communicate with a versioned
Native Messaging protocol.

## Consequences

- Users install both an extension and a signed helper.
- Protocol compatibility and installation detection are required.
- Captured files do not need to pass through extension memory.
- The local helper becomes a security boundary and must reject arbitrary commands and paths.
