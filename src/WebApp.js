/**
 * Web app behind the "Acknowledge" link in manager emails.
 * Deployed as: execute as the owner, accessible to anyone with the link. The random
 * per-item token is the only credential; menu/admin functions refuse to run here
 * (see requireUi_), so the public URL can do nothing except acknowledge.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.a === 'ack' && p.t) return ackPage_(String(p.t));
  return page_('Allo Ops Automation', '<p>This link is used to acknowledge recurring-task alerts.</p>');
}

function page_(title, bodyHtml) {
  var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc_(title) + '</title>' +
    '<style>body{font-family:Arial,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#222}' +
    'table{border-collapse:collapse;width:100%}td{padding:6px;border-bottom:1px solid #eee;vertical-align:top}' +
    'td:first-child{color:#6c757d;width:40%}select,textarea,button{font-size:15px;width:100%;margin:6px 0;padding:8px;box-sizing:border-box}' +
    'button{background:#1f3a5f;color:#fff;border:0;border-radius:4px;cursor:pointer}.ok{color:#155724}.err{color:#721c24}</style></head>' +
    '<body><h2>' + esc_(title) + '</h2>' + bodyHtml + '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function findByToken_(ctx, token) {
  return token ? findById_(ctx.cycles, 'ackToken', token) : null;
}

function ackPage_(token) {
  var ctx = loadContext_();
  var c = findByToken_(ctx, token);
  if (!c) return page_('Link not valid', '<p class="err">This acknowledgement link is not valid or has expired.</p>');
  var d = slaDeadlines(c, ctx.settings);
  var details = '<table>' + [
    ['Employee', c.employeeName], ['Task', c.taskName], ['Was due', fmtDateTime(c.dueAt)],
    ['Task status now', cycleStatus(c, ctx.now) + (c.completedAt ? ' (' + fmtDateTime(c.completedAt) + ', ' + c.proof + ')' : '')],
    ['Acknowledge by', fmtDateTime(d.ackDeadline)], ['Must be completed by', fmtDateTime(d.resolveDeadline)]
  ].map(function (r) { return '<tr><td>' + esc_(r[0]) + '</td><td>' + esc_(r[1]) + '</td></tr>'; }).join('') + '</table>';

  if (c.managerAckAt) {
    return page_('Already acknowledged', details + '<p class="ok">Acknowledged on ' + esc_(fmtDateTime(c.managerAckAt)) + ' by ' +
      esc_(c.managerAckBy) + ': ' + esc_(c.managerAction) + (c.managerNote ? ' (' + esc_(c.managerNote) + ')' : '') + '</p>');
  }
  var options = MANAGER_ACTIONS.map(function (a) { return '<option>' + esc_(a) + '</option>'; }).join('');
  var form = '<p><b>What action did you take?</b></p><select id="action">' + options + '</select>' +
    '<textarea id="note" rows="3" maxlength="500" placeholder="Note (optional), e.g. Called Employee B, ticket by 7 PM"></textarea>' +
    '<button id="btn" onclick="submitIt()">Acknowledge</button><p id="msg"></p>' +
    '<script>function submitIt(){var b=document.getElementById("btn");b.disabled=true;b.textContent="Saving…";' +
    'google.script.run.withSuccessHandler(function(m){document.getElementById("msg").className="ok";document.getElementById("msg").textContent=m;b.textContent="Done";})' +
    '.withFailureHandler(function(e){document.getElementById("msg").className="err";document.getElementById("msg").textContent=e.message;b.disabled=false;b.textContent="Acknowledge";})' +
    '.submitAck(' + JSON.stringify(token).replace(/</g, '\\u003c') + ',document.getElementById("action").value,document.getElementById("note").value);}</script>';
  return page_('Acknowledge pending task', details + form);
}

/** Called from the acknowledgement page via google.script.run. */
function submitAck(token, action, note) {
  return withLock_(function () {
    var ctx = loadContext_();
    var c = findByToken_(ctx, String(token || ''));
    if (!c) throw new Error('This acknowledgement link is not valid.');
    var res = acknowledgeCore_(ctx, c.cycleId, String(action || ''), String(note || ''), ctx.settings.managerName + ' (email link)');
    if (!res.ok) throw new Error(res.error);
    if (!res.already) {
      saveCycles_(ctx);
      renderAllViews_(ctx);
    }
    return res.message;
  });
}
