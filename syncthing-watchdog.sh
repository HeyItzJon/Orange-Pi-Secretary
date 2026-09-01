#!/usr/bin/env bash
# syncthing-watchdog.sh — round 53. Jon: "let's do that script that makes
# sure sync thing is actually running, in fact."
#
# Why this exists (see claude/round-52-syncthing-conflict-holdings-fix.md's
# addendum for the full incident): Syncthing's packaged unit already has
# Restart=on-failure, but that only fires on a *crash* exit — it does NOT
# restart after a clean `systemctl stop` or a plain SIGTERM sent outside
# systemd's own stop-job tracking (e.g. `kill -15` from an SSH session).
# That's exactly what happened on Aug 31: Syncthing was stopped cleanly,
# systemd correctly saw nothing to restart, and it just sat down for ~17
# hours until Jon noticed the vault had stopped syncing. This script is
# the fix for THAT gap specifically — it doesn't replace systemd's own
# restart-on-crash behavior, it covers the "stopped on purpose or by
# accident, and nobody told it to come back" case systemd never will.
#
# Triggered every 5 minutes by syncthing-watchdog.timer — not meant to be
# run by hand, though it's safe to (it's idempotent: if Syncthing's
# already up, this is a no-op and exits 0 immediately).
#
# Runs as root (see syncthing-watchdog.service) so `systemctl start` needs
# no sudo rule of its own — scoped to exactly the one systemctl call
# below, nothing broader.

set -euo pipefail

UNIT="syncthing@jonbourgy.service"

if systemctl is-active --quiet "$UNIT"; then
  # Already up — the common case, every 5 minutes, forever. Nothing to log.
  exit 0
fi

echo "syncthing-watchdog: $UNIT is not active — starting it"

if systemctl start "$UNIT"; then
  echo "syncthing-watchdog: $UNIT started successfully"
  exit 0
else
  echo "syncthing-watchdog: failed to start $UNIT — see 'systemctl status $UNIT' and 'journalctl -u $UNIT' on the Pi" >&2
  exit 1
fi
