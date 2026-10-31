"""One theme, one css: the launcher's palette lives in `site/theme.css` and nowhere else.

Owen, 2026-10-31: "let's use the theme and design and color pallet of launcher.easter.company
(easter-co-smp.github.io) on all products and make sure it's a DRY system. we want one theme,
one css, imported and re-used on all projects."

`site/theme.css` is that file. It holds custom properties and nothing else — the dark theme on
`:root`, the light theme on `html[data-easter-theme="light"]` — and every other sheet in `site/`
consumes the properties. A product vendors the file byte for byte and links it first; that is
the whole contract.

Five promises, each checked here:

  * every page links `theme.css` before any other stylesheet, at the right relative depth;
  * no sheet that this ticket converted restates a theme literal;
  * `styles.css` and `account-control.css` carry no `:root` palette of their own;
  * Diana's `launcher-light.css` (byte-pinned by tests/test_launcher_light.py) mirrors the
    light block token for token, so the one permitted duplication is a checked mirror;
  * `theme.css` itself carries no component rule — tokens only.

WHAT IS STILL RESTATING THE PALETTE, AND WHY IT IS COUNTED RATHER THAN CONVERTED.
`site/desktop.css`, `site/store/store.css`, `site/account/account.css` and
`site/minecraft/wiki/wiki.css` still write theme values as literals. They are not converted
here, and the reason is measured rather than tidy: every one of those literals is a
*theme-agnostic* value (`#e4c486` is the gold on a dark panel). Pointing them at `var(--app-gold)`
would turn them into the LIGHT gold (`#805b1c`) in the light theme, which changes how the
launcher window, the store and the account card paint there — a design change, not a
refactor, and one that needs the packed app to judge. So their counts are pinned below: a new
restatement anywhere fails, and removing one fails until the pin is updated.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
THEME = SITE / "theme.css"

#: Diana's light palette, vendored byte for byte. The one permitted restatement of the theme,
#: and only because it is the designer's own artefact: the check below keeps it in lockstep.
MIRROR = SITE / "launcher-light.css"

#: The sheets this ticket converted. A theme literal may not appear in any of them.
CONVERTED = ("styles.css", "web.css", "account-control.css", "launcher-light-adapter.css",
             "world-journal.css")

#: The palette a token block must not be declared in any more.
NO_OWN_PALETTE = ("styles.css", "account-control.css", "web.css")

#: Pages that redirect immediately and paint nothing of their own.
REDIRECT_STUBS = {"map/index.html", "wiki/index.html"}

HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")


def _strip_comments(text):
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def _theme_literals():
    return {match.lower() for match in HEX.findall(_strip_comments(THEME.read_text()))}


def _count_literal(text, literal):
    """Occurrences of `literal`, refusing a longer hex that merely starts with it."""
    return len(re.findall(re.escape(literal) + r"(?![0-9a-fA-F])", text, re.I))


def _pages():
    return sorted(page for page in SITE.rglob("*.html")
                  if str(page.relative_to(SITE)) not in REDIRECT_STUBS)


def test_the_theme_file_is_the_one_palette():
    text = _strip_comments(THEME.read_text())
    rules = re.findall(r"([^{}]+)\{([^{}]*)\}", text)
    selectors = [selector.strip() for selector, _ in rules]
    assert selectors == [":root", 'html[data-easter-theme="light"]'], (
        f"theme.css must hold exactly the dark and the light token block, found {selectors}")
    dark = dict(re.findall(r"(--[a-z-]+)\s*:\s*([^;]+)", rules[0][1]))
    light = dict(re.findall(r"(--[a-z-]+)\s*:\s*([^;]+)", rules[1][1]))
    for name, value in (("--ink", "#edf1e9"), ("--muted", "#abb8b8"), ("--gold", "#dbba79"),
                        ("--line", "#ffffff24"), ("--surface", "#10232bf2"),
                        ("--scrollbar-track", "#0a1c24"), ("--scrollbar-thumb", "#899b93"),
                        ("--modal-scrim", "#06131bc9"), ("--modal-blur", "5px"),
                        ("--app-panel", "#11252d"), ("--app-border", "#ffffff24"),
                        ("--app-muted", "#a8b9b4"), ("--app-gold", "#e4c486")):
        assert dark.get(name, "").strip() == value, (
            f"theme.css dark {name} is {dark.get(name)!r}, expected {value!r}")
    for name, value in (("--ink", "#2b2b36"), ("--muted", "#515b70"), ("--gold", "#805b1c"),
                        ("--line", "#c7d1e0"), ("--surface", "#f8faff"), ("--bg", "#eef2f9"),
                        ("--modal-scrim", "#28345280"), ("--app-gold", "var(--gold)")):
        assert light.get(name, "").strip() == value, (
            f"theme.css light {name} is {light.get(name)!r}, expected {value!r}")
    # The page ground and the type stack travel with the palette, not with the components.
    assert "background:#0d2029" in rules[0][1], "the dark page ground left theme.css"
    assert "font-family:Inter" in rules[0][1], "the type stack left theme.css"
    assert "background:var(--bg)" in rules[1][1], "the light page ground left theme.css"


def test_every_page_links_the_theme_first():
    pages = _pages()
    assert len(pages) >= 19, f"expected the whole site, found {len(pages)} pages"
    for page in pages:
        text = page.read_text()
        relative = str(page.relative_to(SITE))
        depth = len(page.relative_to(SITE).parts) - 1
        href = ("/" if relative == "404.html" else "../" * depth) + "theme.css"
        head = text.split("</head>", 1)[0]
        linked = re.findall(r'<link rel="stylesheet" href="([^"]+)"', head)
        assert linked, f"{relative} links no stylesheet at all"
        assert linked[0] == href, (
            f"{relative} links {linked[0]!r} before the theme; theme.css must be first")


def test_the_theme_is_not_restated_outside_its_file():
    literals = _theme_literals()
    assert len(literals) >= 30, f"theme.css named only {len(literals)} colours; is it the palette?"
    for name in CONVERTED:
        sheet = SITE / name
        text = _strip_comments(sheet.read_text())
        for literal in sorted(literals):
            count = _count_literal(text, literal)
            assert count == 0, (
                f"{name} restates the theme's {literal} {count}x; use the property instead")


#: Sheets outside this ticket's scope that still write the palette by hand, with the exact
#: count measured when the theme was extracted. Each hit is a theme-agnostic dark value; see
#: the module docstring for why converting them is a design change and not a refactor.
RESTATED_PENDING = {
    "desktop.css": {"#11252d": 2, "#a8b9b4": 3, "#e4c486": 9, "#ffffff24": 1},
    "store/store.css": {"#0d2029": 4, "#11252d": 1, "#a8b9b4": 2, "#e4c486": 1, "#edf1e9": 1},
    "account/account.css": {"#0d2029": 1, "#11252d": 1, "#a8b9b4": 1, "#e4c486": 1,
                            "#edf1e9": 1},
    "minecraft/wiki/wiki.css": {"#0d2029": 1},
}


def test_the_pending_restatements_are_exactly_the_ones_on_the_list():
    """A pinned count, not an exemption: a new literal fails, and so does a quiet removal."""
    literals = _theme_literals()
    measured = {}
    for name in RESTATED_PENDING:
        text = _strip_comments((SITE / name).read_text())
        hits = {literal: _count_literal(text, literal) for literal in literals}
        measured[name] = {literal: count for literal, count in hits.items() if count}
    assert measured == RESTATED_PENDING, (
        "the restatement debt in the not-yet-converted sheets has changed:\n"
        f"  expected {RESTATED_PENDING}\n  measured {measured}\n"
        "A new literal must use the theme property; a removal updates this list.")


def test_the_converted_sheets_declare_no_palette_of_their_own():
    for name in NO_OWN_PALETTE:
        text = _strip_comments((SITE / name).read_text())
        for selector, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", text):
            if ":root" not in selector and "data-easter-theme" not in selector:
                continue
            declared = re.findall(r"(--[a-z-]+)\s*:", declarations)
            assert not declared, (
                f"{name} still declares {declared} on {selector.strip()!r}; theme.css owns it")
    # styles.css specifically: the three blocks that used to hold the palette, the scrim pair
    # and the scrollbar set are gone, and the rules that *consume* the tokens stayed.
    styles = _strip_comments((SITE / "styles.css").read_text())
    declared = re.findall(r"(--(?:ink|muted|gold|line|surface|bg|modal-scrim|modal-blur|"
                          r"scrollbar-track|scrollbar-thumb|scrollbar-hover|scrollbar-active|"
                          r"app-panel|app-border|app-muted|app-gold))\s*:", styles)
    assert not declared, f"styles.css is declaring {sorted(set(declared))} again"
    assert "border:0}" in styles.replace(" ", "") or "var(--ink)" in styles, (
        "styles.css stopped consuming the tokens it used to")
    for consumer in ("scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)",
                     "background-color:var(--scrollbar-hover)"):
        assert consumer in styles, f"styles.css lost the rule that consumes {consumer!r}"


def test_dianas_light_sheet_mirrors_the_theme():
    """The one permitted duplication: her file is byte-pinned, so it must agree with ours."""
    theme_light = re.search(r'html\[data-easter-theme="light"\]\{(.*?)\}', _strip_comments(
        THEME.read_text()), re.S).group(1)
    her_light = re.search(r'html\[data-easter-theme="light"\]\{(.*?)\}', _strip_comments(
        MIRROR.read_text()), re.S).group(1)
    ours = dict((name, value.strip()) for name, value in
                re.findall(r"(--[a-z-]+)\s*:\s*([^;]+)", theme_light))
    hers = dict((name, value.strip()) for name, value in
                re.findall(r"(--[a-z-]+)\s*:\s*([^;]+)", her_light))
    # Every token she declares must agree with theme.css. The theme declares more than she
    # does (the scrim pair, the --app-* mapping), because the theme also serves the products
    # that never see her file; that is not drift, and it is checked the other way round.
    differing = {name: (ours.get(name), value) for name, value in hers.items()
                 if ours.get(name) != value}
    assert not differing, (
        f"launcher-light.css has drifted from theme.css: {differing}. "
        "Her file is byte-pinned and hers is the design, so theme.css is the one to change.")
    assert set(hers) <= set(ours), (
        f"launcher-light.css declares tokens the theme does not: {sorted(set(hers) - set(ours))}")
