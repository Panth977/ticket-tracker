# The sandbox gateway on Cloud Run gen2: the gateway, sandboxd and gVisor in one container.
# User code runs inside gVisor, inside the instance's microVM, with no network. The service
# account holds no roles. Rebuild to take new gVisor and Deno releases.
FROM node:22-bookworm-slim
ARG KIT=v0.3.2
ARG GVISOR=release-20261026.0
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl unzip bzip2 >/dev/null
RUN mkdir /gv && cd /gv \
 && curl -fsSLO https://github.com/google/gvisor/releases/download/$GVISOR/gvisor-x86_64.tar.bz2 \
 && curl -fsSLO https://github.com/google/gvisor/releases/download/$GVISOR/SHA256SUMS \
 && grep gvisor-x86_64.tar.bz2 SHA256SUMS | sha256sum -c - \
 && tar -xjf gvisor-x86_64.tar.bz2 && rm gvisor-x86_64.tar.bz2 SHA256SUMS && cp -r /gv/* /usr/local/bin/ && rm -rf /gv
RUN cd /tmp \
 && curl -fsSLO https://github.com/Panth977/sandbox-environment/releases/download/$KIT/sandboxd-linux-amd64 \
 && curl -fsSLO https://github.com/Panth977/sandbox-environment/releases/download/$KIT/SHA256SUMS \
 && grep sandboxd-linux-amd64 SHA256SUMS | sha256sum -c - \
 && install -m 755 sandboxd-linux-amd64 /usr/local/bin/sandboxd && rm sandboxd-linux-amd64 SHA256SUMS
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/d.zip \
 && unzip -q /tmp/d.zip -d /usr/local/bin && rm /tmp/d.zip
# Types for `node:` imports: sandboxes have no network, so they are cached here.
RUN mkdir -p /app /src /build /etc/gateway /opt/deno-cache /var/lib/sandboxd && cd /tmp \
 && echo 'import fs from "node:fs"; console.log(fs, process.pid)' > c.ts \
 && DENO_DIR=/opt/deno-cache deno check --no-lock c.ts && rm c.ts && chmod -R a+rX /opt/deno-cache
COPY gateway.mjs start.sh /gateway/
CMD ["sh", "/gateway/start.sh"]
