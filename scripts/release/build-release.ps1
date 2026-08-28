[CmdletBinding()]
param(
  [string] $OutputDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\windows\common.ps1')

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\..\packaging\release\dist'
}

Assert-WebMirrorWindows
$repositoryRoot = Assert-WebMirrorSafeDirectoryPath `
  -Path (Join-Path $PSScriptRoot '..\..')
$outputPath = Assert-WebMirrorDirectoryWritable -Path $OutputDirectory
$extensionPath = Assert-WebMirrorSafeDirectoryPath `
  -Path (Join-Path $repositoryRoot 'apps\extension\dist')
$windowsPackagePath = Assert-WebMirrorSafeDirectoryPath `
  -Path (Join-Path $repositoryRoot 'packaging\windows\dist')
$windowsHashesPath = Get-WebMirrorExistingFile `
  -Path (Join-Path $windowsPackagePath $script:WebMirrorHashesFileName) `
  -Label 'Windows hashes.json'
$windowsHashes = Read-WebMirrorJsonFile `
  -Path $windowsHashesPath `
  -Label 'Windows hashes.json'

if (-not (Test-Path -LiteralPath $extensionPath -PathType Container)) {
  throw "Built extension directory does not exist: $extensionPath"
}
if ($windowsHashes.schemaVersion -ne 1) {
  throw "Unsupported Windows hash manifest schema: $($windowsHashes.schemaVersion)"
}

$extensionManifest = Read-WebMirrorJsonFile `
  -Path (Join-Path $extensionPath 'manifest.json') `
  -Label 'Built extension manifest'
$extensionZipPath = Join-Path $outputPath 'webmirror-extension-chromium.zip'
$windowsZipPath = Join-Path $outputPath 'webmirror-windows-native-host.zip'
$sbomPath = Join-Path $outputPath 'webmirror-sbom.spdx.json'
$releaseManifestPath = Join-Path $outputPath 'release-manifest.json'

foreach ($knownPath in @(
  $extensionZipPath,
  $windowsZipPath,
  $sbomPath,
  $releaseManifestPath
)) {
  if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
    Remove-Item -LiteralPath $knownPath -Force
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-WebMirrorZip {
  param(
    [Parameter(Mandatory = $true)]
    [string] $SourceDirectory,

    [Parameter(Mandatory = $true)]
    [string] $DestinationPath
  )

  $source = Assert-WebMirrorSafeDirectoryPath -Path $SourceDirectory
  $destination = Assert-WebMirrorPathWithinDirectory `
    -Path $DestinationPath `
    -Directory $outputPath
  $temporary = Assert-WebMirrorPathWithinDirectory `
    -Path ($destination + '.tmp-' + [System.Guid]::NewGuid().ToString('N')) `
    -Directory $outputPath
  $archive = $null
  $archiveStream = $null

  try {
    $sourcePrefix = $source.TrimEnd('\') + '\'
    $items = @(Get-ChildItem -LiteralPath $source -Recurse -Force)
    $reparsePoint = @(
      $items |
        Where-Object {
          ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        } |
        Select-Object -First 1
    )
    if ($reparsePoint.Count -gt 0) {
      throw "Refusing to archive a reparse point: $($reparsePoint[0].FullName)"
    }

    $files = @(
      $items |
        Where-Object { -not $_.PSIsContainer } |
        Sort-Object FullName
    )
    if ($files.Count -eq 0) {
      throw "Refusing to create an empty release ZIP from: $source"
    }

    $archiveStream = [System.IO.File]::Open(
      $temporary,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $archive = [System.IO.Compression.ZipArchive]::new(
      $archiveStream,
      [System.IO.Compression.ZipArchiveMode]::Create,
      $false
    )

    foreach ($file in $files) {
      $filePath = Get-WebMirrorFullPath -Path $file.FullName
      if (-not $filePath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release file is outside the source directory: $filePath"
      }

      $entryName = $filePath.Substring($sourcePrefix.Length).Replace('\', '/')
      if (
        [string]::IsNullOrWhiteSpace($entryName) -or
        $entryName.StartsWith('/', [System.StringComparison]::Ordinal) -or
        $entryName -match '(^|/)\.\.(/|$)'
      ) {
        throw "Invalid release ZIP entry name: $entryName"
      }

      $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $filePath,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
    }

    $archive.Dispose()
    $archive = $null
    $archiveStream.Dispose()
    $archiveStream = $null
    Move-Item -LiteralPath $temporary -Destination $destination -Force
  } finally {
    if ($null -ne $archive) {
      $archive.Dispose()
    }
    if ($null -ne $archiveStream) {
      $archiveStream.Dispose()
    }
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }

  return Get-WebMirrorExistingFile -Path $destination -Label 'Release ZIP'
}

function Assert-WebMirrorZipContents {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string[]] $RequiredEntries
  )

  $zipPath = Get-WebMirrorExistingFile -Path $Path -Label 'Release ZIP'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)

  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
    $invalidEntry = @(
      $entryNames |
        Where-Object {
          $_.Contains('\') -or
          $_.StartsWith('/', [System.StringComparison]::Ordinal) -or
          $_ -match '(^|/)\.\.(/|$)'
        } |
        Select-Object -First 1
    )
    if ($invalidEntry.Count -gt 0) {
      throw "Release ZIP contains an invalid entry name: $($invalidEntry[0])"
    }

    $duplicateEntry = @(
      $entryNames |
        Group-Object |
        Where-Object { $_.Count -gt 1 } |
        Select-Object -First 1
    )
    if ($duplicateEntry.Count -gt 0) {
      throw "Release ZIP contains a duplicate entry: $($duplicateEntry[0].Name)"
    }

    foreach ($requiredEntry in $RequiredEntries) {
      if ($entryNames -cnotcontains $requiredEntry) {
        throw "Release ZIP is missing the required entry: $requiredEntry"
      }
    }
  } finally {
    $archive.Dispose()
  }
}

$null = New-WebMirrorZip `
  -SourceDirectory $extensionPath `
  -DestinationPath $extensionZipPath
$null = Assert-WebMirrorZipContents `
  -Path $extensionZipPath `
  -RequiredEntries @(
    'manifest.json',
    'background.js',
    'popup.html',
    'popup.js'
  )

$stagePath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $outputPath ('.windows-stage-' + [System.Guid]::NewGuid().ToString('N'))) `
  -Directory $outputPath
$null = Ensure-WebMirrorDirectory -Path $stagePath

try {
  foreach ($fileName in @(
    $script:WebMirrorExecutableFileName,
    $script:WebMirrorHashesFileName
  )) {
    $null = Copy-WebMirrorFileAtomic `
      -Source (Join-Path $windowsPackagePath $fileName) `
      -Destination (Join-Path $stagePath $fileName)
  }

  foreach ($directoryName in @('node_modules', 'browsers')) {
    $null = Copy-WebMirrorDirectoryAtomic `
      -Source (Join-Path $windowsPackagePath $directoryName) `
      -Destination (Join-Path $stagePath $directoryName)
  }

  $null = Copy-WebMirrorDirectoryAtomic `
    -Source (Join-Path $repositoryRoot 'scripts\windows') `
    -Destination (Join-Path $stagePath 'scripts\windows')
  $null = Copy-WebMirrorFileAtomic `
    -Source (Join-Path $repositoryRoot 'docs\installation\windows-native-host.md') `
    -Destination (Join-Path $stagePath 'README.md')
  $null = New-WebMirrorZip `
    -SourceDirectory $stagePath `
    -DestinationPath $windowsZipPath
  $null = Assert-WebMirrorZipContents `
    -Path $windowsZipPath `
    -RequiredEntries @(
      'webmirror-helper.exe',
      'hashes.json',
      'browsers/chromium-headless-shell/chrome-headless-shell-win64/chrome-headless-shell.exe',
      'node_modules/playwright/package.json',
      'node_modules/playwright-core/package.json',
      'scripts/windows/install-native-host.ps1',
      'scripts/windows/diagnose-native-host.ps1',
      'scripts/windows/uninstall-native-host.ps1',
      'README.md'
    )
} finally {
  if (Test-Path -LiteralPath $stagePath -PathType Container) {
    $stageItem = Get-Item -LiteralPath $stagePath -Force
    if (($stageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to remove a reparse-point release stage: $stagePath"
    }

    Remove-Item -LiteralPath $stagePath -Recurse -Force
  }
}

$nodeCommand = @(Get-Command node -CommandType Application -ErrorAction Stop)[0]
$nodePath = Get-WebMirrorExistingFile `
  -Path $nodeCommand.Source `
  -Label 'Node executable'
$sbomScript = Get-WebMirrorExistingFile `
  -Path (Join-Path $PSScriptRoot 'generate-sbom.mjs') `
  -Label 'SBOM generator'
$null = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @($sbomScript, $sbomPath) `
  -Label 'SPDX SBOM generation'

$releaseManifest = [ordered]@{
  schemaVersion = 1
  generatedAtUtc = [System.DateTime]::UtcNow.ToString('o')
  product = 'WebMirror'
  version = [string] $extensionManifest.version
  extension = [ordered]@{
    manifestVersion = [int] $extensionManifest.manifest_version
    browsers = @('Chrome', 'Microsoft Edge')
    package = Get-WebMirrorFileRecord `
      -Path $extensionZipPath `
      -RelativePath 'webmirror-extension-chromium.zip'
  }
  windowsNativeHost = [ordered]@{
    artifactState = [string] $windowsHashes.artifactState
    helperVersion = [string] $windowsHashes.helperVersion
    package = Get-WebMirrorFileRecord `
      -Path $windowsZipPath `
      -RelativePath 'webmirror-windows-native-host.zip'
    executable = @(
      $windowsHashes.artifacts |
        Where-Object {
          ([string] $_.relativePath).Replace('\', '/') -eq $script:WebMirrorExecutableFileName
        }
    )[0]
    browser = $windowsHashes.browser
    signature = $windowsHashes.verification.signature
  }
  sbom = Get-WebMirrorFileRecord `
    -Path $sbomPath `
    -RelativePath 'webmirror-sbom.spdx.json'
  externalReleaseGates = @(
    'Sign webmirror-helper.exe with approved Authenticode credentials and timestamp.',
    'Refresh hashes.json and rebuild this release bundle after signing.',
    'Publish the privacy policy at a stable public URL.',
    'Upload the extension through authorized Chrome Web Store and Edge Add-ons accounts.'
  )
}
$null = Write-WebMirrorJsonFile `
  -Path $releaseManifestPath `
  -Value $releaseManifest `
  -Depth 20

[pscustomobject]@{
  ExtensionZip = $extensionZipPath
  WindowsZip = $windowsZipPath
  Sbom = $sbomPath
  ReleaseManifest = $releaseManifestPath
  ArtifactState = $windowsHashes.artifactState
}
