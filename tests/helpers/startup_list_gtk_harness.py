# SPDX-License-Identifier: GPL-3.0-or-later
# Test-only: builds StartupList, the widget of the "Startup apps" tab (startup_list.py),
# the way cinnamon-settings builds a custom widget, and checks it: the rows, the switch, Remove,
# the Pick button's D-Bus call, the pick results of the extension (the hidden key startup-pick:
# an application, which is added at once with an Undo, or a window without one, which opens the
# form), the "Startup Applications" button, the grey-out by "Enable Window Memory", the folder
# monitor, and that nothing raises out of the widget.
# Run by tests/startup-list.test.js, which skips the test when there is no display. The logic
# harness (startup_list_harness.py) stays without GTK: this file is the GTK half.
# Usage: python3 -B startup_list_gtk_harness.py <extension dir>
# Exit codes: 0 all checks passed, 1 a check failed, 77 cannot run here (no display or no GTK).
#
# Nothing here touches the real autostart folder, the real configuration or the real Cinnamon:
# before gi is imported XDG_CONFIG_HOME and XDG_CONFIG_DIRS point at a temp folder (the widget
# finds the user's and the system's autostart folders through GLib), GSettings uses the in-memory
# backend, the D-Bus proxy and Gio.Subprocess.new are replaced by recorders, and no dialog is
# shown (Gtk.Dialog.run is replaced by a recorder). Every desktop file is made up here.
import atexit
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import time

SKIP = 77

work = tempfile.mkdtemp(prefix='window-memory-startup-gtk-harness-')
atexit.register(shutil.rmtree, work, True)  # also when a check raises
CONFIG = os.path.join(work, 'config')
SYSCONFIG = os.path.join(work, 'sysconfig')
# GLib reads these once: set before gi is imported. LANGUAGE=C keeps the language of the session,
# and a translation installed for it, out of the text checks.
os.environ['XDG_CONFIG_HOME'] = CONFIG
os.environ['XDG_CONFIG_DIRS'] = SYSCONFIG
os.environ['XDG_DATA_HOME'] = os.path.join(work, 'data')
os.environ['GSETTINGS_BACKEND'] = 'memory'
os.environ['LANGUAGE'] = 'C'
USER = os.path.join(CONFIG, 'autostart')
SYSTEM = os.path.join(SYSCONFIG, 'autostart')
APPS = os.path.join(work, 'applications')
for folder in (USER, SYSTEM, APPS):
    os.makedirs(folder)

ext_dir = sys.argv[1]


def load_module(file_name='startup_list.py'):
    # The same three calls as xlet-settings.py:481-483.
    path = os.path.join(ext_dir, file_name)
    spec = importlib.util.spec_from_file_location('windowmemorybootkicker.' + file_name.split('.')[0], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The module is loaded before GTK, as the logic harness loads it: loading it must not load GTK.
try:
    import gi
    module = load_module()
    gtk_after_load = 'gi.repository.Gtk' in sys.modules
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gdk, Gio, GLib, Gtk
    from xapp.SettingsWidgets import SettingsWidget
    if not Gtk.init_check()[0]:
        raise RuntimeError('Gtk.init_check() failed: no display')
except Exception as e:  # ImportError, ValueError (missing typelib), RuntimeError
    print('cannot run: %s' % e)
    sys.exit(SKIP)

UUID = 'window-memory@bootkicker'
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
        print('FAIL: ' + message)


# The texts, word for word, spelled out here and not read from the module under test.
HINT = 'This command is a best guess from the window. Check it before adding.'
SYSTEM_NOTE = '(system entry)'
CHANGED = 'Nemo changed in the meantime and was left as it is.'


class FakeHandler(object):
    """The part of cinnamon-settings' JSONSettingsHandler that the widget uses, with its semantics
    (bin/JsonSettingsWidgets.py): bind() with GET sets the property at once and again on every
    set_value(); listen() only records; set_value() of a new value notifies the bindings and then
    every listener of the key, synchronously; set_value() of the same value does nothing."""
    instance_id = UUID

    def __init__(self, enabled=True, pick=''):
        self.values = {'enabled': enabled, 'startup-pick': pick}
        self.bindings = []
        self.listeners = {}
        self.sets = []

    def bind(self, key, obj, prop, direction, map_get=None, map_set=None):
        self.bindings.append((key, obj, prop, direction))
        obj.set_property(prop, self.values[key])

    def listen(self, key, callback):
        self.listeners.setdefault(key, []).append(callback)

    def get_value(self, key):
        return self.values[key]

    def set_value(self, key, value):
        if value == self.values[key]:
            return
        self.values[key] = value
        self.sets.append((key, value))
        for bound_key, obj, prop, direction in self.bindings:
            if bound_key == key:
                obj.set_property(prop, value)
        for callback in list(self.listeners.get(key, [])):
            callback(key, value)


class OtherHandler(FakeHandler):
    instance_id = 'instance-7'


class BareHandler(object):
    # No instance_id, no bind, no listen, no get_value, no set_value: the widget must still build.
    pass


class FakeProxy(object):
    def __init__(self, error=None):
        self.calls = []
        self.kwargs = []
        self.error = error

    def activateCallback(self, *args, **kwargs):
        self.calls.append(args)
        self.kwargs.append(kwargs)
        if self.error:
            raise self.error


class RecordingBus(object):
    """Stands in for Gio.DBusProxy.new_for_bus_sync: records the arguments, returns the fake proxy."""

    def __init__(self, proxy=None, error=None):
        self.calls = []
        self.proxy = proxy or FakeProxy()
        self.error = error

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        return self.proxy


class RecordingSpawn(object):
    """Stands in for Gio.Subprocess.new: records the arguments, starts nothing."""

    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        return object()


class Dialogs(object):
    """Stands in for Gtk.Dialog.run: records each dialog, lets the test fill it in (fill), and
    answers with the next of answers (CANCEL when they run out), so that no dialog appears."""

    def __init__(self):
        self.shown = []
        self.answers = []
        self.fill = None

    def run(self, dialog):
        shown = {'dialog': dialog, 'modal': dialog.get_modal(), 'parent': dialog.get_transient_for(),
                 'mapped': dialog.get_mapped(), 'title': dialog.get_title(),
                 'buttons': [name for name in ('OK', 'CANCEL', 'CLOSE', 'YES', 'NO', 'ACCEPT', 'APPLY')
                             if dialog.get_widget_for_response(getattr(Gtk.ResponseType, name)) is not None],
                 'labels': [w.get_text() for w in descendants(dialog, Gtk.Label)],
                 'dimmed': [w.get_text() for w in descendants(dialog, Gtk.Label)
                            if w.get_style_context().has_class('dim-label')],
                 'error': None}
        error = getattr(dialog, 'error_label', None)
        if error is not None and error.get_visible():
            shown['error'] = error.get_text()
        for name in ('name_entry', 'command_entry', 'comment_entry'):
            entry = getattr(dialog, name, None)
            shown[name] = entry.get_text() if entry is not None else None
        spin = getattr(dialog, 'delay_spin', None)
        shown['delay'] = spin.get_value_as_int() if spin is not None else None
        shown['range'] = tuple(spin.get_range()) if spin is not None else None
        shown['destroyed'] = False
        if not getattr(dialog, '_harness_watched', False):
            dialog._harness_watched = True
            dialog.connect('destroy', lambda *args: [s.__setitem__('destroyed', True) for s in self.shown if s['dialog'] is dialog])
        self.shown.append(shown)
        if self.fill:
            self.fill(dialog)
        return self.answers.pop(0) if self.answers else Gtk.ResponseType.CANCEL


def descendants(widget, kind):
    found = [widget] if isinstance(widget, kind) else []
    if isinstance(widget, Gtk.Container):
        # forall also gives internal children (the action area of a dialog, the box of an InfoBar).
        children = []
        widget.forall(children.append)
        for child in children:
            found.extend(descendants(child, kind))
    return found


def pump():
    for _ in range(20):
        while Gtk.events_pending():
            Gtk.main_iteration()


def wait_for(done, seconds=5):
    deadline = time.monotonic() + seconds
    while not done() and time.monotonic() < deadline:
        pump()
        time.sleep(0.02)
    return done()


def write(folder, basename, text):
    path = os.path.join(folder, basename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return path


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def desktop(name, exec_='true', extra=''):
    return '[Desktop Entry]\nType=Application\nName=%s\nExec=%s\n%s' % (name, exec_, extra)


def keyvalue(path, key, kind='string'):
    kf = GLib.KeyFile.new()
    kf.load_from_file(path, GLib.KeyFileFlags.NONE)
    try:
        return kf.get_boolean('Desktop Entry', key) if kind == 'bool' else kf.get_string('Desktop Entry', key)
    except GLib.Error:
        return None


def rows(widget):
    return widget.list_box.get_children()


def row_names(widget):
    return [row.entry.name for row in rows(widget)]


def row_of(widget, name):
    for row in rows(widget):
        if row.entry.name == name:
            return row
    return None


def texts(row):
    return [label.get_text() for label in descendants(row, Gtk.Label)]


def bar_text(widget):
    return widget.bar_label.get_text() if widget.bar.get_visible() else None


stamp = [1000]


def pick_app(desktop_file, name):
    stamp[0] += 1
    return json.dumps({'v': 1, 'stamp': stamp[0], 'kind': 'app', 'desktopFile': desktop_file, 'name': name})


def pick_form(name, command):
    stamp[0] += 1
    return json.dumps({'v': 1, 'stamp': stamp[0], 'kind': 'form', 'name': name, 'command': command})


def quietly(action):
    """Runs action with stderr captured; returns (what it returned, the log). An exception is a failure."""
    captured = io.StringIO()
    result = None
    try:
        with contextlib.redirect_stderr(captured):
            result = action()
    except Exception as e:
        check(False, 'raised out of the widget: %r' % e)
    return result, captured.getvalue()


def show(widget):
    window = Gtk.OffscreenWindow()
    window.set_default_size(700, 500)
    window.add(widget)
    window.show_all()
    pump()
    return window


ITEM = {'type': 'custom', 'file': 'startup_list.py', 'widget': 'StartupList'}

dialogs = Dialogs()
real_run = Gtk.Dialog.run
Gtk.Dialog.run = lambda dialog: dialogs.run(dialog)
real_new_for_bus_sync = Gio.DBusProxy.new_for_bus_sync
bus = RecordingBus()
Gio.DBusProxy.new_for_bus_sync = bus
real_subprocess_new = Gio.Subprocess.new
spawn = RecordingSpawn()
Gio.Subprocess.new = spawn
made = []

# 0. Loading the module does not load GTK; the class is a SettingsWidget, the same object each time.
check(not gtk_after_load, 'loading startup_list.py does not load Gtk')
StartupList = module.StartupList
check(isinstance(StartupList, type) and issubclass(StartupList, SettingsWidget), 'StartupList is a SettingsWidget class')
check(module.StartupList is StartupList, 'the class is made once')
check(GLib.get_user_config_dir() == CONFIG, 'GLib gives the temp folder as the configuration folder')

# 1. The rows. The value of startup-pick at build time is an old result: it is cleared without being used (it may
# hold a command line).
write(USER, 'mine.desktop', desktop('Mine', 'mine --go', 'Comment=My own\nIcon=mine\nX-GNOME-Autostart-Delay=7\n'))
write(SYSTEM, 'sysapp.desktop', desktop('Zeta system', 'zeta', 'X-GNOME-Autostart-enabled=false\n'))
nemo_desktop = write(APPS, 'nemo.desktop', desktop('Nemo', 'nemo %U', 'Icon=nemo\nX-Keep=1\n'))
handler = FakeHandler(pick=pick_app(nemo_desktop, 'Nemo'))
widget, log = quietly(lambda: StartupList(ITEM, 'startup-list', handler))
made.append(widget)
window = show(widget)
check(log == '', 'building logs nothing, got %r' % log)
check(widget.key == 'startup-list' and widget.settings is handler, 'the widget keeps its key and handler')
check(row_names(widget) == ['Mine', 'Zeta system'], 'one row per entry, sorted by name: %r' % row_names(widget))
check([row.switch.get_active() for row in rows(widget)] == [True, False], 'the switches show enabled')
mine, zeta = rows(widget)
check('mine --go' in texts(mine) and 'delay 7 s' in texts(mine), 'a row shows the command and the delay: %r' % texts(mine))
check(SYSTEM_NOTE not in ' '.join(texts(mine)), 'a user entry has no system note')
check(any(SYSTEM_NOTE in t for t in texts(zeta)) and 'delay 0 s' in texts(zeta), 'a system entry says so: %r' % texts(zeta))
check(any(label.get_style_context().has_class('dim-label') for label in descendants(zeta, Gtk.Label) if 'Zeta' in label.get_text()),
      'the name of a system entry is dimmed')
check(any(label.get_style_context().has_class('dim-label') for label in descendants(mine, Gtk.Label) if label.get_text() == 'mine --go'),
      'the command line is dimmed')
check(sorted(os.listdir(USER)) == ['mine.desktop'], 'the value of startup-pick at build time adds nothing')
check(handler.sets == [('startup-pick', '')] and handler.values['startup-pick'] == '' and not widget.bar.get_visible(),
      'it is cleared at build time and shows no message: %r' % handler.sets)
check(len(dialogs.shown) == 0, 'and it opens no form')
check(len(handler.listeners.get('startup-pick', [])) == 1, 'the widget listens to startup-pick once')
check(widget.get_sensitive(), 'enabled: the widget is sensitive')
# The pick button has the crosshair icon, or, in an icon theme without it, the crosshair glyph in front of its label.
theme_has_pick_icon = Gtk.IconTheme.get_default().lookup_icon('find-location-symbolic', 16, 0) is not None
pick_label = 'Pick a window to start at login' if theme_has_pick_icon else '\u2316 Pick a window to start at login'
labels = [b.get_label() for b in (widget.pick_button, widget.remove_button, widget.startup_button)]
check(labels == [pick_label, 'Remove', 'Add or edit in Startup Applications…'],
      'the three buttons: %r' % labels)
check(any('log in' in t for t in [l.get_text() for l in descendants(widget, Gtk.Label)]), 'the explanation is shown')
check(any(t.startswith('These applications start when you log in, and Window Memory puts their windows back in place, '
                       'unless they are enabled in the never remember list.')
          for t in [l.get_text() for l in descendants(widget, Gtk.Label)]),
      'the explanation says that an application enabled in the never remember list is not put back, in its first sentence')
# The pick button has the same crosshair icon as the General tab's pick button, in front of its label, and keeps
# its natural width and place in the row of buttons. In an icon theme without the icon it has no image and the
# glyph is in its label (checked above).
pick_image = widget.pick_button.get_image()
if theme_has_pick_icon:
    check(isinstance(pick_image, Gtk.Image) and pick_image.get_icon_name()[0] == 'find-location-symbolic',
          'the pick button has the crosshair icon: %r' % (pick_image and pick_image.get_icon_name(),))
    check(widget.pick_button.get_always_show_image(), 'the icon shows whatever the theme says about button images')
    check(widget.pick_button.get_image_position() == Gtk.PositionType.LEFT, 'the icon is before the label')
else:
    check(pick_image is None, 'without the icon in the theme the pick button has no image')
check(widget.pick_button.get_parent() is widget.remove_button.get_parent(), 'the pick button stays in the row of buttons')
check(not widget.pick_button.get_hexpand() and widget.remove_button.get_image() is None and widget.startup_button.get_image() is None,
      'it keeps its natural width, and the other two buttons have no icon')

# 2. A switch writes the file: a system entry gets a user override, the system file is untouched.
sys_before = read(os.path.join(SYSTEM, 'sysapp.desktop'))
_, log = quietly(lambda: row_of(widget, 'Zeta system').switch.set_active(True))
override = os.path.join(USER, 'sysapp.desktop')
check(os.path.isfile(override) and keyvalue(override, 'X-GNOME-Autostart-enabled', 'bool') is True,
      'switching a system entry on writes a user override')
check(read(os.path.join(SYSTEM, 'sysapp.desktop')) == sys_before, 'the system file is untouched')
# Back off: the override now says what the system file says, and is deleted (as the system tool does).
quietly(lambda: row_of(widget, 'Zeta system').switch.set_active(False))
check(not os.path.exists(override), 'switching it back off leaves no user file')
quietly(lambda: row_of(widget, 'Zeta system').switch.set_active(True))
check(os.path.isfile(override), 'and on again writes the override again')
quietly(lambda: row_of(widget, 'Mine').switch.set_active(False))
check(keyvalue(os.path.join(USER, 'mine.desktop'), 'X-GNOME-Autostart-enabled', 'bool') is False, 'switching off writes enabled=false')
pump()
check([row.switch.get_active() for row in rows(widget)] == [False, True], 'the switches follow the files')

# 3. Remove removes the selected row's entry; it needs a selection.
widget.list_box.unselect_all()
pump()
check(not widget.remove_button.get_sensitive(), 'Remove is insensitive without a selection')
widget.list_box.select_row(row_of(widget, 'Mine'))
pump()
check(widget.remove_button.get_sensitive(), 'Remove is sensitive with a selection')
quietly(lambda: widget.remove_button.clicked())
check(not os.path.exists(os.path.join(USER, 'mine.desktop')), 'Remove deletes a user-only entry')
check(row_names(widget) == ['Zeta system'], 'and its row is gone: %r' % row_names(widget))
check(not widget.remove_button.get_sensitive(), 'Remove is insensitive again')

# 4. The Pick button sends exactly one pickStartupWindow call, as the plain button does.
EXPECTED_FLAGS = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS
for pick_handler, instance_id in ((FakeHandler(), UUID), (OtherHandler(), 'instance-7'), (BareHandler(), UUID)):
    bus.calls.clear()
    bus.proxy = FakeProxy()
    picker, _ = quietly(lambda: StartupList(ITEM, 'startup-list', pick_handler))
    made.append(picker)
    picker.pick_button.clicked()
    check(len(bus.calls) == 1 and bus.calls[0] == ((Gio.BusType.SESSION, EXPECTED_FLAGS, None, 'org.Cinnamon', '/org/Cinnamon',
                                                    'org.Cinnamon', None), {}), 'the proxy is the plain button\'s: %r' % bus.calls)
    check(bus.proxy.calls == [('(sss)', 'pickStartupWindow', UUID, instance_id)] and bus.proxy.kwargs == [{'timeout': 5000}],
          'one pickStartupWindow call with instance id %s: %r %r' % (instance_id, bus.proxy.calls, bus.proxy.kwargs))
# A call that fails is logged and said in the message bar, not raised.
bus.proxy = FakeProxy(error=GLib.Error('no such name'))
widget._proxy = None
_, log = quietly(lambda: widget._on_pick_clicked())
check('could not run pickStartupWindow in Cinnamon: no such name' in log, 'a failed call is logged: %r' % log)
check(bar_text(widget) is not None and 'no such name' in bar_text(widget), 'and shown: %r' % bar_text(widget))
check(not widget.undo_button.get_visible(), 'an error has no Undo')
bus.proxy = FakeProxy()

# 5. A pick of an application: added at once, the message with Undo, the key cleared; Undo restores.
_, log = quietly(lambda: handler.set_value('startup-pick', pick_app(nemo_desktop, 'Nemo')))
target = os.path.join(USER, 'nemo.desktop')
check(os.path.isfile(target) and keyvalue(target, 'X-Keep') == '1' and keyvalue(target, 'X-GNOME-Autostart-enabled', 'bool') is True,
      'the application is added')
check(bar_text(widget) == 'Added Nemo' and widget.undo_button.get_visible(), 'the message says Added Nemo, with Undo: %r' % bar_text(widget))
check(handler.values['startup-pick'] == '' and handler.sets[-1] == ('startup-pick', ''), 'the key is cleared once the result is used')
check('Nemo' in row_names(widget), 'the new entry is listed: %r' % row_names(widget))
check(log == '', 'nothing logged, the empty value of the clearing included: %r' % log)
quietly(lambda: widget.undo_button.clicked())
check(not os.path.exists(target), 'Undo deletes the added file')
check('Nemo' not in row_names(widget) and not widget.bar.get_visible(), 'the row is gone, and the message')

# 6. The same pick twice: the second says it is already in the list; nothing is written twice.
quietly(lambda: handler.set_value('startup-pick', pick_app(nemo_desktop, 'Nemo')))
first = read(target)
quietly(lambda: handler.set_value('startup-pick', pick_app(nemo_desktop, 'Nemo')))
check(bar_text(widget) == 'Nemo is already in the list' and not widget.undo_button.get_visible(),
      'the second pick: already in the list, nothing to undo: %r' % bar_text(widget))
check(read(target) == first and sorted(os.listdir(USER)) == ['nemo.desktop', 'sysapp.desktop'], 'no second file, no change')
# switched off, then picked: switched on
quietly(lambda: row_of(widget, 'Nemo').switch.set_active(False))
quietly(lambda: handler.set_value('startup-pick', pick_app(nemo_desktop, 'Nemo')))
check(bar_text(widget) == 'Nemo switched on' and keyvalue(target, 'X-GNOME-Autostart-enabled', 'bool') is True,
      'a pick of an entry that is off switches it on: %r' % bar_text(widget))
check(row_of(widget, 'Nemo').switch.get_active(), 'and its switch shows it')
# Undo after a change from elsewhere: refused, said, nothing touched.
write(USER, 'nemo.desktop', desktop('Nemo', 'nemo --edited'))
edited = read(target)
quietly(lambda: widget.undo_button.clicked())
check(read(target) == edited, 'Undo leaves an entry that changed in the meantime alone')
check(bar_text(widget) == CHANGED and not widget.undo_button.get_visible(), 'and says so: %r' % bar_text(widget))
os.remove(target)
# a removed system entry, picked: brought back
files_system = write(SYSTEM, 'files.desktop', desktop('Files', 'files'))
files_app = write(APPS, 'files.desktop', desktop('Files', 'files'))
widget.refresh()
widget.list_box.select_row(row_of(widget, 'Files'))
quietly(lambda: widget.remove_button.clicked())
check('Files' not in row_names(widget) and keyvalue(os.path.join(USER, 'files.desktop'), 'Hidden', 'bool') is True,
      'Remove of a system entry hides it with a user override')
quietly(lambda: handler.set_value('startup-pick', pick_app(files_app, 'Files')))
check(bar_text(widget) == 'Files brought back' and 'Files' in row_names(widget), 'a removed entry is brought back: %r' % bar_text(widget))
quietly(lambda: widget.undo_button.clicked())
check('Files' not in row_names(widget), 'and Undo removes it again')
# The list on screen may be stale: the pick reads the folder again before it decides.
write(USER, 'stale.desktop', desktop('Stale', 'stale'))
stale_app = write(APPS, 'stale.desktop', desktop('Stale', 'stale'))
widget._entries = [e for e in widget._entries if e.basename != 'stale.desktop']  # as if the monitor had not told yet
quietly(lambda: handler.set_value('startup-pick', pick_app(stale_app, 'Stale')))
check(bar_text(widget) == 'Stale is already in the list', 'a pick decides on the files, not on a stale list: %r' % bar_text(widget))
os.remove(os.path.join(USER, 'stale.desktop'))
# An application whose desktop file cannot be read: a short error, nothing raised, the key cleared.
_, log = quietly(lambda: handler.set_value('startup-pick', pick_app(os.path.join(APPS, 'gone.desktop'), 'Gone')))
check(bar_text(widget) is not None and bar_text(widget).startswith('Could not add Gone') and not widget.undo_button.get_visible(),
      'an add that fails is said in the message bar: %r' % bar_text(widget))
check(handler.values['startup-pick'] == '', 'the key is cleared after a failed add too')
check('gone.desktop' in log, 'and logged: %r' % log)
check(not os.path.exists(os.path.join(USER, 'gone.desktop')), 'nothing is written for it')

# 7. A pick of a window without a desktop file opens the form, filled in; Add adds, Cancel does not.
parent = widget.get_toplevel()
command = "xterm -e 'sh -c \"echo 100%%; sleep 1\"'"
dialogs.answers = [Gtk.ResponseType.CANCEL]
before = sorted(os.listdir(USER))
quietly(lambda: handler.set_value('startup-pick', pick_form('xterm', command)))
check(len(dialogs.shown) == 1, 'one form is run: %d' % len(dialogs.shown))
form = dialogs.shown[-1]
check(form['name_entry'] == 'xterm' and form['command_entry'] == command and form['comment_entry'] == '' and form['delay'] == 0,
      'the form is filled in from the result, the command as received: %r' % ({k: form[k] for k in ('name_entry', 'command_entry', 'comment_entry', 'delay')},))
check(form['range'] == (0.0, 100.0), 'the delay is 0 to 100: %r' % (form['range'],))
check(sorted(form['buttons']) == ['CANCEL', 'OK'], 'Cancel and Add: %r' % form['buttons'])
check(HINT in form['labels'], 'the form says the command is a guess: %r' % form['labels'])
check(HINT in form['dimmed'], 'the guess line is dimmed')
check(form['modal'] and not form['mapped'], 'the form is modal and not shown by the widget itself')
check(form['parent'] is parent, 'the form is transient for the settings window')
check(sorted(os.listdir(USER)) == before and handler.values['startup-pick'] == '', 'Cancel creates nothing, the key is cleared')


def fill_comment_and_delay(dialog):
    dialog.comment_entry.set_text('My terminal')
    dialog.delay_spin.set_value(12)


dialogs.fill = fill_comment_and_delay
dialogs.answers = [Gtk.ResponseType.OK]
quietly(lambda: handler.set_value('startup-pick', pick_form('xterm', command)))
dialogs.fill = None
custom = os.path.join(USER, 'xterm.desktop')
check(os.path.isfile(custom), 'Add creates a custom entry: %r' % sorted(os.listdir(USER)))
if os.path.isfile(custom):
    check(keyvalue(custom, 'Exec') == command and keyvalue(custom, 'Name') == 'xterm' and keyvalue(custom, 'Comment') == 'My terminal'
          and keyvalue(custom, 'X-GNOME-Autostart-Delay') == '12' and keyvalue(custom, 'X-GNOME-Autostart-enabled', 'bool') is True,
          'the custom entry has the four fields, the command exactly as shown')
check(bar_text(widget) == 'Added xterm' and widget.undo_button.get_visible() and 'xterm' in row_names(widget),
      'the message says Added xterm, with Undo: %r' % bar_text(widget))
quietly(lambda: widget.undo_button.clicked())
check(not os.path.exists(custom) and 'xterm' not in row_names(widget), 'Undo deletes the custom entry')

# An empty command, or one that is not valid: the form says why and stays open; nothing is written.
for bad, label in (('   ', 'an empty command'), ('xterm "unclosed', 'a command that is not valid')):
    def clear_command(dialog, bad=bad):
        dialog.command_entry.set_text(bad)
    dialogs.fill = clear_command
    dialogs.answers = [Gtk.ResponseType.OK, Gtk.ResponseType.CANCEL]
    ran = len(dialogs.shown)
    before = sorted(os.listdir(USER))
    quietly(lambda: handler.set_value('startup-pick', pick_form('xterm', 'xterm')))
    dialogs.fill = None
    again = dialogs.shown[ran:]
    check(len(again) == 2 and again[1]['error'], '%s: the form runs again with an error: %r' % (label, [d['error'] for d in again]))
    check(sorted(os.listdir(USER)) == before, '%s: nothing is written' % label)
# An empty name takes the program's name, as the system tool does.
def clear_name(dialog):
    dialog.name_entry.set_text('')
dialogs.fill = clear_name
dialogs.answers = [Gtk.ResponseType.OK]
quietly(lambda: handler.set_value('startup-pick', pick_form('', '/usr/bin/foot -a test')))
dialogs.fill = None
check(os.path.isfile(os.path.join(USER, 'foot.desktop')) and keyvalue(os.path.join(USER, 'foot.desktop'), 'Name') == 'foot',
      'an empty name becomes the program name: %r' % sorted(os.listdir(USER)))
quietly(lambda: widget.undo_button.clicked())
# A name that cannot be a file name (too long in bytes): the form says why, nothing raised.
dialogs.answers = [Gtk.ResponseType.OK, Gtk.ResponseType.CANCEL]
ran = len(dialogs.shown)
_, log = quietly(lambda: handler.set_value('startup-pick', pick_form('窓' * 100, 'xterm')))
again = dialogs.shown[ran:]
check(len(again) == 2 and again[1]['error'], 'a save that fails is said in the form: %r' % [d['error'] for d in again])

# 8. Values that are not a result of the extension do nothing and raise nothing.
for bad in ('not json', '[]', '{}', json.dumps({'v': 2, 'stamp': 1, 'kind': 'app', 'desktopFile': nemo_desktop, 'name': 'Nemo'}),
            json.dumps({'v': 1, 'stamp': 2, 'kind': 'app', 'name': 'Nemo'}),
            json.dumps({'v': 1, 'stamp': 3, 'kind': 'app', 'desktopFile': 'nemo.desktop', 'name': 'Nemo'}),
            json.dumps({'v': 1, 'stamp': 4, 'kind': 'form', 'name': 'x'}),
            json.dumps({'v': 1, 'stamp': 5, 'kind': 'other', 'name': 'x', 'command': 'x'})):
    ran = len(dialogs.shown)
    before = sorted(os.listdir(USER))
    _, log = quietly(lambda: handler.set_value('startup-pick', bad))
    check(sorted(os.listdir(USER)) == before and len(dialogs.shown) == ran, 'an invalid value does nothing: %r' % bad)
    check('startup-pick' in log, 'an invalid value is logged: %r -> %r' % (bad, log))
_, log = quietly(lambda: handler.set_value('startup-pick', ''))
check(log == '', 'an empty value is ignored without a log')

# 9. The "Startup Applications" button starts the system tool, without a shell and without waiting.
spawn.calls.clear()
quietly(lambda: widget.startup_button.clicked())
check(len(spawn.calls) == 1 and list(spawn.calls[0][0][0]) == ['cinnamon-settings', 'startup'],
      'it starts cinnamon-settings startup: %r' % spawn.calls)
spawn.error = GLib.Error('not found')
_, log = quietly(lambda: widget.startup_button.clicked())
check(bar_text(widget) is not None and 'not found' in bar_text(widget) and 'not found' in log, 'a failed start is said: %r' % bar_text(widget))
spawn.error = None

# 10. Greyed out while "Enable Window Memory" is off.
off = FakeHandler(enabled=False)
greyed, _ = quietly(lambda: StartupList(ITEM, 'startup-list', off))
made.append(greyed)
check(not greyed.get_sensitive(), 'insensitive while enabled is false')
off.set_value('enabled', True)
check(greyed.get_sensitive(), 'sensitive again when it is switched on')
check([(k, p) for k, _, p, _ in off.bindings] == [('enabled', 'sensitive')], 'bound once, GET: %r' % off.bindings)

# 11. The folder monitor refreshes the list when a file is added or removed from outside.
outside = write(USER, 'outside.desktop', desktop('Outside', 'outside'))
check(wait_for(lambda: 'Outside' in row_names(widget)), 'a file added from outside appears: %r' % row_names(widget))
os.remove(outside)
check(wait_for(lambda: 'Outside' not in row_names(widget)), 'and disappears when removed')

# 12. A defensive __init__: a handler without bind or listen, or a list that cannot be read.
bare, log = quietly(lambda: StartupList(ITEM, 'startup-list', BareHandler()))
made.append(bare)
check(bare is not None and 'enabled' in log, 'a bare handler builds, the missing bind is logged: %r' % log)
real_gather = module.gather_entries


def broken(*args, **kwargs):
    raise OSError(13, 'Permission denied')


module.gather_entries = broken
unreadable, log = quietly(lambda: StartupList(ITEM, 'startup-list', FakeHandler()))
made.append(unreadable)
module.gather_entries = real_gather
check(unreadable is not None and rows(unreadable) == [] and 'Permission denied' in log, 'a list that cannot be read builds empty, logged: %r' % log)
check(bar_text(unreadable) is not None and 'Permission denied' in bar_text(unreadable), 'and says so: %r' % bar_text(unreadable))

# 13. Destroyed: the monitor is cancelled and a late result does nothing.
gone_handler = FakeHandler()
gone, _ = quietly(lambda: StartupList(ITEM, 'startup-list', gone_handler))
monitor = gone._monitor
check(monitor is not None and not monitor.is_cancelled(), 'the monitor runs while the widget lives')
gone.destroy()
check(monitor.is_cancelled(), 'the monitor is cancelled on destroy')
before = sorted(os.listdir(USER))
_, log = quietly(lambda: gone_handler.set_value('startup-pick', pick_app(nemo_desktop, 'Nemo')))
check(sorted(os.listdir(USER)) == before, 'a result after destroy does nothing')

# 13b. Clearing startup-pick goes through the handler's set_value, whose save pauses the handler's monitor of the
# settings file (JSONSettingsHandler.save_settings: pause_monitor, and do_resume 2 s later reconnects it without reading
# the file). A result the extension writes in that pause is not notified. So after a clear the widget asks the handler
# to read the file again (check_settings) once, RECHECK_MS later: a second pick in the pause is used then, and its
# command line does not stay in the file. One timer at a time; removed on destroy.
class PausingHandler(FakeHandler):
    """A FakeHandler with the pause: the settings file is file; set_value writes it and pauses the monitor; what the
    extension writes meanwhile is only in the file until check_settings reads it and notifies the listeners."""

    def __init__(self, **kwargs):
        super(PausingHandler, self).__init__(**kwargs)
        self.file = dict(self.values)
        self.paused = False
        self.checks = 0

    def set_value(self, key, value):
        if value == self.values[key]:
            return
        self.file[key] = value
        self.paused = True
        super(PausingHandler, self).set_value(key, value)

    def extension_writes(self, key, value):
        self.file[key] = value
        if not self.paused:
            self.check_settings()

    def resume(self):
        self.paused = False  # the monitor is back; the file is not read again

    def check_settings(self):
        self.checks += 1
        for key, value in list(self.file.items()):
            if value != self.values[key]:
                self.values[key] = value
                for callback in list(self.listeners.get(key, [])):
                    callback(key, value)


real_recheck = module.RECHECK_MS
check(real_recheck == 2500, 'the re-read comes 2.5 s after a clear, after the handler\'s 2 s pause: %r' % real_recheck)
module.RECHECK_MS = 50
alpha = write(APPS, 'alpha.desktop', desktop('Alpha', 'alpha'))
beta = write(APPS, 'beta.desktop', desktop('Beta', 'beta'))
paused = PausingHandler()
pausing, log = quietly(lambda: StartupList(ITEM, 'startup-list', paused))
made.append(pausing)
check(pausing._recheck_id is None, 'no re-read is pending after a build with an empty startup-pick')
quietly(lambda: paused.extension_writes('startup-pick', pick_app(alpha, 'Alpha')))
check(os.path.isfile(os.path.join(USER, 'alpha.desktop')) and paused.file['startup-pick'] == '' and paused.paused,
      'the first pick is used and cleared, which pauses the handler')
pending = pausing._recheck_id
check(pending is not None, 'a re-read is pending after the clear')
quietly(lambda: paused.extension_writes('startup-pick', pick_app(beta, 'Beta')))
check(not os.path.exists(os.path.join(USER, 'beta.desktop')) and paused.file['startup-pick'] != '',
      'test setup: a second pick in the pause is not notified')
paused.resume()
_, log = quietly(lambda: wait_for(lambda: os.path.exists(os.path.join(USER, 'beta.desktop'))))
check(os.path.isfile(os.path.join(USER, 'beta.desktop')), 'the second pick is used after the re-read')
check(paused.file['startup-pick'] == '', 'and its value is cleared from the settings file')
check(bar_text(pausing) == 'Added Beta', 'the message says so: %r' % bar_text(pausing))
check(log == '', 'nothing logged: %r' % log)
# One re-read at a time: a second clear while one is pending does not start another.
twice = FakeHandler()
two, _ = quietly(lambda: StartupList(ITEM, 'startup-list', twice))
made.append(two)
quietly(lambda: twice.set_value('startup-pick', pick_app(alpha, 'Alpha')))
first_id = two._recheck_id
quietly(lambda: twice.set_value('startup-pick', pick_app(beta, 'Beta')))
check(first_id is not None and two._recheck_id == first_id, 'a second clear while a re-read is pending starts no second timer')
# A handler without check_settings, or one whose check_settings raises: the timer ends quietly or logs.
_, log = quietly(lambda: wait_for(lambda: two._recheck_id is None))
check(two._recheck_id is None and log == '', 'with a handler without check_settings the re-read does nothing: %r' % log)


class RaisingHandler(FakeHandler):
    def check_settings(self):
        raise ValueError('Failed to parse settings JSON data')


raising = RaisingHandler()
raiser, _ = quietly(lambda: StartupList(ITEM, 'startup-list', raising))
made.append(raiser)
quietly(lambda: raising.set_value('startup-pick', pick_app(alpha, 'Alpha')))
_, log = quietly(lambda: wait_for(lambda: raiser._recheck_id is None))
check('Failed to parse settings JSON data' in log, 'a failing re-read is logged: %r' % log)
# Destroyed with a re-read pending: the timer is removed, and a later read of the file does nothing.
for name in ('alpha.desktop', 'beta.desktop'):
    os.remove(os.path.join(USER, name))
late = PausingHandler()
dying, _ = quietly(lambda: StartupList(ITEM, 'startup-list', late))
quietly(lambda: late.extension_writes('startup-pick', pick_app(alpha, 'Alpha')))
check(dying._recheck_id is not None, 'test setup: a re-read is pending')
quietly(lambda: late.extension_writes('startup-pick', pick_app(beta, 'Beta')))
dying.destroy()
check(dying._recheck_id is None, 'destroy removes the pending re-read')
checks = late.checks
deadline = time.monotonic() + 0.4
while time.monotonic() < deadline:
    pump()
    time.sleep(0.02)
check(late.checks == checks, 'the removed timer never fires: %d re-reads, %d before' % (late.checks, checks))
late.resume()
quietly(lambda: late.check_settings())
check(not os.path.exists(os.path.join(USER, 'beta.desktop')), 'a result read after destroy is not used')
os.remove(os.path.join(USER, 'alpha.desktop'))
module.RECHECK_MS = real_recheck

# 13c. The list is tall, and it clearly scrolls when it has more entries than fit: one named height (module.LIST_MIN_HEIGHT, about
# nine rows), the vertical policy AUTOMATIC and the horizontal one NEVER, a scrollbar that takes room and stays visible
# (no overlay scrolling), and the mouse wheel and the keys moving the view. The widget itself does not scroll to a row
# (it never did), so nothing of that is checked.
check(isinstance(module.LIST_MIN_HEIGHT, int) and module.LIST_MIN_HEIGHT >= 400, 'LIST_MIN_HEIGHT is the named height, about nine rows: %r' % (module.LIST_MIN_HEIGHT,))
lone = FakeHandler()
tall, log = quietly(lambda: StartupList(ITEM, 'startup-list', lone))
made.append(tall)
tall_window = show(tall)
scrolls = descendants(tall, Gtk.ScrolledWindow)
check(len(scrolls) == 1, 'the list is in one scrolled window: %d' % len(scrolls))
scroll = scrolls[0]
check(scroll.get_policy() == (Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC),
      'policy: no horizontal scrolling, vertical automatic: %r' % (scroll.get_policy(),))
check(scroll.get_min_content_height() == module.LIST_MIN_HEIGHT, 'the scrolled window has the minimum content height LIST_MIN_HEIGHT: %d' % scroll.get_min_content_height())
check(scroll.get_overlay_scrolling() is False, 'overlay scrolling is off: the scrollbar is a real, visible one')
few = row_names(tall)
check(scroll.get_allocated_height() >= module.LIST_MIN_HEIGHT, 'a short list already has the height: %d' % scroll.get_allocated_height())
# (GTK hides an automatic scrollbar as a child, so mapped is the thing to ask, not get_visible.)
check(len(few) < 5 and not scroll.get_vscrollbar().get_mapped(), 'with a few entries there is no scrollbar')
many = []
for i in range(25):
    many.append(write(USER, 'many-%02d.desktop' % i, desktop('Many %02d' % i)))
quietly(lambda: tall._on_folder_changed())
pump()
check(len(rows(tall)) == len(few) + 25, 'test setup: 25 more rows: %d' % len(rows(tall)))
vadj = scroll.get_vadjustment()
check(vadj.get_upper() > vadj.get_page_size() + 100, 'more entries than fit: the content (%d) is taller than the view (%d)' % (vadj.get_upper(), vadj.get_page_size()))
check(scroll.get_vscrollbar().get_mapped(), 'the scrollbar is visible when the list is longer than its area')
check(scroll.get_vscrollbar().get_allocated_width() > 4, 'and takes room beside the rows (no overlay): %d px' % scroll.get_vscrollbar().get_allocated_width())
check(not scroll.get_hscrollbar().get_mapped(), 'no horizontal scrollbar')
check(scroll.get_allocated_height() >= module.LIST_MIN_HEIGHT, 'the list keeps its height: %d' % scroll.get_allocated_height())
check(scroll.get_vadjustment().get_value() == 0, 'it starts at the top')
# The mouse wheel: a scroll event on the list moves the view.
event = Gdk.Event.new(Gdk.EventType.SCROLL)
event.window = scroll.get_window()
event.direction = Gdk.ScrollDirection.DOWN
event.device = Gdk.Display.get_default().get_default_seat().get_pointer()
event.x, event.y, event.send_event = 10.0, 10.0, True
scroll.event(event)
pump()
check(vadj.get_value() > 0, 'the mouse wheel scrolls the list: value %r' % vadj.get_value())
# The end of the list can be reached.
vadj.set_value(vadj.get_upper() - vadj.get_page_size())
pump()
check(vadj.get_value() >= vadj.get_upper() - vadj.get_page_size() - 1, 'the view reaches the end of the list')
for path_ in many:
    os.remove(path_)
quietly(lambda: tall._on_folder_changed())
pump()
check(row_names(tall) == few, 'test cleanup: the extra entries are gone: %r' % row_names(tall))
tall_window.destroy()

# 13d. The page of the tab, as the engine builds it (xlet-settings.py build_with_layout): a section with the heading, the list, and the
# Version row of the key version-info-login last, directly under the list and its message bar, and never greyed out.
with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
    full_schema = json.load(f)
login_section = full_schema['layout'][full_schema['layout']['login']['sections'][0]]
check(login_section['keys'] == ['startup-list', 'version-info-login'], 'the login section lists the list and the footer key: %r' % login_section['keys'])
from xapp.SettingsWidgets import SettingsPage
page_handler = FakeHandler(enabled=True)
page = SettingsPage()
section = page.add_section(login_section['title'])
page_rows = []
for key in login_section['keys']:
    entry = full_schema[key]
    row, _ = quietly(lambda: getattr(load_module(entry['file']), entry['widget'])(entry, key, page_handler))
    section.add_row(row)
    page_rows.append(row)
page_window = show(page)
page_list, page_footer = page_rows
made.append(page_list)
check(type(page_footer).__name__ == 'VersionInfo' and page_footer.key == 'version-info-login', 'the last row is the Version row of its own key')
check(any(l.get_text() == login_section['title'] for l in descendants(page, Gtk.Label)), 'the heading is drawn over the tab: %r' % login_section['title'])
check(page_footer.get_visible() and page_footer.get_mapped(), 'the Version row is shown')
list_bottom = page_list.translate_coordinates(page, 0, page_list.get_allocated_height())[1]
footer_top = page_footer.translate_coordinates(page, 0, 0)[1]
check(0 <= footer_top - list_bottom < 40, 'the Version row sits directly under the list: gap %d px' % (footer_top - list_bottom))
page_handler.set_value('enabled', False)
pump()
check(not page_list.get_sensitive() and page_footer.get_sensitive() and all(c.is_sensitive() for c in page_footer.content_widget.get_children()),
      'with "Enable Window Memory" off the list is greyed out and the Version row is not')
page_window.destroy()

# 14. Nothing real was reached; the replaced functions are put back.
check(all(w is None or w._proxy is None or isinstance(w._proxy, FakeProxy) for w in made), 'no real DBusProxy was created')
check(not any(d['mapped'] for d in dialogs.shown), 'no dialog was shown')
check(dialogs.shown and all(d['destroyed'] for d in dialogs.shown), 'every form is destroyed once closed')
Gtk.Dialog.run = real_run
Gio.DBusProxy.new_for_bus_sync = real_new_for_bus_sync
Gio.Subprocess.new = real_subprocess_new
window.destroy()

print('FAILED %d' % len(failures) if failures else 'OK')
sys.exit(1 if failures else 0)
