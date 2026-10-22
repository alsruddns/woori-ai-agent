import { describe, expect, it } from 'vitest';
import { aggregateRunStatus } from '../apps/cli/src/run-status.js';

describe('run status aggregation', () => {
  it('does not report partial agent coverage as a full success', () => {
    expect(aggregateRunStatus(false, { qa: 'Completed', analytics: 'Not Configured' })).toBe('Partial');
    expect(aggregateRunStatus(false, { analytics: 'Not Configured' })).toBe('Not Configured');
  });
  it('keeps failures higher priority than unconfigured integrations', () => {
    expect(aggregateRunStatus(true, { qa: 'Failed', analytics: 'Not Configured' })).toBe('Failed');
  });
});
