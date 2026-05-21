# Fake live-transcript injector

> Thay vì dùng Deepgram STT thật (lag + miss câu cho demo), inject pre-scripted segments qua `collabAPI.publishSTTSegment()`. Đi đúng pipeline `/translate-batch` nên translation vẫn live + thật.

## Cách dùng

1. Mở DevTools (F12) trên **CẢ 3 TAB** — Luân / Dojin / Elon
2. Mở Console tab
3. Paste đúng snippet của tab đó (mục dưới)
4. **Đếm ngược 3-2-1**, anh nhấn `Enter` chạy snippet TRÊN CẢ 3 TAB gần cùng lúc (sai số 1-2s không sao)
5. **Anh có 6 GIÂY** để: tắt F12 trên cả 3 tab → start recording → setup khung hình
6. Sau 6s, segment đầu tiên hiện. Timeline tổng từ lúc segment đầu = ~38s, có 6 segments.

> **Nếu 6s không đủ**: edit `STARTUP_DELAY = 6000` thành `10000` (hoặc bao nhiêu cũng được). Cùng giá trị trên cả 3 snippet để timing đồng bộ.

> **Lưu ý:** snippet sẽ tự **dispatch translate-batch** cho mỗi segment, nên dù peer xem ở ngôn ngữ khác cũng thấy translation hiện ngay.

---

## Snippet — Tab Luân (Việt)

```js
(async () => {
  // === SETTINGS ===
  // STARTUP_DELAY: thời gian (ms) từ lúc Enter đến segment đầu tiên.
  // Đủ để anh tắt F12 + start recording. Tăng nếu cần thêm thời gian.
  const STARTUP_DELAY = 6000;

  // BFS toàn fiber tree tìm stateNode có publishSTTSegment.
  // Collab là class component → instance ở stateNode, không pass qua
  // props nên không tìm thấy bằng walk-up-the-chain.
  const findCollabAPI = () => {
    const root =
      document.querySelector('.excalidraw-container') || document.body;
    if (!root) return null;
    const fk = Object.keys(root).find((k) => k.startsWith('__reactFiber'));
    if (!fk) return null;
    let top = root[fk];
    while (top.return) top = top.return;
    const queue = [top];
    while (queue.length) {
      const f = queue.shift();
      const sn = f && f.stateNode;
      if (
        sn &&
        typeof sn === 'object' &&
        typeof sn.publishSTTSegment === 'function'
      ) {
        return sn;
      }
      if (f && f.child) queue.push(f.child);
      if (f && f.sibling) queue.push(f.sibling);
    }
    return null;
  };
  const collab = findCollabAPI();
  if (!collab) { console.error('collabAPI not found'); return; }

  // Mimic real STT latency: 1-2s between "speaker finishes" and
  // "transcript appears". Scales with sentence length (Deepgram-ish).
  // 50ms per char, clamped 1000-2000ms. Same math on all 3 tabs so
  // turn-taking timing stays natural.
  const latency = (text) =>
    Math.min(2000, Math.max(1000, text.length * 50));
  const segments = [
    { delay:    0, text: 'Mình review suite phòng ngủ chính — bedroom, master bath, và walk-in closet ở giữa' },
    { delay: 15000, text: 'Cửa S.G.D 6068 ra ban công, hướng ra vườn sau — lấy sáng tốt' },
    { delay: 38000, text: 'OK mình mở rộng W.I.C thành 8x6, lấy từ hành lang' },
  ];
  console.log(`[LUÂN] queued ${segments.length} segments — first one in ${(STARTUP_DELAY+latency(segments[0].text))/1000}s. Tắt F12 + start recording NGAY.`);
  for (const s of segments) {
    setTimeout(() => {
      collab.publishSTTSegment({ text: s.text, lang: 'vi', ts: Date.now() });
      console.log('[LUÂN] →', s.text);
    }, STARTUP_DELAY + s.delay + latency(s.text));
  }
})();
```

## Snippet — Tab Dojin (Hàn)

```js
(async () => {
  const STARTUP_DELAY = 6000;
  // BFS toàn fiber tree tìm stateNode có publishSTTSegment (Collab
  // class instance). Walk-up-chain cũ không tìm thấy vì Collab không
  // pass qua props.
  const findCollabAPI = () => {
    const root =
      document.querySelector('.excalidraw-container') || document.body;
    if (!root) return null;
    const fk = Object.keys(root).find((k) => k.startsWith('__reactFiber'));
    if (!fk) return null;
    let top = root[fk];
    while (top.return) top = top.return;
    const queue = [top];
    while (queue.length) {
      const f = queue.shift();
      const sn = f && f.stateNode;
      if (
        sn &&
        typeof sn === 'object' &&
        typeof sn.publishSTTSegment === 'function'
      ) {
        return sn;
      }
      if (f && f.child) queue.push(f.child);
      if (f && f.sibling) queue.push(f.sibling);
    }
    return null;
  };
  const collab = findCollabAPI();
  if (!collab) { console.error('collabAPI not found'); return; }

  // Mimic real STT latency: 1-2s between "speaker finishes" and
  // "transcript appears". Scales with sentence length (Deepgram-ish).
  // 50ms per char, clamped 1000-2000ms. Same math on all 3 tabs so
  // turn-taking timing stays natural.
  const latency = (text) =>
    Math.min(2000, Math.max(1000, text.length * 50));
  const segments = [
    { delay: 23000, text: '마스터 욕실 더블 세면대 배관은 천장으로 올리는 게 좋겠습니다' },
  ];
  console.log(`[DOJIN] queued ${segments.length} segments — first one in ${(STARTUP_DELAY+segments[0].delay+latency(segments[0].text))/1000}s.`);
  for (const s of segments) {
    setTimeout(() => {
      collab.publishSTTSegment({ text: s.text, lang: 'ko', ts: Date.now() });
      console.log('[DOJIN] →', s.text);
    }, STARTUP_DELAY + s.delay + latency(s.text));
  }
})();
```

## Snippet — Tab Elon (Anh)

```js
(async () => {
  const STARTUP_DELAY = 6000;
  // BFS toàn fiber tree tìm stateNode có publishSTTSegment (Collab
  // class instance). Walk-up-chain cũ không tìm thấy vì Collab không
  // pass qua props.
  const findCollabAPI = () => {
    const root =
      document.querySelector('.excalidraw-container') || document.body;
    if (!root) return null;
    const fk = Object.keys(root).find((k) => k.startsWith('__reactFiber'));
    if (!fk) return null;
    let top = root[fk];
    while (top.return) top = top.return;
    const queue = [top];
    while (queue.length) {
      const f = queue.shift();
      const sn = f && f.stateNode;
      if (
        sn &&
        typeof sn === 'object' &&
        typeof sn.publishSTTSegment === 'function'
      ) {
        return sn;
      }
      if (f && f.child) queue.push(f.child);
      if (f && f.sibling) queue.push(f.sibling);
    }
    return null;
  };
  const collab = findCollabAPI();
  if (!collab) { console.error('collabAPI not found'); return; }

  // Mimic real STT latency: 1-2s between "speaker finishes" and
  // "transcript appears". Scales with sentence length (Deepgram-ish).
  // 50ms per char, clamped 1000-2000ms. Same math on all 3 tabs so
  // turn-taking timing stays natural.
  const latency = (text) =>
    Math.min(2000, Math.max(1000, text.length * 50));
  const segments = [
    { delay:  7000, text: 'The sliding door on the north — does it open onto something?' },
    { delay: 31000, text: "Walk-in closet at 7 by 5'11 feels tight. Can we push it out?" },
  ];
  console.log(`[ELON] queued ${segments.length} segments — first one in ${(STARTUP_DELAY+segments[0].delay+latency(segments[0].text))/1000}s.`);
  for (const s of segments) {
    setTimeout(() => {
      collab.publishSTTSegment({ text: s.text, lang: 'en', ts: Date.now() });
      console.log('[ELON] →', s.text);
    }, STARTUP_DELAY + s.delay + latency(s.text));
  }
})();
```

---

## Timeline tổng thể

`t = 0` là lúc anh nhấn Enter. Mỗi segment hiển thị tại `STARTUP_DELAY + delay + latency`. `latency` = `min(2000, max(1000, text.length × 50))ms`, mimic STT real.

| t (~s) | Speaker | Lang | Câu |
|---|---|---|---|
| 0 | — | — | Anh nhấn Enter cả 3 tab. **Tắt F12 + start recording NGAY** |
| ~8 | Luân | vi | `Mình review suite phòng ngủ chính — bedroom, master bath, và walk-in closet ở giữa` |
| ~14.5 | Elon | en | `The sliding door on the north — does it open onto something?` |
| ~23 | Luân | vi | `Cửa S.G.D 6068 ra ban công, hướng ra vườn sau — lấy sáng tốt` |
| ~31 | Dojin | ko | `마스터 욕실 더블 세면대 배관은 천장으로 올리는 게 좋겠습니다` |
| ~39 | Elon | en | `Walk-in closet at 7 by 5'11 feels tight. Can we push it out?` |
| ~46 | Luân | vi | `OK mình mở rộng W.I.C thành 8x6, lấy từ hành lang` |

Tổng thời lượng nội dung ~38s (từ segment đầu đến cuối) — đủ cho 1 phân đoạn V2b.

---

## Nếu muốn TÙY CHỈNH timing

Mỗi snippet có array `segments` với `delay` (ms). Anh có thể:

- **Chậm lại**: x1.5 mọi delay (delay × 1.5)
- **Nhanh hơn**: ÷ 1.5
- **Đổi nội dung**: edit `text:` field
- **Thêm câu**: thêm object `{ delay: N, text: '...' }` vào array — nhớ giữ thứ tự delay tăng dần

---

## Khắc phục nếu không hoạt động

- **"collabAPI not found"** trong console → tab chưa join room. Verify thanh participants có 3 avatar + host crown trên Luân.
- **Segment đã chạy nhưng transcript không hiện** → Live Transcript panel chưa mở. Click "Live transcript" pill ở bottom-left của canvas.
- **Translation không hiện** → Gemini API key chưa active, hoặc auto-translate đang OFF. Kiểm tra `room/.env` + chat header có icon "Auto-translate (on)".

---

## Recording flow

1. Setup: 3 tab vào room, transcript panel mở trên Tab Luân (tab này sẽ visible trên màn hình)
2. Paste 3 snippets vào DevTools console của 3 tab
3. Đếm `3-2-1` → nhấn Enter cả 3 tab gần như cùng lúc
4. Start screen recording
5. 6 segments chạy trong ~45s, có translation theo ngôn ngữ user
6. Stop recording sau ~50s

Tổng thời lượng nội dung dùng được cho clip: ~40-45s, đủ cho 1 vignette V2b.
