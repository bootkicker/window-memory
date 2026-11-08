# SPDX-License-Identifier: GPL-3.0-or-later
# Test-only: checks backup_buttons.py, the "Back up or restore" row of the settings dialog.
# Run by tests/backup-buttons.test.js.
# Usage: python3 -B backup_harness.py <extension dir> functions|widget
#   functions  The plain functions. Needs Python 3 and its standard library only: the test runs it
#              with -I -S, and gi and xapp are replaced by stand-ins while the module is loaded (the
#              plain functions do not use them; the module asks GLib only for the home folder, where
#              its translations are). The French check (F19) also needs msgfmt, and is skipped
#              without it.
#   widget     The widget, built the way cinnamon-settings builds it. Needs GTK 3, xapp and a display.
# Exit codes: 0 all checks passed, 1 a check failed, 77 cannot run here (widget: no GTK, xapp or display).
#
# Nothing here touches the real configuration folder. Before anything else the harness points
# XDG_CONFIG_HOME at a temp folder, for itself and for the processes it starts (two of which test the
# fallback to HOME instead, with HOME in the same temp folder), and it removes the folder at the end.
# Every file a check writes is in it. No dialog is shown: the widget's methods that run one are
# replaced by recorders, and the dialogs are only built and inspected. The widget never gets a real
# D-Bus proxy. Failure messages never print what a state file holds.
#
# The checks compare the English texts. LANGUAGE=C keeps the language of the session, and a
# translation installed for it, out of them: Python's gettext reads LANGUAGE first. The stand-in
# home folder of the functions has no translation either.
import atexit
import calendar
import contextlib
import importlib.util
import io
import json
import os
import pwd
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import types

SKIP = 77

ext_dir, mode = sys.argv[1], sys.argv[2]
work = tempfile.mkdtemp(prefix='window-memory-backup-harness-')
atexit.register(shutil.rmtree, work, True)  # also when a check raises
CONFIG = os.path.join(work, 'config')
os.environ['XDG_CONFIG_HOME'] = CONFIG
os.environ['LANGUAGE'] = 'C'
# What GLib.get_home_dir() gives the module in the functions checks: a folder with no translation.
STAND_IN_HOME = os.path.join(work, 'home')
STATE_DIR = os.path.join(CONFIG, 'window-memory')
STATE = os.path.join(STATE_DIR, 'state.json')
STAGING = os.path.join(STATE_DIR, 'import-pending.json')

# Spelled out here, not read from the module under test.
UUID = 'window-memory@bootkicker'
STORED = ['enabled', 'remember-size', 'remember-position', 'remember-monitor', 'remember-workspace',
          'remember-maximized', 'remember-minimized', 'match-by-title', 'include-dialogs', 'excluded-apps',
          'max-entries', 'forget-focused']
STORED_TYPES = ('switch', 'spinbutton', 'combobox', 'list', 'keybinding', 'entry')
LABELS = ['Export backup…', 'Import backup…']
LIMIT = 20 * 1024 * 1024
TOO_LARGE = 'The file is larger than 20 MB, too large to be a Window Memory backup.'
CREATED = '2025-01-31T12:00:00Z'
CREATED_SECONDS = calendar.timegm((2025, 1, 31, 12, 0, 0))
LOST = 'The current settings and remembered windows are lost. This cannot be undone.'
SAVE_FAILED = 'Could not save the backup.'
RESTORE_FAILED = 'Could not restore the backup.'
EMPTY_STATE = {'version': 1, 'windows': []}
NOT_HANDED = 'The remembered windows could not be handed to Window Memory: '
NOT_RUNNING = 'Window Memory is not running. Enable it in System Settings, then try again.'
# The message when importState gives no answer in time, word for word. The widget shows it
# as a text and a detail; the two together are this.
UNCONFIRMED = ('Window Memory did not confirm the restore in time. The remembered windows may or may not have been '
               'replaced, and the other settings were left as they were. Importing the same backup again is safe.')

with open(os.path.join(ext_dir, 'settings-schema.json'), encoding='utf-8') as f:
    schema = json.load(f)
DEFAULTS = {key: schema[key]['default'] for key in STORED}
# Every kind of stored setting changed from its default.
CHANGED = dict(DEFAULTS, **{'remember-size': False, 'match-by-title': 'class+title',
                            'excluded-apps': [{'enabled': True, 'wmclass': 'xterm'}, {'enabled': False, 'wmclass': 'Éditeur'}],
                            'max-entries': 750, 'forget-focused': '<Super>w::'})

failures = []
checked = [0]


def check(ok, message):
    checked[0] += 1
    if not ok:
        failures.append(message)
        print('FAIL: ' + message)


def finish():
    print('FAILED %d of %d checks' % (len(failures), checked[0]) if failures else 'OK, %d checks' % checked[0])
    sys.exit(1 if failures else 0)


def load_module(path):
    # The same three calls as xlet-settings.py:481-483.
    spec = importlib.util.spec_from_file_location('windowmemorybootkicker.' + os.path.basename(path).split('.')[0], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def window(number):
    # A made-up entry of the state file. Its title has a letter outside ASCII.
    return {'id': 'w%d' % number, 'key': 'app%d|app%d' % (number, number), 'wmClass': 'App%d' % number,
            'instance': 'app%d' % number, 'title': 'Fenêtre %d' % number, 'lastSeen': 1760000000 + number,
            'rel': {'x': 0.1, 'y': 0.2, 'w': 0.5, 'h': 0.4}, 'monitor': None, 'maximized': False,
            'minimized': False, 'workspace': 0}


def state_of(*numbers):
    return {'version': 1, 'windows': [window(n) for n in numbers]}


def write_file(path, content):
    """content: bytes or str (written as is), or anything else (written as JSON)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not isinstance(content, (bytes, str)):
        content = json.dumps(content)
    with open(path, 'wb') as f:
        f.write(content if isinstance(content, bytes) else content.encode('utf-8'))
    return path


def read_text(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def mode_of(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def files_under(folder):
    return sorted(os.path.join(root, name) for root, _, names in os.walk(folder) for name in names)


@contextlib.contextmanager
def time_zone(tz):
    real = os.environ.get('TZ')
    os.environ['TZ'] = tz
    time.tzset()
    try:
        yield
    finally:
        if real is None:
            os.environ.pop('TZ', None)
        else:
            os.environ['TZ'] = real
        time.tzset()


def load_without_gtk(path, home=STAND_IN_HOME):
    """The module, loaded with stand-ins for gi and xapp, which the plain functions do not use. The
    stand-in GLib.get_home_dir() gives home: the module looks for its translations in
    <home>/.local/share/locale when it is loaded."""
    gi = types.ModuleType('gi')
    gi.require_version = lambda namespace, version: None
    repository = types.ModuleType('gi.repository')
    for name in ('Gio', 'GLib', 'Gtk'):
        setattr(repository, name, types.ModuleType('gi.repository.' + name))
    repository.GLib.get_home_dir = lambda: home
    gi.repository = repository
    xapp = types.ModuleType('xapp')
    xapp.SettingsWidgets = types.ModuleType('xapp.SettingsWidgets')
    xapp.SettingsWidgets.SettingsWidget = type('SettingsWidget', (object,), {})
    stand_ins = {'gi': gi, 'gi.repository': repository, 'xapp': xapp, 'xapp.SettingsWidgets': xapp.SettingsWidgets}
    saved = {name: sys.modules.get(name) for name in stand_ins}
    sys.modules.update(stand_ins)
    try:
        return load_module(path)
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def refused(m, call, *args):
    """The message of the BackupError that call(*args) raises, or None when it raises none."""
    try:
        call(*args)
    except m.BackupError as e:
        return str(e)
    return None


# The French check (F19): the texts of the confirmation before an import, and their French
# translations, which the check compiles into a .mo of its own. A counted text has its two forms,
# and the two French ones.
FRENCH = {
    ('Replace the settings and the %(count)d remembered window with this backup from %(time)s?',
     'Replace the settings and the %(count)d remembered windows with this backup from %(time)s?'):
        ('Remplacer les paramètres et %(count)d fenêtre mémorisée par cette sauvegarde du %(time)s ?',
         'Remplacer les paramètres et %(count)d fenêtres mémorisées par cette sauvegarde du %(time)s ?'),
    ('Replace the settings and the %(count)d remembered window with this backup?',
     'Replace the settings and the %(count)d remembered windows with this backup?'):
        ('Remplacer les paramètres et %(count)d fenêtre mémorisée par cette sauvegarde ?',
         'Remplacer les paramètres et %(count)d fenêtres mémorisées par cette sauvegarde ?'),
    LOST: 'Les paramètres et les fenêtres mémorisées actuels seront perdus. Cette opération est irréversible.',
    # The labels and tooltips of the two buttons, from the schema: the widget translates them itself.
    'Export backup…': 'Exporter une sauvegarde…',
    'Save every setting, the never-remember list and the remembered windows to a file.':
        'Enregistre tous les paramètres, la liste des applications à ne jamais mémoriser et les fenêtres mémorisées dans un fichier.',
    'Import backup…': 'Importer une sauvegarde…',
    'Replace every setting and remembered window with the ones in a backup file. Asks first.':
        'Remplace tous les paramètres et toutes les fenêtres mémorisées par ceux d’un fichier de sauvegarde. Demande d’abord.',
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
    os.makedirs(home)
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


def functions_checks():
    m = load_without_gtk(os.path.join(ext_dir, 'backup_buttons.py'))

    # F1. The real schema: the items that store a value, in its order. Every other item is a custom
    # widget (or a schema button), so a new kind of setting cannot be left out of backups unnoticed.
    check(m.stored_keys(schema) == STORED, 'the stored items of the schema, in its order: got %s' % m.stored_keys(schema))
    kinds = set(entry['type'] for entry in schema.values())
    # "layout" is the first key of the schema, the tabs of the settings window (xlet-settings.py build_with_layout): it holds
    # no value, and a backup never carries it.
    check(kinds <= set(STORED_TYPES) | {'custom', 'button', 'generic', 'layout'}, 'the schema uses only stored types, custom, button, generic and layout: %s' % sorted(kinds))
    check(schema['layout']['type'] == 'layout' and 'layout' not in m.stored_keys(schema), 'layout is not a stored key')
    # startup-pick, the hidden key the "Pick a window to start at login" button of the extension writes (a generic: no widget),
    # is a result passed to another process and not a setting: a backup never carries it.
    check(schema['startup-pick']['type'] == 'generic' and 'startup-pick' not in m.stored_keys(schema), 'startup-pick is a generic and not a stored key')
    check('startup-pick' not in STORED, 'startup-pick is not among the keys a backup stores')

    # F2. build_backup: format 1, the value of every stored item in the schema's order, the state as given.
    state = state_of(1, 2)
    values = dict(CHANGED, **{'pick-window': 'stores nothing', 'no-such-setting': 1})
    data = m.build_backup(schema, values, state, CREATED, '0.1.0')
    check(list(data) == ['format', 'version', 'created', 'extensionVersion', 'settings', 'state'], 'the keys of a backup: got %s' % list(data))
    check((data['format'], data['version'], data['created'], data['extensionVersion']) == ('window-memory-backup', 1, CREATED, '0.1.0'),
          'format, version, created and extensionVersion are the ones given')
    check(list(data['settings']) == STORED and data['settings'] == {key: CHANGED[key] for key in STORED},
          'settings holds the stored items with the given values, in the schema order, and nothing else')
    with_pick = m.build_backup(schema, dict(values, **{'startup-pick': '{"v":1,"stamp":1,"kind":"app"}'}), state, CREATED, '0.1.0')
    check('startup-pick' not in with_pick['settings'] and with_pick == data, 'a backup made with a startup-pick value in the values does not carry it')
    check(data['state'] == state, 'the state is the one given')

    # F3. The text: json.dumps(data, indent=2, ensure_ascii=False) and a newline. Never NaN, which
    # JSON.parse (the extension) refuses.
    text = m.backup_text(data)
    check(text == json.dumps(data, indent=2, ensure_ascii=False) + '\n', 'the backup text is json.dumps(data, indent=2, ensure_ascii=False) and a newline')
    check('Éditeur' in text, 'text outside ASCII is written as it is, not escaped')
    try:
        m.backup_text({'n': float('nan')})
        check(False, 'NaN is not written')
    except ValueError:
        pass

    # F4. A backup made by build_backup passes check_backup, also through a file.
    result = m.check_backup(json.loads(text), schema)
    check(list(result.settings) == STORED and result.settings == data['settings'], 'the checked settings are the backup\'s, in the schema order')
    check(result.state == state and result.unknown == 0 and result.created == CREATED, 'the checked state, no unknown settings, the created time')
    path = write_file(os.path.join(work, 'backup.json'), text)
    check(m.read_backup(path) == data, 'read_backup gives back the JSON in the file')

    # F5. Every rejection, with its own message. Each case is the backup above with one thing changed.
    delete = object()

    def variant(*keys_and_value):
        keys, value = keys_and_value[:-1], keys_and_value[-1]
        copy = json.loads(text)
        target = copy
        for key in keys[:-1]:
            target = target[key]
        if value is delete:
            del target[keys[-1]]
        else:
            target[keys[-1]] = value
        return copy

    not_object = 'The file is not a Window Memory backup: it does not hold a JSON object.'
    not_format = 'The file is not a Window Memory backup: its "format" is not "window-memory-backup".'
    newer = 'The backup was made by a newer version of Window Memory (backup format %d). This version reads format 1 only.'
    not_version = 'The "version" of the backup is not 1.'
    no_settings = 'The backup has no "settings" object.'
    no_state = 'The backup has no "state" object.'
    not_state_version = 'The "version" of the "state" in the backup is not 1.'
    not_windows = 'The "windows" of the "state" in the backup are not a list.'
    not_switch = 'The setting "%s" in the backup is not true or false.'
    not_whole = 'The setting "max-entries" in the backup is not a whole number.'
    out_of_range = 'The setting "max-entries" in the backup is outside the range 10 to 5000.'
    not_choice = 'The setting "match-by-title" in the backup is not one of its choices.'
    not_list = 'The setting "excluded-apps" in the backup is not a list.'
    not_entry = 'The setting "excluded-apps" in the backup has an entry that is not an object.'
    no_wmclass = 'The setting "excluded-apps" in the backup has an entry without a text "wmclass".'
    not_enabled = 'The setting "excluded-apps" in the backup has an entry whose "enabled" is not true or false.'
    not_text = 'The setting "%s" in the backup is not text.'
    with_entry = dict(schema, note={'type': 'entry', 'default': '', 'description': 'A note'})
    cases = [
        ('a JSON list', ['a', 'list'], not_object, schema),
        ('a JSON string', 'backup', not_object, schema),
        ('JSON null', None, not_object, schema),
        ('no format', variant('format', delete), not_format, schema),
        ('another format', variant('format', 'window-memory-state'), not_format, schema),
        ('format version 2', variant('version', 2), newer % 2, schema),
        ('format version 17', variant('version', 17), newer % 17, schema),
        ('format version 0', variant('version', 0), not_version, schema),
        ('format version "1"', variant('version', '1'), not_version, schema),
        ('format version 1.5', variant('version', 1.5), not_version, schema),
        ('format version true', variant('version', True), not_version, schema),
        ('no format version', variant('version', delete), not_version, schema),
        ('settings a list', variant('settings', []), no_settings, schema),
        ('no settings', variant('settings', delete), no_settings, schema),
        ('state a list', variant('state', []), no_state, schema),
        ('no state', variant('state', delete), no_state, schema),
        ('state version 2', variant('state', 'version', 2), not_state_version, schema),
        ('state version true', variant('state', 'version', True), not_state_version, schema),
        ('no state version', variant('state', 'version', delete), not_state_version, schema),
        ('windows an object', variant('state', 'windows', {}), not_windows, schema),
        ('no windows', variant('state', 'windows', delete), not_windows, schema),
        ('a switch that is a string', variant('settings', 'remember-size', 'true'), not_switch % 'remember-size', schema),
        ('a switch that is 1', variant('settings', 'enabled', 1), not_switch % 'enabled', schema),
        ('a spinbutton that is a string', variant('settings', 'max-entries', '500'), not_whole, schema),
        ('a spinbutton that is a fraction', variant('settings', 'max-entries', 500.5), not_whole, schema),
        ('a spinbutton that is true', variant('settings', 'max-entries', True), not_whole, schema),
        ('a spinbutton below its min', variant('settings', 'max-entries', 9), out_of_range, schema),
        ('a spinbutton above its max', variant('settings', 'max-entries', 5001), out_of_range, schema),
        ('a combobox value that is no option', variant('settings', 'match-by-title', 'title'), not_choice, schema),
        ('a combobox label instead of its value', variant('settings', 'match-by-title', 'Application only'), not_choice, schema),
        ('a list that is an object', variant('settings', 'excluded-apps', {'wmclass': 'xterm'}), not_list, schema),
        ('a list entry that is a string', variant('settings', 'excluded-apps', ['xterm']), not_entry, schema),
        ('a list entry without wmclass', variant('settings', 'excluded-apps', [{'wmclass': 'xterm'}, {'class': 'xed'}]), no_wmclass, schema),
        ('a list entry whose wmclass is a number', variant('settings', 'excluded-apps', [{'wmclass': 7}]), no_wmclass, schema),
        ('a list entry whose enabled is a string', variant('settings', 'excluded-apps', [{'enabled': 'true', 'wmclass': 'xterm'}]), not_enabled, schema),
        ('a list entry whose enabled is 1', variant('settings', 'excluded-apps', [{'wmclass': 'xed'}, {'enabled': 1, 'wmclass': 'xterm'}]), not_enabled, schema),
        ('a list entry whose enabled is null', variant('settings', 'excluded-apps', [{'enabled': None, 'wmclass': 'xterm'}]), not_enabled, schema),
        ('a list entry with enabled but without wmclass', variant('settings', 'excluded-apps', [{'enabled': True}]), no_wmclass, schema),
        ('a keybinding that is a list', variant('settings', 'forget-focused', ['<Super>w']), not_text % 'forget-focused', schema),
        ('an entry that is a number', variant('settings', 'note', 5), not_text % 'note', with_entry),
    ]
    for label, bad, message, against in cases:
        got = refused(m, m.check_backup, bad, against)
        check(got == message, '%s: refused with %r, wanted %r' % (label, got, message))
    check(m.check_backup(variant('settings', 'note', 'a text'), with_entry).settings.get('note') == 'a text', 'an entry takes a string')

    # The first problem is named: the file's own order of settings, after the checks of the frame.
    two_bad = variant('settings', {'max-entries': 1, 'remember-size': 'x'})
    check(refused(m, m.check_backup, two_bad, schema) == out_of_range, 'two bad settings: the first in the file is named')
    two_bad['format'] = 'other'
    check(refused(m, m.check_backup, two_bad, schema) == not_format, 'a bad format is named before bad settings')

    # F6. Settings the schema does not know are ignored and counted; those it stores nothing for are
    # ignored. A backup with some settings gives those, in the schema order.
    extra = variant('settings', 'no-such-setting', 1)
    extra['settings'].update({'another-unknown': {'x': 1}, 'pick-window': 'stores nothing', 'version-info': 3})
    result = m.check_backup(extra, schema)
    check(result.unknown == 2 and list(result.settings) == STORED, 'two unknown settings counted, the custom items ignored, got %d' % result.unknown)
    # An import never sets startup-pick, even from a hand-made file: it is known to the schema but stores no backup value.
    with_pick = variant('settings', 'startup-pick', '{"v":1,"stamp":1,"kind":"form","name":"x","command":"x"}')
    result = m.check_backup(with_pick, schema)
    check('startup-pick' not in result.settings and result.unknown == 0 and list(result.settings) == STORED, 'startup-pick in a backup file is left out of the settings to apply, got %s' % list(result.settings))
    partial = m.check_backup(variant('settings', {'max-entries': 750, 'enabled': False}), schema)
    check(list(partial.settings.items()) == [('enabled', False), ('max-entries', 750)], 'some settings: those, in the schema order')

    # F6b. The never-remember list checks each column by its type: the text "wmclass" must be a string; the boolean
    # "enabled" must be true or false when it is there, and may be missing: a backup made before the column has none
    # (cinnamon-settings shows such a row with the column default, checked). Rows are taken as they are.
    old_rows = [{'wmclass': 'xterm'}, {'wmclass': 'Éditeur'}]
    new_rows = [{'enabled': True, 'wmclass': 'xterm'}, {'enabled': False, 'wmclass': 'xed'}, {'wmclass': 'vlc'}]
    for label, rows in (('an old backup with no "enabled"', old_rows), ('a new backup with "enabled"', new_rows), ('an empty list', [])):
        try:
            got = m.check_backup(variant('settings', 'excluded-apps', rows), schema).settings.get('excluded-apps')
            check(got == rows, '%s: the rows are taken as they are, got %r' % (label, got))
        except m.BackupError as e:
            check(False, '%s: refused with %r' % (label, str(e)))
    check([c.get('type') for c in schema['excluded-apps']['columns']] == ['boolean', 'string'],
          'the list has a boolean column, then a string column')

    # F7. A spinbutton takes min and max themselves, and a whole number written with a fraction part.
    for value, wanted in ((10, 10), (5000, 5000), (750.0, 750)):
        got = m.check_backup(variant('settings', 'max-entries', value), schema).settings['max-entries']
        check(got == wanted and type(got) is int, 'max-entries %r is taken as the whole number %r, got %r' % (value, wanted, got))

    # F8. read_backup. The file is opened once, without blocking, and checked on that descriptor: a
    # file over 20 MB is refused before any of it is read (the file is sparse: nothing is written to
    # disk). The limit itself is checked with a smaller limit.
    check(m.MAX_BACKUP_BYTES == LIMIT, 'the limit is 20 MB, got %d' % m.MAX_BACKUP_BYTES)
    big = os.path.join(work, 'big.json')
    with open(big, 'wb') as f:
        f.truncate(LIMIT + 1)
    reads = []
    real_read = os.read
    os.read = lambda fd, size: reads.append(size) or real_read(fd, size)
    try:
        check(refused(m, m.read_backup, big) == TOO_LARGE, 'a file of 20 MB and a byte is refused')
    finally:
        os.read = real_read
    check(reads == [], 'the large file is refused before any of it is read')
    # A FIFO, and a regular file that is a FIFO by the time it is opened (as if swapped in after a
    # check): refused at once. An open that blocked would wait for a writer; the alarm makes that a
    # failure instead of a hang.
    fifo = os.path.join(work, 'fifo.json')
    os.mkfifo(fifo)
    swapped = write_file(os.path.join(work, 'swapped.json'), text)
    real_os_open = os.open

    def swapping_open(where, flags, *args, **kwargs):
        if where == swapped:
            os.unlink(swapped)
            os.mkfifo(swapped)
        return real_os_open(where, flags, *args, **kwargs)

    def on_alarm(signum, frame):
        raise TimeoutError('blocked')

    previous = signal.signal(signal.SIGALRM, on_alarm)
    try:
        for label, where in (('a FIFO', fifo), ('a file that is a FIFO when it is opened', swapped)):
            os.open = swapping_open
            signal.alarm(5)
            try:
                got = refused(m, m.read_backup, where)
            except TimeoutError:
                got = 'blocked for 5 s'
            finally:
                signal.alarm(0)
                os.open = real_os_open
            check(got == 'The file is not a regular file.', '%s: refused at once as not a regular file, got %r' % (label, got))
    finally:
        signal.signal(signal.SIGALRM, previous)
    check(stat.S_ISFIFO(os.stat(swapped).st_mode), 'the swap happened: the second path is a FIFO now')
    size = os.path.getsize(path)
    try:
        m.MAX_BACKUP_BYTES = size
        check(refused(m, m.read_backup, path) is None, 'a file of exactly the limit is read')
        m.MAX_BACKUP_BYTES = size - 1
        check(refused(m, m.read_backup, path) == TOO_LARGE, 'a file one byte over the limit is refused')
    finally:
        m.MAX_BACKUP_BYTES = LIMIT
    folder = os.path.join(work, 'a-folder.json')
    os.mkdir(folder)
    check(refused(m, m.read_backup, os.path.join(work, 'missing.json')) == 'The file cannot be read: No such file or directory.', 'a missing file')
    check(refused(m, m.read_backup, folder) == 'The file is not a regular file.', 'a folder')
    check(refused(m, m.read_backup, write_file(os.path.join(work, 'latin1.json'), b'{"format": "\xe9"}')) == 'The file is not UTF-8 text.', 'bytes that are not UTF-8')
    for label, content in (('an empty file', ''), ('cut short', text[:40]), ('NaN', '{"x": NaN}'), ('Infinity', '[Infinity]'), ('-Infinity', '[-Infinity]')):
        got = refused(m, m.read_backup, write_file(os.path.join(work, 'bad.json'), content)) or ''
        check(got.startswith('The file is not valid JSON: '), '%s: refused as not valid JSON, got %r' % (label, got))

    # F9. write_private: atomic, mode 0600 whatever the umask, nothing left behind on failure.
    out_dir = os.path.join(work, 'out')
    os.mkdir(out_dir)
    target = os.path.join(out_dir, 'backup.json')
    seen = []
    real_replace = os.replace

    def watching_replace(src, dst):
        seen.append((os.path.dirname(src), mode_of(src), dst))
        return real_replace(src, dst)

    real_umask = os.umask(0o022)
    try:
        os.replace = watching_replace
        try:
            m.write_private(target, 'one\n')
        finally:
            os.replace = real_replace
        check(read_text(target) == 'one\n' and mode_of(target) == 0o600, 'the file has the text and mode 0600, got %o' % mode_of(target))
        check(seen == [(out_dir, 0o600, target)], 'written to a temporary file in the same folder, already 0600, then moved with os.replace')
        check(os.listdir(out_dir) == ['backup.json'], 'no temporary file is left')
        os.chmod(target, 0o644)
        m.write_private(target, 'two\n')
        check(read_text(target) == 'two\n' and mode_of(target) == 0o600, 'an existing 0644 file is replaced: the new text, mode 0600')
        os.umask(0o277)
        m.write_private(target, 'three\n')
        os.umask(0o022)
        check(mode_of(target) == 0o600, 'with umask 277 the file is still 0600, got %o' % mode_of(target))
        # A folder in the way fails at os.replace, after the temporary file was written beside it.
        in_the_way = os.path.join(out_dir, 'in-the-way.json')
        os.mkdir(in_the_way)
        for label, where, words in (('text that cannot be UTF-8', target, 'lone \ud800'),
                                    ('a folder in the way', in_the_way, 'x'),
                                    ('a missing folder', os.path.join(work, 'no-such-folder', 'x.json'), 'x')):
            try:
                m.write_private(where, words)
                check(False, '%s: the write failed' % label)
            except (OSError, ValueError):
                pass
        check(read_text(target) == 'three\n' and mode_of(target) == 0o600, 'after the failures the old file is untouched')
        check(sorted(os.listdir(out_dir)) == ['backup.json', 'in-the-way.json'] and os.listdir(in_the_way) == []
              and not os.path.exists(os.path.join(work, 'no-such-folder')), 'no temporary file is left where the writes failed')
    finally:
        os.umask(real_umask)

    # F10. read_state: the state file as saved, or an empty state and the reason.
    states = os.path.join(work, 'states')
    saved = dict(state_of(3), extra='kept as saved')
    check(m.read_state(write_file(os.path.join(states, 'good.json'), saved)) == (saved, None), 'a state of version 1 is taken as saved')
    for label, content, problem in (('missing', None, 'the state file does not exist'),
                                    ('not JSON', '{oops', 'the state file is not valid JSON'),
                                    ('not UTF-8', b'\xff\xfe', 'the state file is not valid JSON'),
                                    ('NaN', '{"version": 1, "windows": [NaN]}', 'the state file is not valid JSON'),
                                    ('a list', '[]', 'the state file is not a state of version 1'),
                                    ('version 2', {'version': 2, 'windows': []}, 'the state file is not a state of version 1'),
                                    ('windows an object', {'version': 1, 'windows': {}}, 'the state file is not a state of version 1')):
        where = os.path.join(states, label.replace(' ', '-') + '.json')
        if content is not None:
            write_file(where, content)
        got_state, got_problem = m.read_state(where)
        check(got_state == EMPTY_STATE and got_problem == problem, '%s: an empty state and %r, got the problem %r' % (label, problem, got_problem))

    # F11. extensionVersion comes from metadata.json; without a usable one it is "unknown", with a warning.
    with open(os.path.join(ext_dir, 'metadata.json'), encoding='utf-8') as f:
        real_version = json.load(f)['version']
    check(m.read_extension_version(ext_dir) == real_version, 'the version of the real metadata.json, %s' % real_version)
    for number, content in enumerate((None, '{oops', '[]', '{}', '{"version": 3}', '{"version": " "}')):
        where = os.path.join(work, 'meta%d' % number)
        os.mkdir(where)
        if content is not None:
            write_file(os.path.join(where, 'metadata.json'), content)
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            got = m.read_extension_version(where)
        check(got == 'unknown' and 'metadata.json' in captured.getvalue(), 'metadata.json %r: "unknown" and a warning, got %r' % (content, got))

    # F12. read_schema: the schema next to the widget, or a BackupError.
    check(m.read_schema(ext_dir) == schema, 'read_schema reads settings-schema.json in the folder')
    check((refused(m, m.read_schema, work) or '').startswith('The settings schema cannot be read: '), 'a folder without a schema')

    # F13. The configuration folder is GLib.get_user_config_dir()'s (the widget checks compare them),
    # and the staging write goes to the path under the temporary XDG_CONFIG_HOME.
    home = pwd.getpwuid(os.getuid()).pw_dir
    for environ, wanted in (({'XDG_CONFIG_HOME': '/x/config', 'HOME': '/x/home'}, '/x/config'),
                            ({'XDG_CONFIG_HOME': '', 'HOME': '/x/home'}, '/x/home/.config'),
                            ({'HOME': '/x/home'}, '/x/home/.config'),
                            ({}, os.path.join(home, '.config'))):
        check(m.user_config_dir(environ) == wanted, 'user_config_dir(%s) is %s, got %s' % (environ, wanted, m.user_config_dir(environ)))
    check(m.user_config_dir() == CONFIG, 'without an argument it reads the environment: the temporary XDG_CONFIG_HOME')
    check(m.state_path(CONFIG) == STATE and m.staging_path(CONFIG) == STAGING, 'state.json and import-pending.json in <config>/window-memory')
    check(not os.path.exists(CONFIG), 'nothing is in the temporary config folder yet')
    written = m.write_staging(m.user_config_dir(), state)
    check(written == STAGING and files_under(CONFIG) == [STAGING], 'the staging write made <XDG_CONFIG_HOME>/window-memory/import-pending.json and nothing else')
    check(mode_of(STAGING) == 0o600 and json.loads(read_text(STAGING)) == state, 'the staging file has mode 0600 and holds the state')
    m.remove_file(STAGING)
    m.remove_file(STAGING)
    check(not os.path.exists(STAGING), 'remove_file removes it, and a second time does nothing')

    # F14. The folder of the save dialog: Documents if it is a folder, else the home folder.
    documents, home_folder = os.path.join(work, 'Documents'), os.path.join(work, 'home')
    os.mkdir(documents)
    a_file = write_file(os.path.join(work, 'a-file'), '')
    check(m.backup_folder(documents, home_folder) == documents, 'Documents when it exists')
    for missing in (None, os.path.join(work, 'missing'), a_file):
        check(m.backup_folder(missing, home_folder) == home_folder, 'the home folder when Documents is %s' % missing)

    # F15. Times: created is UTC; the suggested file name has the local date, the confirmation the
    # local time. TEST-2 is two hours east of UTC all year and needs no time zone database.
    check(m.utc_stamp(CREATED_SECONDS) == CREATED, 'utc_stamp gives %s, got %s' % (CREATED, m.utc_stamp(CREATED_SECONDS)))
    with time_zone('TEST-2'):
        check(m.local_time(CREATED) == '2025-01-31 14:00', 'local_time gives 2025-01-31 14:00, got %s' % m.local_time(CREATED))
        name = m.backup_file_name(CREATED_SECONDS + 11 * 3600)
        check(name == 'window-memory-backup-2025-02-01.json', '23:00 UTC is the next day two hours east, got %s' % name)
        for odd in ('2025-01-31 12:00:00', '2025-01-31T12:00:00', 'yesterday', 20250131, None):
            check(m.local_time(odd) is None, 'created %r is not a time' % (odd,))

        # F16. The messages.
        check(m.replace_question(2, CREATED) == ('Replace the settings and the 2 remembered windows with this backup from 2025-01-31 14:00?', LOST),
              'the confirmation: %s' % (m.replace_question(2, CREATED),))
        check(m.replace_question(1, 'not a time') == ('Replace the settings and the 1 remembered window with this backup?', LOST),
              'the confirmation without a usable time: %s' % (m.replace_question(1, 'not a time'),))
    for got, wanted in ((m.export_message(12, 2, None), ('Backup saved: 12 settings, 2 remembered windows.', None)),
                        (m.export_message(12, 1, None), ('Backup saved: 12 settings, 1 remembered window.', None)),
                        # No state file: no window is remembered yet, which is not a problem.
                        (m.export_message(12, 0, 'the state file does not exist'),
                         ('Backup saved: 12 settings, 0 remembered windows.', 'No windows are remembered yet.')),
                        (m.export_message(12, 0, 'the state file is not valid JSON'),
                         ('Backup saved: 12 settings, 0 remembered windows.', 'The remembered windows could not be read (the state file is not valid JSON), so none were saved.')),
                        (m.restore_message(12, 3, 0), ('Restored 12 settings and 3 remembered windows.', None)),
                        (m.restore_message(12, 1, 2), ('Restored 12 settings and 1 remembered window.',
                                                       '2 settings in the backup are not known to this version of Window Memory and were left out.')),
                        (m.restore_message(1, 0, 1), ('Restored 1 setting and 0 remembered windows.',
                                                      '1 setting in the backup is not known to this version of Window Memory and was left out.')),
                        # A setting that fails after the windows were restored.
                        (m.partial_restore_message(2, 'match-by-title', 'No space left on device.', 2),
                         ('Restored 2 remembered windows, but not all the settings.',
                          'The setting "match-by-title" could not be set: No space left on device. 2 settings after it were not set either. '
                          'Importing the same backup again is safe.')),
                        (m.partial_restore_message(1, 'excluded-apps', 'Disk full.', 1),
                         ('Restored 1 remembered window, but not all the settings.',
                          'The setting "excluded-apps" could not be set: Disk full. 1 setting after it was not set either. '
                          'Importing the same backup again is safe.')),
                        (m.partial_restore_message(0, 'forget-focused', 'Disk full.', 0),
                         ('Restored 0 remembered windows, but not all the settings.',
                          'The setting "forget-focused" could not be set: Disk full. Importing the same backup again is safe.'))):
        check(got == wanted, 'message %s, wanted %s' % (got, wanted))
    glib_error = type('Error', (Exception,), {'message': 'no such name'})()
    for error, wanted in ((FileNotFoundError(2, 'No such file or directory', '/x'), 'No such file or directory.'),
                          (m.BackupError('The file is not UTF-8 text.'), 'The file is not UTF-8 text.'),
                          (glib_error, 'no such name.'), (RuntimeError(), 'RuntimeError.')):
        check(m.describe(error) == wanted, 'describe(%r) is %r, got %r' % (error, wanted, m.describe(error)))

    # F17. The reason in a remote D-Bus error: the text of the reply without the "GDBus.Error:<name>: "
    # that GDBus puts before it; the TypeError of a callback Cinnamon could not find says that Window
    # Memory is not running.
    js = 'org.gnome.gjs.JSError.Error'
    for name, message, wanted in ((js, 'GDBus.Error:%s: [window-memory] import rejected: x does not exist' % js,
                                   '[window-memory] import rejected: x does not exist.'),
                                  ('org.gnome.gjs.JSError.TypeError', 'GDBus.Error:org.gnome.gjs.JSError.TypeError: obj is null', NOT_RUNNING),
                                  ('org.example.Failed', 'a text without the prefix.', 'a text without the prefix.'),
                                  ('org.example.Failed', 'GDBus.Error:org.example.Failed: ', 'org.example.Failed.')):
        check(m.remote_reason(name, message) == wanted, 'remote_reason(%r, %r) is %r, got %r' % (name, message, wanted, m.remote_reason(name, message)))

    # F18. max-entries is set before the call only when the backup's value is larger than the current one.
    # The current value can be a float: cinnamon-settings stores a spin button changed in the dialog as one.
    for backup_settings, current, wanted in (({'max-entries': 750}, {'max-entries': 500}, True),
                                             ({'max-entries': 500}, {'max-entries': 500}, False),
                                             ({'max-entries': 100}, {'max-entries': 500}, False),
                                             ({'max-entries': 750}, {'max-entries': 300.0}, True),
                                             ({'max-entries': 750}, {'max-entries': 749.5}, True),
                                             ({'max-entries': 750}, {'max-entries': 750.0}, False),
                                             ({'max-entries': 500}, {'max-entries': 750.0}, False),
                                             ({'enabled': False}, {'enabled': True}, False),
                                             ({'max-entries': 750}, {'max-entries': None}, False),
                                             ({'max-entries': 750}, {'max-entries': '300'}, False),
                                             ({'max-entries': 750}, {'max-entries': True}, False)):
        check(m.raises_limit(backup_settings, current) is wanted, 'raises_limit(%s, %s) is %s' % (backup_settings, current, wanted))

    # F19. In French. The texts are translated in the domain of the uuid, from the .mo files in
    # ~/.local/share/locale. The module is loaded again with LANGUAGE=fr and a home folder where
    # FRENCH is compiled with msgfmt -c: the question and the warning of the confirmation come out in
    # French, with the French plural forms (one window, and none, are singular in French), and so do
    # the labels and tooltips of the two buttons. A text with no translation in the file stays in
    # English. Skipped, with a note, when msgfmt is not installed.
    fr_home = os.path.join(work, 'fr-home')
    problem = compile_french(fr_home, FRENCH)
    if problem and problem.startswith('msgfmt is not installed'):
        print('note: %s; the French check is skipped' % problem)
    elif problem:
        check(False, problem)
    else:
        os.environ['LANGUAGE'] = 'fr'
        try:
            fr = load_without_gtk(os.path.join(ext_dir, 'backup_buttons.py'), home=fr_home)
        finally:
            os.environ['LANGUAGE'] = 'C'
        lost = FRENCH[LOST]
        with time_zone('TEST-2'):
            for got, wanted in ((fr.replace_question(2, CREATED),
                                 ('Remplacer les paramètres et 2 fenêtres mémorisées par cette sauvegarde du 2025-01-31 14:00 ?', lost)),
                                (fr.replace_question(1, CREATED),
                                 ('Remplacer les paramètres et 1 fenêtre mémorisée par cette sauvegarde du 2025-01-31 14:00 ?', lost)),
                                (fr.replace_question(0, 'not a time'),
                                 ('Remplacer les paramètres et 0 fenêtre mémorisée par cette sauvegarde ?', lost)),
                                (fr.replace_question(37, 'not a time'),
                                 ('Remplacer les paramètres et 37 fenêtres mémorisées par cette sauvegarde ?', lost))):
                check(got == wanted, 'in French the confirmation is %s, got %s' % (wanted, got))
        check(fr.RESTORE_FAILED == RESTORE_FAILED, 'a text with no French translation stays in English, got %r' % fr.RESTORE_FAILED)
        check(m.replace_question(1, 'not a time')[0] == 'Replace the settings and the 1 remembered window with this backup?',
              'the module loaded before is still in English')
        # The buttons: cinnamon-settings does not translate the "buttons" of the schema item, the widget
        # does. An empty text stays empty: gettext would give the header of the .mo for it.
        buttons = schema['backup']['buttons']
        wanted = [(FRENCH[spec['label']], FRENCH[spec['tooltip']]) for spec in buttons]
        got = fr.BackupButtons._button_texts(schema['backup'])
        check(got == wanted, 'in French the buttons are %s, got %s' % (wanted, got))
        check(fr.PLAIN_LABELS == (FRENCH['Export backup…'], FRENCH['Import backup…']), 'the plain labels in French, got %s' % (fr.PLAIN_LABELS,))
        empty = {'buttons': [dict(spec, tooltip='') for spec in buttons]}
        got = fr.BackupButtons._button_texts(empty)
        check(got == [(FRENCH[spec['label']], '') for spec in buttons], 'empty tooltips stay empty, got %s' % got)

    finish()


class FakeHandler(object):
    """The part of cinnamon-settings' JSONSettingsHandler that the widget uses: get_value and
    set_value (bin/JsonSettingsWidgets.py:80-92). Records every set_value call and every bind call."""
    instance_id = 'window-memory@bootkicker'

    def __init__(self, values):
        self.values = json.loads(json.dumps(values))
        self.set_calls = []
        self.bind_calls = []

    def get_value(self, key):
        return self.values[key]

    def set_value(self, key, value):
        self.set_calls.append((key, value))
        self.values[key] = value

    def bind(self, *args, **kwargs):
        self.bind_calls.append(args)


class OtherHandler(FakeHandler):
    instance_id = 'instance-7'


class LimitFailsHandler(FakeHandler):
    """set_value of max-entries raises, as a full disk would, at the calls numbered in fail_at
    (1 is the first), and then changes nothing and records nothing."""
    fail_at = ()

    def __init__(self, values):
        super(LimitFailsHandler, self).__init__(values)
        self.limit_calls = 0

    def set_value(self, key, value):
        if key == 'max-entries':
            self.limit_calls += 1
            if self.limit_calls in self.fail_at:
                raise OSError(28, 'No space left on device')
        super(LimitFailsHandler, self).set_value(key, value)


class EarlyFailsHandler(LimitFailsHandler):
    fail_at = (1,)


class RollbackFailsHandler(LimitFailsHandler):
    fail_at = (2,)


class SettingFailsHandler(FakeHandler):
    """set_value of the key fail_key raises, as a full disk would, and then changes and records nothing."""
    fail_key = None

    def set_value(self, key, value):
        if key == self.fail_key:
            raise OSError(28, 'No space left on device')
        super(SettingFailsHandler, self).set_value(key, value)


class FakeProxy(object):
    """Records each activateCallback call and what the staging file held at that moment: its mode,
    its JSON, and how many set_value calls the handler had seen."""

    def __init__(self, handler=None, error=None):
        self.calls, self.kwargs, self.seen = [], [], []
        self.handler, self.error = handler, error

    def activateCallback(self, *args, **kwargs):
        self.calls.append(args)
        self.kwargs.append(kwargs)
        if os.path.exists(STAGING):
            self.seen.append((mode_of(STAGING), json.loads(read_text(STAGING)), len(self.handler.set_calls) if self.handler else None))
        else:
            self.seen.append(None)
        if self.error:
            raise self.error


class RecordingBus(object):
    """Stands in for Gio.DBusProxy.new_for_bus_sync: records the arguments, returns the fake proxy."""

    def __init__(self, proxy=None, error=None):
        self.calls, self.proxy, self.error = [], proxy or FakeProxy(), error

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        return self.proxy


class Asked(object):
    """Stands in for the dialogs of one widget: records what each would show, and answers as planned."""

    def __init__(self, widget, save_path=None, open_path=None, replace=True):
        self.saves, self.opens, self.questions, self.messages = [], [], [], []
        widget._ask_save_path = lambda name, folder: self._answer(self.saves, (name, folder), save_path)
        widget._ask_open_path = lambda folder: self._answer(self.opens, (folder,), open_path)
        widget._ask_replace = lambda question, detail: self._answer(self.questions, (question, detail), replace)
        widget._tell = lambda text, detail=None, error=False: self.messages.append((text, detail, error))

    @staticmethod
    def _answer(record, asked, answer):
        record.append(asked)
        return answer


def click(button, asked):
    """Clicks button (its real signal). The widget logs each error it shows and nothing else."""
    before = len(asked.messages)
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        button.clicked()
    shown = ''.join('window-memory: %s %s\n' % (text, detail) for text, detail, error in asked.messages[before:] if error)
    check(captured.getvalue() == shown, 'the widget logs the errors it shows and nothing else; it logged %r' % captured.getvalue())


def widget_checks():
    os.environ['GSETTINGS_BACKEND'] = 'memory'
    # No GIO modules: gvfs would try the (unreachable) session bus from the file chooser, and print.
    os.mkdir(os.path.join(work, 'gio-modules'))
    os.environ['GIO_MODULE_DIR'] = os.path.join(work, 'gio-modules')
    # GLib reads the Documents folder from $XDG_CONFIG_HOME/user-dirs.dirs, the temporary one here.
    documents = os.path.join(work, 'Documents')
    os.mkdir(documents)
    write_file(os.path.join(CONFIG, 'user-dirs.dirs'), 'XDG_DOCUMENTS_DIR="%s"\n' % documents)
    try:
        import gi
        gi.require_version('Gtk', '3.0')
        from gi.repository import GLib, Gtk
        from xapp.SettingsWidgets import SettingsWidget
        if not Gtk.init_check()[0]:
            raise RuntimeError('Gtk.init_check() failed: no display')
    except Exception as e:  # ImportError, ValueError (missing typelib), RuntimeError
        print('cannot run: %s' % e)
        sys.exit(SKIP)

    module = load_module(os.path.join(ext_dir, 'backup_buttons.py'))
    Buttons = module.BackupButtons
    item = schema['backup']
    with open(os.path.join(ext_dir, 'metadata.json'), encoding='utf-8') as f:
        real_version = json.load(f)['version']

    # Gio.DBusProxy.new_for_bus_sync is replaced for the whole run, so nothing can reach the real bus.
    Gio = module.Gio
    real_new_for_bus_sync = Gio.DBusProxy.new_for_bus_sync
    bus = RecordingBus()
    Gio.DBusProxy.new_for_bus_sync = bus
    made = []

    def build(values, info=item, handler_class=FakeHandler):
        handler = handler_class(values)
        widget = Buttons(info, 'backup', handler)
        made.append(widget)
        return widget, handler

    def export_button(widget):
        return widget.content_widget.get_children()[0]

    def import_button(widget):
        return widget.content_widget.get_children()[1]

    # W1. What cinnamon-settings needs: a SettingsWidget built from (item, key, settings). It keeps its
    # key, which the page pass of pick_button.py reads, and binds and sets nothing when it is built.
    widget, handler = build(DEFAULTS)
    check(isinstance(widget, SettingsWidget), 'the widget is a SettingsWidget')
    check(widget.key == 'backup' and widget.settings is handler, 'the widget keeps its key and its settings handler')
    check(widget.uuid == UUID and widget.instance_id == UUID, 'uuid and instance id are the uuid of the extension, got %s %s' % (widget.uuid, widget.instance_id))
    check(build(DEFAULTS, handler_class=OtherHandler)[0].instance_id == 'instance-7', 'the instance id is the handler\'s')
    check(handler.bind_calls == [] and handler.set_calls == [], 'building it binds and sets nothing')

    # W2. Two buttons in a centred box, with the labels and tooltips of the schema's "buttons", in order.
    box = widget.content_widget
    buttons = box.get_children()
    check(isinstance(box, Gtk.Box) and box.get_orientation() == Gtk.Orientation.HORIZONTAL and box.get_halign() == Gtk.Align.CENTER,
          'the buttons are in a centred horizontal box')
    check([type(b) for b in buttons] == [Gtk.Button, Gtk.Button], 'two Gtk.Buttons, got %s' % [type(b).__name__ for b in buttons])
    check([b.get_label() for b in buttons] == LABELS == [spec['label'] for spec in item['buttons']], 'the labels are the schema\'s, in order: got %s' % [b.get_label() for b in buttons])
    check([b.get_tooltip_text() for b in buttons] == [spec['tooltip'] for spec in item['buttons']], 'the tooltips are the schema\'s, in order')
    # An item without usable "buttons" costs the tooltips, not the page: __init__ must not raise.
    for label, bad in (('no "buttons"', {k: v for k, v in item.items() if k != 'buttons'}), ('"buttons" a string', dict(item, buttons='x')),
                       ('buttons without tooltips', dict(item, buttons=[{'label': 'A'}, {'label': 'B'}])), ('one button', dict(item, buttons=item['buttons'][:1]))):
        captured = io.StringIO()
        try:
            with contextlib.redirect_stderr(captured):
                built = build(DEFAULTS, info=bad)[0]
        except Exception as e:
            check(False, '%s: __init__ raised %r' % (label, e))
            continue
        kids = built.content_widget.get_children()
        check([b.get_label() for b in kids] == LABELS and [b.get_tooltip_text() for b in kids] == [None, None],
              '%s: the two buttons with the plain labels and no tooltips' % label)
        check('"buttons"' in captured.getvalue(), '%s: logged, got %r' % (label, captured.getvalue()))

    # W3. The dialogs, built and inspected, never shown (realize() makes no window appear).
    def pump_until(condition, seconds=5):
        """Runs the main loop until condition() is true, for at most seconds."""
        deadline = time.monotonic() + seconds
        while not condition() and time.monotonic() < deadline:
            while Gtk.events_pending():
                Gtk.main_iteration()
            time.sleep(0.01)

    # A chooser takes the folder it is given after an asynchronous query of that folder: until then
    # get_current_folder() gives None.
    save = widget._save_dialog('window-memory-backup-2025-01-31.json', documents)
    save.realize()
    pump_until(lambda: save.get_current_folder() is not None)
    check(save.get_action() == Gtk.FileChooserAction.SAVE and save.get_do_overwrite_confirmation(), 'the export chooser saves, and asks before it overwrites')
    check(save.get_current_name() == 'window-memory-backup-2025-01-31.json' and save.get_current_folder() == documents,
          'the export chooser suggests the name and the folder, got %r' % save.get_current_folder())
    check(save.get_widget_for_response(Gtk.ResponseType.ACCEPT).has_default() and save.get_widget_for_response(Gtk.ResponseType.CANCEL) is not None,
          'the export chooser has Cancel and Save, Save the default')
    check(not save.get_mapped(), 'the export chooser was not shown')
    # The import chooser starts in the folder the export suggests, shows *.json first and can show every file.
    opener = widget._open_dialog(documents)
    opener.realize()
    pump_until(lambda: opener.get_current_folder() is not None)
    filters = [f.to_gvariant().unpack() for f in opener.list_filters()]
    check(opener.get_action() == Gtk.FileChooserAction.OPEN and filters == [('JSON files', [(0, '*.json')]), ('All files', [(0, '*')])]
          and opener.get_filter() is opener.list_filters()[0],
          'the import chooser opens, filtered to *.json, with "All files" second: %s' % filters)
    check(opener.get_current_folder() == documents, 'the import chooser starts in the folder of the export, got %r' % opener.get_current_folder())
    check(not opener.get_mapped(), 'the import chooser was not shown')
    question = widget._replace_dialog('Replace?', LOST)
    cancel, replace = question.get_widget_for_response(Gtk.ResponseType.CANCEL), question.get_widget_for_response(Gtk.ResponseType.ACCEPT)
    check(question.get_property('message-type') == Gtk.MessageType.WARNING and question.get_property('text') == 'Replace?'
          and question.get_property('secondary-text') == LOST, 'the confirmation shows the question and the warning')
    check(cancel.get_label() == '_Cancel' and replace.get_label() == '_Replace' and cancel.has_default(), 'the confirmation has Cancel and Replace, Cancel the default')
    check(replace.get_style_context().has_class('destructive-action') and not cancel.get_style_context().has_class('destructive-action'),
          'Replace, and only Replace, is in the destructive style')
    failed = widget._message_dialog(SAVE_FAILED, 'Disk full.', True)
    saved = widget._message_dialog('Backup saved.', None, False)
    check(failed.get_property('message-type') == Gtk.MessageType.ERROR and failed.get_property('secondary-text') == 'Disk full.'
          and saved.get_property('message-type') == Gtk.MessageType.INFO and saved.get_property('secondary-text') is None
          and saved.get_widget_for_response(Gtk.ResponseType.OK) is not None, 'an error is an error dialog with the reason, a success an info dialog, each with OK')
    for dialog in (save, opener, question, failed, saved):
        dialog.destroy()

    # W4. Export: the chooser is asked for window-memory-backup-<local date>.json in Documents; the file
    # has the handler's values and the state file as saved, mode 0600; the message counts both.
    exports = os.path.join(work, 'exports')
    os.mkdir(exports)
    out = os.path.join(exports, 'backup.json')
    write_file(STATE, state_of(1, 2))
    exporter, _ = build(CHANGED)
    asked = Asked(exporter, save_path=out)
    before = time.time()
    click(export_button(exporter), asked)
    after = time.time()
    names = set('window-memory-backup-%s.json' % time.strftime('%Y-%m-%d', time.localtime(t)) for t in (before, after))
    check(len(asked.saves) == 1 and asked.saves[0][0] in names and asked.saves[0][1] == documents,
          'the chooser is asked for %s in %s, got %s' % (sorted(names), documents, asked.saves))
    check(asked.messages == [('Backup saved: 12 settings, 2 remembered windows.', None, False)], 'the export message, got %s' % asked.messages)
    check(os.path.isfile(out) and mode_of(out) == 0o600, 'the backup is written with mode 0600')
    raw = read_text(out) if os.path.isfile(out) else ''
    backup = json.loads(raw or 'null') or {}
    check(raw == json.dumps(backup, indent=2, ensure_ascii=False) + '\n', 'the file is indented by 2, keeps text outside ASCII, and ends with a newline')
    check(list(backup) == ['format', 'version', 'created', 'extensionVersion', 'settings', 'state']
          and (backup.get('format'), backup.get('version'), backup.get('extensionVersion')) == ('window-memory-backup', 1, real_version),
          'format window-memory-backup, version 1, and the version of metadata.json')
    try:
        created = calendar.timegm(time.strptime(backup.get('created'), '%Y-%m-%dT%H:%M:%SZ'))
    except (TypeError, ValueError):
        created = None
    check(created is not None and int(before) <= created <= after, 'created is the UTC time of the export, got %r' % backup.get('created'))
    check(list(backup.get('settings', {})) == STORED and backup.get('settings') == {key: CHANGED[key] for key in STORED}, 'the settings are the handler\'s values, in the schema order')
    check(backup.get('state') == state_of(1, 2), 'the state is the state file as saved')
    # Cancelled: nothing is written and nothing is said.
    cancelled = Asked(exporter, save_path=None)
    click(export_button(exporter), cancelled)
    check(cancelled.saves and cancelled.messages == [] and os.listdir(exports) == ['backup.json'], 'a cancelled export writes nothing and says nothing')
    # A state file that cannot be read: no windows, and the message says so.
    write_file(STATE, '{broken')
    unread = Asked(exporter, save_path=os.path.join(exports, 'no-windows.json'))
    click(export_button(exporter), unread)
    check(json.loads(read_text(os.path.join(exports, 'no-windows.json')))['state'] == EMPTY_STATE, 'an unreadable state file exports no windows')
    check(unread.messages == [('Backup saved: 12 settings, 0 remembered windows.',
                               'The remembered windows could not be read (the state file is not valid JSON), so none were saved.', False)],
          'the message says the windows could not be read, got %s' % unread.messages)
    # No state file yet: a success with no windows, and the message says that none is remembered yet.
    os.remove(STATE)
    fresh = Asked(exporter, save_path=os.path.join(exports, 'no-state-file.json'))
    click(export_button(exporter), fresh)
    check(json.loads(read_text(os.path.join(exports, 'no-state-file.json')))['state'] == EMPTY_STATE, 'with no state file the backup holds no windows')
    check(fresh.messages == [('Backup saved: 12 settings, 0 remembered windows.', 'No windows are remembered yet.', False)],
          'with no state file the message says no window is remembered yet, got %s' % fresh.messages)
    # A write that fails: an error dialog with the reason; nothing is created.
    nowhere = os.path.join(work, 'no-such-folder', 'backup.json')
    failing = Asked(exporter, save_path=nowhere)
    click(export_button(exporter), failing)
    check(failing.messages == [(SAVE_FAILED, '%s cannot be written: No such file or directory.' % nowhere, True)], 'a failed write: %s' % failing.messages)
    check(not os.path.exists(os.path.dirname(nowhere)), 'a failed write creates nothing')
    # A setting the handler does not have: an error, no file.
    gappy, _ = build({key: value for key, value in CHANGED.items() if key != 'max-entries'})
    missing = Asked(gappy, save_path=os.path.join(exports, 'gappy.json'))
    click(export_button(gappy), missing)
    check(missing.messages == [(SAVE_FAILED, 'The settings file has no value for "max-entries".', True)] and not os.path.exists(os.path.join(exports, 'gappy.json')),
          'a setting missing from the handler: an error and no file, got %s' % missing.messages)

    # W5. Import. The backup of W4 (CHANGED, windows 1 and 2) goes into a handler with the defaults,
    # while the state file holds one window. Asked first, in a chooser that starts in Documents; then
    # the staging file is written. The backup's max-entries (750) is larger than the current one
    # (500), so it is set before importState is called; the other settings that differ are set after
    # the call, in the schema order. After the call the page removes the staging file itself (the
    # fake extension never does).
    write_file(STATE, state_of(9))
    importer, target = build(DEFAULTS)
    proxy = FakeProxy(handler=target)
    bus.proxy = proxy
    asked = Asked(importer, open_path=out)
    click(import_button(importer), asked)
    check(asked.opens == [(documents,)], 'the open chooser is asked to start in %s, got %s' % (documents, asked.opens))
    local = time.strftime('%Y-%m-%d %H:%M', time.localtime(created or 0))
    check(asked.questions == [('Replace the settings and the 1 remembered window with this backup from %s?' % local, LOST)],
          'the confirmation counts the current windows and shows the local time, got %s' % asked.questions)
    check(proxy.calls == [('(sss)', 'importState', UUID, UUID)] and proxy.kwargs == [{'timeout': 20000}],
          'importState is called like the plain button calls its callback, with a 20000 ms timeout, got %s %s' % (proxy.calls, proxy.kwargs))
    check(proxy.seen == [(0o600, state_of(1, 2), 1)] and target.set_calls[:1] == [('max-entries', 750)],
          'when importState runs, the staging file is there, 0600, with the backup\'s state, and only the larger max-entries was set '
          '(%s settings set)' % (proxy.seen[0][2] if proxy.seen and proxy.seen[0] else None))
    differing = [key for key in STORED if CHANGED[key] != DEFAULTS[key]]
    later = [key for key in differing if key != 'max-entries']
    check(target.set_calls == [('max-entries', 750)] + [(key, CHANGED[key]) for key in later],
          'max-entries first, then set_value for the %d other settings that differ, in the schema order, got %s'
          % (len(later), [key for key, _ in target.set_calls]))
    check(target.values == {key: CHANGED[key] for key in STORED}, 'the handler now has the backup\'s settings')
    check(asked.messages == [('Restored 12 settings and 2 remembered windows.', None, False)], 'the restore message, got %s' % asked.messages)
    check(not os.path.exists(STAGING), 'after a call that succeeded the page removes the staging file')
    check(json.loads(read_text(STATE)) == state_of(9), 'the widget never writes the state file itself')
    check(len(bus.calls) == 1 and bus.calls[0] == ((Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
                                                    None, 'org.Cinnamon', '/org/Cinnamon', 'org.Cinnamon', None), {}),
          'the proxy is made like xlet-settings.py:162-163 makes it, got %s' % bus.calls)

    def importing(backup_path, values=DEFAULTS, replace=True, error=None, handler_class=FakeHandler):
        """A fresh widget imports backup_path; returns (asked, proxy, handler)."""
        widget, handler = build(values, handler_class=handler_class)
        bus.proxy = FakeProxy(handler=handler, error=error)
        asked = Asked(widget, open_path=backup_path, replace=replace)
        click(import_button(widget), asked)
        return asked, bus.proxy, handler

    def said(asked):
        """The one message shown, its text and detail as one text, and whether it is an error."""
        if len(asked.messages) != 1:
            return None
        text, detail, error = asked.messages[0]
        return ' '.join(part for part in (text, detail) if part), error

    # Settings the schema does not know are left out, and the message says how many.
    with open(out, encoding='utf-8') as f:
        extended = json.load(f)
    extended['settings'].update({'from-a-newer-version': 1, 'another-one': 'x'})
    asked, proxy, handler = importing(write_file(os.path.join(work, 'extended.json'), extended))
    check(asked.messages == [('Restored 12 settings and 2 remembered windows.', '2 settings in the backup are not known to this version of Window Memory and were left out.', False)]
          and 'from-a-newer-version' not in handler.values, 'unknown settings are left out and counted, got %s' % asked.messages)
    check(not os.path.exists(STAGING), 'the page removed the staging file')

    # The windows the message counts are the ones the extension keeps: entries it cannot use (invalid fields), pop-up
    # entries, and a second entry of an id are dropped by parseState (lib/store.js), so they are not counted. The
    # same cases are in the table of tests/store.test.js for parseState.
    def entry_with(number, **over):
        return dict(window(number), **over)
    mixed = [entry_with(1), entry_with(2), entry_with(1, title='again'), entry_with(3, role='pop-up'), {'id': 'x'},
             entry_with(4, maximized='no'), entry_with(5, rel={'x': 1, 'y': 2}), entry_with(6, lastSeen='soon'),
             entry_with(7, workspace=None), entry_with(8, minimized=None)]
    check([w['id'] for w in module.kept_windows(mixed)] == ['w1', 'w2', 'w7'],
          'kept_windows keeps entries 1, 2 and 7 (a missing minimized field is allowed, a null one is not), got %s' % [w['id'] for w in module.kept_windows(mixed)])
    check(module.kept_windows([]) == [] and module.kept_windows([1, None, 'x', []]) == [], 'kept_windows drops what is not an entry')
    with open(out, encoding='utf-8') as f:
        messy = json.load(f)
    messy['state']['windows'] = mixed[:5]
    asked, proxy, handler = importing(write_file(os.path.join(work, 'messy.json'), messy))
    check(asked.messages == [('Restored 12 settings and 2 remembered windows.', None, False)],
          'the message counts the 2 windows the extension keeps of the 5 in the backup, got %s' % asked.messages)

    # A backup whose max-entries is smaller than the current one, or the same: nothing is set before
    # the call; max-entries is set after it with the other settings that differ, in the schema order
    # (the same value is not set at all).
    lower_paths = {}
    for label, limit in (('smaller', 100), ('the same', 500)):
        with open(out, encoding='utf-8') as f:
            lower = json.load(f)
        lower['settings']['max-entries'] = limit
        lower_paths[limit] = write_file(os.path.join(work, 'limit-%d.json' % limit), lower)
        asked, proxy, handler = importing(lower_paths[limit])
        wanted = [(key, lower['settings'][key]) for key in STORED if lower['settings'][key] != DEFAULTS[key]]
        check(len(proxy.seen) == 1 and proxy.seen[0] and proxy.seen[0][2] == 0, 'max-entries %s: no setting was set when importState ran' % label)
        check(handler.set_calls == wanted, 'max-entries %s: the settings that differ are set after the call, in the schema order, got %s'
              % (label, [key for key, _ in handler.set_calls]))
        check(handler.values['max-entries'] == limit and asked.messages == [('Restored 12 settings and 2 remembered windows.', None, False)],
              'max-entries %s: the backup is restored, got %s' % (label, asked.messages))
        check(not os.path.exists(STAGING), 'max-entries %s: the page removed the staging file' % label)

    # The current max-entries as cinnamon-settings stores it once it was changed in the dialog: a
    # float. A backup limit larger than it is set before the call; an equal one is not set, and a
    # smaller one is set after the call, in its place in the schema order.
    for label, current_limit, before_call, wanted in (
            ('larger than 500.0', 500.0, 1, [('max-entries', 750)] + [(key, CHANGED[key]) for key in later]),
            ('equal to 750.0', 750.0, 0, [(key, CHANGED[key]) for key in later]),
            ('smaller than 1000.0', 1000.0, 0, [(key, CHANGED[key]) for key in differing])):
        asked, proxy, handler = importing(out, values=dict(DEFAULTS, **{'max-entries': current_limit}))
        seen_sets = proxy.seen[0][2] if len(proxy.seen) == 1 and proxy.seen[0] else None
        check(seen_sets == before_call and handler.set_calls == wanted,
              'the backup limit is %s: %d setting set before the call wanted, got %s; the sets %s'
              % (label, before_call, seen_sets, [key for key, _ in handler.set_calls]))
        check(handler.values['max-entries'] == 750 and asked.messages == [('Restored 12 settings and 2 remembered windows.', None, False)],
              'the backup limit is %s: restored, got %s' % (label, asked.messages))

    # The errors of a failed call, made as GDBus makes them (checked against a peer-to-peer
    # connection): an error reply is a remote error with the D-Bus name of the
    # reply (the extension's JS error, or the bus's NoReply); a call that times out, or meets a
    # closed connection, is a local Gio.IOErrorEnum.TIMED_OUT or CLOSED.
    def reply(name, text):
        return Gio.DBusError.new_for_dbus_error(name, text)

    rejected = reply('org.gnome.gjs.JSError.Error', '[window-memory] import rejected: %s does not exist' % STAGING)
    rejected_reason = '[window-memory] import rejected: %s does not exist.' % STAGING
    not_running = reply('org.gnome.gjs.JSError.TypeError', 'obj is null')
    no_reply = reply('org.freedesktop.DBus.Error.NoReply', 'Message recipient disconnected from message bus without replying')
    timed_out = GLib.Error.new_literal(Gio.io_error_quark(), 'Timeout was reached', Gio.IOErrorEnum.TIMED_OUT)
    closed = GLib.Error.new_literal(Gio.io_error_quark(), 'The connection is closed', Gio.IOErrorEnum.CLOSED)
    raised = dict(DEFAULTS, **{'max-entries': 750})

    # A definite failure: the extension threw (before any change), Window Memory is not running, or
    # an error that is no timeout. The raised max-entries is set back, nothing else is set, the
    # staging file is removed, and the error gives the reason without the GDBus prefix.
    for label, error, reason in (('the extension refused', rejected, rejected_reason),
                                 ('Window Memory is not running', not_running, NOT_RUNNING),
                                 ('a local error that is no timeout', GLib.Error('no such name'), 'no such name.')):
        asked, proxy, handler = importing(out, error=error)
        check(len(proxy.seen) == 1 and proxy.seen[0] and proxy.seen[0][1] == state_of(1, 2) and proxy.seen[0][2] == 1,
              '%s: the call was made with the staging file in place, after max-entries was raised' % label)
        check(handler.set_calls == [('max-entries', 750), ('max-entries', 500)] and handler.values == DEFAULTS,
              '%s: max-entries is set back to 500 and nothing else is set, got %s' % (label, handler.set_calls))
        check(not os.path.exists(STAGING), '%s: the staging file is removed' % label)
        check(asked.messages == [(RESTORE_FAILED, NOT_HANDED + reason + ' The settings were not changed.', True)],
              '%s: the error, got %s' % (label, asked.messages))
    asked, proxy, handler = importing(lower_paths[100], error=rejected)
    check(proxy.calls and handler.set_calls == [] and not os.path.exists(STAGING)
          and asked.messages == [(RESTORE_FAILED, NOT_HANDED + rejected_reason + ' The settings were not changed.', True)],
          'a definite failure with a smaller max-entries in the backup: no setting set at all, got %s %s' % (handler.set_calls, asked.messages))

    # An unknown outcome: no answer in time, a closed connection, or NoReply from the bus. The
    # windows may have been replaced, so the raised max-entries stays, no other setting is set, the
    # staging file is removed, and the message is UNCONFIRMED.
    for label, error in (('a timeout', timed_out), ('a closed connection', closed), ('NoReply', no_reply)):
        asked, proxy, handler = importing(out, error=error)
        check(len(proxy.calls) == 1 and handler.set_calls == [('max-entries', 750)] and handler.values == raised,
              '%s: max-entries stays 750, nothing is set back and nothing else is set, got %s' % (label, handler.set_calls))
        check(not os.path.exists(STAGING), '%s: the staging file is removed' % label)
        check(said(asked) == (UNCONFIRMED, True), '%s: the message, got %s' % (label, asked.messages))
    asked, proxy, handler = importing(lower_paths[100], error=timed_out)
    check(handler.set_calls == [] and said(asked) == (UNCONFIRMED, True),
          'a timeout with a smaller max-entries in the backup: no setting set at all, got %s %s' % (handler.set_calls, asked.messages))

    # max-entries cannot be raised: the call is not made, the staging file is removed, nothing else
    # changes, and the error says what was not changed.
    asked, proxy, handler = importing(out, handler_class=EarlyFailsHandler)
    check(proxy.calls == [] and handler.set_calls == [] and handler.values == DEFAULTS and not os.path.exists(STAGING),
          'the early max-entries fails: no call, no setting set, no staging file, got %s' % handler.set_calls)
    check(asked.messages == [(RESTORE_FAILED, 'The setting "max-entries" could not be set to 750 before the restore: No space left on device. '
                                              'The remembered windows and the other settings were not changed.', True)],
          'the early max-entries fails: the error, got %s' % asked.messages)
    # After a definite failure max-entries cannot be set back: the error says that it stayed raised.
    asked, proxy, handler = importing(out, error=rejected, handler_class=RollbackFailsHandler)
    check(len(proxy.calls) == 1 and handler.set_calls == [('max-entries', 750)] and handler.values == raised and not os.path.exists(STAGING),
          'the set-back fails: max-entries stays 750, nothing else is set, no staging file, got %s' % handler.set_calls)
    check(asked.messages == [(RESTORE_FAILED, NOT_HANDED + rejected_reason + ' The setting "max-entries" was set to 750 for the restore and '
                                              'could not be set back to 500: No space left on device. The remembered windows and the other '
                                              'settings were not changed.', True)],
          'the set-back fails: the error, got %s' % asked.messages)

    # A setting that fails after the call succeeded: the windows are restored, so nothing is set
    # back (max-entries stays raised) and the settings after it are not set. The message says that
    # the windows were restored, names the setting and the reason, and says that importing the same
    # backup again is safe. The sets come in this order: max-entries before the call, then the
    # others that differ, in the schema order.
    order = ['max-entries'] + later
    for failing, rest in (('match-by-title', ' 2 settings after it were not set either.'), ('forget-focused', '')):
        asked, proxy, handler = importing(out, handler_class=type('Fails', (SettingFailsHandler,), {'fail_key': failing}))
        before = order[:order.index(failing)]
        check(len(proxy.calls) == 1 and handler.set_calls == [(key, CHANGED[key]) for key in before]
              and handler.values == dict(DEFAULTS, **{key: CHANGED[key] for key in before}) and not os.path.exists(STAGING),
              '%s fails after the call: the settings before it stay set, the ones after it are not set, got %s'
              % (failing, [key for key, _ in handler.set_calls]))
        check(asked.messages == [('Restored 2 remembered windows, but not all the settings.',
                                  'The setting "%s" could not be set: No space left on device.%s Importing the same backup again is safe.'
                                  % (failing, rest), True)],
              '%s fails after the call: the message, got %s' % (failing, asked.messages))

    def nothing_changed(label, asked, proxy, handler, questions=0):
        check(len(asked.questions) == questions and proxy.calls == [] and handler.set_calls == [] and not os.path.exists(STAGING),
              '%s: no staging file, no importState call, no setting set' % label)

    # Replace not chosen; the open chooser cancelled.
    asked, proxy, handler = importing(out, replace=False)
    nothing_changed('Cancel in the confirmation', asked, proxy, handler, questions=1)
    check(asked.messages == [], 'Cancel says nothing')
    asked, proxy, handler = importing(None)
    nothing_changed('a cancelled chooser', asked, proxy, handler)
    check(asked.messages == [], 'a cancelled chooser says nothing')
    # A bad backup, and a file over 20 MB: an error naming the problem, before the confirmation.
    extended['settings']['max-entries'] = 1
    for label, backup_path, reason in (('a bad setting', write_file(os.path.join(work, 'bad-setting.json'), extended),
                                        'The setting "max-entries" in the backup is outside the range 10 to 5000.'),
                                       ('a file over 20 MB', os.path.join(work, 'big.json'), TOO_LARGE)):
        if label == 'a file over 20 MB':
            with open(backup_path, 'wb') as f:
                f.truncate(LIMIT + 1)
        asked, proxy, handler = importing(backup_path)
        nothing_changed(label, asked, proxy, handler)
        check(asked.messages == [(RESTORE_FAILED, reason + ' Nothing was changed.', True)], '%s: the error names it, got %s' % (label, asked.messages))
    # A setting the handler does not have: refused before any change.
    asked, proxy, handler = importing(out, values={key: value for key, value in DEFAULTS.items() if key != 'max-entries'})
    nothing_changed('a setting missing from the handler', asked, proxy, handler, questions=1)
    check(asked.messages == [(RESTORE_FAILED, 'The settings file has no value for "max-entries". Nothing was changed.', True)], 'got %s' % asked.messages)
    # No session bus at all: the proxy cannot be made, which is before max-entries is raised, so no
    # call is made, the staging file is removed and nothing is set.
    bus.error = GLib.Error('no bus')
    asked, proxy, handler = importing(out)
    bus.error = None
    check(proxy.calls == [] and not os.path.exists(STAGING) and handler.set_calls == []
          and asked.messages == [(RESTORE_FAILED, 'The remembered windows could not be handed to Window Memory: no bus. The settings were not changed.', True)],
          'no bus: no call, the staging file removed, no setting set, got %s' % asked.messages)
    # The staging file cannot be written (a file where the folder should be): no call, nothing set.
    shutil.rmtree(STATE_DIR)
    write_file(STATE_DIR, 'not a folder')
    asked, proxy, handler = importing(out)
    os.remove(STATE_DIR)
    check(proxy.calls == [] and handler.set_calls == [] and asked.messages and asked.messages[-1][0] == RESTORE_FAILED
          and asked.messages[-1][1].startswith('The remembered windows could not be handed to Window Memory: '),
          'a staging file that cannot be written: no call, no setting set, an error, got %s' % asked.messages)
    check(asked.questions and 'the 0 remembered windows' in asked.questions[0][0], 'a state file that cannot be read counts 0 windows')

    # W6. Whatever else goes wrong in a click is shown and logged, never raised into GTK.
    def broken():
        raise RuntimeError('broken on purpose')

    # Called directly: PyGObject swallows exceptions raised in signal handlers, so clicked() proves nothing here.
    for on_clicked, work_name, failure in (('_on_export_clicked', '_export', SAVE_FAILED), ('_on_import_clicked', '_import', RESTORE_FAILED)):
        widget, _ = build(DEFAULTS)
        asked = Asked(widget)
        setattr(widget, work_name, broken)
        captured = io.StringIO()
        try:
            with contextlib.redirect_stderr(captured):
                getattr(widget, on_clicked)()
        except Exception as e:
            check(False, '%s raised %r' % (on_clicked, e))
        check(asked.messages == [(failure, 'broken on purpose.', True)] and captured.getvalue() == 'window-memory: %s broken on purpose.\n' % failure,
              '%s: an unexpected error is shown and logged, got %s' % (on_clicked, asked.messages))

    # W7. user_config_dir() is GLib.get_user_config_dir(), which extension.js uses for STATE_DIR: here,
    # and in fresh processes (GLib reads the environment once) with XDG_CONFIG_HOME set, empty and unset.
    check(module.user_config_dir() == GLib.get_user_config_dir() == CONFIG, 'here both give the temporary XDG_CONFIG_HOME')
    probe = 'from gi.repository import GLib; print(GLib.get_user_config_dir())'
    for changes in ({'XDG_CONFIG_HOME': os.path.join(work, 'probe-config')},
                    {'XDG_CONFIG_HOME': '', 'HOME': os.path.join(work, 'probe-home')},
                    {'XDG_CONFIG_HOME': None, 'HOME': os.path.join(work, 'probe-home')}):
        env = dict(os.environ)
        for key, value in changes.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        run = subprocess.run([sys.executable, '-B', '-c', probe], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        check(run.returncode == 0 and run.stdout.strip() == module.user_config_dir(env),
              'with %s GLib says %r, user_config_dir %r' % (changes, run.stdout.strip(), module.user_config_dir(env)))

    # W8. No widget above got a real proxy; the real constructor is put back.
    Gio.DBusProxy.new_for_bus_sync = real_new_for_bus_sync
    check(all(w._proxy is None or isinstance(w._proxy, FakeProxy) for w in made), 'no real DBusProxy was created')
    finish()


if mode == 'functions':
    functions_checks()
elif mode == 'widget':
    widget_checks()
else:
    print('unknown mode %r: functions or widget' % mode)
    sys.exit(2)
