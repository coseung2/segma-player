param(
  [string]$LocalStatePath = "C:\Users\coseung2\AppData\Local\Google\Chrome\User Data\Local State",
  [string]$KeyOutputPath = "$env:TEMP\aura-cookie-key.txt"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$localState = Get-Content -LiteralPath $localStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$encryptedKey = [Convert]::FromBase64String($localState.os_crypt.encrypted_key)
if ($encryptedKey.Length -lt 5 -or [System.Text.Encoding]::ASCII.GetString($encryptedKey, 0, 5) -ne "DPAPI") {
  throw "unexpected encrypted_key prefix"
}
$keyBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $encryptedKey[5..($encryptedKey.Length - 1)],
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$hex = [System.BitConverter]::ToString($keyBytes).Replace("-", "").ToLowerInvariant()
[System.IO.File]::WriteAllText(
  $KeyOutputPath,
  $hex,
  (New-Object System.Text.UTF8Encoding($false))
)
Write-Output ("KEY_OK bytes=" + $keyBytes.Length)
