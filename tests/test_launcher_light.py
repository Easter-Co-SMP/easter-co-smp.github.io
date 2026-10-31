"""Every launcher page paints Diana's light palette, and only under the light attribute.

The site had a light switch and no light paint: `site/theme-publish.mjs` published
`html[data-easter-theme="light"]` and nothing in any stylesheet answered it, so the pages
measured identical pixels in both schemes (2026-10-31, production: `/`, `/store/`, `/account/`,
`/minecraft/wiki/` all `rgb(13,32,41)` ground with `attr=light`).

`site/launcher-light.css` is Diana's palette, vendored byte for byte from her studio. This gate
keeps three promises about it:

  * every page that paints links it and the pre-paint script, at the right relative depth;
  * the vendored copy still matches her studio file, so a local "fix" cannot drift from the
    design she signed;
  * every selector in it is scoped to the light attribute, because an unscoped declaration
    inside a light sheet would repaint the dark theme.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
STUDIO = Path("/home/diana/Desktop/launcher-light/launcher-light.css")

#: The product stylesheets a page can carry. The palette must load after whichever it uses.
PRODUCT_SHEETS = ("styles.css", "web.css", "desktop.css", "account-control.css",
                  "world-journal.css", "store.css", "wiki.css", "legal.css")

#: Pages that redirect immediately and paint nothing of their own.
REDIRECT_STUBS = {"map/index.html", "wiki/index.html"}


def _pages():
    return sorted(p for p in SITE.rglob("*.html") if str(p.relative_to(SITE)) not in REDIRECT_STUBS)


def test_every_page_links_the_light_sheet_and_the_pre_paint_script():
    pages = _pages()
    assert len(pages) >= 19, f"expected the whole site, found {len(pages)} pages"
    for page in pages:
        text = page.read_text()
        relative = str(page.relative_to(SITE))
        depth = len(page.relative_to(SITE).parts) - 1
        prefix = "../" * depth
        head = text.split("</head>", 1)[0]
        assert f'href="{prefix}launcher-light.css"' in head, f"{relative} does not link the light palette in its head"
        assert f'src="{prefix}theme-early.js"' in head, f"{relative} does not load the pre-paint theme script"
        # It must come after every product stylesheet it adapts, because it overrides them.
        # A later adapter of our own (the wiki's) is allowed to follow it.
        light_at = head.rindex(f'href="{prefix}launcher-light.css"')
        for name in PRODUCT_SHEETS:
            at = head.find(f'{name}"')
            if at != -1:
                assert light_at > at, f"{relative} loads the light palette before {name}"
        assert any(head.find(f'{name}"') != -1 for name in PRODUCT_SHEETS), f"{relative} links no product stylesheet at all"
        for asset in ("launcher-light.css", "theme-early.js"):
            assert (SITE / asset).exists(), f"{asset} is missing from site/"


def test_the_vendored_palette_is_the_designers_own_file():
    vendored = (SITE / "launcher-light.css").read_bytes()
    assert STUDIO.exists(), f"the studio copy is gone: {STUDIO}"
    assert vendored == STUDIO.read_bytes(), "site/launcher-light.css has drifted from Diana's studio copy"


#: Pages whose own stylesheet the palette was not drawn against, so they need the adapter.
ADAPTED = ("minecraft/wiki/", "account/")


def test_every_page_loads_the_adapter_after_the_palette():
    for page in _pages():
        relative = str(page.relative_to(SITE))
        head = page.read_text().split("</head>", 1)[0]
        prefix = "../" * (len(page.relative_to(SITE).parts) - 1)
        assert f'href="{prefix}launcher-light-adapter.css"' in head, f"{relative} does not load the light adapter"
        assert head.rindex("launcher-light-adapter.css") > head.rindex("launcher-light.css"), relative


def test_the_light_sheets_never_repaint_the_dark_theme():
    for sheet in ("launcher-light.css", "launcher-light-adapter.css"):
        _assert_scoped(SITE / sheet)


def _assert_scoped(path):
    text = path.read_text()
    # Drop comments, then every rule must be either the light-scoped block itself or a
    # selector list in which every selector carries the light attribute.
    body = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    for selector_list, _ in re.findall(r"([^{}]+)\{([^{}]*)\}", body):
        for selector in selector_list.split(","):
            selector = selector.strip()
            if not selector:
                continue
            assert "data-easter-theme=\"light\"" in selector, f"unscoped light-palette selector: {selector!r}"


def test_the_pre_paint_script_publishes_only_a_resolved_theme():
    script = (SITE / "theme-early.js").read_text()
    for needle in ("prefers-color-scheme: light", "dataset.easterTheme", "style.colorScheme"):
        assert needle in script, f"theme-early.js lost {needle!r}"
    assert '"system"' not in script and "'system'" not in script, (
        "the contract resolves system before publishing; a literal 'system' has no palette")


#: Every class name that addresses a logo mark. A rule matching one of these may size the
#: artwork; it may not recolour it.
MARK_CLASSES = (".wordmark-mark", ".signed-in-splash-mark", ".mark-for-dark", ".mark-for-light")

#: The one asset the mark is, in both themes, on both surfaces.
MARK_ASSET = "assets/ec-logo.svg"


def test_the_mark_is_an_asset_not_a_filter():
    """The phoenix is a picture of a burning bird, not a themed glyph.

    Owen, 2026-10-31: "the Easter Co. phoenix icon is black in light mode, but it should not
    be, it's a complex detailed fire-y phoenix icon, should not be impacted by the theme at
    all." Three things recoloured it and each is held out here by name: Diana's provisional
    filter:brightness(0) on the header mark and on the splash (site/launcher-light.css:54-55),
    which the adapter neutralises because her sheet is vendored byte for byte; and a swap to
    the flattened ink cut assets/ec-logo-ink.svg, which is gone from the repository.
    """
    marked = 0
    for page in _pages():
        markup = page.read_text()
        assert "ec-logo-ink" not in markup and "splash-mark-light" not in markup, (
            f"{page.relative_to(SITE)} still names a theme cut of the mark")
        mark = re.search(r'<img class="wordmark-mark" src="([^"]+)"', markup)
        if mark is None:
            continue  # 404.html is a standalone page with no header of its own.
        marked += 1
        assert mark.group(1).endswith(MARK_ASSET), (
            f"{page.relative_to(SITE)} header mark is {mark.group(1)!r}, expected {MARK_ASSET}")
    assert marked >= 19, f"only {marked} pages carry the wordmark's mark; expected the whole site"
    # The signed-in splash carries the same asset once: one mark, no theme cut beside it.
    index = (SITE / "index.html").read_text()
    splash = re.findall(r'<img class="signed-in-splash-mark[^"]*" src="([^"]+)"', index)
    assert splash == [MARK_ASSET], f"the splash carries {splash}, expected exactly {MARK_ASSET!r}"
    # The adapter neutralises both of the rules Diana's sheet still carries.
    adapter = (SITE / "launcher-light-adapter.css").read_text()
    assert 'html[data-easter-theme="light"] .site-wordmark .wordmark-mark{filter:none}' in adapter, (
        "the header mark is left under Diana's brightness(0) filter")
    assert 'html[data-easter-theme="light"] .signed-in-splash-mark{filter:none}' in adapter, (
        "the splash mark is left under Diana's brightness(0) filter")
    # Diana's own file is untouched: it still carries the provisional rule, and it is still hers.
    vendored = (SITE / "launcher-light.css").read_text()
    assert re.search(r'html\[data-easter-theme="light"\] \.site-wordmark \.wordmark-mark,\s*'
                     r'html\[data-easter-theme="light"\] \.signed-in-splash-mark\{filter:brightness\(0\)\}',
                     vendored), "the provisional rule this adapter overrides has moved or changed shape"
    assert (SITE / "launcher-light.css").read_bytes() == STUDIO.read_bytes(), (
        "site/launcher-light.css has drifted from Diana's studio copy")
    # No flattened cut is left behind for a theme to swap back to.
    assert not (SITE / "assets" / "ec-logo-ink.svg").exists()


def test_no_stylesheet_recolours_the_mark():
    """No filter, opacity or colour of any kind lands on a logo mark.

    Diana's vendored launcher-light.css is byte-pinned, so its provisional filter rule cannot
    be edited in place; the adapter's filter:none overrides are the correction, and the test
    above asserts both of them by name. Every other sheet in site/ is scanned outright: a rule
    that addresses a mark may declare `filter:none` and nothing else that touches its colour.
    """
    sheets = sorted(SITE.glob("*.css"))
    assert len(sheets) >= 5, f"expected the site's stylesheets, found {[s.name for s in sheets]}"
    for sheet in sheets:
        if sheet.name == "launcher-light.css":
            continue
        body = re.sub(r"/\*.*?\*/", "", sheet.read_text(), flags=re.S)
        for selector_list, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", body):
            for selector in selector_list.split(","):
                if not any(mark_class in selector for mark_class in MARK_CLASSES):
                    continue
                for declaration in declarations.split(";"):
                    name, _, value = declaration.partition(":")
                    name, value = name.strip(), value.strip()
                    if name == "filter":
                        assert value == "none", (
                            f"{sheet.name}: {selector.strip()!r} filters the mark: {value!r}")
                    else:
                        assert name not in {"opacity", "color", "fill", "background", "mix-blend-mode"}, (
                            f"{sheet.name}: {selector.strip()!r} paints the mark: {declaration.strip()!r}")


def test_the_wiki_rail_marks_the_current_page_like_a_shape_not_a_guess():
    """Diana, 2026-10-31: wash alone is too close to paper, so the current item also carries a
    3px inset gold stroke. It must hang off the rail's own aria-current (which wiki.js and
    article.js set) rather than a colour comparison, must not move the label, and must not
    swallow hover or the focus outline.
    """
    adapter = " ".join((SITE / "launcher-light-adapter.css").read_text().split())
    rule = ('html[data-easter-theme="light"] #wiki-topics a[aria-current]{ '
            'background:var(--gold-wash);color:var(--gold);box-shadow:inset 3px 0 0 var(--gold)}')
    assert rule in adapter, "the current-page state is missing or has drifted from the reviewed values"
    # A stroke drawn as a box-shadow cannot shift the label; a border would.
    assert "a[aria-current]{border" not in adapter
    # Hover stays distinct from the persistent state.
    assert ("html[data-easter-theme=\"light\"] #wiki-topics a:not([aria-current]):hover{color:var(--ink)}"
            in adapter), "hover must be scoped away from the current page"
    # And the marker exists in the rail's own code, not inferred from colour.
    wiki_js = (SITE / "minecraft" / "wiki" / "wiki.js").read_text()
    assert "aria-current" in wiki_js, "the rail no longer sets the semantic attribute this state hangs off"
