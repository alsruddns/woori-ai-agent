import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

type Session = { expiresAt: number };
const sessions = new Map<string, Session>();
const COOKIE = 'woori_agent_admin';
const hash = (value: string) => createHash('sha256').update(value).digest();
const loginFailures = new Map<string,{count:number;blockedUntil:number}>();
function cookieValue(req: http.IncomingMessage, key: string) { const raw=req.headers.cookie??''; for(const part of raw.split(';')){const [name,...rest]=part.trim().split('=');if(name===key)return decodeURIComponent(rest.join('='));} return ''; }
export function adminConfigurationStatus() { return process.env.WOORI_ADMIN_PASSWORD && process.env.WOORI_ADMIN_PASSWORD.length>=16 ? 'Configured' : 'Not Configured'; }
export function issueAdminSession(req: http.IncomingMessage, password: string) {
  const expected=process.env.WOORI_ADMIN_PASSWORD??''; if(adminConfigurationStatus()!=='Configured')throw new Error('WOORI_ADMIN_PASSWORD must be configured with at least 16 characters.');
  const address=req.socket?.remoteAddress??'loopback',now=Date.now(),failure=loginFailures.get(address);if(failure&&failure.blockedUntil>now)throw new Error('Administrator login temporarily rate-limited.');
  if(password.length>512||!timingSafeEqual(hash(password),hash(expected))){const count=(failure?.count??0)+1,blockedUntil=count>=5?now+5*60_000:0;loginFailures.set(address,{count:blockedUntil?0:count,blockedUntil});throw new Error('Invalid administrator credentials.');}
  loginFailures.delete(address);
  const sessionId=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'); sessions.set(sessionId,{expiresAt:Date.now()+8*60*60_000});
  for(const [id,value] of sessions)if(value.expiresAt<=Date.now())sessions.delete(id);
  return { csrf, cookie: `${COOKIE}=${encodeURIComponent(sessionId)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800`, csrfCookie:`woori_agent_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Strict; Max-Age=28800`, administrator: true };
}
export function adminSessionStatus(req: http.IncomingMessage) { const sessionId=cookieValue(req,COOKIE),session=sessions.get(sessionId); if(!session||session.expiresAt<=Date.now()){sessions.delete(sessionId);return {authenticated:false,configuration:adminConfigurationStatus()};}return {authenticated:true,configuration:adminConfigurationStatus(),csrf:cookieValue(req,'woori_agent_csrf'),expiresAt:new Date(session.expiresAt).toISOString()}; }
export function authorizeAdminMutation(req: http.IncomingMessage) { if(req.headers.origin!=='http://127.0.0.1:5173'||req.headers['content-type']?.split(';')[0]!=='application/json')return {ok:false as const,status:403,error:'forbidden_origin_or_content_type'}; const session=adminSessionStatus(req); if(!session.authenticated)return {ok:false as const,status:401,error:'administrator_authentication_required'};const header=req.headers['x-csrf-token'],csrf=cookieValue(req,'woori_agent_csrf');if(typeof header!=='string'||!csrf||header!==csrf||session.csrf!==csrf)return {ok:false as const,status:403,error:'csrf_validation_failed'};return {ok:true as const,actor:'local-administrator'}; }
export function clearAdminSession(req: http.IncomingMessage) { const sessionId=cookieValue(req,COOKIE);sessions.delete(sessionId);return [`${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,`woori_agent_csrf=; Path=/; SameSite=Strict; Max-Age=0`]; }
