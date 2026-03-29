import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import St from "gi://St";
import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import {
	DEFAULT_DISCOVERABLE_DURATION_MINUTES,
	DEFAULT_LAUNCHER_COMMAND,
	KEY_DISCOVERABLE_DURATION_MINUTES,
	KEY_LAUNCHER_COMMAND,
	formatRemainingTime,
	parseCommandLine,
} from "./common.js";

const INDICATOR_ICON = "network-transmit-receive-symbolic";

class TextPromptDialog extends ModalDialog.ModalDialog {
	private _titleLabel: St.Label;
	private _descriptionLabel: St.Label;
	private _errorLabel: St.Label;
	private _entry: St.Entry;
	private _resolve: ((value: string | null) => void) | null = null;

	constructor() {
		super({
			shellReactive: true,
			actionMode: Shell.ActionMode.ALL,
			shouldFadeIn: true,
			shouldFadeOut: true,
			destroyOnClose: false,
		});

		const content = new St.BoxLayout({
			vertical: true,
			x_expand: true,
			y_expand: true,
			style_class: "prompt-dialog-content",
		});

		this._titleLabel = new St.Label({
			style_class: "prompt-dialog-title",
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.START,
		});

		this._descriptionLabel = new St.Label({
			style_class: "prompt-dialog-description",
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.START,
		});

		this._entry = new St.Entry({
			hint_text: "Type text to send",
			x_expand: true,
		});

		this._errorLabel = new St.Label({
			style_class: "prompt-dialog-error",
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.START,
		});

		content.add_child(this._titleLabel);
		content.add_child(this._descriptionLabel);
		content.add_child(this._entry);
		content.add_child(this._errorLabel);
		this.contentLayout.add_child(content);
		this.setInitialKeyFocus(this._entry);

		this._entry.clutter_text.connect("activate", () => {
			this._submit();
		});

		this.setButtons([
			{
				label: "Cancel",
				action: () => {
					this._resolvePrompt(null);
				},
			},
			{
				label: "Send",
				default: true,
				action: () => {
					this._submit();
				},
			},
		]);
	}

	prompt(
		title: string,
		description: string,
		initialText = "",
	): Promise<string | null> {
		if (this._resolve !== null) {
			this._resolvePrompt(null);
		}

		this._titleLabel.text = title;
		this._descriptionLabel.text = description;
		this._errorLabel.text = "";
		this._entry.text = initialText;

		return new Promise<string | null>((resolve) => {
			this._resolve = resolve;
			this.open();
			this.setInitialKeyFocus(this._entry);
			this._entry.grab_key_focus();
		});
	}

	override destroy(): void {
		this._resolvePrompt(null);
		super.destroy();
	}

	private _submit(): void {
		const text = this._entry.text;
		if (text.trim().length === 0) {
			this._errorLabel.text = "Enter text before sending.";
			this._entry.grab_key_focus();
			return;
		}

		this._resolvePrompt(text);
	}

	private _resolvePrompt(value: string | null): void {
		const resolve = this._resolve;
		this._resolve = null;

		if (resolve !== null) resolve(value);

		this.close();
	}
}

class LocalSendIndicator extends QuickSettings.SystemIndicator {
	menu: QuickSettings.QuickToggleMenu;

	constructor() {
		super();

		const indicator = this._addIndicator();
		indicator.icon_name = INDICATOR_ICON;

		this.menu = new QuickSettings.QuickToggleMenu(this);
		this.menu.setHeader(
			Gio.icon_new_for_string(INDICATOR_ICON),
			"LocalSend",
			"Ready to receive",
		);
	}
}

export default class LocalSendCompanionExtension extends Extension {
	private _settings!: Gio.Settings;
	private _indicator: LocalSendIndicator | null = null;
	private _discoverableUntil = 0;
	private _discoverableTimeoutId: number | null = null;
	private _discoverableProcessWatchId: number | null = null;
	private _promptDialog: TextPromptDialog | null = null;

	enable(): void {
		this._settings = this.getSettings() as unknown as Gio.Settings;

		this._indicator = new LocalSendIndicator();
		this._indicator.connect("clicked", () => {
			void this._runUserAction("Toggle discoverability", async () => {
				await this.toggleDiscoverability();
			});
		});

		this._indicator.menu.addAction(
			"Toggle discoverability",
			() => {
				void this._runUserAction("Toggle discoverability", async () => {
					await this.toggleDiscoverability();
				});
			},
			Gio.icon_new_for_string(INDICATOR_ICON) as any,
		);

		this._indicator.menu.addAction(
			"Send files...",
			() => {
				void this.sendFiles();
			},
			Gio.icon_new_for_string("folder-open-symbolic") as any,
		);

		this._indicator.menu.addAction(
			"Send clipboard text",
			() => {
				void this.sendClipboardText();
			},
			Gio.icon_new_for_string("edit-paste-symbolic") as any,
		);

		this._indicator.menu.addAction(
			"Type text...",
			() => {
				void this.promptAndSendText();
			},
			Gio.icon_new_for_string("insert-text-symbolic") as any,
		);

		Main.panel.statusArea.quickSettings.addExternalIndicator(
			this._indicator as any,
		);
		this._syncIndicator();
	}

	disable(): void {
		this._stopDiscoverableSession(false);

		this._promptDialog?.destroy();
		this._promptDialog = null;

		this._indicator?.destroy();
		this._indicator = null;
	}

	private async toggleDiscoverability(): Promise<void> {
		if (this._isDiscoverable()) {
			this._stopDiscoverableSession(false);
			return;
		}

		this._startDiscoverableSession();
	}

	private _isDiscoverable(): boolean {
		return this._discoverableUntil > Date.now();
	}

	private _startDiscoverableSession(): void {
		const durationMinutes =
			this._settings.get_int(KEY_DISCOVERABLE_DURATION_MINUTES) ||
			DEFAULT_DISCOVERABLE_DURATION_MINUTES;
		const expiresAt = Date.now() + durationMinutes * 60_000;

		this._launchLocalSend([], { hidden: true, watchExit: true });

		this._discoverableUntil = expiresAt;
		this._syncIndicator();
		Main.notify(`LocalSend is discoverable for ${durationMinutes} minutes`);

		this._discoverableTimeoutId = GLib.timeout_add_seconds(
			GLib.PRIORITY_DEFAULT,
			1,
			() => {
				if (!this._isDiscoverable()) {
					this._discoverableTimeoutId = null;
					this._stopDiscoverableSession(true);
					return GLib.SOURCE_REMOVE;
				}

				this._syncIndicator();
				return GLib.SOURCE_CONTINUE;
			},
		);
	}

	private _stopDiscoverableSession(announce: boolean): void {
		this._discoverableUntil = 0;

		if (this._discoverableTimeoutId !== null) {
			GLib.source_remove(this._discoverableTimeoutId);
			this._discoverableTimeoutId = null;
		}

		if (this._discoverableProcessWatchId !== null) {
			GLib.source_remove(this._discoverableProcessWatchId);
			this._discoverableProcessWatchId = null;
		}

		this._syncIndicator();

		if (announce) Main.notify("LocalSend discoverability ended");
	}

	private _syncIndicator(): void {
		if (this._indicator === null) return;

		const active = this._isDiscoverable();
		const subtitle = active
			? `Discoverable for ${formatRemainingTime((this._discoverableUntil - Date.now()) / 1000)}`
			: "Ready to receive";

		this._indicator.menu.setHeader(
			Gio.icon_new_for_string(INDICATOR_ICON),
			"LocalSend",
			subtitle,
		);
	}

	private async sendFiles(): Promise<void> {
		await this._runUserAction("Send files", async () => {
			const fileChooser = new Gtk.FileChooserNative({
				title: "Choose files to send with LocalSend",
				action: Gtk.FileChooserAction.OPEN,
				select_multiple: true,
			});

			let response: Gtk.ResponseType;
			try {
				response = await new Promise<Gtk.ResponseType>((resolve) => {
					fileChooser.connect("response", (_widget, resp) => {
						resolve(resp);
					});
					fileChooser.show();
				});
			} catch (error) {
				fileChooser.destroy();
				throw error;
			}

			if (response !== Gtk.ResponseType.ACCEPT) {
				fileChooser.destroy();
				return;
			}

			const files = fileChooser.get_files();
			fileChooser.destroy();

			const paths: string[] = [];

			for (let index = 0; index < files.get_n_items(); index++) {
				const file = files.get_item(index) as Gio.File | null;
				const path = file?.get_path();

				if (path === null || path === undefined)
					throw new Error("LocalSend can only send local files and folders.");

				paths.push(path);
			}

			if (paths.length === 0) return;

			this._launchLocalSend(paths, { hidden: false, watchExit: false });
			if (this._isDiscoverable()) this._stopDiscoverableSession(true);
		});
	}

	private async sendClipboardText(): Promise<void> {
		await this._runUserAction("Send clipboard text", async () => {
			const clipboard = St.Clipboard.get_default();
			const text = await new Promise<string>((resolve) => {
				clipboard.get_text(null, (_clipboard, value) => {
					resolve(value);
				});
			});

			if (text.trim().length === 0)
				throw new Error("The clipboard does not contain any text.");

			this._launchLocalSend(["--text", text], {
				hidden: false,
				watchExit: false,
			});
			if (this._isDiscoverable()) this._stopDiscoverableSession(true);
		});
	}

	private async promptAndSendText(): Promise<void> {
		await this._runUserAction("Send typed text", async () => {
			const dialog = this._ensurePromptDialog();
			const text = await dialog.prompt(
				"Send text with LocalSend",
				"Type or paste the text you want to hand off to LocalSend.",
			);

			if (text === null) return;

			this._launchLocalSend(["--text", text], {
				hidden: false,
				watchExit: false,
			});
			if (this._isDiscoverable()) this._stopDiscoverableSession(true);
		});
	}

	private _ensurePromptDialog(): TextPromptDialog {
		if (this._promptDialog === null)
			this._promptDialog = new TextPromptDialog();

		return this._promptDialog;
	}

	private _launchLocalSend(
		extraArgs: string[],
		options: { hidden: boolean; watchExit: boolean },
	): void {
		const commandLine =
			this._settings.get_string(KEY_LAUNCHER_COMMAND).trim() ||
			DEFAULT_LAUNCHER_COMMAND;
		const candidates = [commandLine, DEFAULT_LAUNCHER_COMMAND, "localsend"];

		let lastError: Error | null = null;

		for (const candidate of new Set(candidates)) {
			try {
				const argv = parseCommandLine(candidate);
				if (options.hidden) argv.push("--hidden");
				argv.push(...extraArgs);

				const spawnFlags =
					GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD;
				const [success, pid] = GLib.spawn_async(
					null,
					argv,
					null,
					spawnFlags,
					null,
				);

				if (!success || pid === null)
					throw new Error(`Failed to launch LocalSend using "${candidate}".`);

				if (options.watchExit) {
					this._discoverableProcessWatchId = GLib.child_watch_add(
						GLib.PRIORITY_DEFAULT,
						pid,
						() => {
							GLib.spawn_close_pid(pid);
							this._discoverableProcessWatchId = null;

							if (this._isDiscoverable()) this._stopDiscoverableSession(true);
						},
					);
				} else {
					GLib.spawn_close_pid(pid);
				}

				return;
			} catch (error) {
				lastError = error as Error;
			}
		}

		throw lastError ?? new Error("Unable to launch LocalSend.");
	}

	private async _runUserAction(
		title: string,
		action: () => Promise<void>,
	): Promise<void> {
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Main.notifyError(title, message);
		}
	}
}
