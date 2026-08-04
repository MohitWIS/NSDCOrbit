/* ==========================================================================
   NSDC Orbit — core utilities
   Namespaced on window.Orbit so nothing leaks into the Creator page scope.
   Classic script (no ES modules) to stay safe inside the Creator widget
   sandbox and the ZET packaging step.
   ========================================================================== */

window.Orbit = window.Orbit || {};

(function (Orbit) {
  "use strict";

  /* ======================================================================
     Config
     ====================================================================== */

  Orbit.config = {
    /* Creator application link name */
    appName: "nsdc-orbit",

    /* YTD basis: "financial" = Indian FY (1 Apr – 31 Mar), "calendar" = Jan–Dec.
       NSDC reports on the financial year, so that is the default.            */
    ytdBasis: "financial",

    /* Month the financial year starts on (0-indexed: 3 = April) */
    fiscalStartMonth: 3,

    /* Set true to render from the built-in sample data instead of Creator.
       Auto-detected at boot: if the Creator SDK is absent, mock turns on.    */
    useMock: false,

    /* Records per page when paging a report (Creator caps this at 200) */
    pageSize: 200,

    /* Hard stop so a mis-scoped report can never spin forever */
    maxPages: 50,

    locale: "en-IN"
  };

  /* ======================================================================
     SDK readiness gate

     Widget SDK v2 must be initialised before any ZOHO.CREATOR.DATA call.
     Firing getRecords too early fails in a misleading way — Creator reports
     the report as missing rather than saying the SDK wasn't ready. Every
     data call goes through this promise.
     ====================================================================== */

  var readyPromise = null;

  function ready() {
    if (readyPromise) return readyPromise;

    readyPromise = new Promise(function (resolve) {
      if (typeof ZOHO === "undefined" || !ZOHO.CREATOR) {
        console.warn("[Orbit] Creator SDK not present — running on sample data.");
        Orbit.config.useMock = true;
        resolve({ sdk: false });
        return;
      }

      /* init() exists on 2.0+; older builds initialise on first use. */
      var boot = (typeof ZOHO.CREATOR.init === "function")
        ? ZOHO.CREATOR.init()
        : Promise.resolve();

      Promise.resolve(boot).then(function () {
        if (ZOHO.CREATOR.UTIL && ZOHO.CREATOR.UTIL.getInitParams) {
          return ZOHO.CREATOR.UTIL.getInitParams();
        }
        return null;
      }).then(function (params) {
        if (params) {
          console.info("[Orbit] initParams:", params);
          Orbit.initParams = params;
          /* Local ZET preview and the Creator dev environment both report a
             /environment/development fragment. Reports must exist THERE, not
             only in production, or lookups 404. */
          Orbit.isDevEnv = params.envUrlFragment === "/environment/development";
          if (Orbit.isDevEnv) {
            console.info("[Orbit] Development environment — reports resolve " +
              "against the development stage of the app.");
          }
        }
        resolve({ sdk: true, params: params });
      }).catch(function (err) {
        console.error("[Orbit] SDK initialisation failed:", err);
        resolve({ sdk: true, error: err });
      });
    });

    return readyPromise;
  }

  /* ======================================================================
     DOM helpers
     ====================================================================== */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /**
   * Build an element. Attributes are applied literally; children are appended
   * as nodes or as TEXT (never parsed as HTML) so record data cannot inject
   * markup.
   */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined || val === false) return;
        if (key === "class") node.className = val;
        else if (key === "text") node.textContent = val;
        else if (key === "html") node.innerHTML = val;
        else if (key.indexOf("on") === 0 && typeof val === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (key === "dataset") {
          Object.keys(val).forEach(function (d) { node.dataset[d] = val[d]; });
        } else node.setAttribute(key, val);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  /** Namespaced element for SVG content. */
  function svgEl(tag, attrs, children) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined || val === false) return;
        if (key === "text") node.textContent = val;
        else node.setAttribute(key, val);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === "string"
        ? document.createTextNode(child) : child);
    });
    return node;
  }

  /** Escape a string for the rare case innerHTML is genuinely needed. */
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ======================================================================
     Formatting
     ====================================================================== */

  /** 1234567 → "12,34,567" (Indian digit grouping). */
  function num(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return n.toLocaleString(Orbit.config.locale);
  }

  /** Compact form for axis ticks and tight tiles: 12500 → "12.5K". */
  function compact(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    var abs = Math.abs(n);
    if (abs >= 1e7) return (n / 1e7).toFixed(abs >= 1e8 ? 0 : 1) + "Cr";
    if (abs >= 1e5) return (n / 1e5).toFixed(abs >= 1e6 ? 0 : 1) + "L";
    if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + "K";
    return String(n);
  }

  function pct(value, digits) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return n.toFixed(digits === undefined ? 1 : digits) + "%";
  }

  var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function fmtDate(value) {
    var d = parseDate(value);
    if (!d) return "—";
    return d.getDate().toString().padStart(2, "0") + " " +
      MONTHS_SHORT[d.getMonth()] + " " + d.getFullYear();
  }

  function fmtMonth(date) {
    return MONTHS_SHORT[date.getMonth()] + " " + String(date.getFullYear()).slice(2);
  }

  /* ======================================================================
     Dates
     ====================================================================== */

  /**
   * Creator hands back dates in several shapes depending on the field type
   * and the org's locale setting. Cover the common ones explicitly rather
   * than trusting Date.parse, which reads "01/04/2026" as 4 January in a
   * US-locale browser — a silent, month-shifting bug.
   */
  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

    var str = String(value).trim();
    if (!str) return null;

    var m;

    /* dd-MMM-yyyy [HH:mm:ss] — Creator's default display format */
    m = str.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      var mi = MONTHS_SHORT.indexOf(m[2].slice(0, 3).toLowerCase()
        .replace(/^./, function (c) { return c.toUpperCase(); }));
      if (mi >= 0) {
        return new Date(+m[3], mi, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      }
    }

    /* dd/MM/yyyy or dd-MM-yyyy — day first, the Indian convention */
    m = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }

    /* yyyy-MM-dd [HH:mm:ss] — ISO-ish, unambiguous */
    m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }

    var fallback = new Date(str);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function addMonths(date, delta) {
    return new Date(date.getFullYear(), date.getMonth() + delta, 1);
  }

  function sameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  /**
   * Start of the year-to-date window.
   * financial → 1 April of the current financial year (Indian convention)
   * calendar  → 1 January
   */
  function startOfYTD(ref) {
    var now = ref || new Date();
    if (Orbit.config.ytdBasis === "calendar") {
      return new Date(now.getFullYear(), 0, 1);
    }
    var fyStart = Orbit.config.fiscalStartMonth;
    var year = now.getMonth() >= fyStart ? now.getFullYear() : now.getFullYear() - 1;
    return new Date(year, fyStart, 1);
  }

  /** "FY 2026-27" or "2026" — the label that goes beside a YTD figure. */
  function ytdLabel(ref) {
    var start = startOfYTD(ref);
    if (Orbit.config.ytdBasis === "calendar") return String(start.getFullYear());
    return "FY " + start.getFullYear() + "–" + String(start.getFullYear() + 1).slice(2);
  }

  /* ======================================================================
     Misc
     ====================================================================== */

  function debounce(fn, wait) {
    var timer;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait || 250);
    };
  }

  /** Percentage change, guarding the divide-by-zero case explicitly. */
  function delta(current, previous) {
    var c = Number(current) || 0, p = Number(previous) || 0;
    if (p === 0) {
      return { pct: null, dir: c > 0 ? "up" : "flat", abs: c - p };
    }
    var change = ((c - p) / p) * 100;
    return {
      pct: change,
      dir: Math.abs(change) < 0.05 ? "flat" : (change > 0 ? "up" : "down"),
      abs: c - p
    };
  }

  /* ======================================================================
     Theme
     ====================================================================== */

  var THEME_KEY = "orbit.theme";

  var theme = {
    get: function () {
      try { return localStorage.getItem(THEME_KEY) || "auto"; }
      catch (e) { return "auto"; }
    },
    set: function (mode) {
      try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* private mode */ }
      theme.apply(mode);
    },
    apply: function (mode) {
      var root = document.documentElement;
      if (mode === "auto") root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", mode);
      document.dispatchEvent(new CustomEvent("orbit:themechange", { detail: { mode: mode } }));
    },
    toggle: function () {
      var current = theme.get();
      var isDark = current === "dark" ||
        (current === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      theme.set(isDark ? "light" : "dark");
      return isDark ? "light" : "dark";
    },
    init: function () { theme.apply(theme.get()); }
  };

  /* ======================================================================
     Export
     ====================================================================== */

  Orbit.$ = $;
  Orbit.$$ = $$;
  Orbit.el = el;
  Orbit.svgEl = svgEl;
  Orbit.escapeHtml = escapeHtml;
  Orbit.clear = clear;
  Orbit.num = num;
  Orbit.compact = compact;
  Orbit.pct = pct;
  Orbit.fmtDate = fmtDate;
  Orbit.fmtMonth = fmtMonth;
  Orbit.parseDate = parseDate;
  Orbit.startOfMonth = startOfMonth;
  Orbit.addMonths = addMonths;
  Orbit.sameMonth = sameMonth;
  Orbit.startOfYTD = startOfYTD;
  Orbit.ytdLabel = ytdLabel;
  Orbit.debounce = debounce;
  Orbit.delta = delta;
  Orbit.theme = theme;
  Orbit.ready = ready;
  Orbit.MONTHS_SHORT = MONTHS_SHORT;
})(window.Orbit);
