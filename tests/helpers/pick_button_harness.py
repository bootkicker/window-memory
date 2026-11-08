# SPDX-License-Identifier: GPL-3.0-or-later
# Test-only: builds PickWindowButton the way cinnamon-settings does and checks it.
# Run by tests/pick-button.test.js, which skips the test when there is no display.
# Usage: python3 -B pick_button_harness.py <extension dir>
# Exit codes: 0 all checks passed, 1 a check failed, 77 cannot run here (no display or no GTK).
#
# The widget is never given a real D-Bus proxy: every click goes to a fake one, and the
# last check proves that no real proxy was created.
#
# Section 9 builds the whole settings page from the real schema with Cinnamon's own widget
# classes (skipped, with a note, when they cannot be imported) and checks that every row follows
# the "enabled" switch, except the version row (version_info.py), which must stay sensitive. The pages are drawn in offscreen windows only; nothing is shown. The
# settings file it writes is in a temp directory, and GSettings uses the in-memory backend.
# The same page is used for the forget-all row (forget_button.py), which is greyed out with the
# others, and for the never-remember list, which the page pass makes two thirds as high as the stock
# list (same width, still scrolling), or leaves as it is, with a warning, when its height request
# cannot be read or is not above zero, or the list row holds two scrolled windows. The page pass also puts the
# "Max windows" spin button at the right end of the list's toolbar, bound to max-entries both ways; the list has
# the Enabled checkbox column first.
import collections
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

# Section 9 builds Cinnamon's real keybinding widget, which reads GSettings. The memory backend
# keeps that in this process: nothing is read from or written to the user's dconf database.
os.environ['GSETTINGS_BACKEND'] = 'memory'

try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import GLib, Gtk
    from xapp.SettingsWidgets import SettingsPage, SettingsWidget
    if not Gtk.init_check()[0]:
        raise RuntimeError('Gtk.init_check() failed: no display')
except Exception as e:  # ImportError, ValueError (missing typelib), RuntimeError
    print('cannot run: %s' % e)
    sys.exit(SKIP)

ext_dir = sys.argv[1]
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
        print('FAIL: ' + message)


def load_module(file_name='pick_button.py'):
    # The same three calls as xlet-settings.py:481-483.
    path = os.path.join(ext_dir, file_name)
    spec = importlib.util.spec_from_file_location('windowmemorybootkicker.' + file_name.split('.')[0], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHandler(object):
    """The part of cinnamon-settings' JSONSettingsHandler that the widget uses.

    instance_id is what the real one carries for an extension (xlet-settings.py:328).
    bind() sets the property to the key's value at once and set_value() sets it again, as
    bin/JsonSettingsWidgets.py:61-73 and :83-92 do for a binding with Gio.SettingsBindFlags.GET.
    """
    instance_id = 'window-memory@bootkicker'

    def __init__(self, enabled=True):
        self.values = {'enabled': enabled}
        self.bind_calls = []

    def bind(self, key, obj, prop, direction, map_get=None, map_set=None):
        self.bind_calls.append((key, obj, prop, direction))
        obj.set_property(prop, self.values[key])

    def set_value(self, key, value):
        self.values[key] = value
        for bound_key, obj, prop, direction in self.bind_calls:
            if bound_key == key:
                obj.set_property(prop, value)


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


def pump():
    for _ in range(20):
        while Gtk.events_pending():
            Gtk.main_iteration()


def pixel(pixbuf, x, y):
    start = y * pixbuf.get_rowstride() + x * pixbuf.get_n_channels()
    return tuple(pixbuf.get_pixels()[start:start + 3])


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


def settled_height(widget):
    """The allocated height of widget once it has stayed the same for STILL_SECONDS."""
    return settled(widget.get_allocated_height, 'the height of the %s' % type(widget).__name__)


module = load_module()
Button = module.PickWindowButton
with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
    item = json.load(f)['pick-window']

# 1. What cinnamon-settings needs: a SettingsWidget, built from (item, key, settings).
widget = Button(item, 'pick-window', FakeHandler())
check(isinstance(widget, SettingsWidget), 'the widget is a SettingsWidget')
check(isinstance(widget.content_widget, Gtk.Button), 'content_widget is a Gtk.Button')

# 2. Icon and label, both ways the icon can go.
real_has_icon = Button._theme_has_icon
Button._theme_has_icon = staticmethod(lambda: True)
row = Button(item, 'pick-window', FakeHandler()).content_widget.get_child()
kinds = [type(c).__name__ for c in row.get_children()]
check(kinds == ['Image', 'Label'], 'with the icon: an image, then the label (got %s)' % kinds)
check(row.get_children()[0].get_icon_name()[0] == 'find-location-symbolic', 'the image is find-location-symbolic')
check(row.get_children()[1].get_text() == item['description'], 'the label is the schema description')

Button._theme_has_icon = staticmethod(lambda: False)
row = Button(item, 'pick-window', FakeHandler()).content_widget.get_child()
kinds = [type(c).__name__ for c in row.get_children()]
check(kinds == ['Label'], 'without the icon: only the label (got %s)' % kinds)
check(row.get_children()[0].get_text() == '⌖ ' + item['description'], 'without the icon the label starts with U+2316')
Button._theme_has_icon = staticmethod(real_has_icon)

# 3. The border is drawn in the theme's selection colour, also while hovered or pressed.
window = Gtk.OffscreenWindow()
window.set_default_size(560, 60)
window.add(widget)
window.show_all()
pump()
button = widget.content_widget
ok, colour = button.get_style_context().lookup_color('theme_selected_bg_color')
if not ok:
    print('note: this theme does not define theme_selected_bg_color; border colour not compared')
else:
    expected = tuple(int(round(c * 255)) for c in (colour.red, colour.green, colour.blue))
    for name, flags in (('normal', Gtk.StateFlags.NORMAL), ('hover', Gtk.StateFlags.PRELIGHT), ('pressed', Gtk.StateFlags.ACTIVE)):
        button.set_state_flags(flags, True)
        _, alloc, pixbuf = settled_frame(window, button)
        found = pixel(pixbuf, alloc.x, alloc.y + alloc.height // 2)
        check(all(abs(a - b) <= 1 for a, b in zip(found, expected)),
              'left border pixel in the %s state is %s, theme selection colour is %s' % (name, found, expected))
window.remove(widget)  # destroying the window would destroy the widget and drop its signal handlers
window.destroy()

# 3b. The border is 1px, and nothing dark is left outside it or between it and the button background.
# Some themes give buttons an outer box-shadow (a 1px line on each side), which survives a border
# override; so the check also runs on the themes below that are installed, with animations off so
# that the hover state is drawn at once.
settings = Gtk.Settings.get_default()
real_theme = settings.get_property('gtk-theme-name')
real_animations = settings.get_property('gtk-enable-animations')
settings.set_property('gtk-enable-animations', False)
themes = []
for name in (real_theme, 'Mint-Y', 'Mint-L', 'Mint-X', 'Adwaita', 'Adwaita-dark', 'HighContrast'):
    if name not in themes and os.path.exists('/usr/share/themes/%s/gtk-3.0/gtk.css' % name):
        themes.append(name)


def near(a, b):
    return all(abs(x - y) <= 1 for x, y in zip(a, b))


for theme in themes:
    settings.set_property('gtk-theme-name', theme)
    for state_name, flags in (('normal', Gtk.StateFlags.NORMAL), ('hover', Gtk.StateFlags.PRELIGHT)):
        probe = Button(item, 'pick-window', FakeHandler())
        probe_window = Gtk.OffscreenWindow()
        probe_window.set_default_size(560, 60)
        probe_window.add(probe)
        probe_window.show_all()
        pump()
        probe.content_widget.set_state_flags(flags, True)
        _, a, pixbuf = settled_frame(probe_window, probe.content_widget)
        ok, colour = probe.content_widget.get_style_context().lookup_color('theme_selected_bg_color')
        row = a.y + a.height // 2
        where = '%s, %s' % (theme, state_name)
        if not ok:
            print('note: %s has no theme_selected_bg_color; skipped' % theme)
        else:
            selection = tuple(int(round(c * 255)) for c in (colour.red, colour.green, colour.blue))
            right = a.x + a.width - 1
            widths = {
                'left': sum(1 for k in range(0, 6) if near(pixel(pixbuf, a.x + k, row), selection) and all(
                    near(pixel(pixbuf, a.x + j, row), selection) for j in range(k + 1))),
                'right': sum(1 for k in range(0, 6) if near(pixel(pixbuf, right - k, row), selection) and all(
                    near(pixel(pixbuf, right - j, row), selection) for j in range(k + 1))),
                'top': sum(1 for k in range(0, 6) if near(pixel(pixbuf, a.x + a.width // 2, a.y + k), selection) and all(
                    near(pixel(pixbuf, a.x + a.width // 2, a.y + j), selection) for j in range(k + 1))),
            }
            check(widths == {'left': 1, 'right': 1, 'top': 1}, '%s: border width in px is %s, want 1 on each side' % (where, widths))
            page = pixel(pixbuf, a.x - 8, row)
            outside = [pixel(pixbuf, a.x - 1, row), pixel(pixbuf, a.x - 2, row),
                       pixel(pixbuf, a.x + a.width, row), pixel(pixbuf, a.x + a.width + 1, row)]
            check(all(p == page for p in outside), '%s: pixels just outside the border are %s, the page is %s' % (where, outside, page))
            inside = [pixel(pixbuf, a.x + 1, row), pixel(pixbuf, right - 1, row)]
            interior = [pixel(pixbuf, a.x + 4, row), pixel(pixbuf, right - 4, row)]
            check(inside == interior, '%s: pixels just inside the border are %s, the button background is %s' % (where, inside, interior))
        probe_window.remove(probe)
        probe_window.destroy()
    # While "Enable Window Memory" is off the button is the theme's own disabled button: no
    # selection-coloured border, and the same edge pixels as a plain disabled Gtk.Button of
    # this theme (its border and anything outside it), so it looks as greyed out as the
    # other rows.
    disabled = Button(item, 'pick-window', FakeHandler(enabled=False))
    plain = Gtk.Button(label=item['description'])
    plain.set_sensitive(False)
    for margin in ('start', 'end', 'top', 'bottom'):
        getattr(plain, 'set_margin_' + margin)(10)  # page background around it, as around the row's button
    edges = []
    for root, button in ((disabled, disabled.content_widget), (plain, plain)):
        edge_window = Gtk.OffscreenWindow()
        edge_window.set_default_size(560, 60)
        edge_window.add(root)
        edge_window.show_all()
        _, a, pixbuf = settled_frame(edge_window, button)
        row = a.y + a.height // 2
        edges.append([pixel(pixbuf, a.x, row), pixel(pixbuf, a.x + a.width - 1, row),
                      pixel(pixbuf, a.x + a.width // 2, a.y),
                      pixel(pixbuf, a.x - 1, row), pixel(pixbuf, a.x + a.width, row)])
        edge_window.remove(root)
        edge_window.destroy()
    check(all(near(x, y) for x, y in zip(*edges)),
          '%s, disabled: left, right, top and outside edge pixels are %s, a plain disabled button has %s' % (theme, edges[0], edges[1]))
    ok, colour = disabled.content_widget.get_style_context().lookup_color('theme_selected_bg_color')
    if ok:
        selection = tuple(int(round(c * 255)) for c in (colour.red, colour.green, colour.blue))
        check(not near(edges[0][0], selection), '%s, disabled: the left border %s is not the selection colour' % (theme, edges[0][0]))
settings.set_property('gtk-theme-name', real_theme)
settings.set_property('gtk-enable-animations', real_animations)

# 4. A click builds the proxy the way xlet-settings.py:162-163 does, and makes the plain button's
# call, xlet-settings.py:65: activateCallback('(sss)', callback, uuid, instance_id).
# Gio.DBusProxy.new_for_bus_sync is replaced for the rest of the run, so nothing below can reach the
# real bus. The instance id is the handler's (xlet-settings.py:328), or the uuid when it has none.
Gio = module.Gio
real_new_for_bus_sync = Gio.DBusProxy.new_for_bus_sync
bus = RecordingBus()
Gio.DBusProxy.new_for_bus_sync = bus


class OtherHandler(FakeHandler):
    instance_id = 'instance-7'


class BareHandler(object):
    # Neither an instance_id nor a bind(): the widget must still build (section 7b checks the rest).
    pass


class RaisingHandler(FakeHandler):
    def bind(self, *args, **kwargs):
        raise KeyError('enabled')


EXPECTED_FLAGS = Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS
made = []
for handler, instance_id in ((FakeHandler(), 'window-memory@bootkicker'), (OtherHandler(), 'instance-7'), (BareHandler(), 'window-memory@bootkicker')):
    clicked = Button(item, 'pick-window', handler)
    made.append(clicked)
    bus.calls.clear()
    bus.proxy = FakeProxy()
    clicked._on_clicked()
    check(len(bus.calls) == 1, 'the first click makes one proxy (made %d)' % len(bus.calls))
    if bus.calls:
        args, kwargs = bus.calls[0]
        check(args == (Gio.BusType.SESSION, EXPECTED_FLAGS, None, 'org.Cinnamon', '/org/Cinnamon', 'org.Cinnamon', None) and kwargs == {},
              'the proxy is made on the session bus for org.Cinnamon /org/Cinnamon org.Cinnamon, flags '
              'DO_NOT_LOAD_PROPERTIES | DO_NOT_CONNECT_SIGNALS, no cancellable; got %s %s' % (args, kwargs))
    check(bus.proxy.calls == [('(sss)', 'pickWindow', 'window-memory@bootkicker', instance_id)],
          'click calls activateCallback with (sss, pickWindow, uuid, %s), got %s' % (instance_id, bus.proxy.calls))
    check(bus.proxy.kwargs == [{'timeout': 5000}],
          'the call has a 5000 ms timeout and nothing else, got %s' % bus.proxy.kwargs)
    clicked._on_clicked()
    check(len(bus.calls) == 1 and len(bus.proxy.calls) == 2, 'a second click reuses the proxy')

# 5. Cinnamon not answering, or no bus at all, does not raise out of the click handler.
# Called directly: PyGObject swallows exceptions raised in signal handlers, so button.clicked() proves nothing.
bus.calls.clear()
bus.proxy = FakeProxy(error=GLib.Error('no such name'))
failing = Button(item, 'pick-window', FakeHandler())
try:
    failing._on_clicked()
except Exception as e:
    check(False, 'a failed D-Bus call raised out of the click handler: %r' % e)
check(len(bus.proxy.calls) == 1, 'the failing call was made, so the error really was raised and handled')

gone = RecordingBus(error=GLib.Error('no bus'))
Gio.DBusProxy.new_for_bus_sync = gone
unreachable = Button(item, 'pick-window', FakeHandler())
try:
    unreachable._on_clicked()
    unreachable._on_clicked()
except Exception as e:
    check(False, 'a failed proxy creation raised out of the click handler: %r' % e)
check(len(gone.calls) == 2 and unreachable._proxy is None, 'a failed proxy is not cached, the next click tries again')
Gio.DBusProxy.new_for_bus_sync = bus

# 6. The tooltip comes from the schema item.
check(bool(item.get('tooltip')), 'the schema item has a tooltip')
check(widget.get_tooltip_text() == item.get('tooltip'), 'the widget shows the schema tooltip')
check(Button({k: v for k, v in item.items() if k != 'tooltip'}, 'pick-window', FakeHandler()).get_tooltip_text() is None,
      'no tooltip when the schema item has none')

# 7. __init__ must not raise: an exception there stops cinnamon-settings from building the page.
# A theme lookup that raises, and a border that cannot be built, only cost the icon and the border.
real_apply_border = Button._apply_border


def broken(*args):
    raise RuntimeError('broken on purpose')


Button._theme_has_icon = staticmethod(broken)
Button._apply_border = broken
try:
    guarded = Button(item, 'pick-window', FakeHandler())
    row = guarded.content_widget.get_child()
    check([type(c).__name__ for c in row.get_children()] == ['Label']
          and row.get_children()[0].get_text() == '⌖ ' + item['description'],
          'with a failing icon lookup the label alone is shown, with the U+2316 prefix')
except Exception as e:
    check(False, '__init__ raised when the icon lookup and the border failed: %r' % e)
Button._theme_has_icon = staticmethod(real_has_icon)
Button._apply_border = real_apply_border

# 7b. The row is greyed out, and its button cannot be clicked, while "Enable Window Memory"
# (the key "enabled") is off. The schema's "dependency" key cannot do it: it hides the row
# (JSONSettingsRevealer, bin/JsonSettingsWidgets.py:229-270). The widget binds the key to its
# own "sensitive" property, read-only, through the handler's bind().
check(json.load(open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8'))['enabled']['type'] == 'switch',
      'the key the widget follows, "enabled", is a switch in the schema')
GET = Gio.SettingsBindFlags.GET
on_handler = FakeHandler(enabled=True)
on_widget = Button(item, 'pick-window', on_handler)
check(on_handler.bind_calls == [('enabled', on_widget, 'sensitive', GET)],
      'the widget binds "enabled" to its own "sensitive", GET only; got %s' % on_handler.bind_calls)
check(on_widget.get_sensitive() and on_widget.content_widget.is_sensitive(), 'enabled on: the row and its button are sensitive')
off_widget = Button(item, 'pick-window', FakeHandler(enabled=False))
check(not off_widget.get_sensitive() and not off_widget.content_widget.is_sensitive(),
      'built while enabled is off: the row and its button are insensitive from the start')
live_handler = FakeHandler(enabled=True)
live = Button(item, 'pick-window', live_handler)
for value in (False, True, False, True):
    live_handler.set_value('enabled', value)
    check(live.get_sensitive() == value and live.content_widget.is_sensitive() == value,
          'enabled flipped to %s: the button follows at once, without being rebuilt' % value)
check(live.get_tooltip_text() == item.get('tooltip'), 'the tooltip does not change with the state')
# A handler without bind() (or a bind() that raises) must not stop the page: the button stays
# usable and a warning is logged.
for label, handler in (('no bind()', BareHandler()), ('a bind() that raises', RaisingHandler())):
    captured = io.StringIO()
    try:
        with contextlib.redirect_stderr(captured):
            unbound = Button(item, 'pick-window', handler)
        check(unbound.get_sensitive() and unbound.content_widget.is_sensitive(), '%s: the button stays sensitive' % label)
        check('could not follow the "enabled" setting' in captured.getvalue(), '%s: a warning is logged, got %r' % (label, captured.getvalue()))
    except Exception as e:
        check(False, '%s: __init__ raised: %r' % (label, e))

# 8. No widget above kept a real proxy; the real constructor is put back.
Gio.DBusProxy.new_for_bus_sync = real_new_for_bus_sync
check(all(w._proxy is None or w._proxy is bus.proxy or isinstance(w._proxy, FakeProxy) for w in made + [widget, failing, unreachable]),
      'no real DBusProxy was created')

# 9. The whole settings page. While "Enable Window Memory" is off every other row is greyed
# out and cannot be used, and everything is as it was when it is on again. The pick button
# does this for the rows by itself, once the page is shown (_on_map); the schema's
# "dependency" key would hide them instead.
# 9a. Not on a settings page: nothing to walk, so the button warns and nothing else happens.
pageless = Button(item, 'pick-window', FakeHandler(enabled=True))
pageless_window = Gtk.OffscreenWindow()
pageless_window.add(pageless)
captured = io.StringIO()
with contextlib.redirect_stderr(captured):
    pageless_window.show_all()
    pump()
check('not on a settings page' in captured.getvalue(), 'on no settings page the button warns, got %r' % captured.getvalue())
check(pageless.is_sensitive(), 'on no settings page the button itself still follows the switch (enabled is on)')
pageless_window.remove(pageless)
pageless_window.destroy()

# 9b. The page, built like cinnamon-settings builds it (xlet-settings.py:431-472) from the real
# schema, with Cinnamon's own classes: its JSONSettingsHandler and JSON* widgets. The custom
# rows (pick-window, forget-all, version-info) are built from the schema's "file" and "widget".
# A schema "button" item (there is none now) would be replaced by the Button that
# XLETSettingsButton extends: that class lives in the xlet-settings.py script and cannot be
# imported. Skipped when Cinnamon is not installed.
CINNAMON_BIN = '/usr/share/cinnamon/cinnamon-settings/bin'
try:
    sys.path.append(CINNAMON_BIN)
    import JsonSettingsWidgets as cinnamon_json
    from xapp.SettingsWidgets import Button as PlainButton
except Exception as e:
    cinnamon_json = None
    print('note: the Cinnamon settings widgets cannot be imported (%s); the page checks are skipped' % e)

if cinnamon_json is not None:
    ENABLED = 'enabled'
    VERSION = 'version-info'  # the row of version_info.py: never greyed out
    with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
        # The settings window has two tabs (the schema's first key is a layout). pick_button.py greys out the rows of the page
        # it is on, the "General" tab: build_page makes one row per key of that page's sections, in the order of the layout
        # (xlet-settings.py build_with_layout), so the count follows it. The other tab has its own widget, and the hidden
        # startup-pick key is in no section.
        LAYOUT = json.load(f, object_pairs_hook=collections.OrderedDict)['layout']
    GENERAL_KEYS = [key for name in LAYOUT['general']['sections'] for key in LAYOUT[name]['keys']]
    SCHEMA_ROWS = len(GENERAL_KEYS)
    custom_modules = {}

    # Every custom row of the layout, on either tab, names a file and a class that xlet-settings.py can load and that is a
    # SettingsWidget (xlet-settings.py:460-461). StartupList is made on first access by the module's __getattr__, so a
    # search of the source for "class StartupList" would not find it: it is loaded here, with the same three calls.
    with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
        every_entry = json.load(f, object_pairs_hook=collections.OrderedDict)
    every_key = [key for page in every_entry['layout']['pages'] for name in every_entry['layout'][page]['sections']
                 for key in every_entry['layout'][name]['keys']]
    check('startup-list' in every_key and 'startup-pick' not in every_key, 'the login tab lists startup-list and the hidden startup-pick is in no section')
    check(every_key.count('version-info') == 1 and every_key.count('version-info-login') == 1 and every_key[-1] == 'version-info-login',
          'each tab ends with its own Version key, each listed once')
    for key in every_key:
        entry = every_entry[key]
        if entry['type'] != 'custom':
            continue
        loaded = load_module(entry['file'])
        widget_class = getattr(loaded, entry['widget'])
        check(isinstance(widget_class, type) and issubclass(widget_class, SettingsWidget),
              '%s: %s of %s is a SettingsWidget class' % (key, entry['widget'], entry['file']))
    check(getattr(load_module('startup_list.py'), 'StartupList').__name__ == 'StartupList', 'startup_list.py gives the class StartupList')

    # The schema types of this extension, and the class xlet-settings.py:30-54 maps each to.
    XLET_WIDGETS = {'switch': 'JSONSettingsSwitch', 'spinbutton': 'JSONSettingsSpinButton',
                    'combobox': 'JSONSettingsComboBox', 'keybinding': 'JSONSettingsKeybinding',
                    'list': 'JSONSettingsList'}
    LIST_BUTTONS = ('add_button', 'remove_button', 'edit_button', 'move_up_button', 'move_down_button')
    work = tempfile.mkdtemp(prefix='window-memory-harness-')
    settings.set_property('gtk-enable-animations', False)  # so a snapshot is never mid-transition

    def write_settings(path, enabled):
        with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
            full = json.load(f, object_pairs_hook=collections.OrderedDict)
        for entry in full.values():
            if entry['type'] not in ('button', 'custom', 'label', 'layout'):
                entry['value'] = entry['default']
        full[ENABLED]['value'] = enabled
        full['__md5__'] = 'harness'
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(full, f, indent=4)

    def build_page(enabled, keys=None):
        """The page in an offscreen window, shown. keys limits it to some rows (default: all)."""
        path = os.path.join(work, 'window-memory@bootkicker.json')
        write_settings(path, enabled)
        handler = cinnamon_json.JSONSettingsHandler(path, None)
        handler.instance_id = 'window-memory@bootkicker'
        page = SettingsPage()
        section = page.add_section('Settings for window-memory@bootkicker')
        widgets = collections.OrderedDict()
        settings_map = handler.get_settings()
        for key in GENERAL_KEYS:  # the rows of the General tab, in its order
            entry = settings_map[key]
            if keys is not None and key not in keys:
                continue
            if entry['type'] not in XLET_WIDGETS and entry['type'] not in ('button', 'custom'):
                continue  # a generic has no widget (xlet-settings.py: an unknown type is skipped)
            if entry['type'] == 'button':
                row = PlainButton(entry['description'])
            elif entry['type'] == 'custom':
                # The module of the schema's "file", as xlet-settings.py:474-491 loads it.
                if entry['file'] not in custom_modules:
                    custom_modules[entry['file']] = module if entry['file'] == 'pick_button.py' else load_module(entry['file'])
                row = getattr(custom_modules[entry['file']], entry['widget'])(entry, key, handler)
            else:
                row = getattr(cinnamon_json, XLET_WIDGETS[entry['type']])(key, handler, entry)
            section.add_row(row)
            widgets[key] = row
        page_window = Gtk.OffscreenWindow()
        page_window.set_default_size(760, 900)
        page_window.add(page)
        page_window.show_all()
        pump()
        return handler, widgets, page_window

    def populate_list(widgets):
        """Three entries, the middle one selected: all five list buttons are usable."""
        lst = widgets['excluded-apps']
        for name in ('firefox', 'xed', 'vlc'):
            lst.model.append([True, name])
        lst.content_widget.get_selection().select_path(Gtk.TreePath.new_from_string('1'))
        pump()

    def below(widget):
        found = [widget]
        if isinstance(widget, Gtk.Container):
            for child in widget.get_children():
                found.extend(below(child))
        if isinstance(widget, Gtk.TreeView):
            found.extend(column.get_button() for column in widget.get_columns())
        return found

    def check_page(label, widgets, target, populated=False):
        """Every row except the switch follows target; the switch stays usable; so does the list."""
        word = 'sensitive' if target else 'greyed out'
        for key, row in widgets.items():
            if key == ENABLED:
                check(row.is_sensitive(), '%s: the "enabled" switch itself stays sensitive' % label)
                continue
            if key == VERSION:
                # The version line and its commit link are information, not a setting: never greyed out.
                check(row.is_sensitive() and all(w.is_sensitive() for w in below(row)),
                      '%s: the version row and everything in it stays sensitive' % label)
                continue
            check(row.is_sensitive() == target, '%s: row "%s" is %s' % (label, key, word))
            if not target:
                usable = [type(w).__name__ for w in below(row)
                          if isinstance(w, (Gtk.Button, Gtk.ToolItem, Gtk.Switch, Gtk.SpinButton, Gtk.ComboBox, Gtk.TreeView))
                          and w.is_sensitive()]
                check(not usable, '%s: row "%s" still has controls that can be used: %s' % (label, key, usable))
        if 'excluded-apps' in widgets:
            lst = widgets['excluded-apps']
            for column in lst.content_widget.get_columns():
                check(column.get_button().is_sensitive() == target, '%s: the list column header "%s" is %s' % (label, column.get_title(), word))
            spins = module.PickWindowButton._descendants(lst, Gtk.SpinButton)
            check(len(spins) == 1 and spins[0].is_sensitive() == target, '%s: the Max windows spin button is %s' % (label, word))
            for name in LIST_BUTTONS:
                expected = target and (populated or name == 'add_button')  # the others need a selected row
                check(getattr(lst, name).is_sensitive() == expected,
                      '%s: the list button %s is %s' % (label, name, 'sensitive' if expected else 'insensitive'))

    def header_contrast(widgets, page_window, column=0):
        """How far the header text of a list column stands out from the header background, in the page's pixels."""
        button = widgets['excluded-apps'].content_widget.get_column(column).get_button()
        (x, y), a, pixbuf = settled_frame(page_window, button)
        x, y, w, h = x + 3, y + 3, min(a.width, 330) - 6, a.height - 6
        # get_pixels() copies the whole buffer, so read it once, not once per pixel (as pixel() does).
        data, stride, channels = pixbuf.get_pixels(), pixbuf.get_rowstride(), pixbuf.get_n_channels()

        def at(i, j):
            start = j * stride + i * channels
            return data[start:start + 3]

        background = at(x, y)
        return max(sum(abs(p - q) for p, q in zip(at(i, j), background))
                   for j in range(y, y + h) for i in range(x, x + w))

    @contextlib.contextmanager
    def switched_off(step):
        """The page pass with one of its methods replaced by a no-op: '_on_map' is the whole pass,
        '_grey_out_other_rows' is the binding of the rows only."""
        real = getattr(module.PickWindowButton, step)
        setattr(module.PickWindowButton, step, lambda self, *args: None)
        try:
            yield
        finally:
            setattr(module.PickWindowButton, step, real)

    def pixels_without_the_walk():
        """The page as it looks when enabled with the walk switched off: "identical" is measured against it.
        Only the walk is off: the list is still made shorter, that is not what is measured here."""
        with switched_off('_grey_out_other_rows'):
            _, _, plain_window = build_page(True)
            pixels = snapshot(plain_window).get_pixels()
            plain_window.destroy()
        return pixels

    def snapshot(page_window):
        """The page's pixbuf once its pixels have stayed the same for STILL_SECONDS (settled)."""
        settled(lambda: page_window.get_pixbuf().get_pixels(), 'the drawing of the page')
        return page_window.get_pixbuf()

    def flip(widgets, value):
        widgets[ENABLED].content_widget.set_active(value)  # what a click on the switch does
        pump()

    baseline = pixels_without_the_walk()
    for start in (True, False):
        handler, widgets, page_window = build_page(start)
        check(len(widgets) == SCHEMA_ROWS and widgets[ENABLED].content_widget.get_active() == start,
              'the page has the %d rows of the schema, enabled=%s' % (SCHEMA_ROWS, start))
        check(list(widgets)[-1] == VERSION, 'the version row is the last row of the page')
        check_page('built with enabled=%s' % start, widgets, start)
        if start:
            check(snapshot(page_window).get_pixels() == baseline, 'enabled: the page looks exactly as it does without the walk')
        for target in (not start, start, not start, start):
            flip(widgets, target)
            check(handler.get_value(ENABLED) is target, 'the switch wrote enabled=%s' % target)
            check_page('flipped to %s' % target, widgets, target)
            if target:
                check(snapshot(page_window).get_pixels() == baseline,
                      'enabled again: the page looks exactly as it does without the walk')
        page_window.destroy()

    # The forget-all row is forget_button.py's ForgetAllButton, built from the schema's "file" and
    # "widget" like any custom row. It binds nothing itself: the page pass above greys it out.
    handler, widgets, page_window = build_page(True)
    forget = widgets['forget-all']
    check(type(forget).__name__ == 'ForgetAllButton' and getattr(forget, 'key', None) == 'forget-all',
          'the forget-all row is a ForgetAllButton with its key, got %s' % type(forget).__name__)
    check(forget.is_sensitive() and forget.content_widget.is_sensitive(), 'enabled: the forget-all row and its button are sensitive')
    flip(widgets, False)
    check(not forget.is_sensitive() and not forget.content_widget.is_sensitive(),
          'disabled: the forget-all row and its button are greyed out with the other rows')
    flip(widgets, True)
    check(forget.is_sensitive() and forget.content_widget.is_sensitive(), 'enabled again: the forget-all row and its button are sensitive')
    page_window.destroy()

    # The never-remember list. The page pass gives its scrolled window two thirds of the height the
    # stock list gives it (cinnamon-settings bin/TreeListWidgets.py:119-120: set_size_request(-1, 200)),
    # once, when the page is first shown. The width and the scrolling are left alone. "Before" is the
    # same page with the whole page pass switched off. The sizes are the ones GTK allocated.
    TWO_THIRDS = 2.0 / 3.0

    def list_window(widgets):
        found = module.PickWindowButton._descendants(widgets['excluded-apps'], Gtk.ScrolledWindow)
        check(len(found) == 1, 'the list row holds one scrolled window, found %d' % len(found))
        return found[0]

    def list_size(widgets):
        """(width, height, width request) of the list's scrolled window, once its size has settled."""
        scrolled = list_window(widgets)
        width, height = settled(lambda: (scrolled.get_allocated_width(), scrolled.get_allocated_height()), 'the size of the list')
        return width, height, scrolled.get_size_request()[0]

    with switched_off('_on_map'):
        _, stock_widgets, stock_window = build_page(True)
        before_width, before_height, before_request_width = list_size(stock_widgets)
        stock_window.destroy()
    handler, widgets, page_window = build_page(True)
    after_width, after_height, after_request_width = list_size(widgets)
    print('list height: %d px before, %d px after; width: %d px before, %d px after'
          % (before_height, after_height, before_width, after_width))
    check(before_height > 1, 'the stock list has a height to take a share of, got %d' % before_height)
    check(abs(after_height - before_height * TWO_THIRDS) < 1,
          'the list is two thirds of its height: %d px before, %d px after, %.1f px wanted' % (before_height, after_height, before_height * TWO_THIRDS))
    check(after_height < before_height, 'the list is shorter: %d px before, %d px after' % (before_height, after_height))
    check(before_width > 1 and after_width == before_width and after_request_width == before_request_width,
          'the list is as wide as before: %d px before, %d px after (width requests %d and %d)'
          % (before_width, after_width, before_request_width, after_request_width))
    # Still scrollable: more rows than fit make the content taller than the visible part, and the
    # scrollbar moves it.
    scrolled = list_window(widgets)
    for number in range(40):
        widgets['excluded-apps'].model.append([True, 'application-%d' % number])
    vertical = scrolled.get_vadjustment()
    settled(lambda: (scrolled.get_allocated_height(), vertical.get_page_size(), vertical.get_upper()), 'the scrolling of the list')
    check(scrolled.get_policy()[1] != Gtk.PolicyType.NEVER, 'the list can scroll vertically, policy %s' % scrolled.get_policy()[1])
    check(0 < vertical.get_page_size() < after_height < vertical.get_upper(),
          'forty rows do not fit: visible %d px of %d px high list, content %d px' % (vertical.get_page_size(), after_height, vertical.get_upper()))
    vertical.set_value(vertical.get_upper())
    pump()
    check(vertical.get_value() > 0, 'scrolling to the end moves the list, value %d' % vertical.get_value())
    page_window.destroy()

    # Once: hiding the page and showing it again maps the button again, and must not take another
    # share of the height.
    maps = []
    real_on_map = module.PickWindowButton._on_map

    def counting_on_map(self, *args):
        maps.append(1)
        return real_on_map(self, *args)

    module.PickWindowButton._on_map = counting_on_map
    try:
        handler, widgets, page_window = build_page(True)
        for _ in range(3):
            page_window.hide()
            pump()
            page_window.show_all()
            pump()
        again_width, again_height, _ = list_size(widgets)
    finally:
        module.PickWindowButton._on_map = real_on_map
    check(len(maps) >= 3, 'the button was mapped again when the page was shown again (%d maps)' % len(maps))
    check(again_height == after_height and again_width == after_width,
          'shown four times, the list is still %d px high and %d px wide, got %d and %d' % (after_height, after_width, again_height, again_width))
    page_window.destroy()

    # The never-remember list has two columns: a centred Enabled checkbox, then the WM class. A row saved before the
    # column existed has no "enabled" and is shown checked (the column default); a click on the checkbox writes it.
    handler, widgets, page_window = build_page(True)
    lst = widgets['excluded-apps']
    columns = lst.content_widget.get_columns()
    check([c.get_title() for c in columns] == ['Enabled', 'Never remember these applications (WM class)'],
          'the list columns are Enabled, then the WM class, got %s' % [c.get_title() for c in columns])
    toggles = columns[0].get_cells()
    check(len(toggles) == 1 and isinstance(toggles[0], Gtk.CellRendererToggle) and toggles[0].get_alignment() == (0.5, 0.5)
          and columns[0].get_alignment() == 0.5, 'the Enabled column is a checkbox, centred in its cells and in its header')
    handler.set_value('excluded-apps', [{'wmclass': 'xterm'}, {'enabled': False, 'wmclass': 'xed'}])
    pump()
    check([list(row) for row in lst.model] == [[True, 'xterm'], [False, 'xed']],
          'an old row without "enabled" is shown checked, an unchecked one unchecked, got %s' % [list(row) for row in lst.model])
    toggles[0].emit('toggled', '0')
    pump()
    check(handler.get_value('excluded-apps') == [{'enabled': False, 'wmclass': 'xterm'}, {'enabled': False, 'wmclass': 'xed'}],
          'a click on the checkbox writes enabled false, got %s' % handler.get_value('excluded-apps'))
    page_window.destroy()

    # The "Max windows" spin button. max-entries is no row of its own: the page pass puts it at the right end of the
    # list's toolbar (after the five stock tool buttons, an invisible separator that takes the free width, then a tool
    # item with the label and the spin button), with the range and step of the schema, bound to the key both ways.
    with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
        MAX_ITEM = json.load(f)['max-entries']
    MAX_TOOLTIP = 'Maximum remembered windows. The least recently seen windows are dropped first.'

    def toolbar_of(widgets):
        found = module.PickWindowButton._descendants(widgets['excluded-apps'], Gtk.Toolbar)
        check(len(found) == 1, 'the list row holds one toolbar, found %d' % len(found))
        return found[0]

    def stored_max_entries(handler):
        with open(handler.filepath, encoding='utf-8') as f:
            return json.load(f)['max-entries']['value']

    handler, widgets, page_window = build_page(True)
    toolbar = toolbar_of(widgets)
    lst = widgets['excluded-apps']
    items = [toolbar.get_nth_item(i) for i in range(toolbar.get_n_items())]
    stock = [getattr(lst, name) for name in LIST_BUTTONS]
    check(items[:5] == stock and len(items) == 7, 'the toolbar holds the five stock buttons, then two more items, got %s' % [type(i).__name__ for i in items])
    check(not toolbar.get_show_arrow(), 'the toolbar has no overflow arrow, so the spin button can never be hidden behind it')
    if len(items) == 7:
        gap, tool = items[5], items[6]
        check(isinstance(gap, Gtk.SeparatorToolItem) and not gap.get_draw() and gap.get_expand(),
              'the sixth item is an invisible separator that takes the free width')
        box = tool.get_child()
        check(type(tool) is Gtk.ToolItem and isinstance(box, Gtk.Box) and box.get_tooltip_text() == MAX_TOOLTIP,
              'the seventh item is a tool item whose box has the tooltip, got %r' % (box.get_tooltip_text() if box else None))
        parts = box.get_children() if isinstance(box, Gtk.Box) else []
        check([type(p).__name__ for p in parts] == ['Label', 'SpinButton'] and parts[0].get_text() == 'Max windows',
              'the tool item holds the label "Max windows", then the spin button, got %s' % [type(p).__name__ for p in parts])
        spin = parts[1] if len(parts) == 2 else Gtk.SpinButton()
        check(spin.get_range() == (MAX_ITEM['min'], MAX_ITEM['max']) and spin.get_increments() == (MAX_ITEM['step'], MAX_ITEM['step'])
              and spin.get_digits() == 0, 'the spin button goes from %s to %s in steps of %s, whole numbers, got %s %s %d'
              % (MAX_ITEM['min'], MAX_ITEM['max'], MAX_ITEM['step'], spin.get_range(), spin.get_increments(), spin.get_digits()))
        check(spin.get_value() == MAX_ITEM['default'], 'the spin button shows the value of max-entries, got %s' % spin.get_value())
        check(stored_max_entries(handler) == MAX_ITEM['default'] and type(handler.get_value('max-entries')) is int,
              'building the page writes nothing: max-entries is still %r' % handler.get_value('max-entries'))
        # Right-aligned: the tool item ends at the right end of the toolbar, the separator fills the gap after the buttons.
        def places():
            return (tool.translate_coordinates(toolbar, 0, 0), tool.get_allocated_width(), gap.translate_coordinates(toolbar, 0, 0),
                    gap.get_allocated_width(), stock[-1].translate_coordinates(toolbar, 0, 0), stock[-1].get_allocated_width(), toolbar.get_allocated_width())
        (tool_x, _y), tool_w, (gap_x, _y2), gap_w, (last_x, _y3), last_w, bar_w = settled(places, 'the toolbar')
        print('toolbar: %d px wide; last stock button ends at %d, separator %d..%d, Max windows %d..%d'
              % (bar_w, last_x + last_w, gap_x, gap_x + gap_w, tool_x, tool_x + tool_w))
        check(gap_w > 100 and gap_x >= last_x + last_w and tool_x >= gap_x + gap_w, 'the separator fills the free width between the buttons and the spin button')
        check(0 <= bar_w - (tool_x + tool_w) <= 8, 'the spin button is at the right end of the toolbar (%d px from it)' % (bar_w - (tool_x + tool_w)))
        # Both ways: a new value of the key is shown, a value set in the spin button is stored as a whole number.
        handler.set_value('max-entries', 1200)
        pump()
        check(spin.get_value() == 1200, 'max-entries set to 1200: the spin button follows, got %s' % spin.get_value())
        spin.set_value(2000)
        pump()
        check(handler.get_value('max-entries') == 2000 and type(handler.get_value('max-entries')) is int and stored_max_entries(handler) == 2000,
              'the spin button set to 2000: max-entries is the whole number 2000, in the file too, got %r' % handler.get_value('max-entries'))
        spin.spin(Gtk.SpinType.STEP_FORWARD, 0)  # 0: the spin button's own step
        pump()
        check(handler.get_value('max-entries') == 2010, 'one step up: 2010, got %r' % handler.get_value('max-entries'))
        for wanted, given in ((MAX_ITEM['max'], 99999), (MAX_ITEM['min'], 1)):
            spin.set_value(given)
            pump()
            check(handler.get_value('max-entries') == wanted, 'the spin button set to %d stores %d, got %r' % (given, wanted, handler.get_value('max-entries')))
        # Greyed out with the list while the extension is off (check_page also looks at every spin button of a row).
        flip(widgets, False)
        check(not spin.is_sensitive() and not tool.is_sensitive(), 'disabled: the spin button is greyed out')
        flip(widgets, True)
        check(spin.is_sensitive(), 'enabled again: the spin button can be used')
    page_window.destroy()

    # Once: showing the page again does not add a second spin button.
    handler, widgets, page_window = build_page(True)
    for _ in range(3):
        page_window.hide()
        pump()
        page_window.show_all()
        pump()
    toolbar = toolbar_of(widgets)
    check(toolbar.get_n_items() == 7 and len(module.PickWindowButton._descendants(toolbar, Gtk.SpinButton)) == 1,
          'shown four times, the toolbar still has one spin button and %d items' % toolbar.get_n_items())
    page_window.destroy()

    # The list with a selected row: its five buttons follow, and the selection-based state comes back.
    handler, widgets, page_window = build_page(True)
    populate_list(widgets)
    check_page('list with a selection, enabled', widgets, True, populated=True)
    flip(widgets, False)
    check_page('list with a selection, disabled', widgets, False, populated=True)
    flip(widgets, True)
    check_page('list with a selection, enabled again', widgets, True, populated=True)

    # A change of the settings file on disk (check_settings is what the file monitor runs) is followed too.
    with open(handler.filepath, encoding='utf-8') as f:
        raw = json.load(f)
    raw[ENABLED]['value'] = False
    with open(handler.filepath, 'w', encoding='utf-8') as f:
        json.dump(raw, f)
    handler.check_settings()
    pump()
    check(not widgets[ENABLED].content_widget.get_active(), 'the settings file changed on disk: the switch follows')
    check_page('after the settings file changed on disk', widgets, False, populated=True)

    # A click on the row of a greyed switch does nothing; when enabled again it does.
    before = handler.get_value('remember-size')
    widgets['remember-size'].clicked()
    pump()
    check(handler.get_value('remember-size') == before, 'a click on a greyed switch row changes nothing')
    flip(widgets, True)
    widgets['remember-size'].clicked()
    pump()
    check(handler.get_value('remember-size') != before, 'a click on the switch row works again when enabled')
    page_window.destroy()

    # Without the "enabled" switch on the page nothing can be told apart from it, so nothing is
    # greyed out (the switch could never be turned back on otherwise): a warning, the rows stay usable.
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        handler, widgets, page_window = build_page(False, keys=('remember-size', 'pick-window', 'include-dialogs'))
    check(widgets['remember-size'].is_sensitive() and widgets['include-dialogs'].is_sensitive(),
          'with no "enabled" switch on the page the other rows are left alone')
    check('switch is not on the page' in captured.getvalue(), 'a warning says why, got %r' % captured.getvalue())
    page_window.destroy()

    # The two steps of the page pass do not depend on each other. Without the switch the list is
    # still made shorter; without the list the rows are still greyed out, and a warning names the list.
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        handler, widgets, page_window = build_page(False, keys=('pick-window', 'excluded-apps'))
    shortened = settled_height(list_window(widgets))
    check(abs(shortened - before_height * TWO_THIRDS) < 1,
          'with no "enabled" switch on the page the list is still two thirds as high, got %d px' % shortened)
    check('switch is not on the page' in captured.getvalue() and 'shorten' not in captured.getvalue(),
          'only the grey-out warns, got %r' % captured.getvalue())
    page_window.destroy()
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        handler, widgets, page_window = build_page(False, keys=('enabled', 'remember-size', 'pick-window'))
    check(not widgets['remember-size'].is_sensitive(), 'with no list on the page the other rows are still greyed out')
    check('could not shorten the excluded-apps list' in captured.getvalue() and 'could not grey out' not in captured.getvalue(),
          'only the list step warns, got %r' % captured.getvalue())
    page_window.destroy()

    # The list step leaves the list as it is, with a warning, when the height request of its
    # scrolled window cannot be read or is not above zero, and when the list row holds two scrolled
    # windows. Each page is built with the page pass off and changed; then the pass runs as the
    # first map runs it. GTK turns a size request of 0 into 1 (gtk_widget_set_size_request), so a
    # height request of 0, like one that cannot be read, is given by a stand-in for get_size_request.
    def run_page_pass(widgets):
        """Runs the page pass of the page's pick button; returns what it logged."""
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            widgets['pick-window']._on_map()
            pump()
        return captured.getvalue()

    def unreadable_size_request():
        raise RuntimeError('the size request cannot be read')

    for label, change, why in (
            ('a height request that cannot be read',
             lambda scrolled: setattr(scrolled, 'get_size_request', unreadable_size_request), 'the size request cannot be read'),
            ('a height request of 0', lambda scrolled: setattr(scrolled, 'get_size_request', lambda: (-1, 0)),
             'no height request to take a share of (0)'),
            ('no height request', lambda scrolled: scrolled.set_size_request(-1, -1), 'no height request to take a share of (-1)')):
        with switched_off('_on_map'):
            handler, widgets, page_window = build_page(True)
        scrolled = list_window(widgets)
        change(scrolled)
        request, height = Gtk.Widget.get_size_request(scrolled), settled_height(scrolled)
        logged = run_page_pass(widgets)
        after = settled_height(scrolled)
        check(Gtk.Widget.get_size_request(scrolled) == request and after == height,
              '%s: the list keeps its height (request %s, %d px), got %s, %d px'
              % (label, request, height, Gtk.Widget.get_size_request(scrolled), after))
        check('could not shorten the excluded-apps list' in logged and why in logged and 'could not grey out' not in logged,
              '%s: only the list step warns, and says why, got %r' % (label, logged))
        page_window.destroy()
    with switched_off('_on_map'):
        handler, widgets, page_window = build_page(True)
    scrolled = list_window(widgets)
    second = Gtk.ScrolledWindow()
    widgets['excluded-apps'].pack_start(second, False, False, 0)
    second.show()
    request, height = scrolled.get_size_request(), settled_height(scrolled)
    logged = run_page_pass(widgets)
    after = settled_height(scrolled)
    check(scrolled.get_size_request() == request and after == height and second.get_size_request() == (-1, -1),
          'two scrolled windows in the list row: neither height is changed, got %s, %d px (before %s, %d px)'
          % (scrolled.get_size_request(), after, request, height))
    check('could not shorten the excluded-apps list' in logged and 'holds 2 scrolled windows, not one' in logged and 'could not grey out' not in logged,
          'two scrolled windows in the list row: only the list step warns, and says why, got %r' % logged)
    page_window.destroy()

    # The Max windows step fails alone, adds nothing and says why: with no toolbar in the list row, and with a bind()
    # that raises (a handler without the key max-entries). The list is still shortened and the rows still greyed out;
    # the extension keeps reading max-entries from the settings file.
    with switched_off('_on_map'):
        handler, widgets, page_window = build_page(True)
    toolbar = toolbar_of(widgets)
    widgets['excluded-apps'].remove(toolbar)
    height = settled_height(list_window(widgets))
    logged = run_page_pass(widgets)
    check('could not add the Max windows spin button' in logged and 'holds 0 toolbars, not one' in logged
          and 'could not shorten' not in logged and 'could not grey out' not in logged,
          'no toolbar: only the Max windows step warns, and says why, got %r' % logged)
    check(not module.PickWindowButton._descendants(widgets['excluded-apps'], Gtk.SpinButton), 'no toolbar: no spin button anywhere in the list row')
    check(settled_height(list_window(widgets)) < height, 'no toolbar: the list is still shortened')
    flip(widgets, False)
    check(not widgets['remember-size'].is_sensitive(), 'no toolbar: the rows are still greyed out')
    page_window.destroy()

    with switched_off('_on_map'):
        handler, widgets, page_window = build_page(True)
    real_bind = handler.bind

    def bind_without_max_entries(key, *args, **kwargs):
        if key == 'max-entries':
            raise KeyError(key)
        return real_bind(key, *args, **kwargs)

    handler.bind = bind_without_max_entries
    logged = run_page_pass(widgets)
    toolbar = toolbar_of(widgets)
    check('could not add the Max windows spin button' in logged and 'could not grey out' not in logged and 'could not shorten' not in logged,
          'a bind() that raises: only the Max windows step warns, got %r' % logged)
    check(toolbar.get_n_items() == 5, 'a bind() that raises: the toolbar keeps its five stock buttons only, got %d items' % toolbar.get_n_items())
    page_window.destroy()

    # Every installed theme: the list header (which the themes draw the same disabled) is dimmed
    # at most to 70% of its contrast, and enabling again gives back exactly the same page.
    for theme in themes:
        settings.set_property('gtk-theme-name', theme)
        theme_baseline = pixels_without_the_walk()
        handler, widgets, page_window = build_page(True)
        on = [header_contrast(widgets, page_window, column) for column in (0, 1)]
        check(snapshot(page_window).get_pixels() == theme_baseline, '%s: enabled looks exactly as it does without the walk' % theme)
        flip(widgets, False)
        off = [header_contrast(widgets, page_window, column) for column in (0, 1)]
        for column, (a, b) in enumerate(zip(on, off)):
            check(a > 0 and b <= 0.7 * a, '%s: the header of list column %d is dimmed when disabled (contrast %d -> %d, at most 70%% wanted)' % (theme, column, a, b))
        flip(widgets, True)
        check(snapshot(page_window).get_pixels() == theme_baseline, '%s: enabled again looks exactly as it does without the walk' % theme)
        page_window.destroy()
    settings.set_property('gtk-theme-name', real_theme)
    settings.set_property('gtk-enable-animations', real_animations)
    shutil.rmtree(work, ignore_errors=True)

print('FAILED %d' % len(failures) if failures else 'OK')
sys.exit(1 if failures else 0)
