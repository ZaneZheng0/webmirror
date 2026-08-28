[CmdletBinding()]
param(
  [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\WebMirror\stable')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-WebMirrorWindows
$installPath = Assert-WebMirrorSafeDirectoryPath -Path $InstallDirectory
$executablePath = Join-Path $installPath $script:WebMirrorExecutableFileName
$chromeManifestPath = Join-Path $installPath $script:WebMirrorChromeManifestFileName
$edgeManifestPath = Join-Path $installPath $script:WebMirrorEdgeManifestFileName

$runningProcesses = @(Get-WebMirrorRunningHostProcesses -ExecutablePath $executablePath)
if ($runningProcesses.Count -gt 0) {
  $processIds = ($runningProcesses | ForEach-Object { $_.Id }) -join ', '
  throw "The installed helper is running (PID: $processIds). Close Chrome and Edge native connections before uninstalling."
}

$registrationResults = @()
$registrationResults += @(
  Remove-WebMirrorNativeHostRegistration `
    -Browser Chrome `
    -ExpectedManifestPath $chromeManifestPath
)
$registrationResults += @(
  Remove-WebMirrorNativeHostRegistration `
    -Browser Edge `
    -ExpectedManifestPath $edgeManifestPath
)

$removedFiles = @()
$knownFiles = @(
  $script:WebMirrorExecutableFileName,
  $script:WebMirrorChromeManifestFileName,
  $script:WebMirrorEdgeManifestFileName,
  $script:WebMirrorHashesFileName,
  $script:WebMirrorInstallStateFileName
)

if (Test-Path -LiteralPath $installPath -PathType Container) {
  foreach ($fileName in $knownFiles) {
    $filePath = Assert-WebMirrorPathWithinDirectory `
      -Path (Join-Path $installPath $fileName) `
      -Directory $installPath
    if (Test-Path -LiteralPath $filePath -PathType Leaf) {
      Remove-Item -LiteralPath $filePath -Force
      $removedFiles += $filePath
    }
  }

  $runtimePath = Assert-WebMirrorPathWithinDirectory `
    -Path (Join-Path $installPath 'node_modules') `
    -Directory $installPath
  if (Test-Path -LiteralPath $runtimePath -PathType Container) {
    $runtimeItem = Get-Item -LiteralPath $runtimePath -Force
    if (($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to remove a reparse-point runtime directory: $runtimePath"
    }

    Remove-Item -LiteralPath $runtimePath -Recurse -Force
    $removedFiles += $runtimePath
  }

  $browserRootPath = Assert-WebMirrorPathWithinDirectory `
    -Path (Join-Path $installPath 'browsers') `
    -Directory $installPath
  if (Test-Path -LiteralPath $browserRootPath -PathType Container) {
    $browserRootItem = Get-Item -LiteralPath $browserRootPath -Force
    if (($browserRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to remove a reparse-point browser directory: $browserRootPath"
    }

    Remove-Item -LiteralPath $browserRootPath -Recurse -Force
    $removedFiles += $browserRootPath
  }
}

$directoryRemoved = $false
$remainingFiles = @()
if (Test-Path -LiteralPath $installPath -PathType Container) {
  $remainingFiles = @(Get-ChildItem -LiteralPath $installPath -Force)
  if ($remainingFiles.Count -eq 0) {
    Remove-Item -LiteralPath $installPath
    $directoryRemoved = $true
  }
}

[pscustomobject]@{
  HostName = $script:WebMirrorHostName
  InstallDirectory = $installPath
  RemovedFiles = $removedFiles
  DirectoryRemoved = $directoryRemoved
  PreservedEntries = @(
    $registrationResults |
      Where-Object { $_.Action -eq 'PreservedMismatch' }
  )
  RemainingItems = @($remainingFiles | ForEach-Object { $_.FullName })
  UserDataRemoved = $false
}
