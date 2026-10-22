import http from 'node:http';
import fs from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {protectForCurrentWindowsUser} from './local-dpapi.js';
import './core.js';

async function main(){
 if(process.platform!=='win32')throw new Error('The interactive local OAuth setup is supported on Windows only.');
 const clientId=process.env.GOOGLE_OAUTH_CLIENT_ID,clientSecret=process.env.GOOGLE_OAUTH_CLIENT_SECRET;
 if(!clientId||!clientSecret)throw new Error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from a Google Cloud Desktop OAuth client in your local .env first.');
 const selected=(process.argv.find(x=>x.startsWith('--providers='))?.slice('--providers='.length)??'gsc,ga4').split(',').map(x=>x.trim()).filter(Boolean);
 const scopeByProvider:Record<string,string>={gsc:'https://www.googleapis.com/auth/webmasters.readonly',ga4:'https://www.googleapis.com/auth/analytics.readonly',adsense:'https://www.googleapis.com/auth/adsense.readonly'};
 if(!selected.length||selected.some(x=>!scopeByProvider[x]))throw new Error('Use --providers=gsc,ga4 and add adsense only if its API is confirmed safe to use.');
 if(selected.includes('adsense')&&process.env.ADSENSE_ZERO_COST_CONFIRMED!=='true')throw new Error('AdSense consent is blocked until ADSENSE_ZERO_COST_CONFIRMED=true is set after the user verifies the Google Cloud billing configuration.');
 if(selected.includes('ga4')&&process.env.GA4_ZERO_COST_CONFIRMED!=='true')throw new Error('GA4 consent is blocked until GA4_ZERO_COST_CONFIRMED=true is set after the user verifies the Google Cloud billing configuration.');
 const scopes=[...new Set(selected.map(x=>scopeByProvider[x]!))];
 const state=randomBytes(24).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const server=http.createServer();
 await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Could not open a local OAuth callback port.');
 const redirectUri=`http://127.0.0.1:${address.port}/oauth2callback`;
 const authUrl=new URL('https://accounts.google.com/o/oauth2/v2/auth');authUrl.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
 console.log('Google will request the listed read-only scopes. Review the consent screen yourself; the agent will not open a browser or approve access.');console.log(authUrl.toString());console.log('Waiting for the loopback callback for up to 5 minutes…');
 try{
  const callback=await new Promise<{code:string}>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('OAuth consent timed out; no credentials were saved.')),5*60_000);
   server.on('request',(req,res)=>{const url=new URL(req.url??'/',redirectUri);if(url.pathname!=='/oauth2callback'){res.writeHead(404).end();return;}if(url.searchParams.get('state')!==state){res.writeHead(400).end('OAuth state did not match.');clearTimeout(timer);reject(new Error('OAuth state validation failed.'));return;}const error=url.searchParams.get('error');const code=url.searchParams.get('code');if(error||!code){res.writeHead(400,{'content-type':'text/plain; charset=utf-8'}).end('Authorization was not completed. You may close this tab.');clearTimeout(timer);reject(new Error(`Google authorization returned ${error??'no code'}; no credentials were saved.`));return;}res.writeHead(200,{'content-type':'text/plain; charset=utf-8'}).end('Authorization received. You may close this tab.');clearTimeout(timer);resolve({code});});
  });
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code:callback.code,code_verifier:verifier,redirect_uri:redirectUri,grant_type:'authorization_code'}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Google token exchange failed with HTTP ${response.status}; credentials were not saved.`);
  const token=await response.json() as {refresh_token?:string};if(!token.refresh_token)throw new Error('Google did not return an offline refresh token. No credentials were saved. Revoke prior app consent in Google Account settings, then rerun this command if needed.');
  const stored=JSON.stringify({refreshToken:token.refresh_token,scopes,createdAt:new Date().toISOString()});
  fs.mkdirSync('data',{recursive:true});fs.writeFileSync('data/google-oauth.dpapi',protectForCurrentWindowsUser(stored)+'\n',{encoding:'ascii',flag:'w'});
  console.log('OAuth refresh token encrypted with Windows DPAPI for the current user and saved to data/google-oauth.dpapi. No token value was printed.');
 }finally{server.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
