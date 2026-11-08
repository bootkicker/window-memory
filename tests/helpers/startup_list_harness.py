# SPDX-License-Identifier: GPL-3.0-or-later
# Test-only: checks the file logic of the "Startup apps" tab (startup_list.py): which
# startup entries are listed, the switch, Remove, the pick of an application (added, already on,
# switched on, restored) with its Undo, and the custom entry. No GTK widget and no display are
# needed: the module imports GLib only, and the last check proves that Gtk was not loaded.
# Run by tests/startup-list.test.js.
# Usage: python3 -B startup_list_harness.py <extension dir>
# Exit codes: 0 all checks passed, 1 a check failed, 77 cannot run here (no python gi / GLib).
#
# Nothing here touches the real autostart folder or the real configuration: before gi is imported
# XDG_CONFIG_HOME and XDG_CONFIG_DIRS point at a temp folder, and every folder the functions work
# in is a temp folder passed explicitly. Every desktop file is made up here.
import atexit
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import contextlib

SKIP = 77

work = tempfile.mkdtemp(prefix='window-memory-startup-harness-')
atexit.register(shutil.rmtree, work, True)  # also when a check raises
# GLib reads these once: set before gi is imported. LANGUAGE=C keeps the language of the session
# out of the name checks.
os.environ['XDG_CONFIG_HOME'] = os.path.join(work, 'real-config-stand-in')
os.environ['XDG_CONFIG_DIRS'] = os.path.join(work, 'real-system-stand-in')
os.environ['XDG_DATA_HOME'] = os.path.join(work, 'data')
os.environ['LANGUAGE'] = 'C'

try:
    import gi
    from gi.repository import GLib
except Exception as e:  # ImportError, ValueError
    print('cannot run: %s' % e)
    sys.exit(SKIP)

ext_dir = sys.argv[1]
spec = importlib.util.spec_from_file_location('startup_list', os.path.join(ext_dir, 'startup_list.py'))
sl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sl)

failures = []
counter = [0]


def check(ok, what):
    if not ok:
        failures.append(what)
        print('FAIL: %s' % what)


def fresh():
    """A new empty user autostart folder and a system autostart folder, in their own temp folder."""
    counter[0] += 1
    base = os.path.join(work, 'case-%d' % counter[0])
    user = os.path.join(base, 'user', 'autostart')
    system = os.path.join(base, 'system', 'autostart')
    os.makedirs(user)
    os.makedirs(system)
    return user, system


def write(folder, basename, text):
    path = os.path.join(folder, basename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return path


def read(path):
    with open(path, 'rb') as f:
        return f.read()


def keyfile(path):
    kf = GLib.KeyFile.new()
    kf.load_from_file(path, GLib.KeyFileFlags.KEEP_TRANSLATIONS | GLib.KeyFileFlags.KEEP_COMMENTS)
    return kf


def value(path, key, default=None):
    try:
        return keyfile(path).get_string('Desktop Entry', key)
    except GLib.Error:
        return default


def flag(path, key, default=None):
    try:
        return keyfile(path).get_boolean('Desktop Entry', key)
    except GLib.Error:
        return default


def desktop(name, exec_='true', extra=''):
    return '[Desktop Entry]\nType=Application\nName=%s\nExec=%s\n%s' % (name, exec_, extra)


def listing(user, system, blacklist=(), **kw):
    with contextlib.redirect_stderr(io.StringIO()) as err:
        entries = sl.gather_entries(user, [system], set(blacklist), **kw)
    return entries, err.getvalue()


def names(entries):
    return [e.name for e in entries]


NEMO = desktop('Nemo', 'nemo %U', 'Comment=Files\nIcon=nemo\nName[fr]=Fichiers\nX-Custom=keep me\n')

# ---- 1. gather_entries ------------------------------------------------------------------------

user, system = fresh()
write(user, 'mine.desktop', desktop('Mine', 'mine --go', 'Comment=My own\nIcon=mine\nX-GNOME-Autostart-Delay=7\n'))
write(system, 'sysapp.desktop', desktop('Zeta system', 'zeta', 'X-GNOME-Autostart-enabled=false\n'))
write(system, 'both.desktop', desktop('Both system', 'both-sys'))
write(user, 'both.desktop', desktop('Both user', 'both-user', 'X-GNOME-Autostart-enabled=false\n'))
entries, err = listing(user, system)
by = {e.basename: e for e in entries}
check(sorted(by) == ['both.desktop', 'mine.desktop', 'sysapp.desktop'], 'gather merges user and system files: %r' % sorted(by))
check(names(entries) == ['Both user', 'Mine', 'Zeta system'], 'gather sorts by name: %r' % names(entries))
m = by['mine.desktop']
check((m.name, m.comment, m.command, m.icon, m.delay, m.enabled, m.system) ==
      ('Mine', 'My own', 'mine --go', 'mine', 7, True, False), 'user-only entry fields: %r' % (vars(m),))
check(m.user_path == os.path.join(user, 'mine.desktop'), 'user_path of a user file')
s = by['sysapp.desktop']
check((s.system, s.enabled, s.user_path, s.delay, s.icon) == (True, False, None, 0, None),
      'system-only entry: system, off from the file, no user_path, delay 0, no icon: %r' % (vars(s),))
b = by['both.desktop']
check((b.system, b.enabled, b.command) == (True, False, 'both-user') and b.user_path == os.path.join(user, 'both.desktop'),
      'a user file overrides the system file of the same name and the entry knows both: %r' % (vars(b),))
check(err == '', 'nothing logged for readable files: %r' % err)


# hidden, NotShowIn / OnlyShowIn, blacklist
user, system = fresh()
write(user, 'removed.desktop', desktop('Removed', 'x', 'Hidden=true\nX-GNOME-Autostart-enabled=false\n'))
write(system, 'removed.desktop', desktop('Removed system'))
write(system, 'notcin.desktop', desktop('Not Cinnamon', 'x', 'NotShowIn=X-Cinnamon;\n'))
write(system, 'notgnome.desktop', desktop('Not Gnome', 'x', 'NotShowIn=GNOME;KDE;\n'))
write(system, 'onlykde.desktop', desktop('Only KDE', 'x', 'OnlyShowIn=KDE;\n'))
write(system, 'onlycin.desktop', desktop('Only Cinnamon', 'x', 'OnlyShowIn=X-Cinnamon;\n'))
write(system, 'onlygnome.desktop', desktop('Only GNOME', 'x', 'OnlyShowIn=GNOME;\n'))
write(system, 'nodisplay.desktop', desktop('No display', 'x', 'NoDisplay=true\n'))
write(system, 'black.desktop', desktop('Blacklisted'))
write(user, 'blackuser.desktop', desktop('Blacklisted user'))
write(system, 'blackuser.desktop', desktop('Blacklisted user system'))
write(user, 'plain.desktop', desktop('Plain'))
entries, err = listing(user, system, {'black', 'blackuser'})
check(sorted(e.basename for e in entries) == ['notgnome.desktop', 'onlycin.desktop', 'onlygnome.desktop', 'plain.desktop'],
      'hidden, NotShowIn=X-Cinnamon, OnlyShowIn without Cinnamon/GNOME, NoDisplay and blacklisted are not listed: %r'
      % sorted(e.basename for e in entries))
entries, _ = listing(user, system, (), desktop='KDE')
check('onlykde.desktop' in [e.basename for e in entries] and 'notgnome.desktop' not in [e.basename for e in entries],
      'the desktop argument decides NotShowIn / OnlyShowIn')

# a corrupt file is skipped and logged to stderr
user, system = fresh()
write(user, 'bad.desktop', 'this is not a key file\n[[[ broken\n')
write(system, 'good.desktop', desktop('Good'))
entries, err = listing(user, system)
check([e.basename for e in entries] == ['good.desktop'], 'a corrupt file is skipped: %r' % [e.basename for e in entries])
check('bad.desktop' in err, 'the skipped file is logged to stderr: %r' % err)

# an empty .desktop file is listed under its file name and breaks nothing
user, system = fresh()
write(user, 'empty.desktop', '')
write(user, 'other.desktop', desktop('Other'))
write(system, 'sys.desktop', desktop('Sys'))
entries, err = listing(user, system)
by = {e.basename: e for e in entries}
check(sorted(by) == ['empty.desktop', 'other.desktop', 'sys.desktop'], 'an empty file is listed: %r' % sorted(by))
check(by['empty.desktop'].name == 'empty' and by['empty.desktop'].command == '' and by['empty.desktop'].enabled
      and by['empty.desktop'].delay == 0 and by['empty.desktop'].icon is None, 'an empty file: named by its file, no command, on: %r' % (vars(by['empty.desktop']),))
check(by['other.desktop'].name == 'Other' and by['sys.desktop'].name == 'Sys', 'the other entries are unaffected by an empty file')

# an unreadable (garbage) user file hides the system entry of the same name, and is logged (as
# the system tool does, which then does not load its entry for that name either)
user, system = fresh()
write(user, 'nemo.desktop', 'garbage [[[\n')
write(system, 'nemo.desktop', NEMO)
write(system, 'keep.desktop', desktop('Keep'))
entries, err = listing(user, system)
check([e.basename for e in entries] == ['keep.desktop'], 'a garbage user file hides its system entry: %r' % [e.basename for e in entries])
check('nemo.desktop' in err, 'and is logged: %r' % err)

# a corrupt system file is skipped and logged to stderr, the others are listed
user, system = fresh()
write(system, 'broken.desktop', '[[[ not a key file\n')
write(system, 'fine.desktop', desktop('Fine'))
write(user, 'mine.desktop', desktop('Mine'))
entries, err = listing(user, system)
check([e.basename for e in entries] == ['fine.desktop', 'mine.desktop'], 'a corrupt system file is skipped: %r' % [e.basename for e in entries])
check('broken.desktop' in err, 'the corrupt system file is logged to stderr: %r' % err)

# missing folders are not an error
entries, err = listing(os.path.join(work, 'nowhere'), os.path.join(work, 'nowhere-either'))
check(entries == [], 'missing folders give an empty list')

# a bad delay is 0; an entry without Name gets a readable name
user, system = fresh()
write(user, 'odd.desktop', '[Desktop Entry]\nType=Application\nExec=odd\nX-GNOME-Autostart-Delay=soon\n')
entries, err = listing(user, system)
check(entries[0].delay == 0 and entries[0].name == 'odd', 'bad delay is 0, missing Name falls back to the file name: %r' % (vars(entries[0]),))

# ---- 2. set_enabled ---------------------------------------------------------------------------

user, system = fresh()
sys_path = write(system, 'nemo.desktop', NEMO)
before = read(sys_path)
entry = listing(user, system)[0][0]
sl.set_enabled(user, entry, False)
override = os.path.join(user, 'nemo.desktop')
check(os.path.exists(override), 'set_enabled on a system entry creates the user override')
check(flag(override, 'X-GNOME-Autostart-enabled') is False, 'the override says enabled=false')
check(value(override, 'Exec') == 'nemo %U' and value(override, 'X-Custom') == 'keep me', 'the override is a copy of the system file')
check(keyfile(override).get_locale_string('Desktop Entry', 'Name', 'fr') == 'Fichiers', 'translated names survive in the override')
check(read(sys_path) == before, 'the system file is untouched')
entry2 = listing(user, system)[0][0]
check(entry2.enabled is False and entry2.system and entry2.user_path == override, 'the list shows it off with the override')
sl.set_enabled(user, entry2, True)
# As the system tool (cs_startup.py, save and user_equals_system): an override that now says what the
# system file says is deleted, so a switch off and on leaves no user file.
check(not os.path.exists(override), 'switching back on deletes the override that now equals the system file')
check(entry2.enabled is True and entry2.user_path is None, 'the entry object follows: on, no user file')
entry3 = listing(user, system)[0][0]
check(entry3.enabled is True and entry3.system and entry3.user_path is None, 'the list shows the system entry, on, without an override')
check(read(sys_path) == before, 'the system file is still untouched')

# The comparison is field by field, as user_equals_system: comments and keys it does not compare do not count,
# an edited field does.
COMMENTED = ('# Autostart file of a system service\n[Desktop Entry]\n# the name\nType=Application\nName=Example Tray\n'
             'Comment=Tray icon of a device\nExec=example-tray --window=hide\nIcon=example-tray\nX-GNOME-Autostart-Delay=2\n')
user, system = fresh()
sys_path = write(system, 'example-tray.desktop', COMMENTED)
entry = listing(user, system)[0][0]
sl.set_enabled(user, entry, False)
override = os.path.join(user, 'example-tray.desktop')
check(os.path.isfile(override) and b'# the name' in read(override), 'switching a commented system entry off: an override, comments kept')
sl.set_enabled(user, listing(user, system)[0][0], True)
check(not os.path.exists(override), 'switching it on again deletes the override although the system file has comments')
for what, extra in (('Exec', 'Exec=example-tray --other\n'), ('Name', 'Name=My Example Tray\n'), ('Comment', 'Comment=mine\n'),
                    ('delay', 'X-GNOME-Autostart-Delay=9\n'), ('Icon', 'Icon=other\n'), ('NoDisplay', 'NoDisplay=false\nX-x=1\n')):
    user, system = fresh()
    write(system, 'example-tray.desktop', COMMENTED)
    text = COMMENTED.replace('X-GNOME-Autostart-Delay=2\n', 'X-GNOME-Autostart-Delay=2\nX-GNOME-Autostart-enabled=false\n')
    key = extra.split('=')[0]
    lines = [line for line in text.split('\n') if not line.startswith(key + '=')]
    write(user, 'example-tray.desktop', '\n'.join(lines).rstrip('\n') + '\n' + extra)
    sl.set_enabled(user, listing(user, system)[0][0], True)
    kept = os.path.isfile(os.path.join(user, 'example-tray.desktop'))
    # NoDisplay=false is the default: it equals a system file without the key, so that override goes.
    check(kept == (what != 'NoDisplay'), 'an override with %s %s is %s' % (what, extra.strip(), 'kept' if what != 'NoDisplay' else 'deleted'))

# on a user-only file the other keys survive; the folder is created when missing
user, system = fresh()
upath = write(user, 'mine.desktop', desktop('Mine', 'mine', '# a comment\nName[de]=Meins\nX-Keep=1\n'))
entry = listing(user, system)[0][0]
sl.set_enabled(user, entry, False)
check(flag(upath, 'X-GNOME-Autostart-enabled') is False and value(upath, 'X-Keep') == '1', 'switch off keeps other keys')
check(keyfile(upath).get_locale_string('Desktop Entry', 'Name', 'de') == 'Meins', 'switch keeps translated names')
check(b'# a comment' in read(upath), 'switch keeps comments')
fresh_user = os.path.join(work, 'created', 'autostart')
user2, system2 = fresh()
sys_path = write(system2, 'later.desktop', desktop('Later'))
entry = listing(user2, system2)[0][0]
shutil.rmtree(user2)
sl.set_enabled(fresh_user, entry, False)
check(os.path.isfile(os.path.join(fresh_user, 'later.desktop')), 'set_enabled creates the autostart folder when it is missing')

# ---- 3. remove_entry --------------------------------------------------------------------------

user, system = fresh()
upath = write(user, 'mine.desktop', desktop('Mine'))
entry = listing(user, system)[0][0]
sl.remove_entry(user, entry)
check(not os.path.exists(upath), 'remove deletes a user-only file')
check(listing(user, system)[0] == [], 'and the list is empty')

user, system = fresh()
sys_path = write(system, 'nemo.desktop', NEMO)
before = read(sys_path)
entry = listing(user, system)[0][0]
sl.remove_entry(user, entry)
override = os.path.join(user, 'nemo.desktop')
check(os.path.exists(override) and flag(override, 'Hidden') is True and flag(override, 'X-GNOME-Autostart-enabled') is False,
      'remove of a system entry writes the user override with Hidden=true and enabled=false')
check(read(sys_path) == before, 'remove leaves the system file untouched')
check(listing(user, system)[0] == [], 'a removed system entry is not listed')

user, system = fresh()
write(system, 'nemo.desktop', NEMO)
write(user, 'nemo.desktop', desktop('Nemo mine', 'nemo', 'X-GNOME-Autostart-enabled=true\n'))
entry = listing(user, system)[0][0]
sl.remove_entry(user, entry)
check(os.path.exists(os.path.join(user, 'nemo.desktop')) and flag(os.path.join(user, 'nemo.desktop'), 'Hidden') is True,
      'remove of a user file that overrides a system entry hides it (the file stays)')

# ---- 4. add_application -----------------------------------------------------------------------

# a new entry
user, system = fresh()
apps = os.path.join(work, 'apps-%d' % counter[0])
os.makedirs(apps)
nemo_desktop = write(apps, 'nemo.desktop', NEMO)
nemo_bytes = read(nemo_desktop)
shutil.rmtree(user)  # the autostart folder is created when missing
r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
target = os.path.join(user, 'nemo.desktop')
check(r.action == 'added' and r.basename == 'nemo.desktop', 'new application: added: %r' % (vars(r),))
check(r.previous is None and r.written == read(target), 'added: previous None, written is the file content')
kf = keyfile(target)
check(kf.get_string('Desktop Entry', 'Exec') == 'nemo %U' and kf.get_string('Desktop Entry', 'X-Custom') == 'keep me'
      and kf.get_boolean('Desktop Entry', 'X-GNOME-Autostart-enabled') is True
      and kf.get_locale_string('Desktop Entry', 'Name', 'fr') == 'Fichiers',
      'the new file is the copy of the desktop file plus enabled=true')
original = keyfile(nemo_desktop)
same = all(original.get_string('Desktop Entry', k) == kf.get_string('Desktop Entry', k) for k in original.get_keys('Desktop Entry')[0])
check(same, 'every key of the desktop file is kept unchanged')
check(value(target, 'X-GNOME-Autostart-Delay') is None, 'no delay key: delay 0')
check(read(nemo_desktop) == nemo_bytes, 'the source desktop file is untouched')
entries, _ = listing(user, system)
check(len(entries) == 1 and entries[0].enabled and entries[0].delay == 0, 'the new entry is listed, on, delay 0')

# a source that has a delay key gives a copy with delay 0 (no key), the rest unchanged
user, system = fresh()
apps = os.path.join(work, 'apps-%d' % counter[0])
os.makedirs(apps)
delayed = write(apps, 'delayed.desktop', desktop('Delayed', 'delayed', 'X-GNOME-Autostart-Delay=9\nX-Keep=1\n'))
r = sl.add_application(user, [], delayed, system_dirs=[system])
target = os.path.join(user, 'delayed.desktop')
check(r.action == 'added' and value(target, 'X-GNOME-Autostart-Delay') is None and value(target, 'X-Keep') == '1', 'the delay key of the source is not copied')
e = listing(user, system)[0][0]
check(e.delay == 0 and e.enabled, 'the entry listed has delay 0')
check(value(delayed, 'X-GNOME-Autostart-Delay') == '9', 'the source file keeps its delay key')

# a desktop file that would be invisible is made visible
user, system = fresh()
apps = os.path.join(work, 'apps-%d' % counter[0])
os.makedirs(apps)
hid = write(apps, 'hid.desktop', desktop('Hid', 'hid', 'NoDisplay=true\nHidden=true\n'))
r = sl.add_application(user, [], hid, system_dirs=[system])
check(r.action == 'added' and len(listing(user, system)[0]) == 1, 'a NoDisplay desktop file still gives a listed entry')

# already on: nothing changes, never a name-1 copy
user, system = fresh()
write(system, 'nemo.desktop', NEMO)
entries, _ = listing(user, system)
snapshot = sorted(os.listdir(user))
r = sl.add_application(user, entries, nemo_desktop, system_dirs=[system])
check(r.action == 'already-on' and r.previous is None and r.written is None, 'a system entry that is on: already-on, nothing written: %r' % (vars(r),))
check(sorted(os.listdir(user)) == snapshot, 'already-on creates no file')
user, system = fresh()
write(user, 'nemo.desktop', desktop('Nemo', 'nemo', 'X-GNOME-Autostart-enabled=true\n'))
entries, _ = listing(user, system)
before = read(os.path.join(user, 'nemo.desktop'))
r = sl.add_application(user, entries, nemo_desktop, system_dirs=[system])
check(r.action == 'already-on' and r.written is None and read(os.path.join(user, 'nemo.desktop')) == before,
      'a user entry that is on: already-on, the file is unchanged')
check(sorted(os.listdir(user)) == ['nemo.desktop'], 'never creates nemo-1.desktop')

# switched off -> enabled
user, system = fresh()
upath = write(user, 'nemo.desktop', desktop('Nemo', 'nemo', 'X-GNOME-Autostart-enabled=false\nX-Keep=1\n'))
entries, _ = listing(user, system)
before = read(upath)
r = sl.add_application(user, entries, nemo_desktop, system_dirs=[system])
check(r.action == 'enabled' and r.previous == before and r.written == read(upath), 'an entry that is off is switched on: %r' % (vars(r),))
check(flag(upath, 'X-GNOME-Autostart-enabled') is True and value(upath, 'X-Keep') == '1', 'enabled=true written, other keys kept')
check(sorted(os.listdir(user)) == ['nemo.desktop'], 'enabled creates no second file')
# a system entry that is off: the override is created, undo deletes it
user, system = fresh()
write(system, 'nemo.desktop', desktop('Nemo', 'nemo', 'X-GNOME-Autostart-enabled=false\n'))
entries, _ = listing(user, system)
r = sl.add_application(user, entries, nemo_desktop, system_dirs=[system])
check(r.action == 'enabled' and r.previous is None and flag(os.path.join(user, 'nemo.desktop'), 'X-GNOME-Autostart-enabled') is True,
      'a system entry that is off: an override that switches it on')
check(sl.undo(user, r) is True and not os.path.exists(os.path.join(user, 'nemo.desktop')), 'undo deletes that override')

# restored: Hidden=true in a user-only file (no system file)
user, system = fresh()
upath = write(user, 'nemo.desktop', desktop('Nemo', 'nemo', 'Hidden=true\nX-GNOME-Autostart-enabled=false\nX-Keep=1\n'))
before = read(upath)
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
check(r.action == 'restored' and r.previous == before and r.written == read(upath), 'a Hidden=true user file is restored: %r' % (vars(r),))
check(not flag(upath, 'Hidden') and flag(upath, 'X-GNOME-Autostart-enabled') is True and value(upath, 'X-Keep') == '1',
      'the hiding is cleared, enabled=true, other keys kept')
check(len(listing(user, system)[0]) == 1 and sorted(os.listdir(user)) == ['nemo.desktop'], 'restored: listed again, no second file')
# restored: a hiding-only override of a system entry is deleted
user, system = fresh()
write(system, 'nemo.desktop', NEMO)
entry = listing(user, system)[0][0]
sl.remove_entry(user, entry)
hidden_bytes = read(os.path.join(user, 'nemo.desktop'))
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
check(r.action == 'restored' and r.previous == hidden_bytes and r.written is None, 'a hiding-only override is deleted: %r' % (vars(r),))
check(not os.path.exists(os.path.join(user, 'nemo.desktop')), 'the override file is gone')
entries, _ = listing(user, system)
check(len(entries) == 1 and entries[0].enabled and entries[0].user_path is None, 'the system entry is listed and on again')
check(sl.undo(user, r) is True and read(os.path.join(user, 'nemo.desktop')) == hidden_bytes, 'undo puts the hiding override back exactly')
check(listing(user, system)[0] == [], 'and the entry is removed again')
# restored: the override the system tool's Remove writes drops the comments of the system file (cs_startup.py loads
# with KEEP_TRANSLATIONS only); it is still a hiding-only override and is deleted
user, system = fresh()
write(system, 'example-tray.desktop', COMMENTED)
tool_override = ''.join(line + '\n' for line in COMMENTED.split('\n') if line and not line.startswith('#'))
tool_override += 'Hidden=true\nX-GNOME-Autostart-enabled=false\n'
upath = write(user, 'example-tray.desktop', tool_override)
hidden_bytes = read(upath)
check(listing(user, system)[0] == [], 'test setup: the system tool\'s override hides the entry')
apps = os.path.join(work, 'apps-%d' % counter[0])
os.makedirs(apps)
tray_app = write(apps, 'example-tray.desktop', COMMENTED)
r = sl.add_application(user, listing(user, system)[0], tray_app, system_dirs=[system])
check(r.action == 'restored' and r.written is None and not os.path.exists(upath),
      'a hiding-only override without the comments of the system file is deleted: %r' % (vars(r),))
check(sl.undo(user, r) is True and read(upath) == hidden_bytes, 'undo puts that override back exactly')
# enabled: a pick of a system entry that an override switched off deletes the override (it would equal the system file)
user, system = fresh()
write(system, 'nemo.desktop', NEMO)
sl.set_enabled(user, listing(user, system)[0][0], False)
upath = os.path.join(user, 'nemo.desktop')
off_bytes = read(upath)
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
check(r.action == 'enabled' and r.previous == off_bytes and r.written is None and not os.path.exists(upath),
      'switching a system entry on by a pick leaves no user file: %r' % (vars(r),))
entries, _ = listing(user, system)
check(len(entries) == 1 and entries[0].enabled and entries[0].user_path is None, 'the system entry is listed and on')
check(sl.undo(user, r) is True and read(upath) == off_bytes, 'undo puts the switched-off override back exactly')
check(listing(user, system)[0][0].enabled is False, 'and the entry is off again')
# restored: an override the user edited (Exec, or a delay) is kept: the hiding is cleared, the edit stays
for what, edit in (('Exec', lambda t: t.replace('Exec=nemo %U', 'Exec=nemo --mine')),
                   ('Name', lambda t: t.replace('Name=Nemo\n', 'Name=My Nemo\n')),
                   ('delay', lambda t: t.replace('Hidden=true', 'Hidden=true\nX-GNOME-Autostart-Delay=5'))):
    user, system = fresh()
    write(system, 'nemo.desktop', NEMO)
    sl.remove_entry(user, listing(user, system)[0][0])
    upath = os.path.join(user, 'nemo.desktop')
    write(user, 'nemo.desktop', edit(read(upath).decode('utf-8')))
    edited = read(upath)
    check(edited != read(os.path.join(system, 'nemo.desktop')), 'test setup: the %s edit is in the override' % what)
    r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
    check(r.action == 'restored' and r.previous == edited and r.written == read(upath) and r.written is not None,
          'an override with an edited %s is kept: %r' % (what, (r.action, r.written)))
    check(os.path.exists(upath) and not flag(upath, 'Hidden') and flag(upath, 'X-GNOME-Autostart-enabled') is True,
          'the %s override: hiding cleared, enabled' % what)
    if what == 'Exec':
        check(value(upath, 'Exec') == 'nemo --mine', 'the Exec edit is still there')
    elif what == 'Name':
        check(value(upath, 'Name') == 'My Nemo', 'the Name edit is still there')
    else:
        check(value(upath, 'X-GNOME-Autostart-Delay') == '5', 'the delay edit is still there')
    entries, _ = listing(user, system)
    check(len(entries) == 1 and entries[0].enabled, 'the %s override is listed and on' % what)
    check(sl.undo(user, r) is True and read(upath) == edited, 'undo of the kept %s override restores the exact bytes' % what)

# restored: an override of a system entry that is itself off keeps working as an override
user, system = fresh()
write(system, 'nemo.desktop', desktop('Nemo', 'nemo', 'X-GNOME-Autostart-enabled=false\n'))
entry = listing(user, system)[0][0]
sl.remove_entry(user, entry)
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
entries, _ = listing(user, system)
check(r.action == 'restored' and len(entries) == 1 and entries[0].enabled, 'restoring an entry whose system file is off still gives an entry that is on: %r' % (vars(r),))

# a user file that cannot be read is not overwritten by surprise: it is replaced and Undo brings it back
user, system = fresh()
bad = write(user, 'nemo.desktop', 'garbage [[[\n')
r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
check(r.action == 'added' and r.previous == b'garbage [[[\n' and sl.undo(user, r) is True and read(bad) == b'garbage [[[\n',
      'an unreadable user file is replaced and Undo brings it back byte for byte')

# ---- 5. add_custom ----------------------------------------------------------------------------

user, system = fresh()
shutil.rmtree(user)
base = sl.add_custom(user, 'Firefox', 'firefox --private-window', 'A browser', 12)
check(base == 'Firefox.desktop' and os.path.isfile(os.path.join(user, base)), 'custom entry: the basename is returned and the folder is created: %r' % base)
p = os.path.join(user, base)
check(value(p, 'Name') == 'Firefox' and value(p, 'Exec') == 'firefox --private-window' and value(p, 'Comment') == 'A browser'
      and value(p, 'X-GNOME-Autostart-Delay') == '12' and flag(p, 'X-GNOME-Autostart-enabled') is True
      and value(p, 'Type') == 'Application', 'custom entry keys')
e = listing(user, system)[0][0]
check((e.name, e.command, e.comment, e.delay, e.enabled, e.system, e.icon) == ('Firefox', 'firefox --private-window', 'A browser', 12, True, False, None),
      'the custom entry is listed: %r' % (vars(e),))
base2 = sl.add_custom(user, 'Firefox', 'firefox', '', 0)
check(base2 == 'Firefox-1.desktop' and os.path.isfile(os.path.join(user, base2)), 'a free name when Firefox.desktop exists: %r' % base2)
check(sl.add_custom(user, 'Firefox', 'firefox', '', 0) == 'Firefox-2.desktop', 'and the next one is -2')
# a name used by a system file is not free either (the user file would shadow the system entry)
write(system, 'Taken.desktop', desktop('Taken'))
check(sl.add_custom(user, 'Taken', 't', '', 0, system_dirs=[system]) == 'Taken-1.desktop', 'a name used by a system file is not free')
check(sl.add_custom(user, 'a/b', 'x', '', 0) == 'a-b.desktop', 'a slash in the name does not make a path')
check(sl.add_custom(user, '.hidden', 'x', '', 0) == 'hidden.desktop', 'a leading dot is dropped')
check(sl.add_custom(user, '   ', 'x', '', 0) == 'startup.desktop', 'an empty name gets a fallback file name')
# the delay is kept as a number from 0 to 100 by the caller; an empty comment writes no empty key
check(value(os.path.join(user, base2), 'Comment') is None, 'an empty comment is not written')

# ---- 6. undo ----------------------------------------------------------------------------------

# undo of added
user, system = fresh()
r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
check(sl.undo(user, r) is True and not os.path.exists(os.path.join(user, 'nemo.desktop')), 'undo of added deletes the file')
# undo of enabled
user, system = fresh()
upath = write(user, 'nemo.desktop', desktop('Nemo', 'nemo', 'X-GNOME-Autostart-enabled=false\n'))
before = read(upath)
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
check(sl.undo(user, r) is True and read(upath) == before, 'undo of enabled restores the exact earlier content')
# undo of restored (user-only file)
user, system = fresh()
upath = write(user, 'nemo.desktop', desktop('Nemo', 'nemo', 'Hidden=true\nX-GNOME-Autostart-enabled=false\n'))
before = read(upath)
r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
check(sl.undo(user, r) is True and read(upath) == before, 'undo of restored restores the exact earlier content')
# undo of already-on: nothing to undo, nothing changes
user, system = fresh()
write(system, 'nemo.desktop', NEMO)
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
check(sl.undo(user, r) is True and os.listdir(user) == [], 'undo of already-on changes nothing')
# refuses when the file changed
user, system = fresh()
r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
target = os.path.join(user, 'nemo.desktop')
sl.set_enabled(user, listing(user, system)[0][0], False)
changed = read(target)
check(sl.undo(user, r) is False and read(target) == changed, 'undo of added refuses when the file changed, and changes nothing')
os.remove(target)
check(sl.undo(user, r) is False and not os.path.exists(target), 'undo of added refuses when the file is gone')
user, system = fresh()
upath = write(user, 'nemo.desktop', desktop('Nemo', 'nemo', 'X-GNOME-Autostart-enabled=false\n'))
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
sl.set_enabled(user, listing(user, system)[0][0], False)
changed = read(upath)
check(sl.undo(user, r) is False and read(upath) == changed, 'undo of enabled refuses when the file changed')
user, system = fresh()
write(system, 'nemo.desktop', NEMO)
sl.remove_entry(user, listing(user, system)[0][0])
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
write(user, 'nemo.desktop', desktop('Someone else wrote this'))
check(sl.undo(user, r) is False and value(os.path.join(user, 'nemo.desktop'), 'Name') == 'Someone else wrote this',
      'undo of a deleted override refuses when a file appeared meanwhile')

# undo does not raise when the path cannot be read as a file: it refuses and changes nothing
user, system = fresh()
r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
target = os.path.join(user, 'nemo.desktop')
os.remove(target)
os.mkdir(target)
check(sl.undo(user, r) is False and os.path.isdir(target), 'undo of added refuses when the path became a directory')
user, system = fresh()
write(system, 'nemo.desktop', NEMO)
sl.remove_entry(user, listing(user, system)[0][0])
r = sl.add_application(user, listing(user, system)[0], nemo_desktop, system_dirs=[system])
check(r.written is None, 'test setup: a deleted override')
os.mkdir(os.path.join(user, 'nemo.desktop'))
check(sl.undo(user, r) is False and os.path.isdir(os.path.join(user, 'nemo.desktop')), 'undo of a deleted override refuses when the path became a directory')
if os.geteuid() != 0:
    user, system = fresh()
    r = sl.add_application(user, [], nemo_desktop, system_dirs=[system])
    target = os.path.join(user, 'nemo.desktop')
    os.chmod(target, 0)
    try:
        check(sl.undo(user, r) is False and os.path.exists(target), 'undo refuses (no exception) when the file cannot be read')
    finally:
        os.chmod(target, 0o600)

# ---- 6b. the pick result of the extension and the command of the form ---------------------------

import json  # noqa: E402

app = {'v': 1, 'stamp': 1730000000000, 'kind': 'app', 'desktopFile': '/usr/share/applications/nemo.desktop', 'name': 'Nemo'}
form = {'v': 1, 'stamp': 1730000000001, 'kind': 'form', 'name': 'xterm', 'command': "xterm -e 'sh -c x'"}
check(sl.parse_pick(json.dumps(app)) == (app, None), 'parse_pick accepts an app result')
check(sl.parse_pick(json.dumps(form)) == (form, None), 'parse_pick accepts a form result')
check(sl.parse_pick(json.dumps(dict(form, command='', name='')))[0] is not None, 'an empty command and name are still a result (the form opens empty)')
for bad in ('', None, 5, 'not json', '[]', '{}', json.dumps(dict(app, v=2)), json.dumps(dict(app, stamp=True)),
            json.dumps(dict(app, stamp='1')), json.dumps({k: v for k, v in app.items() if k != 'desktopFile'}),
            json.dumps(dict(app, desktopFile='nemo.desktop')), json.dumps(dict(app, desktopFile='/x/nemo.txt')),
            json.dumps(dict(app, name=None)), json.dumps({k: v for k, v in form.items() if k != 'command'}),
            json.dumps(dict(form, kind='other'))):
    result, why = sl.parse_pick(bad)
    check(result is None and why, 'parse_pick refuses %r with a reason: %r' % (bad, why))
    check(why is None or 'xterm' not in why, 'the reason does not repeat the value')
check(sl.check_command("xterm -e 'sh -c x'") == (['xterm', '-e', 'sh -c x'], None), 'check_command splits a valid command')
check(sl.check_command('   ')[0] is None and sl.check_command('   ')[1] == 'The command cannot be empty.', 'an empty command is refused')
check(sl.check_command('xterm "open')[0] is None and sl.check_command('xterm "open')[1].startswith('The command is not valid: '),
      'a command the shell cannot split is refused')

# ---- 7. the module needs no display -----------------------------------------------------------

check('gi.repository.Gtk' not in sys.modules and 'gi.repository.Gdk' not in sys.modules, 'importing startup_list does not load Gtk or Gdk')
check(sl.UUID == 'window-memory@bootkicker', 'UUID constant')

if failures:
    print('%d check(s) failed' % len(failures))
    sys.exit(1)
print('all checks passed')
