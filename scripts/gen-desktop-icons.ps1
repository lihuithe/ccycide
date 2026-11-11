# 生成桌面端图标源图：icon-source.png（应用图标 1024px）、tray-idle.png / tray-active.png（托盘 64px，active 带绿点）
# 用法：powershell -File scripts/gen-desktop-icons.ps1
# 之后：cd apps/desktop; npx tauri icon src-tauri/icons/icon-source.png -o src-tauri/icons
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Icon([int]$size, [bool]$dot, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [float]$size
  $bg = New-RoundRect ($s * 0.04) ($s * 0.04) ($s * 0.92) ($s * 0.92) ($s * 0.2)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 28, 38))), $bg)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 94, 234, 212)), ($s * 0.075)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $g.DrawLines($pen, @(
    (New-Object System.Drawing.PointF ($s * 0.26), ($s * 0.34)),
    (New-Object System.Drawing.PointF ($s * 0.46), ($s * 0.5)),
    (New-Object System.Drawing.PointF ($s * 0.26), ($s * 0.66))))
  $g.DrawLine($pen, ($s * 0.54), ($s * 0.68), ($s * 0.76), ($s * 0.68))
  if ($dot) {
    $r = $s * 0.2
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))), ($s * 0.96 - $r * 2), ($s * 0.96 - $r * 2), ($r * 2), ($r * 2))
  }
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

New-Icon 1024 $false (Join-Path $out 'icon-source.png')
New-Icon 64 $false (Join-Path $out 'tray-idle.png')
New-Icon 64 $true (Join-Path $out 'tray-active.png')
Write-Host "图标已生成到 $out"
