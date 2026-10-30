/**
 * Renders the employee "My Tasks" tabs and the Manager Dashboard from Task_Cycles.
 * Views are fully redrawn after every change, so they can never drift from the data.
 */

var COLORS = {
  header: '#1f3a5f', headerText: '#ffffff', title: '#1f3a5f', muted: '#6c757d',
  Overdue: '#f8d7da', Pending: '#fff3cd', Upcoming: '#eef2f7', Completed: '#d4edda',
  input: '#fff59d', escalated: '#f5c6cb', demo: '#ffe0b2'
};

var EMP_VIEW = {
  HEADER_ROW: 5,
  INPUT_COL: 8,
  HEADERS: ['Cycle ID', 'Task', 'Repeats', 'Cycle Period', 'Due By', 'Status', 'What to Enter',
    '✍ Ticket ID / Update (type here)', 'Completed At', 'Completed By']
};

var DASH = {
  SUMMARY_HEADER_ROW: 4,
  SUMMARY_HEADERS: ['Employee', 'Pending (in window)', 'Overdue', 'Awaiting Manager Ack', 'Escalated & Still Open', 'Completed (last 7 days)'],
  EXC_HEADERS: ['Cycle ID', 'Employee', 'Task', 'Due At', 'Task Status', 'Manager Alerted At', 'Ack ✔',
    'Manager Action', 'Manager Note', 'Acknowledged At', 'Escalated to Leadership At', 'Escalation Reason', 'Outcome'],
  ACK_COL: 7,
  ACTION_COL: 8,
  NOTE_COL: 9
};

var DATETIME_FORMAT = 'ddd dd mmm yyyy, hh:mm';

function renderAllViews_(ctx) {
  ctx.employees.forEach(function (emp) { renderEmployeeTab_(ctx, emp); });
  renderDashboard_(ctx);
}

function demoBanner_(ctx) {
  return ctx.settings.simulatedNow ? '   ⚠ DEMO MODE: simulated time. Use Ops Automation → Exit demo mode to go live.' : '';
}

function styleHeaderRow_(range) {
  range.setFontWeight('bold').setBackground(COLORS.header).setFontColor(COLORS.headerText).setWrap(true).setVerticalAlignment('middle');
}

function renderEmployeeTab_(ctx, emp) {
  var sh = ensureSheet_(emp.tabName);
  var width = EMP_VIEW.HEADERS.length;
  var bodyRows = Math.max(sh.getMaxRows() - EMP_VIEW.HEADER_ROW, 1);
  var body = sh.getRange(EMP_VIEW.HEADER_ROW + 1, 1, bodyRows, width);
  body.clearContent().clearNote().setBackground(null).setFontColor(null);

  sh.getRange(1, 1).setValue('My Tasks: ' + emp.name).setFontSize(16).setFontWeight('bold').setFontColor(COLORS.title);
  sh.getRange(2, 1).setValue('To complete a task, type the Ticket ID (portal tasks) or paste the update you posted in the WhatsApp group ' +
    '(daily task) into the yellow cell. That is the only update needed: the system records who and when, and opens the next cycle.');
  sh.getRange(3, 1).setValue('Refreshed ' + fmtDateTime(ctx.now) + demoBanner_(ctx)).setFontColor(COLORS.muted);
  styleHeaderRow_(sh.getRange(EMP_VIEW.HEADER_ROW, 1, 1, width).setValues([EMP_VIEW.HEADERS]));

  var rows = selectEmployeeView(ctx.cycles.filter(function (c) { return c.employeeId === emp.employeeId; }), ctx.now, 5);
  if (!rows.length) {
    sh.getRange(EMP_VIEW.HEADER_ROW + 1, 1).setValue('Nothing pending. 🎉');
    return;
  }
  var values = [];
  var colors = [];
  rows.forEach(function (c) {
    var st = cycleStatus(c, ctx.now);
    var period = Number(c.frequencyDays) === 1 ? fmtDate(c.start) : fmtDate(c.start) + ' → ' + fmtDate(c.periodEnd);
    values.push([c.cycleId, c.taskName, frequencyLabel(c.frequencyDays), period, c.dueAt, st, c.proofInstructions,
      cellValue_(c.proof || ''), c.completedAt || '', c.completedBy || '']);
    var rowColor = COLORS[st];
    var line = [];
    for (var i = 0; i < width; i++) line.push(rowColor);
    if (st === STATUS.PENDING || st === STATUS.OVERDUE) line[EMP_VIEW.INPUT_COL - 1] = COLORS.input;
    colors.push(line);
  });
  var data = sh.getRange(EMP_VIEW.HEADER_ROW + 1, 1, values.length, width);
  data.setValues(values).setBackgrounds(colors).setWrap(true).setVerticalAlignment('top');
  sh.getRange(EMP_VIEW.HEADER_ROW + 1, 5, values.length, 1).setNumberFormat(DATETIME_FORMAT);
  sh.getRange(EMP_VIEW.HEADER_ROW + 1, 9, values.length, 1).setNumberFormat(DATETIME_FORMAT);
}

function renderDashboard_(ctx) {
  var sh = ensureSheet_(SHEETS.DASHBOARD);
  var all = sh.getRange(1, 1, sh.getMaxRows(), DASH.EXC_HEADERS.length);
  all.clearDataValidations();
  all.clear();

  sh.getRange(1, 1).setValue('Manager Dashboard: recurring tasks').setFontSize(16).setFontWeight('bold').setFontColor(COLORS.title);
  sh.getRange(2, 1).setValue('As of ' + fmtDateTime(ctx.now) + demoBanner_(ctx)).setFontColor(COLORS.muted);

  var summary = summarizeTeam(ctx.employees, ctx.cycles, ctx.now).map(function (r) {
    return [r.name, r.pending, r.overdue, r.awaitingAck, r.escalatedOpen, r.completed7d];
  });
  styleHeaderRow_(sh.getRange(DASH.SUMMARY_HEADER_ROW, 1, 1, DASH.SUMMARY_HEADERS.length).setValues([DASH.SUMMARY_HEADERS]));
  if (summary.length) {
    sh.getRange(DASH.SUMMARY_HEADER_ROW + 1, 1, summary.length, DASH.SUMMARY_HEADERS.length).setValues(summary);
    summary.forEach(function (r, i) {
      if (r[2] > 0 || r[4] > 0) sh.getRange(DASH.SUMMARY_HEADER_ROW + 1 + i, 1, 1, DASH.SUMMARY_HEADERS.length).setBackground(COLORS.Overdue);
    });
  }

  var titleRow = DASH.SUMMARY_HEADER_ROW + summary.length + 2;
  var headerRow = titleRow + 1;
  sh.getRange(titleRow, 1).setValue('Exceptions: overdue and alerted items. To acknowledge, pick a Manager Action, add a note, then tick Ack ✔.')
    .setFontWeight('bold');
  styleHeaderRow_(sh.getRange(headerRow, 1, 1, DASH.EXC_HEADERS.length).setValues([DASH.EXC_HEADERS]));

  var exceptions = selectExceptions(ctx.cycles, ctx.now);
  if (!exceptions.length) {
    sh.getRange(headerRow + 1, 1).setValue('No overdue or alerted items.');
    return;
  }
  var values = exceptions.map(function (c) {
    return [c.cycleId, c.employeeName, c.taskName, c.dueAt, cycleStatus(c, ctx.now), c.managerAlertedAt || '', c.managerAlertedAt ? !!c.managerAckAt : '',
      c.managerAction || '', cellValue_(c.managerNote || ''), c.managerAckAt || '', c.leadershipEscalatedAt || '',
      c.escalationReason || '', outcomeLabel(c, ctx.settings)];
  });
  var first = headerRow + 1;
  sh.getRange(first, 1, values.length, DASH.EXC_HEADERS.length).setValues(values).setWrap(true).setVerticalAlignment('top');
  [4, 6, 10, 11].forEach(function (col) { sh.getRange(first, col, values.length, 1).setNumberFormat(DATETIME_FORMAT); });

  var alerted = [];
  exceptions.forEach(function (c, i) {
    var color = c.completedAt ? COLORS.Completed : c.leadershipEscalatedAt ? COLORS.escalated : COLORS.Overdue;
    sh.getRange(first + i, 1, 1, DASH.EXC_HEADERS.length).setBackground(color);
    if (c.managerAlertedAt) alerted.push(first + i);
  });
  alerted.forEach(function (r) {
    sh.getRange(r, DASH.ACK_COL).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    sh.getRange(r, DASH.ACTION_COL).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(MANAGER_ACTIONS, true).setAllowInvalid(false).build());
    sh.getRange(r, DASH.ACTION_COL, 1, 2).setBackground(COLORS.input);
  });
}
