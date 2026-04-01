#!/usr/bin/env python3
"""
snap_viewer.py - Snap Camera Dual-Feed Viewer

Attaches to both Snap Camera instances via Frida GL hooks, shows each feed
in its own OpenCV window, and pushes frames to Unity Capture Device 0 (Feed 1)
and Unity Capture Device 1 (Feed 2).

Requirements:
    pip install frida frida-tools opencv-python numpy pyvirtualcam

Usage:
    python snap_viewer.py   (run as Administrator for Frida)

"""

import os
import re
import sys
import queue
import threading

import frida
import cv2
import numpy as np

try:
    import pyvirtualcam
    _PVCAM_OK = True
except ImportError:
    _PVCAM_OK = False
    print("WARNING: pyvirtualcam not installed — virtual camera output disabled.")
    print("         Run: pip install pyvirtualcam")


_SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
_HOOK_JS_PATH = os.path.join(_SCRIPT_DIR, 'hook.js')

try:
    with open(_HOOK_JS_PATH, 'r') as fh:
        HOOK_SCRIPT = fh.read()
except FileNotFoundError:
    sys.exit(f"ERROR: hook.js not found at {_HOOK_JS_PATH}")

_CANDIDATE_RE = re.compile(r'(?:candidate|new) tex=(\d+) (\d+)x(\d+)')


class SnapFeed:
    _QUEUE_SIZE = 2

    def __init__(self, name: str, pid: int, label: str,
                 display_w: int = 960, display_h: int = 540,
                 unity_device_name: str | None = None):
        self.name              = name
        self.pid               = pid
        self.label             = label
        self.display_w         = display_w
        self.display_h         = display_h
        self.unity_device_name = unity_device_name
        self.candidates: dict  = {}

        self.display_q: queue.Queue = queue.Queue(maxsize=self._QUEUE_SIZE)
        self.vcam_q:    queue.Queue = queue.Queue(maxsize=self._QUEUE_SIZE)
        self._vcam        = None
        self._session     = None
        self._script      = None
        self._stop_event  = threading.Event()
        self._vcam_thread = None

    def _on_message(self, message, data):
        if message['type'] == 'send':
            payload = message['payload']
            if payload.get('type') == 'frame' and data is not None:
                w, h = payload['w'], payload['h']
                try:
                    arr     = np.frombuffer(data, dtype=np.uint8).reshape((h, w, 4))
                    raw_bgr = np.ascontiguousarray(arr[::-1, :, :3])
                    display = (cv2.resize(raw_bgr, (self.display_w, self.display_h),
                                          interpolation=cv2.INTER_LINEAR)
                               if raw_bgr.shape[1] != self.display_w or raw_bgr.shape[0] != self.display_h
                               else raw_bgr)
                    self._enqueue(self.display_q, display)
                    self._enqueue(self.vcam_q, raw_bgr)
                except Exception as exc:
                    print(f"[{self.name}] Frame decode error ({w}x{h}): {exc}",
                          file=sys.stderr)

            elif payload.get('type') == 'status':
                msg = payload['msg']
                print(f"[{self.name}] {msg}")
                m = _CANDIDATE_RE.match(msg)
                if m:
                    tex_id = int(m.group(1))
                    self.candidates[tex_id] = (int(m.group(2)), int(m.group(3)))

        elif message['type'] == 'error':
            print(f"[{self.name}] Script error: {message.get('description')}",
                  file=sys.stderr)

    @staticmethod
    def _enqueue(q: queue.Queue, frame):
        if q.full():
            try: q.get_nowait()
            except queue.Empty: pass
        try: q.put_nowait(frame)
        except queue.Full: pass

    def force_lock(self, tex_id: int):
        if self._script is None:
            return
        if tex_id == 0:
            self._script.post({'type': 'auto'})
        else:
            w, h = self.candidates[tex_id]
            self._script.post({'type': 'force_lock', 'texId': tex_id, 'w': w, 'h': h})

    def _vcam_worker(self):
        while not self._stop_event.is_set():
            try:
                raw = self.vcam_q.get(timeout=0.05)
                self.send_to_vcam(raw)
            except queue.Empty:
                pass

    def send_to_vcam(self, frame: np.ndarray):
        if not _PVCAM_OK or self.unity_device_name is None:
            return
        h, w = frame.shape[:2]
        if self._vcam is None:
            try:
                self._vcam = pyvirtualcam.Camera(
                    width=w, height=h, fps=30,
                    backend='unitycapture', device=self.unity_device_name,
                    fmt=pyvirtualcam.PixelFormat.BGR,
                )
                print(f"[{self.name}] virtual cam '{self.unity_device_name}' opened ({w}x{h})")
            except Exception as e:
                print(f"[{self.name}] Could not open virtual cam '{self.unity_device_name}': {e}",
                      file=sys.stderr)
                self.unity_device_name = None
                return
        try:
            self._vcam.send(frame)
        except Exception as e:
            print(f"[{self.name}] vcam send error: {e}", file=sys.stderr)

    def attach(self, device) -> bool:
        try:
            self._session = device.attach(self.pid)
            self._script  = self._session.create_script(HOOK_SCRIPT)
            self._script.on('message', self._on_message)
            self._script.load()
            self._stop_event.clear()
            self._vcam_thread = threading.Thread(target=self._vcam_worker, daemon=True)
            self._vcam_thread.start()
            print(f"[{self.name}] Attached (PID {self.pid})")
            return True
        except frida.ProcessNotFoundError:
            print(f"[{self.name}] PID {self.pid} not found.", file=sys.stderr)
        except frida.PermissionDeniedError:
            print(f"[{self.name}] Permission denied — run as Administrator.", file=sys.stderr)
        except Exception as exc:
            print(f"[{self.name}] Attach failed: {exc}", file=sys.stderr)
        return False

    def detach(self):
        self._stop_event.set()
        if self._vcam_thread is not None:
            self._vcam_thread.join(timeout=1.0)
            self._vcam_thread = None
        if self._vcam is not None:
            try: self._vcam.close()
            except Exception: pass
            self._vcam = None
        if self._session:
            try: self._session.detach()
            except Exception: pass
            self._session = None


def find_snap_processes():
    device = frida.get_local_device()
    procs  = device.enumerate_processes()
    snaps  = [p for p in procs if 'snap camera' in p.name.lower()]
    snaps.sort(key=lambda p: p.name.lower())
    return device, snaps


def _placeholder(label: str, w=640, h=360) -> np.ndarray:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    cv2.putText(img, "Waiting for feed from", (w//2 - 160, h//2 - 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (180, 180, 180), 2)
    cv2.putText(img, label, (w//2 - 160, h//2 + 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (220, 220, 100), 2)
    return img


def _combo_options(feed: SnapFeed) -> list[str]:
    opts = ['Auto']
    for tex_id, (w, h) in sorted(feed.candidates.items()):
        opts.append(f"tex={tex_id}  ({w}x{h})")
    return opts


def _tex_id_from_sel(value: str) -> int:
    if value == 'Auto':
        return 0
    m = re.match(r'tex=(\d+)', value)
    return int(m.group(1)) if m else 0


def main():
    import tkinter as tk
    from tkinter import ttk

    print("=" * 60)
    print("  Snap Camera Dual-Feed Viewer  (Frida + OpenCV)")
    print("=" * 60)

    device, snap_procs = find_snap_processes()
    if len(snap_procs) < 2:
        print(f"\nERROR: Found {len(snap_procs)} Snap Camera instance(s); need 2.")
        sys.exit(1)

    print(f"\nFound {len(snap_procs)} Snap Camera processes:")
    for p in snap_procs:
        print(f"  {p.name:<30}  PID {p.pid}")

    WIN_W, WIN_H = 960, 540

    unity_devices = ['Unity Video Capture', 'Unity Video Capture 2']

    feeds = [
        SnapFeed(snap_procs[0].name, snap_procs[0].pid,
                 f"Feed 1 — {snap_procs[0].name}",
                 WIN_W, WIN_H,
                 unity_device_name=unity_devices[0]),
        SnapFeed(snap_procs[1].name, snap_procs[1].pid,
                 f"Feed 2 — {snap_procs[1].name}",
                 WIN_W, WIN_H,
                 unity_device_name=unity_devices[1]),
    ]

    print("\nAttaching Frida hooks …")
    for feed in feeds:
        if not feed.attach(device):
            print("Aborting.")
            sys.exit(1)

    print("\nHooks loaded. Waiting for frames …")
    print("Press Q or Escape in any viewer window to quit.\n")

    for i, feed in enumerate(feeds):
        cv2.namedWindow(feed.label, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(feed.label, WIN_W, WIN_H)
        cv2.moveWindow(feed.label, 30 + i * (WIN_W + 20), 80)
        cv2.imshow(feed.label, _placeholder(feed.name))

    # ── Tkinter texture-select control window ────────────────────────────────
    root = tk.Tk()
    root.title("Snap Camera Viewer — Texture Select")
    root.resizable(False, False)

    sel_vars:  list[tk.StringVar]    = []
    combos:    list[ttk.Combobox]    = []
    prev_opts: list[list[str]]       = [[], []]

    for i, feed in enumerate(feeds):
        frm = ttk.LabelFrame(root, text=feed.label, padding=8)
        frm.grid(row=i, column=0, padx=10, pady=6, sticky='ew')
        ttk.Label(frm, text="Texture:").grid(row=0, column=0, sticky='w')
        var = tk.StringVar(value='Auto')
        sel_vars.append(var)
        combo = ttk.Combobox(frm, textvariable=var, state='readonly', width=28)
        combo['values'] = ['Auto']
        combo.current(0)
        combo.grid(row=0, column=1, padx=(6, 0))
        combos.append(combo)

        def _on_select(event, f=feed, v=var):
            f.force_lock(_tex_id_from_sel(v.get()))

        combo.bind('<<ComboboxSelected>>', _on_select)

    # ── Main loop ────────────────────────────────────────────────────────────
    try:
        while True:
            for feed in feeds:
                try:
                    frame = feed.display_q.get_nowait()
                    cv2.imshow(feed.label, frame)
                except queue.Empty:
                    pass

            key = cv2.waitKey(16) & 0xFF
            if key in (ord('q'), ord('Q'), 27):
                break

            for i, (feed, combo) in enumerate(zip(feeds, combos)):
                opts = _combo_options(feed)
                if opts != prev_opts[i]:
                    current = sel_vars[i].get()
                    combo['values'] = opts
                    sel_vars[i].set(current if current in opts else 'Auto')
                    prev_opts[i] = opts

            try:
                root.update()
            except tk.TclError:
                break

            if all(cv2.getWindowProperty(f.label, cv2.WND_PROP_VISIBLE) < 1
                   for f in feeds):
                break

    except KeyboardInterrupt:
        pass

    print("\nShutting down …")
    try: root.destroy()
    except Exception: pass
    cv2.destroyAllWindows()
    for feed in feeds:
        feed.detach()
    print("Done.")


if __name__ == '__main__':
    main()
