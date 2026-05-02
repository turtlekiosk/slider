/* shell-saves.js — Save export, import, slot-summary helpers, and the
 * ROM-picker save-slot-import IIFE.
 *
 * Loaded as a deferred top-level script in shell.html. All functions
 * declared here at top level become window.* — the rest of shell.html
 * (notably the settings-menu code) calls summarizeSlot, stampSave,
 * loadStamp, clearStamp directly without window.* prefixes, which works
 * because both scripts share a global scope.
 *
 * Externals it depends on: FS (Emscripten's MEMFS/IDBFS bridge), Module
 * (for __save_ready), the DOM ids #rom-saves / #rom-saves-file /
 * #rom-saves-status / #rom-import-* / #rom-export-* / #rom-remove-*
 * (defined in shell.html), and the helpers withAudioSilenced (defined
 * in shell.html's main script). */

// ----- Save export -----
// Reads GCI saves out of the IDBFS-backed /save tree and triggers
// browser downloads. Exposed as window.exportSave(slot?) so a UI
// element can be wired up later. `slot`:
//   'a'  → only Card A's primary GCI (DobutsunomoriP_MURA.gci)
//   'b'  → every .gci found in /save/card_b/ (Card B is BYO town;
//          filename is whatever the user dropped in)
//   omit → both A and B (default)
// Returns the count of files that were downloaded (0 if nothing).
var CARD_A_DIR        = '/save/card_a';
var CARD_B_DIR        = '/save/card_b';
var CARD_A_GCI        = 'DobutsunomoriP_MURA.gci';
function _exportTimestamp() {
    var pad2 = function(n) { return ('0' + n).slice(-2); };
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
           '-' + pad2(d.getHours()) + pad2(d.getMinutes());
}
function _downloadBytes(bytes, fileName) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url  = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}
function _exportOneFile(path, baseName, stamp) {
    var bytes;
    try {
        bytes = FS.readFile(path);
    } catch (e) {
        return false;
    }
    var stampedName = baseName.replace(/\.gci$/i, '') + '-' + stamp + '.gci';
    _downloadBytes(bytes, stampedName);
    console.log('[save-export] downloaded', stampedName,
                '(' + bytes.length + ' bytes from ' + path + ')');
    return true;
}
function _listGcisIn(dir) {
    try {
        return FS.readdir(dir).filter(function(n) {
            return /\.gci$/i.test(n) && n !== '.' && n !== '..';
        });
    } catch (e) {
        return [];
    }
}
function exportSave(slot) {
    if (typeof FS === 'undefined') {
        console.warn('[save-export] FS not ready');
        return 0;
    }
    // Best-effort flush MEMFS → IDBFS; the read below uses MEMFS
    // either way, so this is just for durability.
    try { FS.syncfs(false, function() {}); } catch (e) {}
    var stamp = _exportTimestamp();
    var count = 0;
    if (slot === undefined || slot === 'a') {
        if (_exportOneFile(CARD_A_DIR + '/' + CARD_A_GCI, CARD_A_GCI, stamp)) count++;
        else if (slot === 'a') console.warn('[save-export] no save at', CARD_A_DIR + '/' + CARD_A_GCI);
    }
    if (slot === undefined || slot === 'b') {
        var bGcis = _listGcisIn(CARD_B_DIR);
        bGcis.forEach(function(name) {
            if (_exportOneFile(CARD_B_DIR + '/' + name, name, stamp)) count++;
        });
        if (slot === 'b' && bGcis.length === 0) {
            console.warn('[save-export] no .gci files in', CARD_B_DIR);
        }
    }
    if (count === 0 && slot === undefined) {
        console.warn('[save-export] no save data found in either slot');
    }
    return count;
}
window.exportSave = exportSave;

// ----- Save import -----
// Writes a GCI into the IDBFS-backed /save tree. Symmetric to
// exportSave; intended to be wired to a UI element later.
//   slot: 'a' (overwrites the canonical Card A save) or 'b'
//         (drops the file into card_b/ for visiting)
//   src : File / Blob / ArrayBuffer / Uint8Array
// Returns a Promise that resolves to true on success, false on
// validation/IO failure. Validation: GCI header gameName must
// be "GAFE" (USA AC); for slot 'a' the embedded fileName must
// additionally be "DobutsunomoriP_MURA" so a rogue Card B GCI
// can't clobber the real save.
function _toUint8Array(src) {
    return new Promise(function(resolve, reject) {
        if (src instanceof Uint8Array) { resolve(src); return; }
        if (src instanceof ArrayBuffer) { resolve(new Uint8Array(src)); return; }
        if (src && typeof src.arrayBuffer === 'function') {
            src.arrayBuffer().then(function(ab) { resolve(new Uint8Array(ab)); }, reject);
            return;
        }
        reject(new Error('importSave: unsupported source (need File/Blob/ArrayBuffer/Uint8Array)'));
    });
}
function _readGciFileName(bytes) {
    if (bytes.length < 0x28) return '';
    var name = '';
    for (var i = 0x08; i < 0x28; i++) {
        var c = bytes[i];
        if (c === 0) break;
        name += String.fromCharCode(c);
    }
    return name;
}
function _validateGciHeader(bytes) {
    if (bytes.length < 0x40) return 'file too small to be a GCI (need ≥64 bytes)';
    // gameName "GAFE" (USA AC); other regions wouldn't run anyway
    // since the port is built for GAFE01 Rev 0.
    if (bytes[0] !== 0x47 /* G */ || bytes[1] !== 0x41 /* A */ ||
        bytes[2] !== 0x46 /* F */ || bytes[3] !== 0x45 /* E */) {
        return 'not a USA Animal Crossing GCI (gameName ≠ "GAFE")';
    }
    return null;
}
function importSave(slot, src) {
    return _toUint8Array(src).then(function(bytes) {
        if (typeof FS === 'undefined') {
            console.warn('[save-import] FS not ready');
            return false;
        }
        var headerErr = _validateGciHeader(bytes);
        if (headerErr) {
            console.warn('[save-import]', headerErr);
            return false;
        }
        var embeddedName = _readGciFileName(bytes);
        var path;
        if (slot === 'a') {
            if (embeddedName !== 'DobutsunomoriP_MURA') {
                console.warn('[save-import] Card A requires DobutsunomoriP_MURA, got "' +
                             embeddedName + '"');
                return false;
            }
            try { FS.mkdir(CARD_A_DIR); } catch (e) { /* exists */ }
            path = CARD_A_DIR + '/' + CARD_A_GCI;
        } else if (slot === 'b') {
            if (!embeddedName) {
                console.warn('[save-import] GCI has empty embedded filename');
                return false;
            }
            try { FS.mkdir(CARD_B_DIR); } catch (e) { /* exists */ }
            path = CARD_B_DIR + '/' + embeddedName + '.gci';
        } else {
            console.warn('[save-import] slot must be "a" or "b"');
            return false;
        }
        try {
            FS.writeFile(path, bytes);
        } catch (e) {
            console.warn('[save-import] write failed:', e && e.message);
            return false;
        }
        // Persist to IndexedDB so the import survives reload.
        return new Promise(function(resolve) {
            FS.syncfs(false, function(err) {
                if (err) {
                    console.warn('[save-import] syncfs failed:', err);
                    resolve(false);
                    return;
                }
                console.log('[save-import] wrote', path,
                            '(' + bytes.length + ' bytes)');
                resolve(true);
            });
        });
    }).catch(function(err) {
        console.warn('[save-import]', err && err.message);
        return false;
    });
}
window.importSave = importSave;

// Persist a per-slot last-write timestamp in localStorage so it
// survives page reloads. FS.stat().mtime can't — IDBFS rehydrates
// MEMFS on load, which resets every file's mtime to "now".
// Called from C (pc_web_sync_save) on each successful save commit
// and from JS importSave on user-triggered imports.
function _stampKey(slot) { return 'save:card_' + slot + ':mtime'; }
function stampSave(slot) {
    try { localStorage.setItem(_stampKey(slot), String(Date.now())); }
    catch (e) { /* localStorage unavailable — ignore */ }
}
function loadStamp(slot) {
    try {
        var v = localStorage.getItem(_stampKey(slot));
        var n = v ? parseInt(v, 10) : 0;
        return isFinite(n) && n > 0 ? n : 0;
    } catch (e) { return 0; }
}
function clearStamp(slot) {
    try { localStorage.removeItem(_stampKey(slot)); } catch (e) {}
}
window._stampSave = stampSave;

// Slot summary helpers — shared by the ROM picker and the settings menu.
// The .gci filename is uninformative on its own (Card A always uses the
// same name, Card B varies by town but the user already knows what
// they imported). Show size and a relative timestamp instead.
function _formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) {
        var kb = n / 1024;
        return (kb >= 10 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/, '')) + ' KB';
    }
    var mb = n / (1024 * 1024);
    return (mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/, '')) + ' MB';
}
function _formatRelativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 0) diff = 0;
    var sec = Math.floor(diff / 1000);
    if (sec < 60)    return 'just now';
    var min = Math.floor(sec / 60);
    if (min < 60)    return min + ' min ago';
    var hr  = Math.floor(min / 60);
    if (hr  < 24)    return hr  + (hr  === 1 ? ' hr ago'  : ' hrs ago');
    var day = Math.floor(hr / 24);
    if (day < 7)     return day + (day === 1 ? ' day ago' : ' days ago');
    try { return new Date(ts).toLocaleDateString(); }
    catch (e) { return ''; }
}
function summarizeSlot(slot, dir, files, verb) {
    if (!files || files.length === 0) return 'Empty';
    var totalSize = 0;
    for (var i = 0; i < files.length; i++) {
        try { totalSize += (FS.stat(dir + '/' + files[i]).size | 0); }
        catch (e) { /* ignore — best-effort summary */ }
    }
    // Prefer the localStorage stamp (set by importSave + the C save
    // path on every successful write). Fall back to FS.stat().mtime
    // for files written this session before any stamp exists, which
    // is at least accurate within the current page load.
    var ts = loadStamp(slot);
    if (!ts) {
        for (var j = 0; j < files.length; j++) {
            try {
                var st = FS.stat(dir + '/' + files[j]);
                var t = 0;
                if (st.mtime instanceof Date) t = st.mtime.getTime();
                else if (typeof st.mtime === 'number') t = st.mtime;
                if (t > ts) ts = t;
            } catch (e) {}
        }
    }
    var parts = [];
    if (files.length > 1) parts.push(files.length + ' files');
    if (totalSize > 0)    parts.push(_formatBytes(totalSize));
    var rel = _formatRelativeTime(ts);
    if (rel)              parts.push((verb || 'imported') + ' ' + rel);
    return parts.length ? parts.join(' · ') : 'Save data present';
}

// ----- ROM picker: optional save-slot import -----
// Two slot blocks (Card A / Card B). Each has Import + Remove.
// Import reuses the same window.importSave path as the in-game
// settings menu (so header/filename validation is identical).
// Remove unlinks every .gci in that slot's directory and persists
// the deletion via FS.syncfs(false). State is refreshed on picker
// show so previously-persisted saves from earlier sessions get
// surfaced too.
(function wireRomPickerSaveImport() {
    var root   = document.getElementById('rom-saves');
    var input  = document.getElementById('rom-saves-file');
    var status = document.getElementById('rom-saves-status');
    if (!root || !input || !status) return;

    var SLOTS = {
        a: { dir: '/save/card_a', el: root.querySelector('.rom-saves-slot[data-slot="a"]'),
             btnImport: document.getElementById('rom-import-a'),
             btnExport: document.getElementById('rom-export-a'),
             btnRemove: document.getElementById('rom-remove-a') },
        b: { dir: '/save/card_b', el: root.querySelector('.rom-saves-slot[data-slot="b"]'),
             btnImport: document.getElementById('rom-import-b'),
             btnExport: document.getElementById('rom-export-b'),
             btnRemove: document.getElementById('rom-remove-b') }
    };

    function setStatus(text, kind) {
        status.textContent = text || '';
        status.className = 'rom-saves-status' + (kind ? ' ' + kind : '');
    }
    function listGcis(dir) {
        try {
            return FS.readdir(dir).filter(function(n) {
                return /\.gci$/i.test(n) && n !== '.' && n !== '..';
            });
        } catch (e) { return []; }
    }
    function refreshSlotUi(slot) {
        var s = SLOTS[slot];
        if (!s || !s.el) return;
        if (typeof FS === 'undefined') return;
        // Don't refresh until IDBFS for /save has finished mounting.
        // FS.readdir would otherwise return empty (the directory
        // exists but hasn't been hydrated yet), making us flash
        // "Empty" before "Checking…" had a chance to be replaced
        // by the real state. The runtime-init poll re-calls this
        // once __save_ready flips.
        if (!Module || !Module.__save_ready) return;
        var files = listGcis(s.dir);
        var stateEl = s.el.querySelector('.rom-saves-slot-state');
        // Reveal action buttons now that the check has resolved.
        // Import is always available; Delete shows but is disabled
        // when empty; Export only appears when the slot has data.
        if (s.btnImport) s.btnImport.style.display = '';
        if (s.btnRemove) s.btnRemove.style.display = '';
        if (files.length > 0) {
            s.el.classList.add('has-data');
            stateEl.textContent = summarizeSlot(slot, s.dir, files);
            if (s.btnRemove) s.btnRemove.disabled = false;
            if (s.btnExport) s.btnExport.style.display = '';
        } else {
            s.el.classList.remove('has-data');
            stateEl.textContent = 'Empty';
            if (s.btnRemove) s.btnRemove.disabled = true;
            if (s.btnExport) s.btnExport.style.display = 'none';
        }
    }
    function refreshAll() { refreshSlotUi('a'); refreshSlotUi('b'); }
    /* Expose for the picker's onRuntimeInitialized hook so the
     * card slots re-read their state once IDBFS is mounted. */
    root._refresh = refreshAll;

    function pick(slot) {
        var s = SLOTS[slot];
        if (s && typeof FS !== 'undefined') {
            var existing = listGcis(s.dir);
            if (existing.length > 0) {
                var label  = 'Card ' + slot.toUpperCase();
                var detail = summarizeSlot(slot, s.dir, existing, 'last saved');
                var msg = label + ' already has save data (' + detail + ').\n\n' +
                          'Importing will overwrite it. Continue?';
                if (!withAudioSilenced(function() { return confirm(msg); })) {
                    return;
                }
            }
        }
        input.value = '';
        input.dataset.slot = slot;
        input.click();
    }
    function removeSlot(slot) {
        var s = SLOTS[slot];
        if (!s || typeof FS === 'undefined') return;
        var files = listGcis(s.dir);
        if (files.length === 0) return;
        var label  = 'Card ' + slot.toUpperCase();
        var detail = summarizeSlot(slot, s.dir, files, 'last saved');
        var msg = 'Delete ' + label + ' save data (' + detail + ')?\n\nThis cannot be undone.';
        if (!withAudioSilenced(function() { return confirm(msg); })) {
            return;
        }
        files.forEach(function(name) {
            try { FS.unlink(s.dir + '/' + name); }
            catch (e) { console.warn('[rom-saves] unlink failed:', s.dir + '/' + name, e && e.message); }
        });
        FS.syncfs(false, function(err) {
            if (err) {
                setStatus('Persist failed: ' + err, 'error');
                return;
            }
            clearStamp(slot);
            setStatus('Deleted Card ' + slot.toUpperCase() + ' save data.', 'ok');
            refreshSlotUi(slot);
        });
    }

    function exportSlot(slot, btn) {
        try {
            var n = window.exportSave(slot);
            if (n > 0) {
                setStatus('Exported ' + n + ' file' + (n === 1 ? '' : 's') +
                          ' from Card ' + slot.toUpperCase() + '.', 'ok');
            } else {
                setStatus('No save found in slot ' + slot.toUpperCase() + '.', 'error');
            }
        } catch (e) {
            setStatus('Export failed: ' + (e && e.message || e), 'error');
        }
    }

    SLOTS.a.btnImport.addEventListener('click', function() { pick('a'); });
    SLOTS.b.btnImport.addEventListener('click', function() { pick('b'); });
    SLOTS.a.btnExport.addEventListener('click', function() { exportSlot('a', this); });
    SLOTS.b.btnExport.addEventListener('click', function() { exportSlot('b', this); });
    SLOTS.a.btnRemove.addEventListener('click', function() { removeSlot('a'); });
    SLOTS.b.btnRemove.addEventListener('click', function() { removeSlot('b'); });

    input.addEventListener('change', function() {
        var f = this.files && this.files[0];
        if (!f) return;
        var slot = this.dataset.slot;
        setStatus('Importing to Card ' + slot.toUpperCase() + '…');
        window.importSave(slot, f).then(function(ok) {
            if (ok) {
                stampSave(slot);
                setStatus('Imported to Card ' + slot.toUpperCase() +
                          '. Will load when the game boots.', 'ok');
            } else {
                setStatus('Import failed — see console for details.', 'error');
            }
            refreshSlotUi(slot);
        });
    });

    /* Re-read slot state every time the picker is shown so
     * previously-persisted saves are reflected. Hooked into
     * showRomPicker/hideRomPicker via window._onPickerShow. */
    window._onPickerShow = function() { refreshAll(); };
})();
