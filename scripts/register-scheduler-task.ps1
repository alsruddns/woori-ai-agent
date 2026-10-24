param([switch]$Confirm)
$ErrorActionPreference = 'Stop'
if (-not $Confirm) { throw 'This only registers a current-user logon task after explicit opt-in. Re-run with -Confirm after configuring the zero-cost policy in .env.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$null = Get-Command pnpm.cmd -ErrorAction Stop
$taskName = 'Woori AI Agent ReadOnly Scheduler'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-scheduler.ps1' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Opt-in local read-only woori-ai-agent scheduler. Codex, PR, merge and deployment remain disabled.' -Force | Out-Null
Write-Output "Registered disabled-policy-guarded task '$taskName'. WOORI_SCHEDULER_ENABLED=true and explicit zero-cost policy are still required by the process."
