import {createSign} from 'node:crypto';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {initDb,readApiCache,reserveApiRequest,saveAgentData,saveAnalyticsDaily,serviceFor,writeApiCache,config} from './core.js';

type Kind='gsc'|'ga4'|'adsense';
const tokens=new Map<string,{value:string;expiresAt:number}>();
const scopes:Record<Kind,string>={gsc:'https://www.googleapis.com/auth/webmasters.readonly',ga4:'https://www.googleapis.com/auth/analytics.readonly',adsense:'https://www.googleapis.com/auth/adsense.readonly'};
const enabledEnv:Record<Kind,string>={gsc:'GSC_API_ENABLED',ga4:'GA4_API_ENABLED',adsense:'ADSENSE_API_ENABLED'};
const idEnv:Record<Kind,string>={gsc:'GSC_SITE_URL',ga4:'GA4_PROPERTY_ID',adsense:'ADSENSE_ACCOUNT_ID'};
const agentFor=(kind:Kind)=>kind==='adsense'?'ads':'analytics';
const iso=(date:Date)=>date.toISOString().slice(0,10);
const asDate=(value:string)=>/^\d{8}$/.test(value)?`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`:value;

async function getToken(scope:string,fetcher:typeof fetch){
 const cached=tokens.get(scope);if(cached&&cached.expiresAt>Date.now()+60000)return cached.value;
 const localOAuthFile=process.env.GOOGLE_LOCAL_OAUTH_FILE??'data/google-oauth.dpapi';
 if(process.platform==='win32'&&fs.existsSync(localOAuthFile)){
  try{const {unprotectForCurrentWindowsUser}=await import('./local-dpapi.js');const encrypted=fs.readFileSync(localOAuthFile,'utf8');const stored=JSON.parse(unprotectForCurrentWindowsUser(encrypted)) as {refreshToken:string;scopes:string[]};if(!stored.scopes.includes(scope))throw new Error('requested read-only provider scope is not in the local grant');const clientId=process.env.GOOGLE_OAUTH_CLIENT_ID,clientSecret=process.env.GOOGLE_OAUTH_CLIENT_SECRET;if(!clientId||!clientSecret)throw new Error('OAuth Desktop client id/secret are not configured');const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:stored.refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(`Google OAuth refresh returned HTTP ${response.status}`);const value=await response.json() as {access_token:string;expires_in:number};tokens.set(scope,{value:value.access_token,expiresAt:Date.now()+value.expires_in*1000});return value.access_token;}catch(error){throw new Error(`Local OAuth credentials could not be used: ${error instanceof Error?error.message:String(error)}`);}
 }
 let email=process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,key=process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g,'\n');
 if((!email||!key)&&process.env.GOOGLE_CREDENTIALS_DPAPI_FILE&&process.platform==='win32'){
  try{const encrypted=fs.readFileSync(process.env.GOOGLE_CREDENTIALS_DPAPI_FILE,'utf8');const script="$s=[Console]::In.ReadToEnd();$sec=ConvertTo-SecureString $s;$c=New-Object System.Management.Automation.PSCredential('local',$sec);$c.GetNetworkCredential().Password";const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:encrypted,encoding:'utf8',windowsHide:true});const credentials=JSON.parse(raw) as {client_email?:string;private_key?:string};email=credentials.client_email;key=credentials.private_key?.replace(/\\n/g,'\n');}catch{throw new Error('Not Configured: encrypted local Google credentials could not be read with this Windows user profile.');}
 }
 if(!email||!key)throw new Error('Not Configured: OAuth service-account credentials are missing.');
 const now=Math.floor(Date.now()/1000),encode=(value:string)=>Buffer.from(value).toString('base64url');
 const header=encode(JSON.stringify({alg:'RS256',typ:'JWT'})),claim=encode(JSON.stringify({iss:email,scope,aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
 const signer=createSign('RSA-SHA256');signer.update(`${header}.${claim}`);const assertion=`${header}.${claim}.${signer.sign(key,'base64url')}`;
 const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(`Google OAuth returned HTTP ${response.status}.`);
 const value=await response.json() as {access_token:string;expires_in:number};tokens.set(scope,{value:value.access_token,expiresAt:Date.now()+value.expires_in*1000});return value.access_token;
}

export async function googleReport(kind:Kind,runId:string,fetcher:typeof fetch=fetch){
 const env=process.env,id=env[idEnv[kind]],agent=agentFor(kind);
 const save=(status:string,source:string,payload:unknown)=>saveAgentData(runId,agent,status,source,payload);
 const notConfigured=(reason:string)=>{const payload={reason,metrics:null,requestsMade:0};save('Not Configured',`${kind} configuration`,payload);return{status:'Not Configured',payload}};
 if(env[enabledEnv[kind]]!=='true')return notConfigured('Explicit API opt-in is disabled; no provider request was made.');
 if((kind==='ga4'||kind==='adsense')&&env.GOOGLE_CLOUD_BILLING_DISABLED!=='true')return notConfigured('Google Cloud billing must remain disabled and be explicitly confirmed before this provider can run. No billing changes are made by this application.');
 if(kind==='ga4'&&env.GA4_ZERO_COST_CONFIRMED!=='true')return notConfigured('GA4 API is fail-closed until the user opts in to quota-limited read-only requests. No provider request was made.');
 if(kind==='adsense'&&env.ADSENSE_ZERO_COST_CONFIRMED!=='true')return notConfigured('AdSense API is fail-closed until the user confirms the API project has no billable services enabled. No provider request was made.');
 const hasEnvCredentials=Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL&&env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),hasEncryptedCredentials=Boolean(env.GOOGLE_CREDENTIALS_DPAPI_FILE&&process.platform==='win32'&&fs.existsSync(env.GOOGLE_CREDENTIALS_DPAPI_FILE)),oauthFile=env.GOOGLE_LOCAL_OAUTH_FILE??'data/google-oauth.dpapi',hasLocalOAuth=process.platform==='win32'&&fs.existsSync(oauthFile);
 if(!id||(!hasEnvCredentials&&!hasEncryptedCredentials&&!hasLocalOAuth))return notConfigured('Google OAuth credentials and provider property/account identifier are required.');

 const end=env.ANALYTICS_END_DATE??iso(new Date(Date.now()-86400000));
 const db=initDb();const latest=db.prepare('SELECT MAX(metric_date) date FROM analytics_daily WHERE provider=?').get(kind) as {date:string|null};db.close();
 const startDate=latest.date?new Date(`${latest.date}T00:00:00Z`):new Date(Date.now()-7*86400000);if(latest.date)startDate.setUTCDate(startDate.getUTCDate()-3);
 const start=env.ANALYTICS_START_DATE??iso(startDate),cacheKey=`${kind}:${id}:${start}:${end}:phase4`;
 const cached=readApiCache(cacheKey);if(cached){save('Completed',`Google ${kind} cached read-only result`,cached);return{status:'Completed',payload:cached,cached:true};}

 const dailyCap=kind==='adsense'?2:8,requestCap=4,pageSize=kind==='gsc'?250:100;
 try{
  const token=await getToken(scopes[kind],fetcher),dataRows:unknown[]=[],daily:Array<{date:string;service:string;dimensionKey:string;metrics:unknown}>=[],quota:unknown[]=[];let requests=0;
  const request=async(endpoint:string,body?:Record<string,unknown>)=>{
   if(requests>=requestCap||!reserveApiRequest(kind,dailyCap))throw new Error('FREE_QUOTA_LIMIT: request budget reached; stopped without retry.');
   requests++;
   const response=await fetcher(endpoint,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
   if(response.status===429)throw new Error('FREE_QUOTA_LIMIT: provider returned HTTP 429; no retry was attempted.');
   if(!response.ok)throw new Error(`${kind} API returned HTTP ${response.status}.`);
   return await response.json() as Record<string,any>;
  };
  if(kind==='gsc'){
   const endpoint=`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(id)}/searchAnalytics/query`;
   const groups=[['date','page'],['date','query'],['date','country']];
   for(let group=0;group<groups.length;group++){
    const dimensions=groups[group]!;let startRow=0;const pageLimit=group===0?2:1;
    for(let page=0;page<pageLimit;page++){
     const result=await request(endpoint,{startDate:start,endDate:end,dimensions,rowLimit:pageSize,startRow}),rows=(result.rows??[]) as Array<{keys:string[];clicks:number;impressions:number;ctr:number;position:number}>;dataRows.push(...rows);
     for(const row of rows){const [date,...keys]=row.keys,pageUrl=keys.find(value=>value.startsWith('http'));daily.push({date:asDate(date??''),service:pageUrl?serviceFor(pageUrl).id:'all',dimensionKey:`${dimensions.slice(1).join('|')}:${keys.join('|')}`,metrics:{clicks:row.clicks,impressions:row.impressions,ctr:row.ctr,position:row.position}});}
     startRow+=rows.length;if(rows.length<pageSize)break;
    }
   }
  }else if(kind==='ga4'){
   const endpoint=`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(id)}:runReport`;let offset=0;
   for(let page=0;page<2;page++){
    const result=await request(endpoint,{dateRanges:[{startDate:start,endDate:end}],dimensions:[{name:'date'},{name:'country'},{name:'pagePath'}],metrics:[{name:'sessions'},{name:'activeUsers'},{name:'screenPageViews'}],limit:pageSize,offset:String(offset),returnPropertyQuota:true});
    const rows=(result.rows??[]) as Array<{dimensionValues:Array<{value:string}>;metricValues:Array<{value:string}>}>;dataRows.push(...rows);if(result.propertyQuota)quota.push(result.propertyQuota);
    for(const row of rows){const [date,country,pagePath]=row.dimensionValues.map(value=>value.value);const service=pagePath?serviceFor(new URL(pagePath,config.baseUrl).href).id:'all';daily.push({date:asDate(date??''),service,dimensionKey:`${country??''}|${pagePath??''}`,metrics:{sessions:Number(row.metricValues[0]?.value??0),activeUsers:Number(row.metricValues[1]?.value??0),screenPageViews:Number(row.metricValues[2]?.value??0)}});}
    offset+=rows.length;const remaining=(result.propertyQuota as any)?.tokensPerProjectPerHour?.remaining;if(typeof remaining==='number'&&remaining<100)throw new Error('FREE_QUOTA_LIMIT: GA4 hourly quota is low; stopped without retry.');if(offset>=Number(result.rowCount??offset))break;
   }
  }else{
   const from=new Date(`${start}T00:00:00Z`),to=new Date(`${end}T00:00:00Z`),account=id.startsWith('accounts/')?id:`accounts/${id}`;
   const params=new URLSearchParams({dateRange:'CUSTOM','startDate.year':String(from.getUTCFullYear()),'startDate.month':String(from.getUTCMonth()+1),'startDate.day':String(from.getUTCDate()),'endDate.year':String(to.getUTCFullYear()),'endDate.month':String(to.getUTCMonth()+1),'endDate.day':String(to.getUTCDate()),metrics:'ESTIMATED_EARNINGS,PAGE_VIEWS_RPM',dimensions:'DATE,AD_UNIT_NAME',limit:String(pageSize)});
   const result=await request(`https://adsense.googleapis.com/v2/${account}/reports:generate?${params}`);const rows=(result.rows??[]) as Array<{cells:Array<{value:string}>}>;dataRows.push(...rows);
   for(const row of rows)daily.push({date:asDate(row.cells?.[0]?.value??''),service:'all',dimensionKey:row.cells?.[1]?.value??'',metrics:{estimatedEarnings:row.cells?.[2]?.value??null,pageViewsRpm:row.cells?.[3]?.value??null}});
  }
  saveAnalyticsDaily(kind,daily);const payload={source:`Google ${kind} read-only API`,retrievedAt:new Date().toISOString(),period:{start,end},rowCount:dataRows.length,dailyRows:daily.length,requestCount:requests,quota,data:dataRows};
  writeApiCache(cacheKey,kind,id,start,end,6*60*60*1000,payload);save('Completed',`Google ${kind} official API`,payload);return{status:'Completed',payload,cached:false};
 }catch(error){const reason=error instanceof Error?error.message:String(error),quota=reason.includes('FREE_QUOTA_LIMIT'),payload={reason,metrics:null,requestsMade:true};save(quota?'Skipped':'Failed',`Google ${kind} official API`,payload);return{status:quota?'Skipped':'Failed',payload};}
}
