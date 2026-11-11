<#
.SYNOPSIS
  RTerm 版本号一致性检查与批量修改（对应 scripts/release-prepare.sh，两者行为一致）。

.DESCRIPTION
  管理的文件（不存在的会跳过）：
    Cargo.toml                         [workspace.package] version（唯一来源，crates/* 与 src-tauri 用 version.workspace = true）
    crates/*/Cargo.toml                必须是 version.workspace = true，或写死且与工作区一致
    apps/desktop/src-tauri/Cargo.toml  同上
    Cargo.lock                         本地 crate（无 source 的包）的 version
    apps/desktop/package.json          + package-lock.json（顶层与 packages[""] 两处）
    server/package.json                + package-lock.json
    apps/desktop/src-tauri/tauri.conf.json  version 缺省或写成 "../package.json" 视为跟随，写死则必须一致

.PARAMETER Set
  批量改成该版本（可带 v 前缀），改完自动再检查。
.PARAMETER Expect
  检查时要求等于该版本（tag 校验用）。
.PARAMETER Root
  仓库根目录，默认脚本上级目录。
.PARAMETER DryRun
  与 -Set 配合：只检查参数与路径，不写文件。

.EXAMPLE
  pwsh scripts/release-prepare.ps1
  pwsh scripts/release-prepare.ps1 -Expect v0.2.0
  pwsh scripts/release-prepare.ps1 -Set 0.2.0
  pwsh scripts/release-prepare.ps1 -Set 0.2.0 -DryRun

  退出码：0 一致；1 不一致或参数错误。
#>
[CmdletBinding()]
param(
  [string]$Set = '',
  [string]$Expect = '',
  [string]$Root = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Die([string]$msg) { [Console]::Error.WriteLine("错误：$msg"); exit 1 }

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path
$semver = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
$New = $Set -replace '^v', ''
$ExpectV = $Expect -replace '^v', ''
if ($Set -and $New -notmatch $semver) { Die "-Set 需要形如 1.2.3 或 1.2.3-beta.1 的版本号，收到「$New」" }
if ($Expect -and $ExpectV -notmatch $semver) { Die "-Expect 不是合法版本号：$ExpectV" }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 按行读取并保留每行原有的换行符（\n 或 \r\n），改写后原样写回
function Read-Lines([string]$path) {
  $text = [System.IO.File]::ReadAllText($path, $Utf8NoBom)
  if ($text.Length -eq 0) { return @() }
  return [regex]::Split($text, '(?<=\n)') | Where-Object { $_ -ne '' }
}
function Split-Eol([string]$line) {
  if ($line.EndsWith("`r`n")) { return @($line.Substring(0, $line.Length - 2), "`r`n") }
  if ($line.EndsWith("`n")) { return @($line.Substring(0, $line.Length - 1), "`n") }
  return @($line, '')
}

$jsonRe = '^(?<head>\s*"version"\s*:\s*")(?<v>[^"]*)(?<tail>".*)$'
$cargoRe = '^(?<head>version\s*=\s*")(?<v>[^"]*)(?<tail>".*)$'

# 通用处理器：Op = get 返回当前值数组；Op = set 返回改写后的行数组
function Invoke-Edit([string]$Kind, [string]$Op, [string]$Path, [string[]]$Names = @()) {
  $lines = Read-Lines $Path
  $out = New-Object System.Collections.Generic.List[string]
  $got = New-Object System.Collections.Generic.List[string]
  $done = $false; $topdone = $false; $rootdone = $false; $inroot = $false; $insec = $false
  $block = New-Object System.Collections.Generic.List[string]
  $inblock = $false

  $flush = {
    if ($block.Count -eq 0) { return }
    $name = ''; $src = $false; $vidx = -1
    for ($i = 0; $i -lt $block.Count; $i++) {
      $t = (Split-Eol $block[$i])[0]
      if ($t -match '^name\s*=\s*"(?<n>[^"]*)"') { $name = $Matches['n'] }
      if ($t -match '^source\s*=') { $src = $true }
      if ($t -match '^version\s*=' -and $vidx -lt 0) { $vidx = $i }
    }
    if (-not $src -and $vidx -ge 0 -and ($Names -contains $name)) {
      $p = Split-Eol $block[$vidx]
      if ($Op -eq 'get') { if ($p[0] -match $cargoRe) { $got.Add("pkg:$name=$($Matches['v'])") } }
      else { $block[$vidx] = ($p[0] -replace $cargoRe, ('${head}' + $New + '${tail}')) + $p[1] }
    }
    if ($Op -eq 'set') { foreach ($b in $block) { $out.Add($b) } }
    $block.Clear()
  }

  foreach ($raw in $lines) {
    $p = Split-Eol $raw; $t = $p[0]; $eol = $p[1]
    switch ($Kind) {
      'json' {
        if (-not $done -and $t -match $jsonRe) {
          $done = $true
          if ($Op -eq 'get') { $got.Add($Matches['v']) }
          else { $out.Add(($t -replace $jsonRe, ('${head}' + $New + '${tail}')) + $eol); continue }
        }
        if ($Op -eq 'set') { $out.Add($raw) }
      }
      'lock' {
        if (-not $rootdone -and $t -match '^\s*"":\s*\{') { $inroot = $true }
        if (-not $rootdone -and $t -match $jsonRe) {
          if (-not $topdone) {
            $topdone = $true
            if ($Op -eq 'get') { $got.Add("top=$($Matches['v'])") }
            else { $out.Add(($t -replace $jsonRe, ('${head}' + $New + '${tail}')) + $eol); continue }
          } elseif ($inroot) {
            $rootdone = $true
            if ($Op -eq 'get') { $got.Add("root=$($Matches['v'])") }
            else { $out.Add(($t -replace $jsonRe, ('${head}' + $New + '${tail}')) + $eol); continue }
          }
        }
        if ($Op -eq 'set') { $out.Add($raw) }
      }
      { $_ -in 'cargo_ws', 'cargo_pkg' } {
        if ($t -match '^\[') {
          if ($Kind -eq 'cargo_ws') { $insec = ($t -match '^\[workspace\.package\]') } else { $insec = ($t -match '^\[package\]') }
        }
        if ($insec -and -not $done -and $t -match '^version\.workspace\s*=\s*true') {
          $done = $true; if ($Op -eq 'get') { $got.Add('workspace') }
        } elseif ($insec -and -not $done -and $t -match $cargoRe) {
          $done = $true
          if ($Op -eq 'get') { $got.Add($Matches['v']) }
          else { $out.Add(($t -replace $cargoRe, ('${head}' + $New + '${tail}')) + $eol); continue }
        }
        if ($Op -eq 'set') { $out.Add($raw) }
      }
      'cargolock' {
        if ($t -match '^\[\[package\]\]') { & $flush; $inblock = $true; $block.Add($raw); continue }
        if ($t -match '^\[') { & $flush; $inblock = $false }
        if ($inblock) { $block.Add($raw); continue }
        if ($Op -eq 'set') { $out.Add($raw) }
      }
    }
  }
  if ($Kind -eq 'cargolock') { & $flush }

  if ($Op -eq 'get') { $script:Got = $got.ToArray(); return }
  if (-not $DryRun) { [System.IO.File]::WriteAllText($Path, (-join $out), $Utf8NoBom) }
}
function Get-Ver([string]$Kind, [string]$Path, [string[]]$Names = @()) { $script:Got = @(); Invoke-Edit $Kind 'get' $Path $Names | Out-Null; return $script:Got }

# ---------- 收集目标 ----------
$wsToml = Join-Path $Root 'Cargo.toml'
if (-not (Test-Path -LiteralPath $wsToml)) { Die "找不到 $wsToml" }
$tauriDir = Join-Path $Root 'apps/desktop/src-tauri'

function Get-PkgName([string]$path) {
  $sec = $false
  foreach ($l in Read-Lines $path) {
    $t = (Split-Eol $l)[0]
    if ($t -match '^\[') { $sec = ($t -match '^\[package\]') }
    if ($sec -and $t -match '^name\s*=\s*"(?<n>[^"]*)"') { return $Matches['n'] }
  }
  return ''
}

$members = @()
$cratesDir = Join-Path $Root 'crates'
if (Test-Path -LiteralPath $cratesDir) {
  foreach ($d in Get-ChildItem -LiteralPath $cratesDir -Directory | Sort-Object Name) {
    $f = Join-Path $d.FullName 'Cargo.toml'
    if (Test-Path -LiteralPath $f) { $members += $f }
  }
}
$tauriToml = Join-Path $tauriDir 'Cargo.toml'
if (Test-Path -LiteralPath $tauriToml) { $members += $tauriToml }
$names = @($members | ForEach-Object { Get-PkgName $_ })

function Rel([string]$p) { return $p.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/') }

# ---------- 修改 ----------
if ($Set) {
  Invoke-Edit 'cargo_ws' 'set' $wsToml
  foreach ($f in $members) {
    $cur = (@(Get-Ver 'cargo_pkg' $f))[0]
    if ($cur -and $cur -ne 'workspace') { Invoke-Edit 'cargo_pkg' 'set' $f }
  }
  $lock = Join-Path $Root 'Cargo.lock'
  if (Test-Path -LiteralPath $lock) { Invoke-Edit 'cargolock' 'set' $lock $names }
  foreach ($p in 'apps/desktop', 'server') {
    $pj = Join-Path $Root "$p/package.json"
    $pl = Join-Path $Root "$p/package-lock.json"
    if (Test-Path -LiteralPath $pj) { Invoke-Edit 'json' 'set' $pj }
    if (Test-Path -LiteralPath $pl) { Invoke-Edit 'lock' 'set' $pl }
  }
  $tc = Join-Path $tauriDir 'tauri.conf.json'
  if (Test-Path -LiteralPath $tc) {
    $cur = (@(Get-Ver 'json' $tc))[0]
    if ($cur -and $cur -match '^[0-9]') { Invoke-Edit 'json' 'set' $tc }
  }
  if ($DryRun) { Write-Output "[dry-run] 参数与路径检查通过，未写入任何文件，目标版本 $New"; exit 0 }
  Write-Output "已将版本号改为 $New"
}

# ---------- 检查 ----------
$wsVer = (@(Get-Ver 'cargo_ws' $wsToml))[0]
if (-not $wsVer) { Die 'Cargo.toml 的 [workspace.package] 里没有 version' }
$want = if ($ExpectV) { $ExpectV } else { $wsVer }
$script:bad = $false
$rows = New-Object System.Collections.Generic.List[string]
function Add-Row([string]$label, [string]$value, [string]$state) {
  $rows.Add(('{0,-52} {1,-16} {2}' -f $label, $value, $state))
}
function Add-Ver([string]$label, [string]$value) {
  if ($value -eq $want) { Add-Row $label $value 'OK' } else { $script:bad = $true; Add-Row $label $value '不一致' }
}

Add-Ver 'Cargo.toml [workspace.package]' $wsVer
foreach ($f in $members) {
  $v = (@(Get-Ver 'cargo_pkg' $f))[0]
  if ($v -eq 'workspace') { Add-Row (Rel $f) 'workspace' '跟随' }
  elseif ($v) { Add-Ver (Rel $f) $v }
  else { Add-Ver (Rel $f) '（缺失）' }
}
$lock = Join-Path $Root 'Cargo.lock'
if (Test-Path -LiteralPath $lock) {
  foreach ($e in (Get-Ver 'cargolock' $lock $names)) {
    $n = $e -replace '^pkg:', ''
    $i = $n.IndexOf('=')
    Add-Ver ("Cargo.lock " + $n.Substring(0, $i)) $n.Substring($i + 1)
  }
}
foreach ($p in 'apps/desktop', 'server') {
  $pj = Join-Path $Root "$p/package.json"
  $pl = Join-Path $Root "$p/package-lock.json"
  if (Test-Path -LiteralPath $pj) { Add-Ver "$p/package.json" ((@(Get-Ver 'json' $pj))[0]) }
  if (Test-Path -LiteralPath $pl) {
    foreach ($e in (Get-Ver 'lock' $pl)) {
      $i = $e.IndexOf('=')
      Add-Ver ("$p/package-lock.json (" + $e.Substring(0, $i) + ")") $e.Substring($i + 1)
    }
  }
}
$tc = Join-Path $tauriDir 'tauri.conf.json'
if (Test-Path -LiteralPath $tc) {
  $v = (@(Get-Ver 'json' $tc))[0]
  if (-not $v) { Add-Row 'apps/desktop/src-tauri/tauri.conf.json' '（未设置）' '跟随' }
  elseif ($v -match '^[0-9]') { Add-Ver 'apps/desktop/src-tauri/tauri.conf.json' $v }
  else { Add-Row 'apps/desktop/src-tauri/tauri.conf.json' $v '跟随' }
} else {
  Add-Row 'apps/desktop/src-tauri/tauri.conf.json' '-' '文件还不存在，跳过'
}

Write-Output "期望版本：$want"
$rows | ForEach-Object { Write-Output $_ }
if ($script:bad) {
  [Console]::Error.WriteLine("版本号不一致。用 scripts/release-prepare.ps1 -Set $want 批量修正。")
  exit 1
}
Write-Output "版本号全部一致：$want"
