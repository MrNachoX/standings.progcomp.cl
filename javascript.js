const API_BASE = "https://animeitor.naquadah.com.br/api";
const WS_BASE = "wss://animeitor.naquadah.com.br/api";
const params = new URLSearchParams(window.location.search);
const EVENT_ID = params.get("event") ?? "moj-icpc-latam-finals-2026-oficial";
const CONTEST_ID =
  params.get("contest") ?? "The 2026 ICPC Latin America Finals";
const SITE_NAME = params.get("sede") ?? "Chile";
const CONTEST_PATH = `/events/${encodeURIComponent(
  EVENT_ID
)}/contests/${encodeURIComponent(CONTEST_ID)}`;

const penaltyPerWrongAnswer = { value: 20 };
let problemIds = [];
let contestMeta = null;
let siteFilters = [];
const teamState = new Map();
const runsById = new Map();
let socket;
let reconnectTimer;
let clockTimer;
const RENDER_DEBOUNCE_MS = 200;
let renderTimeoutId = null;
let renderQueued = false;

document.addEventListener("DOMContentLoaded", () => {
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
  const [contest, config] = await Promise.all([
    fetchApi("/contest"),
    fetchApi("/config").catch(() => null),
  ]);

  contestMeta = contest;
  penaltyPerWrongAnswer.value = Math.round((contest.penalty_seconds ?? 1200) / 60);
  problemIds = [...(contest.problems ?? [])];
  siteFilters = buildSiteFilters(config);

  populateHero(contestMeta);
  renderHeader();
  hydrateTeams(contestMeta.teams);
  requestRender(true);
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
  runsById.clear();
  const teamList = Object.values(teams ?? {}).filter((team) =>
    shouldIncludeTeam(team.login)
  );

  for (const team of teamList) {
    teamState.set(team.login, {
      login: team.login,
      name: team.nome ?? team.login,
      school: team.escola ?? "",
      solved: 0,
      penalty: 0,
      problems: createProblemState(),
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

  const baseHeadings = ["#", "Team", "Solved", "Penalty"];
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

  const teams = [...teamState.values()].sort(compareTeams);
  const fragment = document.createDocumentFragment();

  teams.forEach((team, index) => {
    const tr = document.createElement("tr");

    appendCell(tr, "col-rank", index + 1);
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
  return a.name.localeCompare(b.name);
}

function connectSocket() {
  if (!contestMeta) return;
  clearTimeout(reconnectTimer);

  setStatus("Connecting…");
  socket = new WebSocket(`${WS_BASE}${CONTEST_PATH}/runs_ws`);

  socket.addEventListener("open", () => {
    // The server replays every run on connect, so start from a clean slate.
    runsById.clear();
    for (const team of teamState.values()) recomputeTeam(team);
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

  runsById.set(run.id, run);
  recomputeTeam(team);
}

function recomputeTeam(team) {
  const runs = [...runsById.values()]
    .filter((run) => run.team_login === team.login)
    .sort((a, b) => a.time_seconds - b.time_seconds || a.id - b.id);

  team.problems = createProblemState();
  team.solved = 0;
  team.penalty = 0;

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
  tbody.innerHTML = `<tr><td colspan="${4 + problemIds.length}" class="placeholder">${text}</td></tr>`;
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
