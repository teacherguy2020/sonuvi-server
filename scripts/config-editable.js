/* Literal editable browser contract. Never collect credentials from the DOM. */
(() => {
  const fields = {
    featureAlexaSkill: ['alexa', 'enabled', 'bool'], alexaDomain: ['alexa', 'publicDomain'],
    notifyEnabled: ['notifications.trackNotify', 'enabled', 'bool'],
    pollMs: ['notifications.trackNotify', 'pollMs', 'number'],
    dedupeMs: ['notifications.trackNotify', 'dedupeMs', 'number'],
    alexaMaxAgeMs: ['notifications.trackNotify', 'alexaMaxAgeMs', 'number'],
    featurePodcasts: ['features', 'podcasts', 'bool'], featureRatings: ['features', 'ratings', 'bool'],
    featureRadio: ['features', 'radio', 'bool'], featureAlbumPersonnel: ['features', 'albumPersonnel', 'bool'],
    featureShowAboutWhenNoPersonnel: ['features', 'showAboutWhenNoPersonnel', 'bool'],
    featureMoodeDisplayTakeover: ['features', 'moodeDisplayTakeover', 'bool'],
    featureLastfm: ['features', 'lastfm', 'bool'],
    apiNodeIp: ['', 'apiHost'], apiPort: ['ports', 'api', 'number'], uiPort: ['ports', 'ui', 'number'],
    mpdHost: ['mpd', 'host'], mpdPort: ['mpd', 'port', 'number'],
    moodeSshHost: ['moode', 'sshHost'], moodeSshUser: ['moode', 'sshUser'],
    moodeBaseUrl: ['moode', 'baseUrl'],
    pathMusicLibraryRoot: ['paths', 'musicLibraryRoot'], pathMoodeUsbMount: ['paths', 'moodeUsbMount'],
    pathPiMountBase: ['paths', 'piMountBase'], pathPodcastRoot: ['paths', 'podcastRoot'],
    idleBrandLine: ['display', 'idleBrandLine'], idleMessageLine: ['display', 'idleMessageLine'],
    lastfmUsername: ['lastfm', 'username'], lastfmRecentsReplaceRadio: ['lastfm', 'recentsReplaceRadio', 'bool'],
    lastfmRecentsMode: ['lastfm', 'recentsMode'],
  };
  function capture(document) {
    const values = {};
    for (const [id, [, , kind]] of Object.entries(fields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      values[id] = kind === 'bool' ? !!el.checked : kind === 'number' ? Number(el.value) : String(el.value || '').trim();
    }
    return values;
  }
  function changes(before, after) {
    const out = {};
    for (const [id, [group, key]] of Object.entries(fields)) {
      if (!Object.hasOwn(after, id) || after[id] === before[id]) continue;
      if (group === 'paths' && !after[id]) continue; // redacted paths are never blanks to save
      let target = out;
      for (const part of group.split('.').filter(Boolean)) target = target[part] ||= {};
      target[key] = after[id];
    }
    return out;
  }
  globalThis.SonuviConfigEditable = Object.freeze({ capture, changes, fieldIds: Object.freeze(Object.keys(fields)) });
})();
