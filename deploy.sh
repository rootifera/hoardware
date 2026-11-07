#!/usr/bin/env bash
# Deploy Hoardware: pull the latest code, build the containers, make sure a .env
# exists (asking for what it needs the first time), start everything, and keep the
# CPU and GPU reference data downloaded and imported.
#
#   ./deploy.sh                    # normal deploy
#   ./deploy.sh --no-cache         # rebuild the images from scratch (also refreshes base images)
#   ./deploy.sh --reset-password   # choose a new sign-in password (signs everyone out)
#   ./deploy.sh --no-data          # skip the reference data step (e.g. no internet access)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NO_CACHE=0
RESET_PASSWORD=0
SKIP_DATA=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE=1 ;;
    --reset-password) RESET_PASSWORD=1 ;;
    --no-data) SKIP_DATA=1 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok() { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*" >&2; }
die() { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "the 'docker compose' plugin (v2) is required."

# ------------------------------------------------------------------ helpers
ENV_FILE=".env" # while a new .env is being written this points at a temporary file

ask() { # ask VAR "Question" "default"
  local reply
  read -r -p "$2${3:+ [$3]}: " reply
  printf -v "$1" '%s' "${reply:-${3:-}}"
}
ask_required() { # ask_required VAR "Question"
  local reply=""
  while [ -z "$reply" ]; do read -r -p "$2: " reply; done
  printf -v "$1" '%s' "$reply"
}
ask_secret() { # ask_secret VAR "Question"  (not echoed, must not be empty)
  local reply=""
  while [ -z "$reply" ]; do read -r -s -p "$2: " reply; echo >&2; done
  printf -v "$1" '%s' "$reply"
}
yes_no() { # yes_no "Question" default(y|n)
  local reply hint="[Y/n]"
  [ "$2" = n ] && hint="[y/N]"
  read -r -p "$1 $hint: " reply
  reply="${reply:-$2}"
  [[ "$reply" =~ ^[Yy] ]]
}
# Write KEY=value into $ENV_FILE, single-quoted so characters like $ and # survive.
set_env() { # set_env KEY value
  case "$2" in *"'"*) die "$1 must not contain a single quote (')." ;; esac
  local tmp
  tmp="$(mktemp)"
  VAL="'$2'" awk -v key="$1" 'BEGIN { FS = OFS = "=" }
    $1 == key && !done { print key "=" ENVIRON["VAL"]; done = 1; next } { print }
    END { if (!done) print key "=" ENVIRON["VAL"] }' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}
get_env() { # get_env KEY [default]   (value from .env, quotes removed)
  local v=""
  [ -f .env ] && v="$(grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//')" || true
  printf '%s' "${v:-${2:-}}"
}
get_env_file() { # get_env_file KEY   (from the .env being written, quotes removed)
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e "s/^'//" -e "s/'$//"
}
random_secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 32 || true; }

# Ask for a new password twice and print its hash line (AUTH_PASSWORD_HASH=...).
# The password goes to the hasher on stdin, never on a command line or into .env.
ask_password_hash() {
  local p1 p2
  while :; do
    ask_secret p1 "  Password (at least 8 characters)"
    if [ "${#p1}" -lt 8 ]; then warn "too short."; continue; fi
    ask_secret p2 "  Repeat the password"
    [ "$p1" = "$p2" ] && break
    warn "the passwords differ."
  done
  printf '%s\n' "$p1" | docker compose run --rm -T --no-deps backend python -m app.cli hash-password --password-stdin |
    grep '^AUTH_PASSWORD_HASH=' || die "could not hash the password."
}

# Ask for S3 connection details and write them with the given variable prefix
# ("S3_" for photos and files, "BACKUP_S3_" for backups). Offers to retry until the bucket
# is reachable. Leaves the entered values in S3_BUCKET_ENTERED.
configure_s3() { # configure_s3 PREFIX "check command (python code)"
  local prefix="$1" check="$2" endpoint region bucket key secret path_style
  while :; do
    ask endpoint "  Endpoint URL (empty for AWS S3), e.g. https://s3.example.com" ""
    ask region "  Region" "us-east-1"
    ask_required bucket "  Bucket name (must already exist)"
    ask_required key "  Access key"
    ask_secret secret "  Secret key"
    if yes_no "  Path-style addressing (right for most self-hosted S3 such as RustFS or MinIO)?" y; then path_style=true; else path_style=false; fi
    set_env "${prefix}ENDPOINT_URL" "$endpoint"
    set_env "${prefix}REGION" "$region"
    set_env "${prefix}BUCKET" "$bucket"
    set_env "${prefix}ACCESS_KEY_ID" "$key"
    set_env "${prefix}SECRET_ACCESS_KEY" "$secret"
    set_env "${prefix}FORCE_PATH_STYLE" "$path_style"
    if docker compose --env-file "$ENV_FILE" run --rm -T --no-deps backend sh -c "$check" >/dev/null 2>&1; then
      ok "the bucket is reachable"
      break
    fi
    warn "could not reach the bucket with those details."
    yes_no "  Enter them again?" y || { warn "keeping them as entered; fix them in .env if needed."; break; }
  done
  S3_BUCKET_ENTERED="$bucket"
}

# Created up front, as the current user: if it is missing when a container mounts it, Docker
# creates the folder itself, owned by root, and the reference data could not be downloaded into it.
mkdir -p "$(get_env REFERENCE_DATA_DIR ./reference-data)"

# Ask for the (optional) token the app uses to read version.json from a private GitHub repository,
# and point the check at this checkout's own repository and branch.
configure_version_check() {
  local token origin repo branch
  echo
  echo "Update notice: the app checks the git repository for a newer version.json every few hours and"
  echo "shows a small \"update available\" note. A private repository needs a read-only access token"
  echo "(GitHub > Settings > Developer settings > Fine-grained tokens: this repository only,"
  echo "permission \"Contents: read-only\"). Leave empty to skip."
  read -r -s -p "  Token: " token
  echo >&2
  set_env VERSION_CHECK_TOKEN "$token"
  origin="$(git remote get-url origin 2>/dev/null || true)"
  repo="$(printf '%s' "$origin" | sed -nE 's#^(git@github\.com:|https://github\.com/)([^/]+/[^/]+)$#\2#p' | sed 's/\.git$//')"
  if [ -n "$repo" ]; then
    branch="$(git symbolic-ref --short -q HEAD 2>/dev/null || echo main)"
    set_env VERSION_CHECK_URL "https://raw.githubusercontent.com/$repo/$branch/version.json"
  fi
}

# ---------------------------------------------------------------- 1. pull
step "1/5 Pulling the latest code"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  warn "not a git checkout, skipping the pull."
elif ! git symbolic-ref -q HEAD >/dev/null 2>&1; then
  warn "no branch is checked out (detached HEAD), skipping the pull."
else
  git pull --ff-only || die "git pull failed. Resolve it (local changes or diverged history) and run again."
fi

# ---------------------------------------------------------------- 2. build
step "2/5 Building the containers"
if [ "$NO_CACHE" = 1 ]; then
  docker compose build --no-cache --pull
else
  docker compose build
fi
ok "images built"

# ---------------------------------------------------------------- 3. .env
step "3/5 Checking .env"
if [ -f .env ]; then
  ok ".env exists, keeping it as it is"
  # An install from before the update notice: ask for the token once (the key is then in .env).
  if [ -t 0 ] && ! grep -q '^VERSION_CHECK_TOKEN=' .env; then
    configure_version_check
  fi
  # An install from before backup monitoring: scheduled backups are on, so have the app watch them.
  if [ "$(get_env COMPOSE_PROFILES)" = backup ] && [ -z "$(get_env BACKUP_EXPECTED)" ]; then
    set_env BACKUP_EXPECTED yes
    ok "the app will now warn if scheduled backups stop (BACKUP_EXPECTED=yes added to .env)"
  fi
  if [ "$RESET_PASSWORD" = 1 ]; then
    [ -t 0 ] || die "--reset-password needs an interactive terminal."
    echo
    echo "New sign-in details (the current password is replaced; everyone is signed out):"
    ask NEW_USER "  Username" "$(get_env AUTH_USERNAME admin)"
    hash_line="$(ask_password_hash)"
    set_env AUTH_USERNAME "$NEW_USER"
    set_env AUTH_PASSWORD_HASH "${hash_line#AUTH_PASSWORD_HASH=}"
    set_env AUTH_PASSWORD ""
    ok "sign-in details updated"
  fi
else
  [ -t 0 ] || die ".env is missing and this is not an interactive terminal. Copy .env.example to .env and edit it, or run ./deploy.sh from a terminal."
  [ -f .env.example ] || die ".env.example is missing."

  echo "Creating .env (press Enter to accept the value in brackets)"
  # Built in a temporary file and moved into place only when complete, so an aborted
  # run (Ctrl-C, a typo) never leaves a half-written .env behind.
  ENV_FILE=".env.new.$$"
  trap 'rm -f "$ENV_FILE"' EXIT
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # General
  detected_tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)"
  ask TZ_VALUE "Timezone (used for \"today\" in test and verified dates)" "${detected_tz:-UTC}"
  ask PORT_VALUE "Port the web interface listens on" "3000"
  set_env TZ "$TZ_VALUE"
  set_env FRONTEND_PORT "$PORT_VALUE"

  # Database password: generated, unless a database from an earlier install is still there.
  project="$(basename "$PWD" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]//g')"
  project="${COMPOSE_PROJECT_NAME:-$project}"
  if docker volume ls -q | grep -qx "${project}_db_data"; then
    warn "A database from an earlier install exists. It still needs its old password."
    ask_secret DB_PASSWORD "POSTGRES_PASSWORD of that install"
  else
    DB_PASSWORD="$(random_secret)"
  fi
  set_env POSTGRES_PASSWORD "$DB_PASSWORD"
  unset DB_PASSWORD

  # Login
  echo
  echo "Sign-in for the web interface:"
  ask AUTH_USER "  Username" "admin"
  hash_line="$(ask_password_hash)"
  set_env AUTH_USERNAME "$AUTH_USER"
  set_env AUTH_PASSWORD_HASH "${hash_line#AUTH_PASSWORD_HASH=}"

  # Photo and file storage
  echo
  USE_S3=0
  DATA_BUCKET=""
  if yes_no "Store photos and downloads in S3 (instead of a local Docker volume)?" n; then
    USE_S3=1
    echo "  Use a bucket (or a folder inside it) that no other Hoardware install shares."
    configure_s3 "S3_" "python -c \"from app.storage import build_storage; build_storage('s3').check()\""
    DATA_BUCKET="$S3_BUCKET_ENTERED"
    ask S3_FOLDER "  Folder inside the bucket (empty = the bucket root)" ""
    [ -n "$S3_FOLDER" ] && set_env S3_PREFIX "${S3_FOLDER%/}/"
  fi

  # Backups
  echo
  if yes_no "Take a database backup every day?" y; then
    set_env COMPOSE_PROFILES backup
    # The app warns on screen when backups stop running or fail.
    set_env BACKUP_EXPECTED yes
    echo "  Backups are always kept in a local Docker volume. Copy them somewhere else too?"
    echo "    1) No, local volume only"
    if [ "$USE_S3" = 1 ]; then
      echo "    2) Yes, into the same S3 bucket as the photos (under backups/)"
    fi
    echo "    3) Yes, to a different S3 bucket or service (safest: survives losing the photo storage)"
    default_choice=3
    [ "$USE_S3" = 1 ] && default_choice=2
    while :; do
      ask BACKUP_CHOICE "  Choose" "$default_choice"
      case "$BACKUP_CHOICE" in
        1) break ;;
        2) [ "$USE_S3" = 1 ] && { set_env BACKUP_S3_BUCKET "$DATA_BUCKET"; break; } ;;
        3)
          configure_s3 "BACKUP_S3_" "python -m app.cli check-backup-s3"
          break
          ;;
      esac
      warn "enter one of the numbers shown."
    done
  fi

  if [ "$(get_env_file COMPOSE_PROFILES)" = backup ]; then
    echo
    echo "  A message can be sent to a webhook if a scheduled backup fails (Slack, Discord, Mattermost,"
    echo "  Gotify, or an ntfy topic URL). Leave empty for none: the app still shows a warning on screen."
    ask NOTIFY_URL "  Webhook URL" ""
    [ -n "$NOTIFY_URL" ] && set_env BACKUP_NOTIFY_URL "$NOTIFY_URL"
  fi

  configure_version_check

  # Reference data
  echo
  if yes_no "Download and import the CPU and GPU reference data (needs git and internet access)?" y; then
    set_env REFERENCE_DATA yes
  else
    set_env REFERENCE_DATA no
  fi

  mv "$ENV_FILE" .env
  trap - EXIT
  ENV_FILE=".env"
  ok ".env written (readable only by you)"
fi

# ---------------------------------------------------------------- 4. start
step "4/5 Starting the application"
docker compose up -d --wait --wait-timeout 240 || {
  docker compose ps
  die "the application did not become healthy. See: docker compose logs --tail=100"
}
PORT="$(get_env FRONTEND_PORT 3000)"
ok "Hoardware is running: http://localhost:${PORT}"

# ---------------------------------------------------------------- 5. reference data
# CPU-DB and GPUs-Specs are cloned into ./reference-data (or updated if already there) and
# imported when they are new, changed or not yet in the database. A problem here never
# stops the deploy: the application works without them, they only power the suggestions.
step "5/5 Reference data (CPU and GPU suggestions)"
refdata_dir="$(get_env REFERENCE_DATA_DIR ./reference-data)"
if [ "$SKIP_DATA" = 1 ] || [ "$(get_env REFERENCE_DATA yes)" = no ]; then
  ok "skipped"
elif ! command -v git >/dev/null; then
  warn "git is not installed, skipping the reference data."
else
  if [ ! -w "$refdata_dir" ]; then
    warn "$refdata_dir is not writable by you (Docker may have created it as root). Fix with: sudo chown -R \"\$USER\" $refdata_dir"
    exit 0
  fi
  update_dataset() { # update_dataset name url source-key
    local name="$1" url="$2" key="$3" dir="$refdata_dir/$1" changed=0 count before after
    if [ -d "$dir/.git" ]; then
      before="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
      git -C "$dir" pull --ff-only --quiet || warn "$name: could not update, using what is there."
      after="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
      [ "$before" != "$after" ] && changed=1
    elif [ -d "$dir" ]; then
      echo "  $name: using the files already in $dir"
    else
      mkdir -p "$refdata_dir"
      echo "  $name: downloading..."
      if git clone --depth 1 --quiet "$url" "$dir"; then changed=1; else warn "$name: download failed."; return 0; fi
    fi
    count="$(docker compose run --rm -T --no-deps backend python -m app.cli reference-count "$key" 2>/dev/null | tail -1 || echo 0)"
    if [ "$changed" = 1 ] || [ "${count:-0}" = 0 ]; then
      echo "  $name: importing..."
      docker compose run --rm -T --no-deps backend python -m app.cli import-reference "$key" "/reference-data/$name" 2>&1 |
        grep -E '"(added|changed|unchanged|errors)"' | tr -d '\n' | sed 's/  */ /g; s/,/, /g' || true
      echo
    else
      ok "$name: up to date ($count records)"
    fi
  }
  update_dataset cpu-db https://github.com/zymos/cpu-db cpu-db
  update_dataset gpus-specs https://github.com/RonnyMuthomi/GPUs-Specs gpus-specs
fi

echo
ok "Done."
echo "  Logs:            docker compose logs -f"
echo "  Update:          ./deploy.sh"
echo "  New password:    ./deploy.sh --reset-password"
