export interface LogRow {
  id: string;
  service: string;
  dateRaw: string;
  date: Date | null;
  ts: number; // epoch ms, or NaN when unparseable
  level: string;
  levelNorm: string; // lowercased
  logger: string;
  message: string;
  ip: string;
  stackTrace: string;
  exception: string;
  url: string;
  urlPath: string;
  nrDic: string;
  dicStatus: string;
  httpStatus: string;
  httpCode: number; // NaN when not numeric
  statusClass: string; // '2xx' | '4xx' | ... | '—'
  isError: boolean;
}

export interface SourceInfo {
  name: string;
  path: string;
  rows: number;
}

export const ERROR_LEVELS = new Set(['error', 'fatal', 'critical', 'crit', 'err', 'severe']);
export const WARN_LEVELS = new Set(['warn', 'warning']);

/** Parse the service timestamp `2026-04-08 11:04:53.2443+03` into a Date. */
export function parseLogDate(raw: string): Date | null {
  if (!raw) return null;
  let t = raw.trim().replace(' ', 'T');
  // Normalize trailing timezone offset: +03 -> +03:00, +0300 -> +03:00
  t = t.replace(/([+-]\d{2})(\d{2})?$/, (_m, h: string, mm?: string) => `${h}:${mm ?? '00'}`);
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function statusClassOf(code: number): string {
  if (isNaN(code) || code <= 0) return '—';
  if (code < 200) return '1xx';
  if (code < 300) return '2xx';
  if (code < 400) return '3xx';
  if (code < 500) return '4xx';
  return '5xx';
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

function pathOf(url: string): string {
  if (!url) return '';
  try {
    return stripTrailingSlash(new URL(url).pathname || url);
  } catch {
    const m = url.match(/^[a-z]+:\/\/[^/]+(\/.*)$/i);
    return stripTrailingSlash(m ? m[1] : url);
  }
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v).trim();
  }
  return '';
}

/** Map a raw CSV record (header → value) into a typed LogRow. */
export function toLogRow(row: Record<string, string>): LogRow {
  const dateRaw = pick(row, 'dt_tm_event', 'date', 'timestamp', 'time');
  const date = parseLogDate(dateRaw);
  const level = pick(row, 'level', 'log_level', 'severity') || '—';
  const httpStatus = pick(row, 'cd_http_status', 'http_status', 'status');
  const httpCode = parseInt(httpStatus, 10);
  const levelNorm = level.toLowerCase();
  const url = pick(row, 'url');

  return {
    id: pick(row, 'id_service_log', 'id'),
    service: pick(row, 'cd_service', 'service') || '—',
    dateRaw,
    date,
    ts: date ? date.getTime() : NaN,
    level,
    levelNorm,
    logger: pick(row, 'logger'),
    message: pick(row, 'message', 'msg'),
    ip: pick(row, 'ip_requester', 'ip', 'remote_ip') || '—',
    stackTrace: pick(row, 'stack_trace', 'stacktrace'),
    exception: pick(row, 'exception', 'error'),
    url,
    urlPath: pathOf(url),
    nrDic: pick(row, 'nr_dic') || '—',
    dicStatus: pick(row, 'cd_dic_status'),
    httpStatus: httpStatus || '—',
    httpCode,
    statusClass: statusClassOf(httpCode),
    isError: ERROR_LEVELS.has(levelNorm) || (!isNaN(httpCode) && httpCode >= 400),
  };
}
