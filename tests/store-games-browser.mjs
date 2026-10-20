import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.EASTER_PUBLIC_ORIGIN || "http://127.0.0.1:18100",
  output = process.env.EASTER_REVIEW_OUTPUT;
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const [width, height] of [
    [1440, 1000],
    [1100, 760],
    [800, 700],
    [390, 844],
    [320, 568],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/store/", { waitUntil: "networkidle" });
    const store = page.locator(".company-store");
    await store.locator(".store-product").first().waitFor();
    const picker = store.locator(".store-game-picker");
    const expand = async () => {
      if (!(await picker.evaluate((n) => n.open)))
        await picker.locator("summary").click();
    };
    await expand();
    const games = store.getByRole("navigation", { name: "Choose a game" });
    assert.equal(await store.locator(".store-sidebar .store-games").count(), 1);
    assert.equal(
      await picker.locator("summary").textContent(),
      "Chose Your Game",
    );
    const rows = await games
      .locator(".store-game")
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().toJSON()),
      );
    for (let i = 1; i < rows.length; i++)
      assert.ok(
        rows[i].y >= rows[i - 1].y + rows[i - 1].height,
        "games form a vertical list",
      );
    assert.equal(await games.getByRole("button").count(), 3);
    await expand();
    assert.equal(
      await games
        .getByRole("button", { name: "Easter Co. SMP — Store open" })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await store.locator(".store-product").count(), 9);
    if (output)
      await page.screenshot({ path: `${output}/store-games-${width}.png` });
    await store
      .getByRole("button", { name: "Add 1,000 Crowns to cart" })
      .click();
    for (const game of ["Orbital Racing", "Frontier"]) {
      await expand();
      await games
        .getByRole("button", { name: game + " — Coming soon, placeholder" })
        .click();
      await store.getByRole("heading", { name: game, exact: true }).waitFor();
      assert.equal(await store.locator(".store-product").count(), 0);
      assert.equal(await store.locator(".store-concept-card").count(), 3);
      assert.equal(
        await store.getByRole("button", { name: /Add .* to cart/ }).count(),
        0,
      );
      assert.match(
        await store.locator(".store-coming-soon").innerText(),
        /nothing here is for sale/,
      );
      assert.equal(
        await store
          .getByRole("button", { name: "Cart · 1", exact: true })
          .count(),
        1,
        "switching games retains cart",
      );
      assert.ok(
        await store.evaluate((n) => n.scrollWidth <= n.clientWidth),
        "no outer horizontal overflow",
      );
      if (output)
        await page.screenshot({
          path: `${output}/store-${game.toLowerCase().replaceAll(" ", "-")}-${width}.png`,
        });
    }
    await store.getByRole("button", { name: "Cart · 1", exact: true }).click();
    assert.match(
      await store.locator(".store-cart-row").innerText(),
      /Easter Co. SMP/,
    );
    await expand();
    assert.equal(
      await games
        .getByRole("button", { name: "Easter Co. SMP — Store open" })
        .getAttribute("aria-pressed"),
      "true",
    );
    await store.getByRole("button", { name: "Review checkout" }).click();
    await store.getByRole("heading", { name: "Review your order" }).waitFor();
    assert.match(
      await store.locator(".store-checkout-main").innerText(),
      /Easter Co. SMP only/,
    );
    await store.getByRole("checkbox").check();
    await store.getByRole("button", { name: /Place test order/ }).click();
    await store
      .getByRole("heading", { name: "Your test order is complete." })
      .waitFor();
    assert.match(
      await store.locator(".store-receipt").innerText(),
      /Easter Co. SMP/,
    );
    await store
      .getByRole("button", { name: "View orders", exact: true })
      .click();
    await store.locator(".store-order-record").waitFor();
    assert.match(
      await store.locator(".store-order-record").innerText(),
      /Easter Co. SMP/,
    );
    assert.deepEqual(errors, []);
    console.log("Game navigation and purchase scope passed:", width, height);
    await page.close();
  }
} finally {
  await browser.close();
}
