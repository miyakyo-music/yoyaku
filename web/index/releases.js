// 予約表: 更新情報（フッタの版を押すと小窓で出す）
'use strict';

// 利用者に関係する変更だけを、新しい順に書く。内部の仕組みの変更や細かな修正は書かない（GitHub の履歴に残る）。
// admin: true は管理者だけが使う変更（「管理」の札を付ける）
const RELEASES = [
  { ver: 'v0.8.1-beta', date: '2026-10-13', items: [
    '予約を取り消したあと5秒間は「元に戻す」で取り消しをやめられるようにしました',
    'カレンダーを左右になぞって月を切り替えられるようにしました',
    'カレンダーの見た目を iPhone・Mac のカレンダーに近づけました',
    '電波がないときは、送る前に知らせるようにしました（入力は消えません）',
    '長いお知らせは、押すと全文が見られるようにしました',
    { text: '操作の記録（変更履歴）を見られるようにしました', admin: true },
  ] },
  { ver: 'v0.7.1-beta', date: '2026-10-11', items: [
    { text: '予約履歴を検索・印刷し、Excel・PDF で書き出せるようにしました', admin: true },
    { text: '予約履歴から予約を選んで削除できるようにしました', admin: true },
  ] },
  { ver: 'v0.6.1-beta', date: '2026-10-11', items: [
    '23時を過ぎて開いたときは、翌日の予約表を出すようにしました',
    'iPhone で開始時刻が勝手に変わることがある不具合を直しました',
  ] },
  { ver: 'v0.5.7-beta', date: '2026-10-10', items: [
    '予約を名前などで検索できるようにしました',
    'よく使う練習室を「お気に入り」にして絞り込めるようにしました',
    '自分の予約から、練習した時間の合計が見られるようにしました',
    'ほかの人の予約が、すぐ予約表に出るようにしました',
    '予約の帯を長押しして、つかんで動かせるようにしました',
  ] },
  { ver: 'v0.5.6-beta', date: '2026-10-10', items: [
    '開始・終了の時刻をホイールで選べるようにしました',
    'ホーム画面に追加して、アプリのように使えるようにしました',
    '予約の詳細から、端末のカレンダーに追加できるようにしました',
    { text: '予約をほかの日・部屋にコピーできるようにしました', admin: true },
  ] },
  { ver: 'v0.5.4-beta', date: '2026-10-10', items: [
    '予約表の読み込みを速くしました',
  ] },
  { ver: 'v0.4.4-beta', date: '2026-10-10', items: [
    '端末の設定に合わせて、ダークモードで表示するようにしました',
    '前回の予約表をすぐ出し、そのあと最新に入れ替えるようにしました',
  ] },
  { ver: 'v0.4.2-beta', date: '2026-10-10', items: [
    'いま空いている部屋が、部屋名の左の色でわかるようにしました',
    'スマホでは右下の「＋」から予約できるようにしました',
  ] },
  { ver: 'v0.4.0-beta', date: '2026-10-09', items: [
    '画面のデザインを新しくしました',
  ] },
  { ver: 'v0.3.1-beta', date: '2026-10-09', items: [
    '「不具合を報告」から、気づいたことを管理者に送れるようにしました',
  ] },
  { ver: 'v0.2.2-beta', date: '2026-10-08', items: [
    '試験運用を始めました',
  ] },
];

function renderReleases() {
  return RELEASES.map((r) => {
    const d = new Date(r.date + 'T00:00:00');
    const items = r.items.map((it) => {
      const o = typeof it === 'string' ? { text: it } : it;
      return `<li>${o.admin ? '<span class="rel-who">管理</span>' : ''}${esc(o.text)}</li>`;
    }).join('');
    return `<section class="rel-ver"><h3>${esc(r.ver)}<small>${d.getMonth() + 1}/${d.getDate()}</small></h3><ul>${items}</ul></section>`;
  }).join('');
}
function openReleases() {
  const list = $('releasesList');
  if (!list.firstChild) list.innerHTML = renderReleases();
  list.scrollTop = 0;
  $('releasesDialog').showModal();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-releases]')) openReleases(); });
