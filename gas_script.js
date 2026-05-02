// ============================================================
// DIGspotlight 申請編集システム - Google Apps Script
// ============================================================
// 【使い方】
// 1. スプレッドシートを開き「拡張機能 → Apps Script」でこのコードを貼り付け
// 2. CONFIG の spreadsheetId と formId を設定
//    - formId はフォームの編集URL https://docs.google.com/forms/d/★ここ★/edit の★部分
// 3. setup_createTrigger() を1回だけ実行（フォーム送信の自動保存トリガー）
// 4. setup_backfillEditUrls() を1回だけ実行（既存申請者の編集URLを一括取得）
// 5. 「デプロイ → 新しいデプロイ」→ 種類: ウェブアプリ
//    - 次のユーザーとして実行: 自分
//    - アクセスできるユーザー: 全員（Googleアカウント不要）
// 6. 表示されたウェブアプリURLを edit.html の GAS_URL に貼り付け
// ============================================================

const CONFIG = {
  spreadsheetId: '17mMvupAwNM2ssbHjiHhXNRfUujoXQYeXgkSAQjL6G-g',
  formId: '1qNvS73pHgk32Ivt3e1xSmhJ5euah9MPxKZ4dYYGRqHE',
  twitchClientId: 'kp13odpytkan0tqo6xmgj5509h4104',
  editUrlsSheet: 'EditURLs',
  fields: {
    twitch: ['Twitch', 'twitch', 'チャンネル'],
    game:   ['Game', 'ゲーム', 'game', 'タイトル'],
  }
};

// ============================================================
// 【手順3】初回のみ実行：フォーム送信トリガーを作成
// ============================================================
function setup_createTrigger() {
  // 既存の同名トリガーを削除（重複防止）
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
// 【手順4】初回のみ実行：既存申請者の編集URLを一括取得して保存
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
      // 同じTwitch+Gameの既存行は最新URLで上書き
      sheet.getRange(existingRow, 3).setValue(res.getEditResponseUrl());
    } else {
      sheet.appendRow([twitch, game, res.getEditResponseUrl(), res.getTimestamp()]);
      added++;
    }
  });

  Logger.log('Backfill完了：' + added + '件追加（既存行は上書き済み）');
}

// ============================================================
// フォーム送信時の自動保存（トリガーから自動実行）
// ============================================================
function onFormSubmit(e) {
  const { twitch, game } = extractFields(e.response.getItemResponses());
  if (!twitch || !game) return;

  const sheet = getOrCreateEditSheet();
  const existingRow = findRowIndex(sheet, twitch, game);

  if (existingRow > 0) {
    sheet.getRange(existingRow, 3).setValue(e.response.getEditResponseUrl());
    sheet.getRange(existingRow, 4).setValue(e.response.getTimestamp());
  } else {
    sheet.appendRow([twitch, game, e.response.getEditResponseUrl(), e.response.getTimestamp()]);
  }
}

// ============================================================
// 【デバッグ用】UrlFetchApp の認証確認（確認後は削除してOK）
// ============================================================
function testUrlFetch() {
  const res = UrlFetchApp.fetch('https://api.twitch.tv/helix/users', {
    headers: {
      'Authorization': 'Bearer test',
      'Client-Id': CONFIG.twitchClientId
    },
    muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
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

  const editRows = editSheet.getDataRange().getValues().slice(1); // ヘッダー行を除く

  // メインシートから表示データを取得
  const mainSheet = ss.getSheets()[0];
  const mainRows = mainSheet.getDataRange().getValues();
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
