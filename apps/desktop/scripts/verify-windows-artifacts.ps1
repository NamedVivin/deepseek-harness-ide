# Verify the native Windows Forge payload, archive, Authenticode timestamps, and Squirrel outputs.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Report,

  [Parameter(Mandatory = $true)]
  [ValidateSet('unsigned', 'signed')]
  [string]$SignaturePolicy
)

$ErrorActionPreference = 'Stop'
$reportObject = Get-Content -LiteralPath $Report -Raw | ConvertFrom-Json
$target = $reportObject.artifacts.target
if ($target.id -ne 'windows-x64' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw "desktop release: windows-x64 verification requires a native AMD64 runner"
}

function Assert-ValidSignature {
  param([Parameter(Mandatory = $true)][string]$Path)

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid') {
    throw "desktop release: invalid Authenticode signature ($($signature.Status)): $Path"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "desktop release: Authenticode signature has no timestamp: $Path"
  }
}

function Assert-Payload {
  param([Parameter(Mandatory = $true)][string]$Application)

  $required = @(
    (Join-Path $Application 'deepseek-harness-ide.exe'),
    (Join-Path $Application 'resources\app.asar'),
    (Join-Path $Application 'resources\desktop-resources\runtime\node.exe'),
    (Join-Path $Application 'resources\desktop-resources\runtime\LICENSE'),
    (Join-Path $Application 'resources\desktop-resources\LICENSE'),
    (Join-Path $Application 'resources\desktop-resources\THIRD_PARTY_NOTICES.md'),
    (Join-Path $Application 'resources\desktop-resources\legal\electron\LICENSE'),
    (Join-Path $Application 'resources\desktop-resources\legal\electron\LICENSES.chromium.html'),
    (Join-Path $Application 'resources\desktop-resources\host\node_modules\@vscode\ripgrep\LICENSE'),
    (Join-Path $Application 'resources\desktop-resources\host\node_modules\@vscode\ripgrep-win32-x64\LICENSE'),
    (Join-Path $Application 'resources\desktop-resources\host\node_modules\koffi\LICENSE.txt'),
    (Join-Path $Application 'resources\desktop-resources\host\lib\sidecar.js'),
    (Join-Path $Application 'resources\desktop-resources\host\lib\guardian.js'),
    (Join-Path $Application 'resources\desktop-resources\assets\shell\index.html')
  )
  foreach ($path in $required) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "desktop release: packaged Windows payload is missing $path"
    }
    if ((Get-Item -LiteralPath $path).Length -eq 0) {
      throw "desktop release: packaged Windows payload contains an empty file: $path"
    }
  }

  $notice = [IO.File]::ReadAllText((Join-Path $Application 'resources\desktop-resources\THIRD_PARTY_NOTICES.md'))
  foreach ($term in @('Electron 43.2.0', 'v24.16.0', 'LICENSES.chromium.html', '@vscode/ripgrep', 'koffi', 'dsh-process-capsule')) {
    if (-not $notice.Contains($term, [StringComparison]::Ordinal)) {
      throw "desktop release: packaged notices omit $term"
    }
  }

  $node = Join-Path $Application 'resources\desktop-resources\runtime\node.exe'
  $identity = & $node -p 'JSON.stringify([process.version,process.platform,process.arch])'
  if ($LASTEXITCODE -ne 0 -or $identity -ne '["v24.16.0","win32","x64"]') {
    throw "desktop release: portable ZIP carries the wrong Node.js runtime: $identity"
  }

  if ($SignaturePolicy -eq 'signed') {
    $signedPayloads = @(Get-ChildItem -LiteralPath $Application -Recurse -File | Where-Object {
      $_.Extension -in @('.exe', '.dll', '.node')
    })
    if ($signedPayloads.Count -eq 0) {
      throw 'desktop release: packaged Windows application has no signable payloads'
    }
    foreach ($payload in $signedPayloads) { Assert-ValidSignature -Path $payload.FullName }
  }
}

$application = [string]$reportObject.artifacts.application
$setup = [string]$reportObject.artifacts.setup
$archive = [string]$reportObject.artifacts.archive
$squirrelPackage = [string]$reportObject.artifacts.squirrelPackage
$releases = [string]$reportObject.artifacts.squirrelReleases
foreach ($path in @($application, $setup, $archive, $squirrelPackage, $releases)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "desktop release: missing Forge output $path" }
}

Assert-Payload -Application $application
if ($SignaturePolicy -eq 'signed') { Assert-ValidSignature -Path $setup }

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-desktop-verify-" + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $temporary | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $temporary
  $applications = @(Get-ChildItem -LiteralPath $temporary -Directory -Filter 'DeepSeek Harness IDE-win32-x64')
  if ($applications.Count -ne 1) {
    throw 'desktop release: portable ZIP must contain exactly one top-level application directory'
  }
  Assert-Payload -Application $applications[0].FullName
} finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Recurse -Force
  }
}
