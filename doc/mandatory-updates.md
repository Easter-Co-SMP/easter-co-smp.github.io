# Mandatory updates

Launcher and game updates are always enabled. Saved false values and renderer input cannot disable them. Only closing the launcher when Minecraft starts remains a preference.

Packaged startup checks the latest normal GitHub release before checking the game. Checking, download, verification, restart and failure occupy a dedicated startup screen before the Home arrival. Failure blocks installation and Play and offers Retry; it never silently enables an unsupported client. Game manifests are checked on startup for existing installs and again immediately before launch.

Each release publishes a platform/architecture-specific app.asar and update manifest. The manifest pins release version, exact Electron runtime, bootstrap protocol, byte length and SHA-256. Assets come only from this repository's HTTPS release URLs. New application files are streamed to a unique temporary file, bounded by the declared length, hashed, and atomically activated only after complete verification. Updates live beneath the existing per-user application directory, so installed program files and AppImages are not overwritten. Account vaults, preferences and Minecraft files keep their existing paths.

A small installed bootstrap validates the selected payload on each start, loads its main entry, and keeps the installed bundle as a repair fallback. A bad cached payload cannot bypass the online version gate. A required runtime/bootstrap change blocks with a clear reinstall message; it never loads incompatible application code. Routine JavaScript/HTML/CSS/dependency updates need only a payload download and automatic restart.

Relaunch uses the original AppImage path on Linux and the installed executable elsewhere, without a shell or renderer-supplied arguments. The installed bootstrap version must be installed once: 1.0.10 and earlier contain no updater and cannot acquire one automatically.

Unpackaged development and test harnesses use the local tree and do not query the production launcher feed. Production does not accept a test feed or bypass flag. Tests inject the update transport in the updater module and use dedicated Electron harnesses.
