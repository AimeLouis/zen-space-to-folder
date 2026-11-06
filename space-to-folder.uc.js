// ==UserScript==
// @name           Zen Space to Folder
// @version        1.0.3
// @description    Turn a Zen workspace into a folder in a chosen workspace.
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

(() => {
  "use strict";
  if (window.location.protocol !== "chrome:" ||
      window.location.pathname !== "/content/browser.xhtml" ||
      window.location.host !== "browser") return;

  const menuId = "zen-space-to-folder";
  if (document.getElementById(menuId)) return;

  // Only ordinary navigations can be reopened in a different cookie container.
  // Never import another container's session entries, form data or principal.
  function checkReopenUrl(value) {
    let url;
    try { url = new URL(value); } catch {}
    if (!(url && (
      (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) ||
      ["about:blank", "about:newtab", "about:home"].includes(url.href)
    ))) {
      throw new Error("A tab has an address that cannot be reopened in another container. Move that tab separately, then try again.");
    }
    return url.href;
  }

  function validateReplacement(tab) {
    const { SessionStore } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs"
    );
    const state = JSON.parse(SessionStore.getTabState(tab));
    const entry = state.entries?.[(state.index || state.entries.length) - 1];
    if (entry?.postdata_b64 || entry?.postData || entry?.hasPostData || state.formdata) {
      throw new Error("A tab has form data or navigation that needs to be preserved. Complete it or move the tab out of this workspace before changing containers.");
    }
    const current = tab.linkedBrowser?.currentURI?.spec;
    const target = tab.hasAttribute("pending") || !tab.linkedPanel
      ? entry?.url || current : current || entry?.url;
    const url = checkReopenUrl(target);
    const pinned = tab._zenPinnedInitialState?.entry;
    const pinnedUrl = pinned?.url ? checkReopenUrl(pinned.url) : url;
    return { url, pinnedUrl, pinnedTitle: pinned?.title || "", title: tab.label || entry?.title || "" };
  }

  async function prepareReplacement(oldTab, destinationId, containerId) {
    const { url, pinnedUrl, pinnedTitle, title } = validateReplacement(oldTab);
    const tab = gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({ userContextId: containerId }),
      userContextId: containerId,
      zenWorkspaceId: destinationId,
      skipRoute: true,
      createLazyBrowser: true,
      lazyTabTitle: title,
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
    });
    if (!tab) throw new Error("Zen could not reopen a tab in the destination container.");
    try {
      if (Number(tab.userContextId) !== containerId) {
        throw new Error("Zen opened the tab in an unexpected container. The conversion was stopped.");
      }
      tab.setAttribute("zen-workspace-id", destinationId);
      tab.setAttribute("zenDefaultUserContextId", "true");
      // TabOpen assigns the new tab's sync ID asynchronously. Set its local
      // canonical entry before TabPinned can derive it from the current page.
      tab._zenPinnedInitialState = { entry: { url: pinnedUrl, title: pinnedTitle || title } };
      gBrowser.pinTab(tab);
      gZenWorkspaces.moveTabToWorkspace(tab, destinationId);
      if (oldTab.zenStaticLabel) {
        tab.zenStaticLabel = oldTab.zenStaticLabel;
        tab._zenChangeLabelFlag = true;
        try { gBrowser._setTabLabel(tab, oldTab.zenStaticLabel); }
        finally { delete tab._zenChangeLabelFlag; }
      }
      return tab;
    } catch (error) {
      gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true, skipSessionStore: true });
      throw error;
    }
  }
  const workspaceAttribute = "zen-workspace-id";
  const conversionLock = Symbol.for("sine.zen-space-to-folder.running");

  function checkConversionWindow() {
    if (gZenWorkspaces.privateWindowOrDisabled) {
      throw new Error("Open your Zen profile’s main window to convert a workspace.");
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win !== window && !win.closed && win.gZenWorkspaces?.currentWindowIsSyncing) {
        throw new Error("Close the other synced Zen windows for this profile before converting a workspace.");
      }
    }
  }

  // The tab strip contains labels, separators and a generic empty tab as well
  // as user items. A folder's own empty tab, in contrast, belongs to that folder.
  function contentNodes(container, includeEmpty = false) {
    if (!container) {
      throw new Error("Zen did not provide the expected tab structure.");
    }
    return Array.from(container.children).filter(node =>
      (gBrowser.isTab(node) || gBrowser.isTabGroup(node)) &&
      !node.hasAttribute("zen-essential") &&
      (includeEmpty || !node.hasAttribute("zen-empty-tab"))
    );
  }

  function workspaceRoots(element) {
    return [...contentNodes(element.pinnedTabsContainer), ...contentNodes(element.tabsContainer)];
  }

  function sameNodes(actual, expected) {
    return actual.length === expected.length && expected.every((node, i) => actual[i] === node);
  }

  function inspectSpaceConversion(sourceId, destinationId) {
    checkConversionWindow();
    const source = gZenWorkspaces.getWorkspaceFromId(sourceId);
    const destination = gZenWorkspaces.getWorkspaceFromId(destinationId);
    if (!source || !destination || sourceId === destinationId) {
      throw new Error("Choose two different workspaces in this profile.");
    }
    const sourceElement = gZenWorkspaces.workspaceElement(sourceId);
    const destinationElement = gZenWorkspaces.workspaceElement(destinationId);
    if (!sourceElement || !destinationElement?.pinnedTabsContainer) {
      throw new Error("This workspace’s tab bar is unavailable.");
    }
    const containerId = Number(destination.containerTabId || 0);
    const maxDepth = Services.prefs.getIntPref("zen.folders.max-subfolders", 5);
    const roots = workspaceRoots(sourceElement);
    const groups = new Map();
    const positions = new Map();
    const ownership = new Map();
    const replacements = new Map();
    let tabCount = 0;
    let folderCount = 0;

    function record(node, depth, specialGroup) {
      const owner = node.getAttribute(workspaceAttribute);
      const isGroup = gBrowser.isTabGroup(node);
      // Zen's folder-to-space command can leave the old workspace ID on
      // nested group shells. Check their actual location and every child tab.
      if (!sourceElement.contains(node) || (owner && owner !== sourceId && !isGroup) ||
          node.closing || !node.isConnected) {
        throw new Error("The tabs in this workspace are changing. Please try again.");
      }
      positions.set(node, { parent: node.parentNode, next: node.nextSibling, pinned: node.pinned });
      ownership.set(node, owner);
      if (isGroup) {
        if (node.isZenFolder) {
          folderCount++;
          if (depth >= maxDepth) {
            throw new Error("The folder would exceed Zen’s configured nesting limit.");
          }
        } else if (!node.hasAttribute("split-view-group")) {
          throw new Error("This workspace contains a type of group that this mod cannot move.");
        }
        const children = contentNodes(node.groupContainer, true);
        groups.set(node, children);
        for (const child of children) {
          record(child, depth + 1, specialGroup || node.isLiveFolder || !node.isZenFolder);
        }
        return;
      }
      if (node.hasAttribute("zen-empty-tab")) {
        return;
      }
      tabCount++;
      const glance = node.querySelector(".tabbrowser-tab[glance-id], .tabbrowser-tab[zen-glance-tab]");
      if (glance) {
        if (Number(glance.userContextId || 0) !== containerId) {
          throw new Error("Close the Glance preview before changing containers.");
        }
        ownership.set(glance, glance.getAttribute(workspaceAttribute));
      }
      if (Number(node.userContextId || 0) !== containerId) {
        if (specialGroup || glance || node.hasAttribute("zen-glance-tab")) {
          throw new Error("Changing containers would require recreating a split view, a Glance preview or a live folder. Choose a workspace that uses the same container.");
        }
        replacements.set(node, validateReplacement(node));
      }
    }
    for (const root of roots) {
      record(root, 1, false);
    }
    checkSourceRemainder(sourceId, sourceElement, ownership);
    return {
      source, destination, tabCount, folderCount, reopenCount: replacements.size,
      sourceElement, destinationElement, containerId, roots, groups, positions, ownership, replacements,
    };
  }

  function checkSourceRemainder(id, element, allowed) {
    gBrowser.tabContainer._invalidateCachedTabs();
    const physical = element.querySelectorAll("tab, zen-folder, tab-group");
    const owned = gZenWorkspaces.allStoredTabs.filter(tab => tab.getAttribute(workspaceAttribute) === id);
    for (const node of [...physical, ...owned]) {
      if (node.hasAttribute("zen-essential") || (node.hasAttribute("zen-empty-tab") && !node.group)) {
        continue;
      }
      if (!allowed.has(node)) {
        throw new Error("Zen found an unexpected item in the source workspace. The workspace has been kept.");
      }
    }
  }

  function assertSourceUnchanged(plan) {
    checkConversionWindow();
    const { source, destination, roots, groups, positions, replacements } = plan;
    const currentDestination = gZenWorkspaces.getWorkspaceFromId(destination.uuid);
    if (!gZenWorkspaces.getWorkspaceFromId(source.uuid) || !currentDestination ||
        Number(currentDestination.containerTabId || 0) !== plan.containerId ||
        !sameNodes(workspaceRoots(plan.sourceElement), roots)) {
      throw new Error("The workspaces changed during preparation. Start the conversion again.");
    }
    for (const [group, children] of groups) {
      if (!sameNodes(contentNodes(group.groupContainer, true), children)) {
        throw new Error("A folder’s contents changed during preparation.");
      }
    }
    for (const [node, position] of positions) {
      if (node.parentNode !== position.parent || node.pinned !== position.pinned || node.closing) {
        throw new Error("An item was moved during preparation.");
      }
    }
    checkReplacementSources(replacements);
    checkSourceRemainder(source.uuid, plan.sourceElement, plan.ownership);
  }

  function checkReplacementSources(replacements) {
    for (const [old, original] of replacements) {
      if (old.closing || !old.isConnected || !sameReopenedPage(old, original)) {
        throw new Error("A tab that needs to be reopened changed pages or was closed. Start the conversion again.");
      }
    }
  }

  function sameReopenedPage(tab, expected) {
    const current = validateReplacement(tab);
    return current.url === expected.url && current.pinnedUrl === expected.pinnedUrl;
  }

  function moveConversionItem(node, parent, before = null) {
    gBrowser.zenHandleTabMove(node, () => parent.insertBefore(node, before));
  }

  function checkDestination(plan, wrapper, copies, originalsClosed = false) {
    checkConversionWindow();
    const { source, destination, roots, groups, ownership, replacements } = plan;
    const replacementFor = node => copies.get(node) || node;
    const target = gZenWorkspaces.getWorkspaceFromId(destination.uuid);
    if (!target || Number(target.containerTabId || 0) !== plan.containerId ||
        !gZenWorkspaces.getWorkspaceFromId(source.uuid) ||
        contentNodes(plan.destinationElement.pinnedTabsContainer)[0] !== wrapper || !wrapper.collapsed ||
        !sameNodes(contentNodes(wrapper.groupContainer), roots.map(replacementFor))) {
      throw new Error("The destination folder’s structure could not be verified.");
    }
    for (const [group, children] of groups) {
      if (!sameNodes(contentNodes(group.groupContainer, true), children.map(replacementFor))) {
        throw new Error("The tab order in a subfolder could not be verified.");
      }
    }
    for (const old of ownership.keys()) {
      const node = replacementFor(old);
      if (!wrapper.contains(node) || node.getAttribute(workspaceAttribute) !== destination.uuid ||
          node.closing || (copies.has(old) && (Number(node.userContextId || 0) !== plan.containerId ||
          !sameReopenedPage(node, replacements.get(old))))) {
        throw new Error("Zen did not confirm that every item in the folder was transferred.");
      }
    }
    if (!originalsClosed) {
      checkReplacementSources(replacements);
      for (const old of replacements.keys()) {
        if (!plan.sourceElement.contains(old) || old.getAttribute(workspaceAttribute) !== source.uuid) {
          throw new Error("An original tab was moved during conversion.");
        }
      }
    }
    checkSourceRemainder(source.uuid, plan.sourceElement, originalsClosed ? new Set() : replacements);
  }

  async function saveConvertedSession() {
    const { SessionSaver } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs");
    await gBrowser.TabStateFlusher.flushWindow(window);
    await SessionSaver.run();
  }

  async function convertSpace(sourceId, destinationId) {
    if (window[conversionLock]) {
      throw new Error("A conversion is already running in this window.");
    }
    window[conversionLock] = true;
    const copies = new Map();
    const wrapperPlaceholders = new Set();
    const startSpace = gZenWorkspaces.activeWorkspace;
    let plan, wrapper;
    let moved = false;
    let deleting = false;
    try {
      plan = inspectSpaceConversion(sourceId, destinationId);
      if (startSpace !== destinationId) {
        await gZenWorkspaces.changeWorkspaceWithID(destinationId);
      }
      if (gZenWorkspaces.activeWorkspace !== destinationId) {
        throw new Error("Zen could not activate the destination workspace.");
      }
      for (const old of plan.replacements.keys()) {
        const copy = await prepareReplacement(old, destinationId, plan.containerId);
        copies.set(old, copy);
      }
      assertSourceUnchanged(plan);
      if (gZenWorkspaces.activeWorkspace !== destinationId) {
        throw new Error("The active workspace changed during preparation.");
      }
      wrapper = gZenFolders.createFolder([], {
        label: plan.source.name,
        workspaceId: destinationId,
        insertBefore: contentNodes(plan.destinationElement.pinnedTabsContainer)[0],
        collapsed: true,
      });
      moved = true;
      for (const tab of wrapper.tabs) {
        if (tab.hasAttribute("zen-empty-tab")) wrapperPlaceholders.add(tab);
      }
      for (const [old, copy] of copies) {
        if (old.group) {
          moveConversionItem(copy, old.parentNode, old);
          const parking = plan.sourceElement.pinnedTabsContainer;
          moveConversionItem(old, parking, parking.querySelector(".pinned-tabs-container-separator"));
        }
      }
      for (const old of plan.ownership.keys()) {
        (copies.get(old) || old).setAttribute(workspaceAttribute, destinationId);
      }
      for (const root of plan.roots) {
        const item = copies.get(root) || root;
        const tabs = gBrowser.isTab(item) ? [item] : Array.from(item.tabs);
        for (const tab of tabs) {
          if (!tab.pinned) {
            gBrowser.pinTab(tab);
          }
        }
        moveConversionItem(item, wrapper.groupContainer);
      }
      gBrowser.tabContainer._invalidateCachedTabs();
      gZenWorkspaces.updateTabsContainers();
      await Promise.resolve();
      wrapper.collapsed = true;
      checkDestination(plan, wrapper, copies);
      await saveConvertedSession();
      checkDestination(plan, wrapper, copies);
      // removeWorkspace drops the space even if a tab's beforeunload vetoes
      // closing. Let Firefox close the original tabs first and check its result.
      deleting = true;
      if (copies.size) {
        const originals = [...copies.keys()];
        gBrowser.removeTabs(originals, { animate: false, closeWindowWithLastTab: false });
        if (originals.some(tab => tab.isConnected)) {
          throw new Error("An original tab is still open.");
        }
        checkDestination(plan, wrapper, copies, true);
      }
      await gZenWorkspaces.removeWorkspace(sourceId);
      if (gZenWorkspaces.getWorkspaceFromId(sourceId)) {
        throw new Error("Zen did not confirm that the source workspace was removed.");
      }
      await saveConvertedSession();
      return wrapper;
    } catch (error) {
      if (deleting) {
        console.error("[Space to Folder] Finalization", error);
        if (gZenWorkspaces.getWorkspaceFromId(sourceId)) {
          throw new Error("The folder was created. Zen did not confirm that all original tabs were closed, so the source workspace was kept. Check both workspaces.", { cause: error });
        }
        throw new Error("The folder was created. Zen did not confirm the final session save.", { cause: error });
      }
      try {
        if (moved) {
          // Restore pin state before positions. Pin/unpin can itself move a tab.
          for (const [node, { pinned }] of plan.positions) {
            if (gBrowser.isTab(node) && node.isConnected && !pinned && node.pinned) {
              gBrowser.unpinTab(node);
            }
          }
          for (const [node, { parent, next }] of Array.from(plan.positions).reverse()) {
            if (node.isConnected && parent.isConnected) {
              const anchor = next?.parentNode === parent ? next : null;
              if (node.parentNode !== parent || node.nextSibling !== anchor) {
                moveConversionItem(node, parent, anchor);
              }
            }
          }
          for (const [node, id] of plan.ownership) {
            if (id === null) {
              node.removeAttribute(workspaceAttribute);
            } else {
              node.setAttribute(workspaceAttribute, id);
            }
          }
        }
        for (const copy of copies.values()) {
          if (copy.isConnected && !copy.closing) {
            gBrowser.removeTab(copy, { animate: false, skipPermitUnload: true, skipSessionStore: true });
          }
        }
        if (wrapper?.isConnected) {
          // A folder's synthetic tab is deliberately excluded by removeTabs.
          // Never detach the shell if an actual tab or nested folder remains.
          const leftovers = wrapper.querySelectorAll("tab, zen-folder, tab-group");
          if ([...leftovers].every(node => wrapperPlaceholders.has(node) && node.hasAttribute("zen-empty-tab"))) {
            for (const tab of leftovers) {
              gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true, skipSessionStore: true });
            }
            await Promise.resolve();
            if (!wrapper.querySelector("tab, zen-folder, tab-group")) wrapper.remove();
          }
        }
        gBrowser.tabContainer._invalidateCachedTabs();
        if (gZenWorkspaces.activeWorkspace === destinationId && startSpace !== destinationId &&
            gZenWorkspaces.getWorkspaceFromId(startSpace)) {
          await gZenWorkspaces.changeWorkspaceWithID(startSpace);
        }
      } catch (rollbackError) {
        console.error("[Space to Folder] Rollback", rollbackError, error);
        throw new Error("The conversion was stopped. The source workspace was kept. Check the destination folder as well.", { cause: rollbackError });
      }
      throw error;
    } finally {
      delete window[conversionLock];
    }
  }

  const actions = document.getElementById("zenWorkspaceMoreActions");
  if (!actions) return;
  const controller = new AbortController();
  const { signal } = controller;
  const menu = document.createXULElement("menu");
  menu.id = menuId;
  menu.setAttribute("label", "Convert to Folder in…");
  menu.hidden = true;
  const destinations = document.createXULElement("menupopup");
  menu.append(destinations);
  actions.insertBefore(menu, actions.querySelector("#context_zenDeleteWorkspace"));

  let busy = false;
  let lastContext = null;

  function sourceAt(node) {
    const marker = node?.closest?.("[zen-workspace-id], zen-workspace, [data-uuid]");
    return marker?.getAttribute("zen-workspace-id") || marker?.workspaceUuid || marker?.dataset?.uuid;
  }
  document.addEventListener("contextmenu", event => {
    const source = sourceAt(event.composedPath()[0]);
    lastContext = source ? { source, time: Date.now() } : null;
  }, { capture: true, signal });

  actions.addEventListener("popupshowing", event => {
    if (event.target !== actions) return;
    const sourceId = sourceAt(actions.triggerNode) || sourceAt(actions.anchorNode) ||
      sourceAt(event.explicitOriginalTarget) ||
      (lastContext && Date.now() - lastContext.time < 1000 ? lastContext.source : null);
    lastContext = null;
    const spaces = window.gZenWorkspaces?.getWorkspaces() || [];
    destinations.replaceChildren();
    menu.hidden = !spaces.some(space => space.uuid === sourceId);
    menu.disabled = busy || spaces.length < 2;
    if (menu.hidden || menu.disabled) return;
    for (const space of spaces) {
      if (space.uuid === sourceId) continue;
      const item = document.createXULElement("menuitem");
      const emoji = space.icon && !space.icon.endsWith(".svg") ? space.icon + "  " : "";
      item.setAttribute("label", emoji + space.name);
      item.dataset.destinationId = space.uuid;
      item.addEventListener("command", event => {
        event.stopPropagation();
        perform(sourceId, space.uuid);
      }, { once: true });
      destinations.append(item);
    }
  }, { signal });

  async function perform(sourceId, destinationId) {
    if (busy) return;
    busy = true;
    try {
      const info = inspectSpaceConversion(sourceId, destinationId);
      if (info.reopenCount) {
        const approved = Services.prompt.confirm(window, "Change Container",
          info.reopenCount + " tab(s) will be reopened in the container for “" +
          info.destination.name + "”. These pages will use the destination’s cookies. " +
          "These tabs’ browsing history and unsaved form input will be lost. Continue?");
        if (!approved) return;
      }
      await convertSpace(sourceId, destinationId);
    } catch (error) {
      Services.prompt.alert(window, "Workspace Conversion", error?.message || String(error));
    } finally {
      busy = false;
    }
  }

  function cleanup() {
    controller.abort();
    menu.remove();
  }
  window.addEventListener("unload", cleanup, { once: true, signal });
  if (typeof window.addUnloadListener === "function") window.addUnloadListener(cleanup);
})();
