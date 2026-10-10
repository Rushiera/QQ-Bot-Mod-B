# list-napcat.ps1 -- list processes that belong to the given NapCat shell directory.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File list-napcat.ps1 -ShellDir "D:\...\NapCat.52230.Shell"
# Output: JSON array of { ProcessId, Name } (empty array when nothing matches).
# NOTE: keep this file ASCII-only -- PowerShell 5.1 reads .ps1 as ANSI on Chinese Windows.

param(
    [Parameter(Mandatory = $true)][string]$ShellDir
)

$procs = Get-CimInstance Win32_Process -Filter "Name='QQ.exe' or Name='NapCatWinBootMain.exe'" |
    Where-Object { $_.CommandLine -like "*$ShellDir*" } |
    Select-Object ProcessId, Name

if ($null -eq $procs) {
    Write-Output '[]'
    exit 0
}

$procs | ConvertTo-Json -Compress
