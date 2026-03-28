# start-dev.ps1 - starts tunnel + server together with auto-reconnect
# Usage: .\start-dev.ps1  |  Stop with Ctrl+C

$envFile = Join-Path $PSScriptRoot '.env'
$tmpLog  = Join-Path $env:TEMP 'lhr-tunnel.log'

function Update-EnvUrl($url) {
    if (-not (Test-Path $envFile)) { return }
    $c = Get-Content $envFile
    if ($c -match 'PUBLIC_URL=') { $c = $c -replace 'PUBLIC_URL=.*', "PUBLIC_URL=$url" }
    else { $c += "`nPUBLIC_URL=$url" }
    $c | Set-Content $envFile
}

Write-Host "Stopping existing node processes..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

$nodeProc = $null

while ($true) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Starting tunnel..." -ForegroundColor Cyan
    '' | Set-Content $tmpLog

    $sshJob = Start-Job -ScriptBlock {
        param($log)
        ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -R 80:localhost:8080 nokey@localhost.run 2>&1 | Tee-Object -FilePath $log
    } -ArgumentList $tmpLog

    $tunnelUrl = $null
    $deadline  = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
        Start-Sleep -Milliseconds 400
        $raw = Get-Content $tmpLog -Raw -ErrorAction SilentlyContinue
        if ($raw -match '([\w\d]+\.lhr\.life)') { $tunnelUrl = "https://$($Matches[1])" }
    }

    if (-not $tunnelUrl) {
        Write-Host "ERROR: Tunnel URL not received - retrying in 5s..." -ForegroundColor Red
        Stop-Job $sshJob -ErrorAction SilentlyContinue
        Remove-Job $sshJob -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
        continue
    }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Tunnel live: $tunnelUrl" -ForegroundColor Green
    Update-EnvUrl $tunnelUrl

    if ($nodeProc -and -not $nodeProc.HasExited) {
        Write-Host "Restarting server with new URL..." -ForegroundColor Yellow
        $nodeProc.Kill(); $nodeProc.WaitForExit(3000) | Out-Null
    }

    $nodePsi = [System.Diagnostics.ProcessStartInfo]::new('node')
    $nodePsi.Arguments        = 'src/index.js'
    $nodePsi.WorkingDirectory = $PSScriptRoot
    $nodePsi.UseShellExecute  = $true
    $nodeProc = [System.Diagnostics.Process]::Start($nodePsi)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Server pid=$($nodeProc.Id) running. Ctrl+C to stop." -ForegroundColor Green

    Wait-Job $sshJob | Out-Null
    Remove-Job $sshJob -ErrorAction SilentlyContinue
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Tunnel disconnected - reconnecting in 2s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
}
