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
  test('entering a ticket on My Tasks completes the cycle and prepares the next one', () => {
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
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ status: 'Completed', proof: 'TCK-555' });
    expect(cycles[0].completedBy).toMatch(/Employee B/);
    expect(cycles[1].status).toBe('Upcoming');
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

  test('a non-admin can still run the demo tests and the automation', () => {
    const { g, fake } = boot();
    fake.user = 'reviewer@example.com';
    expect(() => g.runAutomationFromMenu()).not.toThrow();
    expect(g.runDemoTests_([7])[0].result).toBe('PASS');
    expect(() => g.exitDemoMode()).not.toThrow();
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
