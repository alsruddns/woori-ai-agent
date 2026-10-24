param([Parameter(Mandatory=$true)][ValidateSet('Start','Stop')][string]$Action,[switch]$Confirm)
$ErrorActionPreference = 'Stop'
if (-not $Confirm) { throw 'This starts or stops the opt-in current-user task. Re-run with -Confirm after reviewing scheduler policy.' }
$taskName = 'Woori AI Agent ReadOnly Scheduler'
if ($Action -eq 'Start') { Start-ScheduledTask -TaskName $taskName }
else { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object TaskName,LastRunTime,LastTaskResult,NextRunTime
