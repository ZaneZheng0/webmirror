[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ChromeExtensionId,

  [Parameter(Mandatory = $true)]
  [string] $EdgeExtensionId,

  [string] $SourceDirectory = '',

  [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\WebMirror\stable'),

  [switch] $RequireValidSignature
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$installScript = Join-Path $PSScriptRoot 'install-native-host.ps1'
$parameters = @{
  ChromeExtensionId = $ChromeExtensionId
  EdgeExtensionId = $EdgeExtensionId
  SourceDirectory = $SourceDirectory
  InstallDirectory = $InstallDirectory
  Upgrade = $true
}

if ($RequireValidSignature) {
  $parameters.RequireValidSignature = $true
}

& $installScript @parameters
