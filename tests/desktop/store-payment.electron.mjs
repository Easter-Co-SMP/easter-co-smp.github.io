import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
// PAYING INSIDE THE LAUNCHER.
//
// Owen, 2026-10-23, all three of his sentences: "It opened stripe in my web browser, but it should
// open in an embedded view within the launcher instead, and when it succeeds it should not redirect
// to the website or anything, all functionality should maintain within the launcher. And also the
// launcher needs a 'Payment Successful' modal for when the stripe transaction succeeds."
//
// The "Stripe" page here is a local fixture served by the harness for the Checkout host itself
// (tests/desktop/store-payment-harness.cjs): no real Checkout Session exists, nothing is fetched
// from Stripe, and no money can move. What is proved is the launcher's own half:
//
//   (a) Buy opens a window inside the launcher - modal, parented, menu-less, no node, no dev
//       tools - and shell.openExternal is NEVER called. The list the stub records is asserted
//       empty at every step, so this is evidence and not intent.
//   (b) The success fragment (`#store-paid/{session}`) closes that window, shows Owen's
//       "Payment Successful" dialog with his body sentence, and writes no order row by itself: the
//       Orders view still says "No orders yet." until the account service records the purchase.
//   (c) The cancel fragment closes the window and says nothing at all: the store is exactly as it
//       was before the press, sentence for sentence.
//   (d) Closing the window by hand shows no dialog, claims nothing, and leaves the store usable -
//       a second press still opens a window.
//   (e) A navigation inside that window to any other host is refused before it loads: the fixture
//       session is never asked for it, and the payment page is still the document.
//   (f) A Checkout URL on any host but Stripe's is refused by the launcher, so no window opens.
const root = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'easter-store-payment-'));
await fs.writeFile(
  path.join(temp, 'settings.json'),
  JSON.stringify({ memoryMB: 4096, exitOnLaunch: false }),
);
const launch = async () =>
  electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', path.join(root, 'tests/desktop/store-payment-harness.cjs')],
    env: { ...process.env, EASTER_TEST_HOME: temp },
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storeText = async (page) =>
  (await page.locator('.store-app').innerText()).replace(/\s+/g, ' ').trim();
const windows = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const app = await launch();
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.easterDesktop?.mode === 'desktop');
  await page.keyboard.press('Escape');
  // One signed-in player, so the store's three commands answer against a session.
  await page.locator('[data-desktop-play]').click();
  await page.locator('#desktop-install-details').waitFor({ state: 'hidden' });
  await page.locator('[data-desktop-play]').click();
  await page
    .getByRole('button', { name: 'Sign in with Microsoft', exact: true })
    .click();
  await page.locator('.desktop-code').filter({ hasText: 'TEST-CODE' }).waitFor();
  await app.evaluate(() => global.easterTestApprove());
  await page.waitForFunction(async () => !!((await window.easterDesktop.status()).account));
  await page.getByRole('link', { name: 'Store', exact: true }).click();
  await page.locator('.store-app').waitFor();
  await page.locator('.store-product').first().waitFor();
  assert.equal(await windows(app), 1, 'the launcher starts with its one window');

  const buy = (name = '10 Sterling') =>
    page.getByRole('button', { name: 'Buy ' + name });
  const outside = () => app.evaluate(() => global.paymentOutside);
  const press = async () => {
    await buy().waitFor();
    const opened = app.waitForEvent('window');
    void buy()
      .click()
      .catch(() => {});
    const stripe = await opened;
    stripe.setDefaultTimeout(20000);
    await stripe.locator('#pay').waitFor();
    return stripe;
  };
  // A press inside the payment page is dispatched from the page rather than clicked through
  // Playwright's own click: Playwright waits on "scheduled navigations", and the whole point of
  // the two fragments is that the navigation is cancelled before it loads.
  const payPage = (stripe, id) =>
    stripe.evaluate((which) => document.getElementById(which).click(), id);
  const openWindow = async () => {
    const shape = await app.evaluate(({ BrowserWindow, screen }) => {
      const all = BrowserWindow.getAllWindows();
      const launcher = all.find((win) =>
        win.webContents.getURL().startsWith('easter://easter/'),
      );
      const payment = all.find((win) => win !== launcher);
      if (!payment) return null;
      const prefs = payment.webContents.getLastWebPreferences();
      return {
        windows: all.length,
        size: payment.getSize(),
        modal: payment.isModal(),
        parented: payment.getParentWindow() === launcher,
        menuAutoHide: payment.isMenuBarAutoHide(),
        menuBarVisible: payment.isMenuBarVisible(),
        title: payment.getTitle(),
        url: payment.webContents.getURL(),
        nodeIntegration: prefs.nodeIntegration,
        contextIsolation: prefs.contextIsolation,
        sandbox: prefs.sandbox,
        webSecurity: prefs.webSecurity,
        preload: prefs.preload ?? null,
        // A modal child takes the launcher window's input while it is up: that is what "modal"
        // means here, and it is asserted rather than assumed.
        launcherDisabled: launcher.isEnabled() === false,
        launcherBounds: launcher.getBounds(),
        // The display this runs on, because a window taller than the screen is clamped by the
        // windowing layer before Electron ever sees it. The size below is asserted against what
        // the launcher asked for *and* the display's own ceiling, so this journey never depends
        // on how large the virtual screen happens to be.
        display: screen.getPrimaryDisplay().workAreaSize,
      };
    });
    assert.ok(shape, 'the press opened a window');
    return shape;
  };
  // (a) the press opens an in-launcher window, and nothing is handed to the operating system.
  {
    const stripe = await press();
    const shape = await openWindow();
    assert.equal(shape.windows, 2, 'one launcher window and one payment window');
    assert.equal(shape.modal, true, 'the payment window is modal');
    assert.equal(shape.parented, true, 'and it is parented to the launcher window');
    assert.equal(shape.launcherDisabled, true, 'a modal child holds the launcher window');
    assert.equal(shape.menuAutoHide, true, 'no menu bar');
    assert.equal(shape.menuBarVisible, false, 'and no menu bar drawn on the window');
    // `devTools: false` is asked for in the webPreferences; this is it behaving: the payment page
    // cannot open an inspector on itself.
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => {
        const payment = BrowserWindow.getAllWindows().find((win) => win.isModal());
        try {
          payment.webContents.openDevTools();
        } catch {}
        return payment.webContents.isDevToolsOpened();
      }),
      false,
      'dev tools cannot be opened in the payment window',
    );
    assert.equal(shape.nodeIntegration, false, 'nodeIntegration off');
    assert.equal(shape.contextIsolation, true, 'contextIsolation on');
    assert.equal(shape.sandbox, true, 'sandboxed');
    assert.equal(shape.webSecurity, true, 'web security on');
    assert.equal(shape.preload, null, 'no preload: the payment page is not given this app');
    assert.equal(shape.size[0], 480, 'the Checkout column is 480 wide');
    assert.equal(
      shape.size[1],
      Math.min(760, shape.launcherBounds.height, shape.display.height),
      '760 tall, or the launcher window and the display when either is smaller',
    );
    assert.equal(
      shape.size[1] > 0 && shape.size[1] <= 760,
      true,
      'and never taller than the column it is',
    );
    assert.equal(shape.url, 'https://checkout.stripe.com/c/pay/cs_test_fixture');
    assert.equal(stripe.url(), 'https://checkout.stripe.com/c/pay/cs_test_fixture');
    assert.deepEqual(await outside(), [], 'shell.openExternal was never called');
    assert.deepEqual(
      await app.evaluate(() => global.storeCheckoutPresses),
      ['sterling-10'],
      'the page asked for the product it pressed, and main sent that key',
    );
    // (e) a navigation to another host inside that window is refused before it loads.
    await payPage(stripe, 'elsewhere');
    await sleep(700);
    assert.equal(
      await stripe.evaluate(() => document.title),
      'Stripe Checkout fixture',
      'the payment page is still the document: the other host did not load',
    );
    assert.equal(stripe.url(), 'https://checkout.stripe.com/c/pay/cs_test_fixture');
    assert.deepEqual(
      await app.evaluate(() => global.paymentHosts),
      ['checkout.stripe.com'],
      'the payment session was never asked for another host',
    );
    assert.equal(await stripe.locator('#foreign').count(), 0);
    // (b) the success fragment ends the payment in the launcher.
    const closed = stripe.waitForEvent('close', { timeout: 20000 });
    void payPage(stripe, 'pay').catch(() => {});
    await closed;
    await page.locator('.store-modal').waitFor();
    assert.equal(await windows(app), 1, 'the payment window is gone');
    const modal = page.locator('.store-modal');
    assert.equal(await modal.getAttribute('role'), 'dialog');
    assert.equal(await modal.getAttribute('aria-modal'), 'true');
    const labelledBy = await modal.getAttribute('aria-labelledby');
    assert.equal(
      await page.evaluate((id) => document.getElementById(id)?.textContent, labelledBy),
      'Payment Successful',
      'the dialog is labelled by its own heading',
    );
    assert.equal(
      await page.getByRole('heading', { name: 'Payment Successful', exact: true }).count(),
      1,
    );
    assert.equal(
      (await modal.innerText()).replace(/\s+/g, ' ').trim(),
      'Payment Successful Your order is recorded. Close',
      'Owen heading, Owen body, and one control: no second sentence, no exclamation mark',
    );
    assert.equal(
      await page.evaluate(() =>
        (document.activeElement?.className || '').includes('store-modal-close'),
      ),
      true,
      'focus moves into the dialog',
    );
    // Nothing was written by the launcher: the Orders view is still the service's own empty list.
    assert.equal(await page.locator('.store-order-record').count(), 0);
    await page.keyboard.press('Escape');
    await page.locator('.store-modal').waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset?.buy),
      'sterling-10',
      'Escape closes it and focus returns to the Buy control of the product just bought',
    );
    const reads = await app.evaluate(() => global.storeOrderReads);
    assert.ok(reads >= 1, 'closing the dialog re-reads the orders');
    page.on('console', () => {});
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.locator('.store-orders-heading').waitFor();
    assert.equal(
      await page.locator('.store-order-record').count(),
      0,
      'no order row exists: the fragment wrote nothing, and the service still has none',
    );
    assert.equal((await storeText(page)).includes('No orders yet.'), true);
    await page.getByRole('link', { name: 'Browse', exact: true }).click();
    await page.locator('.store-product').first().waitFor();
    assert.deepEqual(await outside(), [], 'still nothing handed to the operating system');
    console.log(
      'In-launcher payment PASS: modal window with the launcher as its parent, the success fragment ends it, Owen\'s dialog opens, and nothing left the launcher.',
    );
  }
  // (b, continued) Close re-reads the orders, so the row on screen is the service's own.
  {
    const stripe = await press();
    const closed = stripe.waitForEvent('close', { timeout: 20000 });
    void payPage(stripe, 'pay').catch(() => {});
    await closed;
    await page.locator('.store-modal').waitFor();
    await app.evaluate(() => {
      global.storeOrderList = [
        {
          sessionId: 'cs_test_fixture',
          product: 'sterling-10',
          amountMinor: 149,
          currency: 'USD',
          paid: true,
          delivered: false,
          creditPence: 1000,
          createdAt: '2026-10-23T10:00:00.000Z',
        },
      ];
    });
    const before = await app.evaluate(() => global.storeOrderReads);
    await page
      .locator('.store-modal')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.locator('.store-modal').waitFor({ state: 'detached' });
    assert.equal(
      await app.evaluate(() => global.storeOrderReads),
      before + 1,
      'Close re-reads the orders once',
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset?.buy),
      'sterling-10',
      'and gives focus back to that product\'s Buy control',
    );
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.locator('.store-order-record').waitFor();
    const record = (await page.locator('.store-order-record').innerText()).replace(
      /\s+/g,
      ' ',
    );
    assert.equal(record.includes('10 Sterling'), true);
    assert.equal(record.includes('$1.49'), true);
    assert.equal(record.includes('Paid'), true);
    await page.getByRole('link', { name: 'Browse', exact: true }).click();
    await page.locator('.store-product').first().waitFor();
    console.log(
      'Close PASS: the dialog dismisses, the orders are re-read, and the row is the account service\'s own.',
    );
  }
  // Enter closes it too.
  {
    const stripe = await press();
    const closed = stripe.waitForEvent('close', { timeout: 20000 });
    void payPage(stripe, 'pay').catch(() => {});
    await closed;
    await page.locator('.store-modal').waitFor();
    await page.keyboard.press('Enter');
    await page.locator('.store-modal').waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset?.buy),
      'sterling-10',
      'Enter closes it and focus returns to Buy',
    );
    console.log('Enter PASS: the dialog closes and focus returns to Buy.');
  }
  // (c) the cancel fragment: no dialog, no sentence, the store exactly as it was.
  {
    const before = await storeText(page);
    assert.equal(before.includes('Payment Successful'), false);
    const stripe = await press();
    const closed = stripe.waitForEvent('close', { timeout: 20000 });
    void payPage(stripe, 'cancel').catch(() => {});
    await closed;
    await buy().waitFor();
    assert.equal(await page.locator('.store-modal').count(), 0, 'no dialog');
    assert.equal(await windows(app), 1);
    assert.equal(await storeText(page), before, 'the store is exactly as it was before the press');
    assert.equal(await page.locator('.store-status').count(), 0, 'and says nothing at all');
    console.log('Cancel PASS: the window closes and the store says nothing at all.');
  }
  // (d) closing the window by hand: no dialog, no claim, and the store is still usable.
  {
    const stripe = await press();
    const closed = stripe.waitForEvent('close', { timeout: 20000 });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((win) => win.isModal())
        .close();
    });
    await closed;
    await buy().waitFor();
    assert.equal(await page.locator('.store-modal').count(), 0, 'no dialog for a hand-closed window');
    const text = await storeText(page);
    assert.equal(text.includes('Payment Successful'), false);
    assert.equal(text.includes('Your order is recorded.'), false);
    assert.equal(
      text.includes(
        'Finish the payment in the Stripe window. Your Sterling arrives the next time you join.',
      ),
      true,
      'the one sentence that says where the payment finishes, and nothing pretending it happened',
    );
    assert.equal(await buy().isEnabled(), true);
    // Usable: the next press opens a window again, and cancelling it leaves the store standing.
    const again = await press();
    const againClosed = again.waitForEvent('close', { timeout: 20000 });
    void payPage(again, 'cancel').catch(() => {});
    await againClosed;
    await buy().waitFor();
    assert.equal(await page.locator('.store-modal').count(), 0);
    assert.equal(await windows(app), 1);
    console.log(
      'Hand-close PASS: no dialog and no claim, the payment sentence stands, and the next press still opens a window.',
    );
  }
  // (f) a Checkout URL on any other host than Stripe's is refused, and no window opens.
  {
    for (const [index, answer] of [
      'https://example.test/c/pay/cs_test_fixture',
      'http://checkout.stripe.com/c/pay/cs_test_fixture',
    ].entries()) {
      // Each refusal replaces the catalogue with the one sentence (a shut door, not a half-shop),
      // so the page is reloaded between the two: the store's own mount reads the catalogue again.
      if (index) {
        await page.reload();
        await page.locator('.store-product').first().waitFor();
      }
      await app.evaluate((url) => {
        global.storeCheckoutURL = url;
      }, answer);
      await buy().click();
      await page.locator('.store-feedback span').waitFor();
      assert.equal(
        (await page.locator('.store-feedback span').innerText()).trim(),
        'The store is unavailable right now.',
        `${answer} is refused with the store's one sentence`,
      );
      assert.equal(await windows(app), 1, `${answer} opened no window`);
      assert.equal(await page.locator('.store-modal').count(), 0);
    }
    await app.evaluate(() => {
      global.storeCheckoutURL = 'https://checkout.stripe.com/c/pay/cs_test_fixture';
    });
    console.log(
      'Host rule PASS: a Checkout URL anywhere but https://checkout.stripe.com opens nothing.',
    );
  }
  assert.deepEqual(await outside(), [], 'shell.openExternal was never called, at any point');
  assert.deepEqual(errors, [], 'no page error in the launcher');
  console.log(
    'Store payment journey PASS: the Stripe page opens inside the launcher, the success and cancel fragments end it there, Owen\'s Payment Successful dialog is the launcher\'s own, and shell.openExternal is never called.',
  );
} catch (error) {
  const page = await app.firstWindow().catch(() => null);
  if (page)
    console.log(
      await page
        .evaluate(() => ({
          body: document.querySelector('.store-app')?.innerText?.slice(0, 400),
          modal: document.querySelector('.store-modal')?.innerText,
        }))
        .catch(() => 'no launcher page state'),
    );
  throw error;
} finally {
  await app.close();
  await fs.rm(temp, { recursive: true, force: true });
}
