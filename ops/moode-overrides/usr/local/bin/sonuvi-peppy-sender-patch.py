#!/usr/bin/env python3
"""Reapply after moOde upgrades; requires provisioned root-only token and system CA trust."""
from pathlib import Path
p=Path('/opt/peppymeter/httpinterface.py')
s=p.read_text().replace('requests.put(self.url, json=d)', "requests.put(self.url, json=d, headers={'Authorization': 'Bearer ' + open('/etc/sonuvi-peppy-token').read().strip()}, verify='/etc/ssl/certs/ca-certificates.crt', timeout=0.5)")
p.write_text(s)
p=Path('/usr/local/bin/peppy-spectrum-bridge.py')
s=p.read_text().replace("headers={'Content-Type': 'application/json'}", "headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + open('/etc/sonuvi-peppy-token').read().strip()}")
p.write_text(s)
