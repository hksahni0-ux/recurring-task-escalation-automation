/**
 * Menu, one-time setup (sheets, seed data, guide) and trigger installation.
 */

var TRIGGER_HANDLERS = ['handleEdit', 'runAutomation', 'syncHolidays'];

function onOpen() {
  var demo = SpreadsheetApp.getUi().createMenu('Demo tests (assignment)')
    .addItem('Run all 8 tests', 'runAllDemoTests')
    .addSeparator()
    .addItem('Test 1: Recurring cycle', 'runDemoTest1')
    .addItem('Test 2: Single-point completion', 'runDemoTest2')
    .addItem('Test 3: Daily task', 'runDemoTest3')
    .addItem('Test 4: Same-day manager alert', 'runDemoTest4')
    .addItem('Test 5: Manager acknowledgement', 'runDemoTest5')
    .addItem('Test 6: Leadership escalation', 'runDemoTest6')
    .addItem('Test 7: Escalation timing (SLA)', 'runDemoTest7')
    .addItem('Test 8: No duplicates', 'runDemoTest8')
    .addSeparator()
    .addItem('Exit demo mode (restore live data)', 'exitDemoMode');
  SpreadsheetApp.getUi().createMenu('⚙ Ops Automation')
    .addItem('Who am I? (my access)', 'showMyAccess')
    .addSeparator()
    .addItem('Run automation now', 'runAutomationFromMenu')
    .addSubMenu(demo)
    .addSeparator()
    .addItem('Setup / repair sheets', 'setupSystem')
    .addItem('Sync holidays now', 'syncHolidaysFromMenu')
    .addItem('Apply access rules', 'applyAccessRulesFromMenu')
    .addItem('Install triggers', 'installTriggers')
    .addItem('Reset live data (clear all cycles)', 'resetLiveData')
    .addToUi();
}

function runAutomationFromMenu() {
  requireAdmin_();
  var r = runAutomation_();
  toast_('Done. New cycles: ' + r.created + ', manager alerts: ' + r.managerAlerts + ', escalations: ' + r.escalations + '.');
}

/** Creates any missing sheets, headers, seed data and formatting. Safe to re-run: never overwrites data. */
function setupSystem() {
  requireAdmin_();
  var ss = getSpreadsheet_();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  syncTimeZone_();

  setupTable_(SHEETS.CONFIG, [['key', 'Key'], ['value', 'Value'], ['description', 'Description']], []);
  var cfg = getSheet_(SHEETS.CONFIG);
  cfg.getRange(1, 2, cfg.getMaxRows(), 1).setNumberFormat('@'); // keep times/dates as typed text
  CONFIG_DEFAULTS.forEach(function (d) {
    if (!findRowByValue_(cfg, 1, d[0])) appendTable_(SHEETS.CONFIG, [['k', ''], ['v', ''], ['d', '']], [{ k: d[0], v: d[1], d: d[2] }]);
  });

  var monday = startOfDay(new Date());
  while (monday.getDay() !== 1) monday = addDays(monday, -1);

  setupTable_(SHEETS.EMPLOYEES, EMPLOYEE_COLS, ['A', 'B', 'C', 'D'].map(function (x) {
    return { employeeId: 'E-' + x, name: 'Employee ' + x, email: DEFAULT_RECIPIENT, tabName: EMPLOYEE_TAB_PREFIX + 'Employee ' + x };
  }));
  setupTable_(SHEETS.TASKS, TASK_COLS, [
    { taskId: 'T-001', taskName: 'Daily Operations Update', employeeId: 'E-A', frequencyDays: 1, proofType: PROOF.DAILY_UPDATE,
      proofInstructions: 'Paste the update you posted in the Ops WhatsApp group', startDate: monday, active: true },
    { taskId: 'T-002', taskName: 'Portal Task A', employeeId: 'E-B', frequencyDays: 7, proofType: PROOF.TICKET,
      proofInstructions: 'Portal Ticket ID', startDate: monday, active: true },
    { taskId: 'T-003', taskName: 'Portal Task B', employeeId: 'E-C', frequencyDays: 15, proofType: PROOF.TICKET,
      proofInstructions: 'Portal Ticket ID', startDate: monday, active: true },
    { taskId: 'T-004', taskName: 'Portal Task C', employeeId: 'E-D', frequencyDays: 30, proofType: PROOF.TICKET,
      proofInstructions: 'Portal Ticket ID', startDate: monday, active: true }
  ]);
  var tasks = getSheet_(SHEETS.TASKS);
  tasks.getRange(2, 5, tasks.getMaxRows() - 1, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([PROOF.TICKET, PROOF.DAILY_UPDATE], true).build());
  tasks.getRange(2, 7, tasks.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  tasks.getRange(2, 8, tasks.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());

  setupTable_(SHEETS.HOLIDAYS, HOLIDAY_COLS, []);
  var hol = getSheet_(SHEETS.HOLIDAYS);
  hol.getRange(2, 1, hol.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  hol.getRange(2, 4, hol.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  setupTable_(SHEETS.CYCLES, CYCLE_COLS, []);
  setupTable_(SHEETS.ALERTS, ALERT_COLS, []);
  setupTable_(SHEETS.TESTS, TEST_COLS, []);
  var cycles = getSheet_(SHEETS.CYCLES);
  cycles.getRange(2, 14, cycles.getMaxRows() - 1, 1).setNumberFormat('@'); // Ticket IDs like 00123 keep their zeros

  writeGuide_();
  readTable_(SHEETS.EMPLOYEES, EMPLOYEE_COLS).forEach(function (emp) { setupEmployeeTab_(emp); });
  ensureSheet_(SHEETS.DASHBOARD).setFrozenRows(0);
  orderSheets_();
  var access = applyAccessRules_();

  var holidayNote = '';
  try {
    var n = syncHolidaysCore_();
    holidayNote = n === null ? '' : '\nHolidays: ' + n + ' public holidays synced from Google Calendar.';
  } catch (e) {
    holidayNote = '\nHolidays: sync failed (' + e.message + '). Try Ops Automation → Sync holidays now.';
  }
  runAutomation_();
  var accessNote = access.problems.length ? '\nAccess rules: could not add ' + access.problems.join('; ') : '\nAccess rules applied to ' + access.sheets + ' tabs.';
  SpreadsheetApp.getUi().alert('Setup complete.' + holidayNote + accessNote + '\n\nNext: Ops Automation → Install triggers (one time) so alerts run automatically.');
}

function setupTable_(name, cols, seed) {
  var sh = ensureSheet_(name);
  writeHeader_(sh, cols); // headers are owned by the code; rewriting picks up newly added columns
  if (seed.length && sh.getLastRow() < 2) appendTable_(name, cols, seed);
  return sh;
}

function setupEmployeeTab_(emp) {
  var sh = ensureSheet_(emp.tabName);
  sh.setFrozenRows(EMP_VIEW.HEADER_ROW);
  sh.setColumnWidths(1, EMP_VIEW.HEADERS.length, 140);
  sh.setColumnWidth(2, 180);
  sh.setColumnWidth(7, 220);
  sh.setColumnWidth(EMP_VIEW.INPUT_COL, 320);
  sh.getRange(EMP_VIEW.HEADER_ROW + 1, EMP_VIEW.INPUT_COL, sh.getMaxRows() - EMP_VIEW.HEADER_ROW, 1).setNumberFormat('@');
}

function orderSheets_() {
  var ss = getSpreadsheet_();
  var order = [SHEETS.GUIDE, SHEETS.DASHBOARD]
    .concat(readTable_(SHEETS.EMPLOYEES, EMPLOYEE_COLS).map(function (e) { return e.tabName; }))
    .concat([SHEETS.TASKS, SHEETS.EMPLOYEES, SHEETS.CONFIG, SHEETS.HOLIDAYS, SHEETS.CYCLES, SHEETS.ALERTS, SHEETS.TESTS]);
  order.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (sh) {
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(i + 1);
    }
  });
  var guide = ss.getSheetByName(SHEETS.GUIDE);
  if (guide) ss.setActiveSheet(guide);
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0) ss.deleteSheet(sheet1);
}

function installTriggers() {
  requireAdmin_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('handleEdit').forSpreadsheet(getSpreadsheet_()).onEdit().create();
  ScriptApp.newTrigger('runAutomation').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('runAutomation').timeBased().atHour(18).nearMinute(45).everyDays(1).create();
  ScriptApp.newTrigger('runAutomation').timeBased().atHour(7).everyDays(1).create();
  ScriptApp.newTrigger('syncHolidays').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  SpreadsheetApp.getUi().alert('Triggers installed (re-running replaces them, so there are never duplicates):\n\n' +
    '• On edit: records completions and acknowledgements\n• Every hour: new cycles, alerts and escalations\n' +
    '• Daily around 18:45: same-day manager alert run\n• Daily around 07:00: opens the day\'s cycles\n' +
    '• Weekly, Monday 06:00: refreshes public holidays from Google Calendar');
}

function resetLiveData() {
  var ui = requireAdmin_();
  if (ui.alert('Reset live data?', 'This clears ALL task cycles and the alert log. Task_Master is kept.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  withLock_(function () {
    writeTable_(SHEETS.CYCLES, CYCLE_COLS, []);
    writeTable_(SHEETS.ALERTS, ALERT_COLS, []);
    setConfigValue_('SIMULATED_NOW', '');
    runAutomation_();
  });
  toast_('Live data reset.');
}

function writeGuide_() {
  var sh = ensureSheet_(SHEETS.GUIDE);
  sh.clear();
  var lines = [
    ['Recurring Task Tracking & Escalation: How It Works', ''],
    ['', ''],
    ['WHO DOES WHAT', ''],
    ['Employee', 'Opens only their own "My Tasks - <name>" tab. It lists what is Overdue or Pending now, plus recent completions. The next occurrence of a task appears automatically on the day its period starts. To complete a task they type ONE thing into the yellow cell: the portal Ticket ID, or for the daily task, the update they posted in the WhatsApp group. Nothing else to update anywhere.'],
    ['System', 'Records who completed it and when, closes the cycle, and refreshes the Manager Dashboard. The next occurrence opens automatically when its period starts. Invalid entries (e.g. a 1-character ticket) are rejected with a note explaining why.'],
    ['Manager', 'Watches the Manager Dashboard (team summary + exceptions). Receives ONE same-day email per overdue item. Must acknowledge it (email button or tick Ack ✔ on the dashboard) and record the action taken.'],
    ['Leadership', 'Receives ONE escalation email per item if the manager does not acknowledge in time, the task is still not done after the SLA, or the manager asks for help.'],
    ['', ''],
    ['RECURRENCE', ''],
    ['Cycles', 'Each task has a frequency (1 = every working day, 7, 15, 30 days) and a start date. Cycle N covers start + N×frequency for "frequency" days and is due at DUE_TIME on the last working day of that period. Cycles are anchored on the start date, so completing late never shifts future due dates.'],
    ['Next cycle', 'Created automatically by the scheduled run (07:00 daily and hourly) on the day its period starts; nothing is created in advance. Task_Master\'s Status shows when the next one is due. Each cycle has a fixed ID (TaskID-YYYYMMDD), so it can never be created twice.'],
    ['', ''],
    ['DAILY TASK PROOF (no Ticket ID)', ''],
    ['Method', 'The employee posts the daily update in the WhatsApp group as usual, then pastes the same text into the yellow cell (one copy-paste). The system stores the text, the time and the editor. Text shorter than 15 characters (e.g. "done") is rejected, so a real update is captured. The manager can spot-check it against the group.'],
    ['Why', 'WhatsApp does not offer an API to read group messages, so automatic detection is not possible without third-party tools. Copy-paste is a single action with no new app, and it produces an audit trail. Upgrade path: post via the WhatsApp Business API from this sheet, so posting and recording happen in one step.'],
    ['', ''],
    ['ESCALATION SLA (all times configurable in Config)', ''],
    ['T0: due', 'Task due at 18:00 on its due date (last working day of the cycle).'],
    ['T0 + 30 min', 'Same-day manager email. One email per run lists every newly overdue item. The 30-minute grace period covers last-minute updates.'],
    ['Next working day 12:00', 'If the manager has NOT acknowledged, escalate to leadership. Half a working day is enough to react, and leadership hears about it the same day.'],
    ['Due date + 2 working days, 18:00', 'If the manager acknowledged but the task is STILL not completed, escalate to leadership.'],
    ['Any time after the alert', 'Manager picks "Blocked: needs leadership help", which escalates on the next run.'],
    ['Sundays / holidays', 'Skipped when counting working days, so no one is escalated over a weekend or holiday. The Holidays tab is refreshed every Monday from Google\'s India public holiday calendar (public holidays only, not observances). Add company-specific days as extra rows (kept on every sync); untick Observed for a public holiday the company works through.'],
    ['No repeat emails', 'Each cycle stores Manager Alerted At and Leadership Escalated At. Each level fires at most once per cycle, every run holds a lock, and markers are saved immediately after sending. After escalation the item stays red on the dashboard instead of generating more email.'],
    ['', ''],
    ['TABS', ''],
    ['Manager Dashboard', 'Team summary + exceptions with Ack / Manager Action / Note (editable).'],
    ['My Tasks - <name>', 'Each employee\'s single place of work.'],
    ['Task_Master', 'Add a task by typing a new row: Task Name, Assigned To (employee ID or name, e.g. Employee B) and Frequency (days). Everything else fills itself in (Task ID, Start Date = today, Active, Proof Type = TICKET). The task appears on the employee\'s My Tasks tab at once. To prepare a task without showing it yet, give it a future Start Date: it stays "🗓 Scheduled" and appears on that day. The Status column also shows when the task was last done, by whom and whether it was on time, or exactly what to fix. Changing Assigned To or the Task Name moves the task\'s open cycles to match (completed ones stay as history). Untick Active to pause a task: its open cycle is cancelled and disappears from the employee\'s tab and the dashboard (kept in Task_Cycles as a record). Tick it again to resume.'],
    ['Employees / Config / Holidays', 'Team list, SLA settings and recipients, non-working days.'],
    ['Task_Cycles', 'System of record: one row per cycle with completion, alert, ack and escalation history.'],
    ['Alert_Log', 'Every email the system has sent.'],
    ['Test_Log', 'Results of the built-in demo tests (menu ⚙ Ops Automation → Demo tests).'],
    ['', ''],
    ['DEMO', ''],
    ['ACCESS', ''],
    ['Employees', 'Can edit only their own "My Tasks" tab (matched by their email in the Employees tab). Anything typed outside the yellow column is undone automatically.'],
    ['Managers', 'The address(es) in Config → MANAGER_EMAIL can edit the Manager Dashboard (Ack ✔, Manager Action, Note) and Task_Master, to assign tasks.'],
    ['Admins', 'The sheet owner plus Config → ADMIN_EMAILS can edit every tab and use the ⚙ Ops Automation menu (everyone sees the menu; it only runs for admins). Every other tab is admin-only.'],
    ['Viewing', 'Google Sheets cannot hide tabs per person: everyone with access can view every tab. Rules re-apply automatically when the Employees or Config tab changes, or via ⚙ Ops Automation → Apply access rules.'],
    ['Copyright', '© 2026 Prateek Sahni. All rights reserved. Built for the Allo Innoware AI Operations Manager assignment.'],
    ['For reviewers', 'Reviewers are set up as admins, so you can run the demo and act as any employee or the manager. The first time you use the ⚙ Ops Automation menu, Google asks for permission ("Google hasn\'t verified this app" → Advanced → Go to Allo Recurring Task Tracker → Allow). This is the sheet\'s own script. The automation already runs on the owner\'s account, so you do not need "Install triggers". To try it live: type a Ticket ID in the yellow cell of a My Tasks tab, or acknowledge an item on the Manager Dashboard.'],
    ['How to test', 'Menu ⚙ Ops Automation → Demo tests → Run all 8 tests (or a single test). Tests use a simulated clock (Config SIMULATED_NOW) so days of activity happen in seconds. Your live data is saved first. Real emails are sent, prefixed [DEMO]. Afterwards, look at the dashboard, the tabs, Task_Cycles and Alert_Log, then choose "Exit demo mode" to restore live data.']
  ];
  sh.getRange(1, 1, lines.length, 2).setValues(lines).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 230);
  sh.setColumnWidth(2, 820);
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor(COLORS.title);
  lines.forEach(function (l, i) {
    if (l[0] && !l[1] && i > 0) sh.getRange(i + 1, 1, 1, 2).setFontWeight('bold').setBackground(COLORS.header).setFontColor(COLORS.headerText);
    else if (l[1]) sh.getRange(i + 1, 1).setFontWeight('bold');
  });
}
