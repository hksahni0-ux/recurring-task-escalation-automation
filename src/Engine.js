/**
 * The automation engine: cycle generation, completion, acknowledgement, alerts and the
 * edit handlers. Every public entry point runs under the script lock and is idempotent.
 */

function loadContext_() {
  syncTimeZone_();
  var settings = loadConfig_();
  var now = settings.simulatedNow || new Date();
  var employees = readTable_(SHEETS.EMPLOYEES, EMPLOYEE_COLS);
  // A Task_Master row counts as soon as it has a Task ID or a Task Name (managers type new rows without an ID).
  var rawTasks = readTable_(SHEETS.TASKS, TASK_COLS, function (r) { return String(r[0]).trim() !== '' || String(r[1]).trim() !== ''; })
    .map(function (t) {
      // A start date is a calendar day: round to the nearest midnight so a time-zone-shifted value still lands on the intended day.
      if (isDate(t.startDate)) t.startDate = startOfDay(addMinutes(t.startDate, 12 * 60));
      return t;
    });
  var cycles = readTable_(SHEETS.CYCLES, CYCLE_COLS);
  var taskRows = prepareTaskRows(rawTasks, employees, now, settings, cycles);
  return {
    settings: settings,
    now: now,
    employees: employees,
    rawTasks: rawTasks,
    taskRows: taskRows,
    tasks: taskRows.filter(isUsableTask),
    cycles: cycles
  };
}

/** Recomputes Task_Master statuses (next due, last done) from the current cycles and saves them if changed. */
function refreshTaskMaster_(ctx) {
  ctx.taskRows = prepareTaskRows(ctx.rawTasks, ctx.employees, ctx.now, ctx.settings, ctx.cycles);
  ctx.tasks = ctx.taskRows.filter(isUsableTask);
  syncTaskMaster_(ctx);
}

/**
 * Keeps open cycles in step with Task_Master: a reassigned or renamed task moves its open cycles to the
 * new employee / name. Completed cycles keep their original details as history.
 */
function syncOpenCycles_(ctx) {
  var byId = {};
  ctx.tasks.forEach(function (t) { byId[t.taskId] = t; });
  ctx.cycles.forEach(function (c) {
    var t = byId[c.taskId];
    if (!t || c.completedAt) return;
    var emp = findById_(ctx.employees, 'employeeId', t.employeeId);
    c.employeeId = t.employeeId;
    c.employeeName = emp ? emp.name : t.employeeId;
    c.taskName = t.taskName;
    c.proofType = t.proofType;
    c.proofInstructions = t.proofInstructions;
  });
}

var PAUSED_RESOLUTION = 'Cancelled: task paused';

/**
 * Pausing a task (Active unticked) cancels its open cycles: they leave every view and never alert, but stay
 * in Task_Cycles as a record. Resuming within the same period reopens that period's cycle; a later period
 * simply starts afresh.
 */
function applyPauseState_(ctx) {
  var byId = {};
  ctx.tasks.forEach(function (t) { byId[t.taskId] = t; });
  var today = startOfDay(ctx.now);
  ctx.cycles.forEach(function (c) {
    var t = byId[c.taskId];
    if (!t || c.completedAt) return;
    if (!isActive(t.active)) {
      if (!c.cancelledAt) {
        c.cancelledAt = ctx.now;
        c.resolution = PAUSED_RESOLUTION;
      }
    } else if (c.cancelledAt && c.resolution === PAUSED_RESOLUTION && isDate(c.start) && isDate(c.periodEnd) &&
        startOfDay(c.start) <= today && today <= startOfDay(c.periodEnd)) {
      c.cancelledAt = '';
      c.resolution = '';
    }
  });
}

/**
 * Removes open cycles that start before their task's start date (the date was moved later after the task
 * went live), unless someone already acted on them: completed cycles and alerted ones are kept as history.
 */
function withdrawEarlyCycles_(ctx) {
  var byId = {};
  ctx.tasks.forEach(function (t) { byId[t.taskId] = t; });
  var before = ctx.cycles.length;
  ctx.cycles = ctx.cycles.filter(function (c) {
    var t = byId[c.taskId];
    if (!t || c.completedAt || c.managerAlertedAt || !isDate(c.start)) return true;
    return startOfDay(c.start) >= startOfDay(t.startDate);
  });
  return before - ctx.cycles.length;
}

/** Writes back Task_Master only when preparing the rows changed something (filled defaults or a new status). */
function syncTaskMaster_(ctx) {
  var key = function (rows) { return JSON.stringify(toRows_(TASK_COLS, rows)); };
  if (key(ctx.rawTasks) !== key(ctx.taskRows)) writeTable_(SHEETS.TASKS, TASK_COLS, ctx.taskRows);
}

function saveCycles_(ctx) {
  writeTable_(SHEETS.CYCLES, CYCLE_COLS, ctx.cycles);
}

function findById_(list, key, id) {
  for (var i = 0; i < list.length; i++) if (String(list[i][key]) === String(id)) return list[i];
  return null;
}

// ---------------------------------------------------------------- automation run

/** Time-trigger entry point (hourly, ~18:45 and 07:00). */
function runAutomation(e) {
  requireTrigger_(e, 'runAutomation');
  return runAutomation_();
}

/** Creates due cycles, refreshes statuses, sends alerts/escalations, redraws views. Safe to run any number of times. */
function runAutomation_() {
  return withLock_(function () {
    var ctx = loadContext_();
    withdrawEarlyCycles_(ctx);
    syncOpenCycles_(ctx);
    applyPauseState_(ctx);
    var created = ensureCurrentCycles_(ctx);
    ctx.cycles.forEach(function (c) { c.status = cycleStatus(c, ctx.now); });
    saveCycles_(ctx);
    var sent = processAlerts_(ctx);
    refreshTaskMaster_(ctx);
    renderAllViews_(ctx);
    return { created: created, managerAlerts: sent.manager, escalations: sent.leadership };
  });
}

function newCycleRecord_(ctx, task, c) {
  var emp = findById_(ctx.employees, 'employeeId', task.employeeId);
  var rec = {
    cycleId: c.cycleId, taskId: task.taskId, taskName: task.taskName, employeeId: task.employeeId,
    employeeName: emp ? emp.name : task.employeeId, frequencyDays: Number(task.frequencyDays),
    start: c.start, periodEnd: c.periodEnd, dueDate: c.dueDate, dueAt: c.dueAt,
    proofType: task.proofType, proofInstructions: task.proofInstructions, createdAt: ctx.now
  };
  rec.status = cycleStatus(rec, ctx.now);
  return rec;
}

function ensureCurrentCycles_(ctx) {
  var ids = {};
  ctx.cycles.forEach(function (c) { ids[c.cycleId] = true; });
  var valid = ctx.tasks.filter(function (t) {
    try {
      frequencyOf_(t);
      return isDate(t.startDate);
    } catch (e) {
      console.warn('Skipping misconfigured task ' + t.taskId + ': ' + e.message);
      return false;
    }
  });
  var created = cyclesToCreate(valid, ids, ctx.now, ctx.settings).map(function (c) {
    return newCycleRecord_(ctx, findById_(ctx.tasks, 'taskId', c.taskId), c);
  });
  ctx.cycles = ctx.cycles.concat(created);
  return created.length;
}

function ackBaseUrl_(s) {
  if (s.webAppUrl) return s.webAppUrl;
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

function processAlerts_(ctx) {
  var s = ctx.settings;
  var managerItems = [];
  var leaderItems = [];
  ctx.cycles.forEach(function (c) {
    var d = evaluateEscalation(c, ctx.now, s);
    if (d.action === ACTION.MANAGER_ALERT) managerItems.push(c);
    if (d.action === ACTION.LEADERSHIP_ESCALATION) leaderItems.push({ cycle: c, reason: d.reason });
  });

  if (managerItems.length) {
    managerItems.forEach(function (c) {
      c.managerAlertedAt = ctx.now;
      if (!c.ackToken) c.ackToken = Utilities.getUuid();
    });
    sendAndLog_(ctx, 'MANAGER', s.managerEmail, buildManagerAlertEmail(managerItems, s, ctx.now, ackBaseUrl_(s)), managerItems);
  }

  if (leaderItems.length) {
    leaderItems.forEach(function (x) {
      x.cycle.leadershipEscalatedAt = ctx.now;
      x.cycle.escalationReason = x.reason;
    });
    var to = [s.leadershipEmail, s.managerEmail].filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join(',');
    sendAndLog_(ctx, 'LEADERSHIP', to, buildEscalationEmail(leaderItems, s, ctx.now), leaderItems.map(function (x) { return x.cycle; }));
  }
  return { manager: managerItems.length, leadership: leaderItems.length };
}

function sendAndLog_(ctx, level, to, mail, cycles) {
  if (!to) throw new Error('No recipient configured for ' + level + ' emails (see Config).');
  MailApp.sendEmail({ to: to, subject: mail.subject, body: mail.text, htmlBody: mail.html, name: 'Allo Ops Automation' });
  // Persist the "sent" markers straight away so a later failure can never cause a resend.
  saveCycles_(ctx);
  var ids = cycles.map(function (c) { return c.cycleId; });
  appendTable_(SHEETS.ALERTS, ALERT_COLS, [{
    alertKey: level + '|' + ids.join(','), level: level, sentAt: new Date(),
    simulatedAt: ctx.settings.simulatedNow ? ctx.now : '', to: to, subject: mail.subject,
    cycleIds: ids.join(', '), count: ids.length
  }]);
}

// ---------------------------------------------------------------- completion & acknowledgement

function completeCycleCore_(ctx, cycleId, rawProof, by, employeeId) {
  var c = findById_(ctx.cycles, 'cycleId', cycleId);
  if (!c) return { ok: false, error: 'Unknown task cycle ' + cycleId + '.' };
  if (employeeId && c.employeeId !== employeeId) return { ok: false, error: cycleId + ' is not assigned to you.' };
  if (c.cancelledAt) return { ok: false, error: 'This task was paused, so this cycle was cancelled. Nothing to do.' };
  if (c.completedAt) {
    return { ok: false, duplicate: true, error: 'Already completed on ' + fmtDateTime(c.completedAt) + ' by ' + c.completedBy + '. Nothing more to do.' };
  }
  if (cycleStatus(c, ctx.now) === STATUS.UPCOMING) return { ok: false, error: 'This cycle opens on ' + fmtDate(c.start) + '. Complete it from then.' };
  var v = validateProof(c.proofType, rawProof);
  if (!v.ok) return { ok: false, error: v.error };

  c.proof = v.value;
  c.completedAt = ctx.now;
  c.completedBy = by;
  c.status = STATUS.COMPLETED;
  c.resolution = describeResolution(c, ctx.now);

  var next = null;
  var task = findById_(ctx.tasks, 'taskId', c.taskId);
  if (task && isActive(task.active)) {
    var n = nextCycleAfter(task, c, ctx.settings);
    next = findById_(ctx.cycles, 'cycleId', n.cycleId);
    if (!next) {
      next = newCycleRecord_(ctx, task, n);
      ctx.cycles.push(next);
    }
  }
  return { ok: true, cycle: c, next: next };
}

function acknowledgeCore_(ctx, cycleId, action, note, by) {
  var c = findById_(ctx.cycles, 'cycleId', cycleId);
  if (!c) return { ok: false, error: 'Unknown task cycle ' + cycleId + '.' };
  if (!c.managerAlertedAt) return { ok: false, error: 'No manager alert has been sent for ' + cycleId + ' yet.' };
  if (c.managerAckAt) {
    return { ok: true, already: true, message: 'Already acknowledged on ' + fmtDateTime(c.managerAckAt) + ' by ' + c.managerAckBy + '.' };
  }
  if (MANAGER_ACTIONS.indexOf(action) === -1) return { ok: false, error: 'Choose an action from the list: ' + MANAGER_ACTIONS.join(', ') + '.' };
  c.managerAckAt = ctx.now;
  c.managerAckBy = by;
  c.managerAction = action;
  c.managerNote = String(note || '').slice(0, 500);
  return {
    ok: true,
    message: 'Acknowledged: ' + c.taskName + ' (' + c.employeeName + '). The task is ' + (c.completedAt ? 'already completed.' : 'still open.')
  };
}

// ---------------------------------------------------------------- edit handlers

function editorEmail_(e) {
  try {
    return (e && e.user && e.user.getEmail && e.user.getEmail()) || Session.getActiveUser().getEmail() || '';
  } catch (err) {
    return '';
  }
}

/** Installable on-edit trigger (Ops Automation → Install triggers). Deliberately not named onEdit. */
function handleEdit(e) {
  if (isGenuineTrigger_(e)) handleEdit_(e);
}

function handleEdit_(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  var name = sh.getName();
  if (name === SHEETS.DASHBOARD) handleDashboardEdit_(e, sh);
  else if (name.indexOf(EMPLOYEE_TAB_PREFIX) === 0) handleEmployeeEdit_(e, sh);
  else if (name === SHEETS.EMPLOYEES || name === SHEETS.CONFIG) withLock_(applyAccessRules_); // roles may have changed
  else if (name === SHEETS.TASKS) runAutomation_(); // a new or changed task takes effect at once
}

function handleEmployeeEdit_(e, sh) {
  var row = e.range.getRow();
  if (e.range.getColumn() !== EMP_VIEW.INPUT_COL || e.range.getNumColumns() !== 1 || row <= EMP_VIEW.HEADER_ROW) {
    // Only the input column is meaningful; redraw to undo anything typed elsewhere.
    withLock_(function () { renderAllViews_(loadContext_()); });
    return;
  }
  withLock_(function () {
    var ctx = loadContext_();
    if (e.range.getNumRows() !== 1) {
      renderAllViews_(ctx);
      toast_('Please complete one task at a time.');
      return;
    }
    var emp = findById_(ctx.employees, 'tabName', sh.getName());
    var cycleId = String(sh.getRange(row, 1).getValue());
    var typed = e.range.getValue();
    if (!emp || !cycleId) {
      renderAllViews_(ctx);
      return;
    }
    var res = completeCycleCore_(ctx, cycleId, typed, emp.name + ' <' + (editorEmail_(e) || emp.email) + '>', emp.employeeId);
    if (res.ok) {
      saveCycles_(ctx);
      refreshTaskMaster_(ctx);
      renderAllViews_(ctx);
      toast_('✅ ' + res.cycle.taskName + ' recorded.' + (res.next ? ' Next cycle: ' + fmtDate(res.next.start) + ' → due ' + fmtDateTime(res.next.dueAt) + '.' : ''));
      return;
    }
    renderAllViews_(ctx);
    if (!res.duplicate && String(typed).trim()) {
      // Leave what the employee typed in place, with the reason, so they can correct it.
      var r = findRowByValue_(sh, 1, cycleId);
      if (r) sh.getRange(r, EMP_VIEW.INPUT_COL).setValue(cellValue_(String(typed))).setNote('❌ Not saved: ' + res.error);
    }
    toast_('❌ ' + res.error);
  });
}

function handleDashboardEdit_(e, sh) {
  var row = e.range.getRow();
  var col = e.range.getColumn();
  var headerRow = findRowByValue_(sh, 1, DASH.EXC_HEADERS[0]);
  if (!headerRow || row <= headerRow || e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;
  if ([DASH.ACK_COL, DASH.ACTION_COL, DASH.NOTE_COL].indexOf(col) === -1) return;
  withLock_(function () {
    var ctx = loadContext_();
    var vals = sh.getRange(row, 1, 1, DASH.EXC_HEADERS.length).getValues()[0];
    var c = findById_(ctx.cycles, 'cycleId', vals[0]);
    if (!c) {
      renderDashboard_(ctx);
      return;
    }
    var action = String(vals[DASH.ACTION_COL - 1] || '');
    if (MANAGER_ACTIONS.indexOf(action) !== -1) c.managerAction = action;
    c.managerNote = String(vals[DASH.NOTE_COL - 1] || '').slice(0, 500);
    if (vals[DASH.ACK_COL - 1] === true && !c.managerAckAt) {
      var by = ctx.settings.managerName + ' <' + (editorEmail_(e) || ctx.settings.managerEmail) + '> via dashboard';
      var res = acknowledgeCore_(ctx, c.cycleId, action, c.managerNote, by);
      toast_(res.ok ? '✅ ' + res.message : '❌ ' + res.error);
    }
    // Un-ticking an acknowledged item is ignored: the re-render puts the tick back.
    saveCycles_(ctx);
    renderAllViews_(ctx);
  });
}
