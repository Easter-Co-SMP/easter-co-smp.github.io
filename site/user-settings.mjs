// THE ACCOUNT-WIDE USER SETTINGS PANEL, AS ONE MOUNTABLE OBJECT.
//
// Ported from Diana's prototype (/home/diana/Documents/UserSettings/index.html) and her handoff
// beside it (DESIGN-SPEC.md, 2026-10-30). Her words, her four sections, her geometry, her
// attention behaviour, and exactly one change of substance: the panel now reads and writes the
// account document the cloud already serves instead of localStorage. Every sentence a player
// reads is copied from her spec's "Exact production copy" section rather than re-written, because
// a settings panel that speaks its own dialect on each surface is how a household ends up with
// four of them.
//
// WHAT THIS FILE IS NOT. It is not a page, a route or a link to e-server: e-server is a different
// product on a different origin, and a `Settings` row that navigates there would take the player
// away from the account they were editing. It draws a modal over whatever surface mounted it.
//
// ONE COMPONENT, HOST PALETTE. Diana's frozen token contract is five inputs — --surface, --border,
// --text, --muted, --accent — and site/account-control.css maps them from the host's own
// declarations (its header says how). Nothing here names a colour, a font size outside her
// measurements, or a surface's product palette. The panel looks like Easter Company on both sites
// because both sites are the host and both publish the same five tokens.
//
// THE STYLESHEET TRAVELS WITH THE MODULE. site/account-control.mjs injects
// site/account-control.css resolved against its OWN url, so the corporate site — which imports
// this module over the network from launcher.easter.company — gets the panel's rules without
// adding a line to its markup. That is also why nothing in this file is scoped to a class a page
// has to remember to set.
//
// THE THREE STATES DIANA SPECIFIES ARE IMPLEMENTED, NOT APPROXIMATED:
//   * Clean: no action buttons at all — not in the DOM's tab order, because they are not in the
//     DOM. Dirty is a semantic comparison of the canonical document against the stored one, so
//     changing a preference and changing it back is clean again.
//   * Save: the request is the whole draft, the revision the read was answered with, and the
//     panel stays visible and busy until the service acknowledges. A failed save keeps every
//     draft, says so, and leaves Save Changes as the retry. Nothing claims to be saved before it
//     is (the flag comes from the service's own answer).
//   * Blocked close: "polite insistence" — the dialog is nudged on X only (0,-6,+6,-3,0 over
//     360ms, then 0,-3,+3,-1.5,0 over 240ms on the second attempt, then no movement at all),
//     both resolution buttons wear the accent outline, and the footer says what is wrong. It is
//     never an error banner, a red fill, a sound or an auto-focused destructive action.
import {AccountError} from './account-client.mjs';

// ---------------------------------------------------------------------------------------------
// The copy. Diana's spec, sentence for sentence; the two sentences this port had to add are
// marked, because a copy change in four front ends is a decision and not a detail.
// ---------------------------------------------------------------------------------------------
export const COPY = {
  title: 'User Settings',
  subtitle: 'Your preferences, across Easter Company.',
  close: 'Close User Settings',
  language: {
    heading: 'Preferred Language',
    help: 'Automatic uses your device language, then English (US).',
    automatic: 'Automatic',
    automaticDetail: 'Device language → English (US)',
    search: 'Search languages',
    placeholder: 'Name, region, or language code',
    choose: 'Choose a language',
    // ADDED (not in the spec): the catalogue is a network read, and a picker that silently shows
    // nothing would read as "this account has no languages". The stored language is never
    // rewritten by a failed read, and the sentence says so.
    unavailable: 'The language list could not be loaded. Your saved language is kept.',
    empty: 'No matches. Try a name or code.',
    matching: count => `${count} matching languages`,
    always: ' · Automatic always available.'
  },
  theme: { heading: 'Preferred Theme', help: 'Preview a theme before saving.', choices: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] },
  chat: {
    heading: 'Preferred Chat Behaviour',
    help: 'Choose what each key combination does in chat.',
    rows: [['enter', 'Enter'], ['shiftEnter', 'Shift+Enter'], ['ctrlEnter', 'Ctrl+Enter']],
    actions: [['submit', 'Submit'], ['queue', 'Submit & Queue'], ['newline', 'New Line'], ['interrupt', 'Interrupt & Submit']]
  },
  editor: { heading: 'Preferred Text Editing Behaviour', label: 'VIM keys', badge: 'Coming soon', help: 'Off. Not available yet.' },
  status: {
    clean: 'All changes saved.',
    dirty: 'You have unsaved changes.',
    saving: 'Saving your changes…',
    savingButton: 'Saving…',
    waiting: 'Saving your changes… Please wait.',
    // The typographic apostrophe is Diana's, and it is the one a player reads.
    failed: 'Couldn’t save your changes. Try again, or discard them.',
    first: 'You have unsaved changes. Save or discard them to close.',
    again: 'Still editing? Save Changes or Discard Changes to close.'
  },
  buttons: { discard: 'Discard Changes', save: 'Save Changes' },
  announce: { saved: 'Settings saved.', discarded: 'Changes discarded.' }
};

// Diana's numbers, named. A bare number in an animation is a bound nobody can find later.
const NUDGE_FIRST_MS = 360;
const NUDGE_LATER_MS = 240;
const NUDGE_FIRST_PX = 6;
const NUDGE_LATER_PX = 3;
// cubic-bezier(.22,.61,.36,1) over the whole sequence: the same curve on both attempts, so the
// second nudge is a smaller version of the first rather than a different gesture.
const NUDGE_CURVE = 'cubic-bezier(.22,.61,.36,1)';
// Outlines stay for 2400ms after the first attempt and 4000ms after each later one; the third
// attempt stops removing them at all (Diana: "keep both outlines ... visible until next
// preference edit, successful save, or discard").
const ATTENTION_FIRST_MS = 2400;
const ATTENTION_LATER_MS = 4000;
// Attempts inside this window are one attempt: a held Escape is one press with a reader in mind,
// and one announcement is the rule.
const ATTEMPT_COALESCE_MS = 500;
// Search announcements are debounced so typing a name does not narrate every keystroke.
const SEARCH_ANNOUNCE_MS = 150;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// The panel's own copy of a document, so a draft and the snapshot it is compared with can never be
// the same object (the comparison is what decides whether the buttons exist).
const clone = value => ({version: value.version, language: value.language, theme: value.theme,
  chat: {enter: value.chat.enter, shiftEnter: value.chat.shiftEnter, ctrlEnter: value.chat.ctrlEnter},
  editor: {vim: value.editor.vim === true}});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// A default document for the moments before the first answer arrives: the same defaults the
// service writes (api/settings_document.py), so the panel never shows a shape the cloud cannot
// produce. It is replaced by the real document the moment a read answers.
const freshDocument = () => ({version: 1, language: 'auto', theme: 'system', chat: {enter: 'submit', shiftEnter: 'newline', ctrlEnter: 'interrupt'}, editor: {vim: false}});

// Search matching for the language picker: case and diacritics folded, and the hyphenated BCP-47
// spelling of a code accepted as an alias for Minecraft's underscore form (`en-US` finds `en_us`).
const fold = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function openUserSettings({seam, opener = null, document: doc = globalThis.document, window: win = globalThis.window} = {}) {
  if (!seam || !doc) return null;
  // One dialog per page: the corporate site and this site both mount the control once, and a
  // second Settings row opening a second dialog is not a state anyone asked to see.
  panel ??= createPanel({seam, doc, win});
  return panel.open(opener);
}

let panel = null;

function createPanel({seam, doc, win}) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text) => {
    const node = el('button', className, text);
    node.type = 'button';
    return node;
  };

  // ---- the elements, built once -------------------------------------------------------------
  const dialog = el('dialog', 'web-user-settings');
  dialog.id = 'easter-user-settings';
  const shell = el('div', 'es-shell');
  const head = el('header', 'es-head');
  const heading = el('div');
  const title = el('h2', null, COPY.title);
  title.id = 'es-settings-title';
  title.tabIndex = -1;
  const subtitle = el('p', 'es-sub', COPY.subtitle);
  subtitle.id = 'es-settings-subtitle';
  heading.append(title, subtitle);
  const closeButton = button('es-close', '×');
  closeButton.setAttribute('aria-label', COPY.close);
  head.append(heading, closeButton);

  const body = el('div', 'es-body');

  // Preferred Language -----------------------------------------------------------------------
  const languageSection = el('section');
  const languageHeading = el('h3', null, COPY.language.heading);
  const languageHelp = el('p', 'es-help', COPY.language.help);
  const languageToggle = button('es-wide');
  languageToggle.setAttribute('aria-expanded', 'false');
  languageToggle.setAttribute('aria-controls', 'es-language-picker');
  const languageChoice = el('span', 'es-choice');
  const languageName = el('span', null, COPY.language.automatic);
  const languageDetail = el('span', 'es-secondary', COPY.language.automaticDetail);
  // The native name is isolated in both directions: `Automatic` and `English (United States)` are
  // this panel's own words, but `العربية` is a language's own name, and mixing them in one line
  // without isolation reorders the Arabic. Diana's spec asks for bdi on both, with dir=auto.
  languageName.dir = 'auto';
  languageDetail.dir = 'auto';
  languageChoice.append(languageName, languageDetail);
  languageToggle.append(languageChoice, el('span', 'es-chevron', '⌄'));
  const picker = el('div', 'es-picker');
  picker.id = 'es-language-picker';
  picker.hidden = true;
  const searchLabel = el('label', null, COPY.language.search);
  searchLabel.htmlFor = 'es-language-search';
  const searchInput = el('input');
  searchInput.type = 'search';
  searchInput.id = 'es-language-search';
  searchInput.placeholder = COPY.language.placeholder;
  searchInput.autocomplete = 'off';
  const listLabel = el('label', null, COPY.language.choose);
  listLabel.htmlFor = 'es-language-list';
  listLabel.className = 'es-picker-label';
  const list = el('select');
  list.id = 'es-language-list';
  list.size = 5;
  const count = el('p', 'es-help');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  picker.append(searchLabel, searchInput, listLabel, list, count);
  languageSection.append(languageHeading, languageHelp, languageToggle, picker);

  // Preferred Theme ---------------------------------------------------------------------------
  const themeSection = el('section');
  const themeFieldset = el('fieldset');
  const themeLegend = el('legend', null, COPY.theme.heading);
  const themeHelp = el('p', 'es-help', COPY.theme.help);
  const themeSegments = el('div', 'es-segments');
  const themeInputs = new Map();
  for (const [value, label] of COPY.theme.choices) {
    const wrapper = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = 'es-theme';
    input.value = value;
    const text = el('span', null, label);
    wrapper.append(input, text);
    themeSegments.append(wrapper);
    themeInputs.set(value, input);
  }
  themeFieldset.append(themeLegend, themeHelp, themeSegments);
  themeSection.append(themeFieldset);

  // Preferred Chat Behaviour ------------------------------------------------------------------
  const chatSection = el('section');
  const chatHeading = el('h3', null, COPY.chat.heading);
  const chatHelp = el('p', 'es-help', COPY.chat.help);
  chatSection.append(chatHeading, chatHelp);
  const chatSelects = new Map();
  for (const [key, label] of COPY.chat.rows) {
    const row = el('div', 'es-chat-row');
    const labelNode = el('label');
    const id = `es-chat-${key}`;
    labelNode.htmlFor = id;
    // A chip that names a shortcut is not a button and must not look pressable: it is a <kbd>
    // inside the label, which is also why focusing the control focuses the select, not the chip.
    labelNode.append(el('kbd', null, label));
    const select = el('select');
    select.id = id;
    for (const [value, text] of COPY.chat.actions) select.append(new Option(text, value));
    row.append(labelNode, select);
    chatSection.append(row);
    chatSelects.set(key, select);
  }

  // Preferred Text Editing Behaviour ----------------------------------------------------------
  const editorSection = el('section');
  const editorRow = el('div', 'es-editor');
  const editorText = el('div');
  const editorHeading = el('h3', null, COPY.editor.heading);
  const editorHelpLine = el('p', 'es-help');
  editorHelpLine.append(COPY.editor.label, el('span', 'es-badge', COPY.editor.badge));
  const editorState = el('p', 'es-help', COPY.editor.help);
  editorState.id = 'es-vim-help';
  editorText.append(editorHeading, editorHelpLine, editorState);
  // Disabled by construction: a <span role=switch> with no tab stop, aria-checked=false and
  // aria-disabled=true, describing why. There is no feature behind it, so nothing here pretends
  // there is one and nothing ever serializes a pretend "on".
  const editorSwitch = el('span', 'es-switch');
  editorSwitch.setAttribute('role', 'switch');
  editorSwitch.setAttribute('aria-checked', 'false');
  editorSwitch.setAttribute('aria-disabled', 'true');
  editorSwitch.setAttribute('aria-label', COPY.editor.label);
  editorSwitch.setAttribute('aria-describedby', editorState.id);
  editorRow.append(editorText, editorSwitch);
  editorSection.append(editorRow);

  body.append(languageSection, themeSection, chatSection, editorSection);

  // The footer: status and the two conditional actions, pinned outside the scrolling body. -----
  const foot = el('footer', 'es-foot');
  const status = el('p', 'es-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const mark = el('span', 'es-mark', 'i');
  mark.setAttribute('aria-hidden', 'true');
  const statusText = el('span', null, COPY.status.clean);
  status.append(mark, statusText);
  dialog.setAttribute('aria-labelledby', title.id);
  dialog.setAttribute('aria-describedby', subtitle.id);
  const actions = el('div', 'es-actions');
  actions.hidden = true;
  const discardButton = button('es-discard', COPY.buttons.discard);
  const saveButton = button('es-primary', COPY.buttons.save);
  actions.append(discardButton, saveButton);
  foot.append(status, actions);
  shell.append(head, body, foot);
  dialog.append(shell);
  // Outside the dialog, because the dialog is closed by the time these are said. A live region
  // inside a closed <dialog> is not in the accessibility tree at all.
  const announcer = el('p', 'web-settings-announce');
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  doc.body.append(dialog, announcer);

  // ---- state ---------------------------------------------------------------------------------
  let stored = freshDocument();
  let draft = clone(stored);
  let revision = 0;
  let busy = false;
  let touched = false;
  let attempts = 0;
  let lastAttempt = -Infinity;
  let animation = null;
  let flashTimer = null;
  let readSequence = 0;
  let catalogue = null;
  let catalogueState = 'idle';
  let searchTimer = null;
  let open = false;

  const reducedMotion = () => {
    try { return win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; }
    catch { return false; }
  };
  const systemTheme = () => {
    try { return win.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark'; }
    catch { return 'dark'; }
  };
  // THE THEME IS APPLIED WHERE THE SURFACE CAN USE IT. Both Easter Company surfaces are
  // single-mode dark today, so what a stored preference can actually change here is the page's
  // own colour scheme — form controls, scrollbars, and the panel inside it — plus the attribute a
  // host that grows a light palette can key off. Nothing pretends to repaint a palette that does
  // not exist, and the preference is stored either way.
  const applyTheme = theme => {
    const resolved = theme === 'light' || theme === 'dark' ? theme : systemTheme();
    try {
      doc.documentElement.dataset.easterTheme = resolved;
      doc.documentElement.style.colorScheme = resolved;
    } catch { /* a host that refuses the attribute keeps its own look; the preference is stored */ }
  };
  const dirty = () => !same(draft, stored);
  const setStatus = text => { statusText.textContent = text; };
  const announce = text => { announcer.textContent = ''; win.setTimeout(() => { announcer.textContent = text; }, 0); };

  const paintActions = () => {
    // Clean means the two buttons are not in the DOM's tab order — they are not in the DOM's
    // action row at all. That is Diana's rule, and it is also what keeps a clean panel's Escape
    // from being a question. While a save is in flight they stay where they are, disabled: the
    // request is visible to the player, and Diana's "Saving…" primary button is one of the two.
    actions.hidden = !dirty();
    for (const node of [discardButton, saveButton]) node.disabled = busy;
  };
  const paintLanguage = () => {
    const entry = (catalogue || []).find(row => row.code === draft.language);
    if (draft.language === 'auto' || !entry) {
      languageName.textContent = COPY.language.automatic;
      languageDetail.textContent = COPY.language.automaticDetail;
      return;
    }
    languageName.textContent = entry.native;
    // The service's `english` is the code itself for every locale whose English name the game's
    // assets do not carry (api/settings_document.py says why). Printing "Deutsch (Deutschland) —
    // de_de" is true; printing an invented English name would not be, so the code stands in.
    languageDetail.textContent = entry.english && entry.english !== entry.code ? `${entry.english} · ${entry.code}` : entry.code;
  };
  const paintChat = () => {
    for (const [key, select] of chatSelects) select.value = draft.chat[key];
  };
  const paintTheme = () => {
    for (const [value, input] of themeInputs) input.checked = draft.theme === value;
  };
  const render = () => {
    paintLanguage();
    paintTheme();
    paintChat();
    paintActions();
    // The status line follows the draft, except while an attempt is being answered or a save is in
    // flight, where the last word is the one that was just said.
    if (!busy && !attempts) setStatus(dirty() ? COPY.status.dirty : COPY.status.clean);
  };
  // Any edit ends the attention state: Diana's third attempt holds its outlines "until next
  // preference edit, successful save, or discard", and the counter resets on the same events.
  const edited = () => {
    touched = true;
    attempts = 0;
    lastAttempt = -Infinity;
    dialog.classList.remove('es-attend');
    clearTimeout(flashTimer);
    flashTimer = null;
    animation?.cancel();
    animation = null;
    applyTheme(draft.theme);
    render();
  };

  // ---- the language picker -------------------------------------------------------------------
  const renderLanguages = () => {
    const query = fold(searchInput.value);
    const rows = [];
    // Automatic is pinned at the top and is always available, whatever the search says: a player
    // who has typed something wrong can still ask for the device's own language.
    rows.push({code: 'auto', native: COPY.language.automatic, english: COPY.language.automaticDetail, label: `${COPY.language.automatic} — ${COPY.language.automaticDetail}`});
    for (const entry of catalogue || []) {
      const haystack = [fold(entry.native), fold(entry.english), fold(entry.code), fold(entry.code.replace(/_/g, '-'))].join(' ');
      if (query && !haystack.includes(query)) continue;
      const secondary = entry.english && entry.english !== entry.code ? `${entry.english} · ${entry.code}` : entry.code;
      rows.push({...entry, label: `${entry.native} — ${secondary}`});
    }
    const chosen = rows.find(row => row.code === draft.language) || rows[0];
    list.replaceChildren(...rows.map(row => new Option(row.label, row.code)));
    // A selected entry that a filter has removed from the list must not silently become the first
    // row: the value stays on the draft, and the picker says what is selected.
    list.value = chosen.code === draft.language ? draft.language : '';
    // The count is announced politely and debounced; it reports the catalogue's matches, never
    // counting Automatic.
    clearTimeout(searchTimer);
    searchTimer = win.setTimeout(() => {
      if (catalogueState === 'failed') { count.textContent = COPY.language.unavailable; return; }
      if (catalogueState === 'loading') { count.textContent = ''; return; }
      const matches = rows.length - 1;
      count.textContent = matches > 0 ? COPY.language.matching(matches) + COPY.language.always : COPY.language.empty;
    }, SEARCH_ANNOUNCE_MS);
  };
  const loadCatalogue = async () => {
    if (catalogueState === 'ready' || catalogueState === 'loading') return;
    catalogueState = 'loading';
    try {
      const answer = await seam.settingsLanguages();
      catalogue = answer.languages;
      catalogueState = 'ready';
      renderLanguages();
    } catch {
      // The stored language is kept and shown; only the choice list is missing, and the count line
      // says so rather than drawing an empty picker.
      catalogueState = 'failed';
      renderLanguages();
    }
  };
  languageToggle.onclick = () => {
    if (picker.hidden) {
      picker.hidden = false;
      languageToggle.setAttribute('aria-expanded', 'true');
      if (catalogueState === 'failed') catalogueState = 'idle';
      void loadCatalogue().then(() => renderLanguages());
      searchInput.focus();
    } else {
      picker.hidden = true;
      languageToggle.setAttribute('aria-expanded', 'false');
    }
  };
  searchInput.oninput = renderLanguages;
  searchInput.onkeydown = event => {
    // ArrowDown out of the search field lands on the chosen row, which is how a native listbox and
    // its search behave everywhere else.
    if (event.key === 'ArrowDown') { event.preventDefault(); list.focus(); }
  };
  list.onchange = () => {
    if (!list.value) return;
    draft.language = list.value;
    edited();
  };
  list.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      picker.hidden = true;
      languageToggle.setAttribute('aria-expanded', 'false');
      languageToggle.focus();
    }
  };
  for (const [value, input] of themeInputs) input.onchange = () => { if (input.checked) { draft.theme = value; edited(); } };
  for (const [key, select] of chatSelects) select.onchange = () => { draft.chat[key] = select.value; edited(); };
  try {
    win.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener('change', () => { if (open && draft.theme === 'system') applyTheme('system'); });
  } catch { /* no live OS listener in this host: the preview still resolves on every change */ }

  // ---- close, and the blocked close ---------------------------------------------------------
  const finish = message => {
    open = false;
    dialog.close();
    try { opener?.focus?.(); } catch { /* the pill can be gone after a sign-out */ }
    if (message) announce(message);
  };
  const requestClose = () => {
    if (busy) { setStatus(COPY.status.waiting); return; }
    if (!dirty()) { finish(''); return; }
    // One attempt per burst: a held Escape is one press, and it is announced once.
    const now = win.performance?.now?.() ?? Date.now();
    if (now - lastAttempt < ATTEMPT_COALESCE_MS) return;
    lastAttempt = now;
    attempts += 1;
    dialog.classList.add('es-attend');
    setStatus(attempts === 1 ? COPY.status.first : COPY.status.again);
    clearTimeout(flashTimer);
    flashTimer = null;
    animation?.cancel();
    animation = null;
    // Movement first and second, none from the third: the nudge is a request to resolve, not a
    // punishment, and it never escalates in distance or volume.
    if (!reducedMotion() && attempts < 3) {
      const distance = attempts === 1 ? NUDGE_FIRST_PX : NUDGE_LATER_PX;
      animation = dialog.animate([
        {transform: 'translateX(0)'},
        {transform: `translateX(-${distance}px)`},
        {transform: `translateX(${distance}px)`},
        {transform: `translateX(-${distance / 2}px)`},
        {transform: 'translateX(0)'}
      ], {duration: attempts === 1 ? NUDGE_FIRST_MS : NUDGE_LATER_MS, easing: NUDGE_CURVE});
    }
    if (attempts < 3) {
      flashTimer = win.setTimeout(() => {
        dialog.classList.remove('es-attend');
        flashTimer = null;
      }, attempts === 1 ? ATTENTION_FIRST_MS : ATTENTION_LATER_MS);
    }
    announce(attempts === 1 ? COPY.status.first : COPY.status.again);
  };
  closeButton.onclick = () => requestClose();
  dialog.addEventListener('cancel', event => {
    // Escape never closes this dialog on its own: the guard decides, and an open picker answers
    // the first Escape itself (its own focus goes back to the trigger).
    event.preventDefault();
    if (!picker.hidden) {
      picker.hidden = true;
      languageToggle.setAttribute('aria-expanded', 'false');
      languageToggle.focus();
      return;
    }
    requestClose();
  });
  // A click outside counts only when the press began outside as well: dragging a text selection
  // out of the panel and releasing it there is not a decision to close.
  let downOutside = false;
  dialog.addEventListener('pointerdown', event => {
    const box = dialog.getBoundingClientRect();
    downOutside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  });
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (downOutside && outside) requestClose();
    downOutside = false;
  });
  // Best effort and honestly described as such: the browser's own prompt cannot be styled or
  // cancelled by an animation, and Diana's spec says so rather than claiming otherwise.
  const beforeUnload = event => {
    if (!open || !dirty()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  win.addEventListener?.('beforeunload', beforeUnload);

  // ---- save ---------------------------------------------------------------------------------
  discardButton.onclick = () => {
    draft = clone(stored);
    attempts = 0;
    lastAttempt = -Infinity;
    clearTimeout(flashTimer);
    flashTimer = null;
    dialog.classList.remove('es-attend');
    applyTheme(stored.theme);
    finish(COPY.announce.discarded);
  };
  saveButton.onclick = async () => {
    if (busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    setStatus(COPY.status.saving);
    saveButton.textContent = COPY.status.savingButton;
    body.inert = true;
    paintActions();
    const sent = clone(draft);
    let answer;
    try { answer = await seam.settingsSave(sent, revision); }
    catch (error) { answer = {ok: false, error: error instanceof AccountError ? error.message : 'The Easter Company account service could not be reached.'}; }
    busy = false;
    dialog.removeAttribute('aria-busy');
    saveButton.textContent = COPY.buttons.save;
    body.inert = false;
    if (answer?.ok && isObject(answer.value) && !answer.value.conflict) {
      // The service's own answer is the only thing that may say "saved": the stored snapshot, the
      // revision the next write will name, and the theme that stays applied all come from it.
      stored = clone(answer.value.settings);
      revision = answer.value.revision;
      draft = clone(stored);
      touched = false;
      attempts = 0;
      lastAttempt = -Infinity;
      dialog.classList.remove('es-attend');
      applyTheme(stored.theme);
      finish(COPY.announce.saved);
      return;
    }
    // NOT SAVED, and it says so. A conflict means another surface moved the document on: the
    // document it holds now becomes the snapshot (so Retry compares against the truth), and the
    // revision it reports is the one the retry will replace - which is what makes pressing Save
    // Changes again an explicit choice to overwrite rather than a silent one.
    if (answer?.ok && isObject(answer.value) && answer.value.conflict) {
      stored = clone(answer.value.settings);
      revision = answer.value.revision;
    }
    paintActions();
    setStatus(COPY.status.failed);
    announce(COPY.status.failed);
    try { saveButton.focus(); } catch { /* focus is a courtesy; the sentence is the message */ }
  };

  // ---- open ---------------------------------------------------------------------------------
  const readSettings = async () => {
    const sequence = ++readSequence;
    try {
      const answer = await seam.settingsRead();
      if (sequence !== readSequence) return;
      if (!answer?.ok || !isObject(answer.value)) return;
      stored = clone(answer.value.settings);
      revision = answer.value.revision;
      // A draft the player has already edited is never overwritten by the answer that arrives
      // behind it: what the read does in that case is make the snapshot honest.
      if (!touched) {
        draft = clone(stored);
        applyTheme(draft.theme);
        render();
      } else {
        paintActions();
        setStatus(dirty() ? COPY.status.dirty : COPY.status.clean);
      }
    } catch { /* an unreadable read leaves the panel on the defaults it opened with */ }
  };
  const show = invoker => {
    if (invoker) opener = invoker;
    open = true;
    touched = false;
    attempts = 0;
    lastAttempt = -Infinity;
    clearTimeout(flashTimer);
    flashTimer = null;
    dialog.classList.remove('es-attend');
    picker.hidden = true;
    languageToggle.setAttribute('aria-expanded', 'false');
    searchInput.value = '';
    draft = clone(stored);
    applyTheme(draft.theme);
    paintTheme();
    paintChat();
    paintActions();
    setStatus(dirty() ? COPY.status.dirty : COPY.status.clean);
    renderLanguages();
    if (!dialog.open) dialog.showModal();
    // Initial focus is the heading, so a screen reader reads the panel's name and purpose before
    // its first control, and a typist's first Tab is the close button.
    try { title.focus(); } catch { /* no focus ring is not a failure */ }
    void readSettings();
    if (catalogueState !== 'ready') void loadCatalogue().then(() => renderLanguages());
    return api;
  };
  const api = {
    dialog,
    open: show,
    close: () => { if (dialog.open) finish(''); },
    isOpen: () => dialog.open,
    // The tests read these rather than reaching into the closes: what they assert is the state the
    // component believes it is in, and the document it would send.
    snapshot: () => ({stored: clone(stored), draft: clone(draft), revision, attempts, busy}),
    copy: COPY
  };
  return api;
}
