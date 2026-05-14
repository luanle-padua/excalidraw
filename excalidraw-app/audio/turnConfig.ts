// Fetches short-lived ICE server credentials (Cloudflare TURN) from the
// room server's /turn-credentials proxy. The long-lived Cloudflare API
// token never leaves the server — the browser only ever sees TURN
// username/password good for ~24h.
//
// Module-level cache avoids re-fetching on every peer connection inside
// a single session.

export type IceServersConfig = {
  iceServers: RTCIceServer[];
};

const STUN_FALLBACK: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

let cached: IceServersConfig | null = null;
let inflight: Promise<IceServersConfig> | null = null;

const normalizeIceServers = (raw: any): RTCIceServer[] => {
  // Cloudflare's response is { iceServers: { urls, username, credential } },
  // i.e. a single bag, not an array. RTCPeerConnection accepts either; we
  // normalize to an array so the rest of the code is uniform.
  if (!raw || typeof raw !== "object") {
    return STUN_FALLBACK;
  }
  if (Array.isArray(raw.iceServers)) {
    return raw.iceServers as RTCIceServer[];
  }
  if (raw.iceServers) {
    return [raw.iceServers as RTCIceServer];
  }
  return STUN_FALLBACK;
};

export const getIceServers = async (): Promise<IceServersConfig> => {
  if (cached) {
    return cached;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const res = await fetch("/turn-credentials", { method: "GET" });
      if (!res.ok) {
        // 503 = TURN not configured on server; that's expected in fresh
        // checkouts. Fall back to STUN-only so same-LAN calls still work.
        return { iceServers: STUN_FALLBACK };
      }
      const body = await res.json();
      const iceServers = normalizeIceServers(body);
      const config = { iceServers };
      cached = config;
      return config;
    } catch (err) {
      console.warn("TURN credentials fetch failed; falling back to STUN", err);
      return { iceServers: STUN_FALLBACK };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
};

export const resetIceServersCache = () => {
  cached = null;
};
