# Demo — text + chat content (copy/paste source)

> Mọi đoạn dưới đây đã được làm "demo-friendly" — ngắn, đúng accent Vietnamese / Korean / English, có dấu rõ ràng để render font Caveat / Noto Sans KR đúng.
>
> **Quy ước:** mỗi block có `[Tab]` đầu để biết ai gõ, ngôn ngữ trong dấu ngoặc `(VN/KR/EN)`. Anh chỉ copy phần ở trong `code block`.

---

## VIGNETTE 1 — Cùng làm việc trên cùng một bản vẽ

### Beat 1b — 3 notes trên 3 zoom regions

#### Note #1 — Luân, VN, copy DXF zoom vào **phòng ngủ chính**
```
Phòng ngủ cần thêm cửa sổ
```

#### Note #2 — Dojin, KR, copy DXF zoom vào **phòng tắm**
```
화장실 출입구 위치 변경
```

#### Note #3 — Elon, EN, copy DXF zoom vào **bếp**
```
Add a kitchen island here?
```

### Beat 1c — note trên PDF (page 2)

#### Note PDF — Dojin, KR, gần khu vực tower diagram
```
타워 높이 18m 맞나요?
```

> Sau khi gõ xong, Elon select note này → click **🌐 Dịch** → translate widget tự sinh dòng tiếng Anh phía dưới. Nội dung Anh predict: *"Is the tower height correct at 18m?"* (Gemini generated, không cần copy).

---

## VIGNETTE 2 — Communication không rào cản

### Beat 2a — Chat 3 chiều (auto-translate)

> Chat tự auto-translate sang ngôn ngữ của người đọc. Anh gõ ở tab nào thì người tab kia sẽ thấy bản dịch. Auto-translate đã bật mặc định ở MeetingShell.
>
> **Context:** anh + đội đang review suite phòng ngủ chính của Villa Riverside — master bedroom 13'8 × 14, master bath với double vanity, W.I.C. 7 × 5'11, sliding glass door 6068 ra phía bắc. Mọi message ở dưới tied vào layout này.

#### Msg #1 — Luân (VN) gõ
```
Master bedroom 13'8 x 14 — đề xuất nới W.I.C thêm 1 foot mỗi chiều, lấy bớt từ hành lang
```

#### Msg #2 — Dojin (KR) reply
```
좋습니다. 그런데 마스터 욕실 더블 세면대 배관은 천장 위로 올리는 게 안전합니다
```

#### Msg #3 — Elon (EN) reply
```
Sounds good. Could the S.G.D open onto a small balcony? It'd be perfect for morning coffee.
```

#### Msg #4 — Luân (VN) close
```
Chốt — mở rộng W.I.C 8x6, thêm balcony qua S.G.D 6068. Em gửi update tuần sau
```

### Beat 2b — Live transcript (pre-seeded segments)

> Mình không gõ những đoạn này — em sẽ inject thẳng vào transcript log qua collabAPI để xuất hiện như đã được STT. Đối thoại tied vào master suite layout — bedroom 13'8 × 14, master bath với double vanity, W.I.C., S.G.D 6068.

| t | Speaker | Lang | Text |
|---|---|---|---|
| ~8 | Luân | VN | `Mình review suite phòng ngủ chính — bedroom, master bath, và walk-in closet ở giữa` |
| ~14.5 | Elon | EN | `The sliding door on the north — does it open onto something?` |
| ~23 | Luân | VN | `Cửa S.G.D 6068 ra ban công, hướng ra vườn sau — lấy sáng tốt` |
| ~31 | Dojin | KR | `마스터 욕실 더블 세면대 배관은 천장으로 올리는 게 좋겠습니다` |
| ~39 | Elon | EN | `Walk-in closet at 7 by 5'11 feels tight. Can we push it out?` |
| ~46 | Luân | VN | `OK mình mở rộng W.I.C thành 8x6, lấy từ hành lang` |

> Em sẽ programmatically inject 6 segments này (gõ thẳng vào transcriptionLogAtom hoặc gọi publishSTTSegment) trước khi quay Beat 2b để transcript đã có content.

---

## VIGNETTE 3 — AI Summary

> Không cần copy text. AI summary tự generate từ:
> - chatLogAtom (4 messages từ Vignette 2a)
> - transcriptionLogAtom (6 segments từ Vignette 2b)
>
> Anh chỉ click "Biên bản" → modal mở → "Tạo tóm tắt" (regenerate summary) → đợi ~3-5s → Gemini xuất bản summary.
>
> Predict summary content (Gemini sẽ generate, không hard-code):
> - **Quyết định:** mở rộng master bedroom 1.5m về phía vườn; di dời cửa phòng tắm sang bắc; giữ bếp open-plan.
> - **Việc cần làm:** Luân gửi bản update tuần sau.
> - **Ngôn ngữ summary:** theo `preferredLanguageAtom` của người mở modal — Luân thấy tiếng Việt, Dojin Hàn, Elon Anh.

---

## Phụ lục — strings ngắn tiện copy

| | VN | KR | EN |
|---|---|---|---|
| Vietnamese sample (phòng ngủ) | `Phòng ngủ cần thêm cửa sổ` | | |
| Korean sample (toilet door) | | `화장실 출입구 위치 변경` | |
| English sample (kitchen) | | | `Add a kitchen island here?` |
| Vietnamese sample (translate test) | `Tôi nghĩ phòng khách hơi nhỏ` | | |
| Korean sample (translate test) | | `천장 높이가 충분합니까` | |
| English sample (translate test) | | | `The natural lighting looks great` |

---

## Tips khi quay

- Mỗi note canvas: chọn **Text tool (T)** → click vào canvas → gõ → click ra ngoài. Font mặc định Caveat phủ Vietnamese; KR sẽ tự fallback Noto Sans KR.
- Revision cloud: vẽ rectangle bao quanh → right-click → "Convert to revision cloud" (hoặc dùng tool Revision Cloud `Q`).
- Drag DXF/PDF/IMG từ library: kéo từ tile bên library sidebar → thả vào canvas.
- Copy DXF anchor: select → Ctrl+D → drag ra vị trí mới. Anh có thể đặt 3 copies side-by-side.
- Per-anchor zoom (mỗi DXF copy zoom vào 1 region khác nhau): click vào DXF anchor → dùng wheel scroll để zoom + drag để pan. View tự persist vào `customData.dxfView`, peers nhìn thấy đúng view của anh.
- Stamp adhesion: chọn stamp picker → pick 1 trong 12 chibi stamps → click TRÊN image kéo từ library → stamp tự group với image. Sau đó drag image → stamp đi theo.
