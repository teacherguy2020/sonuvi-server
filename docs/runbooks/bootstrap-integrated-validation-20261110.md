# Bootstrap replacement integrated validation — 2026-11-10

Source increment: descendant of Server `dea72accab8627fe0ed3afeb1c01bc56475a7d95`,
preserving Findings 1–4. Compatible iOS increment starts at
`54363487ed8671bac9a3ea41f1fbb4a475fa703f`. Exact delivered commit IDs are recorded
in the owning task's completion report; no signed artifact is implied by this file.

Capsule `sonuvi.gate-c-bootstrap-kit-replacement.v1`: **88,892 bytes**, SHA-256
`8d4509a7a79fca65ba255e0a13eb59bcf888a8aee963d507adf8bb7d864dd15c`.
The authoritative protocol is [the replacement runbook](sonuvi-v2-bootstrap-kit-replacement.md).

## Coverage and results

- Historical ARM64/systemd fixture: **16/16** with actual reviewed capsule,
  production admission command builder, signed historical archives and promoted
  scripts. Recover initial A → replace B → guarded staging → committed activation
  passes with the original A evidence byte-for-byte retained. Repeated generations,
  rollback, interrupted bootstrap and Server transactions, ordering, corrupt history,
  framing, identity, signature, filesystem substitution and locking are covered.
- Three five-cycle stress runs: **15/15 interrupted Server recovery cycles**,
  each followed by idempotent guarded recovery; all three complete suites **16/16**.
  The first run is uninstrumented. The next two use optional in-process inspector
  diagnostics, last narrowed to typed-error construction/mapping boundaries.
  Diagnostics open no network port, change no signed kit and bypass no guard.
- Complete applicable unprivileged Linux Node suite: **664 passed, 1 skipped,
  0 failed**, 665 total, twice on the final capsule. UID501/GID20, Debian ARM64,
  locked dependencies and real release artifacts available. The root-only adapter
  file is intentionally separate; it passes **4/4 as root**. Its mocked command
  runner is not evidence of real systemd operation; the historical fixture is.
- The one Docker-gated v1 capsule skip was exercised separately: **4/4** in the
  actual unchanged v1 capsule test group. Real historical archive compatibility
  also passes **1/1** and is included in the mounted full Linux run.
- Python vibe-planner regressions: **5/5** as an unprivileged Linux user.
- Complete Swift suite with native loopback OpenSSH SFTP enabled: **1067 tests,
  4 expected skips, 0 failures**. It exercises active v2 content-addressed upload
  and exact-byte reuse on separate connections, plus unchanged v1 upload.
- Cross-repository parity checks all capsule bytes, its SHA, all three complete
  production guard commands and all 33 capsule failure codes. Syntax and Git
  whitespace checks pass. Swift simulator compilation is unsigned, with
  `CODE_SIGNING_ALLOWED=NO`; no physical install is part of validation.

Real historical kit identities are unchanged:

- `sonuvi-7d5407b2915caafba26c583ac80d51f750fac6ff309b08837d762cd3c4594a66`:
  236032 bytes, SHA256 `91b2d8cc171e5106ca87102a50e3e29392680f52b748c02ac9c5926a71d1b63d`.
- `sonuvi-3cbe87d6744b9f7a1423afa09ca91eb81e9662138d59d1e29054c72045700fdf`:
  238592 bytes, SHA256 `aec02a0ad716f6c979b2b2099099d913bee773e651f7159c402b022dfe113243`.

## Failed invocations are not passing evidence

The earlier review's 8/14 invocation cannot be assigned a proven cause from its
retained generic errors. During this increment, one final-capsule run was **9/16**:
the first failure was guarded interrupted Server recovery, with six later failures
cascading from its retained pending Server transaction. The old assertion did not
capture the typed response. These are not seven independent failures and the run
is not counted as passing. No product fix is claimed to explain that intermittent
failure. Subsequent complete runs and the 15-cycle experiment above did not
reproduce it; that is bounded reproducible evidence, not proof that timing faults
are impossible. A recurrence remains a release stop requiring the now-captured
typed response, adapter error boundary, backup/journal and real service logs.

Failure diagnostics now read journald's boot-time directory explicitly: the fixture
changes machine-id after boot, making a default journal lookup misleadingly empty.
Historical signed kits remain unmodified. Test logs, including failed invocations,
are retained under the owning workspace's `sonuvi-team/bootstrap-completion-20261110`.

Initial dependency/tool-incomplete Linux runs are not passes (missing git/python/
patch); neither are root-only chown tests attempted as UID501. After installing
the fixture prerequisites and separating permission models, the complete runs above
pass. A second Swift invocation against a populated SFTP fixture failed at v1's
intentional no-overwrite check. Starting a fresh owned container restored the full
passing result; no v1 safety check was relaxed. V2 reuse is explicitly tested twice
within the native test. Always start that combined v1/v2 test with a fresh fixture.

## Reproduction

On the ARM64 Docker host with the two immutable historical kits and installed
release archives at the verified paths in the harness:

```sh
scripts/test-linux-bootstrap-replacement-fixture.sh
SONUVI_BOOTSTRAP_RECOVERY_REPETITIONS=5 scripts/test-linux-bootstrap-replacement-fixture.sh
SONUVI_BOOTSTRAP_RECOVERY_REPETITIONS=5 SONUVI_BOOTSTRAP_TRACE_RECOVERY=1 scripts/test-linux-bootstrap-replacement-fixture.sh
node scripts/verify-ios-bootstrap-contract.mjs <compatible-iOS-worktree>
```

For the complete Node suite, install locked dependencies in a disposable Linux
environment; provide Node, git, python3, patch and real archives. Run every
`test/*.test.mjs` except `sonuvi-linux-systemd-upgrade.test.mjs` as an ordinary user;
run that four-case adapter file separately as root. Run Python with
`PYTHONPATH=. python3 -B -m unittest discover -s test -p test_vibe_planner.py`.
The real v1 capsule group is `test/sonuvi-gate-c-bootstrap-kit.test.mjs` and
requires its documented Docker gate. Do not reinterpret a skipped group as passed.

Use the iOS canonical build helper only, from its dedicated checkout:
`/usr/bin/python3 scripts/sonuvi-build.py swift-test`. Enable its existing SFTP
fixture variables with a fresh, task-owned stock OpenSSH container and test-only
credential; default port2224 may belong to another task, so this increment used
loopback2226. Use an unsigned simulator configuration with the same build helper.

## Explicit remaining deployment boundaries

Systemd PID1, start/stop/restart, release-verifying ExecStartPre, MainPID/process
environment identity and atomic directory exchange are real. HTTP API/web endpoints
are **simulated probes**; configuration, administrator/controller records and SSH
authorization are synthetic preservation fixtures. Native SFTP is real, but the
entire app→sudo→real Server application lifecycle and controller reconnect are not
claimed as a physical-device/paired-host end-to-end test. Kill injection is not a
physical power-loss durability test.

Four Swift opt-in gates remain unavailable in this run: live inventory endpoint,
GateB2 host-key probe, GateB2 authenticated loopback health, and native v1 archive/
status fixture. The real v1 capsule and first-install unit tests are covered
separately; these four gates are not silently marked passed.

Signing/publication remains a later authorized step: build the new immutable
ARM64 release and kit from the delivered clean Server commit, verify inventories,
sign the canonical envelope with the unchanged Ed25519 trust anchor, bind release/
manifest/archive/kit identities and expiry, update the iOS approved release
inventory to those exact bytes, and rerun artifact-specific guarded lifecycle and
parity checks. The current published inventory is a historical compatibility
fixture, not a newly signed build of this increment. No trust redesign is needed.
Exclusive initial maintenance, backup/restore proof and real unsimulated health
checks are required before any separately authorized disposable-VM migration;
see the authoritative runbook. No VM, Pi, physical iPad, signing/publication,
push or merge was performed for this checkpoint.
