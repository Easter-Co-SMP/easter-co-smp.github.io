"""Published search contracts: canonical pages, crawl rules and static guide content."""
from html.parser import HTMLParser
import json
from pathlib import Path
import unittest
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

SITE = Path(__file__).resolve().parents[1] / 'site'
ORIGIN = 'https://launcher.easter.company'


class Head(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.meta, self.canonicals, self.schemas = {}, [], []
        self.in_schema = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            key = attrs.get('name', attrs.get('property'))
            self.meta.setdefault(key, []).append(attrs.get('content'))
        if tag == 'link' and attrs.get('rel') == 'canonical':
            self.canonicals.append(attrs.get('href'))
        self.in_schema = tag == 'script' and attrs.get('type') == 'application/ld+json'

    def handle_data(self, value):
        if self.in_schema:
            self.schemas.append(json.loads(value))

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_schema = False


class SearchMetadata(unittest.TestCase):
    def test_sitemap_contains_only_existing_indexable_canonical_documents(self):
        tree = ET.fromstring((SITE / 'sitemap.xml').read_text())
        urls = [item.text for item in tree.findall('{*}url/{*}loc')]
        self.assertEqual(len(urls), len(set(urls)))
        self.assertGreaterEqual(len(urls), 17)
        for url in urls:
            with self.subTest(url=url):
                parsed = urlsplit(url)
                self.assertEqual(parsed.scheme + '://' + parsed.netloc, ORIGIN)
                self.assertFalse(parsed.fragment or parsed.query)
                document = SITE / parsed.path.lstrip('/') / 'index.html'
                html = document.read_text()
                head = Head(html)
                self.assertEqual(head.canonicals, [url])
                self.assertEqual(html.count('<title>'), 1)
                self.assertEqual(len(head.meta['description']), 1)
                self.assertNotIn('noindex', ','.join(head.meta['robots']))
                self.assertEqual(head.meta['og:url'], [url])
                self.assertTrue(head.meta['og:title'][0])
                self.assertTrue(head.meta['twitter:description'][0])
                self.assertTrue(head.meta['og:image'][0].startswith(ORIGIN + '/assets/'))
                self.assertEqual(head.schemas[0]['@graph'][0]['url'], url)
                if '/wiki/' in url and parsed.path != '/minecraft/wiki/':
                    self.assertIn('<article class="wiki-article">', html)
                    self.assertIn('<h1>', html)
                    self.assertIn('wiki-article-section', html)
                    self.assertNotIn('Opening the field guide', html)
        for excluded in ('account/', 'store/', 'map/', 'wiki/', '404.html'):
            self.assertNotIn(ORIGIN + '/' + excluded, urls)

    def test_robots_allows_rendering_and_points_to_sitemap(self):
        robots = (SITE / 'robots.txt').read_text()
        self.assertIn('User-agent: *', robots)
        self.assertIn('Allow: /', robots)
        self.assertNotIn('Disallow:', robots)
        self.assertIn('Sitemap: ' + ORIGIN + '/sitemap.xml', robots)

    def test_private_error_and_moved_pages_stay_noindex_but_crawlable(self):
        for file in ('account/index.html', 'store/index.html', '404.html', 'map/index.html', 'wiki/index.html'):
            with self.subTest(file=file):
                self.assertIn('noindex', ','.join(Head((SITE / file).read_text()).meta['robots']))
