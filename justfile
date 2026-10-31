set shell := ["bash", "-uc"]

serve:
    zola serve --interface 0.0.0.0 --base-url /

serve-drafts:
    zola serve --interface 0.0.0.0 --base-url / --drafts

build:
    zola build

check:
    zola check

all: check build

# Pin the tellus.rs submodule, which provides the styles and fonts, to its latest main.
update-tellus-site:
    git -C tellus-site fetch origin main
    git -C tellus-site checkout origin/main
    git add tellus-site
