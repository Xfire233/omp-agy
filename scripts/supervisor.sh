#!/usr/bin/bash
# stdout belongs exclusively to ACP; only this shell writes framed control records.
set -uo pipefail
umask 077
runtime=$1 generation=$2
[[ -d $runtime && ! -L $runtime && $(<"$runtime/generation") == "$generation" ]] || exit 70
[[ -f $runtime/boot-id && $(<"$runtime/boot-id") == "$(</proc/sys/kernel/random/boot_id)" ]] || exit 70
# The kernel-bounded FIFO carries raw diagnostics, never control records. Keep
# its reader open before opening writers; helpers must close the control FD 5.
exec 5>&2
mkfifo "$runtime/diagnostics" 5>&- || exit 70
exec 6<>"$runtime/diagnostics"
exec 2>"$runtime/diagnostics"
exec 3<&0
export HOME=$(<"$runtime/home")
export XDG_CONFIG_HOME=$(<"$runtime/xdg_config") XDG_CACHE_HOME=$(<"$runtime/xdg_cache") XDG_DATA_HOME=$(<"$runtime/xdg_data")
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/omp-agy-private-session-bus
cli=$(<"$runtime/cli")
gateway=$(<"$runtime/gateway")
source_address=$(<"$runtime/source_address")
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}$gateway,127.0.0.1,localhost,::1"
export no_proxy="${no_proxy:+$no_proxy,}$gateway,127.0.0.1,localhost,::1"
declare -A starts=() groups=() parents=()
child= pgid= feeder= stopping=0
receipt=${runtime%/*}/receipts/$generation
[[ -d $receipt && ! -L $receipt && $(<"$receipt/runtime") == "$runtime" && $(<"$receipt/generation") == "$generation" ]] || exit 70
# Read at most 12 KiB per pass, without waiting for a newline or EOF. Base64 is
# applied before bytes enter shell variables, preserving NUL and split UTF-8.
# Only the read keeper is nonblocking; independent FIFO writers retain blocking
# backpressure. There is no collector process or diagnostic file to grow.
drain_diagnostics() {
  local encoded count
  for ((count=0;count<4;count++)); do
    read -r -t 0 -u 6 || return 1
    encoded=$(exec 5>&-; dd bs=3072 count=1 iflag=nonblock status=none <&6 6>&- 2>/dev/null | base64 -w0 6>&-)
    [[ -n $encoded ]] || return 1
    printf 'OMP_AGY_EVENT\tdiagnostic\t%s\n' "$encoded" >&5
  done
  return 0
}
emit() {
  local encoded
  drain_diagnostics
  encoded=$(exec 5>&- 6>&-; printf '%s' "$2" | base64 -w0)
  printf 'OMP_AGY_EVENT\t%s\t%s\n' "$1" "$encoded" >&5
}
# /proc/PID/stat's comm may contain spaces or ')': remove through its LAST ') '.
read_identity() {
  local text
  [[ -r /proc/$1/stat ]] || return 1
  IFS= read -r text < "/proc/$1/stat" 2>/dev/null || return 1
  text=${text##*) }
  read -r -a identity <<< "$text"
  [[ ${#identity[@]} -ge 20 ]] || return 1
}
is_present() {
  [[ -n ${starts[$1]:-} ]] || return 1
  read_identity "$1" || return 1
  [[ ${identity[19]} == "${starts[$1]}" ]]
}
is_live() {
  is_present "$1" && [[ ${identity[0]} != Z && ${identity[0]} != X ]]
}
scan_workers() {
  local file pid entry owned parent group start known group_owned=0
  for known in "${!starts[@]}"; do
    if is_live "$known" && [[ ${identity[2]} == "$pgid" ]]; then group_owned=1; break; fi
  done
  for file in /proc/[0-9]*/stat; do
    pid=${file#/proc/}; pid=${pid%/stat}
    [[ $pid != "$$" && $pid != "$feeder" ]] || continue
    read_identity "$pid" || continue
    parent=${identity[1]} group=${identity[2]} start=${identity[19]}
    owned=0
    if [[ $group_owned == 1 && -n $pgid && $group == "$pgid" ]]; then
      owned=1
    elif [[ -n ${starts[$pid]:-} && ${starts[$pid]} == "$start" ]]; then
      owned=1
    elif [[ -n ${starts[$parent]:-} ]] && is_live "$parent"; then
      owned=1
    elif [[ -O /proc/$pid && -r /proc/$pid/environ ]]; then
      while IFS= read -r -d '' entry; do
        if [[ $entry == "OMP_AGY_GENERATION=$generation" ]]; then owned=1; break; fi
      done 2>/dev/null < "/proc/$pid/environ"
    fi
    [[ $owned == 1 ]] || continue
    if [[ -z ${starts[$pid]:-} || ${starts[$pid]} != "$start" ]]; then
      starts[$pid]=$start groups[$pid]=$group parents[$pid]=$parent
      printf '%s\t%s\t%s\t%s\n' "$pid" "$start" "$group" "$parent" >> "$runtime/workers"
      emit worker "$pid $start $group $parent"
    fi
  done
}
# Poll only the known ownership tree at 100ms. A full marker/group scan still
# runs every second and on every cleanup pass, covering reparented/detached
# workers without reading every process environment ten times per second.
scan_descendants() {
  local known task pid parent group start index=0
  local -a queue=("${!starts[@]}") children
  local -A visited=()
  while ((index < ${#queue[@]})); do
    known=${queue[index++]}
    [[ -z ${visited[$known]:-} ]] || continue
    visited[$known]=1
    is_live "$known" || continue
    for task in /proc/$known/task/[0-9]*/children; do
      [[ -r $task ]] || continue
      children=()
      read -r -a children < "$task" || true
      for pid in "${children[@]}"; do
        read_identity "$pid" || continue
        parent=${identity[1]} group=${identity[2]} start=${identity[19]}
        [[ $parent == "$known" ]] || continue
        if [[ ${starts[$pid]:-} != "$start" ]]; then
          starts[$pid]=$start groups[$pid]=$group parents[$pid]=$parent
          printf '%s\t%s\t%s\t%s\n' "$pid" "$start" "$group" "$parent" >> "$runtime/workers"
          emit worker "$pid $start $group $parent"
        fi
        queue+=("$pid")
      done
    done
  done
}
signal_owned() {
  local signal=$1 pid group_live=0
  for pid in "${!starts[@]}"; do
    if is_live "$pid" && [[ ${identity[2]} == "$pgid" ]]; then group_live=1; break; fi
  done
  [[ $group_live == 0 ]] || kill -s "$signal" -- "-$pgid" 2>/dev/null || true
  for pid in "${!starts[@]}"; do
    is_live "$pid" || continue
    kill -s "$signal" "$pid" 2>/dev/null || true
  done
}
any_live() {
  local pid
  for pid in "${!starts[@]}"; do is_live "$pid" && return 0; done
  return 1
}
cleanup() {
  [[ $stopping == 0 ]] || return
  local term_deadline remaining_us pause
  stopping=1
  trap '' HUP INT TERM
  trap - EXIT
  [[ -z $feeder ]] || kill "$feeder" 2>/dev/null || true
  exec 4>&- 3<&-
  scan_workers
  term_deadline=$(( ${EPOCHREALTIME/./} + 500000 ))
  signal_owned TERM
  # Keep the user-selected 500ms grace inclusive of scans/diagnostic draining,
  # rather than adding helper work to five unconditional 100ms sleeps.
  while (( ${EPOCHREALTIME/./} < term_deadline )); do
    scan_workers
    any_live || break
    drain_diagnostics
    remaining_us=$(( term_deadline - ${EPOCHREALTIME/./} ))
    ((remaining_us > 0)) || break
    ((remaining_us <= 100000)) || remaining_us=100000
    printf -v pause '0.%06d' "$remaining_us"
    sleep "$pause" 5>&- 6>&-
  done
  signal_owned KILL
  for ((attempt=0;attempt<20;attempt++)); do
    scan_workers
    any_live || break
    drain_diagnostics
    sleep 0.1 5>&- 6>&-
  done
  child_exit=0
  if [[ -n $child ]]; then
    # Never wait indefinitely for a kernel-stuck process.
    if is_live "$child"; then child_exit=unknown; else wait "$child"; child_exit=$?; fi
  fi
  [[ -z $feeder ]] || wait "$feeder" 2>/dev/null || true
  # Reap the direct child above; require descendants (including zombies) to
  # disappear too, instead of calling a remaining /proc entry fully cleaned.
  for ((attempt=0;attempt<20;attempt++)); do
    remaining=0
    for pid in "${!starts[@]}"; do is_present "$pid" && remaining=1; done
    [[ $remaining != 0 ]] || break
    drain_diagnostics
    sleep 0.1 5>&- 6>&-
  done
  status=stopped
  [[ $remaining == 0 ]] || status=cleanup_failed
  [[ $child_exit != unknown ]] || status=cleanup_failed
  # Publish the durable receipt only after successful directory removal, while
  # holding the registry lock. No Windows callback is needed for finalization.
  exec 9> "$HOME/.cache/omp-agy/registry.lock"
  if ! flock -x -w 15 9 5>&- 6>&-; then
    emit fatal "cleanup_failed: registry lock deadline exceeded; retaining $runtime"
    return
  fi
  {
    printf '%s\n' "$status"
    printf 'generation\t%s\n' "$generation"
    printf 'producer_exit\t%s\n' "$child_exit"
    for pid in "${!starts[@]}"; do
      state=exited
      is_present "$pid" && state=alive
      printf 'worker\t%s\t%s\t%s\t%s\t%s\n' "$pid" "${starts[$pid]}" "${groups[$pid]}" "${parents[$pid]}" "$state"
    done
  } > "$runtime/cleanup.tmp"
  mv "$runtime/cleanup.tmp" "$runtime/cleanup" 5>&- 6>&-
  if ! cp "$runtime/cleanup" "$receipt/cleanup.tmp" 5>&- 6>&-; then
    emit fatal "cleanup_failed: cannot stage durable receipt; retaining $runtime"
    return
  fi
  if [[ $status == stopped ]]; then
    cd "$HOME" || return
    [[ ! -L $runtime/gemini/antigravity-cli ]] || unlink "$runtime/gemini/antigravity-cli" 5>&- 6>&-
    if ! rm -rf -- "$runtime" 5>&- 6>&-; then
      status=cleanup_failed
      { printf 'cleanup_failed\ngeneration\t%s\nproducer_exit\t%s\nerror\tactivation directory removal failed: %s\n' "$generation" "$child_exit" "$runtime"; } > "$receipt/cleanup.tmp"
    fi
  fi
  if ! mv "$receipt/cleanup.tmp" "$receipt/cleanup" 5>&- 6>&-; then
    emit fatal "cleanup_failed: cannot publish durable receipt: $receipt/cleanup.tmp"
    return
  fi
  # Proven stopped writers leave only the finite kernel FIFO buffer. Failed
  # cleanup gets one bounded pass rather than waiting on a surviving writer.
  # The FIFO was unlinked with the runtime; close the last writer before drain.
  exec 2>&-
  if [[ $status == stopped ]]; then while drain_diagnostics; do :; done; fi
  # Full report + explicit completion seal travels over the already-open control
  # transport only AFTER durable publication and successful physical cleanup.
  emit cleanup "$(<"$receipt/cleanup")"$'\ncomplete\t'"$generation"
  exec 6>&- 5>&-
}
trap 'cleanup; exit 143' HUP INT TERM
trap cleanup EXIT
read_identity "$$" || exit 70
supervisor_start=${identity[19]}
read -r owner_pid owner_start owner_generation owner_role < "$runtime/owner" || exit 70
[[ $owner_pid == "$$" && $owner_start == "$supervisor_start" && $owner_generation == "$generation" ]] || exit 70
exec 9> "$HOME/.cache/omp-agy/registry.lock"
flock -x -w 15 9 5>&- 6>&- || exit 70
printf '%s %s %s supervisor\n' "$$" "$supervisor_start" "$generation" > "$runtime/owner.tmp"
mv "$runtime/owner.tmp" "$runtime/owner" 5>&- 6>&-
flock -u 9 5>&- 6>&-
exec 9>&-
mkfifo "$runtime/input" 5>&- 6>&-
# A private keeper prevents FIFO open from blocking before the CLI is configured.
exec 4<>"$runtime/input"
# This pipe is liveness-only, not ACP. Its reader cannot block on a full ACP FIFO
# when the producer stops reading and the Windows controller disappears.
cat <&3 3<&- 4>&- 5>&- 6>&- > /dev/null &
feeder=$!
emit ready "$$ $supervisor_start"
while [[ ! -e $runtime/start ]]; do
  [[ ! -e $runtime/stop ]] && kill -0 "$feeder" 2>/dev/null || exit 0
  drain_diagnostics
  sleep 0.1 5>&- 6>&-
done
[[ ! -e $runtime/stop ]] && kill -0 "$feeder" 2>/dev/null || exit 0
# Route checks continue during the activation; changed topology is fatal.
check_route() {
  local route default_route actual_source= actual_device= i
  local -a fields
  route=$(exec 5>&- 6>&-; ip -4 route get "$gateway") || return 1
  default_route=$(exec 5>&- 6>&-; ip -4 route show default dev eth0) || return 1
  [[ $default_route == "default via $gateway "* && $default_route != *$'\n'* ]] || return 1
  read -r -a fields <<< "$route"
  for ((i=0;i<${#fields[@]}-1;i++)); do
    [[ ${fields[i]} != src ]] || actual_source=${fields[i+1]}
    [[ ${fields[i]} != dev ]] || actual_device=${fields[i+1]}
  done
  [[ $actual_source == "$source_address" && $actual_device == eth0 ]]
}
check_route || { emit fatal 'gateway route changed before ACP start'; exit 70; }
operation=$(<"$runtime/operation")
input=$runtime/input
if [[ $operation == usage ]]; then
  # Root print mode has no --gemini-dir: require the verified HOME default.
  [[ $(<"$runtime/account") == "$HOME/.gemini/antigravity-cli" ]] || { emit fatal 'usage accountDirectory must equal HOME/.gemini/antigravity-cli'; exit 70; }
  args=(-p /usage --output-format json --disable-slash-commands=false --log-file=/dev/null)
  export AGY_CLI_DISABLE_AUTO_UPDATE=true
  input=/dev/null
elif [[ $operation == acp ]]; then
  profile=$(<"$runtime/profile")
  args=(acp --stdio --process-per-session "--gemini-dir=$runtime/gemini" --include-default-customizations=false)
  if [[ $profile == custom-clean ]]; then
    args+=(--agent=omp-agy-clean)
  elif [[ $profile != default-agy ]]; then
    emit fatal 'unknown profile'; exit 70
  fi
else
  emit fatal 'unknown operation'; exit 70
fi
cd "$runtime/workspace" || exit 70
[[ ! -e $runtime/stop ]] && kill -0 "$feeder" 2>/dev/null || exit 0
# setsid is launched from a non-job-control shell: its child retains this PID/PGID.
OMP_AGY_GENERATION=$generation /usr/bin/setsid "$cli" "${args[@]}" < "$input" 3<&- 4>&- 5>&- 6>&- &
child=$! pgid=$!
for ((attempt=0;attempt<50;attempt++)); do
  if read_identity "$child"; then
    starts[$child]=${identity[19]} groups[$child]=$pgid parents[$child]=$$
    [[ ${identity[2]} != "$pgid" ]] || break
  else
    break
  fi
  drain_diagnostics
  sleep 0.01 5>&- 6>&-
done
printf '%s %s %s %s\n' "$child" "${starts[$child]:-unknown}" "$pgid" "$generation" > "$runtime/producer.tmp"
mv "$runtime/producer.tmp" "$runtime/producer" 5>&- 6>&-
printf '%s\t%s\t%s\t%s\n' "$child" "${starts[$child]:-unknown}" "$pgid" "$$" >> "$runtime/workers"
emit producer "$child $pgid $generation ${starts[$child]:-unknown}"
route_tick=0
while true; do
  drain_diagnostics
  scan_descendants
  if ((route_tick % 10 == 0)); then scan_workers; fi
  [[ ! -e $runtime/stop ]] && kill -0 "$feeder" 2>/dev/null || break
  if [[ -n ${starts[$child]:-} ]]; then is_live "$child" || break; else break; fi
  if ((route_tick++ % 10 == 0)); then
    check_route || { emit fatal 'gateway route changed during activation'; break; }
  fi
  sleep 0.1 5>&- 6>&-
done
cleanup
[[ $child_exit == unknown ]] && exit 70
exit "$child_exit"
