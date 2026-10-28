/**
 * りざぶ郎からの取り込み: 「いつ、どの日を取り込むか」だけを決める（通信はしない）。
 *
 * 2026-10-28 から 2026-11-04 00:00 までの一時的な運用。予約表の更新が少ない夜間は回数を落とす。
 * - 今日: 日中は20分ごと、夜間（23時〜6時）は1時間ごと。1回につき1日分
 * - 翌日: 毎時30分に1回
 * - 2日後〜2026-11-30: 4:05〜9:55 と 16:05〜21:55 に、5分間隔で1日ずつ（どの日も1日2回）
 *
 * 1回は1日分だけ（通信2回）。1日あたり約146回・292通信。Cloudflare の無料枠の「1回の実行で50回まで」に収める。
 * 取り込みをやめたあとも、このファイルは 2026-11-04 に消す（仕様書 4.8）。
 */
(function (g) {
  'use strict';
  const END = '2026-11-30';
  const STOP_AT = Date.parse('2026-11-04T00:00:00+09:00');
  const MAX_DAYS = 23; // 手で期間を指定するときの上限（1日の通信2回 × 23日 = 46回）
  const DAY = 86400000;

  /** 日本時間の日付・時・分 */
  function jst(ms) {
    const d = new Date(Number(ms) + 9 * 3600 * 1000);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
  function addDays(date, n) {
    return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  }
  function daysBetween(from, to) {
    return Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  }

  /** 定期実行の1回分。取り込む日付の配列（何もしないときは空） */
  function datesFor(ms) {
    ms = Number(ms) || Date.now();
    if (ms >= STOP_AT) return [];
    const p = jst(ms);
    if (p.date > END) return [];
    const night = p.hour >= 23 || p.hour < 6;
    const day = !night;
    // 今日: 日中は20分ごと、夜間は1時間ごと。1回につき1日分だけ取る
    if (day ? p.minute % 20 === 0 : p.minute === 0) return [p.date];
    // 翌日: 毎時30分に1回
    const tomorrow = addDays(p.date, 1);
    if (p.minute === 30 && tomorrow <= END) return [tomorrow];
    // 2日後〜末日: 4:05〜9:55 と 16:05〜21:55 に、5分間隔で1日ずつ（どの日も1日2回）
    if ((p.hour >= 4 && p.hour < 10) || (p.hour >= 16 && p.hour < 22)) {
      if (p.minute >= 5 && p.minute <= 55 && (p.minute - 5) % 10 === 0) {
        const start = addDays(p.date, 2);
        const total = daysBetween(start, END);
        const base = p.hour < 10 ? 4 : 16;
        const idx = (p.hour - base) * 6 + (p.minute - 5) / 10;
        if (idx < total) return [addDays(start, idx)];
      }
    }
    return [];
  }

  /**
   * 手で期間を指定するとき（POST /rizaburo/run）の範囲を、今日〜2026-11-30・23日以内に直す。
   * 停止日を過ぎていたら stopped。
   */
  function manualRange(from, to, ms) {
    ms = Number(ms) || Date.now();
    if (ms >= STOP_AT) return { stopped: true, error: 'りざぶ郎からの取り込みは 2026-11-04 00:00 に終了しました。' };
    const today = jst(ms).date;
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE.test(String(from || '')) || !DATE.test(String(to || ''))) return { error: '日付は YYYY-MM-DD の形で指定してください。' };
    const f = from < today ? today : from;
    const t = to > END ? END : to;
    if (f > t) return { error: '取り込みの範囲は、今日から ' + END + ' までです。' };
    if (f >= STOP_AT) return { stopped: true, error: 'りざぶ郎からの取り込みは 2026-11-04 00:00 に終了しました。' };
    if (daysBetween(f, t) > MAX_DAYS) return { error: '一度に取り込めるのは ' + MAX_DAYS + ' 日までです。分けて実行してください。' };
    return { from: f, to: t };
  }

  g.RizaburoPlan = { END, STOP_AT, MAX_DAYS, jst, addDays, daysBetween, datesFor, manualRange };
})(globalThis);
