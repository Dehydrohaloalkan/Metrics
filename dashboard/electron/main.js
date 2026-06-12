const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged || process.env.ELECTRON_DEV === '1';

/**
 * Returns the list of candidate locations for the default data.csv,
 * ordered by priority. The first existing one wins.
 */
function defaultCsvCandidates() {
  const candidates = [];

  // Portable build: directory where the user placed the portable .exe
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data.csv'));
  }

  // Installed build / generic: folder next to the running executable
  try {
    candidates.push(path.join(path.dirname(app.getPath('exe')), 'data.csv'));
  } catch {
    /* ignore */
  }

  // Bundled fallback copy shipped inside the app resources
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'data.csv'));
  }

  // Dev: project root
  candidates.push(path.join(__dirname, '..', 'data.csv'));

  return candidates;
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
ipcMain.handle('csv:loadDefault', async () => {
  for (const candidate of defaultCsvCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        return { ok: true, path: candidate, content: readCsvFile(candidate) };
      }
    } catch (err) {
      return { ok: false, path: candidate, error: String(err) };
    }
  }
  return { ok: false, error: 'data.csv not found next to the application.' };
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
