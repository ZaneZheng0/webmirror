[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ChromeExtensionId,

  [Parameter(Mandatory = $true)]
  [string] $EdgeExtensionId,

  [string] $OutputDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\..\packaging\windows\dist'
}

Assert-WebMirrorWindows
$outputPath = Assert-WebMirrorDirectoryWritable -Path $OutputDirectory
$manifests = Write-WebMirrorNativeHostManifests `
  -OutputDirectory $outputPath `
  -ChromeExtensionId $ChromeExtensionId `
  -EdgeExtensionId $EdgeExtensionId

foreach ($manifestPath in @($manifests.Chrome, $manifests.Edge)) {
  $manifest = Read-WebMirrorJsonFile -Path $manifestPath -Label 'Native host manifest'
  if (
    $manifest.name -ne $script:WebMirrorHostName -or
    $manifest.type -ne 'stdio' -or
    $manifest.path -ne $script:WebMirrorExecutableFileName -or
    @($manifest.allowed_origins).Count -ne 1
  ) {
    throw "Generated native host manifest failed validation: $manifestPath"
  }
}

[pscustomobject]@{
  HostName = $script:WebMirrorHostName
  ChromeManifest = $manifests.Chrome
  EdgeManifest = $manifests.Edge
}
