# Supervised moOde Audio Info rollout

**Status: NO-GO for production until the prerequisites below are satisfied and
Brian approves both stages.** This is a runbook, not authorization or an
automated deployment tool.

## Verified starting point (2026-10-30)

- Active dispatcher: `/usr/local/libexec/sonuvi-moode-readonly-v1.py`,
  root-owned `0755`, SHA-256
  `7c5a15f6045518eece2b14d83e552c476eaa9db981b7fca62b3adaf2b64badff`.
- The Server key is still constrained by one `restrict`ed forced command to
  that file. No `authorized_keys`, sudo policy, or SSH policy change is
  proposed.
- From the active API service account, the existing `diagnostics` and
  `radio-catalog` operations both returned the expected
  `sonuvi.moode-readonly.v1` contract.
- Candidate dispatcher SHA-256:
  `54b9f7f3be1cc33abf3b16116440a3ff35454045ab249103c24010416a9cd5c5`.
  Recompute after every source change; do not deploy a different digest.
- `sonuvi-api.service` currently runs as `brianwis`, has no drop-ins, and none
  of its protected environment files define `SONUVI_MOODE_READONLY_PROTOCOL`.
- The persisted immutable runtime configuration remains the authority for the
  moOde SSH endpoint. The Stage 2 marker enables only the fixed read-only
  protocol; it must not duplicate or override the configured host/user.

## Security review

`audio-info-snapshot` accepts exactly one literal `SSH_ORIGINAL_COMMAND`. It
does not accept user paths, SQL, URLs, shell fragments, or subprocess
arguments. Unknown commands exit `126` with `SONUVI_OPERATION_DENIED` before
collection begins. Existing `radio-catalog` and `diagnostics` literals remain.

The operation reads only moOde's local SQLite database in query-only mode,
local `audioinfo.php`, loopback MPD state/current-song, and ALSA procfs. The
pre-existing diagnostics command retains its fixed `systemctl is-active`
invocation. There is no shell execution. The PHP session is used only in a
local request header, is redacted from returned HTML, and is never returned,
logged, or passed to a child process.

The Server client permits only a pinned SSH argv with strict host checking, the
protected identity, no forwarding, and the exact literal operation. It fails
closed for denied, malformed, oversized, unavailable, and partial replies.
Its endpoint resolution follows the normal Sonuvi precedence: an explicit
environment override when present, otherwise the persisted immutable moOde
configuration. The immutable process boundary derives the same exact argv, so
it cannot approve a different target than the collector.

## Preconditions

1. Finalize this work into a reviewed, clean Git commit. Production artifact
   building correctly rejects the current dirty worktree.
2. Build and independently verify a clean immutable Server artifact from that
   commit. Do not use a dirty snapshot.
3. Re-read the production dispatcher hash. Stop if it differs from the baseline
   above and review the drift rather than overwriting it.
4. Capture the current Server release identity and identify a known-good
   rollback release through the approved site-specific activation procedure.
5. Obtain separate explicit approval for Stage 1 and Stage 2. Do not alter
   playback, renderer configuration, credentials, or `authorized_keys`.

The full suite's three H4C.4A failures are unchanged on clean `main`: its path
guard intentionally rejects this home-directory worktree. They are unrelated
to this rollout and must not be repaired as part of it.

## Stage 1 — moOde dispatcher only

This stage changes only the root-owned dispatcher and requires no restart or
playback action.

1. Copy the reviewed candidate to the exact temporary file:

   ```sh
   scp -o BatchMode=yes -o StrictHostKeyChecking=yes \
     ops/moode-overrides/sonuvi-readonly/dispatcher.py \
     moode@10.0.0.254:/tmp/sonuvi-moode-readonly-v1.py.new
   ```

2. On moOde, verify its digest and syntax. Confirm that an injected command
   produces `SONUVI_OPERATION_DENIED` with exit `126`; any other result stops
   the rollout:

   ```sh
   test "$(sha256sum /tmp/sonuvi-moode-readonly-v1.py.new | awk '{print $1}')" = \
     54b9f7f3be1cc33abf3b16116440a3ff35454045ab249103c24010416a9cd5c5
   sudo -n /usr/bin/python3 -c "compile(open('/tmp/sonuvi-moode-readonly-v1.py.new', encoding='utf-8').read(), 'dispatcher.py', 'exec')"
   if env -i PATH=/usr/bin:/bin SSH_ORIGINAL_COMMAND='sonuvi-readonly-v1 audio-info-snapshot; id' \
     /usr/bin/python3 -I /tmp/sonuvi-moode-readonly-v1.py.new; then exit 1; else test "$?" -eq 126; fi
   ```

3. Back up the current dispatcher without overwriting an existing backup, then
   compare it to the recorded baseline:

   ```sh
   sudo -n install -d -o root -g root -m 0700 /var/backups/sonuvi-moode-readonly
   sudo -n test ! -e /var/backups/sonuvi-moode-readonly/dispatcher.pre-audio-info-snapshot.py
   sudo -n install -o root -g root -m 0700 \
     /usr/local/libexec/sonuvi-moode-readonly-v1.py \
     /var/backups/sonuvi-moode-readonly/dispatcher.pre-audio-info-snapshot.py
   test "$(sudo -n sha256sum /var/backups/sonuvi-moode-readonly/dispatcher.pre-audio-info-snapshot.py | awk '{print $1}')" = \
     7c5a15f6045518eece2b14d83e552c476eaa9db981b7fca62b3adaf2b64badff
   ```

4. Replace only that file with root ownership and mode `0755`. Do **not** edit
   the forced-command key entry:

   ```sh
   sudo -n install -o root -g root -m 0755 \
     /tmp/sonuvi-moode-readonly-v1.py.new \
     /usr/local/libexec/.sonuvi-moode-readonly-v1.py.new
   sudo -n mv -f -- /usr/local/libexec/.sonuvi-moode-readonly-v1.py.new \
     /usr/local/libexec/sonuvi-moode-readonly-v1.py
   ```

5. Reconfirm mode, owner, hash, and forced-command restriction. From the active
   Server API account using its existing pinned key, invoke all three literal
   operations. Parse JSON locally and print only `ok`, `contract`,
   `operation`, collection-stage states, and absence of `PHPSESSID`/`sessionid`.
   Existing operations must succeed. The new snapshot may truthfully mark a
   stage unavailable, but must never return a session value.

### Stage 1 rollback

No restart is necessary. Restore only the retained dispatcher and rerun the
existing-operation probe:

```sh
sudo -n install -o root -g root -m 0755 \
  /var/backups/sonuvi-moode-readonly/dispatcher.pre-audio-info-snapshot.py \
  /usr/local/libexec/.sonuvi-moode-readonly-v1.py.restore
sudo -n mv -f -- /usr/local/libexec/.sonuvi-moode-readonly-v1.py.restore \
  /usr/local/libexec/sonuvi-moode-readonly-v1.py
```

## Stage 2 — immutable Server release and protocol marker

Stage 2 follows a successful Stage 1. Build a release from the approved clean
commit using the existing artifact flow:

```sh
npm ci
npm test
node scripts/prepare-target-dependencies.mjs \
  --source-worktree <clean-worktree> \
  --output-root <absolute-target-dependencies-root> \
  --target-image node@sha256:9e70124bd00f47dd023e349cd587132ae61892acc0e47ed641416c3e18f401c3
node scripts/build-release.mjs \
  --source-worktree <clean-worktree> \
  --dependency-root <absolute-target-dependencies-root> \
  --output-root <absolute-release-artifact-root> \
  --production
node scripts/verify-release.mjs --artifact-root <absolute-release-artifact-root>
```

Use the approved immutable artifact staging/promotion procedure in
`docs/runbooks/sonuvi-server-operations.md`. Do not use the retired file-push
helper or copy code into `/opt/sonuvi/current`. The repository deliberately has
no general live activation/rollback CLI, so **do not manually repoint
`/opt/sonuvi/current`**. The reviewed site-specific activation transaction and
known-good rollback release are mandatory Stage 2 inputs.

Immediately before that approved activation/restart, install this non-secret,
narrow API-unit marker. It does not modify any protected environment file or
credential:

```sh
sudo -n install -d -o root -g root -m 0755 /etc/systemd/system/sonuvi-api.service.d
sudo -n install -o root -g root -m 0644 \
  ops/systemd/sonuvi-api.service.d/20-moode-readonly-audio-info.conf \
  /etc/systemd/system/sonuvi-api.service.d/20-moode-readonly-audio-info.conf
sudo -n systemctl daemon-reload
```

After the approved immutable-release activation transaction starts the new
release, restart the coupled services and verify both are active:

```sh
sudo -n systemctl restart sonuvi-api.service sonuvi-web.service
systemctl is-active sonuvi-api.service
systemctl is-active sonuvi-web.service
```

### Stage 2 live acceptance

Use the existing authenticated Audio Info surface or existing authenticated
operator client; never print or paste its credential. Without changing track or
route, inspect `GET /config/moode/audio-info?diagnostics=1` and retain only the
sanitized report. For the known Cavalli 24/96 playback state, confirm current
readings for all of the following:

1. Cavalli USB DAC identity and USB interface.
2. MPD decoded PCM: 24-bit, 96 kHz, stereo.
3. ALSA `hw_params`: `S32_LE`, 96 kHz, stereo. Treat 32-bit as container width,
   not 32 valid source bits.
4. Current DSP/volume values, including polarity inversion **Off**.
5. Current timestamps and field-level collection provenance.
6. Signal Integrity still **UNVERIFIED** at the remote renderer-output boundary
   unless genuinely new direct evidence exists; rate matching is not Bit Perfect.

If a different track or device is active, record its actual readings and defer
the format-specific Cavalli check. Do not load or reroute music to make a test
pass.

### Stage 2 rollback

1. Use the reviewed site-specific immutable-release rollback transaction to
   restore the release captured at the Stage 2 preflight. Do not hand-edit the
   `current` symlink.
2. Remove only the marker, reload systemd, and restart the pair during that
   rollback transaction:

   ```sh
   sudo -n rm -f -- /etc/systemd/system/sonuvi-api.service.d/20-moode-readonly-audio-info.conf
   sudo -n systemctl daemon-reload
   sudo -n systemctl restart sonuvi-api.service sonuvi-web.service
   ```

3. Verify the previous release identity and API/web health. Stage 1 can remain
   safely in place because the old Server release cannot call the new literal
   operation; restore Stage 1 independently if the dispatcher is suspected.

Neither rollback touches protected settings, credentials, queues, playback, or
moOde configuration.
