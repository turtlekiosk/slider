/* shell-touch.js — On-screen touch gamepad overlay handlers.
 *
 * Bridges to the wasm via Module._pc_input_touch_button /
 * _pc_input_touch_stick (declared in pc/src/pc_pad.c under
 * __EMSCRIPTEN__). Visibility, layout, and opacity are user-configurable
 * via the settings dialog and persist in localStorage. */
(function() {
    // GameCube button bitmasks (match dolphin/pad.h)
    var GC = {
        LEFT: 0x0001, RIGHT: 0x0002, DOWN: 0x0004, UP: 0x0008,
        Z: 0x0010, R: 0x0020, L: 0x0040,
        A: 0x0100, B: 0x0200, X: 0x0400, Y: 0x0800,
        START: 0x1000
    };

    var root = document.getElementById('touch-controls');
    if (!root) return;

    // ---- Settings model + persistence -------------------------------
    var SETTINGS_KEY = 'acgc.touch.v1';
    var DEFAULTS = { enabled: 'auto', opacity: 25, style: 'simplified' };
    function loadSettings() {
        try {
            var raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return Object.assign({}, DEFAULTS);
            var parsed = JSON.parse(raw);
            return Object.assign({}, DEFAULTS, parsed);
        } catch (e) { return Object.assign({}, DEFAULTS); }
    }
    function saveSettings(s) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
        catch (e) {}
    }
    var settings = loadSettings();

    var hasTouch = ('maxTouchPoints' in navigator)
        ? navigator.maxTouchPoints > 0
        : ('ontouchstart' in window);

    // ---- Bridges into the wasm. The exports are *defined* on Module
    // immediately (as stub references) but throw if called before
    // the wasm module finishes initializing. Module.calledRun flips
    // to true once the runtime is up; gate every call on it.
    function wasmReady() {
        return !!(window.Module && window.Module.calledRun);
    }
    function callButton(mask, pressed) {
        if (!wasmReady()) return;
        var fn = Module._pc_input_touch_button;
        if (fn) fn(mask, pressed ? 1 : 0);
    }
    function callStick(x, y) {
        if (!wasmReady()) return;
        var fn = Module._pc_input_touch_stick;
        if (fn) fn(x | 0, y | 0);
    }
    function callCstick(x, y) {
        if (!wasmReady()) return;
        var fn = Module._pc_input_touch_cstick;
        if (fn) fn(x | 0, y | 0);
    }

    // Defensive: if the canvas ever loses focus (despite our mousedown
    // preventDefault on each control), refocus async so SDL2 doesn't
    // pause event processing.
    var canvasEl = document.getElementById('canvas');
    if (canvasEl) {
        canvasEl.addEventListener('blur', function() {
            queueMicrotask(function() {
                if (document.activeElement !== canvasEl) {
                    try { canvasEl.focus({ preventScroll: true }); } catch (e) {}
                }
            });
        });
    }
    // Also prevent the default focus-shift on the *touch* element so
    // the canvas keeps focus to begin with. mousedown is the event
    // that browsers consult for focus changes; intercepting it here
    // (in addition to pointerdown's preventDefault, which is meant to
    // do the same but isn't honored consistently on iOS Safari) is
    // the more reliable way to keep focus on the canvas.
    function preventFocusShift(el) {
        el.addEventListener('mousedown', function(ev) { ev.preventDefault(); });
        el.addEventListener('touchstart', function(ev) {
            /* Don't preventDefault here on the zone — would block scroll
             * gestures elsewhere. preventDefault is only safe within
             * controls themselves, where pointerdown already does it. */
        }, { passive: true });
    }

    // ---- Visibility + layout + opacity application -----------------
    function shouldShow() {
        if (settings.enabled === 'on')  return true;
        if (settings.enabled === 'off') return false;
        return hasTouch; /* auto */
    }
    function pickLayout() {
        /* Driven entirely by viewport aspect — landscape → B (controls
         * flank the canvas), portrait → A (controls below the canvas).
         * The user-facing override was removed; the auto choice was
         * what everyone used in practice. */
        return (window.innerWidth >= window.innerHeight) ? 'b' : 'a';
    }
    function applyVisibility() {
        if (shouldShow()) {
            root.classList.add('visible');
            root.setAttribute('aria-hidden', 'false');
            /* When the stick zone first becomes interactable, init nipple */
            ensureNipple();
            if (settings.style === 'full') ensureCstickNipple();
        } else {
            root.classList.remove('visible');
            root.setAttribute('aria-hidden', 'true');
            destroyNipple();
            destroyCstickNipple();
        }
        applyCanvasBias();
    }
    function applyLayout() {
        var l = pickLayout();
        root.classList.toggle('layout-a', l === 'a');
        root.classList.toggle('layout-b', l === 'b');
        /* nipplejs anchors to the zone; rebuild on layout change so the
         * overlay's coordinates match the new zone position. */
        if (root.classList.contains('visible')) {
            ensureNipple(true);
            ensureCstickNipple(true);
        }
        applyCanvasBias();
    }
    function applyStyle() {
        var s = settings.style === 'full' ? 'full' : 'simplified';
        root.classList.toggle('style-full', s === 'full');
        root.classList.toggle('style-simplified', s === 'simplified');
        /* C-stick zone visibility is gated by the style class; (re)build
         * or destroy its nipplejs instance to match. */
        if (s === 'full' && root.classList.contains('visible')) {
            ensureCstickNipple(true);
        } else {
            destroyCstickNipple();
        }
    }
    /* Bias the canvas higher in the viewport when controls occupy the
     * bottom (Layout A only). Landscape (Layout B) controls sit on the
     * sides, so the canvas can stay centered. */
    function applyCanvasBias() {
        var bias = root.classList.contains('visible') &&
                   root.classList.contains('layout-a');
        document.body.classList.toggle('tc-bias-top', bias);
    }
    function applyOpacity() {
        var sliderAlpha = settings.opacity / 100;
        var bg     = sliderAlpha.toFixed(3);
        var press  = Math.min(1, sliderAlpha + 0.27).toFixed(3);
        var stroke = Math.min(1, sliderAlpha + 0.22).toFixed(3);
        // Label tracks the slider directly so dragging it visibly fades
        // the button text alongside the background. Keep a small floor
        // so the labels don't disappear entirely at the low end.
        var label  = Math.max(0.15, Math.min(1, sliderAlpha + 0.10)).toFixed(3);
        // White labels lose contrast once the white-tinted background is
        // bright enough to wash them out. Switch the label/arrow base
        // color to a dark tone past that threshold so letters and d-pad
        // arrows stay legible at high opacity.
        var labelRgb = sliderAlpha >= 0.45 ? '70, 70, 70' : '255, 255, 255';
        root.style.setProperty('--tc-bg-alpha',         bg);
        root.style.setProperty('--tc-bg-pressed-alpha', press);
        root.style.setProperty('--tc-stroke-alpha',     stroke);
        root.style.setProperty('--tc-label-alpha',      label);
        root.style.setProperty('--tc-label-rgb',        labelRgb);
    }
    function applyAll() { applyVisibility(); applyLayout(); applyStyle(); applyOpacity(); }

    // ---- nipplejs analog stick -------------------------------------
    var nipple = null;
    function ensureNipple(forceRebuild) {
        var stickZone = document.getElementById('tc-stick-zone');
        if (!stickZone) return;
        if (typeof nipplejs === 'undefined') return; /* lib not loaded */
        if (nipple && !forceRebuild) return;
        destroyNipple();
        preventFocusShift(stickZone);
        nipple = nipplejs.create({
            zone:       stickZone,
            mode:       'dynamic',  /* floating: spawn at touch position */
            color:      '#d0d0d0',  /* soft off-white, easier on the eye than pure white */
            size:       160,        /* bigger than the 120 default */
            fadeTime:   100,
            threshold:  0.05,
            restJoystick: true
        });
        nipple.on('start', function() { root.classList.add('stick-active'); });
        nipple.on('move', function(_evt, data) {
            if (!data || !data.vector) return;
            /* nipplejs vector: x [-1..1] right, y [-1..1] up. GC stick
             * matches sign convention (+y = up), so we just scale. */
            callStick(
                Math.round(data.vector.x * 127),
                Math.round(data.vector.y * 127)
            );
        });
        nipple.on('end', function() {
            root.classList.remove('stick-active');
            callStick(0, 0);
        });
    }
    function destroyNipple() {
        if (!nipple) return; /* nothing to tear down — and avoid a wasm
                                call before init when called from early
                                applyLayout() during page load. */
        try { nipple.destroy(); } catch (e) {}
        nipple = null;
        callStick(0, 0);
    }

    /* C-stick — second nipplejs instance pinned to #tc-cstick-zone, only
     * active when style:full. Mirrors the main stick lifecycle. */
    var cstick = null;
    function ensureCstickNipple(forceRebuild) {
        if (settings.style !== 'full') return;
        var zone = document.getElementById('tc-cstick-zone');
        if (!zone) return;
        if (typeof nipplejs === 'undefined') return;
        if (cstick && !forceRebuild) return;
        destroyCstickNipple();
        preventFocusShift(zone);
        cstick = nipplejs.create({
            zone: zone,
            mode: 'dynamic',
            color: '#e6dc7a', /* soft yellow — matches GameCube C-stick */
            size: 140,
            fadeTime: 100,
            threshold: 0.05,
            restJoystick: true
        });
        cstick.on('start', function() { root.classList.add('cstick-active'); });
        cstick.on('move', function(_evt, data) {
            if (!data || !data.vector) return;
            callCstick(
                Math.round(data.vector.x * 127),
                Math.round(data.vector.y * 127)
            );
        });
        cstick.on('end', function() {
            root.classList.remove('cstick-active');
            callCstick(0, 0);
        });
    }
    function destroyCstickNipple() {
        if (!cstick) return;
        try { cstick.destroy(); } catch (e) {}
        cstick = null;
        callCstick(0, 0);
    }

    /* nipplejs is loaded via <script ... onload="window._nippleLoaded()">.
     * If it lands after applyVisibility ran, the onload handler retries
     * ensureNipple here. If it landed first, _nippleLoaded is wired up
     * but harmless — applyVisibility already saw nipplejs as defined. */
    window._nippleLoaded = function() {
        if (root.classList.contains('visible')) {
            ensureNipple();
            if (settings.style === 'full') ensureCstickNipple();
        }
    };
    if (typeof nipplejs !== 'undefined' && root.classList.contains('visible')) {
        ensureNipple();
        if (settings.style === 'full') ensureCstickNipple();
    }

    // ---- Simple buttons (A, B, Y, Start) ---------------------------
    function bindButton(el) {
        var mask = parseInt(el.getAttribute('data-tc-button'), 16);
        var activeId = null;
        var pressedAt = 0;
        var pendingRelease = 0;
        // Hold the press bit for at least ~50 ms (3 frames at 60 Hz)
        // so the wasm input poll definitely sees it. Modern Chromium
        // (notably 2024+ builds on Snapdragon 8 Gen 3 / Z Flip 6) can
        // coalesce a quick tap's pointerdown + pointerup into the
        // same JS task tick — the press bit gets set then cleared
        // before the wasm wakes up, and the tap is silently dropped.
        var MIN_HOLD_MS = 50;
        preventFocusShift(el);
        el.addEventListener('pointerdown', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (activeId !== null) return;
            if (pendingRelease) { clearTimeout(pendingRelease); pendingRelease = 0; }
            activeId = ev.pointerId;
            pressedAt = performance.now();
            try { el.setPointerCapture(ev.pointerId); } catch (e) {}
            el.classList.add('pressed');
            callButton(mask, 1);
        });
        var release = function(ev) {
            if (activeId === null || ev.pointerId !== activeId) return;
            ev.preventDefault();
            ev.stopPropagation();
            activeId = null;
            var elapsed = performance.now() - pressedAt;
            var doRelease = function() {
                el.classList.remove('pressed');
                callButton(mask, 0);
                pendingRelease = 0;
            };
            if (elapsed < MIN_HOLD_MS) {
                pendingRelease = setTimeout(doRelease, MIN_HOLD_MS - elapsed);
            } else {
                doRelease();
            }
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('lostpointercapture', release);
    }
    var simpleButtons = root.querySelectorAll('[data-tc-button]');
    for (var i = 0; i < simpleButtons.length; i++) bindButton(simpleButtons[i]);

    // ---- D-pad (4 directions, position-based, two simultaneous OK)
    var dpad = document.getElementById('tc-dpad');
    if (dpad) {
        var dpadActiveId = null;
        var dpadCurrent = 0;
        function dpadCompute(ev) {
            var rect = dpad.getBoundingClientRect();
            var dx = ev.clientX - (rect.left + rect.width  / 2);
            var dy = ev.clientY - (rect.top  + rect.height / 2);
            var thresh = rect.width * 0.12;
            var mask = 0;
            if (dx < -thresh) mask |= GC.LEFT;
            else if (dx > thresh) mask |= GC.RIGHT;
            if (dy < -thresh) mask |= GC.UP;
            else if (dy > thresh) mask |= GC.DOWN;
            return mask;
        }
        function dpadUpdate(ev) {
            var newMask = dpadCompute(ev);
            if (newMask === dpadCurrent) return;
            var released = dpadCurrent & ~newMask;
            var pressed  = newMask    & ~dpadCurrent;
            if (released) callButton(released, 0);
            if (pressed)  callButton(pressed,  1);
            dpadCurrent = newMask;
        }
        preventFocusShift(dpad);
        dpad.addEventListener('pointerdown', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (dpadActiveId !== null) return;
            dpadActiveId = ev.pointerId;
            try { dpad.setPointerCapture(ev.pointerId); } catch (e) {}
            dpad.classList.add('pressed');
            dpadUpdate(ev);
        });
        dpad.addEventListener('pointermove', function(ev) {
            if (ev.pointerId !== dpadActiveId) return;
            ev.preventDefault();
            ev.stopPropagation();
            dpadUpdate(ev);
        });
        var dpadRelease = function(ev) {
            if (dpadActiveId === null || ev.pointerId !== dpadActiveId) return;
            ev.preventDefault();
            ev.stopPropagation();
            dpad.classList.remove('pressed');
            if (dpadCurrent) {
                callButton(dpadCurrent, 0);
                dpadCurrent = 0;
            }
            dpadActiveId = null;
        };
        dpad.addEventListener('pointerup', dpadRelease);
        dpad.addEventListener('pointercancel', dpadRelease);
        dpad.addEventListener('lostpointercapture', dpadRelease);
    }

    // ---- Settings dialog wiring ------------------------------------
    var styleSwap  = document.getElementById('tc-style-swap');
    var opacityRng = document.getElementById('tc-opacity-range');
    var opacityVal = document.getElementById('tc-opacity-value');

    /* Floating swap button (top-right, next to fullscreen) — cycles the
     * touch overlay through simplified → full → off → simplified. The
     * "off" stop sets settings.enabled='off' so the layout dropdown in
     * the (now-removed) settings dialog and the rendered overlay agree. */
    if (styleSwap) {
        function currentMode() {
            if (settings.enabled === 'off') return 'off';
            return settings.style === 'full' ? 'full' : 'simplified';
        }
        function nextMode(mode) {
            if (mode === 'simplified') return 'full';
            if (mode === 'full')       return 'off';
            return 'simplified';
        }
        function updateStyleSwapTitle() {
            var next = nextMode(currentMode());
            styleSwap.title = next === 'off'
                ? 'Hide touch controls'
                : 'Switch to ' + next + ' touch controls';
        }
        updateStyleSwapTitle();
        styleSwap.addEventListener('click', function(ev) {
            ev.preventDefault();
            var next = nextMode(currentMode());
            if (next === 'off') {
                settings.enabled = 'off';
            } else {
                settings.enabled = 'on';
                settings.style = next;
            }
            saveSettings(settings);
            applyStyle();
            applyVisibility();
            updateStyleSwapTitle();
        });
    }
    if (opacityRng && opacityVal) {
        opacityRng.value = settings.opacity;
        opacityVal.textContent = settings.opacity + '%';
        opacityRng.addEventListener('input', function() {
            settings.opacity = parseInt(opacityRng.value, 10);
            opacityVal.textContent = settings.opacity + '%';
            applyOpacity(); /* live */
        });
        opacityRng.addEventListener('change', function() { saveSettings(settings); });
    }

    // ---- Layout follows orientation/resize -------------------------
    window.addEventListener('resize', applyLayout);
    window.addEventListener('orientationchange', function() {
        /* layout responds to inner{Width,Height}, which lag the
         * orientationchange event by a frame on most browsers. */
        requestAnimationFrame(applyLayout);
        setTimeout(applyLayout, 200);
    });

    applyAll();
})();
