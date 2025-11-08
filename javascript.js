const CONTEST_API = "https://animeitor.naquadah.com.br/api/contest";
const RUNS_SOCKET = "wss://animeitor.naquadah.com.br/api/allruns_ws";
const TEAM_PREFIX_FILTER = "teamsoch";

const penaltyPerWrongAnswer = { value: 20 };
let problemIds = [];
let contestMeta = null;
const teamState = new Map();
let socket;
let reconnectTimer;
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

async function loadContest() {
  setStatus("Fetching contest…");
  const response = await fetch(CONTEST_API);
  if (!response.ok) {
    throw new Error(`Contest API responded with ${response.status}`);
  }

  contestMeta = await response.json();
  penaltyPerWrongAnswer.value = contestMeta.penalty_per_wrong_answer ?? 20;
  problemIds = buildProblemIds(contestMeta.number_problems);

  populateHero(contestMeta);
  renderHeader();
  hydrateTeams(contestMeta.teams);
  requestRender(true);
}

function populateHero(contest) {
  const contestName = document.getElementById("contest-name");
  const freezeTimeLabel = document.getElementById("freeze-time");
  const maxTimeLabel = document.getElementById("max-time");

  contestName.textContent = contest.contest_name ?? "Live Contest";
  freezeTimeLabel.textContent = formatMinutes(contest.score_freeze_time);
  maxTimeLabel.textContent = formatMinutes(contest.maximum_time);
}

function hydrateTeams(teams) {
  teamState.clear();
  const teamList = Object.values(teams ?? {}).filter((team) =>
    shouldIncludeTeam(team.login)
  );

  for (const team of teamList) {
    teamState.set(team.login, {
      login: team.login,
      name: team.name,
      school: team.escola,
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
  socket = new WebSocket(RUNS_SOCKET);

  socket.addEventListener("open", () => setStatus("Live", "online"));
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
  if (!shouldIncludeTeam(run.team_login)) return;
  const team = teamState.get(run.team_login);
  if (!team) return;

  const probId = run.prob;
  if (!team.problems[probId]) {
    team.problems[probId] = {
      solved: false,
      pending: false,
      wrongAttempts: 0,
      time: 0,
    };
    if (!problemIds.includes(probId)) {
      problemIds.push(probId);
      renderHeader();
    }
  }

  const verdict = Object.keys(run.answer ?? {})[0];
  if (!verdict) return;
  const details = run.answer[verdict];
  const problem = team.problems[probId];

  switch (verdict) {
    case "Wait":
      problem.pending = true;
      break;
    case "Yes":
      finalizeSolve(team, problem, details?.time ?? run.time ?? 0);
      break;
    case "No":
      if (!problem.solved) {
        problem.pending = false;
        problem.wrongAttempts += 1;
      }
      break;
    default:
      break;
  }
}

function finalizeSolve(team, problem, solveTime) {
  if (problem.solved) return;
  const normalizedTime =
    typeof solveTime === "number" && !Number.isNaN(solveTime)
      ? solveTime
      : Number(solveTime) || 0;
  problem.solved = true;
  problem.pending = false;
  problem.time = normalizedTime;
  team.solved += 1;
  team.penalty +=
    normalizedTime + problem.wrongAttempts * penaltyPerWrongAnswer.value;
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
  if (!TEAM_PREFIX_FILTER) return true;
  return login?.startsWith(TEAM_PREFIX_FILTER);
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
