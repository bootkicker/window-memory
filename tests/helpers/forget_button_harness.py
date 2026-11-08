# SPDX-License-Identifier: GPL-3.0-or-later
# Test-only: builds ForgetAllButton the way cinnamon-settings does and checks it.
# Run by tests/forget-button.test.js, which skips the test when there is no display.
# Usage: python3 -B forget_button_harness.py <extension dir>
#   With "french" as a second argument it is the child process of the French check (section 8).
# Exit codes: 0 all checks passed, 1 a check failed, 77 cannot run here (no display or no GTK).
#
# The widget is never given a real D-Bus proxy: every click goes to a fake one, and the last
# check proves that no real proxy was created. The widget is built alone, in offscreen windows
# (nothing is shown), and its sensitivity is set by hand. That the page pass of pick_button.py
# greys it out with the other rows is checked on the whole page in pick_button_harness.py
# (section 9). No dialog is shown: Gtk.Dialog.run is replaced by a recorder, which answers OK at
# once. The state file the widget counts is in a temp folder: before anything else the harness
# points XDG_CONFIG_HOME at it, and it removes the folder at the end. Every state file it counts is
# made up here; none is the user's.
import atexit
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

SKIP = 77

FRENCH_CHILD = sys.argv[2:] == ['french']

# Nothing is read from or written to the user's dconf database.
os.environ['GSETTINGS_BACKEND'] = 'memory'

# The checks compare the English texts. LANGUAGE=C keeps the language of the session, and a
# translation installed for it, out of them: Python's gettext reads LANGUAGE first. The French
# child keeps the LANGUAGE it is given.
if not FRENCH_CHILD:
    os.environ['LANGUAGE'] = 'C'

# Nor from the user's configuration folder. GLib.get_user_config_dir(), where the widget finds the
# state file of the extension, reads XDG_CONFIG_HOME once, so it is set before gi is imported.
work = tempfile.mkdtemp(prefix='window-memory-forget-harness-')
atexit.register(shutil.rmtree, work, True)  # also when a check raises
CONFIG = os.path.join(work, 'config')
os.environ['XDG_CONFIG_HOME'] = CONFIG
STATE_DIR = os.path.join(CONFIG, 'window-memory')
STATE = os.path.join(STATE_DIR, 'state.json')

try:
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gdk, GLib, Gtk
    from xapp.SettingsWidgets import SettingsWidget
    if not Gtk.init_check()[0]:
        raise RuntimeError('Gtk.init_check() failed: no display')
except Exception as e:  # ImportError, ValueError (missing typelib), RuntimeError
    print('cannot run: %s' % e)
    sys.exit(SKIP)

ext_dir = sys.argv[1]
failures = []

# The red of the warning mark, spelled out here and not read from the module under test.
RED = Gdk.RGBA()
RED.parse('#e01b24')
THEME_ICON = 'dialog-warning-symbolic'
GLYPH = '⚠'  # WARNING SIGN, U+26A0
# A pixel counts as red when its red is well above both its green and its blue. Anti-aliasing
# blends the red with the button background, so the exact red is rare; a grey, white or
# black pixel never passes, so a mark that is not red has none.
RED_MARGIN = 60
# The least number of red pixels a drawn mark must have (a 16 px icon has over a hundred; the
# thin glyph far fewer).
MIN_RED_PIXELS = 4

# The texts of the confirmation, word for word, spelled out here too.
UUID = 'window-memory@bootkicker'
FORGOTTEN = 'Forgot all remembered windows.'
NOTHING_TO_FORGET = 'No windows were remembered, so there is nothing to forget.'
CONFIRM = 'Forget all remembered windows?'
NOT_FORGOTTEN = 'The remembered windows were not forgotten.'
NOT_RUNNING = 'Window Memory is not running. Enable it in System Settings, then try again.'
UNANSWERED = 'It is not known whether the remembered windows were forgotten.'
UNANSWERED_DETAIL = 'Window Memory did not answer in time.'
NOT_SAVED = 'Forgot all remembered windows, but the change could not be saved.'
NOT_SAVED_DETAIL = 'The remembered windows may come back the next time Window Memory starts.'


def check(ok, message):
    if not ok:
        failures.append(message)
        print('FAIL: ' + message)


def load_module(file_name):
    # The same three calls as xlet-settings.py:481-483.
    path = os.path.join(ext_dir, file_name)
    spec = importlib.util.spec_from_file_location('windowmemorybootkicker.' + file_name.split('.')[0], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHandler(object):
    """The part of cinnamon-settings' JSONSettingsHandler that the widget could use.

    instance_id is what the real one carries for an extension (xlet-settings.py:328).
    bind() only records: the widget must not call it (the page pass of pick_button.py does it).
    """
    instance_id = 'window-memory@bootkicker'

    def __init__(self):
        self.bind_calls = []

    def bind(self, key, obj, prop, direction, map_get=None, map_set=None):
        self.bind_calls.append((key, prop))


class ToggleHandler(FakeHandler):
    """A handler that keeps include-dialogs, as JSONSettingsHandler does (get_value, set_value)."""

    def __init__(self, value, fail_set=False):
        super(ToggleHandler, self).__init__()
        self.value = value
        self.sets = []
        self.fail_set = fail_set

    def get_value(self, key):
        assert key == 'include-dialogs', key
        return self.value

    def set_value(self, key, value):
        assert key == 'include-dialogs', key
        if self.fail_set:
            raise KeyError(key)
        self.sets.append(value)
        self.value = value


class OtherHandler(FakeHandler):
    instance_id = 'instance-7'


class BareHandler(object):
    # No instance_id and no bind(): the widget must still build.
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


class EmptyingProxy(FakeProxy):
    """A call that succeeds and empties the state file, as forgetAll in the extension does before it
    returns: a count made after the call would be 0."""

    def activateCallback(self, *args, **kwargs):
        super(EmptyingProxy, self).activateCallback(*args, **kwargs)
        if os.path.isfile(STATE):
            write_state({'version': 1, 'windows': []})


class ChangingProxy(FakeProxy):
    """A call that succeeds and runs change() on the state file during the call."""

    def __init__(self, change):
        super(ChangingProxy, self).__init__()
        self.change = change

    def activateCallback(self, *args, **kwargs):
        super(ChangingProxy, self).activateCallback(*args, **kwargs)
        self.change()


class Dialogs(object):
    """Stands in for Gtk.Dialog.run: records what each dialog would show, and answers OK at once,
    so that no dialog appears."""

    RESPONSES = ('OK', 'CANCEL', 'CLOSE', 'YES', 'NO', 'ACCEPT', 'REJECT', 'APPLY', 'HELP')

    def __init__(self):
        self.shown = []
        self.during = None  # called when a dialog runs, if set; may raise
        self.answer = Gtk.ResponseType.OK  # what a question dialog answers: OK, CANCEL or DELETE_EVENT

    def run(self, dialog):
        if self.during:
            self.during()
        shown = {'kind': type(dialog).__name__, 'modal': dialog.get_modal(), 'parent': dialog.get_transient_for(),
                 'mapped': dialog.get_mapped(), 'destroyed': False,
                 'buttons': [name for name in self.RESPONSES
                             if dialog.get_widget_for_response(getattr(Gtk.ResponseType, name)) is not None]}
        if isinstance(dialog, Gtk.MessageDialog):
            shown.update(type=dialog.get_property('message-type'), text=dialog.get_property('text'),
                         detail=dialog.get_property('secondary-text'))
        cancel = dialog.get_widget_for_response(Gtk.ResponseType.CANCEL)
        shown['default'] = 'CANCEL' if cancel is not None and cancel.has_default() else None
        dialog.connect('destroy', lambda *args: shown.__setitem__('destroyed', True))
        self.shown.append(shown)
        is_question = isinstance(dialog, Gtk.MessageDialog) and shown['type'] == Gtk.MessageType.QUESTION
        return self.answer if is_question else Gtk.ResponseType.OK


def check_dialog(got, message_type, text, detail, parent, label):
    """got: the dialogs that one click ran. Wanted: one message dialog of message_type with text and
    detail (the secondary text, None for none), modal and transient for parent, with an OK button
    only, not shown by the widget itself, and destroyed once closed."""
    check(len(got) == 1, '%s: one dialog is run, got %d' % (label, len(got)))
    if len(got) != 1:
        return
    shown = got[0]
    check(shown['kind'] == 'MessageDialog' and shown.get('type') == message_type,
          '%s: a message dialog of type %s, got %s of type %s' % (label, message_type, shown['kind'], shown.get('type')))
    check(shown.get('text') == text, '%s: the text is %r, got %r' % (label, text, shown.get('text')))
    check(shown.get('detail') == detail, '%s: the secondary text is %r, got %r' % (label, detail, shown.get('detail')))
    check(shown['modal'] and shown['parent'] is parent, '%s: modal and transient for %s, got %s and %s'
          % (label, 'the settings window' if parent else 'no window', shown['modal'], shown['parent']))
    check(shown['buttons'] == ['OK'], '%s: an OK button only, got %s' % (label, shown['buttons']))
    check(not shown['mapped'] and shown['destroyed'], '%s: not shown before run, and destroyed once closed' % label)


def write_state(content):
    """The state file holds content: bytes as they are, anything else as JSON."""
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE, 'wb') as f:
        f.write(content if isinstance(content, bytes) else json.dumps(content).encode('utf-8'))


def state_of(windows):
    """A state of version 1 with that many remembered windows."""
    return {'version': 1, 'windows': [{'id': 'entry-%d' % number, 'key': 'app|app'} for number in range(windows)]}


def pump():
    for _ in range(20):
        while Gtk.events_pending():
            Gtk.main_iteration()


def pixel(pixbuf, x, y):
    start = y * pixbuf.get_rowstride() + x * pixbuf.get_n_channels()
    return tuple(pixbuf.get_pixels()[start:start + 3])


def near(a, b):
    return all(abs(x - y) <= 1 for x, y in zip(a, b))


def show(widget):
    window = Gtk.OffscreenWindow()
    window.set_default_size(560, 60)
    window.add(widget)
    window.show_all()
    pump()
    return window


def discard(window, widget):
    window.remove(widget)  # destroying the window would destroy the widget and drop its signal handlers
    window.destroy()


# Every measurement of the layout or of the drawing is taken once it has stayed the same for
# STILL_SECONDS, which the main loop is pumped for; SETTLE_SECONDS at most. A fixed number of
# main-loop iterations is not enough on a loaded machine: a resize or a redraw can still be pending
# after it. get_pixbuf() gives the last frame drawn.
STILL_SECONDS = 0.2
SETTLE_SECONDS = 5


def settled(measure, what):
    """measure() once it has given the same value for STILL_SECONDS. After SETTLE_SECONDS that is a
    failure, and the last value is returned."""
    deadline = time.monotonic() + SETTLE_SECONDS
    value, since = measure(), time.monotonic()
    while True:
        pump()
        current, now = measure(), time.monotonic()
        if current != value:
            value, since = current, now
        elif now - since >= STILL_SECONDS:
            return value
        if now >= deadline:
            check(False, '%s did not settle within %d s' % (what, SETTLE_SECONDS))
            return value
        time.sleep(0.02)


def settled_frame(window, widget):
    """(the place of widget in the window, its allocation, the window's pixbuf), once the place, the
    allocation and the pixels have all stayed the same for STILL_SECONDS."""
    def measure():
        a = widget.get_allocation()
        return widget.translate_coordinates(window, 0, 0), (a.x, a.y, a.width, a.height), window.get_pixbuf().get_pixels()
    settled(measure, 'the drawing of the %s' % type(widget).__name__)
    return widget.translate_coordinates(window, 0, 0), widget.get_allocation(), window.get_pixbuf()


def red_pixels(window, widget):
    """How many pixels inside widget, as drawn in the window, are red."""
    (x0, y0), allocation, pixbuf = settled_frame(window, widget)
    data, stride, channels = pixbuf.get_pixels(), pixbuf.get_rowstride(), pixbuf.get_n_channels()
    count = 0
    for y in range(y0, y0 + allocation.height):
        for x in range(x0, x0 + allocation.width):
            start = y * stride + x * channels
            r, g, b = data[start], data[start + 1], data[start + 2]
            if r - g >= RED_MARGIN and r - b >= RED_MARGIN:
                count += 1
    return count


def inside(window, button):
    """A pixel of the button's own background: just inside its left edge, half way down."""
    _, a, pixbuf = settled_frame(window, button)
    return pixel(pixbuf, a.x + 3, a.y + a.height // 2)


def colour_of(widget):
    """The CSS colour the widget is drawn with in its present state."""
    c = widget.get_style_context().get_color(widget.get_state_flags())
    return (c.red, c.green, c.blue, c.alpha)


def same_colour(a, b):
    return all(abs(x - y) < 0.01 for x, y in zip(a, b))


def parts(widget):
    """(box, [mark, label]) of the button inside a ForgetAllButton."""
    box = widget.content_widget.get_child()
    return box, box.get_children()


# The French check (section 8): the texts of the confirmation, and their French translations, which
# the check compiles into a .mo of its own. A counted text has its two forms, and the two French ones.
FRENCH = {
    'Forgot all remembered windows.': 'Toutes les fenêtres mémorisées ont été oubliées.',
    ('%(count)d remembered window was forgotten.', '%(count)d remembered windows were forgotten.'):
        ('%(count)d fenêtre mémorisée a été oubliée.', '%(count)d fenêtres mémorisées ont été oubliées.'),
}
FRENCH_HEADER = ('msgid ""\nmsgstr ""\n"Project-Id-Version: window-memory@bootkicker\\n"\n"Language: fr\\n"\n'
                 '"MIME-Version: 1.0\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n'
                 '"Content-Transfer-Encoding: 8bit\\n"\n"Plural-Forms: nplurals=2; plural=(n > 1);\\n"\n')


def po_quote(text):
    return '"%s"' % text.replace('\\', '\\\\').replace('"', '\\"')


def compile_french(home, translations):
    """Compiles translations into <home>/.local/share/locale/fr/LC_MESSAGES/<uuid>.mo with
    msgfmt -c, as the Spices installer compiles po/fr.po (cinnamon-settings bin/Spices.py:733-737).
    Returns None, or why it could not."""
    entries = []
    for msgid, msgstr in translations.items():
        if isinstance(msgid, tuple):
            entries.append('msgid %s\nmsgid_plural %s\nmsgstr[0] %s\nmsgstr[1] %s\n'
                           % (po_quote(msgid[0]), po_quote(msgid[1]), po_quote(msgstr[0]), po_quote(msgstr[1])))
        else:
            entries.append('msgid %s\nmsgstr %s\n' % (po_quote(msgid), po_quote(msgstr)))
    po = os.path.join(home, 'fr.po')
    with open(po, 'w', encoding='utf-8') as f:
        f.write(FRENCH_HEADER + '\n' + '\n'.join(entries))
    folder = os.path.join(home, '.local', 'share', 'locale', 'fr', 'LC_MESSAGES')
    os.makedirs(folder)
    try:
        run = subprocess.run(['msgfmt', '-c', '-o', os.path.join(folder, UUID + '.mo'), po],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    except FileNotFoundError:
        return 'msgfmt is not installed (package gettext)'
    return None if run.returncode == 0 else 'msgfmt -c refused the French file: %s' % run.stderr


def french_child():
    """The child process of the French check (section 8), started with LANGUAGE=fr and a home
    folder with the French .mo. Clicks the button in a settings window with two remembered windows,
    then with one, and prints the text and the secondary text of the two dialogs, as JSON."""
    french = load_module('forget_button.py')
    with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
        forget_item = json.load(f)['forget-all']
    shown = Dialogs()
    Gtk.Dialog.run = lambda dialog: shown.run(dialog)
    french.Gio.DBusProxy.new_for_bus_sync = RecordingBus(EmptyingProxy())
    window = Gtk.Window()
    button = french.ForgetAllButton(forget_item, 'forget-all', FakeHandler())
    window.add(button)
    for windows in (2, 1):
        write_state(state_of(windows))
        button.content_widget.clicked()
    print(json.dumps([[dialog.get('text'), dialog.get('detail')] for dialog in shown.shown
                      if dialog.get('type') != Gtk.MessageType.QUESTION]))
    window.destroy()
    sys.exit(0)


if FRENCH_CHILD:
    french_child()

settings = Gtk.Settings.get_default()
real_animations = settings.get_property('gtk-enable-animations')
settings.set_property('gtk-enable-animations', False)  # so a state change is drawn at once

module = load_module('forget_button.py')
Button = module.ForgetAllButton
with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
    item = json.load(f)['forget-all']

# Every click below runs a dialog. Gtk.Dialog.run is replaced for the rest of the run, so none is shown.
dialogs = Dialogs()
real_run = Gtk.Dialog.run
Gtk.Dialog.run = lambda dialog: dialogs.run(dialog)

# 1. What cinnamon-settings needs: a SettingsWidget, built from (item, key, settings). The widget
# keeps its key, as the JSON rows do. Once the page is shown, the page pass of pick_button.py binds
# every SettingsWidget on the page to "Enable Window Memory", except that switch and the rows marked
# always_sensitive (the pick button binds itself). That is the only thing that greys this row out,
# so the widget binds nothing itself. The pass reads the keys of the rows only to find the switch
# and the never-remember list, and to name a row in its warnings.
handler = FakeHandler()
widget = Button(item, 'forget-all', handler)
check(isinstance(widget, SettingsWidget), 'the widget is a SettingsWidget')
check(isinstance(widget.content_widget, Gtk.Button), 'content_widget is a Gtk.Button')
check(widget.key == 'forget-all' and widget.settings is handler, 'the widget keeps its key and its settings handler')
check(widget.callback == item['callback'] == 'forgetAll', 'the callback is the one in the schema, forgetAll')
check(widget.uuid == 'window-memory@bootkicker' and widget.instance_id == 'window-memory@bootkicker',
      'uuid and instance id are the uuid of the extension, got %s %s' % (widget.uuid, widget.instance_id))
check(Button(item, 'forget-all', OtherHandler()).instance_id == 'instance-7', 'the instance id is the handler\'s')
check(handler.bind_calls == [], 'the widget binds nothing itself, got %s' % handler.bind_calls)
check(widget.get_tooltip_text() is None, 'no tooltip, as before')

# 2. Warning mark and label. The mark is the theme icon when the icon theme has it, and the
# glyph in front of the label (not inside its text) when it has not.
real_has_icon = Button._theme_has_icon
theme_has_it = Gtk.IconTheme.get_default().lookup_icon(THEME_ICON, 16, 0) is not None
for name, forced in (('this theme', None), ('with the icon', True), ('without the icon', False)):
    if forced is not None:
        Button._theme_has_icon = staticmethod(lambda forced=forced: forced)
    wanted_icon = theme_has_it if forced is None else forced
    box, children = parts(Button(item, 'forget-all', FakeHandler()))
    kinds = [type(c).__name__ for c in children]
    check(kinds == (['Image', 'Label'] if wanted_icon else ['Label', 'Label']),
          '%s: the mark, then the label (got %s)' % (name, kinds))
    check(isinstance(box, Gtk.Box) and box.get_orientation() == Gtk.Orientation.HORIZONTAL and box.get_halign() == Gtk.Align.CENTER,
          '%s: the button holds a centred horizontal box' % name)
    if len(children) == 2:
        if wanted_icon:
            check(children[0].get_icon_name()[0] == THEME_ICON, '%s: the mark is the theme icon %s' % (name, THEME_ICON))
        else:
            check(children[0].get_text() == GLYPH, '%s: the mark is the glyph U+26A0, got %r' % (name, children[0].get_text()))
        check(children[1].get_text() == item['description'], '%s: the label is the schema description, got %r' % (name, children[1].get_text()))
Button._theme_has_icon = staticmethod(real_has_icon)

# 3. The mark is red, #e01b24, and only the mark, and only while the button is not disabled. The
# label and the button keep the theme's colours: the text colour and a pixel of the button's
# background are compared with a plain Gtk.Button of the same theme, the same size, in the same state.
for name, has_icon in (('theme icon', True), ('glyph', False)):
    Button._theme_has_icon = staticmethod(lambda has_icon=has_icon: has_icon)
    red = Button(item, 'forget-all', FakeHandler())
    red_window = show(red)
    button = red.content_widget
    _, size, _ = settled_frame(red_window, button)
    plain = Gtk.Button(label=item['description'])
    plain.set_size_request(size.width, size.height)
    plain.set_halign(Gtk.Align.CENTER)
    plain.set_valign(Gtk.Align.CENTER)
    plain_window = show(plain)
    mark, label = parts(red)[1]
    plain_label = plain.get_child()
    wanted = (RED.red, RED.green, RED.blue, RED.alpha)
    for state, sensitive in (('enabled', True), ('disabled', False), ('enabled again', True)):
        red.set_sensitive(sensitive)
        plain.set_sensitive(sensitive)
        pump()
        where = '%s, %s' % (name, state)
        check(bool(mark.get_state_flags() & Gtk.StateFlags.INSENSITIVE) == (not sensitive),
              '%s: the mark is insensitive exactly when the button is (GTK passes it down)' % where)
        check(same_colour(colour_of(mark), wanted) == sensitive,
              '%s: the mark colour is %s (red wanted: %s)' % (where, colour_of(mark), sensitive))
        if has_icon and not theme_has_it:
            # The icon theme has no such icon here, so GTK draws a placeholder: only the colour is checked.
            print('note: this icon theme has no %s; the red pixels of the icon are not counted' % THEME_ICON)
        else:
            drawn = red_pixels(red_window, mark)
            check((drawn >= MIN_RED_PIXELS) == sensitive and (sensitive or drawn == 0),
                  '%s: %d red pixels are drawn in the mark (red wanted: %s)' % (where, drawn, sensitive))
        check(same_colour(colour_of(label), colour_of(plain_label)),
              '%s: the label keeps the theme colour %s, got %s' % (where, colour_of(plain_label), colour_of(label)))
        check(same_colour(colour_of(button), colour_of(plain)),
              '%s: the button keeps the theme colour %s, got %s' % (where, colour_of(plain), colour_of(button)))
        check(not same_colour(colour_of(label), wanted) and not same_colour(colour_of(button), wanted),
              '%s: neither the label nor the button is red' % where)
        ours, theirs = inside(red_window, button), inside(plain_window, plain)
        check(near(ours, theirs), '%s: the button background is the theme\'s %s, got %s' % (where, theirs, ours))
    discard(red_window, red)
    discard(plain_window, plain)
Button._theme_has_icon = staticmethod(real_has_icon)

# 4. The border is the one of the Pick-a-window button: the same rule, in a class of its own,
# on the button. pick_button.py cannot be imported by cinnamon-settings (each custom file is
# loaded standalone, xlet-settings.py:474-491), so the rule is copied; this keeps the copies equal.
button = widget.content_widget
check(button.get_style_context().has_class(module.CSS_CLASS), 'the border class %s is on the button' % module.CSS_CLASS)
pick = load_module('pick_button.py')


def rule(m):
    return m.CSS.decode('utf-8').replace('.' + m.CSS_CLASS, '.CLASS')


check(rule(module) == rule(pick) and 'border: 1px solid @theme_selected_bg_color; box-shadow: none;' in rule(pick),
      'the border rule is the one in pick_button.py: %r against %r' % (rule(module), rule(pick)))

# It is really drawn: the left edge of the button is the theme's selection colour while the
# button is enabled, and not while it is disabled.
window = show(Button(item, 'forget-all', FakeHandler()))
bordered = window.get_child()
button = bordered.content_widget
ok, colour = button.get_style_context().lookup_color('theme_selected_bg_color')
if not ok:
    print('note: this theme does not define theme_selected_bg_color; border colour not compared')
else:
    selection = tuple(int(round(c * 255)) for c in (colour.red, colour.green, colour.blue))
    for state, sensitive in (('enabled', True), ('disabled', False), ('enabled again', True)):
        bordered.set_sensitive(sensitive)
        _, alloc, pixbuf = settled_frame(window, button)
        edge = pixel(pixbuf, alloc.x, alloc.y + alloc.height // 2)
        check(near(edge, selection) == sensitive,
              'left border pixel is %s, theme selection colour is %s (%s: selection colour wanted: %s)' % (edge, selection, state, sensitive))
discard(window, bordered)

def results_of(shown):
    """The dialogs of a click other than its question."""
    return [d for d in shown if d.get('type') != Gtk.MessageType.QUESTION]


# 5. A click makes the call of the plain button, xlet-settings.py:65: activateCallback('(sss)',
# callback, uuid, instance_id), with the callback of the schema item, on a proxy built like
# xlet-settings.py:162-163 builds it. Gio.DBusProxy.new_for_bus_sync is replaced for the rest of
# the run, so nothing below can reach the real bus. The click is the real signal of the button.
Gio = module.Gio
real_new_for_bus_sync = Gio.DBusProxy.new_for_bus_sync
bus = RecordingBus()
Gio.DBusProxy.new_for_bus_sync = bus
EXPECTED_FLAGS = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS
made = [widget]
write_state(state_of(1))  # a click with no remembered window calls nothing: these clicks have one
for click_handler, instance_id in ((FakeHandler(), 'window-memory@bootkicker'), (OtherHandler(), 'instance-7'), (BareHandler(), 'window-memory@bootkicker')):
    clicked = Button(item, 'forget-all', click_handler)
    made.append(clicked)
    bus.calls.clear()
    bus.proxy = FakeProxy()
    clicked.content_widget.clicked()
    check(len(bus.calls) == 1, 'the first click makes one proxy (made %d)' % len(bus.calls))
    if bus.calls:
        args, kwargs = bus.calls[0]
        check(args == (Gio.BusType.SESSION, EXPECTED_FLAGS, None, 'org.Cinnamon', '/org/Cinnamon', 'org.Cinnamon', None) and kwargs == {},
              'the proxy is made on the session bus for org.Cinnamon /org/Cinnamon org.Cinnamon, flags '
              'DO_NOT_LOAD_PROPERTIES | DO_NOT_CONNECT_SIGNALS, no cancellable; got %s %s' % (args, kwargs))
    check(bus.proxy.calls == [('(sss)', 'forgetAll', 'window-memory@bootkicker', instance_id)],
          'click calls activateCallback with (sss, forgetAll, uuid, %s), got %s' % (instance_id, bus.proxy.calls))
    check(bus.proxy.kwargs == [{'timeout': 5000}], 'the call has a 5000 ms timeout and nothing else, got %s' % bus.proxy.kwargs)
    clicked.content_widget.clicked()
    check(len(bus.calls) == 1 and len(bus.proxy.calls) == 2, 'a second click reuses the proxy')

# The callback name comes from the schema item, not from the widget.
bus.calls.clear()
bus.proxy = FakeProxy()
other = Button(dict(item, callback='someOtherCallback'), 'forget-all', FakeHandler())
made.append(other)
other.content_widget.clicked()
check([call[1] for call in bus.proxy.calls] == ['someOtherCallback'], 'the callback name is the schema\'s, got %s' % bus.proxy.calls)

# 5b. Cinnamon not answering, or no bus at all, does not raise out of the click handler; it is logged,
# and an error dialog gives the reason. These widgets are in no window, so the dialog has no parent.
# Called directly: PyGObject swallows exceptions raised in signal handlers, so clicked() proves nothing here.
bus.calls.clear()
bus.proxy = FakeProxy(error=GLib.Error('no such name'))
failing = Button(item, 'forget-all', FakeHandler())
made.append(failing)
captured = io.StringIO()
ran = len(dialogs.shown)
try:
    with contextlib.redirect_stderr(captured):
        failing._on_clicked()
except Exception as e:
    check(False, 'a failed D-Bus call raised out of the click handler: %r' % e)
check(len(bus.proxy.calls) == 1, 'the failing call was made, so the error really was raised and handled')
check('window-memory: could not run forgetAll in Cinnamon: no such name' in captured.getvalue(),
      'a failed call is logged with the callback and the reason, got %r' % captured.getvalue())
check_dialog(results_of(dialogs.shown[ran:]), Gtk.MessageType.ERROR, NOT_FORGOTTEN, 'no such name.', None, 'a failed call')

gone = RecordingBus(error=GLib.Error('no bus'))
Gio.DBusProxy.new_for_bus_sync = gone
unreachable = Button(item, 'forget-all', FakeHandler())
made.append(unreachable)
captured = io.StringIO()
ran = len(dialogs.shown)
try:
    with contextlib.redirect_stderr(captured):
        unreachable._on_clicked()
        unreachable._on_clicked()
except Exception as e:
    check(False, 'a failed proxy creation raised out of the click handler: %r' % e)
check(len(gone.calls) == 2 and unreachable._proxy is None, 'a failed proxy is not cached, the next click tries again')
check(captured.getvalue().count('could not run forgetAll in Cinnamon: no bus') == 2, 'both failed clicks are logged, got %r' % captured.getvalue())
check(len(results_of(dialogs.shown[ran:])) == 2, 'each failed click runs one result dialog, got %d' % len(results_of(dialogs.shown[ran:])))
for number, shown in enumerate(results_of(dialogs.shown[ran:])):
    check_dialog([shown], Gtk.MessageType.ERROR, NOT_FORGOTTEN, 'no bus.', None, 'no bus, click %d' % (number + 1))
Gio.DBusProxy.new_for_bus_sync = bus

# 5c. The confirmation. Before the call the widget counts the remembered windows: the entries of
# "windows" in the state file of the extension, GLib.get_user_config_dir() + '/window-memory/state.json'
# (STATE_DIR in extension.js), here in the temp folder. It reads the file once per click, before the
# call: the proxy below empties it during the call, as the extension does. After a call that
# succeeds, a message dialog says that all were forgotten and how many: none for no file, nothing
# when the count is unknown. After a GLib.Error, an error dialog gives the reason without the
# "GDBus.Error:<name>: " of a D-Bus error reply; when no answer came in time, it says instead that
# it is not known whether the windows were forgotten. Each dialog is modal, transient for the
# settings window, and has an OK button. The call is the same in every case.
check(GLib.get_user_config_dir() == CONFIG, 'GLib gives the temp folder as the configuration folder, got %r' % GLib.get_user_config_dir())
settings_window = Gtk.Window()  # the settings window around the row; never shown
confirming = Button(item, 'forget-all', FakeHandler())
made.append(confirming)
settings_window.add(confirming)
opened = []  # (path, calls made before) for every file the widget opens


def recording_open(path, *args, **kwargs):
    opened.append((path, len(bus.proxy.calls)))
    return open(path, *args, **kwargs)


module.open = recording_open  # a global of the module, found before the builtin


def confirm(label, proxy):
    """Clicks the button in the settings window (its real signal), with proxy as Cinnamon. Returns
    the dialogs the click ran and what it logged, and checks the read and the call."""
    bus.proxy = proxy
    confirming._proxy = None  # so that the click asks the fake bus for its proxy, this one
    ran, reads = len(dialogs.shown), len(opened)
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        confirming.content_widget.clicked()
    wanted = [(STATE, 0)] if proxy.error else [(STATE, 0), (STATE, 1)]
    check(opened[reads:] == wanted, '%s: the state file is read once before the call, and once after a call that succeeds, got %s'
          % (label, opened[reads:]))
    check(proxy.calls == [('(sss)', 'forgetAll', UUID, UUID)] and proxy.kwargs == [{'timeout': 5000}],
          '%s: the call is the same, got %s %s' % (label, proxy.calls, proxy.kwargs))
    run_now = dialogs.shown[ran:]
    confirm.questions = [d for d in run_now if d.get('type') == Gtk.MessageType.QUESTION]
    return [d for d in run_now if d.get('type') != Gtk.MessageType.QUESTION], captured.getvalue()


def no_folder():
    shutil.rmtree(STATE_DIR, ignore_errors=True)


def no_file():
    no_folder()
    os.makedirs(STATE_DIR)


def folder_as_file():
    no_folder()
    os.makedirs(STATE)


counted = (('one remembered window', lambda: write_state(state_of(1)), '1 remembered window was forgotten.'),
           ('two remembered windows', lambda: write_state(state_of(2)), '2 remembered windows were forgotten.'),
           ('37 remembered windows', lambda: write_state(state_of(37)), '37 remembered windows were forgotten.'),
           ('one window again, in the same widget', lambda: write_state(state_of(1)), '1 remembered window was forgotten.'))
for label, prepare, detail in counted:
    prepare()
    got, log = confirm(label, EmptyingProxy())
    check_dialog(got, Gtk.MessageType.INFO, FORGOTTEN, detail, settings_window, label)
    check(log == '', '%s: nothing is logged, got %r' % (label, log))

# Each click with remembered windows first asks: a question dialog, modal and transient for the settings
# window, with Cancel and OK, Cancel the default. Only OK goes on to the call; Cancel, and the window's
# close button (DELETE_EVENT), leave the windows remembered: no call, no result dialog.
for label, prepare in (('one remembered window', lambda: write_state(state_of(1))),
                       ('several remembered windows', lambda: write_state(state_of(5)))):
    prepare()
    confirm(label, EmptyingProxy())
    check(len(confirm.questions) == 1, '%s: one question is asked, got %d' % (label, len(confirm.questions)))
    q = confirm.questions[0]
    check(q['text'] == CONFIRM and q['detail'] is None, '%s: the question is %r, got %r %r' % (label, CONFIRM, q['text'], q['detail']))
    check(q['modal'] and q['parent'] is settings_window and not q['mapped'] and q['destroyed'],
          '%s: the question is modal, transient for the settings window, not shown by the widget, destroyed' % label)
    check(sorted(q['buttons']) == ['CANCEL', 'OK'], '%s: Cancel and OK, got %s' % (label, q['buttons']))
    check(q['default'] == 'CANCEL', '%s: Cancel is the default' % label)

for label, answer in (('Cancel', Gtk.ResponseType.CANCEL), ('the close button', Gtk.ResponseType.DELETE_EVENT)):
    write_state(state_of(3))
    dialogs.answer = answer
    bus.proxy = FakeProxy()
    confirming._proxy = None
    ran, reads, calls = len(dialogs.shown), len(opened), len(bus.proxy.calls)
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        confirming.content_widget.clicked()
    dialogs.answer = Gtk.ResponseType.OK
    check(len(dialogs.shown) - ran == 1 and dialogs.shown[-1]['type'] == Gtk.MessageType.QUESTION,
          '%s: only the question is run, no result dialog' % label)
    check(not bus.proxy.calls, '%s: Cinnamon is not called' % label)
    check(len(opened) - reads == 1, '%s: the state file is read once (the count), got %d' % (label, len(opened) - reads))
    check(captured.getvalue() == '', '%s: nothing is logged, got %r' % (label, captured.getvalue()))
    with open(STATE, encoding='utf-8') as f:
        check(len(json.load(f)['windows']) == 3, '%s: the remembered windows are still there' % label)

# No remembered window (no file, no folder, or an empty list): nothing is asked and nothing is called.
# One message dialog says that there is nothing to forget, with an OK button only; closing it with the
# close button is the same as OK.
for label, prepare in (('no state folder', no_folder), ('a state folder with no file', no_file),
                       ('no remembered window', lambda: write_state(state_of(0)))):
    for closing, answer in (('OK', Gtk.ResponseType.OK), ('the close button', Gtk.ResponseType.DELETE_EVENT)):
        prepare()
        bus.proxy = FakeProxy()
        confirming._proxy = None
        ran = len(dialogs.shown)
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            confirming.content_widget.clicked()
        check_dialog(dialogs.shown[ran:], Gtk.MessageType.INFO, NOTHING_TO_FORGET, None, settings_window,
                     '%s, closed with %s' % (label, closing))
        check(not bus.proxy.calls, '%s: Cinnamon is not called' % label)
        check(captured.getvalue() == '', '%s: nothing is logged, got %r' % (label, captured.getvalue()))

# An unknown count: no secondary text, and the reason is logged.
unknown = (('a file that is not JSON', lambda: write_state(b'{broken')),
           ('a file that is not UTF-8', lambda: write_state(b'\xff\xfe{}')),
           ('an empty file', lambda: write_state(b'')),
           ('JSON that is not an object', lambda: write_state([])),
           ('an object without windows', lambda: write_state({'version': 1})),
           ('windows that are not a list', lambda: write_state({'version': 1, 'windows': {'a': 1}})),
           ('a folder in place of the file', folder_as_file))
for label, prepare in unknown:
    prepare()
    got, log = confirm(label, EmptyingProxy())
    check_dialog(got, Gtk.MessageType.INFO, FORGOTTEN, None, settings_window, label)
    check(log.startswith('window-memory: could not count the remembered windows') and log.count('\n') == 1,
          '%s: the reason is logged in one line, got %r' % (label, log))

# A failed call: the reason, as a sentence. The TypeError of a callback that Cinnamon cannot find
# means that Window Memory is not running. The classification of backup_buttons.py says when
# forgetAll may have run all the same, and the dialog then says that it is not known: a local
# timeout or closed connection (Gio.IOErrorEnum.TIMED_OUT or CLOSED), a local
# Gio.DBusError.TIMED_OUT, or NoReply from the bus. Any other remote error is an answer, the
# TimedOut reply of the bus among them, and keeps the dialog that says they were not forgotten. The
# errors are made as GDBus makes them (checked with Gio): an error reply is a remote
# error with the D-Bus name of the reply; a call that times out, or meets a closed connection, is a
# local error.
no_folder()
write_state(state_of(2))
call_errors = (('an error reply', Gio.DBusError.new_for_dbus_error('org.freedesktop.DBus.Error.ServiceUnknown',
                                                                    'The name org.Cinnamon was not provided by any .service files'),
                NOT_FORGOTTEN, 'The name org.Cinnamon was not provided by any .service files.'),
               ('an error reply that ends with a full stop', Gio.DBusError.new_for_dbus_error('org.gnome.gjs.JSError.Error',
                                                                                           '[window-memory] it failed.'),
                NOT_FORGOTTEN, '[window-memory] it failed.'),
               ('Window Memory not running', Gio.DBusError.new_for_dbus_error('org.gnome.gjs.JSError.TypeError', 'obj is null'),
                NOT_FORGOTTEN, NOT_RUNNING),
               ('a TimedOut reply', Gio.DBusError.new_for_dbus_error('org.freedesktop.DBus.Error.TimedOut', 'Timed out'),
                NOT_FORGOTTEN, 'Timed out.'),
               ('a closed connection', GLib.Error.new_literal(Gio.io_error_quark(), 'The connection is closed', Gio.IOErrorEnum.CLOSED),
                UNANSWERED, UNANSWERED_DETAIL),
               ('no answer in time', GLib.Error.new_literal(Gio.io_error_quark(), 'Timeout was reached', Gio.IOErrorEnum.TIMED_OUT),
                UNANSWERED, UNANSWERED_DETAIL),
               ('a local D-Bus timeout', GLib.Error.new_literal(Gio.dbus_error_quark(), 'Timed out', Gio.DBusError.TIMED_OUT),
                UNANSWERED, UNANSWERED_DETAIL),
               ('NoReply from the bus', Gio.DBusError.new_for_dbus_error('org.freedesktop.DBus.Error.NoReply',
                                                                         'Message recipient disconnected from message bus without replying'),
                UNANSWERED, UNANSWERED_DETAIL))
for label, error, text, detail in call_errors:
    got, log = confirm(label, FakeProxy(error=error))
    check_dialog(got, Gtk.MessageType.ERROR, text, detail, settings_window, label)
    check(log == 'window-memory: could not run forgetAll in Cinnamon: %s\n' % error.message,
          '%s: the failed call is logged, got %r' % (label, log))
# The copy keeps to backup_buttons.py: both classify each of these errors the same way.
backup = load_module('backup_buttons.py')
for label, error, text, detail in call_errors:
    check(Button._outcome_unknown(error) == backup.BackupButtons._outcome_unknown(error),
          '%s: classified as backup_buttons.py classifies it' % label)

# 5d. A call that succeeded, but the extension could not write the emptied state: the state file
# still holds entries from before the call, which come back the next time it starts. The widget
# reads the ids of the entries before the call, with the count, and again after a call that
# succeeds. An id from before that is still in the file gives an error dialog that says the change
# could not be saved. It decides by ids, not by counts: entries saved after the call have new ids.
# A file it cannot read after the call keeps the success dialog. Before each call the file holds two
# entries, entry-0 and entry-1; the proxy changes it during the call, as the extension would.
def replace_state(content):
    return lambda: write_state(content)


def folder_in_place():
    os.remove(STATE)
    os.makedirs(STATE)


ERROR, INFO = Gtk.MessageType.ERROR, Gtk.MessageType.INFO
TWO_FORGOTTEN = '2 remembered windows were forgotten.'
after_calls = (('the old entries are still in the file', lambda: None, ERROR, NOT_SAVED, NOT_SAVED_DETAIL),
               ('one old entry among new ones', replace_state({'version': 1, 'windows': [{'id': 'new-0'}, {'id': 'entry-1'}]}),
                ERROR, NOT_SAVED, NOT_SAVED_DETAIL),
               ('the file was emptied', replace_state(state_of(0)), INFO, FORGOTTEN, TWO_FORGOTTEN),
               ('only new entries, more than before', replace_state({'version': 1, 'windows': [{'id': 'new-%d' % n} for n in range(3)]}),
                INFO, FORGOTTEN, TWO_FORGOTTEN),
               ('a folder in place of the file', folder_in_place, INFO, FORGOTTEN, TWO_FORGOTTEN),
               ('a file that is no longer JSON, with the old ids in its text', replace_state(b'{"version": 1, "windows": [{"id": "entry-0"}'),
                INFO, FORGOTTEN, TWO_FORGOTTEN))
for label, change, message_type, text, detail in after_calls:
    no_folder()
    write_state(state_of(2))
    got, log = confirm(label, ChangingProxy(change))
    check_dialog(got, message_type, text, detail, settings_window, label)
    check(log == '', '%s: nothing is logged, got %r' % (label, log))
del module.open
no_folder()

# 6. __init__ must not raise: an exception there stops cinnamon-settings from building the page.
# A theme lookup that raises, a border that cannot be built, a red that cannot be applied, and
# CSS that GTK rejects only cost the icon, the border or the red; each is logged.
real_apply_border = Button._apply_border
real_apply_red = Button._apply_red
real_css, real_icon_css = module.CSS, module.ICON_CSS


def broken(*args):
    raise RuntimeError('broken on purpose')


def build_quietly(label):
    captured = io.StringIO()
    try:
        with contextlib.redirect_stderr(captured):
            built = Button(item, 'forget-all', FakeHandler())
    except Exception as e:
        check(False, '%s: __init__ raised: %r' % (label, e))
        return None, captured.getvalue()
    return built, captured.getvalue()


Button._theme_has_icon = staticmethod(broken)
built, log = build_quietly('a failing icon lookup')
if built is not None:
    kinds = [(type(c).__name__, c.get_text() if isinstance(c, Gtk.Label) else None) for c in parts(built)[1]]
    check(kinds == [('Label', GLYPH), ('Label', item['description'])],
          'with a failing icon lookup the glyph and the label are shown, got %s' % kinds)
    check('could not look up the %s icon: broken on purpose' % THEME_ICON in log, 'a failing icon lookup is logged, got %r' % log)
Button._theme_has_icon = staticmethod(real_has_icon)

Button._apply_border = broken
built, log = build_quietly('a failing border')
check(built is not None and 'could not style the button border: broken on purpose' in log, 'a failing border is logged, got %r' % log)
Button._apply_border = real_apply_border

Button._apply_red = broken
built, log = build_quietly('a failing red')
check(built is not None and [type(c).__name__ for c in parts(built)[1]] in (['Image', 'Label'], ['Label', 'Label'])
      and 'could not colour the warning mark: broken on purpose' in log, 'a failing red is logged and the mark is still there, got %r' % log)
Button._apply_red = real_apply_red

module.CSS = b'.x { frobnicate: 1; }'
built, log = build_quietly('border CSS that GTK rejects')
check(built is not None and 'the button border CSS was rejected' in log, 'rejected border CSS is logged, got %r' % log)
module.CSS = real_css
module.ICON_CSS = b'.x { frobnicate: 1; }'
built, log = build_quietly('red CSS that GTK rejects')
check(built is not None and 'the warning mark CSS was rejected' in log, 'rejected red CSS is logged, got %r' % log)
module.ICON_CSS = real_icon_css

# 6b. "Also remember dialog windows" (include-dialogs). While it is on, the dialog of a click would be
# remembered itself, and the next Forget all would count it. So a click turns it off before the call,
# and puts it back once the dialog is closed and its window is gone (module.RELEASE_DELAY_MS later, on
# the main loop), or at once when the row is destroyed first. Off before the click: never touched.
module.RELEASE_DELAY_MS = 30
module.open = recording_open  # put back: the cases above remove it
no_file()  # and they leave the state path as they like


def settle(done, what):
    deadline = time.time() + 3
    while not done() and time.time() < deadline:
        pump()
        time.sleep(0.01)
    check(done(), what)


def toggled(label, start, proxy=None, fail_set=False, dialog_error=None):
    handler = ToggleHandler(start, fail_set)
    confirming.settings = handler
    seen = []
    dialogs.during = lambda: (seen.append(handler.value), (_ for _ in ()).throw(dialog_error) if dialog_error and len(seen) > 1 else None)
    write_state(state_of(1))
    try:
        got, log = confirm(label, proxy or EmptyingProxy())
    except Exception:
        got, log = None, None
    finally:
        dialogs.during = None
    return handler, seen, got, log


handler, seen, got, log = toggled('toggle on', True)
check(seen == [False, False], 'toggle on: the toggle is off while both dialogs are open, got %s' % seen)
check(handler.sets == [False] and handler.value is False,
      'toggle on: it is still off right after the dialog closes, until its window is gone, got %s' % handler.sets)
settle(lambda: handler.value is True, 'toggle on: it is turned back on afterwards')
check(handler.sets == [False, True], 'toggle on: turned off once and on once, got %s' % handler.sets)
check_dialog(got, Gtk.MessageType.INFO, FORGOTTEN, '1 remembered window was forgotten.', settings_window, 'toggle on')
check(log == '', 'toggle on: nothing is logged, got %r' % log)

handler, seen, got, log = toggled('toggle off', False)
pump(); time.sleep(0.1); pump()
check(seen == [False, False] and handler.sets == [], 'toggle off: it is never touched, got %s %s' % (seen, handler.sets))

handler, seen, got, log = toggled('failed call', True, FakeProxy(error=GLib.Error('refused')))
settle(lambda: handler.value is True, 'failed call: the toggle is turned back on')
check(handler.sets == [False, True] and seen == [False, False], 'failed call: off during its dialogs, got %s %s' % (handler.sets, seen))

handler, seen, got, log = toggled('dialog raises', True, dialog_error=RuntimeError('dialog'))
settle(lambda: handler.value is True, 'dialog raises: the toggle is turned back on')

# Two clicks in a row: the second must not take the held-off value for the user's.
handler = ToggleHandler(True)
confirming.settings = handler
write_state(state_of(1))
confirm('first of two', EmptyingProxy())
write_state(state_of(1))
confirm('second of two', EmptyingProxy())
settle(lambda: handler.value is True, 'two clicks: the toggle ends on')
pump(); time.sleep(0.1); pump()
check(handler.value is True and handler.sets == [False, True],
      'two clicks: one off, one on, got %s' % handler.sets)

# The row destroyed before the delay: the toggle is put back at once.
module.RELEASE_DELAY_MS = 60000
gone = Button(item, 'forget-all', ToggleHandler(True))
made.append(gone)
gone_window = Gtk.Window()
gone_window.add(gone)
write_state(state_of(1))
bus.proxy = EmptyingProxy()
gone._proxy = None
with contextlib.redirect_stderr(io.StringIO()):
    gone.content_widget.clicked()
check(gone.settings.value is False, 'destroyed row: still off before the delay')
gone.destroy()
gone_window.destroy()
check(gone.settings.value is True, 'destroyed row: turned back on at once')
module.RELEASE_DELAY_MS = 30

# A handler with no get_value (or one that fails) must not stop the click: the dialog is shown, a
# failure to set is logged, and nothing is restored that was not changed.
confirming.settings = FakeHandler()
write_state(state_of(1))
got, log = confirm('plain handler', EmptyingProxy())
check_dialog(got, Gtk.MessageType.INFO, FORGOTTEN, '1 remembered window was forgotten.', settings_window, 'plain handler')
check(log == '', 'plain handler: nothing is logged, got %r' % log)

handler, seen, got, log = toggled('set fails', True, fail_set=True)
check(got and got[0]['text'] == FORGOTTEN, 'set fails: the dialog is still shown')
check('include-dialogs' in log, 'set fails: it is logged, got %r' % log)
pump(); time.sleep(0.1); pump()
check(handler.sets == [], 'set fails: nothing was set')
confirming.settings = FakeHandler()


del module.open

# 7. No widget above kept a real proxy, and no dialog was shown; the real constructor and run are put back.
Gio.DBusProxy.new_for_bus_sync = real_new_for_bus_sync
check(all(w._proxy is None or isinstance(w._proxy, FakeProxy) for w in made), 'no real DBusProxy was created')
Gtk.Dialog.run = real_run
check(dialogs.shown and not any(shown['mapped'] for shown in dialogs.shown), 'no dialog was shown')
settings_window.destroy()

# 8. In French. The texts of the dialog are translated in the domain of the uuid, from the .mo files
# in ~/.local/share/locale, the home folder being GLib's. A child process of this harness
# (french_child) runs with LANGUAGE=fr, and with HOME and XDG_DATA_HOME in a temp folder, where
# compile_french has compiled FRENCH with msgfmt -c. Its two dialogs, after a click with two
# remembered windows and one with one, come out in French, each with its French plural form.
# Skipped, with a note, when msgfmt is not installed.
fr_home = os.path.join(work, 'fr-home')
os.mkdir(fr_home)
problem = compile_french(fr_home, FRENCH)
if problem and problem.startswith('msgfmt is not installed'):
    print('note: %s; the French check is skipped' % problem)
elif problem:
    check(False, problem)
else:
    child = subprocess.run([sys.executable, '-B', os.path.abspath(__file__), ext_dir, 'french'],
                           env=dict(os.environ, LANGUAGE='fr', HOME=fr_home, XDG_DATA_HOME=os.path.join(fr_home, '.local', 'share')),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    lines = child.stdout.strip().splitlines()
    try:
        got = json.loads(lines[-1]) if child.returncode == 0 and lines else None
    except ValueError:
        got = None
    forgot = 'Toutes les fenêtres mémorisées ont été oubliées.'
    wanted = [[forgot, '2 fenêtres mémorisées ont été oubliées.'], [forgot, '1 fenêtre mémorisée a été oubliée.']]
    check(got == wanted, 'in French the two dialogs are %s, got %s (exit %d): %s' % (wanted, got, child.returncode, child.stderr[-2000:]))

settings.set_property('gtk-enable-animations', real_animations)
print('FAILED %d' % len(failures) if failures else 'OK')
sys.exit(1 if failures else 0)
