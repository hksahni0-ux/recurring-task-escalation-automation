# Recurring Task Tracking, Pending Reports & Escalation: Solution Design

Allo Innoware: AI Operations Manager assignment.

Google Sheets is the only interface: employees, the manager and leadership never need another tool. Google Apps Script provides the automation (time triggers, an on-edit trigger, Gmail, and a small web app for one-click acknowledgement).

## 1. End-to-end flow

```
Task_Master ──(hourly / 07:00 run)──► Task_Cycles: one row per cycle, ID = TaskID-YYYYMMDD
                                          │
                     ┌────────────────────┴──────────────────────┐
                     ▼                                           ▼
     "My Tasks - <employee>" tab                       Manager Dashboard
     employee types Ticket ID / update ──► cycle closed, next cycle opened, views refreshed
                                          │
             due 18:00 missed ──► 18:30 same-day manager email (one per item)
                                          │
        manager acknowledges (email button or Ack ✔) + records action taken
                                          │
  no ack by 12:00 next working day, OR still open at due + 2 working days 18:00,
  OR manager picks "Blocked: needs leadership help" ──► one leadership escalation email
```

## 2. Sheets

| Tab | Purpose | Who edits |
|---|---|---|
| How It Works | Built-in guide | none |
| Manager Dashboard | Team summary (pending / overdue / awaiting ack / escalated / done this week) and an exceptions list with **Ack ✔, Manager Action, Note** | Manager |
| My Tasks - Employee A…D | Each employee's single working place: overdue, pending, upcoming, recent completions. One yellow input column | Employee |
| Task_Master | Recurring task definitions: frequency (days), proof type (TICKET / DAILY_UPDATE), start date, active | Admin |
| Employees, Config, Holidays | Team, SLA settings and recipients, non-working days | Admin |
| Task_Cycles | System of record: every cycle with completion, alert, ack and escalation history | Automation only |
| Alert_Log | Every email sent | Automation only |
| Test_Log | Results and evidence of the built-in tests | Automation only |

## 3. Recurring cycle logic

- A task with frequency *N* days and start date *S* has cycles starting at *S*, *S+N*, *S+2N*, and so on. Each cycle covers *N* days and is **due at 18:00 on the last working day of the period** (Sundays and holidays move back to the previous working day).
- A daily task (*N* = 1) gets a cycle on every working day only.
- Cycles are **anchored on the start date**, so completing late never shifts future due dates. Nobody calculates a next due date by hand.
- When a cycle is completed, the next cycle is created at once (shown as *Upcoming*). The hourly run also creates any cycle whose period has started. The ID `TaskID-YYYYMMDD` is deterministic, so a cycle can never exist twice.

## 4. Single-point completion

The employee works only on their **My Tasks** tab and types **one value** into the yellow cell:

- **Portal tasks:** the Ticket ID. Validated as 3–40 letters, numbers or `-_./#`, so "x" or a formula is rejected.
- **Daily task:** the update text they posted (see §5).

The on-edit trigger then, under a lock:
1. validates the entry;
2. records **proof, completed-at and completed-by** (employee name and the editor's Google account) in Task_Cycles;
3. closes the cycle, records its resolution (on time / late / after alert / after escalation) and opens the next cycle;
4. redraws every tab and the dashboard.

Rejected entries stay in the cell with a note explaining why, and nothing is recorded. A second entry on a completed cycle is ignored. No other sheet ever needs updating.

## 5. Daily task without a Ticket ID (WhatsApp update)

**Method:** the employee posts the daily update in the WhatsApp group as usual, then copies the same message and pastes it into the yellow cell on their tab. That is one copy-paste.

**What the system records:** the full update text, the time and the editor. Text under 15 characters (such as "done" or "ok") is rejected, so the record shows the work was actually done, not just a tick. The manager can compare the text with the group at any time.

**Why this method:** WhatsApp offers no API to read group messages, so the system cannot detect a group post. Copy-paste needs no new app, takes about 5 seconds, and leaves an audit trail of what was shared. **Upgrade path:** send the update from the sheet through the WhatsApp Business Platform, so posting and recording happen in one step.

## 6. Manager alerts and leadership escalation (SLA)

All values are editable in **Config**.

| Time | Rule | Reasoning |
|---|---|---|
| **T0**: due date, 18:00 | Task must be completed | End of the working day |
| **T0 + 30 min** (18:30, same day) | **Manager email.** One email per run lists every newly overdue item, with *Acknowledge* buttons, ack-by and complete-by times, and what to do | Same day, as required. The 30 minutes covers last-minute updates and avoids false alarms |
| **12:00 next working day** | Not acknowledged → **leadership escalation** | Half a working day is enough to react, and leadership hears about it the same working day |
| **Due date + 2 working days, 18:00** | Acknowledged but **still not completed** → **leadership escalation** | Acknowledging is not enough. The work must actually get done |
| Any time after the alert | Manager chooses **"Blocked: needs leadership help"** → escalation on the next run | Lets the manager pull leadership in straight away |
| Sundays / holidays | Skipped when counting working days | No one is escalated over a weekend or holiday |

**What the manager is expected to do (Test 5):** check with the employee and get the task done (the employee only enters the Ticket ID or update), then **acknowledge** the item, either through the email button (a mobile-friendly page) or Ack ✔ on the dashboard, choosing the action taken:
- Followed up with employee
- Extension agreed with employee
- Task reassigned
- Blocked: needs leadership help
- Other

An optional note can be added. The system stores who acknowledged it, when, the action and the note. The dashboard's **Outcome** column shows whether the task was completed afterwards, for example "Completed after manager alert".

**Avoiding repeat emails (Test 8):**
- Each cycle stores *Manager Alerted At* and *Leadership Escalated At*, so each level fires **at most once per cycle**.
- Items due at the same time share one email.
- Every run takes a script lock, and markers are saved immediately after sending.
- After escalation, the item stays red on the dashboard rather than producing more email.
- Re-installing triggers replaces them, so triggers are never duplicated either.

## 7. Automation

| Trigger | Runs | Does |
|---|---|---|
| On edit | Every edit | Records completions (My Tasks) and acknowledgements (Dashboard) |
| Time: hourly | Every hour | Creates due cycles, refreshes statuses, sends manager alerts and escalations |
| Time: about 18:45 | Daily | Makes sure the same-day manager alert goes out promptly |
| Time: about 07:00 | Daily | Opens the day's cycles before work starts |
| Web app | Email link | Acknowledgement page. Guarded by a random per-item token. Admin and menu functions refuse to run outside the sheet UI |

**Access control:** every tab carries a real Google protection, not a warning, built from the roles in the Employees and Config tabs:

| Role | Who | Can edit |
|---|---|---|
| Employee | Their email in the Employees tab | Only their own My Tasks tab. Anything typed outside the yellow column is undone on the next redraw |
| Manager | Config → MANAGER_EMAIL | Only the Manager Dashboard (Ack ✔, Manager Action, Note) |
| Admin | Sheet owner + Config → ADMIN_EMAILS | Every tab and every ⚙ Ops Automation menu item (the menu is visible to all, but runs only for admins) |

The rules re-apply automatically whenever the Employees or Config tab changes. Completions and acknowledgements are recorded by the owner's triggers, so locked tabs never block the automation. Google Sheets cannot hide tabs per person, so everyone with access can *view* every tab. Reviewers are added to ADMIN_EMAILS so they can run the demo.

## 8. Test cases (built in: menu ⚙ Ops Automation → Demo tests)

The tests run the real code paths (time-trigger run, employee edit, dashboard edit, email-link acknowledgement) under a **simulated clock** (`Config → SIMULATED_NOW`), so a week of activity takes seconds.
- Live data is snapshotted first. **Exit demo mode** restores it.
- Real emails are sent, marked `[DEMO]`.
- Every result and its evidence is written to **Test_Log**.

| # | Scenario | Checked |
|---|---|---|
| 1 | Weekly task completed with TCK-7001 | Cycle closed; next cycle created as Upcoming; becomes Pending when its period starts; still exactly 2 cycles |
| 2 | Employee C types a Ticket ID on their tab | Task_Cycles updated (proof, who, when); tab and dashboard updated; no other edit needed |
| 3 | Daily update | "done" rejected; real update accepted and stored; next working day's cycle queued |
| 4 | Daily task missed | No email at 18:15 (grace period); one manager email at 18:35 the same day |
| 5 | Manager acknowledges on the dashboard, then employee completes | Ack, action and note stored; outcome "Completed after manager alert"; no escalation |
| 6 | (a) Manager never acknowledges; (b) acknowledges by email link but the task stays open | Escalated at 12:05 next working day; escalated after due + 2 working days |
| 7 | SLA boundaries | Each rule checked one minute before and at its deadline; holiday shift; no repeats |
| 8 | Run automation 3× at each stage; enter completion twice | 1 manager email, 1 leadership email, unique cycle IDs, completion recorded once |

The same logic is also covered by 67 automated tests in Node (`npm run test:all`), run in CI on every push.
