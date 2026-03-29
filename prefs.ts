import Gio from 'gi://Gio';
import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
  DEFAULT_DISCOVERABLE_DURATION_MINUTES,
  DEFAULT_LAUNCHER_COMMAND,
  KEY_DISCOVERABLE_DURATION_MINUTES,
  KEY_LAUNCHER_COMMAND,
  SETTINGS_SCHEMA,
} from './common.js';

const DESCRIPTION = 'Launch LocalSend from GNOME Shell and keep it discoverable for a short window.';

export default class LocalSendCompanionPreferences extends ExtensionPreferences {
  override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings(SETTINGS_SCHEMA) as unknown as Gio.Settings;

    const page = new Adw.PreferencesPage({
      title: 'LocalSend',
    });

    const launcherGroup = new Adw.PreferencesGroup({
      title: 'Launcher',
      description: DESCRIPTION,
    });

    const launcherRow = new Adw.EntryRow({
      title: 'Launcher command',
    });
    launcherRow.text = settings.get_string(KEY_LAUNCHER_COMMAND) || DEFAULT_LAUNCHER_COMMAND;
    settings.bind(KEY_LAUNCHER_COMMAND, launcherRow as any, 'text', Gio.SettingsBindFlags.DEFAULT);

    const durationRow = Adw.SpinRow.new_with_range(1, 120, 1);
    durationRow.title = 'Discoverable window';
    durationRow.value = settings.get_int(KEY_DISCOVERABLE_DURATION_MINUTES) || DEFAULT_DISCOVERABLE_DURATION_MINUTES;
    settings.bind(KEY_DISCOVERABLE_DURATION_MINUTES, durationRow as any, 'value', Gio.SettingsBindFlags.DEFAULT);

    launcherGroup.add(launcherRow);
    launcherGroup.add(durationRow);
    page.add(launcherGroup);

    window.add(page);
  }
}
