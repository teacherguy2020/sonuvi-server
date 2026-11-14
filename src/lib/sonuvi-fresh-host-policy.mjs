import fs from 'node:fs/promises';
import path from 'node:path';

// No interactive privilege escalation: only the two fixed application units,
// and only restart. Caller identity and verb are supplied by systemd/Polkit.
export const RESTART_RULE = `polkit.addRule(function(action, subject) {
  if (subject.user === "sonuvi" && action.id === "org.freedesktop.systemd1.manage-units" &&
      action.lookup("verb") === "restart" &&
      ["sonuvi-api.service", "sonuvi-web.service"].indexOf(action.lookup("unit")) !== -1) {
    return polkit.Result.YES;
  }
});
`;

export async function provisionFreshHostPolicy({etcRoot='/etc'}={}) {
  if (!path.isAbsolute(etcRoot)) throw new Error('host_policy_root_invalid');
  const directory=path.join(etcRoot,'polkit-1','rules.d');
  await fs.mkdir(directory,{recursive:true,mode:0o755});
  // Refuse symlinked parent paths as well as a symlinked destination.
  if(await fs.realpath(directory)!==path.join(await fs.realpath(etcRoot),'polkit-1','rules.d')) throw new Error('host_policy_path_unsafe');
  const target=path.join(directory,'50-sonuvi-restart.rules');
  try {
    const stat=await fs.lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o022)) throw new Error('host_policy_file_unsafe');
    if(await fs.readFile(target,'utf8')!==RESTART_RULE) throw new Error('host_policy_conflict');
  } catch(error) {
    if(error.code!=='ENOENT') throw error;
    await fs.writeFile(target,RESTART_RULE,{flag:'wx',mode:0o644});
    await fs.chmod(target,0o644);
  }
  return {target};
}
