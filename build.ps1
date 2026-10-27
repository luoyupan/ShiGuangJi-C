# ============================================================
#  ShiGuangJi C build script (ASCII only: Windows PowerShell 5.1 safe)
#  Build host:  powershell -ExecutionPolicy Bypass -File build.ps1 -Only hello
#  Output:      build\ShiGuangJi.exe + build\modules\*.dll + build\ui\
# ============================================================
param(
  [switch]$HostOnly,
  [string]$Only = "",
  [switch]$NoHost
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# 版本号单一来源：改这里即可（package.ps1 与 src\host\sgj.h 需同步）
# FILEVERSION 必须是 4 段 16 位整数，"1.1.0" 要补成 "1,1,0,0"，否则 rc.exe 报错
$ver = "1.1.0"
$verParts = $ver.Split('.')
while ($verParts.Count -lt 4) { $verParts += "0" }
$verComma = $verParts -join ","
$build = Join-Path $root "build"
$gen = Join-Path $build "gen"
$modout = Join-Path $build "modules"
$sdk = Join-Path $root "third_party\webview2"
$cjson = Join-Path $root "third_party\cJSON"
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
  # VS 2022 / 2026, BuildTools / Enterprise / Community ... 都试一遍
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $inst = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($inst) {
      $cand = Join-Path $inst.Trim() "VC\Auxiliary\Build\vcvars64.bat"
      if (Test-Path $cand) { $vcvars = $cand }
    }
  }
}
if (-not (Test-Path $vcvars)) {
  $vs = Get-ChildItem "C:\Program Files*\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($vs) { $vcvars = $vs.FullName } else { throw "vcvars64.bat not found (need Visual Studio C++ Build Tools)" }
}

New-Item -ItemType Directory -Force -Path $build, $gen, $modout | Out-Null

function Invoke-Batch([string]$name, [string]$content) {
  $bat = Join-Path $gen "$name.cmd"
  $content = "@echo off`r`ncall `"$vcvars`" >nul 2>&1`r`nchcp 65001 >nul`r`ncd /d `"$root`"`r`n" + $content + "`r`n"
  [System.IO.File]::WriteAllText($bat, $content, [System.Text.Encoding]::Default)
  Write-Host ">> $name" -ForegroundColor Cyan
  & cmd.exe /c "`"$bat`""
  if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" }
}

function Build-Host {
  $sources = (Get-ChildItem (Join-Path $root "src\host") -Filter *.c | ForEach-Object { '"' + $_.FullName + '"' }) -join " "
  $sources += ' "' + (Join-Path $cjson "cJSON.c") + '"'
  $res = ""
  $zip = Join-Path $build "ui.zip"
  if (Test-Path $zip) {
    $rc = Join-Path $gen "ui.rc"
    $rcText = "#pragma code_page(65001)`r`nUI_ZIP RCDATA `"$($zip.Replace('\','\\'))`"`r`n"
    [System.IO.File]::WriteAllText($rc, $rcText, (New-Object System.Text.UTF8Encoding($false)))
    $res += "rc /nologo /fo `"$gen\ui.res`" `"$rc`" && "
    $sources += ' "' + (Join-Path $gen "ui.res") + '"'
  }
  $icon = Join-Path $root "assets\app.ico"
  if (Test-Path $icon) {
    $rc2 = Join-Path $gen "app.rc"
    $ic = $icon.Replace('\','\\')
    $rc2Text = "#pragma code_page(65001)`r`nAPPICON ICON `"$ic`"`r`n1 VERSIONINFO`r`nFILEVERSION $verComma`r`nPRODUCTVERSION $verComma`r`nFILEOS 0x40004L`r`nFILETYPE 0x1L`r`nBEGIN`r`n  BLOCK `"StringFileInfo`"`r`n  BEGIN`r`n    BLOCK `"080404B0`"`r`n    BEGIN`r`n      VALUE `"FileDescription`", `"ShiGuangJi C Edition`"`r`n      VALUE `"FileVersion`", `"$ver`"`r`n      VALUE `"ProductName`", `"ShiGuangJi`"`r`n      VALUE `"ProductVersion`", `"$ver`"`r`n    END`r`n  END`r`n  BLOCK `"VarFileInfo`"`r`n  BEGIN`r`n    VALUE `"Translation`", 0x0804, 1200`r`n  END`r`nEND`r`n"
    [System.IO.File]::WriteAllText($rc2, $rc2Text, (New-Object System.Text.UTF8Encoding($false)))
    $res += "rc /nologo /fo `"$gen\app.res`" `"$rc2`" && "
    $sources += ' "' + (Join-Path $gen "app.res") + '"'
  }
  $cmd = $res + "cl /nologo /std:c11 /utf-8 /W3 /O2 /MT /D_CRT_SECURE_NO_WARNINGS /DUNICODE /D_UNICODE " +
         "/I`"$root\src\host`" /I`"$cjson`" /I`"$sdk\include`" " +
         "/Fo`"$gen\\`" /Fe`"$build\ShiGuangJi.exe`" $sources " +
         "/link /LIBPATH:`"$sdk\x64`" WebView2LoaderStatic.lib ole32.lib oleaut32.lib user32.lib shell32.lib shlwapi.lib " +
         "advapi32.lib gdi32.lib winhttp.lib ws2_32.lib dwmapi.lib comdlg32.lib uuid.lib"
  Invoke-Batch "build-host" $cmd
  Copy-Item (Join-Path $sdk "x64\WebView2Loader.dll") $build -Force
}

function Make-UiPack {
  $zip = Join-Path $build "ui.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Write-Host ">> ui-pack" -ForegroundColor Cyan
  Compress-Archive -Path (Join-Path $build "ui\*") -DestinationPath $zip -Force -CompressionLevel Optimal
  if (-not (Test-Path $zip)) { throw "ui.zip packaging failed" }
}

function Write-JsBundle([string]$id, [string[]]$parts) {
  $out = Join-Path $gen "$id.js"
  $sb = New-Object System.Text.StringBuilder
  foreach ($p in $parts) {
    $full = Join-Path $root $p
    if (-not (Test-Path $full)) { throw "renderer file not found: $full" }
    [void]$sb.AppendLine("/* ===== $p ===== */")
    [void]$sb.AppendLine([System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8))
  }
  [System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
  return $out
}

function Build-Module([string]$id, [string[]]$jsParts, [string]$cssPath) {
  $manifest = Join-Path $root "src\modules\$id\module.json"
  $source = Join-Path $root "src\modules\$id\module.c"
  if (-not (Test-Path $source)) { Write-Host "skip $id (no module.c)" -ForegroundColor DarkGray; return }
  if (-not (Test-Path $manifest)) { throw "missing module.json for $id" }
  $js = Write-JsBundle $id $jsParts
  $rc = Join-Path $gen "$id.rc"
  # RC treats backslash as escape: double them in quoted paths
  $rcManifest = $manifest.Replace('\', '\\')
  $rcJs = $js.Replace('\', '\\')
  $rcText = "#pragma code_page(65001)`r`nMANIFEST RCDATA `"$rcManifest`"`r`nUI_JS RCDATA `"$rcJs`"`r`n"
  if ($cssPath) {
    $cssFull = Join-Path $root $cssPath
    if (Test-Path $cssFull) { $rcText += "UI_CSS RCDATA `"$($cssFull.Replace('\','\\'))`"`r`n" }
  }
  [System.IO.File]::WriteAllText($rc, $rcText, (New-Object System.Text.UTF8Encoding($false)))
  $cmd = "rc /nologo /fo `"$gen\$id.res`" `"$rc`" && " +
         "cl /nologo /LD /std:c11 /utf-8 /W3 /O2 /MT /D_CRT_SECURE_NO_WARNINGS /DUNICODE /D_UNICODE " +
         "/I`"$root\src\modules`" /I`"$root\src\host`" /I`"$cjson`" " +
         "`"$source`" `"$root\src\modules\module_common.c`" `"$root\src\host\sgj.c`" `"$cjson\cJSON.c`" `"$gen\$id.res`" " +
         "/Fo`"$gen\\`" /Fe`"$modout\$id.dll`" " +
         "/link user32.lib shell32.lib advapi32.lib ole32.lib comctl32.lib winhttp.lib bcrypt.lib"
  Invoke-Batch "build-$id" $cmd
}

function Copy-Ui {
  $src = Join-Path $root "ui"
  $dst = Join-Path $build "ui"
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
}

Copy-Ui
Make-UiPack
if (-not $NoHost) { Build-Host }

$mods = [ordered]@{
  "hello"   = @(@("src\modules\hello\renderer.js"), "src\modules\hello\style.css")
  "games"   = @(@("ui\js\modules\hidden.js", "ui\js\modules\games.js"), $null)
  "mods"    = @(@("ui\js\modules\mods.js"), $null)
  "music"   = @(@("ui\js\modules\music.js"), $null)
  "netdisk" = @(@("ui\js\modules\netdisk.js"), $null)
  "browser" = @(@("src\modules\browser\renderer.js"), $null)
  "link"    = @(@("ui\js\modules\link.js"), $null)
  "photos"  = @(@("ui\js\modules\photos.js"), $null)
  "player"  = @(@("src\modules\player\renderer.js"), "src\modules\player\style.css")
}
foreach ($id in $mods.Keys) {
  if ($Only -and $Only -ne $id) { continue }
  $spec = $mods[$id]
  Build-Module $id $spec[0] $spec[1]
}

Write-Host ""
Write-Host "Build done:" -ForegroundColor Green
Write-Host "  $build\ShiGuangJi.exe"
Get-ChildItem $modout -Filter *.dll -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("  " + $_.FullName + "  (" + $_.Length + " bytes)") }
