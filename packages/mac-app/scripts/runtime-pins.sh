# Pinned downloads of the bundled runtime, sourced by build-app.sh and lock-python.sh (not run on its own).
# A new Node or Python means a new version, a new SHA-256 from the release's own checksum list, and for Python a
# fresh scripts/lock-python.sh run.
# shellcheck shell=bash

NODE_VERSION="24.21.0"
NODE_SHA256="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
NODE_TARBALL="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

PBS_RELEASE="20260901"
PYTHON_VERSION="3.12.14"
PYTHON_SHA256="3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76"
PYTHON_TARBALL="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PYTHON_VERSION}%2B${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PY_MINOR="3.12"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# fetch <url> <file> <sha256>: download once into $CACHE, verify on every call (a cached tarball is re-hashed
# before each use; a mismatch deletes it and stops the build).
fetch() {
  local url="$1" file="$CACHE/$2" sha="$3"
  mkdir -p "$CACHE"
  if [ ! -f "$file" ]; then
    log "downloading $2"
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  local got
  got="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [ "$got" != "$sha" ]; then
    rm -f "$file"
    die "SHA-256 mismatch for $2: expected $sha, got $got (cached copy removed)"
  fi
  echo "verified $2 ($sha)"
}

# extract <tarball in $CACHE> <dir>: a fresh tree from the verified tarball, replacing whatever was at <dir>.
# Extracted trees are never reused across builds, so nothing left in a cache or staging directory is trusted.
extract() {
  local tarball="$CACHE/$1" dir="$2"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$tarball" -C "$dir" --strip-components 1
}
