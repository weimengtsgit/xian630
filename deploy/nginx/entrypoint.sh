#!/bin/sh
# Detect the container's actual DNS server(s) from /etc/resolv.conf and
# configure nginx to use them instead of hardcoded addresses.  This lets
# Podman aardvark-dns resolve container hostnames like "factory" while
# still falling back to public resolvers for external upstreams.
set -e

RESOLVERS=""
for ns in $(grep '^nameserver' /etc/resolv.conf | awk '{print $2}'); do
    RESOLVERS="${RESOLVERS}${ns} "
done

# Always append public fallbacks for external hostnames (api.open-meteo.com, etc.)
RESOLVERS="${RESOLVERS}8.8.8.8 114.114.114.114"

# Replace the placeholder resolver line in the nginx config
if [ -n "$RESOLVERS" ]; then
    sed -i "s/resolver .*/resolver ${RESOLVERS}valid=30s ipv6=off;/" /etc/nginx/conf.d/default.conf
    echo "entrypoint: nginx resolver set to ${RESOLVERS}"
fi

# Chain to the original nginx entrypoint
exec /docker-entrypoint.sh nginx -g "daemon off;"
