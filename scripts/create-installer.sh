#!/usr/bin/env bash
# create-installer.sh
# Runs electron-builder to produce the installer (dmg/exe).
# This is the ONLY build stage that needs code-signing secrets.
#
# Expects the frontend to be built and python-embed to be ready.
# See local-build.sh for the convenience wrapper that runs all stages.
#
# Usage:
#   bash scripts/create-installer.sh [options]
#
# Options:
#   --platform mac|win   Target platform (auto-detected if omitted)
#   --publish <mode>     Publish mode for electron-builder (always|never|onTag)
#   --unpack             Build unpacked app only (faster, no installer/dmg)

set -euo pipefail

# ============================================================
# Parse arguments
# ============================================================
UNPACK=false
PLATFORM=""
PUBLISH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unpack) UNPACK=true ;;
    --publish)
      PUBLISH="$2"
      shift
      ;;
    --platform)
      PLATFORM="$2"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--platform mac|win] [--publish always|never|onTag] [--unpack]"
      exit 1
      ;;
  esac
  shift
done

# Auto-detect platform if not specified
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin)          PLATFORM="mac" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="win" ;;
    Linux)           PLATFORM="linux" ;;
    *)               echo "ERROR: Could not detect platform. Use --platform mac|win"; exit 1 ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$PROJECT_DIR/release"
BACKEND_DIR="$PROJECT_DIR/backend"
HASH_FILE="$PROJECT_DIR/python-deps-hash.txt"
EMBEDDED_HASH_FILE="$PROJECT_DIR/python-embed/deps-hash.txt"

cd "$PROJECT_DIR"

if [ -z "${LTX_RELEASE_OWNER:-}" ] || [ -z "${LTX_RELEASE_REPO:-}" ]; then
  PACKAGE_HOMEPAGE="$(node -e "const pkg=require('./package.json'); process.stdout.write(typeof pkg.homepage==='string' ? pkg.homepage : '')")"
  if [ -n "$PACKAGE_HOMEPAGE" ]; then
    REPO_PATH="$(node -e "const homepage=process.argv[1]; try { const u=new URL(homepage); if (/github\\.com$/i.test(u.host)) process.stdout.write(u.pathname.replace(/^\\/+|\\/+$/g,'')); } catch {}" "$PACKAGE_HOMEPAGE")"
    if [ -n "$REPO_PATH" ]; then
      RELEASE_OWNER_FROM_HOMEPAGE="${REPO_PATH%%/*}"
      RELEASE_REPO_FROM_HOMEPAGE="${REPO_PATH#*/}"
      if [ -z "${LTX_RELEASE_OWNER:-}" ]; then export LTX_RELEASE_OWNER="$RELEASE_OWNER_FROM_HOMEPAGE"; fi
      if [ -z "${LTX_RELEASE_REPO:-}" ]; then export LTX_RELEASE_REPO="$RELEASE_REPO_FROM_HOMEPAGE"; fi
    fi
  fi
fi

export LTX_RELEASE_OWNER="${LTX_RELEASE_OWNER:-Lightricks}"
export LTX_RELEASE_REPO="${LTX_RELEASE_REPO:-ltx-desktop}"
echo "Release source: $LTX_RELEASE_OWNER/$LTX_RELEASE_REPO"

# ============================================================
# Verify prerequisites
# ============================================================
if [ ! -d "dist" ] || [ ! -d "dist-electron" ]; then
  echo "ERROR: Frontend not built. Run local-build.sh or 'npm run build:frontend' first."
  exit 1
fi

if [ "$PLATFORM" != "linux" ] && [ ! -d "python-embed" ]; then
  echo "ERROR: Python environment not found. Run local-build.sh or prepare-python.sh first."
  exit 1
fi

echo "Generating python dependency hash..."
PYTHON_VERSION="$(tr -d '[:space:]' < "$BACKEND_DIR/.python-version")"
if command -v sha256sum >/dev/null 2>&1; then
  LOCK_HASH="$(sha256sum "$BACKEND_DIR/uv.lock" | awk '{print $1}')"
  DEPS_HASH="$(printf 'platform=%s\npython-version=%s\nuv-lock=%s' "$PLATFORM" "$PYTHON_VERSION" "$LOCK_HASH" | sha256sum | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  LOCK_HASH="$(shasum -a 256 "$BACKEND_DIR/uv.lock" | awk '{print $1}')"
  DEPS_HASH="$(printf 'platform=%s\npython-version=%s\nuv-lock=%s' "$PLATFORM" "$PYTHON_VERSION" "$LOCK_HASH" | shasum -a 256 | awk '{print $1}')"
else
  echo "ERROR: sha256sum or shasum is required to generate python-deps-hash.txt"
  exit 1
fi
printf '%s' "$DEPS_HASH" > "$HASH_FILE"
printf '%s' "$DEPS_HASH" > "$EMBEDDED_HASH_FILE"
echo "Python deps hash: $DEPS_HASH"

# ============================================================
# Build with electron-builder
# ============================================================
BUILDER_ARGS=""
case "$PLATFORM" in
  mac)   BUILDER_ARGS="--mac" ;;
  win)   BUILDER_ARGS="--win" ;;
  linux) BUILDER_ARGS="--linux" ;;
esac

if [ "$UNPACK" = true ]; then
  echo "Packaging unpacked app (fast mode)..."
  pnpm exec electron-builder $BUILDER_ARGS --dir
else
  PUBLISH_ARGS=""
  if [ -n "$PUBLISH" ]; then
    PUBLISH_ARGS="--publish $PUBLISH"
  fi
  echo "Packaging installer..."
  pnpm exec electron-builder $BUILDER_ARGS $PUBLISH_ARGS
fi
echo ""

# ============================================================
# Summary
# ============================================================
echo "========================================"
echo "  Build Complete!"
echo "========================================"

if [ "$UNPACK" = true ]; then
  case "$PLATFORM" in
    mac)
      echo ""
      echo "Unpacked app ready!"
      echo "Run: open \"$RELEASE_DIR/mac-arm64/LTX Desktop.app\""
      ;;
    win)
      echo ""
      echo "Unpacked app ready!"
      echo "Run: $RELEASE_DIR/win-unpacked/LTX Desktop.exe"
      ;;
    linux)
      echo ""
      echo "Unpacked app ready!"
      LINUX_UNPACKED="$RELEASE_DIR/linux-unpacked"
      [ -d "$RELEASE_DIR/linux-arm64-unpacked" ] && LINUX_UNPACKED="$RELEASE_DIR/linux-arm64-unpacked"
      echo "Run: $LINUX_UNPACKED/ltx-desktop"
      ;;
  esac
else
  echo ""
  echo "Output: $RELEASE_DIR/"
  ls -1 "$RELEASE_DIR/" 2>/dev/null | head -10
fi

echo ""
echo "Note: AI models (~150GB) will be downloaded on first run."
