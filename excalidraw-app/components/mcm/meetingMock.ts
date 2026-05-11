// Hardcoded demo data so the UI shell can be evaluated without the
// real STT / video / AI integrations wired up yet.

export type MockParticipant = {
  id: string;
  name: string;
  country: string;
  /** css gradient for the avatar fallback (no real photos yet) */
  avatar: string;
  micOn: boolean;
  speaking: boolean;
  isMe?: boolean;
};

export const MOCK_PARTICIPANTS: MockParticipant[] = [
  {
    id: "me",
    name: "You (Minh)",
    country: "VN",
    avatar: "linear-gradient(135deg,#34d399,#0ea5e9)",
    micOn: true,
    speaking: true,
    isMe: true,
  },
  {
    id: "emma",
    name: "Emma",
    country: "UK",
    avatar: "linear-gradient(135deg,#f472b6,#ef4444)",
    micOn: false,
    speaking: false,
  },
  {
    id: "james",
    name: "James",
    country: "US",
    avatar: "linear-gradient(135deg,#fbbf24,#f97316)",
    micOn: false,
    speaking: false,
  },
  {
    id: "huy",
    name: "Huy",
    country: "VN",
    avatar: "linear-gradient(135deg,#60a5fa,#6366f1)",
    micOn: true,
    speaking: false,
  },
  {
    id: "mai",
    name: "Mai",
    country: "VN",
    avatar: "linear-gradient(135deg,#a78bfa,#ec4899)",
    micOn: false,
    speaking: false,
  },
  {
    id: "khoa",
    name: "Khoa",
    country: "VN",
    avatar: "linear-gradient(135deg,#22d3ee,#3b82f6)",
    micOn: false,
    speaking: false,
  },
  {
    id: "sophia",
    name: "Sophia",
    country: "DE",
    avatar: "linear-gradient(135deg,#fb7185,#f59e0b)",
    micOn: false,
    speaking: false,
  },
  {
    id: "antonio",
    name: "Antonio",
    country: "IT",
    avatar: "linear-gradient(135deg,#84cc16,#10b981)",
    micOn: false,
    speaking: false,
  },
];

export type MockTranscriptLine = {
  at: string;
  speaker: string;
  country: string;
  original: string;
  translated: string;
};

export const MOCK_TRANSCRIPT: MockTranscriptLine[] = [
  {
    at: "00:15",
    speaker: "Emma",
    country: "UK",
    original:
      "I think we should widen the opening between living room and terrace.",
    translated:
      "Tôi nghĩ chúng ta nên mở rộng khoảng mở giữa phòng khách và sân thượng.",
  },
  {
    at: "00:22",
    speaker: "James",
    country: "US",
    original: "Agree. It will improve the natural light and the flow.",
    translated: "Đồng ý. Nó sẽ cải thiện ánh sáng tự nhiên và sự lưu thông.",
  },
  {
    at: "00:30",
    speaker: "Minh",
    country: "VN",
    original: "Let's also consider the sun direction in the afternoon.",
    translated: "Chúng ta cũng nên xem xét hướng nắng vào buổi chiều.",
  },
  {
    at: "00:37",
    speaker: "Huy",
    country: "VN",
    original: "Maybe move the laundry nearer to the bedrooms?",
    translated: "Có thể di chuyển khu giặt là gần phòng ngủ hơn không?",
  },
  {
    at: "00:45",
    speaker: "Sophia",
    country: "DE",
    original: "Nice! Also consider adding more greenery along the boundary.",
    translated: "Tuyệt! Cũng nên thêm nhiều cây xanh dọc theo ranh giới.",
  },
];

export const MOCK_MEETING_TITLE = "Villa Riverside – Design Review";
export const MOCK_MEETING_DURATION_S = 42 * 60 + 18; // 00:42:18
