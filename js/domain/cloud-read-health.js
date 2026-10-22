export function mergeCloudReadHealth(current, failedDomains = [], attemptedDomains = [], failureDetails = {}) {
  const nextFailures = new Set(current?.failedDomains || []);
  const nextDetails = { ...(current?.failureDetails || {}) };
  attemptedDomains.filter(Boolean).forEach(domain => nextFailures.delete(domain));
  attemptedDomains.filter(Boolean).forEach(domain => delete nextDetails[domain]);
  failedDomains.filter(Boolean).forEach(domain => nextFailures.add(domain));
  failedDomains.filter(Boolean).forEach(domain => {
    nextDetails[domain] = failureDetails[domain] || nextDetails[domain] || { code: '' };
  });
  const uniqueFailures = [...nextFailures];

  return Object.freeze({
    status: uniqueFailures.length > 0 ? 'degraded' : 'healthy',
    failedDomains: uniqueFailures,
    failureDetails: Object.freeze(nextDetails)
  });
}
