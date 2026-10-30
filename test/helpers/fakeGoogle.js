/**
 * Minimal in-memory fakes of the Google Apps Script services the project uses.
 * Data methods are real; formatting/protection calls are accepted as chainable no-ops.
 */

const noop = new Proxy(function () {}, {
  get: (t, p) => (p === 'then' ? undefined : () => noop),
  apply: () => noop,
});

/** Wraps an object so unknown methods become chainable no-ops. */
function withNoops(obj) {
  const proxy = new Proxy(obj, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'then' || typeof p === 'symbol') return undefined;
      return () => proxy;
    },
  });
  obj.self = proxy;
  return proxy;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getSheet() { return this.sheet.self; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) row.push(this.sheet.get(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`setValues dimension mismatch: got ${values.length}x${values[0] && values[0].length}, range is ${this.numRows}x${this.numCols}`);
    }
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this.self;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this.self; }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.set(this.row + r, this.col + c, '');
    return this.self;
  }
  clear() { return this.clearContent(); }
  setNote(n) { this.sheet.notes[`${this.row}:${this.col}`] = n; return this.self; }
  getNote() { return this.sheet.notes[`${this.row}:${this.col}`] || ''; }
}

// Script time zone is Asia/Kolkata (+330 min). Real Sheets writes a Date as wall-clock time in the
// SPREADSHEET time zone but reads it back in the SCRIPT time zone, so a mismatch shifts every date.
const TZ_OFFSETS = { 'Asia/Kolkata': 330, 'Europe/London': 0, 'America/New_York': -300 };
const SCRIPT_TZ_OFFSET = 330;

class FakeSheet {
  constructor(name, ss) { this.name = name; this.ss = ss; this.cells = []; this.notes = {}; }
  getName() { return this.name; }
  get(r, c) { const row = this.cells[r - 1]; const v = row ? row[c - 1] : undefined; return v === undefined ? '' : v; }
  set(r, c, v) {
    while (this.cells.length < r) this.cells.push([]);
    // Like Sheets: a leading apostrophe forces text and is not part of the stored value.
    if (v instanceof Date) v = new Date(v.getTime() + (TZ_OFFSETS[this.ss.timeZone] - SCRIPT_TZ_OFFSET) * 60000);
    this.cells[r - 1][c - 1] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
  }
  getLastRow() {
    let last = 0;
    this.cells.forEach((row, i) => { if (row.some((v) => v !== '' && v !== undefined && v !== null)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.cells.forEach((row) => row.forEach((v, j) => { if (v !== '' && v !== undefined) last = Math.max(last, j + 1); }));
    return last;
  }
  getMaxRows() { return Math.max(200, this.cells.length); }
  getMaxColumns() { return 26; }
  getRange(row, col, numRows = 1, numCols = 1) { return withNoops(new FakeRange(this, row, col, numRows, numCols)); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  clear() { this.cells = []; this.notes = {}; return this.self; }
  clearContents() { this.cells = []; return this.self; }
  /** Test helper: the sheet as a 2D array of values. */
  dump() { return this.getDataRange().getValues(); }
}

class FakeSpreadsheet {
  constructor(timeZone) { this.sheets = []; this.toasts = []; this.timeZone = timeZone; }
  getSpreadsheetTimeZone() { return this.timeZone; }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
  getSheetByName(name) { return this.sheets.find((s) => s.getName() === name) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`Sheet ${name} already exists`);
    const sh = withNoops(new FakeSheet(name, this));
    this.sheets.push(sh);
    return sh;
  }
  deleteSheet(sh) { this.sheets = this.sheets.filter((s) => s !== sh); }
  toast(msg) { this.toasts.push(String(msg)); }
  getId() { return 'fake-spreadsheet-id'; }
  getOwner() { return { getEmail: () => this.owner }; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake'; }
}

function createFakeGoogle({ uiAvailable = true, spreadsheetTimeZone = 'Asia/Kolkata' } = {}) {
  const ss = withNoops(new FakeSpreadsheet(spreadsheetTimeZone));
  ss.owner = 'owner@example.com';
  const outbox = [];
  let uuid = 0;
  const properties = {};
  const ui = withNoops({ alert: () => 'OK', Button: { YES: 'YES', OK: 'OK' }, ButtonSet: { YES_NO: 'YES_NO' } });

  const globals = {
    SpreadsheetApp: withNoops({
      getActiveSpreadsheet: () => ss,
      getActive: () => ss,
      openById: () => ss,
      getUi: () => { if (!fake.uiAvailable) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); return ui; },
      newDataValidation: () => noop,
      flush: () => {},
    }),
    UrlFetchApp: {
      fetch: (url) => {
        fake.fetched.push(url);
        return { getResponseCode: () => fake.ics.status, getContentText: () => fake.ics.body };
      },
    },
    MailApp: { sendEmail: (msg) => outbox.push(msg), getRemainingDailyQuota: () => 100 },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities: { getUuid: () => `uuid-${++uuid}`, sleep() {} },
    Session: {
      getActiveUser: () => ({ getEmail: () => 'owner@example.com' }),
      getEffectiveUser: () => ({ getEmail: () => fake.user }),
      getScriptTimeZone: () => 'Asia/Kolkata',
    },
    ScriptApp: withNoops({
      getService: () => ({ getUrl: () => 'https://script.example/exec' }),
      getProjectTriggers: () => fake.triggers,
      newTrigger: () => noop,
      deleteTrigger() {},
    }),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in properties ? properties[k] : null),
        setProperty: (k, v) => { properties[k] = String(v); },
        deleteProperty: (k) => { delete properties[k]; },
      }),
    },
    HtmlService: {
      createHtmlOutput: (html) => withNoops({ getContent: () => html }),
    },
  };

  const fake = { ss, outbox, ui, globals, uiAvailable, user: 'owner@example.com', fetched: [],
    triggers: [{ getUniqueId: () => 'trig-1', getHandlerFunction: () => 'runAutomation' }], ics: { status: 200, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' } };
  return fake;
}

module.exports = { createFakeGoogle };
