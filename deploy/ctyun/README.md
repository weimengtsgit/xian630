# CTYun Production Deployment Guide

This guide documents the production deployment pattern for the three services on
China Telecom Cloud:

- `cc-status`
- `factory-server`
- `sf-portal-mvp`

The production host uses CentOS Stream 9 and rootful Podman. Images must be
versioned and named exactly after the service:

- `localhost/cc-status:<version>`
- `localhost/factory-server:<version>`
- `localhost/sf-portal-mvp:<version>`

## Directory Layout

Use one stable root for all deployment state:

```text
/opt/xian630/
  backups/
    <timestamp>-predeploy-<version>/
  releases/
    <version>/
      source/
      build/
      metadata/
  apps/
    cc-status/
      data/
      logs/
    factory-server/
      data/        # optional bind layout; current production reuses sf_sf-data
      runs/
    sf-portal-mvp/
  active/
    VERSION
```

Current production keeps the historical Software Factory Podman volumes:

- `sf_sf-data` mounted at `/data`
- `sf_sf-apps` mounted at `/workspace/generated-apps`
- `sf_sf-claude` mounted at `/root/.claude`

Keep these volumes during upgrades unless an explicit data migration is planned.

## Version Format

Use a timestamp plus the Git short SHA:

```bash
VERSION="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)"
```

Example:

```text
20260709-101530-d4f3b30d
```

## Build Images

Build on the CTYun host so the images match the production architecture
(`x86_64`). The build context is the repository root for `factory-server` and
`sf-portal-mvp`, and `cc-status/` for `cc-status`.

```bash
podman build \
  -t localhost/cc-status:${VERSION} \
  -f deploy/Dockerfile.cc-status \
  --build-arg VERSION=${VERSION} \
  cc-status

podman build \
  -t localhost/factory-server:${VERSION} \
  -f deploy/Dockerfile.factory \
  .

podman build \
  -t localhost/sf-portal-mvp:${VERSION} \
  -f deploy/Dockerfile.portal \
  --build-arg VITE_FACTORY_API_BASE_URL="" \
  .
```

Do not rely on `latest` as the rollback anchor. `latest` can be added as a
convenience tag after the versioned images pass verification.

## Network

All three services should join the `sf_default` Podman network.

Expected service aliases:

- `cc-status` resolves to the `cc-status` container.
- `factory` resolves to the active `factory-server` container, because
  `sf-portal-mvp` Nginx proxies `/api/` to `factory:8787`.

Create the network if it does not exist:

```bash
podman network exists sf_default || podman network create sf_default
```

## Runtime Commands

`cc-status` runs internally on port `8765`:

```bash
podman run -d \
  --name cc-status-${VERSION} \
  --network sf_default \
  --network-alias cc-status \
  --restart unless-stopped \
  -v /opt/xian630/apps/cc-status/data:/data:Z \
  -v /opt/xian630/apps/cc-status/logs:/var/log/cc-status:Z \
  localhost/cc-status:${VERSION}
```

`factory-server` runs internally on port `8787` and talks to the host Podman
socket:

```bash
podman run -d \
  --name factory-server-${VERSION} \
  --network sf_default \
  --network-alias factory \
  --restart unless-stopped \
  --add-host host-gateway:host-gateway \
  -e FACTORY_ADDR=0.0.0.0:8787 \
  -e FACTORY_CC_STATUS_BASE_URL=http://cc-status:8765 \
  -e FACTORY_CONTAINER_RUNTIME=podman \
  -e FACTORY_HEALTH_HOST=host-gateway \
  -e FACTORY_APP_URL_HOST=<public-or-private-host> \
  -e DOCKER_HOST=unix:///var/run/runtime.sock \
  -e CONTAINER_HOST=unix:///var/run/runtime.sock \
  -v /run/podman/podman.sock:/var/run/runtime.sock \
  -v sf_sf-data:/data \
  -v sf_sf-apps:/workspace/generated-apps \
  -v sf_sf-claude:/root/.claude \
  --env-file /opt/xian630/runtime/factory.env \
  localhost/factory-server:${VERSION}
```

`sf-portal-mvp` publishes the external HTTP port. Current production uses
`8000:80`:

```bash
podman run -d \
  --name sf-portal-mvp-${VERSION} \
  --network sf_default \
  --restart unless-stopped \
  -p 8000:80 \
  localhost/sf-portal-mvp:${VERSION}
```

## Blue-Green Procedure

1. Back up current containers, image metadata, systemd units, and data volumes.
2. Build the three versioned images.
3. Start the new `cc-status` container.
4. Start the new `factory-server` container with the `factory` network alias.
5. Start the new `sf-portal-mvp` container on a temporary verification port.
6. Verify:

```bash
curl -fsS http://127.0.0.1:<temp-portal-port>/healthz
curl -fsS http://127.0.0.1:<temp-portal-port>/
podman logs --tail 100 cc-status-${VERSION}
podman logs --tail 100 factory-server-${VERSION}
podman logs --tail 100 sf-portal-mvp-${VERSION}
```

7. Switch the public port by stopping the old portal container and starting the
   verified new portal on `8000:80`.
8. Keep the old containers stopped, not removed, until the release is accepted.

## Rollback

Rollback is container-level. The old images and stopped containers are retained
by the predeploy backup.

```bash
podman stop sf-portal-mvp-${VERSION} factory-server-${VERSION} cc-status-${VERSION}
podman start <old-factory-container>
podman start <old-portal-container>
```

If a data rollback is required, restore from:

```text
/opt/xian630/backups/<timestamp>-predeploy-<version>/volumes/
```

Only restore data after stopping all containers that mount the affected volume.

## Generated App Nginx Proxy

Generated applications that proxy ontology requests should use this standardized
shape:

```nginx
location /api/ontology/ {
    rewrite ^/api/ontology/(.*)$ /$1 break;
    proxy_pass http://ceshi.projects.bingosoft.net:8081;
    proxy_http_version 1.1;
    proxy_set_header Host ceshi.projects.bingosoft.net;
    proxy_set_header Authorization "<runtime-secret>";
    proxy_set_header Spaceid "<runtime-secret>";
    proxy_set_header scopeType "Space";
}
```

Avoid variable upstreams such as `proxy_pass http://$upstream:8081/` for this
external ontology proxy. The production migration backup for the current
standardization is stored under `/opt/xian630/backups/`.
