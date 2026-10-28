/**
 * りざぶ郎からの取り込み: 「いつ、どの日を取り込むか」だけを決める（通信はしない）。
 *
 * 2026-10-28 から 2026-11-04 00:00 までの一時的な運用。予約表の更新が少ない夜間は回数を落とす。
 * - 今日: 日中は10分ごと、夜間（23時〜6時）は1時間ごと
 * - 明日〜7日後: 日中は1時間ごと（0分に1〜3日後、30分に4〜7日後）。夜間は取らない
 * - 8〜14日後: 日中は6時間ごと（前半・後半を交互に）。夜間は取らない
 * - 15日後〜2026-11-30: 4日に1回、5日ずつ（4時20分）
 *
 * 1回に取るのは最大5日（1日あたり通信2回なので10回）。Cloudflare の無料枠の「1回の実行で50回まで」に収める。
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
    const out = new Set();
    const add = (from, to) => {
      for (let d = from; d <= to && d <= END; d = addDays(d, 1)) if (d >= p.date) out.add(d);
    };
    // 今日
    if (day || p.minute === 0) out.add(p.date);
    // 明日〜7日後: 日中、0分に1〜3日後、30分に4〜7日後（どの日も1時間ごと）
    if (day && p.minute === 0) add(addDays(p.date, 1), addDays(p.date, 3));
    if (day && p.minute === 30) add(addDays(p.date, 4), addDays(p.date, 7));
    // 8〜14日後: 日中の3時間ごと。前半・後半を交互にして、どの日も6時間ごと
    if (day && p.minute === 10 && p.hour % 3 === 0) {
      const later = Math.floor(p.hour / 3) % 2 === 1;
      add(addDays(p.date, later ? 12 : 8), addDays(p.date, later ? 14 : 11));
    }
    // 15日後〜末日: 4日に1回、5日ずつ（4時20分）
    if (p.minute === 20 && p.hour === 4) {
      const slot = Math.floor(Date.parse(p.date + 'T00:00:00Z') / DAY) % 4;
      add(addDays(p.date, 15 + slot * 5), addDays(p.date, 19 + slot * 5));
    }
    return [...out].sort();
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
