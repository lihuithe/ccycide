$exe = Join-Path (Get-Location) 'target-host\debug\hookprobe.exe'   # 在仓库根目录运行
$json = '{"hook_event_name":"Stop","session_id":"x"}'
$ts = 1..20 | ForEach-Object { (Measure-Command { $json | & $exe hook | Out-Null }).TotalMilliseconds }
$avg = [int]($ts | Measure-Object -Average).Average
$max = [int]($ts | Measure-Object -Maximum).Maximum
$min = [int]($ts | Measure-Object -Minimum).Minimum
"V17_RESULT live-server avg=${avg}ms min=${min}ms max=${max}ms"
