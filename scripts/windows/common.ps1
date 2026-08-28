Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:WebMirrorHostName = 'com.webmirror.helper'
$script:WebMirrorExecutableFileName = 'webmirror-helper.exe'
$script:WebMirrorChromeManifestFileName = 'com.webmirror.helper.chrome.json'
$script:WebMirrorEdgeManifestFileName = 'com.webmirror.helper.edge.json'
$script:WebMirrorHashesFileName = 'hashes.json'
$script:WebMirrorInstallStateFileName = 'install-state.json'
$script:WebMirrorBundledBrowserMutableLogRelativePath = 'chrome-headless-shell-win64/debug.log'

function Assert-WebMirrorWindows {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'WebMirror Windows packaging scripts can only run on Windows.'
  }
}

function Get-WebMirrorFullPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [string] $BaseDirectory = (Get-Location).Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'A path value cannot be empty.'
  }

  if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Path)) {
    throw "Wildcard characters are not allowed in paths: $Path"
  }

  $expandedPath = [System.Environment]::ExpandEnvironmentVariables($Path)
  if (-not [System.IO.Path]::IsPathRooted($expandedPath)) {
    $expandedPath = [System.IO.Path]::Combine($BaseDirectory, $expandedPath)
  }

  $fullPath = [System.IO.Path]::GetFullPath($expandedPath)
  if (
    $fullPath.StartsWith('\\', [System.StringComparison]::Ordinal) -or
    $fullPath.StartsWith('\\?\', [System.StringComparison]::Ordinal) -or
    $fullPath.StartsWith('\\.\', [System.StringComparison]::Ordinal)
  ) {
    throw "UNC and device paths are not supported: $fullPath"
  }

  if ($fullPath.Length -gt 2 -and $fullPath.Substring(2).Contains(':')) {
    throw "Alternate data stream paths are not supported: $fullPath"
  }

  return $fullPath
}

function Assert-WebMirrorSafeDirectoryPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $fullPath = Get-WebMirrorFullPath -Path $Path
  $rootPath = [System.IO.Path]::GetPathRoot($fullPath)

  if (
    $fullPath.TrimEnd('\') -eq $rootPath.TrimEnd('\') -or
    $fullPath -eq [System.Environment]::GetFolderPath(
      [System.Environment+SpecialFolder]::Windows
    )
  ) {
    throw "Refusing to use a filesystem root or the Windows directory: $fullPath"
  }

  return $fullPath
}

function Assert-WebMirrorPathWithinDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Directory
  )

  $fullPath = Get-WebMirrorFullPath -Path $Path
  $fullDirectory = Assert-WebMirrorSafeDirectoryPath -Path $Directory
  $directoryPrefix = $fullDirectory.TrimEnd('\') + '\'

  if (-not $fullPath.StartsWith($directoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the expected directory: $fullPath"
  }

  return $fullPath
}

function Get-WebMirrorExistingFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [string] $Label = 'File'
  )

  $fullPath = Get-WebMirrorFullPath -Path $Path
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "$Label does not exist or is not a file: $fullPath"
  }

  $item = Get-Item -LiteralPath $fullPath -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point: $fullPath"
  }

  if ($item.Length -le 0) {
    throw "$Label is empty: $fullPath"
  }

  return $fullPath
}

function Ensure-WebMirrorDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $fullPath = Assert-WebMirrorSafeDirectoryPath -Path $Path
  if (Test-Path -LiteralPath $fullPath) {
    $item = Get-Item -LiteralPath $fullPath -Force
    if (-not $item.PSIsContainer) {
      throw "Expected a directory but found a file: $fullPath"
    }

    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Directory must not be a reparse point: $fullPath"
    }
  } else {
    $null = New-Item -ItemType Directory -Path $fullPath
  }

  return $fullPath
}

function Assert-WebMirrorDirectoryWritable {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $fullPath = Ensure-WebMirrorDirectory -Path $Path
  $probePath = Join-Path $fullPath ('.webmirror-write-test-' + [System.Guid]::NewGuid().ToString('N'))

  try {
    [System.IO.File]::WriteAllText(
      $probePath,
      'write-test',
      (New-Object System.Text.UTF8Encoding($false))
    )
  } finally {
    if (Test-Path -LiteralPath $probePath -PathType Leaf) {
      Remove-Item -LiteralPath $probePath -Force
    }
  }

  return $fullPath
}

function Assert-WebMirrorExtensionId {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ExtensionId,

    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  if ($ExtensionId -cnotmatch '^[a-p]{32}$') {
    throw "$Label must be exactly 32 lowercase characters in the range a-p."
  }

  return $ExtensionId
}

function Get-WebMirrorSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [switch] $AllowEmpty
  )

  $fullPath = Get-WebMirrorFullPath -Path $Path
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "File does not exist: $fullPath"
  }

  $item = Get-Item -LiteralPath $fullPath -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "File must not be a reparse point: $fullPath"
  }

  if (-not $AllowEmpty -and $item.Length -le 0) {
    throw "File is empty: $fullPath"
  }

  $stream = [System.IO.File]::Open(
    $fullPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  $sha256 = [System.Security.Cryptography.SHA256]::Create()

  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Assert-WebMirrorExpectedSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Actual,

    [string] $Expected,

    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  if ([string]::IsNullOrWhiteSpace($Expected)) {
    return
  }

  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Expected SHA-256 for $Label must contain exactly 64 hexadecimal characters."
  }

  if (-not $Actual.Equals($Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label SHA-256 mismatch. Expected $($Expected.ToLowerInvariant()), got $Actual."
  }
}

function Get-WebMirrorFileRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $RelativePath
  )

  $fullPath = Get-WebMirrorExistingFile -Path $Path
  $item = Get-Item -LiteralPath $fullPath

  return [ordered]@{
    relativePath = $RelativePath.Replace('\', '/')
    bytes = [int64] $item.Length
    sha256 = Get-WebMirrorSha256 -Path $fullPath
  }
}

function Write-WebMirrorUtf8File {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string] $Content
  )

  $fullPath = Get-WebMirrorFullPath -Path $Path
  $parentPath = Split-Path -Parent $fullPath
  $null = Assert-WebMirrorDirectoryWritable -Path $parentPath
  $temporaryPath = $fullPath + '.tmp-' + [System.Guid]::NewGuid().ToString('N')

  try {
    [System.IO.File]::WriteAllText(
      $temporaryPath,
      $Content,
      (New-Object System.Text.UTF8Encoding($false))
    )
    Move-Item -LiteralPath $temporaryPath -Destination $fullPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }

  return $fullPath
}

function Write-WebMirrorJsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [object] $Value,

    [int] $Depth = 12
  )

  $json = $Value | ConvertTo-Json -Depth $Depth
  return Write-WebMirrorUtf8File -Path $Path -Content ($json + [System.Environment]::NewLine)
}

function Read-WebMirrorJsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [string] $Label = 'JSON file'
  )

  $fullPath = Get-WebMirrorExistingFile -Path $Path -Label $Label
  try {
    return Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "$Label is not valid JSON: $fullPath. $($_.Exception.Message)"
  }
}

function Invoke-WebMirrorCommandCapture {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,

    [string[]] $ArgumentList = @(),

    [string] $Label = 'Command'
  )

  $commandPath = Get-WebMirrorExistingFile -Path $FilePath -Label "$Label executable"
  $previousErrorActionPreference = $ErrorActionPreference
  $noColorWasDefined = Test-Path Env:NO_COLOR
  $forceColorWasDefined = Test-Path Env:FORCE_COLOR
  $previousNoColor = if ($noColorWasDefined) { $env:NO_COLOR } else { $null }
  $previousForceColor = if ($forceColorWasDefined) { $env:FORCE_COLOR } else { $null }
  try {
    $ErrorActionPreference = 'Continue'
    # Machine-readable helper probes must not inherit contradictory color settings.
    # Node emits a warning when NO_COLOR and FORCE_COLOR are both present; because
    # stderr is deliberately captured for diagnostics, that warning otherwise
    # contaminates values such as `--version` and produces a false mismatch.
    $env:NO_COLOR = '1'
    Remove-Item -LiteralPath Env:FORCE_COLOR -ErrorAction SilentlyContinue
    $output = @(& $commandPath @ArgumentList 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference

    if ($noColorWasDefined) {
      $env:NO_COLOR = $previousNoColor
    } else {
      Remove-Item -LiteralPath Env:NO_COLOR -ErrorAction SilentlyContinue
    }

    if ($forceColorWasDefined) {
      $env:FORCE_COLOR = $previousForceColor
    } else {
      Remove-Item -LiteralPath Env:FORCE_COLOR -ErrorAction SilentlyContinue
    }
  }
  $text = ($output | ForEach-Object { $_.ToString() }) -join [System.Environment]::NewLine

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode. $text"
  }

  return $text.Trim()
}

function Get-WebMirrorSignatureRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $fullPath = Get-WebMirrorExistingFile -Path $Path
  $signatureCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
  if ($null -eq $signatureCommand) {
    return [ordered]@{
      status = 'Unavailable'
      statusMessage = 'Authenticode verification is unavailable in this PowerShell environment.'
      signerSubject = $null
      signerThumbprint = $null
    }
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $fullPath
  $subject = $null
  $thumbprint = $null

  if ($null -ne $signature.SignerCertificate) {
    $subject = $signature.SignerCertificate.Subject
    $thumbprint = $signature.SignerCertificate.Thumbprint
  }

  return [ordered]@{
    status = $signature.Status.ToString()
    statusMessage = $signature.StatusMessage
    signerSubject = $subject
    signerThumbprint = $thumbprint
  }
}

function Copy-WebMirrorFileAtomic {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Source,

    [Parameter(Mandatory = $true)]
    [string] $Destination
  )

  $sourcePath = Get-WebMirrorExistingFile -Path $Source -Label 'Source file'
  $destinationPath = Get-WebMirrorFullPath -Path $Destination
  $parentPath = Split-Path -Parent $destinationPath
  $null = Assert-WebMirrorDirectoryWritable -Path $parentPath
  $temporaryPath = $destinationPath + '.new-' + [System.Guid]::NewGuid().ToString('N')

  try {
    Copy-Item -LiteralPath $sourcePath -Destination $temporaryPath
    $sourceHash = Get-WebMirrorSha256 -Path $sourcePath
    $temporaryHash = Get-WebMirrorSha256 -Path $temporaryPath
    if ($sourceHash -ne $temporaryHash) {
      throw "Atomic copy verification failed for $destinationPath."
    }

    Move-Item -LiteralPath $temporaryPath -Destination $destinationPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }

  return $destinationPath
}

function Get-WebMirrorDirectoryTreeSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Directory,

    [switch] $ExcludeBundledBrowserMutableLog
  )

  $root = Assert-WebMirrorSafeDirectoryPath -Path $Directory
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Directory does not exist: $root"
  }

  $rootItem = Get-Item -LiteralPath $root -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $targets = @($rootItem.Target)
    if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string] $targets[0])) {
      throw "Directory tree root reparse target could not be resolved: $root"
    }

    $target = [string] $targets[0]
    if (-not [System.IO.Path]::IsPathRooted($target)) {
      $target = Join-Path (Split-Path -Parent $root) $target
    }

    $root = Assert-WebMirrorSafeDirectoryPath -Path $target
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      throw "Directory tree reparse target does not exist: $root"
    }

    $rootItem = Get-Item -LiteralPath $root -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Directory tree reparse target must not be another reparse point: $root"
    }
  }

  $prefix = $root.TrimEnd('\') + '\'
  $lines = New-Object System.Collections.Generic.List[string]
  $entries = @(Get-ChildItem -LiteralPath $root -Recurse -Force)
  $records = @{}

  foreach ($entry in $entries) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Directory tree contains a reparse point: $($entry.FullName)"
    }
  }

  $files = @($entries | Where-Object { -not $_.PSIsContainer })
  if ($files.Count -eq 0) {
    throw "No files were found while hashing directory: $root"
  }

  foreach ($file in $files) {
    if (-not $file.FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Directory tree hashing escaped its root: $($file.FullName)"
    }

    $relativePath = $file.FullName.Substring($prefix.Length).Replace('\', '/')
    if (
      $ExcludeBundledBrowserMutableLog -and
      $relativePath.Equals(
        $script:WebMirrorBundledBrowserMutableLogRelativePath,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    ) {
      continue
    }

    $fileHash = Get-WebMirrorSha256 -Path $file.FullName -AllowEmpty
    $records[$relativePath] = [pscustomobject]@{
      Bytes = [int64] $file.Length
      Sha256 = $fileHash
    }
  }

  $relativePaths = [string[]] @($records.Keys)
  [System.Array]::Sort($relativePaths, [System.StringComparer]::Ordinal)

  foreach ($relativePath in $relativePaths) {
    $record = $records[$relativePath]
    $lines.Add(
      [string]::Format(
        [System.Globalization.CultureInfo]::InvariantCulture,
        "{0}`t{1}`t{2}",
        $relativePath,
        $record.Bytes,
        $record.Sha256
      )
    )
  }

  $serialized = [string]::Join("`n", $lines) + "`n"
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($serialized)
    return ([System.BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-WebMirrorBundledBrowserTreeSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Directory
  )

  $browserDirectory = Assert-WebMirrorSafeDirectoryPath -Path $Directory
  $null = Get-WebMirrorExistingFile `
    -Path (Join-Path $browserDirectory 'chrome-headless-shell-win64\chrome-headless-shell.exe') `
    -Label 'Bundled Chromium Headless Shell executable'

  return Get-WebMirrorDirectoryTreeSha256 `
    -Directory $browserDirectory `
    -ExcludeBundledBrowserMutableLog
}

function Copy-WebMirrorDirectoryAtomic {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Source,

    [Parameter(Mandatory = $true)]
    [string] $Destination
  )

  $sourcePath = Assert-WebMirrorSafeDirectoryPath -Path $Source
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "Source directory does not exist: $sourcePath"
  }

  $destinationPath = Assert-WebMirrorSafeDirectoryPath -Path $Destination
  $parentPath = Split-Path -Parent $destinationPath
  $null = Assert-WebMirrorDirectoryWritable -Path $parentPath
  $null = Assert-WebMirrorPathWithinDirectory -Path $destinationPath -Directory $parentPath
  $temporaryPath = Assert-WebMirrorPathWithinDirectory `
    -Path ($destinationPath + '.new-' + [System.Guid]::NewGuid().ToString('N')) `
    -Directory $parentPath

  try {
    Copy-Item -LiteralPath $sourcePath -Destination $temporaryPath -Recurse
    $sourceHash = Get-WebMirrorDirectoryTreeSha256 -Directory $sourcePath
    $temporaryHash = Get-WebMirrorDirectoryTreeSha256 -Directory $temporaryPath
    if ($sourceHash -ne $temporaryHash) {
      throw "Directory copy verification failed for $destinationPath."
    }

    if (Test-Path -LiteralPath $destinationPath) {
      $existing = Get-Item -LiteralPath $destinationPath -Force
      if (
        -not $existing.PSIsContainer -or
        ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
      ) {
        throw "Refusing to replace an unsafe directory: $destinationPath"
      }

      Remove-Item -LiteralPath $destinationPath -Recurse -Force
    }

    Move-Item -LiteralPath $temporaryPath -Destination $destinationPath
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Container) {
      Remove-Item -LiteralPath $temporaryPath -Recurse -Force
    }
  }

  return $destinationPath
}

function New-WebMirrorNativeHostManifest {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ExtensionId,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Chrome', 'Edge')]
    [string] $Browser
  )

  $validatedId = Assert-WebMirrorExtensionId -ExtensionId $ExtensionId -Label "$Browser extension ID"

  return [ordered]@{
    name = $script:WebMirrorHostName
    description = "WebMirror local helper for $Browser"
    path = $script:WebMirrorExecutableFileName
    type = 'stdio'
    allowed_origins = @("chrome-extension://$validatedId/")
  }
}

function Write-WebMirrorNativeHostManifests {
  param(
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string] $ChromeExtensionId,

    [Parameter(Mandatory = $true)]
    [string] $EdgeExtensionId
  )

  $directory = Assert-WebMirrorDirectoryWritable -Path $OutputDirectory
  $chromePath = Join-Path $directory $script:WebMirrorChromeManifestFileName
  $edgePath = Join-Path $directory $script:WebMirrorEdgeManifestFileName

  $chromeManifest = New-WebMirrorNativeHostManifest `
    -ExtensionId $ChromeExtensionId `
    -Browser Chrome
  $edgeManifest = New-WebMirrorNativeHostManifest `
    -ExtensionId $EdgeExtensionId `
    -Browser Edge

  $null = Write-WebMirrorJsonFile -Path $chromePath -Value $chromeManifest
  $null = Write-WebMirrorJsonFile -Path $edgePath -Value $edgeManifest

  return [pscustomobject]@{
    Chrome = $chromePath
    Edge = $edgePath
  }
}

function Get-WebMirrorRegistryViews {
  if ([System.Environment]::Is64BitOperatingSystem) {
    return @(
      [Microsoft.Win32.RegistryView]::Registry32,
      [Microsoft.Win32.RegistryView]::Registry64
    )
  }

  return @([Microsoft.Win32.RegistryView]::Registry32)
}

function Get-WebMirrorNativeMessagingParentPath {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Chrome', 'Edge')]
    [string] $Browser
  )

  if ($Browser -eq 'Chrome') {
    return 'SOFTWARE\Google\Chrome\NativeMessagingHosts'
  }

  return 'SOFTWARE\Microsoft\Edge\NativeMessagingHosts'
}

function Set-WebMirrorNativeHostRegistration {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Chrome', 'Edge')]
    [string] $Browser,

    [Parameter(Mandatory = $true)]
    [string] $ManifestPath
  )

  $resolvedManifestPath = Get-WebMirrorExistingFile -Path $ManifestPath -Label "$Browser manifest"
  $parentPath = Get-WebMirrorNativeMessagingParentPath -Browser $Browser
  $subkeyPath = "$parentPath\$script:WebMirrorHostName"
  $results = @()

  foreach ($view in @(Get-WebMirrorRegistryViews)) {
    $baseKey = $null
    $hostKey = $null

    try {
      $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::CurrentUser,
        $view
      )
      $hostKey = $baseKey.CreateSubKey(
        $subkeyPath,
        [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
      )
      $hostKey.SetValue('', $resolvedManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
      $results += [pscustomobject]@{
        Browser = $Browser
        View = $view.ToString()
        ManifestPath = $resolvedManifestPath
      }
    } finally {
      if ($null -ne $hostKey) {
        $hostKey.Dispose()
      }
      if ($null -ne $baseKey) {
        $baseKey.Dispose()
      }
    }
  }

  return $results
}

function Get-WebMirrorNativeHostRegistration {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Chrome', 'Edge')]
    [string] $Browser,

    [Parameter(Mandatory = $true)]
    [Microsoft.Win32.RegistryView] $View
  )

  $parentPath = Get-WebMirrorNativeMessagingParentPath -Browser $Browser
  $subkeyPath = "$parentPath\$script:WebMirrorHostName"
  $baseKey = $null
  $hostKey = $null

  try {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      $View
    )
    $hostKey = $baseKey.OpenSubKey($subkeyPath, $false)
    if ($null -eq $hostKey) {
      return $null
    }

    return [string] $hostKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::None)
  } finally {
    if ($null -ne $hostKey) {
      $hostKey.Dispose()
    }
    if ($null -ne $baseKey) {
      $baseKey.Dispose()
    }
  }
}

function Remove-WebMirrorNativeHostRegistration {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Chrome', 'Edge')]
    [string] $Browser,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedManifestPath
  )

  $resolvedExpectedPath = Get-WebMirrorFullPath -Path $ExpectedManifestPath
  $parentPath = Get-WebMirrorNativeMessagingParentPath -Browser $Browser
  $results = @()

  foreach ($view in @(Get-WebMirrorRegistryViews)) {
    $baseKey = $null
    $parentKey = $null
    $hostKey = $null

    try {
      $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::CurrentUser,
        $view
      )
      $parentKey = $baseKey.OpenSubKey($parentPath, $true)
      if ($null -eq $parentKey) {
        $results += [pscustomobject]@{
          Browser = $Browser
          View = $view.ToString()
          Action = 'Absent'
          Value = $null
        }
        continue
      }

      $hostKey = $parentKey.OpenSubKey($script:WebMirrorHostName, $false)
      if ($null -eq $hostKey) {
        $results += [pscustomobject]@{
          Browser = $Browser
          View = $view.ToString()
          Action = 'Absent'
          Value = $null
        }
        continue
      }

      $currentValue = [string] $hostKey.GetValue(
        '',
        $null,
        [Microsoft.Win32.RegistryValueOptions]::None
      )
      $hostKey.Dispose()
      $hostKey = $null

      if (
        -not $currentValue.Equals(
          $resolvedExpectedPath,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        $results += [pscustomobject]@{
          Browser = $Browser
          View = $view.ToString()
          Action = 'PreservedMismatch'
          Value = $currentValue
        }
        continue
      }

      $parentKey.DeleteSubKey($script:WebMirrorHostName, $false)
      $results += [pscustomobject]@{
        Browser = $Browser
        View = $view.ToString()
        Action = 'Removed'
        Value = $currentValue
      }
    } finally {
      if ($null -ne $hostKey) {
        $hostKey.Dispose()
      }
      if ($null -ne $parentKey) {
        $parentKey.Dispose()
      }
      if ($null -ne $baseKey) {
        $baseKey.Dispose()
      }
    }
  }

  return $results
}

function Get-WebMirrorRunningHostProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ExecutablePath
  )

  $resolvedExecutablePath = Get-WebMirrorFullPath -Path $ExecutablePath
  $matches = @()

  foreach ($process in @(Get-Process -Name 'webmirror-helper' -ErrorAction SilentlyContinue)) {
    try {
      if (
        $null -ne $process.Path -and
        $process.Path.Equals(
          $resolvedExecutablePath,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        $matches += $process
      }
    } catch {
      continue
    }
  }

  return $matches
}
