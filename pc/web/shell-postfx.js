/* Display post-process filter — ASCII mode only.
 *
 * The other filters (CRT / LCD / CMYK halftone) live in C now: see
 * pc/src/pc_postfx.c. They run as a final fullscreen pass inside the
 * wasm's own GL context, sampling an FBO that the game renders into.
 *
 * ASCII stayed in JS because its glyph atlas is built at runtime via
 * Canvas2D (rendering monospace characters into a small texture), and
 * porting that to C would need an offline rasterizer. So this module
 * now:
 *   - owns the dropdown + localStorage persistence (single source of
 *     truth for the active mode);
 *   - pushes mode → wasm via Module._pc_postfx_set_mode(intCode) each
 *     time it changes, so C selects the right shader (or OFF for
 *     ascii/off). Integer codes (MODE_CODES) match the
 *     PC_POSTFX_* enum in pc/include/pc_postfx.h — keep in sync;
 *   - runs the ASCII overlay loop only when mode === 'ascii'.
 *
 * preserveDrawingBuffer:true on the main canvas (forced in shell.html)
 * is still needed because ASCII samples mainCanvas via texImage2D. */
(function () {
    var SETTINGS_KEY = 'acgc.postfx.v1';

    /* Mode-string → wasm enum code. Must match PC_POSTFX_* in
     * pc/include/pc_postfx.h. 'ascii' maps to OFF because C doesn't
     * render ASCII — the JS overlay loop below does. */
    var MODE_CODES = {
        'off':            0,
        'crt-basic':      1,
        'crt-full':       2,
        'lcd':            3,
        'cmyk-halftone':  4,
        'ascii':          0
    };

    /* ---- ASCII config ------------------------------------------------ */
    /* Paul Bourke's 69-char brightness ramp, then re-sorted by measured
     * ink density of the actual rendered font (corrects the few places
     * Bourke's hand-sort diverges from what the font produces). */
    var CHARS  = ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
    var CELL   = 4;

    CHARS = (function sortRampByDensity(chars) {
        var c = document.createElement('canvas');
        c.width = CELL;
        c.height = CELL;
        var ctx = c.getContext('2d');
        ctx.font = (CELL - 1) + 'px "Fragment Mono", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var entries = [];
        for (var i = 0; i < chars.length; i++) {
            ctx.clearRect(0, 0, CELL, CELL);
            ctx.fillStyle = '#fff';
            ctx.fillText(chars[i], CELL / 2, CELL / 2 + 0.5);
            var data = ctx.getImageData(0, 0, CELL, CELL).data;
            var sum = 0;
            for (var j = 3; j < data.length; j += 4) sum += data[j];
            entries.push({ ch: chars[i], coverage: sum });
        }
        entries.sort(function (a, b) { return a.coverage - b.coverage; });
        return entries.map(function (m) { return m.ch; }).join('');
    })(CHARS);

    /* ---- settings ---------------------------------------------------- */
    /* Mode: off | ascii | crt-basic | crt-full | lcd | cmyk-halftone */
    var DEFAULTS = { mode: 'off' };
    function loadSettings() {
        try {
            var raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
        } catch (e) {}
        return Object.assign({}, DEFAULTS);
    }
    function saveSettings(s) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
    }
    var settings = loadSettings();

    /* ---- glyph atlas (ASCII) ----------------------------------------- */
    function buildAtlas() {
        var c = document.createElement('canvas');
        c.width  = CHARS.length * CELL;
        c.height = CELL;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#fff';
        ctx.font = (CELL - 1) + 'px "Fragment Mono", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (var i = 0; i < CHARS.length; i++) {
            ctx.fillText(CHARS[i], i * CELL + CELL / 2, CELL / 2 + 0.5);
        }
        return c;
    }

    /* ---- shaders -----------------------------------------------------
     * Only the ASCII vs/fs are loaded now. shaders/postfx-vs.js and
     * postfx-fs-ascii.js attach to window.acgcPostfxShaders before this
     * file runs. */
    var SHADER_SRC = window.acgcPostfxShaders || {};
    var VS         = SHADER_SRC.vs;
    var FS_ASCII   = SHADER_SRC.fsAscii;

    function compile(gl, type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[postfx] shader compile error:', gl.getShaderInfoLog(s));
            gl.deleteShader(s);
            return null;
        }
        return s;
    }
    function link(gl, vs, fs) {
        var p = gl.createProgram();
        gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            console.error('[postfx] program link error:', gl.getProgramInfoLog(p));
            gl.deleteProgram(p);
            return null;
        }
        return p;
    }

    /* ---- module state ------------------------------------------------ */
    var mainCanvas, overlay, gl, vao;
    var progAscii = null;
    var gameTex, atlasTex;
    var rafId = null;
    var uAscii = {};
    var initFailed = false;

    function init() {
        if (gl || initFailed) return !!gl;
        mainCanvas = document.getElementById('canvas');
        overlay    = document.getElementById('postfx-overlay');
        if (!mainCanvas || !overlay) { initFailed = true; return false; }
        if (!VS || !FS_ASCII) {
            console.error('[postfx] ASCII shader sources missing; '
                + 'shaders/postfx-vs.js and postfx-fs-ascii.js must load '
                + 'before shell-postfx.js');
            initFailed = true; return false;
        }

        gl = overlay.getContext('webgl2', {
            alpha: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
            antialias: false
        });
        if (!gl) { initFailed = true; return false; }

        var vs = compile(gl, gl.VERTEX_SHADER,   VS);
        var fs = compile(gl, gl.FRAGMENT_SHADER, FS_ASCII);
        if (!vs || !fs) { initFailed = true; return false; }
        progAscii = link(gl, vs, fs);
        if (!progAscii) { initFailed = true; return false; }

        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        var vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1,  3, -1, -1,  3]), gl.STATIC_DRAW);
        var aLoc = gl.getAttribLocation(progAscii, 'a_pos');
        gl.enableVertexAttribArray(aLoc);
        gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        uAscii.game       = gl.getUniformLocation(progAscii, 'u_game');
        uAscii.atlas      = gl.getUniformLocation(progAscii, 'u_atlas');
        uAscii.canvasSize = gl.getUniformLocation(progAscii, 'u_canvasSize');
        uAscii.cell       = gl.getUniformLocation(progAscii, 'u_cell');
        uAscii.numGlyphs  = gl.getUniformLocation(progAscii, 'u_numGlyphs');

        gameTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, gameTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        atlasTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, atlasTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buildAtlas());

        return true;
    }

    function syncSize() {
        var w = mainCanvas.width  | 0;
        var h = mainCanvas.height | 0;
        if (w === 0 || h === 0) return false;
        if (overlay.width !== w || overlay.height !== h) {
            overlay.width  = w;
            overlay.height = h;
            gl.viewport(0, 0, w, h);
        }
        var rect = mainCanvas.getBoundingClientRect();
        overlay.style.left   = rect.left   + 'px';
        overlay.style.top    = rect.top    + 'px';
        overlay.style.width  = rect.width  + 'px';
        overlay.style.height = rect.height + 'px';
        return true;
    }

    function frame() {
        rafId = null;
        if (settings.mode !== 'ascii') return;
        if (!gl && !init()) return;
        if (!syncSize()) {
            rafId = requestAnimationFrame(frame); return;
        }

        gl.bindTexture(gl.TEXTURE_2D, gameTex);
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mainCanvas);
        } catch (e) {
            rafId = requestAnimationFrame(frame); return;
        }

        gl.useProgram(progAscii);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gameTex);
        gl.uniform1i(uAscii.game, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlasTex);
        gl.uniform1i(uAscii.atlas, 1);
        gl.uniform2f(uAscii.canvasSize, overlay.width, overlay.height);
        gl.uniform1f(uAscii.cell, CELL);
        gl.uniform1f(uAscii.numGlyphs, CHARS.length);

        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        rafId = requestAnimationFrame(frame);
    }

    /* Push the current mode into the wasm-side postfx state. Safe to
     * call before Module is ready — we no-op until the export exists
     * and then re-push on runtime-init via the boot path below. */
    function pushModeToWasm(mode) {
        if (typeof Module === 'undefined') return;
        var fn = Module._pc_postfx_set_mode;
        if (!fn) return;
        var code = MODE_CODES[mode];
        if (code === undefined) code = 0;
        try { fn(code); } catch (e) { /* wasm not ready yet */ }
    }

    function setMode(mode) {
        if (mode !== 'off' && mode !== 'ascii' &&
            mode !== 'crt-basic' && mode !== 'crt-full' &&
            mode !== 'lcd' && mode !== 'cmyk-halftone') mode = 'off';
        settings.mode = mode;
        saveSettings(settings);

        /* C-side handles crt/lcd/halftone; ascii/off pass through and
         * leave the JS overlay to do its thing (or nothing). */
        pushModeToWasm(mode);

        var ov = document.getElementById('postfx-overlay');
        if (ov) ov.style.display = (mode === 'ascii') ? 'block' : 'none';
        if (mode === 'ascii' && rafId === null) {
            rafId = requestAnimationFrame(frame);
        }
    }

    /* Public surface for the settings menu wiring. */
    window.acgcPostfx = {
        getMode: function () { return settings.mode; },
        setMode: setMode
    };

    function boot() {
        if (!document.getElementById('postfx-overlay')) {
            requestAnimationFrame(boot); return;
        }
        var sel = document.getElementById('postfx-mode-select');
        if (sel) {
            sel.value = settings.mode;
            sel.addEventListener('change', function () { setMode(sel.value); });
        }
        /* Apply settings now. pushModeToWasm() is a no-op if the wasm
         * runtime hasn't initialized yet; we re-push from
         * onRuntimeInitialized so the C side picks up the saved mode
         * once it's listening. */
        setMode(settings.mode);

        if (typeof Module !== 'undefined') {
            var prev = Module.onRuntimeInitialized;
            Module.onRuntimeInitialized = function () {
                if (prev) try { prev(); } catch (e) {}
                pushModeToWasm(settings.mode);
            };
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
