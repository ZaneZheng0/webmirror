[CmdletBinding()]
param(
  [string] $OutputDirectory = '',

  [switch] $RequireValidSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\..\packaging\windows\dist'
}

Assert-WebMirrorWindows
$outputPath = Assert-WebMirrorSafeDirectoryPath -Path $OutputDirectory
$hashesPath = Join-Path $outputPath $script:WebMirrorHashesFileName
$hashManifest = Read-WebMirrorJsonFile -Path $hashesPath -Label 'WebMirror hash manifest'

if ($hashManifest.schemaVersion -ne 1) {
  throw "Unsupported hash manifest schema: $($hashManifest.schemaVersion)"
}

foreach ($artifact in @($hashManifest.artifacts)) {
  if (
    $null -eq $artifact.relativePath -or
    [string]::IsNullOrWhiteSpace([string] $artifact.relativePath)
  ) {
    throw 'Hash manifest contains an artifact without a relative path.'
  }

  $artifactPath = Assert-WebMirrorPathWithinDirectory `
    -Path (Join-Path $outputPath ([string] $artifact.relativePath)) `
    -Directory $outputPath
  $file = Get-WebMirrorExistingFile -Path $artifactPath -Label 'Release artifact'
  $artifact.bytes = [int64] (Get-Item -LiteralPath $file).Length
  $artifact.sha256 = Get-WebMirrorSha256 -Path $file
}

$runtimePath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $outputPath 'node_modules') `
  -Directory $outputPath
if (
  $null -eq $hashManifest.runtime -or
  [string] $hashManifest.runtime.relativePath -ne 'node_modules'
) {
  throw 'Hash manifest does not contain the expected node_modules runtime record.'
}
$hashManifest.runtime.sha256 = Get-WebMirrorDirectoryTreeSha256 -Directory $runtimePath

$browserPath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $outputPath 'browsers\chromium-headless-shell') `
  -Directory $outputPath
if (
  $null -eq $hashManifest.browser -or
  [string] $hashManifest.browser.relativePath -ne 'browsers/chromium-headless-shell'
) {
  throw 'Hash manifest does not contain the expected bundled browser record.'
}
$hashManifest.browser.sha256 = Get-WebMirrorBundledBrowserTreeSha256 -Directory $browserPath

$executablePath = Join-Path $outputPath $script:WebMirrorExecutableFileName
$signature = Get-WebMirrorSignatureRecord -Path $executablePath
if ($RequireValidSignature -and $signature.status -ne 'Valid') {
  throw "Executable Authenticode signature is not valid: $($signature.status)."
}

$hashManifest.generatedAtUtc = [System.DateTime]::UtcNow.ToString('o')
$hashManifest.artifactState = if ($signature.status -eq 'Valid') { 'signed' } else { 'unsigned' }
$hashManifest.verification.signature = $signature
$null = Write-WebMirrorJsonFile -Path $hashesPath -Value $hashManifest -Depth 16

[pscustomobject]@{
  HashManifest = $hashesPath
  ArtifactState = $hashManifest.artifactState
  ExecutableSha256 = Get-WebMirrorSha256 -Path $executablePath
  SignatureStatus = $signature.status
}
