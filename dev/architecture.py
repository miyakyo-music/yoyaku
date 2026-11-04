# 構成図（docs/構成図.svg・docs/構成図.png）を作る台本。部品やつながりが変わったら、ここを直して作り直す。
#   python3 dev/architecture.py docs/構成図.svg
#   PNG は SVG を Chromium で開いて2倍で撮る（例: playwright の screenshot）
import sys
W,H=2000,1460
O=[]
L=[]
def a(s): O.append(s)
IC={
'mail':'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
'person':'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
'people':'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.8 2.9-6 6.5-6s6.5 2.2 6.5 6"/><circle cx="17" cy="9" r="2.8"/><path d="M16.5 14.2c3 .3 5 2.3 5 5.3"/>',
'wrench':'<path d="M14.5 6.5a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8M9.5 17.5 3 11l2.5-2.5"/><path d="M14.7 6.3 17.5 3.5a4.5 4.5 0 0 0-6 6l-8 8 3 3 8-8a4.5 4.5 0 0 0 6-6l-2.8 2.8-2.3-.7z" />',
'browser':'<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M2.5 9h19"/><circle cx="5.5" cy="6.5" r=".6"/><circle cx="7.8" cy="6.5" r=".6"/>',
'hex':'<path d="M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3z"/><path d="m9.5 9-2.5 3 2.5 3M14.5 9l2.5 3-2.5 3"/>',
'db':'<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
'radio':'<circle cx="12" cy="12" r="2"/><path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8M5 5a9.9 9.9 0 0 0 0 14M19 5a9.9 9.9 0 0 1 0 14"/>',
'clock':'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
'code':'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m9.5 8.5-3.5 3.5 3.5 3.5M14.5 8.5l3.5 3.5-3.5 3.5"/>',
'sheet':'<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M4 8.5h16M4 13h16M4 17.5h16M10 8.5v13"/>',
'branch':'<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3.5-11 7"/>',
'check':'<circle cx="12" cy="12" r="9"/><path d="m7.5 12.3 3 3 6-6.3"/>',
'upload':'<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14"/>',
'pulse':'<path d="M2.5 12h4l2.5-6 4.5 12 2.5-6h5.5"/>',
'globe':'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 3.8 5.7 3.8 9s-1.2 6.3-3.8 9c-2.6-2.7-3.8-5.7-3.8-9S9.4 5.7 12 3z"/>',
'key':'<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
'cloud':'<path d="M7 18.5h10.5a4 4 0 0 0 .6-8 5.8 5.8 0 0 0-11.1-1.2A4.6 4.6 0 0 0 7 18.5z"/>',
'google':'<path d="M20.5 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h4.8a4.2 4.2 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.6z"/><path d="M12 21c2.4 0 4.5-.8 5.9-2.2l-2.9-2.2c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21zM7 13.8a5.4 5.4 0 0 1 0-3.6V7.9H4a9 9 0 0 0 0 8.2zM12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 4 7.9l3 2.3c.7-2.1 2.7-3.6 5-3.6z"/>',
'gh':'<path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.6-.2.6-.5v-1.7c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6.9.1 1.4 1 1.4 1 .8 1.5 2.2 1 2.7.8.1-.6.3-1 .6-1.2-2.1-.2-4.3-1.1-4.3-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.5 1 2.6 0 3.7-2.2 4.5-4.3 4.7.3.3.6.9.6 1.8v2.6c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z"/>',
}
FONT="'Hiragino Sans','Noto Sans JP','IPAPGothic',sans-serif"
MONO="'SF Mono','Menlo','DejaVu Sans Mono',monospace"
def icon(name,x,y,s,col,fill=False):
    k=s/24
    st=f'fill="{col}" stroke="none"' if fill else f'fill="none" stroke="{col}" stroke-width="{1.8}" stroke-linecap="round" stroke-linejoin="round"'
    a(f'<g transform="translate({x},{y}) scale({k})" {st}>{IC[name]}</g>')
def node(x,y,name,col,label,sub,dashed=False,fill=False,bg='#f7f8fa'):
    d=' stroke-dasharray="5 4"' if dashed else ''
    a(f'<rect x="{x-37}" y="{y-37}" width="74" height="74" rx="14" fill="#fff" stroke="#d9dde3"{d} filter="url(#sh)"/>')
    icon(name,x-19,y-19,38,col,fill)
    a(f'<text x="{x}" y="{y+63}" text-anchor="middle" font-family="{FONT}" font-size="17" font-weight="700" fill="#1f2328" paint-order="stroke" stroke="{bg}" stroke-width="6">{label}</text>')
    for i,s in enumerate(sub.split('\n')):
        a(f'<text x="{x}" y="{y+85+i*17}" text-anchor="middle" font-family="{MONO}" font-size="12.5" fill="#6e7781" paint-order="stroke" stroke="{bg}" stroke-width="5">{s}</text>')
def group(x,y,w,h,title,col,bg,ic=None,dashed=False,tcol=None):
    d=' stroke-dasharray="6 5"' if dashed else ''
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="{bg}" stroke="{col}" stroke-width="1.4"{d}/>')
    tx=x+18
    if ic:
        icon(ic,x+16,y+15,20,tcol or col, ic in('google','gh')); tx=x+44
    a(f'<text x="{tx}" y="{y+31}" font-family="{FONT}" font-size="16" font-weight="700" fill="{tcol or col}">{title}</text>')
def line(pts,col='#57606a',dash=False,label=None,lp=None,anchor='middle',lcol=None,w=1.7):
    d=' stroke-dasharray="6 5"' if dash else ''
    p=' '.join(f'{x},{y}' for x,y in pts)
    m={'#1a73e8':'blue','#cf222e':'red'}.get(col,'gray')
    L.append(f'<polyline points="{p}" fill="none" stroke="{col}" stroke-width="{w}"{d} marker-end="url(#ar{m})"/>')
    if label:
        lx,ly=lp
        L.append(f'<text x="{lx}" y="{ly}" text-anchor="{anchor}" font-family="{FONT}" font-size="13" fill="{lcol or col}" paint-order="stroke" stroke="#f7f8fa" stroke-width="5">{label}</text>')
B='#1a73e8'; G='#57606a'
a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
a('<defs><pattern id="gr" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#e8ebef" stroke-width="1"/></pattern>'
  '<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#1f2328" flood-opacity=".10"/></filter>'
  '<marker id="arblue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="#1a73e8"/></marker>'
  '<marker id="arred" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="#cf222e"/></marker>'
  '<marker id="argray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" fill="#57606a"/></marker></defs>')
a(f'<rect width="{W}" height="{H}" fill="#f7f8fa"/><rect width="{W}" height="{H}" fill="url(#gr)"/>')
a(f'<text x="40" y="58" font-family="{FONT}" font-size="26" font-weight="700" fill="#1f2328">練習室予約システム 構成図</text>')
a(f'<text x="40" y="86" font-family="{MONO}" font-size="13" fill="#6e7781">miyakyo-music/yoyaku ・ 2026-11-04 時点のコードと設定から（dev/architecture.py で作り直せる）</text>')
# groups
group(250,400,360,340,'GitHub Pages','#8c959f','#f6f7f9','gh',tcol='#24292f')
group(700,120,650,820,'Cloudflare（yoyaku-cache）','#f38020','#fff5ec','cloud')
group(1430,120,520,820,'Google（Apps Script ＋ スプレッドシート）','#34a853','#f1f8f3','google',tcol='#1e7e34')
group(250,1090,1240,320,'GitHub Actions（main に push で動く）','#8c959f','#ffffff','gh',dashed=True,tcol='#24292f')
a('<!--N-->')
# nodes
node(110,450,'person',G,'学生・利用者','ブラウザ / ホーム画面')
node(110,680,'people',G,'教員・管理者','管理画面 / パスキー')
node(110,1250,'wrench',G,'保守担当','git push')
node(430,560,'browser','#24292f','予約表・管理画面','web/ ・ 静的ファイル\nService Worker',bg='#f6f7f9')
node(940,560,'hex','#f38020','Worker','worker.js\n入口・パスキーの確認',bg='#fff5ec')
node(1180,560,'db','#f38020','Store','予約の正本 / store.js\nSQLite ・ 30日前まで戻せる',bg='#fff5ec')
node(1180,330,'radio','#f38020','Hub','リアルタイム同期\nWebSocket /live',bg='#fff5ec')
node(940,330,'db','#c2410c','D1','予約表の写し\nGAS が正本のとき',bg='#fff5ec')
node(1180,790,'pulse','#cf222e','監視用 Worker','yoyaku-monitor / 5分ごと\nGAS の版を main と比べる',bg='#fff5ec')
node(1570,560,'code','#1a73e8','GAS','Code.gs / ウェブアプリ\nもう一つの正本の道',bg='#f1f8f3')
node(1810,560,'sheet','#34a853','スプレッドシート','写し ・ 6枚のシート\n閲覧・控え用',bg='#f1f8f3')
node(1570,790,'clock','#34a853','トリガー','cacheRetry / 5分ごと',bg='#f1f8f3')
node(1810,790,'mail','#34a853','メール','MailApp / 保守担当へ',bg='#f1f8f3')
node(370,1250,'branch','#24292f','リポジトリ','main',bg='#ffffff')
node(560,1250,'check','#1a7f37','試験','node --test',bg='#ffffff')
node(750,1250,'upload','#24292f','Pages に公開','pages.yml',bg='#ffffff')
node(940,1250,'upload','#f38020','Cloudflare に公開','cache-deploy.yml',bg='#ffffff')
node(1130,1250,'upload','#1a73e8','GAS に反映','clasp / gas-deploy.yml',bg='#ffffff')
node(1350,1250,'pulse','#cf222e','見張り（予備）','monitor.yml / 1日1回\n失敗で GitHub からメール',bg='#ffffff')
# arrows users
line([(155,450),(205,450),(205,548),(388,548)],B,label='HTTPS',lp=(330,538),lcol=B)
line([(155,680),(205,680),(205,572),(388,572)],B)
line([(475,545),(898,545)],B,label='予約表を読む ・ 予約する',lp=(686,535),lcol=B)
line([(475,577),(898,577)],B,label='/schedule  /api  /live  /passkey',lp=(686,600),lcol=B)
line([(430,515),(430,215),(1555,215),(1555,518)],B,dash=True,label='正本が GAS のとき ・ 写しが使えないとき（GAS から直接）',lp=(1000,205),lcol=B)
line([(985,560),(1138,560)],G,label='/api',lp=(1060,550))
line([(920,515),(920,448)],G,label='写しを読む',lp=(910,490),anchor='end')
line([(962,515),(962,480),(1180,480),(1180,448)],G,label='変更を知らせる',lp=(1075,472))
line([(1222,540),(1528,540)],G,label='変更の10秒後に合図（mirrorNow）',lp=(1375,530))
line([(1528,572),(1222,572)],G,label='変更を読みに行く（/mirror/changes）',lp=(1375,595))
line([(1592,518),(1592,262),(940,262),(940,290)],G,dash=True,label='/push（正本が GAS のとき）',lp=(1265,254))
line([(1612,560),(1768,560)],G,label='写す',lp=(1690,550))
line([(1570,752),(1570,672)],G,label='5分ごとに起動',lp=(1582,718),anchor='start')
line([(1138,775),(1015,775),(1015,680)],'#cf222e',label='GET / 正本・写し・版',lp=(1025,765),anchor='start',lcol='#cf222e')
line([(1138,808),(1080,808),(1080,912),(400,912),(400,675)],'#cf222e',label='画面が開けるか',lp=(700,904),lcol='#cf222e')
line([(1222,790),(1470,790),(1470,672)],'#cf222e',label='悪い状態が続いたら（monitorAlert）',lp=(1346,780),lcol='#cf222e')
line([(1612,590),(1700,590),(1700,790),(1768,790)],G,label='送る',lp=(1708,700),anchor='start')
line([(155,1250),(328,1250)],G,label='git push',lp=(240,1240))
line([(412,1250),(518,1250)],G)
line([(560,1350),(560,1375),(1130,1375),(1130,1348)],G,label='試験に通ったときだけ',lp=(845,1397))
line([(750,1375),(750,1348)],G); line([(940,1375),(940,1348)],G)
line([(750,1208),(750,1060),(470,1060),(470,675)],G,dash=True,label='web/',lp=(480,1052),anchor='start')
line([(940,1208),(940,680)],G,dash=True,label='cache/ ・ monitor/',lp=(950,1040),anchor='start')
line([(1130,1208),(1130,1000),(1505,1000),(1505,680)],G,dash=True,label='gas/',lp=(1515,980),anchor='start')
line([(1350,1208),(1350,960),(1260,960),(1260,905)],'#cf222e',dash=True,label='両方の Worker を見る',lp=(1360,985),anchor='start',lcol='#cf222e')
i=O.index('<!--N-->'); O[i:i+1]=[]
O[i:i]=L
a('</svg>')
open(sys.argv[1],'w').write('\n'.join(O))
