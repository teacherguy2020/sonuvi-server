#!/usr/bin/python3
"""Dedicated SSH forced command. No arguments/URLs from callers reach a shell."""
import os
import sys
MODES = ('player', 'peppy', 'visualizer', 'kiosk')
def command_mode(command):
    for mode in MODES:
        if command == 'sonuvi-display-v1 ' + mode:
            return mode
    raise ValueError('Display operation denied')
if __name__ == '__main__':
    try:
        mode = command_mode(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    except ValueError:
        sys.exit(126)
    os.execv('/usr/bin/sudo', ['sudo', '-n', '/usr/local/libexec/sonuvi-display-apply', mode])
