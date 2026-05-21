# TTS prep — voice cho hội thoại V2b

> Chỉ cần voice cho **6 transcript segments** (bản gốc, theo ngôn ngữ của từng speaker). Phần translation hiện text-only — không cần voice.

---

## Voice mapping

| Character | Language | Trait | ElevenLabs voice | Azure voice | Google voice |
|---|---|---|---|---|---|
| **Luân** | Vietnamese | nam, ~30s, confident architect | `Hồng Vũ` hoặc clone | `vi-VN-NamMinhNeural` | `vi-VN-Neural2-D` |
| **Dojin** | Korean | nam, ~35s, calm engineer (deeper pitch) | `Min-jun` | `ko-KR-InJoonNeural` | `ko-KR-Neural2-C` |
| **Elon** | English | nam, ~40s, US accent, casual client | `Adam` / `Charlie` | `en-US-GuyNeural` | `en-US-Neural2-D` |

> Em recommend **Azure** vì `vi-VN-NamMinh` + `ko-KR-InJoon` đều rất tự nhiên trên giọng nam và free tier 500k char/mo đủ thừa.

---

## 6 file audio cần tạo

### 🎤 Luân (VN) × 3

**File: `luan_01.mp3`**
```
Mình review suite phòng ngủ chính — bedroom, master bath, và walk-in closet ở giữa
```

**File: `luan_02.mp3`**
```
Cửa sliding door sáu không sáu tám ra ban công, hướng ra vườn sau — lấy sáng tốt
```

**File: `luan_03.mp3`**
```
OK mình mở rộng walk-in closet thành tám nhân sáu, lấy từ hành lang
```

### 🎤 Dojin (KR) × 1

**File: `dojin_01.mp3`**
```
마스터 욕실 더블 세면대 배관은 천장으로 올리는 게 좋겠습니다
```

### 🎤 Elon (EN) × 2

**File: `elon_01.mp3`**
```
The sliding door on the north — does it open onto something?
```

**File: `elon_02.mp3`**
```
Walk-in closet at 7 by 5 foot 11 feels tight. Can we push it out?
```

---

## Sync timing trong video editor

Mỗi voice file đặt ở mốc tương ứng trong timeline (tính từ lúc bắt đầu phân đoạn V2b):

| Mốc | Voice | Khoảng nói (giây) |
|---|---|---|
| 0:08 | `luan_01.mp3` | ~5s |
| 0:14 | `elon_01.mp3` | ~4s |
| 0:23 | `luan_02.mp3` | ~5s |
| 0:31 | `dojin_01.mp3` | ~4s |
| 0:39 | `elon_02.mp3` | ~4s |
| 0:46 | `luan_03.mp3` | ~5s |

Tổng: ~27s nói + pause giữa, đẹp với segment hiện text mỗi 6-8s.

---

## Tips

- **Speed**: TTS mặc định hơi nhanh — slow xuống 0.9x cho cảm giác họp tự nhiên
- **Số đếm trong câu Luân**: em đã phiên âm "sáu không sáu tám", "tám nhân sáu" để TTS đọc tự nhiên — đừng dán literal `6068` hay `8x6` (TTS sẽ đọc kỳ)
- **Mixed terms** trong câu VN ("sliding door", "walk-in closet", "master bath"): TTS hiện đại đa số xử lý OK, đọc nhanh theo English. Nếu giọng lai khó nghe, anh dùng `walk-in clô-zét` / `slai-ding đo` phiên âm
- **Pause**: thêm `—` (em-dash) hoặc `,` để TTS có nhịp nghỉ tự nhiên
- **Background ambient** optional: thêm office room tone -30dB phía sau voice cho realistic
