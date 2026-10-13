#!/bin/bash
# Bug-for-bug parity test against the original PHP parser.
# Needs php-cli. Downloads ical.php from trmnl-calendar (not redistributed here).
set -e
cd "$(dirname "$0")"
[ -f ical.php ] || curl -fsSL https://raw.githubusercontent.com/zoltanhosszu/trmnl-calendar/main/server/ical.php -o ical.php
(cd ../.. && npm run build >/dev/null)
DATES=$(node -e "const d=[];for(let t=Date.UTC(2026,0,1);t<=Date.UTC(2027,0,31);t+=864e5)d.push(new Date(t).toISOString().slice(0,10));console.log(d.join(','))")
TZS=(America/New_York Europe/Berlin Australia/Sydney UTC)
mkdir -p out; fail=0
for seed in $(seq 1 ${1:-20}); do
  tz=${TZS[$((seed%4))]}
  node gen.js out/c$seed.ics $seed
  php harness_multi.php out/c$seed.ics $tz 2 $DATES > out/p$seed.json 2>/dev/null
  node compare.js out/c$seed.ics $tz 2 $DATES out/p$seed.json || fail=1
done
exit $fail
