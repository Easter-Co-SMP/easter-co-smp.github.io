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


def test_every_adapted_page_loads_the_adapter_after_the_palette():
    seen = 0
    for page in _pages():
        relative = str(page.relative_to(SITE))
        if not relative.startswith(ADAPTED) and not relative.startswith(tuple(p.rstrip("/") + "/" for p in ADAPTED)):
            continue
        seen += 1
        head = page.read_text().split("</head>", 1)[0]
        prefix = "../" * (len(page.relative_to(SITE).parts) - 1)
        assert f'href="{prefix}launcher-light-adapter.css"' in head, f"{relative} does not load the light adapter"
        assert head.rindex("launcher-light-adapter.css") > head.rindex("launcher-light.css"), relative
    assert seen >= 14, f"expected the wiki and the account page, found {seen}"


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
