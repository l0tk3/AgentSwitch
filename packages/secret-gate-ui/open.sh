#!/usr/bin/env bash
# 双击或在终端运行即可打开 secret-gate 界面。首次会编译（几秒到一分钟）。
cd "$(dirname "$0")"
swift build -c release 2>&1 | grep -E "error|Build complete" || true
exec .build/release/SecretGateUI
