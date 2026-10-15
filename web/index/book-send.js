// 予約表: 予約の送信（返事を待たずに表へ反映し、失敗したら元に戻す）と、取れた帯を弾ませる動き
'use strict';

/** 予約が取れた帯を、小窓が帯へ縮み終わるころに一度だけ弾ませる（index/timeline.css の .blk.res.booked） */
function celebrate(id) {
  state.celebrate = { ids: new Set([id]), start: performance.now() + (VT_OK && onScreen($('bookDialog')) ? 400 : 0) };
}

/** 新規予約（1件）を楽観的に反映してから送信する。失敗したら表示を戻し、入力内容を残したまま予約画面を開き直す。 */
async function createOptimistic(payload) {
  const temp = Object.assign({}, payload, { id: `tmp_${Date.now()}`, groupId: '', hasPin: !!payload.pin, pending: true });
  delete temp.pin;
  delete temp.adminPassword;
  const entry = { r: temp, status: 'sending' };
  state.pending.push(entry);
  celebrate(temp.id);
  morph($('bookDialog'), () => {
    $('bookDialog').close();
    if (state.view === 'day' && payload.date !== state.date) setDate(payload.date);
    else if (state.data) render();
  }, () => bandEl(temp.id));
  try {
    const res = await api('createReservation', payload);
    if (!res || !res.ok) {
      throw Object.assign(new Error((res && res.message) || '予約できませんでした。'), { code: res && res.code });
    }
    // 確定した予約は、再取得で台帳のデータに現れるまでこのまま表示しておく
    entry.r = res.reservation;
    entry.status = 'done';
    if (state.celebrate) state.celebrate.ids.add(res.reservation.id);
    addMine([res.reservation]);
    toast('予約しました');
    invalidate([payload.date]);
    if (state.data) render();
    load({ force: true });
  } catch (ex) {
    state.pending = state.pending.filter((x) => x !== entry); // 画面を予約前の状態に戻す
    if (state.data) render();
    if (ex instanceof AuthError) return;
    const message = errMessage(ex);
    toast(message, 'error');
    if (ex.code === 'CONFLICT') { invalidate([payload.date]); load({ force: true }); }
    if (!anyDialogOpen()) {
      openBooking({ mode: 'create', roomId: payload.roomId, date: payload.date, start: toMin(payload.start), end: toMin(payload.end) });
      $('bAff').value = payload.affiliation;
      $('bPerson').value = payload.name;
      $('bMemo').value = payload.memo;
      $('bPin').value = payload.pin;
      if (payload.color !== undefined) setColorChoice(payload.color);
      $('bError').textContent = message;
    }
  }
}

/** 予約の変更（1件）を楽観的に反映してから送信する。元の予約を隠して変更後の姿を出し、失敗したら元に戻して変更画面を開き直す。 */
async function updateOptimistic(payload, orig) {
  const temp = Object.assign({}, orig, payload, { id: `tmpedit_${orig.id}`, pending: true });
  delete temp.pin;
  delete temp.adminPassword;
  const entry = { r: temp, status: 'sending' };
  state.pending.push(entry);
  state.hidden.set(orig.id, orig.date);
  celebrate(temp.id);
  morph($('bookDialog'), () => {
    $('bookDialog').close();
    if (state.view === 'day' && payload.date !== state.date) setDate(payload.date);
    else if (state.data) render();
  }, () => bandEl(temp.id));
  const restore = () => {
    state.pending = state.pending.filter((x) => x !== entry);
    state.hidden.delete(orig.id);
    if (state.data) render();
  };
  try {
    const res = await api('updateReservation', Object.assign({}, payload, { id: orig.id }));
    if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || '変更できませんでした。'), { code: res && res.code });
    entry.status = 'done';
    // 再取得で台帳に反映されるまで、変更後の姿を出しておく。仮の id なので、その間は押しても詳細・動かす操作をさせない（settling）
    entry.r = Object.assign({}, res.reservation, { id: temp.id, settling: true });
    if (isMine(orig.id)) addMine([res.reservation]); // 日付を変えたときも、この端末の記録の日付を新しい日にする
    toast('予約を変更しました');
    invalidate([orig.date, payload.date]);
    await load({ force: true });
    restore(); // 最新の台帳に変更後の予約が入ったので、仮の表示を片付ける
  } catch (ex) {
    restore();
    if (ex instanceof AuthError) return;
    const message = errMessage(ex);
    toast(message, 'error');
    if (ex.code === 'CONFLICT' || ex.code === 'NOT_FOUND') { invalidate([orig.date, payload.date]); load({ force: true }); }
    if (!anyDialogOpen() && ex.code !== 'NOT_FOUND') {
      openBooking({ mode: 'edit', reservation: orig, pin: payload.pin });
      $('bRoom').value = payload.roomId;
      $('bDate').value = payload.date;
      setTime($('bStartH'), $('bStartM'), toMin(payload.start));
      setTime($('bEndH'), $('bEndM'), toMin(payload.end));
      $('bAff').value = payload.affiliation;
      $('bPerson').value = payload.name;
      $('bMemo').value = payload.memo;
      if (payload.color !== undefined) setColorChoice(payload.color);
      updateBookingUi();
      $('bError').textContent = message;
    }
  }
}
