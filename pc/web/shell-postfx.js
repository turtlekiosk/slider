/* Display post-process filter. Lives entirely in the web layer —
 * captures the wasm's WebGL canvas each frame, runs a shader on a
 * second canvas overlay, and presents that on top of the game.
 *
 * Supported modes:
 *   off          — overlay hidden, game renders directly
 *   ascii        — character-cell ASCII art tinted by underlying color
 *   crt-basic    — curvature + subtle scanlines + soft vignette
 *   crt-full     — adds RGB-triad aperture grille, heavier scanlines,
 *                  brightness compensation; punchier arcade-monitor look
 *   lcd          — Mattias-style sub-pixel grid (RGB column stripes +
 *                  row gaps + backlight floor); handheld-screen look
 *   cmyk-halftone — 4-ink CMYK halftone with rotated screens, riso-
 *                  style spot inks, per-ink misregistration, and
 *                  paper grain on warm cream substrate
 *
 * Self-contained module. Wires into the settings menu via the
 * #postfx-mode-select <select>. Persists state under SETTINGS_KEY.
 *
 * Requires preserveDrawingBuffer:true on the main canvas's WebGL
 * context — otherwise the buffer is cleared on swap and we'd capture
 * black. The patch lives in shell.html (runs before wasm init). */
(function () {
    var SETTINGS_KEY = 'acgc.postfx.v1';

    /* ---- ASCII config ------------------------------------------------ */
    /* Paul Bourke's classic 69-char brightness ramp. Hand-sorted by
     * Bourke from least to most ink density; sortRampByDensity below
     * re-sorts based on the actual rendered font, which mostly agrees
     * with Bourke's ordering and corrects the few divergences. */
    var CHARS  = ' .\'`^",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
    var CELL   = 4;

    /* Sort the ramp by actual measured ink density. Renders each char
     * to a temp canvas at the atlas cell size, sums alpha across the
     * cell to get a coverage score, sorts ascending. Done once at
     * module load using the same font that buildAtlas() uses, so the
     * sorting matches the rendered atlas regardless of which fallback
     * font the browser picks for any given codepoint. */
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

    /* CRT preset uniform values. crt-basic stays subtle (no grille, no
     * boost, light scanlines) for clean rendering on high-DPR mobile
     * displays where the per-pixel RGB-triad pattern of crt-full would
     * moiré. crt-full adds the grille and bumps scanlines/brightness
     * for a punchier arcade-monitor look — best on lower-DPR desktop
     * displays where the grille pattern lands cleanly on pixels. */
    var CRT_PRESETS = {
        'crt-basic': { grille: 0.0,  boost: 1.0,  scanIntensity: 0.10 },
        'crt-full':  { grille: 0.18, boost: 1.18, scanIntensity: 0.40 }
    };

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
    /* Renders the ramp into a (CHARS.length * CELL) × CELL canvas. White
     * glyphs on transparent black; the shader uses the red channel as a
     * coverage mask. */
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
     * Source lives in shaders/postfx-vs.js, postfx-fs-ascii.js,
     * postfx-fs-crt.js, postfx-fs-lcd.js, postfx-fs-halftone.js,
     * which attach to window.acgcPostfxShaders. shell.html loads
     * those files before this one (script tags are deferred and
     * execute in document order), so the namespace is populated
     * by the time we read it. */
    var SHADER_SRC = window.acgcPostfxShaders || {};
    var VS         = SHADER_SRC.vs;
    var FS_ASCII   = SHADER_SRC.fsAscii;
    var FS_CRT     = SHADER_SRC.fsCrt;
    var FS_LCD     = SHADER_SRC.fsLcd;
    var FS_HT      = SHADER_SRC.fsHalftone;

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
    var progAscii = null, progCrt = null, progLcd = null, progHt = null;
    var gameTex, atlasTex;
    var rafId = null;
    var uAscii = {}, uCrt = {}, uLcd = {}, uHt = {};
    var initFailed = false;

    function init() {
        if (gl || initFailed) return !!gl;
        mainCanvas = document.getElementById('canvas');
        overlay    = document.getElementById('postfx-overlay');
        if (!mainCanvas || !overlay) { initFailed = true; return false; }
        if (!VS || !FS_ASCII || !FS_CRT || !FS_LCD || !FS_HT) {
            console.error('[postfx] shader sources missing; '
                + 'shaders/postfx-vs.js, postfx-fs-ascii.js, postfx-fs-crt.js, '
                + 'postfx-fs-lcd.js, postfx-fs-halftone.js must be loaded '
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

        var vs    = compile(gl, gl.VERTEX_SHADER,   VS);
        var fsA   = compile(gl, gl.FRAGMENT_SHADER, FS_ASCII);
        var fsC   = compile(gl, gl.FRAGMENT_SHADER, FS_CRT);
        var fsL   = compile(gl, gl.FRAGMENT_SHADER, FS_LCD);
        var fsH   = compile(gl, gl.FRAGMENT_SHADER, FS_HT);
        if (!vs || !fsA || !fsC || !fsL || !fsH) { initFailed = true; return false; }
        progAscii = link(gl, vs, fsA);
        progCrt   = link(gl, vs, fsC);
        progLcd   = link(gl, vs, fsL);
        progHt    = link(gl, vs, fsH);
        if (!progAscii || !progCrt || !progLcd || !progHt) { initFailed = true; return false; }

        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        var vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1,  3, -1, -1,  3]), gl.STATIC_DRAW);
        /* Both programs use the same a_pos attribute layout. */
        var aLocA = gl.getAttribLocation(progAscii, 'a_pos');
        gl.enableVertexAttribArray(aLocA);
        gl.vertexAttribPointer(aLocA, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        uAscii.game        = gl.getUniformLocation(progAscii, 'u_game');
        uAscii.atlas       = gl.getUniformLocation(progAscii, 'u_atlas');
        uAscii.canvasSize  = gl.getUniformLocation(progAscii, 'u_canvasSize');
        uAscii.cell        = gl.getUniformLocation(progAscii, 'u_cell');
        uAscii.numGlyphs   = gl.getUniformLocation(progAscii, 'u_numGlyphs');

        uCrt.game          = gl.getUniformLocation(progCrt, 'u_game');
        uCrt.canvasSize    = gl.getUniformLocation(progCrt, 'u_canvasSize');
        uCrt.grilleAmt     = gl.getUniformLocation(progCrt, 'u_grille_amt');
        uCrt.boost         = gl.getUniformLocation(progCrt, 'u_boost');
        uCrt.scanIntensity = gl.getUniformLocation(progCrt, 'u_scan_intensity');

        uLcd.game          = gl.getUniformLocation(progLcd, 'u_game');
        uLcd.canvasSize    = gl.getUniformLocation(progLcd, 'u_canvasSize');

        uHt.game           = gl.getUniformLocation(progHt, 'u_game');
        uHt.canvasSize     = gl.getUniformLocation(progHt, 'u_canvasSize');

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
        if (settings.mode === 'off') return;
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

        if (settings.mode === 'crt-basic' || settings.mode === 'crt-full') {
            var preset = CRT_PRESETS[settings.mode];
            gl.useProgram(progCrt);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gameTex);
            gl.uniform1i(uCrt.game, 0);
            gl.uniform2f(uCrt.canvasSize, overlay.width, overlay.height);
            gl.uniform1f(uCrt.grilleAmt, preset.grille);
            gl.uniform1f(uCrt.boost, preset.boost);
            gl.uniform1f(uCrt.scanIntensity, preset.scanIntensity);
        } else if (settings.mode === 'lcd') {
            gl.useProgram(progLcd);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gameTex);
            gl.uniform1i(uLcd.game, 0);
            gl.uniform2f(uLcd.canvasSize, overlay.width, overlay.height);
        } else if (settings.mode === 'cmyk-halftone') {
            gl.useProgram(progHt);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gameTex);
            gl.uniform1i(uHt.game, 0);
            gl.uniform2f(uHt.canvasSize, overlay.width, overlay.height);
        } else {
            /* ascii */
            gl.useProgram(progAscii);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gameTex);
            gl.uniform1i(uAscii.game, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, atlasTex);
            gl.uniform1i(uAscii.atlas, 1);
            gl.uniform2f(uAscii.canvasSize, overlay.width, overlay.height);
            gl.uniform1f(uAscii.cell, CELL);
            gl.uniform1f(uAscii.numGlyphs, CHARS.length);
        }

        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        rafId = requestAnimationFrame(frame);
    }

    function setMode(mode) {
        if (mode !== 'off' && mode !== 'ascii' &&
            mode !== 'crt-basic' && mode !== 'crt-full' &&
            mode !== 'lcd' && mode !== 'cmyk-halftone') mode = 'off';
        settings.mode = mode;
        saveSettings(settings);
        var ov = document.getElementById('postfx-overlay');
        if (ov) ov.style.display = (mode === 'off') ? 'none' : 'block';
        if (mode !== 'off' && rafId === null) {
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
        setMode(settings.mode);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
