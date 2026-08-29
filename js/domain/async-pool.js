export async function mapWithConcurrency(items, mapper, options = {}) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];

  const requestedLimit = Number(options.limit);
  const limit = Math.max(1, Math.min(source.length, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 1));
  const results = new Array(source.length);
  let nextIndex = 0;
  let completed = 0;
  let firstError = null;
  let stopped = false;

  const worker = async () => {
    while (!stopped && nextIndex < source.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(source[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        stopped = true;
        return;
      }
      completed += 1;
      if (typeof options.onProgress === 'function') {
        options.onProgress({ completed, total: source.length, item: source[index], index });
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError) throw firstError;
  return results;
}
