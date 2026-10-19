# Easter Company launcher 1.0.25

The first Play of the day now wakes the server instead of giving up on it.

- The launcher waits long enough for the account service to answer. That service scales
  itself to zero when nobody is playing, so the first request after a quiet night takes
  a few seconds to come back; the launcher used to stop waiting before it did, and Play
  then tried to join a server that was still asleep. It now waits for the answer, so Play
  starts the server and launches the game by itself once the server is up.
- Nothing else changes: same fixed server, same one-minute cold start, same retry, same
  honesty about a server that is not up.
- Warm sessions are unaffected - once someone is online the answer arrives in about half
  a second, exactly as before.

# Easter Company launcher 1.0.24

The launcher now points at one server, and that server can sleep between play sessions.

- The server address setting is gone. Every launch targets the Easter Co. SMP directly, so there is nothing to mistype and nothing to keep in step with the server. A launcher that already stored an address keeps working and simply ignores it.
- The server is stopped when nobody is playing. Pressing Play wakes it, shows an honest "starting your server" state, and launches the game by itself the moment the server answers. A first join in a session waits about a minute; once someone is online, everyone else launches immediately.
- If the server does not come up, the launcher says so once and Play is the retry. Signing in, downloads and updates never depend on the server being awake, and a sleeping server is never reported as online.
- The server now enforces real Minecraft authentication, so a player joins as their own account rather than as a name anyone could claim.

Validation covers the launcher unit and browser suites and the real-preload Electron journeys, including a cold start, a warm start, a wake timeout and an unreachable status service. The server side of the wake path is not enabled yet, so this release behaves exactly like 1.0.23 against a server that is running; the cold-start flow switches on when the wake service is deployed.
