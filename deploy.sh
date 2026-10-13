#!/usr/bin/env bash
# Deploy Hoardware: pull the latest code, build the containers, make sure a .env
# exists (asking for what it needs the first time), and start everything.
#
#   ./deploy.sh              # normal deploy
#   ./deploy.sh --no-cache   # rebuild the images from scratch (also refreshes base images)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NO_CACHE=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE=1 ;;
    -h | --help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
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

# ---------------------------------------------------------------- 1. pull
step "1/5 Pulling the latest code"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only || die "git pull failed. Resolve it (local changes or diverged history) and run again."
else
  warn "not a git checkout, skipping the pull."
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
else
  [ -t 0 ] || die ".env is missing and this is not an interactive terminal. Copy .env.example to .env and edit it, or run ./deploy.sh from a terminal."
  [ -f .env.example ] || die ".env.example is missing."

  # ------------------------------------------------------------ 4. create .env
  step "4/5 Creating .env (press Enter to accept the value in brackets)"

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
    while [ -z "$reply" ]; do read -r -s -p "$2: " reply; echo; done
    printf -v "$1" '%s' "$reply"
  }
  yes_no() { # yes_no "Question" default(y|n)
    local reply hint="[Y/n]"
    [ "$2" = n ] && hint="[y/N]"
    read -r -p "$1 $hint: " reply
    reply="${reply:-$2}"
    [[ "$reply" =~ ^[Yy] ]]
  }
  # Write KEY=value into .env, single-quoted so characters like $ and # survive.
  set_env() { # set_env KEY value
    case "$2" in *"'"*) die "$1 must not contain a single quote (')." ;; esac
    local tmp
    tmp="$(mktemp)"
    VAL="'$2'" awk -v key="$1" 'BEGIN { FS = OFS = "=" }
      $1 == key && !done { print key "=" ENVIRON["VAL"]; done = 1; next } { print }
      END { if (!done) print key "=" ENVIRON["VAL"] }' "$NEW_ENV" >"$tmp"
    cat "$tmp" >"$NEW_ENV"
    rm -f "$tmp"
  }
  random_secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 32 || true; }

  # Built in a temporary file and moved into place only when complete, so an aborted
  # run (Ctrl-C, a typo) never leaves a half-written .env behind.
  NEW_ENV=".env.new.$$"
  trap 'rm -f "$NEW_ENV"' EXIT
  cp .env.example "$NEW_ENV"
  chmod 600 "$NEW_ENV"

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
  while :; do
    ask_secret AUTH_PASS "  Password (at least 8 characters)"
    if [ "${#AUTH_PASS}" -lt 8 ]; then warn "too short."; continue; fi
    ask_secret AUTH_PASS2 "  Repeat the password"
    [ "$AUTH_PASS" = "$AUTH_PASS2" ] && break
    warn "the passwords differ."
  done
  hash_line="$(printf '%s\n' "$AUTH_PASS" | docker compose run --rm -T --no-deps backend python -m app.cli hash-password --password-stdin | grep '^AUTH_PASSWORD_HASH=')" \
    || die "could not hash the password."
  unset AUTH_PASS AUTH_PASS2
  set_env AUTH_USERNAME "$AUTH_USER"
  set_env AUTH_PASSWORD_HASH "${hash_line#AUTH_PASSWORD_HASH=}"

  # Storage
  echo
  USE_S3=0
  if yes_no "Store photos and downloads in S3 (instead of a local Docker volume)?" n; then
    USE_S3=1
    while :; do
      ask S3_ENDPOINT "  Endpoint URL (empty for AWS S3), e.g. https://s3.example.com" ""
      ask S3_REGION "  Region" "us-east-1"
      ask_required S3_BUCKET "  Bucket name (must already exist)"
      ask_required S3_KEY "  Access key"
      ask_secret S3_SECRET "  Secret key"
      if yes_no "  Path-style addressing (right for most self-hosted S3 such as RustFS or MinIO)?" y; then S3_PATH=true; else S3_PATH=false; fi
      set_env S3_ENDPOINT_URL "$S3_ENDPOINT"
      set_env S3_REGION "$S3_REGION"
      set_env S3_BUCKET "$S3_BUCKET"
      set_env S3_ACCESS_KEY_ID "$S3_KEY"
      set_env S3_SECRET_ACCESS_KEY "$S3_SECRET"
      set_env S3_FORCE_PATH_STYLE "$S3_PATH"
      if docker compose --env-file "$NEW_ENV" run --rm -T --no-deps backend python -c \
        "from app.storage import build_storage; build_storage('s3').check()" >/dev/null 2>&1; then
        ok "S3 is reachable and the bucket is accessible"
        break
      fi
      warn "could not reach the bucket with those details."
      yes_no "  Enter them again?" y || { warn "keeping them as entered; fix them in .env if needed."; break; }
    done
    unset S3_SECRET
  fi

  # Backups
  echo
  if yes_no "Take a database backup every day?" y; then
    set_env COMPOSE_PROFILES backup
    if [ "$USE_S3" = 1 ] && yes_no "  Also upload each backup to the S3 bucket (under backups/)?" y; then
      set_env BACKUP_S3_BUCKET "$S3_BUCKET"
    fi
  fi

  mv "$NEW_ENV" .env
  trap - EXIT
  ok ".env written (readable only by you)"
fi

# ---------------------------------------------------------------- 5. start
step "5/5 Starting the application"
docker compose up -d --wait --wait-timeout 240 || {
  docker compose ps
  die "the application did not become healthy. See: docker compose logs --tail=100"
}
PORT="$(grep -E '^FRONTEND_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "'\"")"
echo
ok "Hoardware is running: http://localhost:${PORT:-3000}"
echo "  Logs:   docker compose logs -f"
echo "  Update: ./deploy.sh"
