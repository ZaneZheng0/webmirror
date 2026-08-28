[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ChromeExtensionId,

  [Parameter(Mandatory = $true)]
  [string] $EdgeExtensionId,

  [string] $SourceDirectory = '',

  [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\WebMirror\stable'),

  [switch] $RequireValidSignature,

  [switch] $Upgrade
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
  $releasePackageRoot = Join-Path $PSScriptRoot '..\..'
  $releaseExecutable = Join-Path $releasePackageRoot $script:WebMirrorExecutableFileName
  $releaseHashes = Join-Path $releasePackageRoot $script:WebMirrorHashesFileName

  if (
    (Test-Path -LiteralPath $releaseExecutable -PathType Leaf) -and
    (Test-Path -LiteralPath $releaseHashes -PathType Leaf)
  ) {
    $SourceDirectory = $releasePackageRoot
  } else {
    $SourceDirectory = Join-Path $PSScriptRoot '..\..\packaging\windows\dist'
  }
}

function Get-ExpectedExecutableHash {
  param(
    [Parameter(Mandatory = $true)]
    [object] $HashManifest
  )

  $artifactMatches = @(
    $HashManifest.artifacts |
      Where-Object {
        ([string] $_.relativePath).Replace('\', '/') -eq $script:WebMirrorExecutableFileName
      }
  )

  if (
    $artifactMatches.Count -ne 1 -or
    [string] $artifactMatches[0].sha256 -notmatch '^[0-9a-fA-F]{64}$'
  ) {
    throw "hashes.json must contain exactly one $script:WebMirrorExecutableFileName record."
  }

  return ([string] $artifactMatches[0].sha256).ToLowerInvariant()
}

function Get-ExpectedRuntimeHash {
  param(
    [Parameter(Mandatory = $true)]
    [object] $HashManifest
  )

  if (
    $null -eq $HashManifest.runtime -or
    [string] $HashManifest.runtime.relativePath -ne 'node_modules' -or
    [string] $HashManifest.runtime.sha256 -notmatch '^[0-9a-fA-F]{64}$'
  ) {
    throw 'hashes.json must contain a valid node_modules runtime record.'
  }

  return ([string] $HashManifest.runtime.sha256).ToLowerInvariant()
}

function Get-ExpectedBrowserHash {
  param(
    [Parameter(Mandatory = $true)]
    [object] $HashManifest
  )

  if (
    $null -eq $HashManifest.browser -or
    [string] $HashManifest.browser.name -ne 'chromium-headless-shell' -or
    [string] $HashManifest.browser.relativePath -ne 'browsers/chromium-headless-shell' -or
    [string] $HashManifest.browser.executableRelativePath -ne 'chrome-headless-shell-win64/chrome-headless-shell.exe' -or
    [string] $HashManifest.browser.sha256 -notmatch '^[0-9a-fA-F]{64}$'
  ) {
    throw 'hashes.json must contain a valid bundled browser record.'
  }

  return ([string] $HashManifest.browser.sha256).ToLowerInvariant()
}

Assert-WebMirrorWindows
$chromeId = Assert-WebMirrorExtensionId `
  -ExtensionId $ChromeExtensionId `
  -Label 'Chrome extension ID'
$edgeId = Assert-WebMirrorExtensionId `
  -ExtensionId $EdgeExtensionId `
  -Label 'Edge extension ID'

$sourcePath = Assert-WebMirrorSafeDirectoryPath -Path $SourceDirectory
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
  throw "Source directory does not exist: $sourcePath"
}

$installPath = Assert-WebMirrorSafeDirectoryPath -Path $InstallDirectory
if ($sourcePath.Equals($installPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'SourceDirectory and InstallDirectory must be different.'
}

$sourceExecutablePath = Get-WebMirrorExistingFile `
  -Path (Join-Path $sourcePath $script:WebMirrorExecutableFileName) `
  -Label 'Packaged helper executable'
$sourceHashesPath = Get-WebMirrorExistingFile `
  -Path (Join-Path $sourcePath $script:WebMirrorHashesFileName) `
  -Label 'Packaged hashes.json'
$hashManifest = Read-WebMirrorJsonFile `
  -Path $sourceHashesPath `
  -Label 'Packaged hashes.json'

if ($hashManifest.schemaVersion -ne 1) {
  throw "Unsupported hashes.json schema: $($hashManifest.schemaVersion)"
}

$expectedExecutableHash = Get-ExpectedExecutableHash -HashManifest $hashManifest
$expectedRuntimeHash = Get-ExpectedRuntimeHash -HashManifest $hashManifest
$expectedBrowserHash = Get-ExpectedBrowserHash -HashManifest $hashManifest
$actualExecutableHash = Get-WebMirrorSha256 -Path $sourceExecutablePath
if ($actualExecutableHash -ne $expectedExecutableHash) {
  throw "Packaged helper hash does not match hashes.json. Expected $expectedExecutableHash, got $actualExecutableHash."
}

$sourceRuntimePath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $sourcePath 'node_modules') `
  -Directory $sourcePath
$actualRuntimeHash = Get-WebMirrorDirectoryTreeSha256 -Directory $sourceRuntimePath
if ($actualRuntimeHash -ne $expectedRuntimeHash) {
  throw "Packaged runtime hash does not match hashes.json. Expected $expectedRuntimeHash, got $actualRuntimeHash."
}
$sourceBrowserPath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $sourcePath 'browsers\chromium-headless-shell') `
  -Directory $sourcePath
$sourceBrowserExecutable = Get-WebMirrorExistingFile `
  -Path (Join-Path $sourceBrowserPath 'chrome-headless-shell-win64\chrome-headless-shell.exe') `
  -Label 'Packaged Chromium Headless Shell'
$actualBrowserHash = Get-WebMirrorBundledBrowserTreeSha256 -Directory $sourceBrowserPath
if ($actualBrowserHash -ne $expectedBrowserHash) {
  throw "Packaged browser hash does not match hashes.json. Expected $expectedBrowserHash, got $actualBrowserHash."
}

$sourceSignature = Get-WebMirrorSignatureRecord -Path $sourceExecutablePath
if ($RequireValidSignature -and $sourceSignature.status -ne 'Valid') {
  throw "Packaged helper Authenticode signature is not valid: $($sourceSignature.status)."
}

$helperVersion = Invoke-WebMirrorCommandCapture `
  -FilePath $sourceExecutablePath `
  -ArgumentList @('--version') `
  -Label 'Packaged helper version check'

$installedExecutablePath = Join-Path $installPath $script:WebMirrorExecutableFileName
if ($Upgrade -and -not (Test-Path -LiteralPath $installedExecutablePath -PathType Leaf)) {
  throw "Upgrade requested, but no installed helper exists at $installedExecutablePath."
}

$runningProcesses = @(
  Get-WebMirrorRunningHostProcesses -ExecutablePath $installedExecutablePath
)
if ($runningProcesses.Count -gt 0) {
  $processIds = ($runningProcesses | ForEach-Object { $_.Id }) -join ', '
  throw "The installed helper is running (PID: $processIds). Close Chrome and Edge native connections before installing or upgrading."
}

$null = Assert-WebMirrorDirectoryWritable -Path $installPath
$installedExecutablePath = Copy-WebMirrorFileAtomic `
  -Source $sourceExecutablePath `
  -Destination $installedExecutablePath
$installedHashesPath = Copy-WebMirrorFileAtomic `
  -Source $sourceHashesPath `
  -Destination (Join-Path $installPath $script:WebMirrorHashesFileName)
$installedRuntimePath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $installPath 'node_modules') `
  -Directory $installPath
$installedRuntimePath = Copy-WebMirrorDirectoryAtomic `
  -Source $sourceRuntimePath `
  -Destination $installedRuntimePath
$installedBrowserRoot = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $installPath 'browsers') `
  -Directory $installPath
$null = Ensure-WebMirrorDirectory -Path $installedBrowserRoot
$installedBrowserPath = Copy-WebMirrorDirectoryAtomic `
  -Source $sourceBrowserPath `
  -Destination (Join-Path $installedBrowserRoot 'chromium-headless-shell')
$installedBrowserExecutable = Get-WebMirrorExistingFile `
  -Path (Join-Path $installedBrowserPath 'chrome-headless-shell-win64\chrome-headless-shell.exe') `
  -Label 'Installed Chromium Headless Shell'

$manifests = Write-WebMirrorNativeHostManifests `
  -OutputDirectory $installPath `
  -ChromeExtensionId $chromeId `
  -EdgeExtensionId $edgeId

$installedExecutableHash = Get-WebMirrorSha256 -Path $installedExecutablePath
if ($installedExecutableHash -ne $expectedExecutableHash) {
  throw "Installed helper hash mismatch. Expected $expectedExecutableHash, got $installedExecutableHash."
}

$installedRuntimeHash = Get-WebMirrorDirectoryTreeSha256 -Directory $installedRuntimePath
if ($installedRuntimeHash -ne $expectedRuntimeHash) {
  throw "Installed runtime hash mismatch. Expected $expectedRuntimeHash, got $installedRuntimeHash."
}
$installedBrowserHash = Get-WebMirrorBundledBrowserTreeSha256 -Directory $installedBrowserPath
if ($installedBrowserHash -ne $expectedBrowserHash) {
  throw "Installed browser hash mismatch. Expected $expectedBrowserHash, got $installedBrowserHash."
}

$installedSignature = Get-WebMirrorSignatureRecord -Path $installedExecutablePath
if ($RequireValidSignature -and $installedSignature.status -ne 'Valid') {
  throw "Installed helper Authenticode signature is not valid: $($installedSignature.status)."
}

$installedVersion = Invoke-WebMirrorCommandCapture `
  -FilePath $installedExecutablePath `
  -ArgumentList @('--version') `
  -Label 'Installed helper version check'
if ($installedVersion -ne $helperVersion) {
  throw "Installed helper version mismatch. Expected $helperVersion, got $installedVersion."
}

$registrationResults = @()
$registrationResults += @(
  Set-WebMirrorNativeHostRegistration -Browser Chrome -ManifestPath $manifests.Chrome
)
$registrationResults += @(
  Set-WebMirrorNativeHostRegistration -Browser Edge -ManifestPath $manifests.Edge
)

foreach ($registration in $registrationResults) {
  $view = [Microsoft.Win32.RegistryView] [System.Enum]::Parse(
    [Microsoft.Win32.RegistryView],
    [string] $registration.View
  )
  $registeredPath = Get-WebMirrorNativeHostRegistration `
    -Browser $registration.Browser `
    -View $view
  if (
    $null -eq $registeredPath -or
    -not $registeredPath.Equals(
      $registration.ManifestPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Native Messaging registration verification failed for $($registration.Browser) $($registration.View)."
  }
}

$installStatePath = Join-Path $installPath $script:WebMirrorInstallStateFileName
$installState = [ordered]@{
  schemaVersion = 1
  installedAtUtc = [System.DateTime]::UtcNow.ToString('o')
  mode = if ($Upgrade) { 'upgrade' } else { 'install' }
  hostName = $script:WebMirrorHostName
  helperVersion = $installedVersion
  installDirectory = $installPath
  registryHive = 'HKEY_CURRENT_USER'
  registryViews = @(
    Get-WebMirrorRegistryViews | ForEach-Object { $_.ToString() }
  )
  extensionIds = [ordered]@{
    chrome = $chromeId
    edge = $edgeId
  }
  files = @(
    (Get-WebMirrorFileRecord `
      -Path $installedExecutablePath `
      -RelativePath $script:WebMirrorExecutableFileName),
    (Get-WebMirrorFileRecord `
      -Path $manifests.Chrome `
      -RelativePath $script:WebMirrorChromeManifestFileName),
    (Get-WebMirrorFileRecord `
      -Path $manifests.Edge `
      -RelativePath $script:WebMirrorEdgeManifestFileName),
    (Get-WebMirrorFileRecord `
      -Path $installedHashesPath `
      -RelativePath $script:WebMirrorHashesFileName)
  )
  runtime = [ordered]@{
    relativePath = 'node_modules'
    sha256 = $installedRuntimeHash
  }
  browser = [ordered]@{
    relativePath = 'browsers/chromium-headless-shell'
    executableRelativePath = 'chrome-headless-shell-win64/chrome-headless-shell.exe'
    executablePath = $installedBrowserExecutable
    sha256 = $installedBrowserHash
  }
  signature = $installedSignature
}
$null = Write-WebMirrorJsonFile -Path $installStatePath -Value $installState -Depth 16

[pscustomobject]@{
  Mode = $installState.mode
  HostName = $script:WebMirrorHostName
  HelperVersion = $installedVersion
  InstallDirectory = $installPath
  ChromeManifest = $manifests.Chrome
  EdgeManifest = $manifests.Edge
  RegistryHive = 'HKEY_CURRENT_USER'
  RegistryViews = $installState.registryViews
  SignatureStatus = $installedSignature.status
}
