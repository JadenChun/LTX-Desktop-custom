# upload-python-runtime-assets.ps1
# Uploads runtime archive assets to a GitHub release using the Releases API.

param(
    [string]$Tag = "",
    [string]$AssetsDir = "release\python-runtime",
    [string]$Owner = "",
    [string]$Repo = "",
    [switch]$CreateIfMissing
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$AssetsPath = Join-Path $ProjectDir $AssetsDir
$PackageJsonPath = Join-Path $ProjectDir "package.json"
$Token = $env:GITHUB_TOKEN
if (-not $Token) { $Token = $env:GH_TOKEN }

function Get-PackageJson() {
    return Get-Content $PackageJsonPath -Raw | ConvertFrom-Json
}

function Infer-RepoFromHomepage() {
    $pkg = Get-PackageJson
    $homepage = [string]$pkg.homepage
    if (-not $homepage) { return $null }
    $uri = [System.Uri]$homepage
    if ($uri.Host -notmatch "github\.com$") { return $null }
    $segments = $uri.AbsolutePath.Trim('/').Split('/')
    if ($segments.Length -lt 2) { return $null }
    return @{
        owner = $segments[0]
        repo = $segments[1]
    }
}

function Invoke-GitHubJson($Method, $Url, $Body = $null) {
    $headers = @{
        Authorization = "Bearer $Token"
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "ltx-desktop-custom-runtime-uploader"
    }

    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers
    }

    $json = $Body | ConvertTo-Json -Depth 10
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $headers -Body $json -ContentType "application/json"
}

function Upload-Asset($UploadUrlTemplate, $FilePath, $ExistingAssets) {
    $fileName = Split-Path -Leaf $FilePath
    $uploadBase = $UploadUrlTemplate -replace '\{\?name,label\}$', ''
    $existing = $ExistingAssets | Where-Object { $_.name -eq $fileName } | Select-Object -First 1
    if ($existing) {
        $deleteUrl = "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($existing.id)"
        Invoke-GitHubJson DELETE $deleteUrl | Out-Null
    }

    $headers = @{
        Authorization = "Bearer $Token"
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "ltx-desktop-custom-runtime-uploader"
        "Content-Type" = "application/octet-stream"
    }
    $uploadUrl = "${uploadBase}?name=$([System.Uri]::EscapeDataString($fileName))"
    Invoke-RestMethod -Method POST -Uri $uploadUrl -Headers $headers -InFile $FilePath | Out-Null
    Write-Host "Uploaded $fileName" -ForegroundColor Green
}

if (-not $Token) {
    throw "Set GITHUB_TOKEN or GH_TOKEN before uploading release assets."
}

if (-not (Test-Path $AssetsPath)) {
    throw "Assets directory not found: $AssetsPath. Run package-python-runtime.ps1 first."
}

if (-not $Tag) {
    $pkg = Get-PackageJson
    $Tag = "v$($pkg.version)"
}

if (-not $Owner -or -not $Repo) {
    $inferred = Infer-RepoFromHomepage
    if (-not $Owner) { $Owner = [string]$inferred.owner }
    if (-not $Repo) { $Repo = [string]$inferred.repo }
}

if (-not $Owner -or -not $Repo) {
    throw "Could not determine GitHub owner/repo. Pass -Owner and -Repo explicitly."
}

$releaseUrl = "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Tag"
$release = $null
try {
    $release = Invoke-GitHubJson GET $releaseUrl
} catch {
    if (-not $CreateIfMissing) {
        throw "Release $Tag was not found in $Owner/$Repo. Re-run with -CreateIfMissing to create it."
    }

    $createUrl = "https://api.github.com/repos/$Owner/$Repo/releases"
    $release = Invoke-GitHubJson POST $createUrl @{
        tag_name = $Tag
        name = $Tag
        draft = $false
        prerelease = $false
    }
}

$assetFiles = Get-ChildItem -Path $AssetsPath -File | Sort-Object Name
if (-not $assetFiles) {
    throw "No files found in $AssetsPath"
}

Write-Host "Uploading runtime assets to $Owner/$Repo release $Tag" -ForegroundColor Yellow
foreach ($file in $assetFiles) {
    Upload-Asset -UploadUrlTemplate $release.upload_url -FilePath $file.FullName -ExistingAssets $release.assets
}

Write-Host ""
Write-Host "Runtime asset upload complete." -ForegroundColor Green
