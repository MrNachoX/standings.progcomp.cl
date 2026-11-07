import {
  estimateProblemsNeeded,
  estimateQualifiers,
  SLOT_LABELS,
  SLOT_SHORT_LABELS,
} from "./qualification.js";

const API_BASE = "https://animeitor.naquadah.com.br/api";
const WS_BASE = "wss://animeitor.naquadah.com.br/api";
const params = new URLSearchParams(window.location.search);
const EVENT_ID = params.get("event") ?? "moj-icpc-latam-finals-2026-oficial";
// The guest contest is the official one plus CCL guest teams.
const CONTEST_ID =
  params.get("contest") ?? "The 2026 ICPC Latin America Finals with Guest Teams";
const CONTEST_PATH = `/events/${encodeURIComponent(
  EVENT_ID
)}/contests/${encodeURIComponent(CONTEST_ID)}`;
const WOMEN_DATA_URL = "women.json";
const FLAG_CDN_BASE = "https://cdn.jsdelivr.net/npm/flag-icons/flags/4x3";

const TEAM_FILTER_PARAM = "teams";
const DEFAULT_TEAM_FILTER = [];
const THEME_STORAGE_KEY = "standings-theme";
const FILTER_VISIBILITY_STORAGE_KEY = "standings-filter-hidden";
const FEED_VISIBILITY_STORAGE_KEY = "standings-feed-visible";
const FEED_SIZE = 100;

// Logins look like team<region><country><number>, e.g. teamsocl003; guest
// (CCL) teams use a "ccl" prefix instead, e.g. cclsocl001.
const LOGIN_PATTERN = /^(team|ccl)([a-z]{2})([a-z]{2})\d+$/;
const REGION_NAMES = {
  br: "Brazil",
  cb: "Caribbean",
  ca: "Central America",
  mx: "Mexico",
  no: "South America North",
  so: "South America South",
};
const COUNTRY_NAMES = {
  ag: "Antigua & Barbuda",
  ar: "Argentina",
  bo: "Bolivia",
  br: "Brazil",
  cl: "Chile",
  co: "Colombia",
  cr: "Costa Rica",
  cu: "Cuba",
  do: "Dominican Republic",
  ec: "Ecuador",
  gt: "Guatemala",
  mx: "Mexico",
  ni: "Nicaragua",
  pe: "Peru",
  pr: "Puerto Rico",
  sv: "El Salvador",
  tt: "Trinidad & Tobago",
  uy: "Uruguay",
  ve: "Venezuela",
};

const penaltyPerWrongAnswer = { value: 20 };
let problemIds = [];
let contestMeta = null;
let womenByLogin = {};
// Every official team, so qualifiers can be estimated over all of LatAm.
const teamState = new Map();
// Selected login prefixes ("teamso" for a region, "teamsocl" for a country).
// Empty means every team.
const selectedPrefixes = new Set(readListParam(TEAM_FILTER_PARAM) ?? DEFAULT_TEAM_FILTER);
const selectedWomen = new Set(
  (readListParam("women") ?? []).map(Number).filter((n) => n >= 0 && n <= 3)
);
let showQualifiers = params.get("qualify") !== "0";
let showGuests = params.get("guests") === "1";
// Open by default only where it fits beside the ranking; on small screens it
// is a drawer that would cover the page.
const WIDE_LAYOUT = window.matchMedia("(min-width: 1101px)").matches;
const storedFeed = readStorage(FEED_VISIBILITY_STORAGE_KEY);
let showFeed = storedFeed === null ? WIDE_LAYOUT : storedFeed === "true";
// Latest runs by id, for the submissions sidebar.
const recentRuns = new Map();
let lastFeedRunId = null;
let socket;
let reconnectTimer;
let clockTimer;
const RENDER_DEBOUNCE_MS = 200;
// "Problems needed" reruns the estimate many times, so it is refreshed at
// most this often and computed in small slices to keep the page responsive.
const NEEDS_REFRESH_MS = 10000;
const NEEDS_SLICE_MS = 12;
const NEEDS_MAX_EXTRA = 4;
// Wait for a pause in incoming runs so the replay after connecting is done.
const NEEDS_QUIET_MS = 600;
let needsCache = { at: 0, version: -1, checked: new Set(), needs: new Map() };
let needsJob = null;
// Bumped on every run so cached results know which scoreboard they used.
let scoreboardVersion = 0;
let lastRunAt = 0;
const contestClock = { startSeconds: 0, loadedAt: Date.now() };
let renderTimeoutId = null;
let renderQueued = false;

document.addEventListener("DOMContentLoaded", () => {
  setupThemeToggle();
  setupFilterPanel();
  setupWomenFilter();
  setupQualifyToggle();
  setupGuestToggle();
  setupFeed();
  bootstrap().catch((err) => {
    console.error(err);
    setStatus("Contest load failed", "error");
    showPlaceholder(
      "Unable to contact the contest API. Please refresh to try again."
    );
  });
});

async function bootstrap() {
  await loadContest();
  connectSocket();
}

async function fetchApi(path) {
  const response = await fetch(`${API_BASE}${CONTEST_PATH}${path}`);
  if (!response.ok) {
    throw new Error(`${path} responded with ${response.status}`);
  }
  const body = await response.json();
  return body.data;
}

async function loadContest() {
  setStatus("Fetching contest…");
  const [contest, women] = await Promise.all([
    fetchApi("/contest"),
    loadWomenData(),
  ]);

  womenByLogin = women;
  contestMeta = contest;
  penaltyPerWrongAnswer.value = Math.round((contest.penalty_seconds ?? 1200) / 60);
  problemIds = [...(contest.problems ?? [])];

  populateHero(contestMeta);
  renderHeader();
  hydrateTeams(contestMeta.teams);
  renderTeamFilter();
  requestRender(true);
}

async function loadWomenData() {
  try {
    const response = await fetch(WOMEN_DATA_URL);
    if (!response.ok) throw new Error(`women.json responded with ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn("Women data unavailable", error);
    return {};
  }
}

function populateHero(contest) {
  const contestName = document.getElementById("contest-name");
  const freezeTimeLabel = document.getElementById("freeze-time");
  const maxTimeLabel = document.getElementById("max-time");

  contestName.textContent = (contest.contest ?? "Live Contest").replace(
    / with Guest Teams$/,
    ""
  );
  freezeTimeLabel.textContent = formatMinutes(
    Math.floor((contest.score_freeze_time_seconds ?? 0) / 60)
  );

  clearInterval(clockTimer);
  contestClock.loadedAt = Date.now();
  contestClock.startSeconds = contest.time_seconds ?? 0;
  const tick = () => {
    maxTimeLabel.textContent = formatMinutes(currentMinute());
  };
  tick();
  clockTimer = setInterval(tick, 10000);
}

function currentMinute() {
  const elapsed =
    contestClock.startSeconds + (Date.now() - contestClock.loadedAt) / 1000;
  return Math.floor(elapsed / 60);
}

function hydrateTeams(teams) {
  teamState.clear();

  for (const team of Object.values(teams ?? {})) {
    const [, kind = "team", region = "", country = ""] =
      LOGIN_PATTERN.exec(team.login) ?? [];
    teamState.set(team.login, {
      login: team.login,
      name: team.nome ?? team.login,
      school: team.escola ?? "",
      guest: kind === "ccl",
      region,
      country,
      women: womenByLogin[team.login] ?? 0,
      solved: 0,
      penalty: 0,
      lastSolve: 0,
      problems: createProblemState(),
      runs: new Map(),
    });
  }
}

function createProblemState() {
  const store = {};
  for (const prob of problemIds) {
    store[prob] = {
      solved: false,
      pending: false,
      wrongAttempts: 0,
      time: 0,
    };
  }
  return store;
}

// ---------------------------------------------------------------------------
// Theme and filters

function setupThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  const update = () => {
    const isLight = document.body.dataset.theme === "light";
    toggle.textContent = isLight ? "☾" : "☀";
    toggle.setAttribute("aria-pressed", String(isLight));
  };
  update();
  toggle.addEventListener("click", () => {
    const next = document.body.dataset.theme === "light" ? "dark" : "light";
    document.body.dataset.theme = next;
    writeStorage(THEME_STORAGE_KEY, next);
    update();
  });
}

function setupFilterPanel() {
  const layout = document.getElementById("layout");
  const button = document.getElementById("filter-toggle");
  if (!layout || !button) return;

  const stored = readStorage(FILTER_VISIBILITY_STORAGE_KEY);
  let hidden =
    stored === null
      ? window.matchMedia("(max-width: 768px)").matches
      : stored === "true";
  const apply = () => {
    layout.classList.toggle("has-filters", !hidden);
    button.classList.toggle("active", !hidden);
    button.setAttribute("aria-expanded", String(!hidden));
  };
  apply();
  button.addEventListener("click", () => {
    hidden = !hidden;
    writeStorage(FILTER_VISIBILITY_STORAGE_KEY, String(hidden));
    apply();
  });

  document.getElementById("team-filter")?.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    toggleTeamPrefix(input.value, input.checked);
  });
  document.getElementById("team-filter-clear")?.addEventListener("click", () => {
    selectedPrefixes.clear();
    onTeamFilterChange();
  });
}

function renderTeamFilter() {
  const container = document.getElementById("team-filter");
  if (!container) return;

  const regions = new Map();
  for (const team of teamState.values()) {
    if (team.guest || !team.region) continue;
    if (!regions.has(team.region)) regions.set(team.region, new Map());
    const countries = regions.get(team.region);
    countries.set(team.country, (countries.get(team.country) ?? 0) + 1);
  }

  container.innerHTML = "";
  const sortedRegions = [...regions].sort(([a], [b]) =>
    regionName(a).localeCompare(regionName(b))
  );
  for (const [region, countries] of sortedRegions) {
    const regionPrefix = `team${region}`;
    const block = document.createElement("div");
    block.className = "region-block";

    const total = [...countries.values()].reduce((sum, n) => sum + n, 0);
    const regionBox = buildFilterCheckbox(
      regionPrefix,
      regionName(region),
      total,
      countries.size === 1 ? [...countries.keys()][0] : null
    );
    const countryPrefixes = [...countries.keys()].map((c) => regionPrefix + c);
    const selectedCountries = countryPrefixes.filter((p) => selectedPrefixes.has(p));
    const regionInput = regionBox.querySelector("input");
    regionInput.checked = selectedPrefixes.has(regionPrefix);
    regionInput.indeterminate =
      !regionInput.checked && selectedCountries.length > 0;
    block.appendChild(regionBox);

    // Single-country regions (Brazil, Mexico) don't need a country list.
    if (countries.size > 1) {
      const chips = document.createElement("div");
      chips.className = "country-list";
      const sortedCountries = [...countries].sort(([a], [b]) =>
        countryName(a).localeCompare(countryName(b))
      );
      for (const [country, count] of sortedCountries) {
        const box = buildFilterCheckbox(
          regionPrefix + country,
          countryName(country),
          count,
          country
        );
        box.querySelector("input").checked =
          regionInput.checked || selectedPrefixes.has(regionPrefix + country);
        chips.appendChild(box);
      }
      block.appendChild(chips);
    }

    container.appendChild(block);
  }
}

function buildFilterCheckbox(value, text, count, flagCode) {
  const label = document.createElement("label");
  label.className = "filter-checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = value;
  label.appendChild(input);
  if (flagCode) {
    const flag = createFlagElement(flagCode);
    if (flag) label.appendChild(flag);
  }
  const span = document.createElement("span");
  span.textContent = text;
  const countSpan = document.createElement("span");
  countSpan.className = "filter-count";
  countSpan.textContent = count;
  label.append(span, countSpan);
  return label;
}

function toggleTeamPrefix(prefix, checked) {
  const isRegion = prefix.length === "team".length + 2;
  const regionPrefix = prefix.slice(0, "team".length + 2);
  const countryPrefixes = [
    ...new Set(
      [...teamState.values()]
        .filter((team) => !team.guest && teamPrefix(team).startsWith(regionPrefix))
        .map(teamPrefix)
    ),
  ];

  if (isRegion) {
    for (const p of countryPrefixes) selectedPrefixes.delete(p);
    if (checked) selectedPrefixes.add(regionPrefix);
    else selectedPrefixes.delete(regionPrefix);
  } else {
    // Unchecking one country of a fully selected region expands the region
    // into its remaining countries.
    if (selectedPrefixes.has(regionPrefix)) {
      selectedPrefixes.delete(regionPrefix);
      for (const p of countryPrefixes) selectedPrefixes.add(p);
    }
    if (checked) selectedPrefixes.add(prefix);
    else selectedPrefixes.delete(prefix);
    if (countryPrefixes.every((p) => selectedPrefixes.has(p))) {
      for (const p of countryPrefixes) selectedPrefixes.delete(p);
      selectedPrefixes.add(regionPrefix);
    }
  }
  onTeamFilterChange();
}

function onTeamFilterChange() {
  writeUrlParam(TEAM_FILTER_PARAM, [...selectedPrefixes].join(","));
  renderTeamFilter();
  requestRender(true);
}

function setupWomenFilter() {
  const container = document.getElementById("women-filter");
  if (!container) return;
  for (const input of container.querySelectorAll("input")) {
    input.checked = selectedWomen.has(Number(input.value));
  }
  container.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const value = Number(input.value);
    if (input.checked) selectedWomen.add(value);
    else selectedWomen.delete(value);
    writeUrlParam("women", [...selectedWomen].sort().join(","));
    requestRender(true);
  });
}

function setupGuestToggle() {
  const checkbox = document.getElementById("guest-toggle");
  if (!checkbox) return;
  checkbox.checked = showGuests;
  checkbox.addEventListener("change", () => {
    showGuests = checkbox.checked;
    writeUrlParam("guests", showGuests ? "1" : "");
    requestRender(true);
  });
}

function setupFeed() {
  const toggle = document.getElementById("feed-toggle");
  const close = document.getElementById("feed-close");
  const apply = () => {
    document.getElementById("layout")?.classList.toggle("has-feed", showFeed);
    toggle?.setAttribute("aria-expanded", String(showFeed));
    toggle?.classList.toggle("active", showFeed);
  };
  const set = (visible) => {
    showFeed = visible;
    writeStorage(FEED_VISIBILITY_STORAGE_KEY, String(visible));
    apply();
    renderFeed();
  };
  apply();
  toggle?.addEventListener("click", () => set(!showFeed));
  close?.addEventListener("click", () => set(false));
}

function setupQualifyToggle() {
  const checkbox = document.getElementById("qualify-toggle");
  if (!checkbox) return;
  checkbox.checked = showQualifiers;
  checkbox.addEventListener("change", () => {
    showQualifiers = checkbox.checked;
    writeUrlParam("qualify", showQualifiers ? "" : "0");
    renderHeader();
    requestRender(true);
  });
}

// Region/country filter values use the official "team<region><country>"
// prefix; guests are matched by their region and country too.
function teamPrefix(team) {
  return `team${team.region}${team.country}`;
}

function isTeamSelected(team) {
  if (team.guest && !showGuests) return false;
  if (!selectedPrefixes.size) return true;
  const prefix = teamPrefix(team);
  for (const selected of selectedPrefixes) {
    if (prefix.startsWith(selected)) return true;
  }
  return false;
}

function isWomenSelected(team) {
  return !selectedWomen.size || selectedWomen.has(Math.min(team.women, 3));
}

// ---------------------------------------------------------------------------
// Rendering

function renderHeader() {
  const headerRow = document.getElementById("standings-header");
  headerRow.innerHTML = "";

  const baseHeadings = [
    ["#", "Position within the selected regions/countries"],
    ["Team"],
    ...(showQualifiers
      ? [
          ["LA", "Position in Latin America", "col-latam"],
          ["Slot", "Estimated qualification slot", "col-slot"],
        ]
      : []),
    ["♀", "Women on the team", "col-women"],
    ["AC", "Problems solved", "col-solved"],
    ["Pen", "Penalty (minutes)", "col-penalty"],
  ];
  for (const [title, tooltip, className] of baseHeadings) {
    const th = document.createElement("th");
    th.textContent = title;
    if (tooltip) th.title = tooltip;
    if (className) th.className = className;
    headerRow.appendChild(th);
  }
  for (const prob of problemIds) {
    const th = document.createElement("th");
    th.textContent = prob;
    th.className = "col-problem";
    headerRow.appendChild(th);
  }
}

function renderStandings() {
  const tbody = document.getElementById("standings-body");
  tbody.innerHTML = "";

  if (!teamState.size) {
    showPlaceholder("Waiting for team list…");
    return;
  }

  const sorted = [...teamState.values()].sort(compareTeams);
  // Guests are listed among official teams but never take a position.
  const ranked = sorted.filter((team) => !team.guest);
  const latamRank = new Map(ranked.map((team, index) => [team.login, index + 1]));
  const qualifiers = showQualifiers
    ? estimateQualifiers(ranked, { regionName, countryName })
    : new Map();

  // Rank within the selected regions/countries; the women filter only hides
  // rows so positions stay comparable.
  let position = 0;
  const teams = sorted
    .filter(isTeamSelected)
    .map((team) => ({ team, rank: team.guest ? null : ++position }))
    .filter(({ team }) => isWomenSelected(team));

  if (!teams.length) {
    showPlaceholder("No teams match the current filters.");
    return;
  }

  const needs = showQualifiers
    ? problemsNeeded(
        ranked,
        qualifiers,
        teams.map(({ team }) => team).filter((team) => !team.guest)
      )
    : new Map();

  const fragment = document.createDocumentFragment();
  for (const { team, rank } of teams) {
    const tr = document.createElement("tr");
    if (team.guest) tr.classList.add("guest");

    appendCell(tr, "col-rank", rank ?? "—");
    tr.appendChild(buildTeamCell(team));

    if (showQualifiers) {
      appendCell(tr, "col-latam", latamRank.get(team.login) ?? "—");
      const { slot, detail } = qualifiers.get(team.login) ?? {};
      if (slot) tr.classList.add("qualified");
      const slotCell = appendCell(
        tr,
        "col-slot",
        slot ? SLOT_SHORT_LABELS[slot] ?? slot : "—"
      );
      if (slot) {
        slotCell.title = `${SLOT_LABELS[slot] ?? slot} (estimate)\n${detail}`;
        boldWomenSymbols(slotCell);
      } else if (needs.has(team.login)) {
        const need = needs.get(team.login);
        slotCell.textContent = `${need.extra} more`;
        slotCell.classList.add("need");
        slotCell.title = describeNeed(need);
      } else if (!team.guest && needsCache.checked.has(team.login)) {
        slotCell.title = `Not in the estimate even with ${NEEDS_MAX_EXTRA} more problems.`;
      }
    }

    tr.appendChild(buildWomenCell(team.women));
    appendCell(tr, "col-solved", team.solved);
    appendCell(tr, "col-penalty", team.penalty);

    for (const prob of problemIds) {
      tr.appendChild(buildProblemCell(team.problems[prob]));
    }

    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);
}

function appendCell(row, className, value) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = value;
  row.appendChild(td);
  return td;
}

function buildTeamCell(team) {
  const td = document.createElement("td");
  td.className = "col-team";
  td.title = `${team.name} — ${team.school}`;

  const line = document.createElement("div");
  line.className = "team-line";
  const flag = createFlagElement(team.country);
  if (flag) line.appendChild(flag);
  const name = document.createElement("p");
  name.className = "team-name";
  name.textContent = team.name;
  line.appendChild(name);
  if (team.guest) {
    const tag = document.createElement("span");
    tag.className = "guest-tag";
    tag.textContent = "Guest";
    line.appendChild(tag);
  }

  const school = document.createElement("p");
  school.className = "team-school";
  school.textContent = team.school;

  td.append(line, school);
  return td;
}

// Flags are background images rather than <img>: the table is rebuilt on
// every update, and a cached background paints immediately while a new
// lazy <img> flashes empty first.
function createFlagElement(countryCode) {
  if (!/^[a-z]{2}$/.test(countryCode ?? "")) return null;
  const flag = document.createElement("span");
  flag.className = "team-flag";
  flag.style.backgroundImage = `url("${FLAG_CDN_BASE}/${countryCode}.svg")`;
  flag.setAttribute("role", "img");
  flag.setAttribute("aria-label", countryName(countryCode));
  flag.title = countryName(countryCode);
  return flag;
}

// Returns the latest finished results and starts a background refresh when
// they are stale or miss some of the shown teams.
function problemsNeeded(ranked, qualifiers, candidates) {
  const changed = needsCache.version !== scoreboardVersion;
  const stale =
    changed &&
    (needsCache.version <= 0 || Date.now() - needsCache.at > NEEDS_REFRESH_MS);
  const missing = candidates.some((team) => !needsCache.checked.has(team.login));
  if ((stale || missing) && !needsJob && scoreboardVersion > 0) {
    const quietFor = Date.now() - lastRunAt;
    if (quietFor < NEEDS_QUIET_MS) {
      setTimeout(() => requestRender(), NEEDS_QUIET_MS - quietFor + 50);
    } else {
      startNeedsJob(ranked, qualifiers, candidates);
    }
  }
  // Results from an empty scoreboard would be meaningless.
  return needsCache.version > 0 ? needsCache.needs : new Map();
}

function startNeedsJob(ranked, qualifiers, candidates) {
  // Snapshot the teams: runs keep arriving while the job is in progress.
  const snapshot = ranked.map((team) => ({
    ...team,
    problems: Object.fromEntries(
      Object.entries(team.problems).map(([id, problem]) => [id, { ...problem }])
    ),
  }));
  const byLogin = new Map(snapshot.map((team) => [team.login, team]));
  const queue = candidates
    .map((team) => byLogin.get(team.login))
    .filter((team) => team && !qualifiers.has(team.login));
  const options = {
    minute: currentMinute(),
    maxExtra: NEEDS_MAX_EXTRA,
    wrongPenalty: penaltyPerWrongAnswer.value,
    compare: compareTeams,
    names: { regionName, countryName },
  };
  const needs = new Map();
  const version = scoreboardVersion;
  needsJob = true;

  const step = () => {
    const deadline = performance.now() + NEEDS_SLICE_MS;
    while (queue.length && performance.now() < deadline) {
      const team = queue.shift();
      const need = estimateProblemsNeeded(team, snapshot, qualifiers, options);
      if (need) needs.set(team.login, need);
    }
    if (queue.length) {
      setTimeout(step, 0);
      return;
    }
    needsCache = {
      at: Date.now(),
      version,
      checked: new Set(candidates.map((team) => team.login)),
      needs,
    };
    needsJob = null;
    requestRender();
  };
  setTimeout(step, 0);
}

function describeNeed(need) {
  const problems = need.extra === 1 ? "1 more problem" : `${need.extra} more problems`;
  const lines = [
    `Needs ${problems} (estimate).`,
    `Solving ${need.extra === 1 ? "it" : "them"} now, at minute ` +
      `${currentMinute()}, would leave a penalty of ${need.penalty} and put ` +
      `this team in: ${SLOT_LABELS[need.slot] ?? need.slot}.`,
    need.detail,
  ];
  if (need.displaced.length) {
    lines.push(
      `It would push out: ${need.displaced.map((team) => team.name).join(", ")}.`
    );
  }
  lines.push("Assumes the other teams don't change.");
  return lines.join("\n");
}

// Wrap each run of ♀ so it gets the bold styling of .women-symbol.
function boldWomenSymbols(element) {
  const parts = element.textContent.split(/(♀+)/);
  element.textContent = "";
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("♀")) {
      const span = document.createElement("span");
      span.className = "women-symbol";
      span.textContent = part;
      element.appendChild(span);
    } else {
      element.append(part);
    }
  }
}

function buildWomenCell(count) {
  const td = document.createElement("td");
  td.className = "col-women";
  if (count > 0) {
    td.textContent = count === 3 ? "♀3" : "♀".repeat(count);
    td.title = count === 3 ? "All-women team" : count === 1 ? "1 woman" : `${count} women`;
    if (count === 3) td.classList.add("all-women");
  } else {
    td.textContent = "—";
    td.classList.add("none");
  }
  return td;
}

function buildProblemCell(problem = {}) {
  const td = document.createElement("td");
  td.classList.add("problem-cell");

  // Solve minute only, plus failed tries when there were any; details go in
  // the tooltip to keep the 13 problem columns narrow.
  const tries = problem.wrongAttempts;
  const triesText = `${tries} wrong ${tries === 1 ? "try" : "tries"}`;
  if (problem.solved) {
    td.classList.add("solved");
    td.textContent = problem.time;
    if (tries > 0) {
      const span = document.createElement("span");
      span.textContent = `+${tries}`;
      td.appendChild(span);
    }
    td.title = `Solved at ${formatMinutes(problem.time)}, ${triesText}`;
  } else if (problem.pending) {
    td.classList.add("pending");
    td.textContent = "?";
    td.title = tries ? `Pending, ${triesText}` : "Pending";
  } else if (tries > 0) {
    td.classList.add("failed");
    td.textContent = `-${tries}`;
    td.title = triesText;
  } else {
    td.classList.add("idle");
    td.textContent = "—";
  }

  return td;
}

function compareTeams(a, b) {
  if (b.solved !== a.solved) return b.solved - a.solved;
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  if (a.lastSolve !== b.lastSolve) return a.lastSolve - b.lastSolve;
  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Live runs

function connectSocket() {
  if (!contestMeta) return;
  clearTimeout(reconnectTimer);

  setStatus("Connecting…");
  socket = new WebSocket(`${WS_BASE}${CONTEST_PATH}/runs_ws`);

  socket.addEventListener("open", () => {
    // The server replays every run on connect, so start from a clean slate.
    for (const team of teamState.values()) {
      team.runs.clear();
      recomputeTeam(team);
    }
    scoreboardVersion = 0;
    needsCache = { at: 0, version: -1, checked: new Set(), needs: new Map() };
    recentRuns.clear();
    lastFeedRunId = null;
    setStatus("Live", "online");
  });
  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      processRun(payload);
      requestRender();
    } catch (error) {
      console.error("Could not parse run payload", error);
    }
  });
  socket.addEventListener("close", () => scheduleReconnect());
  socket.addEventListener("error", () => {
    setStatus("Feed error", "error");
    socket.close();
  });
}

function scheduleReconnect() {
  setStatus("Reconnecting…");
  reconnectTimer = setTimeout(connectSocket, 4000);
}

function processRun(run) {
  if (!run || !run.team_login) return;
  const team = teamState.get(run.team_login);
  if (!team) return;

  if (!problemIds.includes(run.prob)) {
    problemIds.push(run.prob);
    problemIds.sort();
    renderHeader();
  }

  team.runs.set(run.id, run);
  recomputeTeam(team);
  scoreboardVersion += 1;
  lastRunAt = Date.now();

  recentRuns.set(run.id, run);
  if (recentRuns.size > FEED_SIZE * 20) {
    const keep = [...recentRuns.keys()].sort((a, b) => b - a).slice(0, FEED_SIZE * 10);
    const keepSet = new Set(keep);
    for (const id of recentRuns.keys()) {
      if (!keepSet.has(id)) recentRuns.delete(id);
    }
  }
}

function renderFeed() {
  const list = document.getElementById("feed-list");
  if (!list || !showFeed) return;

  const runs = [...recentRuns.values()]
    .filter((run) => {
      const team = teamState.get(run.team_login);
      return team && isTeamSelected(team) && isWomenSelected(team);
    })
    .sort((a, b) => b.id - a.id)
    .slice(0, FEED_SIZE);

  list.innerHTML = "";
  if (!runs.length) {
    const empty = document.createElement("li");
    empty.className = "filter-placeholder";
    empty.textContent = "No submissions yet.";
    list.appendChild(empty);
    return;
  }

  for (const run of runs) {
    const team = teamState.get(run.team_login);
    const verdict =
      run.answer === "Y" ? "yes" : run.answer === "N" ? "no" : "pending";
    const li = document.createElement("li");
    li.className = `feed-item ${verdict}`;
    // Only animate runs that arrived after the sidebar was first filled.
    if (lastFeedRunId !== null && run.id > lastFeedRunId) li.classList.add("fresh");

    const prob = document.createElement("span");
    prob.className = "feed-problem";
    prob.textContent = run.prob;

    const body = document.createElement("div");
    body.className = "feed-body";
    const line = document.createElement("div");
    line.className = "team-line";
    const flag = createFlagElement(team.country);
    if (flag) line.appendChild(flag);
    const name = document.createElement("p");
    name.className = "team-name";
    name.textContent = team.name;
    line.appendChild(name);
    const school = document.createElement("p");
    school.className = "team-school";
    school.textContent = team.school;
    body.append(line, school);

    const side = document.createElement("div");
    side.className = "feed-side";
    const result = document.createElement("span");
    result.className = "feed-verdict";
    result.textContent =
      verdict === "yes" ? "Yes" : verdict === "no" ? "No" : "Pending";
    const time = document.createElement("span");
    time.className = "feed-time";
    time.textContent = formatMinutes(Math.floor(run.time_seconds / 60));
    side.append(result, time);

    li.append(prob, body, side);
    list.appendChild(li);
  }

  lastFeedRunId = Math.max(lastFeedRunId ?? 0, runs[0].id);
}

function recomputeTeam(team) {
  const runs = [...team.runs.values()].sort(
    (a, b) => a.time_seconds - b.time_seconds || a.id - b.id
  );

  team.problems = createProblemState();
  team.solved = 0;
  team.penalty = 0;
  team.lastSolve = 0;

  for (const run of runs) {
    const problem = (team.problems[run.prob] ??= {
      solved: false,
      pending: false,
      wrongAttempts: 0,
      time: 0,
    });
    if (problem.solved) continue;

    switch (run.answer) {
      case "Y":
        problem.solved = true;
        problem.pending = false;
        problem.time = Math.floor(run.time_seconds / 60);
        team.solved += 1;
        team.lastSolve = Math.max(team.lastSolve, problem.time);
        team.penalty +=
          problem.time + problem.wrongAttempts * penaltyPerWrongAnswer.value;
        break;
      case "N":
        problem.wrongAttempts += 1;
        break;
      case "?":
        problem.pending = true;
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers

function setStatus(text, style) {
  const pill = document.getElementById("status-pill");
  if (!pill) return;
  pill.textContent = text;
  pill.className = "status-pill";
  if (style) {
    pill.classList.add(style);
  }
}

function showPlaceholder(text) {
  const tbody = document.getElementById("standings-body");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="${
    document.getElementById("standings-header")?.children.length || 5
  }" class="placeholder">${text}</td></tr>`;
}

function formatMinutes(minutes = 0) {
  if (Number.isNaN(minutes)) return "--";
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function regionName(code) {
  return REGION_NAMES[code] ?? code.toUpperCase();
}

function countryName(code) {
  return COUNTRY_NAMES[code] ?? code.toUpperCase();
}

// Returns null when the parameter is absent, [] for "all".
function readListParam(name) {
  const raw = params.get(name);
  if (raw === null) return null;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "all");
}

function writeUrlParam(name, value) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState(null, "", url);
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn("Unable to persist preference", error);
  }
}

function requestRender(immediate = false) {
  if (immediate) {
    if (renderTimeoutId) {
      clearTimeout(renderTimeoutId);
      renderTimeoutId = null;
    }
    renderQueued = false;
    renderStandings();
    renderFeed();
    return;
  }

  if (renderQueued) return;
  renderQueued = true;
  renderTimeoutId = setTimeout(() => {
    renderQueued = false;
    renderTimeoutId = null;
    renderStandings();
    renderFeed();
  }, RENDER_DEBOUNCE_MS);
}
