#!/usr/bin/env bash
# Builds packages/mac-app/build/AgentSwitch.app with its own runtime (docs/app-v0.md §4 打包):
#   Contents/Resources/runtime/node        official Node.js (darwin-arm64), bin/node only
#   Contents/Resources/runtime/daemon      packages/daemon: dist/ + package.json + production node_modules + config/ + ui/
#   Contents/Resources/runtime/python      python-build-standalone CPython with packages/secret-gate installed
#   Contents/Resources/runtime/secret-gate AGENTS.md (the gate guidance every executor gets)
# Supply chain: the Node and Python tarballs are cached in .build-cache/ and checked against the SHA-256 in
# scripts/runtime-pins.sh on every build, then extracted afresh (an extracted tree is never reused); npm ci checks
# package-lock.json's integrity hashes; Python packages come from scripts/python-requirements.txt, wheels only,
# with `pip install --require-hashes` (regenerate with scripts/lock-python.sh), and secret-gate itself is built
# offline into a wheel with the hash-pinned setuptools of scripts/python-build-requirements.txt. No absolute path
# of the build machine ends up in the bundle; the last step checks. Nothing outside packages/mac-app is written:
# the daemon and secret-gate are built from staging copies.
#
#   scripts/build-app.sh                                       full build → build/AgentSwitch.app
#   APP_OUT=build/next/AgentSwitch.app scripts/build-app.sh    same, assembled elsewhere (build/AgentSwitch.app is running)
#   SKIP_RUNTIME=1 scripts/build-app.sh                        reuse build/stage/runtime from the previous run (UI-only changes)
#   SIGN_IDENTITY=- scripts/build-app.sh                       ad-hoc signature (default: an "Apple Development" identity if any)
# A build staged at build/next/AgentSwitch.app is offered by the running app (menu, or the phone's settings); on the
# user's go-ahead the app swaps it in itself and puts itself back if the new one does not start (assistant-v0 §5).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.build-cache"
BUILD="$HERE/build"
STAGE="$BUILD/stage"
RUNTIME="$STAGE/runtime"
NODE_HOME="$STAGE/toolchain/node"
# shellcheck source=runtime-pins.sh
source "$HERE/scripts/runtime-pins.sh"

APP="${APP_OUT:-$BUILD/AgentSwitch.app}"
case "$APP" in
  /*) ;;
  *) APP="$PWD/$APP" ;;
esac
[ "$(basename "$APP")" = "AgentSwitch.app" ] || die "APP_OUT must end in /AgentSwitch.app (it is replaced): $APP"
if pgrep -f "$APP/Contents/" >/dev/null 2>&1; then
  die "$APP is running; quit it first or build elsewhere with APP_OUT=build/next/AgentSwitch.app"
fi

[ "$(uname -m)" = "arm64" ] || die "this build targets Apple silicon (arm64)"
for tool in curl shasum tar rsync xcodegen xcodebuild codesign ditto strip; do
  command -v "$tool" >/dev/null || die "missing tool: $tool"
done

# Console scripts pip writes start with `#!<absolute staging path>/python3.12`. Replace that line with the
# distlib-style sh trampoline so the bundle works wherever it is copied.
relocate_shebangs() {
  local bin="$1" f first
  for f in "$bin"/*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    first="$(head -c 2 "$f" 2>/dev/null || true)"
    [ "$first" = "#!" ] || continue
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
  log "node $NODE_VERSION"
  fetch "$NODE_URL" "$NODE_TARBALL" "$NODE_SHA256"
  rm -rf "$CACHE/node-v${NODE_VERSION}-darwin-arm64"   # where earlier builds kept a reused extracted copy
  extract "$NODE_TARBALL" "$NODE_HOME"
  [ -x "$NODE_HOME/bin/node" ] || die "unexpected Node.js layout"
  mkdir -p "$RUNTIME/node/bin"
  cp "$NODE_HOME/bin/node" "$RUNTIME/node/bin/node"
  cp "$NODE_HOME/LICENSE" "$RUNTIME/node/LICENSE"
}

build_daemon() {
  log "daemon (staging copy of packages/daemon)"
  local src="$STAGE/src/daemon"
  mkdir -p "$src"
  rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude .git "$REPO/packages/daemon/" "$src/"
  grep -q '"build"' "$src/package.json" || die "packages/daemon has no \"build\" script yet (needed: npm run build → dist/)"
  (
    cd "$src"
    export PATH="$NODE_HOME/bin:$PATH" npm_config_cache="$CACHE/npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
    npm ci --no-progress
    npm run build
    npm prune --omit=dev --no-progress
  )
  [ -f "$src/dist/cli.js" ] || die "daemon build produced no dist/cli.js"
  mkdir -p "$RUNTIME/daemon"
  for item in dist package.json node_modules config ui; do
    rsync -a --delete "$src/$item" "$RUNTIME/daemon/"
  done
  mkdir -p "$RUNTIME/secret-gate"
  cp "$REPO/packages/secret-gate/AGENTS.md" "$RUNTIME/secret-gate/AGENTS.md"
}

build_python() {
  log "python $PYTHON_VERSION (python-build-standalone $PBS_RELEASE) + secret-gate"
  fetch "$PYTHON_URL" "$PYTHON_TARBALL" "$PYTHON_SHA256"
  extract "$PYTHON_TARBALL" "$RUNTIME/python"
  local py="$RUNTIME/python/bin/python$PY_MINOR"
  [ -x "$py" ] || die "unexpected python-build-standalone layout"
  local pip=(env PIP_CACHE_DIR="$CACHE/pip" "$py" -m pip --quiet --disable-pip-version-check --no-input)

  # Dependencies: exactly the hash-pinned wheels, nothing resolved or built here.
  "${pip[@]}" install --no-warn-script-location --require-hashes --only-binary=:all: \
    -r "$HERE/scripts/python-requirements.txt"

  # secret-gate: a wheel built offline by the hash-pinned setuptools (kept outside the bundle), installed by name
  # from that wheel. A path or file URL install would record the build machine's path in direct_url.json.
  local src="$STAGE/src/secret-gate" tools="$STAGE/toolchain/py-build" wheels="$STAGE/wheels"
  mkdir -p "$src"
  rsync -a --delete --exclude .venv --exclude tests --exclude '*.egg-info' --exclude __pycache__ --exclude build \
    "$REPO/packages/secret-gate/" "$src/"
  rm -rf "$tools" "$wheels"
  "${pip[@]}" install --require-hashes --only-binary=:all: --target "$tools" \
    -r "$HERE/scripts/python-build-requirements.txt"
  PYTHONPATH="$tools" "${pip[@]}" wheel --no-deps --no-build-isolation --no-index -w "$wheels" "$src"
  "${pip[@]}" install --no-warn-script-location --no-deps --no-index --find-links "$wheels" secret-gate
  "$py" -I -m pip check --disable-pip-version-check

  # Trim what a proxy never needs, then precompile so nothing is written into the signed bundle at runtime.
  local lib="$RUNTIME/python/lib/python$PY_MINOR"
  rm -rf "$lib/test" "$lib/idlelib" "$lib/tkinter" "$lib/turtledemo" "$lib/ensurepip" "$lib/lib2to3" \
         "$RUNTIME/python/share" "$RUNTIME/python/include"
  rm -rf "$RUNTIME/python/lib/"tcl* "$RUNTIME/python/lib/"tk* "$RUNTIME/python/lib/"itcl* "$RUNTIME/python/lib/"thread* \
         "$RUNTIME/python/lib/"libtcl* "$lib/lib-dynload/"_tkinter* "$lib/site-packages/"pip "$lib/site-packages/"pip-*
  (cd "$RUNTIME/python/bin" && rm -f pip pip3* idle3* 2to3* pydoc3* python3*-config)
  find "$RUNTIME/python" -name __pycache__ -type d -prune -exec rm -rf {} +
  # -s/-p: the source path in each .pyc starts at runtime/ instead of this machine's staging directory (the
  # import system substitutes the real location when it loads the file, so tracebacks still point at it).
  # -B -f: the compiling interpreter would otherwise cache its own imports (encodings, multiprocessing, ...) with
  # the full path first, and compileall would then skip them as up to date.
  "$py" -I -B -m compileall -q -f -j 0 -s "$RUNTIME" -p runtime "$lib" >/dev/null || true

  relocate_shebangs "$RUNTIME/python/bin"
  # The entry point the app and the daemon use (SECRET_GATE_BIN). -I: no cwd or user site on sys.path, so a
  # task directory can never shadow the gate's modules; -B: never write bytecode into the bundle.
  cat > "$RUNTIME/python/bin/secret-gate" <<SH
#!/bin/sh
# secret-gate, relocatable: the bundled interpreter runs the CLI module.
exec "\$(dirname -- "\$0")/python$PY_MINOR" -I -B -m secret_gate.cli "\$@"
SH
  chmod 755 "$RUNTIME/python/bin/secret-gate"
  if grep -rlI "$STAGE" "$RUNTIME/python/bin" >/dev/null 2>&1; then
    die "absolute staging paths left in python/bin: $(grep -rlI "$STAGE" "$RUNTIME/python/bin" | tr '\n' ' ')"
  fi
}

write_versions() {
  local daemon_version gate_version mitm_version
  daemon_version="$("$RUNTIME/node/bin/node" -p "require('$RUNTIME/daemon/package.json').version")"
  gate_version="$("$RUNTIME/python/bin/secret-gate" --version)"
  mitm_version="$("$RUNTIME/python/bin/python$PY_MINOR" -I -B -c 'import importlib.metadata as m; print(m.version("mitmproxy"))')"
  cat > "$RUNTIME/VERSIONS" <<EOF
node=$NODE_VERSION
python=$PYTHON_VERSION (python-build-standalone $PBS_RELEASE)
daemon=$daemon_version
secret-gate=$gate_version
mitmproxy=$mitm_version
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

smoke_runtime() {
  log "runtime self-check"
  "$RUNTIME/node/bin/node" --version
  "$RUNTIME/python/bin/secret-gate" --version
  "$RUNTIME/python/bin/python$PY_MINOR" -I -B -c 'import secret_gate.cli, nacl, mitmproxy, mcp, httpx; print("python imports ok")'
  [ -x "$RUNTIME/python/bin/mitmdump" ] || die "mitmdump missing"
  "$RUNTIME/python/bin/mitmdump" --version | head -1
}

build_app() {
  log "xcodegen + xcodebuild (Release)"
  (cd "$HERE" && xcodegen generate --quiet)
  xcodebuild -project "$HERE/AgentSwitch.xcodeproj" -scheme AgentSwitch -configuration Release \
    -derivedDataPath "$BUILD/DerivedData" -quiet build
  local product="$BUILD/DerivedData/Build/Products/Release/AgentSwitch.app"
  [ -d "$product" ] || die "xcodebuild produced no app"
  rm -rf "$APP"
  mkdir -p "$(dirname "$APP")"
  ditto "$product" "$APP"
  # The debug map (object file paths under DerivedData) and local symbols; the dSYM stays in DerivedData.
  strip -S -x "$APP/Contents/MacOS/AgentSwitch"
}

# The bundle must not carry this machine's paths (user name, checkout location): direct_url.json, .pyc source
# paths and the executable's debug map used to.
check_no_build_paths() {
  log "checking the bundle for build-machine paths"
  local hits
  hits="$(LC_ALL=C grep -rlaF -e "$REPO" -e "$HOME/" "$APP" 2>/dev/null || true)"
  [ -z "$hits" ] || die "build-machine paths in the bundle: $(printf '%s\n' "$hits" | head -20 | tr '\n' ' ')"
  echo "no $HOME/ or $REPO paths"
}

mkdir -p "$BUILD"
if [ "${SKIP_RUNTIME:-0}" = "1" ] && [ -f "$RUNTIME/VERSIONS" ]; then
  log "reusing $RUNTIME"
else
  rm -rf "$RUNTIME"
  mkdir -p "$RUNTIME"
  build_node
  build_python
  build_daemon
  write_versions
fi
smoke_runtime
build_app

log "assembling $APP"
ditto "$RUNTIME" "$APP/Contents/Resources/runtime"
check_no_build_paths
# A stable identity keeps macOS's privacy grants (Files and Folders, …) across rebuilds: an ad-hoc signature is known
# by its hash, so to TCC every new build is a new app and the user is asked again (2026-09-25). SIGN_IDENTITY picks
# one (`-` = ad-hoc); by default the first "Apple Development" identity in the keychain, else ad-hoc.
SIGN="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -n 1)}"
SIGN="${SIGN:--}"
codesign --force --deep --timestamp=none --sign "$SIGN" "$APP"
codesign --verify --deep --strict "$APP" && if [ "$SIGN" = "-" ]; then echo "signature ok (ad-hoc)"; else echo "signature ok (development identity: stable across builds)"; fi

log "done"
cat "$RUNTIME/VERSIONS"
du -sh "$APP"
du -sh "$APP/Contents/Resources/runtime/"* | sed 's|'"$APP"'/Contents/Resources/||'
