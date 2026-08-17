#!/usr/bin/env bash
# Exercise cold launch, zero-listener, clean/forced shutdown, replacement, removal, and external-state retention.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'usage: smoke-macos-lifecycle.sh <report.json>' >&2
  exit 2
fi

report=$1
json_field() {
  node -e 'const fs=require("node:fs"); const report=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); let value=report; for (const key of process.argv[2].split(".")) value=value[key]; if (typeof value !== "string") throw new Error(`missing ${process.argv[2]}`); process.stdout.write(value);' "$report" "$1"
}

archive=$(json_field artifacts.archive)
temporary=$(mktemp -d "${RUNNER_TEMP:-/tmp}/dsh-desktop-lifecycle.XXXXXX")
source_root="$temporary/source"
install_root="$temporary/Applications"
install_app="$install_root/DeepSeek Harness IDE.app"
dsh_home="$temporary/state/dsh-home"
workspace="$temporary/state/workspace"
electron_user_data="$temporary/state/electron-user-data"
log_root="$temporary/logs"
mkdir -p "$source_root" "$install_root" "$dsh_home" "$workspace" "$electron_user_data" "$log_root"
printf 'persistent-state\n' > "$dsh_home/release-smoke-sentinel"
printf 'workspace-state\n' > "$workspace/user-file.txt"
printf 'electron-state\n' > "$electron_user_data/release-smoke-sentinel"

owned_pids=()
cleanup() {
  for pid in "${owned_pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null \
      && ps -p "$pid" -o command= 2>/dev/null | grep -Fq "$temporary"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  rm -rf -- "$temporary"
}
trap cleanup EXIT

ditto -x -k "$archive" "$source_root"
source_apps=("$source_root"/*.app)
if [[ ${#source_apps[@]} -ne 1 || ! -d ${source_apps[0]} ]]; then
  echo 'desktop release: lifecycle ZIP must contain exactly one top-level application' >&2
  exit 1
fi
source_app=${source_apps[0]}

descendants() {
  local parent=$1
  local child
  while IFS= read -r child; do
    [[ -n $child ]] || continue
    printf '%s\n' "$child"
    descendants "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

wait_for_guardian() {
  local main_pid=$1
  local attempts
  for attempts in {1..60}; do
    kill -0 "$main_pid" 2>/dev/null || return 1
    if ps -axo ppid=,command= | awk -v parent="$main_pid" '$1 == parent && /lib\/guardian\.js/ { found=1 } END { exit found ? 0 : 1 }'; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_for_renderer() {
  local main_pid=$1
  local attempts
  for attempts in {1..60}; do
    kill -0 "$main_pid" 2>/dev/null || return 1
    if ps -axo ppid=,command= | awk -v parent="$main_pid" '$1 == parent && /--type=renderer/ { found=1 } END { exit found ? 0 : 1 }'; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_for_owned_exit() {
  local main_pid=$1
  shift
  local pid
  local attempts
  for attempts in {1..60}; do
    local live=0
    if kill -0 "$main_pid" 2>/dev/null; then live=1; fi
    for pid in "$@"; do if kill -0 "$pid" 2>/dev/null; then live=1; fi; done
    [[ $live == 0 ]] && return 0
    sleep 0.5
  done
  return 1
}

launch_and_stop() {
  local mode=$1
  local label=$2
  local executable="$install_app/Contents/MacOS/deepseek-harness-ide"
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY= \
    DSH_HOME="$dsh_home" DSH_TELEMETRY_DISABLED=1 \
    "$executable" "--user-data-dir=$electron_user_data" > "$log_root/$label.log" 2>&1 &
  local main_pid=$!
  owned_pids+=("$main_pid")
  if ! wait_for_guardian "$main_pid"; then
    cat "$log_root/$label.log" >&2
    echo "desktop release: $label did not reach guardian startup" >&2
    return 1
  fi
  if ! wait_for_renderer "$main_pid"; then
    cat "$log_root/$label.log" >&2
    echo "desktop release: $label did not reach renderer startup" >&2
    return 1
  fi
  local children=()
  while IFS= read -r pid; do children+=("$pid"); owned_pids+=("$pid"); done < <(descendants "$main_pid")
  local process_list="$main_pid"
  for pid in "${children[@]:-}"; do process_list="$process_list,$pid"; done
  if lsof -nP -a -p "$process_list" -iTCP -sTCP:LISTEN 2>/dev/null | grep -q TCP; then
    echo "desktop release: $label opened a TCP listener" >&2
    return 1
  fi
  if [[ $mode == clean ]]; then kill -TERM "$main_pid"; else kill -KILL "$main_pid"; fi
  if ! wait_for_owned_exit "$main_pid" "${children[@]:-}"; then
    echo "desktop release: $label left an owned process alive" >&2
    return 1
  fi
  wait "$main_pid" 2>/dev/null || true
}

ditto "$source_app" "$install_app"
launch_and_stop clean cold-start
launch_and_stop forced forced-stop

replacement="$install_root/DeepSeek Harness IDE.replacement.app"
ditto "$source_app" "$replacement"
mv "$install_app" "$install_root/DeepSeek Harness IDE.previous.app"
mv "$replacement" "$install_app"
rm -rf -- "$install_root/DeepSeek Harness IDE.previous.app"
launch_and_stop clean replaced-start
rm -rf -- "$install_app"

[[ $(<"$dsh_home/release-smoke-sentinel") == persistent-state ]] || {
  echo 'desktop release: application lifecycle changed DSH_HOME state' >&2
  exit 1
}
[[ $(<"$workspace/user-file.txt") == workspace-state ]] || {
  echo 'desktop release: application lifecycle changed workspace data' >&2
  exit 1
}
[[ $(<"$electron_user_data/release-smoke-sentinel") == electron-state ]] || {
  echo 'desktop release: application lifecycle changed Electron user data' >&2
  exit 1
}
