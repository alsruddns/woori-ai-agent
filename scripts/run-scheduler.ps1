$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
& $pnpm agent scheduler daemon
exit $LASTEXITCODE
