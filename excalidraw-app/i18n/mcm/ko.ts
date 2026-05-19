// Korean locale — mirrors vi.ts structure.
//
// Style notes for Korean translation:
//   • Verbal endings use the polite informal "-요" form across the
//     board (consistent with how the chat translator system prompt
//     handles Korean: see room/src/index.ts TRANSLATOR_SYSTEM_PROMPT).
//   • Honorifics: button labels stay direct (no "-십시오"); status
//     messages addressed to the user use "-요".
//   • Architecture / construction terms (BIM, RC, MEP, IFC) are
//     preserved verbatim — they're cross-language jargon.

import type { Widened } from "./index";
import type { vi } from "./vi";

export const ko: Widened<typeof vi> = {
  header: {
    invite: "초대",
    leave: "나가기",
    share: "공유",
    transcript: "회의록",
    meetingMenu: "회의 메뉴",
    participantCount: "{count}명",
    participantSingular: "{count}명",
    participantsInCall: "방에 {count}명",
    participantsInCallWith: "방에 {count}명 · {inCall}명 통화 중",
    previewNotInRoom: "방 입장 전 — 미리보기",
    layout: "레이아웃",
    present: "발표",
    settings: "설정",
    more: "더보기",
  },

  participants: {
    label: "참여자",
    countInRoom: "방에 {count}명",
    countInCall: "통화 중 {count}명",
    previewBadge: "미리보기",
    raiseHandAria: "손 들기",
    micOffAria: "음소거됨",
    you: "나",
    guest: "손님",
  },

  callControls: {
    joinCall: "마이크 켜고 통화 참여",
    leaveCall: "통화 나가기",
    mute: "음소거",
    unmute: "음소거 해제",
    listenOnly: "듣기 전용",
    listenOnlyTitle: "이 기기에는 마이크가 없습니다 — 듣기 전용",
    requestingMic: "마이크 권한을 요청 중…",
    micDenied:
      "마이크가 차단됨 — 브라우저 설정에서 권한을 켜고 다시 시도하세요.",
    micBusy:
      "다른 앱(Teams/Zoom)에서 마이크 사용 중. 해당 앱을 종료하고 다시 시도하세요.",
    cannotStartMic: "마이크를 시작할 수 없습니다",
    retry: "다시 시도",
    raiseHand: "손 들기",
    lowerHand: "손 내리기",
    reactions: "리액션",
    pickEmoji: "이모지 선택",
    sendReaction: "{emoji} 보내기",
    callingNoPeers: "통화 중…",
  },

  chat: {
    title: "대화",
    sendLabel: "전송",
    composePlaceholder: "메시지 입력…",
    translating: "번역 중…",
    translateToggleOn: "자동 번역 (켜짐)",
    translateToggleOff: "자동 번역 (꺼짐)",
    emoji: "이모지",
    mention: "파일 / 봇 멘션",
    attach: "이미지 첨부",
    attachFileAria: "채팅에 이미지 첨부",
    mentionTitle: "클릭하면 캔버스의 파일로 이동",
    mentionPickerLabel: "멘션할 파일 또는 봇 선택",
    mentionBotName: "MCM 봇",
    mentionBotDesc: "디자인 / 프로젝트에 대해 AI에게 질문",
    mentionNoFile: "이 방의 라이브러리에 파일이 없습니다.",
    mentionNoMatch: '"{query}"와 일치하는 파일 없음',
    replyTitle: "이 메시지에 답장",
    replyAriaLabel: "답장",
    replyCancelAria: "답장 취소",
    replyJumpTitle: "원본 메시지로 이동",
    reactPickerLabel: "리액션 선택",
    addReactionTitle: "리액션 추가",
    reactionTooltip: "{count}명",
    botErrorReply: "지금은 답변할 수 없습니다 (연결 또는 API 문제).",
    botFallbackReply:
      "죄송합니다, 답변하지 못했습니다. 잠시 후 다시 시도하세요.",
    fileTypeWarning: "이미지만 지원됩니다. 건너뜀: {name}",
    fileNotOnCanvas:
      "이 파일은 아직 캔버스에 없습니다. 라이브러리를 열어 클릭해 먼저 배치하세요.",
    you: "나",
    empty: {
      noMessagesTitle: "메시지 없음",
      noMessagesSubtitle: "@로 파일 멘션, @bot으로 AI에게 질문",
      notInRoomTitle: "Live Collaboration을 시작하세요",
      notInRoomSubtitle: "메시지는 방 키로 종단간 암호화됩니다.",
    },
  },

  stt: {
    title: "실시간 회의록",
    showButton: "실시간 회의록",
    sttOn: "STT: 켜짐",
    sttOff: "STT: 꺼짐",
    sttToggleOnTitle: "음성 인식 끄기",
    sttToggleOffTitle: "음성 인식 켜기",
    translateOn: "번역: 켜짐",
    translateOff: "번역: 꺼짐",
    translateToggleOnTitle: "회의록 번역 끄기",
    translateToggleOffTitle: "회의록을 선호 언어로 번역",
    testFile: "파일 테스트",
    testRunning: "테스트 중…",
    testFileTitle:
      "오디오 파일을 STT 파이프라인으로 재생해 테스트 (스피커 출력 포함)",
    pickAudioFileAria: "STT 테스트용 오디오 파일 선택",
    hideAria: "닫기",
    hideTitle: "숨기기 (백그라운드 로깅 유지)",
    speakingNow: "말하는 중…",
    waiting: "누군가 말하기를 기다리는 중…",
    paused: "STT를 켜서 음성 인식을 시작하세요.",
    statusLive: "라이브",
    statusTest: "테스트",
    statusPaused: "일시정지",
    statusError: "오류",
    translating: "번역 중…",
    micErrorNoStream:
      "로컬 마이크 스트림 없음 — 이 기기는 듣기 전용 모드입니다.",
    testFailed: "테스트 실패",
    workletLoadFailed: "STT worklet 로드 실패: {message}",
    wsError: "STT WebSocket 오류",
    sttGenericError: "STT 오류",
  },

  log: {
    title: "회의록",
    titleWithId: "회의 {id}",
    metaSegments: "{count}개",
    metaSegmentsPlural: "{count}개",
    tabTranscript: "회의록",
    tabSummary: "요약",
    closeAria: "닫기",
    emptyTranscript:
      "아직 회의록이 없습니다. 통화 참여 + STT를 켜서 기록을 시작하세요.",
    emptySummary:
      '아직 요약이 없습니다. 아래 "요약 생성"을 클릭하세요 — Gemini가 전체 회의록을 읽고 개요, 결정 사항, 액션 아이템을 생성합니다.',
    summaryLoading: "요약 생성 중… (긴 회의는 ~5-15초 소요)",
    sectionOverview: "개요",
    sectionParticipants: "참여자",
    sectionKeyTopics: "주요 주제",
    sectionDecisions: "결정 사항",
    sectionActionItems: "액션 아이템",
    deadlineLabel: "마감일",
    buttonClear: "기록 삭제",
    buttonGenerateSummary: "요약 생성",
    buttonRegenerateSummary: "요약 재생성",
    buttonDownload: ".md 다운로드",
    summaryGeneratedAt: "{when} 생성됨",
    confirmClear:
      "{roomId} 방의 회의록 + 요약을 삭제하시겠습니까?\n되돌릴 수 없습니다.",
    summaryFailedPrefix: "요약 실패",
    summaryError: "요약 실패",
    mdTitleSummary: "{title} — 요약",
    mdNoTranscript: "(회의록 없음)",
  },

  pin: {
    pinTitle: "클릭하여 이 이미지에 핀 꽂기",
    unpinTitle: "클릭하여 이 이미지의 핀을 제거",
    permissionDenied:
      "{locker}(핀을 꽂은 사람) 또는 {author}(업로더)만 핀을 제거할 수 있습니다.",
  },
};
