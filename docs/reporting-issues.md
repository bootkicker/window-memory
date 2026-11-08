# Reporting an issue with Window Memory

Thank you for reporting a problem. A complete report gets a fix much faster. This page lists what to include, how to collect it, and what to keep out of it.

## 1. Check first

Search the existing issues for your problem: https://github.com/bootkicker/window-memory/issues

## 2. What to include

- What you did, step by step, and what you expected.
- What happened instead.
- Versions (see step 3).
- When it started, and whether a restart of Cinnamon changes it.
- One log file (step 4).

## 3. Versions

Open System Settings → Extensions → Window Memory → Configure. The Version row shows the version and the commit. Then run:

```bash
dpkg-query -W -f='${Package} ${Version}\n' cinnamon muffin
lsb_release -ds
echo "Session: $XDG_SESSION_TYPE"
```

## 4. Collect the log file

Run this. It writes the Window Memory lines from the Cinnamon log into one file in your home folder:

```bash
grep -i 'window-memory' ~/.xsession-errors | tail -n 200 > ~/window-memory-log.txt
```

Then remove personal information from it. This replaces your home folder path and your user name:

```bash
sed -i "s|$HOME|~|g; s|$USER|<user>|g" ~/window-memory-log.txt
```

Open `~/window-memory-log.txt` in a text editor and check it again before you attach it.

Only when a maintainer asks for it, also add the journal lines for Cinnamon. Check these lines carefully, because they can contain more personal data:

```bash
journalctl --user -b --no-pager | grep -i -E 'cinnamon|window-memory' | tail -n 200 >> ~/window-memory-log.txt
```

## 5. Optional information

Switch values from the Window Memory settings, without the list of applications:

```bash
python3 -c "import json,os;p=os.path.expanduser('~/.config/cinnamon/spices/window-memory@bootkicker/window-memory@bootkicker.json');d=json.load(open(p));print({k:v['value'] for k,v in d.items() if 'value' in v and k!='excluded-apps'})"
```

The number of remembered windows, not their names:

```bash
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.config/window-memory/state.json')));print(len(d['windows']),'remembered windows')"
```

If Cinnamon crashed and restarted by itself, list the crash files by name and date. Do not attach them: they can hold memory contents.

```bash
ls -l /var/crash/ 2>/dev/null
```

## 6. Do not include

- The file `~/.config/window-memory/state.json`. It holds window titles and file names.
- Window titles, document names, web addresses, or messages you see on screen.
- Your user name, your computer's name, IP or MAC addresses, email addresses, and the names of devices such as phones or printers.
- The list of applications in the settings. Send only the switch values from step 5.
- Passwords, keys, or tokens of any kind.

## 7. Submit

Open a new issue with this link. It opens the bug report form, which lists what to fill in:

https://github.com/bootkicker/window-memory/issues/new?template=bug_report.md

Fill in the form, attach `~/window-memory-log.txt` (drag it into the text box), and tick the box confirming that you checked it for personal data.
