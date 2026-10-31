#!/usr/bin/env bash
# Builds a self-contained AgentSwitch runtime for this Linux machine's architecture (docs/mesh-v0.md §4.1), the same
# parts as the Mac app's Contents/Resources/runtime (packages/mac-app/scripts/build-app.sh):
#
#   <out>/node/bin/node           Node.js (runtime-pins.sh), the only node the daemon and the keeper run on
#   <out>/daemon/                 packages/daemon built (dist, config, ui, production node_modules, node-pty compiled here,
#                                 native/build/pty-hold: the terminals' holder)
#   <out>/python/bin/secret-gate  CPython from python-build-standalone with secret-gate and its hash-pinned dependencies
#   <out>/secret-gate/AGENTS.md   what every executor is told about ciphertexts
#   <out>/VERSIONS
#
#   scripts/build-runtime.sh <out>   <out> must not exist yet. Needs curl, tar, rsync, sha256sum and what node-gyp needs
#                                    to compile node-pty (make, a C++ compiler, python3). The Python packages are
#                                    installed with uv when there is one (it honours ALL_PROXY), else with pip.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CACHE="${AGENTSWITCH_BUILD_CACHE:-$HERE/.build-cache}"
# shellcheck source=runtime-pins.sh
source "$HERE/scripts/runtime-pins.sh"

OUT="${1:-}"
[ -n "$OUT" ] || die "usage: build-runtime.sh <out>"
[ ! -e "$OUT" ] || die "$OUT exists"
for tool in curl tar rsync sha256sum make; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
command -v g++ >/dev/null || command -v clang++ >/dev/null || die "missing a C++ compiler (node-pty is compiled here)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/agentswitch-build.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
NODE_HOME="$STAGE/node"

# Console scripts pip writes start with `#!<absolute path>/python3.12`; the distlib-style sh trampoline instead finds
# the interpreter next to the script, so the runtime works wherever it is moved (build-app.sh does the same).
relocate_shebangs() {
  local bin="$1" f
  for f in "$bin"/*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    [ "$(head -c 2 "$f" 2>/dev/null || true)" = "#!" ] || continue
    if head -n 1 "$f" | grep -q "^#!/.*python"; then
      {
        printf '#!/bin/sh\n'
        printf "'''exec' \"\$(dirname -- \"\$0\")/python%s\" -I -B \"\$0\" \"\$@\"\n" "$PY_MINOR"
        printf "' '''\n"
        tail -n +2 "$f"
      } > "$f.reloc"
      chmod 755 "$f.reloc"
      mv "$f.reloc" "$f"
    fi
  done
}

build_node() {
  log "node $NODE_VERSION ($ARCH)"
  fetch "$NODE_URL" "$NODE_TARBALL" "$NODE_SHA256"
  extract "$NODE_TARBALL" "$NODE_HOME"
  [ -x "$NODE_HOME/bin/node" ] || die "unexpected Node.js layout"
  mkdir -p "$OUT/node/bin"
  cp "$NODE_HOME/bin/node" "$OUT/node/bin/node"
  cp "$NODE_HOME/LICENSE" "$OUT/node/LICENSE"
}

build_daemon() {
  log "daemon (staging copy of packages/daemon)"
  local src="$STAGE/src/daemon"
  mkdir -p "$src"
  rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude .git "$REPO/packages/daemon/" "$src/"
  (
    cd "$src"
    # The runtime's own node and npm: node-pty is compiled against the node that will load it.
    export PATH="$NODE_HOME/bin:$PATH" npm_config_cache="$CACHE/npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
    # npm and node-gyp take HTTP proxies only: a SOCKS one (there for uv) would stop node-gyp fetching Node's headers.
    for v in ALL_PROXY all_proxy HTTPS_PROXY https_proxy HTTP_PROXY http_proxy; do
      case "${!v:-}" in socks*) unset "$v" ;; esac
    done
    npm ci --no-progress
    npm run build
    npm prune --omit=dev --no-progress
    # node-pty ships no Linux prebuild: it was compiled into build/Release by `npm ci`; the other systems' go.
    rm -rf node_modules/node-pty/prebuilds
    [ -f node_modules/node-pty/build/Release/pty.node ] || die "node-pty was not compiled (make, a C++ compiler and python3 are needed)"
  )
  [ -f "$src/dist/cli.js" ] || die "daemon build produced no dist/cli.js"
  # The terminals' holder (docs/terminal-v0.md §10), compiled by `npm run build` with this machine's C compiler.
  [ -x "$src/native/build/pty-hold" ] || die "daemon build produced no native/build/pty-hold (a C compiler is needed)"
  mkdir -p "$OUT/daemon/native"
  for item in dist package.json node_modules config ui; do rsync -a "$src/$item" "$OUT/daemon/"; done
  rsync -a "$src/native/build" "$OUT/daemon/native/"
  mkdir -p "$OUT/secret-gate"
  cp "$REPO/packages/secret-gate/AGENTS.md" "$OUT/secret-gate/AGENTS.md"
}

build_python() {
  log "python $PYTHON_VERSION (python-build-standalone $PBS_RELEASE) + secret-gate"
  fetch "$PYTHON_URL" "$PYTHON_TARBALL" "$PYTHON_SHA256"
  extract "$PYTHON_TARBALL" "$OUT/python"
  local py="$OUT/python/bin/python$PY_MINOR"
  [ -x "$py" ] || die "unexpected python-build-standalone layout"
  local pip=(env PIP_CACHE_DIR="$CACHE/pip" "$py" -m pip --quiet --disable-pip-version-check --no-input)

  # Dependencies: exactly the hash-pinned wheels, nothing resolved or built here.
  local lock="$HERE/scripts/python-requirements-$ARCH.txt"
  if command -v uv >/dev/null; then
    UV_CACHE_DIR="$CACHE/uv" uv pip install --quiet --python "$py" --break-system-packages --require-hashes --only-binary :all: \
      --index-url https://pypi.org/simple -r "$lock"
  else
    "${pip[@]}" install --no-warn-script-location --require-hashes --only-binary=:all: -r "$lock"
  fi

  # secret-gate: a wheel built offline by the hash-pinned setuptools (outside the runtime), installed from that wheel.
  local src="$STAGE/src/secret-gate" tools="$STAGE/toolchain/py-build" wheels="$STAGE/wheels"
  mkdir -p "$src"
  rsync -a --delete --exclude .venv --exclude tests --exclude '*.egg-info' --exclude __pycache__ --exclude build \
    "$REPO/packages/secret-gate/" "$src/"
  if command -v uv >/dev/null; then
    UV_CACHE_DIR="$CACHE/uv" uv pip install --quiet --python "$py" --target "$tools" --require-hashes --only-binary :all: \
      --index-url https://pypi.org/simple -r "$HERE/scripts/python-build-requirements.txt"
  else
    "${pip[@]}" install --require-hashes --only-binary=:all: --target "$tools" -r "$HERE/scripts/python-build-requirements.txt"
  fi
  PYTHONPATH="$tools" "${pip[@]}" wheel --no-deps --no-build-isolation --no-index -w "$wheels" "$src"
  "${pip[@]}" install --no-warn-script-location --no-deps --no-index --find-links "$wheels" secret-gate
  "$py" -I -m pip check --disable-pip-version-check

  # Trim what a proxy never needs, then precompile, as build-app.sh does.
  local lib="$OUT/python/lib/python$PY_MINOR"
  rm -rf "$lib/test" "$lib/idlelib" "$lib/tkinter" "$lib/turtledemo" "$lib/ensurepip" "$lib/lib2to3" \
         "$OUT/python/share" "$OUT/python/include"
  rm -rf "$OUT/python/lib/"tcl* "$OUT/python/lib/"tk* "$OUT/python/lib/"itcl* "$OUT/python/lib/"thread* \
         "$OUT/python/lib/"libtcl* "$lib/lib-dynload/"_tkinter* "$lib/site-packages/"pip "$lib/site-packages/"pip-*
  (cd "$OUT/python/bin" && rm -f pip pip3* idle3* 2to3* pydoc3* python3*-config)
  find "$OUT/python" -name __pycache__ -type d -prune -exec rm -rf {} +
  "$py" -I -B -m compileall -q -f -j 0 -s "$OUT" -p runtime "$lib" >/dev/null || true

  relocate_shebangs "$OUT/python/bin"
  cat > "$OUT/python/bin/secret-gate" <<SH
#!/bin/sh
# secret-gate, relocatable: the runtime's interpreter runs the CLI module.
exec "\$(dirname -- "\$0")/python$PY_MINOR" -I -B -m secret_gate.cli "\$@"
SH
  chmod 755 "$OUT/python/bin/secret-gate"
}

write_versions() {
  cat > "$OUT/VERSIONS" <<EOF
node=$NODE_VERSION
python=$PYTHON_VERSION (python-build-standalone $PBS_RELEASE)
daemon=$("$OUT/node/bin/node" -p "require('$OUT/daemon/package.json').version")
secret-gate=$("$OUT/python/bin/secret-gate" --version)
mitmproxy=$("$OUT/python/bin/python$PY_MINOR" -I -B -c 'import importlib.metadata as m; print(m.version("mitmproxy"))')
commit=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)$(git -C "$REPO" diff --quiet HEAD 2>/dev/null || echo "+changes")
arch=$ARCH
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

smoke_runtime() {
  log "runtime self-check"
  "$OUT/node/bin/node" --version
  "$OUT/node/bin/node" -e "require('$OUT/daemon/node_modules/node-pty'); console.log('node-pty loads')"
  [ -x "$OUT/daemon/native/build/pty-hold" ] && echo "pty-hold is there"
  "$OUT/node/bin/node" --no-warnings=ExperimentalWarning "$OUT/daemon/dist/cli.js" --help >/dev/null
  "$OUT/python/bin/secret-gate" --version
  "$OUT/python/bin/python$PY_MINOR" -I -B -c 'import secret_gate.cli, nacl, mitmproxy, mcp, httpx; print("python imports ok")'
  "$OUT/python/bin/mitmdump" --version | head -1
}

build_node
build_daemon
build_python
write_versions
smoke_runtime
log "built $OUT"
cat "$OUT/VERSIONS"
