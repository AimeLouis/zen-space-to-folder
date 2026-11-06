#!/usr/bin/env python3
"""Install the local mod in a Zen/Sine profile while the browser is closed (macOS)."""

import argparse
import configparser
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile


MOD_ID = "zen-space-to-folder"
SCRIPT = "space-to-folder.uc.js"
PACKAGE = Path(__file__).resolve().parent
SINE_ENGINE = Path("chrome/JS/core/manager.sys.mjs")
SINE_REGISTRY = Path("chrome/sine-mods/mods.json")
SINE_URL = "https://github.com/CosmoCreeper/Sine/releases/latest"


def locate_profile():
    root = Path.home() / "Library/Application Support/zen"
    config = configparser.ConfigParser(interpolation=None)
    config.read(root / "profiles.ini", encoding="utf-8")
    profiles = {}
    for section in config.sections():
        if section.startswith("Profile") and config.has_option(section, "Path"):
            path = Path(config[section]["Path"]).expanduser()
            if config[section].get("IsRelative", "1") == "1":
                path = root / path
            if (path / SINE_ENGINE).is_file():
                profiles[path.resolve()] = config[section].get("Name", path.name)
    if not profiles:
        raise ValueError(
            f"Install Sine in your Zen profile, then open and quit Zen.\n{SINE_URL}\n"
            "To select a custom profile, use --profile with its root folder."
        )
    if len(profiles) == 1:
        return next(iter(profiles))
    print("Multiple Zen profiles use Sine.")
    for index, (path, name) in enumerate(profiles.items(), 1):
        print(f"  {index}. {name} ({path})")
    if not sys.stdin.isatty():
        raise ValueError("Specify the profile with --profile.")
    choice = input("Profile number to install into (press Enter to cancel): ").strip()
    if not choice.isdecimal() or not 1 <= int(choice) <= len(profiles):
        raise ValueError("Selection cancelled.")
    return list(profiles)[int(choice) - 1]


def write_atomically(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        name = temporary.name
        try:
            temporary.write(data)
            temporary.flush()
            os.fsync(temporary.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)


def install(profile):
    profile = profile.expanduser().resolve()
    registry_path = profile / SINE_REGISTRY
    if not (profile / SINE_ENGINE).is_file() or not registry_path.is_file():
        raise ValueError(
            f"Sine must be installed and initialized in this profile: {profile}\n"
            f"Install Sine, open Zen once, then quit it with ⌘Q.\n{SINE_URL}"
        )
    manifest = json.loads((PACKAGE / "theme.json").read_text(encoding="utf-8"))
    if manifest.get("id") != MOD_ID or SCRIPT not in manifest.get("scripts", {}):
        raise ValueError("The manifest does not match this package’s script.")
    script = (PACKAGE / SCRIPT).read_bytes()
    if not script.strip():
        raise ValueError("The mod’s script is empty. Extract the package again.")
    # Firefox/Zen locks this file using a POSIX write lock on macOS. Keep it
    # locked while merging the registry so Zen or a second installer cannot race us.
    lockfile = profile / ".parentlock"
    if lockfile.is_symlink():
        raise ValueError("This profile uses a symbolic lock. Quit Zen and try again.")
    with lockfile.open("a+b") as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError) as error:
            raise ValueError("This profile is open. Quit Zen with ⌘Q, then try again.") from error
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        if not isinstance(registry, dict):
            raise ValueError("Unknown Sine registry format. Installation stopped.")
        previous = registry.get(MOD_ID, {})
        if not isinstance(previous, dict) or previous.get("id", MOD_ID) != MOD_ID:
            raise ValueError("The mod’s entry in the Sine registry is invalid.")
        enabled = previous.get("enabled", True)
        record = {**manifest, "origin": "local", "enabled": enabled, "no-updates": True}
        folder = registry_path.parent / MOD_ID
        folder.mkdir(exist_ok=True)
        script_path = folder / SCRIPT
        if not script_path.exists() or script_path.read_bytes() != script:
            write_atomically(script_path, script)
        if record != previous:
            registry[MOD_ID] = record
            data = (json.dumps(registry, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            write_atomically(registry_path, data)
    print(f"Mod installed • {manifest['version']}\nProfile: {profile}")
    if not enabled:
        print("This mod was disabled. Enable it in Sine Mods settings.")
    print("Reopen Zen. Sine must allow JavaScript from unofficial sources.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, help="root folder of the Zen profile")
    args = parser.parse_args()
    try:
        install(args.profile or locate_profile())
    except (OSError, ValueError, EOFError, configparser.Error) as error:
        parser.exit(1, f"Installation stopped. {error}\n")


if __name__ == "__main__":
    main()
