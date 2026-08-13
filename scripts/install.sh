#!/usr/bin/env bash
# scripts/install.sh — one-line installer for wenchat
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dkisser/wenchat/main/scripts/install.sh | bash
#
# Env overrides:
#   WENCHAT_VERSION=v0.1.1      Pin a specific release (skip "latest" lookup)
#   WENCHAT_INSTALL_DIR=/path   Override install location (default: $HOME/.local/bin)
set -euo pipefail

REPO="dkisser/wenchat"
INSTALL_DIR="${WENCHAT_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="wenchat"

# --- 1. Platform detection ---------------------------------------------------
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS-$ARCH" in
	linux-x86_64) TARGET=linux-x64 ;;
	darwin-arm64) TARGET=darwin-arm64 ;;
	darwin-x86_64)
		echo "Error: Intel Mac (x86_64) is not in the current build matrix." >&2
		echo "Use Apple Silicon, or build from source for Intel Macs." >&2
		exit 1
		;;
	*)
		echo "Error: unsupported platform $OS-$ARCH" >&2
		echo "Supported: linux-x86_64, darwin-arm64" >&2
		exit 1
		;;
esac

# --- 2. Resolve version ------------------------------------------------------
if [ -n "${WENCHAT_VERSION:-}" ]; then
	VERSION="$WENCHAT_VERSION"
else
	if ! VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
		| grep '"tag_name"' | head -1 | cut -d'"' -f4); then
		echo "Error: failed to fetch latest release from GitHub API." >&2
		echo "Set WENCHAT_VERSION=v0.1.1 to install a specific version." >&2
		exit 1
	fi
fi
if [ -z "$VERSION" ]; then
	echo "Error: could not determine version." >&2
	exit 1
fi

# --- 3. Download binary ------------------------------------------------------
URL="https://github.com/$REPO/releases/download/$VERSION/wenchat-$VERSION-$TARGET"
TMP=$(mktemp)
TMP_DIR=$(dirname "$TMP")
TMP_BASE=$(basename "$TMP")
# Keep the .exe extension on Windows-style temp files when invoked from MSYS/Git-Bash.
if [ -n "${MSYSTEM:-}" ] || [ "$OS" = "windows" ]; then
	TMP="$TMP_DIR/${TMP_BASE}.exe"
fi
trap 'rm -f "$TMP"' EXIT

echo "Downloading wenchat $VERSION for $TARGET ..."
if ! curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$URL"; then
	echo "Error: download failed from $URL" >&2
	echo "Check that release $VERSION exists at https://github.com/$REPO/releases" >&2
	exit 1
fi
chmod +x "$TMP"

# --- 4. Install to PATH ------------------------------------------------------
if [ ! -d "$INSTALL_DIR" ]; then
	mkdir -p "$INSTALL_DIR" || {
		echo "Error: cannot create $INSTALL_DIR (need sudo? Set WENCHAT_INSTALL_DIR to a writable path)" >&2
		exit 1
	}
fi
INSTALL_PATH="$INSTALL_DIR/$BIN_NAME"
if [ -e "$INSTALL_PATH" ]; then
	rm -f "$INSTALL_PATH"
fi
mv "$TMP" "$INSTALL_PATH"

# --- 5. PATH advisory --------------------------------------------------------
case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*)
		echo "" >&2
		echo "Note: $INSTALL_DIR is not in your PATH." >&2
		echo "Add to your shell rc and restart the shell, or run with full path:" >&2
		echo "    export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
		echo "" >&2
		;;
esac

# --- 6. Platform-specific first-run advisory --------------------------------
if [ "$OS" = "darwin" ]; then
	echo "Note (macOS): on first run, Finder may show 'unidentified developer'." >&2
	echo "  Right-click $INSTALL_PATH in Finder -> Open -> confirm." >&2
	echo "  This is a one-time gatekeeper prompt for unsigned binaries." >&2
fi

echo ""
echo "Installed wenchat $VERSION -> $INSTALL_PATH"
echo "Try it: wenchat alice   (or: $INSTALL_PATH alice)"
