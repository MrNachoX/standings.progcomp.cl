import { estimateQualifiers, SLOT_LABELS } from "./qualification.js";

const API_BASE = "https://animeitor.naquadah.com.br/api";
const WS_BASE = "wss://animeitor.naquadah.com.br/api";
const params = new URLSearchParams(window.location.search);
const EVENT_ID = params.get("event") ?? "moj-icpc-latam-finals-2026-oficial";
const CONTEST_ID =
  params.get("contest") ?? "The 2026 ICPC Latin America Finals";
const SITE_NAME = params.get("sede") ?? "Chile";
const WOMEN_DATA_URL = "women.json";
const CONTEST_PATH = `/events/${encodeURIComponent(
  EVENT_ID
)}/contests/${encodeURIComponent(CONTEST_ID)}`;

const penaltyPerWrongAnswer = { value: 20 };
let problemIds = [];
let contestMeta = null;
let siteFilters = [];
let womenByLogin = {};
let minWomen = Number(params.get("women")) || 0;
let showQualifiers = params.get("qualify") === "1";
// Every official team, so qualifiers can be estimated over all of LatAm.
const teamState = new Map();
let socket;
let reconnectTimer;
let clockTimer;
const RENDER_DEBOUNCE_MS = 200;
let renderTimeoutId = null;
let renderQueued = false;

document.addEventListener("DOMContentLoaded", () => {
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
  const [contest, config, women] = await Promise.all([
    fetchApi("/contest"),
    fetchApi("/config").catch(() => null),
    loadWomenData(),
  ]);

  womenByLogin = women;
  contestMeta = contest;
  penaltyPerWrongAnswer.value = Math.round((contest.penalty_seconds ?? 1200) / 60);
  problemIds = [...(contest.problems ?? [])];
  siteFilters = buildSiteFilters(config);

  populateHero(contestMeta);
  renderHeader();
  hydrateTeams(contestMeta.teams);
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

function setupWomenFilter() {
  const select = document.getElementById("women-filter");
  if (!select) return;
  select.value = String(minWomen);
  select.addEventListener("change", () => {
    minWomen = Number(select.value) || 0;
    const url = new URL(window.location.href);
    if (minWomen) url.searchParams.set("women", minWomen);
    else url.searchParams.delete("women");
    window.history.replaceState(null, "", url);
    requestRender(true);
  });
}

function setupQualifyToggle() {
  const checkbox = document.getElementById("qualify-toggle");
  if (!checkbox) return;
  checkbox.checked = showQualifiers;
  checkbox.addEventListener("change", () => {
    showQualifiers = checkbox.checked;
    const url = new URL(window.location.href);
    if (showQualifiers) url.searchParams.set("qualify", "1");
    else url.searchParams.delete("qualify");
    window.history.replaceState(null, "", url);
    renderHeader();
    requestRender(true);
  });
}

function buildSiteFilters(config) {
  if (!SITE_NAME || !config?.sites) return [];
  const site = config.sites.find((s) => s.name === SITE_NAME);
  if (!site) {
    console.warn(`Site "${SITE_NAME}" not found in contest config`);
    return [];
  }
  return (site.codes ?? []).map((code) => new RegExp(code));
}

function populateHero(contest) {
  const contestName = document.getElementById("contest-name");
  const freezeTimeLabel = document.getElementById("freeze-time");
  const maxTimeLabel = document.getElementById("max-time");

  contestName.textContent = SITE_NAME
    ? `${contest.contest ?? "Live Contest"} — ${SITE_NAME}`
    : contest.contest ?? "Live Contest";
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
    // Logins look like team<region><country><number>, e.g. teamsocl003.
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

function renderHeader() {
  const headerRow = document.getElementById("standings-header");
  headerRow.innerHTML = "";

  const baseHeadings = showQualifiers
    ? ["#", "LatAm", "Team", "Slot (est.)", "Women", "Solved", "Penalty"]
    : ["#", "Team", "Women", "Solved", "Penalty"];
  for (const title of baseHeadings) {
    const th = document.createElement("th");
    th.textContent = title;
    headerRow.appendChild(th);
  }

  for (const prob of problemIds) {
    const th = document.createElement("th");
    th.textContent = prob;
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

  // Rank is computed over the whole site so filtering only hides rows.
  const teams = ranked
    .filter((team) => shouldIncludeTeam(team.login))
    .map((team, index) => ({ team, rank: index + 1 }))
    .filter(({ team }) => team.women >= minWomen);
  const fragment = document.createDocumentFragment();

  if (!teams.length) {
    showPlaceholder("No teams match this filter.");
    return;
  }

  teams.forEach(({ team, rank }) => {
    const tr = document.createElement("tr");

    appendCell(tr, "col-rank", rank);
    if (showQualifiers) {
      appendCell(tr, "col-rank latam", latamRank.get(team.login));
    }
    const teamCell = document.createElement("td");
    teamCell.classList.add("col-team");
    const teamName = document.createElement("p");
    teamName.className = "team-name";
    teamName.textContent = truncate(team.name, 60);
    const teamSchool = document.createElement("p");
    teamSchool.className = "team-school";
    teamSchool.textContent = truncate(team.school, 50);
    teamCell.append(teamName, teamSchool);
    tr.appendChild(teamCell);

    if (showQualifiers) {
      const slot = qualifiers.get(team.login);
      const slotCell = document.createElement("td");
      slotCell.className = "col-slot";
      if (slot) {
        tr.classList.add("qualified");
        slotCell.textContent = SLOT_LABELS[slot] ?? slot;
      } else {
        slotCell.textContent = "—";
      }
      tr.appendChild(slotCell);
    }

    tr.appendChild(buildWomenCell(team.women));

    appendCell(tr, "col-solved", team.solved);
    appendCell(tr, "col-penalty", team.penalty);

    for (const prob of problemIds) {
      tr.appendChild(buildProblemCell(team.problems[prob]));
    }

    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);
}

function appendCell(row, className, value) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = value;
  row.appendChild(td);
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
    td.classList.add("pending");
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
  const runs = [...team.runs.values()].sort((a, b) => a.time_seconds - b.time_seconds || a.id - b.id);

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

function buildProblemIds(number = 0) {
  const baseCode = "A".charCodeAt(0);
  return Array.from({ length: number }, (_, idx) =>
    String.fromCharCode(baseCode + idx)
  );
}

function formatMinutes(minutes = 0) {
  if (Number.isNaN(minutes)) return "--";
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function truncate(value = "", max = 40) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shouldIncludeTeam(login = "") {
  if (!siteFilters.length) return true;
  return siteFilters.some((re) => re.test(login));
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
