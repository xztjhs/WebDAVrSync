# WebDAVrSync installer for Obsidian (Windows PowerShell 5.1+)
#
# Usage:
#   .\install.ps1 -VaultPath "D:\MyVault"
#   .\install.ps1 -VaultPath "D:\MyVault" -WithConfig
#   .\install.ps1 -VaultPath "D:\MyVault" -Enable
#
# -WithConfig copies data.json (which contains the WebDAV password).
# -Enable adds the plugin to community-plugins.json; restart Obsidian afterward.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,

    [switch]$WithConfig,

    [switch]$Enable
)

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath $VaultPath)) {
    throw "Vault not found: $VaultPath"
}
$vault = (Resolve-Path -LiteralPath $VaultPath).Path
$obsidianDir = Join-Path $vault '.obsidian'
if (-not (Test-Path -LiteralPath $obsidianDir)) {
    throw "Not an Obsidian vault (missing .obsidian): $vault"
}

$dest = Join-Path $obsidianDir 'plugins\webdavrsync'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$inPlace = (Resolve-Path -LiteralPath $source).Path -eq (Resolve-Path -LiteralPath $dest).Path

$files = @(
    'main.js',
    'manifest.json',
    'versions.json',
    'README.md',
    '使用手册.md',
    'CHANGELOG.md',
    'LICENSE',
    'install.ps1',
    '.gitignore'
)
foreach ($file in $files) {
    $from = Join-Path $source $file
    if (-not (Test-Path -LiteralPath $from)) {
        throw "Missing file in package: $file"
    }
    if (-not $inPlace) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $dest $file) -Force
    }
}

if ($WithConfig -and -not $inPlace) {
    $config = Join-Path $source 'data.json'
    if (-not (Test-Path -LiteralPath $config)) {
        throw "data.json not found in $source"
    }
    # Copy settings only. A copied file-state table would reference another
    # machine's mtimes and could cause false conflicts.
    $configObject = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
    $configObject.state = [pscustomobject]@{
        version  = 1
        lastSync = 0
        files    = [pscustomobject]@{}
    }
    $configJson = ConvertTo-Json -InputObject $configObject -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $dest 'data.json'), $configJson, $utf8NoBom)
}

if ($Enable) {
    $communityFile = Join-Path $obsidianDir 'community-plugins.json'
    $plugins = @()
    if (Test-Path -LiteralPath $communityFile) {
        $raw = Get-Content -LiteralPath $communityFile -Raw -Encoding UTF8
        if ($raw -and $raw.Trim().Length -gt 0) {
            $plugins = @($raw | ConvertFrom-Json)
        }
    }
    if ($plugins -notcontains 'webdavrsync') {
        $plugins += 'webdavrsync'
    }
    $json = ConvertTo-Json -InputObject @($plugins) -Depth 5
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($communityFile, $json, $utf8NoBom)
}

Write-Host ""
Write-Host "WebDAVrSync installed to:" -ForegroundColor Green
Write-Host "  $dest"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart Obsidian (or run 'Reload app without saving')."
Write-Host "  2. Settings -> Community plugins -> enable WebDAVrSync."
Write-Host "  3. Open the plugin settings, test the connection, then sync."
if (-not $WithConfig) {
    Write-Host ""
    Write-Host "Note: data.json was not copied. Fill in the WebDAV address/account in the plugin settings." -ForegroundColor Yellow
}
