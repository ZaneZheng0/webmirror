[CmdletBinding()]
param(
  [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\WebMirror\stable'),

  [switch] $RequireValidSignature,

  [switch] $AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$script:DiagnosticChecks = New-Object System.Collections.Generic.List[object]

function Add-DiagnosticCheck {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Pass', 'Warning', 'Fail')]
    [string] $Status,

    [Parameter(Mandatory = $true)]
    [string] $Detail
  )

  $script:DiagnosticChecks.Add(
    [pscustomobject]@{
      Name = $Name
      Status = $Status
      Detail = $Detail
    }
  )
}

function Read-ExactBytes {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Stream] $Stream,

    [Parameter(Mandatory = $true)]
    [int] $Length,

    [int] $TimeoutMilliseconds = 5000
  )

  $buffer = New-Object byte[] $Length
  $offset = 0

  while ($offset -lt $Length) {
    $task = $Stream.ReadAsync($buffer, $offset, $Length - $offset)
    if (-not $task.Wait($TimeoutMilliseconds)) {
      throw "Timed out while reading $Length bytes from the native host."
    }

    $read = $task.Result
    if ($read -le 0) {
      throw "Native host stdout ended after $offset of $Length bytes."
    }

    $offset += $read
  }

  return ,$buffer
}

function Invoke-NativeHandshake {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ExecutablePath,

    [Parameter(Mandatory = $true)]
    [string] $Origin
  )

  if ($Origin -cnotmatch '^chrome-extension://[a-p]{32}/$') {
    throw "Invalid diagnostic extension origin: $Origin"
  }

  $requestId = [System.Guid]::NewGuid().ToString('N')
  $request = [ordered]@{
    type = 'handshake'
    requestId = $requestId
    protocolVersion = 2
    extensionVersion = 'diagnostic-1'
  }
  $requestJson = $request | ConvertTo-Json -Compress
  $requestBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($requestJson)
  $headerBytes = [System.BitConverter]::GetBytes([uint32] $requestBytes.Length)

  if (-not [System.BitConverter]::IsLittleEndian) {
    [System.Array]::Reverse($headerBytes)
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $ExecutablePath
  $startInfo.Arguments = "$Origin --parent-window=0"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $started = $false

  try {
    if (-not $process.Start()) {
      throw 'Failed to start the native host process.'
    }
    $started = $true

    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.BaseStream.Write($headerBytes, 0, $headerBytes.Length)
    $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.Close()

    $responseHeader = Read-ExactBytes `
      -Stream $process.StandardOutput.BaseStream `
      -Length 4
    if (-not [System.BitConverter]::IsLittleEndian) {
      [System.Array]::Reverse($responseHeader)
    }

    $responseLength = [System.BitConverter]::ToUInt32($responseHeader, 0)
    if ($responseLength -le 0 -or $responseLength -gt (1024 * 1024)) {
      throw "Native host returned an invalid response length: $responseLength."
    }

    $responseBytes = Read-ExactBytes `
      -Stream $process.StandardOutput.BaseStream `
      -Length ([int] $responseLength)
    $responseJson = (New-Object System.Text.UTF8Encoding($false)).GetString($responseBytes)
    $response = $responseJson | ConvertFrom-Json

    if (-not $process.WaitForExit(5000)) {
      $process.Kill()
      throw 'Native host did not exit after diagnostic stdin was closed.'
    }

    $stderr = $stderrTask.Result
    if ($process.ExitCode -ne 0) {
      throw "Native host exited with code $($process.ExitCode). $stderr"
    }

    if (
      $response.type -ne 'handshake_result' -or
      $response.requestId -ne $requestId -or
      $response.accepted -ne $true -or
      $response.protocolVersion -ne 2 -or
      [string]::IsNullOrWhiteSpace([string] $response.helperVersion)
    ) {
      throw "Native host returned an invalid handshake response: $responseJson"
    }

    return [pscustomobject]@{
      HelperVersion = [string] $response.helperVersion
      ProtocolVersion = [int] $response.protocolVersion
      Capabilities = @($response.capabilities)
    }
  } finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill()
      $null = $process.WaitForExit(2000)
    }
    $process.Dispose()
  }
}

function Get-ManifestExtensionOrigin {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ManifestPath,

    [Parameter(Mandatory = $true)]
    [string] $Browser
  )

  $manifest = Read-WebMirrorJsonFile -Path $ManifestPath -Label "$Browser native host manifest"
  $origins = @($manifest.allowed_origins)

  if (
    $manifest.name -ne $script:WebMirrorHostName -or
    $manifest.description -notlike "*$Browser*" -or
    $manifest.path -ne $script:WebMirrorExecutableFileName -or
    $manifest.type -ne 'stdio' -or
    $origins.Count -ne 1 -or
    [string] $origins[0] -cnotmatch '^chrome-extension://[a-p]{32}/$'
  ) {
    throw "$Browser native host manifest failed schema or least-privilege validation."
  }

  return [string] $origins[0]
}

Assert-WebMirrorWindows
$installPath = Assert-WebMirrorSafeDirectoryPath -Path $InstallDirectory
$executablePath = Join-Path $installPath $script:WebMirrorExecutableFileName
$chromeManifestPath = Join-Path $installPath $script:WebMirrorChromeManifestFileName
$edgeManifestPath = Join-Path $installPath $script:WebMirrorEdgeManifestFileName
$hashesPath = Join-Path $installPath $script:WebMirrorHashesFileName
$statePath = Join-Path $installPath $script:WebMirrorInstallStateFileName
$runtimePath = Join-Path $installPath 'node_modules'
$browserPath = Join-Path $installPath 'browsers\chromium-headless-shell'
$browserExecutablePath = Join-Path `
  $browserPath `
  'chrome-headless-shell-win64\chrome-headless-shell.exe'

$executableAvailable = $false
$chromeOrigin = $null
$edgeOrigin = $null

try {
  $null = Get-WebMirrorExistingFile -Path $executablePath -Label 'Installed helper executable'
  $executableAvailable = $true
  Add-DiagnosticCheck -Name 'Executable' -Status Pass -Detail $executablePath
} catch {
  Add-DiagnosticCheck -Name 'Executable' -Status Fail -Detail $_.Exception.Message
}

if ($executableAvailable) {
  try {
    $version = Invoke-WebMirrorCommandCapture `
      -FilePath $executablePath `
      -ArgumentList @('--version') `
      -Label 'Installed helper version check'
    Add-DiagnosticCheck -Name 'Version' -Status Pass -Detail $version
  } catch {
    Add-DiagnosticCheck -Name 'Version' -Status Fail -Detail $_.Exception.Message
  }

  try {
    $signature = Get-WebMirrorSignatureRecord -Path $executablePath
    if ($signature.status -eq 'Valid') {
      Add-DiagnosticCheck `
        -Name 'Authenticode' `
        -Status Pass `
        -Detail ([string] $signature.signerSubject)
    } elseif ($RequireValidSignature) {
      Add-DiagnosticCheck `
        -Name 'Authenticode' `
        -Status Fail `
        -Detail "Signature status: $($signature.status)"
    } else {
      Add-DiagnosticCheck `
        -Name 'Authenticode' `
        -Status Warning `
        -Detail "Development artifact is not validly signed: $($signature.status)"
    }
  } catch {
    Add-DiagnosticCheck -Name 'Authenticode' -Status Fail -Detail $_.Exception.Message
  }
}

try {
  $hashManifest = Read-WebMirrorJsonFile -Path $hashesPath -Label 'Installed hashes.json'
  $records = @(
    $hashManifest.artifacts |
      Where-Object {
        ([string] $_.relativePath).Replace('\', '/') -eq $script:WebMirrorExecutableFileName
      }
  )
  if ($hashManifest.schemaVersion -ne 1 -or $records.Count -ne 1) {
    throw 'Installed hashes.json does not contain one executable record.'
  }

  if ($executableAvailable) {
    $actualHash = Get-WebMirrorSha256 -Path $executablePath
    $expectedHash = ([string] $records[0].sha256).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Executable hash mismatch. Expected $expectedHash, got $actualHash."
    }
  }

  Add-DiagnosticCheck -Name 'Artifact hashes' -Status Pass -Detail $hashesPath
} catch {
  Add-DiagnosticCheck -Name 'Artifact hashes' -Status Fail -Detail $_.Exception.Message
}

try {
  if (
    $null -eq $hashManifest -or
    $null -eq $hashManifest.runtime -or
    [string] $hashManifest.runtime.relativePath -ne 'node_modules' -or
    [string] $hashManifest.runtime.sha256 -notmatch '^[0-9a-fA-F]{64}$'
  ) {
    throw 'Installed hashes.json does not contain a valid runtime record.'
  }

  $actualRuntimeHash = Get-WebMirrorDirectoryTreeSha256 -Directory $runtimePath
  $expectedRuntimeHash = ([string] $hashManifest.runtime.sha256).ToLowerInvariant()
  if ($actualRuntimeHash -ne $expectedRuntimeHash) {
    throw "Runtime hash mismatch. Expected $expectedRuntimeHash, got $actualRuntimeHash."
  }

  Add-DiagnosticCheck -Name 'Playwright runtime' -Status Pass -Detail $runtimePath
} catch {
  Add-DiagnosticCheck -Name 'Playwright runtime' -Status Fail -Detail $_.Exception.Message
}

try {
  if (
    $null -eq $hashManifest -or
    $null -eq $hashManifest.browser -or
    [string] $hashManifest.browser.name -ne 'chromium-headless-shell' -or
    [string] $hashManifest.browser.relativePath -ne 'browsers/chromium-headless-shell' -or
    [string] $hashManifest.browser.sha256 -notmatch '^[0-9a-fA-F]{64}$'
  ) {
    throw 'Installed hashes.json does not contain a valid bundled browser record.'
  }

  $null = Get-WebMirrorExistingFile `
    -Path $browserExecutablePath `
    -Label 'Installed Chromium Headless Shell'
  $actualBrowserHash = Get-WebMirrorBundledBrowserTreeSha256 -Directory $browserPath
  $expectedBrowserHash = ([string] $hashManifest.browser.sha256).ToLowerInvariant()
  if ($actualBrowserHash -ne $expectedBrowserHash) {
    throw "Browser hash mismatch. Expected $expectedBrowserHash, got $actualBrowserHash."
  }

  Add-DiagnosticCheck -Name 'Bundled browser' -Status Pass -Detail $browserExecutablePath
} catch {
  Add-DiagnosticCheck -Name 'Bundled browser' -Status Fail -Detail $_.Exception.Message
}

try {
  $state = Read-WebMirrorJsonFile -Path $statePath -Label 'Install state'
  if (
    $state.schemaVersion -ne 1 -or
    $state.hostName -ne $script:WebMirrorHostName -or
    -not ([string] $state.installDirectory).Equals(
      $installPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw 'Install state does not match this installation.'
  }
  Add-DiagnosticCheck -Name 'Install state' -Status Pass -Detail $statePath
} catch {
  Add-DiagnosticCheck -Name 'Install state' -Status Fail -Detail $_.Exception.Message
}

try {
  $chromeOrigin = Get-ManifestExtensionOrigin `
    -ManifestPath $chromeManifestPath `
    -Browser Chrome
  Add-DiagnosticCheck -Name 'Chrome manifest' -Status Pass -Detail $chromeOrigin
} catch {
  Add-DiagnosticCheck -Name 'Chrome manifest' -Status Fail -Detail $_.Exception.Message
}

try {
  $edgeOrigin = Get-ManifestExtensionOrigin `
    -ManifestPath $edgeManifestPath `
    -Browser Edge
  Add-DiagnosticCheck -Name 'Edge manifest' -Status Pass -Detail $edgeOrigin
} catch {
  Add-DiagnosticCheck -Name 'Edge manifest' -Status Fail -Detail $_.Exception.Message
}

foreach ($browser in @('Chrome', 'Edge')) {
  $expectedManifestPath = if ($browser -eq 'Chrome') {
    $chromeManifestPath
  } else {
    $edgeManifestPath
  }

  foreach ($view in @(Get-WebMirrorRegistryViews)) {
    try {
      $registeredPath = Get-WebMirrorNativeHostRegistration `
        -Browser $browser `
        -View $view
      if (
        $null -eq $registeredPath -or
        -not $registeredPath.Equals(
          $expectedManifestPath,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        throw "Expected $expectedManifestPath, got $registeredPath."
      }

      Add-DiagnosticCheck `
        -Name "$browser registry $($view.ToString())" `
        -Status Pass `
        -Detail $registeredPath
    } catch {
      Add-DiagnosticCheck `
        -Name "$browser registry $($view.ToString())" `
        -Status Fail `
        -Detail $_.Exception.Message
    }
  }
}

if ($executableAvailable -and $null -ne $chromeOrigin) {
  try {
    $handshake = Invoke-NativeHandshake `
      -ExecutablePath $executablePath `
      -Origin $chromeOrigin
    Add-DiagnosticCheck `
      -Name 'Chrome-style handshake' `
      -Status Pass `
      -Detail "helper=$($handshake.HelperVersion); protocol=$($handshake.ProtocolVersion)"
  } catch {
    Add-DiagnosticCheck `
      -Name 'Chrome-style handshake' `
      -Status Fail `
      -Detail $_.Exception.Message
  }
}

if ($executableAvailable -and $null -ne $edgeOrigin) {
  try {
    $handshake = Invoke-NativeHandshake `
      -ExecutablePath $executablePath `
      -Origin $edgeOrigin
    Add-DiagnosticCheck `
      -Name 'Edge-style handshake' `
      -Status Pass `
      -Detail "helper=$($handshake.HelperVersion); protocol=$($handshake.ProtocolVersion)"
  } catch {
    Add-DiagnosticCheck `
      -Name 'Edge-style handshake' `
      -Status Fail `
      -Detail $_.Exception.Message
  }
}

$hasFailures = @($script:DiagnosticChecks | Where-Object { $_.Status -eq 'Fail' }).Count -gt 0
$hasWarnings = @($script:DiagnosticChecks | Where-Object { $_.Status -eq 'Warning' }).Count -gt 0
$overallStatus = if ($hasFailures) {
  'Fail'
} elseif ($hasWarnings) {
  'Warning'
} else {
  'Pass'
}

$result = [pscustomobject]@{
  GeneratedAtUtc = [System.DateTime]::UtcNow.ToString('o')
  HostName = $script:WebMirrorHostName
  InstallDirectory = $installPath
  Status = $overallStatus
  Checks = $script:DiagnosticChecks.ToArray()
}

if ($AsJson) {
  $result | ConvertTo-Json -Depth 12
} else {
  $result
}

if ($hasFailures) {
  exit 1
}
