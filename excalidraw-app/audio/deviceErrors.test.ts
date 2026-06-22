// Unit tests for the PURE Daily-payload → device/fatal error-code mappings
// (Phase 2). These functions are the single boundary that translates Daily's
// structured `camera-error` / fatal `error` payloads (and the raw getUserMedia
// DOMException name) into our language-neutral CODES, which the UI maps to an
// i18n string at render time. A regression here silently shows the wrong
// guidance (or none) for a permission block / full meeting / expired token.
//
//   npx vitest run excalidraw-app/audio/deviceErrors.test.ts   (from repo root)

import { describe, expect, it } from "vitest";

import { fatalErrorKindFor } from "./audioState";
import {
  cameraErrorAffectsVideo,
  cameraErrorKindFor,
  cameraErrorKindForDomException,
} from "./videoState";

describe("cameraErrorKindFor (Daily camera-error.error.type → CameraErrorKind)", () => {
  it("maps 'permissions' to 'permissions' (drives the allow-camera prompt)", () => {
    expect(cameraErrorKindFor("permissions")).toBe("permissions");
  });

  it("collapses every device-in-use variant to 'in-use'", () => {
    expect(cameraErrorKindFor("cam-in-use")).toBe("in-use");
    expect(cameraErrorKindFor("mic-in-use")).toBe("in-use");
    expect(cameraErrorKindFor("cam-mic-in-use")).toBe("in-use");
  });

  it("maps 'not-found' and 'constraints' through", () => {
    expect(cameraErrorKindFor("not-found")).toBe("not-found");
    expect(cameraErrorKindFor("constraints")).toBe("constraints");
  });

  it("collapses unknown / undefined / future types to 'other' (never swallowed silently)", () => {
    expect(cameraErrorKindFor("undefined-mediadevices")).toBe("other");
    expect(cameraErrorKindFor("unknown")).toBe("other");
    expect(cameraErrorKindFor(undefined)).toBe("other");
    expect(cameraErrorKindFor("some-future-type")).toBe("other");
  });
});

describe("cameraErrorKindForDomException (getUserMedia DOMException.name → CameraErrorKind)", () => {
  it("maps the permission-denied family to 'permissions'", () => {
    expect(cameraErrorKindForDomException("NotAllowedError")).toBe(
      "permissions",
    );
    expect(cameraErrorKindForDomException("PermissionDeniedError")).toBe(
      "permissions",
    );
    expect(cameraErrorKindForDomException("SecurityError")).toBe("permissions");
  });

  it("maps the device-busy family to 'in-use'", () => {
    expect(cameraErrorKindForDomException("NotReadableError")).toBe("in-use");
    expect(cameraErrorKindForDomException("TrackStartError")).toBe("in-use");
  });

  it("maps the no-device family to 'not-found'", () => {
    expect(cameraErrorKindForDomException("NotFoundError")).toBe("not-found");
    expect(cameraErrorKindForDomException("DevicesNotFoundError")).toBe(
      "not-found",
    );
  });

  it("maps the over-constrained family to 'constraints'", () => {
    expect(cameraErrorKindForDomException("OverconstrainedError")).toBe(
      "constraints",
    );
    expect(cameraErrorKindForDomException("ConstraintNotSatisfiedError")).toBe(
      "constraints",
    );
  });

  it("falls back to 'other' for an unknown / missing name", () => {
    expect(cameraErrorKindForDomException("AbortError")).toBe("other");
    expect(cameraErrorKindForDomException(undefined)).toBe("other");
  });
});

describe("cameraErrorAffectsVideo (Daily camera-error → does it implicate the camera?)", () => {
  it("treats a pure mic-in-use error as NOT affecting video (keeps the self-view live)", () => {
    expect(cameraErrorAffectsVideo({ type: "mic-in-use" })).toBe(false);
  });

  it("honours Daily's videoOk:true flag — video is fine even on a mic failure", () => {
    expect(
      cameraErrorAffectsVideo({ type: "permissions", videoOk: true }),
    ).toBe(false);
    // videoOk wins over an ambiguous unknown type.
    expect(cameraErrorAffectsVideo({ type: "unknown", videoOk: true })).toBe(
      false,
    );
  });

  it("treats an audio-only media array (no 'video') as NOT affecting video", () => {
    // permissions blockedMedia=["audio"], not-found missingMedia=["audio"],
    // constraints failedMedia=["audio"] all flow through affectedMedia.
    expect(
      cameraErrorAffectsVideo({
        type: "permissions",
        affectedMedia: ["audio"],
      }),
    ).toBe(false);
    expect(
      cameraErrorAffectsVideo({ type: "not-found", affectedMedia: ["audio"] }),
    ).toBe(false);
    expect(
      cameraErrorAffectsVideo({
        type: "constraints",
        affectedMedia: ["audio"],
      }),
    ).toBe(false);
  });

  it("treats a media array that lists 'video' as affecting video", () => {
    expect(
      cameraErrorAffectsVideo({
        type: "permissions",
        affectedMedia: ["video"],
      }),
    ).toBe(true);
    expect(
      cameraErrorAffectsVideo({
        type: "permissions",
        affectedMedia: ["audio", "video"],
      }),
    ).toBe(true);
  });

  it("assumes video IS affected for cam-in-use / cam-mic-in-use", () => {
    expect(cameraErrorAffectsVideo({ type: "cam-in-use" })).toBe(true);
    expect(cameraErrorAffectsVideo({ type: "cam-mic-in-use" })).toBe(true);
  });

  it("fails safe to video-affected for an ambiguous / unknown payload", () => {
    expect(cameraErrorAffectsVideo({ type: undefined })).toBe(true);
    expect(cameraErrorAffectsVideo({ type: "unknown" })).toBe(true);
    expect(cameraErrorAffectsVideo({ type: "permissions" })).toBe(true);
    // videoOk:false is an explicit "video failed".
    expect(
      cameraErrorAffectsVideo({ type: "cam-mic-in-use", videoOk: false }),
    ).toBe(true);
  });
});

describe("fatalErrorKindFor (Daily fatal error.type → AudioErrorKind)", () => {
  it("maps 'meeting-full' to 'meeting-full'", () => {
    expect(fatalErrorKindFor("meeting-full")).toBe("meeting-full");
  });

  it("collapses the room/token expiry family to 'token-expired' (same fix: refresh / rejoin)", () => {
    expect(fatalErrorKindFor("exp-token")).toBe("token-expired");
    expect(fatalErrorKindFor("exp-room")).toBe("token-expired");
    expect(fatalErrorKindFor("nbf-token")).toBe("token-expired");
    expect(fatalErrorKindFor("nbf-room")).toBe("token-expired");
  });

  it("collapses every other / undefined type to the generic 'call' (nothing swallowed)", () => {
    expect(fatalErrorKindFor("ejected")).toBe("call");
    expect(fatalErrorKindFor("not-allowed")).toBe("call");
    expect(fatalErrorKindFor("connection-error")).toBe("call");
    expect(fatalErrorKindFor("end-of-life")).toBe("call");
    expect(fatalErrorKindFor("no-room")).toBe("call");
    expect(fatalErrorKindFor(undefined)).toBe("call");
  });
});
