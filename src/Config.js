/**
 * Sheet names, column schemas, defaults and configuration loading.
 */

var SHEETS = {
  GUIDE: 'How It Works',
  DASHBOARD: 'Manager Dashboard',
  TASKS: 'Task_Master',
  EMPLOYEES: 'Employees',
  CONFIG: 'Config',
  HOLIDAYS: 'Holidays',
  CYCLES: 'Task_Cycles',
  ALERTS: 'Alert_Log',
  TESTS: 'Test_Log',
  SNAPSHOT_CYCLES: '_Snapshot_Cycles',
  SNAPSHOT_ALERTS: '_Snapshot_Alerts'
};

var EMPLOYEE_TAB_PREFIX = 'My Tasks - ';

// Placeholder used only when Setup creates a fresh Config tab; real recipients are set in the Config tab.
var DEFAULT_RECIPIENT = 'ops-manager@example.com';

// [object key, column header]
var EMPLOYEE_COLS = [['employeeId', 'Employee ID'], ['name', 'Name'], ['email', 'Email'], ['tabName', 'My Tasks Tab']];

var TASK_COLS = [
  ['taskId', 'Task ID'], ['taskName', 'Task Name'], ['employeeId', 'Assigned To (Employee ID)'],
  ['frequencyDays', 'Frequency (Days)'], ['proofType', 'Proof Type'], ['proofInstructions', 'What the Employee Enters'],
  ['startDate', 'Start Date'], ['active', 'Active'], ['setupCheck', 'Status (automatic)']
];

var CYCLE_COLS = [
  ['cycleId', 'Cycle ID'], ['taskId', 'Task ID'], ['taskName', 'Task Name'], ['employeeId', 'Employee ID'],
  ['employeeName', 'Employee'], ['frequencyDays', 'Frequency (Days)'], ['start', 'Cycle Start'], ['periodEnd', 'Cycle End'],
  ['dueDate', 'Due Date'], ['dueAt', 'Due At'], ['status', 'Status'], ['proofType', 'Proof Type'],
  ['proofInstructions', 'What to Enter'], ['proof', 'Ticket ID / Update'], ['completedAt', 'Completed At'],
  ['completedBy', 'Completed By'], ['resolution', 'Resolution'], ['managerAlertedAt', 'Manager Alerted At'],
  ['ackToken', 'Ack Token'], ['managerAckAt', 'Manager Ack At'], ['managerAckBy', 'Manager Ack By'],
  ['managerAction', 'Manager Action'], ['managerNote', 'Manager Note'], ['leadershipEscalatedAt', 'Leadership Escalated At'],
  ['escalationReason', 'Escalation Reason'], ['createdAt', 'Created At'], ['cancelledAt', 'Cancelled At']
];

var ALERT_COLS = [
  ['alertKey', 'Alert Key'], ['level', 'Level'], ['sentAt', 'Sent At'], ['simulatedAt', 'Simulated Time'],
  ['to', 'Sent To'], ['subject', 'Subject'], ['cycleIds', 'Cycle IDs'], ['count', 'Items']
];

var TEST_COLS = [['runAt', 'Run At'], ['test', 'Test'], ['result', 'Result'], ['evidence', 'Evidence']];

var HOLIDAY_COLS = [['date', 'Date'], ['name', 'Holiday'], ['source', 'Source'], ['observed', 'Observed']];

var CONFIG_DEFAULTS = [
  ['ADMIN_EMAILS', '', 'Extra people (comma-separated) allowed to use the admin menu items and edit this tab. The sheet owner is always an admin.'],
  ['MANAGER_NAME', 'Operations Manager', 'Name used in emails'],
  ['MANAGER_EMAIL', DEFAULT_RECIPIENT, 'Receives the same-day pending-task alert'],
  ['LEADERSHIP_EMAIL', DEFAULT_RECIPIENT, 'Receives leadership escalations'],
  ['WORKING_DAYS', 'Mon,Tue,Wed,Thu,Fri,Sat', 'Days on which tasks can fall due (see also the Holidays tab)'],
  ['DUE_TIME', '18:00', 'A task must be completed by this time on its due date'],
  ['MANAGER_ALERT_DELAY_MIN', '30', 'Minutes after the due time before the manager is emailed (same day)'],
  ['ACK_DEADLINE_TIME', '12:00', 'Manager must acknowledge by this time on the next working day after the alert'],
  ['RESOLVE_WORKING_DAYS', '2', 'Working days after the due date by which an acknowledged task must be completed'],
  ['RESOLVE_DEADLINE_TIME', '18:00', 'Time of day of the resolution deadline'],
  ['HOLIDAY_CALENDAR_ID', 'en.indian#holiday@group.v.calendar.google.com',
    'Google public holiday calendar synced weekly into Holidays (public holidays only). Blank = no sync.'],
  ['WEBAPP_URL', '', 'Web app /exec URL used for one-click acknowledgement links in emails'],
  ['SIMULATED_NOW', '', 'DEMO ONLY: "YYYY-MM-DD HH:MM" makes the system act as if it is that time. Blank = live.']
];

var MANAGER_ACTIONS = [
  'Followed up with employee',
  'Extension agreed with employee',
  'Task reassigned',
  'Blocked: needs leadership help', // = LEADERSHIP_HELP_ACTION (Logic.js); a literal because file load order is not guaranteed
  'Other'
];

function loadConfig_() {
  var map = {};
  getSheet_(SHEETS.CONFIG).getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[0]) map[String(r[0]).trim()] = r[1];
  });
  var holidays = {};
  readTable_(SHEETS.HOLIDAYS, HOLIDAY_COLS).forEach(function (h) {
    if (h.observed !== '' && !isActive(h.observed)) return; // unticked: the company works that day
    var d = isDate(h.date) ? h.date : parseDateTime(h.date);
    if (d) holidays[dateKey(d)] = h.name || 'Holiday';
  });
  return buildSettings(map, holidays);
}

function setConfigValue_(key, value) {
  var sh = getSheet_(SHEETS.CONFIG);
  var row = findRowByValue_(sh, 1, key);
  if (!row) throw new Error('Config key ' + key + ' not found. Run Ops Automation → Setup / repair.');
  sh.getRange(row, 2).setValue(value);
}
