import assert from 'node:assert/strict';
import {chromium} from '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const origin = process.env.EASTER_PUBLIC_ORIGIN || 'http://127.0.0.1:18100';
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.setDefaultTimeout(10000);
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto(origin + '/');
  await page.getByRole('link',{name:'Wiki',exact:true}).click();
  await page.locator('.wiki-card').first().waitFor();
  assert.equal(await page.locator('.wiki-card').count(),12);
  assert.equal(await page.locator('.arrival-mist').count(),0);
  assert.equal(await page.locator('.site-header a[aria-current]').textContent(),'Wiki');
  await page.screenshot({path:'/tmp/wiki-overview-desktop.png',fullPage:true});
  await page.getByRole('link',{name:'Ships & sailing',exact:true}).click();
  await page.getByRole('heading',{name:'Ships & sailing',exact:true,level:1}).waitFor();
  assert.match(page.url(), /#\/ships-and-sailing$/);
  assert.equal(await page.title(),'Ships & sailing — Easter Co. SMP');
  await page.getByRole('navigation',{name:'On this page',exact:true}).last().getByRole('link',{name:'Chart a course'}).click();
  assert.match(page.url(), /ships-and-sailing\/chart-a-course$/);
  await page.waitForFunction(()=>document.getElementById('chart-a-course')===document.activeElement);
  await page.reload(); await page.locator('#chart-a-course').waitFor();
  await page.waitForFunction(()=>document.getElementById('chart-a-course')===document.activeElement);
  await page.screenshot({path:'/tmp/wiki-article-desktop.png',fullPage:true});
  await page.getByLabel('Search the wiki',{exact:true}).fill('piloting');
  await page.getByRole('heading',{name:'Search the wiki',exact:true}).waitFor();
  assert.equal(await page.locator('.wiki-result').count(),1);
  assert.match(await page.locator('.wiki-result').innerText(),/Ships & sailing/);
  assert.equal(await page.getByLabel('Search the wiki',{exact:true}).inputValue(),'piloting');
  await page.getByLabel('Search the wiki',{exact:true}).fill('zzzzzz');
  await page.getByRole('heading',{name:'No articles found.',exact:true}).waitFor();
  await page.getByLabel('Search the wiki',{exact:true}).fill('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('main img').count(),0);
  await page.getByRole('link',{name:'Browse all articles →',exact:true}).click();
  await page.locator('.wiki-card').first().waitFor();
  await page.locator('h1').click(); await page.keyboard.press('/');
  assert.equal(await page.getByLabel('Search the wiki',{exact:true}).evaluate(node=>node===document.activeElement),true);
  for (const width of [800,390,320]) {
    await page.setViewportSize({width,height:width===800?600:844});
    await page.goto(origin+'/wiki/');
    await page.locator('.wiki-card').first().waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overview fits '+width);
    await page.screenshot({path:'/tmp/wiki-overview-'+width+'.png',fullPage:true});
    if (width<760) {
      await page.getByRole('button',{name:'Browse topics'}).click();
      assert.equal(await page.getByRole('button',{name:'Browse topics'}).getAttribute('aria-expanded'),'true');
    }
    await page.getByRole('link',{name:'Cooking & crafting',exact:true}).click();
    await page.getByRole('heading',{name:'Cooking & crafting',exact:true,level:1}).waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'article fits '+width);
    await page.locator('.wiki-mobile-toc summary').click();
    await page.locator('.wiki-mobile-toc').getByRole('link',{name:'The recipe book'}).click();
    assert.match(page.url(),/the-recipe-book$/);
    await page.screenshot({path:'/tmp/wiki-article-'+width+'.png',fullPage:true});
  }
  await page.goto(origin+'/wiki/#/unknown-page');
  await page.getByRole('heading',{name:'That page isn’t on the chart.'}).waitFor();
  await page.getByRole('link',{name:'Back to the wiki →'}).click();
  await page.locator('.wiki-card').first().waitFor();
  await page.locator('.wiki-card').filter({has:page.getByRole('heading',{name:'Getting started',exact:true})}).click();
  await page.getByRole('heading',{name:'Getting started',exact:true,level:1}).waitFor();
  await page.goBack(); await page.locator('.wiki-card').first().waitFor();
  await page.goForward(); await page.getByRole('heading',{name:'Getting started',exact:true,level:1}).waitFor();
  for (const [id, heading] of [['money-and-banking','Money & banking'], ['law-and-bounties','Law & bounties'], ['crews-and-property','Crews & property']]) {
    await page.goto(origin+'/wiki/#/'+id);
    await page.getByRole('heading',{name:heading,exact:true,level:1}).waitFor();
    if (id === 'money-and-banking') {
      assert(await page.locator('.wiki-note').count() >= 1);
      assert(await page.locator('.wiki-steps li').count() >= 3);
    } else assert(await page.locator('.wiki-table').count() >= 1);
    assert.equal(await page.locator('.wiki-demo').count(),0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.locator('.wiki-section-links a').first().click();
    assert(!page.url().endsWith('#/'+id));
  }
  await page.goto(origin+'/wiki/#/the-easter-isles/a-world-to-explore');
  await page.waitForFunction(()=>document.activeElement?.id==='region-notices');
  assert(page.url().endsWith('/region-notices'));
  assert.equal(await page.locator('.wiki-sidebar-note').innerText().then(text=>/demo|sample/i.test(text)), false);
  assert.deepEqual(errors,[]);
  console.log('Wiki browser PASS: navigation, section links, search, history, safe query rendering, responsive layouts.');
} finally { await browser.close(); }
