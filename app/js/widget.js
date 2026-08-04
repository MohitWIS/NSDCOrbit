/* ==========================================================================
   NSDC Orbit — widget entry point
   Boots the shell, loads the reports, renders the sections.

   Adding a metric: append an entry to SECTIONS below. Each section owns its
   own load + render and fails independently, so one broken report can never
   blank the whole dashboard.
   ========================================================================== */

(function (Orbit) {
  "use strict";

  var el = Orbit.el;
  var $ = Orbit.$;
  var icon = Orbit.icon;
  var charts = Orbit.charts;

  var state = {
    user: null,
    omRecords: null,
    omSummary: null,
    omStatus: null
  };

  /* ======================================================================
     Section registry
     ====================================================================== */

  var SECTIONS = [
    {
      id: "overview",
      label: "Overview",
      icon: "grid",
      title: "Overview",
      crumb: "Orbit",
      render: renderOverview
    }
  ];

  /* ======================================================================
     Requirement 1 — Total OMs Received (This Month / YTD)
     Source: OM_Request_Form_Report
     ====================================================================== */

  function renderOverview(host) {
    Orbit.clear(host);

    var kpiGrid = el("div", { class: "grid grid--kpi" });
    var trendSlot = el("div", { class: "section" });

    host.appendChild(el("div", { class: "section" }, [
      el("div", { class: "section__head" }, [
        el("div", {}, [
          el("h2", { class: "section__title", text: "Orbit" }),
          el("p", {
            class: "section__desc",
            text: "Volume received this month and across " + Orbit.ytdLabel() + " to date."
          })
        ]),
        el("div", { class: "section__tools" }, [
          el("button", {
            class: "btn btn--secondary btn--sm", type: "button",
            onclick: function () { loadOM(true); }
          }, [icon("refresh", 14), document.createTextNode("Refresh")])
        ])
      ]),
      kpiGrid
    ]));

    host.appendChild(trendSlot);

    /* Skeletons while the report is in flight */
    kpiGrid.appendChild(kpiSkeleton());
    kpiGrid.appendChild(kpiSkeleton());
    trendSlot.appendChild(el("div", { class: "card card--pad" }, [charts.chartSkeleton(260)]));

    host._omSlots = { kpi: kpiGrid, trend: trendSlot };

    if (state.omSummary) paintOM(host);
    else loadOM(false);
  }

  function kpiSkeleton() {
    return el("div", { class: "card kpi" }, [
      el("div", { class: "skeleton skeleton--text", style: "width:45%" }),
      el("div", { class: "skeleton skeleton--value" }),
      el("div", { class: "skeleton skeleton--text", style: "width:60%" })
    ]);
  }

  function loadOM(isRefetch) {
    var host = $("#view");
    if (isRefetch) {
      /* Hold the previous render at reduced opacity rather than flashing
         skeletons — no layout jump on refresh. */
      Orbit.$$(".chart", host).forEach(function (c) { c.classList.add("is-refetching"); });
    }

    return Orbit.loadOMRequests().then(function (records) {
      state.omRecords = records;
      var spec = Orbit.reports.omRequests;
      var dateField = Orbit.resolveDateField(records, spec);
      state.omSummary = Orbit.summariseByPeriod(records, dateField);
      state.omStatus = Orbit.summariseByStatus(
        records, spec.fields.status, spec.openStatuses);
      paintOM(host);
      if (isRefetch) Orbit.toast("Refreshed — " + Orbit.num(records.length) + " OM records", "good");
    }).catch(function (err) {
      console.error("[Orbit] OM_Request_Form_Report failed:", err);
      paintOMError(host, err);
    });
  }

  function paintOMError(host, err) {
    var slots = host._omSlots;
    if (!slots) return;
    Orbit.clear(slots.kpi);
    Orbit.clear(slots.trend);
    slots.kpi.appendChild(el("div", { class: "card", style: "grid-column:1/-1" }, [
      charts.errorState(
        "Couldn't load OM_Request_Form_Report",
        (err && err.message) ? err.message : "The report did not respond.",
        function () { loadOM(true); }
      )
    ]));
  }

  function paintOM(host) {
    var slots = host._omSlots;
    var s = state.omSummary;
    if (!slots || !s) return;

    Orbit.clear(slots.kpi);
    Orbit.clear(slots.trend);

    var now = new Date();
    var monthLabel = Orbit.MONTHS_SHORT[now.getMonth()] + " " + now.getFullYear();

    /* ---- Tile 1: the headline — this month, with YTD alongside --------- */
    var d = Orbit.delta(s.thisMonth, s.lastMonth);

    slots.kpi.appendChild(el("div", { class: "card kpi kpi--blue" }, [
      el("div", { class: "kpi__top" }, [
        el("div", { class: "kpi__label" }, [
          el("span", { class: "kpi__icon" }, [icon("doc", 15)]),
          document.createTextNode("Total OMs received")
        ])
      ]),
      el("div", { class: "kpi__split" }, [
        el("div", { class: "kpi__split-item kpi__split-item--lead" }, [
          el("span", { class: "kpi__split-label", text: "This month" }),
          el("span", { class: "kpi__split-value", text: Orbit.num(s.thisMonth) })
        ]),
        el("div", { class: "kpi__split-item" }, [
          el("span", { class: "kpi__split-label", text: Orbit.ytdLabel() + " to date" }),
          el("span", { class: "kpi__split-value", text: Orbit.num(s.ytd) })
        ])
      ]),
      el("div", { class: "kpi__meta" }, [
        deltaChip(d, "vs " + Orbit.fmtMonth(Orbit.addMonths(now, -1))),
        el("span", { text: monthLabel })
      ]),
      el("div", { class: "kpi__spark" }, [charts.sparkline(s.series, { slot: 1 })])
    ]));

    /* ---- Tile 2: YTD against the same window last year ----------------- */
    var yd = Orbit.delta(s.ytd, s.prevYtd);

    slots.kpi.appendChild(el("div", { class: "card kpi kpi--teal" }, [
      el("div", { class: "kpi__top" }, [
        el("div", { class: "kpi__label" }, [
          el("span", { class: "kpi__icon" }, [icon("trend", 15)]),
          document.createTextNode(Orbit.ytdLabel() + " to date")
        ])
      ]),
      el("div", { class: "kpi__value", text: Orbit.num(s.ytd) }),
      el("div", { class: "kpi__meta" }, [
        deltaChip(yd, "vs same period last year"),
        el("span", { text: "Since " + Orbit.fmtDate(s.ytdStart) })
      ])
    ]));

    /* ---- Tile 3: live workload ----------------------------------------- */
    var st = state.omStatus;
    if (st) {
      var parts = Object.keys(st.openBy).map(function (label) {
        return label + " " + Orbit.num(st.openBy[label]);
      });

      slots.kpi.appendChild(el("div", { class: "card kpi kpi--amber" }, [
        el("div", { class: "kpi__top" }, [
          el("div", { class: "kpi__label" }, [
            el("span", { class: "kpi__icon" }, [icon("clock", 15)]),
            document.createTextNode("Open / In progress")
          ])
        ]),
        el("div", { class: "kpi__value", text: Orbit.num(st.open) }),
        el("div", { class: "kpi__meta" }, [
          el("span", { text: parts.join(" · ") }),
          st.open > 0 && s.total > 0
            ? el("span", { text: Orbit.pct((st.open / s.total) * 100, 0) + " of all OMs" })
            : null
        ])
      ]));
    }

    /* ---- Tile 4: all-time total in the report -------------------------- */
    slots.kpi.appendChild(el("div", { class: "card kpi" }, [
      el("div", { class: "kpi__top" }, [
        el("div", { class: "kpi__label" }, [
          el("span", { class: "kpi__icon" }, [icon("inbox", 15)]),
          document.createTextNode("All records")
        ])
      ]),
      el("div", { class: "kpi__value", text: Orbit.num(s.total) }),
      el("div", { class: "kpi__meta" }, [
        el("span", { text: "Everything in OM_Request_Form_Report" })
      ])
    ]));

    /* ---- Trend: 12 rolling months -------------------------------------- */
    var chart = charts.barChart(s.series, {
      slot: 1,
      valueLabel: "OMs received",
      categoryLabel: "Month",
      title: "OMs received by month",
      height: 280
    });

    slots.trend.appendChild(el("div", { class: "card" }, [
      el("div", { class: "card__head" }, [
        el("div", {}, [
          el("div", { class: "card__title", text: "OMs received by month" }),
          el("div", {
            class: "card__subtitle",
            text: "Rolling 12 months · counted from OM_Request_Form_Report"
          })
        ]),
        charts.viewToggle(chart)
      ]),
      el("div", { class: "card__body" }, [chart])
    ]));

    /* ---- Status breakdown ---------------------------------------------- */
    var statusData = null;
    if (st && st.statusField) {
      statusData = Orbit.statusChartData(st, Orbit.reports.omRequests);
      var sd = statusData;

      var statusChart = charts.hBarChart(sd.rows, {
        valueLabel: "OMs",
        categoryLabel: "Status",
        title: "OMs by status",
        groups: sd.groups
      });

      slots.trend.appendChild(el("div", { class: "card", style: "margin-top:var(--space-8)" }, [
        el("div", { class: "card__head" }, [
          el("div", {}, [
            el("div", { class: "card__title", text: "OMs by status" }),
            el("div", {
              class: "card__subtitle",
              text: Orbit.num(sd.total) + " records across " + sd.rows.length +
                " workflow states · grouped by lifecycle stage"
            })
          ]),
          charts.viewToggle(statusChart)
        ]),
        el("div", { class: "card__body" }, [statusChart])
      ]));
    }

    /* ---- Data-quality notices ------------------------------------------ */
    if (!s.dateField) {
      slots.trend.appendChild(el("div", {
        class: "card card--pad", style: "margin-top:var(--space-4)"
      }, [
        charts.errorState(
          "No date field recognised",
          "Every record counted into “All records”, but none could be placed in a month. " +
          "Open the browser console for the list of fields present, then set dateField in js/data.js."
        )
      ]));
    }

    /* A status outside the configured vocabulary still gets charted, in the
       "Other" group — but say so, because it means the workflow has moved
       on and the lifecycle grouping no longer describes it. */
    if (st && st.statusField) {
      if (statusData && statusData.unlisted.length) {
        slots.trend.appendChild(el("div", {
          class: "mock-banner", style: "margin-top:var(--space-4)"
        }, [
          icon("alert", 14),
          document.createTextNode(
            "Status values not in the configured workflow: " +
            statusData.unlisted.join(", ") +
            ". They are charted under “Other” — add them to statusGroups in " +
            "js/data.js to place them in a lifecycle stage."
          )
        ]));
      }

      if (st.blank > 0) {
        slots.trend.appendChild(el("div", {
          class: "mock-banner", style: "margin-top:var(--space-4)"
        }, [
          icon("alert", 14),
          document.createTextNode(
            Orbit.num(st.blank) + " records have no “" + st.statusField +
            "” value and are excluded from the open count."
          )
        ]));
      }
    }

    if (s.dateField && s.undated > 0) {
      slots.trend.appendChild(el("div", {
        class: "mock-banner", style: "margin-top:var(--space-4)"
      }, [
        icon("alert", 14),
        document.createTextNode(
          Orbit.num(s.undated) + " of " + Orbit.num(s.total) +
          " records have no readable “" + s.dateField +
          "” value and are excluded from the monthly figures."
        )
      ]));
    }
  }

  /** Delta cue: arrow glyph + value + period. Colour reinforces, never alone. */
  function deltaChip(d, suffix) {
    var glyph = d.dir === "up" ? "▲" : d.dir === "down" ? "▼" : "—";
    var text = d.pct === null
      ? (d.abs > 0 ? "New" : "No change")
      : (d.pct > 0 ? "+" : "") + d.pct.toFixed(1) + "%";

    return el("span", { class: "delta delta--" + d.dir }, [
      el("span", { "aria-hidden": "true", text: glyph }),
      document.createTextNode(text),
      el("span", { class: "text-muted", style: "font-weight:400", text: " " + suffix })
    ]);
  }

  /* ======================================================================
     Shell
     ====================================================================== */

  function buildShell() {
    var nav = $("#topnav");

    SECTIONS.forEach(function (section, i) {
      nav.appendChild(el("a", {
        class: "nav-item" + (i === 0 ? " is-active" : ""),
        href: "#" + section.id,
        dataset: { section: section.id }
      }, [
        el("span", { class: "nav-item__icon" }, [icon(section.icon)]),
        el("span", { class: "nav-item__label", text: section.label })
      ]));
    });

    /* A nav strip with a single destination is noise — show it only once
       there is somewhere else to go. */
    nav.classList.toggle("u-hide", SECTIONS.length < 2);
  }

  function activate(sectionId) {
    var section = SECTIONS.filter(function (s) { return s.id === sectionId; })[0] || SECTIONS[0];

    Orbit.$$("[data-section]").forEach(function (node) {
      node.classList.toggle("is-active", node.dataset.section === section.id);
    });

    $("#topbarTitle").textContent = section.title;
    $("#topbarCrumb").textContent = section.crumb || "";

    section.render($("#view"));
  }

  /* ---- Command palette -------------------------------------------------- */

  var omni = {
    open: function () {
      $("#omni").classList.add("is-open");
      var input = $("#omniInput");
      input.value = "";
      omni.render("");
      input.focus();
    },
    close: function () { $("#omni").classList.remove("is-open"); },
    isOpen: function () { return $("#omni").classList.contains("is-open"); },

    commands: function () {
      var list = SECTIONS.map(function (s) {
        return {
          group: "Go to", label: s.label, icon: s.icon, hint: "Section",
          run: function () { location.hash = "#" + s.id; }
        };
      });

      list.push({
        group: "Actions", label: "Refresh data", icon: "refresh", hint: "",
        run: function () { loadOM(true); }
      });
      list.push({
        group: "Actions", label: "Toggle dark mode", icon: "moon", hint: "",
        run: function () { Orbit.theme.toggle(); syncThemeIcon(); }
      });

      return list;
    },

    render: function (query) {
      var results = $("#omniResults");
      Orbit.clear(results);

      var q = String(query || "").trim().toLowerCase();
      var matches = omni.commands().filter(function (c) {
        return !q || c.label.toLowerCase().indexOf(q) >= 0;
      });

      if (!matches.length) {
        results.appendChild(el("div", { class: "state", style: "padding:var(--space-8)" }, [
          el("div", { class: "state__desc", text: "No matches for “" + query + "”" })
        ]));
        return;
      }

      var lastGroup = null;
      matches.forEach(function (cmd, i) {
        if (cmd.group !== lastGroup) {
          results.appendChild(el("div", { class: "omni__group-label", text: cmd.group }));
          lastGroup = cmd.group;
        }
        results.appendChild(el("button", {
          class: "omni__item" + (i === 0 ? " is-active" : ""),
          type: "button",
          onclick: function () { omni.close(); cmd.run(); }
        }, [
          el("span", { class: "omni__item-icon" }, [icon(cmd.icon, 16)]),
          el("span", { class: "omni__item-label", text: cmd.label }),
          cmd.hint ? el("span", { class: "omni__item-hint", text: cmd.hint }) : null
        ]));
      });
    },

    move: function (dir) {
      var items = Orbit.$$(".omni__item", $("#omniResults"));
      if (!items.length) return;
      var current = -1;
      items.forEach(function (n, i) { if (n.classList.contains("is-active")) current = i; });
      var next = (current + dir + items.length) % items.length;
      items.forEach(function (n, i) { n.classList.toggle("is-active", i === next); });
      items[next].scrollIntoView({ block: "nearest" });
    },

    activate: function () {
      var active = $(".omni__item.is-active", $("#omniResults"));
      if (active) active.click();
    }
  };

  /* ---- Toast ------------------------------------------------------------ */

  Orbit.toast = function (message, tone) {
    var host = $("#toasts");
    var node = el("div", { class: "toast" + (tone ? " toast--" + tone : ""), role: "status" }, [
      el("span", { class: "toast__icon" }, [icon(tone === "critical" ? "alert" : "check", 16)]),
      el("span", { text: message })
    ]);
    host.appendChild(node);
    setTimeout(function () {
      node.classList.add("is-leaving");
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 240);
    }, 3200);
  };

  /* ---- Theme icon ------------------------------------------------------- */

  function syncThemeIcon() {
    var mode = Orbit.theme.get();
    var isDark = mode === "dark" ||
      (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var btn = $("#themeToggle");
    Orbit.clear(btn);
    btn.appendChild(icon(isDark ? "sun" : "moon"));
    btn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  }

  /* ======================================================================
     Events
     ====================================================================== */

  function wireEvents() {
    window.addEventListener("hashchange", function () {
      activate((location.hash || "").replace("#", ""));
    });

    $("#themeToggle").addEventListener("click", function () {
      Orbit.theme.toggle();
      syncThemeIcon();
    });

    $("#omniTrigger").addEventListener("click", omni.open);
    $("#omni").addEventListener("click", function (e) {
      if (e.target.id === "omni") omni.close();
    });
    $("#omniInput").addEventListener("input", Orbit.debounce(function () {
      omni.render(this.value);
    }, 120));

    document.addEventListener("keydown", function (e) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (omni.isOpen()) omni.close(); else omni.open();
        return;
      }
      if (!omni.isOpen()) return;
      if (e.key === "Escape") { e.preventDefault(); omni.close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); omni.move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); omni.move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); omni.activate(); }
    });

    /* Repaint on theme change so the SVG marks pick up the new tokens */
    document.addEventListener("orbit:themechange", function () {
      if (state.omSummary) paintOM($("#view"));
    });
  }

  /* ======================================================================
     Boot
     ====================================================================== */

  /** The signed-in user arrives under different keys across SDK versions. */
  function extractLoginUser(res) {
    if (!res) return null;
    var keys = ["loginUser", "login_user", "loginUserEmail", "userEmail", "email"];
    for (var i = 0; i < keys.length; i++) {
      if (res[keys[i]]) return res[keys[i]];
    }
    return null;
  }

  function boot() {
    Orbit.theme.init();
    syncThemeIcon();
    buildShell();
    wireEvents();

    /* One readiness gate for the whole widget: the SDK is initialised once,
       then the sections load. Rendering the shell does not wait on it. */
    activate((location.hash || "").replace("#", ""));

    Orbit.ready().then(function (env) {
      /* Kept in state for later sections that need per-user scoping; there
         is no longer a chrome element displaying it. */
      state.user = extractLoginUser(env.params);
      if (Orbit.config.useMock) $("#mockBanner").classList.remove("u-hide");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.Orbit);
