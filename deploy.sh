#!/usr/bin/env bash
# deploy.sh — the one command to run on the Pi after pushing new code.
#
# Pulls the latest commit, reinstalls dependencies, rebuilds the frontend,
# runs the backend test suite as a safety gate (so a bad pull never goes
# live silently), and only then restarts the actual running service — no
# more manual `pkill` + `nohup ... &` + `cd frontend && npm run build`
# dance. Run it from anywhere; it finds its own directory first.
#
#   ./deploy.sh              full deploy, tests included
#   ./deploy.sh --skip-tests skip the test gate if you're in a hurry
#
# Requires the one-time systemd setup described in pi-secretary.service
# (same folder) — that's what makes the "restart" step below work without
# you having to find and kill the old process by hand.

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

echo "==> pulling latest code"
git pull --ff-only

echo "==> installing backend dependencies"
(cd backend && npm install --omit=dev)

if [[ "${1:-}" != "--skip-tests" ]]; then
  echo "==> running backend tests (safety gate — pass --skip-tests to skip)"
  (cd backend && npm test)
else
  echo "==> skipping tests (--skip-tests)"
fi

echo "==> building frontend"
(cd frontend && npm install && npm run build)

echo "==> restarting pi-secretary"
sudo systemctl restart pi-secretary
sleep 1
sudo systemctl --no-pager --full status pi-secretary || true

echo
echo "==> done. Tail logs any time with: journalctl -u pi-secretary -f"
