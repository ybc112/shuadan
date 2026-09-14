[CmdletBinding()]
param([int]$Port = 4318, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$address = "http://127.0.0.1:$Port"
$pidFile = Join-Path $projectDirectory 'work\server.pid'
$entryScript = Join-Path $projectDirectory 'server\index.ts'

function Invoke-ConsoleJson([string]$Route, [string]$Method = 'GET', [string]$Token = '') {
    $request = [System.Net.WebRequest]::Create("$address/api/$Route")
    $request.Proxy = $null
    $request.Timeout = 6000
    $request.Method = $Method
    if ($Method -eq 'POST') {
        $request.Headers['X-Console-Token'] = $Token
        $request.ContentType = 'application/json'
        $bodyBytes = [Text.Encoding]::UTF8.GetBytes('{}')
        $request.ContentLength = $bodyBytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bodyBytes, 0, $bodyBytes.Length) } finally { $stream.Close() }
    }
    $response = $request.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally { $response.Close() }
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $pidFile)) { throw 'Cannot identify the existing service: work/server.pid is missing. No process was stopped.' }
    $makerProcessId = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$makerProcessId) -or $makerProcessId -le 0) { throw 'Invalid service PID. No process was stopped.' }
    if (@($listeners | Where-Object { $_.OwningProcess -ne $makerProcessId }).Count -gt 0) { throw 'The port belongs to another process. No process was stopped.' }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$makerProcessId"
    $commandLine = [string]$processInfo.CommandLine
    $absoluteEntry = $commandLine.Replace('/', '\').IndexOf($entryScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    # Older launchers used a relative entry point. Require the project's data lock as additional ownership evidence.
    $lockFile = Join-Path $projectDirectory 'data\runtime.lock'
    $ownsLock = (Test-Path -LiteralPath $lockFile) -and ([IO.File]::ReadAllText($lockFile).Trim() -eq [string]$makerProcessId)
    $legacyEntry = $ownsLock -and $commandLine -match '(?:^|\s)"?server[/\\]index\.ts"?(?:\s|$)'
    if ($processInfo.Name -ne 'node.exe' -or -not ($absoluteEntry -or $legacyEntry)) { throw 'The process does not match this project. No process was stopped.' }
    $health = Invoke-ConsoleJson 'health'
    if ($health.execution -ne 'paper' -or $health.ok -ne $true) { throw 'The local paper service is not healthy. No process was stopped.' }
    $state = Invoke-ConsoleJson 'state'
    if ([string]::IsNullOrWhiteSpace($state.sessionToken)) { throw 'The local session could not be verified. No process was stopped.' }
    $pauseResult = Invoke-ConsoleJson 'pause-all' 'POST' $state.sessionToken
    if ($pauseResult.ok -ne $true) { throw 'Pause/save was not confirmed. No process was stopped.' }
    $pausedState = Invoke-ConsoleJson 'state'
    if (@($pausedState.orders).Count -gt 0 -or @($pausedState.robots | Where-Object { $_.status -ne 'paused' }).Count -gt 0) { throw 'Some simulated activity remains. No process was stopped.' }
    $currentInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$makerProcessId"
    if ($null -eq $currentInfo -or $currentInfo.CreationDate -ne $processInfo.CreationDate) { throw 'The process changed while checking it. No process was stopped.' }
    $makerProcess = Get-Process -Id $makerProcessId
    Stop-Process -Id $makerProcessId -ErrorAction Stop
    if (-not $makerProcess.WaitForExit(5000)) { throw 'The old service did not exit. The new service was not started.' }
    Write-Host 'Saved all simulated positions and settings; robots will remain paused.'
}

& (Join-Path $PSScriptRoot 'start.ps1') -Port $Port -NoBrowser:$NoBrowser
exit $LASTEXITCODE
