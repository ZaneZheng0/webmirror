[CmdletBinding()]
param(
  [string] $HelperJavaScript = '',

  [Parameter(Mandatory = $true)]
  [string] $PostjectPath,

  [string] $OutputDirectory = '',

  [string] $ExpectedNodeSha256 = '',

  [string] $ExpectedPostjectSha256 = '',

  [string] $ExpectedHelperJavaScriptSha256 = '',

  [string] $ExpectedPostjectVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

if ([string]::IsNullOrWhiteSpace($HelperJavaScript)) {
  $HelperJavaScript = Join-Path $PSScriptRoot '..\..\apps\helper\dist\index.cjs'
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $PSScriptRoot '..\..\packaging\windows\dist'
}

function Get-PostjectPackage {
  param(
    [Parameter(Mandatory = $true)]
    [string] $CliPath
  )

  $cursor = Split-Path -Parent $CliPath
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    $packageJsonPath = Join-Path $cursor 'package.json'
    if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
      $package = Read-WebMirrorJsonFile -Path $packageJsonPath -Label 'postject package.json'
      if ($package.name -eq 'postject') {
        return [pscustomobject]@{
          Root = $cursor
          PackageJsonPath = $packageJsonPath
          Version = [string] $package.version
        }
      }
    }

    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) {
      break
    }
    $cursor = $parent
  }

  throw "Could not locate the postject package root for CLI: $CliPath"
}

Assert-WebMirrorWindows

$nodeCommand = @(Get-Command node -CommandType Application -ErrorAction Stop)[0]
$nodePath = Get-WebMirrorExistingFile -Path $nodeCommand.Source -Label 'Current node.exe'
$helperPath = Get-WebMirrorExistingFile -Path $HelperJavaScript -Label 'Built helper JavaScript'
$loaderPath = Get-WebMirrorExistingFile `
  -Path (Join-Path $PSScriptRoot '..\..\packaging\windows\sea-loader.cjs') `
  -Label 'SEA loader'
$postjectCliPath = Get-WebMirrorExistingFile -Path $PostjectPath -Label 'postject CLI'
$postjectPackage = Get-PostjectPackage -CliPath $postjectCliPath
$outputPath = Assert-WebMirrorDirectoryWritable -Path $OutputDirectory
$helperPackageDirectory = Assert-WebMirrorSafeDirectoryPath `
  -Path (Join-Path $PSScriptRoot '..\..\apps\helper')
$playwrightPackageJson = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @(
    '-e',
    "process.stdout.write(require.resolve('playwright/package.json',{paths:[process.argv[1]]}))",
    $helperPackageDirectory
  ) `
  -Label 'Playwright package resolution'
$playwrightPackageDirectory = Assert-WebMirrorSafeDirectoryPath `
  -Path (Split-Path -Parent $playwrightPackageJson)
$playwrightCorePackageJson = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @(
    '-e',
    "process.stdout.write(require.resolve('playwright-core/package.json',{paths:[process.argv[1]]}))",
    $playwrightPackageDirectory
  ) `
  -Label 'Playwright Core package resolution'
$playwrightCoreDirectory = Assert-WebMirrorSafeDirectoryPath `
  -Path (Split-Path -Parent $playwrightCorePackageJson)
$null = Get-WebMirrorExistingFile `
  -Path (Join-Path $playwrightPackageDirectory 'package.json') `
  -Label 'Playwright package.json'
$null = Get-WebMirrorExistingFile `
  -Path (Join-Path $playwrightCoreDirectory 'package.json') `
  -Label 'Playwright Core package.json'
$playwrightBrowsersJson = Get-WebMirrorExistingFile `
  -Path (Join-Path $playwrightCoreDirectory 'browsers.json') `
  -Label 'Playwright browsers.json'
$playwrightBrowsers = Read-WebMirrorJsonFile `
  -Path $playwrightBrowsersJson `
  -Label 'Playwright browsers.json'
$headlessShellRecords = @(
  $playwrightBrowsers.browsers |
    Where-Object { [string] $_.name -eq 'chromium-headless-shell' }
)
if (
  $headlessShellRecords.Count -ne 1 -or
  [string]::IsNullOrWhiteSpace([string] $headlessShellRecords[0].revision)
) {
  throw 'Playwright browsers.json must contain one chromium-headless-shell record.'
}

$headlessShellRevision = [string] $headlessShellRecords[0].revision
$headlessShellVersion = [string] $headlessShellRecords[0].browserVersion
$browserCacheRoot = if (
  -not [string]::IsNullOrWhiteSpace($env:PLAYWRIGHT_BROWSERS_PATH) -and
  $env:PLAYWRIGHT_BROWSERS_PATH -ne '0'
) {
  $env:PLAYWRIGHT_BROWSERS_PATH
} else {
  Join-Path $env:LOCALAPPDATA 'ms-playwright'
}
$headlessShellSourceDirectory = Assert-WebMirrorSafeDirectoryPath `
  -Path (Join-Path $browserCacheRoot "chromium_headless_shell-$headlessShellRevision")
if (-not (Test-Path -LiteralPath $headlessShellSourceDirectory -PathType Container)) {
  throw "Playwright Chromium Headless Shell is not installed: $headlessShellSourceDirectory. Run 'pnpm exec playwright install chromium' before packaging."
}
$headlessShellSourceExecutable = Get-WebMirrorExistingFile `
  -Path (Join-Path $headlessShellSourceDirectory 'chrome-headless-shell-win64\chrome-headless-shell.exe') `
  -Label 'Playwright Chromium Headless Shell executable'
$runtimeNodeModules = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $outputPath 'node_modules') `
  -Directory $outputPath
$null = Ensure-WebMirrorDirectory -Path $runtimeNodeModules
$null = Copy-WebMirrorDirectoryAtomic `
  -Source $playwrightPackageDirectory `
  -Destination (Join-Path $runtimeNodeModules 'playwright')
$null = Copy-WebMirrorDirectoryAtomic `
  -Source $playwrightCoreDirectory `
  -Destination (Join-Path $runtimeNodeModules 'playwright-core')
$browserOutputRoot = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $outputPath 'browsers') `
  -Directory $outputPath
$null = Ensure-WebMirrorDirectory -Path $browserOutputRoot
$bundledBrowserDirectory = Copy-WebMirrorDirectoryAtomic `
  -Source $headlessShellSourceDirectory `
  -Destination (Join-Path $browserOutputRoot 'chromium-headless-shell')
$transientBrowserLog = Join-Path `
  $bundledBrowserDirectory `
  $script:WebMirrorBundledBrowserMutableLogRelativePath
if (Test-Path -LiteralPath $transientBrowserLog -PathType Leaf) {
  $browserLogItem = Get-Item -LiteralPath $transientBrowserLog -Force
  if (($browserLogItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to remove a reparse-point browser log: $transientBrowserLog"
  }

  Remove-Item -LiteralPath $transientBrowserLog -Force
}
$bundledBrowserExecutable = Get-WebMirrorExistingFile `
  -Path (Join-Path $bundledBrowserDirectory 'chrome-headless-shell-win64\chrome-headless-shell.exe') `
  -Label 'Bundled Playwright Chromium Headless Shell executable'

$nodeVersion = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @('--version') `
  -Label 'Node version check'
$nodeDetailsJson = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @(
    '-p',
    'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath})'
  ) `
  -Label 'Node runtime check'
$nodeDetails = $nodeDetailsJson | ConvertFrom-Json

if ($nodeDetails.platform -ne 'win32') {
  throw "Current Node runtime is not a Windows build: $($nodeDetails.platform)"
}

$nodeHelp = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @('--help') `
  -Label 'Node SEA capability check'
if ($nodeHelp -notmatch '--experimental-sea-config') {
  throw "Current Node runtime does not expose --experimental-sea-config: $nodePath"
}

$nodeHash = Get-WebMirrorSha256 -Path $nodePath
$postjectHash = Get-WebMirrorSha256 -Path $postjectCliPath
$helperHash = Get-WebMirrorSha256 -Path $helperPath
$loaderHash = Get-WebMirrorSha256 -Path $loaderPath

Assert-WebMirrorExpectedSha256 `
  -Actual $nodeHash `
  -Expected $ExpectedNodeSha256 `
  -Label 'node.exe'
Assert-WebMirrorExpectedSha256 `
  -Actual $postjectHash `
  -Expected $ExpectedPostjectSha256 `
  -Label 'postject CLI'
Assert-WebMirrorExpectedSha256 `
  -Actual $helperHash `
  -Expected $ExpectedHelperJavaScriptSha256 `
  -Label 'built helper JavaScript'

if (
  -not [string]::IsNullOrWhiteSpace($ExpectedPostjectVersion) -and
  $postjectPackage.Version -ne $ExpectedPostjectVersion
) {
  throw "postject version mismatch. Expected $ExpectedPostjectVersion, got $($postjectPackage.Version)."
}

$helperVersion = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @($helperPath, '--version') `
  -Label 'Built helper smoke test'
if (
  [string]::IsNullOrWhiteSpace($helperVersion) -or
  $helperVersion.Length -gt 128 -or
  $helperVersion -match '[\r\n]'
) {
  throw 'Built helper returned an invalid version string.'
}

$helperHashAssetPath = Join-Path $outputPath 'webmirror-helper.js.sha256'
$seaConfigPath = Join-Path $outputPath 'sea-config.json'
$blobPath = Join-Path $outputPath 'webmirror-helper.blob'
$executablePath = Join-Path $outputPath $script:WebMirrorExecutableFileName
$stagingExecutablePath = Assert-WebMirrorPathWithinDirectory `
  -Path (Join-Path $outputPath ('.webmirror-helper-' + [System.Guid]::NewGuid().ToString('N') + '.exe')) `
  -Directory $outputPath
$hashesPath = Join-Path $outputPath $script:WebMirrorHashesFileName

$null = Write-WebMirrorUtf8File `
  -Path $helperHashAssetPath `
  -Content ($helperHash + [System.Environment]::NewLine)

$seaConfig = [ordered]@{
  main = $loaderPath
  output = $blobPath
  disableExperimentalSEAWarning = $true
  useSnapshot = $false
  useCodeCache = $false
  execArgvExtension = 'none'
  assets = [ordered]@{
    'webmirror-helper.js' = $helperPath
    'webmirror-helper.sha256' = $helperHashAssetPath
  }
}
$null = Write-WebMirrorJsonFile -Path $seaConfigPath -Value $seaConfig

foreach ($generatedPath in @($blobPath, $executablePath, $hashesPath)) {
  if (Test-Path -LiteralPath $generatedPath -PathType Leaf) {
    Remove-Item -LiteralPath $generatedPath -Force
  }
}

$null = Invoke-WebMirrorCommandCapture `
  -FilePath $nodePath `
  -ArgumentList @('--experimental-sea-config', $seaConfigPath) `
  -Label 'SEA blob generation'
$null = Get-WebMirrorExistingFile -Path $blobPath -Label 'SEA blob'

try {
  # Inject through a unique same-directory file so executable scanners cannot
  # lock the stable destination name between copy and postject.
  $null = Copy-WebMirrorFileAtomic `
    -Source $nodePath `
    -Destination $stagingExecutablePath
  $null = Invoke-WebMirrorCommandCapture `
    -FilePath $nodePath `
    -ArgumentList @(
      $postjectCliPath,
      $stagingExecutablePath,
      'NODE_SEA_BLOB',
      $blobPath,
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
    ) `
    -Label 'postject SEA injection'
  $null = Get-WebMirrorExistingFile `
    -Path $stagingExecutablePath `
    -Label 'Injected helper executable'
  Move-Item `
    -LiteralPath $stagingExecutablePath `
    -Destination $executablePath `
    -Force
} finally {
  if (Test-Path -LiteralPath $stagingExecutablePath -PathType Leaf) {
    Remove-Item -LiteralPath $stagingExecutablePath -Force
  }
}

$null = Get-WebMirrorExistingFile -Path $executablePath -Label 'Standalone helper executable'
$standaloneVersion = Invoke-WebMirrorCommandCapture `
  -FilePath $executablePath `
  -ArgumentList @('--version') `
  -Label 'Standalone helper smoke test'
if ($standaloneVersion -ne $helperVersion) {
  throw "Standalone helper version mismatch. Expected $helperVersion, got $standaloneVersion."
}

$executableHash = Get-WebMirrorSha256 -Path $executablePath
if ($executableHash -eq $nodeHash) {
  throw 'SEA executable hash is unchanged from node.exe; injection was not verified.'
}

$postjectTreeHash = Get-WebMirrorDirectoryTreeSha256 -Directory $postjectPackage.Root
$runtimeTreeHash = Get-WebMirrorDirectoryTreeSha256 -Directory $runtimeNodeModules
$browserTreeHash = Get-WebMirrorBundledBrowserTreeSha256 -Directory $bundledBrowserDirectory
$signature = Get-WebMirrorSignatureRecord -Path $executablePath
$artifactState = if ($signature.status -eq 'Valid') { 'signed' } else { 'unsigned' }

$hashManifest = [ordered]@{
  schemaVersion = 1
  generatedAtUtc = [System.DateTime]::UtcNow.ToString('o')
  artifactState = $artifactState
  helperVersion = $helperVersion
  sources = [ordered]@{
    helperJavaScript = [ordered]@{
      path = $helperPath
      bytes = (Get-Item -LiteralPath $helperPath).Length
      sha256 = $helperHash
    }
    seaLoader = [ordered]@{
      path = $loaderPath
      bytes = (Get-Item -LiteralPath $loaderPath).Length
      sha256 = $loaderHash
    }
  }
  tools = [ordered]@{
    node = [ordered]@{
      path = $nodePath
      version = $nodeVersion
      platform = $nodeDetails.platform
      arch = $nodeDetails.arch
      sha256 = $nodeHash
    }
    postject = [ordered]@{
      path = $postjectCliPath
      version = $postjectPackage.Version
      sha256 = $postjectHash
      packageRoot = $postjectPackage.Root
      packageTreeSha256 = $postjectTreeHash
    }
  }
  artifacts = @(
    (Get-WebMirrorFileRecord -Path $executablePath -RelativePath $script:WebMirrorExecutableFileName),
    (Get-WebMirrorFileRecord -Path $blobPath -RelativePath 'webmirror-helper.blob'),
    (Get-WebMirrorFileRecord -Path $seaConfigPath -RelativePath 'sea-config.json'),
    (Get-WebMirrorFileRecord -Path $helperHashAssetPath -RelativePath 'webmirror-helper.js.sha256')
  )
  runtime = [ordered]@{
    relativePath = 'node_modules'
    sha256 = $runtimeTreeHash
    packages = @(
      [ordered]@{
        name = 'playwright'
        version = (Read-WebMirrorJsonFile `
          -Path (Join-Path $playwrightPackageDirectory 'package.json') `
          -Label 'Playwright package.json').version
      },
      [ordered]@{
        name = 'playwright-core'
        version = (Read-WebMirrorJsonFile `
          -Path (Join-Path $playwrightCoreDirectory 'package.json') `
          -Label 'Playwright Core package.json').version
      }
    )
  }
  browser = [ordered]@{
    name = 'chromium-headless-shell'
    revision = $headlessShellRevision
    version = $headlessShellVersion
    relativePath = 'browsers/chromium-headless-shell'
    executableRelativePath = 'chrome-headless-shell-win64/chrome-headless-shell.exe'
    sha256 = $browserTreeHash
  }
  verification = [ordered]@{
    standaloneVersion = $standaloneVersion
    signature = $signature
  }
}
$null = Write-WebMirrorJsonFile -Path $hashesPath -Value $hashManifest -Depth 16

[pscustomobject]@{
  Executable = $executablePath
  HelperVersion = $standaloneVersion
  NodeVersion = $nodeVersion
  PostjectVersion = $postjectPackage.Version
  Sha256 = $executableHash
  SignatureStatus = $signature.status
  BrowserExecutable = $bundledBrowserExecutable
  HashManifest = $hashesPath
}
