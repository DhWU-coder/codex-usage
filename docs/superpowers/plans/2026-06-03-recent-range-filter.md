# Recent Range Filter Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a recent range filter to the dashboard with natural-span presets and manual `<n>天` input.

**Architecture:** Keep range resolution in the existing front-end and server-side summary paths. Add the same small date helpers to both paths so static snapshots and service API responses use matching semantics.

**Tech Stack:** Node.js `node:test`, vanilla browser JavaScript, HTML, CSS.

---

## Chunk 1: Recent Range Core

### Task 1: Server Summary Range

**Files:**
- Modify: `test/usage-core.test.js`
- Modify: `src/usage-core.js`

- [x] **Step 1: Write failing server tests**

Add tests proving `summarizeUsage` and `summarizeUsageIndex` include events inside `preset=recent` for `1个月`, `半年`, and manual `14天`, using `now` to make the date math deterministic.

- [x] **Step 2: Run the focused server test**

Run: `node --test test/usage-core.test.js`

Expected: FAIL because `recent` is currently treated as `all`.

- [x] **Step 3: Implement minimal server range helpers**

In `src/usage-core.js`, add helpers for parsing recent values, clamping month/year subtraction to the target month, and returning `{ start, end, preset: "recent" }` in both `resolveDateRange` and `indexDateRange`.

- [x] **Step 4: Re-run the focused server test**

Run: `node --test test/usage-core.test.js`

Expected: PASS.

### Task 2: Static Frontend Summary Range

**Files:**
- Modify: `test/app-summary.test.js`
- Modify: `public/app.js`

- [x] **Step 1: Write failing frontend summary test**

Add a test that imports setters from `public/app.js`, sets `preset=recent`, `recentValue=1个月`, and a fixed `now`, then verifies `summarize` filters old events out.

- [x] **Step 2: Run the focused frontend test**

Run: `node --test test/app-summary.test.js`

Expected: FAIL because front-end summary does not support `recent`.

- [x] **Step 3: Implement minimal front-end range helpers**

In `public/app.js`, add `recentValue` and `now` state support, the same recent parser/date helpers, and an exported test helper for setting filter state.

- [x] **Step 4: Re-run the focused frontend test**

Run: `node --test test/app-summary.test.js`

Expected: PASS.

## Chunk 2: Dashboard Controls

### Task 3: Recent Controls UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`

- [x] **Step 1: Add HTML controls**

Add a `最近` control group containing `#recentValue` text input and `#recentPresetSelect` select options for `1天`, `1周`, `1个月`, `3个月`, `半年`, `一年`.

- [x] **Step 2: Wire browser state**

Bind input and select changes in `bootDashboard()`, switch `state.preset` to `recent`, keep preset buttons updated, and include `recentValue` in `usageQuery()` when active.

- [x] **Step 3: Style the compound control**

Add compact CSS for the input/select pair so it wraps cleanly on small screens and matches the current toolbar styling.

- [x] **Step 4: Run full tests**

Run: `node --test`

Expected: PASS.

- [x] **Step 5: Manual browser smoke test**

Start the dashboard and verify the toolbar renders, the `最近` input/select are usable, choosing `3个月` refreshes the dashboard, and manual `14天` input updates the range.
