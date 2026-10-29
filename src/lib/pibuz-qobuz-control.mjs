import { createHash } from 'node:crypto';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_VERIFY_MS = 4000;
const DEFAULT_POLL_MS = 150;
const MAX_RESPONSE_BYTES = 128 * 1024;

const CONTROL_ROUTES = Object.freeze({
  play: '/playback/play',
  pause: '/playback/pause',
  next: '/playback/next',
  previous: '/playback/previous',
  seek: '/playback/seek',
  'queue-jump': '/queue/jump',
});

function text(value, max = 512) {
  return String(value ?? '').trim().slice(0, max);
}

function qobuzId(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return /^\d{1,32}$/.test(raw) ? raw : null;
}

function strictNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fingerprintTrack(track) {
  if (!track || typeof track !== 'object') return null;
  return {
    id: track.qobuzTrackId || null,
    title: text(track.title),
    artist: text(track.artist),
    album: text(track.album),
    version: text(track.version),
    durationSec: Number.isFinite(Number(track.durationSec)) ? Number(track.durationSec) : null,
  };
}

function fingerprintQueue(queue) {
  const canonical = JSON.stringify({
    currentIndex: queue?.currentIndex ?? null,
    totalTracks: queue?.totalTracks ?? null,
    repeat: queue?.repeat || 'off',
    shuffle: queue?.shuffle === true,
    stopAfterTrackId: queue?.stopAfterTrackId ?? null,
    currentTrack: fingerprintTrack(queue?.currentTrack),
    history: Array.isArray(queue?.history) ? queue.history.map(fingerprintTrack) : [],
    upcoming: Array.isArray(queue?.upcoming) ? queue.upcoming.map(fingerprintTrack) : [],
  });
  // A queue fingerprint is only an opaque compare-and-swap token. It is not a
  // catalog identity and contains no provider credential or private URL.
  return `qobuz-queue-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

function augmentQueue(queue) {
  if (!queue || typeof queue !== 'object') return queue;
  if (queue.available === false) return { ...queue, queueFingerprint: null };
  return {
    ...queue,
    queueFingerprint: text(queue.queueFingerprint, 80) || fingerprintQueue(queue),
  };
}

function freshActive(snapshot) {
  return snapshot?.available === true
    && snapshot?.active === true
    && snapshot?.ownershipState === 'confirmed-active'
    && snapshot?.receiverActive === true
    && snapshot?.stale !== true;
}

function capabilitiesFor(snapshot) {
  const active = freshActive(snapshot);
  return {
    readOnly: false,
    play: active,
    pause: active,
    stop: false,
    seek: active,
    next: active,
    previous: active,
    queueEdit: false,
    repeat: false,
    shuffle: false,
    volume: false,
    control: active,
    verification: 'read-after-write',
  };
}

function augmentSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  return {
    ...snapshot,
    capabilities: capabilitiesFor(snapshot),
    ...(snapshot.queue ? { queue: augmentQueue(snapshot.queue) } : {}),
  };
}

function failure({ action, status = 409, errorCode, message, snapshot, accepted = false, verification = 'not-started' }) {
  return {
    ok: false,
    action,
    status,
    errorCode,
    message,
    accepted,
    confirmed: false,
    verification,
    ...(snapshot ? { snapshot } : {}),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPibuzQobuzControlAdapter({
  adapter,
  fetchImpl = globalThis.fetch,
  capabilities = runtimeCapabilities(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  verifyMs = DEFAULT_VERIFY_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  if (!adapter || typeof adapter.getSnapshot !== 'function' || !adapter.endpoint) {
    throw new Error('PiBuZ snapshot adapter is required for Qobuz controls');
  }
  if (typeof fetchImpl !== 'function') throw new Error('PiBuZ control fetch implementation is unavailable');

  const requestTimeoutMs = Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const verificationLimitMs = Math.max(0, Number(verifyMs) || DEFAULT_VERIFY_MS);
  const verificationPollMs = Math.max(25, Number(pollMs) || DEFAULT_POLL_MS);
  let controlTail = Promise.resolve();

  async function getSnapshot(options = {}) {
    return augmentSnapshot(await adapter.getSnapshot(options));
  }

  async function getNowPlaying() {
    const getter = typeof adapter.getNowPlaying === 'function'
      ? adapter.getNowPlaying.bind(adapter)
      : () => adapter.getSnapshot({ includeQueue: false });
    return augmentSnapshot(await getter());
  }

  async function getQueue() {
    const getter = typeof adapter.getQueue === 'function'
      ? adapter.getQueue.bind(adapter)
      : () => adapter.getSnapshot({ includeQueue: true });
    return augmentSnapshot(await getter());
  }

  async function postControl(route, body) {
    capabilities.assertExternalMutation('pibuz.qobuz-control');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    let parsed = null;
    try {
      response = await fetchImpl(`${adapter.endpoint}${route}`, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = typeof response?.text === 'function' ? await response.text() : '';
      if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
        const error = new Error('PiBuZ control response exceeded the size limit');
        error.controlAmbiguous = true;
        throw error;
      }
      if (raw) {
        try { parsed = JSON.parse(raw); } catch {
          const error = new Error('PiBuZ control response was not valid JSON');
          error.controlAmbiguous = true;
          throw error;
        }
      }
    } catch (error) {
      if (error?.controlAmbiguous) throw error;
      const ambiguous = new Error('PiBuZ control result is unknown');
      ambiguous.controlAmbiguous = true;
      ambiguous.cause = error;
      throw ambiguous;
    } finally {
      clearTimeout(timer);
    }

    const status = Number(response?.status || 0);
    const ok = response?.ok !== false && (!status || (status >= 200 && status < 300));
    if (!ok) {
      const error = new Error('PiBuZ rejected the control request');
      error.controlRejected = true;
      error.upstreamStatus = status || 502;
      error.upstreamCode = text(parsed?.code || parsed?.error?.code, 64)
        .replace(/[^a-z0-9_-]/gi, '') || null;
      throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('PiBuZ control response was invalid');
      error.controlAmbiguous = true;
      throw error;
    }
    return parsed;
  }

  function validateExpectedCurrent(snapshot, options, action) {
    if (options.expectedQobuzTrackId !== undefined) {
      const expected = qobuzId(options.expectedQobuzTrackId);
      if (!expected) {
        return failure({
          action,
          status: 400,
          errorCode: 'QOBUZ_INVALID_CURRENT_TRACK',
          message: 'qobuzTrackId must be a numeric Qobuz track ID',
        });
      }
      if (snapshot.qobuzTrackId !== expected) {
        return failure({
          action,
          errorCode: 'QOBUZ_TRACK_CHANGED',
          message: 'the active Qobuz track changed; refresh before retrying',
          snapshot,
        });
      }
    }

    if (options.expectedCurrentIndex !== undefined) {
      const expected = strictNonNegativeInteger(options.expectedCurrentIndex);
      const actual = strictNonNegativeInteger(snapshot.queue?.currentIndex);
      if (expected === null || actual === null) {
        return failure({
          action,
          status: 400,
          errorCode: 'QOBUZ_INVALID_CURRENT_INDEX',
          message: 'currentIndex must be a non-negative integer',
        });
      }
      if (actual !== expected) {
        return failure({
          action,
          errorCode: 'QOBUZ_QUEUE_CHANGED',
          message: 'the active Qobuz queue position changed; refresh before retrying',
          snapshot,
        });
      }
    }
    return null;
  }

  function validateSeek(snapshot, options, action) {
    const positionSec = strictNonNegativeInteger(options.positionSec);
    if (positionSec === null) {
      return failure({
        action,
        status: 400,
        errorCode: 'QOBUZ_INVALID_SEEK_POSITION',
        message: 'positionSec must be a non-negative integer number of seconds',
      });
    }
    const expectedTrackId = qobuzId(options.expectedQobuzTrackId);
    if (!expectedTrackId) {
      return failure({
        action,
        status: 400,
        errorCode: 'QOBUZ_CURRENT_TRACK_REQUIRED',
        message: 'qobuzTrackId is required so seek cannot target a stale track',
      });
    }
    if (snapshot.qobuzTrackId !== expectedTrackId) {
      return failure({
        action,
        errorCode: 'QOBUZ_TRACK_CHANGED',
        message: 'the active Qobuz track changed; refresh before retrying',
        snapshot,
      });
    }
    if (snapshot.durationSec !== null && snapshot.durationSec !== undefined
      && positionSec > snapshot.durationSec) {
      return failure({
        action,
        status: 400,
        errorCode: 'QOBUZ_SEEK_OUT_OF_RANGE',
        message: 'positionSec is beyond the current track duration',
        snapshot,
      });
    }
    return { positionSec, expectedTrackId };
  }

  function validateQueueJump(snapshot, options, action) {
    const index = strictNonNegativeInteger(options.index);
    const targetQobuzTrackId = qobuzId(options.targetQobuzTrackId);
    const queueFingerprint = text(options.queueFingerprint, 128);
    const expectedCurrentIndex = strictNonNegativeInteger(options.expectedCurrentIndex);
    const expectedTotalTracks = strictNonNegativeInteger(options.expectedTotalTracks);
    const expectedShuffle = options.expectedShuffle;
    const queue = snapshot.queue;

    if (index === null || !targetQobuzTrackId || !queueFingerprint
      || expectedCurrentIndex === null || expectedTotalTracks === null
      || typeof expectedShuffle !== 'boolean') {
      return failure({
        action,
        status: 400,
        errorCode: 'QOBUZ_QUEUE_EVIDENCE_REQUIRED',
        message: 'index, qobuzTrackId, queueFingerprint, currentIndex, totalTracks, and shuffle are required',
      });
    }
    if (!queue || queue.available === false || !queue.queueFingerprint) {
      return failure({
        action,
        status: 503,
        errorCode: 'QOBUZ_QUEUE_UNAVAILABLE',
        message: 'the authoritative Qobuz queue is unavailable',
        snapshot,
      });
    }
    if (queue.queueFingerprint !== queueFingerprint
      || queue.currentIndex !== expectedCurrentIndex
      || queue.totalTracks !== expectedTotalTracks
      || queue.shuffle !== expectedShuffle) {
      return failure({
        action,
        errorCode: 'QOBUZ_QUEUE_CHANGED',
        message: 'the Qobuz queue changed; refresh before retrying',
        snapshot,
      });
    }
    if (index >= queue.totalTracks) {
      return failure({
        action,
        status: 400,
        errorCode: 'QOBUZ_QUEUE_INDEX_OUT_OF_RANGE',
        message: 'the requested Qobuz queue index is out of range',
        snapshot,
      });
    }
    if (queue.currentIndex === null || queue.currentIndex < 0) {
      return failure({
        action,
        errorCode: 'QOBUZ_QUEUE_POSITION_UNKNOWN',
        message: 'the current Qobuz queue position is unavailable',
        snapshot,
      });
    }

    let target = null;
    if (index === queue.currentIndex) {
      target = queue.currentTrack;
    } else if (index < queue.currentIndex) {
      return failure({
        action,
        errorCode: 'QOBUZ_QUEUE_HISTORY_UNSUPPORTED',
        message: 'history occurrences cannot be safely targeted until PiBuZ exposes their absolute indices',
        snapshot,
      });
    } else if (queue.shuffle) {
      return failure({
        action,
        errorCode: 'QOBUZ_QUEUE_SHUFFLE_UNSUPPORTED',
        message: 'queue jump is unavailable while Qobuz shuffle is enabled',
        snapshot,
      });
    } else {
      const offset = index - queue.currentIndex - 1;
      target = Array.isArray(queue.upcoming) ? queue.upcoming[offset] : null;
    }

    if (!target || target.qobuzTrackId !== targetQobuzTrackId) {
      return failure({
        action,
        errorCode: 'QOBUZ_QUEUE_OCCURRENCE_MISMATCH',
        message: 'the selected Qobuz queue occurrence does not match the current snapshot',
        snapshot,
      });
    }
    return { index, targetQobuzTrackId };
  }

  async function verifyControl(action, before, options) {
    const includeQueue = action === 'next' || action === 'previous' || action === 'queue-jump';
    const deadline = Date.now() + verificationLimitMs;
    let observed = before;
    while (true) {
      observed = await getSnapshot({ includeQueue });
      if (!freshActive(observed)) return { kind: 'ownership-lost', snapshot: observed };

      const beforeIndex = strictNonNegativeInteger(before.queue?.currentIndex);
      const observedIndex = strictNonNegativeInteger(observed.queue?.currentIndex);
      const trackChanged = Boolean(before.qobuzTrackId && observed.qobuzTrackId)
        && before.qobuzTrackId !== observed.qobuzTrackId;
      if (action === 'seek' && options.expectedTrackId
        && observed.qobuzTrackId && observed.qobuzTrackId !== options.expectedTrackId) {
        return { kind: 'track-changed', snapshot: observed };
      }
      const confirmed = action === 'play'
        ? observed.state === 'play'
        : action === 'pause'
          ? observed.state === 'pause'
          : action === 'seek'
            ? observed.qobuzTrackId === options.expectedTrackId
              && observed.elapsedSec !== null
              && Math.abs(observed.elapsedSec - options.positionSec) <= 3
            : action === 'queue-jump'
              ? observedIndex === options.index
                && observed.qobuzTrackId === options.targetQobuzTrackId
              : (beforeIndex !== null && observedIndex !== null && beforeIndex !== observedIndex)
                || trackChanged;
      if (confirmed) return { kind: 'confirmed', snapshot: observed };
      if (Date.now() >= deadline) return { kind: 'pending', snapshot: observed };
      await sleep(verificationPollMs);
    }
  }

  async function control(action, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(CONTROL_ROUTES, action)) {
      return failure({
        action,
        status: 400,
        errorCode: 'QOBUZ_CONTROL_UNSUPPORTED',
        message: 'the requested Qobuz Connect control action is not supported',
      });
    }

    const run = async () => {
      const needsQueue = action === 'next' || action === 'previous' || action === 'queue-jump'
        || options.expectedCurrentIndex !== undefined;
      let before;
      try {
        before = await getSnapshot({ includeQueue: needsQueue });
      } catch (error) {
        return failure({
          action,
          status: 503,
          errorCode: 'QOBUZ_OWNERSHIP_UNKNOWN',
          message: 'PiBuZ ownership could not be read before the command',
        });
      }
      if (!freshActive(before)) {
        return failure({
          action,
          errorCode: before?.ownershipState === 'confirmed-inactive'
            ? 'QOBUZ_NOT_ACTIVE'
            : 'QOBUZ_OWNERSHIP_UNKNOWN',
          message: before?.ownershipState === 'confirmed-inactive'
            ? 'PiBuZ is not the active Qobuz Connect playback owner'
            : 'PiBuZ ownership is unknown or stale; refresh state before retrying',
          snapshot: before,
        });
      }

      const currentEvidence = validateExpectedCurrent(before, options, action);
      if (currentEvidence) return currentEvidence;

      let requestBody;
      let validated;
      if (action === 'seek') {
        validated = validateSeek(before, options, action);
        if (validated?.ok === false) return validated;
        requestBody = { position: validated.positionSec };
      } else if (action === 'queue-jump') {
        validated = validateQueueJump(before, options, action);
        if (validated?.ok === false) return validated;
        requestBody = { index: validated.index };
      }

      try {
        await postControl(CONTROL_ROUTES[action], requestBody);
      } catch (error) {
        if (error?.controlAmbiguous) {
          return failure({
            action,
            status: 504,
            errorCode: 'QOBUZ_CONTROL_AMBIGUOUS',
            message: 'PiBuZ may have accepted the command, but its result is unknown; inspect state before retrying',
            snapshot: before,
            accepted: 'unknown',
            verification: 'unknown',
          });
        }
        return failure({
          action,
          status: 502,
          errorCode: 'QOBUZ_CONTROL_REJECTED',
          message: 'PiBuZ rejected the Qobuz Connect control request',
          snapshot: before,
          verification: 'rejected',
        });
      }

      const verification = await verifyControl(action, before, {
        ...(validated || {}),
        expectedTrackId: validated?.expectedTrackId || qobuzId(options.expectedQobuzTrackId),
      });
      if (verification.kind === 'ownership-lost') {
        return failure({
          action,
          errorCode: 'QOBUZ_OWNERSHIP_CHANGED',
          message: 'Qobuz Connect ownership changed before the command result was confirmed',
          snapshot: verification.snapshot,
          accepted: true,
          verification: 'ownership-lost',
        });
      }
      if (verification.kind === 'track-changed') {
        return failure({
          action,
          errorCode: 'QOBUZ_TRACK_CHANGED',
          message: 'the active Qobuz track changed before seek was confirmed',
          snapshot: verification.snapshot,
          accepted: true,
          verification: 'track-changed',
        });
      }
      if (verification.kind === 'pending') {
        return {
          ok: true,
          action,
          status: 202,
          accepted: true,
          confirmed: false,
          verification: 'pending',
          snapshot: verification.snapshot,
        };
      }
      return {
        ok: true,
        action,
        status: 200,
        accepted: true,
        confirmed: true,
        verification: 'confirmed',
        snapshot: verification.snapshot,
      };
    };

    const next = controlTail.then(run, run);
    controlTail = next.catch(() => {});
    return next;
  }

  return {
    ...adapter,
    getSnapshot,
    getNowPlaying,
    getQueue,
    control,
  };
}

export const pibuzQobuzControlDefaults = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  verifyMs: DEFAULT_VERIFY_MS,
  pollMs: DEFAULT_POLL_MS,
});
