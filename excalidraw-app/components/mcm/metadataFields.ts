import type { EditorField } from "./MetadataEditor";
import type { Project } from "../../data/projects";

// Canonical Tier-1 option lists (English). "" => the blank "—" choice.
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
    label: "Name",
    value: p.name,
    required: true,
    fullWidth: true,
  },
  {
    key: "cover",
    label: "Cover image",
    value: p.cover ?? "",
    type: "image",
  },
  {
    key: "code",
    label: "Project code",
    value: p.code ?? "",
    placeholder: "e.g. MAP-2026-014",
  },
  {
    key: "client",
    label: "Client",
    value: p.client ?? "",
    placeholder: "Client / owner",
  },
  {
    key: "location",
    label: "Location",
    value: p.location ?? "",
    placeholder: "City, country",
  },
  {
    key: "branch",
    label: "Branch / office",
    value: p.branch ?? "",
    placeholder: "Studio / office",
  },
  {
    key: "stage",
    label: "Phase",
    value: p.stage ?? "",
    type: "select",
    options: withLegacy(PHASE, p.stage ?? ""),
  },
  {
    key: "type",
    label: "Project type",
    value: p.type ?? "",
    type: "select",
    options: withLegacy(PRJ_TYPE, p.type ?? ""),
  },
  {
    key: "description",
    label: "Description",
    value: p.description ?? "",
    placeholder: "Notes",
    multiline: true,
  },
];

export const buildMeetingFields = (m: MeetingFieldsInput): EditorField[] => [
  {
    key: "title",
    label: "Title",
    value: m.title ?? "",
    required: true,
    fullWidth: true,
  },
  {
    key: "topic",
    label: "Topic",
    value: m.topic ?? "",
    placeholder: "Agenda / focus",
    fullWidth: true,
  },
  {
    key: "type",
    label: "Meeting type",
    value: m.type ?? "",
    type: "select",
    options: withLegacy(MTG_TYPE, m.type ?? ""),
  },
  {
    key: "discipline",
    label: "Discipline",
    value: m.discipline ?? "",
    type: "select",
    options: withLegacy(DISCIPLINE, m.discipline ?? ""),
  },
  {
    key: "priority",
    label: "Priority",
    value: m.priority ?? "",
    type: "select",
    options: withLegacy(PRIORITY, m.priority ?? ""),
  },
  {
    key: "confidentiality",
    label: "Confidentiality",
    value: m.confidentiality ?? "",
    type: "select",
    options: withLegacy(CONFIDENTIALITY, m.confidentiality ?? ""),
  },
  {
    key: "scheduled_at",
    label: "Scheduled date",
    value: m.scheduled_at ?? "",
    type: "date",
  },
  {
    key: "description",
    label: "Description",
    value: m.description ?? "",
    placeholder: "Notes",
    multiline: true,
  },
];
