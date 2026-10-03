<#
  Registers the nightly Spani run with Windows Task Scheduler.

  WHY 02:00 AND WHY ONE SUSTAINED RUN:
  Claude's prompt cache has a 1-hour TTL and a warm cache is roughly 7x
  cheaper than a cold one. Twenty applications inside one 40-minute run cost
  far less of the subscription's rate limit than twenty spread across a day.

  The task runs ONLY when you are logged in, because the agent drives a headed
  Chrome window in your desktop session. A locked screen is fine; a logged-off
  session is not.

  Usage:   powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
  Remove:  powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Remove
#>

param(
  [string]$Time = "02:00",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$TaskName = "Spani Nightly"
$Root     = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task named '$TaskName'."
  }
  return
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { throw "npm.cmd not found on PATH." }

$action = New-ScheduledTaskAction `
  -Execute $npm `
  -Argument "run spani -- nightly" `
  -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# Interactive token: the agent needs a desktop session for the headed browser.
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -MultipleInstances IgnoreNew `
  -RestartCount 0

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Spani: nightly application run. Headed Chrome, requires an interactive session." `
  -Force | Out-Null

Write-Host ""
Write-Host "  Registered '$TaskName' for $Time daily."
Write-Host "  Working directory: $Root"
Write-Host ""
Write-Host "  It runs only while you are logged in. Locking the screen is fine."
Write-Host "  Anything needing you queues up and appears in the dashboard:"
Write-Host "      npm run spani -- dashboard"
Write-Host ""
