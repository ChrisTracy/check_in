#!/usr/bin/env bash
# =============================================================================
# Check-In agent for Linux                                         version 2.2.0
#
# 1. Asks the server whether it is accepting check-ins   (GET  /api/status)
# 2. Only if it is: gathers the selected details        (CPU sample takes 1s)
# 3. Sends them, using the short hostname as the ID      (POST /api/checkin)
#
# Needs bash and curl. Everything else is optional; fields a machine can't
# provide are simply left out. Run as root for a few extra fields (serial,
# firewall, encryption).
#
# OPTIONS (command line > environment > config file)
#   --url URL          CHECKIN_URL        Server, e.g. https://checkin.example.com
#   --key KEY          CHECKIN_API_KEY    API key (needed once one is set on the server)
#   --id ID            CHECKIN_ID         Record ID (default: short hostname)
#   --fields LIST      CHECKIN_FIELDS     Groups to send (default: "default")
#   --exclude LIST     CHECKIN_EXCLUDE    Groups to skip
#   --extra K=V,...    CHECKIN_EXTRA      Extra fields, e.g. "site=Dallas,owner=it". A value can use
#                                         environment variables, read on every run: ${NAME},
#                                         ${NAME:-fallback} or %NAME%  (e.g. 'site=${SITE}').
#                                         Quote it in single quotes so your shell doesn't expand it.
#   --check-ports LIST CHECKIN_CHECK_PORTS With each check-in, ask the server to test these TCP ports
#                                         on this machine (e.g. 22) and save port_22 = open / closed.
#                                         Needs port checks turned on (dashboard: Admin > Port checks).
#   --port-check LIST                     Just ask the server whether these ports on this machine are
#                                         reachable from it, print the answer and exit
#                                         (exit 0 = all open, 3 = some not open). Sends no check-in.
#   --insecure         CHECKIN_INSECURE=1 Accept a self-signed certificate
#   --config FILE      CHECKIN_CONFIG     Config file (default /etc/check-in/agent.conf)
#   --dry-run                             Print the JSON; don't contact the server
#   --force                               Send even if the server says it is paused
#   --list                                Show the field groups and exit
#   --install [--every N] [--cron]        Install, save settings, run every N minutes (root).
#                                         Uses a systemd timer when available; --cron forces cron.
#                                         Settings not given keep their saved values, unless
#   --replace-settings                    is added (the one-line installer does): then exclude,
#                                         extra fields, port checks and --insecure are exactly what
#                                         this command says, and anything left out is cleared.
#                                         The saved API key and --id are always kept unless given.
#   --uninstall [--remove-record]         Remove the timer/cron job and settings (root);
#                                         --remove-record also deletes this machine's record on the server
#
# FIELD GROUPS  (default = everything except updates and security)
#   system    hostname, fqdn, os, os_version, kernel, arch, vendor, model, serial, virtualization
#   cpu       cpu_pct, cpu_cores, cpu_model, load_1m, load_5m, load_15m
#   ram       ram_pct, ram_used_mb, ram_total_mb, swap_pct
#   disk      activity: disk_busy_pct (% of one second the busiest disk was busy, like iostat %util)
#             space: disk_pct (% of / used), disk_free_gb, disk_size_gb,
#             disk_max_pct and disk_max_mount (the fullest filesystem)
#   time      system_time, timezone, time_synced, time_source
#   uptime    boot_time, uptime, uptime_h
#   network   ip, interface, mac, gateway, dns_servers
#   domain    domain_joined, domain, domain_type, join_software, dns_domain
#   users     users_logged_in, logged_in_users
#   health    processes, failed_services, failed_service_names, reboot_required
#   updates   pending_updates, security_updates, package_manager, last_update   (slower)
#   security  firewall_enabled, firewall, selinux, apparmor, secure_boot, disk_encrypted
#   topprocs  top_cpu, top_ram, top_disk: the 3 busiest process NAMES, each only while that metric is
#             over 85% (cpu_pct, ram_pct, disk_busy_pct; set DEFAULT_TOP_THRESHOLD). Off unless asked for
#             ("all" or --fields default,topprocs); needs the cpu, ram and disk groups; disk needs root
#   Lists are comma-separated. "all" = every group; "default" can be combined: "default,security,topprocs".
#
# EXIT CODES   0 sent (or dry run)   2 server paused, nothing sent   1 error
#
# ONE-LINE INSTALL (downloads this script from your server and sets it up to report back there)
#   curl -fsSL https://YOUR-SERVER/install.sh | sudo bash
#   The dashboard's "Add Device" page builds this line with your options and API key.
#
# EXAMPLES
#   ./checkin-agent.sh --dry-run --fields all
#   ./checkin-agent.sh --url https://checkin.example.com --key ck_xxx
#   ./checkin-agent.sh --url https://checkin.example.com --fields cpu,ram,disk,uptime
#   sudo ./checkin-agent.sh --install --url https://checkin.example.com --key ck_xxx --every 5 --extra site=Dallas
# =============================================================================
set -u

# ---- SETTINGS - change these ----------------------------------------------------------------
# Used when a value isn't given on the command line, in a CHECKIN_* environment variable or in
# the config file. Machines set up with the one-line installer (https://YOUR-SERVER/install.sh)
# have their own values in /etc/check-in/agent.conf, which win over these - edit that file to
# change one machine; edit here (or src/agents.js INSTALL_DEFAULTS) to change future installs.
DEFAULT_URL=""                  # server, e.g. https://checkin.example.com
DEFAULT_FIELDS="default"        # field groups to send: default, all, or e.g. cpu,ram,disk
DEFAULT_EXCLUDE=""              # field groups to skip
DEFAULT_EXTRA=""                # extra fields, e.g. 'site=Dallas,owner=${OWNER:-it}' (see --extra)
DEFAULT_EVERY=5                 # minutes between runs when installing (1-59)
DEFAULT_TOP_THRESHOLD=85       # topprocs group: list the top processes while CPU, RAM or disk busy % is above this
DEFAULT_CHECK_PORTS=""          # ports the server tests on each check-in, e.g. "22" (needs Admin > Port checks)
# What "default" means (the groups sent when nothing else is chosen):
DEFAULT_GROUPS="system cpu ram disk time uptime network domain users health"
# ----------------------------------------------------------------------------------------------

VERSION="2.2.0"
INSTALL_PATH="/usr/local/bin/checkin-agent"
DEFAULT_CONFIG="/etc/check-in/agent.conf"
ALL_GROUPS="system cpu ram disk time uptime network domain users health updates security topprocs"

LOG_TO_SYSLOG=0
[ -t 2 ] || { command -v logger >/dev/null 2>&1 && LOG_TO_SYSLOG=1; }
log() { printf '%s\n' "$*" >&2; [ "$LOG_TO_SYSLOG" = 1 ] && logger -t checkin-agent -- "$*"; return 0; }
die() { log "check-in agent: $*"; exit 1; }

# ---- options ------------------------------------------------------------------------
OPT_URL="" OPT_KEY="" OPT_ID="" OPT_FIELDS="" OPT_EXCLUDE="" OPT_EXTRA="" OPT_INSECURE="" OPT_CONFIG="" OPT_CHECK_PORTS="" PORT_CHECK=""
DRY_RUN=0 FORCE=0 ACTION="run" EVERY="$DEFAULT_EVERY" USE_CRON=0 REMOVE_RECORD=0 REPLACE=0
need() { [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || die "$1 needs a value (see --help)"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --url) need "$@"; OPT_URL="$2"; shift ;;
    --key) need "$@"; OPT_KEY="$2"; shift ;;
    --id) need "$@"; OPT_ID="$2"; shift ;;
    --fields) need "$@"; OPT_FIELDS="$2"; shift ;;
    --exclude) need "$@"; OPT_EXCLUDE="$2"; shift ;;
    --extra) need "$@"; OPT_EXTRA="$2"; shift ;;
    --config) need "$@"; OPT_CONFIG="$2"; shift ;;
    --check-ports) need "$@"; OPT_CHECK_PORTS="$2"; shift ;;
    --port-check) need "$@"; PORT_CHECK="$2"; ACTION="portcheck"; shift ;;
    --every) need "$@"; EVERY="$2"; shift ;;
    --insecure) OPT_INSECURE=1 ;;
    --cron) USE_CRON=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --install) ACTION="install" ;;
    --uninstall) ACTION="uninstall" ;;
    --remove-record) REMOVE_RECORD=1 ;;
    --replace-settings) REPLACE=1 ;;
    --list) ACTION="list" ;;
    --version) echo "$VERSION"; exit 0 ;;
    -h|--help) sed -n '3,/^# =====/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$ACTION" = "list" ]; then
  sed -n '/^# FIELD GROUPS/,/^# EXIT CODES/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

# Environment wins over the config file; options win over both.
ENV_URL="${CHECKIN_URL:-}" ENV_KEY="${CHECKIN_API_KEY:-}" ENV_ID="${CHECKIN_ID:-}" ENV_FIELDS="${CHECKIN_FIELDS:-}"
ENV_EXCLUDE="${CHECKIN_EXCLUDE:-}" ENV_EXTRA="${CHECKIN_EXTRA:-}" ENV_INSECURE="${CHECKIN_INSECURE:-}" ENV_CHECK_PORTS="${CHECKIN_CHECK_PORTS:-}"
CONFIG="${OPT_CONFIG:-${CHECKIN_CONFIG:-$DEFAULT_CONFIG}}"
if [ -r "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi
TOP_THRESHOLD="${CHECKIN_TOP_THRESHOLD:-$DEFAULT_TOP_THRESHOLD}"
case "$TOP_THRESHOLD" in ''|*[!0-9]*) TOP_THRESHOLD=85 ;; esac
pick() { local v; for v in "$@"; do [ -n "$v" ] && { printf '%s' "$v"; return; }; done; }
# A saved value from the config file, or nothing with --replace-settings (for the options the
# installer manages, so re-running it leaves exactly what was chosen).
saved() { [ "$REPLACE" = 1 ] || printf '%s' "$1"; }
URL=$(pick "$OPT_URL" "$ENV_URL" "${CHECKIN_URL:-}" "$DEFAULT_URL"); URL="${URL%/}"
KEY=$(pick "$OPT_KEY" "$ENV_KEY" "${CHECKIN_API_KEY:-}")
ID=$(pick "$OPT_ID" "$ENV_ID" "${CHECKIN_ID:-}")
FIELDS=$(pick "$OPT_FIELDS" "$ENV_FIELDS" "${CHECKIN_FIELDS:-}" "$DEFAULT_FIELDS" "default")
EXCLUDE=$(pick "$OPT_EXCLUDE" "$ENV_EXCLUDE" "$(saved "${CHECKIN_EXCLUDE:-}")" "$DEFAULT_EXCLUDE")
EXTRA=$(pick "$OPT_EXTRA" "$ENV_EXTRA" "$(saved "${CHECKIN_EXTRA:-}")" "$DEFAULT_EXTRA")
INSECURE=$(pick "$OPT_INSECURE" "$ENV_INSECURE" "$(saved "${CHECKIN_INSECURE:-}")")
CHECK_PORTS=$(pick "$OPT_CHECK_PORTS" "$ENV_CHECK_PORTS" "$(saved "${CHECKIN_CHECK_PORTS:-}")" "$DEFAULT_CHECK_PORTS")
valid_ports() { [[ "$1" =~ ^[0-9]{1,5}(,[0-9]{1,5})*$ ]]; }
CHECK_PORTS="${CHECK_PORTS// /}"
[ -z "$CHECK_PORTS" ] || valid_ports "$CHECK_PORTS" || die "--check-ports must be port numbers separated by commas, e.g. 22 or 22,443"
PORT_CHECK="${PORT_CHECK// /}"
[ "$ACTION" != portcheck ] || valid_ports "$PORT_CHECK" || die "--port-check must be port numbers separated by commas, e.g. 22 or 22,443"

# Resolve the group list.
SELECTED=" "
for g in $(printf '%s' "$FIELDS" | tr ',;' '  ' | tr '[:upper:]' '[:lower:]'); do
  case "$g" in
    all) SELECTED=" $ALL_GROUPS " ;;
    default) for d in $DEFAULT_GROUPS; do case "$SELECTED" in *" $d "*) ;; *) SELECTED="$SELECTED$d " ;; esac; done ;;
    *) case " $ALL_GROUPS " in *" $g "*) case "$SELECTED" in *" $g "*) ;; *) SELECTED="$SELECTED$g " ;; esac ;;
                               *) die "unknown field group: $g (use --list)" ;; esac ;;
  esac
done
for g in $(printf '%s' "$EXCLUDE" | tr ',;' '  ' | tr '[:upper:]' '[:lower:]'); do
  case " $ALL_GROUPS " in *" $g "*) ;; *) die "unknown field group in --exclude: $g (use --list)" ;; esac
  SELECTED="${SELECTED/ $g / }"
done
want() { case "$SELECTED" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- install / uninstall -------------------------------------------------------------
if [ "$ACTION" = "uninstall" ]; then
  [ "$(id -u)" = 0 ] || die "--uninstall needs root (use sudo)"
  if [ "$REMOVE_RECORD" = 1 ]; then
    # Delete this machine's record on the server (uses the saved URL and API key).
    RID="${ID:-$(hostname -s 2>/dev/null || hostname)}"
    ENC=""; for ((i = 0; i < ${#RID}; i++)); do c="${RID:i:1}"; case "$c" in [A-Za-z0-9._~-]) ENC+="$c" ;; *) ENC+=$(printf '%%%02X' "'$c") ;; esac; done
    if [ -z "$URL" ]; then
      echo "No server URL known, so the record for $RID was not removed. Delete it in the dashboard."
    else
      CFG=""; [ -n "$KEY" ] && CFG="header = \"x-api-key: ${KEY//\"/}\""
      CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 ${INSECURE:+-k} -K - -X DELETE "$URL/api/records/$ENC" <<<"$CFG")
      case "$CODE" in
        200|204) echo "Removed the record for $RID from $URL." ;;
        404) echo "There was no record for $RID on $URL." ;;
        401|403) echo "The server refused to delete the record for $RID (HTTP $CODE). Delete it in the dashboard." ;;
        *) echo "Could not remove the record for $RID (HTTP ${CODE:-none}). Delete it in the dashboard." ;;
      esac
    fi
  fi
  if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/checkin-agent.timer ]; then
    systemctl disable --now checkin-agent.timer >/dev/null 2>&1
    rm -f /etc/systemd/system/checkin-agent.timer /etc/systemd/system/checkin-agent.service
    systemctl daemon-reload
  fi
  rm -f /etc/cron.d/checkin-agent "$INSTALL_PATH" "$DEFAULT_CONFIG"
  rmdir /etc/check-in 2>/dev/null
  echo "Removed the Check-In agent."
  exit 0
fi

if [ "$ACTION" = "install" ]; then
  [ "$(id -u)" = 0 ] || die "--install needs root (use sudo)"
  [ -n "$URL" ] || die "--install needs --url"
  case "$EVERY" in ''|*[!0-9]*|0) die "--every must be a whole number of minutes (1 or more)" ;; esac
  [ "$EVERY" -le 59 ] || die "--every must be 59 minutes or less"
  SRC="$0"
  if [ ! -f "$SRC" ] || [ "$(basename "$SRC")" = "bash" ]; then
    # Piped in (curl ... | bash): download a copy to install.
    SRC=$(mktemp); curl -fsS ${INSECURE:+-k} "$URL/agent/checkin-agent.sh" -o "$SRC" || die "could not download the agent from $URL/agent/checkin-agent.sh"
  fi
  # Running the installed copy itself (checkin-agent --install ...) only rewrites the settings.
  if [ "$(readlink -f "$SRC" 2>/dev/null)" != "$(readlink -f "$INSTALL_PATH" 2>/dev/null)" ]; then
    install -m 0755 "$SRC" "$INSTALL_PATH" || die "could not copy the agent to $INSTALL_PATH"
  fi
  mkdir -p "$(dirname "$DEFAULT_CONFIG")"
  ( umask 077
    { echo "# Check-In agent settings, written by --install on $(date -Is). Edit freely."
      printf 'CHECKIN_URL=%q\n' "$URL"
      [ -n "$KEY" ] && printf 'CHECKIN_API_KEY=%q\n' "$KEY"
      [ -n "$ID" ] && printf 'CHECKIN_ID=%q\n' "$ID"
      printf 'CHECKIN_FIELDS=%q\n' "$FIELDS"
      [ -n "$EXCLUDE" ] && printf 'CHECKIN_EXCLUDE=%q\n' "$EXCLUDE"
      [ -n "$EXTRA" ] && printf 'CHECKIN_EXTRA=%q\n' "$EXTRA"
      [ -n "$INSECURE" ] && echo 'CHECKIN_INSECURE=1'
      [ -n "$CHECK_PORTS" ] && printf 'CHECKIN_CHECK_PORTS=%q\n' "$CHECK_PORTS"
    } > "$DEFAULT_CONFIG" )
  chmod 600 "$DEFAULT_CONFIG"
  if [ "$USE_CRON" = 0 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    rm -f /etc/cron.d/checkin-agent
    cat > /etc/systemd/system/checkin-agent.service <<EOF
[Unit]
Description=Check-In agent
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_PATH
SuccessExitStatus=2
EOF
    cat > /etc/systemd/system/checkin-agent.timer <<EOF
[Unit]
Description=Run the Check-In agent every $EVERY minute(s)

[Timer]
OnBootSec=1min
OnUnitActiveSec=${EVERY}min
RandomizedDelaySec=20
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable checkin-agent.timer >/dev/null 2>&1 || die "could not enable checkin-agent.timer"
    # Restart (not just start) so a changed interval applies to a timer that was already running.
    systemctl restart checkin-agent.timer || die "could not start checkin-agent.timer"
    echo "Installed: systemd timer runs $INSTALL_PATH every $EVERY minute(s). Settings: $DEFAULT_CONFIG"
    echo "Check it: systemctl list-timers checkin-agent.timer ; journalctl -t checkin-agent -u checkin-agent"
  else
    if [ -f /etc/systemd/system/checkin-agent.timer ]; then
      systemctl disable --now checkin-agent.timer >/dev/null 2>&1
      rm -f /etc/systemd/system/checkin-agent.timer /etc/systemd/system/checkin-agent.service
    fi
    echo "*/$EVERY * * * * root $INSTALL_PATH >/dev/null 2>&1" > /etc/cron.d/checkin-agent
    chmod 644 /etc/cron.d/checkin-agent
    echo "Installed: cron runs $INSTALL_PATH every $EVERY minute(s). Settings: $DEFAULT_CONFIG"
  fi
  "$INSTALL_PATH"; rc=$?
  [ $rc -eq 1 ] && echo "Warning: the first check-in failed. Check the URL and API key in $DEFAULT_CONFIG."
  exit 0
fi

# ---- helpers -------------------------------------------------------------------------
[ -n "$URL" ] || [ "$DRY_RUN" = 1 ] || die "no server URL: use --url, CHECKIN_URL or $DEFAULT_CONFIG"
[ "$DRY_RUN" = 1 ] || command -v curl >/dev/null 2>&1 || die "curl is required"
has() { command -v "$1" >/dev/null 2>&1; }
IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1

CURL=(curl -sS --max-time 20 --connect-timeout 5 --retry 2 --retry-delay 2)
[ -n "$INSECURE" ] && CURL+=(-k)
# The API key goes to curl on stdin (-K -) so it never appears in `ps` output.
KEY_CFG=""; [ -n "$KEY" ] && KEY_CFG="header = \"x-api-key: ${KEY//\"/}\""
api() { "${CURL[@]}" -K - "$@" <<<"$KEY_CFG"; }

json_str() {
  local s="$1" out="" c i
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [[:cntrl:]]) out+=$(printf '\\u%04x' "'$c") ;; *) out+="$c" ;; esac
  done
  printf '"%s"' "$out"
}
FIELDS_JSON=()
add_str() { [ -n "${2:-}" ] && FIELDS_JSON+=("$(json_str "$1"):$(json_str "$2")"); return 0; }
add_num() { case "${2:-}" in ''|*[!0-9.-]*|*.*.*|-|.) ;; *) FIELDS_JSON+=("$(json_str "$1"):$2") ;; esac; return 0; }
add_bool() { case "${2:-}" in true|false) FIELDS_JSON+=("$(json_str "$1"):$2") ;; esac; return 0; }
read_file() { [ -r "$1" ] && tr -d '\0\n' < "$1" | head -c 256; }
pct() { awk -v a="$1" -v b="$2" 'BEGIN { if (b > 0) printf "%.1f", a * 100 / b }'; }
human_duration() {
  local s=$1 d h m; d=$((s / 86400)); h=$((s % 86400 / 3600)); m=$((s % 3600 / 60))
  if [ $d -gt 0 ]; then printf '%dd %dh %dm' $d $h $m; elif [ $h -gt 0 ]; then printf '%dh %dm' $h $m; else printf '%dm' $m; fi
}
iso_time() { date -d "@$1" +%Y-%m-%dT%H:%M:%S%:z 2>/dev/null; }

# Pull "ports":{"22":"open",...} out of a server reply and print one line per port.
print_ports() {
  local m p st
  m=$(printf '%s' "$1" | grep -o '"ports"[[:space:]]*:[[:space:]]*{[^}]*}' | head -1)
  [ -n "$m" ] || return 1
  while read -r p st; do [ -n "$p" ] && log "  port $p: $st"; done < <(printf '%s' "$m" | grep -o '"[0-9]*"[[:space:]]*:[[:space:]]*"[a-z]*"' | tr -d '"' | tr ':' ' ')
}

# ---- --port-check: ask once, print, exit ----------------------------------------------
if [ "$ACTION" = portcheck ]; then
  RESP=$(api -w '\n%{http_code}' "$URL/api/portcheck?ports=$PORT_CHECK") || die "could not reach $URL/api/portcheck"
  CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"
  [ "$CODE" = 200 ] || die "port check failed (HTTP $CODE): ${BODY:0:200}"
  IP=$(printf '%s' "$BODY" | grep -o '"ip"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  log "Ports on ${IP:-this machine}, as seen from $URL:"
  print_ports "$BODY"
  printf '%s' "$BODY" | grep -o '"ports"[[:space:]]*:[[:space:]]*{[^}]*}' | grep -Eq '"(closed|filtered|error)"' && exit 3
  exit 0
fi

# ---- 1. is the server accepting check-ins? ---------------------------------------------
if [ "$DRY_RUN" = 0 ] && [ "$FORCE" = 0 ]; then
  STATUS=$(api -w '\n%{http_code}' "$URL/api/status") || die "could not reach $URL/api/status"
  SCODE="${STATUS##*$'\n'}"; STATUS="${STATUS%$'\n'*}"
  case "$SCODE" in
    200) ;;
    401|403) die "server refused the API key (HTTP $SCODE): ${STATUS:0:200}" ;;
    *) die "unexpected reply from $URL/api/status (HTTP $SCODE): ${STATUS:0:200}" ;;
  esac
  if printf '%s' "$STATUS" | grep -Eq '"accepting"[[:space:]]*:[[:space:]]*false'; then
    log "Server is paused (not accepting check-ins). Nothing gathered or sent."
    exit 2
  fi
  printf '%s' "$STATUS" | grep -Eq '"accepting"[[:space:]]*:[[:space:]]*true' \
    || die "unexpected reply from $URL/api/status: ${STATUS:0:200}"
fi

# ---- 2. gather -----------------------------------------------------------------------
HOST_SHORT=$(hostname -s 2>/dev/null || hostname)
add_str id "${ID:-$HOST_SHORT}"
add_str hostname "$HOST_SHORT"

if want system; then
  FQDN=$(hostname -f 2>/dev/null); [ "$FQDN" != "$HOST_SHORT" ] && add_str fqdn "$FQDN"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    add_str os "$( . /etc/os-release; echo "${PRETTY_NAME:-$NAME}")"
    # shellcheck disable=SC1091
    add_str os_version "$( . /etc/os-release; echo "${VERSION_ID:-}")"
  fi
  add_str kernel "$(uname -r)"
  add_str arch "$(uname -m)"
  add_str vendor "$(read_file /sys/class/dmi/id/sys_vendor)"
  add_str model "$(read_file /sys/class/dmi/id/product_name)"
  [ "$IS_ROOT" = 1 ] && add_str serial "$(read_file /sys/class/dmi/id/product_serial)"
  VIRT=""; has systemd-detect-virt && VIRT=$(systemd-detect-virt 2>/dev/null)
  if [ -z "$VIRT" ]; then grep -qw hypervisor /proc/cpuinfo 2>/dev/null && VIRT="vm" || VIRT="none"; fi
  add_str virtualization "$VIRT"
fi

# ---- one-second samples: CPU busy % and disk busy % ------------------------------------
# /proc/stat and /proc/diskstats are read twice, one second apart (a single wait for both).
read_cpu() { awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle; exit}' /proc/stat; }
# Whole disks only (no partitions, loop, ram, zram, optical, md or device-mapper volumes):
# name and milliseconds spent doing I/O (field 13), the number iostat's %util is based on.
DISK_LIST=$(ls /sys/block 2>/dev/null | grep -vE '^(loop|ram|zram|dm-|md|sr|fd|nbd)')
read_disks() { awk -v list="$DISK_LIST" 'BEGIN{n=split(list, a, "\n"); for (i = 1; i <= n; i++) ok[a[i]] = 1} ($3 in ok){print $3, $13}' /proc/diskstats 2>/dev/null; }
# Per-process snapshot for the topprocs group, one line per process NAME (processes sharing a name are
# added up): name, CPU ticks (user + system), resident pages, bytes read, bytes written.
# /proc/<pid>/io is only readable as root; without it the byte counts are left out.
snap_procs() {
  # grep -H keeps going past processes that exit meanwhile or whose files can't be read (awk would stop).
  grep -H '' /proc/[0-9]*/stat $( [ "$IS_ROOT" = 1 ] && echo /proc/[0-9]*/io ) 2>/dev/null | awk '
    {
      c = index($0, ":"); if (!c) next
      path = substr($0, 1, c - 1); line = substr($0, c + 1)
    }
    path ~ /\/stat$/ {
      i = index(line, "("); j = 0
      for (k = length(line); k > 0; k--) if (substr(line, k, 1) == ")") { j = k; break }
      if (!i || !j) next
      name = substr(line, i + 1, j - i - 1); gsub(/[ ,]/, "_", name)
      split(substr(line, j + 2), f, " ")
      pn[path] = name; cpu[name] += f[12] + f[13]; rss[name] += f[22]; seen[name] = 1
      next
    }
    path ~ /\/io$/ {
      p2 = path; sub(/\/io$/, "/stat", p2); name = pn[p2]
      if (name == "") next
      split(line, kv, " ")
      if (kv[1] == "read_bytes:") rd[name] += kv[2]
      if (kv[1] == "write_bytes:") wr[name] += kv[2]
    }
    END { for (n in seen) print n, cpu[n] + 0, rss[n] + 0, rd[n] + 0, wr[n] + 0 }'
}
now_ms() { local n; n=$(date +%s%N 2>/dev/null); case "$n" in ''|*N*) echo "";; *) echo $((n / 1000000));; esac; }
P1="" PMS1="" PMS2=""
if want cpu || want disk; then
  T1=0 I1=0 T2=0 I2=0 D1="" D2=""
  want cpu && read -r T1 I1 <<<"$(read_cpu)"
  want disk && D1=$(read_disks)
  # The "before" process snapshot is always taken (it can't be known yet whether anything will be busy).
  if want topprocs; then P1=$(snap_procs); PMS1=$(now_ms); fi
  MS1=$(now_ms); sleep 1; MS2=$(now_ms)
  want cpu && read -r T2 I2 <<<"$(read_cpu)"
  want disk && D2=$(read_disks)
  DT_MS=1000; [ -n "$MS1" ] && [ -n "$MS2" ] && [ $((MS2 - MS1)) -gt 0 ] && DT_MS=$((MS2 - MS1))
fi

CPU_PCT_V="" RAM_PCT_V="" DISK_PCT_V=""
if want cpu; then
  add_str cpu_model "$(grep -m1 -E '^(model name|Hardware|Model)' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//; s/  */ /g')"
  add_num cpu_cores "$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
  [ $((T2 - T1)) -gt 0 ] && { CPU_PCT_V=$(awk -v dt=$((T2 - T1)) -v di=$((I2 - I1)) 'BEGIN{printf "%.1f", (dt-di)*100/dt}'); add_num cpu_pct "$CPU_PCT_V"; }
  read -r L1 L5 L15 _ < /proc/loadavg
  add_num load_1m "$L1"; add_num load_5m "$L5"; add_num load_15m "$L15"
fi

if want ram; then
  eval "$(awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/{gsub(":","",$1); printf "%s=%s\n", $1, $2}' /proc/meminfo)"
  if [ -n "${MemTotal:-}" ]; then
    MEM_USED=$((MemTotal - ${MemAvailable:-0}))   # MemAvailable counts reclaimable cache as free
    RAM_PCT_V=$(pct $MEM_USED $MemTotal); add_num ram_pct "$RAM_PCT_V"
    add_num ram_used_mb $((MEM_USED / 1024))
    add_num ram_total_mb $((MemTotal / 1024))
  fi
  if [ "${SwapTotal:-0}" -gt 0 ]; then add_num swap_pct "$(pct $((SwapTotal - ${SwapFree:-0})) $SwapTotal)"; else add_num swap_pct 0; fi
fi

if want disk; then
  if [ -n "$D1" ] && [ -n "$D2" ]; then
    DISK_BUSY=$(printf '%s\n--\n%s\n' "$D1" "$D2" | awk -v dt="$DT_MS" '
      $1 == "--" {second = 1; next}
      !second {a[$1] = $2; next}
      ($1 in a) {u = ($2 - a[$1]) * 100 / dt; if (u > 100) u = 100; if (u < 0) u = 0; if (!f || u > m) m = u; f = 1}
      END {if (f) printf "%.1f", m}')
    DISK_PCT_V="$DISK_BUSY"; add_num disk_busy_pct "$DISK_BUSY"
  fi
  read -r D_SIZE D_AVAIL D_PCT <<<"$(df -P -k / 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $2, $4, $5}')"
  add_num disk_pct "${D_PCT:-}"
  [ -n "${D_AVAIL:-}" ] && add_num disk_free_gb "$(awk -v a="$D_AVAIL" 'BEGIN{printf "%.1f", a/1048576}')"
  [ -n "${D_SIZE:-}" ] && add_num disk_size_gb "$(awk -v a="$D_SIZE" 'BEGIN{printf "%.1f", a/1048576}')"
  FULLEST=$(df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null \
    | awk 'NR>1 && $2>0 {gsub("%","",$5); if ($5+0 > max) {max=$5+0; m=$6}} END{if (m!="") print max, m}')
  if [ -n "$FULLEST" ]; then add_num disk_max_pct "${FULLEST%% *}"; add_str disk_max_mount "${FULLEST#* }"; fi
fi

# ---- topprocs: the 3 busiest process names, only while a metric is over the threshold ----
# top_cpu / top_ram / top_disk are text lines such as "sqlservr 38%, chrome 21%, bash 3%". A list is
# sent only while its metric is above TOP_THRESHOLD (default 85); otherwise the field is cleared with
# null so an old list never lingers. Only process names are read, never command lines or arguments.
if want topprocs; then
  over() { [ -n "${1:-}" ] && awk -v v="$1" -v t="$TOP_THRESHOLD" 'BEGIN{exit !(v + 0 > t + 0)}'; }
  P2=""
  if over "$CPU_PCT_V" || over "$RAM_PCT_V" || over "$DISK_PCT_V"; then P2=$(snap_procs); PMS2=$(now_ms); fi
  PEL_MS=1100; [ -n "$PMS1" ] && [ -n "$PMS2" ] && [ $((PMS2 - PMS1)) -gt 0 ] && PEL_MS=$((PMS2 - PMS1))
  HZ=$(getconf CLK_TCK 2>/dev/null); HZ=${HZ:-100}
  PAGE=$(getconf PAGESIZE 2>/dev/null); PAGE=${PAGE:-4096}
  NCPU=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo); NCPU=${NCPU:-1}
  top3() {   # $1 = cpu | ram | disk
    printf '%s\n--\n%s\n' "$P1" "$P2" | awk -v mode="$1" -v ms="$PEL_MS" -v hz="$HZ" -v ncpu="$NCPU" -v page="$PAGE" -v memkb="${MemTotal:-0}" '
      $1 == "--" {second = 1; next}
      !second {c1[$1] = $2; r1[$1] = $4; w1[$1] = $5; next}
      {
        n = $1; dc = $2 - c1[n]; dr = $4 - r1[n]; dw = $5 - w1[n]
        if (dc < 0) dc = 0; if (dr < 0) dr = 0; if (dw < 0) dw = 0
        if (mode == "cpu") v[n] = dc / hz / (ms / 1000) / ncpu * 100
        else if (mode == "ram") v[n] = $3 * page
        else v[n] = (dr + dw) / (ms / 1000)
      }
      END {
        out = ""
        for (k = 0; k < 3; k++) {
          best = ""; bv = -1
          for (n in v) if (!(n in used) && v[n] > bv) { bv = v[n]; best = n }
          if (best == "") break
          used[best] = 1
          if (mode == "cpu") { if (bv < 0.5) break; t = sprintf("%s %d%%", best, bv + 0.5) }
          else if (mode == "ram") {
            if (bv < 1048576) break
            sz = bv >= 1073741824 ? sprintf("%.1f GB", bv / 1073741824) : sprintf("%d MB", bv / 1048576 + 0.5)
            t = memkb > 0 ? sprintf("%s %s (%d%%)", best, sz, bv / 1024 * 100 / memkb + 0.5) : sprintf("%s %s", best, sz)
          } else { if (bv < 100000) break; t = sprintf("%s %.1f MB/s", best, bv / 1000000) }
          out = out (out == "" ? "" : ", ") t
        }
        print out
      }'
  }
  add_top() {   # name, metric value, mode
    local line=""
    if [ -n "$P2" ] && over "$2"; then
      line=$(top3 "$3")
      # Disk activity per process needs root; without it nothing honest can be said.
      [ "$3" = disk ] && [ "$IS_ROOT" != 1 ] && line=""
    fi
    if [ -n "$line" ]; then add_str "$1" "$line"; else FIELDS_JSON+=("$(json_str "$1"):null"); fi
  }
  want cpu && add_top top_cpu "$CPU_PCT_V" cpu
  want ram && add_top top_ram "$RAM_PCT_V" ram
  want disk && add_top top_disk "$DISK_PCT_V" disk
fi

if want time; then
  add_str system_time "$(date +%Y-%m-%dT%H:%M:%S%:z)"
  TZ_NAME="${TZ:-}"
  [ -z "$TZ_NAME" ] && has timedatectl && TZ_NAME=$(timedatectl show -p Timezone --value 2>/dev/null)
  [ -z "$TZ_NAME" ] && TZ_NAME=$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')
  add_str timezone "${TZ_NAME:-$(date +%Z)}"
  if has timedatectl; then
    case "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" in yes) add_bool time_synced true ;; no) add_bool time_synced false ;; esac
  fi
  SRC=""
  has chronyc && SRC=$(chronyc -n tracking 2>/dev/null | awk -F'[()]' '/^Reference ID/{print $2; exit}')
  [ -z "$SRC" ] && has timedatectl && SRC=$(timedatectl show-timesync -p ServerName --value 2>/dev/null)
  [ -z "$SRC" ] && has ntpq && SRC=$(ntpq -pn 2>/dev/null | awk '/^\*/{sub(/^\*/,"",$1); print $1; exit}')
  add_str time_source "$SRC"
fi

if want uptime; then
  UP_S=$(awk '{printf "%d", $1}' /proc/uptime)
  add_str boot_time "$(iso_time $(( $(date +%s) - UP_S )))"
  add_str uptime "$(human_duration "$UP_S")"
  add_num uptime_h "$(awk -v s="$UP_S" 'BEGIN{printf "%.1f", s/3600}')"
fi

if want network; then
  IP="" IFACE="" GW=""
  if has ip; then
    ROUTE=$(ip -4 route get 1.1.1.1 2>/dev/null | head -1)
    IP=$(printf '%s' "$ROUTE" | sed -n 's/.* src \([0-9.]*\).*/\1/p')
    IFACE=$(printf '%s' "$ROUTE" | sed -n 's/.* dev \([^ ]*\).*/\1/p')
    GW=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
  fi
  [ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  add_str ip "$IP"; add_str interface "$IFACE"; add_str gateway "$GW"
  [ -n "$IFACE" ] && add_str mac "$(read_file "/sys/class/net/$IFACE/address")"
  DNS=$(awk '/^nameserver/{print $2}' /etc/resolv.conf 2>/dev/null | grep -v '^127\.0\.0\.53$' | paste -sd, -)
  if [ -z "$DNS" ] && has resolvectl; then
    DNS=$(resolvectl dns 2>/dev/null | awk -F': ' 'NF>1{print $2}' | tr ' ' '\n' | grep -v '^$' | sort -u | paste -sd, -)
  fi
  add_str dns_servers "$DNS"
fi

if want domain; then
  DOMAIN="" DTYPE="" JOIN=""
  if has realm; then
    REALM=$(realm list 2>/dev/null)
    DOMAIN=$(printf '%s\n' "$REALM" | awk '/^[^ \t]/{print; exit}')
    if [ -n "$DOMAIN" ]; then
      JOIN=$(printf '%s\n' "$REALM" | awk -F': *' '/client-software/{print $2; exit}')
      DTYPE=$(printf '%s\n' "$REALM" | awk -F': *' '/server-software/{print $2; exit}')
    fi
  fi
  if [ -z "$DOMAIN" ] && [ -r /etc/ipa/default.conf ]; then
    DOMAIN=$(awk -F'= *' '/^domain *=/{print $2; exit}' /etc/ipa/default.conf); DTYPE="ipa"; JOIN="sssd"
  fi
  if [ -z "$DOMAIN" ] && has wbinfo && wbinfo -t >/dev/null 2>&1; then
    DOMAIN=$(wbinfo --own-domain 2>/dev/null); DTYPE="active-directory"; JOIN="winbind"
  fi
  if [ -z "$DOMAIN" ] && [ -r /etc/sssd/sssd.conf ]; then
    DOMAIN=$(awk -F'= *' '/^domains *=/{print $2; exit}' /etc/sssd/sssd.conf); JOIN="sssd"
  fi
  if [ -n "$DOMAIN" ]; then
    add_bool domain_joined true; add_str domain "$DOMAIN"; add_str domain_type "${DTYPE:-unknown}"; add_str join_software "$JOIN"
  else
    add_bool domain_joined false; add_str domain_type none
  fi
  add_str dns_domain "$(hostname -d 2>/dev/null)"
fi

if want users; then
  USERS=$(who 2>/dev/null | awk '{print $1}' | sort -u)
  add_num users_logged_in "$(printf '%s' "$USERS" | grep -c .)"
  add_str logged_in_users "$(printf '%s' "$USERS" | paste -sd, -)"
fi

if want health; then
  add_num processes "$(ps -e --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  if has systemctl && [ -d /run/systemd/system ]; then
    FAILED=$(systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}')
    add_num failed_services "$(printf '%s' "$FAILED" | grep -c .)"
    add_str failed_service_names "$(printf '%s' "$FAILED" | head -10 | paste -sd, -)"
  fi
  if [ -f /var/run/reboot-required ] || { has needs-restarting && ! needs-restarting -r >/dev/null 2>&1; }; then
    add_bool reboot_required true
  else
    add_bool reboot_required false
  fi
fi

if want updates; then
  if has apt-get; then
    SIM=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null)
    add_str package_manager apt
    add_num pending_updates "$(printf '%s\n' "$SIM" | grep -c '^Inst ')"
    add_num security_updates "$(printf '%s\n' "$SIM" | grep '^Inst ' | grep -ci 'security')"
    LAST=$(stat -c %Y /var/log/apt/history.log 2>/dev/null); [ -n "$LAST" ] && add_str last_update "$(iso_time "$LAST")"
  elif has dnf || has yum; then
    PM=$(has dnf && echo dnf || echo yum)
    add_str package_manager "$PM"
    # -C uses the local cache only, so this never stalls on a slow mirror.
    add_num pending_updates "$($PM -q -C check-update 2>/dev/null | grep -cE '^[[:alnum:]][^ ]+[[:space:]]+[^ ]+[[:space:]]+[^ ]+')"
    add_num security_updates "$($PM -q -C updateinfo list --security 2>/dev/null | grep -c .)"
    LAST=$(rpm -qa --last 2>/dev/null | head -1 | sed 's/^[^ ]* *//'); [ -n "$LAST" ] && add_str last_update "$(date -d "$LAST" +%Y-%m-%dT%H:%M:%S%:z 2>/dev/null)"
  elif has zypper; then
    add_str package_manager zypper
    add_num pending_updates "$(zypper -q --non-interactive lu 2>/dev/null | grep -c '^v ')"
    add_num security_updates "$(zypper -q --non-interactive lp --category security 2>/dev/null | grep -c '^[^-+ ].*|.*security')"
  elif has apk; then
    add_str package_manager apk
    add_num pending_updates "$(apk version -l '<' 2>/dev/null | grep -c '<')"
  fi
fi

if want security; then
  FW=""
  if has ufw && [ "$IS_ROOT" = 1 ] && ufw status 2>/dev/null | grep -q 'Status: active'; then FW=ufw
  elif has systemctl && systemctl is-active --quiet firewalld 2>/dev/null; then FW=firewalld
  elif has nft && [ "$IS_ROOT" = 1 ] && [ "$(nft list ruleset 2>/dev/null | grep -c 'hook input')" -gt 0 ]; then FW=nftables
  elif has iptables && [ "$IS_ROOT" = 1 ] && [ "$(iptables -S INPUT 2>/dev/null | grep -vc '^-P INPUT ACCEPT')" -gt 0 ]; then FW=iptables
  fi
  if [ -n "$FW" ]; then add_bool firewall_enabled true; add_str firewall "$FW"
  elif [ "$IS_ROOT" = 1 ]; then add_bool firewall_enabled false; fi
  has getenforce && add_str selinux "$(getenforce 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  if has aa-enabled; then aa-enabled --quiet 2>/dev/null && add_str apparmor enabled || add_str apparmor disabled; fi
  if has mokutil; then
    case "$(mokutil --sb-state 2>/dev/null)" in *enabled*) add_bool secure_boot true ;; *disabled*) add_bool secure_boot false ;; esac
  fi
  if has lsblk; then
    if lsblk -rno TYPE 2>/dev/null | grep -qx crypt; then add_bool disk_encrypted true; else add_bool disk_encrypted false; fi
  fi
fi

# Extra fields: "key=value,key2=value2". Values may reference environment variables:
# ${NAME}, ${NAME:-fallback} or %NAME%. Looked up in this order: the environment (cron and
# systemd pass very little), variables set in the config file, then /etc/environment.
# A field whose value ends up empty is left out.
env_lookup() {
  local n="$1" v=""
  v="${!n-}"
  if [ -z "$v" ] && [ -r /etc/environment ]; then
    v=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\{0,1\}$n=//p" /etc/environment | tail -1)
    v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  fi
  printf '%s' "$v"
}
expand_env() {
  local s="$1" out="" m val
  while [[ "$s" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}|%([A-Za-z_][A-Za-z0-9_]*)% ]]; do
    m="${BASH_REMATCH[0]}"
    if [ -n "${BASH_REMATCH[1]}" ]; then
      val=$(env_lookup "${BASH_REMATCH[1]}"); [ -z "$val" ] && val="${BASH_REMATCH[3]}"
    else
      val=$(env_lookup "${BASH_REMATCH[4]}")
    fi
    out+="${s%%"$m"*}$val"; s="${s#*"$m"}"
  done
  printf '%s' "$out$s"
}
if [ -n "$EXTRA" ]; then
  IFS=',' read -ra PAIRS <<<"$EXTRA"
  for p in "${PAIRS[@]}"; do
    k="${p%%=*}"; v="${p#*=}"
    k="${k#"${k%%[![:space:]]*}"}"; k="${k%"${k##*[![:space:]]}"}"
    [ -n "$k" ] && [ "$k" != "$p" ] && add_str "$k" "$(expand_env "$v")"
  done
fi
add_str agent_version "$VERSION"
add_str agent_os linux
add_str check_ports "$CHECK_PORTS"   # an instruction to the server, not stored as a field

JSON="{$(IFS=,; echo "${FIELDS_JSON[*]}")}"

# ---- 3. send -------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then printf '%s\n' "$JSON"; exit 0; fi
RESP=$(api -w '\n%{http_code}' -X POST -H 'content-type: application/json' --data-binary "$JSON" "$URL/api/checkin") \
  || die "could not reach $URL/api/checkin"
CODE="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"
case "$CODE" in
  200|201)
    log "Checked in as ${ID:-$HOST_SHORT} ($( [ "$CODE" = 201 ] && echo created || echo updated ), ${#FIELDS_JSON[@]} fields)."
    if [ -n "$CHECK_PORTS" ]; then
      if printf '%s' "$BODY" | grep -q '"portCheck"[[:space:]]*:[[:space:]]*"off"'; then log "  port checks are turned off on the server (Admin > Port checks)"
      elif ! print_ports "$BODY"; then log "  port check: $(printf '%s' "$BODY" | grep -o '"portCheckError"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:[[:space:]]*"//; s/"$//')"; fi
    fi
    exit 0 ;;
  503) log "Server paused while sending. Nothing saved."; exit 2 ;;
  401|403) die "server refused the API key (HTTP $CODE): ${BODY:0:200}" ;;
  *) die "check-in failed (HTTP $CODE): ${BODY:0:200}" ;;
esac
