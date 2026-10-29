#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Minimal test fixture derived from the moOde watchdog.sh wake_display() captured 2026-10-29.

wake_display () {
	WAKE_DISPLAY=$(sqlite3 $SQLDB "SELECT value FROM cfg_system WHERE param='wake_display'")
	PEPPY_DISPLAY=$(sqlite3 $SQLDB "SELECT value FROM cfg_system WHERE param='peppy_display'")
	SCN_BLANK_ACTIVE=$(sqlite3 $SQLDB "SELECT value from cfg_system WHERE param='peppy_scn_blank_active'")
	CEC_CONTROL=$(moodeutl -d -gv hdmi_cec)
	CEC_VERSION=$(moodeutl -d -gv hdmi_cec_ver)
	if [[ $WAKE_DISPLAY = "1" ]]; then
		debug_log "wake display: on"
		export DISPLAY=:0
		if [[ $PEPPY_DISPLAY = "1" && $SCN_BLANK_ACTIVE = "1" ]]; then
			debug_log "wake display: set peppy_scn_blank_active 0, restart localdisplay"
			$(sqlite3 $SQLDB "UPDATE cfg_system SET value='0' WHERE param='peppy_scn_blank_active'")
			systemctl restart localdisplay
		else
			debug_log "wake display: send xset s reset"
		fi
	fi
}
