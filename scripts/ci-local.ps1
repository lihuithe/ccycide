<#
.SYNOPSIS
  本机一键跑与 CI（.github/workflows/ci.yml）相同的检查：Rust fmt / clippy / test，前端 tsc / eslint / vitest / build，服务端 tsc / vitest。

.DESCRIPTION
  默认依次跑全部三组，某一步失败不会中断后面的步骤，最后汇总并以非零退出码结束。
  -WhatIf 只打印将要执行的命令，并检查各目录、命令是否存在，不真正运行（用来验证脚本本身）。

.PARAMETER Skip
  跳过某些组：rust、desktop、server（可多个，逗号分隔）。
.PARAMETER NoTest
  只跑静态检查（fmt / clippy / tsc / eslint），不跑测试，快得多。
.PARAMETER Install
  跑前端和服务端之前先 npm ci。
.PARAMETER Integration
  额外跑服务端的 MySQL 集成测试，要求环境变量 TEST_MYSQL_URL 已设置（见 server/test/mysql.test.ts）。
  需要本机 MySQL 8.4，例如 docker compose -f server/docker-compose.dev.yml up -d。
.PARAMETER Root
  仓库根目录，默认脚本上级目录。

.EXAMPLE
  pwsh scripts/ci-local.ps1 -WhatIf
  pwsh scripts/ci-local.ps1 -NoTest
  pwsh scripts/ci-local.ps1 -Skip rust -Install
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidateSet('rust', 'desktop', 'server')]
  [string[]]$Skip = @(),
  [switch]$NoTest,
  [switch]$Install,
  [switch]$Integration,
  [string]$Root = ''
)
$ErrorActionPreference = 'Continue'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path
$results = New-Object System.Collections.Generic.List[object]
$script:problems = 0

function Invoke-Step {
  param([string]$Group, [string]$Name, [string]$Dir, [string]$Exe, [string[]]$StepArgs)
  $label = "[$Group] $Name"
  $cmdText = "$Exe $($StepArgs -join ' ')"
  $dirOk = Test-Path -LiteralPath $Dir -PathType Container
  $exeOk = [bool](Get-Command $Exe -ErrorAction SilentlyContinue)

  if ($WhatIfPreference) {
    $state = if ($dirOk -and $exeOk) { '路径与命令均存在' } else { "缺失：" + $(if (-not $dirOk) { "目录 $Dir " }) + $(if (-not $exeOk) { "命令 $Exe" }) }
    if (-not ($dirOk -and $exeOk)) { $script:problems++ }
    Write-Host ("WhatIf  {0,-34} {1}" -f $label, $state)
    Write-Host ("        cd {0}`n        {1}" -f $Dir, $cmdText) -ForegroundColor DarkGray
    $results.Add([pscustomobject]@{ Step = $label; Result = '(whatif)'; Seconds = 0 })
    return
  }
  if (-not $dirOk -or -not $exeOk) {
    Write-Host "跳过 $label：目录或命令不存在（$Dir / $Exe）" -ForegroundColor Yellow
    $results.Add([pscustomobject]@{ Step = $label; Result = '缺失'; Seconds = 0 })
    $script:problems++
    return
  }
  Write-Host "`n=== $label ===" -ForegroundColor Cyan
  Write-Host "$ $cmdText" -ForegroundColor DarkGray
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Push-Location -LiteralPath $Dir
  try { & $Exe @StepArgs; $code = $LASTEXITCODE } finally { Pop-Location }
  $sw.Stop()
  $ok = ($code -eq 0)
  if (-not $ok) { $script:problems++ }
  $results.Add([pscustomobject]@{ Step = $label; Result = $(if ($ok) { '通过' } else { "失败($code)" }); Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
}

$desktopDir = Join-Path $Root 'apps/desktop'
$serverDir = Join-Path $Root 'server'
$tauriToml = Join-Path $Root 'apps/desktop/src-tauri/Cargo.toml'
$tauriDir = Join-Path $Root 'apps/desktop/src-tauri'

# ---------- Rust ----------
if ($Skip -notcontains 'rust') {
  # tauri-build 会校验 frontendDist（apps/desktop/dist）存在；检查类步骤不需要真内容，建个空目录即可。
  # externalBin / resources 只写在 tauri.bundle*.conf.json 里，仅 tauri build 时才合并，检查不受影响。
  $tauriConf = Join-Path $tauriDir 'tauri.conf.json'
  if (Test-Path -LiteralPath $tauriConf) {
    if (-not (Test-Path -LiteralPath (Join-Path $desktopDir 'dist'))) {
      if ($WhatIfPreference) { Write-Host "WhatIf  创建空目录 apps/desktop/dist（tauri 的 frontendDist 需要存在）" }
      else { New-Item -ItemType Directory -Path (Join-Path $desktopDir 'dist') | Out-Null }
    }
  }
  Invoke-Step 'rust' 'cargo fmt --check' $Root 'cargo' @('fmt', '--all', '--', '--check')
  Invoke-Step 'rust' 'cargo clippy -D warnings' $Root 'cargo' @('clippy', '--workspace', '--all-targets', '--', '-D', 'warnings')
  if (-not $NoTest) {
    # 默认不跑 #[ignore] 的测试（需要外部服务、真钥匙串、已登录的 Claude Code）
    Invoke-Step 'rust' 'cargo test' $Root 'cargo' @('test', '--workspace')
  }
  # src-tauri 若不在工作区里，需要单独检查
  if (Test-Path -LiteralPath $tauriToml) {
    $wsText = Get-Content -LiteralPath (Join-Path $Root 'Cargo.toml') -Raw
    if ($wsText -notmatch 'src-tauri') {
      Invoke-Step 'rust' 'src-tauri fmt --check' $Root 'cargo' @('fmt', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--', '--check')
      Invoke-Step 'rust' 'src-tauri clippy' $Root 'cargo' @('clippy', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings')
      if (-not $NoTest) { Invoke-Step 'rust' 'src-tauri test' $Root 'cargo' @('test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml') }
    }
  }
}

# ---------- 前端 ----------
if ($Skip -notcontains 'desktop') {
  if ($Install) { Invoke-Step 'desktop' 'npm ci' $desktopDir 'npm' @('ci') }
  Invoke-Step 'desktop' 'tsc (typecheck)' $desktopDir 'npm' @('run', 'typecheck')
  Invoke-Step 'desktop' 'eslint' $desktopDir 'npm' @('run', 'lint')
  if (-not $NoTest) { Invoke-Step 'desktop' 'vitest' $desktopDir 'npm' @('test') }
  Invoke-Step 'desktop' 'vite build' $desktopDir 'npm' @('run', 'build')
}

# ---------- 服务端 ----------
if ($Skip -notcontains 'server') {
  if ($Install) { Invoke-Step 'server' 'npm ci' $serverDir 'npm' @('ci') }
  Invoke-Step 'server' 'tsc (typecheck)' $serverDir 'npm' @('run', 'typecheck')
  if (-not $NoTest) {
    # 不设 TEST_MYSQL_URL 时 mysql.test.ts 自动跳过；其余测试都用内存实现，不需要外部依赖
    if ($Integration -and -not $env:TEST_MYSQL_URL -and -not $WhatIfPreference) {
      Write-Host '-Integration 需要先设置环境变量 TEST_MYSQL_URL，例如 mysql://root:dev@127.0.0.1:3306/rterm' -ForegroundColor Red
      $script:problems++
    } elseif (-not $Integration) {
      $saved = $env:TEST_MYSQL_URL; $env:TEST_MYSQL_URL = ''
      Invoke-Step 'server' 'vitest' $serverDir 'npm' @('test')
      $env:TEST_MYSQL_URL = $saved
    } else {
      Invoke-Step 'server' 'vitest（含 MySQL 集成）' $serverDir 'npm' @('test')
    }
  }
}

# ---------- 汇总 ----------
Write-Host "`n===== 汇总 =====" -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String | Write-Host
if ($WhatIfPreference) {
  if ($script:problems -gt 0) { Write-Host "WhatIf 发现 $($script:problems) 处路径/命令缺失" -ForegroundColor Red; exit 1 }
  Write-Host 'WhatIf：所有步骤的目录与命令都存在（未实际运行）' -ForegroundColor Green
  exit 0
}
if ($script:problems -gt 0) { Write-Host "$($script:problems) 步未通过" -ForegroundColor Red; exit 1 }
Write-Host '全部通过' -ForegroundColor Green
