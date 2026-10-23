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
