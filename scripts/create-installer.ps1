# create-installer.ps1
# Runs electron-builder to produce the installer (exe).
# This is the ONLY build stage that needs code-signing secrets.
#
# Expects the frontend to be built and python-embed to be ready.
# See local-build.ps1 for the convenience wrapper that runs all stages.

param(
    [switch]$Unpack,
    [string]$Publish = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ReleaseDir = Join-Path $ProjectDir "release"
$BackendDir = Join-Path $ProjectDir "backend"
$HashFile = Join-Path $ProjectDir "python-deps-hash.txt"
$EmbeddedHashFile = Join-Path $ProjectDir "python-embed\deps-hash.txt"
$PackageJsonPath = Join-Path $ProjectDir "package.json"

Set-Location $ProjectDir

if (-not $env:LTX_RELEASE_OWNER -or -not $env:LTX_RELEASE_REPO) {
    try {
        $PackageJson = Get-Content $PackageJsonPath -Raw | ConvertFrom-Json
        $Homepage = [string]$PackageJson.homepage
        if ($Homepage) {
            $Uri = [System.Uri]$Homepage
            if ($Uri.Host -match "github\.com$") {
                $Segments = $Uri.AbsolutePath.Trim('/').Split('/')
                if ($Segments.Length -ge 2) {
                    if (-not $env:LTX_RELEASE_OWNER) { $env:LTX_RELEASE_OWNER = $Segments[0] }
                    if (-not $env:LTX_RELEASE_REPO) { $env:LTX_RELEASE_REPO = $Segments[1] }
                }
            }
        }
    } catch {
        Write-Host "Warning: could not infer release owner/repo from package.json homepage." -ForegroundColor Yellow
    }
}

if (-not $env:LTX_RELEASE_OWNER) { $env:LTX_RELEASE_OWNER = "Lightricks" }
if (-not $env:LTX_RELEASE_REPO) { $env:LTX_RELEASE_REPO = "ltx-desktop" }
Write-Host "Release source: $($env:LTX_RELEASE_OWNER)/$($env:LTX_RELEASE_REPO)" -ForegroundColor DarkGray

# Verify prerequisites
if (-not (Test-Path "dist") -or -not (Test-Path "dist-electron")) {
    Write-Host "ERROR: Frontend not built. Run local-build.ps1 or 'npm run build:frontend' first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "python-embed")) {
    Write-Host "ERROR: Python environment not found. Run local-build.ps1 or prepare-python.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host "Generating python dependency hash..." -ForegroundColor Yellow
$PythonVersion = (Get-Content (Join-Path $BackendDir ".python-version") -Raw).Trim()
$LockHash = (Get-FileHash (Join-Path $BackendDir "uv.lock") -Algorithm SHA256).Hash.ToLowerInvariant()
$HashMaterial = @(
    "platform=win32-x64"
    "python-version=$PythonVersion"
    "uv-lock=$LockHash"
) -join "`n"
$HashBytes = [System.Text.Encoding]::UTF8.GetBytes($HashMaterial)
$Hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $HashDigest = $Hasher.ComputeHash($HashBytes)
    if ([Convert].GetMethod("ToHexString", [type[]]@([byte[]])) -ne $null) {
        $DepsHash = [Convert]::ToHexString($HashDigest).ToLowerInvariant()
    } else {
        $DepsHash = ([System.BitConverter]::ToString($HashDigest) -replace "-", "").ToLowerInvariant()
    }
} finally {
    $Hasher.Dispose()
}
Set-Content -Path $HashFile -Value $DepsHash -NoNewline
Set-Content -Path $EmbeddedHashFile -Value $DepsHash -NoNewline
Write-Host "Python deps hash: $DepsHash" -ForegroundColor DarkGray

# Build with electron-builder
if ($Unpack) {
    Write-Host "Packaging unpacked app (fast mode)..." -ForegroundColor Yellow
    pnpm exec electron-builder --win --dir
} else {
    Write-Host "Packaging installer..." -ForegroundColor Yellow
    $PublishArgs = @()
    if ($Publish -ne "") {
        $PublishArgs = @("--publish", $Publish)
    }
    pnpm exec electron-builder --win @PublishArgs
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to build!" -ForegroundColor Red
    exit 1
}

# Summary
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

if ($Unpack) {
    $UnpackedDir = Join-Path $ReleaseDir "win-unpacked"
    $ExePath = Join-Path $UnpackedDir "LTX Desktop.exe"
    Write-Host "`nUnpacked app ready!" -ForegroundColor Cyan
    Write-Host "Run: $ExePath" -ForegroundColor Cyan
    Write-Host "`nTip: Just restart the app after code changes - no rebuild needed!" -ForegroundColor Green
} else {
    $Installer = Get-ChildItem -Path $ReleaseDir -Filter "*.exe" | Where-Object { $_.Name -like "*Setup*" } | Select-Object -First 1
    if ($Installer) {
        $InstallerSize = [math]::Round($Installer.Length / 1MB, 2)
        Write-Host "`nInstaller: $($Installer.Name)" -ForegroundColor Cyan
        Write-Host "Size: $InstallerSize MB" -ForegroundColor Cyan
        Write-Host "Location: $($Installer.FullName)" -ForegroundColor Cyan
    }
}

Write-Host "`nNote: AI models (~150GB) will be downloaded on first run." -ForegroundColor Yellow
