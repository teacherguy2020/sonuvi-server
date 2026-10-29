<?php
// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal test fixture derived from the moOde worker.php display loop captured 2026-10-29.

	// Displays
	if ($_SESSION['local_display'] == '1' || $_SESSION['peppy_display'] == '1') {
		//debugLog('** chkAttachedDisplayOnOff');
		chkAttachedDisplayOnOff();
	}
	if ($_SESSION['peppy_display'] == '1' && $_SESSION['scn_blank'] != 'off') {
		//debugLog('** chkPeppyScnBlank');
		chkPeppyScnBlank();
	}

// Peppy screen blank
// - Timeout is set
// - Peppy is on
// - No renderer is active
// - MPD is not playing
function chkPeppyScnBlank() {
	if (false === ($sock = openMpdSock('localhost', 6600))) {
		workerLog('worker: CRITICAL ERROR: chkPeppyScnBlank(): Connection to MPD failed');
	} else {
		$mpdState = getMpdStatus($sock)['state'];
		closeMpdSock($sock);
		if ($mpdState == 'play') {
			$GLOBALS['scn_blank_timeout'] = $_SESSION['scn_blank']; // Reset timeout
		}

		if ($GLOBALS['scn_blank_timeout'] != 'off'
			&& chkRendererActive() === false
			&& $_SESSION['rxactive'] == '0'
			&& $mpdState != 'play') {
			// This SQL value is set to '1' here and '0' in watchdog.sh wake_display()
		}
	}
}
