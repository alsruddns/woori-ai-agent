import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { diagnoseLinuxHost, inspectLinuxRuntime, linuxAvailableMemoryBytes, linuxOverloadReason, linuxWorkerLimits, systemdLimitedCommand, linuxWorkspaceSandboxArgs } from '../apps/cli/src/linux-runtime.js';

describe('Linux worker runtime safety',()=>{
 it('caps resource settings at the requested one CPU and 768 MiB ceiling',()=>{
  expect(linuxWorkerLimits({WOORI_LINUX_CPU_QUOTA_PERCENT:'150',WOORI_LINUX_MEMORY_MAX_MIB:'2048'})).toEqual({cpuQuotaPercent:100,memoryMaxBytes:768*1024*1024,tasksMax:128});
  expect(linuxWorkerLimits({WOORI_LINUX_CPU_QUOTA_PERCENT:'50',WOORI_LINUX_MEMORY_MAX_MIB:'512'})).toEqual({cpuQuotaPercent:50,memoryMaxBytes:512*1024*1024,tasksMax:128});
 });

 it('fails closed for root and for an unconfigured private worker home',()=>{
  const root=inspectLinuxRuntime({platform:'linux',uid:0,env:{},memoryAvailableBytes:3*1024*1024*1024,probeSandbox:()=>({status:'Ready',reason:'fixture'}),probeResources:()=>({status:'Ready',reason:'fixture'})});
  expect(root.runnable).toBe(false);expect(root.userIsolation.status).toBe('Blocked');
  const noHome=inspectLinuxRuntime({platform:'linux',uid:1001,env:{},memoryAvailableBytes:3*1024*1024*1024,probeSandbox:()=>({status:'Ready',reason:'fixture'}),probeResources:()=>({status:'Ready',reason:'fixture'})});
  expect(noHome.runnable).toBe(false);expect(noHome.userIsolation.reason).toMatch(/WOORI_LINUX_WORKER_HOME/);
 });

 it('requires headroom above the 768 MiB task limit and fails if MemAvailable is missing',()=>{
  const low=inspectLinuxRuntime({platform:'linux',uid:1001,env:{},memoryAvailableBytes:1_700*1024*1024,probeSandbox:()=>({status:'Ready',reason:'fixture'}),probeResources:()=>({status:'Ready',reason:'fixture'})});
  expect(low.runnable).toBe(false);expect(low.reasons.join(' ')).toMatch(/host reserve/);
  const absent=inspectLinuxRuntime({platform:'linux',uid:1001,env:{},memoryAvailableBytes:null,probeSandbox:()=>({status:'Ready',reason:'fixture'}),probeResources:()=>({status:'Ready',reason:'fixture'})});
  expect(absent.runnable).toBe(false);expect(absent.reasons.join(' ')).toMatch(/MemAvailable/);
  expect(linuxAvailableMemoryBytes('C:/not-a-linux-file')).toBeNull();
 });

 it('exposes a runtime guard for host memory and CPU pressure',()=>{
  expect(linuxOverloadReason({availableMemoryBytes:1700*1024*1024,cpuCount:4,loadAverage:[0]})).toMatch(/memory/i);
  expect(linuxOverloadReason({availableMemoryBytes:3*1024*1024*1024,cpuCount:4,loadAverage:[3]})).toMatch(/load average/i);
  expect(linuxOverloadReason({availableMemoryBytes:3*1024*1024*1024,cpuCount:4,loadAverage:[2]})).toBeNull();
 });

 it('runs Linux validation in an isolated workspace with network unshared and clean HOME',()=>{
  const args=linuxWorkspaceSandboxArgs('/tmp/job','pnpm',['test']);
  expect(args).toContain('--unshare-net');expect(args).toContain('--bind');expect(args).toContain(path.resolve('/tmp/job'));expect(args).toContain('/workspace');expect(args).toContain('/nonexistent');
  expect(args.join(' ')).not.toContain('windows.sandbox=mxc');
 });

 it('reports Linux diagnostics without enabling code changes on unsupported hosts',()=>{
  const result=diagnoseLinuxHost({platform:'win32',uid:1000});
  expect(result.platform).toBe('win32');expect(result.codeModificationEnabled).toBe(false);
  expect(result.codexCli.status).toBe('Not Configured');expect(result.sandboxBoundary.status).toBe('Not Configured');
  expect(result.note).toMatch(/remains disabled/i);
 });

 it('keeps Linux code modification disabled even when diagnostic probes pass',()=>{
  const result=diagnoseLinuxHost({platform:'linux',uid:1000,codexPath:null,probeBoundary:()=>({status:'Ready',reason:'fixture boundary passed'}),probeResources:()=>({status:'Ready',reason:'fixture cgroup passed'})});
  expect(result.codeModificationEnabled).toBe(false);expect(result.sandboxBoundary.status).toBe('Ready');
  expect(result.codexSandbox.status).toBe('Not Configured');expect(result.codexCli.status).toBe('Not Configured');
 });

 it('passes only allowlisted child variables through a resource-limited systemd scope',()=>{
  const launch=systemdLimitedCommand('/usr/bin/codex',['exec'],undefined,{PATH:'/usr/bin',HOME:'/home/worker',GITHUB_TOKEN:'secret',OPENAI_API_KEY:'secret'});
  expect(launch.command).toBe('systemd-run');expect(launch.args).toContain('--property=CPUQuota=100%');expect(launch.args).toContain('--property=MemoryMax=805306368');expect(launch.args).toContain('HOME=/home/worker');expect(launch.args.join(' ')).not.toContain('secret');
 });
});
