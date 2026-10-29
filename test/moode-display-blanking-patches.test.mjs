import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, '..');
const fixtureDir = join(testDir, 'fixtures', 'moode-display-blanking');

function applyPatchToFixture(fixtureName, patchName) {
	const tempDir = mkdtempSync(join(tmpdir(), 'now-playing-moode-patch-'));
	const fixturePath = join(fixtureDir, fixtureName);
	const patchPath = join(repositoryRoot, 'docs', 'references', 'moode', patchName);

	try {
		cpSync(fixturePath, join(tempDir, fixtureName));

		for (const args of [
			['--dry-run', '-p0', '-i', patchPath],
			['-p0', '-i', patchPath],
		]) {
			const result = spawnSync('patch', args, {
				cwd: tempDir,
				encoding: 'utf8',
			});
			assert.equal(
				result.status,
				0,
				['patch failed', ...(result.stdout || '').split('\n'), ...(result.stderr || '').split('\n')].join(' | '),
			);
		}

		return readFileSync(join(tempDir, fixtureName), 'utf8');
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

function remoteNowPlayingIsActive({
	state,
	isAirplay = false,
	isUpnp = false,
	millsMode = false,
	displayMode = '',
}) {
	return state === 'play'
		|| isAirplay === true
		|| isUpnp === true
		|| millsMode === true
		|| displayMode === 'mills';
}

test('worker local-display blanking patch applies and uses authoritative remote playback state', () => {
	const worker = applyPatchToFixture('worker.php', 'worker-local-display-blanking.patch');

	assert.match(worker, /\$_SESSION\['local_display'\] == '1' \|\| \$_SESSION\['peppy_display'\] == '1'/);
	assert.match(worker, /function chkAttachedDisplayPlaybackActive\(\$mpdState\)/);
	assert.match(worker, /parse_url\(\$_SESSION\['local_display_url'\]\)/);
	assert.match(worker, /is_array\(\$localDisplay\)/);
	assert.match(worker, /escapeshellarg\(\$nowPlayingUrl\)/);
	assert.doesNotMatch(worker, /\n\+\t\$localDisplay/);
	assert.match(worker, /\['isAirplay'\].*=== true/);
	assert.match(worker, /\['isUpnp'\].*=== true/);
	assert.match(worker, /\['millsMode'\].*=== true/);
	assert.match(worker, /\['displayMode'\].*== 'mills'/);
	assert.match(worker, /&& \$displayActive === false/);
});

test('remote playback state keeps an external display awake only for active sources', () => {
	assert.equal(remoteNowPlayingIsActive({ state: 'pause' }), false);
	assert.equal(remoteNowPlayingIsActive({ state: 'stop' }), false);
	assert.equal(remoteNowPlayingIsActive({ state: 'play' }), true);
	assert.equal(remoteNowPlayingIsActive({ state: 'pause', isAirplay: true }), true);
	assert.equal(remoteNowPlayingIsActive({ state: 'pause', isUpnp: true }), true);
	assert.equal(remoteNowPlayingIsActive({ state: 'pause', millsMode: true }), true);
	assert.equal(remoteNowPlayingIsActive({ state: 'pause', displayMode: 'mills' }), true);
});

test('watchdog local-display wake patch applies and restarts localdisplay after a generalized blank', () => {
	const watchdog = applyPatchToFixture('watchdog.sh', 'watchdog-local-display-wake.patch');

	assert.match(watchdog, /WEBUI_DISPLAY=.*param='local_display'/);
	assert.match(watchdog, /\(\$WEBUI_DISPLAY = "1" \|\| \$PEPPY_DISPLAY = "1"\)/);
	assert.match(watchdog, /SCN_BLANK_ACTIVE = "1"/);
	assert.match(watchdog, /systemctl restart localdisplay/);
});

test('reference README records GPL attribution and the exact runtime baselines', () => {
	const readme = readFileSync(
		join(repositoryRoot, 'docs', 'references', 'moode', 'README.md'),
		'utf8',
	);

	assert.match(readme, /GPL-3\.0-or-later/);
	assert.match(readme, /f7472ffba6ecc58414abfee29930e826f1b4075c2cd55c3ea0952c325e107412/);
	assert.match(readme, /48bba33b81de2ffd1bf454fb802edc9c1f19470a0fc49ef56990747adbf37a8e/);
	assert.match(readme, /patch --dry-run -p0/);
});
