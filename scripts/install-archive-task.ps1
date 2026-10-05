# Registers a daily Windows Task Scheduler task that runs Agent's archive (scripts/archive.ts) as the current
# user, so Claude Code / Codex history is kept after the providers clean up their files. Local only.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-archive-task.ps1            # daily at 03:17
#   powershell -ExecutionPolicy Bypass -File scripts\install-archive-task.ps1 -Raw       # also gzip-copy transcripts
#   powershell -ExecutionPolicy Bypass -File scripts\install-archive-task.ps1 -Time 02:30
#   powershell -ExecutionPolicy Bypass -File scripts\install-archive-task.ps1 -Uninstall
#
# No admin rights needed. Agent never runs this script itself.
param(
  [string]$Time = '03:17',
  [string]$TaskName = 'Agent daily archive',
  [switch]$Raw,
  [switch]$Uninstall,
  [switch]$SkipCompile
)
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName' (if it existed)."
  exit 0
}

if ($Time -notmatch '^\d{2}:\d{2}$') { throw "Time must be HH:MM, got '$Time'." }

$checkout = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (-not [System.IO.Path]::IsPathRooted($node)) { throw "node was not found as an absolute path: $node" }

if (-not $SkipCompile) {
  Write-Host "Compiling out-test in $checkout ..."
  Push-Location $checkout
  try { & npm run -s compile-tests; if ($LASTEXITCODE -ne 0) { throw 'npm run compile-tests failed.' } } finally { Pop-Location }
}
$script = Join-Path $checkout 'out-test\scripts\archive.js'
if (-not (Test-Path $script)) { throw "Missing $script (run npm run compile-tests in the checkout)." }

$logDir = Join-Path $env:USERPROFILE '.agent\archive'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'last-run.log'

$nodeArgs = "`"$script`""
if ($Raw) { $nodeArgs += ' --raw' }
# cmd /c only to redirect the output to a log file next to the archive.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" $nodeArgs > `"$log`" 2>&1`"" -WorkingDirectory $checkout
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Agent (agent-vscode): daily local archive of Claude Code / Codex history. Reads provider files, writes ~/.agent/archive only.' -Force | Out-Null

Write-Host "Registered '$TaskName': daily at $Time, runs $node $nodeArgs"
Write-Host "Log: $log"
Write-Host "Check: schtasks /Query /TN `"$TaskName`"   Run now: schtasks /Run /TN `"$TaskName`"   Remove: this script with -Uninstall"
