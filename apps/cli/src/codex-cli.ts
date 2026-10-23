import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformAdapter, detectCodexHome } from './platform-adapters.js';

export type CodexLauncher = { kind:'node'|'exe'; executable:string; prefixArgs:string[]; version:string };
const credentialEnvNames=['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_API_BASE','CODEX_BASE_URL','ANTHROPIC_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY'];
const winEnvNames=['PATH','SYSTEMROOT','WINDIR','HOMEDRIVE','HOMEPATH','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','COMSPEC','PATHEXT','CODEX_HOME','TERM'];

function candidatePaths(){
 const found:string[]=[];
 if(process.platform==='win32'){
  const where=spawnSync('where.exe',['codex'],{encoding:'utf8',windowsHide:true,timeout:3000});
  if(where.status===0)found.push(...where.stdout.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
  const roots=[process.env.APPDATA,process.env.LOCALAPPDATA,process.env.USERPROFILE].filter((x):x is string=>Boolean(x));
  for(const root of roots){
   found.push(path.join(root,'.codex','bin','codex.exe'),path.join(root,'.local','bin','codex.exe'),path.join(root,'scoop','apps','codex','current','codex.exe'));
  }
 }else if(process.platform==='linux'){
  const which=spawnSync('which',['codex'],{encoding:'utf8',timeout:3000});
  if(which.status===0)found.push(...which.stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean));
  found.push(path.join(os.homedir(),'.local','bin','codex'),'/usr/local/bin/codex','/usr/bin/codex');
 }
 return [...new Set(found)];
}
function launcherFor(file:string,platform=process.platform):Omit<CodexLauncher,'version'>|null{
 const ext=path.extname(file).toLowerCase();
 if(ext==='.exe')return{kind:'exe',executable:file,prefixArgs:[]};
 if(ext==='.js')return{kind:'node',executable:process.execPath,prefixArgs:[file]};
 if(platform==='linux'&&ext==='')return{kind:'exe',executable:file,prefixArgs:[]};
 if(ext==='.cmd'||ext==='.ps1'||ext===''){
  const dir=path.dirname(file);
  const jsCandidates=[path.join(dir,'node_modules','@openai','codex','bin','codex.js'),path.join(dir,'..','node_modules','@openai','codex','bin','codex.js')];
  for(const candidate of jsCandidates)if(fs.existsSync(candidate))return{kind:'node',executable:process.execPath,prefixArgs:[candidate]};
 }
 return null;
}
function runCli(base:Omit<CodexLauncher,'version'>,args:string[],timeout=8000){
 const result=spawnSync(base.executable,[...base.prefixArgs,...args],{encoding:'utf8',windowsHide:true,timeout,env:safeCodexEnv(),maxBuffer:1024*1024});
 return{status:result.status,stdout:result.stdout??'',stderr:result.stderr??'',error:result.error};
}
export function safeCodexEnv(source:NodeJS.ProcessEnv=process.env,platform=process.platform):NodeJS.ProcessEnv{
 const env:NodeJS.ProcessEnv={};
 const allowed=platform==='win32'?winEnvNames:['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','CODEX_HOME','XDG_CONFIG_HOME','TERM'];
 for(const name of allowed)if(source[name])env[name]=source[name];
 env.CI='true';env.PLAYWRIGHT_WORKERS='1';env.MAX_WORKERS='1';env.COREPACK_ENABLE_NETWORK='0';env.npm_config_offline='true';
 return env;
}
export function paidCredentialVariablesPresent(env:NodeJS.ProcessEnv=process.env){return credentialEnvNames.filter(name=>Boolean(env[name]));}
export function discoverCodexCli():CodexLauncher|null{
 for(const file of candidatePaths()){
  const base=launcherFor(file);if(!base)continue;
  const result=runCli(base,['--version']);
  const version=result.stdout.trim().split(/\r?\n/)[0];
  if(result.status===0&&/^codex-cli\s+\S+/i.test(version))return{...base,version};
 }
 return null;
}
export function codexLoginStatus(cli=discoverCodexCli()):{status:'ChatGPT'|'API Key'|'Not Configured'|'Unknown';message:string;exitCode:number|null}{
 if(!cli)return{status:'Not Configured',message:'Codex CLI executable was not found.',exitCode:null};
 if(paidCredentialVariablesPresent().length)return{status:'API Key',message:'Paid API credential environment variables are present; execution is blocked.',exitCode:null};
 const result=runCli(cli,['login','status']);
 const output=`${result.stdout}\n${result.stderr}`.replace(/\s+/g,' ').trim();
 if(result.status===0&&/logged in using chatgpt/i.test(output))return{status:'ChatGPT',message:'Codex reports ChatGPT account authentication.',exitCode:result.status};
 if(/api key/i.test(output))return{status:'API Key',message:'Codex reports API-key authentication; execution is blocked.',exitCode:result.status??1};
 return{status:result.status===0?'Unknown':'Not Configured',message:'ChatGPT authentication could not be verified from the CLI status command.',exitCode:result.status??1};
}
export function probeMxcSandbox(cli=discoverCodexCli()):{status:'Ready'|'Not Configured';message:string;exitCode:number|null}{
 if(!cli||process.platform!=='win32')return{status:'Not Configured',message:'The native Windows MXC sandbox is unavailable on this platform.',exitCode:null};
 const result=runCli(cli,['-c','windows.sandbox=mxc','sandbox','--include-managed-config','--permission-profile',':workspace','--cd',process.cwd(),'--','cmd.exe','/d','/c','echo WOORI_MXC_OK'],12000);
 if(result.status===0&&result.stdout.includes('WOORI_MXC_OK'))return{status:'Ready',message:'MXC workspace sandbox probe succeeded.',exitCode:0};
 return{status:'Not Configured',message:'MXC workspace sandbox probe failed; workspace-write execution is blocked.',exitCode:result.status??1};
}

export function parseAllowedPaths(input:string):string[]{
 const patterns=[...new Set(input.split(',').map(x=>x.trim().replace(/\\/g,'/')).filter(Boolean))];
 if(patterns.length===0||patterns.length>12)throw new Error('Supply 1 to 12 explicit allowed path patterns, such as src/**,tests/**.');
 for(const pattern of patterns){
  if(pattern.startsWith('/')||/^[A-Za-z]:/.test(pattern)||pattern.split('/').some(part=>part==='..'||part===''))throw new Error(`Unsafe allowed path pattern: ${pattern}`);
  if(!/^[A-Za-z0-9._/*-]+$/.test(pattern))throw new Error(`Unsupported allowed path pattern: ${pattern}`);
  if(pattern==='*'||pattern==='**'||pattern==='**/*'||/(^|\/)(\.github|\.git|\.env[^/]*|secrets?|deploy|deployment|infra|docker|node_modules)(\/|$)/i.test(pattern))throw new Error(`Protected or overly broad paths cannot be included in an automated write allowlist: ${pattern}`);
 }
 return patterns;
}
export function pathMatchesAllowlist(file:string,patterns:string[]){
 const normalized=file.replace(/\\/g,'/').replace(/^\.\//,'');
 if(/(^|\/)(\.git|\.env[^/]*|secrets?|credentials?[^/]*|node_modules|deploy|deployment|infra|docker)(\/|$)/i.test(normalized)||/\.(?:pem|key|p12|pfx)$/i.test(normalized))return false;
 return patterns.some(pattern=>{
  let source='^';
  for(let i=0;i<pattern.length;i++){
   const char=pattern[i]!;
   if(char==='*'&&pattern[i+1]==='*'){source+='.*';i++;continue;}
   if(char==='*'){source+='[^/]*';continue;}
   source+=char.replace(/[|\\{}()[\]^$+?.]/g,'\\$&');
  }
  const regex=new RegExp(`${source}$`);
  return regex.test(normalized);
 });
}
export function secretFindings(file:string,text:string){
 const findings:string[]=[];
 if(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text))findings.push(`${file}: private key marker`);
 if(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text))findings.push(`${file}: credential-like token`);
 if(/(?:OPENAI_API_KEY|CODEX_API_KEY)\s*[=:]\s*[^\s"']{12,}/i.test(text))findings.push(`${file}: AI API credential assignment`);
 return findings;
}
export function codexExecArgs(worktree:string,mode:'read-only'|'workspace-write',prompt:string){
 const args=createPlatformAdapter().codexExecutor.buildExecArgs(worktree,mode,prompt);
 if(!args)throw new Error(`Codex execution arguments are not configured for ${process.platform}.`);
 return args;
}
export function codexSandboxArgs(worktree:string,command:string,args:string[]){
 const safeArgs=createPlatformAdapter().codexExecutor.buildSandboxCommandArgs(worktree,command,args);
 if(!safeArgs)throw new Error(`Sandbox command arguments are not configured for ${process.platform}.`);
 return safeArgs;
}
export function redactCodexOutput(input:string){
 return input
  .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,'$1[REDACTED]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,'[REDACTED_TOKEN]')
  .replace(/((?:OPENAI_API_KEY|CODEX_API_KEY|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,'$1[REDACTED]');
}
export function isWithinRoot(root:string,target:string){
 const relative=path.relative(path.resolve(root),path.resolve(target));
 return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);
}
export function platformIsWindows(){return process.platform==='win32';}
export function codexAuthFilePresent(){const home=detectCodexHome();return fs.existsSync(path.join(home,'auth.json'));}
export function codexPlatformReadiness(){
 const adapter=createPlatformAdapter();
 return{platform:adapter.id,credentialStore:{id:adapter.credentialStore.id,status:adapter.credentialStore.status,reason:adapter.credentialStore.reason},sandbox:{id:adapter.sandbox.id,status:adapter.sandbox.status,reason:adapter.sandbox.reason},executor:{status:adapter.codexExecutor.status,reason:adapter.codexExecutor.reason},worker:adapter.workerHealth.snapshot()};
}
