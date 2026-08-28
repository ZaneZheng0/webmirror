# Windows Packaging Assets

`sea-loader.cjs` is the trusted CommonJS entry embedded into the Node SEA
executable. The built helper JavaScript is included as a SEA asset rather than
loaded from the installation directory.

The loader:

- verifies the embedded helper JavaScript SHA-256 before importing it;
- accepts the helper maintenance arguments unchanged;
- recognizes Chrome/Edge Native Messaging origin arguments;
- validates browser origins against the two installed manifests;
- maps a valid browser invocation to the helper's `--native` mode;
- writes loader failures to stderr only.

Generated files are written to `packaging/windows/dist/` by default. The
package also contains the Playwright runtime and the matching Chromium
Headless Shell under `node_modules/` and `browsers/`. Transient browser logs
are excluded before integrity hashes are calculated.

Use the scripts in `scripts/windows/` and the procedure in
`docs/installation/windows-native-host.md`. `pnpm package:release` creates the
portable release ZIP, SPDX SBOM, and release hash manifest. Code signing is
intentionally not performed by repository scripts.
