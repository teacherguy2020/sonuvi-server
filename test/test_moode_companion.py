import importlib.util,pathlib,unittest
root=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('companion',root/'scripts/sonuvi-moode-companion.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class CompanionTests(unittest.TestCase):
 def bundle(self):return dict(contract=m.CONTRACT,origin='https://sonuvi-new.local:8444',sourceAddress='10.0.0.4',moodeAddress='10.0.0.254',displayPublicKey='ssh-ed25519 AAAATEST',peppyToken='a'*43,caPEM='-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----')
 def test_origin_and_material_boundaries(self):
  self.assertEqual(m.validate(self.bundle())['sourceAddress'],'10.0.0.4')
  for value in ['http://host','https://user@host','https://host/x','https://host?q=1','https://host\nInjected','https://host:65536']:
   with self.assertRaises(ValueError):m.origin(value)
  for key,value in [('sourceAddress','10.0.0.4",command="sh'),('displayPublicKey','ssh-rsa AAAA'),('peppyToken','bad')]:
   b=self.bundle();b[key]=value
   with self.assertRaises(ValueError):m.validate(b)
 def test_idempotent_key_enrollment_preserves_unrelated_keys(self):
  old='restrict ssh-ed25519 AAAAOTHER readonly\n'
  added=m.authorized_keys(old,self.bundle());self.assertIn(old,added);self.assertIn('from="10.0.0.4",restrict,command="/usr/local/libexec/sonuvi-display-dispatch"',added)
  self.assertEqual(m.authorized_keys(added,self.bundle()),added)
  b=self.bundle();b['sourceAddress']='10.0.0.5';moved=m.authorized_keys(added,b)
  self.assertNotIn('10.0.0.4',moved);self.assertIn(old,moved)
  with self.assertRaises(ValueError):m.authorized_keys('ssh-ed25519 AAAATEST unrestricted\n',b)
 def test_sender_is_verified_bounded_and_idempotent(self):
  patched=m.patched_meter('requests.put(self.url, json=d)')
  self.assertIn("verify='/etc/ssl/certs/ca-certificates.crt'",patched)
  self.assertIn('timeout=0.5',patched);self.assertEqual(m.patched_meter(patched),patched)
  with self.assertRaises(ValueError):m.patched_meter('unexpected API')
 def test_targets_use_enrolled_origin(self):
  s=(root/'ops/moode-overrides/usr/local/bin/nowplaying-peppy-targets.sh').read_text()
  self.assertNotIn('https://sonuvi.local',s);self.assertIn('/etc/sonuvi-display.json',s)
if __name__=='__main__':unittest.main()
