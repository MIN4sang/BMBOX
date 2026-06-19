const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // 외부 링크는 기본 브라우저로 열기
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  // 업데이트 확인 (앱 시작 3초 후)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── 업데이트 이벤트 ──────────────────────────────────────
autoUpdater.on('update-available', (info) => {
  win.webContents.send('update-available', info.version);
});

autoUpdater.on('update-not-available', () => {
  // 조용히 무시
});

autoUpdater.on('download-progress', (progress) => {
  win.webContents.send('update-progress', Math.floor(progress.percent));
});

autoUpdater.on('update-downloaded', () => {
  win.webContents.send('update-downloaded');
});

autoUpdater.on('error', () => {
  // 조용히 무시
});

// 렌더러에서 "지금 설치" 요청을 받으면 재시작 후 업데이트
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});
