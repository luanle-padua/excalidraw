// Vietnamese — source-of-truth dictionary for MCM strings.
//
// Conventions:
//   • Group keys by feature (header, chat, stt, log, callControls, …).
//   • Use lowercase, dot-separated paths in code: `t("chat.empty.title")`.
//   • Placeholders use `{name}` (curly braces) and are substituted by
//     the i18n runtime — never concatenate Vietnamese strings by hand.
//   • If a string varies by count, expose both singular/plural keys
//     (no Intl.PluralRules — Korean/Vietnamese have simple rules).
//   • Adding a key here surfaces a TS error in en.ts and ko.ts until
//     translated, so nothing silently drifts.

export const vi = {
  // ---------------- Header -----------------------------------------
  header: {
    invite: "Mời",
    leave: "Rời",
    share: "Chia sẻ",
    transcript: "Biên bản",
    meetingMenu: "Menu cuộc họp",
    participantCount: "{count} người",
    participantSingular: "{count} người",
    participantsInCall: "{count} người trong phòng",
    participantsInCallWith: "{count} người trong phòng · {inCall} đang call",
    previewNotInRoom: "Chưa vào phòng — preview",
    layout: "Bố cục",
    present: "Trình bày",
    settings: "Cài đặt",
    more: "Thêm",
  },

  // ---------------- Participants bar -------------------------------
  participants: {
    label: "Người tham dự",
    countInRoom: "{count} trong phòng",
    countInCall: "{count} đang call",
    previewBadge: "Preview",
    raiseHandAria: "Đang giơ tay",
    micOffAria: "Đã tắt mic",
    you: "Bạn",
    guest: "Khách",
  },

  // ---------------- Audio call controls ----------------------------
  callControls: {
    joinCall: "Bật mic & vào call",
    leaveCall: "Rời call",
    mute: "Tắt mic",
    unmute: "Bật mic",
    listenOnly: "Chỉ nghe",
    listenOnlyTitle: "Máy này không có mic — chỉ nghe được",
    requestingMic: "Đang xin quyền mic…",
    micDenied:
      "Mic bị từ chối — bật quyền microphone trong trình duyệt rồi thử lại.",
    micBusy:
      "Mic đang bị app khác chiếm (Teams/Zoom...). Thoát app đó rồi thử lại.",
    cannotStartMic: "Không thể bật microphone",
    retry: "Thử lại",
    raiseHand: "Giơ tay",
    lowerHand: "Hạ tay",
    reactions: "Reactions",
    pickEmoji: "Chọn emoji",
    sendReaction: "Gửi {emoji}",
    callingNoPeers: "Đang gọi…",
  },

  // ---------------- Chat panel -------------------------------------
  chat: {
    title: "Hội thoại",
    sendLabel: "Gửi",
    composePlaceholder: "Nhập tin nhắn…",
    translating: "Đang dịch…",
    translateToggleOn: "Tự động dịch (đang bật)",
    translateToggleOff: "Tự động dịch (đang tắt)",
    emoji: "Emoji",
    mention: "Mention file / bot",
    attach: "Đính kèm ảnh",
    attachFileAria: "Đính kèm ảnh vào chat",
    mentionTitle: "Bấm để cuộn tới file trên canvas",
    mentionPickerLabel: "Chọn file hoặc bot để mention",
    mentionBotName: "MCM Bot",
    mentionBotDesc: "Hỏi AI về thiết kế / dự án",
    mentionNoFile: "Chưa có file nào trong thư viện phòng.",
    mentionNoMatch: 'Không có file nào khớp "{query}"',
    replyTitle: "Trả lời tin nhắn này",
    replyAriaLabel: "Trả lời",
    replyCancelAria: "Huỷ trả lời",
    replyJumpTitle: "Cuộn đến tin nhắn gốc",
    reactPickerLabel: "Chọn cảm xúc",
    addReactionTitle: "Thêm cảm xúc",
    reactionTooltip: "{count} người",
    botErrorReply:
      "Mình không thể trả lời lúc này (kết nối hoặc API có vấn đề).",
    botFallbackReply: "Xin lỗi, mình chưa trả lời được. Thử lại sau nhé.",
    fileTypeWarning: "Tạm thời chỉ hỗ trợ ảnh. Bỏ qua: {name}",
    fileNotOnCanvas:
      "File này chưa nằm trên canvas. Mở thư viện và bấm vào file đó để chèn lên trước.",
    you: "Bạn",
    empty: {
      noMessagesTitle: "Chưa có tin nhắn",
      noMessagesSubtitle: "Gõ @ để mention file, @bot để hỏi AI",
      notInRoomTitle: "Bật Live Collaboration để bắt đầu",
      notInRoomSubtitle: "Tin nhắn được mã hoá đầu cuối bằng key của phòng.",
    },
  },

  // ---------------- Speech-to-text panel ---------------------------
  stt: {
    title: "Biên bản trực tiếp",
    showButton: "Live transcript",
    sttOn: "STT: bật",
    sttOff: "STT: tắt",
    sttToggleOnTitle: "Tắt nhận dạng giọng nói",
    sttToggleOffTitle: "Bật nhận dạng giọng nói",
    translateOn: "Dịch: bật",
    translateOff: "Dịch: tắt",
    translateToggleOnTitle: "Tắt dịch transcript",
    translateToggleOffTitle: "Bật dịch transcript sang ngôn ngữ ưu tiên",
    testFile: "Test file",
    testRunning: "Đang test…",
    testFileTitle:
      "Phát 1 file audio vào pipeline STT để test (có cả speaker output)",
    pickAudioFileAria: "Chọn file audio để test STT",
    hideAria: "Đóng",
    hideTitle: "Ẩn (vẫn ghi log nền)",
    speakingNow: "đang nói…",
    waiting: "Đang chờ ai đó nói…",
    paused: "Bật STT để bắt đầu nhận dạng giọng nói.",
    statusLive: "LIVE",
    statusTest: "TEST",
    statusPaused: "PAUSED",
    statusError: "ERROR",
    translating: "Đang dịch…",
    micErrorNoStream:
      "Không có local mic stream — máy này đang ở chế độ chỉ-nghe.",
    testFailed: "Test thất bại",
    workletLoadFailed: "Không tải được STT worklet: {message}",
    wsError: "STT WebSocket lỗi",
    sttGenericError: "Lỗi STT",
  },

  // ---------------- Meeting log + summary modal --------------------
  log: {
    title: "Biên bản cuộc họp",
    titleWithId: "Meeting {id}",
    metaSegments: "{count} segment",
    metaSegmentsPlural: "{count} segments",
    tabTranscript: "Biên bản",
    tabSummary: "Tóm tắt",
    closeAria: "Đóng",
    emptyTranscript: "Chưa có biên bản nào. Vào call + bật STT để bắt đầu ghi.",
    emptySummary:
      'Chưa có tóm tắt. Bấm "Tạo tóm tắt" ở dưới — Gemini sẽ đọc toàn bộ biên bản và sinh ra tổng quan, quyết định, action items.',
    summaryLoading: "Đang tạo tóm tắt… (~5-15s với meeting dài)",
    sectionOverview: "Tổng quan",
    sectionParticipants: "Người tham dự",
    sectionKeyTopics: "Chủ đề chính",
    sectionDecisions: "Quyết định",
    sectionActionItems: "Action items",
    deadlineLabel: "deadline",
    buttonClear: "Xoá log",
    buttonGenerateSummary: "Tạo tóm tắt",
    buttonRegenerateSummary: "Tạo lại tóm tắt",
    buttonDownload: "Tải về .md",
    summaryGeneratedAt: "Tạo lúc {when}",
    confirmClear:
      "Xoá biên bản + tóm tắt của room {roomId}?\nKhông thể hoàn tác.",
    summaryFailedPrefix: "Summary failed",
    summaryError: "Summary failed",
    mdTitleSummary: "{title} — Tóm tắt",
    mdNoTranscript: "(no transcript)",
  },

  // ---------------- Pin / lock affordance --------------------------
  pin: {
    pinTitle: "Bấm để ghim ảnh này",
    unpinTitle: "Bấm để bỏ ghim ảnh này",
    permissionDenied:
      "Chỉ {locker} (người ghim) hoặc {author} (người tải lên) có thể bỏ ghim.",
  },
} as const;
