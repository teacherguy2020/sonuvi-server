import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRadioMetadata,
  deriveRadioLookupContext,
  normalizeRadioMetadata,
  radioHoldbackPolicy,
  radioMetadataProfile,
  radioStationProfiles,
  splitRadioClassicalMetadata,
} from '../src/lib/radio-metadata.mjs';

test('normalizes iHeart song blobs and preserves sponsor classification', () => {
  const song = normalizeRadioMetadata({
    artist: 'iHeart Jazz',
    title: 'Chet Baker - text="Almost Blue" song_spot="0" TPID="123"',
    stationName: 'iHeart Vinyl Jazz',
    file: 'https://radio.example/iheart',
  });
  assert.equal(song.artist, 'Chet Baker');
  assert.equal(song.title, 'Almost Blue');
  assert.equal(song.classification, 'iheart');
  assert.ok(song.reasonCodes.includes('iheart-blob'));

  const ad = normalizeRadioMetadata({
    title: 'adContext="sponsor" text="Commercial" TPID="1"',
    stationName: 'iHeart News',
    file: 'https://radio.example/iheart',
  });
  assert.equal(ad.classification, 'sponsor-ad');
  assert.equal(ad.lookup.allow, false);
});

test('extracts three-, four-, and five-segment classical metadata', () => {
  const three = splitRadioClassicalMetadata('Work - Orchestra/Conductor - Program', { profile: 'wfmt' });
  assert.equal(three.work, 'Work');
  assert.ok(three.personnel.some((value) => /conductor/i.test(value)));

  const four = splitRadioClassicalMetadata('Claude Debussy - La Mer - Chicago Symphony Orchestra/Conductor - Afternoon', { profile: 'wfmt' });
  assert.equal(four.composer, 'Claude Debussy');
  assert.equal(four.work, 'La Mer');
  assert.equal(four.program, 'Afternoon');

  const five = splitRadioClassicalMetadata('Sergei Prokofiev - Piano Concerto No. 2 - Allegro - Martha Argerich, Charles Dutoit, London Symphony Orchestra - Davide', { profile: 'davide-mimic' });
  assert.equal(five.composer, 'Sergei Prokofiev');
  assert.match(five.work, /Piano Concerto No\. 2 - Allegro/);
  assert.ok(five.personnel.some((value) => /conductor/i.test(value)));
  assert.match(five.program, /Davide/);
});

test('uses explicit station profiles and conservative lookup suppression', () => {
  assert.equal(radioMetadataProfile('WFMT 98.7', ''), 'wfmt');
  assert.equal(radioMetadataProfile('Davide of MIMIC', 'https://liveboxstream.uk/proxy/davideof'), 'davide-mimic');
  assert.ok(radioStationProfiles().some((profile) => profile.id === 'wfmt'));
  assert.equal(classifyRadioMetadata({ artist: 'NPR News', title: 'Morning show', stationName: 'News FM' }), 'talk-news-sports');
  const suppressed = normalizeRadioMetadata({ artist: 'Radio Station', title: 'Morning show', stationName: 'Talk FM' });
  assert.equal(suppressed.lookup.reason, 'talk-news-sports');
  assert.equal(suppressed.confidence, 'low');
});

test('retains WFMT forty-five-second holdback policy', () => {
  assert.deepEqual(radioHoldbackPolicy('WFMT 98.7', 'https://radio.example/wfmt'), {
    mode: 'strict',
    holdbackMs: 45000,
  });
  assert.deepEqual(radioHoldbackPolicy('Jazz FM', 'https://radio.example/jazz'), {
    mode: 'normal',
    holdbackMs: 1500,
  });
});

test('derives the same classical lookup context from split and full WFMT input', () => {
  const split = deriveRadioLookupContext({
    artist: 'Granville Bantock',
    title: 'The Pierrot of the Minute - Bournemouth Sinfonietta/Norman Del Mar - Bantock, Butterworth, Bridge - Chandos',
    profile: 'wfmt',
  });
  assert.equal(split.lookupTitle, 'The Pierrot of the Minute');
  assert.equal(split.ensembleHint, 'Bournemouth Sinfonietta');
  assert.equal(split.conductorHint, 'Norman Del Mar');
  assert.equal(split.composer, 'Granville Bantock');

  const full = deriveRadioLookupContext({
    title: 'Granville Bantock - The Pierrot of the Minute - Bournemouth Sinfonietta/Norman Del Mar - Bantock, Butterworth, Bridge - Chandos',
    profile: 'wfmt',
  });
  assert.equal(full.composer, 'Granville Bantock');
  assert.equal(full.lookupTitle, 'The Pierrot of the Minute');
  assert.equal(full.ensembleHint, 'Bournemouth Sinfonietta');
  assert.equal(full.conductorHint, 'Norman Del Mar');
});

test('keeps Davide/MIMIC movement context and curation inputs intact', () => {
  const context = deriveRadioLookupContext({
    artist: 'Sergei Prokofiev',
    title: 'Piano Concerto No. 2, Op. 16 - Allegro - Martha Argerich, Charles Dutoit, London Symphony Orchestra - Davide',
    profile: 'davide-mimic',
  });
  assert.match(context.lookupTitle, /Piano Concerto No\. 2/);
  assert.equal(context.ensembleHint, 'London Symphony Orchestra');
  assert.equal(context.conductorHint, 'Charles Dutoit');
  assert.equal(context.programHint, 'Davide');
});


test('Christmas Vinyl splits the last BY and removes only its station suffix', () => {
  const title='Christmas Auld Lang Syne by Bobby Darin - Christmas Vinyl on walmradio.com';
  const result=normalizeRadioMetadata({title,stationName:'Christmas Vinyl HD'});
  assert.equal(result.title,'Christmas Auld Lang Syne');
  assert.equal(result.artist,'Bobby Darin');
  assert.equal(result.raw.title,title);
  assert.equal(result.classification,'generic');
  assert.equal(result.lookup.allow,true);
  assert.equal(deriveRadioLookupContext(result).lookupArtist,'Bobby Darin');
  const repeated=normalizeRadioMetadata({title:'As Time Goes By BY Bing Crosby',file:'https://icecast3.walmradio.com:8443/christmas_opus'});
  assert.equal(repeated.title,'As Time Goes By');assert.equal(repeated.artist,'Bing Crosby');
  for(const title of ['Christmas Vinyl',' by ','A song by ']) {
    const unchanged=normalizeRadioMetadata({title,stationName:'Christmas Vinyl HD'});
    assert.equal(unchanged.artist,'');
  }
  const generic=normalizeRadioMetadata({title:'As Time Goes By',artist:'Bing Crosby',stationName:'Other station'});
  assert.equal(generic.title,'As Time Goes By');assert.equal(generic.artist,'Bing Crosby');
  const spoof=normalizeRadioMetadata({title:'Title by Artist',file:'https://walmradio.com.example.net/christmas'});
  assert.equal(spoof.artist,'');
});
