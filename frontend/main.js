const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 768,
    title: "PrintFlow – Print Shop Management System",
    backgroundColor: '#0F172A',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    },
    titleBarStyle: 'default',
  });

  // ── Prevent file downloads triggered by iframes/navigation on reload ──
  // When the window reloads, iframes pointing to PDFs (file:// or http://)
  // can trigger Chromium's download manager. Intercept and cancel them.
  mainWindow.webContents.session.on('will-download', (event, item) => {
    // Cancel any automatic download — files should only be downloaded
    // explicitly via the downloadFileLocally() helper in app.js
    event.preventDefault();
  });

  // ── Block top-level navigation away from index.html ──
  // Clicking links inside PDF iframes or iframe navigation errors can
  // cause the main window to navigate away from the app shell.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = `file:///${path.join(__dirname, 'index.html').replace(/\\/g, '/')}`;
    // Allow navigation to the app itself (e.g. initial load), block everything else
    if (!url.startsWith('file://') || !url.includes('index.html')) {
      event.preventDefault();
    }
  });

  // ── Clean up preview iframes before reload ──
  // When F5 or Ctrl+R is pressed, tell the renderer to clear all iframes
  // before the page actually unloads, preventing stale file:// requests.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isReload =
      (input.key === 'F5' && input.type === 'keyDown') ||
      (input.key === 'r' && input.type === 'keyDown' && (input.control || input.meta));

    if (isReload) {
      // Remove all iframes from the DOM before Chromium starts the reload
      mainWindow.webContents.executeJavaScript(`
        document.querySelectorAll('iframe').forEach(f => f.remove());
        document.querySelectorAll('.mini-preview-content').forEach(el => { el.innerHTML = ''; });
        const previewCard = document.getElementById('preview-document-card');
        if (previewCard) previewCard.innerHTML = '';
        const detailCanvas = document.getElementById('detail-preview-canvas');
        if (detailCanvas) detailCanvas.innerHTML = '';
      `).catch(() => {});
    }
  });

  // ── Prevent new windows from opening (e.g. target="_blank" in PDFs) ──
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  // 1. Fetch real OS printers
  ipcMain.handle('get-printers', async (event) => {
    return await mainWindow.webContents.getPrintersAsync();
  });

  // 2. Handle the actual print job
  ipcMain.handle('print-job', async (event, { filePath, printerName, copies, duplex, color }) => {
    return new Promise((resolve, reject) => {

      // --- FIX 1: Normalise and validate the file path before doing anything ---
      // Resolve to an absolute path and normalise separators for the current OS.
      const absPath = path.resolve(filePath);

      if (!fs.existsSync(absPath)) {
        return reject(`File not found on disk: ${absPath}`);
      }

      // Electron's loadFile() requires a plain absolute path (no file:// prefix).
      // On Windows we also make sure there are no stray forward-slashes.
      const safeLoadPath = absPath; // path.resolve already gives the right format

      let printWindow = new BrowserWindow({
        // --- FIX 2: Give the hidden window a real size ---
        // A 0×0 or default-hidden window can produce a zero-page PDF render.
        width: 1280,
        height: 900,
        show: false,
        webPreferences: {
          plugins: true  // enables the internal Chromium PDF viewer
        }
      });

      // Handle load failures so the promise doesn't hang forever
      printWindow.webContents.on('did-fail-load', (ev, errCode, errDesc) => {
        if (!printWindow.isDestroyed()) printWindow.close();
        reject(`PDF failed to load (${errCode}): ${errDesc} — path: ${safeLoadPath}`);
      });

      printWindow.loadFile(safeLoadPath);

      // --- FIX 3: Use 'did-finish-load' + a generous timeout ---
      // 'ready-to-show' fires when the BrowserWindow *frame* is ready, which for
      // a hidden window happens almost instantly — before the Chromium PDF plugin
      // has had any time to parse and render pages.  'did-finish-load' fires when
      // the document's load event completes, which is closer to when the PDF viewer
      // has ingested the file, but the plugin still needs extra time to paint pages.
      //
      // A reliable heuristic: wait for 'did-finish-load', then give the renderer
      // 1 500 ms for small-to-medium PDFs.  Increase if you regularly see blank
      // pages on large or image-heavy files.
      printWindow.webContents.once('did-finish-load', () => {
        const RENDER_BUFFER_MS = 1500; // ← tune upward for heavy files

        setTimeout(() => {
          if (printWindow.isDestroyed()) {
            return reject('Print window was closed before printing could start.');
          }

          printWindow.webContents.print(
            {
              silent: true,
              deviceName: printerName,
              copies: copies,
              color: color === 'color',
              duplexMode: duplex === 'double' ? 'longEdge' : 'simplex'
            },
            (success, errorType) => {
              if (!printWindow.isDestroyed()) printWindow.close();
              if (!success) {
                reject(`Printer reported failure: ${errorType}`);
              } else {
                resolve(true);
              }
            }
          );
        }, RENDER_BUFFER_MS);
      });
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});