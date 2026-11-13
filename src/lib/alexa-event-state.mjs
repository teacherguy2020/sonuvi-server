import fs from 'node:fs/promises';
import path from 'node:path';
import {MASTER_FORMAT} from './master-configuration.mjs';
import {runtimeStatePaths} from './runtime-state-paths.mjs';
import {writeJsonAtomically} from './atomic-file.mjs';

const target=Symbol('alexa-event-target');
const eventFields=['unresolvedArtists','heardArtists','unresolvedAlbums','heardAlbums','unresolvedPlaylists','heardPlaylists'];
export async function readAlexaEventState(configPath,{dataRoot=runtimeStatePaths().dataRoot}={}){
  const document=JSON.parse(await fs.readFile(configPath,'utf8'));
  if(document.format!==MASTER_FORMAT)return document;
  const file=path.join(dataRoot,'alexa-events.json');
  let events={};
  try{events=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const alexa={};
  for(const name of eventFields)alexa[name]=events.alexa?.[name] ?? document.plugins.alexa[name] ?? [];
  // Enumerable symbol survives existing object spread, never JSON serialization.
  return {alexa,[target]:file};
}
export async function writeAlexaEventState(configPath,next){
  if(!next[target])return writeJsonAtomically(configPath,next);
  const alexa=Object.fromEntries(eventFields.map(name=>[name,next.alexa?.[name]??[]]));
  await writeJsonAtomically(next[target],{version:1,alexa});
}
