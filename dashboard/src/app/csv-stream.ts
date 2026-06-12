import { LogRow, toLogRow } from './models';

const macrotask = () => new Promise<void>((r) => setTimeout(r));

/**
 * Streaming, time-sliced CSV parser. Handles quoted fields, escaped quotes
 * (`""`) and embedded newlines. Yields to the event loop periodically so the
 * UI stays responsive on very large files (hundreds of MB), reporting progress
 * as a 0..1 fraction of bytes consumed.
 */
export async function parseCsvStream(
  text: string,
  onProgress: (pct: number, rows: number) => void,
): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  const N = text.length;
  let i = 0;
  let headers: string[] | null = null;
  let record: string[] = [];
  let rowCounter = 0;
  let lastYield = performance.now();

  const finishRecord = () => {
    if (headers === null) {
      headers = record.map((h) => h.trim().replace(/^"|"$/g, ''));
    } else if (record.length > 1 || record[0] !== '') {
      const obj: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c]] = record[c] ?? '';
      const lr = toLogRow(obj);
      if (lr.id || lr.dateRaw || lr.message) rows.push(lr);
    }
    record = [];
  };

  while (i < N) {
    // --- read one field ---
    if (text.charCodeAt(i) === 34 /* " */) {
      i++;
      let buf = '';
      while (i < N) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          buf += text.slice(i);
          i = N;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          buf += text.slice(i, q + 1); // collapse "" -> "
          i = q + 2;
        } else {
          buf += text.slice(i, q);
          i = q + 1;
          break;
        }
      }
      record.push(buf);
    } else {
      let j = i;
      while (j < N) {
        const ch = text.charCodeAt(j);
        if (ch === 44 || ch === 10 || ch === 13) break; // , \n \r
        j++;
      }
      record.push(text.slice(i, j));
      i = j;
    }

    // --- handle delimiter / line break / EOF ---
    if (i >= N) {
      finishRecord();
      break;
    }
    const ch = text.charCodeAt(i);
    if (ch === 44) {
      i++; // comma -> next field
    } else if (ch === 13 || ch === 10) {
      finishRecord();
      i += ch === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      if ((++rowCounter & 16383) === 0) {
        const now = performance.now();
        if (now - lastYield > 30) {
          onProgress(i / N, rows.length);
          await macrotask();
          lastYield = performance.now();
        }
      }
    } else {
      i++; // stray char after a quoted field
    }
  }

  onProgress(1, rows.length);
  return rows;
}
