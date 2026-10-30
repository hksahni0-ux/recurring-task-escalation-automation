/**
 * Pure scheduling, SLA and validation logic.
 * No Google services are used in this file, so all of it is unit-tested in Node.
 */

var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MS_PER_MINUTE = 60000;
var MS_PER_DAY = 86400000;

var STATUS = { UPCOMING: 'Upcoming', PENDING: 'Pending', OVERDUE: 'Overdue', COMPLETED: 'Completed' };
var PROOF = { TICKET: 'TICKET', DAILY_UPDATE: 'DAILY_UPDATE' };
var ACTION = { NONE: 'NONE', MANAGER_ALERT: 'MANAGER_ALERT', LEADERSHIP_ESCALATION: 'LEADERSHIP_ESCALATION' };
var LEADERSHIP_HELP_ACTION = 'Blocked: needs leadership help';

// ---------------------------------------------------------------- dates

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
}

function addMinutes(d, n) {
  return new Date(d.getTime() + n * MS_PER_MINUTE);
}

function daysBetween(a, b) {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / MS_PER_DAY);
}

/** @param {Date} d @param {{h:number,m:number}} t */
function atTime(d, t) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m);
}

function dateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function compactDate(d) {
  return dateKey(d).replace(/-/g, '');
}

function fmtDate(d) {
  return isDate(d) ? DAY_NAMES[d.getDay()] + ' ' + pad2(d.getDate()) + ' ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear() : '';
}

function fmtTime(d) {
  return isDate(d) ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '';
}

function fmtDateTime(d) {
  return isDate(d) ? fmtDate(d) + ', ' + fmtTime(d) : '';
}

/** Accepts "HH:MM" or a Sheets time value. */
function parseTime(v) {
  if (isDate(v)) return { h: v.getHours(), m: v.getMinutes() };
  var m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('Invalid time "' + v + '" (use HH:MM, e.g. 18:00)');
  return { h: +m[1], m: +m[2] };
}

/** Accepts "YYYY-MM-DD HH:MM", "YYYY-MM-DD" or a Date. Blank → null. */
function parseDateTime(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (isDate(v)) return v;
  var m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/.exec(String(v));
  if (!m) throw new Error('Invalid date-time "' + v + '" (use YYYY-MM-DD HH:MM)');
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

// ---------------------------------------------------------------- settings

function toInt_(v, fallback) {
  var n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Builds the typed settings object from the Config sheet's key/value map.
 * @param {Object<string,*>} map
 * @param {Object<string,*>} holidays keyed by YYYY-MM-DD
 */
function buildSettings(map, holidays) {
  var str = function (k, d) { return map[k] === undefined || map[k] === '' ? d : String(map[k]).trim(); };
  return {
    managerName: str('MANAGER_NAME', 'Operations Manager'),
    managerEmail: str('MANAGER_EMAIL', ''),
    leadershipEmail: str('LEADERSHIP_EMAIL', ''),
    workingDays: str('WORKING_DAYS', 'Mon,Tue,Wed,Thu,Fri,Sat').split(',').map(function (x) { return x.trim(); }).filter(String),
    holidays: holidays || {},
    dueTime: parseTime(str('DUE_TIME', '18:00')),
    managerAlertDelayMin: toInt_(map.MANAGER_ALERT_DELAY_MIN, 30),
    ackDeadlineTime: parseTime(str('ACK_DEADLINE_TIME', '12:00')),
    resolveWorkingDays: toInt_(map.RESOLVE_WORKING_DAYS, 2),
    resolveDeadlineTime: parseTime(str('RESOLVE_DEADLINE_TIME', '18:00')),
    webAppUrl: str('WEBAPP_URL', ''),
    holidayCalendarId: str('HOLIDAY_CALENDAR_ID', ''),
    adminEmails: str('ADMIN_EMAILS', ''),
    simulatedNow: parseDateTime(map.SIMULATED_NOW)
  };
}

// ---------------------------------------------------------------- working days

function isWorkingDay(d, s) {
  return s.workingDays.indexOf(DAY_NAMES[d.getDay()]) !== -1 && !s.holidays[dateKey(d)];
}

function nextWorkingDay(d, s) {
  var x = startOfDay(d);
  for (var i = 0; i < 366; i++) {
    x = addDays(x, 1);
    if (isWorkingDay(x, s)) return x;
  }
  throw new Error('No working day within a year: check WORKING_DAYS and Holidays');
}

function addWorkingDays(d, n, s) {
  var x = startOfDay(d);
  for (var i = 0; i < n; i++) x = nextWorkingDay(x, s);
  return x;
}

// ---------------------------------------------------------------- cycles

function isActive(v) {
  return v === true || /^(true|yes|y|1)$/i.test(String(v).trim());
}

/**
 * A cycle covers [start, periodEnd]. It is due at DUE_TIME on the last working day of
 * the period. Cycle starts are anchored on the task start date, so a late completion
 * never shifts the schedule.
 */
function buildCycle_(task, start, periodEnd, s) {
  var due = periodEnd;
  while (!isWorkingDay(due, s) && due > start) due = addDays(due, -1);
  if (!isWorkingDay(due, s)) due = nextWorkingDay(periodEnd, s);
  return {
    cycleId: task.taskId + '-' + compactDate(start),
    taskId: task.taskId,
    start: start,
    periodEnd: periodEnd,
    dueDate: due,
    dueAt: atTime(due, s.dueTime)
  };
}

function frequencyOf_(task) {
  var f = Number(task.frequencyDays);
  if (!(f >= 1) || Math.floor(f) !== f) throw new Error('Task ' + task.taskId + ' has an invalid frequency "' + task.frequencyDays + '"');
  return f;
}

/** The cycle of `task` that contains `date`, or null (before start / daily task on a non-working day). */
function cycleForDate(task, date, s) {
  var freq = frequencyOf_(task);
  var anchor = startOfDay(task.startDate);
  var day = startOfDay(date);
  if (day < anchor) return null;
  if (freq === 1) return isWorkingDay(day, s) ? buildCycle_(task, day, day, s) : null;
  var start = addDays(anchor, Math.floor(daysBetween(anchor, day) / freq) * freq);
  return buildCycle_(task, start, addDays(start, freq - 1), s);
}

function nextCycleAfter(task, cycle, s) {
  var freq = frequencyOf_(task);
  if (freq === 1) {
    var d = nextWorkingDay(cycle.start, s);
    return buildCycle_(task, d, d, s);
  }
  var start = addDays(startOfDay(cycle.start), freq);
  return buildCycle_(task, start, addDays(start, freq - 1), s);
}

/** Cycles that should exist right now but do not. Marks them in `existingIds`. */
function cyclesToCreate(tasks, existingIds, now, s) {
  var out = [];
  tasks.forEach(function (t) {
    if (!t.taskId || !isActive(t.active)) return;
    var c = cycleForDate(t, now, s);
    if (c && !existingIds[c.cycleId]) {
      existingIds[c.cycleId] = true;
      out.push(c);
    }
  });
  return out;
}

function cycleStatus(c, now) {
  if (c.completedAt) return STATUS.COMPLETED;
  if (now < startOfDay(c.start)) return STATUS.UPCOMING;
  if (now > c.dueAt) return STATUS.OVERDUE;
  return STATUS.PENDING;
}

function frequencyLabel(days) {
  return Number(days) === 1 ? 'Daily (working days)' : 'Every ' + days + ' days';
}

// ---------------------------------------------------------------- proof

function validateProof(proofType, value) {
  var v = String(value === null || value === undefined ? '' : value).trim();
  if (proofType === PROOF.DAILY_UPDATE) {
    if (v.length < 15) {
      return { ok: false, error: 'Paste the update you posted in the WhatsApp group (at least 15 characters), e.g. "Dispatched 42 orders, 2 delayed".' };
    }
    return { ok: true, value: v.slice(0, 2000) };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/#-]{2,39}$/.test(v)) {
    return { ok: false, error: 'Enter the portal Ticket ID (3–40 letters/numbers, e.g. TCK-1042).' };
  }
  return { ok: true, value: v };
}

function describeResolution(c, completedAt) {
  if (c.leadershipEscalatedAt) return 'Completed after leadership escalation';
  if (c.managerAlertedAt) return 'Completed after manager alert';
  if (completedAt > c.dueAt) return 'Completed late (before manager alert)';
  return 'Completed on time';
}

// ---------------------------------------------------------------- SLA

function slaDeadlines(c, s) {
  var managerAlertAt = addMinutes(c.dueAt, s.managerAlertDelayMin);
  var ackDeadline = atTime(nextWorkingDay(c.managerAlertedAt || managerAlertAt, s), s.ackDeadlineTime);
  var resolveDeadline = atTime(addWorkingDays(c.dueDate, s.resolveWorkingDays, s), s.resolveDeadlineTime);
  if (resolveDeadline < ackDeadline) resolveDeadline = ackDeadline;
  return { managerAlertAt: managerAlertAt, ackDeadline: ackDeadline, resolveDeadline: resolveDeadline };
}

/**
 * Decides the single next notification for a cycle. Each level fires at most once
 * per cycle (the timestamps on the cycle are the de-duplication record).
 */
function evaluateEscalation(c, now, s) {
  var none = { action: ACTION.NONE, reason: '' };
  if (c.completedAt || now < c.dueAt) return none;
  var d = slaDeadlines(c, s);
  if (!c.managerAlertedAt) {
    return now >= d.managerAlertAt ? { action: ACTION.MANAGER_ALERT, reason: 'Not completed by ' + fmtDateTime(c.dueAt) } : none;
  }
  if (c.leadershipEscalatedAt) return none;
  if (c.managerAckAt && c.managerAction === LEADERSHIP_HELP_ACTION) {
    return { action: ACTION.LEADERSHIP_ESCALATION, reason: 'Manager asked for leadership help' + (c.managerNote ? ': ' + c.managerNote : '') };
  }
  if (!c.managerAckAt && now >= d.ackDeadline) {
    return { action: ACTION.LEADERSHIP_ESCALATION, reason: 'Manager did not acknowledge by ' + fmtDateTime(d.ackDeadline) };
  }
  if (now >= d.resolveDeadline) {
    return {
      action: ACTION.LEADERSHIP_ESCALATION,
      reason: 'Task still not completed by ' + fmtDateTime(d.resolveDeadline) + (c.managerAckAt ? ' (manager had acknowledged)' : '')
    };
  }
  return none;
}

// ---------------------------------------------------------------- holidays

var HOLIDAY_SOURCE = { CALENDAR: 'Google Calendar', MANUAL: 'Manual' };

/**
 * Public holidays from a Google holiday calendar's iCal feed, within [from, to].
 * Google labels each event "Public holiday" or "Observance"; observances (regional
 * festivals offices usually stay open for) are skipped.
 */
function parseIcsHolidays(ics, from, to) {
  var unfolded = String(ics).replace(/\r?\n[ \t]/g, '');
  var out = [];
  unfolded.split('BEGIN:VEVENT').slice(1).forEach(function (block) {
    var field = function (name) {
      var m = new RegExp('^' + name + '[^:\\r\\n]*:(.*)$', 'm').exec(block);
      return m ? m[1].trim() : '';
    };
    var d = /^(\d{4})(\d{2})(\d{2})/.exec(field('DTSTART'));
    if (!d || field('DESCRIPTION').indexOf('Public holiday') !== 0) return;
    var date = new Date(+d[1], +d[2] - 1, +d[3]);
    if (date < startOfDay(from) || date > to) return;
    out.push({ date: date, name: field('SUMMARY').replace(/\\,/g, ',') });
  });
  return out.sort(function (a, b) { return a.date - b.date; });
}

/**
 * Replaces calendar-sourced rows with the fetched list, keeping manual rows untouched and
 * carrying over each calendar holiday's Observed choice (matched by name + date).
 */
function mergeHolidays(existing, fetched) {
  var observedChoice = {};
  var manual = [];
  existing.forEach(function (h) {
    var source = h.source || HOLIDAY_SOURCE.MANUAL;
    var observed = h.observed === '' || h.observed === undefined ? true : isActive(h.observed);
    if (source === HOLIDAY_SOURCE.CALENDAR) {
      if (isDate(h.date)) observedChoice[dateKey(h.date) + '|' + h.name] = observed;
    } else {
      manual.push({ date: h.date, name: h.name, source: HOLIDAY_SOURCE.MANUAL, observed: observed });
    }
  });
  var synced = fetched.map(function (h) {
    var key = dateKey(h.date) + '|' + h.name;
    return { date: h.date, name: h.name, source: HOLIDAY_SOURCE.CALENDAR, observed: key in observedChoice ? observedChoice[key] : true };
  });
  return synced.concat(manual).sort(function (a, b) { return (isDate(a.date) ? a.date : 0) - (isDate(b.date) ? b.date : 0); });
}

// ---------------------------------------------------------------- admin

/** The sheet owner plus anyone in the comma-separated ADMIN_EMAILS list. An unknown (blank) user is never an admin. */
function isAdminEmail(email, ownerEmail, adminList) {
  var me = String(email || '').trim().toLowerCase();
  if (!me) return false;
  var admins = String(adminList || '').split(',').concat([ownerEmail || '']).map(function (x) { return x.trim().toLowerCase(); });
  return admins.indexOf(me) !== -1;
}

/** Every role `email` holds, e.g. ['Admin', 'Employee: Employee A']; empty means view-only. */
function describeRoles(email, ownerEmail, adminList, managerList, employees) {
  var me = String(email || '').trim().toLowerCase();
  if (!me) return [];
  var inList = function (list) { return String(list || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).indexOf(me) !== -1; };
  var roles = [];
  if (me === String(ownerEmail || '').trim().toLowerCase()) roles.push('Owner (admin)');
  else if (inList(adminList)) roles.push('Admin');
  if (inList(managerList)) roles.push('Manager');
  employees.forEach(function (e) { if (inList(e.email)) roles.push('Employee: ' + e.name); });
  return roles;
}

/**
 * Who may edit each tab: employees only their own My Tasks tab, managers only the dashboard,
 * admins everything. Emails are lower-cased and de-duplicated, admins first.
 */
function buildAccessPlan(employees, adminList, managerList) {
  var split = function (v) { return String(v || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(String); };
  var uniq = function (list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); };
  var admins = uniq(split(adminList));
  var plan = employees.filter(function (e) { return e.tabName; }).map(function (e) {
    return { sheet: e.tabName, role: 'Employee: ' + e.name, editors: uniq(admins.concat(split(e.email))) };
  });
  plan.push({ sheet: SHEETS.DASHBOARD, role: 'Manager', editors: uniq(admins.concat(split(managerList))) });
  [SHEETS.GUIDE, SHEETS.TASKS, SHEETS.EMPLOYEES, SHEETS.CONFIG, SHEETS.HOLIDAYS, SHEETS.CYCLES, SHEETS.ALERTS, SHEETS.TESTS]
    .forEach(function (n) { plan.push({ sheet: n, role: 'Admin', editors: admins.slice() }); });
  return plan;
}

// ---------------------------------------------------------------- views

var STATUS_ORDER_ = { Overdue: 0, Pending: 1, Upcoming: 2, Completed: 3 };

/** Rows for an employee's "My Tasks" tab: open work, then upcoming, then the latest completions. */
function selectEmployeeView(cycles, now, completedLimit) {
  var withStatus = cycles.map(function (c) { return { c: c, st: cycleStatus(c, now) }; });
  var open = withStatus.filter(function (x) { return x.st !== STATUS.COMPLETED; }).sort(function (a, b) {
    return STATUS_ORDER_[a.st] - STATUS_ORDER_[b.st] || a.c.dueAt - b.c.dueAt;
  });
  var done = withStatus.filter(function (x) { return x.st === STATUS.COMPLETED; }).sort(function (a, b) {
    return b.c.completedAt - a.c.completedAt;
  }).slice(0, completedLimit);
  return open.concat(done).map(function (x) { return x.c; });
}

/** Overdue items and anything the manager was alerted about (open, or closed in the last 7 days). */
function selectExceptions(cycles, now) {
  var weekAgo = addDays(now, -7);
  return cycles.filter(function (c) {
    var st = cycleStatus(c, now);
    if (st === STATUS.OVERDUE) return true;
    return !!c.managerAlertedAt && (!c.completedAt || c.completedAt >= weekAgo);
  }).sort(function (a, b) { return a.dueAt - b.dueAt; });
}

function summarizeTeam(employees, cycles, now) {
  var weekAgo = addDays(now, -7);
  return employees.map(function (e) {
    var mine = cycles.filter(function (c) { return c.employeeId === e.employeeId; });
    var count = function (fn) { return mine.filter(fn).length; };
    return {
      name: e.name,
      pending: count(function (c) { return cycleStatus(c, now) === STATUS.PENDING; }),
      overdue: count(function (c) { return cycleStatus(c, now) === STATUS.OVERDUE; }),
      awaitingAck: count(function (c) { return c.managerAlertedAt && !c.managerAckAt && !c.completedAt; }),
      escalatedOpen: count(function (c) { return c.leadershipEscalatedAt && !c.completedAt; }),
      completed7d: count(function (c) { return c.completedAt && c.completedAt >= weekAgo; })
    };
  });
}

function outcomeLabel(c, s) {
  if (c.completedAt) return c.resolution || 'Completed';
  if (c.leadershipEscalatedAt) return 'OPEN: escalated to leadership';
  if (c.managerAckAt) return 'OPEN: manager acknowledged, awaiting completion';
  if (c.managerAlertedAt) return 'OPEN: awaiting manager acknowledgement';
  return 'OPEN: manager alert due ' + fmtTime(slaDeadlines(c, s).managerAlertAt);
}
