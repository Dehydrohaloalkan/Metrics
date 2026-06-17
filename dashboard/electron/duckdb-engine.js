'use strict';

/**
 * DuckDB-backed analytics engine. Reads the CSV straight off disk (out-of-core,
 * columnar, vectorised) so 2 GB / 10M-row files load without blowing the V8
 * string limit or the renderer heap. All aggregation runs here as SQL; the
 * renderer only ever receives small result sets (chart buckets, a table page).
 *
 * Lives in the Electron main process. The native @duckdb/node-api addon is
 * N-API based, so it loads in Electron without a rebuild (verified on E42).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const UNGROUPED = '__ungrouped__';
const ERROR_LEVELS = ['error', 'fatal', 'critical', 'crit', 'err', 'severe'];
const WARN_LEVELS = ['warn', 'warning'];

// SQL string literal escaping for inlined file paths (read_csv can't bind params).
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Convert any BigInt the bindings hand back into a Number for JSON/IPC.
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
function plain(rows) {
  return rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r)) o[k] = num(r[k]);
    return o;
  });
}

// date_trunc unit + label SQL per granularity. `label` is written in terms of
// the bucket-timestamp alias `b` (Monday-based weeks match the old bucketKey).
const GRAN = {
  second: { unit: 'second', label: "strftime(b, '%d.%m %H:%M:%S')" },
  minute: { unit: 'minute', label: "strftime(b, '%d.%m %H:%M')" },
  hour: { unit: 'hour', label: "strftime(b, '%d.%m %H:00')" },
  day: { unit: 'day', label: "strftime(b, '%d.%m.%Y')" },
  week: { unit: 'week', label: "'нед ' || strftime(b, '%d.%m')" },
  month: { unit: 'month', label: "strftime(b, '%m.%Y')" },
};

class DuckEngine {
  constructor() {
    this.instance = null;
    this.conn = null;
    this.dbPath = null;
    this.hasData = false;
    this.hasMembers = false;
    this.hasGroupMap = false;
  }

  async init() {
    if (this.conn) return;
    const { DuckDBInstance } = require('@duckdb/node-api');
    // On-disk temp DB so huge tables can spill past RAM.
    this.dbPath = path.join(os.tmpdir(), `metrics-${process.pid}.duckdb`);
    try {
      fs.rmSync(this.dbPath, { force: true });
    } catch {
      /* ignore */
    }
    this.instance = await DuckDBInstance.create(this.dbPath);
    this.conn = await this.instance.connect();
    // Be generous with threads; DuckDB clamps to available cores.
    await this.conn.run(`PRAGMA threads=${Math.max(2, os.cpus().length)}`);
  }

  async setTimezone(tz) {
    if (!tz) return;
    try {
      await this.conn.run(`SET TimeZone=${lit(tz)}`);
    } catch {
      /* invalid tz — fall back to default */
    }
  }

  async all(sql) {
    const reader = await this.conn.runAndReadAll(sql);
    return plain(reader.getRowObjects());
  }
  async one(sql) {
    return (await this.all(sql))[0] || null;
  }

  // ---- loading -----------------------------------------------------------
  async loadCsv(csvPath) {
    await this.init();
    const httpInt = `try_cast(cd_http_status AS INTEGER)`;
    await this.conn.run(`
      CREATE OR REPLACE TABLE logs AS
      SELECT
        coalesce(id_service_log, '') AS id,
        coalesce(nullif(cd_service, ''), '—') AS service,
        dt_tm_event AS date_raw,
        try_cast(regexp_replace(dt_tm_event, '([+-]\\d{2})$', '\\1:00') AS TIMESTAMPTZ) AS ts,
        coalesce(nullif(level, ''), '—') AS level,
        lower(coalesce(level, '')) AS level_norm,
        coalesce(logger, '') AS logger,
        coalesce(message, '') AS message,
        coalesce(nullif(ip_requester, ''), '—') AS ip,
        coalesce(stack_trace, '') AS stack_trace,
        coalesce(exception, '') AS exception,
        coalesce(url, '') AS url,
        rtrim(regexp_replace(coalesce(url, ''), '^[a-z]+://[^/]+', ''), '/') AS url_path,
        coalesce(nullif(nr_dic, ''), '—') AS nr_dic,
        coalesce(cd_dic_status, '') AS dic_status,
        coalesce(nullif(cd_http_status, ''), '—') AS http_status,
        ${httpInt} AS http_code,
        CASE
          WHEN ${httpInt} IS NULL OR ${httpInt} <= 0 THEN '—'
          WHEN ${httpInt} < 200 THEN '1xx'
          WHEN ${httpInt} < 300 THEN '2xx'
          WHEN ${httpInt} < 400 THEN '3xx'
          WHEN ${httpInt} < 500 THEN '4xx'
          ELSE '5xx'
        END AS status_class,
        (lower(coalesce(level, '')) IN (${ERROR_LEVELS.map(lit).join(',')})
          OR coalesce(${httpInt}, 0) >= 400) AS is_error
      FROM read_csv(${lit(csvPath)}, header=true, all_varchar=true,
                    quote='"', escape='"', strict_mode=false, ignore_errors=true);
    `);
    this.hasData = true;
  }

  async loadMembers(membersPath) {
    await this.init();
    // Mirror the renderer's tolerant parser: split on comma, strip quotes/space.
    await this.conn.run(`
      CREATE OR REPLACE TABLE members AS
      SELECT trim(both '"' from trim(column0)) AS ip,
             trim(both '"' from trim(column1)) AS name
      FROM read_csv(${lit(membersPath)}, header=false, all_varchar=true,
                    quote='', skip=1, ignore_errors=true)
      WHERE lower(trim(both '"' from trim(column0))) <> 'ip'
        AND nullif(trim(both '"' from trim(column1)), '') IS NOT NULL;
    `);
    this.hasMembers = true;
  }

  async setGroups(groups) {
    await this.init();
    // Flatten {id, members[]} into an ip→gid lookup. First group wins per ip.
    const rows = [];
    const seen = new Set();
    for (const g of groups || []) {
      for (const ip of g.members || []) {
        if (seen.has(ip)) continue;
        seen.add(ip);
        rows.push(`(${lit(ip)}, ${lit(g.id)})`);
      }
    }
    await this.conn.run(`CREATE OR REPLACE TEMP TABLE group_map (ip VARCHAR, gid VARCHAR)`);
    if (rows.length) {
      await this.conn.run(`INSERT INTO group_map VALUES ${rows.join(',')}`);
    }
    this.hasGroupMap = true;
  }

  // ---- metadata (distinct option lists + range), computed once on load ----
  async meta() {
    if (!this.hasData) return null;
    const range = await this.one(
      `SELECT epoch_ms(min(ts)) AS min, epoch_ms(max(ts)) AS max FROM logs WHERE ts IS NOT NULL`,
    );
    const distinctVals = async (col, where = '') =>
      (await this.all(`SELECT DISTINCT ${col} AS v FROM logs ${where} ORDER BY v`)).map((r) => r.v);
    return {
      rows: (await this.one(`SELECT count(*) AS n FROM logs`)).n,
      range: range && range.min != null ? { min: range.min, max: range.max } : null,
      levels: await distinctVals('level', `WHERE level <> ''`),
      statusClasses: await distinctVals('status_class'),
      services: await distinctVals('service'),
      endpoints: await distinctVals('nr_dic'),
      dicStatuses: await distinctVals('dic_status', `WHERE dic_status <> '' AND dic_status <> '—'`),
      allSources: await this.all(
        `SELECT ip AS key, count(*) AS count FROM logs WHERE ip <> '—' GROUP BY ip ORDER BY count DESC`,
      ),
    };
  }

  // ---- filtering: materialise the current selection once into `cur` -------
  _whereClause(f) {
    const c = [];
    const inList = (col, arr) =>
      arr && arr.length ? c.push(`${col} IN (${arr.map(lit).join(',')})`) : null;
    if (f.dateFrom != null) c.push(`(ts IS NOT NULL AND epoch_ms(ts) >= ${Number(f.dateFrom)})`);
    if (f.dateTo != null) c.push(`(ts IS NOT NULL AND epoch_ms(ts) <= ${Number(f.dateTo)})`);
    inList('level', f.levels);
    inList('status_class', f.statusClasses);
    if (f.service) c.push(`service = ${lit(f.service)}`);
    inList('nr_dic', f.endpoints);
    inList('dic_status', f.dicStatuses);
    if (f.groupFilter) c.push(`coalesce(gm.gid, ${lit(UNGROUPED)}) = ${lit(f.groupFilter)}`);
    if (f.onlyErrors) c.push(`is_error`);
    const like = (expr, q) => c.push(`lower(${expr}) LIKE ${lit('%' + String(q).toLowerCase() + '%')}`);
    if (f.ipQuery && f.ipQuery.trim()) like('l.ip', f.ipQuery.trim());
    if (f.nameQuery && f.nameQuery.trim()) like(`coalesce(m.name, '')`, f.nameQuery.trim());
    if (f.textQuery && f.textQuery.trim())
      like(`concat_ws(' ', l.message, l.url, l.exception, l.logger, l.nr_dic)`, f.textQuery.trim());
    return c.length ? `WHERE ${c.join(' AND ')}` : '';
  }

  async applyFilter(filter) {
    if (!this.hasData) return { total: 0 };
    if (!this.hasGroupMap) await this.setGroups([]);
    const memberJoin = this.hasMembers ? `LEFT JOIN members m ON m.ip = l.ip` : '';
    const nameExpr = this.hasMembers ? `m.name` : `CAST(NULL AS VARCHAR)`;
    await this.conn.run(`
      CREATE OR REPLACE TEMP TABLE cur AS
      SELECT l.*, coalesce(gm.gid, ${lit(UNGROUPED)}) AS group_id, ${nameExpr} AS member_name
      FROM logs l
      LEFT JOIN group_map gm ON gm.ip = l.ip
      ${memberJoin}
      ${this._whereClause(filter)};
    `);
    return { total: (await this.one(`SELECT count(*) AS n FROM cur`)).n };
  }

  // ---- aggregations over `cur` -------------------------------------------
  _bucketExpr(gran) {
    const g = GRAN[gran] || GRAN.day;
    return { bucket: `date_trunc('${g.unit}', ts)`, label: g.label };
  }

  async kpis() {
    const k = await this.one(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE is_error) AS errors,
             count(*) FILTER (WHERE level_norm IN (${WARN_LEVELS.map(lit).join(',')})) AS warnings,
             count(*) FILTER (WHERE http_code > 0) AS with_code,
             count(*) FILTER (WHERE status_class = '2xx') AS ok2xx,
             count(DISTINCT ip) FILTER (WHERE ip <> '—') AS unique_ips,
             count(DISTINCT nr_dic) FILTER (WHERE nr_dic <> '—') AS unique_endpoints,
             epoch_ms(min(ts)) AS min_ts, epoch_ms(max(ts)) AS max_ts
      FROM cur`);
    const total = k.total || 0;
    const spanH = k.max_ts != null && k.min_ts != null ? (k.max_ts - k.min_ts) / 36e5 : 0;
    return {
      total,
      errors: k.errors || 0,
      warnings: k.warnings || 0,
      errorRate: total ? (k.errors / total) * 100 : 0,
      successRate: k.with_code ? (k.ok2xx / k.with_code) * 100 : 0,
      uniqueIps: k.unique_ips || 0,
      uniqueEndpoints: k.unique_endpoints || 0,
      perHour: spanH > 0 ? total / spanH : 0,
      from: k.min_ts ?? null,
      to: k.max_ts ?? null,
    };
  }

  async timeSeries(gran) {
    const { bucket, label } = this._bucketExpr(gran);
    return this.all(`
      SELECT ${label} AS label, epoch_ms(b) AS start, total, errors
      FROM (
        SELECT b, count(*) AS total, count(*) FILTER (WHERE is_error) AS errors
        FROM (SELECT ${bucket} AS b, is_error FROM cur WHERE ts IS NOT NULL)
        GROUP BY b
      ) ORDER BY b`);
  }

  async countBy(col, { limit = 0, where = '' } = {}) {
    return this.all(`
      SELECT ${col} AS key, count(*) AS count, count(*) FILTER (WHERE is_error) AS errors
      FROM cur ${where} GROUP BY ${col} ORDER BY count DESC ${limit > 0 ? `LIMIT ${limit}` : ''}`);
  }

  // Pivot long rows [{key, b, c}] into {labels, starts, series:[{key, data[]}]}.
  _pivot(rows, keyField, orderKeys) {
    const startSet = new Set();
    for (const r of rows) startSet.add(Number(r.b));
    const starts = [...startSet].sort((a, b) => a - b);
    const idx = new Map(starts.map((s, i) => [s, i]));
    const byKey = new Map();
    const labelOf = new Map();
    for (const r of rows) {
      const k = r[keyField];
      if (!byKey.has(k)) byKey.set(k, new Array(starts.length).fill(0));
      byKey.get(k)[idx.get(Number(r.b))] = Number(r.c);
      labelOf.set(Number(r.b), r.label);
    }
    const labels = starts.map((s) => labelOf.get(s) ?? '');
    const keys = orderKeys ? orderKeys.filter((k) => byKey.has(k)) : [...byKey.keys()];
    return { labels, starts, byKey, keys };
  }

  async _bucketRows(gran, extraCol, where = '') {
    const { bucket, label } = this._bucketExpr(gran);
    return this.all(`
      SELECT ${extraCol} AS key, epoch_ms(b) AS b, ${label} AS label, c FROM (
        SELECT ${extraCol} AS ${extraCol}, ${bucket} AS b, count(*) AS c
        FROM cur WHERE ts IS NOT NULL ${where ? 'AND ' + where : ''} GROUP BY 1, 2
      ) ORDER BY b`);
  }

  async byGroup() {
    return this.all(`
      SELECT group_id AS key, count(*) AS count, count(*) FILTER (WHERE is_error) AS errors
      FROM cur GROUP BY group_id ORDER BY count DESC`);
  }

  async groupStats() {
    return this.all(`
      WITH g AS (
        SELECT group_id,
               count(*) AS count,
               count(*) FILTER (WHERE is_error) AS errors,
               count(DISTINCT ip) FILTER (WHERE ip <> '—') AS sources
        FROM cur GROUP BY group_id
      ), te AS (
        SELECT group_id, nr_dic,
               row_number() OVER (PARTITION BY group_id ORDER BY count(*) DESC) AS rn
        FROM cur WHERE nr_dic <> '—' GROUP BY group_id, nr_dic
      )
      SELECT g.group_id AS id, g.count, g.errors, g.sources,
             coalesce((SELECT nr_dic FROM te WHERE te.group_id = g.group_id AND rn = 1), '—') AS topEndpoint
      FROM g ORDER BY g.count DESC`);
  }

  async memberStats() {
    return this.all(`
      WITH m AS (
        SELECT ip,
               count(*) AS count,
               count(*) FILTER (WHERE is_error) AS errors
        FROM cur WHERE ip <> '—' GROUP BY ip
      ), te AS (
        SELECT ip, nr_dic,
               row_number() OVER (PARTITION BY ip ORDER BY count(*) DESC) AS rn
        FROM cur WHERE nr_dic <> '—' AND ip <> '—' GROUP BY ip, nr_dic
      )
      SELECT m.ip, m.count, m.errors,
             coalesce((SELECT nr_dic FROM te WHERE te.ip = m.ip AND rn = 1), '—') AS topEndpoint
      FROM m ORDER BY m.count DESC`);
  }

  async groupTimeSeries(gran) {
    const rows = await this._bucketRows(gran, 'group_id');
    const { labels, starts, byKey } = this._pivot(rows, 'key');
    const series = [...byKey.entries()]
      .map(([id, data]) => ({ id, data, total: data.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total);
    return { labels, starts, series };
  }

  async statusTrend(gran) {
    const rows = await this._bucketRows(gran, 'status_class');
    const order = ['2xx', '3xx', '4xx', '5xx', '1xx', '—'];
    const { labels, starts, byKey } = this._pivot(rows, 'key', order);
    const series = order
      .filter((k) => byKey.has(k))
      .map((key) => ({ key, data: byKey.get(key) }))
      .filter((s) => s.data.some((v) => v > 0));
    return { labels, starts, series };
  }

  async endpointTimeSeries(gran, limit) {
    const topN = limit > 0 ? limit : 1e9;
    const top = (
      await this.all(
        `SELECT nr_dic AS k FROM cur WHERE nr_dic <> '—' GROUP BY nr_dic ORDER BY count(*) DESC LIMIT ${topN}`,
      )
    ).map((r) => r.k);
    if (!top.length) return { labels: [], starts: [], series: [] };
    const rows = await this._bucketRows(gran, 'nr_dic', `nr_dic IN (${top.map(lit).join(',')})`);
    const { labels, starts, byKey } = this._pivot(rows, 'key', top);
    const series = top
      .filter((k) => byKey.has(k))
      .map((id) => ({ id, data: byKey.get(id), total: byKey.get(id).reduce((a, b) => a + b, 0) }));
    return { labels, starts, series };
  }

  async dicStatusTrend(gran) {
    const top = (
      await this.all(
        `SELECT dic_status AS k FROM cur WHERE dic_status <> '' AND dic_status <> '—'
         GROUP BY dic_status ORDER BY count(*) DESC LIMIT 6`,
      )
    ).map((r) => r.k);
    if (!top.length) return { labels: [], starts: [], series: [] };
    const rows = await this._bucketRows(gran, 'dic_status', `dic_status IN (${top.map(lit).join(',')})`);
    const { labels, starts, byKey } = this._pivot(rows, 'key', top);
    const series = top.filter((k) => byKey.has(k)).map((key) => ({ key, data: byKey.get(key) }));
    return { labels, starts, series };
  }

  async sourcePareto() {
    const points = await this.all(`
      WITH s AS (SELECT ip, count(*) AS c FROM cur WHERE ip <> '—' GROUP BY ip),
           tot AS (SELECT sum(c) AS t FROM s)
      SELECT ip AS raw, c AS count,
             sum(c) OVER (ORDER BY c DESC ROWS UNBOUNDED PRECEDING) * 100.0 / (SELECT t FROM tot) AS cumPct
      FROM s ORDER BY c DESC LIMIT 20`);
    const total = await this.one(`SELECT coalesce(sum(c), 0) AS t FROM (SELECT count(*) AS c FROM cur WHERE ip <> '—' GROUP BY ip)`);
    return { points, total: total.t };
  }

  async graph() {
    const sources = await this.all(`
      SELECT ip AS id, count(*) AS count FROM cur WHERE NOT (ip = '—' AND nr_dic = '—')
      GROUP BY ip ORDER BY count DESC LIMIT 18`);
    const endpoints = await this.all(`
      SELECT nr_dic AS id, count(*) AS count FROM cur WHERE NOT (ip = '—' AND nr_dic = '—')
      GROUP BY nr_dic ORDER BY count DESC LIMIT 14`);
    const srcIn = sources.map((s) => lit(s.id)).join(',') || "''";
    const epIn = endpoints.map((e) => lit(e.id)).join(',') || "''";
    const links = await this.all(`
      SELECT ip, nr_dic AS ep, count(*) AS value FROM cur
      WHERE ip IN (${srcIn}) AND nr_dic IN (${epIn}) GROUP BY ip, nr_dic`);
    return { sources, endpoints, links };
  }

  async heatmap(bucketMin) {
    const bm = bucketMin || 60;
    const cells = await this.all(`
      SELECT (isodow(ts) - 1) AS day, ((hour(ts) * 60 + minute(ts)) // ${bm}) AS col, count(*) AS c
      FROM cur WHERE ts IS NOT NULL GROUP BY 1, 2`);
    const agg = await this.one(`
      SELECT count(*) AS grand FROM cur WHERE ts IS NOT NULL`);
    return { cells, bucketMin: bm, grandTotal: agg.grand };
  }

  async bySource() {
    return this.all(`
      SELECT ip AS key, count(*) AS count, count(*) FILTER (WHERE is_error) AS errors
      FROM cur WHERE ip <> '—' GROUP BY ip ORDER BY count DESC`);
  }

  async sourceEndpoints(ip) {
    if (!ip) return [];
    return this.all(`
      SELECT nr_dic AS key, count(*) AS count, count(*) FILTER (WHERE is_error) AS errors
      FROM cur WHERE ip = ${lit(ip)} GROUP BY nr_dic ORDER BY count DESC`);
  }

  async topExceptions() {
    return this.all(`
      SELECT left(trim(split_part(exception, chr(10), 1)), 80) AS key,
             count(*) AS count, count(*) FILTER (WHERE is_error) AS errors
      FROM cur WHERE exception <> '' GROUP BY 1 ORDER BY count DESC LIMIT 10`);
  }

  // The smallest aggregates needed by the renderer's insights panel.
  async errorTops() {
    const ip = await this.one(`
      SELECT ip AS key, count(*) AS count FROM cur WHERE is_error GROUP BY ip ORDER BY count DESC LIMIT 1`);
    const ep = await this.one(`
      SELECT nr_dic AS key, count(*) AS count FROM cur WHERE is_error GROUP BY nr_dic ORDER BY count DESC LIMIT 1`);
    return { ip, ep };
  }

  // --- detail table: a single sorted page (never the whole set) -----------
  async page(sortKey, dir, offset, limit) {
    const col =
      { date: 'ts', level: 'level', service: 'service', nrDic: 'nr_dic', httpCode: 'http_code', ip: 'ip' }[
        sortKey
      ] || 'ts';
    const d = dir === 'asc' ? 'ASC' : 'DESC';
    return this.all(`
      SELECT id, service, date_raw, epoch_ms(ts) AS ts, level, level_norm, logger, message, ip,
             member_name, stack_trace, exception, url, url_path, nr_dic, dic_status, http_status,
             http_code, status_class, is_error
      FROM cur ORDER BY ${col} ${d} NULLS LAST LIMIT ${Number(limit)} OFFSET ${Number(offset)}`);
  }

  // Mirror the renderer's auto-granularity thresholds, measured over `cur`.
  async effectiveGranularity(setting) {
    if (setting && setting !== 'auto') return setting;
    const r = await this.one(`SELECT epoch_ms(min(ts)) AS a, epoch_ms(max(ts)) AS b FROM cur WHERE ts IS NOT NULL`);
    if (!r || r.a == null) return 'day';
    const ms = r.b - r.a;
    const min = 60e3;
    if (ms <= 2 * min) return 'second';
    if (ms <= 180 * min) return 'minute';
    if (ms <= 3 * 864e5) return 'hour';
    if (ms <= 120 * 864e5) return 'day';
    if (ms <= 730 * 864e5) return 'week';
    return 'month';
  }

  // One round-trip: every chart dataset + the requested table page, computed
  // over the already-materialised `cur`.
  async dashboard(opts = {}) {
    const o = opts || {};
    const gran = await this.effectiveGranularity(o.granularity);
    const url = `coalesce(nullif(url_path, ''), url)`;
    const [
      kpis, timeSeries, byLevel, byStatusClass, byService, byEndpoint, topEndpoints, topUrls,
      topIps, topExceptions, topHttpCodes, byDicStatus, topDicStatus, byGroup, groupStats,
      memberStats, groupTimeSeries, statusTrend, endpointTimeSeries, dicStatusTrend, sourcePareto,
      graph, heatmap, bySource, sourceEndpoints, errorTops, page,
    ] = await Promise.all([
      this.kpis(),
      this.timeSeries(gran),
      this.countBy('level'),
      this.countBy('status_class'),
      this.countBy('service'),
      this.countBy('nr_dic'),
      this.countBy('nr_dic', { limit: o.endpointsLimit ?? 15 }),
      this.countBy(url, { limit: o.urlsLimit ?? 15 }),
      this.countBy('ip', { limit: o.ipsLimit ?? 15 }),
      this.topExceptions(),
      this.countBy('http_status', { where: `WHERE http_status <> '—'` }),
      this.countBy('dic_status', { where: `WHERE dic_status <> '' AND dic_status <> '—'` }),
      this.countBy('dic_status', { limit: 14, where: `WHERE dic_status <> '' AND dic_status <> '—'` }),
      this.byGroup(),
      this.groupStats(),
      this.memberStats(),
      this.groupTimeSeries(gran),
      this.statusTrend(gran),
      this.endpointTimeSeries(gran, o.endpointTrendLimit ?? 10),
      this.dicStatusTrend(gran),
      this.sourcePareto(),
      this.graph(),
      this.heatmap(o.heatmapBucketMin ?? 60),
      this.bySource(),
      this.sourceEndpoints(o.selectedSource || (await this._topSourceIp())),
      this.errorTops(),
      this.page(o.sort?.key || 'date', o.sort?.dir || 'desc', (o.page || 0) * (o.pageSize || 50), o.pageSize || 50),
    ]);
    return {
      effectiveGranularity: gran,
      kpis, timeSeries, byLevel, byStatusClass, byService, byEndpoint, topEndpoints, topUrls,
      topIps, topExceptions, topHttpCodes, byDicStatus, topDicStatus, byGroup, groupStats,
      memberStats, groupTimeSeries, statusTrend, endpointTimeSeries, dicStatusTrend, sourcePareto,
      graph, heatmap, bySource, sourceEndpoints, errorTops, page,
    };
  }

  async _topSourceIp() {
    const r = await this.one(`SELECT ip FROM cur WHERE ip <> '—' GROUP BY ip ORDER BY count(*) DESC LIMIT 1`);
    return r ? r.ip : '';
  }

  async exportCsv(dest) {
    await this.conn.run(`
      COPY (
        SELECT id AS id_service_log, service AS cd_service, date_raw AS dt_tm_event, level, logger,
               message, ip AS ip_requester, coalesce(member_name, '') AS requester_name, exception,
               url, nr_dic, dic_status AS cd_dic_status, http_status AS cd_http_status
        FROM cur
      ) TO ${lit(dest)} (FORMAT CSV, HEADER)`);
    return { ok: true, path: dest };
  }
}

module.exports = { DuckEngine, UNGROUPED };
