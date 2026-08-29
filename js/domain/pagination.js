export async function collectAllPages(loadPage, pageSize = 1000) {
  const allData = [];
  let offset = 0;
  let expectedTotal = null;

  while (expectedTotal === null || offset < expectedTotal) {
    const page = await loadPage(offset, offset + pageSize - 1);
    if (page?.error) throw page.error;

    const data = Array.isArray(page?.data) ? page.data : [];
    if (Number.isFinite(page?.count)) expectedTotal = page.count;
    if (data.length === 0) break;

    allData.push(...data);
    offset += data.length;
  }

  return allData;
}
