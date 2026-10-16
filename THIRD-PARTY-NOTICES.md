# Third-party notices

The Easter Company launcher is proprietary software owned by Easter LTD (see
LICENSE). It embeds the third-party components listed below, which we do
redistribute, either inside the packaged application or inside the installers.

Each component remains the property of its authors and is used under the licence
shown. Nothing here grants you any rights over Easter LTD's own material.

## Components redistributed inside the installed application

### Electron

MIT License. Copyright © Electron contributors.
The full text is installed as `LICENSE.electron.txt` in the application's
resources directory, placed there by electron-builder.

### Chromium

BSD 3-Clause and other licences. Copyright © The Chromium Authors.
The full set of Chromium and third-party licence texts is installed as
`LICENSES.chromium.html` in the application's resources directory, placed there
by electron-builder. That file is the authoritative list of everything Chromium
itself embeds, including its own third-party dependencies.

### Node.js

MIT License. Copyright © Node.js contributors. Embedded by Electron as its
runtime; its notices are included in `LICENSES.chromium.html`.

### @xmcl/core 2.14.1

MIT License. Copyright (c) 2023 CI010.
Used to resolve and prepare the Minecraft installation.

### @xmcl/installer 6.1.0

MIT License. Copyright (c) 2023 CI010.
Used to install the Java runtime, the game assets and the Fabric libraries.

### @xmcl/task 4.1.1

MIT License. Copyright (c) 2023 CI010.
Used by the two @xmcl packages above for their progress reporting.

### undici 7.30.1

MIT License. Copyright (c) Matteo Collina and Undici contributors.
Used as the HTTP client. Pinned here, and in package.json's `overrides`, so a
transitive dependency cannot substitute a different version.

## MIT License text

The MIT-licensed components listed above are distributed under the following
terms, reproduced once and applying to each of them with the copyright holder
named against that component:

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Components we download but do not redistribute

These are fetched at install time from their own upstream servers, straight to the
player's machine. Easter LTD does not redistribute them, does not host them, and
claims no rights over them. Each remains under its own author's licence.

- **Minecraft** (Mojang Studios / Microsoft). Downloaded from Mojang's
  `piston-meta.mojang.com` and `piston-data.mojang.com` distribution servers, and
  subject to the Minecraft End User Licence Agreement.
- **The Java runtime** (Microsoft Build of OpenJDK). Downloaded from Mojang's
  runtime manifest.
- **Fabric loader and its libraries**, from `maven.fabricmc.net` (Apache License
  2.0).
- **The pinned client mods**, from Modrinth's CDN at `cdn.modrinth.com`. Each mod
  is under its own author's licence, which is listed on its Modrinth project page.
  The exact versions the launcher installs are named in the published client
  manifest at `site/data/client.json`, and each mod is checksum-verified against
  the hash Modrinth publishes for that version before it is used.

## Our own hosted component

`site/downloads/easter-navy.jar` is the Easter Co. SMP client modification, built
from Easter LTD's own source in the Easter Navy project. It is proprietary, it is
covered by LICENSE, and it is the only client payload we host ourselves.

## OS icons

Windows 10, Ubuntu, Arch Linux and Linux menu artwork: Icons8, supplied in
the project asset references. Attribution: https://icons8.com/icons (also linked
in the download menu). OS names and logos belong to their respective owners.
