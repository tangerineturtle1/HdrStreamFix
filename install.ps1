# HdrStreamFix installer for Vesktop (Windows)
#
# Right-click > "Run with PowerShell", or:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Options:
#   -VencordDir C:\path\to\Vencord   use this Vencord source folder (default: the one Vesktop already uses, else ~\Vencord)
#   -NoRestart                       don't restart Vesktop at the end

param([string]$VencordDir = "", [switch]$NoRestart)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginSrc = Join-Path $here 'hdrStreamFix.desktop'
$vesktopData = Join-Path $env:APPDATA 'vesktop'
$stateFile = Join-Path $vesktopData 'state.json'
$vencordSettings = Join-Path $vesktopData 'settings\settings.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM: Vesktop's JSON parser chokes on one

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Read-Json($path) { if (Test-Path $path) { [IO.File]::ReadAllText($path) | ConvertFrom-Json } else { New-Object psobject } }
function Write-Json($path, $obj) {
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 100), $utf8)
}
function Set-Prop($obj, $name, $value) {
    if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function Run($exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

# Files from a downloaded zip are marked as "from the internet"; unblock ours so they run quietly.
Get-ChildItem $here -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

if (-not (Test-Path $pluginSrc)) { throw "Can't find hdrStreamFix.desktop next to this script. Unzip the whole zip first." }

# Vesktop is required: the regular Discord app captures streams in native code a plugin can't reach.
$vesktopCandidates = @("$env:LOCALAPPDATA\vesktop\Vesktop.exe", "$env:LOCALAPPDATA\Programs\vesktop\Vesktop.exe", "$env:ProgramFiles\Vesktop\Vesktop.exe")
$vesktopInstalled = ($vesktopCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1) -or (Get-Process -Name 'vesktop' -ErrorAction SilentlyContinue)
if (-not $vesktopInstalled) {
    Write-Host "`nVesktop isn't installed. HdrStreamFix only works in Vesktop (not the regular Discord app)." -ForegroundColor Yellow
    Write-Host 'Install it from https://vesktop.dev, open it once and log in, then run this installer again.' -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------- 1. tools
Step 1 'Checking Git, Node.js and pnpm'
if (-not (Have git)) {
    Warn 'Git not found, installing with winget...'
    Run winget @('install', '--id', 'Git.Git', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'); Refresh-Path
}
if (-not (Have node)) {
    Warn 'Node.js not found, installing LTS with winget...'
    Run winget @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'); Refresh-Path
}
if (-not (Have pnpm)) {
    Warn 'pnpm not found, installing with npm...'
    Run npm @('install', '-g', 'pnpm'); Refresh-Path
}
foreach ($t in 'git', 'node', 'pnpm') { if (-not (Have $t)) { throw "$t still not found. Open a new PowerShell window and run the installer again." } }
Ok "git $((git --version) -replace 'git version ','') | node $(node --version) | pnpm $(pnpm --version)"

# ---------------------------------------------------------------- 2. Vencord source
Step 2 'Finding your Vencord source'
$state = Read-Json $stateFile
if (-not $VencordDir -and $state.vencordDir) {
    $candidate = Split-Path $state.vencordDir   # state points at <source>\dist
    if (Test-Path (Join-Path $candidate 'package.json')) { $VencordDir = $candidate; Ok "Using the source Vesktop already loads: $VencordDir" }
}
if (-not $VencordDir) { $VencordDir = Join-Path $HOME 'Vencord' }
if (-not (Test-Path (Join-Path $VencordDir 'package.json'))) {
    if ((Test-Path $VencordDir) -and (Get-ChildItem $VencordDir -Force | Select-Object -First 1)) { throw "$VencordDir exists but isn't a Vencord source folder. Pass -VencordDir with the right path." }
    Warn "Cloning Vencord into $VencordDir..."
    Run git @('clone', '--depth', '1', 'https://github.com/Vendicated/Vencord.git', $VencordDir)
}
Ok $VencordDir

# ---------------------------------------------------------------- 3. copy plugin
Step 3 'Copying the plugin'
$userplugins = Join-Path $VencordDir 'src\userplugins'
$dest = Join-Path $userplugins 'hdrStreamFix.desktop'
New-Item -ItemType Directory -Force -Path $userplugins | Out-Null
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Copy-Item -Recurse $pluginSrc $dest
Ok $dest

# ---------------------------------------------------------------- 4. build
Step 4 'Building Vencord (first time takes a few minutes)'
Push-Location $VencordDir
try {
    try { Run pnpm @('install', '--frozen-lockfile') }
    catch { Warn 'Lockfile install failed, retrying without --frozen-lockfile...'; Run pnpm @('install') }
    Run pnpm @('build')
} finally { Pop-Location }
$dist = Join-Path $VencordDir 'dist'
if (-not (Test-Path (Join-Path $dist 'vencordDesktopMain.js'))) { throw "Build finished but $dist\vencordDesktopMain.js is missing." }
Ok "Built $dist"

# ---------------------------------------------------------------- 5. configure Vesktop
Step 5 'Pointing Vesktop at your build and enabling HdrStreamFix'
$vesktop = Get-Process -Name 'vesktop' -ErrorAction SilentlyContinue
$vesktopExe = ($vesktop | Where-Object { $_.Path } | Select-Object -First 1).Path
if ($vesktop) {
    Warn 'Closing Vesktop so it does not overwrite the settings...'
    $vesktop | Stop-Process -Force
    Start-Sleep -Seconds 2
}

$state = Read-Json $stateFile
Set-Prop $state 'vencordDir' $dist
Write-Json $stateFile $state

$vs = Read-Json $vencordSettings
if (-not $vs.PSObject.Properties['plugins']) { Set-Prop $vs 'plugins' (New-Object psobject) }
if (-not $vs.plugins.PSObject.Properties['HdrStreamFix']) { Set-Prop $vs.plugins 'HdrStreamFix' (New-Object psobject) }
Set-Prop $vs.plugins.HdrStreamFix 'enabled' $true
Write-Json $vencordSettings $vs
Ok 'Vesktop > Developer Options > Vencord Location now points at your build; HdrStreamFix enabled'

# ---------------------------------------------------------------- 6. restart
Step 6 'Starting Vesktop'
if ($NoRestart) { Warn 'Skipped. Start Vesktop yourself.' }
else {
    if (-not $vesktopExe) {
        $vesktopExe = $vesktopCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if ($vesktopExe) { Start-Process $vesktopExe; Ok 'Started' } else { Warn "Couldn't find Vesktop.exe. Start it yourself." }
}

Write-Host "`nDone! Share a screen or window in Discord and viewers get the tone-mapped HDR picture." -ForegroundColor Green
Write-Host 'Tweak it in Settings > Vencord > Plugins > HdrStreamFix. Turn on "debug" to see what it does.' -ForegroundColor Green
Write-Host 'To update later: unzip the new version and run install.bat again.' -ForegroundColor Green
Write-Host 'Note: Vesktop''s "Repair Vencord" / "Force Update Vencord" replace your build and remove the plugin. If that happens, run install.bat again.' -ForegroundColor Yellow
