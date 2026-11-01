#!/usr/bin/env bash
# Sets up a worker machine for backend artifacts: Docker, gVisor, sandboxd, the gateway
# and Caddy for HTTPS. Run once as root on a fresh Ubuntu VM that holds nothing else.
#
#   DOMAIN=run.example.com TM_URL=https://taskmanager-panth977.web.app TM_GATEWAY_SECRET=… ./setup.sh
set -euo pipefail
: "${DOMAIN:?}" "${TM_URL:?}" "${TM_GATEWAY_SECRET:?}"
KIT=v0.3.1
ARCH=$(dpkg --print-architecture)

apt-get update -qq
apt-get install -y -qq docker.io caddy curl unattended-upgrades nodejs npm git

# gVisor, from Google's apt repository, kept current by unattended-upgrades.
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
apt-get update -qq && apt-get install -y -qq runsc
echo 'Unattended-Upgrade::Origins-Pattern { "origin=*"; };' > /etc/apt/apt.conf.d/52sandbox-worker
mkdir -p /etc/docker
echo '{"runtimes":{"runsc":{"path":"/usr/bin/runsc"}}}' > /etc/docker/daemon.json
systemctl restart docker

# Sandboxes must not reach this machine, its cloud metadata or private networks.
# The egress proxy already refuses them; a sandbox has no route of its own.
iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP

curl -fsSL -o /usr/local/bin/sandboxd "https://github.com/Panth977/sandbox-environment/releases/download/$KIT/sandboxd-linux-$ARCH"
chmod 755 /usr/local/bin/sandboxd
mkdir -p /var/lib/sandboxd /opt/gateway /etc/gateway
umask 077
cat > /etc/gateway/env <<ENV
SANDBOXD=unix:///run/sandboxd.sock
TM_URL=$TM_URL
TM_GATEWAY_SECRET=$TM_GATEWAY_SECRET
PORT=8080
ENV
umask 022

cat > /etc/systemd/system/sandboxd.service <<UNIT
[Unit]
After=docker.service
Requires=docker.service
[Service]
ExecStart=/usr/local/bin/sandboxd --socket /run/sandboxd.sock --data-dir /var/lib/sandboxd
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/gateway.service <<UNIT
[Unit]
After=sandboxd.service
Requires=sandboxd.service
[Service]
WorkingDirectory=/opt/gateway/gateway
EnvironmentFile=/etc/gateway/env
ExecStart=/usr/bin/node --experimental-strip-types --no-warnings src/main.ts
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy /sandbox/* 127.0.0.1:8080
  reverse_proxy /internal/* 127.0.0.1:8080
  reverse_proxy /healthz 127.0.0.1:8080
}
CADDY
systemctl daemon-reload
systemctl enable --now sandboxd
systemctl restart caddy
echo "Now copy the gateway to /opt/gateway, then: systemctl enable --now gateway"
