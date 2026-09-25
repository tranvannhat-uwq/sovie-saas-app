export function mergeCloudReadHealth(current, failedDomains = [], attemptedDomains = []) {
  const nextFailures = new Set(current?.failedDomains || []);
  attemptedDomains.filter(Boolean).forEach(domain => nextFailures.delete(domain));
  failedDomains.filter(Boolean).forEach(domain => nextFailures.add(domain));
  const uniqueFailures = [...nextFailures];

  return Object.freeze({
    status: uniqueFailures.length > 0 ? 'degraded' : 'healthy',
    failedDomains: uniqueFailures
  });
}
