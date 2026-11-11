#!/bin/bash
# V12：单行斜杠命令的提交。方式 × 等待时间
cd "$(cd "$(dirname "$0")" && pwd)"
for mode in paste send; do
 for d in 0 30 80 150 300; do
  f=gen/v12-$mode-$d.txt
  cat > $f <<EOT
cwd {REPO}\tools\scratch\s2
spawn {CLAUDE_EXE}
wait 4500
$mode /context
wait $d
send \r
wait 2500
echo RESULT v12 mode=$mode delay=$d
has Context Usage
paste /exit
wait 100
send \r
waitexit 8000
EOT
  ./run.sh tools/spike-s2/$f 2>&1 | grep -E "RESULT|PASS|FAIL|NOT EXITED"
 done
done
