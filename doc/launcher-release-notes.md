# Easter Company launcher 1.0.24

The launcher now points at one server, and that server can sleep between play sessions.

- The server address setting is gone. Every launch targets the Easter Co. SMP directly, so there is nothing to mistype and nothing to keep in step with the server. A launcher that already stored an address keeps working and simply ignores it.
- The server is stopped when nobody is playing. Pressing Play wakes it, shows an honest "starting your server" state, and launches the game by itself the moment the server answers. A first join in a session waits about a minute; once someone is online, everyone else launches immediately.
- If the server does not come up, the launcher says so once and Play is the retry. Signing in, downloads and updates never depend on the server being awake, and a sleeping server is never reported as online.
- The server now enforces real Minecraft authentication, so a player joins as their own account rather than as a name anyone could claim.

Validation covers the launcher unit and browser suites and the real-preload Electron journeys, including a cold start, a warm start, a wake timeout and an unreachable status service. The server side of the wake path is not enabled yet, so this release behaves exactly like 1.0.23 against a server that is running; the cold-start flow switches on when the wake service is deployed.
