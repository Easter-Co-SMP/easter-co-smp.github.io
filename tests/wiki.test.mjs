import assert from 'node:assert/strict';
import test from 'node:test';
import {groups, pages, searchPages, searchableText, sectionAliases} from '../site/wiki/pages.mjs';
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

test('the complete guide preserves original articles and publishes real custom-game content', () => {
  const expected = ['getting-started','health-and-death','the-world-and-its-regions','ships-and-sailing',
    'wildlife-and-pets','law-and-bounties','money-and-banking','crews-and-property',
    'cooking-and-crafting','village-services','equipment-and-enchanting','raids-and-expeditions'];
  assert.deepEqual(new Set(pages.map(page => page.id)), new Set(expected));
  for (const page of pages) {
    assert(!/sample page|demo page|coming soon|will eventually|placeholder/i.test(searchableText(page)));
    assert(page.related.length >= 2 && page.related.length <= 3);
    assert(page.sections.length >= 3 && page.sections.length <= 5);
    for (const section of page.sections) {
      for (const id of section.links || []) assert(pages.some(item => item.id === id), id);
      for (const key of ['paragraphs','paragraphsAfter','list','steps']) {
        if (section[key]) assert(section[key].every(text => typeof text === 'string' && text.trim()));
      }
      if (section.table) {
        assert(section.table.caption && section.table.headers.length >= 2);
        assert(section.table.rows.length);
        for (const row of section.table.rows) {
          assert.equal(row.length, section.table.headers.length);
          assert(row.every(cell => typeof cell === 'string' && cell.trim()));
        }
      }
      if (section.note) assert(section.note.title && section.note.text);
    }
  }
  for (const [id, aliases] of Object.entries(sectionAliases)) {
    const page = pages.find(page => page.id === id); assert(page);
    for (const target of Object.values(aliases)) assert(page.sections.some(section => section.id === target));
  }
});

test('search includes steps, notes and table cells that players need', () => {
  for (const [query, id] of [['Buy Obols','money-and-banking'],['Steel Alloy','equipment-and-enchanting'],
      ['repeat offence','law-and-bounties'],['Crystal Hearts','health-and-death'],
      ['crew accept','crews-and-property'],['Fire Resistance','cooking-and-crafting']]) {
    assert(searchPages(query).some(page => page.id === id), query);
  }
});
