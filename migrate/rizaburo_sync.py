# りざぶ郎 → この予約システム（Cloudflare の正本）へ、予約を移す。りざぶ郎から切り替わるまでの一時的なもの。
# GitHub Actions（.github/workflows/rizaburo-sync.yml）が5分ごとに流す。手元でも流せる:
#   R326_GROUP=… python3 migrate/rizaburo_sync.py                                   … 今日から再来週の日曜まで
#   R326_GROUP=… CACHE_PUSH_TOKEN=… python3 migrate/rizaburo_sync.py 2026-09-01 2026-10-13 … 期間を指定（過去分も）
# - りざぶ郎の「CSVダウンロード」は表示中の1日分だけなので、日付を切り替えながら1日ずつ書き出す（1日あたり通信2回）
# - 予約は氏名・学籍番号も含めてそのまま移す。まだ終わっていない予約は、ふつうの予約（/api）として入れる。
#   終わった予約は、合言葉つきの /import-past（一時的な入口）で入れる
# - 本番にすでにある予約（日付・部屋・時刻・学籍番号・氏名が同じ）は飛ばす。りざぶ郎での取消は移さない
# - リポジトリは公開で Actions の記録も誰でも読めるので、記録（print）には氏名・学籍番号を出さない
import os, re, sys, csv, io, json, time, datetime, unicodedata, urllib.parse, urllib.request, http.cookiejar

G = os.environ['R326_GROUP']
TOKEN = os.environ.get('CACHE_PUSH_TOKEN', '').strip()
R = 'https://www.r326.com/b/'
W = os.environ.get('CACHE_API_URL', 'https://yoyaku-cache.kuridanho.workers.dev')
UA = {'User-Agent': 'Mozilla/5.0'}
JST = datetime.timezone(datetime.timedelta(hours=9))
now = datetime.datetime.now(JST)
today = now.date()
if len(sys.argv) >= 3:
    d0, d1 = datetime.date.fromisoformat(sys.argv[1]), datetime.date.fromisoformat(sys.argv[2])
else:
    d0, d1 = today, today + datetime.timedelta(days=6 - today.weekday() + 14)  # 再来週の日曜まで

op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op.addheaders = list(UA.items())
def rget(u, data=None):
    return op.open(R + u, urllib.parse.urlencode(data).encode() if data is not None else None, timeout=30).read().decode('utf-8')
def wget(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(W + path, headers=UA), timeout=30))
def wpost(path, body, auth=None):
    h = {'Content-Type': 'application/json', **UA}
    if auth: h['Authorization'] = 'Bearer ' + auth
    return json.load(urllib.request.urlopen(urllib.request.Request(W + path, data=json.dumps(body).encode(), headers=h), timeout=30))
sid = lambda h: re.search(r'var statusId="([^"]*)"', h).group(1)
t0 = time.time()

# 1) りざぶ郎から1日ずつ書き出す
lines = []
st = sid(rget('main.aspx?g=' + G))
d = d0
while d <= d1:
    st = sid(rget('main.aspx?g=' + G, {'date': d.strftime('%Y/%m/%d'), 'status': st}))  # 表示する日を切り替える
    rows = [l for l in rget(f'csv.aspx?g={G}&status={st}', {'del': '0', 'code': '0', 'ok': 'ok'}).splitlines() if l and not l.startswith('#')]
    if any(l.split(',')[2][:8] != d.strftime('%Y%m%d') for l in rows): sys.exit(f'{d}: 別の日の予約が混ざったので止めます')
    lines += rows
    d += datetime.timedelta(days=1)
    time.sleep(0.3)
t1 = time.time()

# 2) 本番の予約（重複を飛ばすため）と部屋。一度に読める期間に上限（42日）があるので、30日ずつ
have, rooms = set(), []
d = d0
while d <= d1:
    e = min(d1, d + datetime.timedelta(days=29))
    s = wget(f'/schedule?from={d}&to={e}')
    if not s.get('ok'): sys.exit('本番の予約表を読めませんでした')
    rooms = s['rooms']
    have |= {(r['date'], r['roomId'], r['start'], r['end'], r['affiliation'], r['name']) for r in s['reservations']}
    d = e + datetime.timedelta(days=1)

# 3) 本番の形に直す。部屋は番号と「P.n」（電子ピアノの番号）で当てる。時刻は5分刻みに（開始は切り下げ、終了は切り上げ）
def room_id(name):
    n = unicodedata.normalize('NFKC', name)
    num = int(re.match(r'練習室(\d+)', n).group(1))
    p = re.search(r'P\.(\d+)', n)
    c = [r for r in rooms if r['name'] == f'練習室{num}' and (not p or r['tags'] == f'電子P.{p.group(1)}')]
    if len(c) != 1: raise ValueError('部屋が決まらない: ' + n)
    return c[0]['id']
def hm(s, up):
    m = int(s[8:10]) * 60 + int(s[10:12])
    m = (m + 4) // 5 * 5 if up else m // 5 * 5
    return f'{m // 60:02d}:{m % 60:02d}'
future, past, bad = [], [], 0
for row in csv.reader(io.StringIO('\n'.join(lines))):
    try:
        s, e = row[2], row[3]
        who = unicodedata.normalize('NFKC', row[4]).strip()
        m = re.match(r'([A-Za-z0-9]*\d[A-Za-z0-9]*)\s*・?\s*(.*)$', who)
        aff, name = (m.group(1).upper(), m.group(2).strip()) if m else ('', who)
        p = dict(date=f'{s[:4]}-{s[4:6]}-{s[6:8]}', start=hm(s, False), end=hm(e, True), roomId=room_id(row[0]),
                 affiliation=aff, name=name or aff, memo='', pin='')
    except Exception as ex:
        bad += 1
        print('読めない行:', row[0], row[2], type(ex).__name__)
        continue
    if (p['date'], p['roomId'], p['start'], p['end'], p['affiliation'], p['name']) in have: continue
    (past if f"{p['date']} {p['end']}" <= now.strftime('%Y-%m-%d %H:%M') else future).append(p)

# 4) 登録
ok, ng = 0, 0
for p in future:
    r = wpost('/api', {'action': 'createReservation', 'params': p, 'v': 1})
    if r.get('ok'): ok += 1
    else:
        ng += 1
        print('登録できない:', p['date'], p['start'], p['roomId'], r.get('code') or '', (r.get('message') or '').split('（')[0])
if past:
    if not TOKEN: sys.exit(f'終わった予約が{len(past)}件ありますが、CACHE_PUSH_TOKEN がないので入れられません')
    for i in range(0, len(past), 200):
        r = wpost('/import-past', {'rows': past[i:i + 200]}, TOKEN)
        if not r.get('ok'): sys.exit('過去分の取り込みに失敗: ' + str(r.get('message')))
        ok += r['count']
        for x in r['skipped']:
            ng += 1
            print('登録できない:', x['row']['date'], x['row']['start'], x['row']['roomId'], x['reason'].split('（')[0])
print(f'{d0}〜{d1}（{(d1 - d0).days + 1}日）: りざぶ郎 {len(lines)}件・{t1 - t0:.1f}秒 / 新規 {len(future) + len(past)}件'
      f'（登録 {ok}・できない {ng}・読めない {bad}） / 全体 {time.time() - t0:.1f}秒')
if ng or bad: sys.exit(1)  # Actions で赤く出して気づけるように
