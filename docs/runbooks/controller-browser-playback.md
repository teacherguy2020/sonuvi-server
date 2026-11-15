# Paired browser playback

The paired HTTPS controller dispatches bounded transport commands through the web gateway to the loopback API. Play/pause, next/previous, stop, seek, repeat, and shuffle preserve the existing moOde adapter and Qobuz ownership checks. The browser never needs the Track Key or a direct insecure moOde request. Cookie, exact Origin/Host, CSRF, JSON schema and API-side dispatch checks remain mandatory. Administrative and queue replacement operations are not opened by this change.

The tablet confirms successful transport responses and shows a retry/pairing error on failures. The existing volume widget is specifically for Echo Link in Alexa mode, not a general moOde volume slider. This patch neither enables Echo Link nor changes amplifier or MPD volume.

Verification: `node --test test/controller-playback.test.mjs test/controller-gateway.test.mjs`. Hardware acceptance must separately verify the deployed VM and physical moOde state.
