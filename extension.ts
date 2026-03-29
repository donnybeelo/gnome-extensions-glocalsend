import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Shell from "gi://Shell";
import GObject from "gi://GObject";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { formatBytes, KEY_AUTO_ACCEPT, SETTINGS_SCHEMA } from "./common.js";
import {
	type IncomingTransferRequest,
	type LocalSendPeer,
	LocalSendService,
} from "./localsend.js";

const EXTENSION_DIR = import.meta.url.replace(/file:\/\/(.*)\/[^/]+$/, "$1");
const INDICATOR_ICON = `file://${EXTENSION_DIR}/icon-symbolic.svg`;

const FileChooserXml = `
<node>
  <interface name="org.freedesktop.portal.FileChooser">
    <method name="OpenFile">
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.portal.Request">
    <signal name="Response">
      <arg type="u" name="response"/>
      <arg type="a{sv}" name="results"/>
    </signal>
  </interface>
</node>`;

const LocalSendToggle = GObject.registerClass(
	class LocalSendToggle extends QuickSettings.QuickMenuToggle {
		constructor() {
			super({
				title: "LocalSend",
				subtitle: "Starting",
				gicon: Gio.icon_new_for_string(INDICATOR_ICON) as any,
				menuEnabled: true,
			});
		}
	},
);

const LocalSendIndicator = GObject.registerClass(
	class LocalSendIndicator extends QuickSettings.SystemIndicator {
		_indicator: St.Icon;
		toggle: InstanceType<typeof LocalSendToggle>;

		constructor() {
			super();

			this._indicator = this._addIndicator();
			this._indicator.gicon = Gio.icon_new_for_string(INDICATOR_ICON) as any;
			this._indicator.visible = false;

			this.toggle = new LocalSendToggle();
			this.quickSettingsItems.push(this.toggle);
		}
		destroy() {
			this.quickSettingsItems?.forEach((i) => {
				i.destroy();
			});
			this._indicator.destroy();
			super.destroy();
		}
	},
);

const TextPromptDialog = GObject.registerClass(
	class TextPromptDialog extends ModalDialog.ModalDialog {
		private _titleLabel: St.Label;
		private _descriptionLabel: St.Label;
		private _errorLabel: St.Label;
		private _entry: St.Entry;
		private _resolve: ((value: string | null) => void) | null = null;
		private _activateSignalId: number | null = null;

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

			this._activateSignalId = this._entry.clutter_text.connect(
				"activate",
				() => {
					this._submit();
				},
			);

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
			if (this._resolve !== null) this._resolvePrompt(null);

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
			if (this._activateSignalId !== null) {
				this._entry.clutter_text.disconnect(this._activateSignalId);
				this._activateSignalId = null;
			}

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
	},
);

const IncomingTransferDialog = GObject.registerClass(
	class IncomingTransferDialog extends ModalDialog.ModalDialog {
		private _summaryLabel: St.Label;
		private _filesLabel: St.Label;
		private _resolve: ((value: boolean) => void) | null = null;

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

			this._summaryLabel = new St.Label({
				style_class: "prompt-dialog-title",
				x_align: Clutter.ActorAlign.START,
				y_align: Clutter.ActorAlign.START,
			});

			this._filesLabel = new St.Label({
				style_class: "prompt-dialog-description",
				x_align: Clutter.ActorAlign.START,
				y_align: Clutter.ActorAlign.START,
			});

			content.add_child(this._summaryLabel);
			content.add_child(this._filesLabel);
			this.contentLayout.add_child(content);

			this.setButtons([
				{
					label: "Decline",
					action: () => {
						this._resolvePrompt(false);
					},
				},
				{
					label: "Accept",
					default: true,
					action: () => {
						this._resolvePrompt(true);
					},
				},
			]);
		}

		prompt(
			sender: LocalSendPeer,
			request: IncomingTransferRequest,
		): Promise<boolean> {
			if (this._resolve !== null) this._resolvePrompt(false);

			this._summaryLabel.text = `${sender.alias} wants to send ${request.files.length} file${request.files.length === 1 ? "" : "s"}.`;
			this._filesLabel.text = request.files
				.map((file) => `${file.fileName} (${formatBytes(file.size)})`)
				.join("\n");

			return new Promise<boolean>((resolve) => {
				this._resolve = resolve;
				this.open();
			});
		}

		override destroy(): void {
			this._resolvePrompt(false);
			super.destroy();
		}

		private _resolvePrompt(value: boolean): void {
			const resolve = this._resolve;
			this._resolve = null;

			if (resolve !== null) resolve(value);

			this.close();
		}
	},
);

export default class LocalSendCompanionExtension extends Extension {
	private _settings!: Gio.Settings | null;
	private _indicator: InstanceType<typeof LocalSendIndicator> | null = null;
	private _indicatorClickedSignalId: number | null = null;
	private _service: LocalSendService | null = null;
	private _textPromptDialog: InstanceType<typeof TextPromptDialog> | null =
		null;
	private _incomingDialog: InstanceType<typeof IncomingTransferDialog> | null =
		null;

	enable(): void {
		this._settings = this.getSettings(
			SETTINGS_SCHEMA,
		) as unknown as Gio.Settings;

		this._service = new LocalSendService(this._settings, {
			onStateChanged: () => {
				this._syncIndicator();
			},
			onNotification: (summary, body, actionUri) => {
				const notification = Main.notify(summary, body);
				if (actionUri !== undefined) {
					void Gio.AppInfo.launch_default_for_uri(actionUri, null);
				}
			},
			onIncomingTransfer: async (request) => {
				if (this._settings!.get_boolean(KEY_AUTO_ACCEPT)) return true;

				const dialog = this._ensureIncomingDialog();
				return await dialog.prompt(request.sender, request);
			},
		});

		this._indicator = new LocalSendIndicator();
		this._indicatorClickedSignalId = this._indicator.toggle.connect(
			"clicked",
			() => {
				void this._runUserAction("Toggle LocalSend", async () => {
					this._service?.toggleEnabled();
				});
			},
		);

		Main.panel.statusArea.quickSettings.addExternalIndicator(
			this._indicator as any,
		);

		// Keep LocalSend disabled on startup until the user explicitly enables it.
		// The first toggle-on will auto-disable after 10 minutes.
		this._service?.stop();
		this._syncIndicator();
	}

	disable(): void {
		this._service?.stop();
		this._service = null;

		this._textPromptDialog?.destroy();
		this._textPromptDialog = null;

		this._incomingDialog?.destroy();
		this._incomingDialog = null;

		if (this._indicator !== null && this._indicatorClickedSignalId !== null) {
			this._indicator.toggle.disconnect(this._indicatorClickedSignalId);
			this._indicatorClickedSignalId = null;
		}

		if (this._indicator !== null) {
			(Main.panel.statusArea.quickSettings as any)._removeItems?.([
				this._indicator.toggle,
			]);
		}

		this._indicator?.destroy();
		this._indicator = null;
		this._settings = null;
	}

	private _syncIndicator(): void {
		if (this._indicator === null || this._service === null) return;

		const enabled = this._service.enabled;
		const peers = this._service.peers;
		const subtitle = enabled ? "Discoverable" : null;
		const subheader = !enabled
			? "Sharing paused"
			: peers.length === 0
				? "Listening for nearby devices"
				: `${peers.length} nearby device${peers.length === 1 ? "" : "s"}`;

		this._indicator._indicator.visible = enabled;
		this._indicator.visible = enabled;
		this._indicator.toggle.checked = enabled;
		this._indicator.toggle.subtitle = subtitle;
		this._indicator.toggle.menu.setHeader(
			Gio.icon_new_for_string(INDICATOR_ICON) as any,
			"LocalSend",
			subheader,
		);

		this._indicator.toggle.menu.removeAll();

		this._indicator.toggle.menu.addAction(
			"Refresh nearby devices",
			() => {
				this._service?.refreshPeers();
			},
			Gio.icon_new_for_string("view-refresh-symbolic") as any,
		);

		if (enabled && peers.length > 0) {
			for (const peer of peers) {
				const peerItem = new PopupMenu.PopupSubMenuMenuItem(peer.alias, true);
				const peerIcon = peerItem.icon;
				if (peerIcon !== undefined) {
					peerIcon.gicon = Gio.icon_new_for_string(
						"network-workgroup-symbolic",
					) as any;
				}

				peerItem.menu.addAction(
					"Send files",
					() => {
						void this._sendFilesToPeer(peer);
					},
					Gio.icon_new_for_string("document-send-symbolic") as any,
				);

				peerItem.menu.addAction(
					"Send clipboard text",
					() => {
						void this._sendClipboardTextToPeer(peer);
					},
					Gio.icon_new_for_string("edit-paste-symbolic") as any,
				);

				peerItem.menu.addAction(
					"Type text",
					() => {
						void this._promptAndSendText(peer);
					},
					Gio.icon_new_for_string("insert-text-symbolic") as any,
				);

				this._indicator.toggle.menu.addMenuItem(peerItem);
			}
		}
	}

	private async _sendFilesToPeer(peer: LocalSendPeer): Promise<void> {
		await this._runUserAction(`Send files to ${peer.alias}`, async () => {
			if (this._service === null)
				throw new Error("LocalSend service is not available.");

			const fileChooserInterfaceInfo = Gio.DBusNodeInfo.new_for_xml(
				FileChooserXml,
			).lookup_interface("org.freedesktop.portal.FileChooser");
			if (fileChooserInterfaceInfo === null) {
				throw new Error("Unable to load FileChooser DBus interface info.");
			}

			const proxy = new Gio.DBusProxy({
				g_connection: Gio.DBus.session,
				g_name: "org.freedesktop.portal.Desktop",
				g_object_path: "/org/freedesktop/portal/desktop",
				g_interface_name: "org.freedesktop.portal.FileChooser",
				g_interface_info: fileChooserInterfaceInfo,
			});

			const options = {
				modal: GLib.Variant.new_boolean(false),
				multiple: GLib.Variant.new_boolean(true),
				accept_label: GLib.Variant.new_string("Select"),
			};

			const handle = await new Promise<string>((resolve, reject) => {
				proxy.call(
					"OpenFile",
					GLib.Variant.new("(ssa{sv})", ["", "Select Files", options]) as any,
					Gio.DBusCallFlags.NONE,
					-1,
					null,
					(p, res) => {
						try {
							const result = p!.call_finish(res);
							const [requestHandle] = result.recursiveUnpack() as [string];
							resolve(requestHandle);
						} catch (error) {
							reject(error);
						}
					},
				);
			});

			const selectedUris = await new Promise<string[]>((resolve, reject) => {
				let subscriptionId = 0;

				subscriptionId = Gio.DBus.session.signal_subscribe(
					"org.freedesktop.portal.Desktop",
					"org.freedesktop.portal.Request",
					"Response",
					handle,
					null,
					Gio.DBusSignalFlags.NONE,
					(_connection, _senderName, _objectPath, _interfaceName, _signalName, parameters) => {
						try {
							Gio.DBus.session.signal_unsubscribe(subscriptionId);

							const [response, results] = parameters.recursiveUnpack() as [
								number,
								Record<string, unknown>,
							];
							if (response !== 0) {
								resolve([]);
								return;
							}

							const urisValue = results.uris;
							if (urisValue instanceof GLib.Variant) {
								const unpacked = urisValue.recursiveUnpack();
								resolve(
									Array.isArray(unpacked)
										? unpacked.filter(
											(uri): uri is string => typeof uri === "string",
										)
										: [],
								);
								return;
							}

							resolve(
								Array.isArray(urisValue)
									? urisValue.filter(
										(uri): uri is string => typeof uri === "string",
									)
									: [],
							);
						} catch (error) {
							reject(error);
						}
					},
				);
			});

			if (selectedUris.length === 0) return;

			const filePaths = selectedUris
				.map((uri) => Gio.File.new_for_uri(uri).get_path())
				.filter((path): path is string => path !== null && path.length > 0);

			if (filePaths.length === 0)
				throw new Error("Only local files can be sent.");

			await this._service.sendFilesToPeer(peer, filePaths);
		});
	}

	private async _sendClipboardTextToPeer(peer: LocalSendPeer): Promise<void> {
		await this._runUserAction(
			`Send clipboard text to ${peer.alias}`,
			async () => {
				const clipboard = St.Clipboard.get_default();
				const text = await new Promise<string>((resolve) => {
					clipboard.get_text(null, (_clipboard, value) => {
						resolve(value ?? "");
					});
				});

				await this._service?.sendClipboardTextToPeer(peer, text);
			},
		);
	}

	private async _promptAndSendText(peer: LocalSendPeer): Promise<void> {
		await this._runUserAction(`Send text to ${peer.alias}`, async () => {
			const dialog = this._ensureTextPromptDialog();
			const text = await dialog.prompt(
				`Send text to ${peer.alias}`,
				"Type or paste the text you want to hand off to LocalSend.",
			);

			if (text === null) return;

			await this._service?.sendTypedTextToPeer(peer, text);
		});
	}

	private _ensureTextPromptDialog(): InstanceType<typeof TextPromptDialog> {
		if (this._textPromptDialog === null)
			this._textPromptDialog = new TextPromptDialog();

		return this._textPromptDialog;
	}

	private _ensureIncomingDialog(): InstanceType<typeof IncomingTransferDialog> {
		if (this._incomingDialog === null)
			this._incomingDialog = new IncomingTransferDialog();

		return this._incomingDialog;
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
