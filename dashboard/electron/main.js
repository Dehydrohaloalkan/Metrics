const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged || process.env.ELECTRON_DEV === '1';

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
ipcMain.handle('csv:loadDefault', async () => loadNamedFile('data.csv'));

// --- IPC: load members.csv (ip -> name mapping) ---
ipcMain.handle('members:loadDefault', async () => loadNamedFile('members.csv'));

// --- IPC: persistent settings (settings.json in userData) ---
function settingsPath() {
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
