# Server Application CI

## Purpose and trigger policy

`.github/workflows/application-tests.yml` is the repository's application-test
gate. It runs for every pull request and for pushes to `main`. Pushes to
`ci/application-tests-*` are included only to prove this initial workflow
before it reaches `main`.

The workflow uses the supported `ubuntu-24.04` GitHub-hosted runner, grants
only `contents: read`, disables persisted checkout credentials, and cancels an
older run for the same pull request or branch. Each job has a 20-minute time
limit.

## What the workflow runs

1. `npm ci` installs exactly the dependencies in `package-lock.json`.
2. `npm test` runs the repository's Node application test suite
   (`node --test test/*.test.mjs`).
3. `npm run test:vibe-planner` runs the Vibe planner unit suite. Its command is
   declared in `package.json`; `vibe_planner.py` and
   `test/test_vibe_planner.py` use Python's standard library only, so the
   standard Python 3 interpreter on the hosted Ubuntu runner is sufficient.

There is no `continue-on-error`: any failing application test fails the job.

## Deliberately not covered

This workflow is an application-suite gate, not production or device
validation. It does not exercise privileged `systemd` installation, service
management, or upgrade scenarios; browser tests that require a browser/runtime
environment; or hardware and device integration (including MPD/moOde, UPnP,
and real playback devices). Run those checks separately in their appropriate
controlled environments before a release when they are affected.

The separate GitHub Pages publishing workflow publishes documentation. It is
not application-test coverage and must not be used as evidence that this test
suite passed.
