#!/usr/bin/bash -p
# Linux entrypoint; the WSL launcher must preserve the terminal on FDs 0/1/2
# and use bash -p if it stages this source rather than executing the script.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin

fail() { printf 'omp-agy login: %s\n' "$2" >&2; exit "$1"; }
(( $# == 0 )) || fail 64 'no arguments are accepted'
[[ -t 0 && -t 1 && -t 2 ]] || fail 64 'a foreground interactive terminal is required (no pipes or capture)'
[[ $UID == "$EUID" && $UID != 0 && $(/usr/bin/id -un) == agy && ${WSL_DISTRO_NAME:-} == omp-agy-wsl ]] ||
  fail 70 'expected WSL distribution omp-agy-wsl and non-root user agy'
IFS= read -r kernel < /proc/sys/kernel/osrelease || fail 70 'cannot verify the Linux kernel'
[[ ${kernel,,} == *microsoft* && ${kernel,,} == *wsl2* ]] || fail 70 'WSL2 is required'
terminal=$(/usr/bin/tty) || fail 64 'cannot identify the inherited interactive terminal'

readonly home=/home/agy cli=/home/agy/.local/bin/agy
readonly config=$home/.config cache=$home/.cache data=$home/.local/share
readonly registry=$cache/omp-agy account=$home/.gemini/antigravity-cli
readonly lock=$registry/registry.lock

# Match the runner: this dedicated distro must not expose Windows drive mounts.
mounts=$(</proc/self/mountinfo) || fail 70 'cannot inspect Linux mounts'
[[ -n $mounts ]] || fail 70 'cannot inspect Linux mounts'
while IFS= read -r mount; do
  read -r -a fields <<< "$mount"
  [[ $mount != *' - drvfs '* && $mount != *'aname=drvfs'* && ! ${fields[4]:-} =~ ^/mnt/[a-z](/|$) && ! $mount =~ \ -\ [^\ ]+\ [A-Za-z]: ]] ||
    fail 70 'a Windows drive mount is exposed in the dedicated WSL distribution'
done <<< "$mounts"

mode=$(/usr/bin/stat -c '%a' -- /home) || fail 70 'cannot inspect /home'
[[ -d /home && ! -L /home && $(/usr/bin/stat -c '%u' -- /home) == 0 ]] && (( (8#$mode & 022) == 0 )) ||
  fail 70 'unsafe /home parent directory'
[[ -d $home && ! -L $home && -O $home && -x $home && $(/usr/bin/stat -c '%a' -- "$home") == 700 ]] ||
  fail 70 'expected /home/agy to be a non-symlink directory owned by agy with mode 0700'

check_directory() {
  local path=$1 permissions
  # Optional directories may be created by native AGY. Existing directories
  # must stay inside the verified private HOME and be real and user-owned.
  [[ -e $path || -L $path ]] || return 0
  [[ -d $path && ! -L $path && -O $path && -x $path ]] || fail 70 "unsafe directory: $path"
  permissions=$(/usr/bin/stat -c '%a' -- "$path") || fail 70 "cannot inspect directory: $path"
  (( (8#$permissions & 002) == 0 )) || fail 70 "other-writable directory: $path"
}
for path in "$config" "$cache" "$home/.local" "$data" "$home/.local/bin" "$home/.gemini" "$account"; do
  check_directory "$path"
done
[[ -f $cli && ! -L $cli && -O $cli && -x $cli ]] || fail 70 "unsafe or missing executable: $cli"
mode=$(/usr/bin/stat -c '%a' -- "$cli") || fail 70 "cannot inspect executable: $cli"
(( (8#$mode & 07022) == 0 )) || fail 70 "unsafe executable mode: $cli"
cd -P -- "$home" || fail 70 'cannot enter the dedicated HOME'

# Create only the registry infrastructure, never an activation or a receipt.
# No chmod/fixups on existing objects: share the same inode as bootstrap.
if [[ ! -e $cache && ! -L $cache ]]; then
  /usr/bin/mkdir -- "$cache" 2>/dev/null || [[ -d $cache ]] || fail 70 'cannot create the activation cache parent'
fi
check_directory "$cache"
if [[ ! -e $registry && ! -L $registry ]]; then
  /usr/bin/mkdir -- "$registry" 2>/dev/null || [[ -d $registry ]] || fail 70 'cannot create activation registry'
fi
[[ -d $registry && ! -L $registry && -O $registry && -r $registry && -x $registry && $(/usr/bin/stat -c '%a' -- "$registry") == 700 ]] ||
  fail 70 'unsafe activation registry (must be a private agy-owned directory)'
if [[ ! -e $lock && ! -L $lock ]]; then
  (set -o noclobber; : > "$lock") 2>/dev/null || [[ -e $lock || -L $lock ]] || fail 70 'cannot create registry.lock'
fi
[[ -f $lock && ! -L $lock && -O $lock ]] || fail 70 'unsafe registry.lock (must be an agy-owned regular file)'
exec 9< "$lock" || fail 70 'cannot open registry.lock'
[[ ! -L $lock && $lock -ef /proc/$$/fd/9 && $(/usr/bin/stat -Lc '%u:%a:%h' -- /proc/$$/fd/9) == "$UID:600:1" ]] ||
  fail 70 'unsafe registry.lock (must have mode 0600 and no other links)'
if /usr/bin/flock --exclusive --nonblock --conflict-exit-code 75 9; then
  :
elif (( $? == 75 )); then
  fail 75 'registry busy; wait for another login, activation startup or cleanup to finish, then retry'
else
  fail 70 'could not lock the activation registry'
fi

shopt -s nullglob
for entry in "$registry"/activation.*; do
  fail 75 'an activation entry exists; stop its owning OMP session normally and inspect any remaining entry before retrying. Login does not recover, remove or kill anything.'
done

# Use the official SSH/manual OAuth flow, not --remote-control/--remote-agent.
# A fixed Linux-only environment excludes host keyring, proxy/credential,
# display, browser, loader and tool overrides. BROWSER is deny-only, not an
# opener; the native CLI handles URLs, codes and all credential state.
launch=(/usr/bin/env -i
  "HOME=$home" USER=agy LOGNAME=agy SHELL=/usr/bin/bash PATH=/usr/bin:/bin
  "XDG_CONFIG_HOME=$config" "XDG_CACHE_HOME=$cache" "XDG_DATA_HOME=$data"
  DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/omp-agy-private-session-bus
  TERM=xterm-256color LANG=C.UTF-8 BROWSER=/usr/bin/false
  'SSH_CONNECTION=127.0.0.1 1 127.0.0.1 22' 'SSH_CLIENT=127.0.0.1 1 22'
  "SSH_TTY=$terminal"
  AGY_CLI_DISABLE_AUTO_UPDATE=true
  "$cli" --log-file=/dev/null)

printf '%s\n' \
  'omp-agy login: To replace the saved account, type /logout only in the native AGY UI. This clears the old sign-in; there is no rollback. Do not submit a model prompt.' \
  'If AGY displays its official sign-in URL, open it manually in your browser. Use the intended account and enter the code only when native AGY asks. Do not share the URL or code.' \
  'If logout closes AGY, the wrapper can reopen it once. After signing in, confirm the account in AGY and exit with /exit.' >&2

# Run directly in the foreground, with the same terminal and the lock FD.
# Keep the same lock through the optional second launch; no account state or
# output is inspected, and a CLI error/cancel is not retried automatically.
# A native exit code (even 0) does not prove that sign-in happened.
if "${launch[@]}"; then
  printf '\n%s' 'omp-agy login: If logout closed AGY, type r then Enter to reopen it. Otherwise press Enter to finish. Never paste a URL or code here: ' >&2
  if IFS= read -rs reply && [[ $reply == r ]]; then
    printf '\n' >&2
    exec "${launch[@]}"
  fi
  printf '\n' >&2
  exit 0
else
  exit "$?"
fi
