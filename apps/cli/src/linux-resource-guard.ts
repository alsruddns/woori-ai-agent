import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linuxAvailableMemoryBytes } from './linux-runtime.js';

export type LinuxResourceSample = { availableMemoryBytes: number | null; load1: number | null; cpuCount: number; freeDiskBytes: number | null; cgroupOomEvents: number | null };
export type LinuxResourceDecision = { status: 'Allowed' | 'Blocked' | 'Not Applicable'; reasons: string[]; sample: LinuxResourceSample; policy: { minimumAvailableMemoryBytes: number; minimumFreeDiskBytes: number; maxLoadPerCpu: number } };

function positiveMiB(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 128 && parsed <= 65536 ? Math.floor(parsed) : fallback; }
export function linuxResourcePolicy(env: NodeJS.ProcessEnv = process.env) {
  const load = Number(env.WOORI_LINUX_MAX_LOAD_PER_CPU);
  return { minimumAvailableMemoryBytes: positiveMiB(env.WOORI_LINUX_MIN_AVAILABLE_MIB, 768) * 1024 * 1024, minimumFreeDiskBytes: positiveMiB(env.WOORI_LINUX_MIN_FREE_DISK_MIB, 4096) * 1024 * 1024, maxLoadPerCpu: Number.isFinite(load) && load >= 0.1 && load <= 1 ? load : 0.75 };
}

function cgroupOomEvents(): number | null {
  try {
    const entry = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'));
    if (!entry) return null;
    const relative = entry.slice(3).replace(/^\/+/, '');
    const events = path.join('/sys/fs/cgroup', relative, 'memory.events');
    const text = fs.readFileSync(events, 'utf8');
    const match = text.match(/^oom(?:_kill)?\s+(\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

export function sampleLinuxResources(statePath = process.env.WOORI_AGENT_STATE_DIR ?? '/var/lib/woori-ai-agent'): LinuxResourceSample {
  let freeDiskBytes: number | null = null;
  try { const stat = fs.statfsSync(statePath); freeDiskBytes = Number(stat.bavail) * Number(stat.bsize); } catch { /* missing/unreadable state path is reported as unknown */ }
  return { availableMemoryBytes: linuxAvailableMemoryBytes(), load1: os.loadavg()[0] ?? null, cpuCount: Math.max(1, os.cpus().length), freeDiskBytes, cgroupOomEvents: cgroupOomEvents() };
}

export function decideLinuxReadOnlyWork(sample = sampleLinuxResources(), policy = { minimumAvailableMemoryBytes: 768 * 1024 * 1024, minimumFreeDiskBytes: 4 * 1024 * 1024 * 1024, maxLoadPerCpu: 0.75 }, platform: NodeJS.Platform = process.platform): LinuxResourceDecision {
  const reasons: string[] = [];
  if (platform !== 'linux') return { status: 'Not Applicable', reasons: ['Linux host resource gate does not apply on this platform.'], sample, policy };
  if (sample.availableMemoryBytes === null) reasons.push('MemAvailable could not be measured; read-only job start is blocked.');
  else if (sample.availableMemoryBytes < policy.minimumAvailableMemoryBytes) reasons.push('MemAvailable is below the configured reserve.');
  if (sample.freeDiskBytes === null) reasons.push('Free disk space could not be measured; read-only job start is blocked.');
  else if (sample.freeDiskBytes < policy.minimumFreeDiskBytes) reasons.push('Free disk space is below the configured reserve.');
  if (sample.load1 === null || sample.load1 >= sample.cpuCount * policy.maxLoadPerCpu) reasons.push('Host load is unavailable or above the configured threshold.');
  if (sample.cgroupOomEvents === null) reasons.push('Memory cgroup OOM counters could not be inspected; host verification is required.');
  else if (sample.cgroupOomEvents > 0) reasons.push('OOM events are present in the current cgroup; operator review is required.');
  return { status: reasons.length ? 'Blocked' : 'Allowed', reasons, sample, policy };
}
