const ROLE_SET = new Set(['admin', 'planner', 'manager', 'team_leader', 'coordinator', 'viewer', 'employee']);

export function validRole(role) {
  return ROLE_SET.has(role);
}

export function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return null;
  const [hours, minutes] = String(value).split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function minutesToTime(value) {
  const normalized = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function shiftDurationMinutes(start, end) {
  const from = timeToMinutes(start);
  const to = timeToMinutes(end);
  if (from === null || to === null) return 0;
  const duration = to - from;
  return duration > 0 ? duration : duration + 1440;
}

function offsetFromShift(start, time) {
  const origin = timeToMinutes(start);
  const target = timeToMinutes(time);
  if (origin === null || target === null) return null;
  let offset = target - origin;
  if (offset < 0) offset += 1440;
  return offset;
}

export function validateBreaks(start, end, breaks = []) {
  const shiftMinutes = shiftDurationMinutes(start, end);
  if (!shiftMinutes) return { valid: false, message: 'Intervalul turei este invalid.' };
  const normalized = [];
  for (let index = 0; index < breaks.length; index += 1) {
    const item = breaks[index] || {};
    const from = offsetFromShift(start, item.start);
    const to = offsetFromShift(start, item.end);
    if (from === null || to === null) return { valid: false, message: `Pauza ${index + 1} are ore invalide.` };
    let adjustedTo = to;
    if (adjustedTo <= from) adjustedTo += 1440;
    if (from < 0 || adjustedTo > shiftMinutes || adjustedTo <= from) {
      return { valid: false, message: `Pauza ${index + 1} trebuie să fie în interiorul turei.` };
    }
    normalized.push({
      id: item.id || null,
      label: String(item.label || `Pauza ${index + 1}`).slice(0, 80),
      start: item.start,
      end: item.end,
      paid: Boolean(item.paid),
      from,
      to: adjustedTo,
      duration: adjustedTo - from,
      sortOrder: index,
    });
  }
  normalized.sort((a, b) => a.from - b.from);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].from < normalized[index - 1].to) {
      return { valid: false, message: 'Pauzele nu se pot suprapune.' };
    }
  }
  const totalMinutes = normalized.reduce((sum, item) => sum + item.duration, 0);
  const paidMinutes = normalized.filter(item => item.paid).reduce((sum, item) => sum + item.duration, 0);
  const unpaidMinutes = totalMinutes - paidMinutes;
  return { valid: true, breaks: normalized, totalMinutes, paidMinutes, unpaidMinutes, netMinutes: Math.max(0, shiftMinutes - unpaidMinutes) };
}

export function defaultBreaks(start, end) {
  const duration = shiftDurationMinutes(start, end);
  if (duration < 480) return [];
  const startMinutes = timeToMinutes(start);
  const middle = Math.round((duration / 2 - 30) / 15) * 15;
  return [{ label: 'Pauză 1 oră', start: minutesToTime(startMinutes + middle), end: minutesToTime(startMinutes + middle + 60), paid: false }];
}

export function plannedDate(date, time, addDay = false) {
  const parsed = new Date(`${date}T${time}:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (addDay) parsed.setDate(parsed.getDate() + 1);
  return parsed;
}

export function plannedInterval(shift) {
  const start = plannedDate(shift.date, shift.start_time, false);
  const crosses = timeToMinutes(shift.end_time) <= timeToMinutes(shift.start_time);
  const end = plannedDate(shift.date, shift.end_time, crosses);
  return { start, end };
}

export function canViewEmployee(user, employee) {
  if (!user || !employee || !user.active) return false;
  if (['admin', 'planner'].includes(user.role)) return true;
  if (['manager', 'team_leader'].includes(user.role)) return user.agency_id === employee.agency_id && user.department_id === employee.department_id;
  if (user.role === 'coordinator') return user.agency_id === employee.agency_id;
  if (user.role === 'viewer') {
    if (user.department_id) return user.agency_id === employee.agency_id && user.department_id === employee.department_id;
    return !user.agency_id || user.agency_id === employee.agency_id;
  }
  return user.role === 'employee' && user.employee_id === employee.id;
}

export function canManageEmployee(user, employee) {
  if (!user || !employee || !user.active) return false;
  if (['admin', 'planner'].includes(user.role)) return true;
  return ['manager', 'team_leader'].includes(user.role) && user.agency_id === employee.agency_id && user.department_id === employee.department_id;
}

export function canReviewEmployee(user, employee) {
  if (!user || !employee) return false;
  if (user.role === 'admin') return true;
  return ['manager', 'team_leader'].includes(user.role) && user.agency_id === employee.agency_id && user.department_id === employee.department_id;
}

export function canManageCars(user) {
  return Boolean(user && ['admin', 'planner', 'manager', 'team_leader', 'coordinator'].includes(user.role));
}
