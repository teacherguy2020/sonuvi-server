# Configured idle display after queue completion

The Display plugin owns `idleBrandLine` and `idleMessageLine`. The public
`/config/runtime` response exposes these under `config.display`.

Player (`player-render.html`), classic (`index.html`), and Peppy (`peppy.html`)
show these strings with the idle clock when transport reports stop/stopped/idle,
even if the completed track retains its metadata. Empty paused playback also
shows idle. A paused track with metadata retains the existing pause/artwork
behavior. Active Mills is always excluded, including before selection metadata
arrives. The index/player pause screensaver must not override the idle message.

Idle state is reevaluated on every playback poll, not only on track changes.
Text changes refresh while idle and are inserted as plain text. Temporary config
read failures retain the last known strings. Defaults match the Display plugin:
Sonuvi / Ready to play. This does not change moOde DPMS blanking or LED behavior,
and it does not repair a stale active Mills session.

Regression: `test/display-idle-browser.test.mjs` exercises actual page assets
with all network calls intercepted, never live playback. Deployment is separate.
