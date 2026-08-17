#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: build.sh <arm64|x86_64> <absolute-output>" >&2
  exit 64
fi

architecture=$1
output=$2
case "$architecture" in
  arm64|x86_64) ;;
  *) echo "unsupported architecture: $architecture" >&2; exit 64 ;;
esac
case "$output" in
  /*) ;;
  *) echo "output must be absolute" >&2; exit 64 ;;
esac

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sdk_root=$(xcrun --sdk macosx --show-sdk-path)
mkdir -p "$(dirname -- "$output")"
xcrun --sdk macosx clang \
  -std=c17 -O2 -Wall -Wextra -Werror -pedantic \
  -arch "$architecture" \
  -isysroot "$sdk_root" \
  -mmacosx-version-min=12.0 \
  -Wl,-dead_strip -Wl,-no_uuid \
  "$script_directory/process-capsule.c" \
  -o "$output"
chmod 0755 "$output"
