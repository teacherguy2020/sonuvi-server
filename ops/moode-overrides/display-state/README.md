# Display power machine connection

Config → Mills Display Wake owns `plugins.millsDisplay.enabled` (default false). The value is read live; changing only this setting does not require a server restart. Enable it only after provisioning the machine connection. This is a separate optional module for physical Mills jukebox owners; it is not a general moOde preference.

The public web handler accepts only GET `/__moode/playback-state` with a dedicated Bearer credential configured by SONUVI_MOODE_STATE_TOKEN_FILE. Browser cookies and telemetry credentials do not grant this access. The handler fetches only local `/now-playing` and projects state plus Mills/AirPlay/UPnP/stream/Qobuz flags. No titles, URLs, credentials, file paths or write operations are exposed. Disabling Mills wake masks both Mills flags; ordinary play and idle states retain their existing meanings. Errors return 503, never a fabricated playing state.

The existing root-only `/etc/sonuvi-moode-vm/led-curl.conf` is the shared adapter used by worker.php, watchdog.sh and rgb_moode_service.py. Replace its expired cookie with the dedicated Authorization header, preserve trusted `cacert`, and set `request-target = "/__moode/playback-state"`. Curl retains the original HTTPS origin and certificate validation but sends this narrowly scoped request path. Do not enable insecure TLS, follow redirects, or put credentials in process arguments. Consumers reread the file on each call, so no daemon or playback restart is required. Preserve a root-only backup before installing atomically.

Successful authenticated state reads update a bounded heartbeat under the runtime data root. Config's Check display connection reports recent requests (15 seconds), or not verified; it does not claim physical screen state. Preserve the existing worker/watchdog idle timeout and LED Mills-end timer reset. Verify physical DPMS wakes during actual Mills playback, and test inactive/disabled semantics without changing the user's playback.

Updated: 2026-11-14

## Live Queue handoff
Mills captures a checkpoint after amplifier switching and pausing MPD. Stop
compares the live queue, song ID and paused position to that checkpoint; if
unchanged and previously playing, it sends `pause 0`, preserving queue IDs and
position. The older pre-switch checkpoint could exceed its one-second tolerance
during Harmony's 900ms retry plus network time and suppress a valid resume.
Changed queues, resumed playback and user seeks are left alone.

The optional wake module is hidden in Optional integrations until configured;
it is not a general moOde requirement. A full installable plugin lifecycle for
Mills, Seeburg and Multiphone remains a separate architecture task.


## Priority requests during Mills (2026-11-15)

Mills owns the physical audio source from start through completed stop. Seeburg
and Multiphone/Mabel requests received in that interval only enqueue: no MPD
start, house queue clear, or Mabel play-now promotion. Requests share a FIFO
priority segment. A delayed Mabel confirmation reuses its reserved item.

Mills transitions and request insertions share the MPD mutation lock. At stop,
new deferred IDs are allowed additions to the paused snapshot; all original
IDs/order, selected ID, state and elapsed checkpoint must still match. Resume an
interrupted priority track first, otherwise start the first waiting request at
zero, then let the remaining priority tracks and house queue advance normally.
User queue/seek/play changes are preserved. Duplicate stop cannot restart or
skip a request. Regression coverage: test/mills-priority-handoff.test.mjs.

### Mandatory playback hold, including Mabel's second call

Mabel's deployed Live client uses `/mpd/start-song` after reserving a selection;
this is distinct from a `playNow` selection request. Both start-song and
start-queue now obey the same lock and Mills hold. A delayed start-song cannot
skip an already-active priority request or restart the same song at zero.
Responses distinguish `playbackHold: "mills"` from an ordinary spoken-intro
delay. The Live client skips its follow-up start when a hold is present.

Defense in depth: MPD service checks the physical-source hold before opening
and immediately before writing a play/resume/advance/seek command, including
commands embedded in a command list. Read/enqueue/pause commands remain usable.
Only after successful return to Aux1 does the locked Mills handoff release the
physical hold and resume the priority/house queue. Tests cover the real second
callback and a hold acquired while waiting for the MPD greeting.
