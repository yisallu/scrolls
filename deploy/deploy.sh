#!/usr/bin/env bash
# Deploy 千卷 (scrolls) to a server.
#
#   bash deploy/deploy.sh kr           # push code, install/restart the service
#   bash deploy/deploy.sh kr --dry-run # show what would happen, touch nothing
#
# Design notes, learned from v1's deploy script:
#   * PORT IS PER HOST. v1 shipped one hard-coded unit file (8799) and running it
#     against a box where 8799 was taken silently broke the site. Ports live in the
#     host table below and the unit file is generated from a template.
#   * data/ IS NEVER SYNCED. Rules and your library live only on the server.
#   * The service name and directory are per host too, so v2 can run beside an
#     existing v1 install until you flip nginx over to it.
#   * The Python TLS sidecar is NOT rebuilt here — its venv is expensive and shared.
set -euo pipefail

HOST="${1:-}"
DRY=""
[[ "${2:-}" == "--dry-run" ]] && DRY=1
if [[ -z "$HOST" ]]; then
  echo "usage: bash deploy/deploy.sh <ssh-host> [--dry-run]" >&2
  exit 2
fi

# ---- host table -------------------------------------------------------------------
# port: the Node app's loopback port     bind: 127.0.0.1 unless you want it public
case "$HOST" in
  kr)  PORT=8811; BIND=127.0.0.1; REMOTE=/opt/scrolls; SERVICE=scrolls; SEED_FROM= ;;
  mx)  PORT=8799; BIND=127.0.0.1; REMOTE=/opt/scrolls;  SERVICE=scrolls;  SEED_FROM= ;;
  *)   PORT="${PORT:-8799}"; BIND="${BIND:-127.0.0.1}"; REMOTE="${REMOTE:-/opt/scrolls}"; SERVICE="${SERVICE:-scrolls}"; SEED_FROM="${SEED_FROM:-}" ;;
esac

APPDIR="$(cd "$(dirname "$0")/.." && pwd)"

echo ">> host=$HOST service=$SERVICE dir=$REMOTE port=$PORT bind=$BIND"
if [[ -n "$DRY" ]]; then
  echo ">> dry run: would sync $APPDIR (minus node_modules/data/dist/tmp) and (re)start $SERVICE"
  exit 0
fi

echo ">> syncing code"
# One manifest drives both halves of the sync, so what gets pruned is exactly the
# complement of what got sent.
MANIFEST="$(mktemp)"
trap 'rm -f "$MANIFEST"' EXIT
( cd "$APPDIR" && find . -type f \
    -not -path './node_modules/*' -not -path './data/*' -not -path './dist/*' \
    -not -path './tmp/*' -not -path './.git/*' -not -path './.playwright-mcp/*' \
    -not -name '*.log' | sed 's|^\./||' | LC_ALL=C sort ) > "$MANIFEST"

tar -czf - -C "$APPDIR" -T "$MANIFEST" | ssh "$HOST" "mkdir -p $REMOTE && tar -xzf - -C $REMOTE"

# tar only ADDS. A file deleted locally used to live on forever on the server, and that
# is not cosmetic: a deleted frontend module kept being served, so a browser holding a
# cached older page could still import it and run code that no longer exists here. It
# looked exactly like "the feature is broken on that one device".
# Scoped to the code directories — data/ and node_modules/ are never touched.
echo ">> pruning files that no longer exist locally"
REMOTE_LIST="/tmp/scrolls-sync-$$"
scp -q "$MANIFEST" "$HOST:$REMOTE_LIST.want"
ssh "$HOST" "export LC_ALL=C; cd '$REMOTE' && tr -d '\r' < '$REMOTE_LIST.want' | sort > '$REMOTE_LIST.w' && find server web tools test deploy -type f 2>/dev/null | sort > '$REMOTE_LIST.have' && comm -13 '$REMOTE_LIST.w' '$REMOTE_LIST.have' > '$REMOTE_LIST.gone' && sed 's|^|   - |' '$REMOTE_LIST.gone' && xargs -r -d '\n' rm -f -- < '$REMOTE_LIST.gone'; rm -f '$REMOTE_LIST'.*"

echo ">> installing dependencies and (re)starting the service"
ssh "$HOST" REMOTE="$REMOTE" SERVICE="$SERVICE" PORT="$PORT" BIND="$BIND" SEED_FROM="$SEED_FROM" bash -se <<'REMOTE_SCRIPT'
set -euo pipefail

id scrolls >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin scrolls

cd "$REMOTE/"
npm install --omit=dev --no-audit --no-fund

# First deploy on a box that already runs an older install: bring the rules and the
# library across, so the new service starts with the sites you already had.
mkdir -p "$REMOTE/data/rules"
if [[ -n "${SEED_FROM:-}" && -d "$SEED_FROM" ]] && [[ -z "$(ls -A "$REMOTE/data/rules" 2>/dev/null)" ]]; then
  echo ">> seeding data/ from $SEED_FROM"
  cp -a "$SEED_FROM/." "$REMOTE/data/"
fi
chown -R scrolls:scrolls "$REMOTE"

sed -e "s#@REMOTE@#$REMOTE#g" -e "s#@PORT@#$PORT#g" -e "s#@BIND@#$BIND#g" -e "s#@NAME@#$SERVICE#g" \
  "$REMOTE/deploy/scrolls.service.tmpl" > "/etc/systemd/system/$SERVICE.service"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 1.5
systemctl --no-pager --full status "$SERVICE" | head -8
curl -fsS "http://127.0.0.1:$PORT/api/healthz" && echo "  <- healthz ok"
curl -fsS "http://127.0.0.1:$PORT/api/stats" && echo
REMOTE_SCRIPT

echo ">> done."
echo "   Point nginx at 127.0.0.1:$PORT (see deploy/README-deploy.md), then reload nginx."
