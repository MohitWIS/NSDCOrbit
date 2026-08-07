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
    omStatus: null,
    omOverdue: null,
    omClosed: null,
    omReopened: null,
    omPriority: null,
    omMinistry: null,
    omDepartment: null
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
    /* Mirrors the real tile: a label row and a figure row, nothing under
       the number — so nothing shifts when the data lands. */
    return el("div", { class: "card kpi" }, [
      el("div", { class: "skeleton skeleton--text", style: "width:55%" }),
      el("div", { class: "skeleton skeleton--value" })
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
      state.omOverdue = Orbit.summariseOverdue(
        records, spec.fields.dueDate, spec.fields.status,
        spec.overdueExcludeStatuses);

      var closedField = Orbit.resolveClosedDateField(
        records, spec, spec.fields.status, spec.closedStatuses);
      state.omClosed = Orbit.summariseClosed(
        records, closedField.field || dateField, spec.fields.status,
        spec.closedStatuses);
      state.omClosed.usedFallbackField = closedField.fallback;

      /* Governance flag reads Stage = "Reopen", a different field and value
         from the "Reopened" Status the lifecycle chart still uses. */
      var stageField = Orbit.resolveField(
        records, spec.fields.stage, spec.stageFieldCandidates, "stage");
      state.omReopened = Orbit.countByField(
        records, stageField, spec.reopenedStages);

      var priorityField = Orbit.resolvePriorityField(records, spec);
      state.omPriority = Orbit.priorityStatusMatrix(
        records, priorityField, spec.fields.status, spec);

      /* Ministry is a confirmed field name, so it is used directly — but
         verify it is actually present before charting an empty axis. */
      var ministryField = records.length &&
        Object.prototype.hasOwnProperty.call(records[0], spec.fields.ministry)
        ? spec.fields.ministry : null;
      if (!ministryField && records.length) {
        console.warn("[Orbit] No \"" + spec.fields.ministry + "\" field. " +
          "Fields present: " + Object.keys(records[0]).join(", "));
      }
      state.omMinistry = Orbit.ministryVolume(records, ministryField, spec);

      var deptField = Orbit.resolveField(
        records, spec.fields.department, spec.departmentFieldCandidates,
        "originating department");
      state.omDepartment = Orbit.departmentWorkload(
        records, deptField, spec.fields.status, spec);
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

    /* ---- Tile 1: total received ----------------------------------------
       Every record in the report. */
    slots.kpi.appendChild(el("div", {
      class: "card kpi kpi--violet",
      title: "Every record in OM_Request_Form_Report"
    }, [
      el("div", { class: "kpi__top" }, [
        el("div", { class: "kpi__label" }, [
          el("span", { class: "kpi__icon" }, [icon("inbox", 15)]),
          document.createTextNode("Total OMs received")
        ])
      ]),
      el("div", { class: "kpi__figure" }, [
        el("span", { class: "kpi__value", text: Orbit.num(s.total) })
      ])
    ]));

    /* ---- Tile 2: live workload ----------------------------------------- */
    var st = state.omStatus;
    if (st) {
      var parts = Object.keys(st.openBy).map(function (label) {
        return label + " " + Orbit.num(st.openBy[label]);
      });

      slots.kpi.appendChild(el("div", {
        class: "card kpi kpi--blue",
        title: parts.join(" · ")
      }, [
        el("div", { class: "kpi__top" }, [
          el("div", { class: "kpi__label" }, [
            el("span", { class: "kpi__icon" }, [icon("clock", 15)]),
            document.createTextNode("Open / In progress")
          ])
        ]),
        el("div", { class: "kpi__figure" }, [
          el("span", { class: "kpi__value", text: Orbit.num(st.open) }),
          st.open > 0 && s.total > 0
            ? el("span", {
              class: "kpi__chip",
              text: Orbit.pct((st.open / s.total) * 100, 0)
            })
            : null
        ])
      ]));
    }

    /* ---- Tile 3: overdue ------------------------------------------------
       Status == "Overdue" — the workflow decides, not the widget. Days
       overdue are still measured from Due_Date. Zero is good news, so the
       tile reads as reassurance rather than shouting red at an empty
       count. */
    var od = state.omOverdue;
    if (od) {
      var isClear = od.count === 0;
      var ageParts = od.buckets
        .filter(function (b) { return b.value > 0; })
        .map(function (b) { return b.label + " " + Orbit.num(b.value); });

      /* A record the workflow calls overdue whose due date has not passed
         is a contradiction worth surfacing rather than smoothing over. */
      if (od.notPastDue) {
        ageParts.push(Orbit.num(od.notPastDue) + " not yet past their due date");
      }
      if (od.undated) {
        ageParts.push(Orbit.num(od.undated) + " with no readable due date");
      }

      slots.kpi.appendChild(el("div", {
        class: "card kpi " + (isClear ? "kpi--good" : "kpi--critical"),
        title: isClear ? "No OM is at status Overdue"
          : "Status = Overdue · " + ageParts.join(" · ") +
          " · average " + Orbit.num(od.averageDaysLate) + " days late"
      }, [
        el("div", { class: "kpi__top" }, [
          el("div", { class: "kpi__label" }, [
            el("span", { class: "kpi__icon" }, [icon(isClear ? "check" : "alert", 15)]),
            document.createTextNode("Overdue")
          ])
        ]),
        el("div", { class: "kpi__figure" }, [
          el("span", { class: "kpi__value", text: Orbit.num(od.count) }),
          isClear
            ? null
            : el("span", {
              class: "kpi__chip",
              text: "oldest " + Orbit.num(od.oldestDays) + "d"
            })
        ])
      ]));
    }

    /* ---- Tile 4: closed ------------------------------------------------
       Every record at Status = Closed, with no date filter. The
       month-over-month comparison is gone with the monthly framing — a
       running total has nothing to compare against. `state.omClosed` is
       still computed, because the trend chart plots closures by month. */
    var cl = state.omClosed;
    var closedNow = st ? Orbit.countStatuses(st, Orbit.reports.omRequests.closedStatuses) : null;

    if (closedNow) {
      slots.kpi.appendChild(el("div", {
        class: "card kpi kpi--teal",
        title: Orbit.num(closedNow.count) + " of " +
          Orbit.num(closedNow.denominator) + " OMs are at status Closed"
      }, [
        el("div", { class: "kpi__top" }, [
          el("div", { class: "kpi__label" }, [
            el("span", { class: "kpi__icon" }, [icon("check", 15)]),
            document.createTextNode("Closed")
          ])
        ]),
        el("div", { class: "kpi__figure" }, [
          el("span", { class: "kpi__value", text: Orbit.num(closedNow.count) }),
          closedNow.count > 0
            ? el("span", { class: "kpi__chip", text: Orbit.pct(closedNow.rate, 0) })
            : null
        ])
      ]));
    }

    /* ---- Tile 5: reopened — governance flag -----------------------------
       Read from STAGE = "Reopen", not from Status. A raw count cannot say
       whether governance is slipping — 30 reopened out of 200 is a problem,
       out of 20,000 it is noise — so the rate is shown beside it, against
       records that actually carry a stage (a blank cannot be "Reopen", and
       counting blanks would understate the rate). */
    var ro = state.omReopened;
    if (ro) {
      var noneReopened = ro.count === 0;
      var spellings = Object.keys(ro.matched);

      slots.kpi.appendChild(el("div", {
        class: "card kpi " + (ro.missing ? "" : noneReopened ? "kpi--good" : "kpi--warning"),
        title: ro.missing
          ? "No Stage field in the report"
          : noneReopened
            ? "Nothing at the Reopen stage"
            : Orbit.num(ro.count) + " of " + Orbit.num(ro.denominator) +
            " OMs at Stage \"Reopen\"" +
            (spellings.length > 1 ? " · counted as: " + spellings.join(", ") : "")
      }, [
        el("div", { class: "kpi__top" }, [
          el("div", { class: "kpi__label" }, [
            el("span", { class: "kpi__icon" }, [
              icon(ro.missing ? "alert" : noneReopened ? "check" : "refresh", 15)
            ]),
            document.createTextNode("Reopened")
          ]),
          el("span", { class: "badge badge--neutral", text: "" })
        ]),
        el("div", { class: "kpi__figure" }, [
          el("span", {
            class: "kpi__value",
            text: ro.missing ? "—" : Orbit.num(ro.count)
          }),
          /* The rate is what makes this a governance flag rather than a
             bare count, so it stays — beside the figure. */
          (!ro.missing && !noneReopened)
            ? el("span", { class: "kpi__chip", text: Orbit.pct(ro.rate, 1) })
            : null
        ])
      ]));
    }

    /* ---- Charts, side by side ------------------------------------------
       Each redraws at its column's real pixel width, so type and marks stay
       the intended size whether they sit in one column or two. */
    var chartRow = el("div", { class: "grid grid--halves" });
    slots.trend.appendChild(chartRow);

    /* ---- Status breakdown ---------------------------------------------- */
    var statusData = null;
    if (st && st.statusField) {
      statusData = Orbit.statusChartData(st, Orbit.reports.omRequests);
      var sd = statusData;

      /* Status distribution as a donut. Each status carries its own
         colour from the 12-slot categorical wheel, whose order was searched
         and validated on the adjacent pairlist (worst adjacent CVD ΔE 15.7).
         Statuses stay in lifecycle order so the ring still reads as a
         progression, and the legend names every status with its count and
         share. */
      /* Pass the rows straight through rather than rebuilding them. An
         earlier copy here dropped `cat`, so every status fell back to its
         lifecycle-group slot and the four "Live work" statuses — Open, In
         Progress, Assigned, Reopened — all rendered the same blue. */
      var statusChart = charts.responsive(function (width) {
        return charts.donutChart(sd.rows, {
          /* The legend now sits beside the ring, so the ring takes roughly
             45% of the card and leaves the rest for the list. */
          size: Math.max(150, Math.min(220, Math.round(width * 0.46))),
          valueLabel: "OMs",
          categoryLabel: "Status",
          centerLabel: "total",
          title: "Status distribution"
        });
      });

      chartRow.appendChild(el("div", { class: "card card--tint card--tint-blue" }, [
        el("div", { class: "card__head" }, [
          el("div", {}, [
            el("div", { class: "card__title", text: "Status distribution" }),
            el("div", {
              class: "card__subtitle",
              text: sd.rows.length + " workflow states · in lifecycle order"
            })
          ]),
          charts.viewToggle(statusChart)
        ]),
        el("div", { class: "card__body" }, [statusChart])
      ]));
    }

    /* ---- Second row -------------------------------------------------- */
    var chartRow2 = el("div", { class: "grid grid--halves", style: "margin-top:var(--space-8)" });
    slots.trend.appendChild(chartRow2);

    /* ---- Priority vs Status -------------------------------------------- */
    var pm = state.omPriority;
    if (pm && !pm.missing && pm.rows.length) {
      var priorityChart = charts.responsive(function (width) {
        return charts.stackedBarChart(pm.rows, {
          width: width,
          valueLabel: "OMs",
          categoryLabel: "Priority",
          title: "Priority vs status",
          groups: pm.groups,
          statuses: pm.statuses
        });
      });

      chartRow2.appendChild(el("div", { class: "card card--tint card--tint-violet" }, [
        el("div", { class: "card__head" }, [
          el("div", {}, [
            el("div", { class: "card__title", text: "Priority vs status" }),
            el("div", {
              class: "card__subtitle",
              text: Orbit.num(pm.total) + " OMs across " + pm.rows.length +
                " priorities · stacked by status"
            })
          ]),
          charts.viewToggle(priorityChart)
        ]),
        el("div", { class: "card__body" }, [priorityChart])
      ]));
    } else if (pm && pm.missing) {
      chartRow2.appendChild(el("div", { class: "card card--pad" }, [
        charts.emptyState(
          "No priority field found",
          "OM_Request_Form_Report has no field holding a priority value, so " +
          "priority cannot be crossed against status. Check the console for " +
          "the fields present, then set fields.priority in js/data.js."
        )
      ]));
    }

    /* ---- Ministry-wise volume ------------------------------------------
       Each ministry takes its own colour from the categorical wheel. The
       wheel index follows rank position and the bars are labelled with
       their values, so colour marks identity rather than restating height. */
    var mv = state.omMinistry;
    if (mv && !mv.missing && mv.rows.length) {
      /* Columns needed to stay legible: a narrow column carries fewer bars,
         so the fold is recomputed per render width rather than fixed.
         12 is also the categorical wheel's ceiling — past it a colour would
         have to repeat, and two ministries sharing a hue is worse than a
         fold that says how many it covers. */
      var ministryChart = charts.responsive(function (width) {
        var maxBars = width < 420 ? 5 : width < 560 ? 7 : width < 720 ? 9 : 12;
        return charts.barChart(Orbit.foldTopN(mv.all, maxBars), {
          colorful: true,
          width: width,
          height: 340,
          rotateLabels: true,
          valueLabel: "OMs",
          categoryLabel: "Ministry",
          title: "Ministry-wise volume",
          tableRows: mv.all          /* table keeps every ministry */
        });
      });

      var subtitle = Orbit.num(mv.total) + " OMs across " +
        Orbit.num(mv.distinct) + " ministries · highest first";
      if (mv.distinct > 5) {
        subtitle += " · tail folded into Other, full list in the table view";
      }

      chartRow.appendChild(el("div", { class: "card card--tint card--tint-teal" }, [
        el("div", { class: "card__head" }, [
          el("div", {}, [
            el("div", { class: "card__title", text: "Ministry-wise volume" }),
            el("div", { class: "card__subtitle", text: subtitle })
          ]),
          charts.viewToggle(ministryChart)
        ]),
        el("div", { class: "card__body" }, [ministryChart])
      ]));
    } else if (mv && mv.missing) {
      chartRow.appendChild(el("div", { class: "card card--pad" }, [
        charts.emptyState(
          "No Ministry field found",
          "OM_Request_Form_Report has no field named “Ministry”. Check the " +
          "console for the fields present, then set fields.ministry in js/data.js."
        )
      ]));
    }

    /* ---- Department workload (bottleneck view) --------------------------
       Horizontal bars: three department names read at full length, and the
       list is short enough that every one gets its own colour. The bar is
       total volume; the live count rides in the tooltip, because a big
       total that is fully resolved is not a bottleneck. */
    var dw = state.omDepartment;
    if (dw && !dw.missing && dw.rows.length) {
      var deptChart = charts.responsive(function (width) {
        return charts.hBarChart(dw.rows, {
          width: width,
          rowH: 34,
          valueLabel: "OMs",
          categoryLabel: "Department",
          title: "Department workload"
        });
      });

      chartRow2.appendChild(el("div", { class: "card card--tint card--tint-amber" }, [
        el("div", { class: "card__head" }, [
          el("div", {}, [
            el("div", { class: "card__title", text: "Department workload" }),
            el("div", {
              class: "card__subtitle",
              text: Orbit.num(dw.total) + " OMs by originating department · " +
                Orbit.num(dw.totalOpen) + " still open"
            })
          ]),
          charts.viewToggle(deptChart)
        ]),
        el("div", { class: "card__body" }, [deptChart])
      ]));
    } else if (dw && dw.missing) {
      chartRow2.appendChild(el("div", { class: "card card--pad" }, [
        charts.emptyState(
          "No Originating_Department field found",
          "OM_Request_Form_Report has no field holding the originating " +
          "department. Check the console for the fields present, then set " +
          "fields.department in js/data.js."
        )
      ]));
    }

    /* ---- Overdue OMs grid ----------------------------------------------
       A list, not a chart: the question here is "which ones and who has
       them", and no chart form answers that. Rows are most-overdue first,
       which is the order someone works through them. */
    if (od) renderOverdueGrid(slots.trend, od);

    /* ---- Trend: OMs received vs closed ---------------------------------
       One y-axis: both series are counts of OMs, so they share a scale
       honestly. Two scales would manufacture a correlation that is not in
       the data.

       The two series are bucketed by DIFFERENT fields — received by the
       report's date field, closed by the closure date — so the card names
       both, and the window shrinks to 6 months on a narrow screen where 12
       points would crowd. */
    if (cl && s.series && s.series.length) {
      var trendChart = charts.responsive(function (width) {
        var months = width < 420 ? 6 : width < 620 ? 9 : 12;
        var slice = function (points) { return points.slice(-months); };

        return charts.lineChart([
          { name: "Received", cat: 0, points: slice(s.series) },
          { name: "Closed", cat: 7, points: slice(cl.series) }
        ], {
          width: width,
          height: 300,
          valueLabel: "OMs",
          categoryLabel: "Month",
          title: "OMs received vs closed"
        });
      });

      var trendRow = el("div", {
        class: "grid grid--fixed2", style: "margin-top:var(--space-8)"
      });
      slots.trend.appendChild(trendRow);

      trendRow.appendChild(el("div", {
        class: "card card--tint card--tint-blue"
      }, [
        el("div", { class: "card__head" }, [
          el("div", {}, [
            el("div", { class: "card__title", text: "Received vs closed" }),
            el("div", {
              class: "card__subtitle",
              text: "By month · received by " + (s.dateField || "date") +
                ", closed by " + (cl.dateField || "date")
            })
          ]),
          charts.viewToggle(trendChart)
        ]),
        el("div", { class: "card__body" }, [trendChart])
      ]));

      /* ---- Send back / rejection analysis ------------------------------
         Two bars rather than two pie slices: a 2-slice pie is a documented
         anti-pattern — the eye compares lengths far better than wedge
         angles, and with only two categories the ring wastes the space it
         takes. Colours come from statusChartData, so Returned and Rejected
         keep the exact hues they carry in the status donut. */
      var sb = Orbit.sendBackAnalysis(statusData, Orbit.reports.omRequests);

      if (!sb.missing) {
        var sbChart = charts.responsive(function (width) {
          return charts.hBarChart(sb.rows, {
            width: width,
            rowH: 64,
            padL: Math.round(Math.min(110, Math.max(80, width * 0.24))),
            valueLabel: "OMs",
            categoryLabel: "Outcome",
            title: "Send back and rejection"
          });
        });

        trendRow.appendChild(el("div", {
          class: "card card--tint card--tint-red card--center-body"
        }, [
          el("div", { class: "card__head" }, [
            el("div", {}, [
              el("div", { class: "card__title", text: "Sent back / rejected" }),
              el("div", {
                class: "card__subtitle",
                text: Orbit.num(sb.total) + " of " + Orbit.num(sb.grandTotal) +
                  " OMs went backwards · " + Orbit.pct(sb.share, 1) + " of all"
              })
            ]),
            charts.viewToggle(sbChart)
          ]),
          el("div", { class: "card__body" }, [sbChart])
        ]));
      }
    }


    /* ---- Data-quality notices ------------------------------------------ */
    /* Nothing is rendered on screen. The client does not want notices in
       the widget, so every one of these goes to the browser console
       instead — the information still exists for whoever maintains the
       report, it just no longer sits in front of the reader. */
    reportDataQuality(s, st, cl, od, statusData);
  }

  /* ======================================================================
     Data quality — console only

     These were on-screen banners. They are diagnostics for whoever
     maintains the Creator report, not messages for the dashboard's
     audience, so they belong in the console.
     ====================================================================== */

  function reportDataQuality(s, st, cl, od, statusData) {
    var notes = [];

    if (!s.dateField) {
      notes.push("No date field recognised — every record counted into the " +
        "total, but none could be placed in a month. Set dateField in js/data.js.");
    }

    if (s.dateField && s.undated > 0) {
      notes.push(Orbit.num(s.undated) + " of " + Orbit.num(s.total) +
        " records have no readable \"" + s.dateField +
        "\" value and are excluded from the monthly figures.");
    }

    if (cl && cl.usedFallbackField) {
      notes.push("No closure-date field found, so closed-by-month counts use \"" +
        (cl.dateField || "date") + "\" instead. Set closedDateField in js/data.js.");
    }

    if (st && st.statusField) {
      if (statusData && statusData.unlisted.length) {
        notes.push("Status values outside the configured workflow (charted " +
          "under \"Other\"): " + statusData.unlisted.join(", "));
      }
      if (st.blank > 0) {
        notes.push(Orbit.num(st.blank) + " records have no \"" +
          st.statusField + "\" value.");
      }
    }

    if (od && od.notPastDue) {
      notes.push(Orbit.num(od.notPastDue) + " records are at status Overdue " +
        "but their due date has not passed.");
    }

    if (!notes.length) return;

    console.groupCollapsed("[Orbit] data quality — " + notes.length + " note(s)");
    notes.forEach(function (n) { console.warn(n); });
    console.groupEnd();
  }

  /* ======================================================================
     Overdue OMs grid
     ====================================================================== */

  function renderOverdueGrid(host, od) {
    if (od.count === 0) {
      host.appendChild(el("div", {
        class: "card card--pad", style: "margin-top:var(--space-8)"
      }, [
        el("div", { class: "row row--3" }, [
          el("span", { class: "grid-badge grid-badge--clear" }, [icon("check", 18)]),
          el("div", {}, [
            el("div", { class: "card__title", text: "Nothing overdue" }),
            el("div", {
              class: "card__subtitle",
              text: "No OM is at status Overdue, as of " +
                Orbit.fmtDate(od.asOf) + "."
            })
          ])
        ])
      ]));
      return;
    }

    var body = el("tbody", {}, od.items.map(function (item) {
      return el("tr", {}, [
        el("td", { "data-label": "Reference No.", class: "table__strong", text: item.reference }),
        el("td", { "data-label": "Title", text: item.subject }),
        el("td", { "data-label": "Ministry", text: item.ministry }),
        el("td", { "data-label": "Current Assignee" }, [
          item.assignee === "Unassigned"
            ? el("span", { class: "badge badge--warning", text: "Unassigned" })
            : document.createTextNode(item.assignee)
        ]),
        el("td", {
          "data-label": "Due Date", class: "table__muted",
          text: item.due ? Orbit.fmtDate(item.due) : "—"
        }),
        el("td", { "data-label": "Days Overdue", class: "table__num" }, [
          el("span", { class: "age-pill", title: item.band + " past due" }, [
            el("span", { class: "age-pill__dot", style: "background:" + item.ramp }),
            document.createTextNode(Orbit.num(item.daysLate))
          ])
        ])
      ]);
    }));

    var unassigned = od.items.filter(function (i) {
      return i.assignee === "Unassigned";
    }).length;

    host.appendChild(el("div", {
      class: "card card--tint card--tint-red overdue-grid", style: "margin-top:var(--space-8)"
    }, [
      el("div", { class: "card__head" }, [
        el("div", { class: "row row--3" }, [
          el("span", { class: "grid-badge" }, [icon("alert", 18)]),
          el("div", {}, [
            el("div", { class: "card__title", text: "Overdue OMs" }),
            el("div", {
              class: "card__subtitle",
              text: Orbit.num(od.count) + " at status Overdue · oldest " +
                Orbit.num(od.oldestDays) + " days · as of " +
                Orbit.fmtDate(od.asOf) +
                (unassigned ? " · " + Orbit.num(unassigned) + " unassigned" : "")
            })
          ])
        ])
      ]),
      /* The grid scrolls inside the card rather than stretching the page —
         with a few hundred rows the page would otherwise be unusable. */
      el("div", { class: "card__body card__body--flush" }, [
        el("div", { class: "table-wrap overdue-grid__scroll" }, [
          el("table", { class: "table" }, [
            el("thead", {}, [
              el("tr", {}, [
                el("th", { text: "Reference No." }),
                el("th", { text: "Title" }),
                el("th", { text: "Ministry" }),
                el("th", { text: "Current Assignee" }),
                el("th", { text: "Due Date" }),
                el("th", { class: "table__num", text: "Days Overdue" })
              ])
            ]),
            body
          ])
        ])
      ])
    ]));
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

  /* ======================================================================
     Events
     ====================================================================== */

  function wireEvents() {
    window.addEventListener("hashchange", function () {
      activate((location.hash || "").replace("#", ""));
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
