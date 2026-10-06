import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import St from "gi://St";

import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";

import { CERT_DIR, CERT_PATH, KEY_PATH } from "./common.js";

const COMMAND =
  `mkdir -p -m 700 ${GLib.shell_quote(CERT_DIR)} &&\n` +
  "openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \\\n" +
  "  -subj /CN=GLocalSend \\\n" +
  `  -keyout ${GLib.shell_quote(KEY_PATH)} \\\n` +
  `  -out ${GLib.shell_quote(CERT_PATH)}`;

const CertificateDialog = GObject.registerClass(
  { GTypeName: "GLocalSend_CertificateDialog" },
  class CertificateDialog extends ModalDialog.ModalDialog {
    constructor() {
      super({
        shellReactive: true,
        actionMode: Shell.ActionMode.ALL,
        shouldFadeIn: true,
        shouldFadeOut: true,
        destroyOnClose: true,
      });

      const title = new St.Label({
        style_class: "prompt-dialog-title",
        x_align: Clutter.ActorAlign.START,
        text: "Certificate needed",
      });
      const description = new St.Label({
        style_class: "prompt-dialog-description",
        x_align: Clutter.ActorAlign.START,
        text:
          "LocalSend needs a certificate to connect securely. " +
          "Run this command in a terminal, then turn LocalSend on again:",
      });
      description.clutter_text.line_wrap = true;
      const command = new St.Entry({
        style: "font-family: monospace; margin-top: 12px;",
        x_expand: true,
        can_focus: true,
        text: COMMAND,
      });
      command.clutter_text.editable = false;
      command.clutter_text.single_line_mode = false;

      this.contentLayout.add_child(title);
      this.contentLayout.add_child(description);
      this.contentLayout.add_child(command);

      this.setButtons([
        { label: "Close", action: () => this.close() },
        {
          label: "Copy Command",
          default: true,
          action: () => {
            St.Clipboard.get_default().set_text(
              St.ClipboardType.CLIPBOARD,
              COMMAND,
            );
            this.close();
          },
        },
      ] as any);
    }
  },
);

export function show(): void {
  new CertificateDialog().open();
}
