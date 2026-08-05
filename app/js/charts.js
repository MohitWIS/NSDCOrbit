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
     Paint: gradients and depth

     Every gradient runs between two steps of the SAME colour, so it is
     decoration and never an encoding — a mark's hue still identifies its
     series or group exactly as the flat fill did. Gradient ids are unique
     per chart instance, because duplicate ids across SVGs in one document
     make later charts inherit the first one's paint.
     ====================================================================== */

  var paintSeq = 0;

  function ensureDefs(svg) {
    var defs = svg.querySelector("defs");
    if (!defs) {
      defs = svgEl("defs");
      svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
  }

  /**
   * A two-stop gradient of one colour.
   * @param {string} dir "v" top→bottom, "h" left→right, "d" diagonal
   */
  function paint(svg, color, dir) {
    var defs = ensureDefs(svg);
    var id = "orbit-g" + (++paintSeq);

    var coords = dir === "h"
      ? { x1: "0", y1: "0", x2: "1", y2: "0" }
      : dir === "d"
        ? { x1: "0", y1: "0", x2: "1", y2: "1" }
        : { x1: "0", y1: "0", x2: "0", y2: "1" };

    var grad = svgEl("linearGradient", {
      id: id, x1: coords.x1, y1: coords.y1, x2: coords.x2, y2: coords.y2
    });

    /* Vertical bars are lightest at the top and solid at the baseline, so
       they read as standing on the axis. Horizontal bars run the other way,
       solid at the baseline and lifting towards the data end. */
    var light = "color-mix(in srgb, " + color + " 74%, white)";
    var stops = (dir === "h")
      ? [color, light]
      : (dir === "d") ? [light, color] : [light, color];

    grad.appendChild(svgEl("stop", { offset: "0%", style: "stop-color:" + stops[0] }));
    grad.appendChild(svgEl("stop", { offset: "100%", style: "stop-color:" + stops[1] }));
    defs.appendChild(grad);

    return "url(#" + id + ")";
  }

  /** Soft drop shadow, so marks sit above the card rather than on it. */
  function softShadow(svg) {
    var defs = ensureDefs(svg);
    var id = "orbit-s" + (++paintSeq);
    var filter = svgEl("filter", {
      id: id, x: "-20%", y: "-20%", width: "140%", height: "140%"
    });
    filter.appendChild(svgEl("feDropShadow", {
      dx: "0", dy: "1", stdDeviation: "1.6",
      "flood-color": "#0d1220", "flood-opacity": "0.18"
    }));
    defs.appendChild(filter);
    return "url(#" + id + ")";
  }

  /** The CSS colour expression behind a series slot number. */
  function slotColor(slot) {
    return "var(--series-" + (slot || 1) + ")";
  }

  /** The categorical wheel: one colour per category, 12 slots, no cycling. */
  var CAT_SLOTS = 12;

  function catColor(index) {
    return "var(--cat-" + ((index % CAT_SLOTS) + 1) + ")";
  }

  /**
   * Resolve a datum's paint colour.
   *   d.ramp   — an explicit ordered-scale colour (age bands)
   *   d.cat    — a categorical wheel index (0-based)
   *   opts.colorful — colour every category by its position
   *   otherwise the chart's single series slot
   */
  function colorFor(d, i, opts, slot) {
    if (d && d.ramp) return d.ramp;
    /* A residual bucket is not a category — give it neutral grey so it
       never consumes a wheel slot, and so a 13th item cannot wrap round
       and repeat the first category's colour. */
    if (d && d.isOther) return "var(--cat-other)";
    if (d && typeof d.cat === "number") return catColor(d.cat);
    if (opts && opts.colorful) return catColor(i);
    return slotColor(slot);
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

    /* A series with no variation has no trend to draw. Rendering it anyway
       produces a flat rule pinned to one edge, which reads as a stray line
       rather than data — and an all-zero series is the common case. */
    if (max === min) return svg;

    var range = max - min;
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

    /* The area fades to nothing at the bottom, so the tile's figures are
       never read against a solid block. */
    var defs = ensureDefs(svg);
    var gid = "orbit-sp" + (++paintSeq);
    var grad = svgEl("linearGradient", { id: gid, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", {
      offset: "0%", style: "stop-color:" + slotColor(slot) + ";stop-opacity:0.42"
    }));
    grad.appendChild(svgEl("stop", {
      offset: "100%", style: "stop-color:" + slotColor(slot) + ";stop-opacity:0"
    }));
    defs.appendChild(grad);

    svg.appendChild(svgEl("path", {
      class: "spark__area", fill: "url(#" + gid + ")", d: area
    }));
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
    var W = opts.width || 760, H = height;
    /* Rotated labels need a deeper band beneath the plot. Sizing the
       container to include it is what stops the axis being clipped and the
       card growing a tiny nested scrollbar. */
    var padL = 44, padR = 12, padT = 18;
    var padB = opts.padB || (opts.rotateLabels ? 76 : 34);
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
    /* One series → one colour for every bar. The gradient runs between two
       steps of that same colour, so it adds depth without implying that a
       taller bar is a different category. Never darker-where-bigger: that
       would double-encode height as hue. */
    /* One gradient per distinct colour, built once and reused. */
    var barShadow = softShadow(svg);
    var fillCache = {};
    function fillFor(d, i) {
      var color = colorFor(d, i, opts, slot);
      if (!fillCache[color]) fillCache[color] = paint(svg, color, "v");
      return fillCache[color];
    }

    var maxIndex = data.reduce(function (best, d, i) {
      return d.value > data[best].value ? i : best;
    }, 0);

    data.forEach(function (d, i) {
      var barH = yMax > 0 ? plotH * (d.value / yMax) : 0;
      var x = padL + i * slotW + (slotW - barW) / 2;
      var y = padT + plotH - barH;

      var path = svgEl("path", {
        class: "chart__bar",
        fill: fillFor(d, i),
        filter: barShadow,
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
        "aria-label": (d.full || d.label) + ": " + Orbit.num(d.value) + " " + valueLabel
      });

      function enter() {
        host.classList.add("has-hover");
        path.classList.add("is-hovered");
        var rect = host.getBoundingClientRect();
        var scale = rect.width / W;
        tooltip.show(
          (x + barW / 2) * scale,
          Math.max(y * scale, 8),
          /* The tooltip carries the FULL name — the axis label may be
             shortened to fit, and a truncated name is not identification. */
          d.full || d.label,
          [{
            label: valueLabel,
            value: Orbit.num(d.value),
            color: colorFor(d, i, opts, slot)
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

      /* --- X labels ------------------------------------------------------
         Rotated labels never overlap, so every category can be named. Flat
         labels are thinned out when the slots get narrow, which is better
         than letting them collide. */
      var labelX = padL + i * slotW + slotW / 2;
      var labelY = padT + plotH + 18;

      if (opts.rotateLabels) {
        svg.appendChild(svgEl("text", {
          class: "chart__tick",
          x: labelX.toFixed(1),
          y: labelY,
          "text-anchor": "end",
          transform: "rotate(-38 " + labelX.toFixed(1) + " " + labelY + ")",
          text: d.label
        }));
      } else {
        var every = slotW < 34 ? Math.ceil(34 / slotW) : 1;
        if (i % every === 0 || isLast) {
          svg.appendChild(svgEl("text", {
            class: "chart__tick",
            x: labelX.toFixed(1),
            y: labelY,
            "text-anchor": "middle",
            text: d.label
          }));
        }
      }
    });

    host.appendChild(svg);

    /* --- Table view twin — the WCAG-clean equivalent ---------------------
       `tableRows` lets the table carry the complete set when the chart
       itself is capped (top-N plus "Other"), so nothing is only ever
       visible as a fold. */
    host.appendChild(tableTwin(
      opts.tableRows || data, opts.categoryLabel || "Period", valueLabel));

    return host;
  }

  /* ======================================================================
     Line chart — change over time, two or more series

     One y-axis only. Both series here are counts of OMs, so they share a
     scale honestly; two scales would invent a correlation that is not in
     the data. No area fill: with series overlapping, two translucent areas
     blend into a third colour that means nothing.
     ====================================================================== */

  /**
   * @param {Array<{name, points:[{label,value}], cat}>} series
   * @param {Object} opts { width, height, valueLabel, categoryLabel, title }
   */
  function lineChart(series, opts) {
    opts = opts || {};
    var categoryLabel = opts.categoryLabel || "Period";
    var valueLabel = opts.valueLabel || "Count";

    var host = el("div", { class: "chart chart--animate" });

    var live = (series || []).filter(function (s) {
      return s.points && s.points.length > 1;
    });

    if (!live.length) {
      host.appendChild(emptyState("Nothing to plot"));
      return host;
    }

    var W = opts.width || 760;
    var H = opts.height || 300;
    var padL = 44, padR = 18, padT = 20, padB = 34;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var count = live[0].points.length;

    /* One shared maximum across every series — the whole point of a single
       axis is that the lines are comparable. */
    var peak = 0;
    live.forEach(function (s) {
      s.points.forEach(function (p) { if (p.value > peak) peak = p.value; });
    });
    var yMax = niceMax(peak || 1);
    var yTicks = ticks(yMax, 4);

    var stepX = count > 1 ? plotW / (count - 1) : 0;
    var xAt = function (i) { return padL + i * stepX; };
    var yAt = function (v) { return padT + plotH * (1 - v / yMax); };

    var svg = svgEl("svg", {
      class: "chart__svg",
      viewBox: "0 0 " + W + " " + H,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": (opts.title || valueLabel) + " — line chart, " +
        live.length + " series over " + count + " periods. The same values " +
        "are available in the table view."
    });

    /* --- Grid: solid hairlines ------------------------------------------ */
    yTicks.forEach(function (t) {
      var y = yAt(t);
      svg.appendChild(svgEl("line", {
        class: "chart__grid-line",
        x1: padL, x2: W - padR, y1: y.toFixed(1), y2: y.toFixed(1)
      }));
      svg.appendChild(svgEl("text", {
        class: "chart__tick", x: padL - 8, y: (y + 3.5).toFixed(1),
        "text-anchor": "end", text: Orbit.compact(t)
      }));
    });

    svg.appendChild(svgEl("line", {
      class: "chart__axis-line",
      x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH
    }));

    /* --- X labels: thinned when crowded, never overlapping --------------- */
    var every = stepX < 46 ? Math.ceil(46 / Math.max(stepX, 1)) : 1;
    live[0].points.forEach(function (p, i) {
      if (i % every !== 0 && i !== count - 1) return;
      svg.appendChild(svgEl("text", {
        class: "chart__tick", x: xAt(i).toFixed(1), y: padT + plotH + 18,
        "text-anchor": "middle", text: p.label
      }));
    });

    /* --- Crosshair, drawn under the marks -------------------------------- */
    var crosshair = svgEl("line", {
      class: "chart__crosshair", x1: 0, x2: 0, y1: padT, y2: padT + plotH,
      style: "opacity:0"
    });
    svg.appendChild(crosshair);

    /* --- Lines ------------------------------------------------------------ */
    var dots = [];

    live.forEach(function (s, si) {
      var color = typeof s.cat === "number" ? catColor(s.cat) : slotColor(si + 1);

      var d = s.points.map(function (p, i) {
        return (i ? "L" : "M") + xAt(i).toFixed(2) + "," + yAt(p.value).toFixed(2);
      }).join(" ");

      /* The draw-on animation needs the path's real length; guessing it
         leaves the line either half-drawn or snapping in. */
      var len = 0;
      for (var i = 1; i < s.points.length; i++) {
        var dx = stepX;
        var dy = yAt(s.points[i].value) - yAt(s.points[i - 1].value);
        len += Math.sqrt(dx * dx + dy * dy);
      }

      svg.appendChild(svgEl("path", {
        class: "chart__line", d: d, stroke: color,
        style: "--path-len:" + Math.ceil(len) + ";animation-delay:" + (si * 160) + "ms"
      }));

      var seriesDots = s.points.map(function (p, i) {
        var dot = svgEl("circle", {
          class: "chart__dot", cx: xAt(i).toFixed(2), cy: yAt(p.value).toFixed(2),
          r: 3.5, fill: color
        });
        svg.appendChild(dot);
        return dot;
      });
      dots.push(seriesDots);

      /* Direct-label the endpoint only — one label per series, not one per
         point. */
      var last = s.points[count - 1];
      svg.appendChild(svgEl("text", {
        class: "chart__label",
        x: (xAt(count - 1) + 6).toFixed(1),
        y: (yAt(last.value) - 8).toFixed(1),
        "text-anchor": "end",
        text: Orbit.num(last.value)
      }));
    });

    /* --- Hover: one band per period, the full plot height ---------------- */
    var tooltip = makeTooltip(host);

    live[0].points.forEach(function (p, i) {
      var bandW = count > 1 ? stepX : plotW;
      var band = svgEl("rect", {
        class: "chart__bar-hit",
        x: (xAt(i) - bandW / 2).toFixed(2), y: padT,
        width: bandW.toFixed(2), height: plotH,
        tabindex: "0", role: "button",
        "aria-label": p.label + ": " + live.map(function (s) {
          return s.name + " " + Orbit.num(s.points[i].value);
        }).join(", ")
      });

      function enter() {
        crosshair.setAttribute("x1", xAt(i).toFixed(2));
        crosshair.setAttribute("x2", xAt(i).toFixed(2));
        crosshair.setAttribute("style", "opacity:1");
        dots.forEach(function (set) {
          set.forEach(function (dot, di) {
            dot.setAttribute("r", di === i ? 5.5 : 3.5);
          });
        });

        var rect = host.getBoundingClientRect();
        var scale = (rect.width || W) / W;
        var topY = Math.min.apply(null, live.map(function (s) {
          return yAt(s.points[i].value);
        }));

        tooltip.show(xAt(i) * scale, Math.max(topY * scale, 8), p.label,
          live.map(function (s, si) {
            return {
              label: s.name,
              value: Orbit.num(s.points[i].value),
              color: typeof s.cat === "number" ? catColor(s.cat) : slotColor(si + 1)
            };
          }));
      }

      function leave() {
        crosshair.setAttribute("style", "opacity:0");
        dots.forEach(function (set) {
          set.forEach(function (dot) { dot.setAttribute("r", 3.5); });
        });
        tooltip.hide();
      }

      band.addEventListener("mouseenter", enter);
      band.addEventListener("mouseleave", leave);
      band.addEventListener("focus", enter);
      band.addEventListener("blur", leave);
      svg.appendChild(band);
    });

    host.appendChild(svg);

    /* --- Legend: always present for two or more series ------------------- */
    var legend = el("div", { class: "legend" });
    live.forEach(function (s, si) {
      var total = s.points.reduce(function (sum, p) { return sum + p.value; }, 0);
      legend.appendChild(el("span", { class: "legend__item" }, [
        el("span", {
          class: "legend__swatch",
          style: "background:" + (typeof s.cat === "number" ? catColor(s.cat) : slotColor(si + 1))
        }),
        document.createTextNode(s.name),
        el("span", { class: "legend__value", text: Orbit.num(total) })
      ]));
    });
    host.appendChild(legend);

    host.appendChild(seriesTableTwin(live, categoryLabel));

    return host;
  }

  /** One row per period, one column per series. */
  function seriesTableTwin(series, categoryLabel) {
    var labels = series[0].points.map(function (p) { return p.label; });

    return el("div", { class: "chart-tableview" }, [
      el("div", { class: "table-wrap" }, [
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [el("th", { text: categoryLabel })].concat(
              series.map(function (s) {
                return el("th", { class: "table__num", text: s.name });
              })
            ))
          ]),
          el("tbody", {}, labels.map(function (label, i) {
            return el("tr", {}, [
              el("td", { "data-label": categoryLabel, text: label })
            ].concat(series.map(function (s) {
              return el("td", {
                class: "table__num", "data-label": s.name,
                text: Orbit.num(s.points[i].value)
              });
            })));
          })),
          el("tfoot", {}, [
            el("tr", {}, [
              el("td", { class: "table__strong", "data-label": "Total", text: "Total" })
            ].concat(series.map(function (s) {
              return el("td", {
                class: "table__num table__strong", "data-label": s.name,
                text: Orbit.num(s.points.reduce(function (a, p) { return a + p.value; }, 0))
              });
            })))
          ])
        ])
      ])
    ]);
  }

  /* ======================================================================
     Donut — part-to-whole at a glance

     Legal here because this is a genuine part-to-whole split (every overdue
     OM falls in exactly one age band) with four segments, inside the ≤6
     limit. Segments are separated by a surface-coloured gap rather than a
     stroke, and the hole carries the total so the headline figure is not
     lost to the geometry.
     ====================================================================== */

  function polar(cx, cy, r, angle) {
    var rad = (angle - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  /** Annular sector path between two angles. */
  function arcPath(cx, cy, rOuter, rInner, start, end) {
    /* A full circle cannot be drawn as a single arc — split it. */
    if (end - start >= 359.999) {
      return "M" + (cx - rOuter) + "," + cy +
        "A" + rOuter + "," + rOuter + " 0 1 1 " + (cx + rOuter) + "," + cy +
        "A" + rOuter + "," + rOuter + " 0 1 1 " + (cx - rOuter) + "," + cy + "Z" +
        "M" + (cx - rInner) + "," + cy +
        "A" + rInner + "," + rInner + " 0 1 0 " + (cx + rInner) + "," + cy +
        "A" + rInner + "," + rInner + " 0 1 0 " + (cx - rInner) + "," + cy + "Z";
    }

    var large = end - start > 180 ? 1 : 0;
    var o1 = polar(cx, cy, rOuter, start), o2 = polar(cx, cy, rOuter, end);
    var i2 = polar(cx, cy, rInner, end), i1 = polar(cx, cy, rInner, start);

    return "M" + o1.x.toFixed(2) + "," + o1.y.toFixed(2) +
      "A" + rOuter + "," + rOuter + " 0 " + large + " 1 " + o2.x.toFixed(2) + "," + o2.y.toFixed(2) +
      "L" + i2.x.toFixed(2) + "," + i2.y.toFixed(2) +
      "A" + rInner + "," + rInner + " 0 " + large + " 0 " + i1.x.toFixed(2) + "," + i1.y.toFixed(2) +
      "Z";
  }

  /**
   * @param {Array<{label,value,ramp?,slot?}>} data
   * @param {Object} opts { size, valueLabel, categoryLabel, centerLabel, title }
   */
  function donutChart(data, opts) {
    opts = opts || {};
    var valueLabel = opts.valueLabel || "Count";
    var categoryLabel = opts.categoryLabel || "Category";

    var host = el("div", { class: "chart chart--donut" });

    var live = (data || []).filter(function (d) { return d.value > 0; });
    var total = live.reduce(function (sum, d) { return sum + d.value; }, 0);

    if (!total) {
      host.appendChild(emptyState("Nothing to show"));
      return host;
    }

    var size = opts.size || 240;
    var cx = size / 2, cy = size / 2;
    var rOuter = size / 2 - 4;
    var rInner = rOuter * 0.62;

    /* A 2px surface gap between segments, expressed as an angle so it stays
       2px at the outer edge whatever the radius. */
    var gapDeg = Math.min(3, (2 / (2 * Math.PI * rOuter)) * 360);

    var svg = svgEl("svg", {
      class: "chart__svg",
      viewBox: "0 0 " + size + " " + size,
      width: size, height: size,
      role: "img",
      "aria-label": (opts.title || valueLabel) + " — donut chart of " +
        live.length + " segments totalling " + Orbit.num(total) +
        ". The same values are available in the table view."
    });

    var tooltip = makeTooltip(host);
    var arcShadow = softShadow(svg);
    var angle = 0;

    /* Smallest sweep that still reads as a sliver on screen. */
    var MIN_SWEEP = 0.6;

    live.forEach(function (d, i) {
      var sweep = (d.value / total) * 360;

      /* Trim each end for the surface gap — but never by so much that a
         genuine segment disappears. One record out of several hundred is a
         sub-degree wedge, and a fixed gap would erase it entirely: the band
         would hold a real count yet vanish from the chart. Cap the trim at
         a quarter of the sweep, then enforce a minimum visible angle. */
      var trim = live.length > 1 ? Math.min(gapDeg / 2, sweep * 0.25) : 0;
      var start = angle + trim;
      var end = angle + sweep - trim;

      if (end - start < MIN_SWEEP) {
        start = angle;
        end = angle + Math.max(sweep, MIN_SWEEP);
      }

      angle += sweep;

      var fill = colorFor(d, i, opts, d.slot || (i + 1));

      var seg = svgEl("path", {
        class: "chart__arc",
        d: arcPath(cx, cy, rOuter, rInner, start, end),
        fill: paint(svg, fill, "d"),
        filter: arcShadow,
        tabindex: "0",
        role: "button",
        "aria-label": d.label + ": " + Orbit.num(d.value) + " " + valueLabel +
          ", " + Orbit.pct((d.value / total) * 100, 0) + " of the total"
      });

      function enter() {
        host.classList.add("has-hover");
        seg.classList.add("is-hovered");
        var mid = polar(cx, cy, (rOuter + rInner) / 2, (start + end) / 2);
        var rect = host.getBoundingClientRect();
        var scale = (rect.width || size) / size;
        tooltip.show(mid.x * scale, mid.y * scale, d.label, [
          { label: valueLabel, value: Orbit.num(d.value), color: fill },
          { label: "Share", value: Orbit.pct((d.value / total) * 100, 0) }
        ]);
      }

      function leave() {
        host.classList.remove("has-hover");
        seg.classList.remove("is-hovered");
        tooltip.hide();
      }

      seg.addEventListener("mouseenter", enter);
      seg.addEventListener("mouseleave", leave);
      seg.addEventListener("focus", enter);
      seg.addEventListener("blur", leave);
      svg.appendChild(seg);
    });

    /* Hero figure in the hole */
    svg.appendChild(svgEl("text", {
      class: "chart__center-value",
      x: cx, y: cy + 2, text: Orbit.num(total)
    }));
    svg.appendChild(svgEl("text", {
      class: "chart__center-label",
      x: cx, y: cy + 20, text: opts.centerLabel || valueLabel
    }));

    host.appendChild(svg);

    /* Scale legend — required for a semantic-heat ramp, and it carries the
       values so nothing depends on reading the wedges. */
    var legend = el("div", { class: "legend legend--stack" });
    (data || []).forEach(function (d, i) {
      var fill = colorFor(d, i, opts, d.slot || (i + 1));
      legend.appendChild(el("span", {
        class: "legend__item" + (d.value === 0 ? " is-muted" : "")
      }, [
        el("span", { class: "legend__swatch", style: "background:" + fill }),
        el("span", { class: "legend__name", text: d.label }),
        el("span", { class: "legend__value", text: Orbit.num(d.value) }),
        el("span", {
          class: "legend__share",
          text: total ? Orbit.pct((d.value / total) * 100, 0) : "0%"
        })
      ]));
    });
    host.appendChild(legend);

    host.appendChild(tableTwin(data, categoryLabel, valueLabel));

    return host;
  }

  /* ======================================================================
     Horizontal bar chart — magnitude across named categories

     The right form when categories are nominal, numerous, or have long
     labels: labels read horizontally at full length, and the list grows
     downward without crowding. Colour groups the rows; the axis label and
     the value on every bar carry identity, so colour is redundant rather
     than load-bearing.
     ====================================================================== */

  /**
   * @param {Array<{label,value,group,slot}>} data
   * @param {Object} opts { valueLabel, categoryLabel, groups, showZeros }
   */
  function hBarChart(data, opts) {
    opts = opts || {};
    var valueLabel = opts.valueLabel || "Count";
    var categoryLabel = opts.categoryLabel || "Category";

    var host = el("div", { class: "chart chart--hbar chart--animate" });

    if (!data || !data.length) {
      host.appendChild(emptyState("Nothing to show"));
      return host;
    }

    /* Geometry: rows are a fixed height so the chart grows with the data
       instead of squeezing. */
    var W = opts.width || 760;
    var rowH = opts.rowH || 28;
    var gap = 2;                 /* 2px surface gap between adjacent bars */
    /* Label gutter tracks the column width, with a floor that still fits
       "In Progress" and a ceiling so it never dominates a wide card. */
    var padL = opts.padL || Math.round(Math.min(132, Math.max(78, W * 0.26)));
    var padR = 52;               /* room for the value label past the bar end */
    var padT = 8;
    var padB = 26;
    var plotW = W - padL - padR;
    var H = padT + data.length * rowH + padB;

    var maxValue = Math.max.apply(null, data.map(function (d) { return d.value; }));
    var xMax = niceMax(maxValue || 1);
    var xTicks = ticks(xMax, 4);

    var svg = svgEl("svg", {
      class: "chart__svg",
      viewBox: "0 0 " + W + " " + H,
      preserveAspectRatio: "xMidYMin meet",
      role: "img",
      "aria-label": (opts.title || valueLabel) +
        " — horizontal bar chart with " + data.length +
        " categories. The same values are available in the table view."
    });

    /* --- Vertical grid: solid hairlines --------------------------------- */
    xTicks.forEach(function (t) {
      var x = padL + plotW * (t / xMax);
      svg.appendChild(svgEl("line", {
        class: "chart__grid-line",
        x1: x.toFixed(1), x2: x.toFixed(1),
        y1: padT, y2: padT + data.length * rowH
      }));
      svg.appendChild(svgEl("text", {
        class: "chart__tick",
        x: x.toFixed(1), y: padT + data.length * rowH + 16,
        "text-anchor": "middle",
        text: Orbit.compact(t)
      }));
    });

    /* --- Baseline at zero ------------------------------------------------ */
    svg.appendChild(svgEl("line", {
      class: "chart__axis-line",
      x1: padL, x2: padL, y1: padT, y2: padT + data.length * rowH
    }));

    var tooltip = makeTooltip(host);
    var hbarShadow = softShadow(svg);

    /* --- Rows ------------------------------------------------------------ */
    data.forEach(function (d, i) {
      var slot = d.slot || 1;
      var barH = rowH - gap * 2 - 6;
      var y = padT + i * rowH + (rowH - barH) / 2;
      var barW = xMax > 0 ? plotW * (d.value / xMax) : 0;

      /* Category label, left of the axis */
      svg.appendChild(svgEl("text", {
        class: "chart__tick",
        x: padL - 10, y: y + barH / 2 + 4,
        "text-anchor": "end",
        text: d.label
      }));

      /* Zero rows get a stub so the row still reads as present */
      if (d.value === 0) {
        svg.appendChild(svgEl("rect", {
          class: "chart__grid-line",
          x: padL, y: y + barH / 2 - 1,
          width: 3, height: 2,
          fill: "var(--axis-line)", stroke: "none"
        }));
      } else {
        /* A row may carry an explicit ramp colour (ordered scales such as
           age bands) instead of a categorical slot. Either way the fill is
           a gradient of that one colour. */
        svg.appendChild(svgEl("path", {
          class: "chart__bar",
          fill: paint(svg, colorFor(d, i, opts, slot), "h"),
          filter: hbarShadow,
          d: hBarPath(padL, y, barW, barH),
          style: "animation-delay:" + (i * 30) + "ms"
        }));
      }

      /* Value label past the bar end — every bar, because with ten rows the
         axis alone is hard to read across and the light-mode amber needs
         the label as relief. */
      svg.appendChild(svgEl("text", {
        class: "chart__label",
        x: padL + barW + 8,
        y: y + barH / 2 + 4,
        "text-anchor": "start",
        text: Orbit.num(d.value)
      }));

      /* Hit area spans the whole row, far bigger than the bar itself */
      var hit = svgEl("rect", {
        class: "chart__bar-hit",
        x: 0, y: padT + i * rowH,
        width: W, height: rowH,
        tabindex: "0",
        role: "button",
        "aria-label": d.label + ": " + Orbit.num(d.value) + " " + valueLabel +
          (d.group ? " (" + d.group + ")" : "")
      });

      function enter() {
        host.classList.add("has-hover");
        var bar = svg.querySelectorAll(".chart__bar")[i];
        if (bar) bar.classList.add("is-hovered");
        var rect = host.getBoundingClientRect();
        var scale = rect.width / W;
        tooltip.show(
          (padL + Math.max(barW, 40) / 2) * scale,
          (y) * scale,
          d.label,
          [
            {
              label: valueLabel,
              value: Orbit.num(d.value),
              color: colorFor(d, i, opts, slot)
            },
            d.group ? { label: "Group", value: d.group } : null
          ].concat(d.extra || []).filter(Boolean)
        );
      }

      function leave() {
        host.classList.remove("has-hover");
        Orbit.$$(".chart__bar", svg).forEach(function (b) { b.classList.remove("is-hovered"); });
        tooltip.hide();
      }

      hit.addEventListener("mouseenter", enter);
      hit.addEventListener("mouseleave", leave);
      hit.addEventListener("focus", enter);
      hit.addEventListener("blur", leave);
      svg.appendChild(hit);
    });

    host.appendChild(svg);

    /* --- Legend: names the groups, never the individual statuses --------- */
    if (opts.groups && opts.groups.length) {
      var legend = el("div", { class: "legend" });
      opts.groups.forEach(function (g) {
        legend.appendChild(el("span", { class: "legend__item" }, [
          el("span", {
            class: "legend__swatch",
            style: "background:var(--series-" + g.slot + ")"
          }),
          document.createTextNode(g.name),
          el("span", { class: "legend__value", text: Orbit.num(g.value) })
        ]));
      });
      host.appendChild(legend);
    }

    host.appendChild(tableTwin(data, categoryLabel, valueLabel));

    return host;
  }

  /* ======================================================================
     Stacked horizontal bar — a breakdown within each category

     Segments are separated by a 2px surface gap rather than a stroke. Only
     the last segment in a bar gets the rounded data-end; the rest stay
     square so the stack reads as one continuous bar.
     ====================================================================== */

  /**
   * @param {Array<{label, total, segments:[{label,value,slot,group}]}>} rows
   * @param {Object} opts { width, valueLabel, categoryLabel, groups, title }
   */
  function stackedBarChart(rows, opts) {
    opts = opts || {};
    var valueLabel = opts.valueLabel || "Count";
    var categoryLabel = opts.categoryLabel || "Category";

    var host = el("div", { class: "chart chart--hbar chart--animate" });

    if (!rows || !rows.length) {
      host.appendChild(emptyState("Nothing to show"));
      return host;
    }

    var W = opts.width || 760;
    var rowH = opts.rowH || 38;
    var padL = opts.padL || Math.round(Math.min(120, Math.max(76, W * 0.22)));
    var padR = 56;
    var padT = 8;
    var padB = 26;
    var plotW = W - padL - padR;
    var H = padT + rows.length * rowH + padB;

    var maxTotal = Math.max.apply(null, rows.map(function (r) { return r.total; }));
    var xMax = niceMax(maxTotal || 1);
    var xTicks = ticks(xMax, 4);

    var svg = svgEl("svg", {
      class: "chart__svg",
      viewBox: "0 0 " + W + " " + H,
      preserveAspectRatio: "xMidYMin meet",
      role: "img",
      "aria-label": (opts.title || valueLabel) + " — stacked bar chart, " +
        rows.length + " categories. The same values are available in the " +
        "table view."
    });

    xTicks.forEach(function (t) {
      var x = padL + plotW * (t / xMax);
      svg.appendChild(svgEl("line", {
        class: "chart__grid-line",
        x1: x.toFixed(1), x2: x.toFixed(1), y1: padT, y2: padT + rows.length * rowH
      }));
      svg.appendChild(svgEl("text", {
        class: "chart__tick", x: x.toFixed(1), y: padT + rows.length * rowH + 16,
        "text-anchor": "middle", text: Orbit.compact(t)
      }));
    });

    svg.appendChild(svgEl("line", {
      class: "chart__axis-line",
      x1: padL, x2: padL, y1: padT, y2: padT + rows.length * rowH
    }));

    var tooltip = makeTooltip(host);
    var GAP = 2;
    var stackShadow = softShadow(svg);

    /* One gradient per distinct colour, reused across every bar, so the
       same status keeps the same paint in every row — and the same colour
       it has in the status donut. */
    var segPaint = {};
    function paintForSeg(seg) {
      var color = typeof seg.cat === "number"
        ? catColor(seg.cat) : slotColor(seg.slot || 1);
      if (!segPaint[color]) segPaint[color] = paint(svg, color, "h");
      return segPaint[color];
    }
    function colorOfSeg(seg) {
      return typeof seg.cat === "number"
        ? catColor(seg.cat) : slotColor(seg.slot || 1);
    }

    rows.forEach(function (row, ri) {
      var barH = rowH - 14;
      var y = padT + ri * rowH + (rowH - barH) / 2;

      svg.appendChild(svgEl("text", {
        class: "chart__tick", x: padL - 10, y: y + barH / 2 + 4,
        "text-anchor": "end", text: row.label
      }));

      var cursor = padL;

      row.segments.forEach(function (seg, si) {
        var isLast = si === row.segments.length - 1;
        var raw = plotW * (seg.value / xMax);
        /* Take the gap out of the segment, but never let it vanish. */
        var segW = Math.max(1.5, raw - (isLast ? 0 : GAP));

        var path = isLast
          ? hBarPath(cursor, y, segW, barH)
          : "M" + cursor + "," + y + "h" + segW + "v" + barH + "h" + (-segW) + "Z";

        var mark = svgEl("path", {
          class: "chart__bar",
          fill: paintForSeg(seg),
          filter: stackShadow,
          d: path,
          style: "animation-delay:" + (ri * 40 + si * 12) + "ms"
        });
        svg.appendChild(mark);

        /* Hit area covers the segment plus its gap, with a sane minimum so
           a thin segment is still reachable. */
        var hitW = Math.max(raw, 10);
        var hit = svgEl("rect", {
          class: "chart__bar-hit",
          x: cursor, y: y, width: hitW, height: barH,
          tabindex: "0", role: "button",
          "aria-label": row.label + ", " + seg.label + ": " +
            Orbit.num(seg.value) + " " + valueLabel
        });

        function enter() {
          host.classList.add("has-hover");
          mark.classList.add("is-hovered");
          var rect = host.getBoundingClientRect();
          var scale = (rect.width || W) / W;
          tooltip.show((cursor + segW / 2) * scale, y * scale, row.label, [
            { label: seg.label, value: Orbit.num(seg.value), color: colorOfSeg(seg) },
            { label: seg.group, value: Orbit.pct((seg.value / row.total) * 100, 0) + " of " + row.label }
          ]);
        }

        function leave() {
          host.classList.remove("has-hover");
          mark.classList.remove("is-hovered");
          tooltip.hide();
        }

        hit.addEventListener("mouseenter", enter);
        hit.addEventListener("mouseleave", leave);
        hit.addEventListener("focus", enter);
        hit.addEventListener("blur", leave);
        svg.appendChild(hit);

        cursor += raw;
      });

      /* Row total past the bar end */
      svg.appendChild(svgEl("text", {
        class: "chart__label",
        x: padL + plotW * (row.total / xMax) + 8,
        y: y + barH / 2 + 4,
        "text-anchor": "start",
        text: Orbit.num(row.total)
      }));
    });

    host.appendChild(svg);

    if (opts.groups && opts.groups.length) {
      var legend = el("div", { class: "legend" });
      opts.groups.forEach(function (g) {
        legend.appendChild(el("span", { class: "legend__item" }, [
          el("span", {
            class: "legend__swatch",
            style: "background:" + (typeof g.cat === "number" ? catColor(g.cat) : slotColor(g.slot))
          }),
          document.createTextNode(g.name),
          el("span", { class: "legend__value", text: Orbit.num(g.value) })
        ]));
      });
      host.appendChild(legend);
    }

    /* Table view carries the full cross-tab — every priority × status cell,
       which the chart itself can only show via the tooltip. */
    host.appendChild(stackedTableTwin(rows, opts.statuses || [], categoryLabel, valueLabel));

    return host;
  }

  /** Full cross-tab table: one row per category, one column per segment. */
  function stackedTableTwin(rows, statuses, categoryLabel, valueLabel) {
    var cols = statuses.length
      ? statuses.map(function (s) { return s.label; })
      : rows.reduce(function (acc, r) {
          r.segments.forEach(function (s) {
            if (acc.indexOf(s.label) < 0) acc.push(s.label);
          });
          return acc;
        }, []);

    return el("div", { class: "chart-tableview" }, [
      el("div", { class: "table-wrap" }, [
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [el("th", { text: categoryLabel })].concat(
              cols.map(function (c) { return el("th", { class: "table__num", text: c }); }),
              [el("th", { class: "table__num", text: "Total" })]
            ))
          ]),
          el("tbody", {}, rows.map(function (row) {
            var byLabel = {};
            row.segments.forEach(function (s) { byLabel[s.label] = s.value; });
            return el("tr", {}, [
              el("td", { "data-label": categoryLabel, class: "table__strong", text: row.label })
            ].concat(
              cols.map(function (c) {
                return el("td", {
                  class: "table__num", "data-label": c,
                  text: byLabel[c] ? Orbit.num(byLabel[c]) : "—"
                });
              }),
              [el("td", {
                class: "table__num table__strong", "data-label": "Total",
                text: Orbit.num(row.total)
              })]
            ));
          }))
        ])
      ])
    ]);
  }

  /** Rounded right end, square at the zero baseline. */
  function hBarPath(x, y, w, h, r) {
    var radius = Math.min(r === undefined ? 4 : r, h / 2, w);
    if (w <= 0.5) return "";
    return "M" + x + "," + y +
      "L" + (x + w - radius) + "," + y +
      "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + radius) +
      "L" + (x + w) + "," + (y + h - radius) +
      "Q" + (x + w) + "," + (y + h) + " " + (x + w - radius) + "," + (y + h) +
      "L" + x + "," + (y + h) + "Z";
  }

  /* ======================================================================
     Table view — every chart has one
     ====================================================================== */

  function tableTwin(data, categoryLabel, valueLabel) {
    var total = data.reduce(function (sum, d) { return sum + (Number(d.value) || 0); }, 0);

    var body = el("tbody", {}, data.map(function (d) {
      return el("tr", {}, [
        /* Full name, not the shortened axis label — the table view is the
           accessible equivalent and must not inherit a truncation. */
        el("td", { "data-label": categoryLabel, text: d.full || d.label }),
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

  /* ======================================================================
     Responsive host

     Charts draw at their container's real pixel width — one SVG unit is one
     CSS pixel — rather than scaling a fixed viewBox to fit. Scaling a fixed
     viewBox is what makes a chart in a half-width column render its 11px
     axis labels at 7px: legible at full width, unreadable beside a sibling.
     Redrawing instead keeps type, marks and padding at their intended size
     whatever the column width.
     ====================================================================== */

  function responsive(renderFn) {
    var host = el("div", { class: "chart-host" });
    host.dataset.mode = "chart";

    var lastWidth = 0;

    /* Re-apply the chart/table choice after a redraw replaces the nodes. */
    function applyMode() {
      var svg = host.querySelector(".chart__svg");
      var table = host.querySelector(".chart-tableview");
      if (!svg || !table) return;
      var showTable = host.dataset.mode === "table";
      svg.classList.toggle("u-hide", showTable);
      table.classList.toggle("is-visible", showTable);
    }

    function draw() {
      var width = Math.round(host.clientWidth);
      if (!width) return;
      /* Ignore sub-pixel churn; redraw only on a real size change. */
      if (Math.abs(width - lastWidth) < 12) return;
      lastWidth = width;
      Orbit.clear(host);
      host.appendChild(renderFn(width));
      applyMode();
    }

    host._applyMode = applyMode;
    host._redraw = function () { lastWidth = 0; draw(); };

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(draw).observe(host);
    } else {
      window.addEventListener("resize", Orbit.debounce(draw, 150));
    }

    /* First paint once the host is in the document and has a width. */
    setTimeout(draw, 0);

    return host;
  }

  /**
   * Chart ⇄ Table switch. Returns the control; wire it to a chart container
   * (either a plain chart host or a responsive one).
   */
  function viewToggle(chartHost) {
    function select(mode) {
      chartHost.dataset.mode = mode;

      if (chartHost._applyMode) {
        chartHost._applyMode();
      } else {
        var svg = chartHost.querySelector(".chart__svg");
        var table = chartHost.querySelector(".chart-tableview");
        if (svg && table) {
          svg.classList.toggle("u-hide", mode === "table");
          table.classList.toggle("is-visible", mode === "table");
        }
      }

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
    hBarChart: hBarChart,
    donutChart: donutChart,
    lineChart: lineChart,
    stackedBarChart: stackedBarChart,
    tableTwin: tableTwin,
    viewToggle: viewToggle,
    responsive: responsive,
    emptyState: emptyState,
    errorState: errorState,
    chartSkeleton: chartSkeleton,
    niceMax: niceMax
  };

  Orbit.icon = icon;
})(window.Orbit);
