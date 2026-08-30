$ErrorActionPreference = 'SilentlyContinue'
Set-Location -Path $PSScriptRoot

$running = $false
try {
    Invoke-WebRequest -Uri 'http://localhost:5000' -UseBasicParsing -TimeoutSec 1 | Out-Null
    $running = $true
} catch {
    $running = $false
}

if (-not $running) {
    Start-Process -FilePath 'python' -ArgumentList 'app.py' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--app=http://localhost:5000'
