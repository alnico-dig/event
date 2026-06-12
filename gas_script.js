// ============================================================
// DIGspotlight 申請編集システム - Google Apps Script
// ============================================================
// 【初回セットアップ手順】
// 1. setup_createTrigger()       — フォーム送信トリガーを作成（1回のみ）
// 2. setup_backfillEditUrls()    — 既存申請者の編集URLを一括取得（1回のみ）
// 3. setup_syncDisplaySheet()    — 表示用シートへ既存データをコピー（1回のみ）
// 4. setup_resyncFromForms()     — フォームから最新データで表示用を上書き（1回のみ）
// 5. デプロイ → 新しいデプロイ（ウェブアプリ、全員アクセス可）
// ============================================================

const CONFIG = {
  spreadsheetId: '17mMvupAwNM2ssbHjiHhXNRfUujoXQYeXgkSAQjL6G-g',
  formId: '1qNvS73pHgk32Ivt3e1xSmhJ5euah9MPxKZ4dYYGRqHE',
  twitchClientId: 'kp13odpytkan0tqo6xmgj5509h4104',
  editUrlsSheet: 'EditURLs',
  displaySheet:  '表示用',
  fields: {
    twitch: ['Twitch', 'twitch', 'チャンネル'],
    game:   ['Game', 'ゲーム', 'game', 'タイトル'],
  }
};

// ============================================================
// 【手順1】初回のみ：フォーム送信トリガーを作成
// ============================================================
function setup_createTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onFormSubmit')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('onFormSubmit')
    .forForm(FormApp.openById(CONFIG.formId))
    .onFormSubmit()
    .create();

  Logger.log('トリガー作成完了');
}

// ============================================================
// 【手順2】初回のみ：既存申請者の編集URLを一括取得して保存
// ============================================================
function setup_backfillEditUrls() {
  const sheet = getOrCreateEditSheet();
  const form = FormApp.openById(CONFIG.formId);
  const responses = form.getResponses();
  let added = 0;

  responses.forEach(res => {
    const { twitch, game } = extractFields(res.getItemResponses());
    if (!twitch || !game) return;

    const existingRow = findRowIndex(sheet, twitch, game);
    if (existingRow > 0) {
      sheet.getRange(existingRow, 3).setValue(res.getEditResponseUrl());
    } else {
      sheet.appendRow([twitch, game, res.getEditResponseUrl(), res.getTimestamp()]);
      added++;
    }
  });

  Logger.log('Backfill完了：' + added + '件追加（既存行は上書き済み）');
}

// ============================================================
// 【手順3】初回のみ：表示用シートへフォーム回答シートをコピー
// ============================================================
function setup_syncDisplaySheet() {
  const ss        = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const srcSheet  = ss.getSheets()[0];
  const dispSheet = ss.getSheetByName(CONFIG.displaySheet);
  if (!dispSheet) { Logger.log('表示用シートが見つかりません'); return; }

  dispSheet.clearContents();
  const srcData = srcSheet.getDataRange().getValues();
  if (srcData.length > 0) {
    dispSheet.getRange(1, 1, srcData.length, srcData[0].length).setValues(srcData);
  }
  Logger.log('コピー完了：' + srcData.length + '行');
}

// ============================================================
// 【手順4】初回のみ：Googleフォームの最新回答で表示用を上書き
// 　　　　 手動ソート順は保持したまま、各行のデータだけ更新される
// ============================================================
function setup_resyncFromForms() {
  const ss        = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const dispSheet = ss.getSheetByName(CONFIG.displaySheet);
  if (!dispSheet) { Logger.log('表示用シートが見つかりません'); return; }

  const dispData   = dispSheet.getDataRange().getValues();
  const dispHeader = dispData[0];
  const twitchCol  = dispHeader.findIndex(h => CONFIG.fields.twitch.some(k => String(h).includes(k)));
  const gameCol    = dispHeader.findIndex(h => CONFIG.fields.game.some(k => String(h).includes(k)));
  if (twitchCol < 0 || gameCol < 0) { Logger.log('列が見つかりません'); return; }

  // フォームの全回答から twitch+game ごとに最新回答を取得
  const form = FormApp.openById(CONFIG.formId);
  const latestMap = {};
  form.getResponses().forEach(res => {
    const { twitch, game } = extractFields(res.getItemResponses());
    if (!twitch || !game) return;
    const key = twitch + '|' + game;
    if (!latestMap[key] || res.getTimestamp() > latestMap[key].getTimestamp()) {
      latestMap[key] = res;
    }
  });

  let updated = 0;
  Object.values(latestMap).forEach(res => {
    const itemResponses = res.getItemResponses();
    const { twitch, game } = extractFields(itemResponses);

    const existingIdx = dispData.findIndex((r, i) =>
      i > 0 &&
      normalizeTwitch(r[twitchCol]) === twitch &&
      String(r[gameCol]).trim() === game
    );
    if (existingIdx < 1) return;

    const row = buildRow(dispHeader, itemResponses, res.getTimestamp());
    dispSheet.getRange(existingIdx + 1, 1, 1, row.length).setValues([row]);
    dispData[existingIdx] = row; // メモリ上も更新して後続の findIndex を正確に保つ
    updated++;
  });

  Logger.log('再同期完了：' + updated + '行更新');
}

// ============================================================
// フォーム送信・編集時の自動処理（トリガーから自動実行）
// ============================================================
function onFormSubmit(e) {
  const itemResponses = e.response.getItemResponses();
  const { twitch: newTwitch, game: newGame } = extractFields(itemResponses);
  if (!newTwitch || !newGame) return;

  const editUrl   = e.response.getEditResponseUrl();
  const editSheet = getOrCreateEditSheet();
  const editRows  = editSheet.getDataRange().getValues();

  // 編集URLで既存エントリを検索（ゲーム名変更に対応）
  const existingIdx = editRows.findIndex((r, i) => i > 0 && r[2] === editUrl);
  let oldTwitch = newTwitch;
  let oldGame   = newGame;

  if (existingIdx > 0) {
    oldTwitch = editRows[existingIdx][0];
    oldGame   = editRows[existingIdx][1];
    editSheet.getRange(existingIdx + 1, 1, 1, 4).setValues([[newTwitch, newGame, editUrl, e.response.getTimestamp()]]);
  } else {
    editSheet.appendRow([newTwitch, newGame, editUrl, e.response.getTimestamp()]);
  }

  syncDisplaySheet(oldTwitch, oldGame, newTwitch, newGame, itemResponses, e.response.getTimestamp());
}

// ============================================================
// 表示用シートを更新（イベントデータを直接使用）
// ============================================================
function syncDisplaySheet(oldTwitch, oldGame, newTwitch, newGame, itemResponses, timestamp) {
  const ss        = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const dispSheet = ss.getSheetByName(CONFIG.displaySheet);
  if (!dispSheet) return;

  const dispData   = dispSheet.getDataRange().getValues();
  const dispHeader = dispData[0];
  const twitchCol  = dispHeader.findIndex(h => CONFIG.fields.twitch.some(k => String(h).includes(k)));
  const gameCol    = dispHeader.findIndex(h => CONFIG.fields.game.some(k => String(h).includes(k)));
  if (twitchCol < 0 || gameCol < 0) return;

  const row = buildRow(dispHeader, itemResponses, timestamp);

  // 変更前のキーで検索、見つからなければ変更後のキーで検索
  let existingIdx = dispData.findIndex((r, i) =>
    i > 0 &&
    normalizeTwitch(r[twitchCol]) === oldTwitch &&
    String(r[gameCol]).trim() === oldGame
  );
  if (existingIdx < 1) {
    existingIdx = dispData.findIndex((r, i) =>
      i > 0 &&
      normalizeTwitch(r[twitchCol]) === newTwitch &&
      String(r[gameCol]).trim() === newGame
    );
  }

  if (existingIdx > 0) {
    dispSheet.getRange(existingIdx + 1, 1, 1, row.length).setValues([row]);
  } else {
    dispSheet.appendRow(row);
  }
}

// ============================================================
// Web App エンドポイント（edit.html から fetch で呼ばれる）
// GET ?token=<Twitchアクセストークン>
// ============================================================
function doGet(e) {
  const token = e.parameter.token || '';
  if (!token) return respond({ error: 'token parameter required' });

  let twitch;
  try {
    const res = UrlFetchApp.fetch('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id': CONFIG.twitchClientId
      },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 401) return respond({ error: 'token_expired' });
    if (res.getResponseCode() !== 200) return respond({ error: 'twitch_api_error' });
    const json = JSON.parse(res.getContentText());
    twitch = normalizeTwitch((json.data[0] || {}).login || '');
  } catch (err) {
    return respond({ error: 'twitch_api_failed' });
  }

  if (!twitch) return respond({ error: 'no_user' });

  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const editSheet = ss.getSheetByName(CONFIG.editUrlsSheet);
  if (!editSheet) return respond({ error: 'not initialized - run setup_backfillEditUrls first' });

  const editRows = editSheet.getDataRange().getValues().slice(1);

  const mainSheet  = ss.getSheetByName(CONFIG.displaySheet) || ss.getSheets()[0];
  const mainRows   = mainSheet.getDataRange().getValues();
  const mainHeader = mainRows[0];
  const col = kw => mainHeader.findIndex(h => h && h.toString().includes(kw));
  const C = {
    twitch: col('Twitch'), game:  col('Game'),  steam: col('Steam'),
    date:   col('Date'),   time:  col('Time'),  lang:  col('Language'), notes: col('Notes')
  };

  const results = editRows
    .filter(r => (r[0] || '') === twitch)
    .map(r => {
      const game = r[1];
      const main = mainRows.slice(1).find(m =>
        normalizeTwitch(m[C.twitch] || '') === twitch &&
        (m[C.game] || '').trim() === game
      );
      return {
        game,
        steam:    (main && C.steam  >= 0) ? main[C.steam]  : '',
        date:     (main && C.date   >= 0) ? main[C.date]   : '',
        time:     (main && C.time   >= 0) ? main[C.time]   : '',
        language: (main && C.lang   >= 0) ? main[C.lang]   : '',
        notes:    (main && C.notes  >= 0) ? main[C.notes]  : '',
        editUrl:  r[2]
      };
    });

  return respond(results);
}

// ── ヘルパー関数 ─────────────────────────────────────────────

// フォームの回答項目をスプレッドシートの列に対応する行配列に変換
function buildRow(header, itemResponses, timestamp) {
  const row = new Array(header.length).fill('');
  itemResponses.forEach(item => {
    const colIdx = header.findIndex(h => String(h) === item.getItem().getTitle());
    if (colIdx >= 0) {
      const res = item.getResponse();
      row[colIdx] = Array.isArray(res) ? res.join(', ') : res;
    }
  });
  if (timestamp) {
    const tsCol = header.findIndex(h => {
      const s = String(h).toLowerCase();
      return s === 'timestamp' || s === 'タイムスタンプ';
    });
    if (tsCol >= 0) row[tsCol] = timestamp;
  }
  return row;
}

function getOrCreateEditSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  let sheet = ss.getSheetByName(CONFIG.editUrlsSheet);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.editUrlsSheet);
    sheet.appendRow(['twitch', 'game', 'editUrl', 'timestamp']);
  }
  return sheet;
}

function extractFields(itemResponses) {
  let twitch = '', game = '';
  itemResponses.forEach(item => {
    const title = item.getItem().getTitle();
    if (CONFIG.fields.twitch.some(k => title.includes(k))) twitch = normalizeTwitch(item.getResponse());
    if (CONFIG.fields.game.some(k => title.includes(k)))   game   = (item.getResponse() || '').trim();
  });
  return { twitch, game };
}

function findRowIndex(sheet, twitch, game) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === twitch && rows[i][1] === game) return i + 1;
  }
  return -1;
}

function normalizeTwitch(url) {
  return (url || '')
    .replace(/https?:\/\/(www\.)?twitch\.tv\//i, '')
    .split('?')[0]
    .replace(/\//g, '')
    .toLowerCase()
    .trim();
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
