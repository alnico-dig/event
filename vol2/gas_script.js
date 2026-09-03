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
//   GET  ?list=1              → 参加者一覧（index.html #streams・公開情報のみ） { entries:[...] }
//   GET  ?live=1              → 今 Twitch で配信中の参加者（schedule.html） { live:[{login,name,icon,game}] }
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
  // イベント開催期間（JST・yyyyMMdd）。NowLive のカテゴリ名フィルタ（タイトルに DIGspotlight）を
  // この期間だけ有効にする。期間外は本番前テストのため素通し。
  eventStart: '20261218',
  eventEnd: '20261220',
};

// entries シートの列（この順序で固定。index.html / edit.html が名前で参照する）
const HEADERS = [
  'Timestamp', 'TwitchId', 'TwitchLogin', 'Streamer', 'TwitchUrl', 'IconUrl',
  'AppId', 'Game', 'SteamUrl', 'HeaderImage', 'Developer',
  'Day1', 'Day2', 'Day3', 'DatesTBD', 'Comment', 'X'
];

// Day1/Day2/Day3 に入りうる時間帯。複数選択可なので保存時は "," 区切り。
// '未定' = その日は配信するが時間未定。空文字 = その日は配信しない。
// 表示ラベルはフロント側で「時間未定」等に出し分ける（格納値は '未定' のまま）。
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
  if (p.list) return handlePublicList();
  if (p.live) return handleNowLive();
  return respond({ error: 'no_params' });
}

// ---- 参加者一覧（index.html の #streams 用・公開情報のみ） ----
// 60秒キャッシュ。登録/編集/削除時に doPost 側でキャッシュを破棄するので反映は速い。
const PUBLIC_COLS = [
  'TwitchLogin', 'Streamer', 'TwitchUrl', 'IconUrl',
  'AppId', 'Game', 'SteamUrl', 'HeaderImage',
  'Day1', 'Day2', 'Day3', 'DatesTBD', 'Comment', 'X'
]; // Developer / TwitchId / Timestamp は返さない

function handlePublicList() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('public_list');
  if (hit) return respond(JSON.parse(hit));

  const sheet = getEntriesSheet();
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const idx = {};
  PUBLIC_COLS.forEach(function (k) { idx[k] = header.indexOf(k); });
  const appCol = header.indexOf('AppId');

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][appCol]) continue;
    const o = {};
    PUBLIC_COLS.forEach(function (k) { o[k] = data[i][idx[k]]; });
    rows.push(o);
  }
  const out = { entries: rows };
  cache.put('public_list', JSON.stringify(out), 60);
  return respond(out);
}

// 今 JST でイベント開催期間中か（yyyyMMdd の文字列比較。CONFIG.eventStart〜eventEnd）
function isDuringEvent_() {
  const ymd = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  return ymd >= CONFIG.eventStart && ymd <= CONFIG.eventEnd;
}

// ---- 今 Twitch で配信中の参加者（schedule.html の NowLive パネル用） ----
// 参加者の TwitchLogin を helix/streams にまとめて問い合わせる（最大100件 = 1リクエスト）。
// 結果は 5 分キャッシュ。キャッシュ有効中は何人アクセスしても Twitch 呼び出しは 1 回だけ。
// App Access Token は Script Properties の TWITCH_CLIENT_SECRET から取得（クライアント非公開）。
function handleNowLive() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('now_live');
  if (hit) return respond(JSON.parse(hit));

  const sheet = getEntriesSheet();
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const loginCol = header.indexOf('TwitchLogin');
  const streamerCol = header.indexOf('Streamer');
  const iconCol = header.indexOf('IconUrl');
  const appCol = header.indexOf('AppId');

  const logins = [];
  const infoByLogin = {};
  for (let i = 1; i < data.length; i++) {
    if (!data[i][appCol]) continue;
    const lg = String(data[i][loginCol] || '').toLowerCase().trim();
    if (!lg || infoByLogin[lg] !== undefined) continue;
    infoByLogin[lg] = {
      name: String(data[i][streamerCol] || '') || lg,
      icon: String(data[i][iconCol] || ''),
    };
    logins.push(lg);
  }

  let live = [];
  if (logins.length) {
    try {
      const token = getAppToken();
      const qs = logins.slice(0, 100)
        .map(function (l) { return 'user_login=' + encodeURIComponent(l); })
        .join('&');
      const res = UrlFetchApp.fetch('https://api.twitch.tv/helix/streams?first=100&' + qs, {
        headers: { 'Client-Id': CONFIG.twitchClientId, 'Authorization': 'Bearer ' + token },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 200) {
        const arr = (JSON.parse(res.getContentText()).data) || [];
        // 開催期間中だけ、配信タイトルによるカテゴリ名フィルタを有効にする。
        // 期間外は本番前テストのため素通し（DIGspotlight タグを付けなくても game_name を確認できる）。
        const filterByTitle = isDuringEvent_();
        live = arr
          .filter(function (s) { return s && s.type === 'live'; })
          .map(function (s) {
            const lg = String(s.user_login || '').toLowerCase();
            const info = infoByLogin[lg] || {};
            // game_name / title は同じ helix/streams レスポンスに含まれる＝追加リクエストなし。
            // 開催期間中は「配信タイトルに DIGspotlight を含む＝イベント参加中の配信」だけカテゴリを出す
            // （登録者が無関係な配信をしている時にゲーム名を出すと紛らわしいため）。
            // 表記揺れ対策：大文字小文字は無視（i フラグ）、"DIG spotlight" のような空白入りも許容。
            const showGame = !filterByTitle || /dig\s*spotlight/i.test(String(s.title || ''));
            return {
              login: lg,
              name: info.name || s.user_name || lg,
              icon: info.icon || '',
              game: showGame ? String(s.game_name || '') : '',
            };
          });
      }
    } catch (err) {
      // トークン取得失敗・API エラー等 → 空で返す（パネル側は「配信中なし」表示）
    }
  }

  const out = { live: live };
  cache.put('now_live', JSON.stringify(out), 300); // 5分
  return respond(out);
}

// Twitch App Access Token（client_credentials フロー）。~6時間キャッシュ。
function getAppToken() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('twitch_app_token');
  if (hit) return hit;

  const secret = PropertiesService.getScriptProperties().getProperty('TWITCH_CLIENT_SECRET');
  if (!secret) throw new Error('no_client_secret');

  const res = UrlFetchApp.fetch('https://id.twitch.tv/oauth2/token', {
    method: 'post',
    payload: {
      client_id: CONFIG.twitchClientId,
      client_secret: secret,
      grant_type: 'client_credentials',
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('token_http_' + res.getResponseCode());
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('token_no_access_token');
  // expires_in は秒（通常 ~50日）。CacheService 上限の 6 時間で頭打ち。
  const ttl = Math.min(21600, Math.max(60, (j.expires_in || 3600) - 60));
  cache.put('twitch_app_token', j.access_token, ttl);
  return j.access_token;
}

// storesearch はサントラ・DLC・体験版・開発ツールも同じ type("app") で返してくる
// （type フィールドで判別できない）。ゲーム本体が埋もれるので名前で除外する。
const SEARCH_NOISE = /(soundtrack|サウンドトラック|\bOST\b|artbook|art book|アートブック|wallpaper|\bDLC\b|season pass|supporter|\bdonation\b| demo$|体験版|redkit|redmod|dedicated server|bonus content|upgrade (pack|dlc)|prologue soundtrack)/i;

// Steam の生の結果を「ゲーム本体が上に来る」よう並べ替え、ノイズを落として最大8件返す
function rankSearchItems(rawItems, term) {
  const q = term.trim().toLowerCase();
  return rawItems
    .filter(function (it) { return it && it.name && !SEARCH_NOISE.test(it.name); })
    .map(function (it) {
      const n = String(it.name).toLowerCase();
      let score = 0;
      if (n === q) score = 3;                 // 完全一致
      else if (n.indexOf(q) === 0) score = 2; // 前方一致
      else if (n.indexOf(q) >= 0) score = 1;  // 部分一致
      return { it: it, score: score };
    })
    .sort(function (a, b) {
      return b.score - a.score || String(a.it.name).length - String(b.it.name).length;
    })
    .slice(0, 8)
    .map(function (x) {
      return { id: x.it.id, name: x.it.name, tiny_image: x.it.tiny_image || '' };
    });
}

// ---- Steam ゲーム検索の中継 --------------------------------
// ブラウザからは store.steampowered.com が CORS を返さないため、
// サーバ側（GAS）で叩いて結果だけ返す。
// キャッシュは「結果が1件以上取れたときだけ」保存する。
// Steam の一時的な失敗（429 等）で空をキャッシュすると 5 分間ずっと
// 「該当なし」になってしまうため。
function handleSearch(term) {
  term = String(term || '').trim();
  if (term.length < 2) return respond({ items: [] });

  const cache = CacheService.getScriptCache();
  const key = 'ss_' + term.toLowerCase();
  const hit = cache.get(key);
  if (hit) return respond(JSON.parse(hit));

  const url = 'https://store.steampowered.com/api/storesearch/?term=' +
    encodeURIComponent(term) + '&cc=jp&l=japanese';

  let items = [];
  // 最大2回試行（Steam の瞬間的な失敗をリカバリ）
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) Utilities.sleep(600);
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) continue;
      const j = JSON.parse(res.getContentText());
      const list = (j && j.items) || [];
      if (list.length === 0) break; // 200 かつ 0 件＝本当に該当なし。リトライ不要
      items = rankSearchItems(list, term);
      // ノイズ除外で 0 件になったら、素の結果（サントラ等含む）にフォールバック
      if (items.length === 0) {
        items = list.slice(0, 8).map(function (it) {
          return { id: it.id, name: it.name, tiny_image: it.tiny_image || '' };
        });
      }
      break;
    } catch (err) {
      // JSON パース失敗等 → 次の試行へ
    }
  }

  const out = { items: items };
  if (items.length > 0) {
    cache.put(key, JSON.stringify(out), 300); // 取れたものだけ 5 分キャッシュ
  }
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
    // 「配信日はまだ決まっていない」がチェックされている場合は Day1-3 を空にし DatesTBD を立てる
    const datesTBD = body.datesTBD === true || body.datesTBD === '1' || body.datesTBD === 1;
    const rowObj = {
      Timestamp: new Date(),
      TwitchId: user.id,
      TwitchLogin: user.login,
      Streamer: String(body.name || '').trim().slice(0, 60) || user.display,
      TwitchUrl: 'https://www.twitch.tv/' + user.login,
      IconUrl: user.icon,                       // ログインのたび最新アイコンで上書きされる
      AppId: appId,
      Game: details.game || String(body.gameName || '').trim() || ('App ' + appId),
      // クライアントの貼り付けURL（クエリ等）は使わず appId から正規化して生成
      SteamUrl: 'https://store.steampowered.com/app/' + appId + '/',
      HeaderImage: details.header || sanitizeUrl(body.headerImage) ||
                   ('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/' + appId + '/header.jpg'),
      Developer: details.developer || '',
      Day1: datesTBD ? '' : cleanSlots(sched.day1),
      Day2: datesTBD ? '' : cleanSlots(sched.day2),
      Day3: datesTBD ? '' : cleanSlots(sched.day3),
      DatesTBD: datesTBD ? '1' : '',
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
    CacheService.getScriptCache().removeAll(['public_list', 'now_live']); // 一覧・NowLive を即時反映
    return respond({
      ok: true,
      updated: foundRow > 0,
      game: rowObj.Game,
      steamUrl: rowObj.SteamUrl,
      headerImage: rowObj.HeaderImage,
      developer: rowObj.Developer,
    });
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
    if (deleted > 0) CacheService.getScriptCache().removeAll(['public_list', 'now_live']);
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

// 時間帯の複数選択を検証して "," 区切り文字列に正規化する。
// 受け取り: 配列（["夜","深夜"]）または "," 区切り文字列。
// SLOTS 外の値は捨て、重複を除き、SLOTS の並び順（朝→昼→夜→深夜→未定）に整える。
// 何も選ばれていなければ空文字（＝その日は配信しない）。
function cleanSlots(v) {
  var arr;
  if (Array.isArray(v)) arr = v;
  else arr = String(v || '').split(',');
  var picked = arr.map(function (s) { return String(s).trim(); });
  return SLOTS.filter(function (slot) { return picked.indexOf(slot) >= 0; }).join(',');
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
