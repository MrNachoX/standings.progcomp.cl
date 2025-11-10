const CONTEST_API = "https://animeitor.naquadah.com.br/api/contest";
const RUNS_SOCKET = "wss://animeitor.naquadah.com.br/api/allruns_ws";
const TEAM_PREFIX_FILTER = "team";
const TEAM_FILTER_PARAM = "teams";
const FILTER_VISIBILITY_STORAGE_KEY = "standings-filter-hidden";
const THEME_STORAGE_KEY = "standings-theme";
const DEFAULT_THEME = "dark";

const penaltyPerWrongAnswer = { value: 20 };
let problemIds = [];
let contestMeta = null;
const teamState = new Map();
const selectedTeamPrefixes = new Set();
let teamFilterOptions = [];
let filterPanelEl = null;
let filterToggleBtn = null;
let filterContainerEl = null;
let filtersHidden = false;
let socket;
let reconnectTimer;
const RENDER_DEBOUNCE_MS = 200;
let renderTimeoutId = null;
let renderQueued = false;

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  initTeamFilter();
  bootstrap().catch((err) => {
    console.error(err);
    setStatus("Contest load failed", "error");
    showPlaceholder(
      "Unable to contact the contest API. Please refresh to try again."
    );
  });
});

function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  const savedTheme = getStoredTheme();
  applyTheme(savedTheme);
  updateToggleUI(toggle);
  toggle.addEventListener("click", () => {
    const nextTheme =
      document.body.dataset.theme === "light" ? "dark" : "light";
    applyTheme(nextTheme);
    setStoredTheme(nextTheme);
    updateToggleUI(toggle);
  });
}

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

  updateTeamFilterOptionsFromState();
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

  const teams = [...teamState.values()]
    .filter((team) => isTeamVisible(team.login))
    .sort(compareTeams);

  if (!teams.length) {
    showPlaceholder("No teams match the current filter.");
    return;
  }

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
    td.classList.add("idle");
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
      console.warn("Unknown verdict received:", verdict);
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

function updateTeamFilterOptionsFromState() {
  const teamLogins = [...teamState.keys()];
  const nextOptions = computeMaximalTeamPrefixes(teamLogins);
  const optionsChanged = arraysDiffer(teamFilterOptions, nextOptions);
  teamFilterOptions = nextOptions;
  const selectionChanged = pruneSelectedPrefixes();

  if (optionsChanged || selectionChanged) {
    renderFilterCheckboxes();
    persistFilterToUrl();
    requestRender(true);
  } else {
    renderFilterCheckboxes();
  }
}

function pruneSelectedPrefixes() {
  if (!teamFilterOptions.length || !selectedTeamPrefixes.size) return false;
  const allowed = new Set(teamFilterOptions);
  let mutated = false;
  for (const prefix of [...selectedTeamPrefixes]) {
    if (!allowed.has(prefix)) {
      selectedTeamPrefixes.delete(prefix);
      mutated = true;
    }
  }
  return mutated;
}

function arraysDiffer(prev = [], next = []) {
  if (prev.length !== next.length) return true;
  return prev.some((value, idx) => value !== next[idx]);
}

function computeMaximalTeamPrefixes(logins = []) {
  const cleaned = logins
    .map((login) => stripTrailingDigits(String(login ?? "")))
    .map((login) => login.trim())
    .filter(Boolean);

  if (!cleaned.length) return [];

  const trie = createTrieNode();
  for (const login of cleaned) {
    let node = trie;
    for (const char of login) {
      if (!node.children.has(char)) {
        node.children.set(char, createTrieNode());
      }
      node = node.children.get(char);
    }
    node.terminalCount += 1;
  }

  const prefixes = [];
  collectMaximalPrefixes(trie, "", prefixes);
  return prefixes;
}

function collectMaximalPrefixes(node, prefix, store) {
  if (prefix) {
    const hasBranch = node.children.size >= 2;
    const isTerminal = node.terminalCount > 0;
    if (hasBranch || isTerminal) {
      store.push(prefix);
    }
  }

  for (const [char, child] of node.children) {
    collectMaximalPrefixes(child, prefix + char, store);
  }
}

function createTrieNode() {
  return {
    children: new Map(),
    terminalCount: 0,
  };
}

function stripTrailingDigits(value = "") {
  return value.replace(/\d+$/, "");
}

function shouldIncludeTeam(login = "") {
  if (!TEAM_PREFIX_FILTER) return true;
  return login?.startsWith(TEAM_PREFIX_FILTER);
}

function isTeamVisible(login = "") {
  if (!selectedTeamPrefixes.size) return true;
  for (const prefix of selectedTeamPrefixes) {
    if (login?.startsWith(prefix)) {
      return true;
    }
  }
  return false;
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

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : DEFAULT_THEME;
  document.body.dataset.theme = nextTheme;
}

function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
  } catch (error) {
    console.warn("Unable to read theme preference", error);
    return DEFAULT_THEME;
  }
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.warn("Unable to persist theme preference", error);
  }
}

function updateToggleUI(button) {
  const isLight = document.body.dataset.theme === "light";
  button.textContent = isLight ? "☾" : "☀";
  button.setAttribute("aria-pressed", String(isLight));
}

function initTeamFilter() {
  const urlSelection = parseFilterFromUrl();
  selectedTeamPrefixes.clear();
  urlSelection.forEach((prefix) => selectedTeamPrefixes.add(prefix));

  filtersHidden = getStoredFilterVisibility();
  filterPanelEl = document.getElementById("filter-panel");
  filterToggleBtn = document.getElementById("filter-toggle");
  applyFilterPanelState();
  filterToggleBtn?.addEventListener("click", () => {
    filtersHidden = !filtersHidden;
    applyFilterPanelState();
    setStoredFilterVisibility(filtersHidden);
  });

  filterContainerEl = document.getElementById("team-filter");
  if (!filterContainerEl) return;

  renderFilterCheckboxes();

  filterContainerEl.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
      return;
    }

    const prefix = target.value;
    if (!teamFilterOptions.includes(prefix)) return;

    if (target.checked) {
      selectedTeamPrefixes.add(prefix);
    } else {
      selectedTeamPrefixes.delete(prefix);
    }

    persistFilterToUrl();
    requestRender(true);
  });
}

function renderFilterCheckboxes() {
  if (!filterContainerEl) return;
  filterContainerEl.innerHTML = "";

  if (!teamFilterOptions.length) {
    const placeholder = document.createElement("p");
    placeholder.className = "filter-placeholder";
    placeholder.textContent = "Waiting for teams…";
    filterContainerEl.appendChild(placeholder);
    return;
  }

  const treeRoot = document.createElement("ul");
  treeRoot.className = "filter-tree filter-tree-root";
  const tree = buildPrefixTree(teamFilterOptions);
  tree.forEach((node) => {
    treeRoot.appendChild(createFilterTreeItem(node));
  });
  filterContainerEl.appendChild(treeRoot);
}

function buildPrefixTree(prefixes = []) {
  const root = createPrefixTreeNode("");
  const nodes = new Map();
  nodes.set("", root);

  const sorted = [...prefixes].sort((a, b) => {
    if (a.length === b.length) {
      return a.localeCompare(b);
    }
    return a.length - b.length;
  });

  sorted.forEach((prefix) => {
    const node = createPrefixTreeNode(prefix);
    const parent = findPrefixTreeParent(prefix, nodes);
    parent.children.push(node);
    nodes.set(prefix, node);
  });

  return root.children;
}

function findPrefixTreeParent(prefix, nodes) {
  for (let idx = prefix.length - 1; idx >= 0; idx -= 1) {
    const candidate = prefix.slice(0, idx);
    if (nodes.has(candidate)) {
      return nodes.get(candidate);
    }
  }
  return nodes.get("");
}

function createPrefixTreeNode(value) {
  return { value, children: [] };
}

function createFilterTreeItem(node) {
  const li = document.createElement("li");
  li.className = "filter-tree-item";

  const label = document.createElement("label");
  label.className = "filter-checkbox";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = node.value;
  checkbox.checked = selectedTeamPrefixes.has(node.value);

  const text = document.createElement("span");
  text.textContent = node.value;

  label.append(checkbox, text);
  li.appendChild(label);

  if (node.children.length) {
    const nested = document.createElement("ul");
    nested.className = "filter-tree";
    node.children.forEach((child) => {
      nested.appendChild(createFilterTreeItem(child));
    });
    li.appendChild(nested);
  }

  return li;
}

function parseFilterFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get(TEAM_FILTER_PARAM);
    if (!raw) return [];
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn("Unable to read team filter from URL", error);
    return [];
  }
}

function persistFilterToUrl() {
  const params = new URLSearchParams(window.location.search);
  if (selectedTeamPrefixes.size) {
    params.set(TEAM_FILTER_PARAM, [...selectedTeamPrefixes].join(","));
  } else {
    params.delete(TEAM_FILTER_PARAM);
  }
  const search = params.toString();
  const nextUrl = `${window.location.pathname}${
    search ? `?${search}` : ""
  }${window.location.hash}`;
  window.history.replaceState({}, "", nextUrl);
}

function applyFilterPanelState() {
  if (!filterPanelEl || !filterToggleBtn) return;
  filterPanelEl.classList.toggle("collapsed", filtersHidden);
  const icon = filtersHidden ? "▲" : "▼";
  filterToggleBtn.textContent = `Filters ${icon}`;
  filterToggleBtn.setAttribute("aria-label", filtersHidden ? "Show filters" : "Hide filters");
  filterToggleBtn.setAttribute("aria-pressed", String(filtersHidden));
  filterToggleBtn.setAttribute("aria-expanded", String(!filtersHidden));
}

function getStoredFilterVisibility() {
  try {
    return localStorage.getItem(FILTER_VISIBILITY_STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("Unable to read filter visibility preference", error);
    return false;
  }
}

function setStoredFilterVisibility(value) {
  try {
    localStorage.setItem(FILTER_VISIBILITY_STORAGE_KEY, String(Boolean(value)));
  } catch (error) {
    console.warn("Unable to persist filter visibility preference", error);
  }
}
