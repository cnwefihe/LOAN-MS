#!/bin/sh
# Gets the certificate on first run. After that certbot only renews it within 30 days of expiry.
# A failed attempt waits an hour, to stay within Let's Encrypt's limits.
sleep 15

while true; do
  if certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --no-eff-email --non-interactive --keep-until-expiring; then
    sleep 43200
  else
    echo "Certificate request failed. Check that $DOMAIN points here and port 80 is reachable from the internet."
    sleep 3600
  fi
done
