[CmdletBinding()]
param([int]$Port = 4318, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
$address = "http://127.0.0.1:$Port"

function Test-MakerService {
    try {
        $request = [System.Net.WebRequest]::Create("$address/api/health")
        $request.Proxy = $null
        $request.Timeout = 1500
        $response = $request.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            $health = $reader.ReadToEnd() | ConvertFrom-Json
            return ($health.ok -eq $true -and $health.execution -eq 'paper')
        } finally { $response.Close() }
    } catch { return $false }
}

if (Test-MakerService) {
    Write-Host "Maker console is already running: $address"
    if (-not $NoBrowser) { Start-Process $address }
    exit 0
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$runtimeVersion = [version]((& $nodeCommand.Source --version).TrimStart('v'))
if ($runtimeVersion -lt [version]'22.12.0') { throw 'Node.js 22.12 or later is required.' }

if (-not (Test-Path -LiteralPath 'node_modules')) {
    & $npmCommand.Source ci --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& $npmCommand.Source run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed. See the output above.' }

$logDirectory = Join-Path $projectDirectory 'work'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$previousPort = $env:PORT
try {
    $env:PORT = [string]$Port
    $entryScript = Join-Path $projectDirectory 'server\index.ts'
    $processArguments = @('--import', 'tsx', ('"' + $entryScript + '"'), '--production')
    $makerProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList $processArguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'server.out.log') -RedirectStandardError (Join-Path $logDirectory 'server.err.log')
    $makerProcess.Id | Set-Content -LiteralPath (Join-Path $logDirectory 'server.pid')
} finally { $env:PORT = $previousPort }

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-MakerService) {
        Write-Host "Maker console is ready: $address"
        Write-Host 'Paper trading only. No live exchange orders are sent.'
        if (-not $NoBrowser) { Start-Process $address }
        exit 0
    }
    if ($makerProcess.HasExited) { throw "Service exited. Check work/server.err.log." }
    Start-Sleep -Milliseconds 500
    $makerProcess.Refresh()
}
throw 'Startup timed out. Check work/server.err.log and port availability.'
