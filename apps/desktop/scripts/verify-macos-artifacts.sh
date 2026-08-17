#!/usr/bin/env bash
# Verify the native macOS Forge payload, archive, signatures, notarization tickets, and architecture.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo 'usage: verify-macos-artifacts.sh <report.json> <unsigned|signed>' >&2
  exit 2
fi

report=$1
signature_policy=$2
if [[ $signature_policy != unsigned && $signature_policy != signed ]]; then
  echo "desktop release: unsupported signature policy: $signature_policy" >&2
  exit 2
fi

json_field() {
  node -e 'const fs=require("node:fs"); const report=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); let value=report; for (const key of process.argv[2].split(".")) value=value[key]; if (typeof value !== "string") throw new Error(`missing ${process.argv[2]}`); process.stdout.write(value);' "$report" "$1"
}

app=$(json_field artifacts.application)
archive=$(json_field artifacts.archive)
dmg=$(json_field artifacts.diskImage)
target_arch=$(json_field artifacts.target.arch)
case $target_arch in
  arm64) macho_arch=arm64 ;;
  x64) macho_arch=x86_64 ;;
  *) echo "desktop release: unsupported macOS architecture: $target_arch" >&2; exit 2 ;;
esac

if [[ $(uname -s) != Darwin ]]; then
  echo 'desktop release: macOS artifact verification requires Darwin' >&2
  exit 1
fi
if [[ $(uname -m) != "$macho_arch" ]]; then
  echo "desktop release: runner architecture $(uname -m) does not match $macho_arch" >&2
  exit 1
fi

if [[ $signature_policy == signed ]]; then
  : "${APPLE_SIGN_IDENTITY:?desktop release: APPLE_SIGN_IDENTITY is required}"
  : "${APPLE_API_KEY:?desktop release: APPLE_API_KEY is required}"
  : "${APPLE_API_KEY_ID:?desktop release: APPLE_API_KEY_ID is required}"
  : "${APPLE_API_ISSUER:?desktop release: APPLE_API_ISSUER is required}"
  codesign --force --sign "$APPLE_SIGN_IDENTITY" --timestamp "$dmg"
  xcrun notarytool submit "$dmg" --wait \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER"
  xcrun stapler staple "$dmg"
fi

verify_app() {
  local candidate=$1
  local executable
  local resources
  local ripgrep_platform
  executable="$candidate/Contents/MacOS/deepseek-harness-ide"
  resources="$candidate/Contents/Resources/desktop-resources"
  ripgrep_platform="ripgrep-darwin-$target_arch"
  [[ -x $executable ]] || { echo "desktop release: missing application executable: $executable" >&2; return 1; }
  [[ $(lipo -archs "$executable") == "$macho_arch" ]] || {
    echo "desktop release: main executable is not a single $macho_arch payload" >&2
    return 1
  }

  local required_legal=(
    "$resources/LICENSE"
    "$resources/THIRD_PARTY_NOTICES.md"
    "$resources/legal/electron/LICENSE"
    "$resources/legal/electron/LICENSES.chromium.html"
    "$resources/runtime/LICENSE"
    "$resources/host/node_modules/@vscode/ripgrep/LICENSE"
    "$resources/host/node_modules/@vscode/$ripgrep_platform/LICENSE"
    "$resources/host/node_modules/koffi/LICENSE.txt"
  )
  local legal
  for legal in "${required_legal[@]}"; do
    [[ -f $legal && ! -L $legal && -s $legal ]] || {
      echo "desktop release: missing packaged legal payload: $legal" >&2
      return 1
    }
  done
  local notice_term
  for notice_term in 'Electron 43.2.0' 'v24.16.0' 'LICENSES.chromium.html' '@vscode/ripgrep' 'koffi' 'dsh-process-capsule'; do
    grep -Fq -- "$notice_term" "$resources/THIRD_PARTY_NOTICES.md" || {
      echo "desktop release: packaged notices omit $notice_term" >&2
      return 1
    }
  done

  while IFS= read -r binary; do
    if file -b "$binary" | grep -q 'Mach-O'; then
      [[ $(lipo -archs "$binary") == "$macho_arch" ]] || {
        echo "desktop release: $binary is not a single $macho_arch payload" >&2
        return 1
      }
      if [[ $signature_policy == signed ]]; then
        codesign --verify --strict --verbose=2 "$binary"
        codesign --display --verbose=2 "$binary" 2>&1 | grep -Eq '^Authority=Developer ID Application:'
      fi
    fi
  done < <(find "$candidate" -type f \( -perm -111 -o -name '*.node' -o -name '*.dylib' \) -print | LC_ALL=C sort)

  if [[ $signature_policy == signed ]]; then
    local signature
    signature=$(codesign --display --verbose=4 "$candidate" 2>&1)
    codesign --verify --deep --strict --verbose=4 "$candidate"
    grep -Eq '^Authority=Developer ID Application:' <<< "$signature"
    grep -Eq 'flags=.*runtime' <<< "$signature"
    spctl --assess --type execute --verbose=4 "$candidate"
    xcrun stapler validate "$candidate"
  fi
}

verify_app "$app"

temporary=$(mktemp -d "${RUNNER_TEMP:-/tmp}/dsh-desktop-macos.XXXXXX")
mounted=0
cleanup() {
  if [[ $mounted == 1 ]]; then hdiutil detach "$temporary/dmg" -quiet || true; fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT

mkdir "$temporary/zip" "$temporary/dmg"
ditto -x -k "$archive" "$temporary/zip"
zip_apps=("$temporary/zip"/*.app)
if [[ ${#zip_apps[@]} -ne 1 || ! -d ${zip_apps[0]} ]]; then
  echo 'desktop release: portable ZIP must contain exactly one top-level application' >&2
  exit 1
fi
verify_app "${zip_apps[0]}"

hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$temporary/dmg" -quiet
mounted=1
dmg_apps=("$temporary/dmg"/*.app)
if [[ ${#dmg_apps[@]} -ne 1 || ! -d ${dmg_apps[0]} ]]; then
  echo 'desktop release: DMG must contain exactly one top-level application' >&2
  exit 1
fi
verify_app "${dmg_apps[0]}"
if [[ $signature_policy == signed ]]; then
  codesign --verify --strict --verbose=4 "$dmg"
  codesign --display --verbose=4 "$dmg" 2>&1 | grep -Eq '^Authority=Developer ID Application:'
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
  xcrun stapler validate "$dmg"
fi
