function renderDashboard() {
  const weekEnd = addDays(state.week, 7);
  const weekly = state.data.shifts.filter(item => item.date >= state.week && item.date < weekEnd && item.status !== 'cancelled');
  const openRequests = state.data.requests.filter(item => item.status === 'review').length;
  const openAttendance = state.data.attendance.filter(item => !item.clock_out_actual).length;
  const scheduled = new Set(weekly.map(item => item.employee_id)).size;
  const upcoming = [...state.data.shifts].filter(item => item.status !== 'cancelled' && item.date >= today()).sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`)).slice(0, 10);
  $('#content').innerHTML = setPage('Overzicht', 'Situația curentă pentru planning, pontaj și cereri.') +
    `${state.profile.must_change_password ? '<div class="banner">Parola inițială trebuie schimbată din Profil.</div>' : ''}` +
    `<div class="kpis"><article class="kpi green"><span>Prezenți acum</span><strong>${openAttendance}</strong></article><article class="kpi orange"><span>Request review</span><strong>${openRequests}</strong></article><article class="kpi blue"><span>Programați săptămâna aceasta</span><strong>${scheduled}</strong></article><article class="kpi"><span>Angajați vizibili</span><strong>${state.data.employees.length}</strong></article></div>
    <section class="panel"><div class="panel-head"><div><h2>Următoarele ture</h2><p>Program publicat și draft în aria ta de acces.</p></div></div><div class="panel-body">${upcoming.length ? upcoming.map(item => `<div class="card" style="margin-bottom:9px"><div style="display:flex;align-items:center;gap:12px">${personHtml(employee(item.employee_id))}<div style="margin-left:auto;text-align:right"><strong>${fmtDate(item.date)} · ${esc(item.start_time)}–${esc(item.end_time)}</strong><p style="margin:4px 0">Total break ${totalBreak(item)} min · ${netHours(item)} h net</p></div></div></div>`).join('') : '<div class="empty"><strong>Nu există ture viitoare</strong>Adaugă ture în Planning.</div>'}</div></section>`;
}

function renderPlanning() {
  const p = permissions(), days = Array.from({ length: 7 }, (_, index) => addDays(state.week, index));
  const actions = `<button class="btn secondary" id="prevWeek">←</button><button class="btn secondary" id="currentWeek">Săptămâna curentă</button><button class="btn secondary" id="nextWeek">→</button>${p.editPlanning ? '<button class="btn primary" id="addShift">Adaugă tură</button><button class="btn secondary" id="copyWeek">Copiază săptămâna</button><button class="btn secondary" id="publishWeek">Publică săptămâna</button>' : ''}<button class="btn secondary" id="exportExcel">Excel</button><button class="btn secondary" id="printPlanning">PDF / Print</button>`;
  let table = `<div class="table-wrap"><table class="planning-table"><thead><tr><th>Angajat</th>${days.map(day => `<th>${new Date(`${day}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: '2-digit', month: '2-digit' })}</th>`).join('')}<th>Total net</th></tr></thead><tbody>`;
  for (const person of state.data.employees) {
    let weeklyMinutes = 0; table += `<tr><td>${personHtml(person)}</td>`;
    for (const day of days) {
      const items = state.data.shifts.filter(item => item.employee_id === person.id && item.date === day && item.status !== 'cancelled');
      if (items.length) {
        weeklyMinutes += items.reduce((sum, item) => sum + item.net_minutes, 0);
        table += `<td class="planning-cell">${items.map(item => `<button class="shift-chip" data-shift-id="${item.id}" ${p.editPlanning ? '' : 'disabled'}><strong>${esc(item.start_time)}–${esc(item.end_time)}</strong><small>${statusBadge(item.status)}</small><small>☕ ${item.breaks.length} pauze · <span class="break-total">Total ${totalBreak(item)} min</span></small><small>${netHours(item)} h net</small></button>`).join('')}</td>`;
      } else table += '<td class="planning-cell">—</td>';
    }
    table += `<td><strong>${(weeklyMinutes / 60).toFixed(2)} h</strong></td></tr>`;
  }
  table += '</tbody></table></div>';
  $('#content').innerHTML = setPage('Planning', `${fmtDate(state.week)} — ${fmtDate(addDays(state.week, 6))}`, actions) + `<section class="panel">${state.data.employees.length ? table : '<div class="empty"><strong>Nu există angajați</strong>Administratorul trebuie să creeze angajații.</div>'}</section>`;
  $('#prevWeek').onclick = async () => { state.week = addDays(state.week, -7); await loadData(); renderPlanning(); };
  $('#nextWeek').onclick = async () => { state.week = addDays(state.week, 7); await loadData(); renderPlanning(); };
  $('#currentWeek').onclick = async () => { state.week = mondayOf(today()); await loadData(); renderPlanning(); };
  $('#addShift')?.addEventListener('click', () => openShift());
  $('#copyWeek')?.addEventListener('click', async () => { const target = prompt('Lunea săptămânii țintă (YYYY-MM-DD):', addDays(state.week, 7)); if (!target) return; const result = await api('/api/planning/copy-week', { method: 'POST', body: { sourceMonday: state.week, targetMonday: target } }); toast(`${result.affected} ture copiate ca draft.`); await loadData(); renderPlanning(); });
  $('#publishWeek')?.addEventListener('click', async () => { if (!confirm('Publici toate turele draft din această săptămână?')) return; const result = await api('/api/planning/publish-week', { method: 'POST', body: { monday: state.week } }); toast(`${result.affected} ture publicate.`); await loadData(); renderPlanning(); });
  $$('[data-shift-id]').forEach(button => button.onclick = () => openShift(shift(button.dataset.shiftId)));
  $('#exportExcel').onclick = exportPlanning;
  $('#printPlanning').onclick = () => window.print();
}

function availableSlot(start, end, breaks, duration) {
  const total = shiftMinutes(start, end), origin = timeMinutes(start); if (!total || total < duration) return null;
  const ranges = breaks.map(item => { const a = (timeMinutes(item.start) - origin + 1440) % 1440; let b = (timeMinutes(item.end) - origin + 1440) % 1440; if (b <= a) b += 1440; return [a, b]; });
  const desired = ranges.length ? Math.min(total - duration, Math.max(...ranges.map(item => item[1])) + 15) : Math.round((total / 2 - duration / 2) / 15) * 15;
  const candidates = Array.from({ length: Math.floor((total - duration) / 15) + 1 }, (_, index) => index * 15).sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
  const slot = candidates.find(a => !ranges.some(([from, to]) => a < to && a + duration > from));
  return slot === undefined ? null : { start: minutesTime(origin + slot), end: minutesTime(origin + slot + duration) };
}

function breakRows(prefix, items = []) {
  return `<div class="break-builder"><div class="break-tools"><strong>Pauze planificate</strong><button type="button" class="btn secondary tiny" data-break-add="15" data-prefix="${prefix}">+ 15 min</button><button type="button" class="btn secondary tiny" data-break-add="30" data-prefix="${prefix}">+ 30 min</button><button type="button" class="btn secondary tiny" data-break-add="60" data-prefix="${prefix}">+ 1 hr</button><button type="button" class="btn primary tiny" data-break-add="custom" data-prefix="${prefix}">+ Custom</button></div><div class="break-list" id="${prefix}BreakList">${items.map((item, index) => breakRow(prefix, item, index)).join('')}</div><div class="break-summary" id="${prefix}BreakSummary"></div></div>`;
}
function breakRow(prefix, item = {}, index = 0) {
  return `<div class="break-row" data-break-row><label class="field break-label"><span>Nume</span><input data-break-label value="${esc(item.label || `Pauza ${index + 1}`)}"></label><label class="field"><span>Start</span><input data-break-start type="time" value="${esc(item.start || '')}"></label><label class="field"><span>Sfârșit</span><input data-break-end type="time" value="${esc(item.end || '')}"></label><label class="field checkbox"><input data-break-paid type="checkbox" ${item.paid ? 'checked' : ''}><span>Plătită</span></label><button type="button" class="btn danger-soft tiny" data-break-remove>Șterge</button></div>`;
}
function collectBreaks(prefix) {
  return $$(`#${prefix}BreakList [data-break-row]`).map(row => ({ label: $('[data-break-label]', row).value.trim(), start: $('[data-break-start]', row).value, end: $('[data-break-end]', row).value, paid: $('[data-break-paid]', row).checked }));
}
function breakSummary(prefix, getTimes) {
  const container = $(`#${prefix}BreakSummary`); if (!container) return;
  const breaks = collectBreaks(prefix), { start, end } = getTimes(); let total = 0, paid = 0, unpaid = 0, valid = true;
  const origin = timeMinutes(start), duration = shiftMinutes(start, end), ranges = [];
  for (const item of breaks) {
    if (origin === null || !duration || timeMinutes(item.start) === null || timeMinutes(item.end) === null) { valid = false; continue; }
    const a = (timeMinutes(item.start) - origin + 1440) % 1440; let b = (timeMinutes(item.end) - origin + 1440) % 1440; if (b <= a) b += 1440;
    if (a < 0 || b > duration) valid = false; ranges.push([a, b]); const minutes = Math.max(0, b - a); total += minutes; if (item.paid) paid += minutes; else unpaid += minutes;
  }
  ranges.sort((a, b) => a[0] - b[0]); if (ranges.some((item, index) => index && item[0] < ranges[index - 1][1])) valid = false;
  container.innerHTML = `<span><strong>Total break: ${total} min</strong></span><span>${breaks.length} pauze</span><span>${unpaid} min neplătite</span><span>${paid} min plătite</span><span>${Math.max(0, duration - unpaid) / 60} h net</span>${valid ? '' : '<span>⚠ Verifică orele / suprapunerile</span>'}`;
}
function bindBreakBuilder(prefix, getTimes) {
  const list = $(`#${prefix}BreakList`); const refresh = () => breakSummary(prefix, getTimes);
  const bindRows = () => {
    $$(`#${prefix}BreakList [data-break-remove]`).forEach(button => button.onclick = () => { button.closest('[data-break-row]').remove(); refresh(); });
    $$(`#${prefix}BreakList input`).forEach(input => input.oninput = refresh);
  };
  $$(`[data-prefix="${prefix}"][data-break-add]`).forEach(button => button.onclick = () => {
    const { start, end } = getTimes(); const current = collectBreaks(prefix); const value = button.dataset.breakAdd;
    let item;
    if (value === 'custom') { const slot = availableSlot(start, end, current, 15); item = { label: 'Pauză custom', start: slot?.start || start, end: slot?.end || start, paid: false }; }
    else { const duration = Number(value), slot = availableSlot(start, end, current, duration); if (!slot) return toast(`Nu există un interval liber de ${duration} minute.`); item = { label: duration === 60 ? 'Pauză 1 oră' : `Pauză ${duration} min`, ...slot, paid: false }; }
    list.insertAdjacentHTML('beforeend', breakRow(prefix, item, current.length)); bindRows(); refresh();
  });
  bindRows(); refresh();
}

function employeeOptions(selected) { return state.data.employees.map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)} · ${esc(item.personnel_number)}</option>`).join(''); }

function openShift(existing = null) {
  if (!state.data.employees.length) return toast('Adaugă mai întâi un angajat.');
  const initial = existing || { employee_id: state.data.employees[0].id, date: state.week, start_time: '07:00', end_time: '15:00', status: 'published', note: '', breaks: [{ label: 'Pauză 1 oră', start: '10:30', end: '11:30', paid: false }] };
  openModal({ title: existing ? 'Modifică tura' : 'Tură nouă', submitLabel: 'Salvează tura', body: `<div class="form-grid"><label class="field full"><span>Angajat</span><select id="shiftEmployee">${employeeOptions(initial.employee_id)}</select></label><label class="field"><span>Data</span><input id="shiftDate" type="date" value="${esc(initial.date)}" required></label><label class="field"><span>Status</span><select id="shiftStatus"><option value="published">Published</option><option value="draft">Draft</option><option value="cancelled">Cancelled</option></select></label><label class="field"><span>Start</span><input id="shiftStart" type="time" value="${esc(initial.start_time)}" required></label><label class="field"><span>Sfârșit</span><input id="shiftEnd" type="time" value="${esc(initial.end_time)}" required></label><div class="full">${breakRows('shift', initial.breaks || [])}</div><label class="field full"><span>Notă</span><textarea id="shiftNote">${esc(initial.note || '')}</textarea></label>${existing ? '<div class="full"><button type="button" class="btn danger-soft" id="deleteShift">Șterge tura</button></div>' : ''}</div>`, onOpen: () => {
    $('#shiftStatus').value = initial.status; bindBreakBuilder('shift', () => ({ start: $('#shiftStart').value, end: $('#shiftEnd').value })); $('#shiftStart').oninput = $('#shiftEnd').oninput = () => breakSummary('shift', () => ({ start: $('#shiftStart').value, end: $('#shiftEnd').value }));
    $('#deleteShift')?.addEventListener('click', async () => { if (!confirm('Ștergi această tură?')) return; await api(`/api/shifts/${existing.id}`, { method: 'DELETE' }); closeModal(); await loadData(); renderPlanning(); toast('Tura a fost ștearsă.'); });
  }, onSubmit: async () => {
    const body = { employeeId: $('#shiftEmployee').value, date: $('#shiftDate').value, start: $('#shiftStart').value, end: $('#shiftEnd').value, status: $('#shiftStatus').value, note: $('#shiftNote').value, breaks: collectBreaks('shift'), autoBreak: true };
    await api(existing ? `/api/shifts/${existing.id}` : '/api/shifts', { method: existing ? 'PUT' : 'POST', body }); await loadData(); renderPlanning(); toast('Tura a fost salvată.');
  } });
}

function exportPlanning() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.week, i));
  const rows = [['Angajat', 'Număr personal', 'Departament', 'Data', 'Start', 'Sfârșit', 'Total break min', 'Paid break min', 'Unpaid break min', 'Ore nete', 'Status']];
  state.data.shifts.filter(item => days.includes(item.date)).forEach(item => { const person = employee(item.employee_id); rows.push([person?.name, person?.personnel_number, department(person?.department_id)?.name, item.date, item.start_time, item.end_time, totalBreak(item), item.paid_break_minutes, item.unpaid_break_minutes, netHours(item), item.status]); });
  const table = `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
  const blob = new Blob([`<html><head><meta charset="utf-8"></head><body>${table}</body></html>`], { type: 'application/vnd.ms-excel' }); download(blob, `Planning_${state.week}.xls`);
}
function download(blob, name) { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
