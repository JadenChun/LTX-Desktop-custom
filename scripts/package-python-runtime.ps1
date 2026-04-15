# package-python-runtime.ps1
# Builds the runtime archive assets consumed by installed Windows/Linux apps.

param(
    [string]$InputDir = "python-embed",
    [string]$OutputDir = "release\python-runtime",
    [string]$Prefix = "python-embed-win32",
    [int]$PartSizeMB = 1900
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$InputPath = Join-Path $ProjectDir $InputDir
$OutPath = Join-Path $ProjectDir $OutputDir
$HashPath = Join-Path $ProjectDir "python-deps-hash.txt"
$ArchiveName = "$Prefix.tar.gz"
$ArchivePath = Join-Path $OutPath $ArchiveName
$ManifestPath = Join-Path $OutPath "$Prefix.manifest.json"
$PartSizeBytes = $PartSizeMB * 1MB

function Get-PartSuffix([int]$Index) {
    $alphabet = "abcdefghijklmnopqrstuvwxyz"
    $base = $alphabet.Length
    $first = [math]::Floor($Index / $base)
    $second = $Index % $base
    return "$($alphabet[$first])$($alphabet[$second])"
}

if (-not (Test-Path $InputPath)) {
    throw "Python runtime folder not found: $InputPath"
}

if (-not (Test-Path $HashPath)) {
    throw "Missing python-deps-hash.txt at $HashPath. Build the installer first."
}

if (Test-Path $OutPath) {
    Remove-Item -Recurse -Force $OutPath
}
New-Item -ItemType Directory -Force -Path $OutPath | Out-Null

$InputParent = Split-Path -Parent $InputPath
$InputLeaf = Split-Path -Leaf $InputPath

Write-Host "Creating runtime archive: $ArchiveName" -ForegroundColor Yellow
tar -czf $ArchivePath -C $InputParent $InputLeaf
if ($LASTEXITCODE -ne 0) {
    throw "tar failed while creating $ArchiveName"
}

$archiveFile = Get-Item $ArchivePath
$parts = New-Object System.Collections.Generic.List[object]

$sourceStream = [System.IO.File]::OpenRead($ArchivePath)
try {
    $index = 0
    while ($sourceStream.Position -lt $sourceStream.Length) {
        $suffix = Get-PartSuffix $index
        $partName = "$ArchiveName.part-$suffix"
        $partPath = Join-Path $OutPath $partName

        $targetStream = [System.IO.File]::Create($partPath)
        try {
            $remaining = [math]::Min($PartSizeBytes, $sourceStream.Length - $sourceStream.Position)
            $buffer = New-Object byte[] 1048576
            $written = 0L
            while ($written -lt $remaining) {
                $toRead = [int][math]::Min($buffer.Length, $remaining - $written)
                $read = $sourceStream.Read($buffer, 0, $toRead)
                if ($read -le 0) {
                    throw "Unexpected EOF while splitting archive."
                }
                $targetStream.Write($buffer, 0, $read)
                $written += $read
            }
        } finally {
            $targetStream.Dispose()
        }

        $partFile = Get-Item $partPath
        $parts.Add(@{
            name = $partName
            size = [int64]$partFile.Length
        }) | Out-Null

        $index += 1
    }
} finally {
    $sourceStream.Dispose()
}

$manifest = @{
    parts = $parts
    totalSize = [int64]$archiveFile.Length
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

Copy-Item $HashPath (Join-Path $OutPath "python-deps-hash.txt") -Force

Write-Host ""
Write-Host "Runtime assets ready:" -ForegroundColor Green
Write-Host "  $OutPath" -ForegroundColor Green
Write-Host "Archive size: $([math]::Round($archiveFile.Length / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "Parts: $($parts.Count)" -ForegroundColor Green
