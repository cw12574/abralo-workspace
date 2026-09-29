import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(!process.argv.includes('--apply')) throw Error('Run with --apply only to repair the installed preview after the feedback update.');
const base='http://127.0.0.1:4317/api';
const token=readFileSync(join(process.env.LOCALAPPDATA,'AgentWorkspace','bootstrap.key'),'utf8').trim();
const login=await fetch(base+'/bootstrap',{method:'POST',headers:{'content-type':'application/json','x-workspace-request':'1'},body:JSON.stringify({token})});
if(!login.ok)throw Error('Local launcher authentication failed');
const cookie=login.headers.get('set-cookie').split(';')[0];
async function api(path,body){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json','x-workspace-request':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
const report={at:new Date().toISOString(),connections:[],teams:[]};
for(const c of await api('/connections'))if(c.state==='ready'&&['stripe','railway'].includes(c.service)){
 try{const r=await api('/connections/'+c.id+'/connect',{});report.connections.push({service:c.service,state:r.state||'sign-in required'});}
 catch(e){report.connections.push({service:c.service,error:String(e)});}
}
for(const p of await api('/proposals'))if(p.approved&&!p.handoffMessageId){
 const r=await api('/proposals/'+p.id+'/brief',{});
 report.teams.push({channelId:r.channelId,handoffQueued:!!r.handoffMessageId});
}
writeFileSync('evidence/feedback-installed.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
