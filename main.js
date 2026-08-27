const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let win;

// ── 사용자 데이터 파일 저장 (localStorage 대신 실제 파일에 저장해서 유실 방지) ──
function getDataFilePath() {
  return path.join(app.getPath('userData'), 'bookmark-data.json');
}

ipcMain.handle('data:load', () => {
  try {
    const p = getDataFilePath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (e) {}
  return null;
});

ipcMain.on('data:save', (event, json) => {
  try {
    const p = getDataFilePath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, p); // 원자적 교체: 저장 도중 앱이 죽어도 기존 파일이 깨지지 않음
  } catch (e) {}
});

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
