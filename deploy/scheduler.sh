#!/bin/sh
# Calls the scheduled jobs inside the Docker network.
# Reminders run every 5 minutes so timings set in minutes are met; the loan check runs every hour.
call() {
  wget -q -O /dev/null --post-data="" --header="Authorization: Bearer ${CRON_SECRET}" "http://app:3000/api/cron/$1" \
    && echo "$(date -u +%FT%TZ) $1 ok" \
    || echo "$(date -u +%FT%TZ) $1 FAILED"
}

tick=0
while true; do
  call reminders
  if [ $((tick % 12)) -eq 0 ]; then call servicing; fi
  tick=$((tick + 1))
  sleep 300
done
