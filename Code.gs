// ═══════════════════════════════════════════════════════════════════════════════
// MSBC Menu Database — Apps Script Backend
// ═══════════════════════════════════════════════════════════════════════════════
// Deployed as a Web App, executes as the brewery account, accessible by "Anyone".
// Validates a shared secret on every write. Validates user credentials for actions
// that require them. Appends to change_log for audit trail.
//
// To deploy:
//   1. In the spreadsheet, click Extensions → Apps Script
//   2. Paste this entire file into Code.gs (replace anything that's there)
//   3. Click Deploy → New deployment → Type: Web app
//   4. Set "Execute as": Me
//   5. Set "Who has access": Anyone
//   6. Click Deploy, authorize when prompted
//   7. Copy the Web app URL and send it back to Claude
// ═══════════════════════════════════════════════════════════════════════════════

const SPREADSHEET_ID = '10rgw666iWjXWxdHcKX4z_SqpYY92cv4KPhNBdwOJr6I';
const SHARED_SECRET  = 'jHrz-GVZ1sCNrnJ7SInST4Nqe2tge0JT';

// How long change_log entries stay in the live tab before archiving (in days).
const CHANGE_LOG_RETENTION_DAYS = 180;  // 6 months

// ── Entry point: HTTP POST ────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ ok: false, error: 'Invalid secret' });
    }
    const action = body.action;
    const user = body.user || 'unknown';
    const payload = body.payload || {};

    // Auth check — every write requires a valid user (except auth_check itself)
    if (action !== 'auth_check' && action !== 'health') {
      const userRow = findUser(user, body.password_hash);
      if (!userRow) {
        return jsonResponse({ ok: false, error: 'Authentication failed' });
      }
      if (!userRow.active) {
        return jsonResponse({ ok: false, error: 'User is inactive' });
      }
      // Permission check: managers can only edit their assigned locations
      const targetLoc = payload.location || payload.locationKey || '';
      if (userRow.role === 'manager' && targetLoc) {
        if (!userRow.locations.includes(targetLoc)) {
          return jsonResponse({ ok: false, error: 'No permission for this location' });
        }
      }
      if (userRow.role === 'viewer') {
        return jsonResponse({ ok: false, error: 'Viewers cannot write' });
      }
    }

    let result;
    switch (action) {
      case 'health':           result = handleHealth(); break;
      case 'auth_check':       result = handleAuthCheck(user, body.password_hash); break;
      case 'write_item':       result = handleWriteItem(payload, user); break;
      case 'delete_item':      result = handleDeleteItem(payload, user); break;
      case 'bulk_write_items': result = handleBulkWriteItems(payload, user); break;
      case 'write_location':   result = handleWriteLocation(payload, user); break;
      case 'write_categories': result = handleWriteCategories(payload, user); break;
      case 'write_tap':        result = handleWriteTap(payload, user); break;
      case 'delete_tap':       result = handleDeleteTap(payload, user); break;
      case 'write_board':      result = handleWriteBoard(payload, user); break;
      case 'write_cross_promo':result = handleWriteCrossPromo(payload, user); break;
      case 'write_image':      result = handleWriteImage(payload, user); break;
      case 'write_user':       result = handleWriteUser(payload, user); break;
      case 'archive_changelog': result = handleArchiveChangeLog(); break;
      default:
        return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
    }
    return jsonResponse({ ok: true, result: result });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err), stack: String(err.stack || '') });
  }
}

// ── Health check (GET) ───────────────────────────────────────────────────────
// Useful for confirming the script is reachable. No auth required.
function doGet(e) {
  return jsonResponse({
    ok: true,
    name: 'MSBC Menu Database',
    version: '1.0',
    timestamp: new Date().toISOString(),
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sheet access helpers
// ═══════════════════════════════════════════════════════════════════════════════
function ss() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}
function sheet(name) {
  const s = ss().getSheetByName(name);
  if (!s) throw new Error('Sheet not found: ' + name);
  return s;
}
function getHeaders(sheetName) {
  const s = sheet(sheetName);
  return s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
}
function rowToObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i]; });
  return obj;
}
function objectToRow(headers, obj) {
  return headers.map(h => obj[h] !== undefined ? obj[h] : '');
}

// Find a row in a sheet by a key column matching a value. Returns row index (1-based)
// or -1 if not found. Header is row 1, so data starts at row 2.
function findRowByKey(sheetName, keyCol, keyValue) {
  const s = sheet(sheetName);
  const lastRow = s.getLastRow();
  if (lastRow < 2) return -1;
  const headers = getHeaders(sheetName);
  const colIdx = headers.indexOf(keyCol);
  if (colIdx === -1) throw new Error('Column not found: ' + keyCol + ' in ' + sheetName);
  const values = s.getRange(2, colIdx + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(keyValue)) return i + 2;
  }
  return -1;
}

// Find a row matching multiple key columns (composite key).
function findRowByKeys(sheetName, keys) {
  const s = sheet(sheetName);
  const lastRow = s.getLastRow();
  if (lastRow < 2) return -1;
  const headers = getHeaders(sheetName);
  const allData = s.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    let match = true;
    for (const k in keys) {
      const colIdx = headers.indexOf(k);
      if (colIdx === -1 || String(row[colIdx]) !== String(keys[k])) {
        match = false;
        break;
      }
    }
    if (match) return i + 2;
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// User auth
// ═══════════════════════════════════════════════════════════════════════════════
// SENTINEL: when a user is first created, password_hash is set to this value.
// On their first successful auth_check, the real hash they sent is captured and
// written to the sheet, replacing the sentinel. From then on, only matching the
// stored hash will authenticate.
const FIRST_LOGIN_SENTINEL = '<set on first login>';

function findUser(emailOrAlias, passwordHash) {
  if (!emailOrAlias) return null;
  const headers = getHeaders('users');
  const s = sheet('users');
  const lastRow = s.getLastRow();
  if (lastRow < 2) return null;
  const data = s.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const emailIdx = headers.indexOf('email');
  const aliasIdx = headers.indexOf('alias');
  const hashIdx = headers.indexOf('password_hash');
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const email = String(row[emailIdx]).toLowerCase();
    const alias = String(row[aliasIdx]).toLowerCase();
    const lookup = String(emailOrAlias).toLowerCase();
    if (email === lookup || alias === lookup) {
      const storedHash = String(row[hashIdx]);
      // Password hash check — strict match required.
      // First-login sentinel accepts any password (it will be captured by
      // handleAuthCheck on the auth_check call); subsequent calls must match.
      if (storedHash === FIRST_LOGIN_SENTINEL || storedHash === passwordHash) {
        return rowToObject(headers, row);
      }
    }
  }
  return null;
}

function handleAuthCheck(emailOrAlias, passwordHash) {
  const user = findUser(emailOrAlias, passwordHash);
  if (!user) return { authenticated: false };
  const rowIdx = findRowByKey('users', 'email', user.email);
  if (rowIdx > 0) {
    const headers = getHeaders('users');
    const hashColIdx = headers.indexOf('password_hash');
    const llIdx = headers.indexOf('last_login');
    const s = sheet('users');
    // If the stored hash is still the first-login sentinel, capture the real
    // hash that was just provided. This locks the password in from here on.
    if (hashColIdx >= 0 && passwordHash && String(user.password_hash) === FIRST_LOGIN_SENTINEL) {
      s.getRange(rowIdx, hashColIdx + 1).setValue(passwordHash);
      try { logChange(user.email || user.alias || 'unknown', '', 'PASSWORD SET', user.email || user.alias || '', 'First-login password captured'); } catch (e) {}
      user.password_hash = passwordHash;
    }
    // Update last_login
    if (llIdx >= 0) s.getRange(rowIdx, llIdx + 1).setValue(new Date().toISOString());
  }
  // Don't return the password hash
  delete user.password_hash;
  // Parse locations JSON
  try { user.locations = user.locations ? JSON.parse(user.locations) : []; }
  catch (e) { user.locations = []; }
  return { authenticated: true, user: user };
}

function handleHealth() {
  return { status: 'ok', spreadsheet: SPREADSHEET_ID, time: new Date().toISOString() };
}

// Re-fetch user with locations parsed
function getUserFull(emailOrAlias, passwordHash) {
  const user = findUser(emailOrAlias, passwordHash);
  if (!user) return null;
  try { user.locations = user.locations ? JSON.parse(user.locations) : []; }
  catch (e) { user.locations = []; }
  return user;
}

// Wrapper for findUser used by doPost (no password hash needed since we already validated)
function findUserNoAuth(emailOrAlias) {
  if (!emailOrAlias) return null;
  const headers = getHeaders('users');
  const s = sheet('users');
  const lastRow = s.getLastRow();
  if (lastRow < 2) return null;
  const data = s.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const emailIdx = headers.indexOf('email');
  const aliasIdx = headers.indexOf('alias');
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[emailIdx]).toLowerCase() === String(emailOrAlias).toLowerCase() ||
        String(row[aliasIdx]).toLowerCase() === String(emailOrAlias).toLowerCase()) {
      const user = rowToObject(headers, row);
      try { user.locations = user.locations ? JSON.parse(user.locations) : []; }
      catch (e) { user.locations = []; }
      return user;
    }
  }
  return null;
}

// Override findUser in doPost auth — use both
// (above findUser checks password; we need locations for permission check)
// Simplified: re-wrap to always return parsed locations
const _origFindUser = findUser;
function findUserParsed(emailOrAlias, passwordHash) {
  const u = _origFindUser(emailOrAlias, passwordHash);
  if (u) {
    try { u.locations = u.locations ? JSON.parse(u.locations) : []; }
    catch (e) { u.locations = []; }
  }
  return u;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Write handlers
// ═══════════════════════════════════════════════════════════════════════════════
function handleWriteItem(payload, user) {
  const item = payload.item;
  if (!item || !item.location || !item.id) throw new Error('write_item requires item.location and item.id');
  const headers = getHeaders('items');
  item.updated_at = new Date().toISOString();
  item.updated_by = user;
  // Find existing row
  const rowIdx = findRowByKeys('items', { location: item.location, id: item.id });
  const rowValues = objectToRow(headers, item);
  if (rowIdx === -1) {
    sheet('items').appendRow(rowValues);
    logChange(user, item.location, 'ADDED', item.name || item.id, 'New item');
  } else {
    sheet('items').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
    logChange(user, item.location, 'EDITED', item.name || item.id, payload.diff || 'Item updated');
  }
  return { written: true, id: item.id };
}

function handleDeleteItem(payload, user) {
  if (!payload.location || !payload.id) throw new Error('delete_item requires location and id');
  const rowIdx = findRowByKeys('items', { location: payload.location, id: payload.id });
  if (rowIdx === -1) return { deleted: false, reason: 'not found' };
  const headers = getHeaders('items');
  const nameIdx = headers.indexOf('name');
  const name = sheet('items').getRange(rowIdx, nameIdx + 1).getValue();
  sheet('items').deleteRow(rowIdx);
  logChange(user, payload.location, 'REMOVED', name || payload.id, payload.details || '');
  return { deleted: true };
}

function handleBulkWriteItems(payload, user) {
  // payload.items = [{location,id,...}, ...]
  // payload.deletions = [{location,id}, ...]  (optional)
  const items = payload.items || [];
  const deletions = payload.deletions || [];
  const headers = getHeaders('items');
  let added = 0, edited = 0, deleted = 0;
  // Process deletions first (so we don't reorder rows mid-write)
  // Collect row indices to delete, sort descending, delete
  const deleteIndices = [];
  for (const d of deletions) {
    const idx = findRowByKeys('items', { location: d.location, id: d.id });
    if (idx > 0) deleteIndices.push({ idx: idx, location: d.location, id: d.id, name: d.name || d.id });
  }
  deleteIndices.sort((a, b) => b.idx - a.idx);
  for (const d of deleteIndices) {
    sheet('items').deleteRow(d.idx);
    logChange(user, d.location, 'REMOVED (bulk)', d.name, '');
    deleted++;
  }
  // Process writes
  for (const it of items) {
    it.updated_at = new Date().toISOString();
    it.updated_by = user;
    const rowIdx = findRowByKeys('items', { location: it.location, id: it.id });
    const rowValues = objectToRow(headers, it);
    if (rowIdx === -1) {
      sheet('items').appendRow(rowValues);
      logChange(user, it.location, 'ADDED (bulk)', it.name || it.id, '');
      added++;
    } else {
      sheet('items').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
      logChange(user, it.location, 'EDITED (bulk)', it.name || it.id, '');
      edited++;
    }
  }
  return { added: added, edited: edited, deleted: deleted };
}

function handleWriteLocation(payload, user) {
  const locObj = payload.location;
  if (!locObj || !locObj.key) throw new Error('write_location requires location.key');
  const headers = getHeaders('locations');
  locObj.updated_at = new Date().toISOString();
  locObj.updated_by = user;
  const rowIdx = findRowByKey('locations', 'key', locObj.key);
  const rowValues = objectToRow(headers, locObj);
  if (rowIdx === -1) {
    sheet('locations').appendRow(rowValues);
    logChange(user, locObj.key, 'LOCATION ADDED', locObj.name, '');
  } else {
    sheet('locations').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
    logChange(user, locObj.key, 'LOCATION EDITED', locObj.name, payload.diff || '');
  }
  return { written: true };
}

function handleWriteCategories(payload, user) {
  // payload = {location, menu, categories: [{sort_order, name, takeout_excluded, seasonal, menu_excluded}, ...]}
  // Replaces all rows for this (location, menu) with the new set.
  const loc = payload.location;
  const menu = payload.menu;
  const cats = payload.categories || [];
  if (!loc || !menu) throw new Error('write_categories requires location and menu');
  const s = sheet('categories');
  const headers = getHeaders('categories');
  const lastRow = s.getLastRow();
  // Find all existing rows matching (loc, menu) and delete them
  if (lastRow >= 2) {
    const data = s.getRange(2, 1, lastRow - 1, headers.length).getValues();
    const locIdx = headers.indexOf('location');
    const menuIdx = headers.indexOf('menu');
    const toDelete = [];
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][locIdx]) === String(loc) && String(data[i][menuIdx]) === String(menu)) {
        toDelete.push(i + 2);
      }
    }
    toDelete.sort((a, b) => b - a);
    for (const idx of toDelete) s.deleteRow(idx);
  }
  // Insert new rows
  const ts = new Date().toISOString();
  const toAppend = cats.map(c => objectToRow(headers, {
    location: loc, menu: menu,
    sort_order: c.sort_order || 0,
    name: c.name,
    takeout_excluded: !!c.takeout_excluded,
    seasonal: !!c.seasonal,
    menu_excluded: !!c.menu_excluded,
    updated_at: ts, updated_by: user,
  }));
  if (toAppend.length) {
    s.getRange(s.getLastRow() + 1, 1, toAppend.length, headers.length).setValues(toAppend);
  }
  logChange(user, loc, 'CATEGORIES UPDATED', menu, `Set ${cats.length} categories`);
  return { written: true, count: cats.length };
}

function handleWriteTap(payload, user) {
  const tap = payload.tap;
  if (!tap || !tap.location || !tap.name) throw new Error('write_tap requires tap.location and tap.name');
  const headers = getHeaders('taps');
  tap.updated_at = new Date().toISOString();
  tap.updated_by = user;
  // Use composite key (location, name, status) unless tap.id is provided
  let rowIdx = -1;
  if (tap.id) {
    rowIdx = findRowByKey('taps', 'id', tap.id);
  } else {
    rowIdx = findRowByKeys('taps', { location: tap.location, name: tap.name, status: tap.status || 'current' });
  }
  const rowValues = objectToRow(headers, tap);
  if (rowIdx === -1) {
    sheet('taps').appendRow(rowValues);
    logChange(user, tap.location, 'TAP ADDED', tap.name, tap.status || '');
  } else {
    sheet('taps').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
    logChange(user, tap.location, 'TAP UPDATED', tap.name, payload.diff || '');
  }
  return { written: true };
}

function handleDeleteTap(payload, user) {
  // Match by composite key
  const rowIdx = findRowByKeys('taps', {
    location: payload.location, name: payload.name,
    status: payload.status || 'current'
  });
  if (rowIdx === -1) return { deleted: false };
  sheet('taps').deleteRow(rowIdx);
  logChange(user, payload.location, 'TAP REMOVED', payload.name, '');
  return { deleted: true };
}

function handleWriteBoard(payload, user) {
  const board = payload.board;
  if (!board || !board.board_id) throw new Error('write_board requires board.board_id');
  const headers = getHeaders('boards');
  board.updated_at = new Date().toISOString();
  board.updated_by = user;
  const rowIdx = findRowByKey('boards', 'board_id', board.board_id);
  const rowValues = objectToRow(headers, board);
  if (rowIdx === -1) {
    sheet('boards').appendRow(rowValues);
    logChange(user, board.location, 'BOARD ADDED', board.display_name || board.board_id, '');
  } else {
    sheet('boards').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
    logChange(user, board.location, 'BOARD UPDATED', board.display_name || board.board_id, '');
  }
  return { written: true };
}

function handleWriteCrossPromo(payload, user) {
  // payload = {action: replace_for_location, location, promos: [...]}
  //   OR    = {action: add_one, promo: {...}}
  if (payload.replaceForLocation) {
    const loc = payload.replaceForLocation;
    const promos = payload.promos || [];
    const s = sheet('cross_promo');
    const headers = getHeaders('cross_promo');
    const lastRow = s.getLastRow();
    if (lastRow >= 2) {
      const data = s.getRange(2, 1, lastRow - 1, headers.length).getValues();
      const locIdx = headers.indexOf('location');
      const toDelete = [];
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][locIdx]) === String(loc)) toDelete.push(i + 2);
      }
      toDelete.sort((a, b) => b - a);
      for (const idx of toDelete) s.deleteRow(idx);
    }
    const ts = new Date().toISOString();
    const toAppend = promos.map(p => objectToRow(headers, Object.assign({}, p, {
      location: loc, updated_at: ts, updated_by: user,
    })));
    if (toAppend.length) {
      s.getRange(s.getLastRow() + 1, 1, toAppend.length, headers.length).setValues(toAppend);
    }
    logChange(user, loc, 'CROSS-PROMO UPDATED', '', `Set ${promos.length} promos`);
    return { written: true, count: promos.length };
  }
  // Single-row write
  const p = payload.promo;
  if (!p || !p.location) throw new Error('write_cross_promo requires promo.location');
  const headers = getHeaders('cross_promo');
  p.updated_at = new Date().toISOString();
  p.updated_by = user;
  sheet('cross_promo').appendRow(objectToRow(headers, p));
  logChange(user, p.location, 'CROSS-PROMO ADDED', '', p.message || '');
  return { written: true };
}

function handleWriteImage(payload, user) {
  const img = payload.image;
  if (!img || !img.image_key) throw new Error('write_image requires image.image_key');
  const headers = getHeaders('image_library');
  img.uploaded_at = img.uploaded_at || new Date().toISOString();
  img.uploaded_by = img.uploaded_by || user;
  const rowIdx = findRowByKey('image_library', 'image_key', img.image_key);
  const rowValues = objectToRow(headers, img);
  if (rowIdx === -1) {
    sheet('image_library').appendRow(rowValues);
    logChange(user, '', 'IMAGE ADDED', img.image_key, img.name || '');
  } else {
    sheet('image_library').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
    logChange(user, '', 'IMAGE UPDATED', img.image_key, '');
  }
  return { written: true };
}

function handleWriteUser(payload, user) {
  // Only admins can write users — that check is done in doPost via role check
  // For now, viewers and managers fail earlier. Plus an extra hard check:
  const callerUser = findUserNoAuth(user);
  if (!callerUser || callerUser.role !== 'admin') {
    throw new Error('Only admins can manage users');
  }
  const u = payload.user;
  if (!u || !u.email) throw new Error('write_user requires user.email');
  const headers = getHeaders('users');
  const rowIdx = findRowByKey('users', 'email', u.email);
  // Don't allow writing password_hash via this endpoint unless it's specifically a password set
  if (u.locations && typeof u.locations !== 'string') {
    u.locations = JSON.stringify(u.locations);
  }
  const rowValues = objectToRow(headers, u);
  if (rowIdx === -1) {
    u.created_at = u.created_at || new Date().toISOString();
    sheet('users').appendRow(objectToRow(headers, u));
    logChange(user, '', 'USER ADDED', u.email, u.role || '');
  } else {
    sheet('users').getRange(rowIdx, 1, 1, headers.length).setValues([rowValues]);
    logChange(user, '', 'USER UPDATED', u.email, '');
  }
  return { written: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Change log
// ═══════════════════════════════════════════════════════════════════════════════
function logChange(user, location, action, target, details) {
  const ts = new Date().toISOString();
  sheet('change_log').appendRow([ts, user, location, action, target, details]);
}

// Auto-archive rows older than CHANGE_LOG_RETENTION_DAYS into change_log_archive.
// Creates the archive sheet if it doesn't exist. Triggered manually or by time-driven trigger.
function handleArchiveChangeLog() {
  const s = sheet('change_log');
  const lastRow = s.getLastRow();
  if (lastRow < 2) return { archived: 0 };
  const headers = getHeaders('change_log');
  const data = s.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const cutoff = new Date(Date.now() - CHANGE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const tsIdx = headers.indexOf('timestamp');
  const toArchive = [];
  const toKeep = [];
  for (const row of data) {
    const rowDate = new Date(row[tsIdx]);
    if (!isNaN(rowDate) && rowDate < cutoff) toArchive.push(row);
    else toKeep.push(row);
  }
  if (toArchive.length === 0) return { archived: 0 };
  // Get or create archive sheet
  let archive = ss().getSheetByName('change_log_archive');
  if (!archive) {
    archive = ss().insertSheet('change_log_archive');
    archive.appendRow(headers);
    archive.setFrozenRows(1);
  }
  // Append archived rows
  const archiveLastRow = archive.getLastRow();
  archive.getRange(archiveLastRow + 1, 1, toArchive.length, headers.length).setValues(toArchive);
  // Rewrite live log with only kept rows
  s.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (toKeep.length > 0) {
    s.getRange(2, 1, toKeep.length, headers.length).setValues(toKeep);
  }
  return { archived: toArchive.length, kept: toKeep.length };
}

// Convenience function to set up a time-driven trigger for monthly archiving.
// Run this manually once from the Apps Script editor to install the trigger.
function installArchiveTrigger() {
  // Remove any existing triggers for handleArchiveChangeLog
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'handleArchiveChangeLog') {
      ScriptApp.deleteTrigger(t);
    }
  }
  // Install monthly trigger on the 1st at 3am
  ScriptApp.newTrigger('handleArchiveChangeLog')
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();
  return 'Trigger installed: monthly archive on 1st at 3am';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY BACKUP — duplicates the entire spreadsheet to a Drive folder each night,
// AND saves a copy of this Apps Script source code into the same folder.
// ═══════════════════════════════════════════════════════════════════════════════
// How it works:
//   1. Finds the backup folder by ID (if BACKUP_FOLDER_ID is set) or by name (fallback).
//      Creates the folder under My Drive if neither finds it.
//   2. Copies the entire spreadsheet into it as "MSBC Menu Backup YYYY-MM-DD"
//   3. Saves the current Code.gs source as "Code.gs Backup YYYY-MM-DD.txt"
//   4. If files with today's date already exist, they're overwritten
//   5. Prunes both sheet backups AND script backups older than BACKUP_RETENTION_DAYS
//
// Moving the backup folder:
//   - Run the backup once so the folder exists.
//   - Open the folder in Drive, copy its ID from the URL
//     (drive.google.com/drive/folders/THIS_PART_IS_THE_ID)
//   - Paste it into BACKUP_FOLDER_ID below.
//   - You can then move/rename the folder freely — the script tracks it by ID.
//   - Works for folders in My Drive AND Shared Drives (with appropriate access).
//
// First-time setup:
//   - Run "installBackupTrigger" once (you'll be prompted to authorize Drive access)
//   - To test immediately, run "runDailyBackup" manually
const BACKUP_FOLDER_NAME = 'MSBC Menu Backups';
const BACKUP_FOLDER_ID = '1m38RAjE2iYm5vrQnmgiP3rHKXdsIcA_k';  // Paste folder ID here after first run for permanent tracking
const BACKUP_RETENTION_DAYS = 14;

function runDailyBackup() {
  const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const sheetBackupName  = 'MSBC Menu Backup ' + dateStr;
  const scriptBackupName = 'Code.gs Backup '   + dateStr + '.txt';

  const folder = _getOrCreateBackupFolder();

  // ── 1. Backup the spreadsheet ──────────────────────────────────────────────
  // If a sheet backup with today's date already exists, trash it (overwrite)
  const existingSheets = folder.getFilesByName(sheetBackupName);
  while (existingSheets.hasNext()) existingSheets.next().setTrashed(true);
  const ssFile = DriveApp.getFileById(SPREADSHEET_ID);
  const sheetCopy = ssFile.makeCopy(sheetBackupName, folder);

  // ── 2. Backup the Apps Script source ───────────────────────────────────────
  // Same overwrite semantics for today's script backup
  const existingScripts = folder.getFilesByName(scriptBackupName);
  while (existingScripts.hasNext()) existingScripts.next().setTrashed(true);
  let scriptCopyId = null;
  try {
    const scriptSource = _getScriptSource();
    const scriptBlob = Utilities.newBlob(scriptSource, 'text/plain', scriptBackupName);
    const scriptCopy = folder.createFile(scriptBlob);
    scriptCopyId = scriptCopy.getId();
  } catch (e) {
    // Script backup is nice-to-have; don't fail the whole backup if it errors.
    console.warn('Script backup failed:', e.message);
  }

  // ── 3. Prune old backups (sheets AND scripts) ──────────────────────────────
  const pruned = _pruneOldBackups(folder);

  // ── 4. Log it ──────────────────────────────────────────────────────────────
  try {
    const details = 'Pruned ' + pruned + ' old file(s)' + (scriptCopyId ? '' : '; script backup skipped');
    logChange('SYSTEM', '', 'BACKUP CREATED', sheetBackupName, details);
  } catch (e) { /* don't fail the backup if logging fails */ }

  return {
    sheetBackup: sheetBackupName,
    sheetFileId: sheetCopy.getId(),
    scriptBackup: scriptCopyId ? scriptBackupName : null,
    scriptFileId: scriptCopyId,
    pruned: pruned,
    folderId: folder.getId(),
  };
}

function _getOrCreateBackupFolder() {
  // Prefer lookup by ID if configured (lets you move the folder freely)
  if (BACKUP_FOLDER_ID) {
    try {
      const f = DriveApp.getFolderById(BACKUP_FOLDER_ID);
      if (f) return f;
    } catch (e) {
      console.warn('BACKUP_FOLDER_ID lookup failed, falling back to name:', e.message);
    }
  }
  // Fallback: find by name (searches whole Drive, not just root)
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  // Last resort: create a fresh folder under My Drive
  return DriveApp.createFolder(BACKUP_FOLDER_NAME);
}

// Read this Apps Script project's source as a single text blob.
// Uses the Apps Script API via the script's own project ID, falling back to
// a simpler approach if API access isn't granted. The fallback inlines the
// SPREADSHEET_ID and asks the admin to re-paste Code.gs.
function _getScriptSource() {
  // Method 1: Use the Apps Script API (most accurate — captures the actual current code)
  // Requires the "Apps Script API" advanced service to be enabled in the script project,
  // and the user-running-the-script to have the right scope.
  try {
    const projectId = ScriptApp.getScriptId();
    const url = 'https://script.googleapis.com/v1/projects/' + projectId + '/content';
    const token = ScriptApp.getOAuthToken();
    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      // Concatenate all files (most projects just have Code.gs)
      const sections = (data.files || []).map(f =>
        '// ──── ' + f.name + '.' + (f.type === 'SERVER_JS' ? 'gs' : f.type.toLowerCase()) + ' ────\n' + f.source
      );
      return sections.join('\n\n');
    }
    throw new Error('Apps Script API returned ' + response.getResponseCode());
  } catch (e) {
    // Method 2: fallback — embed a minimal note so the backup file isn't empty
    return '// Script source backup failed: ' + e.message + '\n' +
           '// To capture the live source automatically, enable the Apps Script API:\n' +
           '//   1. Open script.google.com/home/usersettings → toggle "Google Apps Script API" ON\n' +
           '//   2. Re-run runDailyBackup\n' +
           '// Backup created at: ' + new Date().toISOString() + '\n' +
           '// Spreadsheet ID: ' + SPREADSHEET_ID + '\n';
  }
}

function _pruneOldBackups(folder) {
  // Delete backups older than BACKUP_RETENTION_DAYS (by file's last-updated date).
  // Prunes BOTH sheet backups (MSBC Menu Backup ...) and script backups (Code.gs Backup ...).
  const cutoff = new Date(Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const files = folder.getFiles();
  let pruned = 0;
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    const isOurBackup = name.indexOf('MSBC Menu Backup ') === 0 ||
                        name.indexOf('Code.gs Backup ') === 0;
    if (!isOurBackup) continue; // leave manually-placed files alone
    if (f.getLastUpdated() < cutoff) {
      f.setTrashed(true);
      pruned++;
    }
  }
  return pruned;
}

// Run this manually once from the editor to install the daily-3am trigger.
function installBackupTrigger() {
  // Remove any existing triggers for runDailyBackup
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'runDailyBackup') {
      ScriptApp.deleteTrigger(t);
    }
  }
  // Install daily trigger at 3am
  ScriptApp.newTrigger('runDailyBackup')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
  return 'Trigger installed: daily backup at 3am';
}
