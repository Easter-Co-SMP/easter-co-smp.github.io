import {groups, pages, searchPages, sectionAliases} from './pages.mjs';

const main = document.querySelector('#wiki-content');
const search = document.querySelector('#wiki-search');
const topics = document.querySelector('#wiki-topics');
const toggle = document.querySelector('.wiki-topics-toggle');
const paths = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/>',
  ship: '<path d="M12 3v13m0-12 7 9h-7M9 7l-4 6h4M3 16h18l-4 5H7z"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16m6-14v16"/>',
  scales: '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7h6zm14 0-3 7h6z"/>',
  bowl: '<path d="M3 12h18a9 9 0 0 1-18 0ZM8 21h8M8 3v4m4-5v5m4-4v4"/>',
  flag: '<path d="M5 22V3m0 1c5-5 9 5 14 0v11c-5 5-9-5-14 0"/>',
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = paths[name] || paths.compass;
  return svg;
}
function link(title, href, className) {
  const match=/^#\/([^/?]+)(?:\/([^/?]+))?$/.exec(href);
  if (!window.easterDesktop && match && pages.some(page=>page.id===match[1])) {
    href='./'+match[1]+'/'+(match[2]?'#'+match[2]:'');
  }
  const node = el('a', className, title); node.href = href; return node;
}
function card(page, compact = false) {
  const node = link('', '#/' + page.id, compact ? 'wiki-result' : 'wiki-card');
  node.append(icon(page.icon));
  const copy = el('div', 'wiki-card-copy');
  copy.append(el('span', 'wiki-card-group', page.group), el('h2', '', page.title), el('p', '', page.summary));
  node.append(copy, el('span', 'wiki-card-arrow', '↗')); return node;
}
function heading(eyebrow, title, description) {
  const header = el('header', 'wiki-page-header');
  header.append(el('p', 'eyebrow', eyebrow), el('h1', '', title));
  if (description) header.append(el('p', 'wiki-intro', description));
  return header;
}
topics.replaceChildren();
topics.append(link('Wiki overview', '#/', 'wiki-overview-link'));
for (const group of groups) {
  const section = el('div', 'wiki-topic-group');
  section.append(el('p', '', group));
  for (const page of pages.filter(page => page.group === group)) {
    const item = link('', '#/' + page.id); item.append(icon(page.icon), el('span', '', page.title)); section.append(item);
  }
  topics.append(section);
}
function overview() {
  main.append(heading('Easter Co. SMP · Field guide', 'Your guide to\nEaster Co. SMP.',
    'Find your bearings, chart a course, and make the world your own.'));
  const headingRow = el('div', 'wiki-section-heading');
  headingRow.append(el('h2', '', 'Browse the guide'), el('span', '', pages.length + ' guides'));
  main.append(headingRow);
  const cards = el('div', 'wiki-cards'); pages.forEach(page => cards.append(card(page))); main.append(cards);
}
function contents(page, className) {
  const nav = el('nav', className); nav.setAttribute('aria-label', 'On this page');
  for (const section of page.sections) nav.append(link(section.title, '#/' + page.id + '/' + section.id));
  return nav;
}
function article(page) {
  const crumb = el('nav', 'wiki-breadcrumb'); crumb.setAttribute('aria-label', 'Breadcrumb');
  crumb.append(link('Wiki', '#/'), el('span', '', '/'), el('span', '', page.group)); main.append(crumb);
  const reading = el('div', 'wiki-reading'), body = el('article', 'wiki-article');
  body.append(heading(page.group, page.title, page.summary));
  const mobileToc = el('details', 'wiki-mobile-toc'); mobileToc.append(el('summary', '', 'On this page'), contents(page, '')); body.append(mobileToc);
  for (const section of page.sections) {
    const block = el('section', 'wiki-article-section'); block.id = section.id;
    const h2 = el('h2'); h2.append(link(section.title, '#/' + page.id + '/' + section.id)); block.append(h2, el('p', '', section.text));
    if (section.list) {
      const list = el('ul'); section.list.forEach(text => list.append(el('li', '', text))); block.append(list);
    }
    for (const text of section.paragraphs || []) block.append(el('p', '', text));
    if (section.steps) {
      const list = el('ol', 'wiki-steps');
      section.steps.forEach(text => list.append(el('li', '', text))); block.append(list);
    }
    if (section.table) {
      const wrap = el('div', 'wiki-table-wrap');
      wrap.tabIndex = 0; wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', section.table.caption);
      const table = el('table', 'wiki-table');
      table.append(el('caption', '', section.table.caption));
      const head = el('thead'), row = el('tr');
      for (const title of section.table.headers) {
        const cell = el('th', '', title); cell.scope = 'col'; row.append(cell);
      }
      head.append(row); table.append(head);
      const body = el('tbody');
      for (const cells of section.table.rows) {
        const row = el('tr'); cells.forEach(text => row.append(el('td', '', text))); body.append(row);
      }
      table.append(body); wrap.append(table); block.append(wrap);
    }
    if (section.note) {
      const note = el('aside', 'wiki-note');
      note.append(el('strong', '', section.note.title), el('p', '', section.note.text)); block.append(note);
    }
    for (const text of section.paragraphsAfter || []) block.append(el('p', '', text));
    if (section.links?.length) {
      const links = el('nav', 'wiki-section-links'); links.setAttribute('aria-label', section.title + ' guides');
      for (const id of section.links) {
        const target = pages.find(item => item.id === id);
        links.append(link(target.title + ' →', '#/' + id));
      }
      block.append(links);
    }
    if (section.map) block.append(link('Open the world map ↗', '../map/', 'wiki-inline-link'));
    body.append(block);
  }
  const related = el('section', 'wiki-related'); related.append(el('h2', '', 'Keep exploring'));
  for (const id of page.related) {
    const next = pages.find(item => item.id === id); related.append(link(next.title + ' →', '#/' + id));
  }
  body.append(related);
  const outline = el('aside', 'wiki-outline'); outline.append(el('p', '', 'On this page'), contents(page, ''));
  reading.append(body, outline); main.append(reading);
}
function results(query) {
  const matches = searchPages(query);
  main.append(heading('The field guide', 'Search the wiki', query ? 'Results for “' + query + '”' : 'Search by title, topic, or a word in an article.'));
  const status = el('p', 'wiki-result-count', query ? matches.length + (matches.length === 1 ? ' article found' : ' articles found') : 'Start typing to explore the guide.');
  status.setAttribute('role', 'status'); main.append(status);
  if (!query) return;
  if (!matches.length) {
    const empty = el('div', 'wiki-empty'); empty.append(icon('compass'), el('h2', '', 'No articles found.'),
      el('p', '', 'Try a broader term, such as “ships”, “cooking”, or “regions”.'), link('Browse all articles →', '#/')); main.append(empty);
  } else { const list = el('div', 'wiki-results'); matches.forEach(page => list.append(card(page, true))); main.append(list); }
}
function render(focus = false) {
  // Article IDs and section IDs are resolved from our bundled catalogue, never HTML.
  const route = location.hash.slice(1) || '/';
  const [path, queryString = ''] = route.split('?');
  const [, id = '', requestedSection = ''] = path.split('/');
  const sectionId = sectionAliases[id]?.[requestedSection] || requestedSection;
  if (sectionId !== requestedSection) history.replaceState(null, '', '#/' + id + '/' + sectionId);
  const query = (new URLSearchParams(queryString).get('q') || '').slice(0, 120);
  const page = pages.find(item => item.id === id);
  main.replaceChildren();
  if (id === 'search') results(query);
  else if (page) article(page);
  else if (!id) overview();
  else {
    main.append(heading('The field guide', 'That page isn’t on the chart.',
      'The link may be out of date. Choose a topic or return to the wiki overview.'), link('Back to the wiki →', '#/', 'wiki-inline-link'));
  }
  document.title = (page ? page.title : id === 'search' ? 'Search the wiki' : 'Wiki') + ' — Easter Co. SMP';
  if (document.activeElement !== search) search.value = id === 'search' ? query : '';
  for (const item of topics.querySelectorAll('a')) {
    const active = item.hash === (page ? '#/' + page.id : !id ? '#/' : '');
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  toggle.setAttribute('aria-expanded', 'false'); topics.classList.remove('is-open');
  if (sectionId && page?.sections.some(section => section.id === sectionId)) {
    const section = document.getElementById(sectionId); section.tabIndex = -1; section.focus({preventScroll:true}); section.scrollIntoView();
  } else if (focus) { main.focus({preventScroll:true}); window.scrollTo(0, 0); }
}
toggle.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open)); topics.classList.toggle('is-open', open);
});
document.querySelector('.wiki-search').addEventListener('submit', event => { event.preventDefault(); searchWiki(); });
function searchWiki() {
  const hash = '#/search?q=' + encodeURIComponent(search.value.trim());
  if (location.hash.startsWith('#/search')) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  render();
}
search.addEventListener('input', searchWiki);
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault(); search.focus();
  }
});
document.querySelector('.wiki-skip').addEventListener('click', event => { event.preventDefault(); main.focus(); });
window.addEventListener('hashchange', () => render(true));
render();
