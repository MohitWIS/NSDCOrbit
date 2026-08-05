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
        status: "Status",
        priority: "Priority",
        ministry: "Ministry",
        stage: "Stage",
        department: "Originating_Department",
        assignee: "Current_Assignee"
      },

      assigneeFieldCandidates: [
        "Current_Assignee", "Assignee", "Assigned_To", "Current_Owner",
        "Owner", "Handled_By"
      ],

      departmentFieldCandidates: [
        "Originating_Department", "Department", "Originating_Dept",
        "Origin_Department", "Dept"
      ],

      /* Known departments, listed so a department with no OMs still shows a
         zero bar — for a bottleneck view, an empty queue is information. */
      departmentOrder: ["Secretarial", "Ministry", "Audit"],

      /* Stage is a separate field from Status. Detected at runtime because
         it is not in the confirmed field list. */
      stageFieldCandidates: [
        "Stage", "OM_Stage", "Workflow_Stage", "Current_Stage", "Stage_Name"
      ],

      /* A column chart stops being readable well before every ministry can
         have its own bar, so the tail is folded into "Other" — and the fold
         is reported on screen, never silent. The table view keeps all of
         them. */
      ministryTopN: 12,

      /* Priority is not among the confirmed fields, so it is detected at
         runtime and pinned here once known. */
      priorityFieldCandidates: [
        "Priority", "Priority_Level", "OM_Priority", "Urgency",
        "Priority_Type", "Importance"
      ],

      /* Highest first — the order the bars are drawn in. Values found in
         the data but not listed here are appended in the order seen. */
      priorityOrder: ["Critical", "High", "Medium", "Low"],

      /* Statuses that count as still-live work. Compared after
         normalisation, so "In-Progress" and "IN PROGRESS" both match. */
      openStatuses: ["Open", "In Progress", "Assigned"],

      /* An OM is overdue when its due date has passed and it is not in one
         of these statuses. Only "Closed" per the stated rule — add
         "Approved" / "Rejected" here if those should also stop the clock. */
      overdueExcludeStatuses: ["Closed"],

      /* Statuses that count as closed for the "Closed this month" KPI. */
      closedStatuses: ["Closed"],

      /* Outcomes where an OM went backwards rather than through. */
      sendBackStatuses: ["Returned", "Rejected"],

      /* Governance flag: work that came back after being resolved.
         Read from STAGE, not Status — they are different fields, and the
         stage value is "Reopen" (not "Reopened"). */
      reopenedStages: ["Reopen"],

      /* Kept for the status chart's lifecycle vocabulary, which still has a
         "Reopened" status. The governance KPI no longer uses this. */
      reopenedStatuses: ["Reopened"],

      /* The date a record was CLOSED. None of the confirmed fields carries
         this, so it is detected at runtime and pinned here once known.
         Falling back to Due_Date would answer a different question — "closed
         items that were DUE this month" rather than "closed this month" — so
         the fallback is reported on screen rather than assumed. */
      closedDateField: null,
      closedDateFieldCandidates: [
        "Closed_Date", "Date_Closed", "Closure_Date", "Closed_On",
        "Completed_On", "Completion_Date", "Approved_Date",
        "Modified_Time", "Modified_On", "Last_Modified_Time"
      ],

      /* The full workflow vocabulary, in lifecycle order. Statuses are
         listed even when their count is zero — for a fixed vocabulary,
         "Overdue 0" is information, not an empty row.

         Colour is assigned per GROUP, not per status: ten separate hues
         would exceed the point where adjacent classes blur, and no
         eight-slot palette can keep ten categories apart under colour-vision
         deficiency. Identity is carried by the axis label and the value
         label on every bar; the group colour only adds lifecycle structure,
         so nothing is lost if two groups look similar to a given reader.

         Slot order here was validated on the adjacent pairlist in both
         light and dark modes. Changing the group order means re-running
         scripts/validate_palette.js. */
      statusGroups: [
        { name: "Live work", slot: 1, statuses: ["Open", "In Progress", "Assigned", "Reopened"] },
        { name: "Time-sensitive", slot: 4, statuses: ["Due", "Overdue"] },
        { name: "Closed out", slot: 3, statuses: ["Approved", "Closed"] },
        { name: "Sent back", slot: 2, statuses: ["Returned", "Rejected"] }
      ]
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

  /**
   * Build the ordered, grouped status breakdown the chart renders.
   *
   * Every configured status appears, including zeros. Any status found in
   * the data but absent from the configuration is appended in an "Other"
   * group rather than dropped — an unlisted workflow state must be visible,
   * not silently missing from the total.
   *
   * @returns {{rows: Array, groups: Array, total: number, unlisted: Array}}
   */
  function statusChartData(statusSummary, spec) {
    var groups = (spec || reports.omRequests).statusGroups || [];
    var breakdown = statusSummary.breakdown || {};

    /* Fold the raw labels onto their normalised key so "In-Progress" and
       "In Progress" become one row rather than two. */
    var counts = {};
    var seenRaw = {};
    Object.keys(breakdown).forEach(function (raw) {
      var key = normStatus(raw);
      counts[key] = (counts[key] || 0) + breakdown[raw];
      if (!seenRaw[key]) seenRaw[key] = raw;
    });

    var rows = [];
    var claimed = {};

    groups.forEach(function (group, gi) {
      group.statuses.forEach(function (label) {
        var key = normStatus(label);
        claimed[key] = true;
        rows.push({
          label: label,
          value: counts[key] || 0,
          group: group.name,
          groupIndex: gi,
          slot: group.slot,
          /* Wheel index follows the configured lifecycle order, which is
             fixed — so a status keeps its colour no matter what the data
             does. */
          cat: rows.length
        });
      });
    });

    /* Anything the configuration does not know about. */
    var unlisted = [];
    Object.keys(counts).forEach(function (key) {
      if (claimed[key]) return;
      unlisted.push(seenRaw[key]);
      rows.push({
        label: seenRaw[key],
        value: counts[key],
        group: "Other",
        groupIndex: groups.length,
        slot: 6,
        cat: rows.length
      });
    });

    var total = rows.reduce(function (sum, r) { return sum + r.value; }, 0);

    /* Groups actually represented, for the legend. */
    var legend = groups.map(function (g, gi) {
      return {
        name: g.name,
        slot: g.slot,
        value: rows.reduce(function (sum, r) {
          return sum + (r.groupIndex === gi ? r.value : 0);
        }, 0)
      };
    });

    if (unlisted.length) {
      legend.push({
        name: "Other",
        slot: 6,
        value: rows.reduce(function (sum, r) {
          return sum + (r.group === "Other" ? r.value : 0);
        }, 0)
      });
    }

    return { rows: rows, groups: legend, total: total, unlisted: unlisted };
  }

  Orbit.statusChartData = statusChartData;

  /**
   * Send-back / rejection analysis: the two outcomes where an OM went
   * backwards instead of through.
   *
   * Rows are lifted straight out of statusChartData, so each keeps the
   * SAME colour index it has in the status donut — a status that is grape
   * in one chart must not be olive in another.
   *
   * @returns {{rows, total, grandTotal, share, missing}}
   */
  function sendBackAnalysis(statusChart, spec) {
    spec = spec || reports.omRequests;

    var wanted = {};
    (spec.sendBackStatuses || []).forEach(function (label) {
      wanted[normStatus(label)] = true;
    });

    var rows = ((statusChart && statusChart.rows) || [])
      .filter(function (r) { return wanted[normStatus(r.label)]; })
      .map(function (r) {
        return { label: r.label, full: r.label, value: r.value, cat: r.cat };
      })
      .sort(function (a, b) { return b.value - a.value; });

    var total = rows.reduce(function (sum, r) { return sum + r.value; }, 0);
    var grandTotal = (statusChart && statusChart.total) || 0;

    return {
      rows: rows,
      total: total,
      grandTotal: grandTotal,
      share: grandTotal ? (total / grandTotal) * 100 : 0,
      missing: rows.length === 0
    };
  }

  Orbit.sendBackAnalysis = sendBackAnalysis;

  /**
   * Count the records carrying any of `labels`, reading the breakdown that
   * summariseByStatus already produced rather than walking the records
   * again.
   *
   * Matching is normalised, so "Re-opened" and "REOPENED" are counted with
   * "Reopened" — and `matched` reports which raw spellings were found, so a
   * drifting status value is visible instead of quietly splitting the count.
   *
   * @returns {{count:number, matched:Object, denominator:number, rate:number}}
   */
  function countStatuses(statusSummary, labels) {
    var wanted = {};
    (labels || []).forEach(function (label) {
      var key = normStatus(label);
      wanted[key] = true;
      wanted[key.replace(/ /g, "")] = true;
    });

    var breakdown = statusSummary.breakdown || {};
    var count = 0;
    var matched = {};

    Object.keys(breakdown).forEach(function (raw) {
      var key = normStatus(raw);
      if (wanted[key] || wanted[key.replace(/ /g, "")]) {
        count += breakdown[raw];
        matched[raw] = breakdown[raw];
      }
    });

    /* Records that actually carry a status — a blank cannot be "Reopened",
       and including blanks would understate the rate. */
    var denominator = Object.keys(breakdown).reduce(function (sum, raw) {
      return sum + breakdown[raw];
    }, 0);

    return {
      count: count,
      matched: matched,
      denominator: denominator,
      rate: denominator ? (count / denominator) * 100 : 0
    };
  }

  Orbit.countStatuses = countStatuses;

  /**
   * Resolve a field by testing candidates against real records. Returns the
   * field name, or null so the caller can report the gap rather than
   * charting a zero that looks like real data.
   */
  function resolveField(records, preferred, candidates, label) {
    if (!records || !records.length) return null;

    var sample = records.slice(0, 40);
    var populated = function (name) {
      var hits = 0;
      for (var i = 0; i < sample.length; i++) {
        var v = sample[i][name];
        if (v !== null && v !== undefined && String(v).trim() !== "") hits++;
      }
      return hits;
    };

    if (preferred && populated(preferred) > 0) return preferred;

    for (var c = 0; c < (candidates || []).length; c++) {
      if (populated(candidates[c]) >= Math.ceil(sample.length * 0.5)) {
        console.info("[Orbit] " + label + " field: \"" + candidates[c] + "\".");
        return candidates[c];
      }
    }

    console.warn("[Orbit] No " + label + " field found. Fields present: " +
      Object.keys(records[0]).join(", "));
    return null;
  }

  Orbit.resolveField = resolveField;

  /**
   * Count records whose `field` matches any of `labels`, comparing on the
   * normalised value so "Reopen", "re-open" and "REOPEN" all count.
   *
   * The rate is measured against records that actually carry a value —
   * a blank cannot be "Reopen", and counting blanks would understate it.
   */
  function countByField(records, field, labels) {
    var wanted = {};
    (labels || []).forEach(function (label) {
      var key = normStatus(label);
      wanted[key] = true;
      wanted[key.replace(/ /g, "")] = true;
    });

    var result = {
      count: 0, matched: {}, breakdown: {},
      blank: 0, denominator: 0, rate: 0,
      field: field, missing: !field
    };

    if (!field) return result;

    records.forEach(function (rec) {
      var raw = rec[field];
      if (raw === null || raw === undefined || String(raw).trim() === "") {
        result.blank++;
        return;
      }

      var label = String(raw).trim();
      result.breakdown[label] = (result.breakdown[label] || 0) + 1;
      result.denominator++;

      var key = normStatus(raw);
      if (wanted[key] || wanted[key.replace(/ /g, "")]) {
        result.count++;
        result.matched[label] = (result.matched[label] || 0) + 1;
      }
    });

    result.rate = result.denominator
      ? (result.count / result.denominator) * 100 : 0;

    return result;
  }

  Orbit.countByField = countByField;

  /** Which lifecycle group a status belongs to, and its colour slot. */
  function statusGroupIndex(spec) {
    var map = {};
    (spec.statusGroups || []).forEach(function (group, gi) {
      group.statuses.forEach(function (label) {
        map[normStatus(label)] = { name: group.name, slot: group.slot, order: gi };
      });
    });
    return map;
  }

  /**
   * Find the priority field by testing candidates against real records.
   * Returns null when the report has no such field, so the caller can say
   * so rather than render an empty chart.
   */
  function resolvePriorityField(records, spec) {
    if (spec.fields.priority &&
        records.length &&
        records.some(function (r) { return r[spec.fields.priority]; })) {
      return spec.fields.priority;
    }

    if (!records || !records.length) return null;
    var sample = records.slice(0, 40);

    for (var i = 0; i < spec.priorityFieldCandidates.length; i++) {
      var name = spec.priorityFieldCandidates[i];
      var hits = 0;
      for (var j = 0; j < sample.length; j++) {
        if (sample[j][name] && String(sample[j][name]).trim()) hits++;
      }
      if (hits >= Math.ceil(sample.length * 0.5)) {
        spec.fields.priority = name;
        console.info("[Orbit] priority field: \"" + name + "\" (" +
          hits + "/" + sample.length + " sampled records populated).");
        return name;
      }
    }

    console.warn("[Orbit] No priority field found. Fields present: " +
      Object.keys(records[0]).join(", "));
    return null;
  }

  Orbit.resolvePriorityField = resolvePriorityField;

  /**
   * Cross-tabulate priority against status for the stacked bar chart.
   *
   * Segments are individual statuses, as asked. Colour, however, follows the
   * lifecycle GROUP: ten stack segments per bar would need ten
   * distinguishable hues, which no palette provides and which no reader can
   * tell apart at segment size. Statuses are ordered so same-group ones sit
   * together, giving four readable colour blocks subdivided by the surface
   * gaps — with the exact status in the tooltip and the table view.
   *
   * @returns {{rows, statuses, groups, total, priorityField, missing}}
   */
  function priorityStatusMatrix(records, priorityField, statusField, spec) {
    spec = spec || reports.omRequests;
    var groupOf = statusGroupIndex(spec);

    var result = {
      rows: [], statuses: [], groups: [], total: 0,
      priorityField: priorityField, missing: !priorityField, blankPriority: 0
    };

    if (!priorityField || !statusField) return result;

    /* Collect the statuses actually present, ordered by lifecycle group so
       same-coloured segments are adjacent. */
    var statusSeen = {};
    records.forEach(function (rec) {
      var raw = rec[statusField];
      if (raw === null || raw === undefined || String(raw).trim() === "") return;
      var key = normStatus(raw);
      if (!statusSeen[key]) statusSeen[key] = String(raw).trim();
    });

    var statuses = Object.keys(statusSeen).map(function (key) {
      var g = groupOf[key] || { name: "Other", slot: 6, order: 99 };
      return { key: key, label: statusSeen[key], group: g.name, slot: g.slot, order: g.order };
    }).sort(function (a, b) {
      return a.order - b.order || a.label.localeCompare(b.label);
    });

    /* Wheel index by position in the configured status order, so a status
       shows the same colour here as in the status donut. */
    var catOf = {};
    (spec.statusGroups || []).forEach(function (group) {
      group.statuses.forEach(function (label) {
        var k = normStatus(label);
        if (!(k in catOf)) catOf[k] = Object.keys(catOf).length;
      });
    });
    statuses.forEach(function (s) {
      if (!(s.key in catOf)) catOf[s.key] = Object.keys(catOf).length;
      s.cat = catOf[s.key];
    });

    result.statuses = statuses;

    /* Priorities, configured order first then anything else as encountered */
    var priSeen = {};
    var priOrder = [];
    (spec.priorityOrder || []).forEach(function (p) {
      priSeen[normStatus(p)] = { label: p, counts: {}, total: 0 };
      priOrder.push(normStatus(p));
    });

    records.forEach(function (rec) {
      var rawP = rec[priorityField];
      var pLabel = (rawP === null || rawP === undefined || String(rawP).trim() === "")
        ? "(not set)" : String(rawP).trim();
      if (pLabel === "(not set)") result.blankPriority++;

      var pKey = normStatus(pLabel);
      if (!priSeen[pKey]) {
        priSeen[pKey] = { label: pLabel, counts: {}, total: 0 };
        priOrder.push(pKey);
      }

      var rawS = rec[statusField];
      if (rawS === null || rawS === undefined || String(rawS).trim() === "") return;

      var sKey = normStatus(rawS);
      priSeen[pKey].counts[sKey] = (priSeen[pKey].counts[sKey] || 0) + 1;
      priSeen[pKey].total++;
      result.total++;
    });

    /* Drop configured priorities that never appear, so the chart does not
       carry empty bars for values this report does not use. */
    result.rows = priOrder.map(function (key) { return priSeen[key]; })
      .filter(function (row) { return row.total > 0; })
      .map(function (row) {
        return {
          label: row.label,
          total: row.total,
          segments: statuses.map(function (s) {
            return {
              label: s.label, group: s.group, slot: s.slot, cat: s.cat,
              value: row.counts[s.key] || 0
            };
          }).filter(function (seg) { return seg.value > 0; })
        };
      });

    /* Legend: the lifecycle groups actually represented. */
    var groupTotals = {};
    result.rows.forEach(function (row) {
      row.segments.forEach(function (seg) {
        groupTotals[seg.group] = groupTotals[seg.group] || { name: seg.group, slot: seg.slot, value: 0 };
        groupTotals[seg.group].value += seg.value;
      });
    });

    result.groups = (spec.statusGroups || []).map(function (g) {
      return groupTotals[g.name];
    }).filter(Boolean);

    if (groupTotals["Other"]) result.groups.push(groupTotals["Other"]);

    return result;
  }

  Orbit.priorityStatusMatrix = priorityStatusMatrix;
  Orbit.statusGroupIndex = statusGroupIndex;

  /**
   * Shorten a ministry name for an axis label.
   *
   * "Ministry of Skill Development and Entrepreneurship" is unreadable
   * under a column, and every name starting "Ministry of" means the prefix
   * carries no information — it is the same on every bar. The full name
   * stays on the record for the tooltip and the table.
   */
  function shortenMinistry(name, maxChars) {
    var text = String(name || "").trim();
    if (!text) return "(not set)";

    text = text
      .replace(/^ministry\s+of\s+/i, "")
      .replace(/^ministry\s+/i, "")
      .replace(/^department\s+of\s+/i, "")
      .replace(/^dept\.?\s+of\s+/i, "")
      .replace(/^government\s+of\s+/i, "");

    var limit = maxChars || 16;
    if (text.length <= limit) return text;

    /* Cut on a word boundary where one is close enough to the limit. */
    var cut = text.slice(0, limit);
    var space = cut.lastIndexOf(" ");
    if (space > limit * 0.6) cut = cut.slice(0, space);
    return cut.replace(/[\s,;:-]+$/, "") + "…";
  }

  Orbit.shortenMinistry = shortenMinistry;

  /**
   * Volume of OMs per ministry, sorted descending.
   *
   * @returns {{rows, total, distinct, folded, foldedCount, ministryField}}
   */
  function ministryVolume(records, ministryField, spec) {
    spec = spec || reports.omRequests;
    var topN = spec.ministryTopN || 12;

    var result = {
      rows: [], all: [], total: 0, distinct: 0,
      folded: 0, foldedCount: 0, blank: 0,
      ministryField: ministryField, missing: !ministryField
    };

    if (!ministryField) return result;

    var counts = {};
    records.forEach(function (rec) {
      var raw = rec[ministryField];
      var label = (raw === null || raw === undefined || String(raw).trim() === "")
        ? "(not set)" : String(raw).trim();
      if (label === "(not set)") result.blank++;
      counts[label] = (counts[label] || 0) + 1;
      result.total++;
    });

    var all = Object.keys(counts).map(function (label) {
      return {
        label: shortenMinistry(label),
        full: label,
        value: counts[label]
      };
    }).sort(function (a, b) {
      /* Descending by volume; ties resolved by name so the order is stable
         between renders rather than depending on object key order. */
      return b.value - a.value || a.full.localeCompare(b.full);
    });

    result.all = all;
    result.distinct = all.length;

    if (all.length <= topN) {
      result.rows = all;
      return result;
    }

    var head = all.slice(0, topN);
    var tail = all.slice(topN);
    var tailTotal = tail.reduce(function (sum, r) { return sum + r.value; }, 0);

    result.rows = head.concat([{
      label: "Other",
      full: "Other (" + tail.length + " ministries)",
      value: tailTotal,
      isOther: true
    }]);
    result.folded = tail.length;
    result.foldedCount = tailTotal;

    console.info("[Orbit] Ministry chart shows the top " + topN + " of " +
      all.length + "; " + tail.length + " folded into \"Other\" (" +
      tailTotal + " OMs). The table view lists all of them.");

    return result;
  }

  /**
   * Fold a ranked list down to `topN` plus an "Other" residual.
   *
   * Separate from ministryVolume so the fold can be recomputed at render
   * time: a chart in a half-width column fits far fewer columns than the
   * same chart full width, and squeezing 13 rotated labels into 400px is
   * how an axis becomes unreadable.
   */
  function foldTopN(all, topN) {
    if (!all || all.length <= topN) return (all || []).slice();

    var head = all.slice(0, topN);
    var tail = all.slice(topN);
    var tailTotal = tail.reduce(function (sum, r) { return sum + r.value; }, 0);

    return head.concat([{
      label: "Other",
      full: "Other (" + tail.length + " ministries)",
      value: tailTotal,
      isOther: true,
      foldedCount: tail.length
    }]);
  }

  Orbit.foldTopN = foldTopN;
  Orbit.ministryVolume = ministryVolume;

  /**
   * Workload per originating department — the bottleneck view.
   *
   * The bar is total OMs, but a bottleneck is really about what is still
   * MOVING, so the live count travels with each row and surfaces in the
   * tooltip and the subtitle. A department with a big total and nothing
   * open is not a bottleneck; a small total that is entirely open is.
   *
   * @returns {{rows, total, totalOpen, departmentField, missing, blank}}
   */
  function departmentWorkload(records, deptField, statusField, spec) {
    spec = spec || reports.omRequests;

    var openWanted = {};
    (spec.openStatuses || []).forEach(function (label) {
      var key = normStatus(label);
      openWanted[key] = true;
      openWanted[key.replace(/ /g, "")] = true;
    });

    var result = {
      rows: [], total: 0, totalOpen: 0, blank: 0,
      departmentField: deptField, missing: !deptField
    };

    if (!deptField) return result;

    var counts = {};
    var seenRaw = {};

    /* Seed the configured departments so a quiet one still gets a row. */
    (spec.departmentOrder || []).forEach(function (label) {
      var key = normStatus(label);
      counts[key] = { total: 0, open: 0 };
      seenRaw[key] = label;
    });

    records.forEach(function (rec) {
      var raw = rec[deptField];
      var label = (raw === null || raw === undefined || String(raw).trim() === "")
        ? "(not set)" : String(raw).trim();
      if (label === "(not set)") result.blank++;

      var key = normStatus(label);
      if (!counts[key]) { counts[key] = { total: 0, open: 0 }; seenRaw[key] = label; }

      counts[key].total++;
      result.total++;

      var sKey = normStatus(statusField ? rec[statusField] : "");
      if (openWanted[sKey] || openWanted[sKey.replace(/ /g, "")]) {
        counts[key].open++;
        result.totalOpen++;
      }
    });

    result.rows = Object.keys(counts).map(function (key) {
      return {
        label: seenRaw[key],
        full: seenRaw[key],
        value: counts[key].total,
        open: counts[key].open
      };
    }).sort(function (a, b) {
      /* Busiest first; ties by name so the order is stable between renders. */
      return b.value - a.value || a.label.localeCompare(b.label);
    });

    /* Colour by rank position — few enough departments that the wheel has
       room, and the index is stable because the sort is. */
    result.rows.forEach(function (row, i) {
      row.cat = i;
      row.extra = [{ label: "Still open", value: Orbit.num(row.open) }];
    });

    return result;
  }

  Orbit.departmentWorkload = departmentWorkload;

  /**
   * Count overdue OMs: due date in the past, status not one of the excluded
   * (resolved) ones.
   *
   * "Due Date < Today" is taken strictly, against the START of today — an OM
   * due today is not yet overdue. Comparing against `new Date()` instead
   * would make an OM due today count as overdue from one minute past
   * midnight, which is wrong and moves during the day.
   *
   * Records with an unreadable due date are counted separately rather than
   * assumed current; an unparseable date is a data problem, not an on-time
   * OM.
   *
   * Also returns an ageing split, because "42 overdue" and "42 overdue, the
   * oldest by six months" call for very different responses.
   */
  function summariseOverdue(records, dateField, statusField, excludeStatuses, ref) {
    var now = ref || new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var DAY = 86400000;

    var excluded = {};
    (excludeStatuses || ["Closed"]).forEach(function (label) {
      var key = normStatus(label);
      excluded[key] = true;
      excluded[key.replace(/ /g, "")] = true;
    });

    /* Age bands are an ORDERED scale, so they carry a ramp rather than
       categorical slots — a categorical palette would imply the bands are
       unrelated identities instead of increasing severity.

       The ramp is "semantic heat" (amber → red), the one documented
       multi-hue sequential exception: here the hue shift carries meaning,
       amber reading as mild and red as serious. It ships with a scale
       legend, as that exception requires. Validated with --ordinal in both
       modes: monotone lightness, adjacent ΔL ≥ 0.06, and the step nearest
       the surface clearing 2:1. */
    var buckets = [
      { label: "1–7 days", min: 1, max: 7, value: 0, ramp: "var(--heat-1)" },
      { label: "8–30 days", min: 8, max: 30, value: 0, ramp: "var(--heat-2)" },
      { label: "31–90 days", min: 31, max: 90, value: 0, ramp: "var(--heat-3)" },
      { label: "Over 90 days", min: 91, max: Infinity, value: 0, ramp: "var(--heat-4)" }
    ];

    var result = {
      count: 0,
      undated: 0,
      resolved: 0,
      oldestDays: 0,
      totalDaysLate: 0,
      buckets: buckets,
      byStatus: {},
      items: [],
      asOf: todayStart
    };

    var f = reports.omRequests.fields;

    if (!dateField) return result;

    records.forEach(function (rec) {
      var status = statusField ? rec[statusField] : null;
      var key = normStatus(status);

      if (excluded[key] || excluded[key.replace(/ /g, "")]) {
        result.resolved++;
        return;
      }

      var due = Orbit.parseDate(rec[dateField]);
      if (!due) { result.undated++; return; }

      var dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
      if (dueStart >= todayStart) return;

      var daysLate = Math.round((todayStart - dueStart) / DAY);

      result.count++;
      result.totalDaysLate += daysLate;
      if (daysLate > result.oldestDays) result.oldestDays = daysLate;

      var label = String(status == null || String(status).trim() === ""
        ? "(no status)" : String(status).trim());
      result.byStatus[label] = (result.byStatus[label] || 0) + 1;

      var band = null;
      for (var i = 0; i < buckets.length; i++) {
        if (daysLate >= buckets[i].min && daysLate <= buckets[i].max) {
          buckets[i].value++;
          band = buckets[i];
          break;
        }
      }

      /* Keep the record itself, not just the tally — the useful question is
         "which ones", and a count alone cannot answer it. These are the
         columns the overdue grid renders. */
      result.items.push({
        number: rec[f.number] || rec.ID || "—",
        reference: rec[f.reference] || "—",
        subject: rec[f.subject] || "—",
        ministry: rec[f.ministry] || "—",
        assignee: rec[f.assignee] || "Unassigned",
        due: dueStart,
        daysLate: daysLate,
        status: label,
        band: band ? band.label : "",
        ramp: band ? band.ramp : "var(--heat-2)"
      });
    });

    /* Most overdue first — that is the order someone works through them. */
    result.items.sort(function (a, b) { return b.daysLate - a.daysLate; });

    result.averageDaysLate = result.count
      ? Math.round(result.totalDaysLate / result.count) : 0;

    return result;
  }

  Orbit.summariseOverdue = summariseOverdue;

  /**
   * Find the field carrying the closure date, testing candidates against
   * records that are actually closed (a closure date is empty on everything
   * else, so sampling the whole report would find nothing).
   *
   * Returns { field, fallback } — `fallback` true when no candidate matched
   * and the caller should use the general date field instead, which answers
   * a different question and must be said out loud.
   */
  function resolveClosedDateField(records, spec, statusField, closedStatuses) {
    if (spec.closedDateField) return { field: spec.closedDateField, fallback: false };

    var wanted = {};
    (closedStatuses || ["Closed"]).forEach(function (label) {
      var key = normStatus(label);
      wanted[key] = true;
      wanted[key.replace(/ /g, "")] = true;
    });

    var closed = [];
    for (var i = 0; i < records.length && closed.length < 40; i++) {
      var key = normStatus(statusField ? records[i][statusField] : "");
      if (wanted[key] || wanted[key.replace(/ /g, "")]) closed.push(records[i]);
    }

    if (!closed.length) return { field: null, fallback: true };

    for (var c = 0; c < spec.closedDateFieldCandidates.length; c++) {
      var name = spec.closedDateFieldCandidates[c];
      var hits = 0;
      for (var j = 0; j < closed.length; j++) {
        if (closed[j][name] && Orbit.parseDate(closed[j][name])) hits++;
      }
      /* Require most closed records to carry it — a field populated on one
         record in forty is not the closure date. */
      if (hits >= Math.ceil(closed.length * 0.5)) {
        spec.closedDateField = name;
        console.info("[Orbit] closure date field: \"" + name + "\" (" +
          hits + "/" + closed.length + " closed records parsed).");
        return { field: name, fallback: false };
      }
    }

    console.warn("[Orbit] No closure-date field found. Fields on a closed " +
      "record: " + Object.keys(closed[0]).join(", ") +
      ". Falling back to the general date field — the KPI then counts " +
      "closed OMs DUE this month, not closed this month.");

    return { field: null, fallback: true };
  }

  Orbit.resolveClosedDateField = resolveClosedDateField;

  /**
   * "Closed this month", with a month-over-month comparison.
   *
   * The current month is always partial, so the comparison is against the
   * SAME span of last month — day 1 to today's day-of-month. Comparing a
   * part-month against a complete one manufactures a decline: on the 5th it
   * would read as roughly -85% every single month, which is noise, not
   * signal. Last month's full total is returned alongside for context.
   */
  function summariseClosed(records, dateField, statusField, closedStatuses, ref) {
    var now = ref || new Date();
    var thisMonthStart = Orbit.startOfMonth(now);
    var lastMonthStart = Orbit.addMonths(thisMonthStart, -1);
    var dayOfMonth = now.getDate();
    var daysInThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    var wanted = {};
    (closedStatuses || ["Closed"]).forEach(function (label) {
      var key = normStatus(label);
      wanted[key] = true;
      wanted[key.replace(/ /g, "")] = true;
    });

    /* 12 rolling months of closures, for the sparkline */
    var series = [];
    var index = {};
    for (var i = 11; i >= 0; i--) {
      var monthStart = Orbit.addMonths(thisMonthStart, -i);
      var point = { date: monthStart, label: Orbit.fmtMonth(monthStart), value: 0 };
      index[monthStart.getFullYear() + "-" + monthStart.getMonth()] = point;
      series.push(point);
    }

    var result = {
      thisMonth: 0,
      lastMonthToDate: 0,
      lastMonthTotal: 0,
      totalClosed: 0,
      undated: 0,
      series: series,
      dateField: dateField,
      dayOfMonth: dayOfMonth,
      isPartialMonth: dayOfMonth < daysInThisMonth
    };

    if (!dateField) return result;

    records.forEach(function (rec) {
      var key = normStatus(statusField ? rec[statusField] : "");
      if (!wanted[key] && !wanted[key.replace(/ /g, "")]) return;

      result.totalClosed++;

      var d = Orbit.parseDate(rec[dateField]);
      if (!d) { result.undated++; return; }

      if (Orbit.sameMonth(d, thisMonthStart)) result.thisMonth++;

      if (Orbit.sameMonth(d, lastMonthStart)) {
        result.lastMonthTotal++;
        if (d.getDate() <= dayOfMonth) result.lastMonthToDate++;
      }

      var point = index[d.getFullYear() + "-" + d.getMonth()];
      if (point) point.value++;
    });

    /* The headline comparison is like-for-like. */
    result.delta = Orbit.delta(result.thisMonth, result.lastMonthToDate);
    result.lastMonthLabel = Orbit.fmtMonth(lastMonthStart);

    return result;
  }

  Orbit.summariseClosed = summariseClosed;

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

  /* Weighted so the leaders repeat and the tail appears once or twice —
     a flat list would make the chart a suspiciously even row of bars. */
  var MINISTRIES = [
    "Ministry of Skill Development and Entrepreneurship",
    "Ministry of Skill Development and Entrepreneurship",
    "Ministry of Skill Development and Entrepreneurship",
    "Ministry of Education",
    "Ministry of Education",
    "Ministry of Rural Development",
    "Ministry of Rural Development",
    "Ministry of Labour and Employment",
    "Ministry of Finance",
    "Ministry of Electronics and Information Technology",
    "Ministry of Housing and Urban Affairs",
    "Ministry of Women and Child Development",
    "Ministry of Micro, Small and Medium Enterprises",
    "Ministry of Textiles",
    "Ministry of Tourism",
    "Ministry of Social Justice and Empowerment",
    "Ministry of Tribal Affairs",
    "Ministry of Health and Family Welfare",
    "Ministry of Agriculture and Farmers Welfare",
    "Ministry of Heavy Industries",
    "Ministry of Ports, Shipping and Waterways",
    "Ministry of Petroleum and Natural Gas"
  ];

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
        ? ["Open", "In Progress", "In-Progress", "Assigned", "Closed",
           "Due", "Overdue", "Reopened", "Closed"]
        : back <= 3
          ? ["Open", "In Progress", "Assigned", "Approved", "Returned", "Overdue", "Closed"]
          : ["Closed", "Approved", "Closed", "Rejected", "Approved", "Returned", "Closed"];

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
          Title_Subject: "Orbit " + (seq - 4200),
          Description: "Sample description for OM " + (seq - 4200) + ".",
          Date_of_OM: fmtCreatorDate(raised),
          Due_Date: fmtCreatorDate(due),
          Memo_Type: memoTypes[(i + back) % memoTypes.length],
          Status: pool[(i + back) % pool.length],
          /* Skewed towards the middle, as real priority fields are — a flat
             split would make the stacked chart look artificially tidy. */
          Priority: ["Critical", "High", "High", "Medium", "Medium",
                     "Medium", "Medium", "Low", "Low"][(i * 3 + back) % 9],
          /* A few ministries dominate and a long tail follows, which is the
             real shape — and it exercises the top-N fold in preview. */
          Ministry: MINISTRIES[(i * 7 + back * 3) % MINISTRIES.length],
          /* Stage is its own workflow field. "Reopen" is rare, as a
             governance exception should be. */
          Stage: ["Draft", "Under Review", "With Ministry", "Approval",
                  "Reopen", "Dispatch", "Under Review", "Closure",
                  "With Ministry", "Approval"][(i * 5 + back) % 10],
          /* Uneven on purpose — a bottleneck view is pointless if every
             department carries the same load. */
          Originating_Department: ["Secretarial", "Secretarial", "Ministry",
                                   "Secretarial", "Audit", "Ministry",
                                   "Secretarial"][(i * 3 + back * 2) % 7],
          /* One in eight left unassigned — an overdue OM with no owner is
             exactly what the grid should make visible. */
          Current_Assignee: ["A. Sharma", "R. Iyer", "M. Khan", "P. Nair",
                             "S. Verma", "", "K. Reddy",
                             "N. Gupta"][(i * 5 + back * 3) % 8]
        });

        /* Closed records carry a closure date a little after the due date;
           everything else leaves it blank, exactly as the real form would. */
        var row = rows[rows.length - 1];
        if (normStatus(row.Status) === "closed") {
          var closedOn = new Date(due.getFullYear(), due.getMonth(),
            due.getDate() + 2 + (i % 9));
          if (closedOn <= now) row.Closed_Date = fmtCreatorDate(closedOn);
        }
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
