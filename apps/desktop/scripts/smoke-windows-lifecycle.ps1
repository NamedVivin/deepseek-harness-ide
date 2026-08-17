# Exercise Squirrel lifecycle-only events, install/upgrade/uninstall, portable launch, and external-state retention.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Report,

  [Parameter(Mandatory = $true)]
  [ValidateSet('unsigned', 'signed')]
  [string]$SignaturePolicy,

  [string]$BaselineSetup = ''
)

$ErrorActionPreference = 'Stop'
$reportObject = Get-Content -LiteralPath $Report -Raw | ConvertFrom-Json
$setup = [string]$reportObject.artifacts.setup
$archive = [string]$reportObject.artifacts.archive
if ($SignaturePolicy -eq 'signed' -and [string]::IsNullOrWhiteSpace($BaselineSetup)) {
  throw 'desktop release: signed Windows candidates require a prior signed Setup.exe for the upgrade smoke'
}

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-desktop-lifecycle-" + [Guid]::NewGuid().ToString('N'))
$localAppData = Join-Path $temporary 'local-app-data'
$roamingAppData = Join-Path $temporary 'roaming-app-data'
$dshHome = Join-Path $temporary 'dsh-home'
$workspace = Join-Path $temporary 'workspace'
$logs = Join-Path $temporary 'logs'
$portableRoot = Join-Path $temporary 'portable'
$owned = [System.Collections.Generic.HashSet[int]]::new()

function Get-DescendantProcessIds {
  param([Parameter(Mandatory = $true)][int]$ParentId)

  $result = [System.Collections.Generic.List[int]]::new()
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId")) {
    $result.Add([int]$child.ProcessId)
    foreach ($descendant in Get-DescendantProcessIds -ParentId ([int]$child.ProcessId)) {
      $result.Add($descendant)
    }
  }
  return $result.ToArray()
}

function Stop-OwnedProcesses {
  $processIds = @($owned)
  foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  [void](Wait-OwnedExit -ProcessIds $processIds)
}

function Wait-Guardian {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Main)

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($Main.HasExited) { return $false }
    $guardian = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Main.Id)" | Where-Object {
      $_.CommandLine -match 'lib[\\/]guardian\.js'
    }
    if ($null -ne $guardian) { return $true }
    Start-Sleep -Milliseconds 500
    $Main.Refresh()
  }
  return $false
}

function Wait-OwnedExit {
  param([int[]]$ProcessIds)

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $live = @($ProcessIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($live.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-SuccessfulProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Label
  )

  [void]$owned.Add($Process.Id)
  if (-not $Process.WaitForExit(120000)) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw "desktop release: $Label did not exit within 120 seconds"
  }
  $Process.WaitForExit()
  [void]$owned.Remove($Process.Id)
  if ($Process.ExitCode -ne 0) { throw "desktop release: $Label failed with $($Process.ExitCode)" }
}

function Start-AppSmoke {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$Force
  )

  $stdout = Join-Path $logs "$Label.stdout.log"
  $stderr = Join-Path $logs "$Label.stderr.log"
  $main = Start-Process -FilePath $Executable -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  [void]$owned.Add($main.Id)
  if (-not (Wait-Guardian -Main $main)) {
    Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue | ForEach-Object { [Console]::Error.WriteLine($_) }
    Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | ForEach-Object { [Console]::Error.WriteLine($_) }
    throw "desktop release: $Label did not reach guardian startup"
  }
  for ($attempt = 0; $attempt -lt 60 -and $main.MainWindowHandle -eq 0; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    $main.Refresh()
  }
  if ($main.MainWindowHandle -eq 0) { throw "desktop release: $Label did not expose a main window" }
  $processIds = @($main.Id) + @(Get-DescendantProcessIds -ParentId $main.Id)
  foreach ($processId in $processIds) { [void]$owned.Add($processId) }
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
    $_.OwningProcess -in $processIds
  })
  if ($listeners.Count -ne 0) { throw "desktop release: $Label opened a TCP listener" }

  if ($Force) {
    Stop-Process -Id $main.Id -Force
  } else {
    if (-not $main.CloseMainWindow()) {
      throw "desktop release: $Label did not expose a closeable main window"
    }
  }
  if (-not (Wait-OwnedExit -ProcessIds $processIds)) {
    throw "desktop release: $Label left an owned process alive"
  }
  foreach ($processId in $processIds) { [void]$owned.Remove($processId) }
}

function Invoke-Setup {
  param([Parameter(Mandatory = $true)][string]$Path)

  $installer = Start-Process -FilePath $Path -ArgumentList '--silent' -PassThru
  Wait-SuccessfulProcess -Process $installer -Label 'Squirrel Setup'
  foreach ($process in @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like "$localAppData\deepseek_harness_ide\app-*\*"
  })) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Get-InstalledApplication {
  $installRoot = Join-Path $localAppData 'deepseek_harness_ide'
  $versions = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'app-*' | Sort-Object {
    [System.Management.Automation.SemanticVersion]::Parse($_.Name.Substring(4))
  })
  if ($versions.Count -eq 0) { throw 'desktop release: Squirrel did not create an app-version directory' }
  return $versions[-1]
}

function Invoke-LifecycleOnly {
  param([Parameter(Mandatory = $true)][string]$Executable)

  foreach ($event in @('install', 'updated', 'uninstall', 'obsolete')) {
    $before = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'lib[\\/]guardian\.js' }).ProcessId
    $observedGuardians = [System.Collections.Generic.HashSet[int]]::new()
    $process = Start-Process -FilePath $Executable -ArgumentList "--squirrel-$event", '0.1.0' -PassThru
    [void]$owned.Add($process.Id)
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      foreach ($guardianId in @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -match 'lib[\\/]guardian\.js' -and $_.ProcessId -notin $before
      }).ProcessId) {
        [void]$observedGuardians.Add([int]$guardianId)
        [void]$owned.Add([int]$guardianId)
      }
      Start-Sleep -Milliseconds 50
      $process.Refresh()
    }
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "desktop release: --squirrel-$event did not exit within 60 seconds"
    }
    $process.WaitForExit()
    [void]$owned.Remove($process.Id)
    foreach ($guardianId in @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -match 'lib[\\/]guardian\.js' -and $_.ProcessId -notin $before
    }).ProcessId) {
      [void]$observedGuardians.Add([int]$guardianId)
      [void]$owned.Add([int]$guardianId)
    }
    if ($process.ExitCode -ne 0) { throw "desktop release: --squirrel-$event failed with $($process.ExitCode)" }
    if ($observedGuardians.Count -ne 0) { throw "desktop release: --squirrel-$event started the Host guardian" }
  }
}

try {
  New-Item -ItemType Directory -Path $localAppData, $roamingAppData, $dshHome, $workspace, $logs, $portableRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $dshHome 'release-smoke-sentinel') -Value 'persistent-state' -NoNewline
  Set-Content -LiteralPath (Join-Path $workspace 'user-file.txt') -Value 'workspace-state' -NoNewline
  Set-Content -LiteralPath (Join-Path $roamingAppData 'release-smoke-sentinel') -Value 'electron-state' -NoNewline
  $env:LOCALAPPDATA = $localAppData
  $env:APPDATA = $roamingAppData
  $env:DSH_HOME = $dshHome
  $env:DSH_TELEMETRY_DISABLED = '1'
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $env:HTTP_PROXY = 'http://127.0.0.1:9'
  $env:HTTPS_PROXY = 'http://127.0.0.1:9'
  $env:ALL_PROXY = 'http://127.0.0.1:9'
  $env:NO_PROXY = ''

  Expand-Archive -LiteralPath $archive -DestinationPath $portableRoot
  $portableApp = Get-ChildItem -LiteralPath $portableRoot -Directory -Filter 'DeepSeek Harness IDE-win32-x64'
  if (@($portableApp).Count -ne 1) { throw 'desktop release: portable ZIP layout is not unique' }
  Start-AppSmoke -Executable (Join-Path $portableApp.FullName 'deepseek-harness-ide.exe') -Label 'portable-start'

  if (-not [string]::IsNullOrWhiteSpace($BaselineSetup)) {
    if ($SignaturePolicy -eq 'signed') {
      $baselineSignature = Get-AuthenticodeSignature -LiteralPath $BaselineSetup
      $currentSignature = Get-AuthenticodeSignature -LiteralPath $setup
      if ($baselineSignature.Status -ne 'Valid' -or $null -eq $baselineSignature.TimeStamperCertificate) {
        throw 'desktop release: upgrade baseline is not validly signed and timestamped'
      }
      if ($currentSignature.Status -ne 'Valid' -or $null -eq $currentSignature.TimeStamperCertificate) {
        throw 'desktop release: current Setup is not validly signed and timestamped'
      }
      if ($baselineSignature.SignerCertificate.Thumbprint -ne $currentSignature.SignerCertificate.Thumbprint) {
        throw 'desktop release: upgrade baseline and current Setup have different signing identities'
      }
    }
    Invoke-Setup -Path $BaselineSetup
    $baselineVersion = (Get-InstalledApplication).Name
    Invoke-Setup -Path $setup
    $currentVersion = (Get-InstalledApplication).Name
    if ($SignaturePolicy -eq 'signed') {
      $baselineSemanticVersion = [System.Management.Automation.SemanticVersion]::Parse($baselineVersion.Substring(4))
      $currentSemanticVersion = [System.Management.Automation.SemanticVersion]::Parse($currentVersion.Substring(4))
      if ($baselineSemanticVersion -ge $currentSemanticVersion) {
        throw "desktop release: signed upgrade requires a lower-version baseline ($baselineSemanticVersion -> $currentSemanticVersion)"
      }
    }
  } else {
    Invoke-Setup -Path $setup
    Invoke-Setup -Path $setup
  }

  $installed = Get-InstalledApplication
  $installedExecutable = Join-Path $installed.FullName 'deepseek-harness-ide.exe'
  Invoke-LifecycleOnly -Executable $installedExecutable
  Start-AppSmoke -Executable $installedExecutable -Label 'installed-start'
  Start-AppSmoke -Executable $installedExecutable -Label 'installed-forced-stop' -Force

  $update = Join-Path $localAppData 'deepseek_harness_ide\Update.exe'
  if (-not (Test-Path -LiteralPath $update -PathType Leaf)) { throw 'desktop release: Squirrel Update.exe is missing' }
  $uninstaller = Start-Process -FilePath $update -ArgumentList '--uninstall', '-s' -PassThru
  Wait-SuccessfulProcess -Process $uninstaller -Label 'Squirrel uninstall'
  $remainingApplications = @(
    Get-ChildItem -LiteralPath (Split-Path -Parent $update) -Directory -Filter 'app-*' -ErrorAction SilentlyContinue
  )
  if ($remainingApplications.Count -ne 0) { throw 'desktop release: Squirrel uninstall left an application version installed' }

  if ((Get-Content -LiteralPath (Join-Path $dshHome 'release-smoke-sentinel') -Raw) -ne 'persistent-state') {
    throw 'desktop release: Squirrel lifecycle changed DSH_HOME state'
  }
  if ((Get-Content -LiteralPath (Join-Path $workspace 'user-file.txt') -Raw) -ne 'workspace-state') {
    throw 'desktop release: Squirrel lifecycle changed workspace data'
  }
  if ((Get-Content -LiteralPath (Join-Path $roamingAppData 'release-smoke-sentinel') -Raw) -ne 'electron-state') {
    throw 'desktop release: Squirrel lifecycle changed Electron user data'
  }
} finally {
  Stop-OwnedProcesses
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
