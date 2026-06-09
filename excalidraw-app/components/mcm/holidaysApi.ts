// Korean public holidays, fetched on demand from a FREE, key-less, CORS-enabled
// API instead of being hard-coded. Lunar holidays (Seollal, Chuseok, Buddha's
// Birthday) and the statutory substitute holidays (대체공휴일) shift every year,
// so a baked-in table goes stale — this asks the source of truth per visible
// year instead.
//
// Source: Nager.Date — https://date.nager.at
//   GET https://date.nager.at/api/v3/PublicHolidays/{year}/KR
//   → [{ date: "2026-02-17", localName: "설날", name: "Lunar New Year", ... }]
//   Free, no API key, sends CORS headers (works straight from the browser).
//
// Consumed by CalendarX to paint Sundays + holidays red and Saturdays blue in
// the month grid (Korean "빨간 날" red-calendar convention) and to show the
// holiday name in the day cell.
//
// Resilience: any network/parse error resolves to an EMPTY map — the calendar
// keeps working, it just won't tint holidays that year. Results are cached
// in-module (per year, for the page session) and, when available, in
// localStorage with a TTL so navigating across months doesn't refetch.

/** A "YYYY-MM-DD" → holiday-name map, the shape CalendarX consumes. */
export type HolidayMap = ReadonlyMap<string, string>;

/** One entry from the Nager.Date PublicHolidays response (only the fields we
 *  use; the API returns more — countryCode, fixed, global, counties,
 *  launchYear, types). */
interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
}

const COUNTRY = "KR";
const endpoint = (year: number): string =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/${COUNTRY}`;

// In-module cache: resolved maps and in-flight requests, both keyed by year, so
// concurrent callers for the same year share one fetch and later callers reuse
// the result without another network round-trip.
const memCache = new Map<number, HolidayMap>();
const inFlight = new Map<number, Promise<HolidayMap>>();

// localStorage cache (best-effort — may be unavailable in private mode / SSR).
const LS_PREFIX = "mcm.holidays.kr.";
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
    // Quota / unavailable / SSR — fine, the in-module cache still covers the
    // session.
  }
};

/** Build the "YYYY-MM-DD" → localName map from the raw API rows. Multiple rows
 *  can share a date (e.g. overlapping holidays); the first localName wins. We
 *  prefer `localName` (Korean) and fall back to the English `name`. */
const toMap = (rows: NagerHoliday[]): HolidayMap => {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row && typeof row.date === "string" && !map.has(row.date)) {
      map.set(row.date, row.localName || row.name || row.date);
    }
  }
  return map;
};

/**
 * Korean public holidays for `year` as a "YYYY-MM-DD" → name map.
 *
 * On-demand and cached: returns the in-module map if present, else a fresh
 * localStorage hit (within TTL), else fetches from Nager.Date. Never rejects —
 * a network/parse failure resolves to an empty map so the calendar still works.
 */
export const getKoreanHolidays = (year: number): Promise<HolidayMap> => {
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

  const request = fetch(endpoint(year), {
    headers: { Accept: "application/json" },
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Nager.Date ${res.status}`);
      }
      return res.json() as Promise<NagerHoliday[]>;
    })
    .then((rows) => {
      const map = toMap(Array.isArray(rows) ? rows : []);
      memCache.set(year, map);
      writeLocalStorage(year, map);
      return map;
    })
    .catch(() => {
      // Fail gracefully: cache an empty map for this session so we don't hammer
      // a flaky network on every month-navigation, and the UI degrades cleanly.
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

/** The holiday name for a "YYYY-MM-DD" key within an already-fetched map, or
 *  undefined when it isn't a public holiday. Pure helper over a HolidayMap. */
export const holidayNameIn = (
  map: HolidayMap,
  dayKey: string,
): string | undefined => map.get(dayKey);
