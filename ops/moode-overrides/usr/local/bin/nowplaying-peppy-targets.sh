#!/usr/bin/env bash
set -eu

python3 - <<'PY'
from pathlib import Path
import re

VUMETER_TARGET = 'https://sonuvi.local/__peppy/vumeter'
SPECTRUM_TARGET = 'https://sonuvi.local/__peppy/spectrum'


def update_section(text, section_name, updates):
    lines = text.splitlines(keepends=True)
    wanted = f'[{section_name.lower()}]'
    start = None
    end = len(lines)

    for index, line in enumerate(lines):
        stripped = line.strip().lower()
        if stripped == wanted:
            start = index
            break

    if start is None:
        if text and not text.endswith('\n'):
            text += '\n'
        text += f'\n[{section_name}]\n'
        text += ''.join(f'{key} = {value}\n' for key, value in updates.items())
        return text

    for index in range(start + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            end = index
            break

    body = lines[start + 1:end]
    for key, value in updates.items():
        pattern = re.compile(rf'^\s*{re.escape(key)}\s*=.*$', re.IGNORECASE)
        replacement = f'{key} = {value}\n'
        for index, line in enumerate(body):
            if pattern.match(line.rstrip('\n')):
                body[index] = replacement
                break
        else:
            body.append(replacement)

    return ''.join(lines[:start + 1] + body + lines[end:])


def remove_key(text, section_name, key):
    lines = text.splitlines(keepends=True)
    wanted = f'[{section_name.lower()}]'
    start = None
    end = len(lines)

    for index, line in enumerate(lines):
        if line.strip().lower() == wanted:
            start = index
            break
    if start is None:
        return text

    for index in range(start + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            end = index
            break

    pattern = re.compile(rf'^\s*{re.escape(key)}\s*=.*$', re.IGNORECASE)
    body = [line for line in lines[start + 1:end] if not pattern.match(line.rstrip('\n'))]
    return ''.join(lines[:start + 1] + body + lines[end:])


def update_file(path_text, sections):
    path = Path(path_text)
    if not path.exists():
        raise SystemExit(f'missing {path}')

    backup = path.with_name(path.name + '.bak.nowplaying-peppy')
    if not backup.exists():
        backup.write_bytes(path.read_bytes())

    text = path.read_text()
    if path_text == '/etc/peppymeter/config.txt':
        text = remove_key(text, 'current', 'pipe.name')
    for section, updates in sections:
        text = update_section(text, section, updates)
    path.write_text(text)
    print(f'updated {path}')


update_file('/etc/peppymeter/config.txt', [
    ('current', {
        'output.http': 'True',
    }),
    ('data.source', {
        'pipe.name': '/tmp/peppymeter',
    }),
    ('http.interface', {
        'target.url': VUMETER_TARGET,
        'update.period': '0.033',
    }),
])

update_file('/etc/peppyspectrum/config.txt', [
    ('current', {
        'pipe.name': '/tmp/peppyspectrum',
    }),
    ('http.interface', {
        'target.url': SPECTRUM_TARGET,
        'update.period': '0.05',
    }),
])
PY
