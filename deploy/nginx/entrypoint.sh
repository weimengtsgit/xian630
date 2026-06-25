#!/bin/sh
# Detect the container's actual DNS server(s) from /etc/resolv.conf and
# configure nginx to use them instead of hardcoded addresses.  This keeps
# Podman aardvark-dns in charge of compose service names like "factory".
set -e

RESOLVERS=""
for ns in $(grep '^nameserver' /etc/resolv.conf | awk '{print $2}'); do
    RESOLVERS="${RESOLVERS}${ns} "
done

# Keep nginx on the container runtime DNS only; public DNS cannot resolve
# compose service names like "factory" and can cause intermittent 502s.
RESOLVERS="${RESOLVERS% }"

# Replace the placeholder resolver line in the nginx config
if [ -n "$RESOLVERS" ]; then
    sed -i "s|resolver .*|resolver ${RESOLVERS} valid=30s ipv6=off;|" /etc/nginx/conf.d/default.conf
    echo "entrypoint: nginx resolver set to ${RESOLVERS}"
fi

# Chain to the original nginx entrypoint
exec /docker-entrypoint.sh nginx -g "daemon off;"
