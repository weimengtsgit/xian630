#!/bin/sh
# Detect the container's runtime DNS from /etc/resolv.conf and configure nginx
# to use it instead of a hardcoded address. This keeps Podman aardvark-dns in
# charge of compose service names like "factory".
set -e

# Use ONLY the first nameserver. On a named Podman network the first entry is
# the aardvark-dns gateway (e.g. 10.89.0.1), which resolves compose service
# names AND forwards external queries to the host resolvers. Listing additional
# public fallbacks (e.g. 100.95.0.1) alongside it is unsafe: nginx round-robins
# resolver queries, and a public DNS that NXDOMAINs "factory" yields intermittent
# 502s. aardvark-dns already handles external resolution, so one resolver is
# both necessary and sufficient.
NS="$(grep '^nameserver' /etc/resolv.conf | head -1 | awk '{print $2}')"

# Replace the placeholder resolver line in the nginx config
if [ -n "$NS" ]; then
    sed -i "s|resolver .*|resolver ${NS} valid=30s ipv6=off;|" /etc/nginx/conf.d/default.conf
    echo "entrypoint: nginx resolver set to ${NS}"
fi

# Chain to the original nginx entrypoint
exec /docker-entrypoint.sh nginx -g "daemon off;"
