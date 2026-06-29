# GLocalSend

A GNOME Shell extension that integrates a LocalSend client into Quick Settings, letting you discover nearby devices and send files or text directly from the GNOME desktop.

## Requirements

- GNOME Shell 45 - 50
- GNOME development libraries for the extension's target Shell version
- `bun` for building the extension (`npm` might work, I haven't tested it)
- `glib-compile-schemas` for compiling GSettings schemas

## Installation

### Install from GNOME Extensions

You can install the extension directly from GNOME Extensions [here](https://extensions.gnome.org/extension/9632/glocalsend/). (As of this writing, it hasn't been approved yet)

### Build from source

```sh
bun install
make pack
```

This produces a `glocalsend.zip` archive in the project root.

To install the extension into your user extensions directory:

```sh
make install
```

This will build the extension, create the archive, and place the unpacked extension into:

`~/.local/share/gnome-shell/extensions/glocalsend@donnybeelo.github.com`

## Usage

A menu item should appear in the Quick Settings menu with the LocalSend icon. You can toggle the extension on or off from there, and send files or text to nearby devices by clicking the arrow.

## Incoming transfers

When another LocalSend device sends you files, a prompt will appear in GNOME Shell, unless auto-accept is enabled. 

Accepted files are saved to `~/Downloads/LocalSend` by default. You can change receiving behavior in the extension's preferences.
