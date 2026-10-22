param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$CredentialJsonPath
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $CredentialJsonPath).Path
$json = Get-Content -LiteralPath $source -Raw -Encoding UTF8
$parsed = $json | ConvertFrom-Json
if (-not $parsed.client_email -or -not $parsed.private_key) {
  throw 'Expected a Google service account JSON with client_email and private_key.'
}
$secure = ConvertTo-SecureString -String $json -AsPlainText -Force
$encrypted = ConvertFrom-SecureString -SecureString $secure
$target = Join-Path (Split-Path $PSScriptRoot -Parent) 'data/google-credentials.dpapi'
New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
Set-Content -LiteralPath $target -Value $encrypted -Encoding ASCII
Write-Output "Encrypted for current Windows user: $target"
Write-Output 'Delete the source JSON yourself after confirming the encrypted credential works.'
