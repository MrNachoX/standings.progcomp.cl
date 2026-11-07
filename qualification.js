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
  const best = (predicate) =>
    rankedTeams.find((team) => isOpen(team) && predicate(team));
  const isAllWomen = (team) => team.women >= 3;

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
      best((t) => HOST_SCHOOLS.has(t.school)),
      "host",
      `Host institution slot: best team from ${hostSchools}, since the host ` +
        `had no team qualified by performance or country.`
    );
  }

  // I.4 Geographic representation, up to N teams.
  const geo = geographicQuotas(rankedTeams, slots.size);
  for (const [region, quota] of geo.quotas) {
    for (let i = 0; i < quota; i++) {
      const team = best((t) => t.region === region && isNewSchool(t));
      if (!team) break;
      qualify(
        team,
        "geographic",
        `Geographic slot ${i + 1} of ${quota} for ${regionName(region)}: the ` +
          `${geo.open} slots left up to ${N} are split by number of ` +
          `institutions (${regionName(region)} has ${geo.schools.get(region)} ` +
          `of ${geo.total}); best ${regionName(region)} team from an ` +
          `institution with no qualified team yet.`
      );
    }
  }

  // All-female slots (general rule does not apply).
  qualify(
    best((t) => isAllWomen(t) && t.country === HOST_COUNTRY),
    "women-host-country",
    `All-women slot for the host country: best all-women team from ` +
      `${countryName(HOST_COUNTRY)} not yet qualified.`
  );
  qualify(
    best(isAllWomen),
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
    best((t) => isAllWomen(t) && HOST_SCHOOLS.has(t.school)),
    "women-host",
    `Host all-women slot: best all-women team from ${hostSchools} not yet ` +
      `qualified.`
  );

  const regions = [...new Set(rankedTeams.map((team) => team.region))];
  for (const region of regions) {
    qualify(
      best((t) => isAllWomen(t) && t.region === region),
      "women-region",
      `All-women slot for ${regionName(region)}: best all-women team from ` +
        `${regionName(region)} not yet qualified (one per region).`
    );
  }

  for (let i = 0; i < 3; i++) {
    qualify(
      best((t) => t.women >= 2),
      "two-women",
      `Two-women slot ${i + 1} of 3: best team in Latin America with at least ` +
        `two women not yet qualified.`
    );
  }
  for (let i = 0; i < 3; i++) {
    qualify(
      best((t) => t.women >= 1),
      "one-woman",
      `One-woman slot ${i + 1} of 3: best team in Latin America with at least ` +
        `one woman not yet qualified.`
    );
  }

  COUNTRY_PARTICIPATION_SLOTS.forEach(({ country, teams, slots: count }, index) => {
    for (let i = 0; i < count; i++) {
      qualify(
        best((t) => t.country === country && isNewSchool(t)),
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
      best((t) => HOST_SCHOOLS.has(t.school)),
      "host-extra",
      `Extra host slot ${i + 1} of 2: best team from ${hostSchools} not yet ` +
        `qualified.`
    );
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
  let nSchoolsLatam = 0;
  for (const schools of schoolsByRegion.values()) nSchoolsLatam += schools.size;
  const result = {
    quotas,
    open: Math.max(N - alreadyAllocated, 0),
    total: nSchoolsLatam,
    schools: new Map([...schoolsByRegion].map(([r, set]) => [r, set.size])),
  };
  if (alreadyAllocated >= N) return result;

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

  return result;
}
