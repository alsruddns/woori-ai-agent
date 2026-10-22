import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueDevelopmentTask, listDevelopmentTasks, transitionDevelopmentTask } from '../apps/cli/src/development-orchestrator.js';

const previousDb = process.env.WOORI_AGENT_DB_PATH;
let tempDir: string | undefined;
afterEach(() => {
  if (previousDb === undefined) delete process.env.WOORI_AGENT_DB_PATH;
  else process.env.WOORI_AGENT_DB_PATH = previousDb;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function useTempDatabase() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woori-development-'));
  process.env.WOORI_AGENT_DB_PATH = path.join(tempDir, 'queue.sqlite');
}

describe('development task queue safety', () => {
  it('deduplicates equivalent work and records queue events in SQLite', () => {
    useTempDatabase();
    const input = { service:'docs', title:'Improve document navigation', kind:'ux', priority:'Medium' as const, evidence:'The sampled document table of contents did not expose a working anchor.', acceptanceCriteria:'Verify each table of contents link scrolls to its heading and add a regression test.', sourceAgent:'qa', url:'https://www.woori.today/ko/docs/example' };
    const first = enqueueDevelopmentTask(input);
    const duplicate = enqueueDevelopmentTask(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    const queue = listDevelopmentTasks();
    expect(queue.tasks).toHaveLength(1);
    expect(queue.events).toHaveLength(1);
  });

  it('excludes MoneyBook and keeps Calculator from becoming Ready while locked', () => {
    useTempDatabase();
    expect(() => enqueueDevelopmentTask({ service:'money', title:'Change account behavior', kind:'bug', priority:'High', evidence:'Private user data flow.', acceptanceCriteria:'Do not run.', sourceAgent:'qa' })).toThrow(/MoneyBook is excluded/i);
    const task = enqueueDevelopmentTask({ service:'calculator', title:'Review known compound-interest issue', kind:'bug', priority:'Medium', evidence:'Previously recorded QA issue; not newly reproduced.', acceptanceCriteria:'After multilingual expansion, reproduce and verify with an independent expected-value test.', sourceAgent:'qa', url:'https://www.woori.today/ko/calculators/compound-interest' });
    expect(task.created).toBe(true);
    transitionDevelopmentTask(task.taskId!, 'Triaged');
    expect(() => transitionDevelopmentTask(task.taskId!, 'Ready')).toThrow(/protected ongoing multilingual expansion/i);
  });

  it('rejects unsafe task transitions and never starts Codex execution from the dry-run queue', () => {
    useTempDatabase();
    const task = enqueueDevelopmentTask({ service:'docs', title:'Review docs issue', kind:'content', priority:'Low', evidence:'A page lacks a usage note.', acceptanceCriteria:'Confirm the page and add a content review regression check.', sourceAgent:'content' });
    transitionDevelopmentTask(task.taskId!, 'Triaged');
    transitionDevelopmentTask(task.taskId!, 'Ready');
    expect(() => transitionDevelopmentTask(task.taskId!, 'Running')).toThrow(/not configured/i);
    const tasks = listDevelopmentTasks().tasks as Array<{status:string}>;
    expect(tasks[0]?.status).toBe('Ready');
  });
});
