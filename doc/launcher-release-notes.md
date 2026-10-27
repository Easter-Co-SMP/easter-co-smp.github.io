# Easter Company launcher 1.0.50

# Easter Company launcher 1.0.50

## Two new chapters about the water

The home page now tells the rest of the sailing story, in the same illustrated chapters as the
rest: taking a ship, naming it and sailing it with your crew, and then what happens when two
ships meet. Both are on the site, and the launcher shows them where it shows the others.

## The map and the guide have new addresses

`/minecraft/map` and `/minecraft/wiki` are where they live now, under the product's own name.
Old links keep working: a bookmark to the old address takes you to the new one, including a
link straight to a wiki article.

## Signing in

- The sign-in window closes itself when it is done, and shows a short confirmation instead of
  the home page while it does.
- The account page hands you back to the site once you are signed in instead of showing you
  an account panel with nothing to do on it.
- Microsoft now signs you in on the company's own domain.

## Smaller things

- The chapter links under the home page sit in two even rows.
- The footer carries the operator credit and the motto's translation.
- The icon is the same picture at a quarter of the size, so the launcher starts a little faster.


# Easter Company launcher 1.0.49

# Easter Company launcher 1.0.49

## Signing in no longer asks you to copy a code

Microsoft sign-in used to show you a code and send you to a page to type it. The launcher now opens
Microsoft's own sign-in page in your browser and takes the answer back itself, over a connection
that exists for exactly one reply and then closes.

- Nothing to copy, nothing to type, and no code left on screen.
- The launcher proves it is the same request it started before it accepts the answer.
- Cancelling in the browser, or closing it, leaves you signed out exactly as you were.

## Microsoft's consent screen says Easter Company

The launcher used to sign in through another application's registration, so Microsoft's page named
someone else. It now uses Easter Company's own, which is the name you will see when you approve it.

## Everyone signs in once

Because the registration changed, the sessions the account service held were issued to the old
application and cannot be renewed. Every player signs in with Microsoft once after this update; if
you have linked Google, Discord or Steam as well they are untouched, and your username, roles and
purchases stay with your account.

## The website can sign you in too

The site has its own sign-in at `easter-co-smp.github.io/account/`, for the store and your account
details. It does not start Minecraft — Play still belongs to the launcher, here.


# Easter Company launcher 1.0.48

## The store opens at once

Pressing Store used to cost a round trip: the page asked the account service for the catalogue and
your orders, and on a cold service that wait was twenty seconds or more. The launcher now asks
once during startup, quietly, and the shop paints from what it already has — then checks again
behind your eyes and redraws only if something changed.

- Measured with the service delayed two seconds: opening the store takes **48 ms** instead of
  **2,329 ms**.
- A first paint from the stored answer is marked as exactly that, and an answer older than a day
  is ignored entirely.
- Nothing is ever bought from the stored copy: pressing Buy always asks the service, which decides
  the price.
- Signing out or switching account drops your orders from it.

## Buying says Pending…

While a press is in flight the row says **Pending…** rather than describing what the launcher is
doing behind it.

## Every currency product says two things

Each pack shows what it is worth in the game and, on its own line, where that money goes: it is
deposited into your in-game bank account when you buy it, and can only be taken out in the game.
It is the bank, never the wallet — so a purchase is never cut down by a cap that exists for play.


# Easter Company launcher 1.0.47

## The shop's artwork

Each product now has an emblem that says what it is at a glance, drawn as local vectors rather
than fetched images: loose coins for a small pack, a pouch for a hundred Stirling, a chest for a
thousand, and a heart above gifted coins for the donation. Nothing is downloaded to draw them.

## Where bought currency goes

Every currency card says what it is worth in the game from the server's own figure, and the shop
says once, above the products, that bought currency is deposited into your in-game bank account
and can only be taken out in the game. It is the bank, not the wallet: the wallet is capped for
play, and a purchase must never be cut down by a cap that exists for a different reason.


# Easter Company launcher 1.0.46

## Paying happens inside the launcher

Pressing Buy in the store no longer hands you off to your web browser. The payment page opens in
its own window inside the launcher, and when the payment finishes you come straight back — no tab
opens anywhere and the website is never loaded.

- The window is Stripe's own page, so your card details go to Stripe and never to us or to the
  launcher.
- A payment that succeeds shows **Payment Successful** in the launcher, and closing it takes you
  to your orders where the purchase is listed.
- Closing the window without paying says nothing at all: the store is exactly as you left it.

## The store sells four products

The one-cent product is gone. Stripe cannot charge a card for less than 50 cents, so it could
never be bought: the price was refused at the last moment and the store could only say it was
unavailable. Ten Sterling, a hundred, a thousand, and the five-dollar donation remain, at the
same prices.

## The privacy page says what paying involves

It now states the one thing that is not "no third-party embeds": the payment page you reach only
if you press Buy is served by Stripe, under Stripe's own privacy notice, and nothing loads from
them until you do.


# Easter Company launcher 1.0.45

## Exit Game

With Minecraft running, the button where Play usually sits now says **Exit Game**. It asks the
client to close, and if it is still there a moment later it ends it outright. That is what it is
for: a game you cannot get rid of any other way.

- It works on a game this launcher started and on one it found already running when it came
  back, which is the case that used to have no button at all.
- It needs no account and no server: it is your computer closing your game.
- A game that has already closed resolves to the ordinary screen rather than leaving a button
  that does nothing.

## The launcher updates while you are playing

A running game is no longer a reason for the launcher to stay on an old version. It downloads
and applies its update in the background and comes back on its own, quietly, out of the tray.

- The game keeps running throughout. The new launcher returns into the in-game screen because
  the game it left is still there.
- Nothing is asked of you and nothing is interrupted; the button is Exit Game when it returns.
- The Minecraft client is never updated while a game is open, and nothing launches in the middle
  of a client update.

## A cold launch shows what it last knew

The status row, the account and the client state used to be blank until the account service
answered, which on a cold start is a wait of twenty seconds or more. Now the launcher shows what
it last knew, marked as the last thing it knew, and confirms it as soon as the real answer
arrives.

- The cached answer is never used to start a game: launching always asks. It is only what the
  screen says while it is asking.
- It expires after a day, and signing out clears it.

## The store is a real shop now

The Community store sells the five real products: 10, 100 and 1,000 Sterling, a $5 donation and a
penny, priced in US dollars.

- Paying happens on Stripe's own page, in your browser. The launcher never sees a card.
- Bought Sterling goes into your bank in the game, not your wallet, so a large purchase is not
  cut down by the wallet's cap.
- The store exists only inside the launcher. The website has no store link anywhere, and asking
  a browser for the store's address sends it home.
- Until the payment service is connected it says so, plainly, and offers nothing to buy.

## Smaller things

- The line under the wordmark reads `Custom Minecraft Client & Server`, and PLAY NOW names the
  account it will play as instead of repeating the edition.
- The cold-start sentence says `The server is booting up, this might take a minute.`
- The server is called `Easter Co. Survival Multiplayer Server (Easter Co. SMP)`.
- The launcher no longer claims to support macOS, because it does not.


# Easter Company launcher 1.0.44

## The status line waits instead of guessing

The launcher asks the server how it is before you press Play. Until that answer comes back,
the row under the Play button now says **Status pending…** beside a small turning ring,
rather than saying the server is offline when nothing has gone wrong.

- Once the answer arrives it reads the usual line: `Server Online, 2 active players`, or
  `Server Online, 0 active players` for a server that is asleep with nobody on it.
- `Server Offline` now means what it says: the launcher asked and could not get an answer.
  It is the one case that shows the red dot.
- The ring turns slowly and stops turning for anyone who has asked their system to reduce
  motion. The words carry the state either way.


# Easter Company launcher 1.0.43

## The store looks like the rest of the site

- The store's type is the site's type again: it was rendering in a different face from the
  map and the wiki, and its title was smaller than the headings under it. The title now
  matches the wiki's page heading.
- On a narrow window the store's header is the same height and gutter as the map and the
  wiki.
- The sentence saying the store is a mock stays on screen while you scroll the catalogue,
  instead of scrolling away and leaving prices and "Sold out" badges looking real.
- Corners and buttons use the site's own shapes.

## You can reach the store from the home page

The header of every page — home, map, wiki and the store — lists Store beside Map and Wiki,
in the launcher and in a browser.

## Nothing promises what the mock does not do

Item terms no longer mention confirming availability "before payment", and no product page
promises delivery or ownership: every item carries the same line saying this is a demo
catalogue where nothing is charged, reserved or delivered.


# Easter Company launcher 1.0.42

## The store is a page now

The store is no longer an overlay on the home screen. It is a page of its own, laid out
like the map and the wiki, and it is reached the same way they are: from the header.

- The store lives at `/store/` and appears in the site header on Home, Map, Wiki and the
  store itself. The old Store button that opened a dialog over the hero is gone.
- Its views are addresses, so Back and Forward work and a link can be shared:
  `#catalogue`, `#item/<id>`, `#cart`, `#checkout`, `#receipt/<id>`, `#orders`.
- Sampled the same way as the map and the wiki: same header, same footer, same type, and
  it stays legible from a narrow window to a wide one.
- It is still a mock, and says so on the page before you touch anything: sample products
  and sample USD prices, no real payment, nothing delivered to the game, orders gone when
  you leave the page.

## It is called the Community store

"The Company store" is now "The Community store", in the page heading, the window title,
the description and the home page's store card.

## While the server comes up it says the server

The cold-start line reads "Starting the server…" and "Minecraft opens when the server is
ready", instead of "your server".


# Easter Company launcher 1.0.41

# Easter Company launcher 1.0.41

You connect Microsoft once now, and it stays connected.

- **Why it kept asking.** Every time you signed in, the launcher spent the refresh token
  Microsoft had given it and then kept the copy Microsoft had just invalidated — so the
  account service was handed an already-dead credential, could never make a Minecraft
  session from it, and asked you to reconnect on the next launch. Two requests did that: the
  one that reissues a token for Xbox Live, and the optional one that reads your Microsoft
  email for the account service. Neither asked Microsoft for a replacement token, which
  Microsoft only returns when the request asks for it. Both do now, and the launcher always
  keeps the newest token it is given.
- **One reconnect left, then never again.** This build cannot repair the dead token already
  stored on your machine — those tokens are single use. Sign in once with this version and
  the account service receives a live one, which is what it mints from from then on, on every
  computer you sign in on.
- **A linked account that cannot play now says so.** The hero used to call a Microsoft
  session `local` — meaning it can launch — even when the token behind it had expired and
  nothing could renew it. In that state the launcher looked ready and could never offer the
  one action that fixes it. It now offers the reconnect instead of claiming a session it
  cannot make.


# Easter Company launcher 1.0.40

# Easter Company launcher 1.0.40

Your profile menu is now three things you can do, and Home fits a small window.

- **The profile menu is My Profile, Linked Accounts and Logout.** Opening your name used to
  offer one long list — a "Signs in as" line, a Microsoft/Xbox status line, a combined
  profile dialog, a password entry and a verified-emails entry. It now reads your display
  name, then your username on its own line, then those three entries. Everything about who
  you are lives inside My Profile; everything about what you have connected lives inside
  Linked Accounts.
- **My Profile holds your password form.** Enter a new password twice and save. You are not
  asked for your current one — an active sign-in is enough — and the launcher applies the
  same 8-to-128-character rule the account service does, with an honest sentence when it
  refuses. Your verified emails are in My Profile too, in the section you open on purpose.
- **There is no password reset and no "Forgot your password?" link.** The launcher used to
  offer a recovery flow the account service never had. That control is gone, and a sentence
  in its place says what the real route is: sign in with a linked account, then change the
  password in My Profile.
- **Linked Accounts is only about connections.** Microsoft, Google, Discord and Steam each
  show whether they are linked, and your Minecraft session sits beside them. No email
  address and no password there.
- **Home fits the launcher's smallest window.** At 800×600 the home column overflowed and the
  window chooser's refusal could not be scrolled to; both are laid out to fit now.
- Nothing else changed: the same home screen, server row, downloads, news card and sign-in.


# Easter Company launcher 1.0.40

Your profile menu is now three things you can do, and Home fits a small window.

- **The profile menu is My Profile, Linked Accounts and Logout.** Opening your name used to
  offer one long list — a "Signs in as" line, a Microsoft/Xbox status line, a combined
  profile dialog, a password entry and a verified-emails entry. It now reads your display
  name, then your username on its own line, then those three entries. Everything about who
  you are lives inside My Profile; everything about what you have connected lives inside
  Linked Accounts.
- **My Profile holds your password form.** Enter a new password twice and save. You are not
  asked for your current one — an active sign-in is enough — and the launcher applies the
  same 8-to-128-character rule the account service does, with an honest sentence when it
  refuses. Your verified emails are in My Profile too, in the section you open on purpose.
- **There is no password reset and no "Forgot your password?" link.** The launcher used to
  offer a recovery flow the account service never had. That control is gone, and a sentence
  in its place says what the real route is: sign in with a linked account, then change the
  password in My Profile.
- **Linked Accounts is only about connections.** Microsoft, Google, Discord and Steam each
  show whether they are linked, and your Minecraft session sits beside them. No email
  address and no password there.
- **Home fits the launcher's smallest window.** At 800×600 the home column overflowed and the
  window chooser's refusal could not be scrolled to; both are laid out to fit now.
- Nothing else changed: the same home screen, server row, downloads, news card and sign-in.


# Easter Company launcher 1.0.49

## Signing in no longer asks you to copy a code

Microsoft sign-in used to show you a code and send you to a page to type it. The launcher now opens
Microsoft's own sign-in page in your browser and takes the answer back itself, over a connection
that exists for exactly one reply and then closes.

- Nothing to copy, nothing to type, and no code left on screen.
- The launcher proves it is the same request it started before it accepts the answer.
- Cancelling in the browser, or closing it, leaves you signed out exactly as you were.

## Microsoft's consent screen says Easter Company

The launcher used to sign in through another application's registration, so Microsoft's page named
someone else. It now uses Easter Company's own, which is the name you will see when you approve it.

## Everyone signs in once

Because the registration changed, the sessions the account service held were issued to the old
application and cannot be renewed. Every player signs in with Microsoft once after this update; if
you have linked Google, Discord or Steam as well they are untouched, and your username, roles and
purchases stay with your account.

## The website can sign you in too

The site has its own sign-in at `easter-co-smp.github.io/account/`, for the store and your account
details. It does not start Minecraft — Play still belongs to the launcher, here.


# Easter Company launcher 1.0.48

## The store opens at once

Pressing Store used to cost a round trip: the page asked the account service for the catalogue and
your orders, and on a cold service that wait was twenty seconds or more. The launcher now asks
once during startup, quietly, and the shop paints from what it already has — then checks again
behind your eyes and redraws only if something changed.

- Measured with the service delayed two seconds: opening the store takes **48 ms** instead of
  **2,329 ms**.
- A first paint from the stored answer is marked as exactly that, and an answer older than a day
  is ignored entirely.
- Nothing is ever bought from the stored copy: pressing Buy always asks the service, which decides
  the price.
- Signing out or switching account drops your orders from it.

## Buying says Pending…

While a press is in flight the row says **Pending…** rather than describing what the launcher is
doing behind it.

## Every currency product says two things

Each pack shows what it is worth in the game and, on its own line, where that money goes: it is
deposited into your in-game bank account when you buy it, and can only be taken out in the game.
It is the bank, never the wallet — so a purchase is never cut down by a cap that exists for play.


# Easter Company launcher 1.0.47

## The shop's artwork

Each product now has an emblem that says what it is at a glance, drawn as local vectors rather
than fetched images: loose coins for a small pack, a pouch for a hundred Stirling, a chest for a
thousand, and a heart above gifted coins for the donation. Nothing is downloaded to draw them.

## Where bought currency goes

Every currency card says what it is worth in the game from the server's own figure, and the shop
says once, above the products, that bought currency is deposited into your in-game bank account
and can only be taken out in the game. It is the bank, not the wallet: the wallet is capped for
play, and a purchase must never be cut down by a cap that exists for a different reason.


# Easter Company launcher 1.0.46

## Paying happens inside the launcher

Pressing Buy in the store no longer hands you off to your web browser. The payment page opens in
its own window inside the launcher, and when the payment finishes you come straight back — no tab
opens anywhere and the website is never loaded.

- The window is Stripe's own page, so your card details go to Stripe and never to us or to the
  launcher.
- A payment that succeeds shows **Payment Successful** in the launcher, and closing it takes you
  to your orders where the purchase is listed.
- Closing the window without paying says nothing at all: the store is exactly as you left it.

## The store sells four products

The one-cent product is gone. Stripe cannot charge a card for less than 50 cents, so it could
never be bought: the price was refused at the last moment and the store could only say it was
unavailable. Ten Sterling, a hundred, a thousand, and the five-dollar donation remain, at the
same prices.

## The privacy page says what paying involves

It now states the one thing that is not "no third-party embeds": the payment page you reach only
if you press Buy is served by Stripe, under Stripe's own privacy notice, and nothing loads from
them until you do.


# Easter Company launcher 1.0.45

## Exit Game

With Minecraft running, the button where Play usually sits now says **Exit Game**. It asks the
client to close, and if it is still there a moment later it ends it outright. That is what it is
for: a game you cannot get rid of any other way.

- It works on a game this launcher started and on one it found already running when it came
  back, which is the case that used to have no button at all.
- It needs no account and no server: it is your computer closing your game.
- A game that has already closed resolves to the ordinary screen rather than leaving a button
  that does nothing.

## The launcher updates while you are playing

A running game is no longer a reason for the launcher to stay on an old version. It downloads
and applies its update in the background and comes back on its own, quietly, out of the tray.

- The game keeps running throughout. The new launcher returns into the in-game screen because
  the game it left is still there.
- Nothing is asked of you and nothing is interrupted; the button is Exit Game when it returns.
- The Minecraft client is never updated while a game is open, and nothing launches in the middle
  of a client update.

## A cold launch shows what it last knew

The status row, the account and the client state used to be blank until the account service
answered, which on a cold start is a wait of twenty seconds or more. Now the launcher shows what
it last knew, marked as the last thing it knew, and confirms it as soon as the real answer
arrives.

- The cached answer is never used to start a game: launching always asks. It is only what the
  screen says while it is asking.
- It expires after a day, and signing out clears it.

## The store is a real shop now

The Community store sells the five real products: 10, 100 and 1,000 Sterling, a $5 donation and a
penny, priced in US dollars.

- Paying happens on Stripe's own page, in your browser. The launcher never sees a card.
- Bought Sterling goes into your bank in the game, not your wallet, so a large purchase is not
  cut down by the wallet's cap.
- The store exists only inside the launcher. The website has no store link anywhere, and asking
  a browser for the store's address sends it home.
- Until the payment service is connected it says so, plainly, and offers nothing to buy.

## Smaller things

- The line under the wordmark reads `Custom Minecraft Client & Server`, and PLAY NOW names the
  account it will play as instead of repeating the edition.
- The cold-start sentence says `The server is booting up, this might take a minute.`
- The server is called `Easter Co. Survival Multiplayer Server (Easter Co. SMP)`.
- The launcher no longer claims to support macOS, because it does not.


# Easter Company launcher 1.0.44

## The status line waits instead of guessing

The launcher asks the server how it is before you press Play. Until that answer comes back,
the row under the Play button now says **Status pending…** beside a small turning ring,
rather than saying the server is offline when nothing has gone wrong.

- Once the answer arrives it reads the usual line: `Server Online, 2 active players`, or
  `Server Online, 0 active players` for a server that is asleep with nobody on it.
- `Server Offline` now means what it says: the launcher asked and could not get an answer.
  It is the one case that shows the red dot.
- The ring turns slowly and stops turning for anyone who has asked their system to reduce
  motion. The words carry the state either way.


# Easter Company launcher 1.0.43

## The store looks like the rest of the site

- The store's type is the site's type again: it was rendering in a different face from the
  map and the wiki, and its title was smaller than the headings under it. The title now
  matches the wiki's page heading.
- On a narrow window the store's header is the same height and gutter as the map and the
  wiki.
- The sentence saying the store is a mock stays on screen while you scroll the catalogue,
  instead of scrolling away and leaving prices and "Sold out" badges looking real.
- Corners and buttons use the site's own shapes.

## You can reach the store from the home page

The header of every page — home, map, wiki and the store — lists Store beside Map and Wiki,
in the launcher and in a browser.

## Nothing promises what the mock does not do

Item terms no longer mention confirming availability "before payment", and no product page
promises delivery or ownership: every item carries the same line saying this is a demo
catalogue where nothing is charged, reserved or delivered.


# Easter Company launcher 1.0.42

## The store is a page now

The store is no longer an overlay on the home screen. It is a page of its own, laid out
like the map and the wiki, and it is reached the same way they are: from the header.

- The store lives at `/store/` and appears in the site header on Home, Map, Wiki and the
  store itself. The old Store button that opened a dialog over the hero is gone.
- Its views are addresses, so Back and Forward work and a link can be shared:
  `#catalogue`, `#item/<id>`, `#cart`, `#checkout`, `#receipt/<id>`, `#orders`.
- Sampled the same way as the map and the wiki: same header, same footer, same type, and
  it stays legible from a narrow window to a wide one.
- It is still a mock, and says so on the page before you touch anything: sample products
  and sample USD prices, no real payment, nothing delivered to the game, orders gone when
  you leave the page.

## It is called the Community store

"The Company store" is now "The Community store", in the page heading, the window title,
the description and the home page's store card.

## While the server comes up it says the server

The cold-start line reads "Starting the server…" and "Minecraft opens when the server is
ready", instead of "your server".


# Easter Company launcher 1.0.41

# Easter Company launcher 1.0.41

You connect Microsoft once now, and it stays connected.

- **Why it kept asking.** Every time you signed in, the launcher spent the refresh token
  Microsoft had given it and then kept the copy Microsoft had just invalidated — so the
  account service was handed an already-dead credential, could never make a Minecraft
  session from it, and asked you to reconnect on the next launch. Two requests did that: the
  one that reissues a token for Xbox Live, and the optional one that reads your Microsoft
  email for the account service. Neither asked Microsoft for a replacement token, which
  Microsoft only returns when the request asks for it. Both do now, and the launcher always
  keeps the newest token it is given.
- **One reconnect left, then never again.** This build cannot repair the dead token already
  stored on your machine — those tokens are single use. Sign in once with this version and
  the account service receives a live one, which is what it mints from from then on, on every
  computer you sign in on.
- **A linked account that cannot play now says so.** The hero used to call a Microsoft
  session `local` — meaning it can launch — even when the token behind it had expired and
  nothing could renew it. In that state the launcher looked ready and could never offer the
  one action that fixes it. It now offers the reconnect instead of claiming a session it
  cannot make.


# Easter Company launcher 1.0.40

# Easter Company launcher 1.0.40

Your profile menu is now three things you can do, and Home fits a small window.

- **The profile menu is My Profile, Linked Accounts and Logout.** Opening your name used to
  offer one long list — a "Signs in as" line, a Microsoft/Xbox status line, a combined
  profile dialog, a password entry and a verified-emails entry. It now reads your display
  name, then your username on its own line, then those three entries. Everything about who
  you are lives inside My Profile; everything about what you have connected lives inside
  Linked Accounts.
- **My Profile holds your password form.** Enter a new password twice and save. You are not
  asked for your current one — an active sign-in is enough — and the launcher applies the
  same 8-to-128-character rule the account service does, with an honest sentence when it
  refuses. Your verified emails are in My Profile too, in the section you open on purpose.
- **There is no password reset and no "Forgot your password?" link.** The launcher used to
  offer a recovery flow the account service never had. That control is gone, and a sentence
  in its place says what the real route is: sign in with a linked account, then change the
  password in My Profile.
- **Linked Accounts is only about connections.** Microsoft, Google, Discord and Steam each
  show whether they are linked, and your Minecraft session sits beside them. No email
  address and no password there.
- **Home fits the launcher's smallest window.** At 800×600 the home column overflowed and the
  window chooser's refusal could not be scrolled to; both are laid out to fit now.
- Nothing else changed: the same home screen, server row, downloads, news card and sign-in.


# Easter Company launcher 1.0.40

Your profile menu is now three things you can do, and Home fits a small window.

- **The profile menu is My Profile, Linked Accounts and Logout.** Opening your name used to
  offer one long list — a "Signs in as" line, a Microsoft/Xbox status line, a combined
  profile dialog, a password entry and a verified-emails entry. It now reads your display
  name, then your username on its own line, then those three entries. Everything about who
  you are lives inside My Profile; everything about what you have connected lives inside
  Linked Accounts.
- **My Profile holds your password form.** Enter a new password twice and save. You are not
  asked for your current one — an active sign-in is enough — and the launcher applies the
  same 8-to-128-character rule the account service does, with an honest sentence when it
  refuses. Your verified emails are in My Profile too, in the section you open on purpose.
- **There is no password reset and no "Forgot your password?" link.** The launcher used to
  offer a recovery flow the account service never had. That control is gone, and a sentence
  in its place says what the real route is: sign in with a linked account, then change the
  password in My Profile.
- **Linked Accounts is only about connections.** Microsoft, Google, Discord and Steam each
  show whether they are linked, and your Minecraft session sits beside them. No email
  address and no password there.
- **Home fits the launcher's smallest window.** At 800×600 the home column overflowed and the
  window chooser's refusal could not be scrolled to; both are laid out to fit now.
- Nothing else changed: the same home screen, server row, downloads, news card and sign-in.
