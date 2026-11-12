#!/usr/bin/env node
import { createBrowseIndexAdapter } from '../src/lib/browse-index.mjs';
import { musicLibraryCounts } from '../src/lib/music-library-counts.mjs';
const adapter=createBrowseIndexAdapter({mpdPort:Number(process.env.MPD_PORT||6600)});
const index=await adapter.getBrowseIndex(process.env.MPD_HOST,{force:true});
process.stdout.write(JSON.stringify(musicLibraryCounts(index.tracks))+'\n');
