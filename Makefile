NAME=localsend-companion
DOMAIN=donnybeelo.github.com

.PHONY: all pack install clean

all: dist/extension.js

node_modules: package.json
	bun install

dist/extension.js dist/prefs.js: node_modules
	bunx tsc

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

$(NAME).zip: dist/extension.js dist/prefs.js schemas/gschemas.compiled
	@cp -r schemas dist/
	@if [ -d locale ]; then cp -r locale dist/; fi
	@cp metadata.json dist/
	@(cd dist && zip ../$(NAME).zip -9r .)

pack: $(NAME).zip

install: $(NAME).zip
	@touch ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@mv dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)

clean:
	@rm -rf dist node_modules $(NAME).zip

update-latest:
	git tag -d latest
	git push origin :latest
	git tag -f latest
	git push origin latest
	make pack
	open .
	open "https://extensions.gnome.org/upload/"
