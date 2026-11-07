import { estimateQualifiers, SLOT_LABELS } from "./qualification.js";

const API_BASE = "https://animeitor.naquadah.com.br/api";
const WS_BASE = "wss://animeitor.naquadah.com.br/api";
const params = new URLSearchParams(window.location.search);
const EVENT_ID = params.get("event") ?? "moj-icpc-latam-finals-2026-oficial";
const CONTEST_ID =
  params.get("contest") ?? "The 2026 ICPC Latin America Finals";
const CONTEST_PATH = `/events/${encodeURIComponent(
  EVENT_ID
)}/contests/${encodeURIComponent(CONTEST_ID)}`;
const WOMEN_DATA_URL = "women.json";
const FLAG_CDN_BASE = "https://cdn.jsdelivr.net/npm/flag-icons/flags/4x3";

const TEAM_FILTER_PARAM = "teams";
const DEFAULT_TEAM_FILTER = [];
const THEME_STORAGE_KEY = "standings-theme";
const FILTER_VISIBILITY_STORAGE_KEY = "standings-filter-hidden";

// Logins look like team<region><country><number>, e.g. teamsocl003.
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
let socket;
let reconnectTimer;
let clockTimer;
const RENDER_DEBOUNCE_MS = 200;
let renderTimeoutId = null;
let renderQueued = false;

document.addEventListener("DOMContentLoaded", () => {
  setupThemeToggle();
  setupFilterPanel();
  setupWomenFilter();
  setupQualifyToggle();
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

  contestName.textContent = contest.contest ?? "Live Contest";
  freezeTimeLabel.textContent = formatMinutes(
    Math.floor((contest.score_freeze_time_seconds ?? 0) / 60)
  );

  clearInterval(clockTimer);
  const loadedAt = Date.now();
  const startSeconds = contest.time_seconds ?? 0;
  const tick = () => {
    const elapsed = startSeconds + (Date.now() - loadedAt) / 1000;
    maxTimeLabel.textContent = formatMinutes(Math.floor(elapsed / 60));
  };
  tick();
  clockTimer = setInterval(tick, 10000);
}

function hydrateTeams(teams) {
  teamState.clear();

  for (const team of Object.values(teams ?? {})) {
    teamState.set(team.login, {
      login: team.login,
      name: team.nome ?? team.login,
      school: team.escola ?? "",
      region: team.login.slice(4, 6),
      country: team.login.slice(6, 8),
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
  const panel = document.getElementById("filter-panel");
  const button = document.getElementById("filter-toggle");
  if (!panel || !button) return;

  const stored = readStorage(FILTER_VISIBILITY_STORAGE_KEY);
  let hidden =
    stored === null
      ? window.matchMedia("(max-width: 768px)").matches
      : stored === "true";
  const apply = () => {
    panel.classList.toggle("collapsed", hidden);
    button.textContent = `Filters ${hidden ? "▲" : "▼"}`;
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

    // Single-country regions (Brazil, Mexico) don't need a nested list.
    if (countries.size > 1) {
      const list = document.createElement("ul");
      const sortedCountries = [...countries].sort(([a], [b]) =>
        countryName(a).localeCompare(countryName(b))
      );
      for (const [country, count] of sortedCountries) {
        const li = document.createElement("li");
        const box = buildFilterCheckbox(
          regionPrefix + country,
          countryName(country),
          count,
          country
        );
        box.querySelector("input").checked =
          regionInput.checked || selectedPrefixes.has(regionPrefix + country);
        li.appendChild(box);
        list.appendChild(li);
      }
      block.appendChild(list);
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
        .filter((team) => team.login.startsWith(regionPrefix))
        .map((team) => `team${team.region}${team.country}`)
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

function isTeamSelected(team) {
  if (!selectedPrefixes.size) return true;
  for (const prefix of selectedPrefixes) {
    if (team.login.startsWith(prefix)) return true;
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

  const baseHeadings = showQualifiers
    ? ["#", "Team", "LatAm", "Slot (est.)", "Women", "Solved", "Penalty"]
    : ["#", "Team", "Women", "Solved", "Penalty"];
  for (const title of [...baseHeadings, ...problemIds]) {
    const th = document.createElement("th");
    th.textContent = title;
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

  const ranked = [...teamState.values()].sort(compareTeams);
  const latamRank = new Map(ranked.map((team, index) => [team.login, index + 1]));
  const qualifiers = showQualifiers ? estimateQualifiers(ranked) : new Map();

  // Rank within the selected regions/countries; the women filter only hides
  // rows so positions stay comparable.
  const teams = ranked
    .filter(isTeamSelected)
    .map((team, index) => ({ team, rank: index + 1 }))
    .filter(({ team }) => isWomenSelected(team));

  if (!teams.length) {
    showPlaceholder("No teams match the current filters.");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const { team, rank } of teams) {
    const tr = document.createElement("tr");

    appendCell(tr, "col-rank", rank);
    tr.appendChild(buildTeamCell(team));

    if (showQualifiers) {
      appendCell(tr, "col-latam", latamRank.get(team.login));
      const slot = qualifiers.get(team.login);
      if (slot) tr.classList.add("qualified");
      appendCell(tr, "col-slot", slot ? SLOT_LABELS[slot] ?? slot : "—");
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

  const school = document.createElement("p");
  school.className = "team-school";
  school.textContent = team.school;

  td.append(line, school);
  return td;
}

function createFlagElement(countryCode) {
  if (!/^[a-z]{2}$/.test(countryCode ?? "")) return null;
  const img = document.createElement("img");
  img.className = "team-flag";
  img.src = `${FLAG_CDN_BASE}/${countryCode}.svg`;
  img.alt = countryName(countryCode);
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => img.remove(), { once: true });
  return img;
}

function buildWomenCell(count) {
  const td = document.createElement("td");
  td.className = "col-women";
  if (count > 0) {
    td.textContent = "♀".repeat(count);
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

  if (problem.solved) {
    td.classList.add("solved");
    td.innerHTML = `${formatMinutes(problem.time)}<span>+${problem.wrongAttempts}</span>`;
  } else if (problem.pending) {
    td.classList.add("pending");
    td.textContent = "Wait";
  } else if (problem.wrongAttempts > 0) {
    td.classList.add("failed");
    td.textContent = `-${problem.wrongAttempts}`;
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
    return;
  }

  if (renderQueued) return;
  renderQueued = true;
  renderTimeoutId = setTimeout(() => {
    renderQueued = false;
    renderTimeoutId = null;
    renderStandings();
  }, RENDER_DEBOUNCE_MS);
}
