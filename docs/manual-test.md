# Window Memory: manual test checklist

This checklist is for a real Cinnamon session: the automated tests only cover the extension against a mock of Cinnamon. Record pass or fail for every item, and the exact observation for items marked "record", in a results file of your own.

Items 1 to 10 are the basic checklist. Items 11 to 15 cover further behavior: maximized windows on another monitor, applications that start minimized, a click after a forget, the map effect, and a monitor that is unplugged and plugged back in. Items 16 to 24 cover the minimized state. Items 25 and 26 cover the Forget-all button and the shorter never-remember list. Items 27 and 28 cover backup and restore. Items 29 and 30 cover the confirmations of "Forget all remembered windows" and of the "Forget the focused window" shortcut. Items 31 and 32 cover Forget all with "Also remember dialog windows", and its Cancel and close button. Item 33 covers the Wayland session. Item 34 covers the safety stop. Items 35 to 42 cover the "Startup apps" tab. Items 43 to 47 cover the pick overlay, the Enabled column and the Max windows field.

## Before you start

- Cinnamon 6.0 or newer, on X11 or on the Cinnamon Wayland session (item 33 lists what changes on Wayland). Items 4, 11, 15 and 23 need at least two monitors.
- Errors are logged with the prefix `[window-memory]`. Look for them in `~/.xsession-errors` (for example `grep window-memory ~/.xsession-errors`) and in Looking Glass (press Alt+F2, type `lg`, Enter, open the Errors tab).
- The state file is `~/.config/window-memory/state.json`. Look at it with `cat` after each save.
- A move or resize is saved one second after the window stops, and written to disk one second after that. Wait 3 seconds after the last change before you check the file. Closing a window saves it at once.
- To start a test from a clean state, disable the extension, run `rm ~/.config/window-memory/state.json`, and enable it again.
- Use a browser with several windows (for example Firefox, Chromium or Google Chrome) as the main test application unless an item says otherwise. Any application with several windows works. `xprop WM_CLASS` followed by a click on a window shows its class and instance.

## Checklist

### 1. Install

1. From the repository root run `mkdir -p ~/.local/share/cinnamon/extensions && cp -r files/window-memory@bootkicker ~/.local/share/cinnamon/extensions/`. The folder name must stay `window-memory@bootkicker`.
2. Open System Settings, Extensions, Manage. If Window Memory is not listed, restart Cinnamon from its menu and look again.
3. Tick Window Memory to enable it, then open its configure dialog.

Expected: the extension is listed and enabled with no error mark. The configure dialog shows every setting named in the README. `grep window-memory ~/.xsession-errors` shows no error lines.

### 2. Move, resize, close, reopen

1. Start the browser. Drag it to a clearly different place and change its size.
2. Wait 3 seconds. Close the browser.
3. Start the browser again.

Expected: the window opens with the same size, at the same position, on the same monitor. A difference of a few pixels from the window frame is acceptable. `state.json` holds one entry for the browser.

### 3. Two windows of one application on different monitors

1. Start from a clean state (see "Before you start").
2. Open two browser windows (Ctrl+N). Put one on monitor A and the other on monitor B, at different positions and sizes.
3. Wait 3 seconds. Close both windows. Start the browser again and open a second window.

Expected: one window returns to each saved place, on its own monitor, and the two windows never end up on top of each other at the same place. Which window gets which place can be swapped, because the newest saved entry goes to the first window. `state.json` holds two entries for the browser.

Optional variation: in the settings set "Match windows by" to "Application and window title", give the two windows different titles (different pages), and repeat. Expected: each window returns to the place it had with the same title.

### 4. Unplug an external monitor, reopen the application

1. Put a browser window on an external monitor. Wait 3 seconds. Close it.
2. Unplug that monitor (or run `xrandr --output <name> --off`). Start the browser again.

Expected: the window is fully visible on a remaining monitor, not off-screen and not partly outside the work area. `state.json` still lists the unplugged monitor for that entry.

### 5. Settings apply without a restart

Change each setting while the extension is running, repeat the matching test, and confirm the behavior changes at once. Set each setting back afterwards.

1. Enable Window Memory off: move a window, close it, reopen it. Expected: it opens at the application's default place and `state.json` does not change. Turn it back on: moving and reopening works again.
2. Remember window size off (position on): save a window at a custom size and position, close it, reopen it. Expected: the saved position, the size the application chose.
3. Remember window position off (size on): Expected: the saved size, the position the application chose.
4. Restore to the same monitor off: save a window on monitor B, close it, start the application so that it opens on monitor A (for example from a launcher on monitor A). Expected: it opens on monitor A, at the saved offset from that monitor's top-left corner. With it on and both the size and position switches off, the window opens on monitor B (the saved monitor), at the size and position the application chose.
5. Remember workspace off and on: save a window on workspace 2, close it, reopen it from workspace 1. Expected: with the setting off it opens on workspace 1; on, it opens on workspace 2.
6. Remember maximized state off and on: save a maximized window, close it, reopen it. Expected: with the setting off it opens unmaximized; on, it opens maximized.
7. Match windows by "Application and window title": see the optional variation in item 3.
8. Also remember dialog windows: open a dialog of an application (for example File, Open in a text editor), move it, close it, reopen it. Expected: with the setting off the dialog is never saved or restored; on, it is. Turn the setting on while a dialog is already open: the open dialog is remembered from then on.
9. Never remember these applications: add the browser's class (for example `brave-browser`) while its windows are open. Expected: moving them no longer changes `state.json`, and reopening the browser does not restore it. Remove the row: the browser windows that are already open are remembered again.
10. Max windows (optional; the number field at the right end of the button row under the never-remember list): set it to 10 and open and move windows of more than ten different applications. Expected: `state.json` never holds more than ten entries, and the least recently seen are dropped first.
11. Remember minimized state off and on: see item 16.

### 6. Forget focused and Forget all

1. Move a window and wait 3 seconds. Set a shortcut for "Forget the focused window" in the settings.
2. Focus the window and press the shortcut. Close the window and start the application again.
3. Press the "Forget all remembered windows" button with a few remembered windows open. Wait 3 seconds and check `state.json`.

Expected: after step 2 the window opens at the application's default place and its entry is gone from `state.json`. After step 3, `state.json` holds an empty `windows` list. Changing the shortcut in the settings works at once, and an empty shortcut removes it.

### 7. Disable and re-enable

1. With a few windows open, disable the extension in System Settings, Extensions, Manage.
2. Run `grep window-memory ~/.xsession-errors`. Move a window and check that `state.json` does not change.
3. Enable the extension again, move a window, close it, reopen it.

Expected: no `[window-memory]` error lines at any point, the forget shortcut stops working while disabled, and after enabling everything works as in item 2.

### 8. Corrupt state file

1. Disable the extension.
2. Run `echo '{broken' > ~/.config/window-memory/state.json`.
3. Enable the extension and move a window, wait 3 seconds, and close it.

Expected: a file named `state.json.bad-<timestamp>` appears next to `state.json`, a new valid `state.json` is written, and windows are remembered again. Cinnamon keeps running and the extension stays enabled.

### 9. First-frame flash (record)

1. Save a window of an application at a place that is far from where the application normally opens.
2. Close it and start it again, watching the screen closely. Repeat five times.

Expected: record what you saw in your results file: no flash, a brief flash at the default place, or a visible jump. The window is placed when it is created and the first map only corrects it; the restored place must be correct in every case. To see whether the early move held, log in `_correctAtMap` just before its `move_resize_frame` call and count how often the map had to correct the window.

### 10. Screenshot for the store listing

1. Open the extension's configure dialog.
2. Take a screenshot of the dialog and save it as `screenshot.png` in the repository root (`scripts/package.sh` expects it there).

Expected: the screenshot shows the settings legibly, with all labels visible.

### 11. A maximized window moved to another monitor

1. Start from a clean state and use a text editor (for example xed) or a browser. Open one window and maximize it at once, without dragging it first (double-click the title bar).
2. Move the maximized window to the other monitor: right-click the title bar and choose "Move to Another Monitor", or use the keyboard shortcut for it. Wait 3 seconds.
3. Check `state.json`. Close the window and start the application again.
4. Un-maximize the window (double-click the title bar).
5. Variation with a known normal size: close the window, remove the state as in "Before you start", open the application, drag it to a recognizable place on monitor A, resize it, then maximize it, move it to monitor B, close it and reopen it. Un-maximize it.

Expected: after step 2 the entry has `"maximized": true` and the monitor you moved it to. In step 3 the window opens maximized on that monitor. After step 4 it takes the application's own size, or its last normal geometry if one was known. In the variation, after step 5 the window opens maximized on monitor B and un-maximizes to the normal size and the offsets saved on monitor A, now placed on monitor B. With "Restore to the same monitor" turned off, the window opens maximized on whichever monitor the application chose.

### 12. An application that starts minimized

1. Run the application once in the normal way, put its window somewhere recognizable, wait 3 seconds, close it. Note the entry in `state.json`.
2. Start the application minimized. For a terminal, `xterm -iconic` does this; other applications may have a start-minimized option, or you can minimize the window as soon as it appears.
3. Wait 3 seconds, then check `state.json` and the error log. Restore the window from the taskbar.
4. Close it.

Expected: no `[window-memory]` errors. The saved geometry in `state.json` is not replaced by a meaningless one while the window is minimized (nothing is captured before the first map). The window is placed when it is created, so after you restore it, it is at its saved place. If it appears at the application's default place instead, record this as a finding. Item 21 checks this; a window started with `xterm -iconic` is expected to appear normal.

### 13. A title-bar click after a forget

1. Move a window, wait 3 seconds, and check that it has an entry in `state.json`.
2. Focus the window and press the "Forget the focused window" shortcut. Check that the entry is gone.
3. Click once on the window's title bar without moving the window. Wait 3 seconds and check `state.json`.
4. Close the window and start the application again.
5. Drag the window a few pixels, wait 3 seconds, and check `state.json`. Close it and start the application again.

Expected: after step 3 `state.json` still has no entry for the window, and after step 4 the window opens at the application's default place (the click did not teach it again). After step 5 there is an entry again and the window opens at the new place (a real drag does).

### 14. The map effect (flash) on and off

1. In System Settings, Effects, turn desktop effects off, or set the window-opening ("mapping") effect to None.
2. Save a window far from the application's default place. Close it and start the application ten times, watching the first frame each time.
3. Turn the effects on and set the window-opening effect to Fade or Scale. Repeat step 2.

Expected: in both modes the window ends up at the saved place. The window is now placed at creation and the map only corrects it. Record for each mode whether the first frame still shows the window at the default place before it jumps, and note any difference between the two modes.

### 15. A monitor unplugged while a window is open on it, then plugged back in

1. Put a browser window on the external monitor B, at a recognizable place and size. Wait 3 seconds and note the entry in `state.json` (its monitor and its position).
2. With the window still open, unplug monitor B (or `xrandr --output <name> --off`). Muffin moves the window to the remaining monitor.
3. Wait at least 3 seconds. Check `state.json`.
4. Close the window. Check `state.json` again.
5. Plug monitor B back in (or `xrandr --output <name> --auto`, with the same arrangement as before). Start the browser again.
6. Variation: repeat steps 1 to 3, then plug monitor B back in while the window is still open, and drag the window onto monitor B.

Expected: after steps 3 and 4 the entry still names monitor B with the same offsets, even though the window sat on the other monitor in the meantime. After step 5 the window opens on monitor B at the saved place. In the variation, a window that you drag back onto monitor B updates its entry again once monitor B is connected. Once monitor B is connected, a window that stays on the other monitor is saved there, so closing it without dragging it back makes its entry name the other monitor.

### 16. Remember minimized state on and off (record)

1. Set "Remember minimized state" off. Minimize a browser window, close it, start the browser again. Expected: the window opens normal.
2. Set it on. Minimize a browser window, wait 3 seconds, close it, start the browser again. Expected: the window opens minimized (in the taskbar, not on screen). Restore it from the taskbar: it is at its saved place.
3. Turn "Enable Window Memory" off. Expected: the new switch is greyed out like the other rows.

### 17. Restore after a minimized start, then close (record)

1. Repeat item 16, step 2, to get a minimized start. Before the restore, note the monitor and place of its entry in `state.json`. Restore the window from the taskbar. Wait 3 seconds and check `state.json`. Expected: the entry has `"minimized": false`.
2. Close the window and start the application again. Expected: the window opens normal.
3. After 3 seconds, check `state.json` again. Expected: the monitor and place of its entry are the same as before the restore.

### 18. Two windows of one application, one minimized (record)

1. Open two browser windows. Minimize one. Wait 3 seconds. Expected: `state.json` has two entries for the application, one with `"minimized": true`.
2. Close both, start the application again. Record which window comes back minimized. Expected: one window normal, one minimized. Which window gets which place can be swapped, as with item 3.

### 19. Forget a minimized window

1. Minimize a browser window and wait 3 seconds.
2. Open the extension settings and press "Forget all remembered windows".
3. Close the window and start the browser again. Expected: the window opens normal, and `state.json` no longer holds its entry.

The shortcut "Forget the focused window" is not used here, because a minimized window cannot hold focus. Item 6 covers it.

### 20. Flash and sound on restoring a minimized window (record)

1. With the switch on, save a minimized window, close it and start the application five times, watching the screen and listening. Record for each start: any visible frame (yes or no), whether the minimize sound plays, and whether the window animates. Expected: no frame, no animation, and the minimize sound plays (intended: it tells the user that a window was minimized). Record any deviation in your results file.

### 21. Applications that start minimized by themselves (record)

1. Run `xterm -iconic`. Wait 3 seconds. Record whether the window is minimized or normal, and the entry in `state.json`. Expected per the Muffin source: normal.
2. If you know an application that starts minimized by itself, repeat step 1 with it and record the result.

### 22. Upgrade with an existing state file

1. Keep a `state.json` written by a version before 0.2.0 (it has no `minimized` field). Enable the new version. Expected: no `state.json.bad-*` file appears, every entry is still there, and windows restore as before.

### 23. A window first shown on another workspace is moved to its saved place (record)

1. Start Xed. Put its window on monitor B, on workspace 2, at a recognizable place. Wait 3 seconds, note the monitor and place in its entry in `state.json`, and close the window.
2. Go to workspace 1 and put the pointer on monitor A. Start Xed again from there.
3. Switch to workspace 2 with the keyboard, with desktop effects on. Record where the window appears and any visible jump. Expected: the window appears on its saved monitor at its first show.
4. After 3 seconds, check `state.json`. Expected: the entry still holds its monitor and place.
5. Repeat steps 1 to 4 with the window maximized on monitor B before you close it.

### 24. A maximized window that was minimized (record)

1. Maximize a browser window, then minimize it. Wait 3 seconds and close it.
2. Start the browser again and restore the window from the taskbar. Record whether it is maximized.
3. After 3 seconds, check `state.json`. Expected: the entry still says `"maximized": true`.

### 25. The Forget-all button: look, enabled and disabled (record)

1. Open the extension settings with "Enable Window Memory" on. Look at the "Forget all remembered windows (Cannot be undone, Esc to cancel)" button, directly under the "Forget the focused window" shortcut row. Expected: a red warning triangle before the text, and a border in the theme's selection colour, the same border as the "Pick a window" button. The text and the button colour are the theme's, as before: only the icon is red.
2. Turn "Enable Window Memory" off. Expected: the button is greyed out like the other rows, the icon is no longer red, and the border is the theme's own disabled border, not the selection colour.
3. Turn it on again. With a few remembered windows saved, press the button and wait 3 seconds. Expected: `state.json` holds an empty `windows` list, as in item 6, step 3.

### 26. The never-remember list: height and scrolling (record)

1. Open the extension settings. Look at the list above the "Pick a window to never remember" button (its title is "Never remember these applications (WM class)"). Expected: the list is 133 pixels high (two thirds of the stock 200) and as wide as the stock list. A screenshot shows the height.
2. Add more applications than fit (the + button, or "Pick a window to never remember" several times). Expected: a scrollbar appears and the list scrolls. The five buttons under the list (add, remove, edit, move up, move down) still work.
3. Close the settings window and open it again. Expected: the list has the same height as the first time.

### 27. Back up and restore: a round trip (record)

1. Open the extension settings with "Enable Window Memory" on and a few remembered windows saved. Count the entries with `grep -o '"id":' ~/.config/window-memory/state.json | wc -l`.
2. Press "Export backup…". Expected: the save dialog sits above the settings window, which cannot be used while the dialog is open, and suggests `window-memory-backup-<date>.json` in Documents. Save. Expected: a message gives the number of settings and remembered windows saved, the windows as many as in step 1, and `ls -l` shows the file as `-rw-------`.
3. Turn "Remember workspace" off. Focus a remembered window and press the "Forget the focused window" shortcut (set one first, see item 6). Wait 3 seconds. Expected: that window's entry is gone from `state.json`.
4. Optional, if the backup holds more than 10 remembered windows: set "Max windows" to 10, move a window and wait 3 seconds. Expected: `state.json` holds 10 entries.
5. Press "Import backup…" and open the file from step 2. Expected: the open dialog, and then the question "Replace the settings and the … remembered windows with this backup from …?", sit above the settings window, and Cancel is the default button. Press Replace. Expected: a message "Restored … settings and … remembered windows.", and no `[window-memory]` error lines in `~/.xsession-errors`.
6. Check that both changes are undone. Expected: "Remember workspace" is on again in the open settings window, and "Max windows" has its old value if you did step 4. `state.json` holds the forgotten window's entry again and as many entries as in step 1: the restore itself keeps the backup's windows, and the entry limit applies to later saves as usual.
7. Turn "Enable Window Memory" off. Expected: the row with "Export backup…" and "Import backup…" is greyed out like the other rows, both buttons included. Turn it on again.

Record whether each dialog stayed above the settings window, and the counts from steps 1, 2 and 6.

### 28. Back up and restore: the failure path, with no window changed (record)

This checks what happens when the extension refuses a restore. It changes no window and no setting. It needs the version with the restore installed (see "Reinstall after every change") and Window Memory enabled.

1. Check that there is no staging file: `ls ~/.config/window-memory/`. Expected: no `import-pending.json`. Note the checksum of the state file, `md5sum ~/.config/window-memory/state.json`.
2. Run `gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.activateCallback importState window-memory@bootkicker window-memory@bootkicker`. Expected: an error that says `import-pending.json` does not exist, with the `[window-memory]` prefix, for example `Error: GDBus.Error:org.gnome.gjs.JSError.Error: [window-memory] import rejected: /home/<you>/.config/window-memory/import-pending.json does not exist`.
3. The error reply of step 2 is the check. A matching "Exception in method call: activateCallback" line in `~/.xsession-errors` or the user journal may not appear; do not require it. If such a line does appear, note it in the record.
4. Run the `md5sum` of step 1 again. Expected: the same checksum: `state.json` is unchanged.

Record the error of step 2 and the result of step 4.

### 29. The Forget-all confirmation: the question, the result, none, and an error (record)

1. Open the extension settings with "Enable Window Memory" on and a few remembered windows saved. Wait 3 seconds after the last move, then count the entries with `grep -o '"id":' ~/.config/window-memory/state.json | wc -l`.
2. Press "Forget all remembered windows". Expected: a question sits above the settings window, which cannot be used while it is open, and says "Forget all remembered windows?" with Cancel and OK buttons, Cancel being the default. Press OK. Expected: a second dialog says "Forgot all remembered windows." and "<n> remembered windows were forgotten.", with the number from step 1 ("1 remembered window was forgotten." for one). Press OK. Wait 3 seconds. Expected: `state.json` holds an empty `windows` list.
3. Press the button again. Expected: one dialog says "No windows were remembered, so there is nothing to forget." with an OK button only. Press OK.
4. Keep the settings window open and disable Window Memory in System Settings, Extensions, Manage. Make sure the file holds a remembered window first (move a window, enable, then disable). Press "Forget all remembered windows", then OK in the question. Expected: an error dialog says "The remembered windows were not forgotten." and "Window Memory is not running. Enable it in System Settings, then try again." Press OK and enable Window Memory again.

Record the number from step 1 and the texts of the dialogs.

### 30. The notification of "Forget the focused window": forgotten, not remembered, no focused window (record)

1. Set a shortcut for "Forget the focused window" (see item 6). Move a browser window and wait 3 seconds. Expected: `state.json` has an entry for it.
2. Focus the window and press the shortcut. Expected: a notification titled "Window Memory" says "Forgot the remembered window of <application>.", where the application is named as in the applications menu (for example "Google Chrome"), or by its WM_CLASS if it has no menu entry. Wait 3 seconds. Expected: the entry is gone from `state.json`.
3. Press the shortcut again with the same window focused. Expected: "<application> is not remembered, so nothing was forgotten."
4. Click on the desktop, so that no application window has the focus, and press the shortcut. Expected: "The focused window is not remembered, so nothing was forgotten." Focus a window of an application on the never-remember list and press the shortcut. Expected: the same text.

Expected throughout: no notification shows a window title, and `grep window-memory ~/.xsession-errors` shows no new error lines. Record the three texts.

### 31. Forget all with "Also remember dialog windows" on and off (record)

1. Turn "Also remember dialog windows" on. With a remembered window saved, press "Forget all remembered windows", OK in the question, and OK in the result. Expected: the switch is off while the dialogs are open and is back on about half a second after the last one closes.
2. Press the button again. Expected: "No windows were remembered, so there is nothing to forget." Neither dialog of the first press was remembered.
3. Turn the switch off and press the button. Expected: the dialogs are the same, and the switch stays off afterwards.
4. Close the settings window while a dialog is open. Expected: it cannot be closed, because the dialog is modal.

Record what the switch did in steps 1 and 3.

### 32. Forget all: Cancel, the close button, and none (record)

1. With remembered windows saved, press "Forget all remembered windows" and press Cancel. Expected: no other dialog opens, and the windows are still in `state.json`.
2. Press the button again and close the question with the close button (the x at the top right). Expected: the same as Cancel.
3. Press the button again and press OK. Expected: the windows are forgotten, as in item 29.
4. With none remembered, press the button and close the dialog with the close button. Expected: it closes, as with OK, and nothing else happens.

### 33. On Wayland (record)

Log in with "Cinnamon on Wayland" from the session menu of the login screen. Cinnamon cannot restart in that session, so after changing the extension log out and in again (or disable and enable it, which loads the changed files).

1. Use a native Wayland application with a custom class, for example a terminal started with its own app id (`foot -a MYCLASS`, `kitty --class MYCLASS`), and one X11 application under XWayland (`xterm -class MYCLASS2`). Find the class of a window with Looking Glass (Alt+F2, `lg`): focus the window, then evaluate `global.display.focus_window.get_wm_class()`. `xprop` only sees XWayland windows.
2. Repeat items 2, 3, 5, 6, 7, 11, 16 to 19 and 23 with both kinds of window. Expected: the same as on X11, for native and XWayland windows alike. The window is placed before its first frame; look for any jump or flash.
3. Windows that you maximize or minimize: a window saved maximized and then minimized comes back minimized and is maximized when you restore it from the taskbar; a window restored maximized first shows at its saved size and then maximizes.
4. Items 4 and 15 (unplug a monitor): `xrandr` does not control Wayland outputs; unplug the cable. Muffin numbers the monitors again, and the saved monitor is kept until it returns.
5. An application whose class differs between the two sessions finds the place saved in the other session if it is in the built-in list or has a desktop file (see the limitations in the README); an application without a desktop file does not. In a session with X11 windows only nothing of this applies.
6. Dialogs of native Wayland applications (the Open dialog of a text editor, with a parent window) are remembered as dialogs: with "Also remember dialog windows" off they are not remembered and do not take the place of the application's main window.
7. Open the settings window. Expected: after the word "Version" a short dimmed note, "Wayland (experimental)", with a tooltip that explains it, and the version, the commit link and "Report an issue" on the right as before. In an X11 session there is no note.

Expected: no `[window-memory]` error lines in `~/.xsession-errors` (it is written in the Wayland session too); the one `starting:` line of each start is expected. Record any step that differs from X11.

### 34. The safety stop

1. Disable the extension. Write `~/.config/window-memory/safety.json` with the text `{"stopped": {"reason": "too-many-errors", "at": 1, "cinnamon": "6.0.5", "muffin": "6.0.1", "resume": "switch"}}`. Note the state of `~/.config/window-memory/state.json` (for example `md5sum`). Enable the extension.
2. Expected: nothing in the notification area at that start. `grep window-memory ~/.xsession-errors` shows, after the `starting:` line of that start, one `[window-memory] stopped (too-many-errors)` line that says to turn "Enable Window Memory" off and on to resume. Move a window, close it and reopen it: it is not restored, and `state.json` does not change.
3. Open the settings window, turn "Enable Window Memory" off and on. Expected: tracking resumes (move, close and reopen a window: it is restored), and `safety.json` no longer holds a `stopped` record.
4. Repeat step 1 with `"resume": "file"` in place of `"switch"`. Expected: the same as in step 2, except that the log line says to delete `~/.config/window-memory/safety.json` to resume (this form is written when the extension has no settings to resume with). Delete the file and disable and enable the extension: tracking resumes.
5. Optional, rare: restart Cinnamon three times within two minutes in one session. Expected: Window Memory stops with the notification "Window Memory stopped itself for safety: Cinnamon restarted repeatedly." and the text about resuming.

Expected throughout: no `[window-memory]` error lines.

### 35. The "Startup apps" tab matches Startup Applications (record)

This item and items 36 to 42 change your Startup Applications. Use clearly named test entries (for example "WM test"), and remove them at the end of each item. Before you start, note the list of `~/.config/autostart/` (`ls -l ~/.config/autostart/`). Run items 35 to 42 in an X11 session and again in a Cinnamon Wayland session, and record any step that differs between the two.

1. Open the extension settings. Expected: two tabs, "General" and "Startup apps". Both show the heading "Settings for window-memory@bootkicker" (in your language) at the top and end with the Version row ("Version", the number, the commit link and "Report an issue"). Open the second tab.
2. Open Startup Applications (System Settings, Startup Applications) next to it. Expected: the tab shows the same entries, in the same order (sorted by name). Each row has the icon, the name, the command in a smaller dimmed line, "delay N s", and a switch that matches the switch of the system tool. System entries are dimmed and marked "(system entry)". An entry that Startup Applications does not list (for example one hidden for Cinnamon) is not listed either. The list is about nine rows high, so the Version row sits near the bottom of the window. When the list has more entries than fit (add test entries until it does), a scrollbar is visible beside it and the mouse wheel and the arrow keys scroll it.
3. In Startup Applications add an entry named "WM test" with the command `true`. Expected: it appears in the tab without reopening the window. Delete it there. Expected: it disappears from the tab.

Record the number of entries in both lists.

### 36. A switch changes the entry, and Startup Applications agrees (record)

1. In Startup Applications add an entry "WM test" (command `true`). Turn its switch in the "Startup apps" tab off. Expected: the switch in Startup Applications is off as well, and `grep Autostart-enabled ~/.config/autostart/<file>.desktop` shows `X-GNOME-Autostart-enabled=false`.
2. Turn it on in the tab. Expected: Startup Applications shows it on, and the file says `true`.
3. Turn it off in Startup Applications. Expected: the tab shows it off.
4. Turn the switch of a system entry (one that is on) off in the tab. Expected: a file of the same name appears in `~/.config/autostart/` with `X-GNOME-Autostart-enabled=false`, and Startup Applications shows it off. Turn it on again. Expected: that file is deleted again, because it would only repeat the system file (Startup Applications does the same), and Startup Applications shows it on. The system file is never changed.
5. Remove the test entry (item 37 describes how) and put any changed system entry back as it was. Compare `ls -l ~/.config/autostart/` with the list you noted.

### 37. Remove: a user entry is deleted, a system entry is hidden (record)

1. Select "WM test" (a user entry) and press "Remove". Expected: it leaves the list, its file is deleted from `~/.config/autostart/`, and it is gone from Startup Applications.
2. Select a system entry (one marked "(system entry)") and press "Remove". Expected: it leaves the list and Startup Applications; the system file is unchanged, and `~/.config/autostart/` holds a file of the same name with `Hidden=true`.
3. Bring it back: pick its window (item 38, step 6) or delete the override file `~/.config/autostart/<name>.desktop`. Compare `ls -l ~/.config/autostart/` with the list you noted before you started.

### 38. Pick a window of a normal application (record)

A normal application is one with an entry in the applications menu (for example Files or a browser). Start one that is not in the list.

1. Press "Pick a window to start at login", then click the window. Expected: the entry is added at once, with its icon and name, switched on and with "delay 0 s", and a message says "Added <name>" with an Undo link. A file for it exists in `~/.config/autostart/`, and Startup Applications shows it.
2. Press Undo. Expected: the entry is removed and its file deleted, as before the pick.
3. Pick the window again, and then pick it once more. Expected: the second time no new entry is made and the message says "<name> is already in the list".
4. Turn the entry off in the tab and pick the window again. Expected: the entry is switched on and the message says "<name> switched on". Press Undo. Expected: it is off again.
5. Press "Remove" for that entry (a user entry: its file is deleted) and pick the window again. Expected: the message says "Added <name>", as in step 1. Press Undo. Expected: it is removed again.
6. Brought back: this step needs an application whose menu file and system autostart file have the same name, because the pick finds the entry by the name of the menu file. On Linux Mint, Update Manager qualifies (`mintupdate.desktop`); check with `ls /usr/share/applications /etc/xdg/autostart` that both folders hold the file, and that the entry is listed in the tab, marked "(system entry)" (an autostart file with `NoDisplay=true`, such as the one of Sticky Notes, is not listed). Remove it in the tab (item 37, step 2), start the application and pick its window. Expected: the entry is back in the list and the message says "<name> brought back"; no copy such as `<name>-1.desktop` is made, and the override file with `Hidden=true` is gone or no longer hides it. Press Undo. Expected: it is hidden again. Afterwards bring the entry back to its first state (pick the window again, or delete the test override file `~/.config/autostart/<name>.desktop`).
7. Press the button and then Escape. Expected: nothing is added and the settings window is usable.
8. Remove the test entries and compare `ls -l ~/.config/autostart/` with the list you noted.

### 39. Pick a window that is not a menu application (record)

Use a window that has no entry in the applications menu, for example `xterm -e sh -c 'sleep 600'` (on Wayland: `foot -a WMTEST sh -c 'sleep 600'` or the same xterm; no other test windows).

1. Press "Pick a window to start at login" and click that window. Expected: no entry is added at once. A form "Start at login" opens, filled in from the window: Name, Command (a best guess from the window's process; it can be short or differ from what you typed), Comment and Startup delay (0 to 100), with a line that says the command is a best guess to check before adding. Nothing is saved yet: `ls ~/.config/autostart/` is unchanged.
2. Press Cancel. Expected: the form closes and nothing is saved.
3. Pick the window again and empty the Command, then press Add. Expected: the form stays open and says "The command cannot be empty."; nothing is saved.
4. Enter a command and a name (for example "WM test" and `true`) and press Add. Expected: the entry is created, switched on, and appears in the list and in Startup Applications with the name, command and delay you set.
5. Remove the test entry and close the test window. Compare `ls -l ~/.config/autostart/` with the list you noted.

### 40. "Add or edit in Startup Applications…" opens the system tool (record)

1. Press "Add or edit in Startup Applications…". Expected: Cinnamon's Startup Applications opens. The button does not change anything by itself.
2. Edit an entry there (for example its delay) and close the window. Expected: the tab shows the change.

### 41. The General tab keeps its other rows

1. Open the extension settings and look at the "General" tab. Expected: the rows work as in items 1 and 25 to 28 (the order is now: switches, "Match windows by", "Also remember dialog windows", the never-remember list with its button row, the pick button, the shortcut, Forget all, backup, Version); the buttons work as before.
2. Open the "Startup apps" tab and go back to "General". Expected: nothing changed.

### 42. The tab is greyed while Window Memory is off

1. Turn "Enable Window Memory" off. Expected: in the "Startup apps" tab the whole list and its buttons are greyed out and cannot be used, like the rows of the "General" tab (except the "Enable Window Memory" switch).
2. Turn it on again. Expected: they can be used again.

### 43. The pick overlay: hint, highlight and name (record)

1. Open the extension settings and press "Pick a window to never remember" (below the never-remember list). Expected: a thin orange, semi-transparent, rounded box with dark gray text giving the instructions ("Click a window to never remember its application.  Esc or right-click to cancel.") at a fixed place at the top centre of the primary monitor, and a crosshair pointer.
2. Move the pointer over different windows. Expected: the window under the pointer is covered by a very transparent teal overlay with a solid teal border, and a small orange label with dark gray text in its top-left corner names the application (its WM class). Both follow the pointer from window to window. Over the desktop, a panel or a dialog, nothing is highlighted.
3. Do the same with "Pick a window to start at login" in the "Startup apps" tab. Expected: the same overlay with its own hint ("Click a window to start its application at login.  Esc or right-click to cancel.").
4. On a Wayland session (experimental) repeat steps 1 and 2 with a native Wayland window and an XWayland window. Record where the highlight and the label appear.

### 44. Cancelling a pick (record)

1. Press "Pick a window to never remember", then press Esc. Expected: the overlay and the crosshair are gone, nothing is added.
2. Press it again and right-click anywhere (a window, the desktop). Expected: the same, nothing is added, and no context menu opens in the window underneath.
3. Press it again and do nothing for 20 seconds. Expected: the pick ends by itself.
4. Press it, then click a window. Expected: its class is added to the list (checked), the overlay is gone.

### 45. The Enabled column of the never-remember list (record)

1. Look at the never-remember list. Expected: two columns, "Enabled" and "Never remember these applications (WM class)", with a divider between the headers and the checkboxes centred under "Enabled". Entries saved before this version show as checked.
2. Add an entry for an application with an open window, then untick it. Expected: that application's windows are remembered again (move one and look at the saved entries). Tick it again: they are not remembered.
3. With the entry unticked, pick a window of that application. Expected: the entry is ticked again and no second row appears.
4. Turn "Enable Window Memory" off. Expected: the column headers, rows and buttons are greyed out.

### 46. The Max windows field (record)

1. Look at the row of buttons under the never-remember list. Expected: the five buttons (add, remove, edit, move up, move down) at the left, and "Max windows" with a number field (default 500, buttons - and +) at the right end of the same row.
2. Set it to 10, close and reopen the settings window. Expected: it still shows 10. Set it back to 500.

### 47. Old lists and backups still work (record)

1. With a settings file whose never-remember list has rows without "enabled" (written by an earlier version), open the settings window. Expected: every row is ticked and still excludes its application.
2. Import a backup made by an earlier version. Expected: it imports, and the rows show as ticked.


## Results

For each item write pass or fail, the date, and the observation, in your results file. Include any `[window-memory]` lines from `~/.xsession-errors`, and for items 9, 12, 14, 20, 21, 23 and 24 the measurements asked for above.

## Developer reference

### Where things live

| What | Path |
|---|---|
| Source (edit here) | `files/window-memory@bootkicker/` in the repository |
| Installed copy Cinnamon loads | `~/.local/share/cinnamon/extensions/window-memory@bootkicker/` |
| Extension settings values (the switches and lists) | `~/.config/cinnamon/spices/window-memory@bootkicker/window-memory@bootkicker.json` |
| Saved window state | `~/.config/window-memory/state.json` |
| Staging file of a restore (normally absent; a restore removes it) | `~/.config/window-memory/import-pending.json` |
| Backups of a damaged state file | `~/.config/window-memory/state.json.bad-<time>` |
| Enabled extensions list | `gsettings get org.cinnamon enabled-extensions` |
| Cinnamon log (extension messages go here) | `~/.xsession-errors` |

Only the folder named `window-memory@bootkicker` is used. A copy of the extension under any other folder name must not exist in the extensions folder.

### Reinstall after every change

1. Commit the change (or at least save it): `git status`
2. Run `scripts/dev-reinstall.sh` (from the repository root). It replaces the installed copy and prints the commit it installed.
3. Disable and enable the extension (Extensions settings, or `gsettings`), or restart Cinnamon. Disabling the extension unloads its code, so enabling it again loads the changed files. Then run `scripts/dev-status.sh`: it must show that the installed copy matches the repository source.

### Uninstall by hand

1. Turn Window Memory off in Extensions (Manage).
2. `rm -rf ~/.local/share/cinnamon/extensions/window-memory@bootkicker`
3. Restart Cinnamon from its menu.

### Check that the new copy is the one running

- Cinnamon's process and when it started: `ps -o pid,lstart,cmd -C cinnamon`. The start time changes after a restart.
- Installed copy matches the repo: `diff -rq files/window-memory@bootkicker ~/.local/share/cinnamon/extensions/window-memory@bootkicker && echo same`
- Loads since the last restart: `grep 'Loaded extension window-memory' ~/.xsession-errors | tail -n 5`

### Live logs and errors

- Follow extension messages as they happen: `tail -f ~/.xsession-errors | grep --line-buffered -i 'window-memory'`
- Only errors: `grep -i 'window-memory' ~/.xsession-errors | grep -i 'error\|fail\|warning' | tail -n 20`
- Looking Glass (Cinnamon's debug window): Alt+F2, type `lg`, Enter. Errors tab.
- Settings values right now: `cat ~/.config/cinnamon/spices/window-memory@bootkicker/window-memory@bootkicker.json`

### Live state changes

- Watch saved entries as you test (prints NEW, CHANGED and REMOVED lines, once per second): `scripts/dev-watch-state.sh` (from the repository root)
- One snapshot of the state file: `python3 -m json.tool ~/.config/window-memory/state.json | less`
- Check that something is still capturing: `stat -c '%y' ~/.config/window-memory/state.json`. If the time moves while the extension is disabled, a copy of the code is still running. Restart Cinnamon.

### Scripts

| Script | What it does | Changes anything? |
|---|---|---|
| `scripts/dev-status.sh` | Compares the installed copy with the repository, shows the commit the settings will show, lists stale copies and enabled UUIDs, and warns when an old copy still captures. | No (read only) |
| `scripts/dev-reinstall.sh` | Replaces the installed copy with the current source and writes its version file. | Yes: the installed copy |
| `scripts/dev-watch-state.sh [file]` | Prints each saved entry as it is created, changed or removed, once per second. | No |
| `scripts/check.sh` | Runs the tests, Python and shell syntax checks, the translation template check, and reports git state. | No (rewrites the template only if it changed) |
| `scripts/package.sh` | Builds `dist/window-memory@bootkicker` in the Spices layout, with the version file. | Writes `dist/` |
| `scripts/write-version-json.sh <folder>` | Writes `version.json` (commit of the last change to the extension, short hash, dirty flag). | Writes the folder you pass |
| `scripts/release.sh <X.Y.Z> [--submit]` | Prepares a release: checks, version bump, tag, package, store branch, validation. `--submit` pushes and opens the pull request. | Local only without `--submit`; `--submit` checks that the repository is public |
