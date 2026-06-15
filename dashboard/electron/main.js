const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { DuckEngine } = require('./duckdb-engine');

const isDev = !app.isPackaged || process.env.ELECTRON_DEV === '1';

let mainWindow = null;
let watchedCsvPath = null;
const engine = new DuckEngine();

/** Watch the active data.csv and notify the renderer when it changes. */
function watchCsv(filePath) {
  if (!filePath || filePath === watchedCsvPath) return;
  if (watchedCsvPath) {
    try {
      fs.unwatchFile(watchedCsvPath);
    } catch {
      /* ignore */
    }
  }
  watchedCsvPath = filePath;
  fs.watchFile(filePath, { interval: 1500 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('data:changed');
    }
  });
}

/**
 * Returns candidate locations for a named data file (e.g. data.csv,
 * members.csv), ordered by priority. The first existing one wins.
 */
function fileCandidates(fileName) {
  const candidates = [];

  // Portable build: directory where the user placed the portable .exe
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, fileName));
  }

  // Installed build / generic: folder next to the running executable
  try {
    candidates.push(path.join(path.dirname(app.getPath('exe')), fileName));
  } catch {
    /* ignore */
  }

  // Bundled fallback copy shipped inside the app resources
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, fileName));
  }

  // Dev: project root
  candidates.push(path.join(__dirname, '..', fileName));

  return candidates;
}

/** First existing candidate path for a named data file, or null. */
function resolveDataPath(fileName) {
  for (const candidate of fileCandidates(fileName)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function loadNamedFile(fileName) {
  for (const candidate of fileCandidates(fileName)) {
    try {
      if (fs.existsSync(candidate)) {
        return { ok: true, path: candidate, content: readCsvFile(candidate) };
      }
    } catch (err) {
      return { ok: false, path: candidate, error: String(err) };
    }
  }
  return { ok: false, error: `${fileName} не найден рядом с приложением.` };
}

function readCsvFile(filePath) {
  // Read as buffer first so we can strip a UTF-8 BOM if present.
  const buf = fs.readFileSync(filePath);
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  return content;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0e1116',
    show: false,
    title: 'Service Metrics',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.once('ready-to-show', () => win.show());

  // Open external links in the OS browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:4200');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'dashboard', 'browser', 'index.html'));
  }
}

// --- IPC: load the default data.csv discovered next to the exe / bundled ---
ipcMain.handle('csv:loadDefault', async () => {
  const res = loadNamedFile('data.csv');
  if (res.ok && res.path) watchCsv(res.path);
  return res;
});

// ===================== DuckDB analytics engine IPC =====================
// Load CSV (+ members) straight off disk into DuckDB; returns metadata only.
async function engineLoad(csvPath, tz) {
  await engine.init();
  if (tz) await engine.setTimezone(tz);
  await engine.loadCsv(csvPath);
  const membersPath = resolveDataPath('members.csv');
  if (membersPath) await engine.loadMembers(membersPath);
  watchCsv(csvPath);
  const meta = await engine.meta();
  return { ok: true, path: csvPath, hasMembers: !!membersPath, meta };
}

ipcMain.handle('analytics:loadDefault', async (_e, args) => {
  const csvPath = resolveDataPath('data.csv');
  if (!csvPath) return { ok: false, error: 'data.csv не найден рядом с приложением.' };
  try {
    return await engineLoad(csvPath, args && args.tz);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('analytics:pick', async (_e, args) => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите CSV с логами',
    properties: ['openFile'],
    filters: [
      { name: 'CSV / логи', extensions: ['csv', 'log', 'txt'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
  try {
    return await engineLoad(result.filePaths[0], args && args.tz);
  } catch (err) {
    return { ok: false, path: result.filePaths[0], error: String(err) };
  }
});

ipcMain.handle('analytics:setTimezone', async (_e, tz) => {
  try {
    await engine.setTimezone(tz);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('analytics:setGroups', async (_e, groups) => {
  try {
    await engine.setGroups(groups || []);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Apply the filter (materialises `cur`) and return every chart dataset + page.
ipcMain.handle('analytics:query', async (_e, payload) => {
  try {
    const { filter = {}, opts = {} } = payload || {};
    const { total } = await engine.applyFilter(filter);
    const dash = await engine.dashboard(opts);
    return { ok: true, total, ...dash };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('analytics:export', async () => {
  if (!mainWindow) return { ok: false };
  try {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт отфильтрованного',
      defaultPath: 'metrics-filtered.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    return await engine.exportCsv(res.filePath);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// --- IPC: export the whole dashboard to PDF ---
ipcMain.handle('export:pdf', async () => {
  if (!mainWindow) return { ok: false };
  try {
    const data = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: 'A4',
      // Let the page's own @page rule drive size/margins so the print layout
      // matches what the @media print stylesheet lays out (no shifting/cutoff).
      preferCSSPageSize: true,
      margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
    });
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить отчёт',
      defaultPath: 'metrics-report.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, data);
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// --- IPC: load members.csv (ip -> name mapping) ---
ipcMain.handle('members:loadDefault', async () => loadNamedFile('members.csv'));

// --- IPC: persistent settings (settings.json next to the exe / portable dir) ---
function settingsPath() {
  if (!isDev) {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'settings.json');
    }
    try {
      return path.join(path.dirname(app.getPath('exe')), 'settings.json');
    } catch { /* fall through */ }
  }
  // Dev and last-resort fallback
  return path.join(app.getPath('userData'), 'settings.json');
}

ipcMain.on('settings:get', (event) => {
  try {
    const p = settingsPath();
    event.returnValue = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  } catch {
    event.returnValue = {};
  }
});

ipcMain.handle('settings:set', async (_e, data) => {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(data ?? {}, null, 2), 'utf8');
    return { ok: true, path: settingsPath() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// --- IPC: let the user pick any CSV file ---
ipcMain.handle('csv:pick', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите CSV с логами',
    properties: ['openFile'],
    filters: [
      { name: 'CSV / логи', extensions: ['csv', 'log', 'txt'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  const filePath = result.filePaths[0];
  try {
    return { ok: true, path: filePath, content: readCsvFile(filePath) };
  } catch (err) {
    return { ok: false, path: filePath, error: String(err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
