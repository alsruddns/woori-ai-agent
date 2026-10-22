import { afterEach, describe, expect, it } from 'vitest';
import { googleReport, robotsAllows } from '../apps/cli/src/free-analysis.js';

const before={...process.env};
afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before)});
describe('free analysis safety',()=>{
 it('blocks robots-disallowed paths and honors a longer allow rule',()=>{expect(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/public','/private/a')).toBe(false);expect(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private/public','/private/public')).toBe(true);});
 it('marks Google integrations Not Configured without making any request',async()=>{delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;delete process.env.GSC_SITE_URL;let calls=0;const result=await googleReport('gsc','free-analysis-test',async()=>{calls++;throw new Error('must not be called')});expect(result.status).toBe('Not Configured');expect(calls).toBe(0);});
});
