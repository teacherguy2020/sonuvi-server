# Server Application CI

## Purpose and trigger policy

`.github/workflows/application-tests.yml` is the repository's application-test
gate. It runs for every pull request and for pushes to `main`. Pushes to
`ci/application-tests-*` are included only to prove this initial workflow
before it reaches `main`.

The workflow uses the supported `ubuntu-24.04` GitHub-hosted runner and an
ordinary ephemeral `node:22-bookworm` job container. Setup and dependency
installation use the container's default root identity, but tests run as the
image-provided `node` user with primary group `root` (UID 1000, GID 0). It
grants only `contents: read`, disables persisted checkout credentials, and
cancels an older run for the same pull request or branch. Each job has a
20-minute time limit.

## What the workflow runs

1. The job verifies the default root setup identity, `runuser`, and `python3`.
   It then uses `runuser -u node -g root` to assert that the test identity has
   a non-root UID and GID 0.
2. `npm ci` installs exactly the dependencies in `package-lock.json`.
3. `runuser -u node -g root -- npm test` runs the repository's Node application
   test suite (`node --test test/*.test.mjs`). Running as a non-root UID keeps
   DAC permission-negative assertions meaningful. GID 0 still permits the test
   fixtures to change a file owned by group 0 where that behavior is intended.
4. `runuser -u node -g root -- npm run test:vibe-planner` runs the Vibe planner
   unit suite under the same identity. Its command is declared in
   `package.json`; `vibe_planner.py` and `test/test_vibe_planner.py` use
   Python's standard library only, so the standard Python 3 interpreter on the
   hosted Ubuntu runner is sufficient.

There is no `continue-on-error`: any failing application test fails the job.

## Deliberately not covered

This workflow is an application-suite gate, not production or device
validation. The Linux systemd upgrade unit fixtures use temporary directories
and a stubbed `systemctl`; no real host service is contacted or controlled, and
their fixtures do not provide privileged live-systemd acceptance coverage. The
job does not use `--privileged`, host service access, `sudo`, or security-policy
changes. It also does not exercise browser tests that require a browser/runtime
environment or hardware and device integration (including MPD/moOde, UPnP, and
real playback devices). Run those checks separately in their appropriate
controlled environments before a release when they are affected.

The separate GitHub Pages publishing workflow publishes documentation. It is
not application-test coverage and must not be used as evidence that this test
suite passed.
