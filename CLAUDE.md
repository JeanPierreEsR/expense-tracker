# Personal Finance Tracker — Project Spec

> This file is the source of truth for the project. Read it at the start of every
> session. When a decision here turns out to be wrong or incomplete, update this
> file as part of the same change.

## 1. Context

- **Owner:** non-developer. Explain things in plain language, avoid jargon, and
  say what you are about to do before doing it.
- **Machine:** Mac Mini (development + optional always-on helper).
- **Target device:** iPhone.
- **Budget:** $0. Do not introduce any paid service, API, or subscription
  without asking first.
- **Default currency:** PEN.
- **Locale:** Peru. Common payment apps: Yape, Plin.

## 2. Architecture (Path A)

A Progressive Web App (PWA) added to the iPhone home screen, backed by Google.

| Layer | Technology | Notes |
|---|---|---|
| Database | Google Sheets | One tab per table (see §4). Data stays viewable/editable by hand. |
| Backend | Google Apps Script | Scheduled triggers, Gmail reading, business logic. Deployed via `clasp`. |
| Frontend | HTML + CSS + JavaScript | Hosted free on GitHub Pages. Mobile-first, installable as a PWA. |
| Notifications | ntfy or Telegram bot | Chosen during Phase 4. If ntfy, use a long random topic name. |
| Quick capture | iOS Shortcuts | Apple Pay transaction automation → append entry. |

**Rules**

- No paid hosting, no paid APIs, no third-party services requiring a credit card.
- Email parsing uses per-bank pattern rules. No paid AI API calls in production.
- Commit to Git after every working step so any change can be undone.
- Plan in plain language and get approval before building each feature.

## 3. Core principles

These drive most of the data model. Do not violate them for convenience.

1. **An expense is recorded once, when consumption happens, for the owner's
   share only.**
2. **Money moving between the owner and a friend is never an expense or income.**
   It only changes a debt balance.
3. **Expense timing follows the consumption date, not the payment date.** If a
   friend pays for a January dinner and is repaid in March, the expense counts
   in January.
4. **Budgets apply to expenses only.** Never to income, investments, loans, or
   settlements.
5. **Foreign-currency amounts are stored in their original currency.** The PEN
   value is always derived from the monthly rate table, never stored as a
   frozen number.
6. **Anything automated lands in a review queue as `pending`** until the owner
   confirms it. Never write a confirmed entry from an automated source.

## 4. Data model

Each table is a tab in the Google Sheet. Every row has a stable unique ID.

### Entries
The central table. Covers expenses, income, investments, and transfers.

| Field | Notes |
|---|---|
| `id` | Unique. |
| `type` | `expense` \| `income` \| `investment` \| `transfer` |
| `date` | Consumption date (see principle 3). |
| `amount` | Full amount charged, in `currency`. For shared expenses this is the total, not the owner's share. |
| `currency` | Defaults to PEN. |
| `category_id` | Must belong to the same `type`. |
| `description` | Free text. |
| `payment_method_id` | Required when `paid_by = me`. Hidden when a friend paid. |
| `paid_by` | `me` (default) or a `friend_id`. |
| `status` | `pending` \| `confirmed` |
| `source` | `manual` \| `import` \| `email` \| `shortcut` |
| `external_id` | Bank reference or import hash. Used for deduplication. |
| `import_batch_id` | Set when created by an import. |

**Derived (never stored):** `own_share` = `amount` − sum of its splits.
`amount_pen` = `amount` × rate for `currency` in the month of `date`.

### Entry Splits
Only used for shared expenses. Absent for normal entries.

`id`, `entry_id`, `friend_id`, `amount`

When splits exist, the app creates or updates linked loans:
- `paid_by = me` → each friend owes the owner their split amount.
- `paid_by = friend` → the owner owes that friend the owner's share.

### Categories
`id`, `name`, `type`, `icon`, `color`, `parent_id` (optional)

Each `type` has its own list. Seed with sensible Peru-appropriate defaults and
let the owner edit them.

### Tags
`id`, `name`, `color` — many-to-many with Entries, via an `entry_tags` tab.
Tags cut across categories and types.

### Payment Methods
`id`, `nickname`, `type` (`credit` \| `debit` \| `cash` \| `transfer` \| `wallet`),
`bank_id`, `last_4`

`last_4` is what lets the email parser match a transaction to a card.

### Banks
`id`, `name`

### Exchange Rates
`id`, `month` (YYYY-MM), `currency`, `rate`

`rate` means: 1 unit of `currency` = `rate` PEN. Label it that way in the UI so
it cannot be entered backwards.

**Behaviour**
- When saving an entry whose `currency` ≠ PEN, look up the rate for the month of
  the **entry's date**, not today.
- If missing, prompt for it and save it for that month.
- All other entries in that month and currency reuse it silently.
- Editing a rate recalculates every affected entry. Show the count of affected
  entries before saving.
- Warn if a new rate differs from the previous month's by more than ~10%.
- Rates are always keyed to calendar months, even when viewing custom periods.

### Friends
`id`, `name`, `notes`

### Loans
| Field | Notes |
|---|---|
| `id` | |
| `friend_id` | |
| `direction` | `they_owe_me` \| `i_owe_them` |
| `origin` | `cash` (standalone loan) \| `entry` (created from a shared expense) |
| `entry_id` | Set when `origin = entry`. |
| `amount`, `currency` | Loans keep their original currency. Balances never re-convert. |
| `date` | |
| `due_date` | Optional. Drives overdue reminders. |
| `payment_method_id` | Optional, for cash loans. |
| `description` | |
| `status` | `outstanding` \| `partially_repaid` \| `repaid` \| `forgiven` |

Forgiving a loan optionally converts the remaining balance into an expense
(e.g. category "Gifts") — at that point the money really is spent.

### Settlements
`id`, `loan_id`, `date`, `amount`, `payment_method_id`

Repayments in either direction. **Never** appear as entries, in expense totals,
in income totals, or against budgets.

### Budgets
`id`, `category_id`, `amount`, `period_type`, `thresholds` (e.g. 50/80/100%)

### Budget Alert Log
`id`, `budget_id`, `threshold`, `period`, `sent_at` — prevents duplicate alerts.

### Period Templates
`id`, `name`, `recurrence_rule`, `start_anchor`

Store the rule (e.g. "monthly from day 25") and generate concrete intervals on
the fly. Never materialise each period as a row.

### Import Batches
`id`, `filename`, `date`, `row_count` — lets a bad import be undone in one step.

### Parsing Rules
`id`, `bank_id`, `sender`, `pattern`, `field_mappings`

### Settings
Default currency, alert thresholds, notification channel, notification target.

## 5. Behaviour rules

### Reporting
Show income, expenses, investments, and net (income − expenses − investments)
as separate figures. Investments are contributions and withdrawals of cash, not
portfolio value — this app does not track investment performance.

All budgets and reports are in PEN. Entry lists show both amounts, e.g.
`USD 50.00 (PEN 176.00)`.

### Periods
One reusable period selector: Month (default, swipeable), Year, All-time,
Custom range, plus any saved recurring template. Every query filters on a date
interval so all views work with any period.

### Review queue
Automated entries land here as `pending`. Available actions:

- **Confirm / edit** — normal path.
- **Split** — assign portions to friends. Reduces the owner's share and creates
  linked loans.
- **Mark as repayment** — converts a detected transfer into a settlement against
  an existing loan. Removes it from income/expense totals.
- **Convert to loan** — turns a detected transfer into a new cash loan.
- **Needs exchange rate** — flag shown when a foreign-currency transaction has
  no rate for its month. Do not guess a rate.

Flag as suspicious: a transfer to or from a friend with no open loan, and an
open debt that matches the amount of a transfer just made.

### Email automation
A scheduled Apps Script trigger searches Gmail for bank notifications, parses
them with per-bank rules, matches `last_4` to a payment method, and writes
`pending` entries. Detected deposits default to `type = income`; charges default
to `expense`. Deduplicate on `external_id`.

When a friend pays for something, no email arrives — that case is manual entry
only, so `paid_by` must be easy to reach on the entry form.

### Import
CSV (and optionally Excel). Column-mapping screen, remembered per bank. Preview
with duplicates flagged (match on date + amount + similar description) before
committing. Prompt for any missing monthly exchange rates during preview.
Auto-categorise via keyword rules that grow as the owner corrects them.

### Edge cases to handle
Refunds (negative amounts), instalment purchases, transfers between the owner's
own accounts (`type = transfer`, excluded from expense totals).

## 6. Build phases

Build in this order. Test each phase on the actual iPhone before moving on.

| # | Phase | Scope |
|---|---|---|
| 0 | Setup | Tooling, Google Sheet structure, Apps Script project, GitHub repo, deploy pipeline. |
| 1 | Core app | Entry form and list: types, per-type categories, tags, payment methods, banks, currencies, exchange-rate prompt, Exchange Rates section. |
| 2 | Email automation | Sample email collection, parsing rules, scheduled trigger, review queue. |
| 3 | Periods & charts | Period selector, recurring periods, income/expense/investment views, breakdowns by category, tag, and payment method. |
| 4 | Budgets & alerts | Budget setup, threshold checks, ntfy/Telegram delivery. |
| 5 | Loans | Both directions, splits, settlements, net balance per friend, overdue reminders. |
| 6 | Import & Shortcuts | CSV import with deduplication, Apple Pay Shortcut. |
| 7 | Hardening | Nightly backups on the Mac Mini, edge cases, final testing. |

Types, currencies, and `paid_by` must exist in the data structure from Phase 1 —
retrofitting them means reworking every screen.

## 7. Open decisions

- Notification channel: ntfy vs Telegram (decide in Phase 4).
- Whether to run a local model on the Mac Mini as a fallback parser for unusual
  bank emails (only if the Mac is Apple Silicon with 16 GB+ RAM).
- Whether the Mac Mini handles non-Gmail providers via the Mail app.
