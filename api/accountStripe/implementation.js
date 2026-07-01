// Parent-scope globals available here: ExtensionAPI, ChromeUtils, Services, Cc, Ci.

var { FolderTreeProperties } = ChromeUtils.importESModule(
  "resource:///modules/FolderTreeProperties.sys.mjs",
);

// The thread pane loads as about:3pane; that is what document.documentURI and
// @-moz-document actually see (NOT the underlying chrome:// implementation URL).
const ABOUT_3PANE_URI = "about:3pane";
const isAbout3Pane = (uri) =>
  typeof uri === "string" && uri.startsWith(ABOUT_3PANE_URI);

// The stripe is drawn on a cell, NOT the <tr>: a ::before on a table-row gets
// wrapped in an anonymous table-cell (a phantom leading column) that widens the
// icon columns and desyncs them from the header. A ::before inside a real <td>
// stays out of flow — no extra column.
//
// It must ride the leftmost *visible* cell: hidden columns carry the [hidden]
// attribute (and occupy no space), so the leftmost cell without it is the one
// at the row's left edge. `:nth-child(1 of :not([hidden]))` selects the first
// child matching :not([hidden]) — i.e. the first non-hidden cell — directly.
// (Plain `:not([hidden]):first-child` would NOT work: :first-child is
// structural, so it means "first child AND non-hidden", not "first non-hidden".)
// The stripe follows column hide/show automatically since the selector reacts
// to the [hidden] attribute. All driven by the --acct-stripe custom property
// fillRow sets per row.
const CSS = `
  @-moz-document url-prefix("about:3pane") {
    tr[is="thread-row"] > td:nth-child(1 of :not([hidden])) {
      position: relative;
    }
    tr[is="thread-row"] > td:nth-child(1 of :not([hidden]))::before {
      content: "";
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      width: 3px;
      background: var(--acct-stripe, transparent);
      pointer-events: none;
    }
  }`;

// Marks a patched prototype and stashes the original fillRow for restore.
const PATCHED = Symbol("accountStripePatched");

this.accountStripe = class extends ExtensionAPI {
  // Instance state, shared between getAPI() and onShutdown().
  patchedProtos = new Set();
  observer = null;
  sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(
    Ci.nsIStyleSheetService,
  );
  cssURI = Services.io.newURI(
    `data:text/css;charset=utf-8,${encodeURIComponent(CSS)}`,
  );

  // Monkeypatch one document's thread-row element (idempotent).
  patchThreadRow(win) {
    const ThreadRow = win.customElements?.get("thread-row");
    if (!ThreadRow || ThreadRow.prototype[PATCHED]) {
      return;
    }
    const original = ThreadRow.prototype.fillRow;
    ThreadRow.prototype.fillRow = function () {
      original.call(this);
      try {
        const msgHdr = this.view.getMsgHdrAt(this._index);
        const uri = msgHdr.folder.server.rootFolder.URI;
        const color = FolderTreeProperties.getColor(uri);
        this.style.setProperty("--acct-stripe", color || "transparent");
      } catch {
        // Dummy/grouped rows and global-inbox cases land here.
        this.style.removeProperty("--acct-stripe");
      }
    };
    ThreadRow.prototype[PATCHED] = original;
    this.patchedProtos.add(ThreadRow.prototype);
  }

  // Wait for the element to be defined, patch, then force visible rows to
  // recolor (they were filled before the patch existed).
  patchWhenReady(win) {
    if (!win?.customElements) {
      return;
    }
    win.customElements.whenDefined("thread-row").then(() => {
      this.patchThreadRow(win);
      this.forceRedraw(win);
    });
  }

  // Re-run fillRow for already-visible rows by invalidating the tree.
  forceRedraw(win) {
    try {
      const tree = win.document?.getElementById("threadTree");
      if (tree?.invalidate) {
        tree.invalidate();
      } else if (tree?.view) {
        // Reassigning the view reruns fillRow for all visible rows.
        // biome-ignore lint/correctness/noSelfAssign: the setter re-renders every visible row.
        tree.view = tree.view;
      }
    } catch {
      // Non-fatal: stripes will appear on next scroll/selection.
    }
  }

  // Patch every about3Pane browser reachable from an already-open window.
  patchExistingWindows() {
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      this.patchAbout3PaneBrowsers(win);
    }
    // Standalone message windows can embed a 3-pane too.
    for (const win of Services.wm.getEnumerator("mail:messageWindow")) {
      this.patchAbout3PaneBrowsers(win);
    }
  }

  patchAbout3PaneBrowsers(win) {
    const tabmail = win.document?.getElementById("tabmail");
    if (!tabmail?.tabInfo) {
      // A window with a single about3Pane and no tabmail.
      this.collectAndPatch(win.document);
      return;
    }
    for (const tab of tabmail.tabInfo) {
      // Folder tabs expose chromeBrowser; message tabs may embed one too.
      const browser =
        tab.chromeBrowser ||
        tab.browser ||
        tab.panel?.querySelector?.("browser");
      this.collectFromBrowser(browser);
    }
  }

  collectFromBrowser(browser) {
    const cw = browser?.contentWindow;
    if (isAbout3Pane(cw?.document?.documentURI)) {
      this.patchWhenReady(cw);
    }
    this.collectAndPatch(browser?.contentDocument);
  }

  // Find nested about3Pane browsers within a document and patch them.
  collectAndPatch(doc) {
    if (!doc) {
      return;
    }
    for (const b of doc.querySelectorAll?.("browser") ?? []) {
      const cw = b.contentWindow;
      if (isAbout3Pane(cw?.document?.documentURI)) {
        this.patchWhenReady(cw);
      }
    }
  }

  getAPI(_context) {
    return {
      accountStripe: {
        init: async () => {
          // 1. Register the stylesheet once.
          if (!this.sss.sheetRegistered(this.cssURI, this.sss.USER_SHEET)) {
            this.sss.loadAndRegisterSheet(this.cssURI, this.sss.USER_SHEET);
          }

          // 2. Patch future about3Pane documents as they are created.
          this.observer = {
            observe: (subject) => {
              const win = subject; // window global
              if (!isAbout3Pane(win?.document?.documentURI)) {
                return;
              }
              this.patchWhenReady(win);
            },
          };
          Services.obs.addObserver(
            this.observer,
            "chrome-document-global-created",
          );

          // 3. Patch everything already open.
          this.patchExistingWindows();
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }

    // Restore every patched fillRow. Prototype state is process-global and
    // won't reset on add-on update, so this matters.
    for (const proto of this.patchedProtos) {
      proto.fillRow = proto[PATCHED];
      delete proto[PATCHED];
    }
    this.patchedProtos.clear();

    if (this.observer) {
      Services.obs.removeObserver(
        this.observer,
        "chrome-document-global-created",
      );
      this.observer = null;
    }

    if (this.sss.sheetRegistered(this.cssURI, this.sss.USER_SHEET)) {
      this.sss.unregisterSheet(this.cssURI, this.sss.USER_SHEET);
    }

    // Clear any stripe variables left on visible rows.
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      this.forceRedraw(win);
    }
  }
};
