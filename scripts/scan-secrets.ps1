# 提交前 / 公开前敏感信息扫描（PowerShell 版，与 scan-secrets.sh 规则一致）。
# 扫描“将被提交”的文件（已跟踪 + 未忽略的新文件），发现即以非零退出。
#   pwsh scripts/scan-secrets.ps1              只扫工作区
#   pwsh scripts/scan-secrets.ps1 -History     同时扫整个 git 历史（git log --all -p）
# 若存在 docs/测试服务器凭据.local.md，会把其中的 IP 和密码当作精确值再扫一遍。
# 本脚本自身和 .gitignore 不参与扫描（规则关键字用 [] 拆开，避免脚本自己命中）。
param([switch]$History)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
Set-Location (git rev-parse --show-toplevel)
$script:fail = $false
function Report($cat, $msg) { Write-Output "[$cat] $msg"; $script:fail = $true }

$rules = @(
  @('私钥', '-----BEGIN [A-Z ]*PRIVATE KEY-----'),
  @('GitHub token', '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'),
  @('API key', 'sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[bpas]-[0-9A-Za-z-]{10,}'),
  @('个人邮箱', '[A-Za-z0-9._%+-]+@(gmai[l]|q[q]|163|126|outloo[k]|hotmai[l]|yaho[o]|icloud|foxmai[l]|proton)\.(com|cn|me)'),
  @('本机用户名/路径', 'lizhaowe[i]|[A-Za-z]:\\Users\\Administrato[r]|/Users/[a-z0-9_.-]+/(Desktop|Documents)|rterm_deploy_ke[y]'),
  @('测试服务器域名/主机名', 'shanghaiji[y]ue|ccycid[c]|iv-yez[9]'),
  @('密码片段', 'LI[l]i[0-9]{4}')
)
$ipRe = '\b(\d{1,3}\.){3}\d{1,3}\b'
$ipAllow = '^(127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.1[89]\.|198\.20\.0\.1|255\.|1\.2\.3\.|1\.1\.1\.1|8\.8\.8\.8|9\.9\.9\.9|6\.6\.6\.6|11\.1\.2\.3)'

$all = @(git -c core.quotepath=off ls-files -z -co --exclude-standard | Out-String).Split([char]0) |
  ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^(scripts/scan-secrets\.(sh|ps1)|\.gitignore)$' }

# 文件名 / 大小
foreach ($f in $all) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
  if ($f -match '(^|/)\.env(\..+)?$' -and $f -notmatch '\.example$') { Report '.env 文件' $f }
  if ($f -match '\.(pem|key|p12|pfx|keystore|jks)$|id_rsa|id_ed25519|deploy_ke[y]') { Report '密钥文件' $f }
  if ($f -match '\.(exe|dll|so|dylib|msi|zip|tgz|7z)$') { Report '二进制/压缩包' $f }
  $len = (Get-Item -LiteralPath $f).Length
  if ($len -gt 1MB) { Report '大文件(>1MB)' "$f ($len 字节)" }
}

$text = $all | Where-Object { $_ -notmatch '(^|/)(Cargo\.lock|package-lock\.json)$|\.(png|ico|icns|jpg|jpeg|gif|webp|woff2?|pdf)$' -and (Test-Path -LiteralPath $_ -PathType Leaf) }

# 精确值（来自本机凭据文件）
$exact = @()
$cred = 'docs/测试服务器凭据.local.md'
if (Test-Path -LiteralPath $cred) {
  $c = [IO.File]::ReadAllText($cred, $utf8)
  $exact += [regex]::Matches($c, $ipRe) | ForEach-Object { $_.Value } | Where-Object { $_ -notmatch $ipAllow }
  $exact += [regex]::Matches($c, '(?m)^- *密码[：:] *(.+?)\s*$') | ForEach-Object { $_.Groups[1].Value }
  $exact = $exact | Sort-Object -Unique | Where-Object { $_ }
}

foreach ($f in $text) {
  $lines = [IO.File]::ReadAllLines($f, $utf8)
  for ($i = 0; $i -lt $lines.Length; $i++) {
    $l = $lines[$i]
    $where = "${f}:$($i + 1)"
    foreach ($r in $rules) { if ($l -cmatch $r[1]) { Report $r[0] "$where`:$($l.Substring(0, [Math]::Min(120, $l.Length)))" } }
    foreach ($m in [regex]::Matches($l, $ipRe)) { if ($m.Value -notmatch $ipAllow) { Report '公网IP' "$where`:$($m.Value)" } }
    foreach ($e in $exact) { if ($l.Contains($e)) { Report '凭据文件里的值' $where } }
  }
}

if ($History) {
  $h = (git log --all -p --no-color | Out-String)
  foreach ($r in $rules) {
    $n = ([regex]::Matches($h, $r[1])).Count
    if ($n -gt 0) { Report "历史:$($r[0])" "$n 处命中" }
  }
  $n = ([regex]::Matches($h, '(?m)^\+.*$') | ForEach-Object { [regex]::Matches($_.Value, $ipRe) } | Where-Object { $_.Value -notmatch $ipAllow }).Count
  if ($n -gt 0) { Report '历史:公网IP' "$n 处" }
  $mails = git log --all --format='%ae %ce' | Where-Object { $_ -notmatch 'noreply\.github\.com' }
  if ($mails) { Report '历史:提交邮箱' '存在非 noreply 的作者/提交者邮箱' }
}

if (-not $script:fail) { Write-Output "扫描通过：未发现敏感信息（$($all.Count) 个文件）"; exit 0 }
Write-Output '扫描失败：上面是需要处理的项目'
exit 1
