import { describe, expect, it, vi } from 'vitest';
import { createPlatformAdapter, credentialFileStatus, detectCodexHome } from '../apps/cli/src/platform-adapters.js';
import { safeCodexEnv } from '../apps/cli/src/codex-cli.js';

describe('platform adapters',()=>{
 it('selects Windows DPAPI and MXC without changing their platform boundary',()=>{
  const adapter=createPlatformAdapter('win32');
  expect(adapter.id).toBe('windows');
  expect(adapter.credentialStore.id).toBe('windows-dpapi-current-user');
  expect(adapter.sandbox.id).toBe('windows-mxc');
  expect(adapter.processRunner.timeoutTermination).toBe('taskkill-tree');
  expect(adapter.codexExecutor.reason).toMatch(/MXC probe/i);
  expect(adapter.codexExecutor.buildExecArgs('C:/work','workspace-write','task')?.join(' ')).toContain('windows.sandbox=mxc');
 });

 it('reports Linux credentials and sandbox as not configured and never falls back to DPAPI',()=>{
  const adapter=createPlatformAdapter('linux');
  expect(adapter.id).toBe('linux');
  expect(adapter.credentialStore.id).toBe('linux-local-secret-store');
  expect(adapter.credentialStore.status).toBe('Not Configured');
  expect(adapter.sandbox.id).toBe('linux-isolated-sandbox');
  expect(adapter.sandbox.status).toBe('Not Configured');
  expect(adapter.codexExecutor.status).toBe('Not Configured');
  const execArgs=adapter.codexExecutor.buildExecArgs('/tmp/work','workspace-write','task');
  expect(execArgs).toContain('workspace-write');expect(execArgs).toContain('sandbox_workspace_write.network_access=false');expect(execArgs?.join(' ')).not.toContain('windows.sandbox=mxc');
  expect(adapter.codexExecutor.buildSandboxCommandArgs('/tmp/work','sh',['-c','true'])?.join(' ')).toContain('--unshare-net');
  expect(adapter.processRunner.timeoutTermination).toBe('process-signal');
  expect(credentialFileStatus('/tmp/google-oauth.dpapi','linux').configured).toBe(false);
  expect(credentialFileStatus('/tmp/google-oauth.dpapi','linux').reason).toMatch(/not portable/i);
 });

 it('uses the OS independent path implementation and reports real worker resources',()=>{
  const adapter=createPlatformAdapter('linux');
  const absolute=adapter.fileSystem.resolve('/tmp','worker','..','job');
  expect(absolute).toContain('job');
  const health=adapter.workerHealth.snapshot();
  expect(health.platform).toBe('linux');
  expect(health.cpuCount).toBeGreaterThan(0);
  expect(health.totalMemoryBytes).toBeGreaterThan(0);
  expect(health.loadAverage).toHaveLength(3);
 });

 it('terminates a Linux process group on timeout, including the force-kill escalation path',()=>{
  const kill=vi.spyOn(process,'kill').mockImplementation(()=>true);
  try{const runner=createPlatformAdapter('linux').processRunner;runner.terminate(2468);runner.terminate(2468,true);expect(kill).toHaveBeenNthCalledWith(1,-2468,'SIGTERM');expect(kill).toHaveBeenNthCalledWith(2,-2468,'SIGKILL');}finally{kill.mockRestore();}
 });

 it('resolves Codex home from an explicit environment without exposing credentials',()=>{
  expect(detectCodexHome({CODEX_HOME:'/tmp/private-codex'},'linux')).toBe('/tmp/private-codex');
  const env=safeCodexEnv({PATH:'/usr/bin',HOME:'/home/agent',OPENAI_API_KEY:'must-not-pass',CODEX_API_KEY:'must-not-pass'},'linux');
  expect(env.HOME).toBe('/home/agent');expect(env.OPENAI_API_KEY).toBeUndefined();expect(env.CODEX_API_KEY).toBeUndefined();
  const worker=safeCodexEnv({PATH:'/usr/bin',HOME:'/home/user',XDG_CONFIG_HOME:'/home/user/.config',WOORI_LINUX_WORKER_HOME:'/srv/woori-worker',OPENAI_API_KEY:'must-not-pass'},'linux');
  expect(worker.HOME).toBe('/srv/woori-worker');expect(worker.XDG_CONFIG_HOME).toBe('/srv/woori-worker/.config');expect(worker.OPENAI_API_KEY).toBeUndefined();
 });
});
