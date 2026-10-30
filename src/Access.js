/**
 * Real (not warning-only) protection on every tab, from the roles in Employees and Config:
 * each employee edits only their own My Tasks tab, managers only the Manager Dashboard,
 * admins everything. Triggers run as the owner, so automation is never blocked.
 * Note: Sheets cannot hide tabs per person; everyone with access can still view every tab.
 */

function applyAccessRules_() {
  var s = loadConfig_();
  var plan = buildAccessPlan(readTable_(SHEETS.EMPLOYEES, EMPLOYEE_COLS), [ownerEmail_(), s.adminEmails].join(','), s.managerEmail);
  var ss = getSpreadsheet_();
  var problems = [];
  plan.forEach(function (p) {
    var sh = ss.getSheetByName(p.sheet);
    if (!sh) return;
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (x) { x.remove(); });
    var prot = sh.protect().setDescription(p.role + ': managed by Ops Automation → Apply access rules');
    prot.removeEditors(prot.getEditors());
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
    p.editors.forEach(function (email) {
      try {
        prot.addEditor(email);
      } catch (e) {
        problems.push(email + ' (' + p.sheet + '): ' + e.message);
      }
    });
  });
  return { sheets: plan.length, problems: problems };
}

function applyAccessRulesFromMenu() {
  var ui = requireAdmin_();
  var r = applyAccessRules_();
  ui.alert('Access rules applied to ' + r.sheets + ' tabs.\n\n' +
    '• Each employee can edit only their own My Tasks tab\n• Managers (Config → MANAGER_EMAIL) can edit only the Manager Dashboard\n' +
    '• Admins (owner + Config → ADMIN_EMAILS) can edit everything\n\nEveryone with access can still view every tab.' +
    (r.problems.length ? '\n\nCould not add:\n' + r.problems.join('\n') : ''));
}
