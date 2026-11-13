import ctypes
import ctypes.wintypes as wt
import tkinter as tk
from tkinter import messagebox
import json
import os
import sys
import shutil

# Window titles can contain characters the console codec (gbk on zh-CN Windows)
# cannot encode; an unhandled UnicodeEncodeError inside an `after` callback would
# kill the whole monitor loop. Force UTF-8 with replacement so prints are safe.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# WebView2 delivers its async COM callbacks on an STA message pump; tkinter's
# mainloop pumps that loop, but COM must be initialized apartment-threaded.
sys.coinit_flags = 2  # COINIT_APARTMENTTHREADED, must precede comtypes import
import comtypes
import comtypes.client

_WV2_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wv2")
_WV2_TLB = os.path.join(_WV2_DIR, "WebView2.tlb")
_WV2_LOADER = os.path.join(_WV2_DIR, "WebView2Loader.dll")
_WV2 = {"mod": None, "loader": None, "app": None, "rect": None}

# WebView2 creation completions arrive via COM callbacks. Implementing them as
# comtypes COMObjects is fatal whenever WebView2 invokes them off the main
# thread (its server thunk restores a NULL thread state and kills the
# interpreter). A hand-built vtable backed by plain ctypes callbacks is
# cross-thread GIL-safe, so Invoke only records the result and the main thread
# picks it up by polling.
_IID_IUNKNOWN = bytes.fromhex("0000000000000000c000000000000046")
_E_NOINTERFACE = -2147467262

_QI_T = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.POINTER(ctypes.c_void_p))
_UL_T = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
_INV_T = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.HRESULT,
                            ctypes.c_void_p)


class _HandlerVTable(ctypes.Structure):
    _fields_ = [("QueryInterface", _QI_T), ("AddRef", _UL_T),
                ("Release", _UL_T), ("Invoke", _INV_T)]


_WV2_REG = {}


def _h_qi(self, riid, ppv):
    reg = _WV2_REG.get(self)
    iid = ctypes.string_at(riid, 16)
    if reg and (iid == _IID_IUNKNOWN or iid in reg["iids"]):
        ppv[0] = self
        reg["refs"] += 1
        return 0
    ppv[0] = None
    return _E_NOINTERFACE


def _h_addref(self):
    reg = _WV2_REG.get(self)
    if reg:
        reg["refs"] += 1
        return reg["refs"]
    return 0


def _h_release(self):
    reg = _WV2_REG.get(self)
    if reg:
        reg["refs"] -= 1
        return reg["refs"]
    return 0


def _h_invoke(self, errorCode, ptr):
    reg = _WV2_REG.get(self)
    if reg is not None:
        if ptr:
            vtable = ctypes.c_void_p.from_address(ptr).value
            addref = _UL_T.from_address(vtable + ctypes.sizeof(ctypes.c_void_p))
            addref(ptr)
        reg["result"] = (errorCode, ptr)
    return 0


def _wv2_make_handler(iid):
    vt = _HandlerVTable()
    vt.QueryInterface = _QI_T(_h_qi)
    vt.AddRef = _UL_T(_h_addref)
    vt.Release = _UL_T(_h_release)
    vt.Invoke = _INV_T(_h_invoke)
    # A COM object pointer is a cell holding the vtable pointer, not the vtable.
    cell = ctypes.c_void_p(ctypes.addressof(vt))
    reg = {"refs": 1, "iids": {iid}, "result": None, "vt": vt, "cell": cell,
           "ptr": ctypes.addressof(cell),
           "cbs": (vt.QueryInterface, vt.AddRef, vt.Release, vt.Invoke)}
    _WV2_REG[reg["ptr"]] = reg
    return reg


def _wv2_iid(iface):
    return ctypes.string_at(ctypes.byref(iface._iid_), 16)


def _wv2_wrap(iface, addr):
    # comtypes COM interface pointers auto-deref: the cast result is usable as
    # the interface itself. The reference taken in _h_invoke keeps it alive.
    return ctypes.cast(ctypes.c_void_p(addr), ctypes.POINTER(iface))


def _wv2_boot():
    if _WV2["mod"] is None:
        mod = comtypes.client.GetModule(_WV2_TLB)
        loader = ctypes.WinDLL(_WV2_LOADER)
        loader.CreateCoreWebView2EnvironmentWithOptions.argtypes = [
            ctypes.c_wchar_p, ctypes.c_wchar_p,
            ctypes.POINTER(mod.ICoreWebView2EnvironmentOptions),
            ctypes.c_void_p,
        ]
        loader.CreateCoreWebView2EnvironmentWithOptions.restype = ctypes.HRESULT
        _WV2["mod"] = mod
        _WV2["loader"] = loader
        _WV2["rect"] = mod.tagRECT
    return _WV2


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
user32.SetForegroundWindow.restype = wt.BOOL
user32.SetForegroundWindow.argtypes = [wt.HWND]
user32.GetForegroundWindow.restype = wt.HWND
user32.IsWindow.restype = wt.BOOL
user32.IsWindow.argtypes = [wt.HWND]
user32.PostMessageW.restype = wt.BOOL
user32.PostMessageW.argtypes = [wt.HWND, ctypes.c_uint, ctypes.wintypes.WPARAM, ctypes.wintypes.LPARAM]
user32.GetWindowThreadProcessId.restype = wt.DWORD
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.keybd_event.restype = None
user32.keybd_event.argtypes = [ctypes.c_ubyte, ctypes.c_ubyte, wt.DWORD, ctypes.POINTER(ctypes.c_ulong)]
user32.SetWindowPos.restype = wt.BOOL
user32.SetWindowPos.argtypes = [
    wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_uint,
]
user32.GetParent.restype = wt.HWND
user32.GetParent.argtypes = [wt.HWND]
user32.IsIconic.restype = wt.BOOL
user32.IsIconic.argtypes = [wt.HWND]
user32.IsZoomed.restype = wt.BOOL
user32.IsZoomed.argtypes = [wt.HWND]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [wt.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.ClientToScreen.restype = wt.BOOL
user32.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
user32.SetParent.restype = wt.HWND
user32.SetParent.argtypes = [wt.HWND, wt.HWND]

GWL_EXSTYLE = -20
GWL_STYLE = -16
GWLP_HWNDPARENT = -8
WS_MAXIMIZEBOX = 0x00010000
WS_MINIMIZEBOX = 0x00020000
WS_SYSMENU = 0x00080000
WS_THICKFRAME = 0x00040000
WS_CAPTION = 0x00C00000
WS_POPUP = 0x80000000
WS_CHILD = 0x40000000
WS_VISIBLE = 0x10000000
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

SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.window_catcher.json')

TOOLBAR_H = 35
ADDRBAR_H = 32
BROWSER_H = 500
CAP_PANEL_H = 100

# Refined dark chrome palette (Edge/Chromium-dark inspired).
TH_BAR = "#1f2023"        # toolbar + tab strip base
TH_TAB = "#2a2b30"        # inactive tab / control fill
TH_TAB_ACT = "#3a3b41"    # active tab fill
TH_HOVER = "#34353b"      # hover fill
TH_FG = "#c9cbd1"         # secondary text
TH_FG_ACT = "#ffffff"     # active text
TH_ADDR = "#26272b"       # address bar base
TH_PILL = "#33343a"       # URL pill fill
TH_ACCENT = "#5b9dff"     # accent (go button / active underline)
TH_SEP = "#3a3b41"        # separators


def _bind_hover(w, enter_bg, leave_bg):
    w.bind("<Enter>", lambda e: w.config(bg=enter_bg))
    w.bind("<Leave>", lambda e: w.config(bg=leave_bg))


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
    dwm = ctypes.windll.dwmapi
    attr = ctypes.c_int(0)
    if dwm.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(attr), ctypes.sizeof(attr)) == 0:
        if attr.value != 0:
            return True
    return False


def move_win(hwnd, x, y, w, h):
    user32.MoveWindow(hwnd, x, y, w, h, True)


def min_win(hwnd):
    user32.ShowWindow(hwnd, SW_MINIMIZE)


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


def set_style(hwnd, style):
    user32.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
    user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)


def get_nc_borders(hwnd):
    wr = wt.RECT()
    cr = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(wr))
    user32.GetClientRect(hwnd, ctypes.byref(cr))
    pt = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    left = pt.x - wr.left
    top = pt.y - wr.top
    right = wr.right - (pt.x + cr.right)
    bottom = wr.bottom - (pt.y + cr.bottom)
    return max(left, 0), max(top, 0), max(right, 0), max(bottom, 0)


def find_hwnd_by_pid(pid):
    result = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        if is_skip(hwnd):
            return True
        wp = ctypes.c_uint32()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wp))
        if wp.value == pid:
            t = get_wtitle(hwnd)
            if t:
                result.append(hwnd)
                return False
        return True

    user32.EnumWindows(cb, 0)
    return result[0] if result else None


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
                rw, rh = r[2] - r[0], r[3] - r[1]
                if rw > 60 and rh > 60:
                    results.append((hwnd, t, r))
        return True

    user32.EnumWindows(cb, 0)
    return results


class WindowCatcherApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("窗口捕获工具")
        self.root.geometry("700x750")
        self.root.configure(bg="#e0e0e0")

        self.auto_hide_var = tk.BooleanVar(value=False)
        self.topmost_var = tk.BooleanVar(value=False)
        self.alpha_var = tk.DoubleVar(value=1.0)
        self.url_var = tk.StringVar(value="https://www.bing.com")

        self.captured = {}
        self._prev_pos = {}
        self._prev_rect = {}
        self._hidden_by_auto = False
        self._my_hwnd = None
        self._win_rect = None
        self._prev_win_rect = None
        self._profile_dir = ""
        self._wv2_env = None
        self._wv2_tabs = []
        self._wv2_active = 0
        self._wv2_keepalive = []
        self._wv2_area_visible = True
        self._suppress = False
        self._ready = False
        self._panel_dirty = True
        self._minimized = False

        self._load_settings()
        self._build_ui()
        self._bind_events()

        # Create the WebView2 environment before the mainloop starts. Creating it
        # from inside a tkinter `after` tick makes the COM completion callback
        # fire re-entrantly and fatally corrupt interpreter GIL state every time;
        # pre-mainloop creation is the stable placement.
        self.root.update_idletasks()
        self._init_webview()

        self.root.after(300, self._init_hwnd)
        self.root.mainloop()

    def _init_hwnd(self):
        hwnd = self._get_hwnd()
        self.root.update_idletasks()
        self._win_rect = get_wrect(hwnd) if hwnd else None
        if not self._win_rect:
            self._win_rect = (
                self.root.winfo_rootx(),
                self.root.winfo_rooty(),
                self.root.winfo_rootx() + self.root.winfo_width(),
                self.root.winfo_rooty() + self.root.winfo_height(),
            )
        self._prev_win_rect = self._win_rect
        self._ready = True
        self._disable_root_maximize()
        self.root.attributes("-topmost", bool(self.topmost_var.get()))
        self._apply_alpha()
        self._schedule()

    def _get_hwnd(self):
        if self._my_hwnd is None:
            self.root.update_idletasks()
            child = self.root.winfo_id()
            self._my_hwnd = user32.GetParent(child) or child
        return self._my_hwnd

    # ── UI ──────────────────────────────────────────────

    def _build_ui(self):
        toolbar = tk.Frame(self.root, bg=TH_BAR, height=TOOLBAR_H)
        toolbar.pack(fill=tk.X)
        toolbar.pack_propagate(False)

        tk.Label(toolbar, text="  窗口捕获工具", bg=TH_BAR, fg=TH_FG_ACT,
                 font=("Microsoft YaHei UI", 10, "bold")).pack(side=tk.LEFT, padx=5)

        self._hide_cb = tk.Checkbutton(
            toolbar, text="鼠标离开自动隐藏",
            variable=self.auto_hide_var, command=self._on_toggle_hide,
            bg=TH_BAR, fg=TH_FG, activebackground=TH_BAR, activeforeground=TH_FG_ACT,
            selectcolor=TH_TAB, font=("Microsoft YaHei UI", 9)
        )
        self._hide_cb.pack(side=tk.LEFT, padx=10)

        self._top_cb = tk.Checkbutton(
            toolbar, text="置顶",
            variable=self.topmost_var, command=self._apply_topmost,
            bg=TH_BAR, fg=TH_FG, activebackground=TH_BAR, activeforeground=TH_FG_ACT,
            selectcolor=TH_TAB, font=("Microsoft YaHei UI", 9)
        )
        self._top_cb.pack(side=tk.RIGHT, padx=(2, 10))

        for txt, cmd in (("透明度", self._open_opacity),
                         ("设置", self._open_settings)):
            b = tk.Button(toolbar, text=txt, command=cmd,
                          bg=TH_TAB, fg=TH_FG, activebackground=TH_HOVER,
                          activeforeground=TH_FG_ACT, relief="flat", bd=0,
                          font=("Microsoft YaHei UI", 9), padx=8, pady=1,
                          cursor="hand2")
            b.pack(side=tk.RIGHT, padx=2, pady=6)
            _bind_hover(b, TH_HOVER, TH_TAB)

        self._tab_frame = tk.Frame(toolbar, bg=TH_BAR)
        self._tab_frame.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)

        addr = tk.Frame(self.root, bg=TH_ADDR, height=ADDRBAR_H)
        addr.pack(fill=tk.X)
        addr.pack_propagate(False)

        for sym, cmd in (("←", self._browser_back), ("→", self._browser_fwd),
                         ("↻", self._browser_reload)):
            b = tk.Button(addr, text=sym, command=cmd, bg=TH_ADDR, fg=TH_FG,
                          activebackground=TH_HOVER, activeforeground=TH_FG_ACT,
                          relief="flat", bd=0, padx=7, cursor="hand2",
                          font=("Segoe UI", 11))
            b.pack(side=tk.LEFT, padx=1, pady=4)
            _bind_hover(b, TH_HOVER, TH_ADDR)

        self._url_entry = tk.Entry(
            addr, textvariable=self.url_var, font=("Segoe UI", 10),
            bg=TH_PILL, fg=TH_FG_ACT, insertbackground=TH_FG_ACT,
            relief="flat", bd=0, highlightthickness=1,
            highlightbackground=TH_SEP, highlightcolor=TH_ACCENT)
        self._url_entry.pack(side=tk.LEFT, fill=tk.X, expand=True,
                             padx=6, pady=6, ipady=3)
        self._url_entry.bind("<Return>", lambda e: self._browser_go())

        go = tk.Button(addr, text="转到", command=self._browser_go,
                       bg=TH_ACCENT, fg="white", activebackground="#7db2ff",
                       relief="flat", bd=0, padx=14, cursor="hand2",
                       font=("Microsoft YaHei UI", 9))
        go.pack(side=tk.LEFT, padx=(0, 6), pady=6)
        _bind_hover(go, "#7db2ff", TH_ACCENT)

        tk.Frame(self.root, bg=TH_SEP, height=1).pack(fill=tk.X)

        self._browser_spacer = tk.Frame(self.root, bg="#17181a", height=BROWSER_H)
        self._browser_spacer.pack(fill=tk.X)
        self._browser_spacer.pack_propagate(False)

        cap_frame = tk.Frame(self.root, bg="#e8e8e8", height=CAP_PANEL_H)
        cap_frame.pack(fill=tk.X)
        cap_frame.pack_propagate(False)

        tk.Label(cap_frame, text="已捕获窗口:", bg="#e8e8e8",
                 font=("Microsoft YaHei UI", 8), anchor="w").pack(fill=tk.X, padx=5, pady=(2, 0))

        list_frame = tk.Frame(cap_frame, bg="#e8e8e8")
        list_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=2)

        self._cap_listbox = tk.Listbox(
            list_frame, height=3, selectmode=tk.EXTENDED,
            font=("Microsoft YaHei UI", 8), relief="sunken", bd=1
        )
        self._cap_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self._cap_listbox.bind("<<ListboxSelect>>", self._on_cap_select)
        self._cap_listbox.bind("<Double-Button-1>", self._on_cap_double)
        self._cap_listbox.bind("<Button-3>", self._on_cap_right)

        cap_btn_frame = tk.Frame(list_frame, bg="#e8e8e8")
        cap_btn_frame.pack(side=tk.RIGHT, padx=(5, 0))

        self._release_btn = tk.Button(
            cap_btn_frame, text="释放", command=self._release_selected,
            state=tk.DISABLED, bg="#f0f0f0", relief="flat",
            font=("Microsoft YaHei UI", 8), padx=8
        )
        self._release_btn.pack(fill=tk.X, pady=2)

        tk.Button(cap_btn_frame, text="全部释放", command=self._release_all,
                  bg="#f0f0f0", relief="flat", font=("Microsoft YaHei UI", 8),
                  padx=8).pack(fill=tk.X, pady=2)

        self._status = tk.Label(self.root, text="就绪中...",
                                bg="#e0e0e0", fg="#666",
                                font=("Microsoft YaHei UI", 8), anchor="w")
        self._status.pack(fill=tk.X, padx=5, pady=2)

    def _bind_events(self):
        self.root.bind("<Configure>", self._on_configure)
        self.root.bind("<Map>", self._on_map)
        self.root.bind("<Activate>", self._on_activate)
        self.root.protocol("WM_DELETE_WINDOW", self._do_close)

    def _on_activate(self, event):
        if not self._ready:
            return
        for hwnd in list(self.captured):
            if user32.IsWindow(hwnd) and not self.captured[hwnd].get("minimized"):
                bring_to_top(hwnd)

    def _on_cap_select(self, _):
        sel = self._cap_listbox.curselection()
        self._release_btn.config(state=tk.NORMAL if sel else tk.DISABLED)

    def _on_cap_double(self, _):
        for hwnd in self._get_selected_hwnds():
            if hwnd in self.captured:
                info = self.captured[hwnd]
                if info.get("minimized"):
                    info["minimized"] = False
                    show_win(hwnd)
                    bring_to_top(hwnd)
                    self._panel_dirty = True
                else:
                    self._release_selected()
                    break

    def _on_cap_right(self, e):
        idx = self._cap_listbox.nearest(e.y)
        if idx >= 0:
            self._cap_listbox.selection_clear(0, tk.END)
            self._cap_listbox.selection_set(idx)
            self._release_selected()

    def _get_selected_hwnds(self):
        hwnd_list = list(self.captured.keys())
        return [hwnd_list[i] for i in self._cap_listbox.curselection() if i < len(hwnd_list)]

    def _release_window(self, hwnd):
        info = self.captured.pop(hwnd, None)
        self._prev_pos.pop(hwnd, None)
        self._prev_rect.pop(hwnd, None)
        if not user32.IsWindow(hwnd):
            return
        if info and info.get("minimized"):
            restore_win(hwnd)
            show_win(hwnd)
            bring_to_top(hwnd)
        if info and "orig_owner" in info:
            set_owner(hwnd, info["orig_owner"])
        if info and "orig_style" in info:
            set_style(hwnd, info["orig_style"])

    def _release_selected(self):
        for hwnd in self._get_selected_hwnds():
            self._release_window(hwnd)
        self._panel_dirty = True
        self._update_status()

    def _release_all(self):
        for hwnd in list(self.captured):
            self._release_window(hwnd)
        self.captured.clear()
        self._prev_pos.clear()
        self._prev_rect.clear()
        self._panel_dirty = True
        self._update_status()

    # ── Browser ─────────────────────────────────────────

    def _get_browser_area(self):
        self.root.update_idletasks()
        x = self._browser_spacer.winfo_rootx()
        y = self._browser_spacer.winfo_rooty()
        w = self._browser_spacer.winfo_width()
        h = BROWSER_H
        return (x, y, max(w, 100), h)

    def _clean_profile(self, profile):
        # Purge regenerable Chromium bloat and caches so the profile stays small.
        # Login data (Cookies, Login Data, Local Storage, Web Data) is never
        # touched, so 抖店 logins survive.
        heavy_dirs = [
            "Crashpad", "BrowserMetrics", "Subresource Filter",
            "GrShaderCache", "ShaderCache", "component_crx_cache",
            "Speech Recognition", "hyphen-data", "SmartScreen",
            "EdgeLanguageDetectionModel", "Edge Sidebar", "Safe Browsing",
            "ZxcvbnData", "Typosquatting", "ProvenanceDataTensors",
            "ProvenanceData", "Edge Signal Triggers", "Edge Entity Extraction",
            "Edge Wallet", "Edge Shopping", "Edge Coupons", "EdgeHubApp",
            "Cache", "Code Cache", "GPUCache", "DawnWebGPUCache",
            "DawnGraphiteCache", "Application Cache", "DawnCache",
        ]
        heavy_files = ["BrowserMetrics-spare.pma"]
        bases = [
            profile,
            os.path.join(profile, "Default"),
            os.path.join(profile, "EBWebView"),
            os.path.join(profile, "EBWebView", "Default"),
        ]
        for base in bases:
            for d in heavy_dirs:
                try:
                    p = os.path.join(base, d)
                    if os.path.isdir(p):
                        shutil.rmtree(p, ignore_errors=True)
                except Exception:
                    pass
            for f in heavy_files:
                try:
                    p = os.path.join(base, f)
                    if os.path.isfile(p):
                        os.remove(p)
                except Exception:
                    pass

    def _init_webview(self):
        try:
            _wv2_boot()
        except Exception as e:
            self._status.config(text=f"WebView2 初始化失败: {e}")
            return
        _WV2["app"] = self
        profile = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), ".browser_profile")
        os.makedirs(profile, exist_ok=True)
        self._profile_dir = profile
        self._clean_profile(profile)
        # Cap on-disk cache and stop crash/metrics/component bloat at the source.
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
            "--disk-cache-size=16777216 --disable-breakpad "
            "--disable-crash-reporter --metrics-recording-only "
            "--disable-component-update"
        )
        mod = _WV2["mod"]
        self._wv2_env_reg = _wv2_make_handler(
            _wv2_iid(mod.ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler))
        self._wv2_keepalive.append(self._wv2_env_reg)
        hr = _WV2["loader"].CreateCoreWebView2EnvironmentWithOptions(
            None, profile, None, self._wv2_env_reg["ptr"])
        if hr != 0:
            self._status.config(text=f"WebView2 环境创建失败: {hr}")
            return
        self.root.after(50, self._wv2_poll_env)

    def _wv2_poll_env(self):
        r = self._wv2_env_reg["result"]
        if r is None:
            self.root.after(50, self._wv2_poll_env)
            return
        errorCode, ptr = r
        if errorCode != 0 or not ptr:
            self._status.config(text=f"WebView2 环境错误: {errorCode}")
            return
        env = _wv2_wrap(_WV2["mod"].ICoreWebView2Environment, ptr)
        self._wv2_keepalive.append(env)
        self._wv2_env = env
        self._wv2_new_tab(self.url_var.get())

    def _wv2_new_tab(self, url=None):
        if not self._wv2_env:
            return
        mod = _WV2["mod"]
        reg = _wv2_make_handler(
            _wv2_iid(mod.ICoreWebView2CreateCoreWebView2ControllerCompletedHandler))
        reg["url"] = url or self.url_var.get()
        self._wv2_keepalive.append(reg)
        hptr = ctypes.cast(
            ctypes.c_void_p(reg["ptr"]),
            ctypes.POINTER(
                mod.ICoreWebView2CreateCoreWebView2ControllerCompletedHandler))
        self._wv2_env.CreateCoreWebView2Controller(
            int(self._browser_spacer.winfo_id()), hptr)
        self.root.after(50, lambda: self._wv2_poll_ctrl(reg))

    def _wv2_poll_ctrl(self, reg):
        r = reg["result"]
        if r is None:
            self.root.after(50, lambda: self._wv2_poll_ctrl(reg))
            return
        errorCode, ptr = r
        controller = _wv2_wrap(_WV2["mod"].ICoreWebView2Controller, ptr) if ptr else None
        self._wv2_on_controller(errorCode, controller, reg["url"])

    def _wv2_on_controller(self, errorCode, controller, url):
        if errorCode != 0 or not controller:
            self._status.config(text=f"WebView2 控制器错误: {errorCode}")
            return
        self._wv2_keepalive.append(controller)
        core = controller.CoreWebView2
        tab = {"controller": controller, "core": core, "title": "新标签", "url": ""}
        self._wv2_tabs.append(tab)
        self._wv2_layout()
        if url:
            core.Navigate(url)
        self._wv2_activate(len(self._wv2_tabs) - 1)

    def _wv2_layout(self):
        w = max(self._browser_spacer.winfo_width(), 100)
        rect_type = _WV2.get("rect") or wt.RECT
        rect = rect_type(0, 0, w, BROWSER_H)
        for t in self._wv2_tabs:
            t["controller"].Bounds = rect

    def _wv2_set_area_visible(self, visible):
        self._wv2_area_visible = bool(visible)
        for i, t in enumerate(self._wv2_tabs):
            try:
                t["controller"].IsVisible = (
                    i == self._wv2_active and self._wv2_area_visible)
            except Exception:
                pass

    def _wv2_active_core(self):
        if 0 <= self._wv2_active < len(self._wv2_tabs):
            return self._wv2_tabs[self._wv2_active]["core"]
        return None

    def _wv2_activate(self, idx):
        if not self._wv2_tabs:
            return
        idx = max(0, min(idx, len(self._wv2_tabs) - 1))
        self._wv2_active = idx
        for i, t in enumerate(self._wv2_tabs):
            try:
                t["controller"].IsVisible = (i == idx and self._wv2_area_visible)
            except Exception:
                pass
        core = self._wv2_active_core()
        if core:
            try:
                self.url_var.set(core.Source or "")
            except Exception:
                pass
        self._panel_dirty = True
        self._update_status()

    def _wv2_close_tab(self, idx):
        if not (0 <= idx < len(self._wv2_tabs)):
            return
        t = self._wv2_tabs.pop(idx)
        try:
            t["controller"].Close()
        except Exception:
            pass
        if not self._wv2_tabs:
            self._wv2_new_tab(self.url_var.get())
            return
        self._wv2_activate(min(self._wv2_active, len(self._wv2_tabs) - 1))

    def _wv2_poll_titles(self):
        try:
            changed = False
            for i, t in enumerate(self._wv2_tabs):
                try:
                    title = t["core"].DocumentTitle
                    if title and title != t["title"]:
                        t["title"] = title
                        changed = True
                except Exception:
                    pass
                try:
                    src = t["core"].Source or ""
                    if src != t["url"]:
                        t["url"] = src
                        if i == self._wv2_active:
                            self.url_var.set(src)
                        changed = True
                except Exception:
                    pass
            if changed:
                self._panel_dirty = True
        except Exception:
            pass
        finally:
            self.root.after(500, self._wv2_poll_titles)

    def _pos_maximized(self, hwnd):
        if hwnd not in self.captured:
            return
        bx, by, bw, bh = self._get_browser_area()
        move_win(hwnd, bx, by, bw, bh)

    def _browser_alive(self):
        return bool(self._wv2_tabs)

    def _browser_go(self):
        url = self.url_var.get().strip()
        if not url:
            return
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
            self.url_var.set(url)
        core = self._wv2_active_core()
        if core:
            core.Navigate(url)
        else:
            self._wv2_new_tab(url)

    def _browser_reload(self):
        core = self._wv2_active_core()
        if core:
            core.Reload()
        else:
            self._wv2_new_tab(self.url_var.get())

    def _browser_back(self):
        core = self._wv2_active_core()
        if core and core.CanGoBack:
            core.GoBack()

    def _browser_fwd(self):
        core = self._wv2_active_core()
        if core and core.CanGoForward:
            core.GoForward()

    def _restart_browser(self, url=None):
        for t in list(self._wv2_tabs):
            try:
                t["controller"].Close()
            except Exception:
                pass
        self._wv2_tabs = []
        self._wv2_active = 0
        if url:
            self.url_var.set(url)
        if self._wv2_env:
            self._wv2_new_tab(self.url_var.get())
        else:
            self._init_webview()

    # ── Capture ─────────────────────────────────────────

    def _monitor_capture(self):
        # Reschedule in a finally so a transient error can never permanently kill
        # the 200ms loop (which would leave captured windows unmanaged/covered).
        try:
            self._monitor_capture_once()
        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            self.root.after(200, self._monitor_capture)

    def _monitor_capture_once(self):
        if self._ready and self._win_rect:
            hwnd = self._get_hwnd()
            if hwnd and user32.IsIconic(hwnd):
                if not self._minimized:
                    self._minimized = True
                    self._wv2_set_area_visible(False)
                    for ch in list(self.captured):
                        hide_win(ch)
            elif self._minimized:
                self._minimized = False
                self._wv2_set_area_visible(True)
                for ch in list(self.captured):
                    if not self.captured[ch].get("minimized"):
                        show_win(ch)

            if self.root.winfo_viewable() and not self._suppress:
                wr = self._win_rect

                for ch in list(self.captured):
                    if not user32.IsWindow(ch):
                        self.captured.pop(ch, None)
                        self._prev_pos.pop(ch, None)
                        self._prev_rect.pop(ch, None)
                        self._panel_dirty = True
                        continue
                    info = self.captured[ch]
                    iconic = user32.IsIconic(ch)

                    if iconic and not info["minimized"]:
                        info["minimized"] = True
                        hide_win(ch)
                        self._panel_dirty = True
                    elif not iconic and info["minimized"]:
                        info["minimized"] = False
                        restore_win(ch)
                        show_win(ch)
                        bring_to_top(ch)
                        self._panel_dirty = True

                # Captured windows are independent top-level windows, so clicking
                # the app (toolbar / address bar) raises the app over them and
                # covers them. <Activate> won't re-fire while the app is already
                # active, so re-assert their top position here — but only while
                # the app is the foreground window, so we never fight the user
                # when they're in another app or in a captured window itself.
                my = self._get_hwnd()
                if my and user32.GetForegroundWindow() == my:
                    for ch in list(self.captured):
                        if not self.captured[ch].get("minimized") and user32.IsWindow(ch):
                            bring_to_top(ch)

                exclude = {self._get_hwnd()}
                for ch in list(self.captured):
                    if self.captured[ch].get("minimized"):
                        exclude.add(ch)

                overlapping = enum_overlapping(self._win_rect, exclude)

                overlap_hwnds = {h for h, _, _ in overlapping}

                for hwnd, title, rect in overlapping:
                    pos = (rect[0], rect[1])
                    if hwnd in self._prev_pos:
                        if self._prev_pos[hwnd] != pos and hwnd not in self.captured:
                            orig_style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
                            orig_owner = user32.GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT)
                            my = self._get_hwnd()
                            if my:
                                # Make the captured window owned by the app: an
                                # owned window always stays above its owner, so
                                # clicking the app can never cover/hide it.
                                set_owner(hwnd, my)
                            self.captured[hwnd] = {
                                "title": title,
                                "orig_rect": rect,
                                "orig_style": orig_style,
                                "orig_owner": orig_owner,
                                "minimized": False,
                                "maximized": False,
                            }
                            bring_to_top(hwnd)
                            self._panel_dirty = True
                    self._prev_pos[hwnd] = pos

                removed = False
                for hwnd in list(self.captured):
                    if self.captured[hwnd].get("minimized"):
                        continue
                    if hwnd not in overlap_hwnds:
                        del self.captured[hwnd]
                        self._prev_rect.pop(hwnd, None)
                        removed = True

                for hwnd in list(self._prev_pos):
                    if hwnd not in overlap_hwnds and hwnd not in self.captured:
                        del self._prev_pos[hwnd]

                for hwnd in list(self.captured):
                    info = self.captured[hwnd]
                    if info.get("minimized") or info.get("maximized"):
                        continue
                    r = get_wrect(hwnd)
                    if not r:
                        continue
                    prev = self._prev_rect.get(hwnd)
                    cur_w = r[2] - r[0]
                    cur_h = r[3] - r[1]
                    if prev:
                        prev_w = prev[2] - prev[0]
                        prev_h = prev[3] - prev[1]
                        if cur_w > prev_w or cur_h > prev_h:
                            nx = max(r[0], wr[0])
                            ny = max(r[1], wr[1])
                            nr = min(r[2], wr[2])
                            nb = min(r[3], wr[3])
                            nw = nr - nx
                            nh = nb - ny
                            if nw < cur_w or nh < cur_h or nx != r[0] or ny != r[1]:
                                move_win(hwnd, nx, ny, max(nw, 80), max(nh, 60))
                                r = get_wrect(hwnd) or r
                    self._prev_rect[hwnd] = r

                if removed:
                    self._panel_dirty = True

                self._update_panel()
                self._update_status()

    def _fast_zoom_check(self):
        # Same resilience as the capture loop: always reschedule.
        try:
            self._fast_zoom_check_once()
        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            self.root.after(60, self._fast_zoom_check)

    def _fast_zoom_check_once(self):
        if self._ready and self._win_rect and not self._suppress:
            for ch in list(self.captured):
                if self.captured[ch].get("minimized"):
                    continue
                if user32.IsWindow(ch) and user32.IsZoomed(ch):
                    restore_win(ch)
                    self._pos_maximized(ch)

    # ── Auto-hide ───────────────────────────────────────

    def _check_auto_hide(self):
        try:
            if self.auto_hide_var.get() and self._win_rect and self._ready:
                mx, my = get_cursor_pos()
                in_area = pt_in_rect(mx, my, self._win_rect)

                if not self._hidden_by_auto and not in_area:
                    self._hidden_by_auto = True
                    self._do_min_all()
                elif self._hidden_by_auto and in_area:
                    self._do_restore_all()
        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            self.root.after(300, self._check_auto_hide)

    def _on_toggle_hide(self):
        self._save_settings()
        if not self.auto_hide_var.get() and self._hidden_by_auto:
            self._do_restore_all()

    # ── Topmost / Opacity / Settings ────────────────────

    def _apply_topmost(self):
        self.root.attributes("-topmost", bool(self.topmost_var.get()))
        self._save_settings()

    def _apply_alpha(self, value=None):
        try:
            a = float(value) if value is not None else float(self.alpha_var.get())
        except (TypeError, ValueError):
            return
        a = min(max(a, 0.2), 1.0)
        self.root.attributes("-alpha", a)

    def _open_opacity(self):
        if getattr(self, "_opacity_win", None) is not None:
            try:
                self._opacity_win.lift()
                return
            except tk.TclError:
                self._opacity_win = None
        win = tk.Toplevel(self.root)
        self._opacity_win = win
        win.title("窗口透明度")
        win.configure(bg="#2d2d2d")
        win.resizable(False, False)
        win.attributes("-topmost", bool(self.topmost_var.get()))
        val_lbl = tk.Label(win, text=f"{int(self.alpha_var.get() * 100)}%",
                           bg="#2d2d2d", fg="white", font=("Microsoft YaHei UI", 10))
        val_lbl.pack(pady=(8, 0))

        def _on_slide(v):
            self.alpha_var.set(float(v))
            self._apply_alpha(v)
            val_lbl.config(text=f"{int(float(v) * 100)}%")

        tk.Scale(win, from_=0.2, to=1.0, resolution=0.01, orient=tk.HORIZONTAL,
                 variable=self.alpha_var, command=_on_slide, length=220,
                 bg="#2d2d2d", fg="white", troughcolor="#444",
                 activebackground="#0078d4", highlightthickness=0).pack(padx=12, pady=6)
        tk.Button(win, text="完成", command=win.destroy, bg="#0078d4", fg="white",
                  relief="flat", padx=16, font=("Microsoft YaHei UI", 9)).pack(pady=(0, 10))
        win.protocol("WM_DELETE_WINDOW", self._close_opacity)
        self._center_over_root(win)

    def _close_opacity(self):
        self._save_settings()
        if getattr(self, "_opacity_win", None) is not None:
            try:
                self._opacity_win.destroy()
            except tk.TclError:
                pass
            self._opacity_win = None

    def _open_settings(self):
        if getattr(self, "_settings_win", None) is not None:
            try:
                self._settings_win.lift()
                return
            except tk.TclError:
                self._settings_win = None
        win = tk.Toplevel(self.root)
        self._settings_win = win
        win.title("系统设置")
        win.configure(bg="#f0f0f0")
        win.resizable(False, False)
        win.attributes("-topmost", bool(self.topmost_var.get()))

        tk.Label(win, text="系统设置", bg="#f0f0f0", fg="#222",
                 font=("Microsoft YaHei UI", 11, "bold")).pack(anchor="w", padx=14, pady=(12, 6))

        tk.Checkbutton(win, text="鼠标离开自动隐藏", variable=self.auto_hide_var,
                       command=self._on_toggle_hide, bg="#f0f0f0", anchor="w",
                       font=("Microsoft YaHei UI", 9)).pack(fill=tk.X, padx=12, pady=2)
        tk.Checkbutton(win, text="主应用窗口置顶", variable=self.topmost_var,
                       command=self._apply_topmost, bg="#f0f0f0", anchor="w",
                       font=("Microsoft YaHei UI", 9)).pack(fill=tk.X, padx=12, pady=2)

        sep = tk.Frame(win, bg="#ddd", height=1)
        sep.pack(fill=tk.X, padx=12, pady=8)

        tk.Button(win, text="清理浏览器缓存并重启", command=self._settings_restart_browser,
                  bg="#f0f0f0", relief="solid", bd=1, anchor="w", padx=10,
                  font=("Microsoft YaHei UI", 9)).pack(fill=tk.X, padx=12, pady=2)
        tk.Button(win, text="释放所有已捕获窗口", command=self._settings_release_all,
                  bg="#f0f0f0", relief="solid", bd=1, anchor="w", padx=10,
                  font=("Microsoft YaHei UI", 9)).pack(fill=tk.X, padx=12, pady=2)

        tk.Button(win, text="关闭", command=self._close_settings, bg="#0078d4", fg="white",
                  relief="flat", padx=16, font=("Microsoft YaHei UI", 9)).pack(pady=12)
        win.protocol("WM_DELETE_WINDOW", self._close_settings)
        self._center_over_root(win)

    def _close_settings(self):
        self._save_settings()
        if getattr(self, "_settings_win", None) is not None:
            try:
                self._settings_win.destroy()
            except tk.TclError:
                pass
            self._settings_win = None

    def _settings_restart_browser(self):
        try:
            self._restart_browser()
        except Exception:
            import traceback
            traceback.print_exc()
        self._close_settings()

    def _settings_release_all(self):
        self._release_all()
        self._close_settings()

    def _center_over_root(self, win):
        win.update_idletasks()
        try:
            rx = self.root.winfo_rootx()
            ry = self.root.winfo_rooty()
            rw = self.root.winfo_width()
            rh = self.root.winfo_height()
            ww = win.winfo_width()
            wh = win.winfo_height()
            x = rx + max((rw - ww) // 2, 0)
            y = ry + max((rh - wh) // 2, 0)
            win.geometry(f"+{x}+{y}")
        except tk.TclError:
            pass

    def _disable_root_maximize(self):
        hwnd = self._get_hwnd()
        if not hwnd:
            return
        style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
        set_style(hwnd, style & ~WS_MAXIMIZEBOX)

    # ── Minimize / Restore ──────────────────────────────


    def _do_min_all(self):
        self._hidden_by_auto = True
        self.root.withdraw()
        for hwnd in list(self.captured):
            hide_win(hwnd)
        self._status.config(text="已隐藏", fg="#999")

    def _do_restore_all(self):
        self._hidden_by_auto = False
        self.root.deiconify()
        self.root.update_idletasks()
        for hwnd in list(self.captured):
            if not self.captured[hwnd].get("minimized"):
                show_win(hwnd)
        self._update_status()

    def _on_map(self, event):
        if self._hidden_by_auto:
            self._do_restore_all()

    # ── Resize / Move sync ──────────────────────────────

    def _on_configure(self, event):
        if event.widget != self.root or not self.root.winfo_viewable():
            return
        if getattr(self, '_in_configure', False):
            return
        self._in_configure = True

        hwnd = self._get_hwnd()
        new_rect = get_wrect(hwnd) if hwnd else None
        if not new_rect:
            self._in_configure = False
            return

        if self._prev_win_rect and self._ready and not self._suppress:
            old = self._prev_win_rect
            dx = new_rect[0] - old[0]
            dy = new_rect[1] - old[1]
            old_w = old[2] - old[0]
            old_h = old[3] - old[1]
            new_w = new_rect[2] - new_rect[0]
            new_h = new_rect[3] - new_rect[1]
            size_changed = (old_w != new_w or old_h != new_h)
            pos_changed = (dx != 0 or dy != 0)

            if pos_changed:
                for ch in list(self.captured):
                    info = self.captured[ch]
                    if info.get("minimized"):
                        continue
                    r = get_wrect(ch)
                    if r:
                        move_win(ch, r[0] + dx, r[1] + dy, r[2] - r[0], r[3] - r[1])

            if size_changed:
                for ch in list(self.captured):
                    info = self.captured[ch]
                    if info.get("minimized"):
                        continue
                    if info.get("maximized"):
                        bx, by, bw, bh = self._get_browser_area()
                        move_win(ch, bx, by, bw, bh)
                        continue
                    r = get_wrect(ch)
                    if r:
                        nx = max(r[0], new_rect[0])
                        ny = max(r[1], new_rect[1])
                        nr = min(r[2], new_rect[2])
                        nb = min(r[3], new_rect[3])
                        nw = nr - nx
                        nh = nb - ny
                        if nw < (r[2] - r[0]) or nh < (r[3] - r[1]) or nx != r[0] or ny != r[1]:
                            move_win(ch, nx, ny, max(nw, 80), max(nh, 60))

        self._win_rect = new_rect
        self._prev_win_rect = new_rect
        self._wv2_layout()
        self._in_configure = False

    # ── Panel / Status ──────────────────────────────────

    def _update_panel(self):
        if not self._panel_dirty:
            return
        self._panel_dirty = False
        self._cap_listbox.delete(0, tk.END)
        for hwnd in self.captured:
            info = self.captured[hwnd]
            title = info["title"]
            if len(title) > 35:
                title = title[:32] + "..."
            if info.get("minimized"):
                title = "[最小化] " + title
            elif info.get("maximized"):
                title = "[最大化] " + title
            self._cap_listbox.insert(tk.END, title)
        self._release_btn.config(state=tk.DISABLED)
        self._update_toolbar_tabs()

    def _update_toolbar_tabs(self):
        for w in self._tab_frame.winfo_children():
            w.destroy()
        for hwnd in self.captured:
            info = self.captured[hwnd]
            title = info["title"]
            if len(title) > 10:
                title = title[:9] + "…"
            tab = tk.Frame(self._tab_frame, bg=TH_TAB)
            tab.pack(side=tk.LEFT, padx=1, pady=5)
            if info.get("minimized"):
                btn_text = "▁ " + title
            else:
                btn_text = title
            btn = tk.Button(
                tab, text=btn_text,
                font=("Microsoft YaHei UI", 8),
                bg=TH_TAB, fg=TH_FG, activebackground=TH_HOVER,
                activeforeground=TH_FG_ACT, relief="flat", bd=0,
                padx=6, pady=1, cursor="hand2",
                command=lambda h=hwnd: self._on_tab_click(h)
            )
            btn.pack(side=tk.LEFT)
            _bind_hover(btn, TH_HOVER, TH_TAB)
            btn.bind("<Button-3>", lambda e, h=hwnd: self._on_tab_right(e, h))
            if not info.get("minimized"):
                min_btn = tk.Button(
                    tab, text="─", font=("Segoe UI", 7),
                    bg=TH_TAB, fg=TH_FG, activebackground=TH_HOVER,
                    activeforeground=TH_FG_ACT, relief="flat", bd=0,
                    padx=3, cursor="hand2",
                    command=lambda h=hwnd: self._on_tab_minimize(h)
                )
                min_btn.pack(side=tk.LEFT)
                _bind_hover(min_btn, TH_HOVER, TH_TAB)

        for i, t in enumerate(self._wv2_tabs):
            title = t.get("title") or "新标签"
            if len(title) > 10:
                title = title[:9] + "…"
            active = (i == self._wv2_active)
            bg = TH_TAB_ACT if active else TH_TAB
            fg = TH_FG_ACT if active else TH_FG
            btab = tk.Frame(self._tab_frame, bg=bg)
            btab.pack(side=tk.LEFT, padx=1, pady=5)
            bbtn = tk.Button(
                btab, text=title,
                font=("Microsoft YaHei UI", 8),
                bg=bg, fg=fg,
                activebackground=TH_HOVER, activeforeground=TH_FG_ACT,
                relief="flat", bd=0, padx=6, pady=1, cursor="hand2",
                command=lambda idx=i: self._wv2_activate(idx)
            )
            bbtn.pack(side=tk.LEFT)
            _bind_hover(bbtn, TH_HOVER, bg)
            bx = tk.Button(
                btab, text="×", font=("Segoe UI", 8),
                bg=bg, fg=TH_FG, activebackground=TH_HOVER,
                activeforeground=TH_FG_ACT, relief="flat", bd=0,
                padx=3, cursor="hand2",
                command=lambda idx=i: self._wv2_close_tab(idx)
            )
            bx.pack(side=tk.LEFT)
            _bind_hover(bx, TH_HOVER, bg)
        plus = tk.Button(
            self._tab_frame, text="+", font=("Segoe UI", 10),
            bg=TH_BAR, fg=TH_FG, activebackground=TH_HOVER,
            activeforeground=TH_FG_ACT, relief="flat", bd=0,
            padx=6, cursor="hand2",
            command=lambda: self._wv2_new_tab(self.url_var.get())
        )
        plus.pack(side=tk.LEFT, padx=2, pady=5)
        _bind_hover(plus, TH_HOVER, TH_BAR)

    def _on_tab_click(self, hwnd):
        if hwnd not in self.captured:
            return
        info = self.captured[hwnd]
        if info.get("minimized"):
            info["minimized"] = False
            restore_win(hwnd)
            show_win(hwnd)
            bring_to_top(hwnd)
        else:
            bring_to_top(hwnd)
        self._panel_dirty = True

    def _on_tab_minimize(self, hwnd):
        if hwnd in self.captured:
            self.captured[hwnd]["minimized"] = True
            hide_win(hwnd)
            self._panel_dirty = True

    def _on_tab_right(self, event, hwnd):
        if hwnd in self.captured:
            title = self.captured[hwnd]["title"]
            if not messagebox.askyesno("确认释放", f"确定要释放窗口「{title}」吗？"):
                return
            self._release_window(hwnd)
            self._panel_dirty = True
            self._update_status()

    def _update_status(self):
        n = len(self.captured)
        parts = [f"已捕获: {n} 个窗口"]
        if self._browser_alive():
            parts.append(f"浏览器: ✔ ({len(self._wv2_tabs)} 标签)")
        else:
            parts.append("浏览器: ✘")
        if self.auto_hide_var.get():
            parts.append("自动隐藏: 开")
        self._status.config(text="  |  ".join(parts), fg="#666")

    # ── Close ───────────────────────────────────────────

    def _do_close(self):
        self._save_settings()
        self._release_all()
        for t in list(self._wv2_tabs):
            try:
                t["controller"].Close()
            except Exception:
                pass
        self._wv2_tabs = []
        if getattr(self, "_profile_dir", None):
            self._clean_profile(self._profile_dir)
        self.root.destroy()

    # ── Settings ────────────────────────────────────────

    def _save_settings(self):
        data = {
            "auto_hide": self.auto_hide_var.get(),
            "topmost": bool(self.topmost_var.get()),
            "alpha": round(float(self.alpha_var.get()), 3),
            "url": self.url_var.get(),
        }
        if self._win_rect:
            data["rect"] = list(self._win_rect)
        try:
            with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
        except OSError:
            pass

    def _load_settings(self):
        try:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self.auto_hide_var.set(data.get("auto_hide", False))
            self.topmost_var.set(bool(data.get("topmost", False)))
            try:
                a = float(data.get("alpha", 1.0))
                self.alpha_var.set(min(max(a, 0.2), 1.0))
            except (TypeError, ValueError):
                self.alpha_var.set(1.0)
            url = data.get("url")
            if url:
                self.url_var.set(url)
            rect = data.get("rect")
            if rect and len(rect) == 4:
                x, y, x2, y2 = rect
                w = max(x2 - x, 400)
                h = max(y2 - y, 200)
                self.root.geometry(f"{w}x{h}+{x}+{y}")
        except (OSError, json.JSONDecodeError):
            pass

    # ── Scheduler ───────────────────────────────────────

    def _schedule(self):
        self._monitor_capture()
        self._fast_zoom_check()
        self._check_auto_hide()
        self._wv2_poll_titles()


if __name__ == "__main__":
    WindowCatcherApp()
