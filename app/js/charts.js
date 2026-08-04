/* ==========================================================================
   NSDC Orbit — charts
   Hand-rolled SVG. No chart library: the widget's CSP only whitelists Zoho
   hosts for connect-src, and a self-contained renderer keeps the bundle to
   files ZET can package.

   Rules enforced here (see the project's visualization standards):
     · one y-axis, never two
     · single series → one colour for every mark, never a value ramp
     · grid/axes are solid recessive hairlines, never dashed
     · 4px rounded data-ends on bars, anchored square to the baseline
     · 2px surface gap between adjacent fills instead of a stroke
     · selective direct labels only; the tooltip and table view carry the rest
     · every chart ships a table-view twin
   ========================================================================== */

(function (Orbit) {
  "use strict";

  var svgEl = Orbit.svgEl;
  var el = Orbit.el;

  /* ======================================================================
     Scales & helpers
     ====================================================================== */

  /** "Nice" axis maximum, so ticks land on readable round numbers. */
  function niceMax(value) {
    if (value <= 0) return 10;
    var exp = Math.floor(Math.log(value) / Math.LN10);
    var mag = Math.pow(10, exp);
    var norm = value / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function ticks(max, count) {
    var out = [];
    for (var i = 0; i <= count; i++) out.push((max / count) * i);
    return out;
  }

  /**
   * Rounded-top bar path: 4px radius on the data-end, square at the baseline.
   * Radius shrinks for very short bars so the shape never inverts.
   */
  function barPath(x, y, w, h, r) {
    var radius = Math.min(r === undefined ? 4 : r, w / 2, h);
    if (h <= 0.5) return "";
    return "M" + x + "," + (y + h) +
      "L" + x + "," + (y + radius) +
      "Q" + x + "," + y + " " + (x + radius) + "," + y +
      "L" + (x + w - radius) + "," + y +
      "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + radius) +
      "L" + (x + w) + "," + (y + h) + "Z";
  }

  /* ======================================================================
     Tooltip
     ====================================================================== */

  function makeTooltip(host) {
    var tip = el("div", { class: "chart-tip", role: "status", "aria-live": "polite" });
    host.appendChild(tip);

    return {
      show: function (x, y, title, rows) {
        Orbit.clear(tip);
        tip.appendChild(el("div", { class: "chart-tip__title", text: title }));
        rows.forEach(function (row) {
          tip.appendChild(el("div", { class: "chart-tip__row" }, [
            el("span", { class: "chart-tip__key" }, [
              row.color
                ? el("span", { class: "legend__swatch", style: "background:" + row.color })
                : null,
              document.createTextNode(row.label)
            ]),
            el("span", { class: "chart-tip__val", text: row.value })
          ]));
        });
        tip.style.left = x + "px";
        tip.style.top = y + "px";
        tip.classList.add("is-visible");
      },
      hide: function () { tip.classList.remove("is-visible"); }
    };
  }

  /* ======================================================================
     Sparkline — the recessive trend behind a stat tile
     ====================================================================== */

  /**
   * @param {Array<{label:string, value:number}>} points
   */
  function sparkline(points, opts) {
    opts = opts || {};
    var slot = opts.slot || 1;
    var w = 240, h = 46, pad = 3;

    var svg = svgEl("svg", {
      class: "spark",
      viewBox: "0 0 " + w + " " + h,
      preserveAspectRatio: "none",
      "aria-hidden": "true",
      focusable: "false"
    });

    if (!points || points.length < 2) return svg;

    var values = points.map(function (p) { return p.value; });
    var max = Math.max.apply(null, values);
    var min = Math.min.apply(null, values);
    var range = max - min || 1;
    var stepX = (w - pad * 2) / (points.length - 1);

    var coords = points.map(function (p, i) {
      return {
        x: pad + i * stepX,
        y: pad + (h - pad * 2) * (1 - (p.value - min) / range)
      };
    });

    var line = coords.map(function (c, i) {
      return (i ? "L" : "M") + c.x.toFixed(2) + "," + c.y.toFixed(2);
    }).join(" ");

    var area = line + " L" + coords[coords.length - 1].x.toFixed(2) + "," + h +
      " L" + coords[0].x.toFixed(2) + "," + h + " Z";

    svg.appendChild(svgEl("path", { class: "spark__area s" + slot + "-fill", d: area }));
    svg.appendChild(svgEl("path", { class: "spark__line s" + slot + "-stroke", d: line }));

    /* Mark only the latest point — one label, not twelve. */
    var last = coords[coords.length - 1];
    svg.appendChild(svgEl("circle", {
      class: "spark__end s" + slot + "-fill",
      cx: last.x, cy: last.y, r: 3
    }));

    return svg;
  }

  /* ======================================================================
     Bar chart — magnitude over time, one series
     ====================================================================== */

  /**
   * @param {Array<{label:string, value:number, date?:Date}>} data
   * @param {Object} opts  { slot, valueLabel, height, animate }
   * @returns {HTMLElement} chart container (SVG + tooltip + table twin)
   */
  function barChart(data, opts) {
    opts = opts || {};
    var slot = opts.slot || 1;
    var valueLabel = opts.valueLabel || "Value";
    var height = opts.height || 260;

    var host = el("div", { class: "chart" + (opts.animate === false ? "" : " chart--animate") });

    if (!data || !data.length) {
      host.appendChild(emptyState("No data in this period"));
      return host;
    }

    /* Geometry. The bottom band is reserved for x-axis labels so they are
       never clipped by the container height. */
    var W = 760, H = height;
    var padL = 44, padR = 12, padT = 18, padB = 34;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var maxValue = Math.max.apply(null, data.map(function (d) { return d.value; }));
    var yMax = niceMax(maxValue || 1);
    var yTicks = ticks(yMax, 4);

    /* 2px surface gap between adjacent bars, taken out of the slot width. */
    var slotW = plotW / data.length;
    var gap = 2;
    var barW = Math.max(3, Math.min(48, slotW - gap - 6));

    var svg = svgEl("svg", {
      class: "chart__svg",
      viewBox: "0 0 " + W + " " + H,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": (opts.title || valueLabel) + " — bar chart. " +
        "The same values are available in the table view."
    });

    /* --- Grid: solid hairlines, one shade off the surface --------------- */
    yTicks.forEach(function (t) {
      var y = padT + plotH * (1 - t / yMax);
      svg.appendChild(svgEl("line", {
        class: "chart__grid-line",
        x1: padL, x2: W - padR, y1: y.toFixed(1), y2: y.toFixed(1)
      }));
      svg.appendChild(svgEl("text", {
        class: "chart__tick",
        x: padL - 8, y: (y + 3.5).toFixed(1),
        "text-anchor": "end",
        text: Orbit.compact(t)
      }));
    });

    /* --- Baseline -------------------------------------------------------- */
    svg.appendChild(svgEl("line", {
      class: "chart__axis-line",
      x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH
    }));

    var tooltip = makeTooltip(host);

    /* --- Bars ------------------------------------------------------------ */
    /* One series → one colour for every bar. Never darker-where-bigger:
       that would double-encode height as hue. */
    var maxIndex = data.reduce(function (best, d, i) {
      return d.value > data[best].value ? i : best;
    }, 0);

    data.forEach(function (d, i) {
      var barH = yMax > 0 ? plotH * (d.value / yMax) : 0;
      var x = padL + i * slotW + (slotW - barW) / 2;
      var y = padT + plotH - barH;

      var path = svgEl("path", {
        class: "chart__bar s" + slot + "-fill",
        d: barPath(x, y, barW, barH),
        style: "animation-delay:" + (i * 28) + "ms"
      });
      svg.appendChild(path);

      /* Hit area spans the full slot and the whole plot height, so the
         target is far bigger than the mark itself. */
      var hit = svgEl("rect", {
        class: "chart__bar-hit",
        x: padL + i * slotW, y: padT,
        width: slotW, height: plotH,
        tabindex: "0",
        role: "button",
        "aria-label": d.label + ": " + Orbit.num(d.value) + " " + valueLabel
      });

      function enter() {
        host.classList.add("has-hover");
        path.classList.add("is-hovered");
        var rect = host.getBoundingClientRect();
        var scale = rect.width / W;
        tooltip.show(
          (x + barW / 2) * scale,
          Math.max(y * scale, 8),
          d.label,
          [{
            label: valueLabel,
            value: Orbit.num(d.value),
            color: "var(--series-" + slot + ")"
          }]
        );
      }

      function leave() {
        host.classList.remove("has-hover");
        path.classList.remove("is-hovered");
        tooltip.hide();
      }

      hit.addEventListener("mouseenter", enter);
      hit.addEventListener("mouseleave", leave);
      hit.addEventListener("focus", enter);
      hit.addEventListener("blur", leave);
      svg.appendChild(hit);

      /* --- Selective direct labels: the peak and the latest bar only ----- */
      var isLast = i === data.length - 1;
      if ((i === maxIndex || isLast) && d.value > 0 && barW >= 16) {
        svg.appendChild(svgEl("text", {
          class: "chart__label",
          x: (x + barW / 2).toFixed(1),
          y: (y - 6).toFixed(1),
          "text-anchor": "middle",
          text: Orbit.num(d.value)
        }));
      }

      /* --- X labels: thin out when crowded rather than overlapping ------- */
      var every = slotW < 34 ? Math.ceil(34 / slotW) : 1;
      if (i % every === 0 || isLast) {
        svg.appendChild(svgEl("text", {
          class: "chart__tick",
          x: (padL + i * slotW + slotW / 2).toFixed(1),
          y: padT + plotH + 18,
          "text-anchor": "middle",
          text: d.label
        }));
      }
    });

    host.appendChild(svg);

    /* --- Table view twin — the WCAG-clean equivalent --------------------- */
    host.appendChild(tableTwin(data, opts.categoryLabel || "Period", valueLabel));

    return host;
  }

  /* ======================================================================
     Table view — every chart has one
     ====================================================================== */

  function tableTwin(data, categoryLabel, valueLabel) {
    var total = data.reduce(function (sum, d) { return sum + (Number(d.value) || 0); }, 0);

    var body = el("tbody", {}, data.map(function (d) {
      return el("tr", {}, [
        el("td", { "data-label": categoryLabel, text: d.label }),
        el("td", { class: "table__num", "data-label": valueLabel, text: Orbit.num(d.value) })
      ]);
    }));

    return el("div", { class: "chart-tableview" }, [
      el("div", { class: "table-wrap" }, [
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: categoryLabel }),
              el("th", { class: "table__num", text: valueLabel })
            ])
          ]),
          body,
          el("tfoot", {}, [
            el("tr", {}, [
              el("td", { class: "table__strong", "data-label": "Total", text: "Total" }),
              el("td", {
                class: "table__num table__strong",
                "data-label": valueLabel,
                text: Orbit.num(total)
              })
            ])
          ])
        ])
      ])
    ]);
  }

  /**
   * Chart ⇄ Table switch. Returns the control; wire it to a chart container.
   */
  function viewToggle(chartHost) {
    var svg = null, table = null;

    function refs() {
      svg = chartHost.querySelector(".chart__svg");
      table = chartHost.querySelector(".chart-tableview");
    }

    function select(mode) {
      refs();
      if (!svg || !table) return;
      var showTable = mode === "table";
      svg.classList.toggle("u-hide", showTable);
      table.classList.toggle("is-visible", showTable);
      Orbit.$$(".chart-toggle__btn", control).forEach(function (b) {
        var active = b.dataset.mode === mode;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    var control = el("div", { class: "chart-toggle", role: "group", "aria-label": "Chart view" }, [
      el("button", {
        class: "chart-toggle__btn is-active", type: "button",
        dataset: { mode: "chart" }, text: "Chart",
        "aria-pressed": "true",
        onclick: function () { select("chart"); }
      }),
      el("button", {
        class: "chart-toggle__btn", type: "button",
        dataset: { mode: "table" }, text: "Table",
        "aria-pressed": "false",
        onclick: function () { select("table"); }
      })
    ]);

    return control;
  }

  /* ======================================================================
     States
     ====================================================================== */

  function emptyState(message, detail) {
    return el("div", { class: "state" }, [
      el("div", { class: "state__icon" }, [icon("inbox")]),
      el("div", { class: "state__title", text: message }),
      detail ? el("div", { class: "state__desc", text: detail }) : null
    ]);
  }

  function errorState(message, detail, onRetry) {
    return el("div", { class: "state state--error" }, [
      el("div", { class: "state__icon" }, [icon("alert")]),
      el("div", { class: "state__title", text: message }),
      detail ? el("div", { class: "state__desc", text: detail }) : null,
      onRetry ? el("button", {
        class: "btn btn--secondary btn--sm", type: "button",
        text: "Try again", onclick: onRetry
      }) : null
    ]);
  }

  function chartSkeleton(height) {
    return el("div", { class: "skeleton skeleton--chart", style: "height:" + (height || 260) + "px" });
  }

  /* ======================================================================
     Icons — inline so nothing is fetched across the CSP boundary
     ====================================================================== */

  var PATHS = {
    inbox: "M20 13h-4l-1.5 3h-5L8 13H4M4 13V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6m0 0v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4",
    alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
    doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
    trend: "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
    calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
    refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
    sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
    menu: "M3 12h18M3 6h18M3 18h18",
    check: "M20 6 9 17l-5-5",
    close: "M18 6 6 18M6 6l12 12",
    external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"
  };

  function icon(name, size) {
    var svg = svgEl("svg", {
      width: size || 18, height: size || 18, viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", "stroke-width": "1.8",
      "stroke-linecap": "round", "stroke-linejoin": "round",
      "aria-hidden": "true", focusable: "false"
    });
    svg.appendChild(svgEl("path", { d: PATHS[name] || PATHS.doc }));
    return svg;
  }

  /* ======================================================================
     Export
     ====================================================================== */

  Orbit.charts = {
    sparkline: sparkline,
    barChart: barChart,
    tableTwin: tableTwin,
    viewToggle: viewToggle,
    emptyState: emptyState,
    errorState: errorState,
    chartSkeleton: chartSkeleton,
    niceMax: niceMax
  };

  Orbit.icon = icon;
})(window.Orbit);
