#!/bin/sh
# Ada Egg one-line installer.
#   curl -fsSL https://raw.githubusercontent.com/langadventurellc/adaegg/main/install.sh | bash
#   curl -fsSL <url> | bash -s -- my-hatchling --skip-check
# Arguments pass through to `adaegg init`. ADAEGG_SOURCE=<dir> uses a clone instead of downloading;
# ADAEGG_REF=<ref> picks the branch or tag to download (default main).
set -eu

# The whole body is a function called on the last line, so a truncated download runs nothing.
main() {
  fail() {
    echo "adaegg install: $1" >&2
    exit 1
  }

  case "$(uname -s)" in
    Linux | Darwin) ;;
    *) fail "this system is not supported yet (Linux and macOS only; Windows is not supported yet)." ;;
  esac

  command -v node >/dev/null 2>&1 || fail "node was not found. Install Node 24 or newer from https://nodejs.org."
  node_version=$(node -v)
  node_major=${node_version#v}
  node_major=${node_major%%.*}
  case "$node_major" in
    '' | *[!0-9]*) fail "could not read the Node version (found '$node_version'). Install Node 24 or newer from https://nodejs.org." ;;
  esac
  if [ "$node_major" -lt 24 ]; then
    fail "Node 24 or newer is needed, found $node_version. Install it from https://nodejs.org."
  fi

  command -v git >/dev/null 2>&1 || fail "git was not found. Install git first."
  command -v tar >/dev/null 2>&1 || fail "tar was not found. Install tar first."
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    fail "curl or wget is needed to download Ada Egg, and neither was found."
  fi

  if [ -n "${ADAEGG_SOURCE:-}" ]; then
    [ -d "$ADAEGG_SOURCE" ] || fail "ADAEGG_SOURCE is not a directory: $ADAEGG_SOURCE"
    src=${ADAEGG_SOURCE%/}
  else
    ref=${ADAEGG_REF:-main}
    url="https://codeload.github.com/langadventurellc/adaegg/tar.gz/$ref"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    echo "Downloading Ada Egg ($ref)..."
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$url" -o "$tmp/src.tar.gz" || fail "download failed: $url"
    else
      wget -qO "$tmp/src.tar.gz" "$url" || fail "download failed: $url"
    fi
    src="$tmp/src"
    mkdir "$src"
    tar -xzf "$tmp/src.tar.gz" -C "$src" --strip-components=1 || fail "could not extract the download."
  fi

  [ -f "$src/installer/main.ts" ] || fail "installer not found in $src."

  echo "Creating your hatchling..."
  # stdin from /dev/null: when this script is piped into the shell, the child would read the rest of it.
  # Not exec'ed, so the trap still removes the temporary directory.
  status=0
  node "$src/installer/main.ts" init "$@" </dev/null || status=$?
  exit "$status"
}

main "$@"
