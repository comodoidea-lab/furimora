#!/usr/bin/env bash
# Obscura の公式リリースバイナリを poc/obscura/obscura-bin/ に取得する。
# 対象: https://github.com/h4ckf0r0day/obscura/releases
set -euo pipefail

VERSION="${OBSCURA_VERSION:-v0.2.1}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/obscura-bin"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  ASSET="obscura-aarch64-macos-stealth.tar.gz" ;;
  Darwin-x86_64) ASSET="obscura-x86_64-macos-stealth.tar.gz" ;;
  Linux-aarch64) ASSET="obscura-aarch64-linux-stealth.tar.gz" ;;
  Linux-x86_64)  ASSET="obscura-x86_64-linux-stealth.tar.gz" ;;
  *) echo "未対応のプラットフォーム: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$DIR"
echo "取得中: $ASSET ($VERSION)"
curl -fsSL -o "$DIR/obscura.tar.gz" \
  "https://github.com/h4ckf0r0day/obscura/releases/download/${VERSION}/${ASSET}"
tar xzf "$DIR/obscura.tar.gz" -C "$DIR"
[ "$(uname -s)" = "Darwin" ] && xattr -d com.apple.quarantine "$DIR/obscura" 2>/dev/null || true
"$DIR/obscura" --version
