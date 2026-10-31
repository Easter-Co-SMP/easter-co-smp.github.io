"""One household theme, authored once and vendored byte for byte.

Diana's package is `/home/diana/Desktop/household-theme/` and it is the authority. Two of its
files are ours to ship unchanged:

  `theme.css`              `--ec-*` tokens only, dark default plus the resolved-light block.
  `launcher-bindings.css`  her zero-literal bridge from those tokens onto the names this site
                           already speaks, plus the `filter:none` overrides that retire the
                           frozen sheet's obsolete `brightness(0)` mark rules.

Her README fixes the cascade, and this gate holds it:

  1. product base/layout/component sheets   (styles.css, web.css, desktop.css, ...)
  2. the frozen launcher-light.css, byte for byte
  3. launcher-light-adapter.css
  4. theme.css
  5. launcher-bindings.css

Five promises are checked here: her two files are her two files; the order is her README's;
nothing outside `theme.css` restates a household colour; the palette lives in no product sheet
while the document still paints itself from it; and the contrast pairs she computed in
CONTRAST.md still hold against the bytes we ship.

WHAT THE PINNED TABLE IS FOR. `site/desktop.css`, `site/store/store.css`,
`site/account/account.css` and `site/minecraft/wiki/wiki.css` still write household values as
literals. Converting them is not this ticket's mechanical step: every one of those literals is a
*theme-agnostic* value, so pointing it at `--ec-gold-action` would make it render the LIGHT gold
(`#805b1c`) on the launcher window, the store and the account card. That is a design change
needing the packed app, so the counts are pinned: a new literal fails, and a removal fails until
the pin is updated. They are measured, not forgotten.
"""
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
THEME = SITE / "theme.css"
BRIDGE = SITE / "launcher-bindings.css"
FROZEN = SITE / "launcher-light.css"
STUDIO = Path("/home/diana/Desktop/household-theme")

#: Her published hash of the frozen launcher sheet, from household-theme/README.md.
FROZEN_SHA256 = "0ca5dd952798600419db9d0bc6d1e9cb92becf75a1ec0e0c3c78340984cb9533"

#: The sheets this ticket converted. A household colour may not appear in any of them.
CONVERTED = ("styles.css", "web.css", "account-control.css", "launcher-light-adapter.css",
             "world-journal.css", "launcher-bindings.css")

#: Pages that redirect immediately and paint nothing of their own.
REDIRECT_STUBS = {"map/index.html", "wiki/index.html"}

#: Product sheets that must load before the frozen light sheet (her README step 1 before step 2).
PRODUCT_SHEETS = ("styles.css", "web.css", "desktop.css", "account-control.css",
                  "world-journal.css", "store.css", "wiki.css", "legal.css")

#: Sheets outside this ticket's scope that still write the palette by hand, pinned by count.
RESTATED_PENDING = {
    "desktop.css": {"#0005": 1, "#0b1d25": 2, "#11252d": 2, "#14262e": 2, "#382924": 1,
                    "#71857d": 2, "#8fd694": 1, "#a8b9b4": 3, "#e4c486": 9, "#f0d69f": 1,
                    "#f6c6b4": 1, "#ffffff24": 1},
    "store/store.css": {"#0d2029": 4, "#11252d": 1, "#25383d": 1, "#a8b9b4": 2, "#c0cbc6": 1,
                        "#e4c486": 1, "#edf1e9": 1},
    "account/account.css": {"#0b1d25": 1, "#0d2029": 1, "#11252d": 1, "#a8b9b4": 1,
                            "#e4c486": 1, "#edf1e9": 1},
    "minecraft/wiki/wiki.css": {"#0d2029": 1},
}

#: The pairs CONTRAST.md publishes, as (foreground token, ground token, ratio). Computed here
#: from the shipped bytes; a changed value or a dropped pair fails.
CONTRAST_PAIRS = {
    "dark": [
        ("--ec-ink", "--ec-bg", 14.62), ("--ec-ink", "--ec-panel", 13.84),
        ("--ec-ink", "--ec-panel-soft", 15.09), ("--ec-muted", "--ec-bg", 8.19),
        ("--ec-muted", "--ec-panel", 7.75), ("--ec-gold", "--ec-bg", 9.01),
        ("--ec-gold", "--ec-panel", 8.53), ("--ec-on-gold", "--ec-gold-action", 9.31),
        ("--ec-on-gold", "--ec-gold-hover", 11.01), ("--ec-panel", "--ec-gold-action", 9.45),
        ("--ec-danger", "--ec-danger-bg", 9.04), ("--ec-success", "--ec-success-bg", 9.21),
        ("--ec-disabled-ink", "--ec-disabled-bg", 7.36),
        ("--ec-control-line", "--ec-panel", 4.04),
        ("--ec-scrollbar-thumb", "--ec-scrollbar-track", 5.96),
    ],
    "light": [
        ("--ec-ink", "--ec-bg", 12.46), ("--ec-ink", "--ec-panel", 13.39),
        ("--ec-ink", "--ec-panel-soft", 11.58), ("--ec-muted", "--ec-bg", 6.07),
        ("--ec-muted", "--ec-panel", 6.53), ("--ec-gold", "--ec-bg", 5.45),
        ("--ec-gold", "--ec-panel", 5.86), ("--ec-on-gold", "--ec-gold-action", 6.12),
        ("--ec-on-gold", "--ec-gold-hover", 8.36), ("--ec-surface", "--ec-gold-action", 5.86),
        ("--ec-danger", "--ec-danger-bg", 5.93), ("--ec-success", "--ec-success-bg", 6.09),
        ("--ec-disabled-ink", "--ec-disabled-bg", 5.39),
        ("--ec-control-line", "--ec-panel", 3.72),
        ("--ec-scrollbar-thumb", "--ec-scrollbar-track", 3.21),
    ],
}


def _strip_comments(text):
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def _blocks(text):
    """Every rule in a sheet, keyed by its selector (an @charset is not part of one)."""
    body = _strip_comments(text)
    body = re.sub(r'@charset[^;]+;', '', body)
    return {selector.strip(): declarations
            for selector, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", body)}


def _tokens(declarations):
    return {name: value.strip() for name, value in
            re.findall(r"(--[a-z-]+)\s*:\s*([^;]+)", declarations)}


def _theme_tokens(scheme):
    blocks = _blocks(THEME.read_text())
    selector = ":root" if scheme == "dark" else 'html[data-easter-theme="light"]'
    assert selector in blocks, f"theme.css lost its {scheme} block"
    return _tokens(blocks[selector])


def _household_literals():
    return {match.lower() for match in
            re.findall(r"#[0-9a-fA-F]{3,8}\b", _strip_comments(THEME.read_text()))}


def _pages():
    return sorted(page for page in SITE.rglob("*.html")
                  if str(page.relative_to(SITE)) not in REDIRECT_STUBS)


# -- her files, byte for byte ---------------------------------------------------------------

def test_the_theme_and_its_bridge_are_dianas_files_byte_for_byte():
    for name in ("theme.css", "launcher-bindings.css"):
        source = STUDIO / name
        assert source.exists(), f"the studio copy is gone: {source}"
        assert (SITE / name).read_bytes() == source.read_bytes(), (
            f"site/{name} has drifted from Diana's package; re-copy her bytes, never edit them")


def test_theme_css_carries_tokens_and_nothing_else():
    blocks = _blocks(THEME.read_text())
    assert list(blocks) == [":root", 'html[data-easter-theme="light"]'], (
        f"theme.css must hold exactly her dark and light token blocks, found {list(blocks)}")
    for selector, declarations in blocks.items():
        for name, value in re.findall(r"([a-z-]+)\s*:\s*([^;]+)", declarations):
            assert name.startswith("--ec-"), (
                f"theme.css declares {name!r} on {selector}: the namespace is --ec-*, "
                "and it is tokens only - the product paints")


def test_the_bridge_is_zero_literal_and_retires_the_frozen_filter():
    text = _strip_comments(BRIDGE.read_text())
    literals = re.findall(r"#[0-9a-fA-F]{3,8}\b", text)
    assert not literals, f"launcher-bindings.css carries colours: {sorted(set(literals))}"
    # Loaded last, so this equal-specificity filter:none beats the frozen sheet's brightness(0).
    assert re.search(r"html\[data-easter-theme\] \.site-wordmark \.wordmark-mark,\s*"
                     r"html\[data-easter-theme\] \.signed-in-splash-mark\{filter:none\}", text), (
        "the bridge stopped neutralising the frozen sheet's brightness(0) mark rules")


def test_dianas_frozen_launcher_sheet_is_untouched():
    digest = hashlib.sha256(FROZEN.read_bytes()).hexdigest()
    assert digest == FROZEN_SHA256, (
        f"site/launcher-light.css is {digest}, not the {FROZEN_SHA256} Diana published")
    studio = STUDIO.parent / "launcher-light" / "launcher-light.css"
    assert studio.exists(), f"the studio copy is gone: {studio}"
    assert FROZEN.read_bytes() == studio.read_bytes()


# -- the cascade her README fixes -----------------------------------------------------------

def test_every_page_loads_the_cascade_in_dianas_order():
    pages = _pages()
    assert len(pages) >= 19, f"expected the whole site, found {len(pages)} pages"
    for page in pages:
        relative = str(page.relative_to(SITE))
        head = page.read_text().split("</head>", 1)[0]
        linked = re.findall(r'<link rel="stylesheet" href="([^"]+)"', head)
        assert linked, f"{relative} links no stylesheet at all"
        names = [href.rsplit("/", 1)[-1] for href in linked]
        for required in ("launcher-light.css", "launcher-light-adapter.css", "theme.css",
                         "launcher-bindings.css"):
            assert required in names, f"{relative} does not load {required}"
        order = [names.index(name) for name in
                 ("launcher-light.css", "launcher-light-adapter.css", "theme.css",
                  "launcher-bindings.css")]
        assert order == sorted(order), (
            f"{relative} loads the light sheets out of her order: {names}")
        light_at = names.index("launcher-light.css")
        for product in PRODUCT_SHEETS:
            if product in names:
                assert names.index(product) < light_at, (
                    f"{relative} loads {product} after the frozen light sheet")
        assert names.index("launcher-bindings.css") == len(names) - 1, (
            f"{relative} loads something after launcher-bindings.css: {names}")


# -- one source of colour -------------------------------------------------------------------

def test_the_theme_is_the_only_source_of_a_household_colour():
    household = _household_literals()
    assert len(household) >= 40, f"theme.css named only {len(household)} colours"
    for name in CONVERTED:
        text = _strip_comments((SITE / name).read_text())
        for literal in sorted(household):
            found = re.findall(re.escape(literal) + r"(?![0-9a-fA-F])", text, re.I)
            assert not found, (
                f"{name} restates the household colour {literal} {len(found)}x; "
                "read the token instead")


def test_the_frozen_sheet_declares_no_colour_the_theme_lacks():
    """Her byte-pinned sheet is the one permitted restatement - and only of these values."""
    frozen = _tokens(_blocks(FROZEN.read_text())['html[data-easter-theme="light"]'])
    theme_values = {value.lower() for value in _theme_tokens("light").values()}
    for name, value in frozen.items():
        if not value.startswith("#"):
            continue
        assert value.lower() in theme_values, (
            f"launcher-light.css declares {name}:{value}, a value the household theme does not")


def test_the_pending_restatements_are_exactly_the_ones_on_the_list():
    household = _household_literals()
    measured = {}
    for name in RESTATED_PENDING:
        text = _strip_comments((SITE / name).read_text())
        hits = {literal: len(re.findall(re.escape(literal) + r"(?![0-9a-fA-F])", text, re.I))
                for literal in household}
        measured[name] = {literal: count for literal, count in hits.items() if count}
    assert measured == RESTATED_PENDING, (
        "the restatement debt in the not-yet-converted sheets has changed:\n"
        f"  expected {RESTATED_PENDING}\n  measured {measured}\n"
        "A new literal must read the theme token; a removal updates this list.")


def test_no_product_sheet_declares_a_palette_of_its_own():
    for name in ("styles.css", "web.css", "account-control.css"):
        text = _strip_comments((SITE / name).read_text())
        for selector, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", text):
            if ":root" not in selector and "data-easter-theme" not in selector:
                continue
            for token, value in re.findall(r"(--[a-z-]+)\s*:\s*([^;]+)", declarations):
                assert value.strip().startswith("var("), (
                    f"{name} declares {token}:{value.strip()} on {selector.strip()!r}; "
                    "a product may only alias the theme's tokens")
    # The document still paints itself from the theme, or it falls back to the canvas colour.
    styles = _strip_comments((SITE / "styles.css").read_text())
    assert "background:var(--bg);color:var(--ink)" in styles, (
        "styles.css stopped painting the document from the theme's ground and ink")
    assert "--modal-scrim:var(--ec-scrim);--modal-blur:var(--ec-scrim-blur)" in styles, (
        "the one --modal-scrim declaration moved or lost its theme alias")


# -- her computed pairs ---------------------------------------------------------------------

def _parse(value):
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(character * 2 for character in value)
    if len(value) == 8:
        return (tuple(int(value[index:index + 2], 16) for index in (0, 2, 4)),
                int(value[6:8], 16) / 255)
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4)), 1.0


def _composited(value, ground):
    rgb, alpha = _parse(value)
    if alpha >= 1:
        return rgb
    return tuple(round(alpha * channel + (1 - alpha) * behind)
                 for channel, behind in zip(rgb, _parse(ground)[0]))


def _luminance(rgb):
    def linear(component):
        component = component / 255
        return component / 12.92 if component <= 0.04045 else ((component + 0.055) / 1.055) ** 2.4
    red, green, blue = (linear(component) for component in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def _ratio(foreground, ground, page_ground):
    first = _luminance(_composited(foreground, page_ground))
    second = _luminance(_composited(ground, page_ground))
    lighter, darker = max(first, second), min(first, second)
    return (lighter + 0.05) / (darker + 0.05)


def test_the_contrast_pairs_she_published_still_hold():
    """CONTRAST.md is the numbers; this asserts them against the bytes we ship."""
    for scheme, pairs in CONTRAST_PAIRS.items():
        tokens = _theme_tokens(scheme)
        page_ground = tokens["--ec-bg"]
        for foreground, ground, published in pairs:
            assert foreground in tokens, f"theme.css lost {foreground} in {scheme}"
            assert ground in tokens, f"theme.css lost {ground} in {scheme}"
            measured = _ratio(tokens[foreground], tokens[ground], page_ground)
            assert abs(measured - published) <= 0.05, (
                f"{scheme} {foreground} on {ground} measures {measured:.2f}:1, "
                f"CONTRAST.md publishes {published}:1")
            if "line" in foreground or "scrollbar" in foreground:
                assert measured >= 3.0, (
                    f"{scheme} {foreground} on {ground} is under the 3:1 edge floor")
            else:
                assert measured >= 4.5, (
                    f"{scheme} {foreground} on {ground} is under the 4.5:1 text floor")
