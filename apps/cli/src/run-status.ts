export function aggregateRunStatus(failed: boolean, statuses: Record<string, string>): string {
  if (failed) return 'Failed';
  const notConfigured = Object.values(statuses).filter(status => status === 'Not Configured').length;
  if (notConfigured === Object.keys(statuses).length && notConfigured > 0) return 'Not Configured';
  if (notConfigured > 0) return 'Partial';
  return 'Completed';
}
