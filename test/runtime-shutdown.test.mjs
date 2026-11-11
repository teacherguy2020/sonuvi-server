import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installRuntimeShutdown } from '../src/lib/runtime-shutdown.mjs';
test('signal shutdown awaits resource cleanup once before exit',async()=>{
 const target=new EventEmitter();let release;const pending=new Promise(resolve=>{release=resolve;});const seen=[];
 const hook=installRuntimeShutdown({target,cleanup:async signal=>{seen.push(signal);await pending;seen.push('released');},exit:code=>seen.push(code)});
 target.emit('SIGTERM');target.emit('SIGINT');await Promise.resolve();assert.deepEqual(seen,['SIGTERM']);release();await hook.shutdown('again');assert.deepEqual(seen,['SIGTERM','released',0]);hook.dispose();assert.equal(target.listenerCount('SIGTERM'),0);
});
