// Estimated qualifiers for the 2027 ICPC Latin America Championship, following
// "2026-2027 ICPC Latin America - Promotion Rules". This is an estimate: the
// scoreboard may be frozen, reserve slots are discretionary, and a few inputs
// below are assumptions agreed on for this site.

const N = 40;
const HOST_COUNTRY = "mx";
// Each `escola` counts as its own institution; only this campus is the host.
const HOST_SCHOOLS = new Set(["ITESM Monterrey"]);
// Qualified for 2026 but could not attend. They also compete in the regional,
// but are skipped in the standard slots since their own slot is guaranteed.
const PENDING_TEAMS = ["teamcbcu011", "teamnove019"];
// Most participating teams over the whole cycle, from the opening slide.
const COUNTRY_PARTICIPATION_SLOTS = [
  { country: "mx", teams: 1035, slots: 5 },
  { country: "br", teams: 965, slots: 4 },
  { country: "bo", teams: 227, slots: 3 },
  { country: "ar", teams: 186, slots: 2 },
  { country: "co", teams: 116, slots: 1 },
];
// Institutions per region over the whole regional cycle, from last year's
// official slot-assignment script (this year's counts aren't available).
const REGION_SCHOOLS = new Map([
  ["br", 233],
  ["cb", 21],
  ["ca", 18],
  ["mx", 140],
  ["no", 57],
  ["so", 108],
]);
// The fractions to carry over into this year are unknown (that script only
// has the ones it started from), so assume 0.
const PREVIOUS_FRACTIONS = {};

export const SLOT_LABELS = {
  performance: "Performance",
  country: "Country",
  host: "Host",
  geographic: "Geographic",
  "women-host-country": "Women · host country",
  "women-latam": "Women · LatAm",
  pending: "Pending 2026",
  "women-host": "Women · host",
  "women-region": "Women · region",
  "two-women": "≥2 women",
  "one-woman": "≥1 woman",
  "country-participation": "Country participation",
  "host-extra": "Host extra",
};

export const SLOT_SHORT_LABELS = {
  performance: "Perf",
  country: "Country",
  host: "Host",
  geographic: "Geo",
  "women-host-country": "♀ MX",
  "women-latam": "♀ LatAm",
  pending: "Pending",
  "women-host": "♀ Host",
  "women-region": "♀ Region",
  "two-women": "♀♀",
  "one-woman": "♀",
  "country-participation": "Cycle",
  "host-extra": "Host+",
};

const ordinal = (n) =>
  n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");

/**
 * @param rankedTeams every official team, best first; each has
 *   { login, school, region, country, solved, women }
 * @param names { regionName(code), countryName(code) } for the explanations
 * @returns Map login -> { slot, detail }: slot is a SLOT_LABELS key and
 *   detail explains why this particular team got it
 */
export function estimateQualifiers(rankedTeams, names = {}) {
  const regionName = names.regionName ?? ((code) => code.toUpperCase());
  const countryName = names.countryName ?? ((code) => code.toUpperCase());
  const hostSchools = [...HOST_SCHOOLS].join(", ");

  const slots = new Map();
  const schoolCount = new Map();
  const qualifiedCountries = new Set();
  const pending = new Set(PENDING_TEAMS);

  const qualify = (team, slot, detail) => {
    if (!team) return false;
    slots.set(team.login, { slot, detail });
    schoolCount.set(team.school, (schoolCount.get(team.school) ?? 0) + 1);
    qualifiedCountries.add(team.country);
    return true;
  };
  const isOpen = (team) => !slots.has(team.login) && !pending.has(team.login);
  const isNewSchool = (team) => !schoolCount.has(team.school);
  // Searching smaller ranked pools keeps repeated estimates cheap.
  const best = (predicate, pool = rankedTeams) =>
    pool.find((team) => isOpen(team) && predicate(team));
  const isAllWomen = (team) => team.women >= 3;
  const byRegion = groupBy(rankedTeams, (team) => team.region);
  const byCountry = groupBy(rankedTeams, (team) => team.country);
  const withWomen = rankedTeams.filter((team) => team.women > 0);
  const hostTeams = rankedTeams.filter((team) => HOST_SCHOOLS.has(team.school));

  // I.1 Performance slots: at most two teams per school.
  let performance = 0;
  for (const team of rankedTeams) {
    if (performance >= N / 2) break;
    if (isOpen(team) && (schoolCount.get(team.school) ?? 0) < 2) {
      performance += 1;
      qualify(
        team,
        "performance",
        `Performance slot ${performance} of ${N / 2}: the ${N / 2} best teams ` +
          `in the regional, at most 2 per institution.`
      );
    }
  }

  // I.2 Participating countries.
  const countries = new Set(rankedTeams.map((team) => team.country));
  const countriesWithout = [...countries].filter(
    (country) => !qualifiedCountries.has(country)
  ).length;
  const countrySlots = Math.min(N / 4, countriesWithout - 1);
  for (let i = 0; i < countrySlots; i++) {
    const team = best(
      (t) => !qualifiedCountries.has(t.country) && isNewSchool(t)
    );
    if (!team || team.solved < 1) break;
    qualify(
      team,
      "country",
      `Participating-country slot ${i + 1} of ${countrySlots}: best team from ` +
        `${countryName(team.country)}, which had no qualified team yet ` +
        `(${countriesWithout} countries without one, minus 1, capped at ${N / 4}; ` +
        `needs at least 1 problem solved).`
    );
  }

  // I.3 Host institution.
  if (![...HOST_SCHOOLS].some((school) => schoolCount.has(school))) {
    qualify(
      best(() => true, hostTeams),
      "host",
      `Host institution slot: best team from ${hostSchools}, since the host ` +
        `had no team qualified by performance or country.`
    );
  }

  // I.4 Geographic representation, up to N teams.
  const geo = geographicQuotas(REGION_SCHOOLS, slots.size);
  for (const [region, quota] of geo.quotas) {
    for (let i = 0; i < quota; i++) {
      const team = best(isNewSchool, byRegion.get(region));
      if (!team) break;
      qualify(
        team,
        "geographic",
        `Geographic slot ${i + 1} of ${quota} for ${regionName(region)}: the ` +
          `${geo.open} slots left up to ${N} are split by institutions ` +
          `taking part in the regional season (${regionName(region)} has ` +
          `${geo.schools.get(region)} of ${geo.total}); best ` +
          `${regionName(region)} team from an institution with no qualified ` +
          `team yet.`
      );
    }
  }

  // All-female slots (general rule does not apply).
  qualify(
    best(isAllWomen, byCountry.get(HOST_COUNTRY) ?? []),
    "women-host-country",
    `All-women slot for the host country: best all-women team from ` +
      `${countryName(HOST_COUNTRY)} not yet qualified.`
  );
  qualify(
    best(isAllWomen, withWomen),
    "women-latam",
    `All-women LatAm slot: best all-women team in Latin America not yet ` +
      `qualified.`
  );

  // II. 2027-specific slots, in order.
  for (const login of PENDING_TEAMS) {
    pending.delete(login);
    qualify(
      rankedTeams.find((t) => t.login === login && !slots.has(login)),
      "pending",
      `Pending slot: this team qualified for the 2026 Championship but could ` +
        `not attend, so its 2027 slot is guaranteed regardless of this result.`
    );
  }

  qualify(
    best(isAllWomen, hostTeams),
    "women-host",
    `Host all-women slot: best all-women team from ${hostSchools} not yet ` +
      `qualified.`
  );

  for (const region of byRegion.keys()) {
    qualify(
      best(isAllWomen, withWomen.filter((t) => t.region === region)),
      "women-region",
      `All-women slot for ${regionName(region)}: best all-women team from ` +
        `${regionName(region)} not yet qualified (one per region).`
    );
  }

  for (let i = 0; i < 3; i++) {
    qualify(
      best((t) => t.women >= 2, withWomen),
      "two-women",
      `Two-women slot ${i + 1} of 3: best team in Latin America with at least ` +
        `two women not yet qualified.`
    );
  }
  for (let i = 0; i < 3; i++) {
    qualify(
      best(() => true, withWomen),
      "one-woman",
      `One-woman slot ${i + 1} of 3: best team in Latin America with at least ` +
        `one woman not yet qualified.`
    );
  }

  COUNTRY_PARTICIPATION_SLOTS.forEach(({ country, teams, slots: count }, index) => {
    for (let i = 0; i < count; i++) {
      qualify(
        best(isNewSchool, byCountry.get(country) ?? []),
        "country-participation",
        `Country participation slot ${i + 1} of ${count} for ` +
          `${countryName(country)}: ${countryName(country)} had the ` +
          `${ordinal(index + 1)} most teams over the whole season ` +
          `(${teams.toLocaleString("en")}), which gives it ${count} extra ` +
          `${count === 1 ? "slot" : "slots"}; best team from an institution ` +
          `with no qualified team yet.`
      );
    }
  });

  for (let i = 0; i < 2; i++) {
    qualify(
      best(() => true, hostTeams),
      "host-extra",
      `Extra host slot ${i + 1} of 2: best team from ${hostSchools} not yet ` +
        `qualified.`
    );
  }

  return slots;
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

// "Algorithm to assign the Geographic Representation Slots".
// `schools` maps each region to its number of institutions.
function geographicQuotas(schools, alreadyAllocated) {
  const quotas = new Map();
  let nSchoolsLatam = 0;
  for (const count of schools.values()) nSchoolsLatam += count;
  const result = {
    quotas,
    open: Math.max(N - alreadyAllocated, 0),
    total: nSchoolsLatam,
    schools,
  };
  if (alreadyAllocated >= N) return result;

  let allocated = alreadyAllocated;
  const slotsRatio = nSchoolsLatam / (N - allocated);
  const fractions = new Map();
  for (const [region, count] of schools) {
    const exact = count / slotsRatio;
    const whole = Math.trunc(exact);
    quotas.set(region, whole);
    allocated += whole;
    fractions.set(region, (PREVIOUS_FRACTIONS[region] ?? 0) + exact - whole);
  }

  while (allocated < N) {
    const top = Math.max(...fractions.values());
    // Ties all receive a slot, which can push the total above N.
    for (const [region, fraction] of fractions) {
      if (Math.abs(fraction - top) > 1e-9) continue;
      quotas.set(region, quotas.get(region) + 1);
      allocated += 1;
      fractions.set(region, 0);
    }
  }

  return result;
}

/**
 * For a team outside the estimate, the fewest extra problems that would put
 * it in, solving them at `minute` and leaving every other team unchanged.
 * Each extra problem is taken from the team's unsolved ones with the fewest
 * wrong tries, since those tries add penalty once the problem is solved.
 *
 * Assumes more problems never hurt, so it checks `maxExtra` first and then
 * bisects, which keeps the number of full estimates low.
 *
 * @param rankedTeams official teams, best first (as for estimateQualifiers)
 * @param baseline estimateQualifiers(rankedTeams, names)
 * @returns { extra, penalty, slot, detail, displaced: [team] } or null
 */
export function estimateProblemsNeeded(
  team,
  rankedTeams,
  baseline,
  { minute, maxExtra, wrongPenalty, compare, names }
) {
  if (baseline.has(team.login)) return null;

  const others = rankedTeams.filter((t) => t !== team);
  const unsolvedTries = Object.values(team.problems)
    .filter((problem) => !problem.solved)
    .map((problem) => problem.wrongAttempts)
    .sort((a, b) => a - b);
  const limit = Math.min(maxExtra, unsolvedTries.length);

  const outcomes = new Map();
  const tryExtra = (extra) => {
    if (outcomes.has(extra)) return outcomes.get(extra);
    let penalty = team.penalty;
    for (let i = 0; i < extra; i++) {
      penalty += minute + unsolvedTries[i] * wrongPenalty;
    }
    const candidate = {
      ...team,
      solved: team.solved + extra,
      penalty,
      lastSolve: Math.max(team.lastSolve, minute),
    };
    const index = others.findIndex((t) => compare(candidate, t) < 0);
    const ranked = [...others];
    ranked.splice(index < 0 ? ranked.length : index, 0, candidate);

    const result = estimateQualifiers(ranked, names);
    const got = result.get(team.login);
    const outcome = got && {
      extra,
      penalty,
      ...got,
      displaced: [...baseline.keys()]
        .filter((login) => !result.has(login))
        .map((login) => others.find((t) => t.login === login))
        .filter(Boolean),
    };
    outcomes.set(extra, outcome);
    return outcome;
  };

  if (limit < 1 || !tryExtra(limit)) return null;
  let low = 1;
  let high = limit;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (tryExtra(mid)) high = mid;
    else low = mid + 1;
  }
  return tryExtra(low);
}
