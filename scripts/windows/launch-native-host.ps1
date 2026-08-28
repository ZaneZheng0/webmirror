[CmdletBinding()]
param(
  [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\WebMirror\stable'),

  [ValidateSet('Version', 'Native', 'Browser')]
  [string] $Mode = 'Version',

  [string] $ExtensionId = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-WebMirrorWindows
$installPath = Assert-WebMirrorSafeDirectoryPath -Path $InstallDirectory
$executablePath = Get-WebMirrorExistingFile `
  -Path (Join-Path $installPath $script:WebMirrorExecutableFileName) `
  -Label 'Installed helper executable'

switch ($Mode) {
  'Version' {
    Invoke-WebMirrorCommandCapture `
      -FilePath $executablePath `
      -ArgumentList @('--version') `
      -Label 'WebMirror helper version'
    break
  }
  'Native' {
    & $executablePath '--native'
    if ($LASTEXITCODE -ne 0) {
      throw "WebMirror native host exited with code $LASTEXITCODE."
    }
    break
  }
  'Browser' {
    $validatedId = Assert-WebMirrorExtensionId `
      -ExtensionId $ExtensionId `
      -Label 'Browser extension ID'
    & $executablePath "chrome-extension://$validatedId/" '--parent-window=0'
    if ($LASTEXITCODE -ne 0) {
      throw "WebMirror browser-style native host exited with code $LASTEXITCODE."
    }
    break
  }
}
