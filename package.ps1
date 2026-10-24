# Build a clean distributable folder: dist\ShiGuangJi-1.0.0
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ver = "1.0.0"
$distRoot = Join-Path $root "dist"
$dist = Join-Path $distRoot "ShiGuangJi-$ver"

if (-not $SkipBuild) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "build.ps1")
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
}

if (Test-Path $distRoot) { Remove-Item $distRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist, (Join-Path $dist "modules"), (Join-Path $dist "docs") | Out-Null

Copy-Item (Join-Path $root "build\ShiGuangJi.exe") $dist -Force
Copy-Item (Join-Path $root "build\modules\*.dll") (Join-Path $dist "modules") -Force
Copy-Item (Join-Path $root "README.md") $dist -Force
Copy-Item (Join-Path $root "LICENSE") $dist -Force
Copy-Item (Join-Path $root "docs\*.md") (Join-Path $dist "docs") -Force
# 界面截图是可选资源（当前不含截图 —— 原截图含真实网络信息与个人数据，已撤）
if (Test-Path (Join-Path $root "docs\images")) {
  Copy-Item (Join-Path $root "docs\images") (Join-Path $dist "docs\images") -Recurse -Force
}

# 运行说明（纯文本，避免任何运行环境依赖）
$readme = @"
拾光集 C 版 $ver
====================

运行：
  双击 ShiGuangJi.exe

要求：
  Windows 10/11 x64 + Microsoft Edge WebView2 Runtime
  （Win11 / 新版 Win10 自带；没有就装 Evergreen Runtime）

目录：
  ShiGuangJi.exe      主程序（界面资源已内嵌）
  modules\*.dll       七个模块 + 一个示例插件（删哪个就少哪个模块）
  docs\               架构 / 模块 SDK / 功能对照

数据：
  %APPDATA%\shiguangji\   （和 Electron 原版同一个位置，可直接沿用旧库）

注意：
  同一时间只开一个版本（原版或 C 版），两边都会整库覆盖写。
  第三方 dll 没有沙箱，只放信得过的来源。
"@
[System.IO.File]::WriteAllText((Join-Path $dist "运行说明.txt"), $readme, (New-Object System.Text.UTF8Encoding($true)))

# 打包 zip
$zip = Join-Path $distRoot "ShiGuangJi-$ver-win64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $dist -DestinationPath $zip -Force -CompressionLevel Optimal
if (-not (Test-Path $zip)) { throw "zip failed" }

Write-Host ""
Write-Host "Package done:" -ForegroundColor Green
Get-ChildItem $dist -Recurse -File | Select-Object FullName, Length | Format-Table -AutoSize
Write-Host "ZIP: $zip  ($([math]::Round((Get-Item $zip).Length / 1MB, 2)) MB)"
