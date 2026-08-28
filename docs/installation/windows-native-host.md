# WebMirror Windows Native Host

WebMirror uses a per-user Native Messaging host named
`com.webmirror.helper`. It supplies filesystem access, resource downloading,
local preview, ZIP export, and Playwright-based validation that cannot run
inside an MV3 extension service worker.

The current deliverable is an unsigned development release candidate. A public
release must be Authenticode signed and timestamped.

## Security Boundary

- Installation writes only to `HKEY_CURRENT_USER`; administrator rights are
  not required.
- Chrome and Edge receive separate manifests containing exactly one extension
  origin each. Wildcards and malformed IDs are rejected.
- On 64-bit Windows, registration is verified in each applicable registry
  view.
- The default installation directory is
  `%LOCALAPPDATA%\Programs\WebMirror\stable`.
- UNC paths, device paths, filesystem roots, alternate data streams,
  wildcards, and reparse-point directories are rejected.
- The installer verifies the helper executable, Playwright runtime, and
  bundled browser against `hashes.json` before and after copying.
- Native host stdout is reserved for framed protocol messages. Diagnostics go
  to stderr.
- Uninstall removes only named WebMirror files plus the verified
  `node_modules` and `browsers` directories inside the selected installation
  root. Reparse points are refused.
- Mirror output under `%USERPROFILE%\Documents\WebMirror` is never removed by
  uninstall.
- The shared content cache under `%LOCALAPPDATA%\WebMirror\cache\v1` is also
  preserved. It stores URL fingerprints and verified public response bodies,
  never browser Cookie or Authorization headers.

## Release Package Layout

After extracting `webmirror-windows-native-host.zip`:

```text
webmirror-helper.exe
hashes.json
README.md
browsers/
  chromium-headless-shell/
node_modules/
  playwright/
  playwright-core/
scripts/
  windows/
    common.ps1
    install-native-host.ps1
    upgrade-native-host.ps1
    diagnose-native-host.ps1
    uninstall-native-host.ps1
    launch-native-host.ps1
    ...
```

The installation script automatically detects this release-package layout.

## Install From The Release ZIP

Load the extension first and record the exact 32-character ID shown by Chrome
and Edge. Valid extension IDs contain only lowercase `a` through `p`.

Open PowerShell in the extracted package directory:

```powershell
$ChromeExtensionId = '<chrome-extension-id>'
$EdgeExtensionId = '<edge-extension-id>'
$InstallDirectory = Join-Path $env:LOCALAPPDATA 'Programs\WebMirror\stable'

.\scripts\windows\install-native-host.ps1 `
  -ChromeExtensionId $ChromeExtensionId `
  -EdgeExtensionId $EdgeExtensionId `
  -InstallDirectory $InstallDirectory
```

For a signed public build:

```powershell
.\scripts\windows\install-native-host.ps1 `
  -ChromeExtensionId $ChromeExtensionId `
  -EdgeExtensionId $EdgeExtensionId `
  -InstallDirectory $InstallDirectory `
  -RequireValidSignature
```

Restart Chrome and Edge after installation so their Native Messaging host
registrations are reloaded.

The installer:

1. Verifies the package layout and `hashes.json` schema.
2. Verifies the helper, Playwright runtime, and browser hashes.
3. Optionally requires a valid Authenticode signature.
4. Refuses to overwrite a running installed helper.
5. Copies files atomically into the installation directory.
6. Generates least-privilege Chrome and Edge manifests.
7. Writes and verifies exact HKCU registry values.
8. Runs the installed helper with `--version`.
9. Writes `install-state.json`.

The registry keys are:

```text
HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.webmirror.helper
HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.webmirror.helper
```

## Diagnose

```powershell
.\scripts\windows\diagnose-native-host.ps1 `
  -InstallDirectory $InstallDirectory
```

Machine-readable output:

```powershell
.\scripts\windows\diagnose-native-host.ps1 `
  -InstallDirectory $InstallDirectory `
  -AsJson
```

Signed-release validation:

```powershell
.\scripts\windows\diagnose-native-host.ps1 `
  -InstallDirectory $InstallDirectory `
  -RequireValidSignature `
  -AsJson
```

Diagnostics check:

- helper presence, version, SHA-256, and signature;
- Playwright runtime tree hash;
- bundled Chromium Headless Shell presence and tree hash;
- install-state consistency;
- exact one-origin Chrome and Edge manifests;
- registry values in each applicable view;
- protocol-version-1 handshakes using both browser origins.

Unsigned development artifacts produce a warning unless
`-RequireValidSignature` is set. Failed checks exit with code 1.

## Upgrade

Close active WebMirror jobs and browser Native Messaging connections before
upgrading.

From an extracted release package:

```powershell
.\scripts\windows\upgrade-native-host.ps1 `
  -ChromeExtensionId $ChromeExtensionId `
  -EdgeExtensionId $EdgeExtensionId `
  -InstallDirectory $InstallDirectory
```

Add `-RequireValidSignature` for a signed release. Upgrade requires an existing
installation, re-verifies the new package, replaces the known files and
directories, regenerates manifests, and repairs registration.

## Manual Launch

Version check:

```powershell
.\scripts\windows\launch-native-host.ps1 `
  -InstallDirectory $InstallDirectory `
  -Mode Version
```

Raw Native Messaging mode:

```powershell
.\scripts\windows\launch-native-host.ps1 `
  -InstallDirectory $InstallDirectory `
  -Mode Native
```

Browser-style protocol mode:

```powershell
.\scripts\windows\launch-native-host.ps1 `
  -InstallDirectory $InstallDirectory `
  -Mode Browser `
  -ExtensionId $ChromeExtensionId
```

Native and Browser modes use binary stdin/stdout and are intended for protocol
tools, not interactive text entry.

## Uninstall

```powershell
.\scripts\windows\uninstall-native-host.ps1 `
  -InstallDirectory $InstallDirectory
```

Uninstall:

- refuses to continue while the installed helper is running;
- removes only registrations that still point to this installation;
- preserves mismatched registrations for manual review;
- removes the five known top-level installation files;
- removes only the fixed `node_modules` and `browsers` directories after path
  and reparse-point checks;
- removes the installation directory only when empty;
- leaves mirror output and other user data intact.

Repeated uninstall is supported.

## Build From Source

Requirements:

- Windows 10 or Windows 11.
- Windows PowerShell 5.1 or PowerShell 7.
- Node.js 24 or newer.
- pnpm 11.
- The pinned `postject` dependency from the repository lockfile.
- Playwright Chromium installed in the current user's browser cache.

From the repository root:

```powershell
pnpm install
pnpm exec playwright install chromium
pnpm package:windows
```

The default build output is:

```text
packaging/windows/dist/
  webmirror-helper.exe
  webmirror-helper.blob
  webmirror-helper.js.sha256
  sea-config.json
  hashes.json
  node_modules/
  browsers/
```

`build-sea.ps1`:

1. Resolves the active Windows Node runtime and pinned postject package.
2. Verifies optional approved input hashes and versions.
3. Builds and smoke-tests the helper JavaScript.
4. Copies the Playwright runtime and matching Chromium Headless Shell.
5. Excludes transient browser logs from the package.
6. Generates a Node SEA blob and injects it into a fresh `node.exe`.
7. Verifies the standalone helper version.
8. Records helper, runtime, browser, build-tool, and signature metadata in
   `hashes.json`.

Build the full release candidate:

```powershell
pnpm package:release
```

This creates:

```text
packaging/release/dist/
  webmirror-extension-chromium.zip
  webmirror-windows-native-host.zip
  webmirror-sbom.spdx.json
  release-manifest.json
```

Release ZIP construction validates portable `/` entry names and required
files.

## Install From Repository Output

After `pnpm package:windows`:

```powershell
.\scripts\windows\install-native-host.ps1 `
  -ChromeExtensionId $ChromeExtensionId `
  -EdgeExtensionId $EdgeExtensionId `
  -InstallDirectory $InstallDirectory
```

The repository script automatically uses `packaging/windows/dist`.

## External Code Signing

Signing credentials are intentionally not stored or accessed by repository
scripts.

Required release order:

1. Run `pnpm package:windows`.
2. Sign `packaging/windows/dist/webmirror-helper.exe` with the approved
   Authenticode certificate and trusted timestamp.
3. Verify the signature independently.
4. Refresh hashes:

   ```powershell
   .\scripts\windows\update-hashes.ps1 -RequireValidSignature
   ```

5. Run `pnpm package:release`.
6. Extract the Windows ZIP and install with `-RequireValidSignature`.
7. Run diagnostics with `-RequireValidSignature -AsJson`.

Any binary modification after signing requires a new signature and another
hash refresh.

## Troubleshooting

`Source directory does not exist`

: Run the script either from the repository or from an intact extracted
release ZIP. When using a custom package layout, pass
`-SourceDirectory '<package-root>'`.

`Playwright Chromium Headless Shell is not installed`

: Run `pnpm exec playwright install chromium`, then rebuild.

`The installed helper is running`

: Close active WebMirror jobs and browser windows, then retry. Scripts do not
forcibly terminate the process.

`Packaged helper/runtime/browser hash does not match hashes.json`

: Do not install. Rebuild from trusted inputs. If the helper was intentionally
signed, run `update-hashes.ps1` only after signature verification.

`PreservedMismatch`

: A registry key with the WebMirror host name points to a different manifest.
The uninstaller leaves it intact to avoid deleting another installation.

`Authenticode` warning

: Expected for the local unsigned release candidate. It is a release failure
when `-RequireValidSignature` is used.
