/**
 * Built-in demonstration of the assignment's Tests 1–8.
 *
 * The tests drive the real code paths (time triggers, employee edits on My Tasks,
 * dashboard acknowledgement, email-link acknowledgement) under a simulated clock
 * (Config SIMULATED_NOW). Live data is snapshotted first and restored by
 * "Exit demo mode". Results and evidence go to Test_Log.
 */

var DEMO_TESTS = [
  { id: 1, name: 'Test 1: Recurring cycle', fn: function () { return demoTest1_(); } },
  { id: 2, name: 'Test 2: Single-point completion', fn: function () { return demoTest2_(); } },
  { id: 3, name: 'Test 3: Daily task (no Ticket ID)', fn: function () { return demoTest3_(); } },
  { id: 4, name: 'Test 4: Same-day manager alert', fn: function () { return demoTest4_(); } },
  { id: 5, name: 'Test 5: Manager acknowledgement + follow-through', fn: function () { return demoTest5_(); } },
  { id: 6, name: 'Test 6: Leadership escalation', fn: function () { return demoTest6_(); } },
  { id: 7, name: 'Test 7: Escalation timing / SLA', fn: function () { return demoTest7_(); } },
  { id: 8, name: 'Test 8: No duplicate cycles, completions or emails', fn: function () { return demoTest8_(); } }
];

// ---------------------------------------------------------------- menu entry points

function runAllDemoTests() { requireUi_(); showDemoResults_(runDemoTests_(null)); }
function runDemoTest1() { requireUi_(); showDemoResults_(runDemoTests_([1])); }
function runDemoTest2() { requireUi_(); showDemoResults_(runDemoTests_([2])); }
function runDemoTest3() { requireUi_(); showDemoResults_(runDemoTests_([3])); }
function runDemoTest4() { requireUi_(); showDemoResults_(runDemoTests_([4])); }
function runDemoTest5() { requireUi_(); showDemoResults_(runDemoTests_([5])); }
function runDemoTest6() { requireUi_(); showDemoResults_(runDemoTests_([6])); }
function runDemoTest7() { requireUi_(); showDemoResults_(runDemoTests_([7])); }
function runDemoTest8() { requireUi_(); showDemoResults_(runDemoTests_([8])); }

function exitDemoMode() {
  requireUi_();
  exitDemoMode_();
  SpreadsheetApp.getUi().alert('Demo mode ended. Live data restored and the real clock is back in use.');
}

function showDemoResults_(results) {
  var lines = results.map(function (r) { return (r.result === 'PASS' ? '✅ ' : '❌ ') + r.test + (r.result === 'PASS' ? '' : '\n   ' + r.evidence); });
  SpreadsheetApp.getUi().alert('Demo test results', lines.join('\n') +
    '\n\nEvidence is in Test_Log. The sheet now shows the end state of the last test (DEMO MODE).' +
    '\nUse Ops Automation → Demo tests → Exit demo mode to restore live data.', SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------------------------------------------------------------- runner

function runDemoTests_(ids) {
  return withLock_(function () {
    takeLiveSnapshot_();
    var results = [];
    DEMO_TESTS.forEach(function (t) {
      if (ids && ids.indexOf(t.id) === -1) return;
      var row = { runAt: new Date(), test: t.name };
      try {
        row.evidence = t.fn();
        row.result = 'PASS';
      } catch (err) {
        row.evidence = String((err && err.message) || err) + ' [simulated now: ' + fmtDateTime(loadConfig_().simulatedNow) +
          '; script TZ ' + Session.getScriptTimeZone() + ', sheet TZ ' + getSpreadsheet_().getSpreadsheetTimeZone() + ']';
        row.result = 'FAIL';
      }
      results.push(row);
    });
    appendTable_(SHEETS.TESTS, TEST_COLS, results);
    return results;
  });
}

function copyTable_(from, to, cols) {
  ensureSheet_(to);
  var sh = getSheet_(to);
  sh.clear();
  writeHeader_(sh, cols);
  writeTable_(to, cols, readTable_(from, cols));
}

/** Saves live cycles/alerts once, before the first demo test. */
function takeLiveSnapshot_() {
  if (getSpreadsheet_().getSheetByName(SHEETS.SNAPSHOT_CYCLES)) return; // already in demo mode
  copyTable_(SHEETS.CYCLES, SHEETS.SNAPSHOT_CYCLES, CYCLE_COLS);
  copyTable_(SHEETS.ALERTS, SHEETS.SNAPSHOT_ALERTS, ALERT_COLS);
  [SHEETS.SNAPSHOT_CYCLES, SHEETS.SNAPSHOT_ALERTS].forEach(function (n) { getSheet_(n).hideSheet(); });
}

function exitDemoMode_() {
  withLock_(function () {
    var ss = getSpreadsheet_();
    if (ss.getSheetByName(SHEETS.SNAPSHOT_CYCLES)) {
      writeTable_(SHEETS.CYCLES, CYCLE_COLS, readTable_(SHEETS.SNAPSHOT_CYCLES, CYCLE_COLS));
      writeTable_(SHEETS.ALERTS, ALERT_COLS, readTable_(SHEETS.SNAPSHOT_ALERTS, ALERT_COLS));
      ss.deleteSheet(getSheet_(SHEETS.SNAPSHOT_CYCLES));
      ss.deleteSheet(getSheet_(SHEETS.SNAPSHOT_ALERTS));
    }
    setConfigValue_('SIMULATED_NOW', '');
    runAutomation_();
  });
}

// ---------------------------------------------------------------- helpers

function assert_(cond, msg) {
  if (!cond) throw new Error('Expected: ' + msg);
}

function demoReset_() {
  writeTable_(SHEETS.CYCLES, CYCLE_COLS, []);
  writeTable_(SHEETS.ALERTS, ALERT_COLS, []);
}

function demoSettings_() {
  return loadConfig_();
}

function demoTask_(taskId) {
  var t = findById_(loadContext_().tasks, 'taskId', taskId);
  assert_(t && isActive(t.active), 'task ' + taskId + ' to exist and be active in Task_Master (the demo uses the seeded tasks T-001…T-004)');
  return t;
}

/** First Monday on/after today and the latest seeded start date: dates look current and every demo task is running. */
function demoBase_() {
  var latest = startOfDay(new Date());
  ['T-001', 'T-002', 'T-003', 'T-004'].forEach(function (id) {
    var t = demoTask_(id);
    if (t.startDate > latest) latest = t.startDate;
  });
  // Pick a Monday whose next two weeks have no holidays, so the scripted timings hold every time.
  var holidays = loadConfig_().holidays;
  var clear = function (monday) {
    for (var i = 0; i < 14; i++) if (holidays[dateKey(addDays(monday, i))]) return false;
    return true;
  };
  var d = startOfDay(latest);
  while (d.getDay() !== 1 || !clear(d)) d = addDays(d, 1);
  return d;
}

function demoSetNow_(d) {
  setConfigValue_('SIMULATED_NOW', dateKey(d) + ' ' + fmtTime(d));
  return d;
}

function demoAt_(base, dayOffset, hhmm) {
  return demoSetNow_(atTime(addDays(base, dayOffset), parseTime(hhmm)));
}

function demoCycles_() {
  return readTable_(SHEETS.CYCLES, CYCLE_COLS);
}

function demoCycle_(cycleId) {
  return findById_(demoCycles_(), 'cycleId', cycleId);
}

function demoAlerts_(level, cycleId) {
  return readTable_(SHEETS.ALERTS, ALERT_COLS).filter(function (a) {
    return (!level || a.level === level) && (!cycleId || String(a.cycleIds).split(', ').indexOf(cycleId) !== -1);
  });
}

function demoTabFor_(employeeId) {
  var emp = findById_(readTable_(SHEETS.EMPLOYEES, EMPLOYEE_COLS), 'employeeId', employeeId);
  return getSheet_(emp.tabName);
}

/** Types `value` into the employee's My Tasks input cell for `cycleId`, exactly as a person would. */
function demoEmployeeEntry_(employeeId, cycleId, value) {
  var sh = demoTabFor_(employeeId);
  var row = findRowByValue_(sh, 1, cycleId);
  assert_(row > EMP_VIEW.HEADER_ROW, cycleId + ' to be listed on ' + sh.getName());
  var range = sh.getRange(row, EMP_VIEW.INPUT_COL);
  var old = range.getValue();
  range.setValue(value);
  handleEdit_({ range: range, value: value, oldValue: old });
}

/** Picks an action, writes a note and ticks Ack ✔ on the Manager Dashboard. */
function demoDashboardAck_(cycleId, action, note) {
  var sh = getSheet_(SHEETS.DASHBOARD);
  var edit = function (col, value) {
    var row = findRowByValue_(sh, 1, cycleId);
    assert_(row > 0, cycleId + ' to be listed on the Manager Dashboard');
    var r = sh.getRange(row, col);
    r.setValue(value);
    handleEdit_({ range: r, value: value });
  };
  edit(DASH.ACTION_COL, action);
  edit(DASH.NOTE_COL, note);
  edit(DASH.ACK_COL, true);
}

function cycleIdsUnique_() {
  var ids = demoCycles_().map(function (c) { return c.cycleId; });
  var seen = {};
  ids.forEach(function (id) { assert_(!seen[id], 'cycle ' + id + ' to exist only once'); seen[id] = true; });
  return ids.length;
}

// ---------------------------------------------------------------- the tests

function demoTest1_() {
  demoReset_();
  var s = demoSettings_();
  var base = demoBase_();
  var task = demoTask_('T-002');
  var c1 = cycleForDate(task, base, s);

  demoAt_(base, 0, '10:00');
  runAutomation_();
  assert_(demoCycle_(c1.cycleId).status === STATUS.PENDING, c1.cycleId + ' to be Pending');

  var doneAt = demoAt_(base, 2, '11:00');
  demoEmployeeEntry_(task.employeeId, c1.cycleId, 'TCK-7001');
  var closed = demoCycle_(c1.cycleId);
  assert_(closed.status === STATUS.COMPLETED && closed.proof === 'TCK-7001', 'cycle 1 closed with ticket TCK-7001');

  var c2 = nextCycleAfter(task, c1, s);
  assert_(demoCycle_(c2.cycleId).status === STATUS.UPCOMING, 'next cycle ' + c2.cycleId + ' prepared as Upcoming');

  demoSetNow_(atTime(c2.start, parseTime('09:00')));
  runAutomation_();
  runAutomation_();
  var next = demoCycle_(c2.cycleId);
  assert_(next.status === STATUS.PENDING, c2.cycleId + ' to become Pending when its period starts');
  var count = demoCycles_().filter(function (c) { return c.taskId === 'T-002'; }).length;
  assert_(count === 2, 'exactly 2 cycles for T-002, found ' + count);

  return 'Cycle ' + c1.cycleId + ' (due ' + fmtDateTime(c1.dueAt) + ') completed ' + fmtDateTime(doneAt) + ' with TCK-7001 by ' +
    closed.completedBy + '. Next cycle ' + c2.cycleId + ' created immediately as Upcoming (due ' + fmtDateTime(c2.dueAt) +
    '), became Pending on ' + fmtDate(c2.start) + '. T-002 has 2 cycles, no duplicates.';
}

function demoTest2_() {
  demoReset_();
  var s = demoSettings_();
  var base = demoBase_();
  var task = demoTask_('T-003');
  var now = demoAt_(base, 1, '10:00');
  runAutomation_();
  var c = cycleForDate(task, now, s);

  var sh = demoTabFor_(task.employeeId);
  var row = findRowByValue_(sh, 1, c.cycleId);
  assert_(row > 0, c.cycleId + ' visible on ' + sh.getName());
  var shownStatus = sh.getRange(row, 6).getValue();
  assert_(shownStatus === STATUS.PENDING || shownStatus === STATUS.OVERDUE, 'task to show as needing action, was ' + shownStatus);

  demoEmployeeEntry_(task.employeeId, c.cycleId, 'PRT-15001');
  var rec = demoCycle_(c.cycleId);
  assert_(rec.completedAt && rec.proof === 'PRT-15001', 'Task_Cycles updated from the single entry');
  assert_(String(rec.completedBy).indexOf('Employee C') !== -1, 'completed-by recorded');

  var dash = getSheet_(SHEETS.DASHBOARD);
  var dRow = findRowByValue_(dash, 1, 'Employee C');
  var vals = dash.getRange(dRow, 1, 1, 6).getValues()[0];
  assert_(vals[1] === 0 && vals[2] === 0, 'dashboard shows Employee C with nothing pending/overdue');

  var after = findRowByValue_(sh, 1, c.cycleId);
  return 'Employee C saw ' + c.cycleId + ' (' + shownStatus + ') on "' + sh.getName() + '" and typed PRT-15001 once in the yellow cell. ' +
    'Result: Task_Cycles row completed (' + fmtDateTime(rec.completedAt) + ', ' + rec.completedBy + '), the tab now shows it as ' +
    sh.getRange(after, 6).getValue() + ', the Manager Dashboard shows 0 pending/overdue, and the next cycle is queued. No other sheet was touched.';
}

function demoTest3_() {
  demoReset_();
  var s = demoSettings_();
  var base = demoBase_();
  var task = demoTask_('T-001');
  demoAt_(base, 0, '17:00');
  runAutomation_();
  var c = cycleForDate(task, base, s);

  demoEmployeeEntry_(task.employeeId, c.cycleId, 'done');
  assert_(!demoCycle_(c.cycleId).completedAt, '"done" to be rejected as proof');

  var update = 'Daily ops update shared in WhatsApp group: 42 orders dispatched, 2 delayed (courier), no customer escalations.';
  demoEmployeeEntry_(task.employeeId, c.cycleId, update);
  var rec = demoCycle_(c.cycleId);
  assert_(rec.status === STATUS.COMPLETED && rec.proof === update, 'daily update text stored as proof');
  var next = nextCycleAfter(task, c, s);
  assert_(demoCycle_(next.cycleId).status === STATUS.UPCOMING, 'next working day cycle ' + next.cycleId + ' prepared');

  return 'Daily task has no ticket, so the employee pastes the update they posted in WhatsApp. "done" was rejected (too short to be an update). ' +
    'The real update was accepted: stored text + ' + fmtDateTime(rec.completedAt) + ' + ' + rec.completedBy + ' (' + rec.resolution + '). ' +
    'Next cycle ' + next.cycleId + ' (' + fmtDate(next.start) + ') queued; Sundays/holidays get no daily cycle.';
}

/** Leaves `task`'s cycle for `day` overdue and past the alert time; returns the alerted cycle. */
function demoReachManagerAlert_(task, day) {
  var s = demoSettings_();
  var c = cycleForDate(task, day, s);
  var alertAt = slaDeadlines(c, s).managerAlertAt;
  demoSetNow_(atTime(day, parseTime('09:00')));
  runAutomation_();
  demoSetNow_(addMinutes(alertAt, 5));
  runAutomation_();
  var rec = demoCycle_(c.cycleId);
  assert_(rec.managerAlertedAt, 'manager alerted for ' + c.cycleId);
  return rec;
}

function demoTest4_() {
  demoReset_();
  var s = demoSettings_();
  var base = demoBase_();
  var task = demoTask_('T-001');
  var c = cycleForDate(task, base, s);
  var alertAt = slaDeadlines(c, s).managerAlertAt;

  demoAt_(base, 0, '09:00');
  runAutomation_();
  demoSetNow_(addMinutes(c.dueAt, Math.max(1, Math.floor(s.managerAlertDelayMin / 2))));
  runAutomation_();
  assert_(demoCycle_(c.cycleId).status === STATUS.OVERDUE, 'task Overdue after ' + fmtTime(c.dueAt));
  assert_(demoAlerts_('MANAGER').length === 0, 'no alert during the grace period');

  var sentAt = demoSetNow_(addMinutes(alertAt, 5));
  runAutomation_();
  var alerts = demoAlerts_('MANAGER', c.cycleId);
  assert_(alerts.length === 1, 'one manager alert for ' + c.cycleId);
  var rec = demoCycle_(c.cycleId);
  assert_(dateKey(rec.managerAlertedAt) === dateKey(c.dueDate), 'alert sent on the due date itself');

  return 'Employee A did not post the daily update by ' + fmtDateTime(c.dueAt) + '. At ' + fmtTime(addMinutes(c.dueAt, Math.floor(s.managerAlertDelayMin / 2))) +
    ' it was Overdue with no email (grace period). At ' + fmtDateTime(sentAt) + ' the scheduled run emailed ' + alerts[0].to +
    ': "' + alerts[0].subject + '". Same day as due: yes.';
}

function demoTest5_() {
  demoReset_();
  var base = demoBase_();
  var task = demoTask_('T-001');
  var rec = demoReachManagerAlert_(task, base);
  var s = demoSettings_();

  var ackAt = demoSetNow_(addMinutes(rec.managerAlertedAt, 25));
  demoDashboardAck_(rec.cycleId, 'Followed up with employee', 'Called Employee A, update will be posted by 19:30');
  rec = demoCycle_(rec.cycleId);
  assert_(rec.managerAckAt && rec.managerAction === 'Followed up with employee', 'acknowledgement + action recorded');

  var doneAt = demoSetNow_(addMinutes(ackAt, 30));
  demoEmployeeEntry_(task.employeeId, rec.cycleId, 'Daily ops update (late): 38 orders dispatched, all on time, no issues today.');
  rec = demoCycle_(rec.cycleId);
  assert_(rec.resolution === 'Completed after manager alert', 'resolution shows it was completed after the alert');

  demoSetNow_(addMinutes(slaDeadlines(rec, s).ackDeadline, 5));
  runAutomation_();
  assert_(demoAlerts_('LEADERSHIP', rec.cycleId).length === 0, 'no leadership escalation once acknowledged and completed');

  var dash = getSheet_(SHEETS.DASHBOARD);
  var row = findRowByValue_(dash, 1, rec.cycleId);
  var vals = dash.getRange(row, 1, 1, DASH.EXC_HEADERS.length).getValues()[0];
  assert_(vals[DASH.ACK_COL - 1] === true, 'dashboard shows Ack ✔');

  return 'Expected manager action: follow up, then acknowledge with the action taken (email button or Ack ✔ on the dashboard). ' +
    'Manager acknowledged at ' + fmtDateTime(rec.managerAckAt) + ' ("' + rec.managerAction + '": ' + rec.managerNote + '). ' +
    'Employee completed at ' + fmtDateTime(doneAt) + '. Dashboard outcome: "' + vals[DASH.EXC_HEADERS.length - 1] +
    '". No leadership email at the ack deadline because it was acknowledged and resolved.';
}

function demoTest6_() {
  demoReset_();
  var base = demoBase_();
  var s = demoSettings_();

  // 6a: the manager never acknowledges.
  var daily = demoReachManagerAlert_(demoTask_('T-001'), addDays(base, 1));
  var ackDeadline = slaDeadlines(daily, s).ackDeadline;
  demoSetNow_(addMinutes(ackDeadline, -5));
  runAutomation_();
  assert_(demoAlerts_('LEADERSHIP', daily.cycleId).length === 0, 'no escalation before the ack deadline');
  demoSetNow_(addMinutes(ackDeadline, 5));
  runAutomation_();
  var a = demoCycle_(daily.cycleId);
  assert_(demoAlerts_('LEADERSHIP', daily.cycleId).length === 1 && /did not acknowledge/.test(a.escalationReason), 'escalated: ack missed');

  // 6b: the manager acknowledges (via the email link) but the task stays open.
  var weekly = demoTask_('T-002');
  var c2 = cycleForDate(weekly, base, s);
  demoSetNow_(addMinutes(slaDeadlines(c2, s).managerAlertAt, 5));
  runAutomation_();
  var rec2 = demoCycle_(c2.cycleId);
  assert_(rec2.managerAlertedAt && rec2.ackToken, 'manager alerted for ' + c2.cycleId);
  demoSetNow_(addMinutes(rec2.managerAlertedAt, 90));
  submitAck(rec2.ackToken, 'Extension agreed with employee', 'Portal outage; Employee B to finish by Monday');
  rec2 = demoCycle_(c2.cycleId);
  var resolveDeadline = slaDeadlines(rec2, s).resolveDeadline;
  demoSetNow_(addMinutes(resolveDeadline, -5));
  runAutomation_();
  assert_(demoAlerts_('LEADERSHIP', c2.cycleId).length === 0, 'acknowledged item not escalated before the resolution deadline');
  demoSetNow_(addMinutes(resolveDeadline, 5));
  runAutomation_();
  rec2 = demoCycle_(c2.cycleId);
  assert_(demoAlerts_('LEADERSHIP', c2.cycleId).length === 1 && /still not completed/i.test(rec2.escalationReason), 'escalated: unresolved');

  return '6a: ' + daily.cycleId + ' manager alerted ' + fmtDateTime(daily.managerAlertedAt) + ', never acknowledged, so escalated to leadership at ' +
    fmtDateTime(a.leadershipEscalatedAt) + ' (' + a.escalationReason + '). 6b: ' + c2.cycleId + ' acknowledged via the email link at ' +
    fmtDateTime(rec2.managerAckAt) + ' but still open, so escalated at ' + fmtDateTime(rec2.leadershipEscalatedAt) + ' (' + rec2.escalationReason + ').';
}

function demoTest7_() {
  var s = demoSettings_();
  var base = demoBase_();
  var c = cycleForDate({ taskId: 'T-SLA', frequencyDays: 7, startDate: base }, base, s);
  var at = function (d, mins) { return addMinutes(d, mins); };
  var act = function (cyc, t) { return evaluateEscalation(cyc, t, s).action; };

  var d0 = slaDeadlines(c, s);
  assert_(act(c, at(c.dueAt, -1)) === ACTION.NONE, 'nothing before the due time');
  assert_(act(c, at(d0.managerAlertAt, -1)) === ACTION.NONE, 'nothing during the grace period');
  assert_(act(c, d0.managerAlertAt) === ACTION.MANAGER_ALERT, 'manager alert at due + ' + s.managerAlertDelayMin + ' min');

  var alerted = Object.assign({}, c, { managerAlertedAt: d0.managerAlertAt });
  var d1 = slaDeadlines(alerted, s);
  assert_(act(alerted, at(d0.managerAlertAt, 1)) === ACTION.NONE, 'manager alert is not repeated');
  assert_(act(alerted, at(d1.ackDeadline, -1)) === ACTION.NONE, 'no escalation before the ack deadline');
  assert_(act(alerted, d1.ackDeadline) === ACTION.LEADERSHIP_ESCALATION, 'escalation when the ack is missed');

  var acked = Object.assign({}, alerted, { managerAckAt: at(d0.managerAlertAt, 60) });
  assert_(act(acked, at(d1.resolveDeadline, -1)) === ACTION.NONE, 'acknowledged: wait for the resolution deadline');
  assert_(act(acked, d1.resolveDeadline) === ACTION.LEADERSHIP_ESCALATION, 'escalation when still unresolved');
  assert_(act(Object.assign({}, acked, { completedAt: at(d1.resolveDeadline, -10) }), d1.resolveDeadline) === ACTION.NONE, 'completed: no escalation');
  assert_(act(Object.assign({}, acked, { leadershipEscalatedAt: d1.resolveDeadline }), at(d1.resolveDeadline, 600)) === ACTION.NONE, 'escalation is not repeated');

  var holidays = {};
  holidays[dateKey(d1.ackDeadline)] = 'Demo holiday';
  var withHoliday = Object.assign({}, s, { holidays: holidays });
  var shifted = slaDeadlines(alerted, withHoliday).ackDeadline;
  assert_(shifted > d1.ackDeadline, 'a holiday pushes the ack deadline to the next working day');

  return 'For a weekly cycle due ' + fmtDateTime(c.dueAt) + ': manager email ' + fmtDateTime(d0.managerAlertAt) +
    ' (same day, after ' + s.managerAlertDelayMin + '-min grace) → manager must acknowledge by ' + fmtDateTime(d1.ackDeadline) +
    ' (12:00 next working day; Sunday skipped) else leadership → if acknowledged, must be completed by ' + fmtDateTime(d1.resolveDeadline) +
    ' (due + ' + s.resolveWorkingDays + ' working days) else leadership. A holiday moves the ack deadline to ' + fmtDateTime(shifted) +
    '. Each email fires at most once per cycle. All boundaries checked to the minute.';
}

function demoTest8_() {
  demoReset_();
  var s = demoSettings_();
  var base = demoBase_();
  var task = demoTask_('T-001');
  var c = cycleForDate(task, base, s);

  demoSetNow_(addMinutes(slaDeadlines(c, s).managerAlertAt, 5));
  runAutomation_();
  var cyclesAfterFirst = cycleIdsUnique_();
  runAutomation_();
  runAutomation_();
  assert_(cycleIdsUnique_() === cyclesAfterFirst, 'cycle count unchanged after re-runs (' + cyclesAfterFirst + ')');
  assert_(demoAlerts_('MANAGER').length === 1, 'exactly one manager email after 3 runs');

  var rec = demoCycle_(c.cycleId);
  demoSetNow_(addMinutes(slaDeadlines(rec, s).ackDeadline, 5));
  runAutomation_();
  runAutomation_();
  runAutomation_();
  assert_(demoAlerts_('LEADERSHIP').length === 1, 'exactly one leadership email after 3 runs');

  demoSetNow_(addMinutes(demoCycle_(c.cycleId).leadershipEscalatedAt, 10));
  var update = 'Daily ops update: 40 orders dispatched, 1 delayed (address issue), nothing else pending.';
  demoEmployeeEntry_(task.employeeId, c.cycleId, update);
  var first = demoCycle_(c.cycleId);
  // A second attempt from the same tab must not create a second completion.
  var sh = demoTabFor_(task.employeeId);
  var row = findRowByValue_(sh, 1, c.cycleId);
  assert_(row > 0, 'completed cycle still listed on the tab');
  var cell = sh.getRange(row, EMP_VIEW.INPUT_COL);
  cell.setValue('Second attempt at the same update, should be ignored');
  handleEdit_({ range: cell, value: 'x', oldValue: update });
  var second = demoCycle_(c.cycleId);
  assert_(String(second.completedAt) === String(first.completedAt) && second.proof === update, 'completion recorded once, not overwritten');

  var before = cycleIdsUnique_();
  runAutomation_();
  runAutomation_();
  assert_(cycleIdsUnique_() === before, 'no new cycles from re-runs after completion');
  assert_(demoAlerts_().length === 2, 'still exactly 2 emails in Alert_Log');

  return 'Automation run 3× at the alert time → 1 manager email; 3× after the ack deadline → 1 leadership email; ' +
    before + ' cycles, all IDs unique (deterministic TaskID-YYYYMMDD keys + script lock). Completion entered twice → recorded once (' +
    fmtDateTime(first.completedAt) + '), second attempt rejected and display restored. Alert_Log total: 2 emails.';
}
