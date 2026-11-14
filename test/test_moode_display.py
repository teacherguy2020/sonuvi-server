import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sqlite3
import json
root=Path(__file__).resolve().parents[1]/'ops/moode-overrides/sonuvi-display'
def module(name):
 spec=importlib.util.spec_from_file_location(name,root/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
a=module('apply');d=module('dispatcher')
class DisplayTests(unittest.TestCase):
 def test_exact_commands(self):
  for mode in d.MODES:self.assertEqual(d.command_mode('sonuvi-display-v1 '+mode),mode)
  for command in ['', 'sh', 'sonuvi-display-v1 player; id', 'sonuvi-display-v1 player\n', 'sonuvi-display-v1 player extra']:
   with self.assertRaises(ValueError):d.command_mode(command)
 def test_origin_and_modes(self):
  for mode in a.MODES:
   url=a.target_url('https://sonuvi.local',mode);self.assertTrue(url.startswith('https://sonuvi.local/'));self.assertIn('/kiosk.html' if mode=='kiosk' else 'mode='+mode,url)
  for origin in ['http://x','https://x/evil','https://x;id','https://user@x','https://x/?x=1']:
   with self.assertRaises(ValueError):a.target_url(origin,'player')
 def test_exactly_one_target_preserves_other_startup(self):
  source='#!/bin/bash\nxset s 10\nchromium --app="https://old/" --kiosk\n'
  new=a.updated_startup(source,'https://sonuvi.local/kiosk.html');self.assertIn('xset s 10',new);self.assertIn('--kiosk',new);self.assertEqual(new.count('--app='),1)
  for text in ['chromium --kiosk',source+source]:
   with self.assertRaises(ValueError):a.updated_startup(text,'https://sonuvi.local/kiosk.html')
 def test_process_readback_exact_url(self):
  with tempfile.TemporaryDirectory() as tmp:
   proc=Path(tmp);(proc/'100').mkdir();(proc/'100/cmdline').write_bytes(b'/usr/lib/chromium/chromium\0--app=https://sonuvi.local/kiosk.html\0');self.assertTrue(a.browser_matches('https://sonuvi.local/kiosk.html',proc));self.assertFalse(a.browser_matches('https://sonuvi.local/kiosk.html?extra=1',proc))
 def test_apply_persistence_and_failed_readback_rollback(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);startup=root/'xinitrc';original='chromium --app="https://old.local/" --kiosk\n';startup.write_text(original)
   config=root/'config.json';config.write_text(json.dumps({'origin':'https://sonuvi.local'}));dbfile=root/'db.sqlite';db=sqlite3.connect(dbfile);db.execute('create table cfg_system (param text primary key,value text)');db.executemany('insert into cfg_system values (?,?)',[('local_display','1'),('peppy_display','0'),('local_display_url','https://old.local/')]);db.commit();db.close()
   real_connect=sqlite3.connect
   def mapped(value):return {'/etc/sonuvi-display.json':config,'/home/moode/.xinitrc':startup}[value]
   with patch.object(a,'Path',side_effect=mapped),patch.object(a.sqlite3,'connect',side_effect=lambda *args,**kwargs:real_connect(dbfile)),patch.object(a,'write_atomic',side_effect=lambda p,data:p.write_text(data)),patch.object(a.subprocess,'run') as run,patch.object(a.time,'sleep'):
    with patch.object(a,'browser_matches',return_value=False):
     with self.assertRaises(RuntimeError):a.apply('player')
    self.assertEqual(startup.read_text(),original);db=real_connect(dbfile);self.assertEqual(db.execute("select value from cfg_system where param='local_display_url'").fetchone()[0],'https://old.local/');db.close();self.assertEqual(run.call_count,2)
    with patch.object(a,'browser_matches',return_value=True):self.assertTrue(a.apply('kiosk')['verified'])
    self.assertIn('https://sonuvi.local/kiosk.html',startup.read_text());db=real_connect(dbfile);self.assertEqual(db.execute("select value from cfg_system where param='local_display_url'").fetchone()[0],'https://sonuvi.local/kiosk.html');db.close()
if __name__=='__main__':unittest.main()
