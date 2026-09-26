#!/bin/sh
# Lattice worker installer (POSIX sh, idempotent).
#
#   sudo sh install.sh            install / upgrade the worker as a systemd service
#   sh install.sh --dry-run       print every action, change nothing (no root needed)
#   INSTALL_PREFIX=/tmp/stage sh install.sh
#                                 stage the file layout under a prefix without root: no user
#                                 creation, no chown, no systemctl
#
# Layout: /opt/lattice (code, pwa/, deploy/), /etc/lattice/worker.env (0600),
#         /var/lib/lattice/runs (service user home + runs), /etc/systemd/system/lattice-worker.service
#
# What it never does: download anything (no engines, no model weights), delete files,
# overwrite an existing worker.env, overwrite a locally edited unit (it writes <unit>.new
# instead), or start the service. Engines and licenses are the operator's job; see the
# next steps printed at the end.
#
# Env overrides: INSTALL_PREFIX, PYTHON (default python3), LATTICE_USER (default lattice).
# MIT License (see LICENSE).

set -eu

usage() {
	sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

DRY=0
for arg in "$@"; do
	case "$arg" in
	-n | --dry-run) DRY=1 ;;
	-h | --help) usage; exit 0 ;;
	*) printf 'install.sh: unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
	esac
done

SRC=$(cd "$(dirname "$0")" && pwd)
PREFIX=${INSTALL_PREFIX:-}
PREFIX=${PREFIX%/}
SVC_USER=${LATTICE_USER:-lattice}
PY=${PYTHON:-python3}

APP_DIR=/opt/lattice
ETC_DIR=/etc/lattice
STATE_DIR=/var/lib/lattice
UNIT_DIR=/etc/systemd/system
UNIT_NAME=lattice-worker.service

APP=$PREFIX$APP_DIR
ETC=$PREFIX$ETC_DIR
STATE=$PREFIX$STATE_DIR
UNITS=$PREFIX$UNIT_DIR

STAGED=0
[ -n "$PREFIX" ] && STAGED=1

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# act CMD...: run it, or print it under --dry-run.
act() {
	if [ "$DRY" = 1 ]; then
		printf '[dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

same_file() {
	[ -f "$2" ] && command -v cmp >/dev/null 2>&1 && cmp -s "$1" "$2"
}

# put SRC DST MODE: copy when missing or different.
put() {
	if same_file "$1" "$2"; then
		say "unchanged  $2"
	else
		act install -m "$3" "$1" "$2"
		[ "$DRY" = 1 ] || say "installed  $2"
	fi
}

mkdirs() {
	# mkdirs MODE DIR... (owner applied separately)
	m=$1
	shift
	for d in "$@"; do
		if [ -d "$d" ]; then
			say "exists     $d/"
		else
			act install -d -m "$m" "$d"
		fi
	done
}

# ---------------------------------------------------------------------------
# 1. Preflight (read-only)
# ---------------------------------------------------------------------------
say "Lattice worker installer ($([ "$DRY" = 1 ] && echo dry run || echo live)$([ "$STAGED" = 1 ] && echo ", staged under $PREFIX"))"

command -v "$PY" >/dev/null 2>&1 || die "$PY not found; install Python 3.10+ first"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' ||
	die "Python 3.10+ required, found $("$PY" -c 'import sys; print(sys.version.split()[0])')"
PY_ABS=$(command -v "$PY")
case "$PY_ABS" in /*) ;; *) PY_ABS=$(cd "$(dirname "$PY_ABS")" && pwd)/$(basename "$PY_ABS") ;; esac
say "python     $PY_ABS ($("$PY" -c 'import sys; print(sys.version.split()[0])'))"

if [ "$DRY" = 0 ] && [ "$STAGED" = 0 ] && [ "$(id -u)" != 0 ]; then
	die "run as root (sudo sh install.sh), or use --dry-run / INSTALL_PREFIX=<dir>"
fi

CODE_FILES="worker.py batch.py LICENSE NOTICE README.md DEPLOY.md"
PWA_FILES="index.html styles.css app.js sw.js manifest.json icon.svg"
DEPLOY_FILES="lattice-worker.service worker.env.example Caddyfile docker-compose.yml"
for f in $CODE_FILES $PWA_FILES exporters/__init__.py; do
	[ -f "$SRC/$f" ] || die "missing source file $SRC/$f (run from a complete lattice-ide checkout)"
done
for f in $DEPLOY_FILES; do
	[ -f "$SRC/deploy/$f" ] || die "missing source file $SRC/deploy/$f"
done

# ---------------------------------------------------------------------------
# 2. Service user
# ---------------------------------------------------------------------------
if [ "$STAGED" = 1 ]; then
	say "skip       service user '$SVC_USER' (staged install)"
elif id -u "$SVC_USER" >/dev/null 2>&1; then
	say "exists     user $SVC_USER"
else
	NOLOGIN=/usr/sbin/nologin
	[ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
	if command -v useradd >/dev/null 2>&1; then
		act useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home \
			--shell "$NOLOGIN" --comment "Lattice worker" "$SVC_USER"
	elif command -v adduser >/dev/null 2>&1; then
		act adduser -S -D -H -h "$STATE_DIR" -s "$NOLOGIN" "$SVC_USER"
	else
		die "neither useradd nor adduser found; create the '$SVC_USER' system user yourself"
	fi
fi

# ---------------------------------------------------------------------------
# 3. Directories
# ---------------------------------------------------------------------------
mkdirs 0755 "$APP" "$APP/exporters" "$APP/pwa" "$APP/deploy" "$APP/examples" "$UNITS"
mkdirs 0750 "$ETC" "$STATE" "$STATE/runs"
if [ "$STAGED" = 0 ]; then
	act chown root:"$SVC_USER" "$ETC"
	act chown "$SVC_USER:$SVC_USER" "$STATE" "$STATE/runs"
fi

# ---------------------------------------------------------------------------
# 4. Files (code upgrades overwrite; nothing is ever deleted)
# ---------------------------------------------------------------------------
for f in $CODE_FILES; do
	put "$SRC/$f" "$APP/$f" 0644
done
# Optional multi-user helper module.
[ -f "$SRC/users.py" ] && put "$SRC/users.py" "$APP/users.py" 0644
for f in "$SRC"/exporters/*.py; do
	put "$f" "$APP/exporters/$(basename "$f")" 0644
done
for f in $PWA_FILES; do
	put "$SRC/$f" "$APP/pwa/$f" 0644
done
for f in $DEPLOY_FILES; do
	put "$SRC/deploy/$f" "$APP/deploy/$f" 0644
done
for f in "$SRC"/examples/*.json; do
	[ -f "$f" ] && put "$f" "$APP/examples/$(basename "$f")" 0644
done

# ---------------------------------------------------------------------------
# 5. Environment file (created once, never overwritten)
# ---------------------------------------------------------------------------
ENV_FILE=$ETC/worker.env
NEW_TOKEN=0
if [ -f "$ENV_FILE" ]; then
	say "kept       $ENV_FILE (existing settings untouched)"
elif [ "$DRY" = 1 ]; then
	say "[dry-run] create $ENV_FILE from deploy/worker.env.example (mode 0600, fresh random LATTICE_TOKEN)"
else
	TOKEN=$("$PY" -c 'import secrets; print(secrets.token_hex(32))')
	(
		umask 077
		sed "s|^LATTICE_TOKEN=.*|LATTICE_TOKEN=$TOKEN|" "$SRC/deploy/worker.env.example" >"$ENV_FILE"
	)
	chmod 0600 "$ENV_FILE"
	[ "$STAGED" = 0 ] && chown root:root "$ENV_FILE"
	unset TOKEN
	NEW_TOKEN=1
	say "created    $ENV_FILE (mode 0600, random LATTICE_TOKEN)"
fi

# ---------------------------------------------------------------------------
# 6. systemd unit (ExecStart points at the python found above)
# ---------------------------------------------------------------------------
UNIT_DST=$UNITS/$UNIT_NAME
if [ "$DRY" = 1 ]; then
	say "[dry-run] install $UNIT_DST (ExecStart=$PY_ABS $APP_DIR/worker.py; kept as $UNIT_NAME.new if the existing unit was edited)"
else
	UNIT_TMP=$UNITS/.$UNIT_NAME.tmp
	sed "s|^ExecStart=/usr/bin/python3 |ExecStart=$PY_ABS |" "$SRC/deploy/$UNIT_NAME" >"$UNIT_TMP"
	if same_file "$UNIT_TMP" "$UNIT_DST"; then
		rm -f "$UNIT_TMP"
		say "unchanged  $UNIT_DST"
	elif [ -f "$UNIT_DST" ]; then
		chmod 0644 "$UNIT_TMP"
		mv -f "$UNIT_TMP" "$UNIT_DST.new"
		warn "$UNIT_DST differs from the shipped unit; left it alone and wrote $UNIT_DST.new (diff and merge by hand)"
	else
		chmod 0644 "$UNIT_TMP"
		mv -f "$UNIT_TMP" "$UNIT_DST"
		say "installed  $UNIT_DST"
	fi
fi
if [ "$STAGED" = 0 ] && command -v systemctl >/dev/null 2>&1; then
	act systemctl daemon-reload
elif [ "$STAGED" = 0 ]; then
	warn "systemctl not found; run $APP_DIR/worker.py under your own supervisor"
fi

# ---------------------------------------------------------------------------
# 7. Next steps
# ---------------------------------------------------------------------------
cat <<EOF

Done. Nothing was started and no engines or model weights were downloaded.

Next steps:
  1. Edit $ETC_DIR/worker.env (root, 0600):
       LATTICE_REGION   REQUIRED: ISO country code of this machine (e.g. US). EU-27/GB/KR disables HY-World.
       LATTICE_TOKEN    $([ "$NEW_TOKEN" = 1 ] && echo "a random token was generated;" || echo "set a long random secret;") show it with:
                          sudo grep ^LATTICE_TOKEN= $ETC_DIR/worker.env
                        and enter it in the PWA under More -> Settings.
       LATTICE_EXEC=1   only after engines are installed (until then every job is a dry run).
  2. Licenses: the customer accepts the Cosmos 3 OpenMDW 1.1 license and Tencent's HY-World 2.0
     License.txt (incl. its Acceptable Use Policy) on Hugging Face with their own account.
     HY-World must not be used or its outputs shown in the EU-27, UK or South Korea. See $APP_DIR/DEPLOY.md.
  3. Install the engines you licensed separately (this script installs none), then set
     LATTICE_COSMOS_MODULE / LATTICE_HY_MODULE (and *_CMD) to match them. Weights are fetched
     by the engines at run time with the per-job HF token; never bake them into this host image.
  4. Start it:   systemctl enable --now lattice-worker
                 curl -s http://127.0.0.1:8787/health
  5. HTTPS: install Caddy, copy $APP_DIR/deploy/Caddyfile to /etc/caddy/Caddyfile, set
     LATTICE_DOMAIN for Caddy, reload it. PWA: https://<domain>/  worker URL: https://<domain>/api
     Keep port 8787 closed to the outside.
EOF
