export async function collectAllPages(loadPage, pageSize = 1000, { getRowKey = row => row?.id } = {}) {
  const normalizedPageSize = Number(pageSize);
  if (!Number.isInteger(normalizedPageSize) || normalizedPageSize < 1) {
    throw new RangeError('Pagination page size must be a positive integer.');
  }

  const allData = [];
  const seenRowKeys = new Set();
  let offset = 0;
  let expectedTotal = null;

  while (expectedTotal === null || offset < expectedTotal) {
    const page = await loadPage(offset, offset + normalizedPageSize - 1);
    if (page?.error) throw page.error;

    const data = Array.isArray(page?.data) ? page.data : [];
    if (data.length > normalizedPageSize) {
      throw new Error(`Pagination returned ${data.length} rows for a ${normalizedPageSize}-row page.`);
    }

    if (Number.isFinite(page?.count)) {
      if (expectedTotal !== null && expectedTotal !== page.count) {
        const error = new Error(`Pagination total changed during read (${expectedTotal} → ${page.count}); retry the read.`);
        error.code = 'PAGINATION_TOTAL_CHANGED';
        throw error;
      }
      expectedTotal = page.count;
    }

    if (data.length === 0) {
      if (expectedTotal !== null && offset < expectedTotal) {
        const error = new Error(`Pagination ended after ${offset} of ${expectedTotal} rows; the result is incomplete.`);
        error.code = 'PAGINATION_INCOMPLETE';
        error.expectedRows = expectedTotal;
        error.loadedRows = offset;
        throw error;
      }
      break;
    }

    if (expectedTotal !== null && offset + data.length > expectedTotal) {
      const error = new Error(`Pagination returned more than the reported total (${expectedTotal} rows); retry the read.`);
      error.code = 'PAGINATION_TOTAL_CHANGED';
      throw error;
    }

    for (const row of data) {
      const rowKey = getRowKey?.(row);
      if (rowKey === undefined || rowKey === null || rowKey === '') continue;
      const normalizedKey = String(rowKey);
      if (seenRowKeys.has(normalizedKey)) {
        const error = new Error(`Pagination returned duplicate row key "${normalizedKey}"; the result may have shifted during read.`);
        error.code = 'PAGINATION_DUPLICATE_ROW';
        error.rowKey = normalizedKey;
        throw error;
      }
      seenRowKeys.add(normalizedKey);
    }

    allData.push(...data);
    offset += data.length;
  }

  return allData;
}
