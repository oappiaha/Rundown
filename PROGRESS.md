# Deployment progress

## September 26, 2026 — first Mac mini release

- User authorized deploying on the Mac mini, with OBS on MacBook.
- Deployed application commit `00c5cbb32ad73e18cab1bea47066c2d56b1964eb` as an immutable release with the production web build. Discover, streaming days, personal notes, topic/link capture and local uploads are included.
- LaunchAgent KeepAlive on private Tailscale IP port 8088. Existing app on 8000 untouched; no public exposure. No Tailscale settings changed (Serve unavailable).
- Pre-deploy SQLite/asset backup and daily seven-snapshot local backup job installed; integrity verified. Additive schema initialization completed; no destructive migration.
- Release baseline: 271 API / 237 web tests; lint/types/build pass. Production HTTP smoke and real browser after managed restart pass; evidence docs/evaluations/2026-09-26-mac-mini-deployment/result.json. No saved fake production data and live state preserved.
- Remaining: MacBook/OBS connectivity and actual source refresh, off-machine backup/restore rehearsal, and unattended boot/power-failure recovery. Requires user login; automatic restart on power failure remains off. AI disabled, RSS scheduler enabled with no scheduled feeds at deployment.

## September 26, 2026 — warm palette

Deployed `43e20fd16ae23cfb540b5c86cedc4992d5c21385`: original cream/paper background, sand surfaces, warm dark text and concept artwork colors. Layout and APIs unchanged. Lint/types/build pass. Browser preview and deployed desktop/mobile drawer/capture/overlay checks pass; computed page background #f5f1e8 verified and live state preserved. Backup taken; previous release retained.
