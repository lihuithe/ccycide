#!/bin/bash
# 运行一个脚本。先清掉从外层 Claude Code 继承来的环境变量，免得影响被测的 claude。
UNSET=$(env | grep -E '^(CLAUDE|ANTHROPIC)' | sed 's/=.*//' | grep -v GIT_BASH | sed 's/^/-u /' | tr '\n' ' ')
cd "$(dirname "$0")/../.."
exec env $UNSET target-host/debug/spike-s2.exe "$@"
