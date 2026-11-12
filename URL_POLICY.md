# URL Policy (Canonical + Compatibility)

This project keeps stable canonical URLs while preserving compatibility aliases where practical.

## Canonical UI URLs

### Core surfaces

- `/app.html` — main shell/dashboard
- `/index.html` — now-playing display
- `/player.html` — player-focused display view
- `/peppy.html` — peppy-focused display view
- `/mobile.html` — mobile builder view
- `/controller.html` — mobile controller home

### Controller subpages

- `/controller-now-playing.html`
- `/controller-queue.html`
- `/controller-queue-wizard.html`
- `/controller-playlists.html`
- `/controller-artists.html`
- `/controller-albums.html`
- `/controller-genres.html`
- `/controller-podcasts.html`
- `/controller-radio.html`

### Admin / tooling

- `/config.html` — runtime/config admin
- `/diagnostics.html` — diagnostics and queue controls
- `/library-health.html` — library maintenance tools
- `/queue-wizard.html` — queue builder + vibe tools
- `/podcasts.html` — podcast management
- `/radio.html` — radio management
- `/theme.html` — theme controls
- `/alexa.html` — Alexa integration tools

## Legacy UI aliases

- `/index1080.html` → redirects to `/index.html`

## Canonical art URLs

- `/art/current.jpg`
- `/art/current_640.jpg`
- `/art/current_bg_640_blur.jpg`
- `/art/track_640.jpg?file=...`

## Legacy art aliases

- `/art/current_320.jpg` — compatibility alias

## API base defaults

- API default: `http://<host>:3101`
- Web default: `http://<host>:8101`

For immutable authenticated LAN controllers, configure direct HTTPS (for example `https://<LAN-IP>:8443`). HTTP8101 redirects to that configured origin; it is not an unauthenticated controller API. See [LAN controller HTTPS](docs/runbooks/controller-lan-https.md).

Ports are configurable via runtime config (`ports.api`, `ports.ui`).

## Rules for future URL changes

1. Add/announce canonical URL first.
2. Keep old endpoint as alias/redirect for at least one release cycle.
3. Update UI + docs to canonical URL immediately.
4. Avoid removing aliases until known clients are migrated.
