/**
 * Email builders (pure: they return subject/text/html and send nothing).
 */

function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlTable_(headers, rows) {
  var th = 'style="background:#1f3a5f;color:#fff;padding:6px 8px;text-align:left;font-size:13px"';
  var td = 'style="border-bottom:1px solid #ddd;padding:6px 8px;font-size:13px;vertical-align:top"';
  return '<table style="border-collapse:collapse;font-family:Arial,sans-serif">' +
    '<tr>' + headers.map(function (h) { return '<th ' + th + '>' + esc_(h) + '</th>'; }).join('') + '</tr>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td ' + td + '>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
    '</table>';
}

function demoPrefix_(s) {
  return s.simulatedNow ? '[DEMO] ' : '';
}

function fmtShortDate_(d) {
  return DAY_NAMES[d.getDay()] + ' ' + pad2(d.getDate()) + ' ' + MONTH_NAMES[d.getMonth()];
}

function fmtShortDateTime_(d) {
  return DAY_NAMES[d.getDay()] + ' ' + pad2(d.getDate()) + ' ' + MONTH_NAMES[d.getMonth()] + ', ' + fmtTime(d);
}

/**
 * "[Ops Alert] Employee A: Daily Operations Update not completed (due Mon 02 Nov, 18:00)", or for several items
 * "[Ops Alert] 3 tasks not completed: Employee A (Task, due Mon 02 Nov), Employee B (Task, due Sat 07 Nov) +1 more". Distinct subjects
 * also stop Gmail from threading unrelated alerts together.
 */
function subjectFor_(tag, verb, cycles, s) {
  if (cycles.length === 1) {
    var c = cycles[0];
    return demoPrefix_(s) + tag + ' ' + c.employeeName + ': ' + c.taskName + ' ' + verb + ' (due ' + fmtShortDateTime_(c.dueAt) + ')';
  }
  var sorted = cycles.slice().sort(function (a, b) { return a.dueAt - b.dueAt; });
  var shown = sorted.slice(0, 2).map(function (x) { return x.employeeName + ' (' + x.taskName + ', due ' + fmtShortDate_(x.dueAt) + ')'; }).join(', ');
  return demoPrefix_(s) + tag + ' ' + cycles.length + ' tasks ' + verb + ': ' + shown + (cycles.length > 2 ? ' +' + (cycles.length - 2) + ' more' : '');
}

/** Same-day alert to the manager: one email per run listing every newly overdue item. */
function buildManagerAlertEmail(cycles, s, now, ackBaseUrl) {
  var subject = subjectFor_('[Ops Alert]', 'not completed', cycles, s);
  var rows = cycles.map(function (c) {
    var d = slaDeadlines(c, s);
    var link = ackBaseUrl
      ? '<a href="' + esc_(ackBaseUrl + '?a=ack&t=' + encodeURIComponent(c.ackToken)) + '">Acknowledge</a>'
      : 'Tick Ack ✔ in the Manager Dashboard';
    return [esc_(c.employeeName), esc_(c.taskName), esc_(fmtDateTime(c.dueAt)), esc_(c.proofInstructions),
      esc_(fmtDateTime(d.ackDeadline)), esc_(fmtDateTime(d.resolveDeadline)), link];
  });
  var first = slaDeadlines(cycles[0], s);
  var steps = [
    'Check with the employee and get the task completed. They only need to enter the Ticket ID or update on their My Tasks tab.',
    'Acknowledge each item by clicking <b>Acknowledge</b> (or ticking Ack ✔ in the Manager Dashboard) and choose the action you took, by the "Acknowledge by" time.',
    'If an item is not acknowledged in time, or not completed by the "Complete by" time, it is escalated to leadership automatically. ' +
      'Choose "Blocked: needs leadership help" to escalate immediately.'
  ];
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
    '<p>Hi ' + esc_(s.managerName) + ',</p>' +
    '<p>The following recurring task(s) were <b>not completed by the due time</b>:</p>' +
    htmlTable_(['Employee', 'Task', 'Was due', 'Proof required', 'Acknowledge by', 'Complete by', 'Action'], rows) +
    '<p><b>What you need to do</b></p><ol>' + steps.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>' +
    '<p style="color:#6c757d;font-size:12px">You get one email per item, never repeats. Sent by Allo Ops Automation at ' + esc_(fmtDateTime(now)) + '.</p></div>';
  var text = 'The following recurring tasks were not completed by the due time:\n\n' +
    cycles.map(function (c) {
      return '- ' + c.employeeName + ': ' + c.taskName + ' (due ' + fmtDateTime(c.dueAt) + ')' +
        (ackBaseUrl ? '\n  Acknowledge: ' + ackBaseUrl + '?a=ack&t=' + encodeURIComponent(c.ackToken) : '');
    }).join('\n') +
    '\n\nAcknowledge by ' + fmtDateTime(first.ackDeadline) + ' and get the task completed by ' + fmtDateTime(first.resolveDeadline) +
    ', otherwise it is escalated to leadership.';
  return { subject: subject, html: html, text: text };
}

/** Leadership escalation: items unacknowledged by the manager or still unresolved after the SLA. */
function buildEscalationEmail(items, s, now) {
  var subject = subjectFor_('[Escalation]', 'unresolved', items.map(function (x) { return x.cycle; }), s);
  var rows = items.map(function (x) {
    var c = x.cycle;
    var ack = c.managerAckAt ? 'Yes, ' + fmtDateTime(c.managerAckAt) + ': ' + (c.managerAction || '') + (c.managerNote ? ' (' + c.managerNote + ')' : '') : 'No';
    return [esc_(c.employeeName), esc_(c.taskName), esc_(fmtDateTime(c.dueAt)), esc_(fmtDateTime(c.managerAlertedAt)), esc_(ack), esc_(x.reason)];
  });
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
    '<p>Leadership team,</p>' +
    '<p>The following recurring task(s) breached the escalation SLA:</p>' +
    htmlTable_(['Employee', 'Task', 'Was due', 'Manager alerted', 'Manager acknowledged', 'Reason'], rows) +
    '<p><b>Suggested action:</b> speak to ' + esc_(s.managerName) + ' today to unblock or reassign. ' +
    'Each item is escalated once; its live status stays on the Manager Dashboard until it is completed.</p>' +
    '<p style="color:#6c757d;font-size:12px">Sent by Allo Ops Automation at ' + esc_(fmtDateTime(now)) + '.</p></div>';
  var text = 'Escalated recurring tasks:\n\n' + items.map(function (x) {
    return '- ' + x.cycle.employeeName + ': ' + x.cycle.taskName + ' (due ' + fmtDateTime(x.cycle.dueAt) + '): ' + x.reason;
  }).join('\n');
  return { subject: subject, html: html, text: text };
}
