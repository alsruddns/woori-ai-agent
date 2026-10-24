import { describe, expect, it } from 'vitest';
import { decideLinuxReadOnlyWork, linuxResourcePolicy } from '../apps/cli/src/linux-resource-guard.js';

const healthy={availableMemoryBytes:2*1024**3,load1:0.2,cpuCount:4,freeDiskBytes:20*1024**3,cgroupOomEvents:0};
describe('Linux read-only host resource guard',()=>{
 it('allows only a healthy Linux sample within reserve and cgroup policy',()=>expect(decideLinuxReadOnlyWork(healthy,undefined,'linux').status).toBe('Allowed'));
 it('blocks low memory, low disk, high load, or unreadable/OOM cgroup evidence',()=>{
  expect(decideLinuxReadOnlyWork({...healthy,availableMemoryBytes:100},undefined,'linux').status).toBe('Blocked');
  expect(decideLinuxReadOnlyWork({...healthy,freeDiskBytes:100},undefined,'linux').status).toBe('Blocked');
  expect(decideLinuxReadOnlyWork({...healthy,load1:4},undefined,'linux').status).toBe('Blocked');
  expect(decideLinuxReadOnlyWork({...healthy,cgroupOomEvents:1},undefined,'linux').status).toBe('Blocked');
  expect(decideLinuxReadOnlyWork({...healthy,cgroupOomEvents:null},undefined,'linux').status).toBe('Blocked');
 });
 it('does not apply the Linux host gate on Windows and bounds configurable thresholds',()=>{
  expect(decideLinuxReadOnlyWork(healthy,undefined,'win32').status).toBe('Not Applicable');
  expect(linuxResourcePolicy({WOORI_LINUX_MIN_AVAILABLE_MIB:'1',WOORI_LINUX_MIN_FREE_DISK_MIB:'999999'}).minimumAvailableMemoryBytes).toBe(768*1024*1024);
 });
});
