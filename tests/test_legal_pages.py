"""Guard the legal pages, and every footer that links to them.

The Privacy Policy and Terms of Service are only useful if a visitor can reach
them, and the footer is the only place the site offers them. That makes two
things worth guarding, and this file guards both: the documents themselves must
stay dated and answerable, and every page footer must carry a link to each one
that actually resolves to the document on disk.

The homepage footer's span order is a launcher contract, not a style choice.
site/desktop.js render() writes "Launcher <version>" into
`.home-footer>span:last-child`, so the motto span has to stay last and the legal
links have to sit in front of it. A future edit that appends the legal span
instead of inserting it would silently replace the links with the version text
on every page load inside the launcher, so the order is asserted here as well.

tests/test_site_assets.py explains why a scanner needs its own failing-fixture
tests; the same reasoning applies to the footer scan below. Every rule this file
enforces on site/ is also run against a temporary tree built to break it, so a
scanner that stops finding anything cannot pass as a clean site.
"""
import html.parser
import posixpath
import re
import tempfile
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'

# The two documents, with the heading each page opens with and the other document
# it has to link to.
LEGAL_DOCUMENTS = {
    'privacy': ('Privacy Policy', 'terms'),
    'terms': ('Terms of Service', 'privacy'),
}

# What a footer has to offer: the site path each link must resolve to, and the
# label the visitor reads. The path is normalised, so a trailing slash on the
# href makes no difference.
LEGAL_TARGETS = (('/legal/privacy', 'Privacy'), ('/legal/terms', 'Terms'))

# Pages that carry a footer today. The scan covers every page in site/, but this
# set is asserted too: a page that quietly loses its footer would otherwise drop
# out of the scan and take its legal links with it, and the scan would still pass.
PAGES_WITH_FOOTERS = (
    'index.html',
    'minecraft/map/index.html',
    'minecraft/wiki/index.html',
    'legal/privacy/index.html',
    'legal/terms/index.html',
)

EFFECTIVE_DATE = re.compile(r'Effective\s*<time datetime="\d{4}-\d{2}-\d{2}">\s*\d{1,2} \w+ \d{4}\s*</time>')
# The household's published contact addresses. Each page must offer the general one as a mailto,
# and the whole site must contain no personal address: these are company mailboxes that land in
# the same inbox, and a legal page that tells the world to write to a personal Gmail account is
# the exact thing this asserts against.
CONTACT = 'contact@easter.company'
COMPANY_ADDRESSES = ('contact@easter.company', 'legal@easter.company', 'support@easter.company')
FORBIDDEN_ADDRESSES = ('oceaster@gmail.com',)
CONTACT_LINK = '<a href="mailto:%s">%s</a>' % (CONTACT, CONTACT)
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


class PageParser(html.parser.HTMLParser):
    """Collect every footer on a page, its direct child spans, and its anchors."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.footers = []
        self.anchors = []
        self._stack = []
        self._footer = None
        self._footer_stack = None
        self._span = None
        self._anchor = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        classes = tuple((attributes.get('class') or '').split())
        # A direct child of the footer is a start tag seen while the stack is exactly the
        # footer's own ancestors plus the footer itself. That is what keeps the span inside
        # the copyright text from being mistaken for one of the footer's own spans.
        direct_child = self._footer is not None and self._stack == self._footer_stack
        if tag not in VOID_TAGS:
            self._stack.append(tag)
        if tag == 'footer':
            self._footer = {'classes': classes, 'hrefs': [], 'spans': []}
            self.footers.append(self._footer)
            self._footer_stack = list(self._stack)
        elif direct_child and tag == 'span':
            self._span = {'classes': classes, 'text': ''}
            self._footer['spans'].append(self._span)
        if tag == 'a':
            self._anchor = {'href': attributes.get('href'), 'text': ''}
            self.anchors.append(self._anchor)
            if self._footer is not None:
                self._footer['hrefs'].append(self._anchor)

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        while self._stack:
            if self._stack.pop() == tag:
                break
        if tag == 'a':
            self._anchor = None
        elif tag == 'span' and self._span is not None and self._footer_stack is not None:
            if len(self._stack) == len(self._footer_stack):
                self._span = None
        elif tag == 'footer':
            self._footer = None
            self._footer_stack = None
            self._span = None

    def handle_data(self, data):
        if self._anchor is not None:
            self._anchor['text'] += data
        if self._span is not None:
            self._span['text'] += data


def parse_page(path):
    parser = PageParser()
    parser.feed(Path(path).read_text(encoding='utf-8', errors='replace'))
    parser.close()
    return parser


def local_target(page, href):
    """The site path an href points at, resolved the way a browser resolves it.

    `page` is the page's path relative to the site root, so a relative href is
    resolved against the directory that page is served from. Returns None for a
    fragment, a mailto: link or anything off-site, which cannot be a legal page.
    """
    href = (href or '').strip()
    if not href or href.startswith(('#', 'mailto:', 'tel:', 'javascript:')):
        return None
    parts = urllib.parse.urlsplit(href)
    if parts.scheme or parts.netloc:
        return None
    page_directory = posixpath.dirname('/' + Path(page).as_posix())
    return posixpath.normpath(posixpath.join(page_directory, parts.path))


def footer_name(footer):
    return 'footer.%s' % ('.'.join(footer['classes']) or '(unclassed)')


def document_path(root, target):
    """Where the site serves a legal target from: /legal/privacy -> legal/privacy/index.html."""
    return Path(root) / (target.lstrip('/') + '/index.html')


def scan_footers(root):
    """Return (page, footer, problem) for every footer missing a legal link.

    Each footer must carry a link that resolves to each document, labelled so the
    visitor knows where it goes, and that document must exist in this tree.
    """
    root = Path(root)
    findings = []
    for path in sorted(root.rglob('*.html')):
        page = path.relative_to(root)
        parser = parse_page(path)
        for footer in parser.footers:
            links = [(anchor['href'], anchor['text']) for anchor in footer['hrefs']]
            for target, label in LEGAL_TARGETS:
                matching = [(href, text) for href, text in links if local_target(page, href) == target]
                if not matching:
                    findings.append((page.as_posix(), footer_name(footer), 'no %s link to %s' % (label, target)))
                    continue
                if not any(label in text for href, text in matching):
                    findings.append((page.as_posix(), footer_name(footer),
                                     'the %s link is not labelled %r: %r' % (target, label, matching)))
                if not document_path(root, target).exists():
                    findings.append((page.as_posix(), footer_name(footer),
                                     'the %s link points at a document that does not exist' % label))
    return findings


def scan_root_absolute(root, page='404.html'):
    """Return problems with a page whose legal links must not be relative.

    GitHub Pages serves 404.html for any request path under the domain, so a
    relative legal link there resolves against the path that was asked for, not
    against the file's own directory: /missing/legal/privacy/ is a 404 again.
    """
    root = Path(root)
    path = root / page
    if not path.exists():
        return [(page, 'page is missing')]
    parser = parse_page(path)
    findings = []
    if not parser.footers:
        findings.append((page, 'no footer carries the legal links'))
    links = [(anchor['href'], anchor['text']) for anchor in parser.anchors]
    for target, label in LEGAL_TARGETS:
        matching = [(href, text) for href, text in links if local_target(Path(page), href) == target]
        if not matching:
            findings.append((page, 'no %s link to %s' % (label, target)))
            continue
        if not any(label in text for href, text in matching):
            findings.append((page, 'the %s link is not labelled %r' % (target, label)))
        for href, text in matching:
            if not href.startswith('/'):
                findings.append((page, 'the %s link %r is relative, so it resolves against the '
                                       'requested path instead of the site root' % (label, href)))
    return findings


def home_footer_findings(root):
    """Return problems with the home footer's span order.

    site/desktop.js render() writes the launcher version into the last span of
    .home-footer. The legal span must not be that span, and the motto must be.
    """
    root = Path(root)
    parser = parse_page(root / 'index.html')
    footers = [footer for footer in parser.footers if 'home-footer' in footer['classes']]
    if not footers:
        return [('index.html', 'the home footer is missing or lost its .home-footer class')]
    spans = footers[0]['spans']
    if len(spans) != 3:
        return [('index.html', 'the home footer has %d spans, expected copyright, legal links and motto' % len(spans))]
    findings = []
    for position, span in enumerate(spans):
        if 'legal-links' in span['classes'] and position == len(spans) - 1:
            findings.append(('index.html', 'the legal span is the last span: site/desktop.js writes the launcher '
                                           'version into .home-footer>span:last-child and would replace the links'))
    legal = [position for position, span in enumerate(spans) if 'legal-links' in span['classes']]
    if not legal:
        findings.append(('index.html', 'no legal span in the home footer'))
    elif legal[0] != 1:
        findings.append(('index.html', 'the legal span is span %d, expected it between the copyright and the motto'
                         % (legal[0] + 1)))
    if 'Numquam Succumbe' not in spans[-1]['text']:
        findings.append(('index.html', 'the last home footer span is not the motto: %r' % spans[-1]['text'].strip()))
    return findings


def document_findings(root, name='privacy'):
    """Return problems with one legal document: heading, date, contact, cross link."""
    root = Path(root)
    path = root / 'legal' / name / 'index.html'
    if not path.exists():
        return [(name, 'document is missing at %s' % path.relative_to(root))]
    text = path.read_text(encoding='utf-8', errors='replace')
    parser = parse_page(path)
    page = Path('legal') / name / 'index.html'
    findings = []
    heading, other = LEGAL_DOCUMENTS[name]
    if '<h1>%s</h1>' % heading not in text:
        findings.append((name, 'the page does not open with an %r heading' % heading))
    if not EFFECTIVE_DATE.search(text):
        findings.append((name, 'no effective date'))
    if CONTACT not in text:
        findings.append((name, 'no contact address %r' % CONTACT))
    if not any((anchor['href'] or '').startswith('mailto:' + CONTACT) for anchor in parser.anchors):
        findings.append((name, 'the contact address is not a mailto: link'))
    for address in FORBIDDEN_ADDRESSES:
        if address in text:
            findings.append((name, 'a personal address %r is still published' % address))
    for address in COMPANY_ADDRESSES:
        if address in text and not any((anchor['href'] or '').startswith('mailto:' + address) for anchor in parser.anchors):
            findings.append((name, '%r is named but is not a mailto: link' % address))
    if not any(local_target(page, anchor['href']) == '/legal/' + other for anchor in parser.anchors):
        findings.append((name, 'no link to the %s document' % other))
    return findings


class LegalDocumentTests(unittest.TestCase):
    def test_both_documents_are_dated_and_answerable(self):
        findings = document_findings(SITE, 'privacy') + document_findings(SITE, 'terms')
        self.assertEqual(findings, [], 'A legal document lost something a reader needs: %r' % (findings,))

    def test_both_documents_link_to_each_other(self):
        self.assertEqual(document_findings(SITE, 'privacy'), [])
        self.assertEqual(document_findings(SITE, 'terms'), [])


class FooterTests(unittest.TestCase):
    def test_every_footer_carries_both_legal_links(self):
        findings = scan_footers(SITE)
        self.assertEqual(findings, [], 'A page footer does not link to the legal documents: %r' % (findings,))

    def test_the_pages_expected_to_have_footers_still_have_one(self):
        found = {path.relative_to(SITE).as_posix() for path in SITE.rglob('*.html') if parse_page(path).footers}
        self.assertLessEqual(set(PAGES_WITH_FOOTERS), found,
                             'A page lost its footer, so its legal links went with it')

    def test_404_legal_links_are_root_absolute(self):
        findings = scan_root_absolute(SITE)
        self.assertEqual(findings, [], 'The 404 page cannot link to the legal documents relatively: %r' % (findings,))

    def test_home_footer_keeps_the_motto_last(self):
        findings = home_footer_findings(SITE)
        self.assertEqual(findings, [], 'The launcher would overwrite the legal links: %r' % (findings,))

    def test_launcher_still_writes_the_version_into_the_last_home_footer_span(self):
        js = (SITE / 'desktop.js').read_text(encoding='utf-8')
        self.assertIn("document.querySelector('.home-footer>span:last-child')", js,
                      'site/desktop.js no longer writes the launcher version into the last home footer span; '
                      'this test and the footer order it guards assume it does')


class ScannerTests(unittest.TestCase):
    """The scans must fail on broken pages, not merely run."""

    PAGE = ('<!doctype html><html><body><main><h1>Page</h1></main>'
            '<footer class="page-footer">%s</footer></body></html>')
    LINKS = ('<span>© Easter LTD</span><span class="legal-links"><a href="/legal/privacy/">Privacy</a>'
             '<span aria-hidden="true">·</span><a href="/legal/terms/">Terms</a></span><span>Motto</span>')
    DOCUMENT = ('<!doctype html><html><body><main><h1>%s</h1>'
                '<p class="legal-meta">Effective <time datetime="2026-10-19">19 October 2026</time></p>'
                '<p>Email ' + CONTACT_LINK + '.</p>'
                '<p><a href="../%s/">The other document</a></p></main></body></html>')

    def build(self, root, footer=None, home_footer=None, page='index.html', documents=True, notfound=None):
        root = Path(root)
        (root / page).parent.mkdir(parents=True, exist_ok=True)
        (root / page).write_text(self.PAGE % (self.LINKS if footer is None else footer), encoding='utf-8')
        if home_footer is not None:
            (root / 'index.html').write_text(home_footer, encoding='utf-8')
        if documents:
            for name, (heading, other) in LEGAL_DOCUMENTS.items():
                path = root / 'legal' / name / 'index.html'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(self.DOCUMENT % (heading, other), encoding='utf-8')
        if notfound is not None:
            (root / '404.html').write_text(notfound, encoding='utf-8')
        return root

    def test_a_complete_page_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, home_footer='<!doctype html><html><body>'
                              '<footer class="home-footer"><span>© Easter LTD</span>'
                              '<span class="legal-links"><a href="/legal/privacy/">Privacy</a>'
                              '<span aria-hidden="true">·</span><a href="/legal/terms/">Terms</a></span>'
                              '<span>Numquam Succumbe</span></footer></body></html>')
            self.assertEqual(scan_footers(root), [])
            self.assertEqual(home_footer_findings(root), [])
            self.assertEqual(document_findings(root, 'privacy'), [])

    def test_a_footer_without_the_links_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, footer='<span>© Easter LTD</span><span>Motto</span>')
            self.assertEqual(scan_footers(root),
                             [('index.html', 'footer.page-footer', 'no Privacy link to /legal/privacy'),
                              ('index.html', 'footer.page-footer', 'no Terms link to /legal/terms')])

    def test_a_footer_with_only_one_link_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, footer='<span><a href="/legal/privacy/">Privacy</a></span>')
            self.assertEqual(scan_footers(root), [('index.html', 'footer.page-footer', 'no Terms link to /legal/terms')])

    def test_a_relative_link_from_a_nested_page_is_resolved_against_that_page(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, page='map/index.html',
                              footer='<span><a href="../legal/privacy/">Privacy</a>'
                                     '<a href="../legal/terms/">Terms</a></span>')
            self.assertEqual(scan_footers(root), [])
            (Path(temp) / 'map/index.html').write_text(
                self.PAGE % '<span><a href="legal/privacy/">Privacy</a><a href="legal/terms/">Terms</a></span>',
                encoding='utf-8')
            self.assertEqual(scan_footers(root),
                             [('map/index.html', 'footer.page-footer', 'no Privacy link to /legal/privacy'),
                              ('map/index.html', 'footer.page-footer', 'no Terms link to /legal/terms')])

    def test_a_link_to_a_missing_document_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, documents=False)
            self.assertEqual(scan_footers(root),
                             [('index.html', 'footer.page-footer',
                               'the Privacy link points at a document that does not exist'),
                              ('index.html', 'footer.page-footer',
                               'the Terms link points at a document that does not exist')])

    def test_a_relative_404_link_is_reported(self):
        page = ('<!doctype html><html><body><main><h1>Lost</h1></main><footer class="not-found-footer">'
                '<a href="legal/privacy/">Privacy</a><span aria-hidden="true">·</span>'
                '<a href="/legal/terms/">Terms</a></footer></body></html>')
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, notfound=page)
            self.assertEqual(len(scan_root_absolute(root)), 1)
            self.assertIn('is relative', scan_root_absolute(root)[0][1])
            (Path(temp) / '404.html').write_text(page.replace('legal/privacy/', '/legal/privacy/'), encoding='utf-8')
            self.assertEqual(scan_root_absolute(root), [])

    def test_a_404_page_without_a_footer_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, notfound='<!doctype html><html><body><main><h1>Lost</h1></main></body></html>')
            self.assertEqual(scan_root_absolute(root),
                             [('404.html', 'no footer carries the legal links'),
                              ('404.html', 'no Privacy link to /legal/privacy'),
                              ('404.html', 'no Terms link to /legal/terms')])

    def test_the_legal_span_last_in_the_home_footer_is_reported(self):
        last = ('<!doctype html><html><body><footer class="home-footer"><span>© Easter LTD</span>'
                '<span>Numquam Succumbe</span><span class="legal-links"><a href="/legal/privacy/">Privacy</a>'
                '<a href="/legal/terms/">Terms</a></span></footer></body></html>')
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, home_footer=last)
            findings = home_footer_findings(root)
            self.assertTrue(any('last span' in problem for page, problem in findings), findings)
            self.assertTrue(any('span 3' in problem for page, problem in findings), findings)

    def test_a_home_footer_whose_last_span_is_not_the_motto_is_reported(self):
        wrong = ('<!doctype html><html><body><footer class="home-footer"><span>© Easter LTD</span>'
                 '<span class="legal-links"><a href="/legal/privacy/">Privacy</a>'
                 '<a href="/legal/terms/">Terms</a></span></footer></body></html>')
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp, home_footer=wrong)
            findings = home_footer_findings(root)
            self.assertTrue(any('expected copyright' in problem for page, problem in findings), findings)

    def test_a_document_loses_its_date_contact_or_cross_link(self):
        with tempfile.TemporaryDirectory() as temp:
            root = self.build(temp)
            path = Path(temp) / 'legal/privacy/index.html'
            path.write_text(path.read_text(encoding='utf-8')
                            .replace('Effective <time', 'Published <time')
                            .replace(CONTACT, 'someone@example.invalid')
                            .replace('href="../terms/"', 'href="../elsewhere/"'), encoding='utf-8')
            findings = document_findings(root, 'privacy')
            self.assertEqual([problem for page, problem in findings],
                             ['no effective date',
                              'no contact address %r' % CONTACT,
                              'the contact address is not a mailto: link',
                              'no link to the terms document'])

    def test_the_scans_actually_read_the_published_site(self):
        self.assertTrue((SITE / 'index.html').exists())
        self.assertGreaterEqual(len(list(SITE.rglob('*.html'))), 6,
                                'The site tree disappeared; the scans would pass vacuously')


if __name__ == '__main__':
    unittest.main()
