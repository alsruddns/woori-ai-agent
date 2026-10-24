param([switch]$Confirm)
$ErrorActionPreference = 'Stop'
if (-not $Confirm) { throw 'Pass -Confirm to remove the current-user scheduler task.' }
Stop-ScheduledTask -TaskName 'Woori AI Agent ReadOnly Scheduler' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Woori AI Agent ReadOnly Scheduler' -Confirm:$false -ErrorAction SilentlyContinue
Write-Output 'Woori AI Agent scheduler task removed.'
