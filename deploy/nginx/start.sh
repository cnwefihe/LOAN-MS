#!/bin/sh
# Starts Nginx on plain HTTP until the certificate exists, then switches to HTTPS by itself.
# It also reloads Nginx whenever Certbot renews the certificate.
set -eu

CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

render() {
  if [ -f "$CERT" ]; then template=https; else template=http-only; fi
  sed "s/__DOMAIN__/$DOMAIN/g" "/templates/$template.conf" > /etc/nginx/conf.d/default.conf
}

stamp() {
  if [ -f "$CERT" ]; then stat -L -c %Y "$CERT"; else echo none; fi
}

render
last=$(stamp)

(
  while sleep 60; do
    now=$(stamp)
    if [ "$now" != "$last" ]; then
      last=$now
      render
      nginx -t && nginx -s reload && echo "Certificate changed: Nginx reloaded"
    fi
  done
) &

exec nginx -g "daemon off;"
