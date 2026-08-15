// Excel cells accept at most 32,767 UTF-16 characters. Keep a safety margin
// because SheetJS and Excel both validate the final shared-string value.
export const EXCEL_SAFE_CELL_LENGTH = 30000;
export const BACKUP_CHUNK_MANIFEST_COLUMN = '__backup_chunk_manifest__';
const BACKUP_CHUNK_PREFIX = '__backup_chunk_';

function chunkColumnName(field, partNumber) {
  return `${BACKUP_CHUNK_PREFIX}${encodeURIComponent(field)}_${String(partNumber).padStart(4, '0')}`;
}

function normalizeCellValue(value) {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return value;
}

export function serializeBackupRows(rows) {
  return (rows || []).map(row => {
    if (Object.prototype.hasOwnProperty.call(row, BACKUP_CHUNK_MANIFEST_COLUMN)) {
      throw new Error(`Cột dữ liệu trùng tên dành riêng: ${BACKUP_CHUNK_MANIFEST_COLUMN}`);
    }

    const output = {};
    const chunkManifest = [];

    Object.entries(row).forEach(([field, rawValue]) => {
      const value = normalizeCellValue(rawValue);
      if (typeof value !== 'string' || value.length <= EXCEL_SAFE_CELL_LENGTH) {
        output[field] = value;
        return;
      }

      const parts = [];
      for (let offset = 0; offset < value.length; offset += EXCEL_SAFE_CELL_LENGTH) {
        parts.push(value.slice(offset, offset + EXCEL_SAFE_CELL_LENGTH));
      }

      output[field] = parts[0];
      for (let index = 1; index < parts.length; index += 1) {
        const chunkField = chunkColumnName(field, index + 1);
        if (Object.prototype.hasOwnProperty.call(row, chunkField)) {
          throw new Error(`Cột dữ liệu trùng tên phần sao lưu: ${chunkField}`);
        }
        output[chunkField] = parts[index];
      }
      chunkManifest.push([field, parts.length]);
    });

    if (chunkManifest.length > 0) {
      output[BACKUP_CHUNK_MANIFEST_COLUMN] = JSON.stringify(chunkManifest);
    }
    return output;
  });
}

export function deserializeBackupRows(rows) {
  return (rows || []).map(row => {
    const output = { ...row };
    const rawManifest = output[BACKUP_CHUNK_MANIFEST_COLUMN];
    if (!rawManifest) return output;

    let manifest;
    try {
      manifest = JSON.parse(String(rawManifest));
    } catch {
      throw new Error('Manifest chia nhỏ ô Excel không hợp lệ');
    }
    if (!Array.isArray(manifest)) throw new Error('Manifest chia nhỏ ô Excel không hợp lệ');

    manifest.forEach(entry => {
      const [field, partCount] = Array.isArray(entry) ? entry : [];
      if (typeof field !== 'string' || !Number.isInteger(partCount) || partCount < 2) {
        throw new Error('Thông tin phần dữ liệu Excel không hợp lệ');
      }

      let value = String(output[field] ?? '');
      for (let partNumber = 2; partNumber <= partCount; partNumber += 1) {
        const chunkField = chunkColumnName(field, partNumber);
        if (!Object.prototype.hasOwnProperty.call(output, chunkField)) {
          throw new Error(`Thiếu phần ${partNumber}/${partCount} của trường ${field}`);
        }
        value += String(output[chunkField] ?? '');
        delete output[chunkField];
      }
      output[field] = value;
    });

    delete output[BACKUP_CHUNK_MANIFEST_COLUMN];
    return output;
  });
}
