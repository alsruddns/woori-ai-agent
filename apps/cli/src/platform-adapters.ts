import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type PlatformId = 'windows' | 'linux' | 'unsupported';
export type CapabilityStatus = 'Ready' | 'Not Configured' | 'Unsupported';

export interface CredentialStore {
  readonly id: string;
  readonly status: CapabilityStatus;
  readonly reason: string;
  protect?(value: string): Promise<string>;
  unprotect?(value: string): Promise<string>;
}

export interface SandboxProvider {
  readonly id: string;
  readonly status: CapabilityStatus;
  readonly reason: string;
}

export interface ProcessRunner {
  readonly platform: PlatformId;
  readonly timeoutTermination: 'taskkill-tree' | 'process-signal';
  terminate(pid: number): void;
}

export interface FileSystemAdapter {
  resolve(...parts: string[]): string;
  normalize(value: string): string;
}

export interface WorkerHealthProvider {
  snapshot(): { cpuCount: number; loadAverage: number[]; totalMemoryBytes: number; freeMemoryBytes: number; platform: PlatformId };
}

export interface CodexExecutorAdapter {
  readonly status: CapabilityStatus;
  readonly reason: string;
  readonly sandbox: SandboxProvider;
  buildExecArgs(worktree: string, mode: 'read-only' | 'workspace-write', prompt: string): string[] | null;
  buildSandboxCommandArgs(worktree: string, command: string, args: string[]): string[] | null;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly credentialStore: CredentialStore;
  readonly sandbox: SandboxProvider;
  readonly processRunner: ProcessRunner;
  readonly fileSystem: FileSystemAdapter;
  readonly workerHealth: WorkerHealthProvider;
  readonly codexExecutor: CodexExecutorAdapter;
}

function platformId(platform: string): PlatformId {
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return 'unsupported';
}

function credentialStore(id: PlatformId): CredentialStore {
  if (id === 'windows') return {
    id: 'windows-dpapi-current-user', status: 'Ready',
    reason: 'Uses Windows DPAPI scoped to the current user. It cannot be decrypted on Linux.',
    async protect(value) { return (await import('./local-dpapi.js')).protectForCurrentWindowsUser(value); },
    async unprotect(value) { return (await import('./local-dpapi.js')).unprotectForCurrentWindowsUser(value); },
  };
  if (id === 'linux') return {
    id: 'linux-local-secret-store', status: 'Not Configured',
    reason: 'Linux credential encryption is not implemented in Phase 10A-1; Windows DPAPI data is never read or migrated here.',
  };
  return { id: 'unsupported', status: 'Unsupported', reason: 'No credential-store adapter exists for this operating system.' };
}

function sandboxProvider(id: PlatformId): SandboxProvider {
  if (id === 'windows') return { id: 'windows-mxc', status: 'Not Configured', reason: 'MXC must pass its live Codex sandbox probe before write execution.' };
  if (id === 'linux') return { id: 'linux-isolated-sandbox', status: 'Not Configured', reason: 'Linux sandbox implementation is deferred to Phase 10A-2; Linux code modification is fail-closed.' };
  return { id: 'unsupported', status: 'Unsupported', reason: 'No sandbox adapter exists for this operating system.' };
}

export function createPlatformAdapter(platform = process.platform): PlatformAdapter {
  const id = platformId(platform);
  const sandbox = sandboxProvider(id);
  return {
    id,
    credentialStore: credentialStore(id),
    sandbox,
    processRunner: {
      platform: id,
      timeoutTermination: id === 'windows' ? 'taskkill-tree' : 'process-signal',
      terminate(pid) {
        if (id === 'windows') spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{encoding:'utf8',windowsHide:true,timeout:5000});
        else try { process.kill(pid,'SIGTERM'); } catch { /* Process may have exited during timeout handling. */ }
      },
    },
    fileSystem: {
      resolve: (...parts) => path.resolve(...parts),
      normalize: value => path.normalize(value),
    },
    workerHealth: {
      snapshot: () => {
        const averages = os.loadavg();
        return {
          cpuCount: os.cpus().length,
          loadAverage: id === 'windows' ? [] : averages,
          totalMemoryBytes: os.totalmem(),
          freeMemoryBytes: os.freemem(),
          platform: id,
        };
      },
    },
    codexExecutor: {
      status: sandbox.status,
      reason: id === 'windows' ? 'Workspace-write is available only after the Windows MXC probe succeeds.' : sandbox.reason,
      sandbox,
      buildExecArgs: id === 'windows'
        ? (worktree, mode, prompt) => ['-c','windows.sandbox=mxc','exec','--ignore-user-config','--sandbox',mode,'--ephemeral','--json','--cd',worktree,prompt]
        : () => null,
      buildSandboxCommandArgs: id === 'windows'
        ? (worktree, command, args) => ['-c','windows.sandbox=mxc','sandbox','--include-managed-config','--permission-profile',':workspace','--cd',worktree,'--',command,...args]
        : () => null,
    },
  };
}

export function detectCodexHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const userHome = platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir();
  const home = env.CODEX_HOME || path.join(userHome, '.codex');
  return platform === 'win32' ? path.win32.resolve(home) : path.posix.resolve(home);
}

export function credentialFileStatus(file: string, platform = process.platform) {
  if (platform !== 'win32' && /\.dpapi$/i.test(file)) {
    return { configured: false, status: 'Not Configured' as const, reason: 'Windows DPAPI credentials are not portable to this platform.' };
  }
  return fs.existsSync(file)
    ? { configured: true, status: 'Configured' as const, reason: 'Credential file exists; contents were not inspected.' }
    : { configured: false, status: 'Not Configured' as const, reason: 'Credential file does not exist.' };
}
