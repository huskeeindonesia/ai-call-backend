# start-dev.ps1 - starts tunnel + server with auto-reconnect on URL rotation
# Usage: .\start-dev.ps1  |  Stop with Ctrl+C
#
# localhost.run rotates the URL every ~10 minutes on anonymous connections.
# This script watches stdout from ssh, detects every new *.lhr.life URL,
# updates .env PUBLIC_URL, and restarts node so Twilio always gets the right URL.

$envFile = Join-Path $PSScriptRoot '.env'
$tmpLog  = Join-Path $env:TEMP "lhr-$PID.log"

function Update-EnvUrl($url) {
    $c = Get-Content $envFile
    if ($c -match 'PUBLIC_URL=') { $c = $c -replace 'PUBLIC_URL=.*', "PUBLIC_URL=$url" }
    else { $c += "`nPUBLIC_URL=$url" }
    $c | Set-Content $envFile
}

function Start-NodeServer {
    param($oldProc)
    if ($oldProc -and -not $oldProc.HasExited) {
        $oldProc.Kill()
        $oldProc.WaitForExit(3000) | Out-Null
    }
    $psi = [System.Diagnostics.ProcessStartInfo]::new('node')
    $psi.Arguments        = 'src/index.js'
    $psi.WorkingDirectory = $PSScriptRoot
    $psi.UseShellExecute  = $true
    return [System.Diagnostics.Process]::Start($psi)
}

Write-Host "Stopping existing node processes..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

$nodeProc   = $null
$lastUrl    = $null

while ($true) {
    Write-Host "`n[$(Get-Date -Format 'HH:mm:ss')] Starting ssh tunnel..." -ForegroundColor Cyan
    '' | Set-Content $tmpLog

    # Start ssh in a background job that tees all output to a log file
    $sshJob = Start-Job -ScriptBlock {
        param($log)
        ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
            -R 80:localhost:8080 nokey@localhost.run 2>&1 | Tee-Object -FilePath $log
    } -ArgumentList $tmpLog

    # Poll the log file. Every time we see a NEW lhr.life URL, update .env and restart node.
    $deadline = (Get-Date).AddSeconds(30)
    $gotFirst = $false

    while ((Get-Job -Id $sshJob.Id).State -eq 'Running') {
        Start-Sleep -Milliseconds 300

        $raw = Get-Content $tmpLog -Raw -ErrorAction SilentlyContinue
        if (-not $raw) { continue }

        # Find all lhr.life URLs in the log — take the LAST one (most recent rotation)
        $allUrls = [regex]::Matches($raw, '([\w\d]+\.lhr\.life)') | ForEach-Object { $_.Groups[1].Value }
        if (-not $allUrls) {
            if ((Get-Date) -gt $deadline) { break }
            continue
        }
        $newUrl = "https://$($allUrls[-1])"

        if ($newUrl -ne $lastUrl) {
            $lastUrl = $newUrl
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] >>> Tunnel URL: $newUrl" -ForegroundColor Green
            Update-EnvUrl $newUrl
            $nodeProc = Start-NodeServer $nodeProc
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Server restarted (pid=$($nodeProc.Id))" -ForegroundColor Green
            $gotFirst = $true
            $deadline = (Get-Date).AddHours(1) # stop racing after first URL
        }
    }

    Stop-Job  $sshJob -ErrorAction SilentlyContinue
    Remove-Job $sshJob -ErrorAction SilentlyContinue
    Remove-Item $tmpLog -ErrorAction SilentlyContinue

    if (-not $gotFirst) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Tunnel failed to start — retrying in 3s..." -ForegroundColor Red
        Start-Sleep -Seconds 3
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Tunnel disconnected — reconnecting in 2s..." -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
}
