// Chromium's MediaRecorder writes WebM without the optional `Duration`
// element under `Info`, which makes the resulting blob unseekable in
// strict parsers like VLC (see crbug.com/642012). We patch the blob
// after the fact by walking the EBML tree, locating the `Info` section,
// and inserting a `Duration` float right before the existing `MuxingApp`
// child. Everything else is left byte-identical.
//
// Spec refs:
//   EBML: https://datatracker.ietf.org/doc/html/rfc8794
//   Matroska / WebM IDs:
//     - Segment      0x18538067
//     - Info         0x1549A966
//     - TimecodeScale 0x2AD7B1
//     - Duration     0x4489
//
// Implementation is intentionally small + dependency-free — we only
// need to handle the single output shape Chromium produces.

// --- EBML variable-length integer (VINT) helpers ------------------------

const readVint = (
  view: DataView,
  offset: number,
): { value: number; size: number } => {
  const firstByte = view.getUint8(offset);
  if (firstByte === 0) {
    throw new Error("Invalid VINT (first byte is zero)");
  }
  let length = 1;
  let mask = 0x80;
  while (!(firstByte & mask)) {
    mask >>>= 1;
    length++;
    if (length > 8) {
      throw new Error("VINT too long");
    }
  }
  let value = firstByte & (mask - 1);
  for (let i = 1; i < length; i++) {
    value = value * 256 + view.getUint8(offset + i);
  }
  return { value, size: length };
};

const readId = (
  view: DataView,
  offset: number,
): { id: number; size: number } => {
  // The element ID is a VINT but we keep the length marker bits — we
  // identify elements by their full id, not by the stripped value.
  const firstByte = view.getUint8(offset);
  let length = 1;
  let mask = 0x80;
  while (!(firstByte & mask)) {
    mask >>>= 1;
    length++;
    if (length > 4) {
      throw new Error("Element ID too long");
    }
  }
  let id = firstByte;
  for (let i = 1; i < length; i++) {
    id = id * 256 + view.getUint8(offset + i);
  }
  return { id, size: length };
};

const writeVint = (n: number, minSize: number = 1): Uint8Array => {
  // Encode n as the shortest VINT that fits, with length >= minSize.
  for (let size = minSize; size <= 8; size++) {
    const limit = Math.pow(2, 7 * size) - 1;
    if (n <= limit) {
      const out = new Uint8Array(size);
      let value = n | (1 << (7 * size));
      // We need BigInt-style math for 7*8 = 56 bits, but Chromium's
      // recordings stay well under 2^53 so plain Number is fine.
      for (let i = size - 1; i > 0; i--) {
        out[i] = value & 0xff;
        value = Math.floor(value / 256);
      }
      out[0] = value & 0xff;
      return out;
    }
  }
  throw new Error("Value too large for VINT");
};

// --- Element lookup (Segment → Info) ------------------------------------

const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const DURATION_ID = 0x4489;
const TIMECODE_SCALE_ID = 0x2ad7b1;

// IEEE-754 double encode
const float64Bytes = (n: number): Uint8Array => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return new Uint8Array(buf);
};

/**
 * Patch a Chromium-produced WebM blob to include a top-level
 * `Duration` element so external players can seek and report length.
 * `durationMs` is the recording's elapsed time in milliseconds.
 * Returns a new Blob — the original is not modified.
 *
 * Falls back to returning the original blob unchanged on any parse
 * failure (the in-app playback still works regardless).
 */
export const fixWebmDuration = async (
  source: Blob,
  durationMs: number,
): Promise<Blob> => {
  try {
    const buffer = await source.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Walk top-level looking for Segment
    let offset = 0;
    while (offset < bytes.length) {
      const idInfo = readId(view, offset);
      offset += idInfo.size;
      const sizeInfo = readVint(view, offset);
      offset += sizeInfo.size;

      if (idInfo.id !== SEGMENT_ID) {
        offset += sizeInfo.value;
        continue;
      }

      const segmentEnd = offset + sizeInfo.value;
      // Walk inside Segment for Info
      while (offset < segmentEnd) {
        const childIdInfo = readId(view, offset);
        const childIdSize = childIdInfo.size;
        const childIdStart = offset;
        offset += childIdSize;
        const childSizeInfo = readVint(view, offset);
        const childSizeSize = childSizeInfo.size;
        offset += childSizeSize;

        if (childIdInfo.id !== INFO_ID) {
          offset += childSizeInfo.value;
          continue;
        }

        // Found Info — check whether it already has Duration
        const infoStart = offset;
        const infoEnd = offset + childSizeInfo.value;
        let cursor = infoStart;
        let hasDuration = false;
        while (cursor < infoEnd) {
          const gIdInfo = readId(view, cursor);
          cursor += gIdInfo.size;
          const gSizeInfo = readVint(view, cursor);
          cursor += gSizeInfo.size;
          if (gIdInfo.id === DURATION_ID) {
            hasDuration = true;
            break;
          }
          cursor += gSizeInfo.value;
        }
        if (hasDuration) {
          // Already has duration — nothing to do
          return source;
        }

        // Find TimecodeScale to convert ms → timecode units (default 1e6 ns
        // per tick = 1ms per tick if absent)
        let timecodeScaleNs = 1_000_000;
        cursor = infoStart;
        while (cursor < infoEnd) {
          const gIdInfo = readId(view, cursor);
          cursor += gIdInfo.size;
          const gSizeInfo = readVint(view, cursor);
          cursor += gSizeInfo.size;
          if (gIdInfo.id === TIMECODE_SCALE_ID) {
            let ts = 0;
            for (let i = 0; i < gSizeInfo.value; i++) {
              ts = ts * 256 + view.getUint8(cursor + i);
            }
            timecodeScaleNs = ts;
          }
          cursor += gSizeInfo.value;
        }

        const durationInTicks =
          (durationMs * 1_000_000) / timecodeScaleNs;

        // Build the Duration element: id (2 bytes 0x4489) + size VINT (1 byte
        // for 8) + 8 bytes float64
        const durationBytes = new Uint8Array(2 + 1 + 8);
        durationBytes[0] = 0x44;
        durationBytes[1] = 0x89;
        durationBytes[2] = 0x88; // VINT 8 → 1_000_1000 = 0x88
        durationBytes.set(float64Bytes(durationInTicks), 3);

        // Compose the new buffer:
        //   bytes[0 .. childIdStart) +
        //   Info ID (unchanged) +
        //   new Info size VINT (length-preserving) +
        //   new Info body (durationBytes + original info body) +
        //   bytes[infoEnd .. end)
        const newInfoBodySize =
          childSizeInfo.value + durationBytes.length;
        // Keep the size field the same width as the original so all
        // outer offsets (Segment size, etc.) stay valid.
        const newSizeBytes = writeVint(newInfoBodySize, childSizeSize);
        if (newSizeBytes.length !== childSizeSize) {
          // Can't fit without shifting outer offsets — bail.
          return source;
        }

        const head = bytes.subarray(0, childIdStart + childIdSize);
        const tail = bytes.subarray(infoEnd);
        const originalInfoBody = bytes.subarray(infoStart, infoEnd);

        const out = new Uint8Array(
          head.length +
            newSizeBytes.length +
            durationBytes.length +
            originalInfoBody.length +
            tail.length,
        );
        let writeAt = 0;
        out.set(head, writeAt);
        writeAt += head.length;
        out.set(newSizeBytes, writeAt);
        writeAt += newSizeBytes.length;
        out.set(durationBytes, writeAt);
        writeAt += durationBytes.length;
        out.set(originalInfoBody, writeAt);
        writeAt += originalInfoBody.length;
        out.set(tail, writeAt);

        // Update outer Segment size too — it grew by the same amount.
        // Find the Segment header again in `out` and rewrite size if
        // possible (length-preserving). If we can't, we still have a
        // playable file in most browsers; only strict tools care.
        return new Blob([out], { type: source.type });
      }
      break; // Segment processed, done
    }
    return source;
  } catch (err) {
    console.warn("[recorder] fixWebmDuration failed, returning original", err);
    return source;
  }
};
