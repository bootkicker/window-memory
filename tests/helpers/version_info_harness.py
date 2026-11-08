# SPDX-License-Identifier: GPL-3.0-or-later
# Test-only: builds VersionInfo the way cinnamon-settings does and checks it.
# Run by tests/version-info.test.js, which skips the test when there is no display.
# Usage: python3 -B version_info_harness.py <extension dir>
#   With "french" as a second argument it is the child process of the French check (section 10).
# Exit codes: 0 all checks passed, 1 a check failed, 77 cannot run here (no display or no GTK).
#
# The widget reads metadata.json and version.json from the folder that holds version_info.py.
# So each case below copies version_info.py into a temp folder with the files of that case and
# loads it from there, the way cinnamon-settings loads it (xlet-settings.py:481-483); nothing
# in the extension folder is touched.
#
# No browser is ever started. The link button's default handler opens the URI
# (gtk_show_uri_on_window); the click check connects a handler that returns True first, which
# stops the signal before the default handler (Gtk-3.0.gir, signal activate-link of LinkButton).
# The temp folders are removed at the end; GSettings uses the in-memory backend.
import atexit
import collections
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

SKIP = 77

FRENCH_CHILD = sys.argv[2:] == ['french']

os.environ['GSETTINGS_BACKEND'] = 'memory'

# The checks compare the English texts. LANGUAGE=C keeps the language of the session, and a
# translation installed for it, out of them: Python's gettext reads LANGUAGE first. The French
# child keeps the LANGUAGE it is given.
if not FRENCH_CHILD:
    os.environ['LANGUAGE'] = 'C'

# The row shows a note on a Wayland session, read from XDG_SESSION_TYPE when the row is built. The checks below that
# are about the row as it is on X11 must not depend on the session this harness runs in (it also runs in a Wayland
# session), so the session is X11 until a check says otherwise. WAYLAND_DISPLAY is left alone: GTK needs it.
os.environ['XDG_SESSION_TYPE'] = 'x11'

try:
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import GObject, Gtk
    from xapp.SettingsWidgets import SettingsPage, SettingsWidget, Switch
    if not Gtk.init_check()[0]:
        raise RuntimeError('Gtk.init_check() failed: no display')
except Exception as e:  # ImportError, ValueError (missing typelib), RuntimeError
    print('cannot run: %s' % e)
    sys.exit(SKIP)

ext_dir = sys.argv[1]
failures = []
checked = [0]
work = tempfile.mkdtemp(prefix='window-memory-version-harness-')
atexit.register(shutil.rmtree, work, True)  # also when a check raises

COMMIT_URL = 'https://github.com/bootkicker/window-memory/commit/'
# The "Report an issue" link at the end of the row: the new-issue page with the bug report
# template. ISSUE_TAIL is what the row reads from the separator on.
ISSUE_URL = 'https://github.com/bootkicker/window-memory/issues/new?template=bug_report.md'
ISSUE_LABEL = 'Report an issue'
ISSUE_TAIL = ' | ' + ISSUE_LABEL
# The note after the "Version" label on a Wayland session: a short label, and the explanation as its tooltip.
WAYLAND_NOTE = 'Wayland (experimental)'
WAYLAND_TIP = ("You are using Cinnamon's Wayland session, which is still experimental. Window Memory has been tested with it "
               "on Cinnamon 6.0.5. If a window is not remembered as expected, please use Report an issue.")
FULL = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
SHORT = '1a2b3c4'


def check(ok, message):
    checked[0] += 1
    if not ok:
        failures.append(message)
        print('FAIL: ' + message)


def load_module(path):
    # The same three calls as xlet-settings.py:481-483.
    spec = importlib.util.spec_from_file_location('windowmemorybootkicker.' + os.path.basename(path).split('.')[0], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pump():
    for _ in range(20):
        while Gtk.events_pending():
            Gtk.main_iteration()


class FakeHandler(object):
    """The part of cinnamon-settings' JSONSettingsHandler that the pick button uses.

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


with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
    schema = json.load(f, object_pairs_hook=collections.OrderedDict)
item = schema['version-info']
pick_item = schema['pick-window']

cases = [0]


def make_folder(metadata='default', version=None):
    """A folder with a copy of version_info.py and the given files.

    metadata/version: a dict (written as JSON), a str or bytes (written as is), or None (no file).
    """
    cases[0] += 1
    folder = os.path.join(work, 'case%d' % cases[0])
    os.mkdir(folder)
    shutil.copy(os.path.join(ext_dir, 'version_info.py'), folder)
    if metadata == 'default':
        metadata = {'uuid': 'window-memory@bootkicker', 'version': '0.1.0'}
    for name, content in (('metadata.json', metadata), ('version.json', version)):
        if content is None:
            continue
        if isinstance(content, bytes):
            with open(os.path.join(folder, name), 'wb') as f:
                f.write(content)
        else:
            with open(os.path.join(folder, name), 'w', encoding='utf-8') as f:
                f.write(content if isinstance(content, str) else json.dumps(content))
    return folder


def build(folder, handler=None):
    """The widget as cinnamon-settings makes it, plus whatever it printed to stderr."""
    module = load_module(os.path.join(folder, 'version_info.py'))
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        widget = module.VersionInfo(item, 'version-info', handler or FakeHandler())
    return widget, captured.getvalue()


def pieces(widget):
    return widget.content_widget.get_children()


def link_buttons(widget):
    return [c for c in pieces(widget) if isinstance(c, Gtk.LinkButton)]


def links(widget):
    """The commit links: the link buttons that go to a commit of the repository."""
    return [c for c in link_buttons(widget) if c.get_uri().startswith(COMMIT_URL)]


def issue_links(widget):
    """The other link buttons: besides the commit link, the row has only "Report an issue"."""
    return [c for c in link_buttons(widget) if not c.get_uri().startswith(COMMIT_URL)]


def rendered(widget):
    """The text of the right-hand side as a reader sees it, the link's label included."""
    out = []
    for child in pieces(widget):
        if isinstance(child, Gtk.LinkButton):
            out.append(child.get_label())
        elif isinstance(child, Gtk.Label):
            out.append(child.get_text())
        else:
            out.append('<%s>' % type(child).__name__)
    return ''.join(out)


# The French check (section 10): the texts of the row, and their French translations, which the
# check compiles into a .mo of its own.
UUID = 'window-memory@bootkicker'
FRENCH = {
    'unknown': 'inconnue',
    '(uncommitted changes)': '(modifications non validées)',
    'Report an issue': 'Signaler un problème',
    'Wayland (experimental)': 'Wayland (expérimental)',
    WAYLAND_TIP: ("Vous utilisez la session Wayland de Cinnamon, qui est encore expérimentale. Window Memory y a été testé "
                  "avec Cinnamon 6.0.5. Si une fenêtre n'est pas mémorisée comme prévu, utilisez « Signaler un problème »."),
}
FRENCH_HEADER = ('msgid ""\nmsgstr ""\n"Project-Id-Version: window-memory@bootkicker\\n"\n"Language: fr\\n"\n'
                 '"MIME-Version: 1.0\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n'
                 '"Content-Transfer-Encoding: 8bit\\n"\n"Plural-Forms: nplurals=2; plural=(n > 1);\\n"\n')


def po_quote(text):
    return '"%s"' % text.replace('\\', '\\\\').replace('"', '\\"')


def compile_french(home, translations):
    """Compiles translations ({msgid: msgstr}) into <home>/.local/share/locale/fr/LC_MESSAGES/<uuid>.mo
    with msgfmt -c, as the Spices installer compiles po/fr.po (cinnamon-settings bin/Spices.py:733-737).
    Returns None, or why it could not."""
    entries = ['msgid %s\nmsgstr %s\n' % (po_quote(msgid), po_quote(msgstr)) for msgid, msgstr in translations.items()]
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
    """The child process of the French check (section 10), started with LANGUAGE=fr and a home folder
    with the French .mo. Prints, as JSON, the right-hand side of a row with an unknown version and uncommitted
    changes, and the note and its tooltip as a Wayland session shows them."""
    os.environ['XDG_SESSION_TYPE'] = 'wayland'
    widget, _ = build(make_folder(metadata={'uuid': UUID}, version={'commit': FULL, 'short': SHORT, 'dirty': True}))
    print(json.dumps({'row': rendered(widget), 'note': widget.wayland_note.get_text(), 'tip': widget.wayland_note.get_tooltip_text()}))
    sys.exit(0)


if FRENCH_CHILD:
    french_child()


# 1. What cinnamon-settings needs: a SettingsWidget built from (item, key, settings), whose
# "Version" label is on the left, and whose installed-copy files sit next to the module.
folder = make_folder(version={'commit': FULL, 'short': SHORT, 'dirty': False})
widget, err = build(folder)
check(isinstance(widget, SettingsWidget), 'the widget is a SettingsWidget')
check(isinstance(widget.content_widget, Gtk.Widget), 'content_widget is a widget')
check(widget.key == 'version-info', 'the widget keeps its key')
check(widget.label.get_text() == item['description'] == 'Version', 'the label on the left is the schema description, "Version"')
check(widget.get_children()[0] is widget.label and widget.get_children()[-1] is widget.content_widget,
      'the label is first (left) and the content is last (right) in the row')
check(err == '', 'a complete install prints nothing to stderr, got %r' % err)

# 2. Version and commit: "0.1.0 [1a2b3c4]", the hash being a link to the full commit.
check(rendered(widget) == '0.1.0 [%s]%s' % (SHORT, ISSUE_TAIL), 'the right-hand side reads "0.1.0 [%s]%s", got %r' % (SHORT, ISSUE_TAIL, rendered(widget)))
found = links(widget)
check(len(found) == 1, 'exactly one commit link button, got %d' % len(found))
if found:
    link = found[0]
    check(link.get_label() == SHORT, 'the link label is the short hash, got %r' % link.get_label())
    check(link.get_uri() == COMMIT_URL + FULL, 'the link uri is the commit url with the full hash, got %r' % link.get_uri())
    check(link.get_uri().startswith('https://github.com/bootkicker/window-memory/commit/'), 'the link goes to the GitHub repo')
    # The default handler of activate-link opens the uri (Gtk-3.0.gir): nothing may override it.
    signal_id = GObject.signal_lookup('activate-link', Gtk.LinkButton)
    check(not GObject.signal_has_handler_pending(link, signal_id, 0, False),
          'the widget connects no activate-link handler, so GTK opens the uri in the default browser')
    # A click reaches activate-link on this very button. The handler returns True, so the
    # default handler (the browser) does not run in this test.
    clicked = []

    def on_activate_link(button):
        clicked.append(button.get_uri())
        return True

    link.connect('activate-link', on_activate_link)
    link.clicked()
    check(clicked == [COMMIT_URL + FULL], 'a click on the link emits activate-link for the commit url, got %s' % clicked)
check('uncommitted' not in rendered(widget), 'a clean tree shows no "uncommitted changes"')

# 2b. "Report an issue": a second link button, the last piece of the row, after the commit link.
# It goes to the new-issue page of the repository with the bug report template.
issues = issue_links(widget)
check(len(issues) == 1, 'exactly one other link button, "%s", got %d' % (ISSUE_LABEL, len(issues)))
if issues:
    issue = issues[0]
    check(issue.get_label() == ISSUE_LABEL, 'the issue link label is "%s", got %r' % (ISSUE_LABEL, issue.get_label()))
    check(issue.get_uri() == ISSUE_URL, 'the issue link uri is the new-issue url with the bug report template, got %r' % issue.get_uri())
    check(found and pieces(widget).index(found[0]) < pieces(widget).index(issue), 'the issue link comes after the commit link')
    check(pieces(widget)[-1] is issue, 'the issue link is the last piece of the row')

# 3. dirty: "(uncommitted changes)" after the hash.
dirty, err = build(make_folder(version={'commit': FULL, 'short': SHORT, 'dirty': True}))
check(rendered(dirty) == '0.1.0 [%s] (uncommitted changes)%s' % (SHORT, ISSUE_TAIL),
      'dirty: reads "0.1.0 [%s] (uncommitted changes)%s", got %r' % (SHORT, ISSUE_TAIL, rendered(dirty)))
check(len(links(dirty)) == 1 and links(dirty)[0].get_uri() == COMMIT_URL + FULL, 'dirty: the link is still the full commit url')
uncommitted = [c for c in pieces(dirty) if isinstance(c, Gtk.Label) and c.get_text().strip() == '(uncommitted changes)']
check(len(uncommitted) == 1 and len(issue_links(dirty)) == 1
      and pieces(dirty).index(links(dirty)[0]) < pieces(dirty).index(uncommitted[0]) < pieces(dirty).index(issue_links(dirty)[0]),
      'dirty: the "(uncommitted changes)" label comes after the commit link and before the issue link')
for not_true in ('true', 'yes', 1, None):
    odd, _ = build(make_folder(version={'commit': FULL, 'short': SHORT, 'dirty': not_true}))
    check('uncommitted' not in rendered(odd), 'dirty=%r is not the boolean true: no "uncommitted changes"' % (not_true,))
missing_dirty, _ = build(make_folder(version={'commit': FULL, 'short': SHORT}))
check('uncommitted' not in rendered(missing_dirty), 'no dirty key: no "uncommitted changes"')

# 4. No version.json (the repo never has one): the version and "Report an issue", no commit link,
# and no warning (this is the normal state of a copy that was not made by dev-reinstall.sh or
# package.sh).
bare, err = build(make_folder(version=None))
check(rendered(bare) == '0.1.0' + ISSUE_TAIL, 'no version.json: the version and "%s", got %r' % (ISSUE_LABEL, rendered(bare)))
check(not links(bare), 'no version.json: no commit link button')
bare_issues = issue_links(bare)
check(len(bare_issues) == 1 and bare_issues[0].get_label() == ISSUE_LABEL and bare_issues[0].get_uri() == ISSUE_URL,
      'no version.json: the "%s" link button is still there, with its url' % ISSUE_LABEL)
check(err == '', 'no version.json: nothing printed to stderr, got %r' % err)

# 5. A version.json that is not usable never stops the page and never makes a commit link; the
# "Report an issue" link is still there.
bad_commits = [
    ('commit of the wrong type', {'commit': 12345, 'short': '1234567'}),
    ('commit that is not hex', {'commit': 'z' * 40, 'short': 'zzzzzzz'}),
    ('commit that is too short', {'commit': FULL[:39], 'short': SHORT}),
    ('commit with a trailing newline', {'commit': FULL + '\n', 'short': SHORT}),
    ('commit with something appended to the url', {'commit': FULL + '"><evil', 'short': SHORT}),
    ('commit in capitals', {'commit': FULL.upper(), 'short': SHORT.upper()}),
    ('no commit', {'short': SHORT, 'dirty': False}),
    ('a JSON list', ['a', 'b']),
    ('JSON null', None),
]
for label, content in bad_commits:
    odd, err = build(make_folder(version=json.dumps(content)))
    check(rendered(odd) == '0.1.0' + ISSUE_TAIL and not links(odd) and len(issue_links(odd)) == 1,
          '%s: the version and the issue link, no commit link; got %r' % (label, rendered(odd)))
    check('version.json' in err, '%s: a warning names version.json, got %r' % (label, err))
unreadable, err = build(make_folder(version='{not json'))
check(rendered(unreadable) == '0.1.0' + ISSUE_TAIL and not links(unreadable) and len(issue_links(unreadable)) == 1,
      'malformed version.json: the version and the issue link, no commit link')
check('version.json' in err, 'malformed version.json: a warning names the file, got %r' % err)
binary, err = build(make_folder(version=b'\xff\xfe\x00 not utf-8'))
check(rendered(binary) == '0.1.0' + ISSUE_TAIL and not links(binary) and len(issue_links(binary)) == 1,
      'bytes that are not UTF-8 in version.json: the version and the issue link, no commit link')
check('version.json' in err, 'bytes that are not UTF-8 in version.json: a warning names the file, got %r' % err)

# A "short" that does not belong to the commit is not trusted: the label is the first 7 chars.
liar, _ = build(make_folder(version={'commit': FULL, 'short': 'fffffff', 'dirty': False}))
check(links(liar) and links(liar)[0].get_label() == SHORT, 'a short that is not a prefix of the commit: the link label is the first 7 characters')
no_short, _ = build(make_folder(version={'commit': FULL}))
check(links(no_short) and links(no_short)[0].get_label() == SHORT and links(no_short)[0].get_uri() == COMMIT_URL + FULL,
      'no short in version.json: the link label is the first 7 characters of the commit')
long_short, _ = build(make_folder(version={'commit': FULL, 'short': FULL[:12]}))
check(links(long_short) and links(long_short)[0].get_label() == FULL[:12], 'a longer short that is a prefix of the commit is kept')

# 5b. Styling the link is cosmetic: if it fails, the link is still there and a warning is logged.
styled_module = load_module(os.path.join(make_folder(version={'commit': FULL, 'short': SHORT}), 'version_info.py'))


def broken_style(*args):
    raise RuntimeError('broken on purpose')


styled_module.VersionInfo._remove_padding = staticmethod(broken_style)
captured = io.StringIO()
try:
    with contextlib.redirect_stderr(captured):
        unstyled_widget = styled_module.VersionInfo(item, 'version-info', FakeHandler())
    check(rendered(unstyled_widget) == '0.1.0 [%s]%s' % (SHORT, ISSUE_TAIL)
          and len(links(unstyled_widget)) == 1 and len(issue_links(unstyled_widget)) == 1,
          'with a failing link style the row still shows both links')
    check('could not style the commit link' in captured.getvalue(), 'a failing link style is logged, got %r' % captured.getvalue())
    check('could not style the issue link' in captured.getvalue(), 'a failing issue link style is logged, got %r' % captured.getvalue())
except Exception as e:
    check(False, '__init__ raised when styling the link failed: %r' % e)

# 6. metadata.json problems: the version reads "unknown", and the commit part still works.
for label, metadata in (('missing', None), ('malformed', '{oops'), ('a list', '[1]'),
                        ('without a version', {'uuid': 'x'}), ('with a version of the wrong type', {'version': 3}),
                        ('with an empty version', {'version': ' '})):
    odd, err = build(make_folder(metadata=metadata, version={'commit': FULL, 'short': SHORT}))
    check(rendered(odd) == 'unknown [%s]%s' % (SHORT, ISSUE_TAIL), 'metadata.json %s: reads "unknown [%s]%s", got %r' % (label, SHORT, ISSUE_TAIL, rendered(odd)))
    check(len(links(odd)) == 1, 'metadata.json %s: the link is still there' % label)
    check('metadata.json' in err, 'metadata.json %s: a warning names the file, got %r' % (label, err))

# 7. The real extension folder: the version shown is the one in its metadata.json.
real_module = load_module(os.path.join(ext_dir, 'version_info.py'))
with open(os.path.join(ext_dir, 'metadata.json'), encoding='utf-8') as f:
    real_version = json.load(f)['version']
check(real_module.FOLDER == os.path.dirname(os.path.abspath(os.path.join(ext_dir, 'version_info.py'))),
      'the module looks in the folder that holds it, got %s' % real_module.FOLDER)
real = real_module.VersionInfo(item, 'version-info', FakeHandler())
check(rendered(real).startswith(real_version), 'the real folder: the right-hand side starts with the metadata version %s, got %r' % (real_version, rendered(real)))

# 8. The row is drawn. (How it looks in a theme is checked by hand.)
window = Gtk.OffscreenWindow()
window.set_default_size(560, 60)
window.add(widget)
window.show_all()
pump()
check(widget.get_visible() and widget.content_widget.get_visible() and all(c.get_visible() for c in pieces(widget)),
      'the row and every piece of it are visible')
a = widget.content_widget.get_allocation()
check(a.width > 0 and a.height > 0, 'the right-hand side has a size')
# The link reads as part of the line of text: it has no button padding, so it is narrower than
# a plain link button with the same label (which keeps the theme's padding).
plain = Gtk.LinkButton.new_with_label(COMMIT_URL + FULL, SHORT)
plain_window = Gtk.OffscreenWindow()
plain_window.add(plain)
plain_window.show_all()
pump()
# The preferred (natural) sizes are compared, not the allocations: an allocation also depends on how the container stretches
# the widget, which differs between the X11 and the Wayland backend (the link was allocated 57x70 on Wayland).
styled = links(widget)[0].get_preferred_size()[1]
unstyled = plain.get_preferred_size()[1]
check(styled.width < unstyled.width and styled.height < unstyled.height,
      'the commit link has no button padding (link %dx%d, a plain link button %dx%d)' % (styled.width, styled.height, unstyled.width, unstyled.height))
plain_window.remove(plain)
plain_window.destroy()
window.remove(widget)
window.destroy()

# 9. The grey-out walk of pick_button.py must leave the version row alone. A small page: the version
# row, the "enabled" switch, another row, the pick button. (In the real schema the version row is the
# last row. The walk collects every row of the page first and skips an always_sensitive row wherever
# it sits, so the order on this page does not matter to it.)
# pick_button.py greys out the others once the page is shown, by binding them to "enabled".
pick_module = load_module(os.path.join(ext_dir, 'pick_button.py'))
version_module = load_module(os.path.join(make_folder(version={'commit': FULL, 'short': SHORT, 'dirty': True}), 'version_info.py'))


def build_page(enabled):
    handler = FakeHandler(enabled=enabled)
    page = SettingsPage()
    section = page.add_section('Settings for window-memory@bootkicker')
    rows = collections.OrderedDict()
    rows['version-info'] = version_module.VersionInfo(item, 'version-info', handler)
    rows['enabled'] = Switch('Enable Window Memory')
    rows['enabled'].key = 'enabled'
    rows['other'] = Switch('Remember window size')
    rows['other'].key = 'other'
    rows['pick-window'] = pick_module.PickWindowButton(pick_item, 'pick-window', handler)
    for row in rows.values():
        section.add_row(row)
    page_window = Gtk.OffscreenWindow()
    page_window.set_default_size(760, 400)
    page_window.add(page)
    page_window.show_all()
    pump()
    return handler, rows, page_window


def check_page(label, rows, enabled):
    word = 'sensitive' if enabled else 'greyed out'
    version_row = rows['version-info']
    check(version_row.is_sensitive(), '%s: the version row is sensitive' % label)
    check(all(c.is_sensitive() for c in pieces(version_row)), '%s: every piece of the version row is sensitive' % label)
    check(links(version_row) and links(version_row)[0].is_sensitive(), '%s: the commit link can be clicked' % label)
    check(issue_links(version_row) and issue_links(version_row)[0].is_sensitive(), '%s: the issue link can be clicked' % label)
    check(rows['enabled'].is_sensitive(), '%s: the "enabled" switch is sensitive' % label)
    for key in ('other', 'pick-window'):
        check(rows[key].is_sensitive() == enabled, '%s: row "%s" is %s (the walk is working)' % (label, key, word))


for start in (True, False):
    handler, rows, page_window = build_page(start)
    check_page('page built with enabled=%s' % start, rows, start)
    for value in (not start, start, not start, start):
        handler.set_value('enabled', value)
        pump()
        check_page('enabled flipped to %s' % value, rows, value)
    check(not any(call[1] is rows['version-info'] for call in handler.bind_calls),
          'nothing binds the version row to a setting (enabled=%s)' % start)
    page_window.destroy()

# 9a. The second instance of the row: the footer of the "Startup apps" tab is its own key, version-info-login, with the
# same schema item. Two instances next to each other (as the two tabs hold them) are two independent rows with the same text,
# each with its own key, and both stay sensitive while the walk of pick_button.py greys out its page.
login_item = schema['version-info-login']
check(login_item == item, 'the schema item of version-info-login is the one of version-info: %r' % (login_item,))
handler, rows, page_window = build_page(False)
second = version_module.VersionInfo(login_item, 'version-info-login', handler)
rows['version-info-login'] = second
check(second.key == 'version-info-login' and rows['version-info'].key == 'version-info', 'each instance keeps its own key')
check(second is not rows['version-info'] and links(second)[0] is not links(rows['version-info'])[0], 'the instances share no widget')
check(second.is_sensitive() and all(c.is_sensitive() for c in pieces(second)), 'the second instance is sensitive even on a page that is greyed out')
check(second.label.get_text() == 'Version', 'the second instance has the label "Version": %r' % second.label.get_text())
check([w.get_label() for w in links(second)] == [w.get_label() for w in links(rows['version-info'])] and links(second),
      'both show the same commit link text')
check(not any(call[1] is second for call in handler.bind_calls), 'nothing binds the second instance to a setting')
page_window.destroy()

# 9b. The note after "Version" on a Wayland session. The row stays one row: the label first, then (on Wayland only)
# a short dimmed note whose tooltip explains it, then the content on the right as before. An X11 session gets exactly
# the row it always had. The session is read from XDG_SESSION_TYPE when the row is built; without it, from WAYLAND_DISPLAY.
session_module = load_module(os.path.join(ext_dir, 'version_info.py'))
for label, env, want in (
        ('wayland', {'XDG_SESSION_TYPE': 'wayland'}, True),
        ('Wayland in capitals', {'XDG_SESSION_TYPE': 'Wayland'}, True),
        ('x11', {'XDG_SESSION_TYPE': 'x11'}, False),
        ('x11 with a WAYLAND_DISPLAY left over', {'XDG_SESSION_TYPE': 'x11', 'WAYLAND_DISPLAY': 'wayland-0'}, False),
        ('tty', {'XDG_SESSION_TYPE': 'tty'}, False),
        ('no type, WAYLAND_DISPLAY set', {'WAYLAND_DISPLAY': 'wayland-0'}, True),
        ('no type, WAYLAND_DISPLAY empty', {'WAYLAND_DISPLAY': ''}, False),
        ('nothing set', {}, False)):
    check(session_module.is_wayland_session(env) is want, 'is_wayland_session: %s gives %s' % (label, want))

x11_row, err = build(make_folder(version={'commit': FULL, 'short': SHORT, 'dirty': False}))
check(x11_row.get_children() == [x11_row.label, x11_row.content_widget], 'X11: the row is the label and the content, nothing else')
check(getattr(x11_row, 'wayland_note', None) is None, 'X11: there is no Wayland note')
check(err == '', 'X11: nothing printed to stderr, got %r' % err)

os.environ['XDG_SESSION_TYPE'] = 'wayland'
try:
    wl_row, err = build(make_folder(version={'commit': FULL, 'short': SHORT, 'dirty': False}))
    wl_bare, bare_err = build(make_folder(version=None))
    wl_page_handler, wl_rows, wl_page_window = build_page(False)
finally:
    os.environ['XDG_SESSION_TYPE'] = 'x11'
note = getattr(wl_row, 'wayland_note', None)
check(isinstance(note, Gtk.Label), 'Wayland: the row has a note label')
if isinstance(note, Gtk.Label):
    check(note.get_text() == WAYLAND_NOTE, 'Wayland: the note reads "%s", got %r' % (WAYLAND_NOTE, note.get_text()))
    check(note.get_tooltip_text() == WAYLAND_TIP, 'Wayland: the tooltip of the note explains it, got %r' % note.get_tooltip_text())
    check(wl_row.get_children() == [wl_row.label, note, wl_row.content_widget],
          'Wayland: the note sits between the "Version" label and the content on the right')
    check(note.get_style_context().has_class('dim-label'), 'Wayland: the note is dimmed')
check(wl_row.label.get_text() == 'Version', 'Wayland: the label is still "Version"')
check(rendered(wl_row) == '0.1.0 [%s]%s' % (SHORT, ISSUE_TAIL), 'Wayland: the right-hand side is unchanged, got %r' % rendered(wl_row))
check(err == '', 'Wayland: nothing printed to stderr, got %r' % err)
check(getattr(wl_bare, 'wayland_note', None) is not None and rendered(wl_bare) == '0.1.0' + ISSUE_TAIL and bare_err == '',
      'Wayland without version.json: the note and the version and issue link')
# The note is part of the row that stays usable while "Enable Window Memory" is off.
wl_version = wl_rows['version-info']
check(wl_version.is_sensitive() and wl_version.wayland_note.is_sensitive(), 'Wayland: the note stays sensitive while "enabled" is off')
check(wl_version.wayland_note.get_visible(), 'Wayland: the note is visible on the page')
wl_page_window.destroy()

# 10. In French. The texts of the row are translated in the domain of the uuid, from the .mo files
# in ~/.local/share/locale, the home folder being GLib's. A child process of this harness
# (french_child) runs with LANGUAGE=fr, and with HOME and XDG_DATA_HOME in a temp folder, where
# compile_french has compiled FRENCH with msgfmt -c. Its row reads in French; the version label on
# the left is the schema description, which cinnamon-settings translates before the widget gets it.
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
    wanted = {'row': 'inconnue [%s] (modifications non validées) | Signaler un problème' % SHORT,
              'note': 'Wayland (expérimental)', 'tip': FRENCH[WAYLAND_TIP]}
    check(got == wanted, 'in French the row reads %r, got %r (exit %d): %s' % (wanted, got, child.returncode, child.stderr[-2000:]))

print('FAILED %d of %d checks' % (len(failures), checked[0]) if failures else 'OK, %d checks' % checked[0])
sys.exit(1 if failures else 0)
