#!/usr/bin/bash
# This file is sent to bash -s. Its stdin never carries ACP protocol bytes.
set -euo pipefail
umask 077
mode=$1
shift
fail() { printf 'omp-agy bootstrap: %s\n' "$*" >&2; exit 70; }
# Bootstrap has no concurrent diagnostic writer: --version is captured 2>&1
# and all other helpers finish synchronously. Encode first, then establish a
# line boundary even if a completed helper left an unterminated diagnostic.
emit() {
  local encoded
  encoded=$(printf '%s' "$2" | base64 -w0)
  printf '\nOMP_AGY_BOOTSTRAP\t%s\t%s\n' "$1" "$encoded" >&2
}
uuid() { [[ $1 =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]]; }
private_directory() {
  [[ -d $1 && ! -L $1 && $(stat -c %u "$1") == "$(id -u)" && $(stat -c %a "$1") == 700 ]]
}
identity_present() {
  local text
  local -a fields
  [[ -r /proc/$1/stat ]] || return 1
  IFS= read -r text 2>/dev/null < "/proc/$1/stat" || return 1
  text=${text##*) }
  read -r -a fields <<< "$text"
  [[ ${fields[19]:-} == "$2" && ( ${3:-present} == present || ( ${fields[0]:-} != Z && ${fields[0]:-} != X ) ) ]]
}
registry_fail() { fail "cleanup_failed: $prior: $*; inspect this activation and use /agy-reset only after identity-proven recovery"; }
marker_present() {
  local file entry
  for file in /proc/[0-9]*/environ; do
    [[ -r $file ]] || continue
    while IFS= read -r -d '' entry; do
      [[ $entry != "OMP_AGY_GENERATION=$1" ]] || return 0
    done 2>/dev/null < "$file"
  done
  return 1
}
stopped_report() {
  local kind a b c d e extra exit_seen=0
  [[ -f $1 && ! -L $1 ]] || return 1
  { IFS= read -r kind; [[ $kind == stopped ]] || return 1
    while IFS=$'\t' read -r kind a b c d e extra; do
      case $kind in
        generation) [[ $a == "$prior_generation" && -z $b ]] || return 1 ;;
        producer_exit) [[ ( $a =~ ^[0-9]+$ || $a == boot_ended ) && -z $b && $exit_seen == 0 ]] || return 1; exit_seen=1 ;;
        worker) [[ $a =~ ^[0-9]+$ && $b =~ ^[0-9]+$ && $c =~ ^[0-9]+$ && $d =~ ^[0-9]+$ && $e == exited && -z $extra ]] || return 1
          if [[ $prior_boot == "$current_boot" ]] && identity_present "$a" "$b"; then return 1; fi ;;
        *) return 1 ;;
      esac
    done
  } < "$1"
  [[ $exit_seen == 1 ]]
}
publish_recovery() {
  local receipt=$root/receipts/$prior_generation
  mkdir -p "$root/receipts"
  private_directory "$root/receipts" || registry_fail 'unsafe receipts directory'
  if [[ -e $receipt ]]; then
    private_directory "$receipt" && [[ $(<"$receipt/runtime") == "$prior" ]] || registry_fail 'receipt identity mismatch'
  else
    mkdir "$receipt"
    printf '%s\n' "$prior" > "$receipt/runtime"
    printf '%s\n' "$prior_generation" > "$receipt/generation"
  fi
  # Preserve the old source evidence before publishing a recovered receipt.
  for name in cleanup cleanup-failed owner workers producer boot-id supervisor.sh bootstrap.sh; do
    [[ ! -f $prior/$name || -L $prior/$name || -e $receipt/prior-$name ]] || cp "$prior/$name" "$receipt/prior-$name"
  done
  if [[ -n ${bootstrap_source:-} ]]; then printf '%s' "$bootstrap_source" | base64 -d > "$receipt/bootstrap.sh"; else cp "$0" "$receipt/bootstrap.sh"; fi
  if stopped_report "$prior/cleanup"; then
    cp "$prior/cleanup" "$receipt/cleanup.tmp"
  else
    # A validated different Linux boot proves every old identity exited, even
    # when power loss prevented the supervisor from publishing its final report.
    printf 'stopped\ngeneration\t%s\nproducer_exit\tboot_ended\n' "$prior_generation" > "$receipt/cleanup.tmp"
  fi
  [[ ! -L $prior/gemini/antigravity-cli ]] || unlink "$prior/gemini/antigravity-cli"
  rm -rf -- "$prior"
  mv "$receipt/cleanup.tmp" "$receipt/cleanup"
  [[ ${mode:-} != reset ]] || { printf 'recovered\t'; printf '%s' "$prior" | base64 -w0; printf '\n'; }
}
check_registry() {
  local root=$1 prior prior_generation prior_boot current_boot owner_pid owner_start owner_generation owner_role extra
  current_boot=$(</proc/sys/kernel/random/boot_id)
  for prior in "$root"/activation.*; do
    [[ -e $prior || -L $prior ]] || continue
    private_directory "$prior" || registry_fail 'unsafe activation ownership entry'
    [[ -f $prior/generation && ! -L $prior/generation && -f $prior/boot-id && ! -L $prior/boot-id ]] || registry_fail 'unknown activation generation or Linux boot'
    prior_generation=$(<"$prior/generation") prior_boot=$(<"$prior/boot-id")
    uuid "$prior_generation" && uuid "$prior_boot" || registry_fail 'unknown activation generation or Linux boot'
    if [[ $prior_boot != "$current_boot" ]]; then
      marker_present "$prior_generation" && registry_fail 'a current-boot worker still carries this generation'
      publish_recovery
      continue
    fi
    if stopped_report "$prior/cleanup"; then
      marker_present "$prior_generation" && registry_fail 'a live detached worker still carries this generation'
      publish_recovery
      continue
    fi
    [[ ! -e $prior/cleanup-failed && ! -e $prior/cleanup ]] || registry_fail 'prior cleanup is not confirmed stopped'
    [[ -f $prior/owner && ! -L $prior/owner ]] || registry_fail 'unknown worker ownership; no published owner identity'
    read -r owner_pid owner_start owner_generation owner_role extra < "$prior/owner" || registry_fail 'invalid persistent owner record'
    [[ $owner_pid =~ ^[0-9]+$ && $owner_start =~ ^[0-9]+$ && -z $extra && $owner_generation == "$prior_generation" && ( $owner_role == bootstrap || $owner_role == supervisor ) ]] || registry_fail 'invalid persistent owner identity'
    identity_present "$owner_pid" "$owner_start" live || registry_fail 'owner disappeared; unknown live-worker set on this Linux boot'
    [[ $mode != reset ]] || registry_fail 'activation owner is still present; stop its owning session first'
  done
}
check_account_token() {
  local account=$1 token token_mode
  [[ -d $account && ! -L $account && $(stat -c %u "$account") == "$(id -u)" ]] || fail "existing stable app-data directory is missing, symlinked, or has wrong owner: $account; login is not performed"
  token=$account/antigravity-oauth-token
  [[ -f $token && ! -L $token && -r $token && $(stat -c %u "$token") == "$(id -u)" ]] || fail "existing personal OAuth token is missing, unreadable, symlinked, or owned by another user: $token; alternate authentication layouts are not verified; login is not performed"
  token_mode=$(stat -c %a "$token")
  [[ $token_mode == 400 || $token_mode == 600 ]] || fail "existing OAuth token requires current-user/0400 or 0600: $token (observed mode $token_mode)"
  # Read-only credentials remain read-only. The official CLI owns refresh;
  # accepting 0400 is not a claim that its refresh can update a read-only file.
}
if [[ $mode == reset ]]; then
  expected_user=$1 home=$2 expected_distribution=$3
  [[ $(id -un) == "$expected_user" && $(id -u) != 0 && ${WSL_DISTRO_NAME:-} == "$expected_distribution" ]] || fail 'wrong Linux recovery identity/distribution'
  [[ $home == /* && -d $home && ! -L $home && $(stat -c %u "$home") == "$(id -u)" ]] || fail 'invalid recovery HOME'
  root=$home/.cache/omp-agy
  [[ -e $root || -L $root ]] || exit 0
  private_directory "$root" || fail "unsafe activation registry: $root"
  exec 9> "$root/registry.lock"
  flock -x -w 15 9 || fail "activation registry lock deadline exceeded: $root"
  check_registry "$root"
  exit 0
fi
if [[ $mode != bootstrap ]]; then
  runtime=$1 generation=$2
  uuid "$generation" && [[ $runtime == /*/activation.* && $runtime != *'/../'* ]] || fail 'invalid activation identity'
  receipt=${runtime%/*}/receipts/$generation
  private_directory "$receipt" && [[ $(<"$receipt/generation") == "$generation" && $(<"$receipt/runtime") == "$runtime" ]] || fail "activation receipt identity mismatch: $receipt"
fi
if [[ $mode == configure-usage ]]; then
  exec 9> "${runtime%/*}/registry.lock"
  flock -x -w 15 9 || fail 'usage configuration registry lock deadline exceeded'
  [[ -d $runtime && ! -L $runtime && $(<"$runtime/generation") == "$generation" ]] || fail 'activation identity mismatch'
  [[ ! -e $runtime/start && ! -e $runtime/stop && ! -e $runtime/cleanup ]] || fail 'activation is not configurable'
  printf 'usage\n' > "$runtime/operation"
  : > "$runtime/start"
  exit 0
fi
if [[ $mode == configure ]]; then
  profile=$3
  IFS= read -r config || fail 'missing private MCP configuration'
  IFS= read -r agent || fail 'missing private agent configuration'
  exec 9> "${runtime%/*}/registry.lock"
  flock -x -w 15 9 || fail 'ACP configuration registry lock deadline exceeded'
  [[ -d $runtime && ! -L $runtime && $(<"$runtime/generation") == "$generation" ]] || fail 'activation identity mismatch'
  [[ ! -e $runtime/start && ! -e $runtime/stop && ! -e $runtime/cleanup ]] || fail 'activation is not configurable'
  printf '%s' "$config" | base64 -d > "$runtime/gemini/config/mcp_config.json"
  if [[ $profile == custom-clean ]]; then
    mkdir -p "$runtime/gemini/config/plugins/omp-agy-clean/agents"
    printf '{"name":"omp-agy-clean"}\n' > "$runtime/gemini/config/plugins/omp-agy-clean/plugin.json"
    printf '%s' "$agent" | base64 -d > "$runtime/gemini/config/plugins/omp-agy-clean/agents/omp-agy-clean.md"
  elif [[ $profile != default-agy ]]; then
    fail 'unknown profile'
  fi
  printf '%s\n' "$profile" > "$runtime/profile"
  printf 'acp\n' > "$runtime/operation"
  : > "$runtime/start"
  exit 0
fi
if [[ $mode == input ]]; then
  runtime=$1 generation=$2
  [[ -d $runtime && ! -L $runtime && $(<"$runtime/generation") == "$generation" && ! -e $runtime/cleanup ]] || fail 'activation identity mismatch'
  # This staged program consumes ACP bytes as data, never as bash source.
  exec cat > "$runtime/input"
fi
if [[ $mode == stop || $mode == stop-wait-report || $mode == report || $mode == mark-failed || $mode == remove ]]; then
  exec 9> "${runtime%/*}/registry.lock"
  flock -x -w 15 9 || fail "activation registry lock deadline exceeded: $runtime"
  if [[ $mode == report ]]; then
    [[ -f $receipt/cleanup && ! -L $receipt/cleanup ]] || fail "supervisor has not confirmed cleanup: $receipt/cleanup"
    cat "$receipt/cleanup"
    exit 0
  fi
  prior_status=
  [[ ! -f $receipt/cleanup ]] || IFS= read -r prior_status < "$receipt/cleanup"
  if [[ $prior_status == stopped ]]; then
    [[ $mode != stop-wait-report ]] || cat "$receipt/cleanup"
    exit 0
  fi
  [[ -d $runtime && ! -L $runtime && $(<"$runtime/generation") == "$generation" ]] || fail "activation identity mismatch: $runtime"
  case $mode in
    stop|stop-wait-report) : > "$runtime/stop" ;;
    mark-failed) printf 'cleanup_failed\n' > "$runtime/cleanup-failed" ;;
    remove) fail "cleanup_failed: Linux finalization is not confirmed; retaining $runtime" ;;
  esac
  if [[ $mode == stop-wait-report ]]; then
    timeout_ms=${3:-15000}
    [[ $timeout_ms =~ ^[0-9]+$ ]] || fail 'invalid cleanup deadline'
    flock -u 9
    for ((attempt=0;attempt<timeout_ms/100;attempt++)); do
      [[ ! -f $receipt/cleanup ]] || break
      sleep 0.1
    done
    flock -x -w 15 9 || fail "activation registry lock deadline exceeded: $runtime"
    [[ -f $receipt/cleanup && ! -L $receipt/cleanup ]] || fail "Linux finalization deadline exceeded: $runtime; receipt=$receipt/cleanup"
    cat "$receipt/cleanup"
  fi
  exit 0
fi
[[ $mode == bootstrap ]] || fail 'unknown operation'
generation=$1 expected_user=$2 cli=$3 home=$4 account=$5 xdg_config=$6 xdg_cache=$7 xdg_data=$8 expected_distribution=$9
version_timeout_ms=${10:-30000}
[[ $version_timeout_ms =~ ^[1-9][0-9]{0,9}$ ]] || fail 'invalid CLI version probe deadline'
printf -v version_timeout '%d.%03ds' "$((version_timeout_ms / 1000))" "$((version_timeout_ms % 1000))"
[[ -n ${supervisor_source:-} && -n ${bootstrap_source:-} ]] || fail 'missing static script staging source'
[[ $(id -un) == "$expected_user" && $(id -u) != 0 ]] || fail 'wrong Linux identity; refusing producer'
[[ ${WSL_DISTRO_NAME:-} == "$expected_distribution" ]] || fail 'wrong WSL distribution'
read -r kernel < /proc/sys/kernel/osrelease
[[ ${kernel,,} == *microsoft* && ${kernel,,} == *wsl2* ]] || fail 'WSL2 kernel required'
for binary in /usr/bin/bash /usr/bin/setsid ip base64 dd stat readlink mktemp mkfifo cat sleep chmod mkdir rm unlink find ln mv cp flock timeout; do
  command -v "$binary" >/dev/null || fail "missing prerequisite: $binary"
done
[[ $home == /* && $account == "$home/"* && -d $home && ! -L $home ]] || fail 'invalid stable account root'
[[ $(stat -c %u "$home") == "$(id -u)" ]] || fail 'stable HOME has wrong owner'
[[ -x $cli && $cli == /* ]] || fail 'explicit Linux CLI is not executable'
check_account_token "$account"
mounts=$(</proc/self/mountinfo)
while IFS= read -r mount; do
  [[ $mount != *' - drvfs '* && $mount != *'aname=drvfs'* ]] || fail 'Windows project/DrvFs mount is exposed'
  read -r -a fields <<< "$mount"
  target=${fields[4]}
  [[ ! $target =~ ^/mnt/[a-z](/|$) && ! $mount =~ \ -\ [^\ ]+\ [A-Za-z]: ]] || fail 'Windows drive mount is exposed'
done <<< "$mounts"
route=$(ip -4 route show default dev eth0)
read -r -a fields <<< "$route"
[[ ${fields[0]:-} == default && ${fields[1]:-} == via && $route != *$'\n'* ]] || fail 'a unique current eth0 default gateway is required'
gateway=${fields[2]}
route_to_gateway=$(ip -4 route get "$gateway")
source_address= route_device=
read -r -a fields <<< "$route_to_gateway"
for ((i=0;i<${#fields[@]}-1;i++)); do
  [[ ${fields[i]} != src ]] || source_address=${fields[i+1]}
  [[ ${fields[i]} != dev ]] || route_device=${fields[i+1]}
done
[[ -n $source_address && $route_device == eth0 ]] || fail 'gateway route must expose an eth0 source address'
export HOME=$home XDG_CONFIG_HOME=$xdg_config XDG_CACHE_HOME=$xdg_cache XDG_DATA_HOME=$xdg_data
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/omp-agy-private-session-bus
mkdir -p "$xdg_config" "$xdg_cache" "$xdg_data" "$home/.cache/omp-agy"
[[ ! -L $home/.cache/omp-agy && $(stat -c %u "$home/.cache/omp-agy") == "$(id -u)" ]] || fail 'unsafe activation parent directory'
chmod 700 "$home/.cache/omp-agy"
# Serialize inspection + directory creation + atomic owner publication. The
# bootstrap execs the supervisor with the SAME Linux PID/start time, so no dead
# handoff lease is tolerated and concurrently bootstrapping children remain live.
exec 9> "$home/.cache/omp-agy/registry.lock"
flock -x -w 15 9 || fail 'activation registry lock deadline exceeded'
check_registry "$home/.cache/omp-agy"
version=$(timeout --kill-after=1s "$version_timeout" "$cli" --version 9>&- 2>&1) || fail 'explicit CLI --version failed or timed out'
[[ -n $version ]] || fail 'empty CLI version'
runtime=$(mktemp -d "$home/.cache/omp-agy/activation.XXXXXXXXXX")
trap '[[ -z ${runtime:-} ]] || rm -rf -- "$runtime"' EXIT
printf '%s\n' "$generation" > "$runtime/generation"
printf '%s\n' "$(</proc/sys/kernel/random/boot_id)" > "$runtime/boot-id"
IFS= read -r owner_text < "/proc/$$/stat"
owner_text=${owner_text##*) }
read -r -a owner_fields <<< "$owner_text"
printf '%s %s %s bootstrap\n' "$$" "${owner_fields[19]}" "$generation" > "$runtime/owner.tmp"
mv "$runtime/owner.tmp" "$runtime/owner"
printf '%s' "$supervisor_source" | base64 -d > "$runtime/supervisor.sh"
printf '%s' "$bootstrap_source" | base64 -d > "$runtime/bootstrap.sh"
mkdir -p "$home/.cache/omp-agy/receipts"
private_directory "$home/.cache/omp-agy/receipts" || fail 'unsafe receipts directory'
receipt=$home/.cache/omp-agy/receipts/$generation
mkdir "$receipt"
printf '%s\n' "$runtime" > "$receipt/runtime"
printf '%s\n' "$generation" > "$receipt/generation"
printf '%s\n' "$(<"$runtime/boot-id")" > "$receipt/boot-id"
cp "$runtime/bootstrap.sh" "$receipt/bootstrap.sh"
mkdir -p "$runtime/workspace" "$runtime/gemini/config"
ln -s "$account" "$runtime/gemini/antigravity-cli"
for name in cli home account xdg_config xdg_cache xdg_data gateway source_address; do
  printf '%s\n' "${!name}" > "$runtime/$name"
done
emit generation "$generation"
emit user "$(id -un)"
emit uid "$(id -u)"
emit gid "$(id -g)"
emit groups "$(id)"
emit home "$home"
emit cli "$(readlink -f "$cli")"
emit version "$version"
emit mounts "$mounts"
emit sharedDirectories "$(find /mnt -mindepth 1 -maxdepth 2 -type d -printf '%p mode=%m uid=%U\n' 2>/dev/null || true)"
interop=absent
[[ ! -r /proc/sys/fs/binfmt_misc/WSLInterop ]] || interop=$(</proc/sys/fs/binfmt_misc/WSLInterop)
absolute_interop=not-accessible
[[ ! -x /mnt/c/Windows/System32/cmd.exe ]] || absolute_interop=executable-path-accessible
interop+=$'\n'"absolute-cmd.exe=$absolute_interop; execution-not-attempted"
emit interop "$interop"
emit kernel "$kernel"
emit gateway "$gateway"
emit sourceAddress "$source_address"
emit workspace "$runtime/workspace"
emit runtime "$runtime"
emit cleanupReceiptPath "$receipt/cleanup"
emit permissions "$(stat -c '%n uid=%u gid=%g mode=%a' "$home" "$account" "$account/antigravity-oauth-token" "$cli" "$runtime")"
emit route "$route_to_gateway"
flock -u 9
exec 9>&-
trap - EXIT
exec /usr/bin/bash "$runtime/supervisor.sh" "$runtime" "$generation"
