import { afterEach, describe, expect, it } from 'vitest';
import {randomUUID} from 'node:crypto';
import { googleReport, robotsAllows } from '../apps/cli/src/free-analysis.js';
import { reserveApiRequest } from '../apps/cli/src/core.js';

const before={...process.env};
afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before)});
describe('free analysis safety',()=>{
 it('blocks robots-disallowed paths and honors a longer allow rule',()=>{expect(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/public','/private/a')).toBe(false);expect(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/public','/private/public')).toBe(true);});
 it('marks Google integrations Not Configured without making any request',async()=>{delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;delete process.env.GSC_SITE_URL;let calls=0;const result=await googleReport('gsc','free-analysis-test',async()=>{calls++;throw new Error('must not be called')});expect(result.status).toBe('Not Configured');expect(calls).toBe(0);});
 it('does not call a paid or free provider merely because credentials exist',async()=>{process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL='account@example.invalid';process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY='test-key';process.env.GSC_SITE_URL='sc-domain:example.invalid';process.env.GSC_API_ENABLED='false';let calls=0;const result=await googleReport('gsc','api-key-does-not-enable',async()=>{calls++;throw new Error('must not be called')});expect(result.status).toBe('Not Configured');expect(calls).toBe(0);});
 it('stops reserving provider requests at its configured daily cap',()=>{const provider=`quota-test-${randomUUID()}`;expect(reserveApiRequest(provider,2)).toBe(true);expect(reserveApiRequest(provider,2)).toBe(true);expect(reserveApiRequest(provider,2)).toBe(false);});
});
