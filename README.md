[README.md](https://github.com/user-attachments/files/28112468/README.md)
# MSBC Menu Dashboard

A web-based menu management system for Mountain State Brewing Co. and Black Fork Pizza locations. Staff can edit food, bar, seasonal, and tap menus from any browser, and printable menus are generated on demand. Edits sync to a Google Sheet within seconds and are visible across browsers within 30 seconds.

---

## Live URL

**Production:** `https://mtnst8.github.io/MSBC-Menus-Dashboard/MSBC_Menu_Dashboard_v93.html`

(Replace `v93` with whatever the current version is. Bookmark this URL.)

## Locations served

- **Thomas** (MSBC) — full food + bar + taps
- **Star City** (MSBC) — full food + bar + taps
- **Clay St** (MSBC) — full food + bar + taps (currently no items seeded)
- **Bridgeport** (MSBC) — full food + bar + taps (currently no items seeded)
- **Parsons** (Black Fork Pizza) — food + bar (no taps; BFP doesn't use Taps UI)

---

## Architecture

```
┌─────────────────────────┐       reads (gviz)        ┌──────────────────┐
│  Dashboard (HTML/JS)    │ ◄──────────────────────── │  Google Sheet    │
│  on GitHub Pages        │                            │  "MSBC Menu DB"  │
│                         │ ────► writes (POST) ─────► │                  │
└─────────────────────────┘                            └──────────────────┘
                                                              │
                                                              │ ↓ POSTs handled by
                                                              ▼
                                                       ┌──────────────────┐
                                                       │  Apps Script     │
                                                       │  (Code.gs)       │
                                                       │  Web App         │
                                                       └──────────────────┘
                                                              │
                                                              │ ↓ daily 3am cron
                                                              ▼
                                                       ┌──────────────────┐
                                                       │  Drive folder    │
                                                       │  "MSBC Menu      │
                                                       │   Backups"       │
                                                       │  (14-day rolling)│
                                                       └──────────────────┘
```

**Three pieces working together:**

1. **Dashboard** — single HTML file hosted on GitHub Pages. All UI and logic. Reads sheet data on load (and every 30s in the background), writes via POST to the Apps Script Web App.
2. **Google Sheet** — the source of truth for all menu data. Tabs: `items`, `locations`, `categories`, `taps`, `users`, `change_log`, `image_library`, `cross_promo`, `boards`.
3. **Apps Script** — runs as the brewery account, validates requests with a shared secret + user authentication, writes to the sheet. Also runs the nightly backup cron.

---

## Day-to-day usage

### Logging in

- Open the dashboard URL
- Enter email/alias + password
- First-time users have `<set on first login>` as their hash — they pick a password on initial login
- Sessions persist via `sessionStorage` until logout or browser close

### Editing menus

- Pick a location from the left sidebar
- Switch tabs (Food / Bar / Seasonal / Taps / Print & Export)
- Edits save instantly to localStorage and push to the sheet ~400ms later
- Other browsers refresh from the sheet every 30 seconds
- Background refresh **skips** while any edit form or modal is open (won't clobber in-progress edits)

### Printing menus

The "Print & Export" tab has cards for every supported menu type. Each opens a new tab with a print-ready layout. Click "Print / Save PDF" in that tab.

| Menu | Format | Notes |
|------|--------|-------|
| Print Food Menu | Per location | Multi-page food layout |
| Print Bar & Specials Menu | Half-page cards | Bar on one side, Specials on the other |
| Print Draft Menu | 5.5×8.5 half-page | Current taps + "Coming Soon" list. Two-up on landscape letter. |
| Print To-Go Trifold | C-fold letter | Takeout-friendly subset |
| Print Group Menu | Single page | Items flagged "Include on group menu" only |
| Export CSV / JSON | File download | For Khamu POS import or website integration |

### Managing categories

- "Manage categories" button in left sidebar
- Three toggle buttons per category:
  - **menu ✓ / not on menu** — whether this category prints on the food/bar menu
  - **takeout ✓ / no takeout** — whether it appears on the takeout trifold
  - **🌀 seasonal** — flag the entire category as seasonal
- Rename, reorder, or delete categories from this same modal
- Changes sync to the sheet just like item edits

### Managing taps (Thomas + Star City + Clay St + Bridgeport)

- Click the **🍺 Taps** tab (shown only on locations with `taps_enabled`)
- Two sections: **Current Taps** (pouring now) and **Upcoming Drafts**
- Per tap: Name, Style, ABV%, Brewery, plus 10oz/Mason/Pitcher prices
- Actions per row: move between current/upcoming, reorder, delete
- Current taps automatically populate the "Beers on Draft" / "Draft Beer" section of the bar menu print, and the dedicated Draft Menu print

---

## Deployment / Updating

### Updating the dashboard (HTML)

1. New version produced (e.g., `v94`) and given to you
2. Go to https://github.com/mtnst8/MSBC-Menus-Dashboard
3. Click **Add file → Upload files** → drag new HTML → Commit
4. Wait ~1 minute for GitHub Pages to update
5. New URL: `https://mtnst8.github.io/MSBC-Menus-Dashboard/MSBC_Menu_Dashboard_v94.html`
6. Update staff bookmarks
7. (Optional) Delete old versions from the repo to keep it tidy

### Updating the Apps Script backend

1. Open the Sheet → **Extensions → Apps Script**
2. Ctrl+A → delete the old code → paste the new `Code.gs` → click Save (💾)
3. **Deploy → Manage deployments** → click ✏️ on the active deployment → Version dropdown: **"New version"** → Deploy
4. The Web App URL stays the same — dashboard needs no change
5. ⚠️ **Don't click "New deployment"** — that creates a brand new URL the dashboard doesn't know about

### Adding the menu_excluded column (or any new column)

The Apps Script writes by column NAME, not column index. To add a new field:
1. Add the column header to the appropriate sheet tab (e.g., `menu_excluded` on `categories`)
2. Update Code.gs only if the handler explicitly lists fields to copy (e.g., `handleWriteCategories`)
3. Dashboard sends the new field in its payload
4. The script writes whichever fields match column names

---

## Backups

### How backups work

- **Continuous:** Google Sheets keeps full version history automatically. File → Version history → See version history. Restore granularity is every few minutes for changes.
- **Daily:** A trigger in Apps Script runs `runDailyBackup` at **3 AM every day**. It:
  1. Copies the entire spreadsheet to a Drive folder (default: `MSBC Menu Backups` in My Drive). Filename: `MSBC Menu Backup 2026-05-20`.
  2. Saves a copy of the live Apps Script source code into the same folder. Filename: `Code.gs Backup 2026-05-20.txt`.
  3. Deletes both sheet and script backups older than **14 days**.
- **Audit trail:** Each successful backup is logged in the `change_log` tab as `BACKUP CREATED`.

### Moving the backup folder

You can put the backup folder anywhere — under another folder, in a different organizational structure, or even in a Shared Drive. The script tracks it by folder ID, not location.

1. Run the backup once so the folder exists (`runDailyBackup` in Apps Script)
2. Open the folder in Drive and copy its ID from the URL:
   `drive.google.com/drive/folders/THIS_LONG_STRING_IS_THE_ID`
3. In Apps Script, edit Code.gs and paste the ID into the `BACKUP_FOLDER_ID` constant near the top of the backup section
4. Save → Deploy → Manage deployments → New version → Deploy
5. Now you can move/rename the folder freely

### Enabling the Apps Script source backup

By default the script tries to fetch its own source via the Apps Script API. If that API isn't enabled for your account, the script backup file will just contain a note explaining how to enable it (the sheet backup still works fine).

To enable the source-backup feature:
1. Go to `script.google.com/home/usersettings`
2. Toggle **"Google Apps Script API"** to ON
3. The next backup will include the real source code

### Verifying backups are running

1. Open the Apps Script editor → click the ⏰ Triggers icon (left sidebar)
2. Should see: `runDailyBackup` · Time-driven · Day timer · 3am to 4am
3. Or check the `change_log` tab — look for `BACKUP CREATED` rows on consecutive days
4. Or open the backup folder → confirm recent dated files (both .xlsx-like and .txt)

### Restoring from a Drive backup

Use this when something is badly corrupted, you need to roll back many days, or a tab got accidentally deleted.

**Option 1 — Selective restore (most common):**

You want a few rows back, or one tab worth of data. The live sheet is mostly fine.

1. Open the backup folder → open the dated sheet backup
2. Verify the backup contains what you need (open the relevant tab, scroll to the date in `change_log`)
3. In the backup: select the rows/range you want to restore → Ctrl+C
4. Open the LIVE sheet → navigate to the same tab → paste over
5. Open the dashboard — within 30 seconds, the background refresh will pull the restored data into all open browsers

**Option 2 — Full sheet restore (uncommon, catastrophic recovery):**

The live sheet is unusable; you need to rewind to a specific day.

1. Open the backup folder → right-click the dated backup → **Make a copy**
2. Rename the copy something like "MSBC Menu DB (RESTORED FROM 2026-05-20)"
3. Open Apps Script for the original sheet → copy the `SPREADSHEET_ID` value (line 18 in Code.gs)
4. Get the new sheet's ID from its URL: `docs.google.com/spreadsheets/d/THIS_PART/edit`
5. In Apps Script, change `SPREADSHEET_ID` to the new ID → Save
6. **Deploy → Manage deployments → ✏️ → New version → Deploy**
7. All writes will now flow to the restored sheet
8. Optional cleanup: archive the broken original, rename the restored one to take its place

**Option 3 — Using Google Sheets version history (for recent damage):**

You made a bad change in the last few hours and want to undo all of it without losing newer work in other tabs.

1. Open the live sheet → File → Version history → See version history
2. Browse versions in the right sidebar (auto-saved every few minutes)
3. Click a version to preview
4. Click **Restore this version** at the top to roll the WHOLE sheet back to that point
5. ⚠️ This rolls back everything — items, taps, users, categories all at once. If you only want one tab restored, use Option 1 instead.

**Option 4 — Restoring the Apps Script code:**

The Apps Script project got corrupted, deleted, or you need to roll back a backend change.

1. Open the backup folder → find `Code.gs Backup 2026-05-20.txt` for the day you want
2. Open the .txt file in Drive (or download it)
3. Copy its entire contents
4. Open Apps Script → Ctrl+A → delete → paste the backup → Save
5. **Deploy → Manage deployments → ✏️ → New version → Deploy**

### Running a backup manually

Useful before risky changes (mass deletes, schema migrations), or right after deploying a new version of Code.gs so the latest is captured.

1. Apps Script editor → function dropdown → select **`runDailyBackup`** → click Run
2. Authorize if prompted
3. Check the backup folder → new dated sheet file AND new dated .txt file with today's date

### Reinstalling the backup trigger

If triggers ever get deleted (e.g., by re-running other admin functions):

1. Apps Script editor → function dropdown → **`installBackupTrigger`** → click Run
2. Returns "Trigger installed: daily backup at 3am"

---

## Sheet schema reference

### `items` tab
`id, location, menu, cat, name, price, desc, takeout_desc, sizes_json, seasonal, special, new, gf, nut, veg, takeout, group_menu, group_price, available, featured, board, sort_order, day_of_week, image_key, updated_at, updated_by`

### `locations` tab
`key, name, display_name, type, brand, addr, phone, website, hours, paper, logo_image_key, qr_image_key, party_footer, upcoming_tap_msg, food_template, bar_template, trifold_template, board_template, updated_at, updated_by`

### `categories` tab
`location, menu, sort_order, name, takeout_excluded, seasonal, menu_excluded, updated_at, updated_by`

### `taps` tab
`location, tap_number, status, sort_order, name, style, abv, description, eta, eta_note, tap_image_key, brewery, price_10oz, price_mason, price_pitcher, updated_at, updated_by`

### `users` tab
`email, alias, password_hash, role, locations, active, created_at, last_login`

- `role`: `admin`, `manager`, or `viewer`
- `locations`: JSON array of allowed location keys (managers only; admins access all)
- `active`: `TRUE` or `FALSE`

### `change_log` tab
`timestamp, user, location, action, target, details`

Auto-archived to `change_log_archive` after 180 days by `handleArchiveChangeLog`.

---

## Troubleshooting

### "Invalid secret" on login or save

The dashboard's `SHARED_SECRET` doesn't match the Apps Script's. Either:
- The Apps Script wasn't redeployed after the secret was changed (most common — fix: Deploy → Manage deployments → New version)
- The dashboard's URL points at an old/wrong deployment (check `SHEETS_CONFIG.APPS_SCRIPT_URL` in the HTML matches the active deployment's Web App URL)

### "Authentication failed. Check your name and password."

User auth failed in the Apps Script. Possible causes:
- Wrong password (try the password reset path — currently manual: clear `password_hash` in the users tab to `<set on first login>`)
- User row marked `active = FALSE`
- Email/alias doesn't match any row

### CORS errors in browser console

Dashboard was opened from `file://` instead of the GitHub Pages URL. The sheet reads (gviz) require a real `https://` origin. Solution: always use the GitHub Pages URL.

### Edits don't appear in sheet

Check browser console:
- `_writeWrapperInstalled: false` → initial sheet read failed (CORS? auth?). Fix the read path first.
- `_writeShadow ready?: false` → same — write sync waits for the first successful read.
- Network tab → look at the POST to Apps Script → look at response body for the actual error

### Tap doesn't show on bar menu print

- Make sure the tap's status is `current` (not `upcoming`)
- Verify the bar menu has a category whose name contains "Draft" or "On Tap" — the auto-injection looks for those keywords
- Make sure the tap isn't excluded by the `menu ✓ / not on menu` toggle for the Drafts category

### Background sync isn't pulling other people's edits

- Each browser refreshes every 30 seconds
- Refresh is skipped while ANY edit form or modal is open
- Refresh is skipped if the tab isn't visible
- To force a refresh: switch tabs in the browser, or reload the page

---

## Configuration values

These live at the top of the HTML file in `SHEETS_CONFIG`:

```javascript
SPREADSHEET_ID:    '10rgw666iWjXWxdHcKX4z_SqpYY92cv4KPhNBdwOJr6I'
APPS_SCRIPT_URL:   'https://script.google.com/macros/s/AKfycbzrjR4miScHpDqGHdaqn_cY___h8cBPLNxFzt8ZzOAlTfGdnmt5wYIokWFg0KZg7OKO/exec'
SHARED_SECRET:     'jHrz-GVZ1sCNrnJ7SInST4Nqe2tge0JT'
HASH_SALT:         'msbc-salt-2025'
```

The `SHARED_SECRET` must match the value in Code.gs line 19. Rotating it requires updating BOTH files and redeploying both.

The `HASH_SALT` must never change — changing it would invalidate all existing user passwords.

The GitHub repo is **public** so GitHub Pages works on a free plan. Therefore the secret in the HTML is publicly visible to anyone who finds the repo. The Apps Script's user/password authentication is the real defense — the secret is just a first lock to discourage casual abuse.

---

## File structure in this repo

```
/MSBC-Menus-Dashboard/
├── MSBC_Menu_Dashboard_v93.html   # Current production dashboard
├── Code.gs                         # Apps Script backend (reference copy; live version is in Apps Script editor)
└── README.md                       # This file
```

Older `vXX.html` files can be kept or deleted — only the current one is in use.

---

## Version history (selected milestones)

- **v82** — Backend integration started (Google Sheet + Apps Script)
- **v85** — Standardized trifold covers
- **v88** — Per-category "print on menu" toggle added
- **v89** — Sheet sync for menu_excluded
- **v90** — Secret rotated for public-repo safety
- **v91** — GitHub Pages deployment; CORS issues resolved
- **v92** — Taps UI shipped (current + upcoming, per-location)
- **v93** — Per-tap pricing; Draft Menu print template; auto-inject taps on bar menu print

---

## What's not yet built

- **Menu boards** — digital signage rendering (parked, Phase 2)
- **Image upload** — image_library backend exists but no UI yet (parked, Phase 2)
- **Cross-promo** — backend exists, no UI (parked, Phase 2)
- **Per-day specials UI** — `day_of_week` field exists on items but no calendar-style editor
- **Tap photos** — `tap_image_key` field exists but no upload flow
- **Khamu POS sync** — currently manual via CSV export
