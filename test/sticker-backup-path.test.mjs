import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolveStickerBackupDirectory } from '../src/routes/config.ratings-sticker.routes.mjs';

test('sticker backups move out of a private home in shared-state mode while legacy defaults remain compatible', () => {
  const shared = '/opt/sonuvi/shared';
  assert.equal(
    resolveStickerBackupDirectory({
      env: { SONUVI_STATE_ROOT: shared },
      statePaths: { sharedStateEnabled: true, protectedRoot: path.join(shared, 'protected') },
    }),
    path.join(shared, 'protected', 'sticker-backups'),
  );
  assert.equal(
    resolveStickerBackupDirectory({
      env: {},
      statePaths: { sharedStateEnabled: false, protectedRoot: '/ignored' },
    }),
    '/home/brianwis/backups/sticker-backups',
  );
  assert.equal(
    resolveStickerBackupDirectory({
      env: { MPD_STICKER_BACKUP_DIR: '/var/lib/sonuvi/sticker-backups' },
      statePaths: { sharedStateEnabled: true, protectedRoot: path.join(shared, 'protected') },
    }),
    '/var/lib/sonuvi/sticker-backups',
  );
  assert.throws(
    () => resolveStickerBackupDirectory({
      env: { MPD_STICKER_BACKUP_DIR: 'relative-backups' },
      statePaths: { sharedStateEnabled: true, protectedRoot: path.join(shared, 'protected') },
    }),
    /absolute path/,
  );
});
