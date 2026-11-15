/**
 * Shared radio metadata normalization contract.
 *
 * This module deliberately stops before provider enrichment. It owns source
 * cleanup, station/profile selection, classification, classical field
 * extraction, and conservative lookup gates. Apple/iTunes/About enrichment
 * remains in the existing server service so its caches and provider safety
 * rules stay unchanged.
 */

export const RADIO_METADATA_CONTRACT_VERSION = 1;

const PROFILE_DEFINITIONS = Object.freeze({
  wfmt: {
    id: 'wfmt',
    aliases: ['wfmt', 'classical 98.7', '98.7 wfmt'],
    kind: 'classical',
  },
  'davide-mimic': {
    id: 'davide-mimic',
    aliases: ['davide of mimic', 'davide', 'mimic', 'liveboxstream.uk/proxy/davideof'],
    kind: 'classical',
  },
  generic: {
    id: 'generic',
    aliases: [],
    kind: 'generic',
  },
});

const TALK_NEWS_SPORTS = /(^|\W)(talk|news|sports?|espn|npr|podcast|weather|traffic|headline|commentary|interview|morning\s+show|afternoon\s+show|drive\s*time|play-by-play)(\W|$)|sportstalk/i;
const ENSEMBLE = /orchester|orchestra|symphon|sinfon|philharmonic|ensemble|camerata|choir|chorale|quartet|quintet|trio/i;
const ROLE_NAMES = Object.freeze({
  p: 'piano', pf: 'piano', pno: 'piano',
  vn: 'violin', vln: 'violin',
  vc: 'cello', va: 'viola', vla: 'viola', vi: 'viola',
  f: 'flute', fl: 'flute',
});

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decode(value) {
  return text(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function unwrapStreamTitle(value) {
  let result = decode(value);
  if (/^streamtitle\s*=/i.test(result)) result = result.replace(/^streamtitle\s*=\s*/i, '').trim();
  if ((result.startsWith("'") && /';?$/.test(result)) || (result.startsWith('"') && /";?$/.test(result))) {
    result = result.slice(1).replace(/["'];?$/, '').trim();
  }
  return result;
}

function parseQuotedAttrs(raw) {
  const out = {};
  const re = /([A-Za-z0-9_]+)\s*=\s*"([\s\S]*?)"/g;
  let match;
  while ((match = re.exec(String(raw || ''))) !== null) out[match[1].toLowerCase()] = text(match[2]);
  return out;
}

export function parseIheartTitleBlob(raw) {
  const source = unwrapStreamTitle(raw);
  if (!source) return null;
  if (/(^|[\s,])adContext="[^"]+"/i.test(source)) {
    return { artist: 'Sponsor Ad', title: 'Sponsor Ad', artUrl: '', raw: source, fields: {}, classification: 'sponsor-ad' };
  }
  const fields = parseQuotedAttrs(source);
  const prefix = source.match(/^(.*?)\s*-\s*text="/i)?.[1] || '';
  const fallbackTitle = source.match(/(?:^|[\s,])text\s*=\s*"([^"]+)"/i)?.[1] || '';
  const artist = text(prefix || fields.artist);
  const title = text(fields.text || fallbackTitle || fields.title);
  if (!artist && !title) return null;
  return {
    artist,
    title,
    artUrl: text(fields.amgartworkurl || fields.amgArtworkURL),
    raw: source,
    fields,
    classification: 'iheart',
  };
}

function normalizePersonnel(value) {
  const source = text(value);
  if (!source) return [];
  const parts = source.split(/\s*,\s*/).map(text).filter(Boolean);
  const result = [];
  for (let i = 0; i < parts.length; i += 1) {
    const role = ROLE_NAMES[parts[i + 1]?.toLowerCase()];
    if (role) {
      result.push(`${parts[i]} (${role})`);
      i += 1;
    } else {
      result.push(parts[i]);
    }
  }
  return result;
}

export function splitRadioClassicalMetadata(titleLine, { profile = 'generic' } = {}) {
  const source = text(titleLine);
  if (!source) return null;
  const parts = source.split(/\s+-\s+/).map(text).filter(Boolean);
  if (parts.length < 3) {
    const compact = source.match(/^(.*?)\s*-\s*(.*?)\s*;\s*([^/;]+?)(?:\s*\/\s*([^;]+))?$/);
    if (!compact) return null;
    const personnel = [];
    if (text(compact[2])) personnel.push(text(compact[2]).replace(/,\s*(p|pf|pno)\b/i, ' (piano)'));
    if (text(compact[3])) personnel.push(text(compact[3]));
    if (text(compact[4])) personnel.push(`${text(compact[4])} (conductor)`);
    return { composer: '', work: text(compact[1]), personnel, program: '', movement: '' };
  }

  let performerIndex = -1;
  if (profile === 'davide-mimic') performerIndex = parts.findIndex((part, index) => index >= 2 && ENSEMBLE.test(part));
  if (performerIndex < 0) performerIndex = parts.findIndex((part, index) => index >= 1 && (ENSEMBLE.test(part) || /\/(?:[^/]+)|,\s*(?:p|pf|vn|vc)\b/i.test(part)));
  if (performerIndex < 0) performerIndex = Math.min(parts.length - 2, 2);

  const composer = parts.length >= 4 && /^[A-Za-zÀ-ÿ'’. -]+$/.test(parts[0]) && /\s/.test(parts[0]) ? parts[0] : '';
  const workParts = parts.slice(composer ? 1 : 0, performerIndex);
  const work = workParts.join(' - ');
  const performerSource = parts[performerIndex] || '';
  const performerParts = normalizePersonnel(performerSource.replace(/\s*\/\s*/g, ', '));
  const ensembleIndex = performerParts.findIndex((value) => ENSEMBLE.test(value));
  const personnel = performerSource.includes('/') && performerParts.length === 2
    ? [`${performerParts[1]} (conductor)`, performerParts[0]]
    : (ensembleIndex >= 2
      ? performerParts.map((value, index) => index === ensembleIndex - 1 ? `${value} (conductor)` : value)
      : (performerParts.length === 2 && ENSEMBLE.test(performerParts[1])
        ? [`${performerParts[0]} (conductor)`, performerParts[1]]
        : performerParts));
  const tail = parts.slice(performerIndex + 1);
  return {
    composer,
    work,
    movement: composer && workParts.length > 1 ? workParts.slice(1).join(' - ') : '',
    personnel,
    program: tail.join(' - '),
  };
}

export function radioMetadataProfile(stationName = '', file = '') {
  const source = `${text(stationName)} ${text(file)}`.toLowerCase();
  for (const definition of Object.values(PROFILE_DEFINITIONS)) {
    if (definition.aliases.some((alias) => source.includes(alias))) return definition.id;
  }
  return 'generic';
}

export function radioStationProfiles() {
  return Object.values(PROFILE_DEFINITIONS).map((profile) => ({ ...profile, aliases: [...profile.aliases] }));
}

export function classifyRadioMetadata({ artist = '', title = '', album = '', stationName = '', file = '', iheart = null } = {}) {
  const blob = [artist, title, album, stationName, file].map(text).join(' | ');
  if (iheart?.classification === 'sponsor-ad' || /adContext="/i.test(blob)) return 'sponsor-ad';
  if (TALK_NEWS_SPORTS.test(blob)) return 'talk-news-sports';
  if (radioMetadataProfile(stationName, file) !== 'generic' || /classical|symphon|concerto|sonata|quartet/i.test(blob)) return 'classical';
  if (iheart || /TPID="\d+"|song_spot="/i.test(blob)) return 'iheart';
  if (!text(artist) || /^(radio\s*station|unknown|stream|\d{1,3})$/i.test(text(artist))) return 'generic';
  return 'generic';
}

export function radioLookupDecision({ artist = '', title = '', album = '', stationName = '', file = '', classification = '' } = {}) {
  const a = text(artist);
  const t = text(title);
  if (!t) return { allow: false, reason: 'empty-title' };
  if (classification === 'sponsor-ad') return { allow: false, reason: 'sponsor-ad' };
  if (classification === 'talk-news-sports') return { allow: false, reason: 'talk-news-sports' };
  if (/^(radio\s*station|unknown|stream|\d{1,3})$/i.test(a) && !/\s[-–—]\s/.test(t)) {
    return { allow: false, reason: 'generic-artist' };
  }
  return { allow: true, reason: 'ok' };
}

function stripClassicalMovementDetail(value) {
  let result = text(value);
  result = result.replace(/\s+-\s+[IVXLC]+\.?\s+.*$/i, '');
  result = result.replace(/,\s*\d+(?:st|nd|rd|th)\s+tableau\s*:\s*.*/i, '');
  result = result.replace(/:\s*[IVXLC]+\.?\s+.*$/i, '');
  return text(result);
}

function composerShortName(value) {
  const parts = text(value).replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0].charAt(0)}. ${parts[1].slice(0, 4)}` : '';
}

function validRadioAlbumHint(value) {
  const hint = text(value);
  if (!hint || /^(radio|stream|wfmt|classical|station)$/i.test(hint)) return '';
  return hint;
}

/**
 * Build the provider lookup context shared by canonical and mobile radio.
 * It accepts both a full station title line and the split artist/title pair
 * emitted by native ICY playback.
 */
export function deriveRadioLookupContext({ artist = '', title = '', album = '', profile = 'generic', personnel = [] } = {}) {
  const sourceArtist = text(artist);
  const sourceTitle = text(title);
  const classical = profile !== 'generic';
  const parsed = classical ? splitRadioClassicalMetadata(sourceTitle, { profile }) : null;
  const sourceParts = sourceTitle.split(/\s+-\s+/).map(text).filter(Boolean);
  const performerIndex = classical
    ? sourceParts.findIndex((part, index) => index >= 1 && (ENSEMBLE.test(part) || /\//.test(part)))
    : -1;
  // With native split input, the parser can see the work as its first
  // segment. Prefer the separately supplied artist as composer in that
  // shape; full station lines still use the parsed composer segment.
  const splitPairWork = sourceArtist && performerIndex > 0
    ? sourceParts.slice(0, performerIndex).join(' - ')
    : '';
  const composer = text(sourceArtist || parsed?.composer);
  const lookupTitleFull = sourceTitle;
  const lookupTitle = classical
    ? stripClassicalMovementDetail(parsed?.work || splitPairWork || sourceTitle)
    : sourceTitle;

  const people = [
    ...(Array.isArray(personnel) ? personnel : []),
    ...(Array.isArray(parsed?.personnel) ? parsed.personnel : []),
  ].map(text).filter(Boolean);
  const cleaned = people.map((value) => text(value.replace(/\s*\([^)]*\)\s*/g, ' ')));
  const ensemble = cleaned.find((value) => ENSEMBLE.test(value)) || '';
  const conductorRaw = people.find((value) => /\(conductor\)/i.test(value)) || '';
  const conductor = text(conductorRaw.replace(/\s*\(conductor\)\s*/i, ''));
  const conductorNames = new Set(people
    .filter((value) => /\(conductor\)/i.test(value))
    .map((value) => text(value.replace(/\s*\(conductor\)\s*/i, '')).toLowerCase()));
  const soloist = cleaned.find((value) => value
    && !conductorNames.has(value.toLowerCase())
    && !ENSEMBLE.test(value)) || '';

  const program = text(parsed?.program);
  const albumHint = validRadioAlbumHint(album) || (
    /:\s|\b(op\.?|concerto|symphony|quartet|sonata|orchestral works)\b/i.test(program)
      ? validRadioAlbumHint(program)
      : ''
  );
  const labelHint = classical && sourceParts.length >= 4
    ? validRadioAlbumHint(sourceParts.at(-1))
    : '';

  return {
    lookupArtist: text(ensemble || sourceArtist || composer),
    lookupTitle,
    lookupTitleFull,
    lookupAlbumHint: albumHint,
    composer,
    composerShort: composerShortName(composer),
    ensembleHint: ensemble,
    conductorHint: conductor,
    soloistHint: soloist,
    labelHint,
    programHint: profile === 'davide-mimic' ? program : '',
  };
}

// WALM Christmas publishes title-first ICY metadata with a station suffix.
// Keep this station-scoped: an ordinary song containing "by" is not a pair.
function parseChristmasVinylTitle({ title, stationName, file }) {
  let host = '';
  try { host = new URL(file).hostname.toLowerCase(); } catch {}
  const station = /\bchristmas\s+vinyl\b/i.test(stationName)
    || ((host === 'walmradio.com' || host.endsWith('.walmradio.com')) && /\/christmas(?:[_.?/#]|$)/i.test(file));
  if (!station) return null;
  const line = text(title).replace(/\s+[-–—]\s+Christmas Vinyl(?: HD)?\s+on\s+(?:www\.)?walmradio\.com\s*$/i, '').trim();
  // Greedy first group deliberately selects the last standalone "by".
  const match = line.match(/^(.+)\s+by\s+(.+)$/i);
  if (!match || !text(match[1]) || !text(match[2])) return null;
  return { title: text(match[1]), artist: text(match[2]) };
}

export function normalizeRadioMetadata({ artist = '', title = '', album = '', stationName = '', file = '' } = {}) {
  const raw = { artist: text(artist), title: unwrapStreamTitle(title), album: text(album), stationName: text(stationName), file: text(file) };
  const parsedWalm = parseChristmasVinylTitle(raw);
  const parsedIheart = parseIheartTitleBlob(raw.title) || parseIheartTitleBlob(raw.artist);
  const normalized = {
    ...raw,
    artist: text(parsedIheart?.artist || parsedWalm?.artist || raw.artist),
    title: text(parsedIheart?.title || parsedWalm?.title || raw.title),
  };
  const profile = radioMetadataProfile(normalized.stationName, normalized.file);
  const classification = classifyRadioMetadata({ ...normalized, iheart: parsedIheart });
  const classical = classification === 'classical'
    ? splitRadioClassicalMetadata(normalized.title, { profile })
    : null;
  const lookup = radioLookupDecision({ ...normalized, classification });
  const reasonCodes = [];
  if (parsedWalm && !parsedIheart) reasonCodes.push('christmas-vinyl-title-by-artist');
  if (parsedIheart) reasonCodes.push(parsedIheart.classification === 'sponsor-ad' ? 'iheart-sponsor-ad' : 'iheart-blob');
  if (classical) reasonCodes.push('classical-fields-extracted');
  if (!lookup.allow) reasonCodes.push(`lookup-suppressed:${lookup.reason}`);
  return {
    contractVersion: RADIO_METADATA_CONTRACT_VERSION,
    raw,
    artist: normalized.artist,
    title: normalized.title,
    album: normalized.album,
    profile,
    classification,
    confidence: lookup.allow ? (classical || parsedIheart ? 'high' : 'medium') : 'low',
    reasonCodes,
    lookup,
    composer: text(classical?.composer),
    work: text(classical?.work),
    program: text(classical?.program),
    personnel: Array.isArray(classical?.personnel) ? classical.personnel : [],
    artUrl: text(parsedIheart?.artUrl),
  };
}

export function radioHoldbackPolicy(stationName = '', stationKey = '', { defaultMs = 6000, wfmtMs = 45000, normalMs = 1500 } = {}) {
  const source = `${text(stationName)} ${text(stationKey)}`.toLowerCase();
  const strict = /\bwfmt\b|\bclassical\b|\bking\s*fm\b|\bkusc\b|\bkdfc\b|\bbc\s*radio\s*3\b/.test(source);
  return { mode: strict ? 'strict' : 'normal', holdbackMs: strict ? (source.includes('wfmt') ? wfmtMs : defaultMs) : normalMs };
}
