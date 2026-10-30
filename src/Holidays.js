/**
 * Keeps the Holidays sheet in step with a Google public holiday calendar (default: India).
 * Calendar rows are refreshed; manual rows and "Observed" choices are preserved.
 */

/** Weekly time trigger. */
function syncHolidays(e) {
  requireTrigger_(e, 'syncHolidays');
  return syncHolidays_();
}

function syncHolidays_() {
  return withLock_(function () {
    var n = syncHolidaysCore_();
    if (n !== null) runAutomation_();
    return n;
  });
}

function syncHolidaysFromMenu() {
  requireAdmin_();
  var n = syncHolidays_();
  toast_(n === null ? 'Holiday sync is off (Config → HOLIDAY_CALENDAR_ID is blank).' : 'Holidays synced: ' + n + ' public holidays from Google Calendar.');
}

/** Returns the number of calendar holidays written, or null when syncing is switched off. */
function syncHolidaysCore_() {
  var id = loadConfig_().holidayCalendarId;
  if (!id) return null;
  var url = 'https://calendar.google.com/calendar/ical/' + encodeURIComponent(id) + '/public/basic.ics';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Holiday calendar download failed (HTTP ' + res.getResponseCode() + ') for ' + id + '. Holidays left unchanged.');
  }
  var today = startOfDay(new Date());
  var fetched = parseIcsHolidays(res.getContentText(), new Date(today.getFullYear(), 0, 1), addDays(today, 400));
  writeTable_(SHEETS.HOLIDAYS, HOLIDAY_COLS, mergeHolidays(readTable_(SHEETS.HOLIDAYS, HOLIDAY_COLS), fetched));
  return fetched.length;
}
