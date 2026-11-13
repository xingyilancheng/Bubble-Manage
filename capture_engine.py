"""窗口捕获引擎（Python 侧车进程）。

Electron 负责全部 UI 与内嵌浏览器；本进程只保留 Win32 窗口捕获机制：
拖拽捕获、跟随主窗口移动/缩放、自动隐藏/恢复、释放窗口。
通过 localhost TCP JSON-lines 与 Electron 主进程通信。
"""
import ctypes
import json
import os
import queue
import socket
import threading
import time
from ctypes import wintypes as wt

user32 = ctypes.WinDLL('user32', use_last_error=True)

user32.EnumWindows.restype = wt.BOOL
user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM), wt.LPARAM]
user32.IsWindowVisible.restype = wt.BOOL
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetWindowRect.restype = wt.BOOL
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.GetClientRect.restype = wt.BOOL
user32.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wt.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_longlong
user32.GetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int]
user32.SetWindowLongPtrW.restype = ctypes.c_longlong
user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_longlong]
user32.GetCursorPos.restype = wt.BOOL
user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.ShowWindow.restype = wt.BOOL
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.MoveWindow.restype = wt.BOOL
user32.MoveWindow.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.BOOL]
user32.GetForegroundWindow.restype = wt.HWND
user32.IsWindow.restype = wt.BOOL
user32.IsWindow.argtypes = [wt.HWND]
user32.GetWindowThreadProcessId.restype = wt.DWORD
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.SetWindowPos.restype = wt.BOOL
user32.SetWindowPos.argtypes = [
    wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_uint,
]
user32.IsIconic.restype = wt.BOOL
user32.IsIconic.argtypes = [wt.HWND]
user32.IsZoomed.restype = wt.BOOL
user32.IsZoomed.argtypes = [wt.HWND]
user32.ClientToScreen.restype = wt.BOOL
user32.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
dwmapi = ctypes.windll.dwmapi

VK_LBUTTON = 0x01
VK_S = 0x53

GWL_EXSTYLE = -20
GWL_STYLE = -16
GWLP_HWNDPARENT = -8
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
DWMWA_CLOAKED = 14
SW_MINIMIZE = 6
SW_RESTORE = 9
SW_SHOW = 5
SW_HIDE = 0
HWND_TOP = 0
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
SWP_NOZORDER = 0x0004
SWP_FRAMECHANGED = 0x0020


def pt_in_rect(x, y, r):
    return r[0] <= x <= r[2] and r[1] <= y <= r[3]


def get_cursor_pos():
    pt = wt.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y


def get_wrect(hwnd):
    r = wt.RECT()
    if user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return (r.left, r.top, r.right, r.bottom)
    return None


def get_wtitle(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n == 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def is_skip(hwnd):
    ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
    if ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE):
        return True
    attr = ctypes.c_int(0)
    if ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd, DWMWA_CLOAKED, ctypes.byref(attr), ctypes.sizeof(attr)) == 0:
        if attr.value != 0:
            return True
    return False


def move_win(hwnd, x, y, w, h):
    user32.MoveWindow(hwnd, x, y, w, h, True)


def restore_win(hwnd):
    user32.ShowWindow(hwnd, SW_RESTORE)


def show_win(hwnd):
    user32.ShowWindow(hwnd, SW_SHOW)


def hide_win(hwnd):
    user32.ShowWindow(hwnd, SW_HIDE)


def set_owner(child_hwnd, owner_hwnd):
    user32.SetWindowLongPtrW(child_hwnd, GWLP_HWNDPARENT, owner_hwnd)


def bring_to_top(hwnd):
    user32.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)


def get_pid(hwnd):
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def set_style(hwnd, style):
    user32.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)


def enum_overlapping(target_rect, exclude_hwnds):
    results = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if hwnd in exclude_hwnds:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        if is_skip(hwnd):
            return True
        t = get_wtitle(hwnd)
        if not t:
            return True
        r = get_wrect(hwnd)
        if r:
            cx1, cy1 = max(target_rect[0], r[0]), max(target_rect[1], r[1])
            cx2, cy2 = min(target_rect[2], r[2]), min(target_rect[3], r[3])
            if cx1 < cx2 and cy1 < cy2:
                if (r[2] - r[0]) > 60 and (r[3] - r[1]) > 60:
                    results.append((hwnd, t, r))
        return True

    user32.EnumWindows(cb, 0)
    return results


class CaptureEngine:
    def __init__(self):
        self.app_hwnd = None
        self.auto_hide = False
        self.browser_area = None      # (x, y, w, h) screen coords of webview area
        self.captured = {}
        self._prev_pos = {}
        self._prev_rect = {}
        self._prev_app_rect = None
        self._hidden_by_auto = False
        self._app_minimized = False
        self._paused = False
        self.capture_enabled = True
        self._cmds = queue.Queue()
        self._send_lock = threading.Lock()
        self._conn = None
        self.drag = None
        self._s_prev = False
        self._s_times = []
        self._last_captures_json = None
        self._running = True
        self._bound_pids = {}
        self._last_fg_hwnd = None

    # ── IPC ─────────────────────────────────────────────

    def _serve(self, port):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", port))
        srv.listen(1)
        while self._running:
            try:
                conn, _ = srv.accept()
            except OSError:
                break
            self._conn = conn
            threading.Thread(target=self._read_loop, args=(conn,), daemon=True).start()
        srv.close()

    def _read_loop(self, conn):
        buf = b""
        while self._running:
            try:
                data = conn.recv(65536)
            except OSError:
                break
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except Exception:
                    continue
                self._cmds.put(msg)
        self._conn = None

    def send(self, obj):
        if not self._conn:
            return
        try:
            with self._send_lock:
                self._conn.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        except OSError:
            self._conn = None

    # ── Commands ────────────────────────────────────────

    def _handle_cmd(self, msg):
        cmd = msg.get("cmd")
        if cmd == "hello":
            self.app_hwnd = msg.get("app_hwnd") or None
            self.send({"ev": "hello_ack"})
        elif cmd == "set_auto_hide":
            self.auto_hide = bool(msg.get("value"))
            if not self.auto_hide and self._hidden_by_auto:
                self._do_restore_all()
        elif cmd == "set_browser_area":
            r = msg.get("rect")
            self.browser_area = tuple(r) if r else None
        elif cmd == "release":
            self._release_window(int(msg["hwnd"]))
            self._push_captures()
        elif cmd == "release_all":
            for h in list(self.captured):
                self._release_window(h)
            self._push_captures()
        elif cmd == "tab_minimize":
            h = int(msg["hwnd"])
            if h in self.captured:
                self.captured[h]["minimized"] = True
                hide_win(h)
                self._push_captures()
        elif cmd == "tab_restore":
            h = int(msg["hwnd"])
            if h in self.captured:
                self.captured[h]["minimized"] = False
                restore_win(h)
                show_win(h)
                bring_to_top(h)
                self._push_captures()
        elif cmd == "bring_top":
            h = int(msg["hwnd"])
            if user32.IsWindow(h):
                restore_win(h)
                show_win(h)
                bring_to_top(h)
        elif cmd == "set_paused":
            self._set_paused(bool(msg.get("value")))
        elif cmd == "set_capture_enabled":
            self.capture_enabled = bool(msg.get("value"))
        elif cmd == "win_drag_begin":
            self._begin_drag()
        elif cmd == "minimize_all_captures":
            for h in list(self.captured):
                if not self.captured[h].get("minimized"):
                    self.captured[h]["minimized"] = True
                    hide_win(h)
            self._push_captures()
        elif cmd == "shutdown":
            self._running = False

    # ── Capture core ────────────────────────────────────

    def _release_window(self, hwnd):
        info = self.captured.pop(hwnd, None)
        self._prev_pos.pop(hwnd, None)
        self._prev_rect.pop(hwnd, None)
        self._bound_pids.pop(hwnd, None)
        if not user32.IsWindow(hwnd):
            return
        if info and info.get("minimized"):
            restore_win(hwnd)
            show_win(hwnd)
            bring_to_top(hwnd)
        if info and "orig_style" in info:
            set_style(hwnd, info["orig_style"])

    def _set_paused(self, val):
        if val == self._paused:
            return
        self._paused = val
        app_rect = get_wrect(self.app_hwnd) if self.app_hwnd else None
        if val:
            for h in list(self.captured):
                info = self.captured[h]
                if info.get("minimized") or not user32.IsWindow(h):
                    continue
                r = get_wrect(h)
                if r and app_rect:
                    info["_pause_off"] = (r[0] - app_rect[0], r[1] - app_rect[1])
                hide_win(h)
        else:
            for h in list(self.captured):
                info = self.captured[h]
                if info.get("minimized") or not user32.IsWindow(h):
                    continue
                off = info.pop("_pause_off", None)
                if off and app_rect:
                    r = get_wrect(h)
                    if r:
                        nx, ny = app_rect[0] + off[0], app_rect[1] + off[1]
                        if nx != r[0] or ny != r[1]:
                            move_win(h, nx, ny, r[2] - r[0], r[3] - r[1])
                show_win(h)
                bring_to_top(h)

    def _capture_once(self):
        if self._paused:
            return
        if not self.app_hwnd or not user32.IsWindow(self.app_hwnd):
            return
        app_rect = get_wrect(self.app_hwnd)
        if not app_rect:
            return

        if user32.IsIconic(self.app_hwnd):
            if not self._app_minimized:
                self._app_minimized = True
                for ch in list(self.captured):
                    hide_win(ch)
            # While the app is minimized (including via the boss key), keep every
            # binding intact and leave captured windows hidden. Running the
            # overlap/unbind logic here would drop all bindings, because hidden
            # windows are never "overlapping" the minimized app rect.
            return
        elif self._app_minimized:
            self._app_minimized = False
            for ch in list(self.captured):
                if not self.captured[ch].get("minimized"):
                    restore_win(ch)
                    show_win(ch)
                    bring_to_top(ch)

        if self._hidden_by_auto:
            return

        for ch in list(self.captured):
            if not user32.IsWindow(ch):
                self.captured.pop(ch, None)
                self._prev_pos.pop(ch, None)
                self._prev_rect.pop(ch, None)
                self._bound_pids.pop(ch, None)
                continue
            info = self.captured[ch]
            iconic = user32.IsIconic(ch)
            if iconic and not info["minimized"]:
                info["minimized"] = True
                hide_win(ch)
            elif not iconic and info["minimized"] and user32.IsWindowVisible(ch):
                # Only sync back to "restored" when the window is genuinely
                # visible again (the user restored it externally). A window we
                # hid ourselves is not iconic but also not visible — leave it
                # minimized so tab_minimize / boss-key stay sticky.
                info["minimized"] = False
                restore_win(ch)
                show_win(ch)
                bring_to_top(ch)

        # Captured windows are independent top-levels owned by the app; while the
        # app is foreground, re-assert their top position so clicking the app
        # never covers them.
        if user32.GetForegroundWindow() == self.app_hwnd:
            for ch in list(self.captured):
                if not self.captured[ch].get("minimized") and user32.IsWindow(ch):
                    bring_to_top(ch)

        exclude = {self.app_hwnd}
        for ch in list(self.captured):
            if self.captured[ch].get("minimized"):
                exclude.add(ch)

        overlapping = enum_overlapping(app_rect, exclude)
        overlap_hwnds = {h for h, _, _ in overlapping}
        changed = False

        for hwnd, title, rect in overlapping:
            pos = (rect[0], rect[1])
            if hwnd in self._prev_pos:
                if self._prev_pos[hwnd] != pos and hwnd not in self.captured and self.capture_enabled:
                    orig_style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
                    self.captured[hwnd] = {
                        "title": title,
                        "orig_rect": rect,
                        "orig_style": orig_style,
                        "minimized": False,
                        "maximized": False,
                    }
                    self._bound_pids[hwnd] = get_pid(hwnd)
                    bring_to_top(hwnd)
                    changed = True
            self._prev_pos[hwnd] = pos

        for hwnd in list(self._prev_pos):
            if hwnd not in overlap_hwnds and hwnd not in self.captured:
                del self._prev_pos[hwnd]

        if changed:
            self._push_captures()

    def _push_captures(self):
        items = [
            {"hwnd": h, "title": i["title"], "minimized": bool(i.get("minimized"))}
            for h, i in self.captured.items()
        ]
        payload = json.dumps(items, ensure_ascii=False, sort_keys=True)
        if payload != self._last_captures_json:
            self._last_captures_json = payload
            self.send({"ev": "captures", "items": items})

    def _check_new_pid_windows(self):
        if not self.capture_enabled or self._paused or not self.app_hwnd:
            return
        if self._app_minimized or self._hidden_by_auto:
            return
        if not self._bound_pids:
            return
        fg = user32.GetForegroundWindow()
        if not fg:
            return
        fg_changed = fg != self._last_fg_hwnd
        self._last_fg_hwnd = fg
        if not fg_changed:
            return
        fg_pid = get_pid(fg)
        bound_pid_set = set(self._bound_pids.values())
        if fg_pid in bound_pid_set:
            self._auto_capture_related()
        elif fg in self.captured:
            self._auto_capture_related()

    def _poll_pid_windows(self):
        if not self.capture_enabled or self._paused or not self.app_hwnd:
            return
        if self._app_minimized or self._hidden_by_auto:
            return
        if not self._bound_pids:
            return
        self._auto_capture_related()

    def _auto_capture_related(self):
        if not self.captured:
            return
        bound_pid_set = set(self._bound_pids.values())
        captured_hwnds = set(self.captured.keys())
        exclude = {self.app_hwnd} | captured_hwnds
        new_wins = []

        @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        def cb(hwnd, _):
            if hwnd in exclude:
                return True
            if not user32.IsWindowVisible(hwnd):
                return True
            if user32.IsIconic(hwnd):
                return True
            if is_skip(hwnd):
                return True
            r = get_wrect(hwnd)
            if not r:
                return True
            if (r[2] - r[0]) <= 60 or (r[3] - r[1]) <= 60:
                return True
            pid = get_pid(hwnd)
            owner = user32.GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT)
            related = (pid in bound_pid_set) or (owner in captured_hwnds)
            if not related:
                return True
            t = get_wtitle(hwnd)
            if not t:
                return True
            new_wins.append((hwnd, t, r, pid))
            return True

        user32.EnumWindows(cb, 0)
        if not new_wins:
            return
        changed = False
        for hwnd, title, rect, pid in new_wins:
            if hwnd in self.captured:
                continue
            orig_style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
            self.captured[hwnd] = {
                "title": title,
                "orig_rect": rect,
                "orig_style": orig_style,
                "minimized": False,
                "maximized": False,
                "auto": True,
            }
            self._bound_pids[hwnd] = pid
            self._prev_pos[hwnd] = (rect[0], rect[1])
            bring_to_top(hwnd)
            changed = True
            self._log(f"auto-captured: {title} hwnd={hwnd} pid={pid}")
        if changed:
            self._push_captures()

    def _log(self, msg):
        try:
            path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.log")
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        except Exception:
            pass

    def _begin_drag(self):
        if not self.app_hwnd or not user32.IsWindow(self.app_hwnd):
            return
        r = get_wrect(self.app_hwnd)
        if not r:
            return
        mx, my = get_cursor_pos()
        self.drag = {
            "hwnd": self.app_hwnd,
            "ox": mx - r[0],
            "oy": my - r[1],
            "w": r[2] - r[0],
            "h": r[3] - r[1],
        }

    def _drag_once(self):
        d = self.drag
        if not d:
            return
        if not (user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000):
            self.drag = None
            return
        h = d["hwnd"]
        if not user32.IsWindow(h):
            self.drag = None
            return
        mx, my = get_cursor_pos()
        move_win(h, mx - d["ox"], my - d["oy"], d["w"], d["h"])

    # Global "SSS" boss key. The engine polls the physical S key regardless of
    # which window has focus, so the sequence fires even when the app is hidden
    # or minimized (the host renderer never sees key events in that state).
    def _sss_once(self):
        down = bool(user32.GetAsyncKeyState(VK_S) & 0x8000)
        if down and not self._s_prev:
            now = time.monotonic()
            self._s_times.append(now)
            self._s_times = [t for t in self._s_times if now - t <= 1.2]
            if len(self._s_times) >= 3:
                self._s_times = []
                self._fire_sss()
        self._s_prev = down

    def _fire_sss(self):
        # Boss key (emergency mode): minimize every bound window so nothing
        # private is visible, then let the host focus a clean default tab and
        # minimize the app. Marking them minimized=True (not just hiding) makes
        # the state sticky: when the app is restored these windows stay
        # minimized until the user explicitly restores a tab.
        for h in list(self.captured):
            if user32.IsWindow(h) and not self.captured[h].get("minimized"):
                self.captured[h]["minimized"] = True
                hide_win(h)
        self._push_captures()
        self.send({"ev": "sss"})

    def _follow_once(self):
        if not self.app_hwnd or not user32.IsWindow(self.app_hwnd):
            return
        new_rect = get_wrect(self.app_hwnd)
        if not new_rect:
            return
        if self._paused:
            self._prev_app_rect = new_rect
            return
        old = self._prev_app_rect
        if old and not self._hidden_by_auto:
            dx, dy = new_rect[0] - old[0], new_rect[1] - old[1]
            if dx or dy:
                for ch in list(self.captured):
                    if self.captured[ch].get("minimized"):
                        continue
                    r = get_wrect(ch)
                    if r:
                        move_win(ch, r[0] + dx, r[1] + dy, r[2] - r[0], r[3] - r[1])
        self._prev_app_rect = new_rect

    def _zoom_once(self):
        if not self.app_hwnd or self._hidden_by_auto or self._paused:
            return
        for ch in list(self.captured):
            if self.captured[ch].get("minimized"):
                continue
            if user32.IsWindow(ch) and user32.IsZoomed(ch):
                restore_win(ch)
                if self.browser_area:
                    bx, by, bw, bh = self.browser_area
                    move_win(ch, bx, by, bw, bh)

    def _auto_hide_once(self):
        if not self.auto_hide or not self.app_hwnd or not self._prev_app_rect:
            return
        mx, my = get_cursor_pos()
        in_area = pt_in_rect(mx, my, self._prev_app_rect)
        if not in_area:
            # Keep the app alive while the cursor is over any bound window, so
            # the user can interact with captured windows even where they extend
            # past the app rect. Auto-hide only fires once the cursor has left
            # BOTH the app and every visible bound window.
            for ch, info in list(self.captured.items()):
                if info.get("minimized"):
                    continue
                if not user32.IsWindow(ch) or not user32.IsWindowVisible(ch):
                    continue
                r = get_wrect(ch)
                if r and pt_in_rect(mx, my, r):
                    in_area = True
                    break
        if not self._hidden_by_auto and not in_area:
            self._do_min_all()
        elif self._hidden_by_auto and in_area:
            self._do_restore_all()

    def _do_min_all(self):
        self._hidden_by_auto = True
        if user32.IsWindow(self.app_hwnd):
            hide_win(self.app_hwnd)
        for h in list(self.captured):
            hide_win(h)
        self.send({"ev": "app_hidden", "value": True})

    def _do_restore_all(self):
        self._hidden_by_auto = False
        if user32.IsWindow(self.app_hwnd):
            show_win(self.app_hwnd)
            bring_to_top(self.app_hwnd)
        for h in list(self.captured):
            if not self.captured[h].get("minimized"):
                show_win(h)
        self.send({"ev": "app_hidden", "value": False})

    # ── Main loop ───────────────────────────────────────

    def run(self):
        t_cap = t_zoom = t_hide = t_follow = t_fg = t_poll = 0.0
        while self._running:
            now = time.monotonic()
            while True:
                try:
                    msg = self._cmds.get_nowait()
                except queue.Empty:
                    break
                try:
                    self._handle_cmd(msg)
                except Exception:
                    pass
            try:
                self._sss_once()
                if self.drag:
                    self._drag_once()
                if now >= t_follow:
                    self._follow_once()
                    t_follow = now + 0.05
                if now >= t_fg:
                    self._check_new_pid_windows()
                    t_fg = now + 0.05
                if now >= t_cap:
                    self._capture_once()
                    self._push_captures()
                    t_cap = now + 0.2
                if now >= t_zoom:
                    self._zoom_once()
                    t_zoom = now + 0.06
                if now >= t_hide:
                    self._auto_hide_once()
                    t_hide = now + 0.3
                if now >= t_poll:
                    self._poll_pid_windows()
                    t_poll = now + 2.0
            except Exception:
                pass
            time.sleep(0.01)
        for h in list(self.captured):
            try:
                self._release_window(h)
            except Exception:
                pass


def main():
    eng = CaptureEngine()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    srv.close()
    threading.Thread(target=eng._serve, args=(port,), daemon=True).start()
    print(json.dumps({"ev": "ready", "port": port}), flush=True)
    try:
        eng.run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
