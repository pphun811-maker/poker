# Poker multiplayer relay.
#
# The relay is a single Deno file with no external dependencies. Any Docker-capable
# host (Render, Zeabur, Koyeb, Fly.io, a VPS) can run it.
#
# Render/Koyeb/Zeabur: use this Dockerfile and set:
#   SYNC_STORAGE=memory
#   ALLOWED_ORIGINS=https://pphun811-maker.github.io
#
# In-memory storage is intentional for free single-instance hosts: a poker table only
# needs state for the duration of a session. State resets when the instance restarts.

FROM denoland/deno:alpine

WORKDIR /app
COPY deno.json /app/deno.json
COPY server/sync.js /app/server/sync.js

ENV PORT=8000
EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--allow-read=/app", "--allow-write=/app", "/app/server/sync.js"]
