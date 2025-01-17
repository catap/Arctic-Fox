/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cc, Ci, Cu} = require("chrome");
const Services = require("Services");
const promise = require("promise");
const {gDevTools} = require("./devtools");

// Load target and toolbox lazily as they need gDevTools to be fully initialized
loader.lazyRequireGetter(this, "TargetFactory", "devtools/client/framework/target", true);
loader.lazyRequireGetter(this, "Toolbox", "devtools/client/framework/toolbox", true);
loader.lazyRequireGetter(this, "DebuggerServer", "devtools/server/main", true);
loader.lazyRequireGetter(this, "DebuggerClient", "devtools/shared/client/main", true);

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "CustomizableUI",
                                  "resource:///modules/CustomizableUI.jsm");

const bundle = Services.strings.createBundle("chrome://devtools/locale/toolbox.properties");

/**
 * gDevToolsBrowser exposes functions to connect the gDevTools instance with a
 * Firefox instance.
 */
var gDevToolsBrowser = exports.gDevToolsBrowser = {
  /**
   * A record of the windows whose menus we altered, so we can undo the changes
   * as the window is closed
   */
  _trackedBrowserWindows: new Set(),

  _tabStats: {
    peakOpen: 0,
    peakPinned: 0,
    histOpen: [],
    histPinned: []
  },

  /**
   * This function is for the benefit of Tools:DevToolbox in
   * browser/base/content/browser-sets.inc and should not be used outside
   * of there
   */
  // used by browser-sets.inc, command
  toggleToolboxCommand: function(gBrowser) {
    let target = TargetFactory.forTab(gBrowser.selectedTab);
    let toolbox = gDevTools.getToolbox(target);

    // If a toolbox exists, using toggle from the Main window :
    // - should close a docked toolbox
    // - should focus a windowed toolbox
    let isDocked = toolbox && toolbox.hostType != Toolbox.HostType.WINDOW;
    isDocked ? toolbox.destroy() : gDevTools.showToolbox(target);
  },

  /**
   * This function ensures the right commands are enabled in a window,
   * depending on their relevant prefs. It gets run when a window is registered,
   * or when any of the devtools prefs change.
   */
  updateCommandAvailability: function(win) {
    let doc = win.document;

    function toggleCmd(id, isEnabled) {
      let cmd = doc.getElementById(id);
      if (isEnabled) {
        cmd.removeAttribute("disabled");
        cmd.removeAttribute("hidden");
      } else if (cmd != null) {
        cmd.setAttribute("disabled", "true");
        cmd.setAttribute("hidden", "true");
      }
    };

    // Enable developer toolbar?
    let devToolbarEnabled = Services.prefs.getBoolPref("devtools.toolbar.enabled");
    toggleCmd("Tools:DevToolbar", devToolbarEnabled);
    let focusEl = doc.getElementById("Tools:DevToolbarFocus");
    if (devToolbarEnabled) {
      focusEl.removeAttribute("disabled");
    } else {
      focusEl.setAttribute("disabled", "true");
    }
    if (devToolbarEnabled && Services.prefs.getBoolPref("devtools.toolbar.visible")) {
      win.DeveloperToolbar.show(false).catch(console.error);
    }

    // Enable WebIDE?
    let webIDEEnabled = Services.prefs.getBoolPref("devtools.webide.enabled");
    toggleCmd("Tools:WebIDE", webIDEEnabled);

    let showWebIDEWidget = Services.prefs.getBoolPref("devtools.webide.widget.enabled");
    if (webIDEEnabled && showWebIDEWidget) {
      gDevToolsBrowser.installWebIDEWidget();
    } else {
      gDevToolsBrowser.uninstallWebIDEWidget();
    }

    // Enable Browser Toolbox?
    let chromeEnabled = Services.prefs.getBoolPref("devtools.chrome.enabled");
    let devtoolsRemoteEnabled = Services.prefs.getBoolPref("devtools.debugger.remote-enabled");
    let remoteEnabled = chromeEnabled && devtoolsRemoteEnabled;
    toggleCmd("Tools:BrowserToolbox", remoteEnabled);
    toggleCmd("Tools:BrowserContentToolbox", remoteEnabled && win.gMultiProcessBrowser);

    // Enable Error Console?
    let consoleEnabled = Services.prefs.getBoolPref("devtools.errorconsole.enabled");
    toggleCmd("Tools:ErrorConsole", consoleEnabled);

    // Enable DevTools connection screen, if the preference allows this.
    toggleCmd("Tools:DevToolsConnect", devtoolsRemoteEnabled);
  },

  observe: function(subject, topic, prefName) {
    if (prefName.endsWith("enabled")) {
      for (let win of this._trackedBrowserWindows) {
        this.updateCommandAvailability(win);
      }
    }
  },

  _prefObserverRegistered: false,

  ensurePrefObserver: function() {
    if (!this._prefObserverRegistered) {
      this._prefObserverRegistered = true;
      Services.prefs.addObserver("devtools.", this, false);
    }
  },


  /**
   * This function is for the benefit of Tools:{toolId} commands,
   * triggered from the WebDeveloper menu and keyboard shortcuts.
   *
   * selectToolCommand's behavior:
   * - if the toolbox is closed,
   *   we open the toolbox and select the tool
   * - if the toolbox is open, and the targeted tool is not selected,
   *   we select it
   * - if the toolbox is open, and the targeted tool is selected,
   *   and the host is NOT a window, we close the toolbox
   * - if the toolbox is open, and the targeted tool is selected,
   *   and the host is a window, we raise the toolbox window
   */
  // Used when: - registering a new tool
  //            - new xul window, to add menu items
  selectToolCommand: function(gBrowser, toolId) {
    let target = TargetFactory.forTab(gBrowser.selectedTab);
    let toolbox = gDevTools.getToolbox(target);
    let toolDefinition = gDevTools.getToolDefinition(toolId);

    if (toolbox &&
        (toolbox.currentToolId == toolId ||
          (toolId == "webconsole" && toolbox.splitConsole)))
    {
      toolbox.fireCustomKey(toolId);

      if (toolDefinition.preventClosingOnKey || toolbox.hostType == Toolbox.HostType.WINDOW) {
        toolbox.raise();
      } else {
        toolbox.destroy();
      }
      gDevTools.emit("select-tool-command", toolId);
    } else {
      gDevTools.showToolbox(target, toolId).then(() => {
        let target = TargetFactory.forTab(gBrowser.selectedTab);
        let toolbox = gDevTools.getToolbox(target);

        toolbox.fireCustomKey(toolId);
        gDevTools.emit("select-tool-command", toolId);
      });
    }
  },

  /**
   * Open a tab to allow connects to a remote browser
   */
   // Used by browser-sets.inc, command
  openConnectScreen: function(gBrowser) {
    gBrowser.selectedTab = gBrowser.addTab("chrome://devtools/content/framework/connect/connect.xhtml");
  },

  /**
   * Open WebIDE
   */
   // Used by browser-sets.inc, command
   //         itself, webide widget
  openWebIDE: function() {
    let win = Services.wm.getMostRecentWindow("devtools:webide");
    if (win) {
      win.focus();
    } else {
      Services.ww.openWindow(null, "chrome://webide/content/", "webide", "chrome,centerscreen,resizable", null);
    }
  },

  _getContentProcessTarget: function () {
    // Create a DebuggerServer in order to connect locally to it
    if (!DebuggerServer.initialized) {
      DebuggerServer.init();
      DebuggerServer.addBrowserActors();
    }
    DebuggerServer.allowChromeProcess = true;

    let transport = DebuggerServer.connectPipe();
    let client = new DebuggerClient(transport);

    let deferred = promise.defer();
    client.connect().then(() => {
      client.mainRoot.listProcesses(response => {
        // Do nothing if there is only one process, the parent process.
        let contentProcesses = response.processes.filter(p => (!p.parent));
        if (contentProcesses.length < 1) {
          let msg = bundle.GetStringFromName("toolbox.noContentProcess.message");
          Services.prompt.alert(null, "", msg);
          deferred.reject("No content processes available.");
          return;
        }
        // Otherwise, arbitrary connect to the unique content process.
        client.getProcess(contentProcesses[0].id)
              .then(response => {
                let options = {
                  form: response.form,
                  client: client,
                  chrome: true,
                  isTabActor: false
                };
                return TargetFactory.forRemoteTab(options);
              })
              .then(target => {
                // Ensure closing the connection in order to cleanup
                // the debugger client and also the server created in the
                // content process
                target.on("close", () => {
                  client.close();
                });
                deferred.resolve(target);
              });
      });
    });

    return deferred.promise;
  },

   // Used by browser-sets.inc, command
  openContentProcessToolbox: function () {
    this._getContentProcessTarget()
        .then(target => {
          // Display a new toolbox, in a new window, with debugger by default
          return gDevTools.showToolbox(target, "jsdebugger",
                                       Toolbox.HostType.WINDOW);
        });
  },

  /**
   * Install WebIDE widget
   */
  // Used by itself
  installWebIDEWidget: function() {
    // No CustomizableUI -> short circuit
    return;

    if (this.isWebIDEWidgetInstalled()) {
      return;
    }

    let defaultArea;
    if (Services.prefs.getBoolPref("devtools.webide.widget.inNavbarByDefault")) {
      defaultArea = CustomizableUI.AREA_NAVBAR;
    } else {
      defaultArea = CustomizableUI.AREA_PANEL;
    }

    CustomizableUI.createWidget({
      id: "webide-button",
      shortcutId: "key_webide",
      label: "devtools-webide-button2.label",
      tooltiptext: "devtools-webide-button2.tooltiptext",
      defaultArea: defaultArea,
      onCommand: function(aEvent) {
        gDevToolsBrowser.openWebIDE();
      }
    });
  },

  isWebIDEWidgetInstalled: function() {
    // No CustomizableUI -> short circuit
    return;

    let widgetWrapper = CustomizableUI.getWidget("webide-button");
    return !!(widgetWrapper && widgetWrapper.provider == CustomizableUI.PROVIDER_API);
  },

  /**
   * The deferred promise will be resolved by WebIDE's UI.init()
   */
  isWebIDEInitialized: promise.defer(),

  /**
   * Uninstall WebIDE widget
   */
  uninstallWebIDEWidget: function() {
    // No CustomizableUI -> short circuit
    return;

    if (this.isWebIDEWidgetInstalled()) {
      CustomizableUI.removeWidgetFromArea("webide-button");
    }
    CustomizableUI.destroyWidget("webide-button");
  },

  /**
   * Move WebIDE widget to the navbar
   */
   // Used by webide.js
  moveWebIDEWidgetInNavbar: function() {
    // No CustomizableUI -> short circuit
    return;

    CustomizableUI.addWidgetToArea("webide-button", CustomizableUI.AREA_NAVBAR);
  },

  /**
   * Add this DevTools's presence to a browser window's document
   *
   * @param {XULDocument} doc
   *        The document to which menuitems and handlers are to be added
   */
  // Used by browser.js
  registerBrowserWindow: function DT_registerBrowserWindow(win) {
    this.updateCommandAvailability(win);
    this.ensurePrefObserver();
    gDevToolsBrowser._trackedBrowserWindows.add(win);
    gDevToolsBrowser._addAllToolsToMenu(win.document);

    if (this._isFirebugInstalled()) {
      let broadcaster = win.document.getElementById("devtoolsMenuBroadcaster_DevToolbox");
      broadcaster.removeAttribute("key");
    }

    let tabContainer = win.gBrowser.tabContainer;
    tabContainer.addEventListener("TabSelect", this, false);
    tabContainer.addEventListener("TabOpen", this, false);
    tabContainer.addEventListener("TabClose", this, false);
    tabContainer.addEventListener("TabPinned", this, false);
    tabContainer.addEventListener("TabUnpinned", this, false);
  },

  /**
   * Add a <key> to <keyset id="devtoolsKeyset">.
   * Appending a <key> element is not always enough. The <keyset> needs
   * to be detached and reattached to make sure the <key> is taken into
   * account (see bug 832984).
   *
   * @param {XULDocument} doc
   *        The document to which keys are to be added
   * @param {XULElement} or {DocumentFragment} keys
   *        Keys to add
   */
  attachKeybindingsToBrowser: function DT_attachKeybindingsToBrowser(doc, keys) {
    let devtoolsKeyset = doc.getElementById("devtoolsKeyset");

    if (!devtoolsKeyset) {
      devtoolsKeyset = doc.createElement("keyset");
      devtoolsKeyset.setAttribute("id", "devtoolsKeyset");
    }
    devtoolsKeyset.appendChild(keys);
    let mainKeyset = doc.getElementById("mainKeyset");
    mainKeyset.parentNode.insertBefore(devtoolsKeyset, mainKeyset);
  },

  /**
   * Hook the JS debugger tool to the "Debug Script" button of the slow script
   * dialog.
   */
  setSlowScriptDebugHandler: function DT_setSlowScriptDebugHandler() {
    let debugService = Cc["@mozilla.org/dom/slow-script-debug;1"]
                         .getService(Ci.nsISlowScriptDebug);
    let tm = Cc["@mozilla.org/thread-manager;1"].getService(Ci.nsIThreadManager);

    function slowScriptDebugHandler(aTab, aCallback) {
      let target = TargetFactory.forTab(aTab);

      gDevTools.showToolbox(target, "jsdebugger").then(toolbox => {
        let threadClient = toolbox.getCurrentPanel().panelWin.gThreadClient;

        // Break in place, which means resuming the debuggee thread and pausing
        // right before the next step happens.
        switch (threadClient.state) {
          case "paused":
            // When the debugger is already paused.
            threadClient.resumeThenPause();
            aCallback();
            break;
          case "attached":
            // When the debugger is already open.
            threadClient.interrupt(() => {
              threadClient.resumeThenPause();
              aCallback();
            });
            break;
          case "resuming":
            // The debugger is newly opened.
            threadClient.addOneTimeListener("resumed", () => {
              threadClient.interrupt(() => {
                threadClient.resumeThenPause();
                aCallback();
              });
            });
            break;
          default:
            throw Error("invalid thread client state in slow script debug handler: " +
                        threadClient.state);
          }
      });
    }

    debugService.activationHandler = function(aWindow) {
      let chromeWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIWebNavigation)
                                .QueryInterface(Ci.nsIDocShellTreeItem)
                                .rootTreeItem
                                .QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIDOMWindow)
                                .QueryInterface(Ci.nsIDOMChromeWindow);

      let setupFinished = false;
      slowScriptDebugHandler(chromeWindow.gBrowser.selectedTab,
                             () => { setupFinished = true; });

      // Don't return from the interrupt handler until the debugger is brought
      // up; no reason to continue executing the slow script.
      let utils = aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                         .getInterface(Ci.nsIDOMWindowUtils);
      utils.enterModalState();
      while (!setupFinished) {
        tm.currentThread.processNextEvent(true);
      }
      utils.leaveModalState();
    };

    debugService.remoteActivationHandler = function(aBrowser, aCallback) {
      let chromeWindow = aBrowser.ownerDocument.defaultView;
      let tab = chromeWindow.gBrowser.getTabForBrowser(aBrowser);
      chromeWindow.gBrowser.selected = tab;

      function callback() {
        aCallback.finishDebuggerStartup();
      }

      slowScriptDebugHandler(tab, callback);
    };
  },

  /**
   * Unset the slow script debug handler.
   */
  unsetSlowScriptDebugHandler: function DT_unsetSlowScriptDebugHandler() {
    let debugService = Cc["@mozilla.org/dom/slow-script-debug;1"]
                         .getService(Ci.nsISlowScriptDebug);
    debugService.activationHandler = undefined;
  },

  /**
   * Detect the presence of a Firebug.
   *
   * @return promise
   */
  _isFirebugInstalled: function DT_isFirebugInstalled() {
    let bootstrappedAddons = Services.prefs.getCharPref("extensions.bootstrappedAddons");
    return bootstrappedAddons.indexOf("firebug@software.joehewitt.com") != -1;
  },

  /**
   * Add the menuitem for a tool to all open browser windows.
   *
   * @param {object} toolDefinition
   *        properties of the tool to add
   */
  _addToolToWindows: function DT_addToolToWindows(toolDefinition) {
    // No menu item or global shortcut is required for options panel.
    if (!toolDefinition.inMenu) {
      return;
    }

    // Skip if the tool is disabled.
    try {
      if (toolDefinition.visibilityswitch &&
         !Services.prefs.getBoolPref(toolDefinition.visibilityswitch)) {
        return;
      }
    } catch(e) {}

    // We need to insert the new tool in the right place, which means knowing
    // the tool that comes before the tool that we're trying to add
    let allDefs = gDevTools.getToolDefinitionArray();
    let prevDef;
    for (let def of allDefs) {
      if (!def.inMenu) {
        continue;
      }
      if (def === toolDefinition) {
        break;
      }
      prevDef = def;
    }

    for (let win of gDevToolsBrowser._trackedBrowserWindows) {
      let doc = win.document;
      let elements = gDevToolsBrowser._createToolMenuElements(toolDefinition, doc);

      doc.getElementById("mainCommandSet").appendChild(elements.cmd);

      if (elements.key) {
        this.attachKeybindingsToBrowser(doc, elements.key);
      }

      doc.getElementById("mainBroadcasterSet").appendChild(elements.bc);

      let amp = doc.getElementById("appmenu_webDeveloper_popup");
      if (amp) {
        let ref;

        if (prevDef != null) {
          let menuitem = doc.getElementById("appmenuitem_" + prevDef.id);
          ref = menuitem && menuitem.nextSibling ? menuitem.nextSibling : null;
        } else {
          ref = doc.getElementById("appmenu_devtools_separator");
        }

        if (ref) {
          amp.insertBefore(elements.appmenuitem, ref);
        }
      }

      let ref;

      if (prevDef) {
        let menuitem = doc.getElementById("menuitem_" + prevDef.id);
        ref = menuitem && menuitem.nextSibling ? menuitem.nextSibling : null;
      } else {
        ref = doc.getElementById("menu_devtools_separator");
      }

      if (ref) {
        ref.parentNode.insertBefore(elements.menuitem, ref);
      }
    }

    if (toolDefinition.id === "jsdebugger") {
      gDevToolsBrowser.setSlowScriptDebugHandler();
    }
  },

  /**
   * Add all tools to the developer tools menu of a window.
   *
   * @param {XULDocument} doc
   *        The document to which the tool items are to be added.
   */
  _addAllToolsToMenu: function DT_addAllToolsToMenu(doc) {
    let fragCommands = doc.createDocumentFragment();
    let fragKeys = doc.createDocumentFragment();
    let fragBroadcasters = doc.createDocumentFragment();
    let fragAppMenuItems = doc.createDocumentFragment();
    let fragMenuItems = doc.createDocumentFragment();

    for (let toolDefinition of gDevTools.getToolDefinitionArray()) {
      if (!toolDefinition.inMenu) {
        continue;
      }

      let elements = gDevToolsBrowser._createToolMenuElements(toolDefinition, doc);

      if (!elements) {
        return;
      }

      fragCommands.appendChild(elements.cmd);
      if (elements.key) {
        fragKeys.appendChild(elements.key);
      }
      fragBroadcasters.appendChild(elements.bc);
      fragAppMenuItems.appendChild(elements.appmenuitem);
      fragMenuItems.appendChild(elements.menuitem);
    }

    let mcs = doc.getElementById("mainCommandSet");
    mcs.appendChild(fragCommands);

    this.attachKeybindingsToBrowser(doc, fragKeys);

    let mbs = doc.getElementById("mainBroadcasterSet");
    mbs.appendChild(fragBroadcasters);

    let amps = doc.getElementById("appmenu_devtools_separator");
    if (amps) {
      amps.parentNode.insertBefore(fragAppMenuItems, amps);
    }

    let mps = doc.getElementById("menu_devtools_separator");
    if (mps) {
      mps.parentNode.insertBefore(fragMenuItems, mps);
    }
  },

  /**
   * Add a menu entry for a tool definition
   *
   * @param {string} toolDefinition
   *        Tool definition of the tool to add a menu entry.
   * @param {XULDocument} doc
   *        The document to which the tool menu item is to be added.
   */
  _createToolMenuElements: function DT_createToolMenuElements(toolDefinition, doc) {
    let id = toolDefinition.id;

    // Prevent multiple entries for the same tool.
    if (doc.getElementById("Tools:" + id)) {
      return;
    }

    let cmd = doc.createElement("command");
    cmd.id = "Tools:" + id;
    cmd.setAttribute("oncommand",
        'gDevToolsBrowser.selectToolCommand(gBrowser, "' + id + '");');

    let key = null;
    if (toolDefinition.key) {
      key = doc.createElement("key");
      key.id = "key_" + id;

      if (toolDefinition.key.startsWith("VK_")) {
        key.setAttribute("keycode", toolDefinition.key);
      } else {
        key.setAttribute("key", toolDefinition.key);
      }

      key.setAttribute("command", cmd.id);
      key.setAttribute("modifiers", toolDefinition.modifiers);
    }

    let bc = doc.createElement("broadcaster");
    bc.id = "devtoolsMenuBroadcaster_" + id;
    bc.setAttribute("label", toolDefinition.menuLabel || toolDefinition.label);
    bc.setAttribute("command", cmd.id);

    if (key) {
      bc.setAttribute("key", "key_" + id);
    }

    let appmenuitem = doc.createElement("menuitem");
    appmenuitem.id = "appmenuitem_" + id;
    appmenuitem.setAttribute("observes", "devtoolsMenuBroadcaster_" + id);

    let menuitem = doc.createElement("menuitem");
    menuitem.id = "menuitem_" + id;
    menuitem.setAttribute("observes", "devtoolsMenuBroadcaster_" + id);

    if (toolDefinition.accesskey) {
      menuitem.setAttribute("accesskey", toolDefinition.accesskey);
    }

    return {
      cmd: cmd,
      key: key,
      bc: bc,
      appmenuitem: appmenuitem,
      menuitem: menuitem
    };
  },

  hasToolboxOpened: function(win) {
    let tab = win.gBrowser.selectedTab;
    for (let [target, toolbox] of gDevTools._toolboxes) {
      if (target.tab == tab) {
        return true;
      }
    }
    return false;
  },

  /**
   * Update the "Toggle Tools" checkbox in the developer tools menu. This is
   * called when a toolbox is created or destroyed.
   */
  _updateMenuCheckbox: function DT_updateMenuCheckbox() {
    for (let win of gDevToolsBrowser._trackedBrowserWindows) {

      let hasToolbox = gDevToolsBrowser.hasToolboxOpened(win);

      let broadcaster = win.document.getElementById("devtoolsMenuBroadcaster_DevToolbox");
      if (hasToolbox) {
        broadcaster.setAttribute("checked", "true");
      } else {
        broadcaster.removeAttribute("checked");
      }
    }
  },

  /**
   * Remove the menuitem for a tool to all open browser windows.
   *
   * @param {string} toolId
   *        id of the tool to remove
   */
  _removeToolFromWindows: function DT_removeToolFromWindows(toolId) {
    for (let win of gDevToolsBrowser._trackedBrowserWindows) {
      gDevToolsBrowser._removeToolFromMenu(toolId, win.document);
    }

    if (toolId === "jsdebugger") {
      gDevToolsBrowser.unsetSlowScriptDebugHandler();
    }
  },

  /**
   * Remove a tool's menuitem from a window
   *
   * @param {string} toolId
   *        Id of the tool to add a menu entry for
   * @param {XULDocument} doc
   *        The document to which the tool menu item is to be removed from
   */
  _removeToolFromMenu: function DT_removeToolFromMenu(toolId, doc) {
    let command = doc.getElementById("Tools:" + toolId);
    if (command) {
      command.parentNode.removeChild(command);
    }

    let key = doc.getElementById("key_" + toolId);
    if (key) {
      key.parentNode.removeChild(key);
    }

    let bc = doc.getElementById("devtoolsMenuBroadcaster_" + toolId);
    if (bc) {
      bc.parentNode.removeChild(bc);
    }

    let appmenuitem = doc.getElementById("appmenuitem_" + toolId);
    if (appmenuitem) {
      appmenuitem.parentNode.removeChild(appmenuitem);
    }

    let menuitem = doc.getElementById("menuitem_" + toolId);
    if (menuitem) {
      menuitem.parentNode.removeChild(menuitem);
    }
  },

  /**
   * Called on browser unload to remove menu entries, toolboxes and event
   * listeners from the closed browser window.
   *
   * @param  {XULWindow} win
   *         The window containing the menu entry
   */
  forgetBrowserWindow: function DT_forgetBrowserWindow(win) {
    gDevToolsBrowser._trackedBrowserWindows.delete(win);

    // Destroy toolboxes for closed window
    for (let [target, toolbox] of gDevTools._toolboxes) {
      if (toolbox.frame && toolbox.frame.ownerDocument.defaultView == win) {
        toolbox.destroy();
      }
    }

    let tabContainer = win.gBrowser.tabContainer;
    tabContainer.removeEventListener("TabSelect", this, false);
    tabContainer.removeEventListener("TabOpen", this, false);
    tabContainer.removeEventListener("TabClose", this, false);
    tabContainer.removeEventListener("TabPinned", this, false);
    tabContainer.removeEventListener("TabUnpinned", this, false);
  },

  handleEvent: function(event) {
    switch (event.type) {
      case "TabOpen":
      case "TabClose":
      case "TabPinned":
      case "TabUnpinned":
        let open = 0;
        let pinned = 0;

        for (let win of this._trackedBrowserWindows) {
          let tabContainer = win.gBrowser.tabContainer;
          let numPinnedTabs = win.gBrowser._numPinnedTabs || 0;
          let numTabs = tabContainer.itemCount - numPinnedTabs;

          open += numTabs;
          pinned += numPinnedTabs;
        }

        this._tabStats.histOpen.push(open);
        this._tabStats.histPinned.push(pinned);
        this._tabStats.peakOpen = Math.max(open, this._tabStats.peakOpen);
        this._tabStats.peakPinned = Math.max(pinned, this._tabStats.peakPinned);
      break;
      case "TabSelect":
        gDevToolsBrowser._updateMenuCheckbox();
    }
  },

  /**
   * All browser windows have been closed, tidy up remaining objects.
   */
  destroy: function() {
    Services.prefs.removeObserver("devtools.", gDevToolsBrowser);
    Services.obs.removeObserver(gDevToolsBrowser.destroy, "quit-application");
  },
}

gDevTools.on("tool-registered", function(ev, toolId) {
  let toolDefinition = gDevTools._tools.get(toolId);
  gDevToolsBrowser._addToolToWindows(toolDefinition);
});

gDevTools.on("tool-unregistered", function(ev, toolId) {
  if (typeof toolId != "string") {
    toolId = toolId.id;
  }
  gDevToolsBrowser._removeToolFromWindows(toolId);
});

gDevTools.on("toolbox-ready", gDevToolsBrowser._updateMenuCheckbox);
gDevTools.on("toolbox-destroyed", gDevToolsBrowser._updateMenuCheckbox);

Services.obs.addObserver(gDevToolsBrowser.destroy, "quit-application", false);

// Load the browser devtools main module as the loader's main module.
// This is done precisely here as main.js ends up dispatching the
// tool-registered events we are listening in this module.
loader.main("devtools/client/main");

