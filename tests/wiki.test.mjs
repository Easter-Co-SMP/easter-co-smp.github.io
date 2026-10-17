import assert from 'node:assert/strict';
import test from 'node:test';
import {groups, pages, searchPages} from '../site/wiki/pages.mjs';
test('article links and section links resolve in the bundled catalogue', () => {
  const ids = new Set(pages.map(page => page.id));
  assert.equal(ids.size, pages.length);
  for (const page of pages) {
    assert(groups.includes(page.group));
    assert.match(page.id, /^[a-z]+(?:-[a-z]+)*$/);
    assert(page.title && page.summary && page.sections.length);
    assert.equal(new Set(page.sections.map(section => section.id)).size, page.sections.length);
    for (const section of page.sections) {
      assert.match(section.id, /^[a-z]+(?:-[a-z]+)*$/);
      assert(section.title && section.text);
    }
    assert(page.related.every(id => ids.has(id) && id !== page.id));
  }
});
test('search finds titles and body text, matches all terms, and handles literal input', () => {
  assert.equal(searchPages('  SHIPS  ')[0].id, 'ships-and-sailing');
  assert(searchPages('piloting').some(page => page.id === 'ships-and-sailing'));
  assert(searchPages('cooking baking').some(page => page.id === 'cooking-and-crafting'));
  assert.deepEqual(searchPages('ships nonexistent'), []);
  for (const query of ['', '  ', 'zzzzzz', '[', '<script>alert(1)</script>']) assert.deepEqual(searchPages(query), []);
});
