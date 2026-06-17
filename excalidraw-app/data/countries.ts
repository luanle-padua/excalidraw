// ISO-3166 alpha-2 country list (06-17) shared by the CLIENT-BRANDING UI: the
// admin tags a backdrop with a country, and a host tags a guest with their
// country (which picks that client's entry-page backdrop). The flag emoji is
// derived from the code (regional-indicator letters) — no asset/lib needed. The
// markets MAP-GROUP is going multinational into (VN/KR/US/IN/PL/PH…) lead.

export type Country = { code: string; name: string };

/** A pragmatic subset (not all 249) — the markets in play plus common ones.
 *  Add a row to extend; the worker accepts ANY well-formed alpha-2, so this is
 *  purely the picker's menu, never a server allow-list. */
export const COUNTRIES: readonly Country[] = [
  { code: "VN", name: "Vietnam" },
  { code: "KR", name: "South Korea" },
  { code: "US", name: "United States" },
  { code: "IN", name: "India" },
  { code: "PL", name: "Poland" },
  { code: "PH", name: "Philippines" },
  { code: "JP", name: "Japan" },
  { code: "CN", name: "China" },
  { code: "ID", name: "Indonesia" },
  { code: "TH", name: "Thailand" },
  { code: "MY", name: "Malaysia" },
  { code: "SG", name: "Singapore" },
  { code: "AU", name: "Australia" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "NL", name: "Netherlands" },
  { code: "CA", name: "Canada" },
  { code: "BR", name: "Brazil" },
  { code: "MX", name: "Mexico" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "ZA", name: "South Africa" },
  { code: "NG", name: "Nigeria" },
  { code: "EG", name: "Egypt" },
  { code: "TR", name: "Türkiye" },
  { code: "RU", name: "Russia" },
  { code: "KH", name: "Cambodia" },
  { code: "LA", name: "Laos" },
  { code: "MM", name: "Myanmar" },
  { code: "TW", name: "Taiwan" },
  { code: "HK", name: "Hong Kong" },
];

/** Normalize free input to a known/well-formed alpha-2 (upper-case) or "". */
export const normCountryCode = (v: string | null | undefined): string => {
  const s = (v ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : "";
};

/** Country name for a code (falls back to the bare code when unknown). */
export const countryName = (code: string | null | undefined): string => {
  const c = normCountryCode(code);
  return COUNTRIES.find((x) => x.code === c)?.name ?? c;
};

/** Flag emoji for an alpha-2 code (regional-indicator letters); "" when unset
 *  or malformed. Works without any flag asset. */
export const countryFlag = (code: string | null | undefined): string => {
  const c = normCountryCode(code);
  if (!c) {
    return "";
  }
  return String.fromCodePoint(
    ...[...c].map((ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65)),
  );
};
