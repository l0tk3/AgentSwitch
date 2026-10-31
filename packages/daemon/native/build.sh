#!/bin/sh
# Builds pty-hold.c, the terminals' holder (docs/terminal-v0.md §10), with this machine's C compiler:
#   native/build.sh            → native/build/pty-hold   (where the daemon looks for it, from a checkout and in a runtime)
#   native/build.sh <out>      → <out>
# `npm run build` runs it; the Mac app's and the Linux node's runtimes are built with it (build-app.sh, build-runtime.sh).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/build/pty-hold}
mkdir -p "$(dirname "$out")"
case "$(uname -s)" in Linux) libs=-lutil ;; *) libs= ;; esac
# shellcheck disable=SC2086
${CC:-cc} -std=c11 -O2 -Wall -Wextra -o "$out.tmp" "$here/pty-hold.c" $libs
mv "$out.tmp" "$out"
