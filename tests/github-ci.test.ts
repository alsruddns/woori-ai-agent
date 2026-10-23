import fs from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {assessGithubCi,type GithubCheckEvidence,type GithubWorkflowEvidence} from '../apps/cli/src/github-ci.js';
import readiness from '../configs/service-ci-readiness.json';

const sha='a'.repeat(40);
const check=(overrides:Partial<GithubCheckEvidence>={}):GithubCheckEvidence=>({name:'PR CI / validate',state:'COMPLETED',conclusion:'SUCCESS',headSha:sha,source:'check_run',...overrides});
const run=(overrides:Partial<GithubWorkflowEvidence>={}):GithubWorkflowEvidence=>({runId:1,name:'PR CI',status:'completed',conclusion:'success',url:null,createdAt:null,headSha:sha,...overrides});

describe('GitHub PR CI evidence assessment',()=>{
 it('does not pass when required checks are not configured',()=>{
  expect(assessGithubCi({currentSha:sha,requiredChecksConfigured:false,checks:[check()],workflowRuns:[run()]}).status).toBe('Not Configured');
 });
 it('requires every configured check on the current PR head',()=>{
  const missing=assessGithubCi({currentSha:sha,requiredChecksConfigured:true,requiredChecks:['PR CI / validate','security'],checks:[check()]});
  expect(missing.status).toBe('Checks Missing');expect(missing.missingRequired).toEqual(['security']);
  const passed=assessGithubCi({currentSha:sha,requiredChecksConfigured:true,requiredChecks:['PR CI / validate'],checks:[check()]});expect(passed.status).toBe('Passed');
 });
 it('rejects stale checks and workflow runs after the head SHA changes',()=>{
  const newer='b'.repeat(40);const result=assessGithubCi({currentSha:newer,requiredChecksConfigured:true,requiredChecks:['PR CI / validate'],checks:[check()],workflowRuns:[run()]});
  expect(result.status).toBe('Stale');expect(result.staleEvidence).toBe(1);expect(result.workflowRuns).toHaveLength(0);
 });
 it('keeps check runs and workflow runs as separate evidence and labels failure states',()=>{
  const timedOut=assessGithubCi({currentSha:sha,requiredChecksConfigured:true,requiredChecks:['PR CI / validate'],checks:[check({conclusion:'TIMED_OUT'})],workflowRuns:[run()]});
  expect(timedOut.status).toBe('Timed Out');expect(timedOut.checks).toHaveLength(1);expect(timedOut.workflowRuns).toHaveLength(1);
  expect(assessGithubCi({currentSha:sha,requiredChecksConfigured:true,requiredChecks:['PR CI / validate'],checks:[check({conclusion:'CANCELLED'})]}).status).toBe('Cancelled');
  expect(assessGithubCi({currentSha:sha,requiredChecksConfigured:true,requiredChecks:['PR CI / validate'],checks:[check({conclusion:'FAILURE'})]}).status).toBe('Failed');
 });
 it('never treats a failed GitHub query as success',()=>{
  expect(assessGithubCi({currentSha:sha,requiredChecksConfigured:true,requiredChecks:['PR CI / validate'],checks:[check()],queryFailed:true}).status).toBe('Query Failed');
 });
});

describe('service CI proposal policy',()=>{
 it('ships a proposal for each allowed repository without deployment triggers or write permissions',()=>{
  expect(readiness.services.map(item=>item.service).sort()).toEqual(['calculator','docs','home','quiz','tools']);
  for(const item of readiness.services){
   const base=path.join(process.cwd(),'docs','ci-proposals',item.service);
   const workflow=fs.readFileSync(path.join(base,'pr-ci.yml'),'utf8');
   const patch=fs.readFileSync(path.join(base,'pr-ci.patch'),'utf8');
   expect(workflow).toContain('pull_request:');expect(workflow).toContain('branches: [develop]');expect(workflow).toContain('contents: read');
   expect(workflow).not.toMatch(/^\s+(push|workflow_dispatch|pull_request_target):/m);
   expect(workflow).not.toMatch(/appleboy\/ssh-action|docker\/build-push-action|environment:\s*production|SERVER_SSH_KEY|secrets\./i);
   expect(patch).toContain('+++ b/.github/workflows/pr-ci.yml');
   for(const command of item.commands.slice(1))expect(workflow).toContain(command);
  }
 });
});
