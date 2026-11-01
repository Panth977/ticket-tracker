#!/bin/sh
# One container, two processes: if either ends, the instance ends and Cloud Run replaces it.
sandboxd --driver direct --socket /tmp/sandboxd.sock --data-dir /var/lib/sandboxd &
until [ -S /tmp/sandboxd.sock ]; do sleep 0.05; done
HOST=0.0.0.0 SANDBOXD=unix:///tmp/sandboxd.sock exec node /gateway/gateway.mjs
