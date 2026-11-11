#!/bin/bash
# 与 run.sh 相同，但用旁边带有 conpty.dll / OpenConsole.exe 的副本（自带新版 ConPTY）
UNSET=$(env | grep -E '^(CLAUDE|ANTHROPIC)' | sed 's/=.*//' | grep -v GIT_BASH | sed 's/^/-u /' | tr '\n' ' ')
cp ./target-host/debug/spike-s2.exe ./tools/scratch/side/spike-s2.exe
cd "$(dirname "$0")/../.."
exec env $UNSET tools/scratch/side/spike-s2.exe "$@"
