/* shell-rom.js — disc-image import helpers.
 *
 * Exposes a single `window.romImport` namespace used by shell.html's
 * file picker. The CISO format constants and reader semantics here must
 * stay in sync with pc/src/pc_disc.c — both files cooperate to round-
 * trip a compressed disc image through the wasm runtime.
 */
(function () {
    var CISO_HEADER_SIZE = 0x8000;
    var CISO_BLOCK_SIZE  = 0x200000; // 2 MB
    var CISO_MAP_OFFSET  = 8;
    var CISO_MAX_BLOCKS  = CISO_HEADER_SIZE - CISO_MAP_OFFSET; // 32760

    function isCisoFile(headBytes) {
        return headBytes[0] === 0x43 && headBytes[1] === 0x49 &&
               headBytes[2] === 0x53 && headBytes[3] === 0x4F; // 'CISO'
    }
    async function readSlice(file, offset, length) {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }
    function beU32(arr, off) {
        return ((arr[off] << 24) | (arr[off + 1] << 16) |
                (arr[off + 2] << 8) | arr[off + 3]) >>> 0;
    }

    /* Walk the GC disc's FST and produce a `numBlocks`-long Uint8Array
     * marking which 2 MB blocks overlap any region the game actually
     * reads (disc header, DOL, FST, every FST-listed file). Blocks
     * outside those regions are guaranteed to be filler and safe to
     * drop. Without this, a scattered disc layout produces a CISO
     * nearly as large as the original ISO because each filler block
     * contains pseudo-random padding (not all-same-byte). */
    async function buildFstBlockMap(file, numBlocks) {
        var used = new Uint8Array(numBlocks);
        function markRange(start, end) {
            if (end > file.size) end = file.size;
            if (end <= start) return;
            var first = Math.floor(start / CISO_BLOCK_SIZE);
            var last  = Math.floor((end - 1) / CISO_BLOCK_SIZE);
            for (var b = first; b <= last && b < numBlocks; b++) {
                used[b] = 1;
            }
        }

        // Disc header occupies [0, 0x2440); also conservatively keep
        // the apploader region up to the DOL offset.
        var hdr = await readSlice(file, 0, 0x440);
        var dolOffset = beU32(hdr, 0x420);
        var fstOffset = beU32(hdr, 0x424);
        var fstSize   = beU32(hdr, 0x428);
        markRange(0, Math.max(0x2440, dolOffset));

        // DOL: read its header and compute the total DOL byte span.
        // GC DOL header has 7 text sections (offsets at 0x00, sizes at
        // 0x90) and 11 data sections (offsets at 0x1C, sizes at 0xAC).
        // The DOL ends at max(offset + size) across all sections.
        var dolHdr = await readSlice(file, dolOffset, 0x100);
        var dolEnd = dolOffset + 0x100;
        for (var i = 0; i < 7; i++) {
            var off  = beU32(dolHdr, 0x00 + i * 4);
            var size = beU32(dolHdr, 0x90 + i * 4);
            if (size > 0) dolEnd = Math.max(dolEnd, dolOffset + off + size);
        }
        for (var i = 0; i < 11; i++) {
            var off  = beU32(dolHdr, 0x1C + i * 4);
            var size = beU32(dolHdr, 0xAC + i * 4);
            if (size > 0) dolEnd = Math.max(dolEnd, dolOffset + off + size);
        }
        markRange(dolOffset, dolEnd);

        // FST itself.
        markRange(fstOffset, fstOffset + fstSize);

        // FST entries: 12 bytes each. Root entry at offset 0; its size
        // field (bytes 8-11) is the total entry count. Each file entry
        // has type=0 at byte 0, file offset at bytes 4-7, file size at
        // bytes 8-11. Directories (type=1) have no disc data of their
        // own.
        var fstBytes = await readSlice(file, fstOffset, fstSize);
        var numEntries = beU32(fstBytes, 0x08);
        for (var i = 1; i < numEntries; i++) {
            var entryOff = i * 12;
            if (fstBytes[entryOff] === 0) { // file
                var fileOff  = beU32(fstBytes, entryOff + 4);
                var fileSize = beU32(fstBytes, entryOff + 8);
                markRange(fileOff, fileOff + fileSize);
            }
        }
        return used;
    }

    /* Convert a raw .iso/.gcm Blob into CISO bytes. Uses the FST to
     * identify which 2 MB blocks the game actually reads and drops
     * everything else — GC discs typically contain ~95%+ filler that
     * the game never accesses. The CISO format returns 0x00 for absent
     * blocks; that's fine because dropped offsets are never queried by
     * the disc reader (it only follows FST entries). */
    async function isoToCiso(file, onProgress) {
        var isoSize = file.size;
        var numBlocks = Math.ceil(isoSize / CISO_BLOCK_SIZE);
        if (numBlocks > CISO_MAX_BLOCKS) {
            throw new Error('ISO too large to compress to CISO (max 64 GB at 2 MB blocks).');
        }
        var fstUsed = await buildFstBlockMap(file, numBlocks);
        var blockMap = new Uint8Array(CISO_MAX_BLOCKS);
        var presentBlocks = [];
        for (var i = 0; i < numBlocks; i++) {
            if (!fstUsed[i]) {
                if (onProgress) onProgress(i + 1, numBlocks);
                continue;
            }
            var start = i * CISO_BLOCK_SIZE;
            var end   = Math.min(start + CISO_BLOCK_SIZE, isoSize);
            var buf   = await readSlice(file, start, end - start);
            blockMap[i] = 1;
            if (buf.length < CISO_BLOCK_SIZE) {
                var padded = new Uint8Array(CISO_BLOCK_SIZE);
                padded.set(buf);
                presentBlocks.push(padded);
            } else {
                presentBlocks.push(buf);
            }
            if (onProgress) onProgress(i + 1, numBlocks);
            if ((i & 7) === 7) await new Promise(function (r) { setTimeout(r, 0); });
        }
        var totalSize = CISO_HEADER_SIZE + presentBlocks.length * CISO_BLOCK_SIZE;
        var out = new Uint8Array(totalSize);
        out[0] = 0x43; out[1] = 0x49; out[2] = 0x53; out[3] = 0x4F;
        new DataView(out.buffer).setUint32(4, CISO_BLOCK_SIZE, true);
        out.set(blockMap, CISO_MAP_OFFSET);
        var off = CISO_HEADER_SIZE;
        for (var k = 0; k < presentBlocks.length; k++) {
            out.set(presentBlocks[k], off);
            off += CISO_BLOCK_SIZE;
        }
        return out;
    }

    window.romImport = {
        isCisoFile:     isCisoFile,
        readSlice:      readSlice,
        isoToCiso:      isoToCiso,
        CISO_HEADER_SIZE: CISO_HEADER_SIZE,
    };
})();
