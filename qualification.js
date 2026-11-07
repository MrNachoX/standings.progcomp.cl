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
// Most participating teams over the whole cycle (opening slide: MEX 1035,
// BR 965, BO 227, AR 186, CO 116).
const COUNTRY_PARTICIPATION_SLOTS = [
  ["mx", 5],
  ["br", 4],
  ["bo", 3],
  ["ar", 2],
  ["co", 1],
];
// Fractions carried over from the previous year are unknown; assume 0.
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

/**
 * @param rankedTeams every official team, best first; each has
 *   { login, school, region, country, solved, women }
 * @returns Map login -> slot key (see SLOT_LABELS)
 */
export function estimateQualifiers(rankedTeams) {
  const slots = new Map();
  const schoolCount = new Map();
  const qualifiedCountries = new Set();
  const pending = new Set(PENDING_TEAMS);

  const qualify = (team, slot) => {
    if (!team) return;
    slots.set(team.login, slot);
    schoolCount.set(team.school, (schoolCount.get(team.school) ?? 0) + 1);
    qualifiedCountries.add(team.country);
  };
  const isOpen = (team) => !slots.has(team.login) && !pending.has(team.login);
  const isNewSchool = (team) => !schoolCount.has(team.school);
  const best = (predicate) =>
    rankedTeams.find((team) => isOpen(team) && predicate(team));
  const isAllWomen = (team) => team.women >= 3;

  // I.1 Performance slots: at most two teams per school.
  for (const team of rankedTeams) {
    if (slots.size >= N / 2) break;
    if (isOpen(team) && (schoolCount.get(team.school) ?? 0) < 2) {
      qualify(team, "performance");
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
    qualify(team, "country");
  }

  // I.3 Host institution.
  if (![...HOST_SCHOOLS].some((school) => schoolCount.has(school))) {
    qualify(best((t) => HOST_SCHOOLS.has(t.school)), "host");
  }

  // I.4 Geographic representation, up to N teams.
  for (const [region, quota] of geographicQuotas(rankedTeams, slots.size)) {
    for (let i = 0; i < quota; i++) {
      const team = best((t) => t.region === region && isNewSchool(t));
      if (!team) break;
      qualify(team, "geographic");
    }
  }

  // All-female slots (general rule does not apply).
  qualify(
    best((t) => isAllWomen(t) && t.country === HOST_COUNTRY),
    "women-host-country"
  );
  qualify(best(isAllWomen), "women-latam");

  // II. 2027-specific slots, in order.
  for (const login of PENDING_TEAMS) {
    pending.delete(login);
    qualify(
      rankedTeams.find((t) => t.login === login && !slots.has(login)),
      "pending"
    );
  }

  qualify(
    best((t) => isAllWomen(t) && HOST_SCHOOLS.has(t.school)),
    "women-host"
  );

  const regions = [...new Set(rankedTeams.map((team) => team.region))];
  for (const region of regions) {
    qualify(
      best((t) => isAllWomen(t) && t.region === region),
      "women-region"
    );
  }

  for (let i = 0; i < 3; i++) qualify(best((t) => t.women >= 2), "two-women");
  for (let i = 0; i < 3; i++) qualify(best((t) => t.women >= 1), "one-woman");

  for (const [country, count] of COUNTRY_PARTICIPATION_SLOTS) {
    for (let i = 0; i < count; i++) {
      qualify(
        best((t) => t.country === country && isNewSchool(t)),
        "country-participation"
      );
    }
  }

  for (let i = 0; i < 2; i++) {
    qualify(best((t) => HOST_SCHOOLS.has(t.school)), "host-extra");
  }

  return slots;
}

// "Algorithm to assign the Geographic Representation Slots".
function geographicQuotas(rankedTeams, alreadyAllocated) {
  const schoolsByRegion = new Map();
  for (const team of rankedTeams) {
    if (!schoolsByRegion.has(team.region)) {
      schoolsByRegion.set(team.region, new Set());
    }
    schoolsByRegion.get(team.region).add(team.school);
  }

  const quotas = new Map();
  if (alreadyAllocated >= N) return quotas;

  let nSchoolsLatam = 0;
  for (const schools of schoolsByRegion.values()) nSchoolsLatam += schools.size;

  let allocated = alreadyAllocated;
  const slotsRatio = nSchoolsLatam / (N - allocated);
  const fractions = new Map();
  for (const [region, schools] of schoolsByRegion) {
    const exact = schools.size / slotsRatio;
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

  return quotas;
}
