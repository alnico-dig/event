"""#DIGspotlight アーカイブ（archive/index.html）のデータを作り直すスクリプト。

update_archive.bat をダブルクリックすると実行される。何度実行しても結果は同じ。
  1. 下の VOLS に並べた各回の参加者データを読む
     （アーカイブ化後の固定CSVを優先し、まだ無ければ公開スプレッドシート）
  2. Steam から日本語のゲーム名・デベロッパー・ヘッダー画像を取り直す
     （画像は変わっていれば差し替え。Steam から消えたゲームは前回の名前・画像を残す）
  3. data/games.csv を書き出す（1行＝配信者×ゲーム。ページ側でゲームごとにまとめる）
配信しなかった人は、各回の元データ（CSV／スプレッドシート）から消して対応する。
開催中の回は publish の日付（JST）になるまで一覧に入れない（閉会式で bat を実行して公開する）。
新しい回を足すときは VOLS に1行、archive/index.html の VOLS にも1行足す。
"""
import csv
import datetime
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(HERE, 'data')
IMAGES = os.path.join(HERE, 'images')
GAMES_CSV = os.path.join(DATA, 'games.csv')

JST = datetime.timezone(datetime.timedelta(hours=9))

# 回ごとの設定
#   csv     : アーカイブ化後の固定CSV（ROOT からの相対パス）。あればこちらを読む
#   sheet   : 開催中に読む公開スプレッドシート（CSVエクスポートURL）。csv が無いときだけ使う
#   format  : 'form' = vol1 の Googleフォーム回答の列名／'entries' = vol2 以降の公開シートの列名
#   publish : この日付（JST）になるまで bat を実行しても一覧に入れない。省略時は常に入れる
VOLS = [
    {'vol': '1', 'csv': 'vol1/data/participants.csv', 'format': 'form'},
    {'vol': '2', 'csv': 'vol2/data/participants.csv', 'format': 'entries',
     'sheet': 'https://docs.google.com/spreadsheets/d/1DefWp9Xl6xsvXEoEkDF2ikpB0Lhy0rVfZ7PH-9Jn1s0/export?format=csv',
     'publish': datetime.date(2026, 12, 20)},  # 最終日＝閉会式の日
]

FIELDS = ['Vol', 'AppId', 'Title', 'Developer', 'Streamer', 'TwitchLogin']
UA = {'User-Agent': 'Mozilla/5.0 (DIGspotlight archive builder)'}


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def app_id_of(url):
    m = re.search(r'app/(\d+)', url or '')
    return m.group(1) if m else ''


def login_of(url):
    m = re.search(r'twitch\.tv/([A-Za-z0-9_]+)', url or '')
    return m.group(1).lower() if m else ''


# ---- 各回の参加者 ----
# 元データの1行を共通の形（AppId / Game / Streamer / TwitchLogin）にそろえる
PARSERS = {
    'form': lambda r: {
        'AppId': app_id_of(r.get('Steam URL')),
        'Game': (r.get('ゲームタイトル / Game Title') or '').strip(),
        'Streamer': (r.get('配信者名 / Streamer Name') or '').strip(),
        'TwitchLogin': login_of(r.get('Twitch URL')),
    },
    'entries': lambda r: {
        'AppId': str(r.get('AppId') or '').strip(),
        'Game': (r.get('Game') or '').strip(),
        'Streamer': (r.get('Streamer') or '').strip(),
        'TwitchLogin': (r.get('TwitchLogin') or login_of(r.get('TwitchUrl'))).strip().lower(),
    },
}


def load_vol(v):
    path = os.path.join(ROOT, *v['csv'].split('/'))
    if os.path.exists(path):
        print(f'  vol{v["vol"]}: {v["csv"]} を使用')
        with open(path, encoding='utf-8-sig', newline='') as f:
            text = f.read()
    elif v.get('sheet'):
        print(f'  vol{v["vol"]}: 公開スプレッドシートを使用')
        text = fetch(v['sheet']).decode('utf-8-sig')
    else:
        raise FileNotFoundError(v['csv'])
    parse = PARSERS[v['format']]
    return [dict(parse(r), Vol=v['vol']) for r in csv.DictReader(io.StringIO(text))]


def load_previous():
    """前回の games.csv。Steam から消えたゲームの名前・デベロッパーを引き継ぐために使う。"""
    prev = {}
    if os.path.exists(GAMES_CSV):
        with open(GAMES_CSV, encoding='utf-8-sig', newline='') as f:
            for r in csv.DictReader(f):
                prev.setdefault(r['AppId'], r)
    return prev


# ---- Steam（日本語ストア情報） ----
def fetch_steam_items(app_ids):
    items = {}
    ids = sorted(app_ids, key=int)
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        payload = {
            'ids': [{'appid': int(a)} for a in chunk],
            'context': {'language': 'japanese', 'country_code': 'JP'},
            'data_request': {'include_assets': True, 'include_basic_info': True},
        }
        url = ('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json='
               + urllib.parse.quote(json.dumps(payload)))
        try:
            data = json.loads(fetch(url))
        except Exception as e:  # 取れなかった分は前回の値で埋める
            print(f'  ! Steam 情報の取得に失敗（{len(chunk)}件）: {e}')
            continue
        for it in data.get('response', {}).get('store_items', []):
            if it.get('success') != 1 or not it.get('name'):
                continue
            assets = it.get('assets') or {}
            header = ''
            if assets.get('asset_url_format') and assets.get('header'):
                header = ('https://shared.akamai.steamstatic.com/store_item_assets/'
                          + assets['asset_url_format'].replace('${FILENAME}', assets['header']))
            devs = [d.get('name', '') for d in (it.get('basic_info') or {}).get('developers', [])]
            items[str(it['appid'])] = {
                'name': it['name'],
                'developer': ' / '.join(d for d in devs if d),
                'header': header,
            }
    return items


def update_image(app_id, url):
    """画像を取り直し、中身が変わっていれば上書き。失敗時は既存の画像を残す。"""
    path = os.path.join(IMAGES, f'{app_id}.jpg')
    if not url:
        return 'keep' if os.path.exists(path) else 'missing'
    try:
        body = fetch(url)
    except Exception:
        return 'keep' if os.path.exists(path) else 'missing'
    if os.path.exists(path):
        with open(path, 'rb') as f:
            if f.read() == body:
                return 'same'
    with open(path, 'wb') as f:
        f.write(body)
    return 'updated'


def main():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(IMAGES, exist_ok=True)

    print('参加者データを読み込み中…')
    rows = []
    today = datetime.datetime.now(JST).date()
    for v in VOLS:
        if v.get('publish') and today < v['publish']:
            print(f'  vol{v["vol"]}: {v["publish"]:%Y/%m/%d} の公開日まで一覧に入れません')
            continue
        try:
            rows += load_vol(v)
        except Exception as e:
            # 1回分でも欠けたまま書き出すと、その回が一覧から消えてしまうので中止する
            print(f'  ! vol{v["vol"]} の読み込みに失敗したため中止します: {e}')
            return 1

    kept, seen, skipped = [], set(), 0
    for r in rows:
        if not r['AppId'] or not r['TwitchLogin']:
            skipped += 1
            continue
        key = (r['Vol'], r['AppId'], r['TwitchLogin'])
        if key in seen:  # 同じ人が同じゲームを2回応募していた分
            continue
        seen.add(key)
        kept.append(r)
    if skipped:
        print(f'  ! Steam/Twitch URL が読めない行を {skipped} 件飛ばしました')

    app_ids = {r['AppId'] for r in kept}
    print(f'Steam から {len(app_ids)} タイトルの情報を取得中…')
    items = fetch_steam_items(app_ids)
    prev = load_previous()

    print('ヘッダー画像を確認中…')
    counts = {'updated': 0, 'same': 0, 'keep': 0, 'missing': 0}
    for a in sorted(app_ids, key=int):
        counts[update_image(a, items.get(a, {}).get('header', ''))] += 1
    # 元データから消えたゲームの画像も消す（掲載取り下げ時に画像だけ残らないように）
    removed = 0
    for name in os.listdir(IMAGES):
        if name.endswith('.jpg') and name[:-4] not in app_ids:
            os.remove(os.path.join(IMAGES, name))
            removed += 1

    out = []
    for r in kept:
        it = items.get(r['AppId'])
        p = prev.get(r['AppId'], {})
        out.append({
            'Vol': r['Vol'],
            'AppId': r['AppId'],
            'Title': it['name'] if it else (p.get('Title') or r['Game']),
            'Developer': it['developer'] if it else p.get('Developer', ''),
            'Streamer': r['Streamer'] or r['TwitchLogin'],
            'TwitchLogin': r['TwitchLogin'],
        })
    out.sort(key=lambda o: (-int(o['Vol']), int(o['AppId']), o['TwitchLogin']))

    with open(GAMES_CSV, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(out)

    for vol in sorted({o['Vol'] for o in out}, key=int):
        vs = [o for o in out if o['Vol'] == vol]
        print(f'  vol.{vol}: {len({o["AppId"] for o in vs})} タイトル / '
              f'{len({o["TwitchLogin"] for o in vs})} 名')
    missing_steam = sorted(a for a in app_ids if a not in items)
    if missing_steam:
        print(f'  ! Steam に見つからなかったタイトル（前回の名前・画像を使用）: {", ".join(missing_steam)}')
    print(f'  画像: 更新 {counts["updated"]} / 変化なし {counts["same"]} / '
          f'取得失敗で据え置き {counts["keep"]} / 画像なし {counts["missing"]} / 削除 {removed}')
    print('完了しました。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
