// ============================================================
// #DIGspotlight vol.2 — Google Apps Script（登録・編集・Steam検索中継）
// ============================================================
// このファイルはローカルコピー。実体は「第2回用の新しいスプレッドシート」の
// Apps Script プロジェクトに貼り付けて使う。第1回のスプレッドシートには触らない。
//
// 【セットアップ手順】
// 1. 新しい Google スプレッドシートを作成し、その ID を CONFIG.spreadsheetId に設定
// 2. このコードを Apps Script エディタに貼り付けて保存
// 3. setup_init() を1回実行（entries シートをヘッダー付きで作成）
// 4. デプロイ → 新しいデプロイ →「ウェブアプリ」
//      - 次のユーザーとして実行：自分
//      - アクセスできるユーザー：全員
// 5. 発行された /exec URL を register.html / edit.html の GAS_URL に設定
//
// 【エンドポイント】
//   GET  ?q=<term>            → Steam ゲーム検索の中継     { items:[{id,name,tiny_image}] }
//   GET  ?token=<twitchToken> → 自分の応募一覧（edit.html）  { ok, login, entries:[...] }
//   POST {action:"register"}  → 応募の新規登録 / 上書き
//   POST {action:"update"}    → 応募内容の編集（edit.html）
//   POST {action:"delete"}    → 応募の削除（edit.html）
//   ※ POST は Content-Type: text/plain で送ること（CORS プリフライト回避）
// ============================================================

const CONFIG = {
  // 第2回用スプレッドシート（2026-09-01 作成）
  spreadsheetId: '17ja0sEc8tH8My5Mwtraq5yZH8ryrtjG8-RUOQvL7G5I',
  twitchClientId: 'kp13odpytkan0tqo6xmgj5509h4104',
  entriesSheet: 'entries',
};

// entries シートの列（この順序で固定。index.html / edit.html が名前で参照する）
const HEADERS = [
  'Timestamp', 'TwitchId', 'TwitchLogin', 'Streamer', 'TwitchUrl', 'IconUrl',
  'AppId', 'Game', 'SteamUrl', 'HeaderImage', 'Developer',
  'Day1', 'Day2', 'Day3', 'Comment', 'X'
];

const SLOTS = ['朝', '昼', '夜', '深夜', '未定'];

// ============================================================
// セットアップ（初回のみ）
// ============================================================
function setup_init() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  let sheet = ss.getSheetByName(CONFIG.entriesSheet);
  if (!sheet) sheet = ss.insertSheet(CONFIG.entriesSheet);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  Logger.log('entries シート準備完了');
}

// ============================================================
// GET エンドポイント
// ============================================================
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.q !== undefined) return handleSearch(p.q);
  if (p.token) return handleMyEntries(p.token);
  return respond({ error: 'no_params' });
}

// ---- Steam ゲーム検索の中継 --------------------------------
// ブラウザからは store.steampowered.com が CORS を返さないため、
// サーバ側（GAS）で叩いて結果だけ返す。CacheService で数分キャッシュ。
function handleSearch(term) {
  term = String(term || '').trim();
  if (term.length < 2) return respond({ items: [] });

  const cache = CacheService.getScriptCache();
  const key = 'ss_' + term.toLowerCase();
  const hit = cache.get(key);
  if (hit) return respond(JSON.parse(hit));

  const out = { items: [] };
  try {
    const res = UrlFetchApp.fetch(
      'https://store.steampowered.com/api/storesearch/?term=' +
        encodeURIComponent(term) + '&cc=jp&l=japanese',
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() === 200) {
      const j = JSON.parse(res.getContentText());
      out.items = (j.items || []).slice(0, 8).map(function (it) {
        return { id: it.id, name: it.name, tiny_image: it.tiny_image || '' };
      });
    }
  } catch (err) {
    // 失敗時は空配列（フロント側で「URLを貼り付けて」に誘導）
  }
  cache.put(key, JSON.stringify(out), 300); // 5分
  return respond(out);
}

// ---- 自分の応募一覧（edit.html 用） ------------------------
function handleMyEntries(token) {
  const user = verifyTwitch(token);
  if (user.error) return respond({ error: user.error });

  const sheet = getEntriesSheet();
  const data = sheet.getDataRange().getValues();
  const header = data[0];

  const entries = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][header.indexOf('TwitchId')]) !== String(user.id)) continue;
    const o = {};
    header.forEach(function (h, idx) { o[h] = data[i][idx]; });
    entries.push(o);
  }
  return respond({ ok: true, login: user.login, entries: entries });
}

// ============================================================
// POST エンドポイント
// ============================================================
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ error: 'bad_json' });
  }

  switch (body.action) {
    case 'register': return handleUpsert(body, false);
    case 'update':   return handleUpsert(body, true);
    case 'delete':   return handleDelete(body);
    default:         return respond({ error: 'unknown_action' });
  }
}

// ---- 登録 / 編集（upsert） --------------------------------
// key = TwitchId + AppId。register も update も同じ処理でよい
// （update は「対象が存在しなければ 404 扱い」だけ差をつける）。
function handleUpsert(body, mustExist) {
  const user = verifyTwitch(body.token);
  if (user.error) return respond({ error: user.error });

  const appId = String(body.appId || '').replace(/\D/g, '');
  if (!appId) return respond({ error: 'no_appid' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return respond({ error: 'busy' });
  try {
    const details = fetchAppDetails(appId);
    const sheet = getEntriesSheet();
    const data = sheet.getDataRange().getValues();
    const header = data[0];
    const idOf = function (name) { return header.indexOf(name); };

    // 既存行を探す
    let foundRow = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idOf('TwitchId')]) === String(user.id) &&
          String(data[i][idOf('AppId')]) === appId) {
        foundRow = i;
        break;
      }
    }
    if (mustExist && foundRow < 0) return respond({ error: 'not_found' });

    const sched = body.schedule || {};
    const rowObj = {
      Timestamp: new Date(),
      TwitchId: user.id,
      TwitchLogin: user.login,
      Streamer: String(body.name || '').trim().slice(0, 60) || user.display,
      TwitchUrl: 'https://www.twitch.tv/' + user.login,
      IconUrl: user.icon,                       // ログインのたび最新アイコンで上書きされる
      AppId: appId,
      Game: details.game || String(body.gameName || '').trim() || ('App ' + appId),
      SteamUrl: sanitizeUrl(body.steamUrl) || ('https://store.steampowered.com/app/' + appId + '/'),
      HeaderImage: details.header || sanitizeUrl(body.headerImage) ||
                   ('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/' + appId + '/header.jpg'),
      Developer: details.developer || '',
      Day1: cleanSlot(sched.day1),
      Day2: cleanSlot(sched.day2),
      Day3: cleanSlot(sched.day3),
      Comment: String(body.comment || '').trim().slice(0, 300),
      X: normalizeX(body.x),
    };

    const rowArr = header.map(function (h) {
      return rowObj[h] !== undefined ? rowObj[h] : '';
    });

    if (foundRow > 0) {
      sheet.getRange(foundRow + 1, 1, 1, rowArr.length).setValues([rowArr]);
    } else {
      sheet.appendRow(rowArr);
    }
    return respond({ ok: true, game: rowObj.Game, updated: foundRow > 0 });
  } finally {
    lock.releaseLock();
  }
}

// ---- 削除 ------------------------------------------------
// appId 指定あり → その1件。appId 省略 → 自分の全応募。
function handleDelete(body) {
  const user = verifyTwitch(body.token);
  if (user.error) return respond({ error: user.error });
  const appId = String(body.appId || '').replace(/\D/g, '');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return respond({ error: 'busy' });
  try {
    const sheet = getEntriesSheet();
    const data = sheet.getDataRange().getValues();
    const header = data[0];
    const idCol = header.indexOf('TwitchId');
    const appCol = header.indexOf('AppId');

    let deleted = 0;
    for (let i = data.length - 1; i >= 1; i--) {
      const mine = String(data[i][idCol]) === String(user.id);
      const appMatch = !appId || String(data[i][appCol]) === appId;
      if (mine && appMatch) {
        sheet.deleteRow(i + 1);
        deleted++;
        if (appId) break;
      }
    }
    return respond({ ok: true, deleted: deleted });
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// ヘルパー
// ============================================================
function getEntriesSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  let sheet = ss.getSheetByName(CONFIG.entriesSheet);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.entriesSheet);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Twitch アクセストークンを検証し、本人情報を返す（クライアントの申告値は信用しない）
function verifyTwitch(token) {
  if (!token) return { error: 'no_token' };
  try {
    const res = UrlFetchApp.fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': CONFIG.twitchClientId,
      },
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 401) return { error: 'token_expired' };
    if (code !== 200) return { error: 'twitch_api_error' };
    const u = (JSON.parse(res.getContentText()).data || [])[0];
    if (!u) return { error: 'no_user' };
    return {
      id: String(u.id),
      login: String(u.login || '').toLowerCase(),
      display: u.display_name || u.login,
      icon: u.profile_image_url || '',
    };
  } catch (err) {
    return { error: 'twitch_api_failed' };
  }
}

// Steam appdetails からゲーム名・開発者名・ヘッダー画像を取得（6時間キャッシュ）
function fetchAppDetails(appId) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('ad_' + appId);
  if (hit) return JSON.parse(hit);

  const out = { game: '', developer: '', header: '' };
  try {
    const res = UrlFetchApp.fetch(
      'https://store.steampowered.com/api/appdetails?appids=' +
        encodeURIComponent(appId) + '&l=japanese&cc=jp',
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() === 200) {
      const node = JSON.parse(res.getContentText())[appId];
      if (node && node.success && node.data) {
        out.game = node.data.name || '';
        out.developer = (node.data.developers || []).join(', ');
        out.header = node.data.header_image || '';
      }
    }
  } catch (err) {
    // 取れなければ空のまま（フロントの推定URL・入力値で代替）
  }
  cache.put('ad_' + appId, JSON.stringify(out), 21600); // 6時間
  return out;
}

function cleanSlot(v) {
  return SLOTS.indexOf(v) >= 0 ? v : '未定';
}

function sanitizeUrl(v) {
  v = String(v || '').trim();
  return /^https?:\/\//i.test(v) ? v : '';
}

// X（Twitter）の入力を URL に正規化。判別できなければ空。
function normalizeX(v) {
  v = String(v || '').trim();
  if (!v) return '';
  const m = v.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})/i);
  if (m) return 'https://x.com/' + m[1].replace('@', '');
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(v)) return 'https://x.com/' + v.replace('@', '');
  return '';
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
