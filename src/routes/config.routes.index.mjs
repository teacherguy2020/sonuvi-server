import { registerConfigQueueWizardBasicRoutes } from './config.queue-wizard-basic.routes.mjs';
import { registerConfigQueueWizardPreviewRoute } from './config.queue-wizard-preview.routes.mjs';
import { registerConfigQueueWizardCollageRoute } from './config.queue-wizard-collage.routes.mjs';
import { registerConfigQueueWizardApplyRoute } from './config.queue-wizard-apply.routes.mjs';
import { registerConfigQueueWizardVibeRoutes } from './config.queue-wizard-vibe.routes.mjs';
import { registerConfigDiagnosticsRoutes } from './config.diagnostics.routes.mjs';
import { registerConfigRatingsStickerRoutes } from './config.ratings-sticker.routes.mjs';
import { registerConfigRuntimeAdminRoutes } from './config.runtime-admin.routes.mjs';
import { registerConfigListeningHistoryRoutes } from './config.listening-history.routes.mjs';
import { registerConfigAlexaAliasRoutes } from './config.alexa-alias.routes.mjs';
import { registerConfigLibraryHealthArtRoutes } from './config.library-health-art.routes.mjs';
import { registerConfigLibraryHealthGenreRoutes } from './config.library-health-genre.routes.mjs';
import { registerConfigLibraryHealthPerformersRoutes } from './config.library-health-performers.routes.mjs';
import { registerConfigLibraryHealthBatchRoutes } from './config.library-health-batch.routes.mjs';
import { registerConfigLibraryHealthReadRoutes } from './config.library-health-read.routes.mjs';
import { registerConfigLibraryHealthAnimatedArtRoutes } from './config.library-health-animated-art.routes.mjs';
import { registerConfigRoutes } from './config.routes.mjs';
import { registerConfigControllerProfileRoutes } from './config.controller-profile.routes.mjs';
import { registerConfigEndlessVibeRoutes } from './config.endless-vibe.routes.mjs';
import { registerConfigBrowseRoutes } from './config.browse.routes.mjs';
import { registerConfigMoodeAudioInfoRoutes } from './config.moode-audio-info.routes.mjs';
import { registerConfigQobuzAccountRoutes } from './config.qobuz-account.routes.mjs';
import { registerEchoLinkRoutes } from './echo-link.routes.mjs';

export function registerAllConfigRoutes(app, deps) {
  registerEchoLinkRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigQueueWizardBasicRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigQueueWizardPreviewRoute(app, {
    requireTrackKey: deps.requireTrackKey,
    getRatingForFile: deps.getRatingForFile,
  });

  registerConfigQueueWizardCollageRoute(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigQueueWizardApplyRoute(app, {
    requireTrackKey: deps.requireTrackKey,
    mpdQueryRaw: deps.mpdQueryRaw,
  });

  const queueWizardVibe = registerConfigQueueWizardVibeRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    getRatingForFile: deps.getRatingForFile,
    mpdQueryRaw: deps.mpdQueryRaw,
    mpdHasACK: deps.mpdHasACK,
    parseMpdKeyVals: deps.parseMpdKeyVals,
    parseMpdFirstBlock: deps.parseMpdFirstBlock,
    log: deps.log,
  });

  registerConfigDiagnosticsRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    getRatingForFile: deps.getRatingForFile,
    setRatingForFile: deps.setRatingForFile,
    getAlexaWasPlaying: deps.getAlexaWasPlaying,
    clearAlexaWasPlayingState: deps.clearAlexaWasPlayingState,
    setAlexaModeState: deps.setAlexaModeState,
    getYoutubeNowPlayingHint: deps.getYoutubeNowPlayingHint,
    getYoutubeQueueHint: deps.getYoutubeQueueHint,
    getSourceAudio: deps.getSourceAudio,
    getQobuzNowPlaying: deps.getQobuzNowPlaying,
  });

  registerConfigRatingsStickerRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigRuntimeAdminRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    log: deps.log,
    getLocalHistoryItems: deps.getLocalHistoryItems,
    trackKey: deps.trackKey,
  });

  registerConfigListeningHistoryRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    getItems: deps.getLocalHistoryItems,
    getEvents: deps.getLocalHistoryEvents,
    trackKey: deps.trackKey,
  });

  registerConfigAlexaAliasRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigLibraryHealthArtRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigLibraryHealthGenreRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigLibraryHealthPerformersRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    log: deps.log,
  });

  registerConfigLibraryHealthBatchRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    setRatingForFile: deps.setRatingForFile,
  });

  registerConfigLibraryHealthReadRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    mpdQueryRaw: deps.mpdQueryRaw,
    getRatingForFile: deps.getRatingForFile,
    mpdStickerGetSong: deps.mpdStickerGetSong,
  });

  registerConfigLibraryHealthAnimatedArtRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigControllerProfileRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigEndlessVibeRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigBrowseRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
  });

  registerConfigMoodeAudioInfoRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    getQobuzNowPlaying: deps.getQobuzNowPlaying,
    probeAlsaHardware: deps.probeAlsaHardware,
    getSourceAudio: deps.getSourceAudio,
    getActiveRadioStream: deps.getActiveRadioStream,
    getLiveRadioAudio: deps.getLiveRadioAudio,
  });

  if (deps.controlPoint) {
    registerConfigQobuzAccountRoutes(app, {
      requireTrackKey: deps.requireTrackKey,
      controlPoint: deps.controlPoint,
      releaseQobuzConnect: deps.releaseQobuzConnect,
      getQobuzNowPlaying: deps.getQobuzNowPlaying,
    });
  }

  // compatibility no-op
  registerConfigRoutes(app, {
    requireTrackKey: deps.requireTrackKey,
    log: deps.log,
    mpdQueryRaw: deps.mpdQueryRaw,
    getRatingForFile: deps.getRatingForFile,
    setRatingForFile: deps.setRatingForFile,
    mpdStickerGetSong: deps.mpdStickerGetSong,
  });

  return {
    startMobileVibe: queueWizardVibe?.startMobileVibe,
  };
}
