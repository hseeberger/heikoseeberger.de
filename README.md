# heikoseeberger.de

Heiko Seeberger's website and blog, served at [heikoseeberger.de](https://heikoseeberger.de) and
built with [Zola](https://www.getzola.org).

## Development

You need Zola 0.23 or later and [just](https://just.systems).

```shell
git clone --recurse-submodules git@github.com:hseeberger/heikoseeberger.de.git
just serve          # serve with live reload on all interfaces, port 1111
just serve-drafts   # the same, drafts included
just all            # check links and build into public/
```

## Posts

Posts live in `content/archives/` and are named `YYYY-MM-DD-slug.md`. Each one sets its URL with
`path`, so URLs stay stable when a title changes:

```toml
+++
title = "Post title"
date = 2026-10-23
path = "2026-10-23-slug"

[taxonomies]
tags = ["rust", "tellus"]
+++
```

A post with `draft = true` is not built; `just serve-drafts` shows it locally. Images go in
`static/img/` and are referenced as `/img/...`. Template syntax in a post, for example `${{ ... }}`
in a GitHub Actions example, has to be wrapped in `{% raw %}` and `{% endraw %}`.

The Atom feed at `/atom.xml` contains all posts. tellus.rs reads it at build time and lists the posts
tagged `tellus`, so its URL and the `category` elements of its entries must not change.

## Design

The design comes from [tellus.rs](https://tellus.rs), included as the submodule `tellus-site`.
`sass/main.scss` imports its Sass partials and replaces the accent color; `static/fonts` is a
symlink to its fonts. To pick up changes to the tellus.rs design, run `just update-tellus-site`.

## Deployment

Every push to `main` is checked, built and deployed to GitHub Pages. Pull requests are only checked
and built. The custom domain comes from `static/CNAME`.
