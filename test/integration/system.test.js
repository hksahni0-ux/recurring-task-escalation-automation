const { loadGas } = require('../helpers/loadGas');
const { createFakeGoogle } = require('../helpers/fakeGoogle');

function boot() {
  // Real clock pinned to Mon 02 Nov 2026 09:00 IST so setup's live run is deterministic.
  jest.useFakeTimers({ now: new Date('2026-11-02T09:00:00+05:30') });
  const fake = createFakeGoogle();
  const g = loadGas(fake.globals);
  g.setupSystem();
  return { fake, g, sheet: (n) => fake.ss.getSheetByName(n) };
}

const setNow = (g, s) => g.setConfigValue_('SIMULATED_NOW', s);

describe('setup', () => {
  test('creates every sheet and seeds the four assignment tasks', () => {
    const { g, sheet } = boot();
    ['How It Works', 'Manager Dashboard', 'Task_Master', 'Employees', 'Config', 'Holidays', 'Task_Cycles', 'Alert_Log', 'Test_Log',
      'My Tasks - Employee A', 'My Tasks - Employee D'].forEach((n) => expect(sheet(n)).not.toBeNull());
    const tasks = g.readTable_('Task_Master', g.TASK_COLS);
    expect(tasks.map((t) => [t.taskId, t.employeeId, t.frequencyDays, t.proofType])).toEqual([
      ['T-001', 'E-A', 1, 'DAILY_UPDATE'],
      ['T-002', 'E-B', 7, 'TICKET'],
      ['T-003', 'E-C', 15, 'TICKET'],
      ['T-004', 'E-D', 30, 'TICKET'],
    ]);
  });

  test('is safe to run twice (no duplicated seed rows)', () => {
    const { g } = boot();
    g.setupSystem();
    expect(g.readTable_('Task_Master', g.TASK_COLS)).toHaveLength(4);
    expect(g.readTable_('Employees', g.EMPLOYEE_COLS)).toHaveLength(4);
  });
});

describe('employee single-point update', () => {
  test('entering a ticket on My Tasks completes the cycle (no future cycle is stored)', () => {
    const { g, sheet } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    const tab = sheet('My Tasks - Employee B');
    const row = g.findRowByValue_(tab, 1, 'T-002-' + g.compactDate(g.cycleForDate(g.readTable_('Task_Master', g.TASK_COLS)[1], g.parseDateTime('2026-11-03'), g.loadConfig_()).start));
    expect(row).toBeGreaterThan(g.EMP_VIEW.HEADER_ROW);
    const cell = tab.getRange(row, g.EMP_VIEW.INPUT_COL);
    cell.setValue('TCK-555');
    g.handleEdit_({ range: cell, value: 'TCK-555', oldValue: '' });

    const cycles = g.readTable_('Task_Cycles', g.CYCLE_COLS).filter((c) => c.taskId === 'T-002');
    expect(cycles).toHaveLength(1); // no future row: the next cycle is created when its period starts
    expect(cycles[0]).toMatchObject({ status: 'Completed', proof: 'TCK-555' });
    expect(cycles[0].completedBy).toMatch(/Employee B/);
  });

  test('an invalid ticket is rejected, nothing is recorded, and the employee sees why', () => {
    const { g, fake, sheet } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    const tab = sheet('My Tasks - Employee C');
    const row = g.EMP_VIEW.HEADER_ROW + 1;
    const cell = tab.getRange(row, g.EMP_VIEW.INPUT_COL);
    cell.setValue('x');
    g.handleEdit_({ range: cell, value: 'x', oldValue: '' });
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).find((c) => c.taskId === 'T-003').completedAt).toBe('');
    expect(fake.ss.toasts.join(' ')).toMatch(/Ticket ID/);
    expect(tab.getRange(row, g.EMP_VIEW.INPUT_COL).getNote()).toMatch(/Ticket ID/);
  });

  test('edits outside the input column are ignored', () => {
    const { g, sheet } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    const tab = sheet('My Tasks - Employee C');
    const cell = tab.getRange(g.EMP_VIEW.HEADER_ROW + 1, 2);
    g.handleEdit_({ range: cell, value: 'hello', oldValue: '' });
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).every((c) => !c.completedAt)).toBe(true);
  });
});

describe('alerts, acknowledgement and web app', () => {
  test('manager alert email has an acknowledgement link that records the ack', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-03 18:40');
    g.runAutomation_();
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0].to).toBe(g.DEFAULT_RECIPIENT);
    expect(fake.outbox[0].htmlBody).toMatch(/a=ack&amp;t=uuid-/);

    const c = g.readTable_('Task_Cycles', g.CYCLE_COLS).find((x) => x.managerAlertedAt);
    const page = g.doGet({ parameter: { a: 'ack', t: c.ackToken } }).getContent();
    expect(page).toMatch(/Daily Operations Update/);

    expect(g.submitAck(c.ackToken, 'Followed up with employee', 'Called them')).toMatch(/Acknowledged/);
    expect(g.submitAck(c.ackToken, 'Followed up with employee', '')).toMatch(/already acknowledged/i);
    const after = g.readTable_('Task_Cycles', g.CYCLE_COLS).find((x) => x.cycleId === c.cycleId);
    expect(after.managerAction).toBe('Followed up with employee');
  });

  test('bad tokens and bad actions are refused', () => {
    const { g } = boot();
    expect(g.doGet({ parameter: { a: 'ack', t: 'nope' } }).getContent()).toMatch(/not valid/);
    expect(() => g.submitAck('nope', 'Followed up with employee', '')).toThrow(/not valid/);
    setNow(g, '2026-11-03 18:40');
    g.runAutomation_();
    const c = g.readTable_('Task_Cycles', g.CYCLE_COLS).find((x) => x.managerAlertedAt);
    expect(() => g.submitAck(c.ackToken, 'Delete everything', '')).toThrow(/Choose an action/);
  });

  test('user-supplied text is HTML-escaped on the ack page', () => {
    const { g } = boot();
    setNow(g, '2026-11-03 18:40');
    g.runAutomation_();
    const c = g.readTable_('Task_Cycles', g.CYCLE_COLS).find((x) => x.managerAlertedAt);
    g.submitAck(c.ackToken, 'Other', '<script>alert(1)</script>');
    const page = g.doGet({ parameter: { a: 'ack', t: c.ackToken } }).getContent();
    expect(page).not.toMatch(/<script>alert/);
    expect(page).toMatch(/&lt;script&gt;/);
  });

  test('menu-only actions refuse to run outside the spreadsheet UI (e.g. via the public web app)', () => {
    const { g, fake } = boot();
    fake.uiAvailable = false;
    expect(() => g.resetLiveData()).toThrow(/spreadsheet menu/);
    expect(() => g.runAllDemoTests()).toThrow(/spreadsheet menu/);
    expect(() => g.setupSystem()).toThrow(/spreadsheet menu/);
  });
});

describe('spreadsheet time zone differs from the script (IST)', () => {
  // Regression: a clasp-created Sheet takes the account's time zone. Dates then shifted by hours,
  // which broke next-cycle lookup (Tests 1, 3) and fired the manager alert inside the grace period (Test 4).
  test('setup aligns the spreadsheet time zone and all eight demo tests pass', () => {
    jest.useFakeTimers({ now: new Date('2026-10-30T18:20:00+05:30') });
    const fake = createFakeGoogle({ spreadsheetTimeZone: 'Europe/London' });
    const g = loadGas(fake.globals);
    g.setupSystem();
    expect(fake.ss.getSpreadsheetTimeZone()).toBe('Asia/Kolkata');
    expect(g.runDemoTests_(null).filter((r) => r.result !== 'PASS')).toEqual([]);
  });

  test('start dates written before the fix are read back as the intended day', () => {
    jest.useFakeTimers({ now: new Date('2026-10-30T18:20:00+05:30') });
    const fake = createFakeGoogle();
    const g = loadGas(fake.globals);
    g.setupSystem();
    // What a London-zone sheet stored for "Mon 26 Oct 00:00 IST": Sun 25 Oct 18:30.
    const tasks = fake.ss.getSheetByName('Task_Master');
    tasks.getRange(2, 7).setValue(new Date('2026-10-25T18:30:00+05:30'));
    expect(g.dateKey(g.loadContext_().tasks[0].startDate)).toBe('2026-10-26');
  });
});

describe('in-sheet demo suite (assignment tests 1–8)', () => {
  test('all eight tests pass and are logged', () => {
    const { g, fake } = boot();
    const results = g.runDemoTests_(null);
    const failures = results.filter((r) => r.result !== 'PASS');
    expect(failures).toEqual([]);
    expect(results).toHaveLength(8);
    expect(g.readTable_('Test_Log', g.TEST_COLS)).toHaveLength(8);
    expect(fake.outbox.some((m) => /\[Escalation\]/.test(m.subject))).toBe(true);
    expect(fake.outbox.every((m) => m.subject.startsWith('[DEMO]'))).toBe(true);
  });

  test('exiting demo mode restores the live data and clears the simulated clock', () => {
    const { g } = boot();
    setNow(g, '');
    g.runAutomation_();
    const live = JSON.stringify(g.readTable_('Task_Cycles', g.CYCLE_COLS).map((c) => c.cycleId));
    g.runDemoTests_([1]);
    expect(g.loadConfig_().simulatedNow).not.toBeNull();
    g.exitDemoMode_();
    expect(g.loadConfig_().simulatedNow).toBeNull();
    expect(JSON.stringify(g.readTable_('Task_Cycles', g.CYCLE_COLS).map((c) => c.cycleId))).toBe(live);
  });
});

describe('holiday sync from the Google public holiday calendar', () => {
  const event = (ymd, desc, name) => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${ymd}\r\nDESCRIPTION:${desc}\r\nSUMMARY:${name}\r\nEND:VEVENT`;
  const feed = (...events) => `BEGIN:VCALENDAR\r\n${events.join('\r\n')}\r\nEND:VCALENDAR`;

  function bootWithFeed(body) {
    jest.useFakeTimers({ now: new Date('2026-10-30T18:20:00+05:30') });
    const fake = createFakeGoogle();
    fake.ics.body = body;
    const g = loadGas(fake.globals);
    g.setupSystem();
    return { fake, g };
  }

  test('setup fetches the India calendar and fills Holidays with public holidays only', () => {
    const { fake, g } = bootWithFeed(feed(
      event('20261108', 'Public holiday', 'Diwali/Deepavali'),
      event('20261109', 'Observance', 'Govardhan Puja'),
      event('20261124', 'Public holiday', 'Guru Nanak Jayanti')
    ));
    expect(fake.fetched[0]).toContain('en.indian%23holiday%40group.v.calendar.google.com');
    const rows = g.readTable_('Holidays', g.HOLIDAY_COLS);
    expect(rows.map((h) => [g.dateKey(h.date), h.name, h.source])).toEqual([
      ['2026-11-08', 'Diwali/Deepavali', 'Google Calendar'],
      ['2026-11-24', 'Guru Nanak Jayanti', 'Google Calendar'],
    ]);
    expect(Object.keys(g.loadConfig_().holidays)).toEqual(['2026-11-08', '2026-11-24']);
  });

  test('re-sync keeps manual rows and unticked Observed; unticked holidays are working days', () => {
    const { fake, g } = bootWithFeed(feed(event('20261124', 'Public holiday', 'Guru Nanak Jayanti')));
    const sh = fake.ss.getSheetByName('Holidays');
    sh.getRange(2, 4).setValue(false); // company works on Guru Nanak Jayanti
    g.appendTable_('Holidays', g.HOLIDAY_COLS, [{ date: g.parseDateTime('2026-12-31'), name: 'Company offsite', source: '', observed: true }]);
    g.syncHolidaysCore_();
    g.syncHolidaysCore_();
    const rows = g.readTable_('Holidays', g.HOLIDAY_COLS);
    expect(rows.map((h) => [g.dateKey(h.date), h.source, h.observed])).toEqual([
      ['2026-11-24', 'Google Calendar', false],
      ['2026-12-31', 'Manual', true],
    ]);
    expect(Object.keys(g.loadConfig_().holidays)).toEqual(['2026-12-31']);
  });

  test('a failed download leaves the existing holidays untouched and reports the error', () => {
    const { fake, g } = bootWithFeed(feed(event('20261124', 'Public holiday', 'Guru Nanak Jayanti')));
    fake.ics.status = 404;
    expect(() => g.syncHolidaysCore_()).toThrow(/404/);
    expect(g.readTable_('Holidays', g.HOLIDAY_COLS)).toHaveLength(1);
  });

  test('blank HOLIDAY_CALENDAR_ID turns syncing off', () => {
    const { fake, g } = bootWithFeed(feed());
    g.setConfigValue_('HOLIDAY_CALENDAR_ID', '');
    const before = fake.fetched.length;
    expect(g.syncHolidaysCore_()).toBe(null);
    expect(fake.fetched).toHaveLength(before);
  });

  test('the demo suite still passes when a holiday falls in the coming weeks', () => {
    const { g } = bootWithFeed(feed(event('20261102', 'Public holiday', 'Test Monday'), event('20261104', 'Public holiday', 'Test Wednesday')));
    expect(g.runDemoTests_(null).filter((r) => r.result !== 'PASS')).toEqual([]);
  });
});

describe('admin-only menu items', () => {
  const ADMIN_ONLY = ['setupSystem', 'installTriggers', 'resetLiveData', 'syncHolidaysFromMenu'];

  test('a non-admin editor is refused every admin item and nothing changes', () => {
    const { g, fake } = boot();
    const before = JSON.stringify(g.readTable_('Task_Cycles', g.CYCLE_COLS));
    fake.user = 'reviewer@example.com';
    ADMIN_ONLY.forEach((fn) => expect(() => g[fn]()).toThrow(/Only the tool administrator/));
    expect(JSON.stringify(g.readTable_('Task_Cycles', g.CYCLE_COLS))).toBe(before);
  });

  test('a non-admin cannot run the demo or the automation from the menu either', () => {
    const { g, fake } = boot();
    fake.user = 'reviewer@example.com';
    ['runAutomationFromMenu', 'runAllDemoTests', 'runDemoTest1', 'exitDemoMode', 'applyAccessRulesFromMenu']
      .forEach((fn) => expect(() => g[fn]()).toThrow(/Only the tool administrator/));
  });

  test('someone listed in ADMIN_EMAILS can run admin items', () => {
    const { g, fake } = boot();
    g.setConfigValue_('ADMIN_EMAILS', 'Ops.Lead@example.com');
    fake.user = 'ops.lead@example.com';
    expect(() => g.setupSystem()).not.toThrow();
  });

  test('an unknown identity is refused (fails closed)', () => {
    const { g, fake } = boot();
    fake.user = '';
    expect(() => g.resetLiveData()).toThrow(/Only the tool administrator/);
  });
});

describe('trigger entry points cannot be called through the public web app', () => {
  // google.script.run on the public ack page can call any top-level function with any arguments.
  test.each(['runAutomation', 'syncHolidays'])('%s refuses calls without a genuine trigger id', (fn) => {
    const { g, fake } = boot();
    fake.uiAvailable = false;
    const fetchesBefore = fake.fetched.length;
    expect(() => g[fn]()).toThrow(/only runs from its trigger/);
    expect(() => g[fn]({ triggerUid: 'forged' })).toThrow(/only runs from its trigger/);
    expect(fake.fetched).toHaveLength(fetchesBefore);
    expect(() => g[fn]({ triggerUid: 'trig-1' })).not.toThrow();
  });

  test('handleEdit ignores a forged event', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    const tab = fake.ss.getSheetByName('My Tasks - Employee B');
    const cell = tab.getRange(g.EMP_VIEW.HEADER_ROW + 1, g.EMP_VIEW.INPUT_COL);
    cell.setValue('TCK-999');
    g.handleEdit({ range: cell, value: 'TCK-999', triggerUid: 'forged' });
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).every((c) => !c.completedAt)).toBe(true);
    g.handleEdit({ range: cell, value: 'TCK-999', triggerUid: 'trig-1' });
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).some((c) => c.proof === 'TCK-999')).toBe(true);
  });
});

describe('access rules (real protections on every tab)', () => {
  function bootTeam() {
    const r = boot();
    const { g } = r;
    g.writeTable_('Employees', g.EMPLOYEE_COLS, ['A', 'B', 'C', 'D'].map((x) => ({
      employeeId: 'E-' + x, name: 'Employee ' + x, email: 'emp.' + x.toLowerCase() + '@example.com', tabName: 'My Tasks - Employee ' + x,
    })));
    g.setConfigValue_('MANAGER_EMAIL', 'manager@example.com');
    g.setConfigValue_('ADMIN_EMAILS', 'reviewer@example.com');
    r.result = g.applyAccessRules_();
    return r;
  }

  test('employees can edit only their own tab; the manager only the dashboard; the rest is admin-only', () => {
    const { fake, result } = bootTeam();
    const admins = ['owner@example.com', 'reviewer@example.com'];
    const ed = (n) => fake.ss.getSheetByName(n).editorsOf();
    expect(ed('My Tasks - Employee A')).toEqual([...admins, 'emp.a@example.com'].sort());
    expect(ed('My Tasks - Employee B')).toEqual([...admins, 'emp.b@example.com'].sort());
    expect(ed('Manager Dashboard')).toEqual([...admins, 'manager@example.com'].sort());
    expect(ed('Task_Master')).toEqual([...admins, 'manager@example.com'].sort());
    ['Employees', 'Config', 'Holidays', 'Task_Cycles', 'Alert_Log', 'Test_Log', 'How It Works']
      .forEach((n) => expect(ed(n)).toEqual(admins));
    expect(result.problems).toEqual([]);
  });

  test('every tab has exactly one protection, and none is warning-only or has open ranges', () => {
    const { fake } = bootTeam();
    fake.ss.getSheets().filter((sh) => !sh.getName().startsWith('_')).forEach((sh) => {
      expect([sh.getName(), sh.getProtections().length]).toEqual([sh.getName(), 1]);
      expect(sh.getProtections()[0].warningOnly).toBeFalsy();
      expect(sh.getProtections()[0].unprotected).toBeUndefined();
    });
  });

  test('re-applying is idempotent', () => {
    const { g, fake } = bootTeam();
    g.applyAccessRules_();
    expect(fake.ss.getSheetByName('My Tasks - Employee A').getProtections()).toHaveLength(1);
  });

  test('an invalid employee email is reported, not fatal', () => {
    const { g } = bootTeam();
    g.writeTable_('Employees', g.EMPLOYEE_COLS, [{ employeeId: 'E-A', name: 'Employee A', email: 'not-an-email', tabName: 'My Tasks - Employee A' }]);
    const r = g.applyAccessRules_();
    expect(r.problems.join(' ')).toMatch(/not-an-email/);
  });

  test('editing the Employees tab re-applies the rules automatically', () => {
    const { g, fake } = bootTeam();
    const sh = fake.ss.getSheetByName('Employees');
    sh.getRange(2, 3).setValue('new.a@example.com');
    g.handleEdit_({ range: sh.getRange(2, 3), value: 'new.a@example.com' });
    expect(fake.ss.getSheetByName('My Tasks - Employee A').editorsOf()).toContain('new.a@example.com');
    expect(fake.ss.getSheetByName('My Tasks - Employee A').editorsOf()).not.toContain('emp.a@example.com');
  });

  test('an edit outside the input column on an employee tab is undone by a redraw', () => {
    const { g, fake } = bootTeam();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    const tab = fake.ss.getSheetByName('My Tasks - Employee B');
    const cell = tab.getRange(g.EMP_VIEW.HEADER_ROW + 1, 2);
    const original = cell.getValue();
    cell.setValue('scribble');
    g.handleEdit_({ range: cell, value: 'scribble' });
    expect(tab.getRange(g.EMP_VIEW.HEADER_ROW + 1, 2).getValue()).toBe(original);
  });
});

describe('Who am I?', () => {
  test('anyone can run it; it reports the running account and its role', () => {
    const { g, fake } = boot();
    const shown = [];
    fake.ui.alert = (title, msg) => { shown.push(`${title}\n${msg}`); return 'OK'; };
    fake.user = 'stranger@example.com';
    g.showMyAccess();
    expect(shown[0]).toMatch(/stranger@example\.com/);
    expect(shown[0]).toMatch(/no edit rights/i);
    fake.user = 'owner@example.com';
    g.showMyAccess();
    expect(shown[1]).toMatch(/Owner \(admin\)/);
  });
});

describe('a manager adds a task in Task_Master', () => {
  function addRow(g, fake, values) {
    const sh = fake.ss.getSheetByName('Task_Master');
    const row = sh.getLastRow() + 1;
    values.forEach(([col, v]) => sh.getRange(row, col).setValue(v));
    g.handleEdit_({ range: sh.getRange(row, values[values.length - 1][0]), value: values[values.length - 1][1] });
    return row;
  }

  test('the row is completed, a cycle opens and it shows on the employee tab immediately', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Vendor reconciliation'], [3, 'Employee B'], [4, 7]]);
    const t = g.readTable_('Task_Master', g.TASK_COLS).find((x) => x.taskName === 'Vendor reconciliation');
    expect(t).toMatchObject({ taskId: 'T-005', employeeId: 'E-B', proofType: 'TICKET', active: true });
    expect(fake.ss.getSheetByName('Task_Master').getRange(row, 9).getValue()).toMatch(/^✅ Live/);
    const cycle = g.readTable_('Task_Cycles', g.CYCLE_COLS).find((c) => c.taskId === 'T-005');
    expect(cycle.status).toBe('Pending');
    expect(g.findRowByValue_(fake.ss.getSheetByName('My Tasks - Employee B'), 1, cycle.cycleId)).toBeGreaterThan(g.EMP_VIEW.HEADER_ROW);
  });

  test('a row with a problem is kept, explained, and creates no cycle', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Ghost task'], [3, 'Employee Z'], [4, 7]]);
    expect(fake.ss.getSheetByName('Task_Master').getRange(row, 2).getValue()).toBe('Ghost task');
    expect(fake.ss.getSheetByName('Task_Master').getRange(row, 9).getValue()).toMatch(/Unknown employee/);
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).some((c) => c.taskName === 'Ghost task')).toBe(false);
  });

  test('the hourly run ignores a broken row instead of failing', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    addRow(g, fake, [[2, 'Ghost task'], [3, 'Employee Z'], [4, 7]]);
    expect(() => g.runAutomation_()).not.toThrow();
  });
});

describe('scheduling a task for later', () => {
  function addRow(g, fake, values) {
    const sh = fake.ss.getSheetByName('Task_Master');
    const row = sh.getLastRow() + 1;
    values.forEach(([col, v]) => sh.getRange(row, col).setValue(v));
    g.handleEdit_({ range: sh.getRange(row, values[values.length - 1][0]) });
    return row;
  }
  const cyclesOf = (g, id) => g.readTable_('Task_Cycles', g.CYCLE_COLS).filter((c) => c.taskId === id);

  test('a future start date creates nothing on the employee tab until that day', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Quarterly audit prep'], [3, 'E-A'], [4, 7], [7, g.parseDateTime('2026-11-09')]]);
    expect(fake.ss.getSheetByName('Task_Master').getRange(row, 9).getValue()).toMatch(/^🗓 Scheduled: starts Mon 09 Nov 2026/);
    expect(cyclesOf(g, 'T-005')).toHaveLength(0);
    setNow(g, '2026-11-09 08:00');
    g.runAutomation_();
    expect(cyclesOf(g, 'T-005').map((c) => c.cycleId)).toEqual(['T-005-20261109']);
  });

  test('typing the employee before the future date: the early cycle is withdrawn', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Quarterly audit prep'], [3, 'E-A'], [4, 7]]);
    expect(cyclesOf(g, 'T-005')).toHaveLength(1); // went live today
    const sh = fake.ss.getSheetByName('Task_Master');
    sh.getRange(row, 7).setValue(g.parseDateTime('2026-11-09'));
    g.handleEdit_({ range: sh.getRange(row, 7) });
    expect(cyclesOf(g, 'T-005')).toHaveLength(0);
    expect(g.findRowByValue_(fake.ss.getSheetByName('My Tasks - Employee A'), 2, 'Quarterly audit prep')).toBe(0);
  });

  test('a cycle someone already acted on is never withdrawn', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Quarterly audit prep'], [3, 'E-A'], [4, 7]]);
    const id = cyclesOf(g, 'T-005')[0].cycleId;
    const tab = fake.ss.getSheetByName('My Tasks - Employee A');
    const cell = tab.getRange(g.findRowByValue_(tab, 1, id), g.EMP_VIEW.INPUT_COL);
    cell.setValue('TCK-1');
    g.handleEdit_({ range: cell });
    const sh = fake.ss.getSheetByName('Task_Master');
    sh.getRange(row, 7).setValue(g.parseDateTime('2026-11-09'));
    g.handleEdit_({ range: sh.getRange(row, 7) });
    expect(cyclesOf(g, 'T-005').find((c) => c.cycleId === id).proof).toBe('TCK-1');
  });

  test('completing a task updates its Task_Master status at once', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    g.runAutomation_();
    const c = cyclesOf(g, 'T-002')[0];
    const tab = fake.ss.getSheetByName('My Tasks - Employee B');
    const cell = tab.getRange(g.findRowByValue_(tab, 1, c.cycleId), g.EMP_VIEW.INPUT_COL);
    cell.setValue('TCK-7001');
    g.handleEdit_({ range: cell });
    const status = fake.ss.getSheetByName('Task_Master').getRange(g.findRowByValue_(fake.ss.getSheetByName('Task_Master'), 1, 'T-002'), 9).getValue();
    expect(status).toMatch(/Last done Wed 04 Nov 2026 by Employee B \(TCK-7001\), on time$/);
  });
});

describe('reassigning a task in Task_Master (regression)', () => {
  // Reported: a task moved from Employee A to Employee D stayed on A's tab and never reached D's.
  function addRow(g, fake, values) {
    const sh = fake.ss.getSheetByName('Task_Master');
    const row = sh.getLastRow() + 1;
    values.forEach(([col, v]) => sh.getRange(row, col).setValue(v));
    g.handleEdit_({ range: sh.getRange(row, values[values.length - 1][0]) });
    return row;
  }
  const tabHas = (fake, emp, id) => {
    const sh = fake.ss.getSheetByName('My Tasks - ' + emp);
    const vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues().map((r) => r[0]);
    return vals.includes(id);
  };

  test('the open cycle moves to the new employee; completed history stays put', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Vendor reconciliation'], [3, 'Employee A'], [4, 1]]);
    const today = g.readTable_('Task_Cycles', g.CYCLE_COLS).find((c) => c.taskId === 'T-005');
    // Employee A completes today's cycle, which opens tomorrow's.
    const tabA = fake.ss.getSheetByName('My Tasks - Employee A');
    const cell = tabA.getRange(g.findRowByValue_(tabA, 1, today.cycleId), g.EMP_VIEW.INPUT_COL);
    cell.setValue('VR-1');
    g.handleEdit_({ range: cell });
    // Next day: the morning run opens tomorrow's cycle for Employee A.
    setNow(g, '2026-11-05 08:00');
    g.runAutomation_();

    const sh = fake.ss.getSheetByName('Task_Master');
    sh.getRange(row, 3).setValue('Employee D');
    g.handleEdit_({ range: sh.getRange(row, 3) });

    const cycles = g.readTable_('Task_Cycles', g.CYCLE_COLS).filter((c) => c.taskId === 'T-005');
    const open = cycles.find((c) => !c.completedAt);
    const done = cycles.find((c) => c.completedAt);
    expect([open.employeeId, open.employeeName]).toEqual(['E-D', 'Employee D']);
    expect([done.employeeId, done.employeeName]).toEqual(['E-A', 'Employee A']);
    expect(tabHas(fake, 'Employee D', open.cycleId)).toBe(true);
    expect(tabHas(fake, 'Employee A', open.cycleId)).toBe(false);
  });

  test('renaming a task updates its open cycles too', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 15:00');
    const row = addRow(g, fake, [[2, 'Vendor recon'], [3, 'Employee A'], [4, 7]]);
    const sh = fake.ss.getSheetByName('Task_Master');
    sh.getRange(row, 2).setValue('Vendor reconciliation');
    g.handleEdit_({ range: sh.getRange(row, 2) });
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).find((c) => c.taskId === 'T-005').taskName).toBe('Vendor reconciliation');
  });
});

describe('pausing a task cancels its open cycle', () => {
  const taskRow = (g, fake, id) => g.findRowByValue_(fake.ss.getSheetByName('Task_Master'), 1, id);
  const setActive = (g, fake, id, v) => {
    const sh = fake.ss.getSheetByName('Task_Master');
    const r = sh.getRange(taskRow(g, fake, id), 8);
    r.setValue(v);
    g.handleEdit_({ range: r });
  };
  const cycle = (g, id) => g.readTable_('Task_Cycles', g.CYCLE_COLS).find((c) => c.cycleId === id);
  const onTab = (g, fake, emp, id) => g.findRowByValue_(fake.ss.getSheetByName('My Tasks - ' + emp), 1, id) > g.EMP_VIEW.HEADER_ROW;

  test('the open cycle is cancelled, disappears, never alerts, and stays on record', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-03 18:40');
    g.runAutomation_(); // T-001's daily cycle is overdue and the manager has been alerted
    const id = 'T-001-20261103';
    expect(cycle(g, id).managerAlertedAt).not.toBe('');
    setActive(g, fake, 'T-001', false);
    expect(cycle(g, id)).toMatchObject({ status: 'Cancelled', resolution: 'Cancelled: task paused' });
    expect(onTab(g, fake, 'Employee A', id)).toBe(false);
    expect(g.findRowByValue_(fake.ss.getSheetByName('Manager Dashboard'), 1, id)).toBe(0);
    const sent = fake.outbox.length;
    setNow(g, '2026-11-04 12:30'); // past the ack deadline: would have escalated
    g.runAutomation_();
    expect(fake.outbox.length).toBe(sent);
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).filter((c) => c.taskId === 'T-001' && c.status !== 'Cancelled')).toEqual([]);
  });

  test('a cancelled cycle cannot be completed', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    setActive(g, fake, 'T-002', false);
    const ctx = g.loadContext_();
    const res = g.completeCycleCore_(ctx, 'T-002-20261102', 'TCK-1', 'x', 'E-B');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/paused/);
  });

  test('resuming in the same period reopens the cycle', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    setActive(g, fake, 'T-002', false);
    setActive(g, fake, 'T-002', true);
    expect(cycle(g, 'T-002-20261102')).toMatchObject({ status: 'Pending', cancelledAt: '', resolution: '' });
    expect(onTab(g, fake, 'Employee B', 'T-002-20261102')).toBe(true);
  });

  test('resuming in a later period starts that period afresh', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-03 10:00');
    g.runAutomation_();
    setActive(g, fake, 'T-002', false);
    setNow(g, '2026-11-10 09:00');
    setActive(g, fake, 'T-002', true);
    expect(cycle(g, 'T-002-20261102').status).toBe('Cancelled');
    expect(cycle(g, 'T-002-20261109').status).toBe('Pending');
  });
});

describe('employee tab after completing a task', () => {
  test('no future cycle is created; the next one appears when its period starts', () => {
    const { g, fake } = boot();
    setNow(g, '2026-11-04 10:00');
    g.runAutomation_();
    const tab = fake.ss.getSheetByName('My Tasks - Employee B');
    const cell = tab.getRange(g.findRowByValue_(tab, 1, 'T-002-20261102'), g.EMP_VIEW.INPUT_COL);
    cell.setValue('TCK-1');
    g.handleEdit_({ range: cell });
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).find((c) => c.cycleId === 'T-002-20261109')).toBeUndefined();
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).every((c) => c.status !== 'Upcoming')).toBe(true);
    setNow(g, '2026-11-09 08:00');
    g.runAutomation_();
    expect(g.findRowByValue_(tab, 1, 'T-002-20261109')).toBeGreaterThan(g.EMP_VIEW.HEADER_ROW);
  });
});

describe('future cycles left over from before (cleanup)', () => {
  test('an untouched cycle whose period has not started is removed on the next run', () => {
    const { g } = boot();
    setNow(g, '2026-11-04 10:00');
    g.runAutomation_();
    const ctx = g.loadContext_();
    const task = ctx.tasks.find((t) => t.taskId === 'T-002');
    const future = g.newCycleRecord_(ctx, task, g.cycleForDate(task, g.parseDateTime('2026-11-09'), ctx.settings));
    g.writeTable_('Task_Cycles', g.CYCLE_COLS, ctx.cycles.concat([future]));
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).some((c) => c.status === 'Upcoming')).toBe(true);
    g.runAutomation_();
    expect(g.readTable_('Task_Cycles', g.CYCLE_COLS).some((c) => c.cycleId === 'T-002-20261109')).toBe(false);
  });
});

describe('tabs wider than 26 columns (regression)', () => {
  // Task_Cycles gained a 27th column ("Cancelled At"); a new tab has only A-Z, so every read and write threw.
  test('Task_Cycles grows to fit its columns and automation keeps working', () => {
    const { g, fake } = boot();
    expect(g.CYCLE_COLS.length).toBeGreaterThan(26);
    setNow(g, '2026-11-04 10:00');
    expect(() => g.runAutomation_()).not.toThrow();
    expect(fake.ss.getSheetByName('Task_Cycles').getMaxColumns()).toBeGreaterThanOrEqual(g.CYCLE_COLS.length);
  });
});
