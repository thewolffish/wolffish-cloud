var browserPolyfill$1 = { exports: {} }, browserPolyfill = browserPolyfill$1.exports, hasRequiredBrowserPolyfill;
function requireBrowserPolyfill() {
  return hasRequiredBrowserPolyfill || (hasRequiredBrowserPolyfill = 1, (function(e, t) {
    (function(s, a) {
      a(e);
    })(typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : browserPolyfill, function(s) {
      if (!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id))
        throw new Error("This script should only be loaded in a browser extension.");
      if (globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id)
        s.exports = globalThis.browser;
      else {
        const a = "The message port closed before a response was received.", o = (n) => {
          const r = {
            alarms: {
              clear: {
                minArgs: 0,
                maxArgs: 1
              },
              clearAll: {
                minArgs: 0,
                maxArgs: 0
              },
              get: {
                minArgs: 0,
                maxArgs: 1
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            bookmarks: {
              create: {
                minArgs: 1,
                maxArgs: 1
              },
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getChildren: {
                minArgs: 1,
                maxArgs: 1
              },
              getRecent: {
                minArgs: 1,
                maxArgs: 1
              },
              getSubTree: {
                minArgs: 1,
                maxArgs: 1
              },
              getTree: {
                minArgs: 0,
                maxArgs: 0
              },
              move: {
                minArgs: 2,
                maxArgs: 2
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              removeTree: {
                minArgs: 1,
                maxArgs: 1
              },
              search: {
                minArgs: 1,
                maxArgs: 1
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            },
            browserAction: {
              disable: {
                minArgs: 0,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              enable: {
                minArgs: 0,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              getBadgeBackgroundColor: {
                minArgs: 1,
                maxArgs: 1
              },
              getBadgeText: {
                minArgs: 1,
                maxArgs: 1
              },
              getPopup: {
                minArgs: 1,
                maxArgs: 1
              },
              getTitle: {
                minArgs: 1,
                maxArgs: 1
              },
              openPopup: {
                minArgs: 0,
                maxArgs: 0
              },
              setBadgeBackgroundColor: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setBadgeText: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setIcon: {
                minArgs: 1,
                maxArgs: 1
              },
              setPopup: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setTitle: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              }
            },
            browsingData: {
              remove: {
                minArgs: 2,
                maxArgs: 2
              },
              removeCache: {
                minArgs: 1,
                maxArgs: 1
              },
              removeCookies: {
                minArgs: 1,
                maxArgs: 1
              },
              removeDownloads: {
                minArgs: 1,
                maxArgs: 1
              },
              removeFormData: {
                minArgs: 1,
                maxArgs: 1
              },
              removeHistory: {
                minArgs: 1,
                maxArgs: 1
              },
              removeLocalStorage: {
                minArgs: 1,
                maxArgs: 1
              },
              removePasswords: {
                minArgs: 1,
                maxArgs: 1
              },
              removePluginData: {
                minArgs: 1,
                maxArgs: 1
              },
              settings: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            commands: {
              getAll: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            contextMenus: {
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              removeAll: {
                minArgs: 0,
                maxArgs: 0
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            },
            cookies: {
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getAll: {
                minArgs: 1,
                maxArgs: 1
              },
              getAllCookieStores: {
                minArgs: 0,
                maxArgs: 0
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              set: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            devtools: {
              inspectedWindow: {
                eval: {
                  minArgs: 1,
                  maxArgs: 2,
                  singleCallbackArg: !1
                }
              },
              panels: {
                create: {
                  minArgs: 3,
                  maxArgs: 3,
                  singleCallbackArg: !0
                },
                elements: {
                  createSidebarPane: {
                    minArgs: 1,
                    maxArgs: 1
                  }
                }
              }
            },
            downloads: {
              cancel: {
                minArgs: 1,
                maxArgs: 1
              },
              download: {
                minArgs: 1,
                maxArgs: 1
              },
              erase: {
                minArgs: 1,
                maxArgs: 1
              },
              getFileIcon: {
                minArgs: 1,
                maxArgs: 2
              },
              open: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              pause: {
                minArgs: 1,
                maxArgs: 1
              },
              removeFile: {
                minArgs: 1,
                maxArgs: 1
              },
              resume: {
                minArgs: 1,
                maxArgs: 1
              },
              search: {
                minArgs: 1,
                maxArgs: 1
              },
              show: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              }
            },
            extension: {
              isAllowedFileSchemeAccess: {
                minArgs: 0,
                maxArgs: 0
              },
              isAllowedIncognitoAccess: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            history: {
              addUrl: {
                minArgs: 1,
                maxArgs: 1
              },
              deleteAll: {
                minArgs: 0,
                maxArgs: 0
              },
              deleteRange: {
                minArgs: 1,
                maxArgs: 1
              },
              deleteUrl: {
                minArgs: 1,
                maxArgs: 1
              },
              getVisits: {
                minArgs: 1,
                maxArgs: 1
              },
              search: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            i18n: {
              detectLanguage: {
                minArgs: 1,
                maxArgs: 1
              },
              getAcceptLanguages: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            identity: {
              launchWebAuthFlow: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            idle: {
              queryState: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            management: {
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              },
              getSelf: {
                minArgs: 0,
                maxArgs: 0
              },
              setEnabled: {
                minArgs: 2,
                maxArgs: 2
              },
              uninstallSelf: {
                minArgs: 0,
                maxArgs: 1
              }
            },
            notifications: {
              clear: {
                minArgs: 1,
                maxArgs: 1
              },
              create: {
                minArgs: 1,
                maxArgs: 2
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              },
              getPermissionLevel: {
                minArgs: 0,
                maxArgs: 0
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            },
            pageAction: {
              getPopup: {
                minArgs: 1,
                maxArgs: 1
              },
              getTitle: {
                minArgs: 1,
                maxArgs: 1
              },
              hide: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setIcon: {
                minArgs: 1,
                maxArgs: 1
              },
              setPopup: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              setTitle: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              },
              show: {
                minArgs: 1,
                maxArgs: 1,
                fallbackToNoCallback: !0
              }
            },
            permissions: {
              contains: {
                minArgs: 1,
                maxArgs: 1
              },
              getAll: {
                minArgs: 0,
                maxArgs: 0
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              request: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            runtime: {
              getBackgroundPage: {
                minArgs: 0,
                maxArgs: 0
              },
              getPlatformInfo: {
                minArgs: 0,
                maxArgs: 0
              },
              openOptionsPage: {
                minArgs: 0,
                maxArgs: 0
              },
              requestUpdateCheck: {
                minArgs: 0,
                maxArgs: 0
              },
              sendMessage: {
                minArgs: 1,
                maxArgs: 3
              },
              sendNativeMessage: {
                minArgs: 2,
                maxArgs: 2
              },
              setUninstallURL: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            sessions: {
              getDevices: {
                minArgs: 0,
                maxArgs: 1
              },
              getRecentlyClosed: {
                minArgs: 0,
                maxArgs: 1
              },
              restore: {
                minArgs: 0,
                maxArgs: 1
              }
            },
            storage: {
              local: {
                clear: {
                  minArgs: 0,
                  maxArgs: 0
                },
                get: {
                  minArgs: 0,
                  maxArgs: 1
                },
                getBytesInUse: {
                  minArgs: 0,
                  maxArgs: 1
                },
                remove: {
                  minArgs: 1,
                  maxArgs: 1
                },
                set: {
                  minArgs: 1,
                  maxArgs: 1
                }
              },
              managed: {
                get: {
                  minArgs: 0,
                  maxArgs: 1
                },
                getBytesInUse: {
                  minArgs: 0,
                  maxArgs: 1
                }
              },
              sync: {
                clear: {
                  minArgs: 0,
                  maxArgs: 0
                },
                get: {
                  minArgs: 0,
                  maxArgs: 1
                },
                getBytesInUse: {
                  minArgs: 0,
                  maxArgs: 1
                },
                remove: {
                  minArgs: 1,
                  maxArgs: 1
                },
                set: {
                  minArgs: 1,
                  maxArgs: 1
                }
              }
            },
            tabs: {
              captureVisibleTab: {
                minArgs: 0,
                maxArgs: 2
              },
              create: {
                minArgs: 1,
                maxArgs: 1
              },
              detectLanguage: {
                minArgs: 0,
                maxArgs: 1
              },
              discard: {
                minArgs: 0,
                maxArgs: 1
              },
              duplicate: {
                minArgs: 1,
                maxArgs: 1
              },
              executeScript: {
                minArgs: 1,
                maxArgs: 2
              },
              get: {
                minArgs: 1,
                maxArgs: 1
              },
              getCurrent: {
                minArgs: 0,
                maxArgs: 0
              },
              getZoom: {
                minArgs: 0,
                maxArgs: 1
              },
              getZoomSettings: {
                minArgs: 0,
                maxArgs: 1
              },
              goBack: {
                minArgs: 0,
                maxArgs: 1
              },
              goForward: {
                minArgs: 0,
                maxArgs: 1
              },
              highlight: {
                minArgs: 1,
                maxArgs: 1
              },
              insertCSS: {
                minArgs: 1,
                maxArgs: 2
              },
              move: {
                minArgs: 2,
                maxArgs: 2
              },
              query: {
                minArgs: 1,
                maxArgs: 1
              },
              reload: {
                minArgs: 0,
                maxArgs: 2
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              removeCSS: {
                minArgs: 1,
                maxArgs: 2
              },
              sendMessage: {
                minArgs: 2,
                maxArgs: 3
              },
              setZoom: {
                minArgs: 1,
                maxArgs: 2
              },
              setZoomSettings: {
                minArgs: 1,
                maxArgs: 2
              },
              update: {
                minArgs: 1,
                maxArgs: 2
              }
            },
            topSites: {
              get: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            webNavigation: {
              getAllFrames: {
                minArgs: 1,
                maxArgs: 1
              },
              getFrame: {
                minArgs: 1,
                maxArgs: 1
              }
            },
            webRequest: {
              handlerBehaviorChanged: {
                minArgs: 0,
                maxArgs: 0
              }
            },
            windows: {
              create: {
                minArgs: 0,
                maxArgs: 1
              },
              get: {
                minArgs: 1,
                maxArgs: 2
              },
              getAll: {
                minArgs: 0,
                maxArgs: 1
              },
              getCurrent: {
                minArgs: 0,
                maxArgs: 1
              },
              getLastFocused: {
                minArgs: 0,
                maxArgs: 1
              },
              remove: {
                minArgs: 1,
                maxArgs: 1
              },
              update: {
                minArgs: 2,
                maxArgs: 2
              }
            }
          };
          if (Object.keys(r).length === 0)
            throw new Error("api-metadata.json has not been included in browser-polyfill");
          class i extends WeakMap {
            constructor(m, E = void 0) {
              super(E), this.createItem = m;
            }
            get(m) {
              return this.has(m) || this.set(m, this.createItem(m)), super.get(m);
            }
          }
          const c = (u) => u && typeof u == "object" && typeof u.then == "function", d = (u, m) => (...E) => {
            n.runtime.lastError ? u.reject(new Error(n.runtime.lastError.message)) : m.singleCallbackArg || E.length <= 1 && m.singleCallbackArg !== !1 ? u.resolve(E[0]) : u.resolve(E);
          }, h = (u) => u == 1 ? "argument" : "arguments", l = (u, m) => function(A, ...R) {
            if (R.length < m.minArgs)
              throw new Error(`Expected at least ${m.minArgs} ${h(m.minArgs)} for ${u}(), got ${R.length}`);
            if (R.length > m.maxArgs)
              throw new Error(`Expected at most ${m.maxArgs} ${h(m.maxArgs)} for ${u}(), got ${R.length}`);
            return new Promise((C, y) => {
              if (m.fallbackToNoCallback)
                try {
                  A[u](...R, d({
                    resolve: C,
                    reject: y
                  }, m));
                } catch (w) {
                  console.warn(`${u} API method doesn't seem to support the callback parameter, falling back to call it without a callback: `, w), A[u](...R), m.fallbackToNoCallback = !1, m.noCallback = !0, C();
                }
              else m.noCallback ? (A[u](...R), C()) : A[u](...R, d({
                resolve: C,
                reject: y
              }, m));
            });
          }, g = (u, m, E) => new Proxy(m, {
            apply(A, R, C) {
              return E.call(R, u, ...C);
            }
          });
          let p = Function.call.bind(Object.prototype.hasOwnProperty);
          const f = (u, m = {}, E = {}) => {
            let A = /* @__PURE__ */ Object.create(null), R = {
              has(y, w) {
                return w in u || w in A;
              },
              get(y, w, v) {
                if (w in A)
                  return A[w];
                if (!(w in u))
                  return;
                let _ = u[w];
                if (typeof _ == "function")
                  if (typeof m[w] == "function")
                    _ = g(u, u[w], m[w]);
                  else if (p(E, w)) {
                    let B = l(w, E[w]);
                    _ = g(u, u[w], B);
                  } else
                    _ = _.bind(u);
                else if (typeof _ == "object" && _ !== null && (p(m, w) || p(E, w)))
                  _ = f(_, m[w], E[w]);
                else if (p(E, "*"))
                  _ = f(_, m[w], E["*"]);
                else
                  return Object.defineProperty(A, w, {
                    configurable: !0,
                    enumerable: !0,
                    get() {
                      return u[w];
                    },
                    set(B) {
                      u[w] = B;
                    }
                  }), _;
                return A[w] = _, _;
              },
              set(y, w, v, _) {
                return w in A ? A[w] = v : u[w] = v, !0;
              },
              defineProperty(y, w, v) {
                return Reflect.defineProperty(A, w, v);
              },
              deleteProperty(y, w) {
                return Reflect.deleteProperty(A, w);
              }
            }, C = Object.create(u);
            return new Proxy(C, R);
          }, S = (u) => ({
            addListener(m, E, ...A) {
              m.addListener(u.get(E), ...A);
            },
            hasListener(m, E) {
              return m.hasListener(u.get(E));
            },
            removeListener(m, E) {
              m.removeListener(u.get(E));
            }
          }), W = new i((u) => typeof u != "function" ? u : function(E) {
            const A = f(E, {}, {
              getContent: {
                minArgs: 0,
                maxArgs: 0
              }
            });
            u(A);
          }), b = new i((u) => typeof u != "function" ? u : function(E, A, R) {
            let C = !1, y, w = new Promise((D) => {
              y = function(O) {
                C = !0, D(O);
              };
            }), v;
            try {
              v = u(E, A, y);
            } catch (D) {
              v = Promise.reject(D);
            }
            const _ = v !== !0 && c(v);
            if (v !== !0 && !_ && !C)
              return !1;
            const B = (D) => {
              D.then((O) => {
                R(O);
              }, (O) => {
                let P;
                O && (O instanceof Error || typeof O.message == "string") ? P = O.message : P = "An unexpected error occurred", R({
                  __mozWebExtensionPolyfillReject__: !0,
                  message: P
                });
              }).catch((O) => {
                console.error("Failed to send onMessage rejected reply", O);
              });
            };
            return B(_ ? v : w), !0;
          }), I = ({
            reject: u,
            resolve: m
          }, E) => {
            n.runtime.lastError ? n.runtime.lastError.message === a ? m() : u(new Error(n.runtime.lastError.message)) : E && E.__mozWebExtensionPolyfillReject__ ? u(new Error(E.message)) : m(E);
          }, M = (u, m, E, ...A) => {
            if (A.length < m.minArgs)
              throw new Error(`Expected at least ${m.minArgs} ${h(m.minArgs)} for ${u}(), got ${A.length}`);
            if (A.length > m.maxArgs)
              throw new Error(`Expected at most ${m.maxArgs} ${h(m.maxArgs)} for ${u}(), got ${A.length}`);
            return new Promise((R, C) => {
              const y = I.bind(null, {
                resolve: R,
                reject: C
              });
              A.push(y), E.sendMessage(...A);
            });
          }, x = {
            devtools: {
              network: {
                onRequestFinished: S(W)
              }
            },
            runtime: {
              onMessage: S(b),
              onMessageExternal: S(b),
              sendMessage: M.bind(null, "sendMessage", {
                minArgs: 1,
                maxArgs: 3
              })
            },
            tabs: {
              sendMessage: M.bind(null, "sendMessage", {
                minArgs: 2,
                maxArgs: 3
              })
            }
          }, T = {
            clear: {
              minArgs: 1,
              maxArgs: 1
            },
            get: {
              minArgs: 1,
              maxArgs: 1
            },
            set: {
              minArgs: 1,
              maxArgs: 1
            }
          };
          return r.privacy = {
            network: {
              "*": T
            },
            services: {
              "*": T
            },
            websites: {
              "*": T
            }
          }, f(n, x, r);
        };
        s.exports = o(chrome);
      }
    });
  })(browserPolyfill$1)), browserPolyfill$1.exports;
}
requireBrowserPolyfill();
const DEFAULT_PORT = 23151, LOG_PREFIX = "[Wolffish]", HEARTBEAT_INTERVAL_MS = 15e3, COMMAND_TIMEOUT_MS = 3e4, CONTENT_SCRIPT_PING_TIMEOUT_MS = 500, WolffishCommands = {
  // Navigation
  BROWSER_NAVIGATE: "browser_navigate",
  BROWSER_BACK: "browser_back",
  BROWSER_FORWARD: "browser_forward",
  BROWSER_RELOAD: "browser_reload",
  // Page Interaction
  BROWSER_CLICK: "browser_click",
  BROWSER_TYPE: "browser_type",
  BROWSER_SELECT: "browser_select",
  BROWSER_HOVER: "browser_hover",
  BROWSER_SCROLL: "browser_scroll",
  BROWSER_FOCUS: "browser_focus",
  BROWSER_KEYPRESS: "browser_keypress",
  BROWSER_DRAG_DROP: "browser_drag_drop",
  BROWSER_FILE_UPLOAD: "browser_file_upload",
  BROWSER_SET_VALUE: "browser_set_value",
  BROWSER_SUBMIT_FORM: "browser_submit_form",
  // Page Reading
  BROWSER_READ_PAGE: "browser_read_page",
  BROWSER_QUERY_SELECTOR: "browser_query_selector",
  BROWSER_GET_ATTRIBUTE: "browser_get_attribute",
  BROWSER_GET_VALUE: "browser_get_value",
  BROWSER_GET_URL: "browser_get_url",
  BROWSER_GET_PAGE_INFO: "browser_get_page_info",
  // Tab Management
  BROWSER_TABS_LIST: "browser_tabs_list",
  BROWSER_TAB_OPEN: "browser_tab_open",
  BROWSER_TAB_CLOSE: "browser_tab_close",
  BROWSER_TAB_SWITCH: "browser_tab_switch",
  BROWSER_TAB_DUPLICATE: "browser_tab_duplicate",
  BROWSER_TAB_MOVE: "browser_tab_move",
  // Window Management
  BROWSER_WINDOWS_LIST: "browser_windows_list",
  BROWSER_WINDOW_OPEN: "browser_window_open",
  BROWSER_WINDOW_CLOSE: "browser_window_close",
  BROWSER_WINDOW_RESIZE: "browser_window_resize",
  // Screenshots & Visual
  BROWSER_SCREENSHOT: "browser_screenshot",
  BROWSER_PDF: "browser_pdf",
  // Cookies & Storage
  BROWSER_COOKIES_GET: "browser_cookies_get",
  BROWSER_COOKIES_SET: "browser_cookies_set",
  BROWSER_COOKIES_REMOVE: "browser_cookies_remove",
  BROWSER_STORAGE_GET: "browser_storage_get",
  BROWSER_STORAGE_SET: "browser_storage_set",
  // Clipboard
  BROWSER_CLIPBOARD_READ: "browser_clipboard_read",
  BROWSER_CLIPBOARD_WRITE: "browser_clipboard_write",
  // Downloads
  BROWSER_DOWNLOAD: "browser_download",
  // JavaScript Execution
  BROWSER_EXECUTE_JS: "browser_execute_js",
  // Wait & Polling
  // browser_wait is the generic entry models reach for first (it mirrors
  // the playwright capability's browser_wait): a plain sleep, or a
  // selector/navigation/network-idle wait dispatched on `type`. The
  // specific BROWSER_WAIT_FOR_* commands below remain the primary tools.
  BROWSER_WAIT: "browser_wait",
  BROWSER_WAIT_FOR: "browser_wait_for",
  BROWSER_WAIT_FOR_NAVIGATION: "browser_wait_for_navigation",
  BROWSER_WAIT_FOR_NETWORK_IDLE: "browser_wait_for_network_idle",
  // Notifications
  BROWSER_NOTIFY: "browser_notify",
  // Wolffish tab group — the label the model puts on its own workspace
  BROWSER_SET_ACTIVITY: "browser_set_activity",
  // Debugger Mode
  DEBUGGER_ATTACH: "browser_debugger_attach",
  DEBUGGER_DETACH: "browser_debugger_detach",
  DEBUGGER_STATUS: "browser_debugger_status",
  // Mouse Interaction (coordinate- or selector-based; trusted input in debugger mode)
  BROWSER_MOUSE_MOVE: "browser_mouse_move",
  BROWSER_MOUSE_CLICK: "browser_mouse_click",
  BROWSER_MOUSE_DOWN: "browser_mouse_down",
  BROWSER_MOUSE_UP: "browser_mouse_up",
  BROWSER_MOUSE_DRAG: "browser_mouse_drag",
  // Coordinate ↔ DOM bridging (read-only)
  BROWSER_ELEMENT_FROM_POINT: "browser_element_from_point",
  BROWSER_GET_INTERACTIVE_ELEMENTS: "browser_get_interactive_elements",
  // Humanize
  HUMANIZE: "browser_humanize"
}, CONTENT_SCRIPT_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_DRAG_DROP,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_SUBMIT_FORM,
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_QUERY_SELECTOR,
  WolffishCommands.BROWSER_GET_ATTRIBUTE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_GET_PAGE_INFO,
  WolffishCommands.BROWSER_STORAGE_GET,
  WolffishCommands.BROWSER_STORAGE_SET,
  WolffishCommands.BROWSER_CLIPBOARD_READ,
  WolffishCommands.BROWSER_CLIPBOARD_WRITE,
  WolffishCommands.BROWSER_WAIT_FOR,
  WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
  WolffishCommands.BROWSER_ELEMENT_FROM_POINT,
  WolffishCommands.BROWSER_GET_INTERACTIVE_ELEMENTS
]), SERVICE_WORKER_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_NAVIGATE,
  WolffishCommands.BROWSER_BACK,
  WolffishCommands.BROWSER_FORWARD,
  WolffishCommands.BROWSER_RELOAD,
  WolffishCommands.BROWSER_TABS_LIST,
  WolffishCommands.BROWSER_TAB_OPEN,
  WolffishCommands.BROWSER_TAB_CLOSE,
  WolffishCommands.BROWSER_TAB_SWITCH,
  WolffishCommands.BROWSER_TAB_DUPLICATE,
  WolffishCommands.BROWSER_TAB_MOVE,
  WolffishCommands.BROWSER_WINDOWS_LIST,
  WolffishCommands.BROWSER_WINDOW_OPEN,
  WolffishCommands.BROWSER_WINDOW_CLOSE,
  WolffishCommands.BROWSER_WINDOW_RESIZE,
  WolffishCommands.BROWSER_SCREENSHOT,
  WolffishCommands.BROWSER_PDF,
  WolffishCommands.BROWSER_COOKIES_GET,
  WolffishCommands.BROWSER_COOKIES_SET,
  WolffishCommands.BROWSER_COOKIES_REMOVE,
  WolffishCommands.BROWSER_DOWNLOAD,
  WolffishCommands.BROWSER_EXECUTE_JS,
  // Service-worker side so a bare sleep works with no page attached; the
  // selector/network-idle variants delegate to the content script.
  WolffishCommands.BROWSER_WAIT,
  WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION,
  WolffishCommands.BROWSER_NOTIFY,
  WolffishCommands.BROWSER_SET_ACTIVITY,
  WolffishCommands.BROWSER_GET_URL,
  WolffishCommands.DEBUGGER_ATTACH,
  WolffishCommands.DEBUGGER_DETACH,
  WolffishCommands.DEBUGGER_STATUS,
  WolffishCommands.BROWSER_MOUSE_MOVE,
  WolffishCommands.BROWSER_MOUSE_CLICK,
  WolffishCommands.BROWSER_MOUSE_DOWN,
  WolffishCommands.BROWSER_MOUSE_UP,
  WolffishCommands.BROWSER_MOUSE_DRAG,
  WolffishCommands.HUMANIZE
]), DEBUGGER_ROUTABLE_COMMANDS = /* @__PURE__ */ new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_KEYPRESS
]), api$5 = globalThis.chrome ?? globalThis.browser, log = (...e) => {
  console.log(LOG_PREFIX, ...e);
}, logError = (...e) => {
  console.error(LOG_PREFIX, ...e);
}, isFirefox = () => typeof globalThis.browser < "u", sendToContentScript = async (e, t) => {
  var s;
  return (s = api$5 == null ? void 0 : api$5.tabs) == null ? void 0 : s.sendMessage(e, t);
}, pingContentScript = async (e) => {
  var t;
  try {
    const s = {
      source: "service-worker",
      target: "content-script",
      payload: { type: "ping" }
    }, a = await Promise.race([
      (t = api$5 == null ? void 0 : api$5.tabs) == null ? void 0 : t.sendMessage(e, s),
      new Promise((o, n) => setTimeout(() => n(new Error("timeout")), CONTENT_SCRIPT_PING_TIMEOUT_MS))
    ]);
    return a && a.type === "pong";
  } catch {
    return !1;
  }
}, ensureContentScriptInjected = async (e) => {
  var s;
  await pingContentScript(e) || (await ((s = api$5 == null ? void 0 : api$5.scripting) == null ? void 0 : s.executeScript({
    target: { tabId: e },
    files: ["content/all.iife.js"]
  })), await new Promise((a, o) => {
    var i, c;
    const n = setTimeout(() => o(new Error("Content script injection timed out")), 5e3), r = (d) => {
      var h, l;
      (d == null ? void 0 : d.source) === "content-script" && "type" in d.payload && d.payload.type === "pong" && (clearTimeout(n), (l = (h = api$5 == null ? void 0 : api$5.runtime) == null ? void 0 : h.onMessage) == null || l.removeListener(r), a());
    };
    (c = (i = api$5 == null ? void 0 : api$5.runtime) == null ? void 0 : i.onMessage) == null || c.addListener(r);
  }));
};
let tabFallback = null;
const setTabFallback = (e) => {
  tabFallback = e;
}, resolveTabId = async (e) => {
  var s, a;
  if (e.tabId !== void 0 && await ((s = api$5 == null ? void 0 : api$5.tabs) == null ? void 0 : s.get(e.tabId).then(() => !0).catch(() => !1)))
    return e.tabId;
  if (tabFallback)
    return tabFallback();
  const t = await ((a = api$5 == null ? void 0 : api$5.tabs) == null ? void 0 : a.query({ active: !0, currentWindow: !0 }));
  if (!(t != null && t.length))
    throw new Error("No active tab found");
  return t[0].id;
}, withTimeout = (e) => e, makeResponse = (e, t) => ({ id: e, success: !0, data: t }), makeErrorResponse = (e, t) => ({ id: e, success: !1, error: t }), generateId = () => crypto.randomUUID();
var StorageEnum;
(function(e) {
  e.Local = "local", e.Sync = "sync", e.Managed = "managed", e.Session = "session";
})(StorageEnum || (StorageEnum = {}));
var SessionAccessLevelEnum;
(function(e) {
  e.ExtensionPagesOnly = "TRUSTED_CONTEXTS", e.ExtensionPagesAndContentScripts = "TRUSTED_AND_UNTRUSTED_CONTEXTS";
})(SessionAccessLevelEnum || (SessionAccessLevelEnum = {}));
const chrome$1 = globalThis.chrome, updateCache = async (e, t) => {
  const s = (o) => typeof o == "function", a = (o) => (
    // Use ReturnType to infer the return type of the function and check if it's a Promise
    o instanceof Promise
  );
  return s(e) ? (a(e), e(t)) : e;
};
let globalSessionAccessLevelFlag = !1;
const checkStoragePermission = (e) => {
  if (chrome$1 && !chrome$1.storage[e])
    throw new Error(`"storage" permission in manifest.ts: "storage ${e}" isn't defined`);
}, createStorage = (e, t, s) => {
  var S, W;
  let a = null, o = !1, n = [];
  const r = (s == null ? void 0 : s.storageEnum) ?? StorageEnum.Local, i = ((S = s == null ? void 0 : s.serialization) == null ? void 0 : S.serialize) ?? ((b) => b), c = ((W = s == null ? void 0 : s.serialization) == null ? void 0 : W.deserialize) ?? ((b) => b);
  globalSessionAccessLevelFlag === !1 && r === StorageEnum.Session && (s == null ? void 0 : s.sessionAccessForContentScripts) === !0 && (checkStoragePermission(r), chrome$1 == null || chrome$1.storage[r].setAccessLevel({
    accessLevel: SessionAccessLevelEnum.ExtensionPagesAndContentScripts
  }).catch((b) => {
    console.error(b), console.error("Please call .setAccessLevel() into different context, like a background script.");
  }), globalSessionAccessLevelFlag = !0);
  const d = async () => {
    checkStoragePermission(r);
    const b = await (chrome$1 == null ? void 0 : chrome$1.storage[r].get([e]));
    return b ? c(b[e]) ?? t : t;
  }, h = async (b) => {
    o || (a = await d()), a = await updateCache(b, a), await (chrome$1 == null ? void 0 : chrome$1.storage[r].set({ [e]: i(a) })), p();
  }, l = (b) => (n = [...n, b], () => {
    n = n.filter((I) => I !== b);
  }), g = () => a, p = () => {
    n.forEach((b) => b());
  }, f = async (b) => {
    if (b[e] === void 0)
      return;
    const I = c(b[e].newValue);
    a !== I && (a = await updateCache(I, a), p());
  };
  return d().then((b) => {
    a = b, o = !0, p();
  }), chrome$1 == null || chrome$1.storage[r].onChanged.addListener(f), {
    get: d,
    set: h,
    getSnapshot: g,
    subscribe: l
  };
}, storage = createStorage("wolffish-connection-config", { port: 23151 }, {
  storageEnum: StorageEnum.Local
}), wolffishConnectionStorage = {
  ...storage
}, gaussianRandom = (e, t) => {
  let s = 0, a = 0;
  for (; s === 0; ) s = Math.random();
  for (; a === 0; ) a = Math.random();
  const o = Math.sqrt(-2 * Math.log(s)) * Math.cos(2 * Math.PI * a);
  return Math.round(e + o * t);
}, clamp = (e, t, s) => Math.max(t, Math.min(s, e)), gaussianDelay = (e, t, s) => {
  const a = s ?? (e + t) / 2, o = (t - e) / 4;
  return clamp(gaussianRandom(a, o), e, t);
}, sleep = (e) => new Promise((t) => setTimeout(t, e)), api$4 = globalThis.chrome;
let attachedTabId = null, isAttached = !1;
const resetState = () => {
  attachedTabId = null, isAttached = !1;
}, getDebuggerState = () => ({
  attached: isAttached,
  tabId: attachedTabId
}), sendCDP$1 = async (e, t = {}) => {
  if (!isAttached || attachedTabId === null)
    throw new Error("Debugger not attached");
  return api$4.debugger.sendCommand({ tabId: attachedTabId }, e, t);
}, generateBezierPath = (e, t, s, a, o) => {
  const n = e + (s - e) * 0.25 + (Math.random() - 0.5) * Math.abs(s - e) * 0.3, r = t + (a - t) * 0.25 + (Math.random() - 0.5) * Math.abs(a - t) * 0.3, i = e + (s - e) * 0.75 + (Math.random() - 0.5) * Math.abs(s - e) * 0.3, c = t + (a - t) * 0.75 + (Math.random() - 0.5) * Math.abs(a - t) * 0.3, d = [];
  for (let h = 1; h <= o; h++) {
    const l = h / o, g = 1 - l, p = g * g * g * e + 3 * g * g * l * n + 3 * g * l * l * i + l * l * l * s, f = g * g * g * t + 3 * g * g * l * r + 3 * g * l * l * c + l * l * l * a;
    d.push({ x: Math.round(p), y: Math.round(f) });
  }
  return d;
};
let cursorX = 0, cursorY = 0;
const getCursorPosition = () => ({ x: cursorX, y: cursorY }), BUTTON_MASK = { left: 1, right: 2, middle: 4 }, resolveElementCoords = async (e, t, s = {}) => {
  var n;
  const o = (n = (await api$4.scripting.executeScript({
    target: { tabId: e },
    func: (r, i) => {
      const c = (p) => p.replace(/\s+/g, " ").trim().toLowerCase(), d = (p) => {
        if (p.offsetParent !== null) return !0;
        const f = getComputedStyle(p);
        return f.display !== "none" && f.visibility !== "hidden";
      };
      let h = null;
      if (r.startsWith("text=")) {
        const p = c(r.slice(5).replace(/^(["'])([\s\S]*)\1$/, "$2"));
        if (p) {
          const f = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]), S = [], W = [], b = document.body ? Array.from(document.body.getElementsByTagName("*")) : [];
          for (const x of b) {
            const T = x;
            if (f.has(T.tagName)) continue;
            const u = c(T.textContent ?? "");
            !u || u.length > p.length + 200 || (u === p ? S.push(T) : u.includes(p) && W.push(T));
          }
          const I = S.length > 0 ? S : W;
          h = I.filter((x) => !I.some((T) => T !== x && x.contains(T))).find(d) ?? null;
        }
      } else
        try {
          h = document.querySelector(r);
        } catch {
          return {
            error: `selector syntax is incorrect: '${r}' is not valid CSS. Use a CSS selector, or text=<visible text> to target by text.`
          };
        }
      if (!h) return null;
      i && h.scrollIntoView({ behavior: "smooth", block: "center" });
      const l = h.getBoundingClientRect(), g = h.closest("a");
      return {
        x: Math.round(l.left + l.width / 2),
        y: Math.round(l.top + l.height / 2),
        href: (g == null ? void 0 : g.href) || null
      };
    },
    args: [t, s.scroll ?? !1],
    world: "MAIN"
  }))[0]) == null ? void 0 : n.result;
  if (o && "error" in o) throw new Error(o.error);
  if (!o) throw new Error(`Element not found: ${t}`);
  return o;
}, resolveTarget = async (e, t, s = {}) => {
  if (t.selector) return resolveElementCoords(e, t.selector, s);
  if (typeof t.x == "number" && typeof t.y == "number")
    return { x: t.x, y: t.y, href: null };
  throw new Error("Provide either a selector or x/y coordinates");
}, cdpMove = async (e, t, s = !1) => {
  const a = gaussianDelay(10, 20), o = generateBezierPath(cursorX, cursorY, e, t, a);
  for (const n of o)
    await sendCDP$1("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: n.x,
      y: n.y,
      ...s ? { button: "left", buttons: 1 } : {}
    }), await sleep(gaussianDelay(5, 15));
  cursorX = e, cursorY = t;
}, cdpPress = (e, t, s, a = 1) => sendCDP$1("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: e,
  y: t,
  button: s,
  buttons: BUTTON_MASK[s] ?? 1,
  clickCount: a
}), cdpRelease = (e, t, s, a = 1) => sendCDP$1("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: e,
  y: t,
  button: s,
  buttons: 0,
  clickCount: a
}), fallbackMouse = async (e, t, s, a, o) => {
  await api$4.scripting.executeScript({
    target: { tabId: e },
    func: (n, r, i, c) => {
      const d = c === "right" ? 2 : c === "middle" ? 1 : 0, h = document.elementFromPoint(n, r) ?? document.body, l = (g) => {
        h.dispatchEvent(
          new MouseEvent(g, {
            bubbles: !0,
            cancelable: !0,
            clientX: n,
            clientY: r,
            button: d,
            view: window
          })
        );
      };
      if (i === "down") return l("mousedown");
      if (i === "up") return l("mouseup");
      if (i === "contextmenu")
        return l("mousedown"), l("mouseup"), l("contextmenu");
      l("mousedown"), l("mouseup"), l("click"), i === "dblclick" && (l("mousedown"), l("mouseup"), l("click"), l("dblclick"));
    },
    args: [t, s, a, o],
    world: "MAIN"
  });
};
api$4.debugger.onDetach.addListener((e, t) => {
  e.tabId === attachedTabId && (log(`Debugger detached from tab ${e.tabId}: ${t}`), resetState());
});
api$4.tabs.onRemoved.addListener((e) => {
  e === attachedTabId && (log(`Attached tab ${e} was closed`), resetState());
});
const handleDebuggerAttach = async (e) => {
  const { tabId: t } = e;
  if (isAttached && attachedTabId === t)
    return { success: !0, tabId: t };
  if (isAttached && attachedTabId !== null) {
    try {
      await api$4.debugger.detach({ tabId: attachedTabId });
    } catch {
    }
    resetState();
  }
  try {
    return await api$4.debugger.attach({ tabId: t }, "1.3"), attachedTabId = t, isAttached = !0, log(`Debugger attached to tab ${t}`), { success: !0, tabId: t };
  } catch (s) {
    resetState();
    const a = s instanceof Error ? s.message : String(s);
    throw a.includes("Cannot access") || a.includes("chrome://") || a.includes("chrome-extension://") ? new Error("Cannot attach debugger to restricted page (chrome://, chrome-extension://, etc.)") : a.includes("Another debugger") ? new Error("Cannot attach debugger: DevTools or another debugger is already attached to this tab") : new Error(`Failed to attach debugger: ${a}`);
  }
}, handleDebuggerDetach = async () => {
  if (!isAttached || attachedTabId === null)
    return { success: !0 };
  try {
    await api$4.debugger.detach({ tabId: attachedTabId });
  } catch {
  }
  return log(`Debugger detached from tab ${attachedTabId}`), resetState(), { success: !0 };
}, handleDebuggerStatus = async () => ({
  attached: isAttached,
  tabId: attachedTabId
}), handleCDPClick = async (e) => {
  const { selector: t } = e, s = attachedTabId, a = await resolveElementCoords(s, t, { scroll: !0 });
  await sleep(gaussianDelay(50, 150));
  const o = gaussianDelay(10, 20), n = generateBezierPath(cursorX, cursorY, a.x, a.y, o);
  for (const r of n)
    await sendCDP$1("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: r.x,
      y: r.y
    }), await sleep(gaussianDelay(5, 15));
  return cursorX = a.x, cursorY = a.y, await sendCDP$1("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: a.x,
    y: a.y,
    button: "left",
    clickCount: 1
  }), await sleep(gaussianDelay(30, 80)), await sendCDP$1("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: a.x,
    y: a.y,
    button: "left",
    clickCount: 1
  }), a.href && (await sleep(200), await api$4.scripting.executeScript({
    target: { tabId: s },
    func: (r) => {
      let i = null;
      try {
        i = document.querySelector(r);
      } catch {
        i = null;
      }
      const c = i == null ? void 0 : i.closest("a");
      c && c.click();
    },
    args: [t],
    world: "MAIN"
  })), { success: !0, elementFound: !0 };
}, handleCDPType = async (e) => {
  const { selector: t, text: s, clearFirst: a } = e, o = attachedTabId;
  await api$4.scripting.executeScript({
    target: { tabId: o },
    func: (n, r) => {
      const i = document.querySelector(n);
      if (!i) throw new Error(`Element not found: ${n}`);
      i.focus(), r && (i.tagName === "INPUT" || i.tagName === "TEXTAREA" ? (i.value = "", i.dispatchEvent(new Event("input", { bubbles: !0 }))) : i.isContentEditable && (document.execCommand("selectAll", !1), document.execCommand("delete", !1)));
    },
    args: [t, a ?? !1],
    world: "MAIN"
  });
  for (const n of s) {
    const r = n.charCodeAt(0), i = n, c = n.length === 1 && n >= "a" && n <= "z" ? `Key${n.toUpperCase()}` : n.length === 1 && n >= "A" && n <= "Z" ? `Key${n}` : n.length === 1 && n >= "0" && n <= "9" ? `Digit${n}` : n === " " ? "Space" : "";
    await sendCDP$1("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: i,
      code: c,
      windowsVirtualKeyCode: r,
      nativeVirtualKeyCode: r
    }), await sendCDP$1("Input.dispatchKeyEvent", {
      type: "char",
      text: n,
      key: i,
      code: c,
      windowsVirtualKeyCode: r,
      nativeVirtualKeyCode: r
    }), await sendCDP$1("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: i,
      code: c,
      windowsVirtualKeyCode: r,
      nativeVirtualKeyCode: r
    }), await sleep(gaussianDelay(40, 120, 70));
  }
  return { success: !0 };
}, handleCDPScroll = async (e) => {
  var c;
  const { direction: t, amount: s, selector: a } = e;
  if (a) {
    const d = attachedTabId, l = (c = (await api$4.scripting.executeScript({
      target: { tabId: d },
      func: (g) => {
        const p = document.querySelector(g);
        if (!p) return null;
        const f = p.getBoundingClientRect();
        return { x: Math.round(f.left + f.width / 2), y: Math.round(f.top + f.height / 2) };
      },
      args: [a],
      world: "MAIN"
    }))[0]) == null ? void 0 : c.result;
    if (l)
      return await sendCDP$1("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: l.x,
        y: l.y,
        deltaX: 0,
        deltaY: 0
      }), { success: !0 };
  }
  const o = s ?? 300, n = {
    up: [0, -o],
    down: [0, o],
    left: [-o, 0],
    right: [o, 0]
  }, [r, i] = n[t] ?? [0, 0];
  return await sendCDP$1("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: cursorX || 400,
    y: cursorY || 400,
    deltaX: r,
    deltaY: i
  }), await sleep(gaussianDelay(50, 150)), { success: !0 };
}, handleCDPHover = async (e) => {
  const { selector: t } = e, a = await resolveElementCoords(attachedTabId, t, { scroll: !0 });
  return await sleep(100), await cdpMove(a.x, a.y), { success: !0 };
}, handleCDPKeypress = async (e) => {
  const { key: t, modifiers: s } = e, a = s ?? [], o = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  let n = 0;
  for (const h of a)
    n |= o[h] ?? 0;
  const i = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32 }
  }[t], c = (i == null ? void 0 : i.code) ?? (t.length === 1 ? `Key${t.toUpperCase()}` : t), d = (i == null ? void 0 : i.keyCode) ?? t.charCodeAt(0);
  return await sendCDP$1("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: t,
    code: c,
    windowsVirtualKeyCode: d,
    nativeVirtualKeyCode: d,
    modifiers: n
  }), t.length === 1 && await sendCDP$1("Input.dispatchKeyEvent", {
    type: "char",
    text: t,
    key: t,
    code: c,
    windowsVirtualKeyCode: d,
    nativeVirtualKeyCode: d,
    modifiers: n
  }), await sendCDP$1("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: t,
    code: c,
    windowsVirtualKeyCode: d,
    nativeVirtualKeyCode: d,
    modifiers: n
  }), { success: !0 };
}, handleMouseMove = async (e) => {
  const { x: t, y: s } = e;
  if (!isAttached)
    return cursorX = t, cursorY = s, { success: !0 };
  const a = gaussianDelay(10, 20), o = generateBezierPath(cursorX, cursorY, t, s, a);
  for (const n of o)
    await sendCDP$1("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: n.x,
      y: n.y
    }), await sleep(gaussianDelay(5, 15));
  return cursorX = t, cursorY = s, { success: !0 };
}, handleMouseClick = async (e) => {
  const t = e, s = t.button ?? "left", a = t.double ?? !1;
  if (isAttached && attachedTabId !== null) {
    const { x: c, y: d } = await resolveTarget(attachedTabId, t, { scroll: !0 });
    return await sleep(gaussianDelay(50, 150)), await cdpMove(c, d), await cdpPress(c, d, s, 1), await sleep(gaussianDelay(30, 80)), await cdpRelease(c, d, s, 1), a && (await sleep(gaussianDelay(40, 90)), await cdpPress(c, d, s, 2), await sleep(gaussianDelay(30, 80)), await cdpRelease(c, d, s, 2)), { success: !0, x: c, y: d, trusted: !0 };
  }
  const o = await resolveTabId(t), { x: n, y: r } = await resolveTarget(o, t, { scroll: !0 });
  return await fallbackMouse(o, n, r, s === "right" ? "contextmenu" : a ? "dblclick" : "click", s), { success: !0, x: n, y: r, trusted: !1 };
}, handleMouseDown = async (e) => {
  const t = e, s = t.button ?? "left";
  if (isAttached && attachedTabId !== null) {
    const { x: r, y: i } = await resolveTarget(attachedTabId, t, { scroll: !0 });
    return await cdpMove(r, i), await cdpPress(r, i, s, 1), { success: !0, x: r, y: i, trusted: !0 };
  }
  const a = await resolveTabId(t), { x: o, y: n } = await resolveTarget(a, t, { scroll: !0 });
  return await fallbackMouse(a, o, n, "down", s), { success: !0, x: o, y: n, trusted: !1 };
}, handleMouseUp = async (e) => {
  const t = e, s = t.button ?? "left";
  if (isAttached && attachedTabId !== null) {
    const { x: r, y: i } = await resolveTarget(attachedTabId, t, { scroll: !1 });
    return await cdpRelease(r, i, s, 1), { success: !0, x: r, y: i, trusted: !0 };
  }
  const a = await resolveTabId(t), { x: o, y: n } = await resolveTarget(a, t, { scroll: !1 });
  return await fallbackMouse(a, o, n, "up", s), { success: !0, x: o, y: n, trusted: !1 };
}, handleMouseDrag = async (e) => {
  const t = e, s = async (r, i, c, d) => {
    if (i) return resolveElementCoords(r, i, { scroll: !0 });
    if (typeof c == "number" && typeof d == "number") return { x: c, y: d };
    throw new Error("Drag requires sourceSelector/targetSelector or startX/startY and endX/endY");
  };
  if (isAttached && attachedTabId !== null) {
    const r = attachedTabId, i = await s(r, t.sourceSelector, t.startX, t.startY), c = await s(r, t.targetSelector, t.endX, t.endY);
    return await cdpMove(i.x, i.y), await cdpPress(i.x, i.y, "left", 1), await sleep(gaussianDelay(60, 140)), await cdpMove(c.x, c.y, !0), await sleep(gaussianDelay(60, 140)), await cdpRelease(c.x, c.y, "left", 1), { success: !0, x: c.x, y: c.y, trusted: !0 };
  }
  const a = await resolveTabId(t), o = await s(a, t.sourceSelector, t.startX, t.startY), n = await s(a, t.targetSelector, t.endX, t.endY);
  return await api$4.scripting.executeScript({
    target: { tabId: a },
    func: (r, i, c, d) => {
      const h = document.elementFromPoint(r, i) ?? document.body, l = document.elementFromPoint(c, d) ?? document.body, g = (p, f, S, W) => {
        W.dispatchEvent(
          new MouseEvent(p, { bubbles: !0, cancelable: !0, clientX: f, clientY: S, button: 0, view: window })
        );
      };
      g("mousedown", r, i, h), g("mousemove", Math.round((r + c) / 2), Math.round((i + d) / 2), l), g("mousemove", c, d, l), g("mouseup", c, d, l);
    },
    args: [o.x, o.y, n.x, n.y],
    world: "MAIN"
  }), { success: !0, x: n.x, y: n.y, trusted: !1 };
}, api$3 = globalThis.chrome, sendCDP = async (e, t, s = {}) => api$3.debugger.sendCommand({ tabId: e }, t, s), findInertElement = async (e) => {
  var s;
  return (s = (await api$3.scripting.executeScript({
    target: { tabId: e },
    func: () => {
      const a = /* @__PURE__ */ new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "DETAILS", "SUMMARY"]), o = [], n = document.querySelectorAll("div, span, p, section, article, li, td, th, h1, h2, h3, h4, h5, h6");
      for (let r = 0; r < n.length && o.length < 30; r++) {
        const i = n[r], c = i.getBoundingClientRect();
        c.width < 10 || c.height < 10 || c.top < 0 || c.left < 0 || c.bottom > window.innerHeight || c.right > window.innerWidth || a.has(i.tagName) || i.closest("a, button, input, select, textarea, label") || i.getAttribute("role") === "button" || i.getAttribute("role") === "link" || i.onclick || i.getAttribute("onclick") || o.push({
          x: Math.round(c.left + c.width / 2),
          y: Math.round(c.top + c.height / 2)
        });
      }
      return o.length === 0 ? null : o[Math.floor(Math.random() * o.length)];
    },
    world: "MAIN"
  }))[0]) == null ? void 0 : s.result;
}, actionRandomPause = {
  name: "random_pause",
  execute: async () => {
    const e = gaussianDelay(800, 2e3);
    return await sleep(e), e;
  }
}, actionMicroScroll = {
  name: "micro_scroll",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = gaussianDelay(20, 60), a = Math.random() > 0.5 ? 1 : -1, o = performance.now();
    if (t) {
      const n = getCursorPosition();
      await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: n.x || 400,
        y: n.y || 400,
        deltaX: 0,
        deltaY: s * a
      }), await sleep(gaussianDelay(200, 500)), Math.random() > 0.4 && await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: n.x || 400,
        y: n.y || 400,
        deltaX: 0,
        deltaY: -s * a
      });
    } else
      await api$3.scripting.executeScript({
        target: { tabId: e },
        func: (n, r) => {
          window.scrollBy({ left: 0, top: n * r, behavior: "smooth" });
        },
        args: [s, a],
        world: "MAIN"
      }), await sleep(gaussianDelay(200, 500));
    return Math.round(performance.now() - o);
  }
}, actionCursorMove = {
  name: "cursor_move",
  execute: async (e) => {
    const t = performance.now(), s = await findInertElement(e);
    return s ? (await handleMouseMove({ x: s.x, y: s.y }), Math.round(performance.now() - t)) : (await sleep(gaussianDelay(500, 1e3)), Math.round(performance.now() - t));
  }
}, actionHoverInert = {
  name: "hover_inert",
  execute: async (e) => {
    const t = performance.now(), s = await findInertElement(e);
    return s ? (await handleMouseMove({ x: s.x, y: s.y }), await sleep(gaussianDelay(300, 800)), Math.round(performance.now() - t)) : (await sleep(gaussianDelay(300, 800)), Math.round(performance.now() - t));
  }
}, actionVariableScroll = {
  name: "variable_scroll",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = performance.now(), a = gaussianDelay(2, 4);
    for (let o = 0; o < a; o++) {
      const n = gaussianDelay(15, 40);
      if (t) {
        const r = getCursorPosition();
        await sendCDP(e, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: r.x || 400,
          y: r.y || 400,
          deltaX: 0,
          deltaY: n
        });
      } else
        await api$3.scripting.executeScript({
          target: { tabId: e },
          func: (r) => window.scrollBy({ left: 0, top: r, behavior: "smooth" }),
          args: [n],
          world: "MAIN"
        });
      await sleep(gaussianDelay(100, 300));
    }
    return Math.round(performance.now() - s);
  }
}, actionScrollBounce = {
  name: "scroll_bounce",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = performance.now(), a = gaussianDelay(80, 200);
    if (t) {
      const o = getCursorPosition();
      await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: o.x || 400,
        y: o.y || 400,
        deltaX: 0,
        deltaY: a
      }), await sleep(gaussianDelay(500, 1200)), await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: o.x || 400,
        y: o.y || 400,
        deltaX: 0,
        deltaY: -a
      });
    } else
      await api$3.scripting.executeScript({
        target: { tabId: e },
        func: (o) => window.scrollBy({ left: 0, top: o, behavior: "smooth" }),
        args: [a],
        world: "MAIN"
      }), await sleep(gaussianDelay(500, 1200)), await api$3.scripting.executeScript({
        target: { tabId: e },
        func: (o) => window.scrollBy({ left: 0, top: -o, behavior: "smooth" }),
        args: [a],
        world: "MAIN"
      });
    return await sleep(gaussianDelay(200, 400)), Math.round(performance.now() - s);
  }
}, actionIdleDrift = {
  name: "idle_drift",
  execute: async (e) => {
    const { attached: t } = getDebuggerState(), s = performance.now();
    if (!t)
      return await sleep(gaussianDelay(1e3, 2e3)), Math.round(performance.now() - s);
    const a = getCursorPosition(), o = gaussianDelay(3, 6);
    for (let n = 0; n < o; n++) {
      const r = gaussianDelay(-5, 5), i = gaussianDelay(-5, 5), c = Math.max(0, a.x + r), d = Math.max(0, a.y + i);
      await sendCDP(e, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: c,
        y: d
      }), await sleep(gaussianDelay(200, 400));
    }
    return Math.round(performance.now() - s);
  }
}, actionLongPause = {
  name: "long_pause",
  execute: async () => {
    const e = gaussianDelay(2e3, 5e3);
    return await sleep(e), e;
  }
}, POOLS = {
  light: [actionRandomPause, actionMicroScroll],
  moderate: [actionRandomPause, actionMicroScroll, actionCursorMove, actionHoverInert, actionVariableScroll],
  heavy: [
    actionRandomPause,
    actionMicroScroll,
    actionCursorMove,
    actionHoverInert,
    actionVariableScroll,
    actionScrollBounce,
    actionIdleDrift,
    actionLongPause
  ]
}, handleHumanize = async (e) => {
  const t = e.intensity ?? "moderate", s = await resolveTabId(e), a = POOLS[t], o = a[Math.floor(Math.random() * a.length)];
  log(`Humanize (${t}): executing ${o.name}`);
  const n = await o.execute(s);
  return log(`Humanize: ${o.name} completed in ${n}ms`), { action: o.name, duration_ms: n };
}, api$2 = globalThis.chrome, INSTANCE_ID_KEY = "wf:instance-id", detectOS = (e, t) => {
  var a;
  const s = ((a = e.userAgentData) == null ? void 0 : a.platform) ?? "";
  return /mac/i.test(s) || /Mac OS X/.test(t) ? "macOS" : /win/i.test(s) || /Windows NT/.test(t) ? "Windows" : /CrOS/.test(t) ? "ChromeOS" : /android/i.test(s) || /Android/.test(t) ? "Android" : /linux/i.test(s) || /Linux/.test(t) ? "Linux" : s || "";
}, uaVersion = (e, t) => {
  const s = e.match(new RegExp(`${t}/([\\d.]+)`));
  return (s == null ? void 0 : s[1]) ?? "";
}, detectBrand = async (e, t) => {
  var n, r, i, c, d;
  try {
    const h = globalThis.browser, l = await ((r = (n = h == null ? void 0 : h.runtime) == null ? void 0 : n.getBrowserInfo) == null ? void 0 : r.call(n));
    if (l != null && l.name)
      return { browser: l.name.toLowerCase(), browserName: l.name, browserVersion: l.version };
  } catch {
  }
  const s = ((i = e.userAgentData) == null ? void 0 : i.brands) ?? [], a = (h) => s.find((l) => l.brand.toLowerCase().includes(h)), o = [
    { needle: "microsoft edge", slug: "edge", name: "Microsoft Edge" },
    { needle: "opera", slug: "opera", name: "Opera" },
    { needle: "brave", slug: "brave", name: "Brave" },
    { needle: "vivaldi", slug: "vivaldi", name: "Vivaldi" },
    { needle: "google chrome", slug: "chrome", name: "Google Chrome" }
  ];
  for (const { needle: h, slug: l, name: g } of o) {
    const p = a(h);
    if (p) return { browser: l, browserName: g, browserVersion: p.version || uaVersion(t, "Chrome") };
  }
  try {
    if (await ((d = (c = e.brave) == null ? void 0 : c.isBrave) == null ? void 0 : d.call(c)))
      return { browser: "brave", browserName: "Brave", browserVersion: uaVersion(t, "Chrome") };
  } catch {
  }
  return /Edg\//.test(t) ? { browser: "edge", browserName: "Microsoft Edge", browserVersion: uaVersion(t, "Edg") } : /OPR\//.test(t) ? { browser: "opera", browserName: "Opera", browserVersion: uaVersion(t, "OPR") } : /Firefox\//.test(t) ? { browser: "firefox", browserName: "Firefox", browserVersion: uaVersion(t, "Firefox") } : a("chromium") || /Chrome\//.test(t) ? { browser: "chromium", browserName: "Chromium", browserVersion: uaVersion(t, "Chrome") } : { browser: "browser", browserName: "Browser", browserVersion: "" };
}, getProfileEmail = async () => {
  var e;
  try {
    const t = api$2 == null ? void 0 : api$2.identity, s = await ((e = t == null ? void 0 : t.getProfileUserInfo) == null ? void 0 : e.call(t, { accountStatus: "ANY" }));
    return (s == null ? void 0 : s.email) ?? "";
  } catch {
    return "";
  }
}, getInstanceId = async () => {
  try {
    const s = (await api$2.storage.local.get([INSTANCE_ID_KEY]))[INSTANCE_ID_KEY];
    if (typeof s == "string" && s) return s;
  } catch {
  }
  const e = crypto.randomUUID();
  try {
    await api$2.storage.local.set({ [INSTANCE_ID_KEY]: e });
  } catch {
  }
  return e;
};
let cached = null;
const getBrowserIdentity = async () => {
  if (cached) return cached;
  const e = navigator, t = e.userAgent ?? "", [s, a, o] = await Promise.all([
    getInstanceId(),
    detectBrand(e, t),
    getProfileEmail()
  ]);
  return cached = { instanceId: s, ...a, os: detectOS(e, t), profileEmail: o }, cached;
}, api$1 = globalThis.chrome, WOLFFISH_GROUP_TITLE = "Wolffish", WOLFFISH_GROUP_COLOR = "blue", KEY_GROUP_ID = "wf:group-id", KEY_TAB_ID = "wf:tab-id", KEY_LABEL = "wf:group-label", stateArea = () => api$1.storage.session ?? api$1.storage.local, readState = async (e) => {
  try {
    const t = await stateArea().get(e);
    return (t == null ? void 0 : t[e]) ?? null;
  } catch {
    return null;
  }
}, writeState = async (e, t) => {
  try {
    await stateArea().set({ [e]: t });
  } catch {
  }
}, clearState = async (e) => {
  try {
    await stateArea().remove(e);
  } catch {
  }
}, formatLabel = (e) => {
  const t = ((e == null ? void 0 : e.emoji) ?? "").trim(), s = ((e == null ? void 0 : e.text) ?? "").trim();
  return t && s ? `${t} ${s}` : t || s || WOLFFISH_GROUP_TITLE;
}, liveGroupId = async () => {
  if (!api$1.tabGroups) return null;
  const e = await readState(KEY_GROUP_ID);
  return typeof e != "number" ? null : await api$1.tabGroups.get(e).then(() => !0).catch(() => !1) ? e : (await clearState(KEY_GROUP_ID), null);
}, paintGroup = async (e) => {
  if (!api$1.tabGroups) return;
  const t = await readState(KEY_LABEL);
  try {
    await api$1.tabGroups.update(e, { title: formatLabel(t), color: WOLFFISH_GROUP_COLOR });
  } catch {
  }
}, groupTab = async (e) => {
  if (!api$1.tabGroups || !api$1.tabs.group) return null;
  const t = await liveGroupId();
  if (t !== null)
    try {
      return await api$1.tabs.group({ groupId: t, tabIds: [e] }), await paintGroup(t), t;
    } catch {
      await clearState(KEY_GROUP_ID);
    }
  try {
    const s = await api$1.tabs.get(e), a = await api$1.tabs.group({ tabIds: [e], createProperties: { windowId: s.windowId } });
    return await writeState(KEY_GROUP_ID, a), await paintGroup(a), a;
  } catch (s) {
    return log("tab groups unavailable:", s instanceof Error ? s.message : String(s)), null;
  }
}, getWorkspaceGroupId = () => liveGroupId(), isWorkspaceTab = async (e) => {
  const t = await liveGroupId();
  return t !== null && e.groupId === t;
}, getWorkspaceTabId = async () => {
  const e = await readState(KEY_TAB_ID);
  return typeof e != "number" ? null : await api$1.tabs.get(e).then(() => !0).catch(() => !1) ? e : (await clearState(KEY_TAB_ID), null);
}, adoptTab = async (e) => {
  await writeState(KEY_TAB_ID, e), await groupTab(e);
}, openWorkspaceTab = async (e, t = !0) => {
  const a = (await api$1.tabs.create({ url: e || "about:blank", active: t })).id;
  return await adoptTab(a), a;
}, ensureWorkspaceTab = async () => {
  const e = await getWorkspaceTabId();
  return e !== null ? e : openWorkspaceTab();
}, rememberWorkspaceTab = async (e) => {
  const t = await api$1.tabs.get(e).catch(() => null);
  return !t || !await isWorkspaceTab(t) ? !1 : (await writeState(KEY_TAB_ID, e), !0);
}, setActivity = async (e) => {
  var a, o;
  const t = { emoji: ((a = e.emoji) == null ? void 0 : a.trim()) || void 0, text: ((o = e.text) == null ? void 0 : o.trim()) || void 0 };
  await writeState(KEY_LABEL, t);
  const s = await liveGroupId();
  return s !== null && await paintGroup(s), { title: formatLabel(t), applied: s !== null };
}, api = globalThis.chrome;
setTabFallback(ensureWorkspaceTab);
let connectionStatus = "disconnected", connectionPort = DEFAULT_PORT;
const RECONNECT_ALARM = "wolffish-reconnect";
let ws = null, heartbeatTimer = null;
const stopHeartbeat = () => {
  heartbeatTimer !== null && (clearInterval(heartbeatTimer), heartbeatTimer = null);
}, startHeartbeat = () => {
  stopHeartbeat(), heartbeatTimer = setInterval(() => {
    (ws == null ? void 0 : ws.readyState) === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" }));
  }, HEARTBEAT_INTERVAL_MS);
}, setStatus = (e) => {
  connectionStatus = e, log(`Connection status: ${e}`), api.runtime.sendMessage({ type: "status_update", status: e, port: connectionPort }).catch(() => {
  });
}, scheduleReconnect = () => {
  api.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.05 });
};
api.alarms.onAlarm.addListener((e) => {
  e.name === RECONNECT_ALARM && connectionStatus !== "connected" && connectWebSocket(connectionPort);
});
const connectWebSocket = async (e) => {
  ws && (ws.onopen = null, ws.onclose = null, ws.onerror = null, ws.onmessage = null, (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && ws.close(), ws = null), connectionPort = e;
  try {
    await fetch(`http://localhost:${e}`, { mode: "no-cors" });
  } catch {
    setStatus("disconnected"), scheduleReconnect();
    return;
  }
  setStatus("connecting"), log(`Connecting to ws://localhost:${e}`), ws = new WebSocket(`ws://localhost:${e}`), ws.onopen = () => {
    setStatus("connected"), api.alarms.clear(RECONNECT_ALARM), startHeartbeat(), log("Connected");
    const t = api.runtime.getManifest();
    getBrowserIdentity().catch(() => null).then((s) => {
      sendToServer({ type: "extension_info", version: t.version, ...s ?? {} }), sendToServer({ type: "get_conversations" });
    });
  }, ws.onclose = () => {
    setStatus("disconnected"), stopHeartbeat(), log("Disconnected"), scheduleReconnect();
  }, ws.onerror = () => {
    log("WebSocket error");
  }, ws.onmessage = (t) => {
    try {
      const s = JSON.parse(t.data);
      if (s.type === "pong") return;
      if (s.type === "event") {
        handleWolffishEvent(s);
        return;
      }
      if (s.id && s.type) {
        handleCommand(s);
        return;
      }
    } catch (s) {
      logError("Failed to parse WebSocket message", s);
    }
  };
}, sendToServer = (e) => {
  (ws == null ? void 0 : ws.readyState) === WebSocket.OPEN && ws.send(JSON.stringify(e));
}, waitForTabSettled = (e, t, s) => new Promise((a) => {
  var g, p;
  let o = !1, n = !1;
  const r = () => {
    var f, S;
    clearTimeout(l), clearInterval(h), (S = (f = api.webNavigation) == null ? void 0 : f.onCompleted) == null || S.removeListener(d);
  }, i = (f) => {
    o || (o = !0, r(), a(f));
  }, c = async () => {
    const f = await api.tabs.get(e).catch(() => null);
    f && ((f.status === "loading" || f.url && f.url !== t) && (n = !0), f.status === "complete" && n && i(f));
  }, d = (f) => {
    f.tabId === e && f.frameId === 0 && (n = !0, c());
  };
  (p = (g = api.webNavigation) == null ? void 0 : g.onCompleted) == null || p.addListener(d);
  const h = setInterval(() => void c(), 100), l = setTimeout(() => {
    api.tabs.get(e).then(i).catch(() => i(null));
  }, s);
}), handleNavigate = async (e) => {
  const { url: t, waitUntil: s, newTab: a } = e, o = a ? await openWorkspaceTab() : await resolveTabId(e), n = await api.tabs.get(o).catch(() => null), r = (n == null ? void 0 : n.url) ?? "";
  await api.tabs.update(o, { url: t });
  const c = await waitForTabSettled(o, r, COMMAND_TIMEOUT_MS) ?? await api.tabs.get(o).catch(() => null);
  if (s && (!c || c.status !== "complete"))
    throw new Error(`Navigation timed out waiting for '${s}'`);
  return { url: (c == null ? void 0 : c.url) || t, title: (c == null ? void 0 : c.title) || "", tabId: o };
}, handleBack = async (e) => {
  const t = await resolveTabId(e);
  return await api.scripting.executeScript({
    target: { tabId: t },
    func: () => history.back()
  }), { success: !0 };
}, handleForward = async (e) => {
  const t = await resolveTabId(e);
  return await api.scripting.executeScript({
    target: { tabId: t },
    func: () => history.forward()
  }), { success: !0 };
}, handleReload = async (e) => {
  const { hard: t } = e, s = await resolveTabId(e);
  return await api.tabs.reload(s, { bypassCache: t ?? !1 }), { success: !0 };
}, handleTabsList = async (e) => {
  const { windowId: t } = e, s = t !== void 0 ? { windowId: t } : {}, a = await api.tabs.query(s), o = await getWorkspaceGroupId();
  return {
    tabs: a.map((n) => ({
      id: n.id,
      url: n.url || "",
      title: n.title || "",
      active: n.active,
      pinned: n.pinned,
      windowId: n.windowId,
      groupId: n.groupId,
      wolffish: o !== null && n.groupId === o
    }))
  };
}, handleTabOpen = async (e) => {
  const { url: t, active: s } = e, a = await openWorkspaceTab(t, s ?? !0), o = await api.tabs.get(a).catch(() => null);
  return {
    tabId: a,
    url: (o == null ? void 0 : o.pendingUrl) || (o == null ? void 0 : o.url) || t || ""
  };
}, handleTabClose = async (e) => {
  const { tabId: t } = e;
  return await api.tabs.remove(t), { success: !0 };
}, handleTabSwitch = async (e) => {
  const { tabId: t } = e;
  return await api.tabs.update(t, { active: !0 }), await rememberWorkspaceTab(t), { success: !0 };
}, handleTabDuplicate = async (e) => {
  const { tabId: t } = e, s = await api.tabs.duplicate(t);
  if (!s)
    throw new Error(`Failed to duplicate tab ${t}`);
  return await adoptTab(s.id), { tabId: s.id };
}, handleTabMove = async (e) => {
  const { tabId: t, index: s, windowId: a } = e, o = { index: s };
  return a !== void 0 && (o.windowId = a), await api.tabs.move(t, o), { success: !0 };
}, handleWindowsList = async () => ({
  windows: (await api.windows.getAll({ populate: !0 })).map((t) => {
    var s;
    return {
      id: t.id,
      focused: t.focused,
      tabs: ((s = t.tabs) == null ? void 0 : s.length) ?? 0,
      type: t.type || "normal",
      state: t.state || "normal"
    };
  })
}), handleWindowOpen = async (e) => {
  var i, c;
  const { url: t, incognito: s, width: a, height: o } = e, n = {};
  t !== void 0 && (n.url = t), s !== void 0 && (n.incognito = s), a !== void 0 && (n.width = a), o !== void 0 && (n.height = o);
  const r = await api.windows.create(n);
  return { windowId: r.id, tabId: (c = (i = r.tabs) == null ? void 0 : i[0]) == null ? void 0 : c.id };
}, handleWindowClose = async (e) => {
  const { windowId: t } = e;
  return await api.windows.remove(t), { success: !0 };
}, handleWindowResize = async (e) => {
  const { windowId: t, width: s, height: a, left: o, top: n, state: r } = e, i = {};
  return s !== void 0 && (i.width = s), a !== void 0 && (i.height = a), o !== void 0 && (i.left = o), n !== void 0 && (i.top = n), r !== void 0 && (i.state = r), await api.windows.update(t, i), { success: !0 };
}, handleScreenshot = async (e) => {
  const { format: t, quality: s, fullPage: a, selector: o } = e;
  if (o || a) {
    const l = await resolveTabId(e);
    return await ensureContentScriptInjected(l), (await sendToContentScript(l, {
      source: "service-worker",
      target: "content-script",
      payload: {
        id: crypto.randomUUID(),
        type: WolffishCommands.BROWSER_SCREENSHOT,
        params: e
      }
    })).data;
  }
  const n = t === "jpeg" ? "jpeg" : "png", r = { format: n };
  n === "jpeg" && s !== void 0 && (r.quality = s);
  const i = await resolveTabId(e);
  let c = await api.tabs.get(i);
  c.active || (await api.tabs.update(i, { active: !0 }), await new Promise((l) => setTimeout(l, 150)), c = await api.tabs.get(i));
  const d = await api.tabs.captureVisibleTab(c.windowId, r), h = await api.windows.get(c.windowId);
  return {
    image: d,
    width: h.width || 0,
    height: h.height || 0
  };
}, handlePdf = async (e) => {
  if (isFirefox())
    throw new Error("PDF generation is not supported on Firefox");
  const t = await resolveTabId(e);
  await api.debugger.attach({ tabId: t }, "1.3");
  try {
    return { data: (await api.debugger.sendCommand({ tabId: t }, "Page.printToPDF", {})).data };
  } finally {
    await api.debugger.detach({ tabId: t }).catch(() => {
    });
  }
}, handleCookiesGet = async (e) => {
  const { domain: t, name: s } = e, a = { domain: t };
  return s !== void 0 && (a.name = s), {
    cookies: (await api.cookies.getAll(a)).map((n) => ({
      name: n.name,
      value: n.value,
      domain: n.domain,
      path: n.path,
      expires: n.expirationDate || -1,
      httpOnly: n.httpOnly,
      secure: n.secure
    }))
  };
}, handleCookiesSet = async (e) => {
  const { url: t, name: s, value: a, domain: o, path: n, expires: r, httpOnly: i, secure: c } = e, d = { url: t, name: s, value: a };
  return o !== void 0 && (d.domain = o), n !== void 0 && (d.path = n), r !== void 0 && (d.expirationDate = r), i !== void 0 && (d.httpOnly = i), c !== void 0 && (d.secure = c), await api.cookies.set(d), { success: !0 };
}, handleCookiesRemove = async (e) => {
  const { url: t, name: s } = e;
  return await api.cookies.remove({ url: t, name: s }), { success: !0 };
}, handleDownload = async (e) => {
  const { url: t, filename: s } = e, a = { url: t };
  return s !== void 0 && (a.filename = s), { downloadId: await api.downloads.download(a) };
}, handleExecuteJs = async (params) => {
  var e;
  const { code, world } = params, tabId = await resolveTabId(params), results = await api.scripting.executeScript({
    target: { tabId },
    func: (source) => eval(source),
    args: [code],
    world: world || "ISOLATED"
  });
  return { result: (e = results[0]) == null ? void 0 : e.result };
}, handleWaitForNavigation = async (e) => {
  const { timeout: t } = e, s = await resolveTabId(e), a = t ?? COMMAND_TIMEOUT_MS, o = await api.tabs.get(s).then((n) => n.url || "").catch(() => "");
  return new Promise((n) => {
    let r = !1;
    const i = (l, g) => {
      r || (r = !0, clearTimeout(c), api.webNavigation.onCompleted.removeListener(d), api.tabs.onUpdated.removeListener(h), n({ url: l, title: g }));
    }, c = setTimeout(() => {
      api.tabs.get(s).then((l) => i(l.url || "", l.title || "")).catch(() => i(o, ""));
    }, a), d = (l) => {
      l.tabId === s && l.frameId === 0 && api.tabs.get(s).then((g) => i(g.url || l.url, g.title || "")).catch(() => i(l.url, ""));
    }, h = (l, g) => {
      l === s && g.url && g.url !== o && api.tabs.get(s).then((p) => i(p.url || g.url, p.title || "")).catch(() => i(g.url, ""));
    };
    api.webNavigation.onCompleted.addListener(d), api.tabs.onUpdated.addListener(h);
  });
}, handleWait = async (e) => {
  const t = e, s = t.timeout_ms ?? t.timeout ?? t.ms, a = t.type ?? (t.selector ? "selector" : "timeout");
  if (a === "navigation")
    return handleWaitForNavigation({ timeout: s, tabId: t.tabId });
  if (a === "selector" || a === "network_idle") {
    if (a === "selector" && !t.selector)
      throw new Error("selector is required for type=selector");
    const r = await resolveTabId(t);
    await ensureContentScriptInjected(r);
    const i = {
      id: generateId(),
      type: a === "selector" ? WolffishCommands.BROWSER_WAIT_FOR : WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
      params: a === "selector" ? { selector: t.selector, timeout: s, visible: t.visible, tabId: r } : { timeout: s, tabId: r }
    }, c = await sendToContentScript(r, {
      source: "service-worker",
      target: "content-script",
      payload: i
    });
    if (!(c != null && c.success))
      throw new Error((c == null ? void 0 : c.error) ?? `${a} wait failed`);
    return c.data;
  }
  const o = Number(s), n = Number.isFinite(o) && o > 0 ? o : 0;
  return await new Promise((r) => setTimeout(r, n)), { waited: n };
}, handleNotify = async (e) => {
  const { title: t, message: s, iconUrl: a } = e;
  return { notificationId: await api.notifications.create("", {
    type: "basic",
    title: t,
    message: s,
    iconUrl: a || api.runtime.getURL("icon-128.png")
  }) };
}, handleSetActivity = async (e) => {
  const { emoji: t, text: s } = e;
  return setActivity({ emoji: t, text: s });
}, handleGetUrl = async (e) => {
  const t = await resolveTabId(e), s = await api.tabs.get(t);
  return { url: s.url || "", title: s.title || "" };
}, SERVICE_WORKER_HANDLERS = {
  [WolffishCommands.BROWSER_NAVIGATE]: handleNavigate,
  [WolffishCommands.BROWSER_BACK]: handleBack,
  [WolffishCommands.BROWSER_FORWARD]: handleForward,
  [WolffishCommands.BROWSER_RELOAD]: handleReload,
  [WolffishCommands.BROWSER_TABS_LIST]: handleTabsList,
  [WolffishCommands.BROWSER_TAB_OPEN]: handleTabOpen,
  [WolffishCommands.BROWSER_TAB_CLOSE]: handleTabClose,
  [WolffishCommands.BROWSER_TAB_SWITCH]: handleTabSwitch,
  [WolffishCommands.BROWSER_TAB_DUPLICATE]: handleTabDuplicate,
  [WolffishCommands.BROWSER_TAB_MOVE]: handleTabMove,
  [WolffishCommands.BROWSER_WINDOWS_LIST]: handleWindowsList,
  [WolffishCommands.BROWSER_WINDOW_OPEN]: handleWindowOpen,
  [WolffishCommands.BROWSER_WINDOW_CLOSE]: handleWindowClose,
  [WolffishCommands.BROWSER_WINDOW_RESIZE]: handleWindowResize,
  [WolffishCommands.BROWSER_SCREENSHOT]: handleScreenshot,
  [WolffishCommands.BROWSER_PDF]: handlePdf,
  [WolffishCommands.BROWSER_COOKIES_GET]: handleCookiesGet,
  [WolffishCommands.BROWSER_COOKIES_SET]: handleCookiesSet,
  [WolffishCommands.BROWSER_COOKIES_REMOVE]: handleCookiesRemove,
  [WolffishCommands.BROWSER_DOWNLOAD]: handleDownload,
  [WolffishCommands.BROWSER_EXECUTE_JS]: handleExecuteJs,
  [WolffishCommands.BROWSER_WAIT]: handleWait,
  [WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION]: handleWaitForNavigation,
  [WolffishCommands.BROWSER_NOTIFY]: handleNotify,
  [WolffishCommands.BROWSER_SET_ACTIVITY]: handleSetActivity,
  [WolffishCommands.BROWSER_GET_URL]: handleGetUrl,
  [WolffishCommands.DEBUGGER_ATTACH]: handleDebuggerAttach,
  [WolffishCommands.DEBUGGER_DETACH]: handleDebuggerDetach,
  [WolffishCommands.DEBUGGER_STATUS]: handleDebuggerStatus,
  [WolffishCommands.BROWSER_MOUSE_MOVE]: handleMouseMove,
  [WolffishCommands.BROWSER_MOUSE_CLICK]: handleMouseClick,
  [WolffishCommands.BROWSER_MOUSE_DOWN]: handleMouseDown,
  [WolffishCommands.BROWSER_MOUSE_UP]: handleMouseUp,
  [WolffishCommands.BROWSER_MOUSE_DRAG]: handleMouseDrag,
  [WolffishCommands.HUMANIZE]: handleHumanize
}, CDP_HANDLERS = {
  [WolffishCommands.BROWSER_CLICK]: handleCDPClick,
  [WolffishCommands.BROWSER_TYPE]: handleCDPType,
  [WolffishCommands.BROWSER_SCROLL]: handleCDPScroll,
  [WolffishCommands.BROWSER_HOVER]: handleCDPHover,
  [WolffishCommands.BROWSER_KEYPRESS]: handleCDPKeypress
}, sendResponseToServer = (e) => {
  sendToServer(e);
}, handleCommand = async (e) => {
  log("←", e.type, e.params);
  try {
    let t;
    if (SERVICE_WORKER_COMMANDS.has(e.type)) {
      const s = SERVICE_WORKER_HANDLERS[e.type];
      if (!s)
        t = makeErrorResponse(e.id, `No handler for command: ${e.type}`);
      else {
        const a = await withTimeout(s(e.params));
        t = makeResponse(e.id, a);
      }
    } else if (CONTENT_SCRIPT_COMMANDS.has(e.type)) {
      if (getDebuggerState().attached && DEBUGGER_ROUTABLE_COMMANDS.has(e.type)) {
        const n = CDP_HANDLERS[e.type];
        if (n)
          try {
            const r = await withTimeout(n(e.params));
            t = makeResponse(e.id, r), log("→", e.type, "success (CDP)"), sendResponseToServer(t);
            return;
          } catch (r) {
            log("CDP fallback:", e.type, r instanceof Error ? r.message : String(r));
          }
      }
      const a = await resolveTabId(e.params);
      await ensureContentScriptInjected(a), t = await withTimeout(
        sendToContentScript(a, {
          source: "service-worker",
          target: "content-script",
          payload: e
        })
      );
    } else
      t = makeErrorResponse(e.id, `Unknown command: ${e.type}`);
    log("→", e.type, t.success ? "success" : t.error), sendResponseToServer(t);
  } catch (t) {
    const s = t instanceof Error ? t.message : String(t), a = makeErrorResponse(e.id, s);
    log("→", e.type, "error:", a.error), sendResponseToServer(a);
  }
}, CACHE_MAX_CONVERSATIONS = 50, CACHE_MAX_EVENTS = 500, cache = {
  saveConversations(e) {
    const t = e.slice(0, CACHE_MAX_CONVERSATIONS);
    api.storage.local.set({ "wf:conversations": t }).catch(() => {
    });
  },
  saveActive(e) {
    api.storage.local.set({ "wf:active": e }).catch(() => {
    });
  },
  saveEvents(e, t) {
    const s = t.slice(0, CACHE_MAX_EVENTS);
    api.storage.local.set({ [`wf:events:${e}`]: s }).catch(() => {
    });
  },
  async loadAll() {
    try {
      const e = await api.storage.local.get(["wf:conversations", "wf:active"]), t = e["wf:conversations"] ?? [], s = e["wf:active"] ?? null;
      let a = [];
      return s && (a = (await api.storage.local.get([`wf:events:${s}`]))[`wf:events:${s}`] ?? []), { conversations: t, active: s, events: a };
    } catch {
      return { conversations: [], active: null, events: [] };
    }
  },
  async loadEvents(e) {
    try {
      return (await api.storage.local.get([`wf:events:${e}`]))[`wf:events:${e}`] ?? [];
    } catch {
      return [];
    }
  }
};
let cachedEvents = [], cachedConversations = [], activeConversationId = null, activeConversationTitle = null, cacheRestored = !1;
const handleWolffishEvent = (e) => {
  if (e.event === "port_update") {
    const { port: t } = e.data;
    log(`Port update received: ${t}`), wolffishConnectionStorage.set({ port: t });
    return;
  }
  if (e.event === "extension_reload") {
    log("Received reload command from Wolffish"), api.runtime.reload();
    return;
  }
  if (e.event === "events_sync") {
    const t = e.data;
    activeConversationId = t.conversationId, activeConversationTitle = t.title ?? null, cachedEvents = (t.events ?? []).slice().reverse(), cache.saveActive(activeConversationId), cache.saveEvents(activeConversationId, cachedEvents), api.runtime.sendMessage({ payload: { event: "events_sync", data: e.data } }).catch(() => {
    });
    return;
  }
  if (e.event === "event_logged") {
    const t = e.data;
    cachedEvents.unshift(t), activeConversationId && cache.saveEvents(activeConversationId, cachedEvents), api.runtime.sendMessage({ payload: { event: "event_logged", data: t } }).catch(() => {
    });
    return;
  }
  if (e.event === "conversations_list") {
    cachedConversations = e.data, cache.saveConversations(cachedConversations), api.runtime.sendMessage({ payload: { event: "conversations_list", data: e.data } }).catch(() => {
    });
    for (const t of cachedConversations)
      sendToServer({ type: "get_conversation_events", conversationId: t.conversationId });
    return;
  }
  if (e.event === "conversation_events") {
    const t = e.data;
    cache.saveEvents(t.conversationId, (t.events ?? []).slice().reverse()), api.runtime.sendMessage({ payload: { event: "conversation_events", data: t } }).catch(() => {
    });
    return;
  }
};
api.runtime.onMessage.addListener((e, t, s) => {
  if (e.type === "get_connection_status") {
    const a = ws && ws.readyState === WebSocket.OPEN ? "connected" : ws && ws.readyState === WebSocket.CONNECTING ? "connecting" : "disconnected";
    return a !== connectionStatus && (connectionStatus = a), s({ status: connectionStatus, port: connectionPort }), !0;
  }
  if (e.type === "get_events")
    return sendToServer({ type: "get_conversations" }), cachedConversations.length > 0 || activeConversationId ? s({
      events: cachedEvents,
      conversations: cachedConversations,
      activeConversation: activeConversationId,
      activeConversationTitle
    }) : cache.loadAll().then((a) => {
      cachedConversations = a.conversations, activeConversationId = a.active, cachedEvents = a.events, s({
        events: cachedEvents,
        conversations: cachedConversations,
        activeConversation: activeConversationId,
        activeConversationTitle
      }), api.runtime.sendMessage({ payload: { event: "conversations_list", data: cachedConversations } }).catch(() => {
      });
    }), !0;
  if (e.type === "get_conversation_events" && e.conversationId) {
    const a = e.conversationId;
    return sendToServer({ type: "get_conversation_events", conversationId: a }), cache.loadEvents(a).then((o) => {
      cachedEvents = o, api.runtime.sendMessage({ payload: { event: "conversation_events", data: { conversationId: a, events: o } } }).catch(() => {
      }), s({ events: o });
    }), !0;
  }
  return !1;
});
const startConnection = async () => {
  connectionPort = (await wolffishConnectionStorage.get().catch(() => ({ port: DEFAULT_PORT }))).port, connectWebSocket(connectionPort);
};
api.runtime.onInstalled.addListener(async () => {
  log("Extension installed"), api.sidePanel && api.sidePanel.setPanelBehavior({ openPanelOnActionClick: !0 }), await startConnection();
});
api.runtime.onStartup.addListener(async () => {
  log("Extension started"), api.sidePanel && api.sidePanel.setPanelBehavior({ openPanelOnActionClick: !0 }), await startConnection();
});
wolffishConnectionStorage.subscribe(() => {
  const e = wolffishConnectionStorage.getSnapshot();
  e && e.port !== connectionPort && (log(`Port changed to ${e.port}`), api.alarms.clear(RECONNECT_ALARM), connectWebSocket(e.port));
});
cache.loadAll().then((e) => {
  cacheRestored || (cachedConversations = e.conversations, activeConversationId = e.active, cachedEvents = e.events, cacheRestored = !0, log(`Cache restored: ${e.conversations.length} conversations, ${e.events.length} events`));
}).catch(() => {
});
startConnection().catch((e) => logError("Failed to start connection:", e));
log("Service worker loaded");
