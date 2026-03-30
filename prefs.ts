import Gio from "gi://Gio";
import Adw from "gi://Adw";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
	DEFAULT_PORT,
	KEY_ALIAS,
	KEY_AUTO_ACCEPT,
	KEY_DOWNLOAD_FOLDER,
	KEY_FINGERPRINT,
	KEY_PORT,
	SETTINGS_SCHEMA,
	ensureAlias,
	getDefaultDownloadFolder,
} from "./common.js";

const DEFAULT_AUTO_DISABLE_MINUTES = 10;

const DESCRIPTION =
	"Configure LocalSend sharing, incoming transfers, and the device identity broadcast on your LAN.";

export default class LocalSendCompanionPreferences extends ExtensionPreferences {
	override async fillPreferencesWindow(
		window: Adw.PreferencesWindow,
	): Promise<void> {
		const settings = this.getSettings(
			SETTINGS_SCHEMA,
		) as unknown as Gio.Settings;

		if (settings.get_string(KEY_ALIAS).trim().length === 0)
			settings.set_string(KEY_ALIAS, ensureAlias(""));

		if (settings.get_string(KEY_FINGERPRINT).trim().length === 0)
			settings.set_string(KEY_FINGERPRINT, "");

		if (settings.get_string(KEY_DOWNLOAD_FOLDER).trim().length === 0)
			settings.set_string(KEY_DOWNLOAD_FOLDER, getDefaultDownloadFolder());

		if (settings.get_int(KEY_PORT) <= 0)
			settings.set_int(KEY_PORT, DEFAULT_PORT);

		if (settings.get_int("auto-disable-minutes") <= 0)
			settings.set_int("auto-disable-minutes", DEFAULT_AUTO_DISABLE_MINUTES);

		const page = new Adw.PreferencesPage({
			title: "LocalSend",
		});

		const identityGroup = new Adw.PreferencesGroup({
			title: "Identity",
			description: DESCRIPTION,
		});

		const aliasRow = new Adw.EntryRow({
			title: "Device name",
		});
		settings.bind(
			KEY_ALIAS,
			aliasRow as any,
			"text",
			Gio.SettingsBindFlags.DEFAULT,
		);

		const portRow = Adw.SpinRow.new_with_range(1, 65535, 1);
		portRow.title = "Port";
		portRow.subtitle = "Discovery and transfer port used on the LAN";
		portRow.value = settings.get_int(KEY_PORT);
		settings.bind(
			KEY_PORT,
			portRow as any,
			"value",
			Gio.SettingsBindFlags.DEFAULT,
		);

		identityGroup.add(aliasRow);
		identityGroup.add(portRow);

		const transferGroup = new Adw.PreferencesGroup({
			title: "Receiving",
			description:
				"Incoming transfers are saved locally and approved from the Shell UI.",
		});

		const behaviorGroup = new Adw.PreferencesGroup({
			title: "Behavior",
			description:
				"Control how long LocalSend stays enabled after you turn it on.",
		});

		const folderRow = new Adw.EntryRow({
			title: "Download folder",
		});
		folderRow.text =
			settings.get_string(KEY_DOWNLOAD_FOLDER) || getDefaultDownloadFolder();
		settings.bind(
			KEY_DOWNLOAD_FOLDER,
			folderRow as any,
			"text",
			Gio.SettingsBindFlags.DEFAULT,
		);

		const autoAcceptRow = new Adw.SwitchRow({
			title: "Auto-accept incoming transfers",
			subtitle: "Approve requests without prompting",
		});
		settings.bind(
			KEY_AUTO_ACCEPT,
			autoAcceptRow as any,
			"active",
			Gio.SettingsBindFlags.DEFAULT,
		);

		transferGroup.add(folderRow);
		transferGroup.add(autoAcceptRow);

		const autoDisableRow = new Adw.SwitchRow({
			title: "Auto-disable LocalSend",
			subtitle: "Turn LocalSend off automatically after a period of time",
		});

		const autoDisableMinutesRow = Adw.SpinRow.new_with_range(1, 1440, 1);
		autoDisableMinutesRow.title = "Auto-disable timeout";
		autoDisableMinutesRow.subtitle =
			"Minutes before LocalSend turns itself off";
		autoDisableMinutesRow.value =
			settings.get_int("auto-disable-minutes") || DEFAULT_AUTO_DISABLE_MINUTES;

		settings.bind(
			"auto-disable-enabled",
			autoDisableRow as any,
			"active",
			Gio.SettingsBindFlags.DEFAULT,
		);
		settings.bind(
			"auto-disable-minutes",
			autoDisableMinutesRow as any,
			"value",
			Gio.SettingsBindFlags.DEFAULT,
		);

		behaviorGroup.add(autoDisableRow);
		behaviorGroup.add(autoDisableMinutesRow);

		page.add(identityGroup);
		page.add(transferGroup);
		page.add(behaviorGroup);
		window.add(page);
	}
}
