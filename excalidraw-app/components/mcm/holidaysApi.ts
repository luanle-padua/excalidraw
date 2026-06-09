// Public holidays for the countries the team works across (Korea + Vietnam),
// fetched on demand from a FREE, key-less, CORS-enabled API instead of being
// hard-coded. Lunar holidays (Seollal/Chuseok in KR, Tết in VN) and statutory
// substitute days shift every year, so a baked-in table goes stale — this asks
// the source of truth per visible year instead.
//
// Source: Nager.Date — https://date.nager.at
//   GET https://date.nager.at/api/v3/PublicHolidays/{year}/{KR|VN}
//   → [{ date: "2026-02-17", localName: "설날", name: "Lunar New Year", ... }]
//   Free, no API key, sends CORS headers (works straight from the browser).
//
// Consumed by CalendarX to paint Sundays + holidays red and Saturdays blue in
// the month grid (and tint those cells), showing the holiday name in the cell.
//
// Resilience: any per-country failure contributes an empty set — the calendar
// keeps working. Results are cached in-module (per year) and, when available,
// in localStorage with a TTL so navigating months doesn't refetch.

/** A "YYYY-MM-DD" → holiday-name map, the shape CalendarX consumes. */
export type HolidayMap = ReadonlyMap<string, string>;

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
}

/** Countries whose public holidays we surface (the team is global). Add more
 *  ISO-3166 codes here and they're fetched + merged automatically. */
const COUNTRIES = ["KR", "VN"] as const;

const endpoint = (year: number, country: string): string =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`;

// In-module cache (merged across countries) + in-flight dedupe, keyed by year.
const memCache = new Map<number, HolidayMap>();
const inFlight = new Map<number, Promise<HolidayMap>>();

const LS_PREFIX = "mcm.holidays.";
const LS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — holiday tables are stable

interface CachedShape {
  fetchedAt: number;
  entries: [string, string][];
}

const readLocalStorage = (year: number): HolidayMap | null => {
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + year);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CachedShape;
    if (
      !parsed ||
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray(parsed.entries) ||
      Date.now() - parsed.fetchedAt > LS_TTL_MS
    ) {
      return null;
    }
    return new Map(parsed.entries);
  } catch {
    return null;
  }
};

const writeLocalStorage = (year: number, map: HolidayMap): void => {
  try {
    const payload: CachedShape = {
      fetchedAt: Date.now(),
      entries: [...map.entries()],
    };
    window.localStorage.setItem(LS_PREFIX + year, JSON.stringify(payload));
  } catch {
    // Quota / unavailable / SSR — the in-module cache still covers the session.
  }
};

/** Fetch one country's holidays for a year; resolves to [] on any failure so a
 *  single country's outage doesn't lose the others. */
const fetchCountry = (year: number, country: string): Promise<NagerHoliday[]> =>
  fetch(endpoint(year, country), { headers: { Accept: "application/json" } })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Nager.Date ${country} ${res.status}`);
      }
      return res.json() as Promise<NagerHoliday[]>;
    })
    .then((rows) => (Array.isArray(rows) ? rows : []))
    .catch(() => []);

/**
 * Public holidays (Korea + Vietnam) for `year` as a "YYYY-MM-DD" → name map.
 * On-demand + cached; never rejects (failures degrade to fewer/no holidays).
 * Dates that are a holiday in both countries combine their names with " · ".
 */
export const getHolidays = (year: number): Promise<HolidayMap> => {
  const mem = memCache.get(year);
  if (mem) {
    return Promise.resolve(mem);
  }
  const pending = inFlight.get(year);
  if (pending) {
    return pending;
  }
  const fromLs = readLocalStorage(year);
  if (fromLs) {
    memCache.set(year, fromLs);
    return Promise.resolve(fromLs);
  }

  const request = Promise.all(COUNTRIES.map((cc) => fetchCountry(year, cc)))
    .then((perCountry) => {
      const map = new Map<string, string>();
      for (const rows of perCountry) {
        for (const row of rows) {
          if (!row || typeof row.date !== "string" || map.has(row.date)) {
            continue;
          }
          // First country (see COUNTRIES order) wins for a shared date — we show
          // ONE name so a long "KR · VN" string can't blow out the cell.
          map.set(row.date, row.localName || row.name || row.date);
        }
      }
      memCache.set(year, map);
      writeLocalStorage(year, map);
      return map as HolidayMap;
    })
    .catch(() => {
      const empty: HolidayMap = new Map();
      memCache.set(year, empty);
      return empty;
    })
    .finally(() => {
      inFlight.delete(year);
    });

  inFlight.set(year, request);
  return request;
};

/** Back-compat alias (CalendarX historically imported this name). */
export const getKoreanHolidays = getHolidays;
