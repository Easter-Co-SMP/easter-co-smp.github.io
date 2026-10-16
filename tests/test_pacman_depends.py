"""Guard the Arch package's dependencies, which electron-builder gets wrong by default.

`pacman -U` on 2026-10-16 refused the published launcher-v1.0.5 package:

    warning: cannot resolve "http-parser", a dependency of "easter-company-launcher"
    error: failed to prepare transaction (could not satisfy dependencies)

The cause was not our code. electron-builder's default `pacman` dependency list is
`["c-ares", "ffmpeg", "gtk3", "http-parser", "libevent", "libvpx", "libxslt", "libxss",
"minizip", "nss", "re2", "snappy", "libnotify", "libappindicator-gtk3"]`, and two of those
names are not in any official Arch repository at all: `http-parser` was dropped, and
`libappindicator-gtk3` moved out of the repositories. A package that depends on either can
never be installed by a stock Arch system, no matter how it is built. Every launcher release
up to v1.0.5 carried that list, because the build config never overrode it.

Nothing in the packaged app links `http-parser` either: `readelf -d` on the shipped binaries
lists no http library, and the tray icon that would want libappindicator is not used. The
dependency was never real, only inherited.

So these tests assert the rule rather than the symptom: `build.pacman.depends` must be stated
explicitly, must name only plain packages, must keep the two libraries Electron genuinely
needs, and must never contain the names that cannot resolve. They cannot ask the network
whether a package exists today, so they pin the names that are known to be gone.
"""
from __future__ import annotations
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'package.json'

#: Names electron-builder defaults to that no official Arch repository carries. A package
#: depending on these is uninstallable, which is what the failure above was.
UNRESOLVABLE = {'http-parser', 'libappindicator-gtk3', 'libappindicator', 'gconf'}

#: Electron does not start without these two, so an "explicit list" that lost them would
#: trade one broken package for another.
REQUIRED = {'gtk3', 'nss'}


def build_config() -> dict:
    return json.loads(PACKAGE.read_text(encoding='utf-8'))['build']


class PacmanDepends(unittest.TestCase):
    """The Arch package must declare its own dependencies, and they must be installable."""

    def setUp(self) -> None:
        package = json.loads(PACKAGE.read_text(encoding='utf-8'))
        if 'pacman' not in package.get('build', {}).get('linux', {}).get('target', []):
            self.skipTest('the launcher does not build a pacman package')

    def test_depends_are_stated_rather_than_inherited(self) -> None:
        """An absent key means electron-builder's default list, which cannot resolve."""
        depends = build_config().get('pacman', {}).get('depends')
        self.assertIsInstance(depends, list, 'build.pacman.depends must be set explicitly')
        self.assertTrue(depends, 'build.pacman.depends must not be empty')

    def test_no_dependency_is_missing_from_the_official_repositories(self) -> None:
        depends = set(build_config()['pacman']['depends'])
        self.assertEqual(
            set(), depends & UNRESOLVABLE,
            'these names are not in any official Arch repository, so pacman -U cannot '
            'resolve them and the package cannot be installed',
        )

    def test_electron_runtime_libraries_are_still_required(self) -> None:
        depends = set(build_config()['pacman']['depends'])
        self.assertEqual(set(), REQUIRED - depends, 'the package must depend on gtk3 and nss')

    def test_dependencies_are_plain_package_names(self) -> None:
        """Version constraints and sonames belong to the packaging layer, not here."""
        for name in build_config()['pacman']['depends']:
            with self.subTest(dependency=name):
                self.assertIsInstance(name, str)
                self.assertRegex(name, r'^[a-z0-9][a-z0-9@._+-]*$',
                                 'must be a plain package name, not a constraint or a soname')


if __name__ == '__main__':
    unittest.main()
