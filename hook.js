/**
 * hook.js – Snap Camera clean frame capture (v11)
 *
 * v11: Replaced synchronous glReadPixels with double-buffered PBO async readback.
 *      glReadPixels now returns immediately (GPU fills the PBO asynchronously).
 *      The previous frame's PBO is mapped and sent on the next capture tick,
 *      by which point the GPU transfer is done. Snap Camera's render thread
 *      is no longer stalled on a multi-MB GPU→CPU copy.
 *      Data is in standard OpenGL bottom-up order; snap_viewer.py flips it.
 */
'use strict';

const MIN_FRAME_INTERVAL_MS = 33;   // 30 fps
const MIN_SIDE              = 640;
const SCAN_MAX_ID           = 2048;
const HISTORY_LEN           = 15;
const CHANGE_RATE_THRESHOLD = 0.4;

// GL constants
const GL_TEXTURE_2D               = 0x0DE1;
const GL_TEXTURE_BINDING_2D       = 0x8069;
const GL_READ_FRAMEBUFFER         = 0x8CA8;
const GL_READ_FRAMEBUFFER_BINDING = 0x8CAA;
const GL_FRAMEBUFFER_COMPLETE     = 0x8CD5;
const GL_COLOR_ATTACHMENT0        = 0x8CE0;
const GL_BGRA                     = 0x80E1;
const GL_UNSIGNED_BYTE            = 0x1401;
const GL_TEXTURE_WIDTH            = 0x1000;
const GL_TEXTURE_HEIGHT           = 0x1001;
// PBO
const GL_PIXEL_PACK_BUFFER        = 0x88EB;
const GL_STREAM_READ              = 0x88E1;
const GL_READ_ONLY                = 0x88B8;

// ──────────────────────────────────────────────────────────────
// GL function pointers
// ──────────────────────────────────────────────────────────────
let glGetIntegerv, glGetTexLevelParameteriv, glBindTexture, glIsTexture,
    glGenFramebuffers, glDeleteFramebuffers, glBindFramebuffer,
    glFramebufferTexture2D_fn, glCheckFramebufferStatus, glReadPixels,
    glGenBuffers, glDeleteBuffers, glBindBuffer, glBufferData,
    glMapBuffer, glUnmapBuffer;
let glReady = false;

function initGL(opengl32) {
    function gl(n) { return opengl32.findExportByName(n); }
    function gp(n) {
        const f = new NativeFunction(
            opengl32.findExportByName('wglGetProcAddress'), 'pointer', ['pointer']);
        return f(Memory.allocUtf8String(n));
    }

    glGetIntegerv            = new NativeFunction(gl('glGetIntegerv'),            'void', ['uint','pointer']);
    glGetTexLevelParameteriv = new NativeFunction(gl('glGetTexLevelParameteriv'), 'void', ['uint','int','uint','pointer']);
    glBindTexture            = new NativeFunction(gl('glBindTexture'),            'void', ['uint','uint']);
    glIsTexture              = new NativeFunction(gl('glIsTexture'),              'uint', ['uint']);
    glReadPixels             = new NativeFunction(gl('glReadPixels'),             'void', ['int','int','int','int','uint','uint','pointer']);

    const gbf = gp('glBindFramebuffer');
    const ggf = gp('glGenFramebuffers');
    const dgf = gp('glDeleteFramebuffers');
    const ft2 = gp('glFramebufferTexture2D');
    const cfs = gp('glCheckFramebufferStatus');
    const ggb = gp('glGenBuffers');
    const ddb = gp('glDeleteBuffers');
    const bbb = gp('glBindBuffer');
    const bfd = gp('glBufferData');
    const gmb = gp('glMapBuffer');
    const gub = gp('glUnmapBuffer');

    if (gbf.isNull() || ggf.isNull() || ggb.isNull() || gmb.isNull()) return { ok: false };

    glBindFramebuffer         = new NativeFunction(gbf, 'void',    ['uint','uint']);
    glGenFramebuffers         = new NativeFunction(ggf, 'void',    ['int','pointer']);
    glDeleteFramebuffers      = new NativeFunction(dgf, 'void',    ['int','pointer']);
    glFramebufferTexture2D_fn = new NativeFunction(ft2, 'void',    ['uint','uint','uint','uint','int']);
    glCheckFramebufferStatus  = new NativeFunction(cfs, 'uint',    ['uint']);
    glGenBuffers              = new NativeFunction(ggb, 'void',    ['int','pointer']);
    glDeleteBuffers           = new NativeFunction(ddb, 'void',    ['int','pointer']);
    glBindBuffer              = new NativeFunction(bbb, 'void',    ['uint','uint']);
    glBufferData              = new NativeFunction(bfd, 'void',    ['uint','int64','pointer','uint']);
    glMapBuffer               = new NativeFunction(gmb, 'pointer', ['uint','uint']);
    glUnmapBuffer             = new NativeFunction(gub, 'uint',    ['uint']);

    return {
        ok: true,
        ti2Ptr: gl('glTexImage2D'),
        ts2Ptr: gp('glTexStorage2D')
    };
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function saveBindings() {
    const rfP = Memory.alloc(4), tP = Memory.alloc(4);
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, rfP);
    glGetIntegerv(GL_TEXTURE_BINDING_2D, tP);
    return { rf: rfP.readS32(), tex: tP.readS32() };
}
function restoreBindings(saved) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, saved.rf);
    glBindTexture(GL_TEXTURE_2D, saved.tex);
}

/** Check if texId is a valid large texture; add to candidates if so. No save/restore. */
function maybeAdd(texId) {
    if (candidates[texId]) return;
    if (!glIsTexture(texId)) return;
    glBindTexture(GL_TEXTURE_2D, texId);
    const wp = Memory.alloc(4), hp = Memory.alloc(4);
    glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_WIDTH,  wp);
    glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_HEIGHT, hp);
    const w = wp.readS32(), h = hp.readS32();
    if (w >= MIN_SIDE && h >= MIN_SIDE) {
        candidates[texId] = { w, h, lastHash: -1, history: [], hashRing: [], alternating: false, nonBlack: false };
        send({ type: 'status', msg: 'candidate tex=' + texId + ' ' + w + 'x' + h });
    }
}

function scanAllTextures() {
    const saved = saveBindings();
    let found = 0;
    for (let id = 1; id <= SCAN_MAX_ID; id++) {
        try { maybeAdd(id); if (candidates[id]) found++; } catch(_) {}
    }
    restoreBindings(saved);
    send({ type: 'status', msg: 'Scan done: ' + found + ' large textures' });
}

/**
 * Returns true if the last 4 entries of hashRing show strict alternation [A,B,A,B] where A≠B.
 * A texture driven by two alternating sources (e.g. virtual camera fed by both instances)
 * will hash differently every frame but repeat every two frames.
 */
function isAlternating(hashRing) {
    if (hashRing.length < 4) return false;
    const n = hashRing.length;
    const h0 = hashRing[n - 4], h1 = hashRing[n - 3],
          h2 = hashRing[n - 2], h3 = hashRing[n - 1];
    return h0 === h2 && h1 === h3 && h0 !== h1;
}

/**
 * Sample 8×8 centre pixels synchronously. Only 256 bytes so the GPU stall is negligible.
 * Returns { hash, nonBlack }. hash < 0 means FBO incomplete (skip).
 */
function sampleCentre(tmpFBO, texId, w, h) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, tmpFBO);
    glFramebufferTexture2D_fn(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                              GL_TEXTURE_2D, texId, 0);
    if (glCheckFramebufferStatus(GL_READ_FRAMEBUFFER) !== GL_FRAMEBUFFER_COMPLETE) {
        return { hash: -1, nonBlack: false };
    }
    const cx = Math.max(0, (w >> 1) - 4);
    const cy = Math.max(0, (h >> 1) - 4);
    glReadPixels(cx, cy, 8, 8, GL_BGRA, GL_UNSIGNED_BYTE, sampleBuf);
    let sum = 0, nonBlack = false;
    for (let i = 0; i < 64; i++) {
        const off = i * 4;
        const r = sampleBuf.add(off).readU8();
        const g = sampleBuf.add(off + 1).readU8();
        const b = sampleBuf.add(off + 2).readU8();
        sum += r + g + b;
        if (r > 10 || g > 10 || b > 10) nonBlack = true;
    }
    return { hash: sum, nonBlack };
}

// ──────────────────────────────────────────────────────────────
// PBO async readback
// ──────────────────────────────────────────────────────────────
// Double-buffered: while GPU fills pboIds[writeIdx] for this frame,
// we read pboIds[1-writeIdx] from the previous frame (already done).
let pboIds       = [0, 0];
let pboAllocSize = 0;
let pboWriteIdx  = 0;
let pboHasPending = [false, false];

function ensurePBOs(needed) {
    if (pboAllocSize === needed) return;

    // Free old PBOs if resizing
    if (pboIds[0] !== 0) {
        const arr = Memory.alloc(8);
        arr.writeU32(pboIds[0]);
        arr.add(4).writeU32(pboIds[1]);
        glDeleteBuffers(2, arr);
        pboIds = [0, 0];
    }

    const arr = Memory.alloc(8);
    glGenBuffers(2, arr);
    pboIds[0] = arr.readU32();
    pboIds[1] = arr.add(4).readU32();

    // Pre-allocate GPU-side storage for both PBOs
    for (let i = 0; i < 2; i++) {
        glBindBuffer(GL_PIXEL_PACK_BUFFER, pboIds[i]);
        glBufferData(GL_PIXEL_PACK_BUFFER, needed, ptr(0), GL_STREAM_READ);
    }
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);

    pboAllocSize  = needed;
    pboWriteIdx   = 0;
    pboHasPending = [false, false];
    send({ type: 'status', msg: 'PBOs allocated (' + needed + ' bytes each)' });
}

/**
 * Async capture using double-buffered PBOs.
 *
 * Each call does two things:
 *   1. Issues a new glReadPixels into the write PBO — returns immediately,
 *      GPU fills it asynchronously after the render thread moves on.
 *   2. Maps the read PBO (written last frame) and sends it — the GPU is
 *      guaranteed to have finished by now.
 *
 * Returns true when a frame was actually sent (not on the very first call).
 */
function asyncCapture(texId, w, h) {
    const needed = w * h * 4;
    ensurePBOs(needed);

    const saved  = saveBindings();
    const fboArr = Memory.alloc(4);
    glGenFramebuffers(1, fboArr);
    const tmpFBO = fboArr.readU32();

    let sent = false;

    try {
        glBindFramebuffer(GL_READ_FRAMEBUFFER, tmpFBO);
        glFramebufferTexture2D_fn(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                  GL_TEXTURE_2D, texId, 0);

        if (glCheckFramebufferStatus(GL_READ_FRAMEBUFFER) === GL_FRAMEBUFFER_COMPLETE) {

            // ── Step 1: kick off async read into the write PBO ──
            glBindBuffer(GL_PIXEL_PACK_BUFFER, pboIds[pboWriteIdx]);
            glReadPixels(0, 0, w, h, GL_BGRA, GL_UNSIGNED_BYTE, ptr(0));
            // ptr(0) = NULL offset → write into the bound PBO, not a CPU pointer
            pboHasPending[pboWriteIdx] = true;

            // ── Step 2: read last frame's PBO (GPU is done with it) ──
            const readIdx = 1 - pboWriteIdx;
            if (pboHasPending[readIdx]) {
                glBindBuffer(GL_PIXEL_PACK_BUFFER, pboIds[readIdx]);
                const dataPtr = glMapBuffer(GL_PIXEL_PACK_BUFFER, GL_READ_ONLY);
                if (!dataPtr.isNull()) {
                    send({ type: 'frame', w, h, texId }, dataPtr.readByteArray(needed));
                    sent = true;
                }
                glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
                pboHasPending[readIdx] = false;
            }

            glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
            pboWriteIdx = 1 - pboWriteIdx;
        }
    } catch(_) {}

    glDeleteFramebuffers(1, fboArr);
    restoreBindings(saved);
    return sent;
}

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────
let lastSendTime = 0;
let swapCount    = 0;
let scanned      = false;

const sampleBuf = Memory.alloc(8 * 8 * 4);  // 256 bytes, reused by sampleCentre

// Map: texId → { w, h, lastHash, history:bool[], nonBlack }
const candidates = {};

// Locked selection
const LOCK_HOLD_FRAMES = 45;
let lockedId    = 0, lockedW = 0, lockedH = 0;
let lockedFails = 0;
let manualLock  = false;  // true = Python has forced a specific texture

// ── Message handler: Python → JS ─────────────────────────────
// Receives { type:'force_lock', texId, w, h } or { type:'auto' }
(function listenForCommands() {
    recv(function(msg) {
        if (msg.type === 'force_lock') {
            lockedId = msg.texId; lockedW = msg.w; lockedH = msg.h;
            lockedFails = 0; manualLock = true;
            pboHasPending = [false, false];
            send({ type: 'status', msg: 'Manual lock: tex ' + msg.texId + ' (' + msg.w + 'x' + msg.h + ')' });
        } else if (msg.type === 'auto') {
            manualLock = false; lockedId = 0; lockedFails = 0;
            pboHasPending = [false, false];
            send({ type: 'status', msg: 'Reverted to auto selection' });
        }
        listenForCommands();  // re-arm for next message
    });
})();

// ──────────────────────────────────────────────────────────────
// Hook installation
// ──────────────────────────────────────────────────────────────
function tryHook() {
    const opengl32 = Process.findModuleByName('opengl32.dll');
    if (!opengl32) { setTimeout(tryHook, 500); return; }

    const swapPtr = opengl32.findExportByName('wglSwapBuffers');
    if (!swapPtr) { setTimeout(tryHook, 500); return; }

    Interceptor.attach(swapPtr, {
        onEnter(_args) {
            swapCount++;

            // ── First swap: GL init + creation hooks ─────────
            if (!glReady) {
                const res = initGL(opengl32);
                if (!res.ok) return;
                glReady = true;
                send({ type: 'status', msg: 'GL ready' });

                if (res.ti2Ptr) {
                    Interceptor.attach(res.ti2Ptr, {
                        onEnter(args) {
                            if (!glReady) return;
                            if (args[1].toUInt32() !== 0) return;
                            if (args[0].toUInt32() !== GL_TEXTURE_2D) return;
                            const w = args[3].toInt32(), h = args[4].toInt32();
                            if (w < MIN_SIDE || h < MIN_SIDE) return;
                            try {
                                const tP = Memory.alloc(4);
                                glGetIntegerv(GL_TEXTURE_BINDING_2D, tP);
                                const id = tP.readS32();
                                if (id > 0 && !candidates[id]) {
                                    candidates[id] = { w, h, lastHash: -1, history: [], hashRing: [], alternating: false, nonBlack: false };
                                    send({ type: 'status', msg: 'new tex=' + id + ' ' + w + 'x' + h });
                                }
                            } catch(_) {}
                        }
                    });
                }

                if (!res.ts2Ptr.isNull()) {
                    Interceptor.attach(res.ts2Ptr, {
                        onEnter(args) {
                            if (!glReady) return;
                            if (args[0].toUInt32() !== GL_TEXTURE_2D) return;
                            const w = args[3].toInt32(), h = args[4].toInt32();
                            if (w < MIN_SIDE || h < MIN_SIDE) return;
                            try {
                                const tP = Memory.alloc(4);
                                glGetIntegerv(GL_TEXTURE_BINDING_2D, tP);
                                const id = tP.readS32();
                                if (id > 0 && !candidates[id]) {
                                    candidates[id] = { w, h, lastHash: -1, history: [], hashRing: [], alternating: false, nonBlack: false };
                                    send({ type: 'status', msg: 'new tex=' + id + ' ' + w + 'x' + h });
                                }
                            } catch(_) {}
                        }
                    });
                }

                return;
            }

            // ── Second swap: retroactive scan ────────────────
            if (!scanned) {
                scanned = true;
                try { scanAllTextures(); } catch(_) {}
            }

            // ── Per-swap: update history + pick + capture ────
            const now = Date.now();
            if (now - lastSendTime < MIN_FRAME_INTERVAL_MS) return;
            if (Object.keys(candidates).length === 0) return;

            // ── Manual lock: bypass all automatic logic ──────
            if (manualLock && lockedId > 0) {
                try {
                    if (asyncCapture(lockedId, lockedW, lockedH)) lastSendTime = now;
                } catch(_) {}
                return;
            }

            // ── If locked: update only the locked texture's history, then decide ──
            if (lockedId > 0) {
                const info = candidates[lockedId];
                if (info) {
                    // Cheap: one 8×8 sample to keep history current
                    const savedL = saveBindings();
                    const fboArrL = Memory.alloc(4);
                    glGenFramebuffers(1, fboArrL);
                    const tmpFBOL = fboArrL.readU32();
                    try {
                        const { hash, nonBlack } = sampleCentre(tmpFBOL, lockedId, lockedW, lockedH);
                        if (hash >= 0) {
                            info.nonBlack = nonBlack;
                            const changed = (hash !== info.lastHash);
                            info.lastHash = hash;
                            info.history.push(changed ? 1 : 0);
                            if (info.history.length > HISTORY_LEN) info.history.shift();
                            info.hashRing.push(hash);
                            if (info.hashRing.length > 6) info.hashRing.shift();
                            info.alternating = isAlternating(info.hashRing);
                        }
                    } catch(_) {}
                    glDeleteFramebuffers(1, fboArrL);
                    restoreBindings(savedL);
                }

                if (info && info.alternating) {
                    // Locked onto the virtual camera feedback texture — unlock immediately
                    send({ type: 'status', msg: 'Unlocking tex ' + lockedId + ': alternating pattern detected (virtual camera feedback)' });
                    lockedId = 0; lockedFails = 0;
                    pboHasPending = [false, false];
                    // fall through to re-select
                } else if (info && info.nonBlack && info.history.length >= 3) {
                    const rate = info.history.reduce((a, b) => a + b, 0) / info.history.length;
                    if (rate >= CHANGE_RATE_THRESHOLD) {
                        lockedFails = 0;
                        try {
                            if (asyncCapture(lockedId, lockedW, lockedH)) lastSendTime = now;
                        } catch(_) {}
                        return;
                    }
                }
                if (lockedId > 0) {
                    // Rate too low — hold lock briefly before giving up
                    lockedFails++;
                    if (lockedFails < LOCK_HOLD_FRAMES) {
                        try {
                            if (asyncCapture(lockedId, lockedW, lockedH)) lastSendTime = now;
                        } catch(_) {}
                        return;
                    }
                    // Lock expired — fall through to re-select
                    lockedId = 0; lockedFails = 0;
                    pboHasPending = [false, false];
                }
            }

            // ── Update candidate histories (only when not locked) ──
            {
                const saved = saveBindings();
                const fboArr = Memory.alloc(4);
                glGenFramebuffers(1, fboArr);
                const tmpFBO = fboArr.readU32();
                for (const [idStr, info] of Object.entries(candidates)) {
                    const id = parseInt(idStr);
                    try {
                        const { hash, nonBlack } = sampleCentre(tmpFBO, id, info.w, info.h);
                        if (hash < 0) continue;
                        info.nonBlack = nonBlack;
                        const changed = (hash !== info.lastHash);
                        info.lastHash = hash;
                        info.history.push(changed ? 1 : 0);
                        if (info.history.length > HISTORY_LEN) info.history.shift();
                        info.hashRing.push(hash);
                        if (info.hashRing.length > 6) info.hashRing.shift();
                        info.alternating = isAlternating(info.hashRing);
                        if (info.alternating)
                            send({ type: 'status', msg: 'tex=' + id + ' flagged as alternating (virtual camera feedback)' });
                    } catch(_) {}
                }
                glDeleteFramebuffers(1, fboArr);
                restoreBindings(saved);
            }

            // ── Select new best texture ───────────────────────
            let bestId = 0, bestW = 0, bestH = 0, bestScore = -1;
            for (const [idStr, info] of Object.entries(candidates)) {
                const id = parseInt(idStr);
                if (info.alternating) continue;       // virtual camera feedback — skip
                if (!info.nonBlack) continue;
                if (info.history.length < 3) continue;
                const rate = info.history.reduce((a, b) => a + b, 0) / info.history.length;
                if (rate < CHANGE_RATE_THRESHOLD) continue;
                const score = Math.round(rate * 20) * 10000 + id;
                if (score > bestScore) {
                    bestScore = score; bestId = id; bestW = info.w; bestH = info.h;
                }
            }

            // Fallback: no high-rate candidate yet → pick any non-black non-alternating highest ID
            if (bestId === 0) {
                for (const [idStr, info] of Object.entries(candidates)) {
                    const id = parseInt(idStr);
                    if (info.alternating) continue;
                    if (info.nonBlack && id > bestId) {
                        bestId = id; bestW = info.w; bestH = info.h;
                    }
                }
            }

            if (bestId === 0) return;

            if (bestId !== lockedId)
                send({ type: 'status', msg: 'Locked tex ' + bestId + ' (' + bestW + 'x' + bestH + ')' });
            lockedId = bestId; lockedW = bestW; lockedH = bestH; lockedFails = 0;

            try {
                if (asyncCapture(bestId, bestW, bestH)) lastSendTime = now;
            } catch(_) {}
        }
    });

    send({ type: 'status', msg: 'wglSwapBuffers hook installed' });
}

tryHook();
