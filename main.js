const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let win;

// ── 사용자 데이터 파일 저장 (localStorage 대신 실제 파일에 저장해서 유실 방지) ──
function getDataFilePath() {
  return path.join(app.getPath('userData'), 'bookmark-data.json');
}

// 업데이트 설치 직전에 현재 데이터 파일을 자동으로 백업해둠 (업데이트 도중 문제가 생겨도 복구 가능하도록).
// 주의: 이 로직은 "지금 실행 중인" 버전이 있어야 동작한다 — 즉 이 코드가 들어간 버전이 배포되고,
// 그다음 업데이트부터 실제로 백업이 만들어진다. 지금 당장 진행 중인 업데이트에는 적용되지 않는다.
function backupDataFileBeforeUpdate() {
  try {
    const src = getDataFilePath();
    if (!fs.existsSync(src)) return;
    const backupDir = path.join(app.getPath('userData'), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(src, path.join(backupDir, `bookmark-data-${ts}.json`));
    // 백업이 무한정 쌓이지 않도록 최근 10개만 남기고 정리
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('bookmark-data-') && f.endsWith('.json'))
      .sort();
    while (files.length > 10) {
      fs.unlinkSync(path.join(backupDir, files.shift()));
    }
  } catch (e) {}
}

ipcMain.handle('data:load', () => {
  const p = getDataFilePath();
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (e) {
    // 파일은 있는데(existsSync는 통과) 읽다가 실패한 경우 — 백신 프로그램이 잠깐 파일을 잠갔거나 디스크 문제일 수 있음.
    // 이걸 "파일이 아예 없음(최초 실행)"과 똑같이 null로 돌려주면, 렌더러가 빈 상태로 시작했다가
    // 사용자가 뭔가 하나라도 저장하는 순간 진짜 데이터가 있던 파일이 빈 내용으로 덮어써질 수 있어서 구분해서 알려줌.
    return { __loadError: true, message: String((e && e.message) || e) };
  }
  return null; // 파일이 정말 없는 경우(최초 실행)에만 null
});

ipcMain.on('data:save', (event, json) => {
  try {
    const p = getDataFilePath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, p); // 원자적 교체: 저장 도중 앱이 죽어도 기존 파일이 깨지지 않음
  } catch (e) {}
});

// ── 게시물 링크 미리보기 (Open Graph 메타태그로 내용/이미지 추출) ──
// 렌더러(브라우저) 쪽에서 직접 fetch하면 대부분 사이트가 CORS로 막지만,
// 메인 프로세스에서는 그 제약이 없어서 여기서 대신 가져와 파싱한다.
function detectCharset(buf, contentType) {
  const ctMatch = /charset=([\w-]+)/i.exec(contentType || '');
  if (ctMatch) return ctMatch[1].toLowerCase();
  const head = buf.slice(0, 2048).toString('latin1');
  const metaMatch = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head);
  return metaMatch ? metaMatch[1].toLowerCase() : 'utf-8';
}

// HTML 엔티티(&amp; 같은 문자 코드)를 실제 문자로 바꿈.
// 기존엔 6개(&amp; &lt; &gt; &quot; &#39; &nbsp;)만 처리해서 &#8217;(작은따옴표), &mdash;(줄표), &hellip;(말줄임표) 같은
// 다른 특수문자는 코드 그대로 남아있었음 — 숫자 코드(&#39; &#x27; 등)와 자주 쓰는 이름 코드까지 넓게 처리함.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
};
function decodeOnce(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}
function decodeEntities(s) {
  // 일부 사이트는 &amp;nbsp; 처럼 두 번 인코딩해서 내려주기도 해서, 한 번 더 돌려서 마저 풀어줌
  return decodeOnce(decodeOnce(s || ''))
    .replace(/[\x00-\x1f\x7f]/g, '') // 네이버 등 일부 사이트가 title에 섞어 보내는 제어문자 제거
    .trim();
}

// html 안에 있는 "key":"value" 형태의 JSON 문자열 값을 안전하게 뽑아냄 (\n, \" 같은 이스케이프도 올바르게 처리)
function jsonStringField(html, key) {
  const m = new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`).exec(html);
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
}

// 네이버 플레이스(m.place.naver.com) 페이지는 og 태그엔 리뷰 수만 있지만,
// 화면을 그리는 데 쓰는 JSON 데이터 안에 업종/주소/전화번호/영업시간/홈페이지 링크가 그대로 들어있어서 그걸 대신 뽑아옴.
function extractNaverPlace(html) {
  if (!/"categoryCode":/.test(html)) return null;
  const category = jsonStringField(html, 'category');
  const road = jsonStringField(html, 'road').replace(/\n/g, ' ').trim();
  const phoneMatch = /href="tel:([\d-]+)"/.exec(html);
  const phone = phoneMatch ? phoneMatch[1] : '';

  // "영업 종료"/"영업 중" 같은 지금 이 순간의 상태는 저장해두면 금방 틀린 정보가 되므로 쓰지 않고,
  // 실제 시작~종료 시각(예: 11:00~22:00)만 뽑음
  const hoursMatch = /"businessHours":\{"__typename":"StartEndTime","start":"([^"]*)","end":"([^"]*)"\}/.exec(html);
  const hours = hoursMatch ? `${hoursMatch[1]} - ${hoursMatch[2]}` : '';

  const homepageMatch = /"repr":\{"__typename":"HomepageRepr","url":"((?:\\.|[^"\\])*)"/.exec(html);
  let homepage = '';
  if (homepageMatch) { try { homepage = JSON.parse('"' + homepageMatch[1] + '"'); } catch (e) { homepage = homepageMatch[1]; } }

  if (!category && !road && !phone && !hours && !homepage) return null;
  return { category, road, phone, hours, homepage };
}

function extractLinkMeta(html) {
  const pick = (re) => { const m = re.exec(html); return m ? m[1].trim() : ''; };
  const metaContent = (attr, value) => {
    const a = pick(new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]+content=["']([^"']*)["']`, 'i'));
    if (a) return a;
    return pick(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${value}["']`, 'i'));
  };
  let title = decodeEntities(metaContent('property', 'og:title') || pick(/<title[^>]*>([^<]*)<\/title>/i));
  let description = decodeEntities(metaContent('property', 'og:description') || metaContent('name', 'description'));
  const image = metaContent('property', 'og:image') || metaContent('name', 'twitter:image');
  // 일반 게시물(블로그/뉴스 등)의 실제 작성자 닉네임 — 네이버 플레이스에는 보통 없고, 다른 사이트에서 쓰임
  const author = decodeEntities(metaContent('name', 'author') || metaContent('name', 'twitter:creator') || metaContent('property', 'article:author'));

  const place = extractNaverPlace(html);
  let isPlace = false;
  let hours = '';
  let extraLinks = [];
  if (place) {
    const name = title.replace(/\s*[:|]\s*네이버.*$/, '').trim();
    if (name) title = name;
    const parts = [place.category, place.road, place.phone].filter(Boolean);
    if (parts.length) { description = parts.join(' · '); isPlace = true; }
    hours = place.hours;
    if (place.homepage) extraLinks.push(place.homepage);
  }

  // 노션 페이지 제목엔 " | Notion"이 붙어 나오고, 페이지에 설명글이 따로 없으면
  // 실제 내용 대신 노션 홍보 문구("Hosted by Notion Sites...")가 채워져서 나옴 — 둘 다 정리
  title = title.replace(/\s*\|\s*Notion\s*$/i, '').trim() || title;
  if (/Hosted by Notion Sites|collaborative AI workspace/i.test(description)) description = '';

  return {
    title,
    description,
    image: image ? decodeEntities(image) : '',
    isPlace,
    hours,
    extraLinks,
    author,
  };
}

// 페이지에서 뽑아낸 정보가 사실상 없다시피 하면(설명도 이미지도 없음) — 네이버 블로그처럼
// 실제 내용을 iframe 안에 따로 담아두는 "껍데기" 페이지일 가능성이 있다고 봄
function looksEmpty(meta) {
  return !meta.description && !meta.image;
}

// html 안의 <iframe>들 중 "본문"으로 보이는 것을 하나 골라 절대주소로 반환.
// 특정 사이트를 이름으로 콕 집지 않고, id/name에 본문을 뜻하는 흔한 단어가 들어있는지로 판단해서
// 네이버 블로그뿐 아니라 비슷한 구조(iframe으로 내용을 감싸는 예전 방식 사이트)에도 두루 적용됨.
function findContentIframeUrl(html, baseUrl) {
  const tags = html.match(/<iframe\b[^>]*>/gi);
  if (!tags) return null;
  const candidates = tags.map((tag) => {
    const srcMatch = /\bsrc=["']([^"']+)["']/i.exec(tag);
    if (!srcMatch || !srcMatch[1] || srcMatch[1].startsWith('about:')) return null;
    const idName = (/\b(?:id|name)=["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    const score = /main|content|contents|view|post|article|body/i.test(idName) ? 2 : 1;
    return { src: srcMatch[1], score };
  }).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  try { return new URL(candidates[0].src, baseUrl).toString(); } catch (e) { return null; }
}

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
// 노션(notion.so/site/com)은 일반 브라우저로 보면 빈 껍데기 페이지만 오고 실제 내용은 자바스크립트가 나중에 불러오는데,
// 카카오톡/페이스북 같은 링크 미리보기 크롤러로 보이면 실제 제목/설명이 담긴 페이지를 서버에서 바로 내려줌. 그래서 노션 링크는 크롤러 UA로 요청함.
function isNotionUrl(urlStr) {
  try { return /(^|\.)notion\.(so|site|com)$/i.test(new URL(urlStr).hostname); } catch (e) { return false; }
}

async function fetchWithUA(urlStr, signal) {
  const ua = isNotionUrl(urlStr) ? 'facebookexternalhit/1.1' : DESKTOP_UA;
  return net.fetch(urlStr, {
    redirect: 'follow',
    signal,
    headers: { 'User-Agent': ua },
  });
}

ipcMain.handle('link:preview', async (event, rawUrl) => {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'invalid-protocol' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetchWithUA(u.toString(), controller.signal);
      if (res.ok) {
        // 네이버 지도 장소 링크(map.naver.com)는 자바스크립트로 내용을 그리는 페이지라
        // 서버가 처음 주는 HTML에는 실제 가게 사진/설명이 없음.
        // 같은 장소의 모바일 플레이스 페이지(m.place.naver.com)는 서버에서 바로 렌더링해주므로 그쪽으로 다시 가져옴.
        const placeMatch = /map\.naver\.com\/p\/entry\/place\/(\d+)/.exec(res.url);
        if (placeMatch) {
          const placeRes = await fetchWithUA(`https://m.place.naver.com/place/${placeMatch[1]}/home`, controller.signal);
          if (placeRes.ok) res = placeRes;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { error: 'http-' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    const charset = detectCharset(buf, res.headers.get('content-type'));
    let html;
    try { html = new TextDecoder(charset).decode(buf); }
    catch (e) { html = buf.toString('utf-8'); }

    let meta = extractLinkMeta(html);
    let finalUrl = res.url;

    // 페이지 자체에는 내용이 없고 iframe 안에 실제 글이 들어있는 사이트(예: 네이버 블로그) 대응.
    // 특정 사이트를 알아서 찾는 대신, "내용이 비어있으면 iframe을 찾아 다시 시도"하는 일반적인 방식으로 처리.
    if (looksEmpty(meta)) {
      const iframeUrl = findContentIframeUrl(html, res.url);
      if (iframeUrl) {
        const iframeController = new AbortController();
        const iframeTimer = setTimeout(() => iframeController.abort(), 10000);
        try {
          const iframeRes = await fetchWithUA(iframeUrl, iframeController.signal);
          if (iframeRes.ok) {
            const iframeBuf = Buffer.from(await iframeRes.arrayBuffer());
            const iframeCharset = detectCharset(iframeBuf, iframeRes.headers.get('content-type'));
            let iframeHtml;
            try { iframeHtml = new TextDecoder(iframeCharset).decode(iframeBuf); }
            catch (e) { iframeHtml = iframeBuf.toString('utf-8'); }
            const iframeMeta = extractLinkMeta(iframeHtml);
            if (!looksEmpty(iframeMeta)) {
              meta = iframeMeta;
              finalUrl = iframeRes.url;
            }
          }
        } catch (e) {
        } finally {
          clearTimeout(iframeTimer);
        }
      }
    }

    return { ok: true, finalUrl, ...meta };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
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

// 렌더러에서 "지금 설치" 요청을 받으면 데이터부터 백업한 뒤 재시작 후 업데이트
ipcMain.on('install-update', () => {
  backupDataFileBeforeUpdate();
  autoUpdater.quitAndInstall();
});
