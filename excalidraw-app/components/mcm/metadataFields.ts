import type { EditorField } from "./MetadataEditor";
import type { McmKey } from "../../i18n/mcm";
import type { Project } from "../../data/projects";

// Canonical Tier-1 option lists (English). "" => the blank "—" choice.
// IMPORTANT: these are the STORED values (D1 rows, filters, peers) — they
// stay English on purpose. Only the rendered label localises, via
// `metaOptionLabel` below. `label`/`placeholder` on the built fields are
// i18n KEYS (meta.field.* / meta.ph.*) translated by MetadataEditor at
// render time, so this hook-less module never needs the viewer's locale.
const PHASE = [
  "",
  "Concept",
  "Schematic design",
  "Design development",
  "Construction docs",
  "Construction",
  "Handover",
];
const PRJ_TYPE = [
  "",
  "Residential",
  "Commercial",
  "Mixed-use",
  "Public",
  "Industrial",
  "Other",
];
// Exported: the meeting edit form (EditMeetingForm) renders these same
// vocabularies so create/edit/metadata stay one consistent data set.
export const MTG_TYPE = [
  "",
  "Design review",
  "Kickoff",
  "Coordination",
  "Client presentation",
  "Internal sync",
  "QA-QC",
  "Other",
];
// NOTE: meeting `status` is deliberately NOT an editor field — the lifecycle
// (scheduled → live → finished | cancelled) only moves through its actions
// (Start / End-for-all / Cancel / Restore) and is guarded server-side. A
// free-text dropdown here let users jump states arbitrarily (even out of the
// immutable `finished`).
export const DISCIPLINE = [
  "",
  "Architecture",
  "Structure",
  "MEP",
  "Façade",
  "Interior",
  "Landscape",
  "General",
];
export const PRIORITY = ["", "Low", "Normal", "High"];
export const CONFIDENTIALITY = [
  "",
  "Internal",
  "Client-shared",
  "Confidential",
];

// Canonical option value → display-label i18n key. Legacy / free-text
// values fall through `metaOptionLabel` unchanged (shown verbatim).
const OPTION_LABEL_KEY: Record<string, McmKey> = {
  Concept: "meta.option.concept",
  "Schematic design": "meta.option.schematicDesign",
  "Design development": "meta.option.designDevelopment",
  "Construction docs": "meta.option.constructionDocs",
  Construction: "meta.option.construction",
  Handover: "meta.option.handover",
  Residential: "meta.option.residential",
  Commercial: "meta.option.commercial",
  "Mixed-use": "meta.option.mixedUse",
  Public: "meta.option.public",
  Industrial: "meta.option.industrial",
  Other: "meta.option.other",
  "Design review": "meta.option.designReview",
  Kickoff: "meta.option.kickoff",
  Coordination: "meta.option.coordination",
  "Client presentation": "meta.option.clientPresentation",
  "Internal sync": "meta.option.internalSync",
  "QA-QC": "meta.option.qaqc",
  Architecture: "meta.option.architecture",
  Structure: "meta.option.structure",
  MEP: "meta.option.mep",
  Façade: "meta.option.facade",
  Interior: "meta.option.interior",
  Landscape: "meta.option.landscape",
  General: "meta.option.general",
  Low: "meta.option.low",
  Normal: "meta.option.normal",
  High: "meta.option.high",
  Internal: "meta.option.internal",
  "Client-shared": "meta.option.clientShared",
  Confidential: "meta.option.confidential",
};

/** Localised DISPLAY label for a stored option value. Pass the `t`
 *  returned by `useT()`; unknown (legacy/custom) values render as-is. */
export const metaOptionLabel = (
  translate: (key: McmKey) => string,
  value: string,
): string => {
  const key = OPTION_LABEL_KEY[value];
  return key ? translate(key) : value;
};

// Keep a legacy/free-text value (e.g. an older "Thiet ke co so" stage)
// selectable: prepend it if it isn't already a canonical option.
export const withLegacy = (opts: string[], current: string): string[] =>
  current && !opts.includes(current) ? [current, ...opts] : opts;

/** Shape the meeting editor passes (a merged getMeeting / draft object). */
export type MeetingFieldsInput = {
  title?: string | null;
  topic?: string | null;
  description?: string | null;
  type?: string | null;
  status?: string | null;
  discipline?: string | null;
  priority?: string | null;
  confidentiality?: string | null;
  scheduled_at?: string | null;
};

export const buildProjectFields = (p: Project): EditorField[] => [
  {
    key: "name",
    label: "meta.field.name",
    value: p.name,
    required: true,
    fullWidth: true,
  },
  {
    key: "cover",
    label: "meta.field.cover",
    value: p.cover ?? "",
    type: "image",
  },
  {
    key: "code",
    label: "meta.field.code",
    value: p.code ?? "",
    placeholder: "meta.ph.code",
  },
  {
    key: "client",
    label: "meta.field.client",
    value: p.client ?? "",
    placeholder: "meta.ph.client",
  },
  {
    key: "location",
    label: "meta.field.location",
    value: p.location ?? "",
    placeholder: "meta.ph.location",
  },
  {
    key: "branch",
    label: "meta.field.branch",
    value: p.branch ?? "",
    placeholder: "meta.ph.branch",
  },
  {
    key: "stage",
    label: "meta.field.phase",
    value: p.stage ?? "",
    type: "select",
    options: withLegacy(PHASE, p.stage ?? ""),
  },
  {
    key: "type",
    label: "meta.field.projectType",
    value: p.type ?? "",
    type: "select",
    options: withLegacy(PRJ_TYPE, p.type ?? ""),
  },
  {
    key: "description",
    label: "meta.field.description",
    value: p.description ?? "",
    placeholder: "meta.ph.notes",
    multiline: true,
  },
];

export const buildMeetingFields = (m: MeetingFieldsInput): EditorField[] => [
  {
    key: "title",
    label: "meta.field.title",
    value: m.title ?? "",
    required: true,
    fullWidth: true,
  },
  {
    key: "topic",
    label: "meta.field.topic",
    value: m.topic ?? "",
    placeholder: "meta.ph.topic",
    fullWidth: true,
  },
  {
    key: "type",
    label: "meta.field.meetingType",
    value: m.type ?? "",
    type: "select",
    options: withLegacy(MTG_TYPE, m.type ?? ""),
  },
  {
    key: "discipline",
    label: "meta.field.discipline",
    value: m.discipline ?? "",
    type: "select",
    options: withLegacy(DISCIPLINE, m.discipline ?? ""),
  },
  {
    key: "priority",
    label: "meta.field.priority",
    value: m.priority ?? "",
    type: "select",
    options: withLegacy(PRIORITY, m.priority ?? ""),
  },
  {
    key: "confidentiality",
    label: "meta.field.confidentiality",
    value: m.confidentiality ?? "",
    type: "select",
    options: withLegacy(CONFIDENTIALITY, m.confidentiality ?? ""),
  },
  {
    key: "scheduled_at",
    label: "meta.field.scheduledDate",
    value: m.scheduled_at ?? "",
    type: "date",
  },
  {
    key: "description",
    label: "meta.field.description",
    value: m.description ?? "",
    placeholder: "meta.ph.notes",
    multiline: true,
  },
];
