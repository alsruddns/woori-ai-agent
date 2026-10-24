import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type LinuxRuntimeCheck = { status: 'Ready' | 'Not Configured' | 'Blocked'; reason: string };
export type LinuxRuntimeReadiness = {
  platform: 'linux' | 'unsupported';
  runnable: boolean;
  userIsolation: LinuxRuntimeCheck;
  bubblewrap: LinuxRuntimeCheck;
  resourceLimits: LinuxRuntimeCheck;
  availableMemoryBytes: number | null;
  cpuCount: number;
  loadAverage: number[];
  limits: { cpuQuotaPercent: number; memoryMaxBytes: number; tasksMax: number };
  reasons: string[];
};

export type LinuxSandboxDiagnostics = {
  checkedAt: string;
  platform: string;
  os: string | null;
  kernel: string | null;
  uid: number | null;
  codexCli: LinuxRuntimeCheck & { version?: string };
  bubblewrapCli: LinuxRuntimeCheck & { path?: string; version?: string };
  userNamespace: LinuxRuntimeCheck;
  networkNamespace: LinuxRuntimeCheck;
  appArmor: { enabled: boolean | null; restrictUnprivilegedUserns: boolean | null; bwrapProfiles: string[]; status: string };
  systemdLimits: LinuxRuntimeCheck;
  processSecurity: { noNewPrivileges: boolean | null; seccompMode: number | null };
  sandboxBoundary: LinuxRuntimeCheck;
  codexSandbox: LinuxRuntimeCheck;
  codeModificationEnabled: false;
  note: string;
};

const DEFAULT_MEMORY_MAX_MIB = 768;
const MIN_FREE_MEMORY_MARGIN_MIB = 1024;
const RESOURCE_TEST_TIMEOUT_MS = 8_000;
let readinessCache: { checkedAt: number; value: LinuxRuntimeReadiness } | undefined;

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function linuxWorkerLimits(env: NodeJS.ProcessEnv = process.env) {
  return {
    cpuQuotaPercent: boundedNumber(env.WOORI_LINUX_CPU_QUOTA_PERCENT, 100, 1, 100),
    memoryMaxBytes: boundedNumber(env.WOORI_LINUX_MEMORY_MAX_MIB, DEFAULT_MEMORY_MAX_MIB, 256, DEFAULT_MEMORY_MAX_MIB) * 1024 * 1024,
    tasksMax: 128,
  };
}

export function linuxAvailableMemoryBytes(procMemInfo = '/proc/meminfo') {
  try {
    const text = fs.readFileSync(procMemInfo, 'utf8');
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export function linuxOverloadReason(options: { availableMemoryBytes?: number | null; memoryMaxBytes?: number; cpuCount?: number; loadAverage?: number[] } = {}) {
  const memoryMaxBytes = options.memoryMaxBytes ?? linuxWorkerLimits().memoryMaxBytes;
  const availableMemoryBytes = options.availableMemoryBytes === undefined ? linuxAvailableMemoryBytes() : options.availableMemoryBytes;
  if (availableMemoryBytes === null) return 'MemAvailable could not be read while the Linux task was running.';
  if (availableMemoryBytes < memoryMaxBytes + MIN_FREE_MEMORY_MARGIN_MIB * 1024 * 1024) return 'Available host memory fell below the task memory limit plus the 1 GiB reserve.';
  const cpuCount = options.cpuCount ?? os.cpus().length;
  const loadAverage = options.loadAverage ?? os.loadavg();
  if ((loadAverage[0] ?? 0) >= cpuCount * 0.75) return 'Host 1-minute load average reached 75% of available CPUs; the Linux task was stopped.';
  return null;
}

function linuxUserIsolation(env: NodeJS.ProcessEnv, uid: number | null): LinuxRuntimeCheck {
  if (uid === null) return { status: 'Not Configured', reason: 'Linux UID could not be verified.' };
  if (uid === 0) return { status: 'Blocked', reason: 'Codex must not run as root.' };
  const configuredHome = env.WOORI_LINUX_WORKER_HOME;
  if (!configuredHome || !path.isAbsolute(configuredHome)) return { status: 'Not Configured', reason: 'Set WOORI_LINUX_WORKER_HOME to a dedicated absolute path owned by the non-root worker account.' };
  try {
    const realHome = fs.realpathSync(configuredHome);
    const stat = fs.statSync(realHome);
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) return { status: 'Blocked', reason: 'Dedicated worker home must be owned by the worker UID and have mode 0700 or stricter.' };
    const expectedHome = env.HOME ? fs.realpathSync(env.HOME) : '';
    if (expectedHome !== realHome) return { status: 'Blocked', reason: 'The running worker HOME must equal WOORI_LINUX_WORKER_HOME.' };
    const sensitive = ['.ssh', '.docker', '.aws', '.kube', '.config/gh', '.config/git', '.config/gcloud', '.gitconfig', '.git-credentials', '.npmrc', '.netrc', '.pypirc'];
    const found = sensitive.filter(name => fs.existsSync(path.join(realHome, name)));
    if (found.length) return { status: 'Blocked', reason: 'Sensitive SSH, cloud, Docker, GitHub, or Git credential paths exist in the worker home.' };
    const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(realHome, '.codex');
    const relativeCodex = path.relative(realHome, codexHome);
    if (relativeCodex === '..' || relativeCodex.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCodex)) return { status: 'Blocked', reason: 'CODEX_HOME must remain inside the dedicated worker home.' };
    const codexHomeLinkStat = fs.lstatSync(codexHome);
    if (codexHomeLinkStat.isSymbolicLink()) return { status: 'Blocked', reason: 'CODEX_HOME must be a real directory, not a symbolic link.' };
    const codexStat = fs.statSync(codexHome);
    const authFile = path.join(codexHome, 'auth.json');
    if (fs.lstatSync(authFile).isSymbolicLink()) return { status: 'Blocked', reason: 'The Codex auth file must not be a symbolic link.' };
    const authStat = fs.statSync(authFile);
    if (codexStat.uid !== uid || (codexStat.mode & 0o077) !== 0 || authStat.uid !== uid || (authStat.mode & 0o077) !== 0) return { status: 'Blocked', reason: 'Codex home and ChatGPT auth file must be owned by the worker and inaccessible to group/other users.' };
    return { status: 'Ready', reason: 'Non-root worker uses a private dedicated home with a private Codex auth file and no SSH, GitHub, Docker, or cloud credential paths.' };
  } catch {
    return { status: 'Not Configured', reason: 'Dedicated worker home does not exist or could not be inspected.' };
  }
}

function findExecutable(name: string) {
  const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] || null : null;
}

function boundedProbe(command: string, args: string[] = [], timeout = RESOURCE_TEST_TIMEOUT_MS) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 240), error: result.error?.message };
}

function readOptional(file: string) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function commandCheck(command: string, args: string[], passed: string, failed: string): LinuxRuntimeCheck {
  const result = boundedProbe(command, args);
  return result.status === 0 ? { status: 'Ready', reason: passed } : { status: 'Not Configured', reason: `${failed}${result.stderr ? `: ${result.stderr}` : result.error ? `: ${result.error}` : ''}` };
}

/** Read-only host diagnostics. Probes use only temporary files/namespaces and never relax host policy. */
export function diagnoseLinuxHost(options: { platform?: string; uid?: number | null; codexPath?: string | null; probeBoundary?: () => LinuxRuntimeCheck; probeResources?: (limits: ReturnType<typeof linuxWorkerLimits>) => LinuxRuntimeCheck } = {}): LinuxSandboxDiagnostics {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === undefined ? process.getuid?.() ?? null : options.uid;
  if (platform !== 'linux') {
    const unavailable = { status: 'Not Configured' as const, reason: 'Linux host diagnostics run only on Linux.' };
    return { checkedAt: new Date().toISOString(), platform, os: null, kernel: null, uid, codexCli: unavailable, bubblewrapCli: unavailable, userNamespace: unavailable, networkNamespace: unavailable, appArmor: { enabled: null, restrictUnprivilegedUserns: null, bwrapProfiles: [], status: 'Not Configured outside Linux.' }, systemdLimits: unavailable, processSecurity: { noNewPrivileges: null, seccompMode: null }, sandboxBoundary: unavailable, codexSandbox: unavailable, codeModificationEnabled: false, note: 'Linux write execution remains disabled until the complete sandbox/authentication boundary is separately verified.' };
  }

  const release = readOptional('/etc/os-release');
  const osName = release?.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? null;
  const kernelResult = boundedProbe('uname', ['-r']);
  const kernel = kernelResult.status === 0 ? kernelResult.stdout : null;
  const codexPath = options.codexPath === undefined ? findExecutable('codex') : options.codexPath;
  const codexVersion = codexPath ? boundedProbe(codexPath, ['--version'], 4_000) : null;
  const codexCli: LinuxSandboxDiagnostics['codexCli'] = codexPath && codexVersion?.status === 0
    ? { status: 'Ready', reason: 'Codex CLI version command succeeded; this does not confirm authentication or authorize a model request.', version: codexVersion.stdout.slice(0, 80) }
    : { status: 'Not Configured', reason: 'Codex CLI is not installed or its version could not be read; no AI request was attempted.' };

  const bwrapPath = findExecutable('bwrap');
  const bwrapVersion = bwrapPath ? boundedProbe(bwrapPath, ['--version'], 2_000) : null;
  const bubblewrapCli: LinuxSandboxDiagnostics['bubblewrapCli'] = bwrapPath && bwrapVersion?.status === 0
    ? { status: 'Ready', reason: 'Bubblewrap executable and version were detected.', path: bwrapPath, version: bwrapVersion.stdout.slice(0, 80) }
    : { status: 'Not Configured', reason: 'Bubblewrap was not found or its version command failed.' };

  const unsharePath = findExecutable('unshare');
  const truePath = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  const userNamespace = uid === 0
    ? { status: 'Blocked' as const, reason: 'Worker UID is root; rootless execution is mandatory.' }
    : unsharePath ? commandCheck(unsharePath, ['--user', '--map-root-user', truePath], 'Rootless user namespace probe passed.', 'Rootless user namespace probe was denied')
      : { status: 'Not Configured' as const, reason: 'The unshare utility is unavailable.' };
  const networkNamespace = uid === 0
    ? { status: 'Blocked' as const, reason: 'Worker UID is root; rootless execution is mandatory.' }
    : unsharePath ? commandCheck(unsharePath, ['--user', '--map-root-user', '--net', truePath], 'Rootless network namespace creation passed; this alone does not prove loopback setup or Codex isolation.', 'Rootless network namespace probe was denied')
      : { status: 'Not Configured' as const, reason: 'The unshare utility is unavailable.' };

  const appArmorEnabledRaw = readOptional('/sys/module/apparmor/parameters/enabled');
  const appArmorRestrictionRaw = readOptional('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  const profilesRaw = readOptional('/sys/kernel/security/apparmor/profiles');
  const appArmor: LinuxSandboxDiagnostics['appArmor'] = {
    enabled: appArmorEnabledRaw === null ? null : /^Y/i.test(appArmorEnabledRaw),
    restrictUnprivilegedUserns: appArmorRestrictionRaw === null ? null : appArmorRestrictionRaw === '1',
    bwrapProfiles: profilesRaw?.split(/\r?\n/).filter(line => /bubblewrap|bwrap/i.test(line)).map(line => line.slice(0, 180)) ?? [],
    status: appArmorEnabledRaw === null ? 'AppArmor state is not readable on this host.' : `AppArmor ${/^Y/i.test(appArmorEnabledRaw) ? 'enabled' : 'disabled'}; userns restriction ${appArmorRestrictionRaw ?? 'not exposed'}; matching profile entries ${profilesRaw === null ? 'not readable' : 'listed'}.`,
  };
  const procStatus = readOptional('/proc/self/status');
  const noNewPrivilegesValue = procStatus?.match(/^NoNewPrivs:\s+(\d+)/m)?.[1];
  const seccompValue = procStatus?.match(/^Seccomp:\s+(\d+)/m)?.[1];
  const processSecurity = { noNewPrivileges: noNewPrivilegesValue === undefined ? null : noNewPrivilegesValue === '1', seccompMode: seccompValue === undefined ? null : Number(seccompValue) };

  const limits = linuxWorkerLimits();
  const systemdLimits = (options.probeResources ?? probeSystemdLimits)(limits);
  const sandboxBoundary = (options.probeBoundary ?? (() => probeBubblewrapSandbox({ platform, uid })))();
  const codexSandbox = codexPath
    ? commandCheck(codexPath, ['sandbox', 'linux', truePath], 'Official Codex Linux command sandbox executed successfully; no model request was made.', 'Official Codex Linux sandbox command failed')
    : { status: 'Not Configured' as const, reason: 'Codex CLI is unavailable; official Codex sandbox probe was not run.' };

  return {
    checkedAt: new Date().toISOString(), platform, os: osName, kernel, uid, codexCli, bubblewrapCli,
    userNamespace, networkNamespace, appArmor, systemdLimits, processSecurity, sandboxBoundary, codexSandbox,
    codeModificationEnabled: false,
    note: 'Diagnostics never change sysctl, AppArmor, seccomp, or host namespace settings. Linux code modification remains disabled; ChatGPT login and an isolated write-boundary test are not inferred from these probes.',
  };
}

export function probeBubblewrapSandbox(options: { platform?: string; uid?: number | null; env?: NodeJS.ProcessEnv; tempRoot?: string } = {}): LinuxRuntimeCheck {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return { status: 'Not Configured', reason: 'Linux sandbox probe runs only on Linux.' };
  if ((options.uid ?? process.getuid?.() ?? null) === 0) return { status: 'Blocked', reason: 'Rootless user namespaces are required; root execution is prohibited.' };
  const bwrap = findExecutable('bwrap');
  if (!bwrap) return { status: 'Not Configured', reason: 'bubblewrap (bwrap) is not installed.' };

  const base = options.tempRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'woori-linux-sandbox-'));
  const ownsBase = !options.tempRoot;
  const workspace = path.join(base, 'workspace');
  const outsideSecret = path.join(base, 'host-only-marker');
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(outsideSecret, 'sandbox-boundary-probe', { mode: 0o600 });
    const args = ['--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-net'];
    for (const systemPath of ['/usr','/usr/local','/bin','/lib','/lib64','/lib32']) {
      if (fs.existsSync(systemPath)) args.push('--ro-bind-try', systemPath, systemPath);
    }
    args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/workspace','--bind',workspace,'/workspace','--chdir','/workspace','--','/usr/bin/sh','-eu','-c',
      'printf isolated > /workspace/write-check; test ! -e "$1"; test ! -e /home; test ! -w /usr; test ! -s /proc/net/route; test "$(awk \'NR > 2 { n++ } END { print n+0 }\' /proc/net/dev)" -le 1; printf WOORI_BWRAP_OK',
      'woori-probe', outsideSecret);
    const result = spawnSync(bwrap, args, { encoding: 'utf8', timeout: RESOURCE_TEST_TIMEOUT_MS, stdio: ['ignore','pipe','pipe'] });
    if (result.status === 0 && result.stdout.includes('WOORI_BWRAP_OK') && fs.existsSync(path.join(workspace, 'write-check'))) {
      return { status: 'Ready', reason: 'Rootless bubblewrap probe passed: workspace write works; host-only path, host home, and system writes are inaccessible; only loopback is present and no network route is exposed.' };
    }
    const diagnostic = (result.stderr || result.error?.message || '').replace(/\s+/g, ' ').slice(0, 240);
    return { status: 'Not Configured', reason: `bubblewrap isolation probe failed (exit ${result.status ?? 'unknown'}) or user namespaces are restricted; Linux code execution remains disabled.${diagnostic ? ` Runner diagnostic: ${diagnostic}` : ''}` };
  } catch {
    return { status: 'Not Configured', reason: 'bubblewrap isolation probe could not complete.' };
  } finally {
    if (ownsBase) fs.rmSync(base, { recursive: true, force: true });
  }
}

export function probeSystemdLimits(limits: ReturnType<typeof linuxWorkerLimits> = linuxWorkerLimits()): LinuxRuntimeCheck {
  const systemdRun = findExecutable('systemd-run');
  const trueBin = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  if (!systemdRun || !fs.existsSync(trueBin)) return { status: 'Not Configured', reason: 'systemd-run --user and a minimal probe executable are required for enforceable CPU/memory caps.' };
  const result = spawnSync(systemdRun, [
    '--user','--scope','--quiet',
    `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
    `--property=MemoryMax=${limits.memoryMaxBytes}`,
    `--property=TasksMax=${limits.tasksMax}`,
    '--',trueBin,
  ], { encoding: 'utf8', timeout: RESOURCE_TEST_TIMEOUT_MS, stdio: ['ignore','ignore','ignore'] });
  return result.status === 0
    ? { status: 'Ready', reason: `User systemd scope enforced CPUQuota=${limits.cpuQuotaPercent}%, MemoryMax=${limits.memoryMaxBytes} bytes, TasksMax=${limits.tasksMax}.` }
    : { status: 'Not Configured', reason: 'User systemd scope could not enforce the configured cgroup limits.' };
}

export function inspectLinuxRuntime(options: { platform?: string; uid?: number | null; env?: NodeJS.ProcessEnv; memoryAvailableBytes?: number | null; probeSandbox?: () => LinuxRuntimeCheck; probeResources?: (limits: ReturnType<typeof linuxWorkerLimits>) => LinuxRuntimeCheck } = {}): LinuxRuntimeReadiness {
  if (Object.keys(options).length === 0 && readinessCache && Date.now() - readinessCache.checkedAt < 15_000) return readinessCache.value;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const limits = linuxWorkerLimits(env);
  if (platform !== 'linux') {
    const unavailable = { status: 'Not Configured' as const, reason: 'Runtime inspection is available only on Linux.' };
    const value = { platform: 'unsupported' as const, runnable: false, userIsolation: unavailable, bubblewrap: unavailable, resourceLimits: unavailable, availableMemoryBytes: null, cpuCount: 0, loadAverage: [], limits, reasons: [unavailable.reason] };
    if (Object.keys(options).length === 0) readinessCache = { checkedAt: Date.now(), value };
    return value;
  }
  const availableMemoryBytes = options.memoryAvailableBytes === undefined ? linuxAvailableMemoryBytes() : options.memoryAvailableBytes;
  const userIsolation = linuxUserIsolation(env, options.uid === undefined ? process.getuid?.() ?? null : options.uid);
  const bubblewrap = (options.probeSandbox ?? (() => probeBubblewrapSandbox({ platform, uid: options.uid, env })))();
  const resourceLimits = (options.probeResources ?? probeSystemdLimits)(limits);
  const reasons = [userIsolation, bubblewrap, resourceLimits].filter(check => check.status !== 'Ready').map(check => check.reason);
  if (availableMemoryBytes === null) reasons.push('MemAvailable could not be read from /proc/meminfo.');
  else if (availableMemoryBytes < limits.memoryMaxBytes + MIN_FREE_MEMORY_MARGIN_MIB * 1024 * 1024) reasons.push('Available memory is below the job limit plus the 1 GiB host reserve.');
  const cpuCount = os.cpus().length;
  const loadAverage = os.loadavg();
  if (loadAverage[0] !== undefined && loadAverage[0] >= cpuCount * 0.75) reasons.push('Host 1-minute load average is at least 75% of available CPU count; new Codex work is paused.');
  const value = {
    platform: 'linux' as const,
    runnable: reasons.length === 0,
    userIsolation,
    bubblewrap,
    resourceLimits,
    availableMemoryBytes,
    cpuCount,
    loadAverage,
    limits,
    reasons,
  };
  if (Object.keys(options).length === 0) readinessCache = { checkedAt: Date.now(), value };
  return value;
}

export function systemdLimitedCommand(command: string, args: string[], limits = linuxWorkerLimits(), childEnv: NodeJS.ProcessEnv = {}) {
  const cleanEntries = Object.entries(childEnv).filter(([key,value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && !/^(?:OPENAI|CODEX|GITHUB|GH_|SSH_|GOOGLE_|AWS_|AZURE_|DOCKER_|DATABASE_URL)/i.test(key));
  const envArgs = cleanEntries.map(([key,value]) => `${key}=${value}`);
  return {
    command: 'systemd-run',
    args: ['--user','--scope','--quiet','--pipe',`--property=CPUQuota=${limits.cpuQuotaPercent}%`,`--property=MemoryMax=${limits.memoryMaxBytes}`,`--property=TasksMax=${limits.tasksMax}`,'--','/usr/bin/env','-i',...envArgs,command,...args],
  };
}

export function linuxWorkspaceSandboxArgs(workspace: string, command: string, args: string[]) {
  const normalized = path.resolve(workspace);
  const result = ['--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-net'];
  for (const systemPath of ['/usr','/usr/local','/bin','/lib','/lib64','/lib32']) {
    if (fs.existsSync(systemPath)) result.push('--ro-bind-try',systemPath,systemPath);
  }
  result.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/workspace','--bind',normalized,'/workspace','--chdir','/workspace','--setenv','HOME','/nonexistent','--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--',command,...args);
  return result;
}
