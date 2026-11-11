import { requireAdministratorAuthorization } from '../lib/sonuvi-admin-authority.mjs';
import { projectNativeDlnaStatus, configurationWorkspace, exportPortableConfiguration, previewConfigurationImport, configError } from '../lib/native-configuration-workspace.mjs';

export function registerConfigurationWorkspaceRoutes(app, { administratorAuthority, readConfig, writeConfig, runtimeProjectionOptions = {}, getBrowseIndexStatus, getLibraryHealthStatus, getDlnaStatus, refreshIndex, scanLibrary, checkEnvironment, getWebAccess = () => ({}) } = {}) {
 let mutation = Promise.resolve();
 let job = { running:false, operation:null, state:'idle' };
 const authorize = async req => {
  if(!administratorAuthority||!readConfig)throw configError('administrator_api_unavailable',404);
  const token=String(req.headers.authorization||'').match(/^Bearer ([^\s]+)$/i)?.[1]||'';
  await requireAdministratorAuthorization({authority:administratorAuthority,bearerToken:token}).catch(()=>{throw configError('administrator_authorization_required',401);});
  const identity=await administratorAuthority.administratorRecord();
  return identity.targetIdentity;
 };
 const state = async targetIdentity => ({ok:true,contract:'sonuvi.admin.workspace.v1',targetIdentity,...configurationWorkspace(await readConfig(),runtimeProjectionOptions),job,webAccess:getWebAccess(),operations:{refreshIndex:typeof refreshIndex==='function',scanLibrary:typeof scanLibrary==='function',checkEnvironment:typeof checkEnvironment==='function',restart:false},...(getDlnaStatus?{dlna:projectNativeDlnaStatus(await getDlnaStatus())}: {})});
 const fail=(res,error)=>res.status(error.status||503).json({ok:false,code:error.code||'administrator_workspace_unavailable'});
 app.get('/v1/admin/configuration/workspace',async(req,res)=>{try{return res.json(await state(await authorize(req)));}catch(e){return fail(res,e);}});
 app.post('/v1/admin/configuration/operation',async(req,res)=>{
  try{
   const targetIdentity=await authorize(req);const body=req.body;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['operation','targetIdentity','document','previewId','revision'].includes(k)))throw configError('configuration_request_invalid');
   if(body.targetIdentity!==targetIdentity)throw configError('configuration_target_mismatch',409);
   if(Buffer.byteLength(JSON.stringify(body))>65536)throw configError('configuration_request_too_large',413);
   if(body.operation==='export')return res.json({ok:true,contract:'sonuvi.admin.transfer.v1',targetIdentity,document:exportPortableConfiguration(await readConfig())});
   if(body.operation==='preview'){
    const {next,...preview}=previewConfigurationImport(await readConfig(),body.document,{...runtimeProjectionOptions,targetIdentity});
    return res.json({ok:true,contract:'sonuvi.admin.preview.v1',targetIdentity,...preview});
   }
   if(body.operation==='import'){
    // Serialize native writes, and recompute the preview against current state.
    const run=mutation.then(async()=>{
     if(typeof writeConfig!=='function')throw configError('administrator_configuration_mutation_unavailable',404);
     const preview=previewConfigurationImport(await readConfig(),body.document,{...runtimeProjectionOptions,targetIdentity});
     if(body.previewId!==preview.previewId||body.revision!==preview.revision)throw configError('configuration_preview_stale',409);
     if(preview.changes.length)await writeConfig(preview.next);
     return {...await state(targetIdentity),changed:preview.changes.length>0,restartRequired:preview.restartRequired};
    });mutation=run.catch(()=>{});return res.json(await run);
   }
   if(body.operation==='check-environment'){
    if(!checkEnvironment)throw configError('configuration_operation_unavailable',404);
    return res.json({ok:true,contract:'sonuvi.admin.diagnostics.v1',targetIdentity,diagnostics:await checkEnvironment()});
   }
   const action=body.operation==='refresh-index'?refreshIndex:body.operation==='scan-library'?scanLibrary:null;
   if(!action)throw configError('configuration_operation_unavailable',404);
   if(job.running)throw configError('configuration_job_running',409);
   job={running:true,operation:body.operation,state:'running',startedAt:new Date().toISOString()};
   Promise.resolve().then(action).then(()=>{job={...job,running:false,state:'succeeded',finishedAt:new Date().toISOString()};},()=>{job={...job,running:false,state:'failed',finishedAt:new Date().toISOString()};});
   return res.status(202).json({ok:true,contract:'sonuvi.admin.job.v1',targetIdentity,job});
  }catch(e){return fail(res,e);}
 });
}
