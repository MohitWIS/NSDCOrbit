/* ==========================================================================
   NSDC Orbit — data layer
   One place that knows how to talk to Creator. Everything above it receives
   plain arrays of records and never sees the SDK.
   ========================================================================== */

(function (Orbit) {
  "use strict";

  var cfg = Orbit.config;

  /* ======================================================================
     Report registry
     Each entry names the Creator report and the fields we depend on. When a
     report's real field names differ, change them HERE and nowhere else.

     `dateFieldCandidates` exists because Creator forms name their date field
     differently per app. At runtime we look at the first record and pick the
     first candidate that is actually present and parses as a date, then log
     which one won so it can be pinned in config.
     ====================================================================== */

  var reports = {
    omRequests: {
      reportName: "OM_Request_Form_Report",

      /* The field the "this month / YTD" counts are bucketed by. */
      dateField: "Due_Date",

      /* Fallbacks, used only if Due_Date is empty on every sampled record.
         Detection logs which one won. */
      dateFieldCandidates: [
        "Due_Date", "Date_of_OM", "OM_Date", "Date_field",
        "Request_Date", "Received_Date", "Submitted_On", "Added_Time"
      ],

      /* The rest of the form, for the sections that come next. */
      fields: {
        number: "OM_Number",
        reference: "Reference_No",
        subject: "Title_Subject",
        description: "Description",
        dueDate: "Due_Date",
        dateOfOM: "Date_of_OM",
        memoType: "Memo_Type",
        status: "Status"
      },

      /* Statuses that count as still-live work. Compared after
         normalisation, so "In-Progress" and "IN PROGRESS" both match. */
      openStatuses: ["Open", "In Progress", "Assigned"]
    }
  };

  Orbit.reports = reports;

  /* ======================================================================
     Creator SDK access
     ====================================================================== */

  function sdkAvailable() {
    return typeof ZOHO !== "undefined" &&
      ZOHO.CREATOR &&
      ZOHO.CREATOR.DATA &&
      typeof ZOHO.CREATOR.DATA.getRecords === "function";
  }

  Orbit.sdkAvailable = sdkAvailable;

  /**
   * Fetch every record from a report, following pagination.
   *
   * Creator returns code 3000 with data, or code 3100 ("no records") which is
   * a normal empty result, NOT an error — treating it as a rejection is how
   * dashboards end up showing a red error state for a legitimately empty
   * report.
   */
  /** Pull whatever Creator actually said out of its several error shapes. */
  function describeError(err, reportName) {
    if (!err) return "Unknown error.";

    var code = err.code || (err.responseJSON && err.responseJSON.code);
    var message = err.message ||
      (err.responseJSON && (err.responseJSON.message || err.responseJSON.description)) ||
      err.responseText || err.error || "";

    if (typeof message === "object") {
      try { message = JSON.stringify(message); } catch (e) { message = String(message); }
    }

    var text = String(message);

    /* Creator's "report not found" family — almost always a stage/scope
       problem rather than a genuinely absent report. */
    if (/report.*(not\s*found|invalid|does\s*not\s*exist)/i.test(text) ||
        code === 2945 || code === 4890) {
      return "Creator could not resolve \"" + reportName + "\" in app \"" +
        cfg.appName + "\"" +
        (Orbit.isDevEnv ? " (development stage)" : "") + ". " +
        "Check that the report link name matches exactly and that it exists in " +
        "this environment.";
    }

    return (code ? "Code " + code + ": " : "") + (text || "No detail returned.");
  }

  Orbit.describeError = describeError;

  function fetchAll(reportName, criteria) {
    var out = [];

    function page(pageNo) {
      if (pageNo > cfg.maxPages) {
        console.warn("[Orbit] Hit maxPages (" + cfg.maxPages + ") on " + reportName +
          " — showing the first " + out.length + " records.");
        return Promise.resolve(out);
      }

      var request = {
        app_name: cfg.appName,
        report_name: reportName,
        page: pageNo,
        pageSize: cfg.pageSize
      };
      if (criteria) request.criteria = criteria;

      return ZOHO.CREATOR.DATA.getRecords(request).then(function (res) {
        /* 3100 = no records matched. A valid, empty answer. */
        if (res && res.code === 3100) return out;

        if (!res || (res.code && res.code !== 3000)) {
          console.error("[Orbit] getRecords raw response for " + reportName + ":", res);
          throw new Error(describeError(res, reportName));
        }

        var batch = (res && res.data) || [];
        out = out.concat(batch);

        /* A short page means we've reached the end. */
        if (batch.length < cfg.pageSize) return out;
        return page(pageNo + 1);
      }).catch(function (err) {
        /* The SDK rejects rather than resolving on "no records" in some
           versions — recognise it and return what we have. */
        if (err && (err.code === 3100 ||
            /no\s*record/i.test(err.message || err.responseText || ""))) {
          return out;
        }
        console.error("[Orbit] getRecords rejected for " + reportName + ":", err);
        throw new Error(describeError(err, reportName));
      });
    }

    /* Never call DATA before the SDK has initialised. */
    return Orbit.ready().then(function (env) {
      if (!env.sdk) throw new Error("Creator SDK unavailable in this context.");
      return page(1);
    });
  }

  Orbit.fetchAll = fetchAll;

  /* ======================================================================
     Field detection
     ====================================================================== */

  /**
   * Work out which field carries the record's date, by testing candidates
   * against real records. Returns the field name, or null if none parse.
   */
  function resolveDateField(records, spec) {
    if (spec.dateField) return spec.dateField;
    if (!records || !records.length) return null;

    var sample = records.slice(0, 25);

    for (var i = 0; i < spec.dateFieldCandidates.length; i++) {
      var name = spec.dateFieldCandidates[i];
      var hits = 0;
      for (var j = 0; j < sample.length; j++) {
        if (sample[j][name] && Orbit.parseDate(sample[j][name])) hits++;
      }
      if (hits > 0) {
        spec.dateField = name;
        console.info("[Orbit] " + spec.reportName + ": using \"" + name +
          "\" as the date field (" + hits + "/" + sample.length + " sampled records parsed).");
        return name;
      }
    }

    /* Nothing matched — surface every key we did see, so the right one can
       be added to the candidate list. */
    console.warn("[Orbit] " + spec.reportName + ": no date field matched. " +
      "Fields present: " + Object.keys(records[0]).join(", "));
    return null;
  }

  Orbit.resolveDateField = resolveDateField;

  /* ======================================================================
     Aggregation
     ====================================================================== */

  /**
   * Bucket records into the figures the OM tile needs.
   *
   * Returns counts for this month, last month, YTD, the equivalent
   * year-ago YTD window, plus a 12-month series for the trend chart, and the
   * number of records whose date could not be parsed (surfaced in the UI —
   * a silently-dropped record is a wrong number).
   *
   * `lastMonthToDate` counts only the first N days of last month, where N is
   * today's day-of-month. The current month is always partial, so comparing
   * it against a COMPLETE previous month manufactures a large fake decline —
   * on the 4th of the month that reads as "-88%" when nothing is wrong. The
   * headline delta uses this like-for-like figure instead.
   */
  function summariseByPeriod(records, dateField, ref) {
    var now = ref || new Date();
    var thisMonthStart = Orbit.startOfMonth(now);
    var lastMonthStart = Orbit.addMonths(thisMonthStart, -1);
    var dayOfMonth = now.getDate();
    var ytdStart = Orbit.startOfYTD(now);
    var prevYtdStart = new Date(ytdStart.getFullYear() - 1, ytdStart.getMonth(), 1);
    var prevYtdEnd = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(),
      23, 59, 59);

    /* 12 rolling months, oldest first */
    var series = [];
    var index = {};
    for (var i = 11; i >= 0; i--) {
      var monthStart = Orbit.addMonths(thisMonthStart, -i);
      var key = monthStart.getFullYear() + "-" + monthStart.getMonth();
      var point = { date: monthStart, label: Orbit.fmtMonth(monthStart), value: 0 };
      index[key] = point;
      series.push(point);
    }

    var result = {
      total: records.length,
      thisMonth: 0,
      lastMonth: 0,
      ytd: 0,
      prevYtd: 0,
      undated: 0,
      series: series,
      ytdStart: ytdStart,
      dateField: dateField
    };

    if (!dateField) {
      result.undated = records.length;
      return result;
    }

    records.forEach(function (rec) {
      var d = Orbit.parseDate(rec[dateField]);
      if (!d) { result.undated++; return; }

      if (Orbit.sameMonth(d, thisMonthStart)) result.thisMonth++;
      if (Orbit.sameMonth(d, lastMonthStart)) result.lastMonth++;
      if (d >= ytdStart && d <= now) result.ytd++;
      if (d >= prevYtdStart && d <= prevYtdEnd) result.prevYtd++;

      var key = d.getFullYear() + "-" + d.getMonth();
      if (index[key]) index[key].value++;
    });

    return result;
  }

  Orbit.summariseByPeriod = summariseByPeriod;

  /**
   * Normalise a status for comparison. Creator values drift over time —
   * "In Progress", "In-Progress", "in progress", "InProgress" all occur —
   * so matching on the raw string silently undercounts.
   */
  function normStatus(value) {
    return String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/[\s_\-]+/g, " ");
  }

  /**
   * Count records by status, and total the ones that are still live.
   *
   * Returns the open count, a per-status tally for the statuses that make up
   * that total, the full breakdown, and any records whose status is blank —
   * blanks are reported rather than quietly folded into "not open", because
   * a missing status is a data problem, not a closed item.
   */
  function summariseByStatus(records, statusField, openStatuses) {
    var open = openStatuses || reports.omRequests.openStatuses;

    /* Match with and without spaces, so "InProgress" lands too. */
    var wanted = {};
    open.forEach(function (label) {
      var key = normStatus(label);
      wanted[key] = label;
      wanted[key.replace(/ /g, "")] = label;
    });

    var result = {
      open: 0,
      openBy: {},
      breakdown: {},
      blank: 0,
      statusField: statusField
    };

    open.forEach(function (label) { result.openBy[label] = 0; });

    if (!statusField) return result;

    records.forEach(function (rec) {
      var raw = rec[statusField];

      if (raw === null || raw === undefined || String(raw).trim() === "") {
        result.blank++;
        return;
      }

      var label = String(raw).trim();
      result.breakdown[label] = (result.breakdown[label] || 0) + 1;

      var key = normStatus(raw);
      var hit = wanted[key] || wanted[key.replace(/ /g, "")];
      if (hit) {
        result.open++;
        result.openBy[hit]++;
      }
    });

    return result;
  }

  Orbit.summariseByStatus = summariseByStatus;
  Orbit.normStatus = normStatus;

  /* ======================================================================
     Mock data
     Shaped like a real OM_Request_Form_Report row so the render path is
     identical whether the numbers are live or sample.
     ====================================================================== */

  /** dd-MMM-yyyy — the shape Creator hands back for a date field. */
  function fmtCreatorDate(d) {
    return String(d.getDate()).padStart(2, "0") + "-" +
      Orbit.MONTHS_SHORT[d.getMonth()] + "-" + d.getFullYear();
  }

  function buildMockOMs() {
    var rows = [];
    var now = new Date();
    var id = 4200;

    /* 18 months back, with a mild upward trend and seasonal wobble so the
       chart shows something structurally realistic. */
    for (var back = 17; back >= 0; back--) {
      var monthStart = Orbit.addMonths(Orbit.startOfMonth(now), -back);
      var base = 26 + (17 - back) * 1.6;
      var seasonal = Math.sin((monthStart.getMonth() / 12) * Math.PI * 2) * 7;
      var count = Math.max(4, Math.round(base + seasonal));

      /* The current month is only partly elapsed — scale it down so the
         "this month vs last month" delta isn't misleadingly negative. */
      if (back === 0) {
        var dayOfMonth = now.getDate();
        var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        count = Math.max(1, Math.round(count * (dayOfMonth / daysInMonth)));
      }

      var memoTypes = ["Circular", "Office Order", "Advisory", "Notification", "Clarification"];

      /* Older months are mostly settled; recent months still hold live work.
         Deliberately mixes "In-Progress" and "In Progress" so the
         normalisation path is exercised in preview. */
      var pool = back <= 1
        ? ["Open", "In Progress", "In-Progress", "Assigned", "Open", "Closed"]
        : back <= 3
          ? ["Open", "In Progress", "Assigned", "Closed", "Closed", "Completed"]
          : ["Closed", "Completed", "Closed", "Rejected", "Completed", "Closed"];

      for (var i = 0; i < count; i++) {
        var day = 1 + Math.floor((i / count) * 27);
        /* Due_Date drives the bucketing, so it is the date generated per
           month; Date_of_OM sits a week earlier, as it would in practice. */
        var due = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
        var raised = new Date(due.getFullYear(), due.getMonth(), due.getDate() - 7);
        var seq = id++;
        rows.push({
          ID: String(seq),
          OM_Number: "OM/" + due.getFullYear() + "/" + String(seq).slice(-4),
          Reference_No: "NSDC/REF/" + due.getFullYear() + "/" + String(seq).slice(-4),
          Title_Subject: "Office Memorandum " + (seq - 4200),
          Description: "Sample description for OM " + (seq - 4200) + ".",
          Date_of_OM: fmtCreatorDate(raised),
          Due_Date: fmtCreatorDate(due),
          Memo_Type: memoTypes[(i + back) % memoTypes.length],
          Status: pool[(i + back) % pool.length]
        });
      }
    }
    return rows;
  }

  /**
   * Load the OM report. Falls back to mock data when the SDK is missing
   * (local `npm start` preview) or when config.useMock is on.
   */
  function loadOMRequests() {
    var spec = reports.omRequests;

    if (cfg.useMock || !sdkAvailable()) {
      cfg.useMock = true;
      return new Promise(function (resolve) {
        /* A touch of latency so loading states are exercised in preview. */
        setTimeout(function () { resolve(buildMockOMs()); }, 420);
      });
    }

    return fetchAll(spec.reportName);
  }

  /* ======================================================================
     Diagnostics

     Run `Orbit.diagnose()` in the browser console when a report will not
     resolve. It tries the request in several shapes and prints what each
     one returned, which identifies the cause far faster than guessing:
     a wrong link name fails everywhere, an unsupported pagination argument
     fails only the paged variants, and a stage problem fails everything
     with a "not found" while the app itself is reachable.
     ====================================================================== */

  function diagnose(reportName) {
    var target = reportName || reports.omRequests.reportName;

    return Orbit.ready().then(function (env) {
      console.log("%c[Orbit] diagnostics", "font-weight:bold");
      console.log("SDK present     :", env.sdk);
      console.log("app_name        :", cfg.appName);
      console.log("report_name     :", target);
      console.log("environment     :", Orbit.isDevEnv ? "development" : "production");
      console.log("initParams      :", Orbit.initParams || "(none)");

      if (!env.sdk) {
        console.warn("No SDK — open this inside Creator, not as a bare file.");
        return null;
      }

      var attempts = [
        { name: "minimal (no paging)", cfg: { app_name: cfg.appName, report_name: target } },
        { name: "page + pageSize", cfg: { app_name: cfg.appName, report_name: target, page: 1, pageSize: 10 } },
        { name: "max_records", cfg: { app_name: cfg.appName, report_name: target, max_records: 10 } }
      ];

      var results = [];

      return attempts.reduce(function (chain, attempt) {
        return chain.then(function () {
          return ZOHO.CREATOR.DATA.getRecords(attempt.cfg).then(function (res) {
            results.push({
              attempt: attempt.name,
              outcome: "resolved",
              code: res && res.code,
              records: res && res.data ? res.data.length : 0
            });
            if (res && res.data && res.data.length) {
              console.log("[" + attempt.name + "] first record fields:",
                Object.keys(res.data[0]).join(", "));
              console.log("[" + attempt.name + "] first record:", res.data[0]);
            }
          }).catch(function (err) {
            results.push({
              attempt: attempt.name,
              outcome: "rejected",
              code: err && err.code,
              detail: describeError(err, target)
            });
            console.warn("[" + attempt.name + "] raw error:", err);
          });
        });
      }, Promise.resolve()).then(function () {
        console.table(results);
        return results;
      });
    });
  }

  Orbit.diagnose = diagnose;

  Orbit.loadOMRequests = loadOMRequests;
  Orbit.buildMockOMs = buildMockOMs;
})(window.Orbit);
