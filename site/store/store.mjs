import { CATALOGUE } from './catalogue.mjs';

// This checkout contains no payment bridge. Do not simulate payment or invent
// an IPC method. Checkout, orders and receipts need an authenticated main-process
// integration and authoritative service responses before they can be enabled.
const root = document.querySelector('#store-root');
const announcement = document.querySelector('#store-announcement');
const status = document.querySelector('#store-status');
const storageKey = 'easter-store-selection-v1';
const find = key => CATALOGUE.find(product => product.key === key);
let selected = null;
try { selected = find(sessionStorage.getItem(storageKey))?.key || null; } catch {}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(text, href, className = 'store-link') {
  const node = element('a', className, text);
  node.href = href;
  return node;
}
function choose(product) {
  selected = product.key;
  try { sessionStorage.setItem(storageKey, selected); } catch {}
  announcement.textContent = `${product.name} selected for review.`;
  location.hash = '#cart';
}
function action(text, callback) {
  const node = element('button', 'store-button', text);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}
function artwork(product) {
  const node = element('div', 'store-art', product.mark);
  node.dataset.product = product.key;
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function heading(title, copy) {
  root.append(element('h2', '', title));
  if (copy) root.append(element('p', 'store-lead', copy));
}
function price(product) {
  return element('p', 'store-price', `${product.price} USD`);
}
function catalogue() {
  heading('A small shop for Easter Co. SMP', 'Sterling is in-game currency. Every price below is in US dollars.');
  const list = element('div', 'store-products');
  for (const product of CATALOGUE) {
    const card = element('article', 'store-product');
    const copy = element('div', 'store-product-copy');
    copy.append(element('p', 'store-overline', product.category), element('h3', '', product.name), element('p', 'store-description', product.description));
    const purchase = element('div', 'store-product-action');
    purchase.append(price(product), link(`View ${product.name}`, `#item/${product.key}`));
    card.append(artwork(product), copy, purchase);
    list.append(card);
  }
  root.append(list);
}
function item(product) {
  root.append(link('Back to shop', '#catalogue'));
  const panel = element('section', 'store-detail');
  const copy = element('div');
  copy.append(element('p', 'store-overline', product.category), element('h2', '', product.name), element('p', 'store-lead', product.description), price(product));
  if (product.category === 'In-game currency') {
    copy.append(element('p', 'store-note', 'Sterling is currency inside Easter Co. SMP. The price shown is in USD.'));
  }
  copy.append(action('Select for review', () => choose(product)));
  panel.append(artwork(product), copy);
  root.append(panel);
}
function review(checkout) {
  heading(checkout ? 'Checkout' : 'Review your selection', 'Pick → Review → Pay on Stripe’s page');
  const product = find(selected);
  if (!product) {
    root.append(element('p', 'store-lead', 'No product selected. Choose an item from the shop.'), link('Browse the shop', '#catalogue', 'store-button'));
    return;
  }
  const panel = element('section', 'store-review');
  panel.append(element('p', 'store-overline', 'Your selection'), element('h3', '', product.name), price(product), element('p', 'store-description', product.description));
  panel.append(element('p', 'store-note', 'Payment will take place on Stripe’s hosted checkout page. The payment service determines the final amount. Reviewing an item does not charge you.'));
  const pay = action('Checkout unavailable', () => {});
  pay.disabled = true;
  pay.setAttribute('aria-describedby', 'payment-availability');
  const availability = element('p', 'store-note', 'The launcher’s payment service is not connected. No payment can be requested here.');
  availability.id = 'payment-availability';
  panel.append(pay, availability, link('Choose a different item', '#catalogue'));
  root.append(panel);
}
function orders(receiptId) {
  if (receiptId !== undefined) {
    heading('Receipt unavailable', 'This store cannot retrieve payment records yet.');
    root.append(element('p', 'store-note', 'A receipt must come from the payment service. It will show the purchased item, the amount in USD, and the Stripe reference. In-game credit arrives once payment is confirmed.'), link('View orders', '#orders'));
  } else {
    heading('Orders', 'Order history is unavailable until the launcher’s payment service is connected.');
    root.append(element('p', 'store-note', 'This page cannot verify purchases or payment status.'), link('Browse the shop', '#catalogue'));
  }
}
function render(moveFocus = false) {
  const route = location.hash.slice(1) || 'catalogue';
  // Skip navigation is handled separately so it never changes the store view.
  if (route === 'store-root') { root.focus(); return; }
  root.replaceChildren();
  status.textContent = window.easterDesktop?.mode === 'desktop'
    ? 'Checkout is currently unavailable. The launcher’s payment service is not connected.'
    : 'You can browse here. Purchases require the launcher and a connected payment service; checkout is currently unavailable.';
  const parts = route.split('/');
  if (route === 'catalogue') catalogue();
  else if (route === 'cart' || route === 'checkout') review(route === 'checkout');
  else if (route === 'orders') orders();
  else if (parts[0] === 'receipt' && parts.length === 2 && parts[1]) orders(parts[1]);
  else if (parts[0] === 'item' && parts.length === 2 && find(parts[1])) item(find(parts[1]));
  else {
    heading('This page is unavailable', 'Choose a product from the shop to continue.');
    root.append(link('Browse the shop', '#catalogue'));
  }
  for (const nav of document.querySelectorAll('.store-top-nav a')) {
    const active = nav.hash === `#${route}` || (nav.hash === '#catalogue' && parts[0] === 'item') || (nav.hash === '#cart' && route === 'checkout') || (nav.hash === '#orders' && parts[0] === 'receipt');
    if (active) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  const title = root.querySelector('h2')?.textContent || 'Store';
  document.title = `${title} — Easter Co. SMP`;
  announcement.textContent = title;
  if (moveFocus) root.focus();
}
document.querySelector('.store-skip').addEventListener('click', event => {
  event.preventDefault();
  root.focus();
});
window.addEventListener('hashchange', () => render(true));
render();
