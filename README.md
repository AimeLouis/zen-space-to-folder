# Zen Space to Folder

A Sine mod for Zen Browser that turns a workspace into a collapsed folder at the top of a chosen workspace, preserving subfolders and tab order.

Right-click a workspace, choose **Convert to Folder in…**, then select the destination workspace. The new folder keeps the source workspace’s name and folder hierarchy. Zen folders contain pinned tabs. Available destinations belong to the currently open Zen browser profile.

## What happens to your tabs

- The mod creates a collapsed folder at the top of the destination’s pinned section, below Essentials and before existing tabs and folders. It preserves subfolders, including empty ones, and the sidebar’s top-to-bottom tab order. Unpinned tabs become pinned. Essentials stay in their own bar.
- Tabs that already use the destination’s container are moved with their existing sessions. For other tabs, the mod asks for confirmation before reopening their addresses with the destination container’s cookies. Their browsing history and unsaved form input will be lost. This also applies when both workspaces have the same default container but an individual tab uses a different one.
- Use one synced Zen window per browser profile for this version. Conversion stops if changing containers would require recreating a split view, a Glance preview or a live folder. When changing containers, the mod supports HTTP and HTTPS pages, plus Zen’s blank, new tab and home pages. Zen’s configured folder nesting limit also applies to the new folder. An explanatory message appears if conversion cannot proceed.
- The mod checks the destination folder before removing the source workspace. If a message reports incomplete finalization, check the destination folder and any tabs remaining in the source before trying again.

## Install from GitHub

1. Install [Sine](https://github.com/CosmoCreeper/Sine/releases/latest), then reopen Zen.
2. In **Settings → Sine Mods → Settings**, enable **Enable installing JS from unofficial sources** to allow this JavaScript mod. This setting applies to the whole browser profile.
3. Return to **Sine Mods**, paste `https://github.com/AimeLouis/zen-space-to-folder` into the GitHub installation field, then click **Install**.
4. Restart Zen. Right-click the workspace you want to convert, choose **Convert to Folder in…**, then select the destination.

To receive new versions published in this repository, enable automatic updates in Sine and allow updates for this mod.

## Local installation on macOS

Download and extract [the macOS v1.0.3 package](https://github.com/AimeLouis/zen-space-to-folder/raw/refs/heads/main/Zen-Space-to-Folder-1.0.3.zip), then follow these steps.

1. If **Sine Mods** is missing from Zen’s settings, install Sine for your macOS version and processor. Select Zen and the browser profile in the installer, then reopen Zen. [Official installer](https://github.com/CosmoCreeper/Sine/releases/latest) · [Sine macOS installation guide](https://github.com/sineorg/docs/blob/main/src/installation.md)
2. In **Settings → Sine Mods → Settings**, enable **Enable installing JS from unofficial sources**. This allows Sine to load local scripts and scripts from other unofficial sources. It applies to the whole browser profile.
3. Quit Zen with **⌘Q**. Extract the package and double-click **Installer.command**. The installer requires Python 3 and asks which profile to use if multiple profiles have Sine installed.
4. Reopen Zen. **Zen Space to Folder** appears in your installed Sine mods. Right-click a workspace to choose a destination and convert it.

For a custom profile, find its **root directory** in `about:profiles`. From the extracted package’s folder, you can run the installer with the profile’s full path.

```sh
python3 install.py --profile "/path/to/your/profile"
```

## Updates and reinstallation

**Zen was updated and Sine Mods is still available.** Reopen Zen with the same profile. Sine automatically loads the mod from that profile’s `chrome/sine-mods` folder. [How Sine loads scripts](https://github.com/CosmoCreeper/Sine/blob/fb0bd4ca6af888f10648e126947f7d1f82228433/src/core/utils.sys.mjs#L295-L351)

**Sine Mods disappeared after Zen.app was replaced.** Quit Zen. Run Sine’s official installer again for the new application and the same profile. On the **Old Sine installation detected** screen, select **Save old mods** and **Reinstall bootloader** to keep your mods and restore the loader. Restart Zen. If **Zen Space to Folder** is still missing, quit Zen and run **Installer.command** again. [Sine installer options](https://github.com/sineorg/installer/blob/94ecc00e4746a8c435d0fbcc5c42ada5e94d5891/src/main.cpp#L1014-L1027)

**A new version of the mod is available.** If you installed it from GitHub, use Sine’s update controls. For a local installation, extract the new package and run **Installer.command** with Zen closed. The local installer updates from the package you provide; it does not enable automatic updates. Keep the archive to reinstall the mod offline in any profile where Sine works.

To remove the mod, click **Remove mod** next to **Zen Space to Folder** in Sine Mods, then restart Zen.

## Changelog

- **1.0.3** — English documentation, menus, confirmations, error messages and macOS installer.
- **1.0.2** — Fixed conversion of workspaces created from folders containing subfolders.
- **1.0.1** — Converted folders arrive collapsed at the top of the destination workspace.
