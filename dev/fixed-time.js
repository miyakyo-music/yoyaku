/**
 * テスト環境だけで使う: URL に ?now=2026-10-10T12:00:00 を付けると、画面と模擬 GAS の「今」をその時刻に止める。
 * 見た目の指紋（dev/fingerprint.js）を、時刻に左右されずに比べるため（「終了した予約」や現在時刻の線が動かない）。
 */
(function () {
  const m = /[?&]now=([^&]+)/.exec(location.search);
  if (!m) return;
  const fixed = new Date(decodeURIComponent(m[1])).getTime();
  if (!Number.isFinite(fixed)) return;
  const RealDate = Date;
  function FixedDate(...args) {
    if (!(this instanceof FixedDate)) return new RealDate(fixed).toString();
    return args.length ? new RealDate(...args) : new RealDate(fixed);
  }
  FixedDate.now = () => fixed;
  FixedDate.UTC = RealDate.UTC;
  FixedDate.parse = RealDate.parse;
  FixedDate.prototype = RealDate.prototype;
  window.Date = FixedDate;
})();
