/**
 * Thin data-access layer: sheets as tables of objects, plus locking.
 */

function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Spreadsheet not found. Open the sheet and run Ops Automation → Setup / repair.');
  return SpreadsheetApp.openById(id);
}

/**
 * Sheets writes dates in the spreadsheet's time zone but Apps Script reads them in the script's,
 * so any mismatch shifts every stored date by hours. Keep the two aligned.
 */
function syncTimeZone_() {
  var ss = getSpreadsheet_();
  var tz = Session.getScriptTimeZone();
  if (ss.getSpreadsheetTimeZone() === tz) return false;
  ss.setSpreadsheetTimeZone(tz);
  return true;
}

function getSheet_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run Ops Automation → Setup / repair.');
  return sh;
}

function ensureSheet_(name) {
  var ss = getSpreadsheet_();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readTable_(name, cols) {
  var sh = getSheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues()
    .filter(function (r) { return r[0] !== '' && r[0] !== null; })
    .map(function (r) {
      var o = {};
      cols.forEach(function (c, i) { o[c[0]] = r[i]; });
      return o;
    });
}

/** Sheets would evaluate text starting with = + - @ as a formula; force it to stay text. */
function cellValue_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function toRows_(cols, objs) {
  return objs.map(function (o) { return cols.map(function (c) { return cellValue_(o[c[0]]); }); });
}

/** Replaces all data rows (row 2+) of a table. */
function writeTable_(name, cols, objs) {
  var sh = getSheet_(name);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols.length).clearContent();
  if (objs.length) sh.getRange(2, 1, objs.length, cols.length).setValues(toRows_(cols, objs));
}

function appendTable_(name, cols, objs) {
  if (!objs.length) return;
  var sh = getSheet_(name);
  sh.getRange(Math.max(sh.getLastRow(), 1) + 1, 1, objs.length, cols.length).setValues(toRows_(cols, objs));
}

function writeHeader_(sh, cols) {
  sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c[1]; })])
    .setFontWeight('bold').setBackground(COLORS.header).setFontColor(COLORS.headerText);
  sh.setFrozenRows(1);
}

/** 1-based row whose `col` cell equals `value`, or 0. */
function findRowByValue_(sh, col, value) {
  var last = sh.getLastRow();
  if (last < 1) return 0;
  var vals = sh.getRange(1, col, last, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 1;
  return 0;
}

var LOCK_DEPTH_ = 0;

/** Serialises all writes (edits, triggers, web app) so concurrent runs cannot double-send or double-create. */
function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    lock.releaseLock();
  }
}

/** Menu-only actions must not be reachable from the public web app (which has no UI). */
function requireUi_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (e) {
    throw new Error('This action can only be run from the spreadsheet menu.');
  }
}

/**
 * True only for a real installed trigger of this project. Every top-level function is callable
 * through google.script.run on the public acknowledgement page, with any arguments; a forged call
 * cannot know a trigger's unique id.
 */
function isGenuineTrigger_(e) {
  var uid = e && e.triggerUid;
  if (!uid) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === String(uid); });
}

function requireTrigger_(e, name) {
  if (!isGenuineTrigger_(e)) throw new Error(name + ' only runs from its trigger. Use the ⚙ Ops Automation menu instead.');
}

/** Admin-only menu items: visible to everyone, but they only run for the owner or ADMIN_EMAILS. */
function requireAdmin_() {
  var ui = requireUi_();
  var me = '';
  var owner = '';
  var admins = '';
  try {
    me = Session.getEffectiveUser().getEmail();
  } catch (e) {
    // Unknown identity: treated as not an admin.
  }
  try {
    owner = getSpreadsheet_().getOwner().getEmail();
  } catch (e) {
    // Owner not visible (e.g. shared drive): rely on ADMIN_EMAILS.
  }
  try {
    admins = loadConfig_().adminEmails;
  } catch (e) {
    // Config not created yet (first setup): owner only.
  }
  if (!isAdminEmail(me, owner, admins)) {
    throw new Error('Only the tool administrator can run this' + (owner ? ' (' + owner + ')' : '') +
      '. Everyone can use Demo tests and "Run automation now".');
  }
  return ui;
}

function toast_(msg) {
  try {
    getSpreadsheet_().toast(msg, 'Ops Automation', 8);
  } catch (e) {
    // No UI context (time trigger / web app): nothing to show.
  }
}
