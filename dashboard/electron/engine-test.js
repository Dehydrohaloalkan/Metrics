const { app } = require('electron');
const path = require('path');
const { DuckEngine } = require('./duckdb-engine');

app.whenReady().then(async () => {
  try {
    const eng = new DuckEngine();
    await eng.init();
    await eng.setTimezone('Europe/Moscow');
    await eng.loadCsv(path.join(__dirname, '..', 'data.csv'));
    await eng.loadMembers(path.join(__dirname, '..', 'members.csv'));
    await eng.setGroups([{ id: 'g1', members: ['127.0.0.1'] }]);

    const meta = await eng.meta();
    console.log('META', JSON.stringify(meta));

    const ap = await eng.applyFilter({});
    console.log('APPLY_ALL', JSON.stringify(ap));

    console.log('KPIS', JSON.stringify(await eng.kpis()));
    console.log('TS', JSON.stringify(await eng.timeSeries('hour')));
    console.log('BYLEVEL', JSON.stringify(await eng.countBy('level')));
    console.log('TOPIPS', JSON.stringify(await eng.countBy('ip', { limit: 5 })));

    const ap2 = await eng.applyFilter({ onlyErrors: false, statusClasses: ['2xx'], textQuery: 'запрос' });
    console.log('APPLY_FILTERED', JSON.stringify(ap2));
    console.log('KPIS2', JSON.stringify(await eng.kpis()));

    const ap3 = await eng.applyFilter({ groupFilter: 'g1' });
    console.log('APPLY_GROUP', JSON.stringify(ap3));

    await eng.applyFilter({});
    console.log('BYGROUP', JSON.stringify(await eng.byGroup()));
    console.log('GROUPSTATS', JSON.stringify(await eng.groupStats()));
    console.log('GROUPTS', JSON.stringify(await eng.groupTimeSeries('hour')));
    console.log('STATUSTREND', JSON.stringify(await eng.statusTrend('hour')));
    console.log('EPTS', JSON.stringify(await eng.endpointTimeSeries('hour', 10)));
    console.log('DICTREND', JSON.stringify(await eng.dicStatusTrend('hour')));
    console.log('PARETO', JSON.stringify(await eng.sourcePareto()));
    console.log('GRAPH', JSON.stringify(await eng.graph()));
    console.log('HEATMAP', JSON.stringify(await eng.heatmap(60)));
    console.log('BYSOURCE', JSON.stringify(await eng.bySource()));
    console.log('SRCEP', JSON.stringify(await eng.sourceEndpoints('10.3.14.96')));
    console.log('EXC', JSON.stringify(await eng.topExceptions()));
    console.log('ERRTOPS', JSON.stringify(await eng.errorTops()));
    console.log('PAGE', JSON.stringify(await eng.page('date', 'desc', 0, 3)));

    const dash = await eng.dashboard({ granularity: 'auto', pageSize: 2 });
    console.log('DASH_KEYS', Object.keys(dash).join(','));
    console.log('DASH_GRAN', dash.effectiveGranularity, 'PAGE_LEN', dash.page.length);

    process.exit(0);
  } catch (e) {
    console.error('ENGINE FAIL', e && e.stack ? e.stack : String(e));
    process.exit(1);
  }
});
