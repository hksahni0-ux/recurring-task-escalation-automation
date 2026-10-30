const { loadGas } = require('../helpers/loadGas');
const { createFakeGoogle } = require('../helpers/fakeGoogle');

const g = loadGas(createFakeGoogle().globals);

const D = (s) => g.parseDateTime(s); // 'YYYY-MM-DD HH:MM' in IST
const settings = (over = {}) =>
  g.buildSettings(
    {
      MANAGER_EMAIL: 'mgr@example.com',
      LEADERSHIP_EMAIL: 'lead@example.com',
      WORKING_DAYS: 'Mon,Tue,Wed,Thu,Fri,Sat',
      DUE_TIME: '18:00',
      MANAGER_ALERT_DELAY_MIN: '30',
      ACK_DEADLINE_TIME: '12:00',
      RESOLVE_WORKING_DAYS: '2',
      RESOLVE_DEADLINE_TIME: '18:00',
      ...over,
    },
    {}
  );

// 2026-11-02 is a Monday.
const weekly = { taskId: 'T-002', frequencyDays: 7, startDate: D('2026-11-02') };
const daily = { taskId: 'T-001', frequencyDays: 1, startDate: D('2026-11-02') };
const fortnight = { taskId: 'T-003', frequencyDays: 15, startDate: D('2026-11-02') };

describe('settings', () => {
  test('parses times, numbers and working days', () => {
    const s = settings();
    expect(s.dueTime).toEqual({ h: 18, m: 0 });
    expect(s.managerAlertDelayMin).toBe(30);
    expect(s.workingDays).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(s.simulatedNow).toBeNull();
  });

  test('reads SIMULATED_NOW and rejects garbage', () => {
    expect(g.dateKey(settings({ SIMULATED_NOW: '2026-11-03 18:35' }).simulatedNow)).toBe('2026-11-03');
    expect(() => settings({ SIMULATED_NOW: 'tomorrow' })).toThrow(/YYYY-MM-DD/);
  });

  test('rejects an invalid time', () => {
    expect(() => settings({ DUE_TIME: '25:00' })).toThrow(/HH:MM/);
  });
});

describe('working-day calendar', () => {
  const s = settings();
  test('Sunday is not a working day; holidays are skipped', () => {
    expect(g.isWorkingDay(D('2026-11-08'), s)).toBe(false); // Sun
    const h = g.buildSettings({ WORKING_DAYS: 'Mon,Tue,Wed,Thu,Fri,Sat' }, { '2026-11-09': 'Holiday' });
    expect(g.dateKey(g.nextWorkingDay(D('2026-11-07'), h))).toBe('2026-11-10');
  });

  test('addWorkingDays skips Sundays', () => {
    expect(g.dateKey(g.addWorkingDays(D('2026-11-07'), 2, s))).toBe('2026-11-10'); // Sat + 2 = Tue
  });
});

describe('recurring cycles', () => {
  const s = settings();

  test('weekly cycle covers 7 days and is due on the last working day', () => {
    const c = g.cycleForDate(weekly, D('2026-11-04 10:00'), s);
    expect(c.cycleId).toBe('T-002-20261102');
    expect(g.dateKey(c.start)).toBe('2026-11-02');
    expect(g.dateKey(c.periodEnd)).toBe('2026-11-08');
    expect(g.dateKey(c.dueDate)).toBe('2026-11-07'); // Sunday end shifts back to Saturday
    expect(g.fmtTime(c.dueAt)).toBe('18:00');
  });

  test('the next weekly cycle starts exactly 7 days later (no drift from late completion)', () => {
    const c = g.cycleForDate(weekly, D('2026-11-02'), s);
    const n = g.nextCycleAfter(weekly, c, s);
    expect(n.cycleId).toBe('T-002-20261109');
    expect(g.cycleForDate(weekly, D('2026-11-12'), s).cycleId).toBe(n.cycleId);
  });

  test('15-day cycle', () => {
    const c = g.cycleForDate(fortnight, D('2026-11-20'), s);
    expect(c.cycleId).toBe('T-003-20261117');
    expect(g.dateKey(c.periodEnd)).toBe('2026-12-01');
  });

  test('daily cycles exist only on working days', () => {
    expect(g.cycleForDate(daily, D('2026-11-08 09:00'), s)).toBeNull(); // Sunday
    const sat = g.cycleForDate(daily, D('2026-11-07 09:00'), s);
    expect(g.nextCycleAfter(daily, sat, s).cycleId).toBe('T-001-20261109'); // skips Sunday
  });

  test('no cycle before the task start date', () => {
    expect(g.cycleForDate(weekly, D('2026-11-01'), s)).toBeNull();
  });

  test('cyclesToCreate is idempotent and skips inactive tasks', () => {
    const existing = {};
    const tasks = [{ ...weekly, active: true }, { ...daily, active: 'No' }];
    expect(g.cyclesToCreate(tasks, existing, D('2026-11-03 10:00'), s).map((c) => c.cycleId)).toEqual(['T-002-20261102']);
    expect(g.cyclesToCreate(tasks, existing, D('2026-11-03 10:00'), s)).toEqual([]);
  });

  test('status moves Upcoming → Pending → Overdue → Completed', () => {
    const c = g.cycleForDate(weekly, D('2026-11-02'), s);
    expect(g.cycleStatus(c, D('2026-11-01 23:59'))).toBe('Upcoming');
    expect(g.cycleStatus(c, D('2026-11-07 18:00'))).toBe('Pending');
    expect(g.cycleStatus(c, D('2026-11-07 18:01'))).toBe('Overdue');
    expect(g.cycleStatus({ ...c, completedAt: D('2026-11-07 19:00') }, D('2026-11-08'))).toBe('Completed');
  });
});

describe('proof validation', () => {
  test('ticket IDs', () => {
    expect(g.validateProof('TICKET', ' TCK-1042 ')).toEqual({ ok: true, value: 'TCK-1042' });
    expect(g.validateProof('TICKET', '').ok).toBe(false);
    expect(g.validateProof('TICKET', 'x').ok).toBe(false);
    expect(g.validateProof('TICKET', '=HYPERLINK("x")').ok).toBe(false);
    expect(g.validateProof('TICKET', 1001).value).toBe('1001');
  });

  test('daily update needs real content', () => {
    expect(g.validateProof('DAILY_UPDATE', 'done').ok).toBe(false);
    expect(g.validateProof('DAILY_UPDATE', 'Dispatched 42 orders, 2 delayed').ok).toBe(true);
  });
});

describe('SLA / escalation', () => {
  const s = settings();
  const base = g.cycleForDate(daily, D('2026-11-03'), s); // Tue, due 18:00
  const at = (t) => D(t);

  test('no alert before the due time + grace period', () => {
    expect(g.evaluateEscalation(base, at('2026-11-03 17:59'), s).action).toBe('NONE');
    expect(g.evaluateEscalation(base, at('2026-11-03 18:29'), s).action).toBe('NONE');
  });

  test('same-day manager alert at due + 30 min', () => {
    expect(g.evaluateEscalation(base, at('2026-11-03 18:30'), s).action).toBe('MANAGER_ALERT');
  });

  test('completed cycles never alert', () => {
    expect(g.evaluateEscalation({ ...base, completedAt: at('2026-11-03 18:10') }, at('2026-11-04 13:00'), s).action).toBe('NONE');
  });

  test('escalates when the manager does not acknowledge by 12:00 next working day', () => {
    const c = { ...base, managerAlertedAt: at('2026-11-03 18:35') };
    expect(g.evaluateEscalation(c, at('2026-11-04 11:59'), s).action).toBe('NONE');
    const r = g.evaluateEscalation(c, at('2026-11-04 12:00'), s);
    expect(r.action).toBe('LEADERSHIP_ESCALATION');
    expect(r.reason).toMatch(/did not acknowledge/);
  });

  test('acknowledged but unresolved escalates after 2 working days at 18:00', () => {
    const c = { ...base, managerAlertedAt: at('2026-11-03 18:35'), managerAckAt: at('2026-11-03 19:00') };
    expect(g.evaluateEscalation(c, at('2026-11-05 17:59'), s).action).toBe('NONE');
    const r = g.evaluateEscalation(c, at('2026-11-05 18:00'), s);
    expect(r.action).toBe('LEADERSHIP_ESCALATION');
    expect(r.reason).toMatch(/still not completed/i);
  });

  test('manager asking for leadership help escalates at once', () => {
    const c = { ...base, managerAlertedAt: at('2026-11-03 18:35'), managerAckAt: at('2026-11-03 19:00'), managerAction: 'Blocked: needs leadership help', managerNote: 'Portal access revoked' };
    const r = g.evaluateEscalation(c, at('2026-11-03 19:05'), s);
    expect(r.action).toBe('LEADERSHIP_ESCALATION');
    expect(r.reason).toMatch(/leadership help.*Portal access revoked/);
  });

  test('never escalates twice', () => {
    const c = { ...base, managerAlertedAt: at('2026-11-03 18:35'), leadershipEscalatedAt: at('2026-11-04 12:05') };
    expect(g.evaluateEscalation(c, at('2026-11-10 12:00'), s).action).toBe('NONE');
  });

  test('a Saturday alert gets until Monday noon (Sunday skipped)', () => {
    const sat = { ...g.cycleForDate(daily, D('2026-11-07'), s), managerAlertedAt: at('2026-11-07 18:35') };
    const d = g.slaDeadlines(sat, s);
    expect(g.fmtDateTime(d.ackDeadline)).toBe('Mon 09 Nov 2026, 12:00');
    expect(g.fmtDateTime(d.resolveDeadline)).toBe('Tue 10 Nov 2026, 18:00');
  });

  test('describeResolution', () => {
    expect(g.describeResolution({ dueAt: base.dueAt }, at('2026-11-03 10:00'))).toBe('Completed on time');
    expect(g.describeResolution({ dueAt: base.dueAt }, at('2026-11-03 18:20'))).toBe('Completed late (before manager alert)');
    expect(g.describeResolution({ dueAt: base.dueAt, managerAlertedAt: at('2026-11-03 18:35') }, at('2026-11-03 19:00'))).toBe('Completed after manager alert');
    expect(g.describeResolution({ dueAt: base.dueAt, managerAlertedAt: 1, leadershipEscalatedAt: 1 }, at('2026-11-05'))).toBe('Completed after leadership escalation');
  });
});

describe('views', () => {
  const s = settings();
  test('employee view lists open work first, then upcoming, then recent completions', () => {
    const now = D('2026-11-04 10:00');
    const mk = (task, day, extra = {}) => ({ ...g.cycleForDate(task, D(day), s), ...extra });
    const cycles = [
      mk(daily, '2026-11-05'), // upcoming
      mk(daily, '2026-11-03', { completedAt: D('2026-11-03 17:00') }),
      mk(daily, '2026-11-04'), // pending
      mk(weekly, '2026-11-02'), // pending, later due
    ];
    expect(g.selectEmployeeView(cycles, now, 5).map((c) => c.cycleId)).toEqual([
      'T-001-20261104',
      'T-002-20261102',
      'T-001-20261105',
      'T-001-20261103',
    ]);
  });
});

describe('holiday calendar sync', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261108',
    'DESCRIPTION:Public holiday',
    'SUMMARY:Diwali/Deepavali',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261109',
    'DESCRIPTION:Observance\\nTo hide observances\\, go to Google Calendar Setting',
    ' s > Holidays in India',
    'SUMMARY:Govardhan Puja',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261124',
    'DESCRIPTION:Public holiday\\nDate is tentative and may change.',
    'SUMMARY:Guru Nanak',
    '  Jayanti',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20250101',
    'DESCRIPTION:Public holiday',
    'SUMMARY:Too old',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('keeps only public holidays inside the window, unfolding wrapped lines', () => {
    const out = g.parseIcsHolidays(ics, D('2026-01-01'), D('2027-12-31'));
    expect(out.map((h) => [g.dateKey(h.date), h.name])).toEqual([
      ['2026-11-08', 'Diwali/Deepavali'],
      ['2026-11-24', 'Guru Nanak Jayanti'],
    ]);
  });

  test('merge keeps manual rows and Observed choices, replaces stale calendar rows', () => {
    const existing = [
      { date: D('2026-11-08'), name: 'Diwali/Deepavali', source: 'Google Calendar', observed: false },
      { date: D('2026-12-31'), name: 'Company offsite', source: 'Manual', observed: true },
      { date: D('2026-11-25'), name: 'Guru Nanak Jayanti', source: 'Google Calendar', observed: true }, // date moved
    ];
    const fetched = [
      { date: D('2026-11-08'), name: 'Diwali/Deepavali' },
      { date: D('2026-11-24'), name: 'Guru Nanak Jayanti' },
    ];
    expect(g.mergeHolidays(existing, fetched).map((h) => [g.dateKey(h.date), h.name, h.source, h.observed])).toEqual([
      ['2026-11-08', 'Diwali/Deepavali', 'Google Calendar', false],
      ['2026-11-24', 'Guru Nanak Jayanti', 'Google Calendar', true],
      ['2026-12-31', 'Company offsite', 'Manual', true],
    ]);
  });

  test('rows with an empty source count as manual, and blank Observed means observed', () => {
    const merged = g.mergeHolidays([{ date: D('2026-12-31'), name: 'Offsite', source: '', observed: '' }], []);
    expect(merged[0]).toMatchObject({ source: 'Manual', observed: true });
  });
});

describe('admin guard', () => {
  test('the owner and listed admins are admins, case-insensitively; blank is never an admin', () => {
    expect(g.isAdminEmail('owner@x.com', 'owner@x.com', '')).toBe(true);
    expect(g.isAdminEmail('Ops.Lead@X.com', 'owner@x.com', 'a@x.com, ops.lead@x.com')).toBe(true);
    expect(g.isAdminEmail('reviewer@x.com', 'owner@x.com', 'a@x.com')).toBe(false);
    expect(g.isAdminEmail('', '', '')).toBe(false);
    expect(g.isAdminEmail('', 'owner@x.com', '')).toBe(false);
  });
});

describe('email subjects name the employee, task and due time', () => {
  const s = settings();
  const mk = (task, day, name, emp) => ({ ...g.cycleForDate(task, D(day), s), taskName: name, employeeName: emp, ackToken: 't', managerAlertedAt: D(day + ' 18:35') });
  const a = mk(daily, '2026-11-02', 'Daily Operations Update', 'Employee A');
  const b = mk(weekly, '2026-11-02', 'Portal Task A', 'Employee B');
  const c = mk(fortnight, '2026-11-02', 'Portal Task B', 'Employee C');
  const now = D('2026-11-02 18:35');

  test('single manager alert', () => {
    expect(g.buildManagerAlertEmail([a], s, now, '').subject)
      .toBe('[Ops Alert] Employee A: Daily Operations Update not completed (due Mon 02 Nov, 18:00)');
  });

  test('several items are summarised, with the rest counted', () => {
    expect(g.buildManagerAlertEmail([a, b, c], s, now, '').subject)
      .toBe('[Ops Alert] 3 tasks not completed: Employee A (Daily Operations Update, due Mon 02 Nov), Employee B (Portal Task A, due Sat 07 Nov) +1 more');
    expect(g.buildManagerAlertEmail([a, b], s, now, '').subject)
      .toBe('[Ops Alert] 2 tasks not completed: Employee A (Daily Operations Update, due Mon 02 Nov), Employee B (Portal Task A, due Sat 07 Nov)');
  });

  test('escalations', () => {
    expect(g.buildEscalationEmail([{ cycle: b, reason: 'x' }], s, now).subject)
      .toBe('[Escalation] Employee B: Portal Task A unresolved (due Sat 07 Nov, 18:00)');
    expect(g.buildEscalationEmail([{ cycle: a, reason: 'x' }, { cycle: b, reason: 'y' }], s, now).subject)
      .toBe('[Escalation] 2 tasks unresolved: Employee A (Daily Operations Update, due Mon 02 Nov), Employee B (Portal Task A, due Sat 07 Nov)');
  });

  test('demo emails keep the [DEMO] marker', () => {
    const demo = g.buildSettings({ SIMULATED_NOW: '2026-11-02 18:35' }, {});
    expect(g.buildManagerAlertEmail([a], demo, now, '').subject).toMatch(/^\[DEMO\] \[Ops Alert\] Employee A:/);
  });
});

describe('access plan', () => {
  const employees = [
    { employeeId: 'E-A', name: 'Employee A', email: 'a@x.com', tabName: 'My Tasks - Employee A' },
    { employeeId: 'E-B', name: 'Employee B', email: 'B@x.com ', tabName: 'My Tasks - Employee B' },
  ];
  const plan = g.buildAccessPlan(employees, 'owner@x.com, admin2@x.com', 'mgr@x.com, mgr2@x.com');
  const editorsOf = (sheet) => plan.find((p) => p.sheet === sheet).editors;

  test('each employee tab: admins + that employee only', () => {
    expect(editorsOf('My Tasks - Employee A')).toEqual(['owner@x.com', 'admin2@x.com', 'a@x.com']);
    expect(editorsOf('My Tasks - Employee B')).toEqual(['owner@x.com', 'admin2@x.com', 'b@x.com']);
  });

  test('dashboard: admins + managers', () => {
    expect(editorsOf('Manager Dashboard')).toEqual(['owner@x.com', 'admin2@x.com', 'mgr@x.com', 'mgr2@x.com']);
  });

  test('every other tab is admin-only', () => {
    ['How It Works', 'Task_Master', 'Employees', 'Config', 'Holidays', 'Task_Cycles', 'Alert_Log', 'Test_Log']
      .forEach((n) => expect(editorsOf(n)).toEqual(['owner@x.com', 'admin2@x.com']));
  });

  test('an admin who is also an employee is listed once', () => {
    const p = g.buildAccessPlan([{ ...employees[0], email: 'OWNER@x.com' }], 'owner@x.com', '');
    expect(p.find((x) => x.sheet === 'My Tasks - Employee A').editors).toEqual(['owner@x.com']);
  });
});
