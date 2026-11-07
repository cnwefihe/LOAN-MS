#!/bin/sh
# Runs on the server at the end of each deployment. GitHub Actions has already updated
# .env, docker-compose.yml and this folder. Data volumes are never touched.
set -eu

cd "$(dirname "$0")/.."

docker compose pull --quiet app scheduler migrate nginx certbot db
docker compose up -d --remove-orphans

echo "Waiting for the app to become healthy..."
tries=0
while [ "$tries" -lt 40 ]; do
  status=$(docker inspect -f '{{.State.Health.Status}}' pau-lms-app-1 2>/dev/null || echo starting)
  if [ "$status" = "healthy" ]; then
    echo "Deployed: $(grep '^APP_IMAGE=' .env)"
    docker image prune -f > /dev/null
    exit 0
  fi
  tries=$((tries + 1))
  sleep 5
done

echo "The app did not become healthy." >&2
docker compose ps >&2
docker compose logs --tail=40 migrate app >&2
exit 1
