import {
  buildRoomUrl,
  createRoom,
  leaveRoom,
  sendRoomMessage,
  subscribeToRoom,
  upsertParticipant,
  writeSharedGameState,
} from "./firebase-service.js";

const STORAGE_KEY = "arena-quiz-state-v2";
const SHUFFLE_MEMORY_KEY = "arena-quiz-shuffle-memory-v1";
const CLIENT_ID_KEY = "arena-quiz-client-id-v1";
const ROOM_RULES_TEXT =
  "قوانين اللعبة: كل واحد له دور يختار سؤال، لكن الإجابة تتحدد لأسرع واحد جاوب فيكم.";
const POINT_VALUES = [200, 400, 600];
const OPTION_KEYS = ["A", "B", "C", "D"];
const DESKTOP_SHARE_WIDTH = 1320;
const ABILITY_META = {
  double: {
    icon: "2×",
    label: "دبل النقاط",
  },
  removeTwo: {
    icon: "✂️",
    label: "حذف إجابتين",
  },
  block: {
    icon: "⛔",
    label: "بلوك",
  },
};
const TEAM_COLORS = [
  "#ff6b6b",
  "#4cc9f0",
  "#ffd166",
  "#22c55e",
  "#a855f7",
  "#fb7185",
  "#f97316",
  "#2dd4bf",
  "#60a5fa",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#84cc16",
];

const appElement = document.querySelector("#app");
const toastElement = document.querySelector("#toast");

let toastTimer = null;
let shuffleMemory = loadShuffleMemory();
let state = loadState() || createInitialState();
let roomContext = createRoomContext();

initializeRoomMode();

render();

appElement.addEventListener("click", onAppClick);
appElement.addEventListener("change", onAppChange);
appElement.addEventListener("input", onAppInput);
appElement.addEventListener("submit", onAppSubmit);

function createRoomContext() {
  return {
    clientId: getOrCreateClientId(),
    roomCode: "",
    roomUrl: "",
    hostClientId: "",
    isHost: false,
    roomExists: false,
    joinedParticipant: null,
    participants: [],
    chatMessages: [],
    unsubscribeRoom: null,
    lastSyncedRevision: 0,
    pendingName: "",
    pendingColor: TEAM_COLORS[0],
    pendingRole: "player",
  };
}

function initializeRoomMode() {
  const roomCode = getRoomCodeFromUrl();
  if (!roomCode) {
    return;
  }

  roomContext.roomCode = roomCode;
  roomContext.roomUrl = buildRoomUrl(roomCode);
  state = {
    ...createInitialState(),
    phase: "room-join",
  };
  subscribeCurrentRoom();
}

function createInitialUploadState() {
  return {
    loading: false,
    progress: 0,
    status: "بانتظار ملف الأسئلة",
    categoryCount: 0,
    questionCount: 0,
    completed: false,
    error: "",
  };
}

function createInitialTeamDraft() {
  return [
    { name: "لاعب 1", color: TEAM_COLORS[0] },
    { name: "لاعب 2", color: TEAM_COLORS[1] },
  ];
}

function createAbilityState() {
  return {
    double: {
      used: false,
      pending: false,
    },
    removeTwo: {
      used: false,
    },
    block: {
      used: false,
    },
  };
}

function mergeAbilityState(abilities = {}) {
  const fallback = createAbilityState();
  return {
    double: {
      ...fallback.double,
      ...(abilities.double || {}),
    },
    removeTwo: {
      ...fallback.removeTwo,
      ...(abilities.removeTwo || {}),
    },
    block: {
      ...fallback.block,
      ...(abilities.block || {}),
    },
  };
}

function createPlayerState({
  id,
  name,
  color,
  points = 0,
  abilities,
  blockedByPlayerId = null,
}) {
  return {
    id,
    name,
    color,
    points,
    abilities: mergeAbilityState(abilities),
    blockedByPlayerId,
  };
}

function createDraftPlayer(team, index) {
  return createPlayerState({
    id: `player-${index + 1}`,
    name: team.name,
    color: team.color,
  });
}

function normalizeStoredTeams(teams, teamDraft) {
  const fallbackPlayers = teamDraft.map((team, index) => createDraftPlayer(team, index));
  const sourcePlayers =
    Array.isArray(teams) && teams.length ? teams : fallbackPlayers;

  return sourcePlayers.map((storedPlayer, index) => {
    const fallbackPlayer =
      fallbackPlayers[index] ||
      createDraftPlayer(
        {
          name: storedPlayer.name || `لاعب ${index + 1}`,
          color: storedPlayer.color || TEAM_COLORS[index % TEAM_COLORS.length],
        },
        index
      );

    return createPlayerState({
      id: storedPlayer.id || fallbackPlayer.id,
      name: storedPlayer.name || fallbackPlayer.name,
      color: storedPlayer.color || fallbackPlayer.color,
      points: Number(storedPlayer.points) || 0,
      abilities: storedPlayer.abilities,
      blockedByPlayerId: storedPlayer.blockedByPlayerId || null,
    });
  });
}

function normalizeCurrentQuestion(currentQuestion) {
  if (!currentQuestion) {
    return null;
  }

  return {
    ...currentQuestion,
    removedOptionKeys: Array.isArray(currentQuestion.removedOptionKeys)
      ? currentQuestion.removedOptionKeys
      : [],
    blockedPlayerIds: Array.isArray(currentQuestion.blockedPlayerIds)
      ? currentQuestion.blockedPlayerIds
      : [],
  };
}

function createInitialState() {
  const teamDraft = createInitialTeamDraft();

  return {
    phase: "upload",
    fileName: "",
    fileSignature: "",
    categories: [],
    selectedCategoryIds: [],
    teamDraft,
    teams: teamDraft.map((team, index) => createDraftPlayer(team, index)),
    board: [],
    currentQuestion: null,
    selectedResponderId: "",
    dialog: null,
    lastResult: null,
    sessionUsedQuestionIds: [],
    upload: createInitialUploadState(),
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const teamDraft =
      Array.isArray(parsed.teamDraft) && parsed.teamDraft.length
        ? parsed.teamDraft
        : createInitialTeamDraft();

    return {
      ...createInitialState(),
      ...parsed,
      teamDraft,
      teams: normalizeStoredTeams(parsed.teams, teamDraft),
      currentQuestion: normalizeCurrentQuestion(parsed.currentQuestion),
      sessionUsedQuestionIds: Array.isArray(parsed.sessionUsedQuestionIds)
        ? parsed.sessionUsedQuestionIds
        : [],
      upload: {
        ...createInitialUploadState(),
        ...(parsed.upload || {}),
      },
    };
  } catch {
    return null;
  }
}

function loadShuffleMemory() {
  try {
    const raw = localStorage.getItem(SHUFFLE_MEMORY_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistShuffleMemory() {
  localStorage.setItem(SHUFFLE_MEMORY_KEY, JSON.stringify(shuffleMemory));
}

function commit(nextState, options = {}) {
  state = nextState;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();

  if (options.sync !== false) {
    queueRoomStateSync(nextState);
  }
}

function resetAllState() {
  if (roomContext.unsubscribeRoom) {
    roomContext.unsubscribeRoom();
    roomContext.unsubscribeRoom = null;
  }

  if (roomContext.joinedParticipant?.id && roomContext.roomCode) {
    leaveRoom(roomContext.roomCode, roomContext.joinedParticipant.id).catch(() => {});
  }

  localStorage.removeItem(STORAGE_KEY);
  state = createInitialState();
  roomContext = createRoomContext();
  clearRoomCodeFromUrl();
  render();
}

function render() {
  document.body.dataset.phase = getBodyPhase();
  document.body.dataset.room = roomContext.roomCode ? "active" : "idle";

  let screenHtml = "";
  if (roomContext.roomCode && !roomContext.joinedParticipant) {
    screenHtml = renderRoomJoinScreen();
  } else {
    switch (state.phase) {
      case "room-join":
      case "room-lobby":
        screenHtml = renderRoomLobbyScreen();
        break;
      case "category-select":
        screenHtml = renderCategorySelectionScreen();
        break;
      case "team-setup":
        screenHtml = renderTeamSetupScreen();
        break;
      case "board":
        screenHtml = renderBoardScreen();
        break;
      case "question":
        screenHtml = renderQuestionScreen();
        break;
      case "answer-select":
        screenHtml = renderAnswerSelectScreen();
        break;
      case "answer":
        screenHtml = renderAnswerScreen();
        break;
      case "winner":
        screenHtml = renderWinnerScreen();
        break;
      case "upload":
      default:
        screenHtml = renderUploadScreen();
        break;
    }
  }

  appElement.innerHTML = roomContext.roomCode
    ? renderRoomLayout(screenHtml)
    : screenHtml;
}

function getBodyPhase() {
  if (state.phase !== "answer") {
    return state.phase;
  }

  if (state.lastResult?.type === "correct") {
    return "answer-correct";
  }

  if (state.lastResult?.type === "blockNotice") {
    return "answer-blocked";
  }

  return "answer-wrong";
}

function renderRoomLayout(content) {
  return `
    <div class="room-layout">
      ${renderRoomHeader()}
      <div class="room-stage">${content}</div>
      ${renderChatDock()}
    </div>
  `;
}

function renderRoomHeader() {
  const playerCount = getRoomPlayers().length;
  const spectatorCount = getRoomSpectators().length;
  const participantLabel = roomContext.joinedParticipant
    ? `${roomContext.joinedParticipant.name} • ${
        roomContext.joinedParticipant.role === "player" ? "لاعب" : "متفرج"
      }`
    : "لم تنضم بعد";

  return `
    <section class="room-topbar panel">
      <div class="panel-inner room-topbar-inner">
        <div class="room-chip-group">
          <span class="pill">الغرفة: ${escapeHtml(roomContext.roomCode || "----")}</span>
          <span class="pill">اللاعبون: ${formatNumber(playerCount)} / 4</span>
          <span class="pill">المتفرجون: ${formatNumber(spectatorCount)}</span>
          <span class="pill">${escapeHtml(participantLabel)}</span>
        </div>
        <div class="btn-row room-actions no-capture" style="margin-top:0;">
          <button class="btn btn-secondary" data-action="copy-room-link">نسخ الرابط</button>
          ${
            roomContext.isHost
              ? `<button class="btn btn-ghost" data-action="send-rules">القوانين</button>`
              : ""
          }
        </div>
      </div>
    </section>
  `;
}

function renderChatDock() {
  const messages = roomContext.chatMessages.slice(-40);
  const joined = Boolean(roomContext.joinedParticipant);

  return `
    <section class="chat-dock panel">
      <div class="panel-inner chat-dock-inner">
        <div class="chat-dock-head">
          <h3>الدردشة</h3>
          <span>${escapeHtml(roomContext.roomCode || "")}</span>
        </div>

        <div class="chat-messages" id="chat-messages">
          ${
            messages.length
              ? messages
                  .map(
                    (message) => `
                      <article class="chat-message ${message.kind === "system" ? "system" : ""}">
                        <strong>${escapeHtml(message.name || "النظام")}</strong>
                        <p>${escapeHtml(message.text || "")}</p>
                      </article>
                    `
                  )
                  .join("")
              : `<div class="chat-empty">لا توجد رسائل بعد.</div>`
          }
        </div>

        <form id="chat-form" class="chat-form ${joined ? "" : "disabled"}">
          <input
            type="text"
            name="chat_message"
            maxlength="220"
            placeholder="${joined ? "اكتب رسالة..." : "انضم للغرفة أولًا"}"
            ${joined ? "" : "disabled"}
          />
          <button class="btn btn-primary" type="submit" ${joined ? "" : "disabled"}>
            إرسال
          </button>
        </form>
      </div>
    </section>
  `;
}

function renderRoomJoinScreen() {
  const playerCount = getRoomPlayers().length;
  const playerSlotsAvailable = playerCount < 4;
  const defaultColor = getNextAvailableColor(getRoomPlayers());

  return `
    <section class="screen panel room-screen">
      <div class="panel-inner room-join-layout">
        <div class="room-card">
          <h2 class="section-title">الانضمام إلى الغرفة</h2>
          <p class="section-subtitle">
            اكتب اسمك، اختر لونًا غير مستخدم إذا أردت الدخول كلاعب، أو اختر
            المشاهدة فقط كمتفرج.
          </p>

          ${
            !roomContext.roomExists
              ? `<div class="info-banner" style="margin-top:18px;background:rgba(255,92,92,0.1);border-color:rgba(255,92,92,0.18);color:#ffd6d6;">تعذر العثور على هذه الغرفة حاليًا أو أنها لم تُنشأ بعد.</div>`
              : ""
          }

          <div class="helper-row">
            <div class="pill">رمز الغرفة: ${escapeHtml(roomContext.roomCode || "----")}</div>
            <div class="pill">أماكن اللاعبين المتبقية: ${formatNumber(Math.max(0, 4 - playerCount))}</div>
          </div>

          <form id="join-room-form" style="margin-top:22px;">
            <input
              type="text"
              name="join_name"
              placeholder="اسمك داخل الغرفة"
              maxlength="30"
              value="${escapeHtmlAttribute(roomContext.pendingName || "")}"
              required
              style="width:100%;margin-top:0;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:var(--text);padding:14px 16px;font:inherit;"
            />

            <div class="join-role-grid">
              <label class="role-card ${roomContext.pendingRole === "player" ? "selected" : ""} ${
                playerSlotsAvailable ? "" : "disabled"
              }">
                <input
                  type="radio"
                  name="join_role"
                  value="player"
                  ${roomContext.pendingRole === "player" && playerSlotsAvailable ? "checked" : ""}
                  ${playerSlotsAvailable ? "" : "disabled"}
                />
                <strong>لاعب</strong>
                <span>${playerSlotsAvailable ? "سيظهر اسمك ونقاطك داخل المباراة." : "لا توجد أماكن لاعبين متبقية."}</span>
              </label>

              <label class="role-card ${roomContext.pendingRole === "spectator" || !playerSlotsAvailable ? "selected" : ""}">
                <input
                  type="radio"
                  name="join_role"
                  value="spectator"
                  ${
                    roomContext.pendingRole === "spectator" || !playerSlotsAvailable
                      ? "checked"
                      : ""
                  }
                />
                <strong>متفرج</strong>
                <span>تشاهد مجريات اللعبة وتشارك في الدردشة فقط.</span>
              </label>
            </div>

            <div class="join-color-row">
              <span>لون اللاعب</span>
              <input
                type="color"
                name="join_color"
                value="${escapeHtmlAttribute(normalizeColorHex(roomContext.pendingColor) || defaultColor)}"
              />
            </div>

            <div class="btn-row">
              <button class="btn btn-primary" type="submit" ${
                roomContext.roomExists ? "" : "disabled"
              }>
                دخول الغرفة
              </button>
            </div>
          </form>
        </div>

        <aside class="summary-card">
          <h3>المشاركون الآن</h3>
          <div class="room-roster-grid compact">
            ${renderParticipantRoster()}
          </div>
        </aside>
      </div>
    </section>
  `;
}

function renderRoomLobbyScreen() {
  const players = getRoomPlayers();
  const spectators = getRoomSpectators();
  const canStartCategories =
    roomContext.isHost && roomContext.joinedParticipant && state.categories.length > 0;

  return `
    <section class="screen panel room-screen">
      <div class="panel-inner room-lobby-layout">
        <div class="room-card">
          <h2 class="section-title">الغرفة جاهزة</h2>
          <p class="section-subtitle">
            انشر الرابط أو رمز الغرفة، وانتظر حتى يدخل اللاعبون. التحكم الكامل
            في سير المباراة يبقى عند منشئ الغرفة.
          </p>

          <div class="helper-row">
            <div class="pill">الرابط: ${escapeHtml(roomContext.roomUrl)}</div>
            <div class="pill">رمز الغرفة: ${escapeHtml(roomContext.roomCode)}</div>
          </div>

          <div class="room-roster-block">
            <h3>اللاعبون</h3>
            <div class="room-roster-grid">
              ${
                players.length
                  ? players.map((participant) => renderParticipantCard(participant)).join("")
                  : `<div class="chat-empty">لم ينضم لاعبون بعد.</div>`
              }
            </div>
          </div>

          <div class="room-roster-block">
            <h3>المتفرجون</h3>
            <div class="room-roster-grid compact">
              ${
                spectators.length
                  ? spectators.map((participant) => renderParticipantCard(participant)).join("")
                  : `<div class="chat-empty">لا يوجد متفرجون بعد.</div>`
              }
            </div>
          </div>

          ${
            roomContext.isHost
              ? `<div class="btn-row">
                  <button
                    class="btn btn-primary"
                    data-action="go-room-categories"
                    ${canStartCategories && players.length >= 2 ? "" : "disabled"}
                  >
                    متابعة المباراة
                  </button>
                </div>`
              : `<div class="info-banner" style="margin-top:20px;">بانتظار منشئ الغرفة ليبدأ تجهيز المباراة.</div>`
          }
        </div>
      </div>
    </section>
  `;
}

function renderParticipantRoster() {
  return roomContext.participants.length
    ? roomContext.participants.map((participant) => renderParticipantCard(participant)).join("")
    : `<div class="chat-empty">لا يوجد مشاركون بعد.</div>`;
}

function renderParticipantCard(participant) {
  const tone =
    participant.role === "player" && participant.color
      ? `style="--participant-color:${escapeHtmlAttribute(participant.color)};--participant-text:${escapeHtmlAttribute(
          getContrastTextColor(participant.color)
        )};"`
      : "";

  return `
    <article class="participant-card ${participant.role === "player" ? "player" : "spectator"}" ${tone}>
      <strong>${escapeHtml(participant.name)}</strong>
      <span>${participant.role === "player" ? "لاعب" : "متفرج"}${participant.id === roomContext.hostClientId ? " • منشئ" : ""}</span>
    </article>
  `;
}

function renderUploadScreen() {
  const hasLoadedQuestions = state.upload.completed && state.categories.length > 0;
  const status = state.upload.error || state.upload.status;
  const progress = Math.max(0, Math.min(100, state.upload.progress || 0));
  const questionCount = state.upload.questionCount || 0;
  const categoryCount = state.upload.categoryCount || 0;
  const totalGameSlots = estimateGameSlotCapacity(state.categories);

  return `
    <section class="screen panel">
      <div class="panel-inner upload-layout">
        <div class="upload-card">
          <h2 class="section-title">حمّل ملف الإكسل ثم ابدأ اللعب</h2>
          <p class="section-subtitle">
            الصيغة المتوقعة: أعمدة للتصنيف، السؤال، الخيارات، الإجابة الصحيحة، والنقاط.
            يدعم الموقع نقاط <strong>200 / 400 / 600</strong> كما في النموذج.
          </p>

          <label class="drop-zone">
            <input
              id="excel-file"
              class="file-input"
              type="file"
              accept=".xlsx,.xls,.csv"
            />
            <span class="drop-badge">اختر ملف الإكسل</span>
            <h3>${escapeHtml(state.fileName || "لا يوجد ملف محدد بعد")}</h3>
            <p>
              بمجرد اختيار الملف سيبدأ التحميل والتحليل مباشرة، وسيظهر عدد التصنيفات
              والأسئلة أسفل شريط التقدم.
            </p>
          </label>

          <div class="status-row">
            <div class="status-chip">
              <strong>${formatNumber(categoryCount)}</strong>
              <span>عدد التصنيفات</span>
            </div>
            <div class="status-chip">
              <strong>${formatNumber(questionCount)}</strong>
              <span>عدد الأسئلة الصالحة</span>
            </div>
            <div class="status-chip">
              <strong>${formatNumber(totalGameSlots)}</strong>
              <span>خانات اللعب المتاحة</span>
            </div>
          </div>

          <div class="progress-shell">
            <div class="progress-line" aria-label="تقدم التحميل">
              <span style="width:${progress}%"></span>
            </div>
            <div class="progress-copy">
              <span>${escapeHtml(status)}</span>
              <span>${progress}%</span>
            </div>
          </div>

          ${
            state.upload.error
              ? `<div class="info-banner" style="margin-top:18px;background:rgba(255,92,92,0.1);border-color:rgba(255,92,92,0.18);color:#ffd6d6;">${escapeHtml(
                  state.upload.error
                )}</div>`
              : ""
          }

          <div class="btn-row">
            <button
              class="btn btn-primary"
              data-action="start-flow"
              ${hasLoadedQuestions ? "" : "disabled"}
            >
              بدء اللعبة
            </button>
            <button class="btn btn-secondary" data-action="download-template">
              تحميل نموذج إكسل
            </button>
            ${
              hasLoadedQuestions
                ? `<button class="btn btn-ghost" data-action="reset-all">تغيير الملف</button>`
                : ""
            }
          </div>
        </div>

        <aside class="summary-card">
          <div>
            <h3>ما الذي سيحدث بعد الرفع؟</h3>
            <p>
              سيقرأ الموقع الملف، يجهز التصنيفات، ثم يفتح لك مسارًا منظمًا:
              اختيار التصنيفات، إعداد أول لاعبين، ثم لوحة لعب يمكن أن تضيف
              إليها لاعبين جدد أثناء المباراة.
            </p>
          </div>

          <div class="mini-stat-list">
            <div class="mini-stat">
              <strong>6</strong>
              <span>عدد التصنيفات المعروضة في المباراة الواحدة</span>
            </div>
            <div class="mini-stat">
              <strong>+2</strong>
              <span>تبدأ بلاعبين ويمكن إضافة لاعبين آخرين أثناء اللعب</span>
            </div>
            <div class="mini-stat">
              <strong>0</strong>
              <span>تكرار للأسئلة داخل الجلسة الحالية لنفس الملف</span>
            </div>
          </div>

          <div class="info-banner">
            إذا كان عدد التصنيفات أكثر من ستة فستختار منها ستة فقط قبل بدء
            المباراة. وإذا كانت ستة أو أقل فسيجهزها الموقع تلقائيًا.
          </div>
        </aside>
      </div>
    </section>
  `;
}

function renderCategorySelectionScreen() {
  const categories = state.categories || [];
  const availableCategories = getAvailableCategories(categories, state.sessionUsedQuestionIds);
  const availableCategoryIdSet = new Set(availableCategories.map((category) => category.id));
  const targetCount = Math.min(6, availableCategories.length);
  const lockedSelection = availableCategories.length <= 6;
  const selectedIds = lockedSelection
    ? availableCategories.map((category) => category.id)
    : state.selectedCategoryIds.filter((categoryId) => availableCategoryIdSet.has(categoryId));
  const selectedCount = selectedIds.length;
  const helperText =
    targetCount === 0
      ? "كل أسئلة هذا الملف استُخدمت بالفعل في هذه الجلسة."
      : availableCategories.length > 6
        ? `اختر ${targetCount} تصنيفات بالضبط من أصل ${availableCategories.length} تصنيفًا ما زال متاحًا في هذه الجلسة.`
        : "هذه هي التصنيفات المتبقية في الجلسة الحالية، وهي محددة مسبقًا.";

  return `
    <section class="screen panel">
      <div class="panel-inner">
        <h2 class="section-title">اختر تصنيفات المباراة</h2>
        <p class="section-subtitle">
          ${escapeHtml(helperText)}
        </p>

        <div class="helper-row">
          <div class="pill">التصنيفات المختارة: ${formatNumber(selectedCount)} / ${formatNumber(
            targetCount
          )}</div>
          <div class="pill">الملف: ${escapeHtml(state.fileName || "بدون اسم")}</div>
          <div class="pill">الأسئلة المستخدمة في الجلسة: ${formatNumber(
            state.sessionUsedQuestionIds.length
          )}</div>
        </div>

        ${
          targetCount === 0
            ? `<div class="info-banner" style="margin-top:18px;">لا توجد أسئلة جديدة متبقية لنفس الملف داخل هذه الجلسة. غيّر الملف إذا أردت مواصلة اللعب بدون تكرار.</div>`
            : ""
        }

        <div class="categories-grid">
          ${categories
            .map((category) => {
              const remainingQuestions = countCategoryQuestions(
                category,
                state.sessionUsedQuestionIds
              );
              const remainingSlots = estimateCategoryGameSlots(
                category,
                state.sessionUsedQuestionIds
              );
              const exhausted = remainingSlots === 0;
              const selected = !exhausted && selectedIds.includes(category.id);
              const selectableAttr =
                lockedSelection || exhausted
                  ? ""
                  : `data-action="toggle-category" data-category-id="${escapeHtmlAttribute(
                      category.id
                    )}"`;

              return `
                <article class="category-card ${selected ? "selected" : ""} ${
                  exhausted ? "exhausted" : ""
                }" ${selectableAttr}>
                  <h3>${escapeHtml(category.name)}</h3>
                  <div class="category-meta">
                    <span>${formatNumber(remainingQuestions)} سؤال متبقٍ</span>
                    <span>${formatNumber(remainingSlots)} خانة متبقية</span>
                  </div>
                </article>
              `;
            })
            .join("")}
        </div>

        <div class="btn-row">
          <button
            class="btn btn-primary"
            data-action="go-team-setup"
            ${selectedCount === targetCount && targetCount > 0 ? "" : "disabled"}
          >
            ${roomContext.roomCode ? "بدء المباراة" : "التالي"}
          </button>
          <button class="btn btn-ghost" data-action="back-to-upload">العودة للملف</button>
        </div>
      </div>
    </section>
  `;
}

function renderTeamSetupScreen() {
  const selectedCategories = getSelectedCategories();

  return `
    <section class="screen panel">
      <div class="panel-inner">
        <h2 class="section-title">أسماء أول لاعبين وألوانهما</h2>
        <p class="section-subtitle">
          اكتب اسم أول لاعبين، اختر لون كل لاعب، ثم ابدأ اللعبة. يمكنك إضافة
          لاعبين جدد لاحقًا أثناء المباراة.
        </p>

        <div class="helper-row">
          <div class="pill">التصنيفات المختارة: ${selectedCategories
            .map((category) => escapeHtml(category.name))
            .join(" • ")}</div>
        </div>

        <form id="teams-form">
          <div class="teams-grid">
            ${state.teamDraft
              .map((team, index) => {
                const label = index === 0 ? "اللاعب الأول" : "اللاعب الثاني";

                return `
                  <article class="team-card">
                    <h3>${label}</h3>
                    <p class="helper-text">
                      هذا اللاعب سيظهر أعلى اللوحة مع نقاطه ومميزاته الفردية.
                    </p>
                    <input
                      type="text"
                      value="${escapeHtmlAttribute(team.name)}"
                      placeholder="اسم اللاعب"
                      maxlength="30"
                      data-team-name-index="${index}"
                    />
                    <div class="color-picker">
                      ${TEAM_COLORS.map(
                        (color) => `
                          <button
                            class="color-swatch ${normalizeColorHex(team.color) === normalizeColorHex(color) ? "active" : ""}"
                            type="button"
                            title="${escapeHtmlAttribute(color)}"
                            style="background:${color}"
                            data-action="pick-color"
                            data-team-index="${index}"
                            data-color="${escapeHtmlAttribute(color)}"
                          ></button>
                        `
                      ).join("")}
                    </div>
                    <div class="team-preview" style="border-color:${team.color};">
                      <div class="team-mark" style="--team-color:${team.color};">${escapeHtml(
                        team.name || `لاعب ${index + 1}`
                      )}</div>
                      <div class="team-meta">
                        <span>اللون المختار</span>
                        <span>${escapeHtml(team.color)}</span>
                      </div>
                    </div>
                  </article>
                `;
              })
              .join("")}
          </div>

          <div class="btn-row">
            <button class="btn btn-primary" type="submit">التالي</button>
            <button class="btn btn-ghost" type="button" data-action="back-to-categories">
              العودة للتصنيفات
            </button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderBoardScreen() {
  const remaining = countRemainingSlots(state.board);
  const total = countTotalAvailableSlots(state.board);
  const pendingDoubles = state.teams.filter((player) => player.abilities.double.pending);
  const blockedPlayers = state.teams.filter((player) => player.blockedByPlayerId);

  return `
    <section class="screen">
      <div class="board-center board-canvas" data-share-root>
        <div class="panel board-banner">
          <div class="panel-inner" style="padding:0;">
            <h2 class="section-title">لوحة التحدي</h2>
            <div class="helper-row">
              <div class="pill">المتبقي: ${formatNumber(remaining)} / ${formatNumber(total)}</div>
              <div class="pill">كل الأسئلة الآن محايدة، وبعد عرض الجواب حدّد اللاعب الذي أجاب</div>
              ${
                pendingDoubles.length
                  ? `<div class="pill">2× جاهز لـ ${pendingDoubles
                      .map(
                        (player) =>
                          `<span style="color:${player.color};">${escapeHtml(player.name)}</span>`
                      )
                      .join(" / ")}</div>`
                  : ""
              }
              ${
                blockedPlayers.length
                  ? `<div class="pill">بلوك الجولة القادمة: ${blockedPlayers
                      .map((player) => escapeHtml(player.name))
                      .join(" / ")}</div>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="players-strip">
          ${state.teams.map((player) => renderPlayerBoardCard(player)).join("")}
        </div>

        <div class="board-grid">
          ${state.board.map((card) => renderBoardCard(card)).join("")}
        </div>

        <div class="btn-row no-capture">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
          <button class="btn btn-ghost" data-action="reset-all">تغيير الملف</button>
        </div>
      </div>

      ${renderDialog()}
    </section>
  `;
}

function renderQuestionScreen() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion) {
    return renderFallbackScreen("لا يوجد سؤال نشط حاليًا.");
  }

  const visibleOptions = currentQuestion.question.options.filter(
    (option) => !currentQuestion.removedOptionKeys.includes(option.key)
  );
  const canUseRemoveTwo = canUseRemoveTwoInCurrentQuestion();
  const blockedPlayers = currentQuestion.blockedPlayerIds
    .map((playerId) => getPlayerName(playerId))
    .filter(Boolean);

  return `
    <section class="screen question-shell">
      <div class="question-card" data-share-root>
        <div class="question-meta">
          <span class="pill">${escapeHtml(currentQuestion.categoryName)}</span>
          <span class="pill">${formatNumber(currentQuestion.question.points)} نقطة</span>
        </div>
        <h2 class="question-text">${escapeHtml(currentQuestion.question.text)}</h2>

        ${
          blockedPlayers.length
            ? `<div class="helper-row" style="justify-content:center;">
                <div class="pill">المحظورون في هذه الجولة: ${blockedPlayers
                  .map((name) => escapeHtml(name))
                  .join(" / ")}</div>
              </div>`
            : ""
        }

        <div class="question-tools no-capture">
          <div class="question-tool-group">
            <button
              class="ability-icon"
              type="button"
              title="حذف إجابتين"
              ${canUseRemoveTwo ? "" : "disabled"}
              data-action="open-remove-two-picker"
            >
              ${ABILITY_META.removeTwo.icon}
            </button>
          </div>
        </div>

        <div class="options-list">
          ${visibleOptions
            .map(
              (option) => `
                <div class="option-card">
                  <strong>(${displayOptionKey(option.key)})</strong>
                  ${escapeHtml(option.label)}
                </div>
              `
            )
            .join("")}
        </div>

        <div class="btn-row no-capture" style="justify-content:center;">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
          <button class="btn btn-primary" data-action="go-answer-select">التالي</button>
        </div>
      </div>

      ${renderDialog()}
    </section>
  `;
}

function renderAnswerSelectScreen() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion) {
    return renderFallbackScreen("لا يوجد سؤال نشط حاليًا.");
  }

  const selectedResponderId = state.selectedResponderId;
  const blockedPlayerIdSet = new Set(currentQuestion.blockedPlayerIds || []);
  const selectedPlayer =
    selectedResponderId && selectedResponderId !== "__none__"
      ? state.teams.find((player) => player.id === selectedResponderId)
      : null;

  return `
    <section class="screen question-shell">
      <div class="question-card" data-share-root>
        <div class="question-meta">
          <span class="pill">${escapeHtml(currentQuestion.categoryName)}</span>
          <span class="pill">${formatNumber(currentQuestion.question.points)} نقطة</span>
        </div>

        <h2 class="section-title" style="margin-bottom:14px;">الجواب الصحيح</h2>
        <p class="question-text" style="font-size:2rem;">${escapeHtml(
          currentQuestion.question.answerText
        )}</p>

        <div class="player-choice-grid">
          ${state.teams
            .map((player) =>
              renderPlayerChoiceCard({
                player,
                selected: selectedResponderId === player.id,
                disabled: blockedPlayerIdSet.has(player.id),
                action: "select-responder",
                subtitle: blockedPlayerIdSet.has(player.id)
                  ? `ممنوع هذه الجولة بواسطة ${escapeHtml(
                      getPlayerName(player.blockedByPlayerId) || "بلوك"
                    )}`
                  : player.abilities.double.pending
                    ? "2× جاهز"
                    : `${formatNumber(player.points)} نقطة`,
              })
            )
            .join("")}

          ${
            roomContext.roomCode
              ? ""
              : `<button
                  class="choice-card add-choice-card"
                  data-action="open-add-player"
                  data-purpose="answer-select"
                >
                  <strong>+</strong>
                  <span>لاعب جديد</span>
                </button>`
          }

          <button
            class="choice-card no-one-card ${selectedResponderId === "__none__" ? "selected" : ""}"
            data-action="select-no-one"
          >
            <strong>لا أحد</strong>
            <span>بمعنى لم يجب أحد</span>
          </button>
        </div>

        ${
          selectedPlayer
            ? `<div class="helper-row" style="justify-content:center;"><div class="pill" style="color:${selectedPlayer.color};">سيُسجل الجواب لصالح ${escapeHtml(
                selectedPlayer.name
              )}</div></div>`
            : selectedResponderId === "__none__"
              ? `<div class="helper-row" style="justify-content:center;"><div class="pill">سيُسجّل السؤال على أنه بلا مجيب</div></div>`
              : ""
        }

        <div class="btn-row no-capture" style="justify-content:center;">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
          <button
            class="btn btn-primary"
            data-action="confirm-responder"
            ${selectedResponderId ? "" : "disabled"}
          >
            التالي
          </button>
        </div>
      </div>

      ${renderDialog()}
    </section>
  `;
}

function renderAnswerScreen() {
  const result = state.lastResult;
  if (!result) {
    return renderFallbackScreen("لم يتم العثور على نتيجة الجولة.");
  }

  const player = result.playerId ? getPlayerById(result.playerId) : null;
  const actorPlayer = result.actorPlayerId ? getPlayerById(result.actorPlayerId) : null;
  const targetPlayer = result.targetPlayerId ? getPlayerById(result.targetPlayerId) : null;
  const resultType = result.type;
  const scoreClass =
    resultType === "correct" ? "success" : resultType === "blockNotice" ? "blocked" : "fail";
  const emoji =
    resultType === "correct" ? "🥳" : resultType === "blockNotice" ? "⛔" : "😔";
  const borderColor = player?.color || actorPlayer?.color || "#ff6b6b";
  const title =
    resultType === "correct"
      ? "إجابة صحيحة"
      : resultType === "blockNotice"
        ? "تم تفعيل البلوك"
        : "لم يجيب أحد";
  const subtitle =
    resultType === "correct"
      ? `الجواب الصحيح لصالح ${player?.name || "اللاعب"}.`
      : resultType === "blockNotice"
        ? `تم عمل بلوك للاعب ${targetPlayer?.name || ""} من قبل ${actorPlayer?.name || ""} للجولة القادمة.`
        : "انتهى هذا السؤال بدون مجيب.";

  return `
    <section class="screen result-shell">
      <div class="result-card ${scoreClass}" data-share-root style="border-color:${borderColor}">
        <div class="emoji">${emoji}</div>
        <h2 class="section-title">${escapeHtml(title)}</h2>
        <p class="section-subtitle">${escapeHtml(subtitle)}</p>

        ${
          resultType === "correct"
            ? `
              <div class="score-big success">${formatSignedNumber(result.scoreDelta)}</div>
              ${
                result.usedDouble
                  ? `<div class="helper-row" style="justify-content:center;"><div class="pill" style="color:${player?.color || "#ffd166"};">تم تطبيق دبل النقاط ×2</div></div>`
                  : ""
              }
            `
            : resultType === "blockNotice"
              ? `<div class="score-big blocked">⛔</div>`
              : `<div class="score-big fail">0</div>`
        }

        <div class="answer-grid">
          <div class="answer-stat">
            <strong>${escapeHtml(result.categoryName || "الجولة القادمة")}</strong>
            <span>${resultType === "blockNotice" ? "الحالة" : "التصنيف"}</span>
          </div>
          <div class="answer-stat">
            <strong>${escapeHtml(
              resultType === "blockNotice" ? actorPlayer?.name || "" : result.correctAnswer || ""
            )}</strong>
            <span>${resultType === "blockNotice" ? "من فعّل البلوك" : "الإجابة الصحيحة"}</span>
          </div>
          <div class="answer-stat">
            <strong>${escapeHtml(
              resultType === "correct"
                ? player?.name || ""
                : resultType === "blockNotice"
                  ? targetPlayer?.name || ""
                  : "لا أحد"
            )}</strong>
            <span>${
              resultType === "correct"
                ? "صاحب الجواب"
                : resultType === "blockNotice"
                  ? "اللاعب المحظور"
                  : "حالة السؤال"
            }</span>
          </div>
        </div>

        <div class="btn-row no-capture" style="justify-content:center;">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
          <button class="btn btn-primary" data-action="next-after-answer">التالي</button>
        </div>
      </div>
    </section>
  `;
}

function renderWinnerScreen() {
  const players = [...state.teams].sort((left, right) => right.points - left.points);
  const [winner, runnerUp] = players;
  const isTie = winner && runnerUp && winner.points === runnerUp.points;

  return `
    <section class="screen winner-shell">
      <div class="winner-card" data-share-root style="border-color:${winner?.color || "#ffd166"}">
        <div class="winner-crown">${isTie ? "🤝" : "👑"}</div>
        <h2 class="section-title">${isTie ? "انتهت اللعبة بالتعادل" : "اللاعب الفائز"}</h2>
        <h3 class="winner-name" style="color:${winner?.color || "#ffd166"};">
          ${escapeHtml(isTie ? "تعادل اللاعبون" : winner?.name || "")}
        </h3>
        <p class="winner-points">
          ${
            isTie
              ? `أعلى نتيجة كانت ${formatNumber(winner?.points || 0)} نقطة`
              : `${escapeHtml(winner?.name || "")} جمع ${formatNumber(winner?.points || 0)} نقطة`
          }
        </p>

        <div class="winner-grid">
          ${players
            .map(
              (player) => `
                <div class="${player.id === winner?.id && !isTie ? "winner-badge" : "loser-card"}" style="border-color:${player.color};">
                  <h3 style="margin-top:0;color:${player.color};">${escapeHtml(player.name)}</h3>
                  <p style="margin:0;">${formatNumber(player.points)} نقطة</p>
                </div>
              `
            )
            .join("")}
        </div>

        <div class="btn-row no-capture" style="justify-content:center;">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
          <button class="btn btn-primary" data-action="restart-same-file">لعبة جديدة بنفس الملف</button>
          <button class="btn btn-ghost" data-action="reset-all">تغيير الملف</button>
        </div>
      </div>
    </section>
  `;
}

function renderFallbackScreen(message) {
  return `
    <section class="screen panel">
      <div class="panel-inner">
        <div class="empty-state">${escapeHtml(message)}</div>
        <div class="btn-row">
          <button class="btn btn-primary" data-action="reset-all">العودة للبداية</button>
        </div>
      </div>
    </section>
  `;
}

function renderPlayerBoardCard(player) {
  const canToggleDouble = !player.abilities.double.used || player.abilities.double.pending;
  const canUseBlock = !player.abilities.block.used && state.phase === "board";
  const blockedByName = getPlayerName(player.blockedByPlayerId);
  const contrastColor = getContrastTextColor(player.color);

  return `
    <article
      class="player-score-card"
      style="--player-color:${escapeHtmlAttribute(player.color)};--player-text:${escapeHtmlAttribute(
        contrastColor
      )};"
    >
      <div class="player-score-name">${escapeHtml(player.name)}</div>
      <div class="player-score-points">${formatNumber(player.points)}</div>
      <div class="player-score-badges">
        ${
          player.abilities.double.pending
            ? `<span class="mini-badge">2× جاهز</span>`
            : ""
        }
        ${
          blockedByName
            ? `<span class="mini-badge danger">بلوك من ${escapeHtml(blockedByName)}</span>`
            : ""
        }
      </div>
      <div class="player-card-abilities no-capture">
        ${renderAbilityButton({
          icon: ABILITY_META.double.icon,
          label: ABILITY_META.double.label,
          action: canToggleDouble ? "activate-double" : "",
          dataAttributes: `data-player-id="${escapeHtmlAttribute(player.id)}"`,
          used: player.abilities.double.used && !player.abilities.double.pending,
          active: player.abilities.double.pending,
          disabled: !canToggleDouble,
          title: player.abilities.double.pending
            ? "اضغط مرة أخرى لإلغاء الدبل"
            : "تفعيل دبل النقاط لهذا اللاعب",
        })}
        ${renderAbilityButton({
          icon: ABILITY_META.removeTwo.icon,
          label: ABILITY_META.removeTwo.label,
          action: "ability-hint",
          dataAttributes:
            'data-message="حذف إجابتين يتم تفعيله من داخل السؤال ثم تختار اللاعب المستخدم."',
          used: player.abilities.removeTwo.used,
          disabled: false,
          title: ABILITY_META.removeTwo.label,
        })}
        ${renderAbilityButton({
          icon: ABILITY_META.block.icon,
          label: ABILITY_META.block.label,
          action: canUseBlock ? "open-block-picker" : "",
          dataAttributes: `data-player-id="${escapeHtmlAttribute(player.id)}"`,
          used: player.abilities.block.used,
          disabled: !canUseBlock,
          title: "اختر لاعبًا سيتم عمل بلوك له في الجولة القادمة",
        })}
      </div>
    </article>
  `;
}

function renderAbilityButton({
  icon,
  label,
  action,
  dataAttributes = "",
  used = false,
  active = false,
  disabled = false,
  title = "",
}) {
  const actionAttr = action ? `data-action="${action}"` : "";
  const classes = ["ability-icon", used ? "used" : "", active ? "active" : ""]
    .filter(Boolean)
    .join(" ");

  return `
    <button
      class="${classes}"
      type="button"
      aria-label="${escapeHtmlAttribute(label)}"
      title="${escapeHtmlAttribute(title || label)}"
      ${actionAttr}
      ${dataAttributes}
      ${disabled || (used && !active) ? "disabled" : ""}
    >
      ${icon}
    </button>
  `;
}

function renderBoardCard(card) {
  return `
    <article class="game-card">
      <div class="card-topline">
        <span>${formatNumber(countCardRemainingSlots(card))} خانات متبقية</span>
        <span>${formatNumber(countCardAvailableQuestions(card))} أسئلة جاهزة</span>
      </div>
      <h3 class="card-title">${escapeHtml(card.name)}</h3>
      <div class="single-stack">
        ${POINT_VALUES.map((pointValue) => renderPointButton(card, pointValue)).join("")}
      </div>
    </article>
  `;
}

function renderPointButton(card, pointValue) {
  const slot = card.slots?.[pointValue];
  const answeredPlayer = slot?.answeredByPlayerId
    ? getPlayerById(slot.answeredByPlayerId)
    : null;
  const disabled = !slot || slot.used || slot.unavailable;
  const buttonColor = answeredPlayer?.color || (slot?.noAnswer ? "#b85d5d" : "#d7e1ef");
  const textColor = answeredPlayer
    ? getContrastTextColor(answeredPlayer.color)
    : slot?.noAnswer
      ? "#ffffff"
      : "#243247";
  const classes = [
    "point-button",
    "single",
    slot?.used && answeredPlayer ? "answered" : "",
    slot?.used && slot?.noAnswer ? "no-answer" : "",
    slot?.unavailable ? "unavailable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = answeredPlayer
    ? `تم تسجيل هذا السؤال لصالح ${answeredPlayer.name}`
    : slot?.noAnswer
      ? "انتهى هذا السؤال بدون مجيب"
      : slot?.unavailable
        ? "لا يوجد سؤال متاح لهذه القيمة"
        : "افتح السؤال";

  return `
    <button
      class="${classes}"
      style="--button-color:${escapeHtmlAttribute(buttonColor)};--button-text:${escapeHtmlAttribute(
        textColor
      )};"
      ${disabled ? "disabled" : ""}
      data-action="launch-slot"
      data-category-id="${escapeHtmlAttribute(card.categoryId)}"
      data-point-value="${pointValue}"
      title="${escapeHtmlAttribute(title)}"
    >
      ${formatNumber(pointValue)}
    </button>
  `;
}

function renderPlayerChoiceCard({ player, selected, disabled, action, subtitle = "" }) {
  const contrastColor = getContrastTextColor(player.color);

  return `
    <button
      class="choice-card player-choice-card ${selected ? "selected" : ""}"
      style="--player-color:${escapeHtmlAttribute(player.color)};--player-text:${escapeHtmlAttribute(
        contrastColor
      )};"
      ${disabled ? "disabled" : ""}
      data-action="${action}"
      data-player-id="${escapeHtmlAttribute(player.id)}"
    >
      <strong>${escapeHtml(player.name)}</strong>
      <span>${subtitle}</span>
    </button>
  `;
}

function renderDialog() {
  if (!state.dialog) {
    return "";
  }

  if (state.dialog.type === "pick-player") {
    return renderPickPlayerDialog();
  }

  if (state.dialog.type === "add-player") {
    return renderAddPlayerDialog();
  }

  return "";
}

function renderPickPlayerDialog() {
  const dialog = state.dialog;
  if (!dialog || dialog.type !== "pick-player") {
    return "";
  }

  const actor = dialog.actorPlayerId ? getPlayerById(dialog.actorPlayerId) : null;
  const players =
    dialog.purpose === "remove-two"
      ? state.teams.filter((player) => !player.abilities.removeTwo.used)
      : state.teams.filter(
          (player) => player.id !== dialog.actorPlayerId && !player.blockedByPlayerId
        );
  const title =
    dialog.purpose === "remove-two"
      ? "من سيستخدم حذف إجابتين؟"
      : `من اللاعب الذي سيتم عمل بلوك له بواسطة ${actor?.name || "هذا اللاعب"}؟`;
  const subtitle =
    dialog.purpose === "remove-two"
      ? "سيُستهلك حذف إجابتين لهذا اللاعب."
      : "هذا اللاعب سيكون محظورًا في اختيار صاحب الجواب للجولة القادمة.";

  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <h3 style="margin-top:0;">${escapeHtml(title)}</h3>
        <p>${escapeHtml(subtitle)}</p>
        <div class="player-choice-grid compact">
          ${players
            .map((player) =>
              renderPlayerChoiceCard({
                player,
                selected: false,
                disabled: false,
                action: "pick-dialog-player",
                subtitle:
                  dialog.purpose === "remove-two"
                    ? "سيُستهلك الحذف لهذا اللاعب"
                    : `${formatNumber(player.points)} نقطة`,
              })
            )
            .join("")}

          ${
            dialog.purpose === "remove-two" && !roomContext.roomCode
              ? `<button class="choice-card add-choice-card" data-action="open-add-player" data-purpose="remove-two">
                  <strong>+</strong>
                  <span>لاعب جديد</span>
                </button>`
              : ""
          }
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost" data-action="close-dialog">إغلاق</button>
        </div>
      </div>
    </div>
  `;
}

function renderAddPlayerDialog() {
  const dialog = state.dialog;
  const defaultColor = getNextAvailableColor();

  return `
    <div class="modal-backdrop">
      <div class="modal-card">
        <h3 style="margin-top:0;">إضافة لاعب جديد</h3>
        <p>اكتب اسم اللاعب واختر لونًا مختلفًا عن بقية اللاعبين.</p>
        <form id="add-player-form">
          <input type="hidden" name="purpose" value="${escapeHtmlAttribute(dialog?.purpose || "")}" />
          <input
            type="text"
            name="player_name"
            placeholder="اسم اللاعب"
            maxlength="30"
            required
            style="width:100%;margin-top:16px;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);color:var(--text);padding:14px 16px;font:inherit;"
          />
          <input
            type="color"
            name="player_color"
            value="${escapeHtmlAttribute(defaultColor)}"
            style="width:100%;margin-top:16px;height:56px;border-radius:16px;border:1px solid rgba(255,255,255,0.1);background:transparent;padding:8px;"
          />
          <div class="btn-row">
            <button class="btn btn-primary" type="submit">إضافة</button>
            <button class="btn btn-ghost" type="button" data-action="close-dialog">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function onAppClick(event) {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) {
    return;
  }

  const { action } = actionElement.dataset;

  if (roomContext.roomCode && !roomContext.isHost && requiresHostControl(action)) {
    showToast("التحكم الكامل في اللعبة مخصص لمنشئ الغرفة.");
    return;
  }

  switch (action) {
    case "start-flow":
      startFlow().catch((error) => {
        showToast(error instanceof Error ? error.message : "تعذر إنشاء الغرفة.");
      });
      break;
    case "download-template":
      downloadExcelTemplate();
      break;
    case "copy-room-link":
      copyCurrentRoomLink();
      break;
    case "send-rules":
      sendRulesMessage();
      break;
    case "go-room-categories":
      goToRoomLobbyCategories();
      break;
    case "toggle-category":
      toggleCategory(actionElement.dataset.categoryId || "");
      break;
    case "go-team-setup":
      goToTeamSetup();
      break;
    case "back-to-upload":
      commit({
        ...state,
        phase: "upload",
      });
      break;
    case "back-to-categories":
      commit({
        ...state,
        phase: "category-select",
      });
      break;
    case "pick-color":
      pickTeamColor(
        Number(actionElement.dataset.teamIndex),
        actionElement.dataset.color || ""
      );
      break;
    case "activate-double":
      activateDoubleForPlayer(actionElement.dataset.playerId || "");
      break;
    case "ability-hint":
      showToast(actionElement.dataset.message || "تُستخدم هذه الميزة في موضع مختلف.");
      break;
    case "launch-slot":
      openQuestion(
        actionElement.dataset.categoryId || "",
        Number(actionElement.dataset.pointValue)
      );
      break;
    case "open-remove-two-picker":
      openRemoveTwoPicker();
      break;
    case "open-block-picker":
      openBlockPicker(actionElement.dataset.playerId || "");
      break;
    case "pick-dialog-player":
      handleDialogPlayerPick(actionElement.dataset.playerId || "");
      break;
    case "open-add-player":
      openAddPlayer(actionElement.dataset.purpose || "");
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "go-answer-select":
      goToAnswerSelect();
      break;
    case "select-responder":
      selectResponder(actionElement.dataset.playerId || "");
      break;
    case "select-no-one":
      selectResponder("__none__");
      break;
    case "confirm-responder":
      confirmResponder();
      break;
    case "next-after-answer":
      moveAfterAnswer();
      break;
    case "share-current":
      shareCurrentView();
      break;
    case "restart-same-file":
      restartWithSameFile();
      break;
    case "reset-all":
      resetAllState();
      break;
    default:
      break;
  }
}

function requiresHostControl(action) {
  return [
    "start-flow",
    "download-template",
    "toggle-category",
    "go-team-setup",
    "back-to-upload",
    "back-to-categories",
    "pick-color",
    "activate-double",
    "launch-slot",
    "open-remove-two-picker",
    "open-block-picker",
    "pick-dialog-player",
    "open-add-player",
    "close-dialog",
    "go-answer-select",
    "select-responder",
    "select-no-one",
    "confirm-responder",
    "next-after-answer",
    "restart-same-file",
    "reset-all",
    "go-room-categories",
    "send-rules",
  ].includes(action);
}

function onAppChange(event) {
  const target = event.target;

  if (target.id === "excel-file") {
    const [file] = target.files || [];
    if (file) {
      handleFileSelection(file);
    }
    return;
  }

  if (target.name === "join_role") {
    roomContext.pendingRole = target.value === "spectator" ? "spectator" : "player";
    render();
    return;
  }

  if (target.name === "join_color") {
    roomContext.pendingColor = target.value;
    return;
  }

  if (target.dataset.teamNameIndex) {
    syncTeamName(Number(target.dataset.teamNameIndex), target.value, true);
  }
}

function onAppInput(event) {
  const target = event.target;
  if (target.name === "join_name") {
    roomContext.pendingName = target.value;
    return;
  }

  if (!target.dataset.teamNameIndex) {
    return;
  }

  syncTeamName(Number(target.dataset.teamNameIndex), target.value, false);
}

function onAppSubmit(event) {
  if (event.target.id === "join-room-form") {
    event.preventDefault();
    joinCurrentRoom(event.target).catch((error) => {
      showToast(error instanceof Error ? error.message : "تعذر الانضمام إلى الغرفة.");
    });
    return;
  }

  if (event.target.id === "teams-form") {
    event.preventDefault();
    finalizeTeamsAndStartBoard();
    return;
  }

  if (event.target.id === "add-player-form") {
    event.preventDefault();
    handleAddPlayerSubmit(event.target);
    return;
  }

  if (event.target.id === "chat-form") {
    event.preventDefault();
    sendChatFromForm(event.target).catch((error) => {
      showToast(error instanceof Error ? error.message : "تعذر إرسال الرسالة.");
    });
  }
}

async function startFlow() {
  if (!state.categories.length) {
    showToast("ارفع ملف الإكسل أولاً.");
    return;
  }

  if (!roomContext.roomCode) {
    await createAndOpenRoom();
    return;
  }

  if (!roomContext.isHost) {
    showToast("فقط منشئ الغرفة يستطيع بدء المباراة.");
    return;
  }

  const targetSelection = getAutoSelectedCategoryIds(
    state.categories,
    state.sessionUsedQuestionIds
  );

  commit({
    ...state,
    phase: "room-lobby",
    selectedCategoryIds: targetSelection.length ? targetSelection : state.selectedCategoryIds,
  });
}

function toggleCategory(categoryId) {
  const availableCategories = getAvailableCategories(
    state.categories,
    state.sessionUsedQuestionIds
  );
  const availableCategoryIds = new Set(availableCategories.map((category) => category.id));
  if (
    !categoryId ||
    availableCategories.length <= 6 ||
    !availableCategoryIds.has(categoryId)
  ) {
    return;
  }

  const targetCount = Math.min(6, availableCategories.length);
  const selectedSet = new Set(state.selectedCategoryIds);

  if (selectedSet.has(categoryId)) {
    selectedSet.delete(categoryId);
  } else if (selectedSet.size < targetCount) {
    selectedSet.add(categoryId);
  } else {
    showToast("يمكن اختيار 6 تصنيفات فقط.");
    return;
  }

  commit({
    ...state,
    selectedCategoryIds: Array.from(selectedSet),
  });
}

function goToTeamSetup() {
  const availableCategories = getAvailableCategories(
    state.categories,
    state.sessionUsedQuestionIds
  );
  const availableIds = new Set(availableCategories.map((category) => category.id));
  const targetCount = Math.min(6, availableCategories.length);
  const selectedIds =
    availableCategories.length <= 6
      ? availableCategories.map((category) => category.id)
      : state.selectedCategoryIds.filter((categoryId) => availableIds.has(categoryId));

  if (selectedIds.length !== targetCount || targetCount === 0) {
    showToast("أكمل اختيار التصنيفات المطلوبة أولاً.");
    return;
  }

  if (roomContext.roomCode) {
    startRoomMatch(selectedIds);
    return;
  }

  commit({
    ...state,
    phase: "team-setup",
    selectedCategoryIds: selectedIds,
  });
}

function pickTeamColor(teamIndex, color) {
  if (!color) {
    return;
  }

  const nextDraft = state.teamDraft.map((team, index) =>
    index === teamIndex ? { ...team, color } : team
  );

  commit({
    ...state,
    teamDraft: nextDraft,
  });
}

function syncTeamName(teamIndex, value, shouldRender) {
  const nextDraft = state.teamDraft.map((team, index) =>
    index === teamIndex ? { ...team, name: value } : team
  );

  state = {
    ...state,
    teamDraft: nextDraft,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  if (shouldRender) {
    render();
  }
}

function finalizeTeamsAndStartBoard() {
  const cleanedDraft = state.teamDraft.map((team, index) => ({
    name: (team.name || "").trim() || `لاعب ${index + 1}`,
    color: normalizeColorHex(team.color) || TEAM_COLORS[index % TEAM_COLORS.length],
  }));

  const uniqueNames = new Set(cleanedDraft.map((team) => normalizeLooseText(team.name)));
  const uniqueColors = new Set(cleanedDraft.map((team) => normalizeColorHex(team.color)));

  if (uniqueNames.size < cleanedDraft.length) {
    showToast("اختر اسمين مختلفين للاعبين.");
    return;
  }

  if (uniqueColors.size < cleanedDraft.length) {
    showToast("اختر لونين مختلفين للاعبين.");
    return;
  }

  const board = buildBoard(state.selectedCategoryIds);
  if (!countTotalAvailableSlots(board)) {
    showToast("لا توجد أسئلة كافية لبناء لوحة لعب صالحة.");
    return;
  }

  commit({
    ...state,
    phase: "board",
    teamDraft: cleanedDraft,
    teams: cleanedDraft.map((team, index) => createDraftPlayer(team, index)),
    board,
    currentQuestion: null,
    selectedResponderId: "",
    dialog: null,
    lastResult: null,
  });
}

function startRoomMatch(selectedCategoryIds = state.selectedCategoryIds) {
  if (!roomContext.isHost) {
    showToast("فقط منشئ الغرفة يستطيع بدء المباراة.");
    return;
  }

  const players = getRoomPlayers().map((participant) =>
    createPlayerState({
      id: participant.id,
      name: participant.name,
      color: participant.color,
      points: 0,
    })
  );

  if (players.length < 2) {
    showToast("يجب أن ينضم لاعبان على الأقل قبل بدء المباراة.");
    return;
  }

  const board = buildBoard(selectedCategoryIds);
  if (!countTotalAvailableSlots(board)) {
    showToast("لا توجد أسئلة كافية لبناء لوحة لعب صالحة.");
    return;
  }

  commit({
    ...state,
    phase: "board",
    selectedCategoryIds,
    teams: players,
    board,
    currentQuestion: null,
    selectedResponderId: "",
    dialog: null,
    lastResult: null,
  });
}

function buildBoard(selectedCategoryIds) {
  const usedQuestionIdSet = new Set(state.sessionUsedQuestionIds);
  const categories = state.categories.filter((category) =>
    selectedCategoryIds.includes(category.id)
  );

  return categories.map((category) => {
    const slots = {};

    POINT_VALUES.forEach((pointValue) => {
      const availableQuestions = (category.questionsByPoints[String(pointValue)] || []).filter(
        (question) => !usedQuestionIdSet.has(question.id)
      );
      const questionPool = getRandomizedQuestionPool(
        availableQuestions,
        state.fileSignature,
        `${category.id}:${pointValue}`
      );
      slots[pointValue] = createSlot(questionPool.shift() || null, pointValue);
    });

    return {
      categoryId: category.id,
      name: category.name,
      slots,
    };
  });
}

function createSlot(question, pointValue) {
  return {
    id: `slot-${pointValue}-${question?.id || `empty-${pointValue}`}`,
    pointValue,
    used: false,
    unavailable: !question,
    question,
    answeredByPlayerId: "",
    noAnswer: false,
  };
}

function openQuestion(categoryId, pointValue) {
  if (!categoryId || !POINT_VALUES.includes(pointValue)) {
    return;
  }

  const boardCard = state.board.find((card) => card.categoryId === categoryId);
  if (!boardCard) {
    return;
  }

  const slot = boardCard.slots?.[pointValue];
  if (!slot || slot.used || slot.unavailable || !slot.question) {
    return;
  }

  commit({
    ...state,
    phase: "question",
    currentQuestion: {
      categoryId,
      pointValue,
      categoryName: boardCard.name,
      question: slot.question,
      removedOptionKeys: [],
      blockedPlayerIds: getBlockedPlayerIds(state.teams),
    },
    selectedResponderId: "",
    dialog: null,
    lastResult: null,
  });
}

function goToAnswerSelect() {
  if (!state.currentQuestion) {
    return;
  }

  commit({
    ...state,
    phase: "answer-select",
    selectedResponderId: "",
    dialog: null,
  });
}

function selectResponder(playerId) {
  if (!state.currentQuestion) {
    return;
  }

  if (playerId !== "__none__") {
    const player = getPlayerById(playerId);
    if (!player) {
      return;
    }

    if ((state.currentQuestion.blockedPlayerIds || []).includes(playerId)) {
      showToast(`لا يمكن اختيار ${player.name} في هذه الجولة بسبب البلوك.`);
      return;
    }
  }

  commit({
    ...state,
    selectedResponderId: playerId,
  });
}

function confirmResponder() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion || !state.selectedResponderId) {
    showToast("اختر اللاعب الذي أجاب أو اختر لا أحد.");
    return;
  }

  const blockedPlayerIds = currentQuestion.blockedPlayerIds || [];
  const clearedTeams = clearRoundBlocks(state.teams, blockedPlayerIds);
  const updatedSessionUsedQuestionIds = appendSessionQuestionId(
    currentQuestion.question.id,
    state.sessionUsedQuestionIds
  );

  if (state.selectedResponderId === "__none__") {
    commit({
      ...state,
      phase: "answer",
      teams: clearedTeams,
      board: markBoardSlotResolved(state.board, currentQuestion.categoryId, currentQuestion.pointValue, {
        noAnswer: true,
      }),
      currentQuestion: null,
      selectedResponderId: "",
      dialog: null,
      sessionUsedQuestionIds: updatedSessionUsedQuestionIds,
      lastResult: {
        type: "nobody",
        categoryName: currentQuestion.categoryName,
        correctAnswer: currentQuestion.question.answerText,
        scoreDelta: 0,
      },
    });
    return;
  }

  const playerIndex = clearedTeams.findIndex((player) => player.id === state.selectedResponderId);
  if (playerIndex === -1) {
    showToast("تعذر العثور على اللاعب المختار.");
    return;
  }

  const player = clearedTeams[playerIndex];
  const usedDouble = player.abilities.double.pending;
  const scoreDelta = currentQuestion.question.points * (usedDouble ? 2 : 1);
  const updatedTeams = clearedTeams.map((currentPlayer, index) =>
    index === playerIndex
      ? {
          ...currentPlayer,
          points: currentPlayer.points + scoreDelta,
          abilities: {
            ...currentPlayer.abilities,
            double: {
              used: currentPlayer.abilities.double.used || usedDouble,
              pending: false,
            },
          },
        }
      : currentPlayer
  );

  commit({
    ...state,
    phase: "answer",
    teams: updatedTeams,
    board: markBoardSlotResolved(state.board, currentQuestion.categoryId, currentQuestion.pointValue, {
      answeredByPlayerId: player.id,
    }),
    currentQuestion: null,
    selectedResponderId: "",
    dialog: null,
    sessionUsedQuestionIds: updatedSessionUsedQuestionIds,
    lastResult: {
      type: "correct",
      playerId: player.id,
      categoryName: currentQuestion.categoryName,
      correctAnswer: currentQuestion.question.answerText,
      scoreDelta,
      usedDouble,
    },
  });
}

function activateDoubleForPlayer(playerId) {
  if (state.phase !== "board") {
    return;
  }

  const player = getPlayerById(playerId);
  if (!player) {
    return;
  }

  if (player.abilities.double.used && !player.abilities.double.pending) {
    return;
  }

  const updatedTeams = state.teams.map((currentPlayer) =>
    currentPlayer.id === playerId
      ? {
          ...currentPlayer,
          abilities: {
            ...currentPlayer.abilities,
            double: {
              ...currentPlayer.abilities.double,
              pending: !currentPlayer.abilities.double.pending,
            },
          },
        }
      : currentPlayer
  );

  commit({
    ...state,
    teams: updatedTeams,
  });

  showToast(
    player.abilities.double.pending
      ? `تم إلغاء دبل النقاط لـ ${player.name}.`
      : `تم تفعيل دبل النقاط لـ ${player.name}.`
  );
}

function openRemoveTwoPicker() {
  if (!state.currentQuestion) {
    return;
  }

  if (!canUseRemoveTwoInCurrentQuestion()) {
    showToast("لا يمكن استخدام حذف إجابتين في هذا السؤال.");
    return;
  }

  commit({
    ...state,
    dialog: {
      type: "pick-player",
      purpose: "remove-two",
    },
  });
}

function openBlockPicker(actorPlayerId) {
  if (state.phase !== "board") {
    return;
  }

  const actorPlayer = getPlayerById(actorPlayerId);
  if (!actorPlayer || actorPlayer.abilities.block.used) {
    return;
  }

  const eligibleTargets = state.teams.filter(
    (player) => player.id !== actorPlayerId && !player.blockedByPlayerId
  );
  if (!eligibleTargets.length) {
    showToast("لا يوجد لاعب صالح لعمل البلوك عليه الآن.");
    return;
  }

  commit({
    ...state,
    dialog: {
      type: "pick-player",
      purpose: "block",
      actorPlayerId,
    },
  });
}

function handleDialogPlayerPick(playerId) {
  const dialog = state.dialog;
  if (!dialog || dialog.type !== "pick-player" || !playerId) {
    return;
  }

  if (dialog.purpose === "remove-two") {
    applyRemoveTwoForPlayer(playerId);
    return;
  }

  if (dialog.purpose === "block") {
    applyBlock(actorPlayerIdSafe(dialog.actorPlayerId), playerId);
  }
}

function actorPlayerIdSafe(playerId) {
  return typeof playerId === "string" ? playerId : "";
}

function applyRemoveTwoForPlayer(playerId) {
  const nextState = buildRemoveTwoState(state, playerId);
  if (!nextState) {
    return;
  }

  const player = getPlayerById(playerId, nextState.teams);
  commit(nextState);
  showToast(`تم حذف إجابتين لصالح ${player?.name || "اللاعب"}.`);
}

function buildRemoveTwoState(baseState, playerId) {
  const currentQuestion = baseState.currentQuestion;
  if (!currentQuestion) {
    return null;
  }

  const playerIndex = baseState.teams.findIndex((player) => player.id === playerId);
  if (playerIndex === -1) {
    showToast("تعذر العثور على اللاعب.");
    return null;
  }

  const player = baseState.teams[playerIndex];
  if (player.abilities.removeTwo.used) {
    showToast("هذا اللاعب استخدم حذف إجابتين مسبقًا.");
    return null;
  }

  const wrongOptions = currentQuestion.question.options.filter(
    (option) =>
      option.key !== currentQuestion.question.answerKey &&
      !currentQuestion.removedOptionKeys.includes(option.key)
  );
  const removableCount = Math.min(2, Math.max(0, wrongOptions.length - 1));

  if (removableCount <= 0) {
    showToast("لا يمكن استخدام حذف إجابتين في هذا السؤال.");
    return null;
  }

  const removedKeys = shuffleArray(wrongOptions)
    .slice(0, removableCount)
    .map((option) => option.key);
  const updatedTeams = baseState.teams.map((currentPlayer, index) =>
    index === playerIndex
      ? {
          ...currentPlayer,
          abilities: {
            ...currentPlayer.abilities,
            removeTwo: {
              used: true,
            },
          },
        }
      : currentPlayer
  );

  return {
    ...baseState,
    teams: updatedTeams,
    dialog: null,
    currentQuestion: {
      ...currentQuestion,
      removedOptionKeys: Array.from(
        new Set([...currentQuestion.removedOptionKeys, ...removedKeys])
      ),
    },
  };
}

function applyBlock(actorPlayerId, targetPlayerId) {
  if (!actorPlayerId || !targetPlayerId || actorPlayerId === targetPlayerId) {
    return;
  }

  const actorIndex = state.teams.findIndex((player) => player.id === actorPlayerId);
  const targetIndex = state.teams.findIndex((player) => player.id === targetPlayerId);
  if (actorIndex === -1 || targetIndex === -1) {
    return;
  }

  const actorPlayer = state.teams[actorIndex];
  const targetPlayer = state.teams[targetIndex];
  if (actorPlayer.abilities.block.used) {
    return;
  }

  if (targetPlayer.blockedByPlayerId) {
    showToast("هذا اللاعب عليه بلوك بالفعل للجولة القادمة.");
    return;
  }

  const updatedTeams = state.teams.map((player, index) => {
    if (index === actorIndex) {
      return {
        ...player,
        abilities: {
          ...player.abilities,
          block: {
            used: true,
          },
        },
      };
    }

    if (index === targetIndex) {
      return {
        ...player,
        blockedByPlayerId: actorPlayerId,
      };
    }

    return player;
  });

  commit({
    ...state,
    phase: "answer",
    teams: updatedTeams,
    currentQuestion: null,
    selectedResponderId: "",
    dialog: null,
    lastResult: {
      type: "blockNotice",
      actorPlayerId,
      targetPlayerId,
    },
  });
}

function openAddPlayer(purpose) {
  if (roomContext.roomCode) {
    showToast("إضافة اللاعبين تكون عبر الغرفة قبل بدء المباراة.");
    return;
  }

  commit({
    ...state,
    dialog: {
      type: "add-player",
      purpose,
    },
  });
}

function closeDialog() {
  commit({
    ...state,
    dialog: null,
  });
}

function handleAddPlayerSubmit(formElement) {
  if (roomContext.roomCode) {
    showToast("إضافة اللاعبين تكون عبر الغرفة.");
    return;
  }

  const formData = new FormData(formElement);
  const purpose = String(formData.get("purpose") || "").trim();
  const name = String(formData.get("player_name") || "").trim();
  const color = normalizeColorHex(String(formData.get("player_color") || ""));

  if (!name) {
    showToast("اكتب اسم اللاعب.");
    return;
  }

  if (!color) {
    showToast("اختر لونًا صالحًا للاعب.");
    return;
  }

  if (state.teams.some((player) => normalizeLooseText(player.name) === normalizeLooseText(name))) {
    showToast("اسم اللاعب مستخدم بالفعل.");
    return;
  }

  if (state.teams.some((player) => normalizeColorHex(player.color) === color)) {
    showToast("اختر لونًا مختلفًا عن ألوان اللاعبين الحاليين.");
    return;
  }

  const newPlayer = createPlayerState({
    id: createRuntimePlayerId(),
    name,
    color,
  });
  const nextTeams = [...state.teams, newPlayer];

  if (purpose === "remove-two") {
    const nextState = buildRemoveTwoState(
      {
        ...state,
        teams: nextTeams,
        dialog: null,
      },
      newPlayer.id
    );
    if (!nextState) {
      return;
    }

    commit(nextState);
    showToast(`تمت إضافة ${newPlayer.name} واستخدام حذف إجابتين له.`);
    return;
  }

  if (purpose === "answer-select") {
    commit({
      ...state,
      teams: nextTeams,
      dialog: null,
      selectedResponderId: newPlayer.id,
    });
    showToast(`تمت إضافة ${newPlayer.name}.`);
    return;
  }

  commit({
    ...state,
    teams: nextTeams,
    dialog: null,
  });
  showToast(`تمت إضافة ${newPlayer.name}.`);
}

function moveAfterAnswer() {
  if (!state.lastResult) {
    return;
  }

  const nextPhase =
    state.lastResult.type === "blockNotice"
      ? "board"
      : isBoardFinished(state.board)
        ? "winner"
        : "board";

  commit({
    ...state,
    phase: nextPhase,
    currentQuestion: null,
    selectedResponderId: "",
    dialog: null,
    lastResult: null,
  });
}

function restartWithSameFile() {
  if (!state.categories.length) {
    resetAllState();
    return;
  }

  const resetSelection = getAutoSelectedCategoryIds(
    state.categories,
    state.sessionUsedQuestionIds
  );

  commit({
    ...createInitialState(),
    fileName: state.fileName,
    fileSignature: state.fileSignature,
    categories: state.categories,
    selectedCategoryIds: resetSelection,
    upload: {
      ...createInitialUploadState(),
      completed: true,
      progress: 100,
      status: "الملف جاهز. ابدأ مباراة جديدة.",
      categoryCount: state.categories.length,
      questionCount: countQuestionsInCategories(state.categories),
    },
    sessionUsedQuestionIds: state.sessionUsedQuestionIds,
    phase: "category-select",
  });
}

async function createAndOpenRoom() {
  const roomCode = generateRoomCode();
  roomContext.roomCode = roomCode;
  roomContext.roomUrl = buildRoomUrl(roomCode);
  roomContext.hostClientId = roomContext.clientId;
  roomContext.roomExists = true;
  roomContext.pendingColor = getNextAvailableColor([]);
  setRoomCodeInUrl(roomCode);

  await createRoom(roomCode, roomContext.clientId, {
    ...state,
    phase: "room-lobby",
  });

  subscribeCurrentRoom();
  commit(
    {
      ...state,
      phase: "room-join",
    },
    { sync: false }
  );
}

function subscribeCurrentRoom() {
  if (!roomContext.roomCode) {
    return;
  }

  if (roomContext.unsubscribeRoom) {
    roomContext.unsubscribeRoom();
  }

  roomContext.unsubscribeRoom = subscribeToRoom(roomContext.roomCode, handleRoomSnapshot);
}

function handleRoomSnapshot(roomData) {
  roomContext.roomExists = Boolean(roomData);
  roomContext.hostClientId = roomData?.meta?.hostClientId || roomContext.hostClientId;
  roomContext.isHost = roomContext.hostClientId === roomContext.clientId;
  roomContext.participants = normalizeParticipants(roomData?.participants);
  roomContext.chatMessages = normalizeChatMessages(roomData?.chat);
  roomContext.joinedParticipant =
    roomContext.participants.find((participant) => participant.id === roomContext.clientId) || null;
  roomContext.pendingColor = getNextAvailableColor(getRoomPlayers());

  const remoteSharedState = roomData?.sharedState;
  if (remoteSharedState?.game) {
    const remoteRevision = Number(remoteSharedState.revision) || 0;
    const ownUpdate =
      roomContext.isHost && remoteSharedState.updatedBy === roomContext.clientId;

    if (ownUpdate) {
      roomContext.lastSyncedRevision = remoteRevision;
    } else if (remoteRevision >= roomContext.lastSyncedRevision) {
      roomContext.lastSyncedRevision = remoteRevision;
      state = hydrateRemoteState(remoteSharedState.game);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } else if (roomContext.roomCode) {
    state = {
      ...createInitialState(),
      phase: "room-join",
    };
  }

  if (!roomContext.roomExists) {
    state = {
      ...createInitialState(),
      phase: "room-join",
    };
  }

  render();
}

function hydrateRemoteState(remoteGameState) {
  const teamDraft =
    Array.isArray(remoteGameState?.teamDraft) && remoteGameState.teamDraft.length
      ? remoteGameState.teamDraft
      : createInitialTeamDraft();

  return {
    ...createInitialState(),
    ...(remoteGameState || {}),
    teamDraft,
    teams: normalizeStoredTeams(remoteGameState?.teams, teamDraft),
    currentQuestion: normalizeCurrentQuestion(remoteGameState?.currentQuestion),
    sessionUsedQuestionIds: Array.isArray(remoteGameState?.sessionUsedQuestionIds)
      ? remoteGameState.sessionUsedQuestionIds
      : [],
    upload: {
      ...createInitialUploadState(),
      ...(remoteGameState?.upload || {}),
    },
  };
}

async function queueRoomStateSync(nextState) {
  if (!roomContext.roomCode || !roomContext.isHost || !roomContext.roomExists) {
    return;
  }

  const nextRevision = roomContext.lastSyncedRevision + 1;
  roomContext.lastSyncedRevision = nextRevision;

  try {
    await writeSharedGameState(roomContext.roomCode, {
      game: nextState,
      revision: nextRevision,
      updatedBy: roomContext.clientId,
      updatedAt: Date.now(),
    });
  } catch (error) {
    showToast(error instanceof Error ? error.message : "تعذر مزامنة حالة الغرفة.");
  }
}

async function joinCurrentRoom(formElement) {
  if (!roomContext.roomCode) {
    throw new Error("لا يوجد رمز غرفة صالح.");
  }

  if (!roomContext.roomExists) {
    throw new Error("هذه الغرفة غير موجودة حاليًا.");
  }

  const formData = new FormData(formElement);
  const name = String(formData.get("join_name") || "").trim();
  const requestedRole = String(formData.get("join_role") || "player");
  const requestedColor = normalizeColorHex(String(formData.get("join_color") || ""));

  if (!name) {
    throw new Error("اكتب اسمك أولًا.");
  }

  const finalParticipant = await upsertParticipant(roomContext.roomCode, {
    id: roomContext.clientId,
    name,
    role: requestedRole === "spectator" ? "spectator" : "player",
    color: requestedColor,
    isHost: roomContext.isHost,
  });

  roomContext.pendingName = finalParticipant.name;
  roomContext.pendingRole = finalParticipant.role;
  roomContext.pendingColor = finalParticipant.color || roomContext.pendingColor;

  await sendRoomMessage(roomContext.roomCode, {
    senderId: roomContext.clientId,
    name: "النظام",
    kind: "system",
    text: `${finalParticipant.name} انضم إلى الغرفة كـ ${
      finalParticipant.role === "player" ? "لاعب" : "متفرج"
    }.`,
  });

  roomContext.joinedParticipant = finalParticipant;

  if (roomContext.isHost) {
    commit(
      {
        ...state,
        phase: "room-lobby",
      },
      { sync: false }
    );
    return;
  }

  render();
}

function goToRoomLobbyCategories() {
  if (!roomContext.isHost) {
    showToast("فقط منشئ الغرفة يستطيع الانتقال إلى إعداد المباراة.");
    return;
  }

  const targetSelection = getAutoSelectedCategoryIds(
    state.categories,
    state.sessionUsedQuestionIds
  );

  commit({
    ...state,
    phase: "category-select",
    selectedCategoryIds: targetSelection.length ? targetSelection : state.selectedCategoryIds,
  });
}

async function sendChatFromForm(formElement) {
  const input = formElement.querySelector('input[name="chat_message"]');
  const text = (input?.value || "").trim();

  if (!text || !roomContext.roomCode || !roomContext.joinedParticipant) {
    return;
  }

  await sendRoomMessage(roomContext.roomCode, {
    senderId: roomContext.clientId,
    name: roomContext.joinedParticipant.name,
    kind: "user",
    text,
  });

  input.value = "";
}

async function sendRulesMessage() {
  if (!roomContext.roomCode || !roomContext.isHost) {
    return;
  }

  await sendRoomMessage(roomContext.roomCode, {
    senderId: roomContext.clientId,
    name: "القوانين",
    kind: "system",
    text: ROOM_RULES_TEXT,
  });
}

function copyCurrentRoomLink() {
  if (!roomContext.roomUrl) {
    return;
  }

  navigator.clipboard
    ?.writeText(roomContext.roomUrl)
    .then(() => {
      showToast("تم نسخ رابط الغرفة.");
    })
    .catch(() => {
      showToast(roomContext.roomUrl);
    });
}

function normalizeParticipants(participantsMap) {
  return Object.values(participantsMap || {})
    .filter(Boolean)
    .sort((left, right) => (left.joinedAt || 0) - (right.joinedAt || 0));
}

function normalizeChatMessages(chatMap) {
  return Object.values(chatMap || {})
    .filter(Boolean)
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
}

function getRoomPlayers() {
  return roomContext.participants.filter((participant) => participant.role === "player");
}

function getRoomSpectators() {
  return roomContext.participants.filter((participant) => participant.role !== "player");
}

function getOrCreateClientId() {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }

  const clientId = `client-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  localStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

function getRoomCodeFromUrl() {
  try {
    const url = new URL(window.location.href);
    return String(url.searchParams.get("room") || "")
      .trim()
      .toUpperCase();
  } catch {
    return "";
  }
}

function setRoomCodeInUrl(roomCode) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomCode);
  window.history.replaceState({}, "", url.toString());
}

function clearRoomCodeFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState({}, "", url.toString());
}

function generateRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function markBoardSlotResolved(board, categoryId, pointValue, resolution = {}) {
  return board.map((card) => {
    if (card.categoryId !== categoryId) {
      return card;
    }

    return {
      ...card,
      slots: {
        ...card.slots,
        [pointValue]: {
          ...card.slots[pointValue],
          used: true,
          answeredByPlayerId: resolution.answeredByPlayerId || "",
          noAnswer: Boolean(resolution.noAnswer),
        },
      },
    };
  });
}

async function handleFileSelection(file) {
  commit({
    ...createInitialState(),
    fileName: file.name,
    upload: {
      ...createInitialUploadState(),
      loading: true,
      progress: 4,
      status: "جارٍ رفع الملف...",
    },
  });

  try {
    const arrayBuffer = await readFileAsArrayBuffer(file, (fraction) => {
      const progress = Math.max(5, Math.min(68, Math.round(fraction * 68)));
      commit({
        ...state,
        upload: {
          ...state.upload,
          progress,
          status: "جارٍ قراءة الملف...",
        },
      });
    });

    commit({
      ...state,
      upload: {
        ...state.upload,
        progress: 78,
        status: "جارٍ تحليل بيانات الإكسل...",
      },
    });

    const fileSignature = computeFileSignature(arrayBuffer, file.name);
    const { categories, questionCount } = parseWorkbook(arrayBuffer);
    const selectedCategoryIds =
      categories.length <= 6 ? categories.map((category) => category.id) : [];

    commit({
      ...state,
      fileSignature,
      categories,
      selectedCategoryIds,
      upload: {
        ...state.upload,
        loading: false,
        completed: true,
        progress: 100,
        categoryCount: categories.length,
        questionCount,
        status: "اكتمل التحميل. يمكنك الآن بدء اللعبة.",
        error: "",
      },
    });
  } catch (error) {
    commit({
      ...state,
      categories: [],
      selectedCategoryIds: [],
      upload: {
        ...state.upload,
        loading: false,
        completed: false,
        progress: 0,
        categoryCount: 0,
        questionCount: 0,
        error:
          error instanceof Error
            ? error.message
            : "تعذر قراءة الملف. تأكد من تنسيق الأعمدة.",
        status: "فشل تحميل الملف",
      },
    });
  }
}

function readFileAsArrayBuffer(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("تعذر فتح الملف من المتصفح."));
    reader.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(event.loaded / event.total);
      }
    };
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

function parseWorkbook(arrayBuffer) {
  if (!window.XLSX) {
    throw new Error("مكتبة قراءة الإكسل غير جاهزة.");
  }

  const workbook = window.XLSX.read(arrayBuffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("الملف لا يحتوي على ورقة عمل.");
  }

  const firstSheet = workbook.Sheets[firstSheetName];
  const rows = window.XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  const headerRowIndex = rows.findIndex((row) =>
    row.some((cell) => normalizeHeader(cell))
  );

  if (headerRowIndex === -1) {
    throw new Error("تعذر العثور على صف العناوين داخل الملف.");
  }

  const headers = rows[headerRowIndex].map(normalizeHeader);
  const columnMap = resolveColumnMap(headers);

  if (
    columnMap.category === -1 ||
    columnMap.question === -1 ||
    columnMap.answer === -1 ||
    columnMap.points === -1
  ) {
    throw new Error(
      "الأعمدة الأساسية غير مكتملة. تأكد من وجود التصنيف، السؤال، الإجابة الصحيحة، والنقاط."
    );
  }

  const categoriesMap = new Map();
  let questionCount = 0;

  rows.slice(headerRowIndex + 1).forEach((row, rowIndex) => {
    const categoryName = String(row[columnMap.category] || "").trim();
    const questionText = String(row[columnMap.question] || "").trim();
    const rawAnswer = row[columnMap.answer];
    const pointValue = parsePointValue(row[columnMap.points]);

    if (!categoryName || !questionText || !POINT_VALUES.includes(pointValue)) {
      return;
    }

    const options = extractOptions(row, columnMap);
    if (options.length < 2) {
      return;
    }

    const resolvedAnswer = resolveAnswer(rawAnswer, options);
    if (!resolvedAnswer) {
      return;
    }

    const categoryKey = normalizeLooseText(categoryName);
    if (!categoriesMap.has(categoryKey)) {
      categoriesMap.set(categoryKey, {
        id: `cat-${slugify(categoryName)}-${categoriesMap.size + 1}`,
        name: categoryName,
        questionsByPoints: {
          200: [],
          400: [],
          600: [],
        },
      });
    }

    const category = categoriesMap.get(categoryKey);
    const question = {
      id: `q-${category.id}-${pointValue}-${rowIndex + 1}`,
      categoryId: category.id,
      categoryName,
      text: questionText,
      options,
      answerKey: resolvedAnswer.key,
      answerText: resolvedAnswer.text,
      points: pointValue,
    };

    category.questionsByPoints[String(pointValue)].push(question);
    questionCount += 1;
  });

  const categories = Array.from(categoriesMap.values()).filter((category) =>
    POINT_VALUES.some(
      (pointValue) => (category.questionsByPoints[String(pointValue)] || []).length > 0
    )
  );

  if (!categories.length) {
    throw new Error("لم أجد أسئلة صالحة داخل الملف بعد التحليل.");
  }

  return { categories, questionCount };
}

function resolveColumnMap(headers) {
  return {
    category: findHeaderIndex(headers, ["التصنيف", "الفئه", "الفئة", "القسم", "الفصل"]),
    question: findHeaderIndex(headers, ["السوال", "السؤال", "سوال"]),
    optionsCombined: findHeaderIndex(headers, [
      "الخيارات",
      "الخياراتابجد",
      "خيارات",
      "خياراتابجد",
      "options",
    ]),
    answer: findHeaderIndex(headers, [
      "الاجابهالصحيحه",
      "الإجابةالصحيحة",
      "الاجابةالصحيحة",
      "الجواب",
      "correctanswer",
    ]),
    points: findHeaderIndex(headers, [
      "النقاط",
      "الدرجات",
      "القيمه",
      "القيمة",
      "points",
    ]),
    optionA: findHeaderIndex(headers, ["ا", "أ", "a"]),
    optionB: findHeaderIndex(headers, ["ب", "b"]),
    optionC: findHeaderIndex(headers, ["ج", "c"]),
    optionD: findHeaderIndex(headers, ["د", "d"]),
  };
}

function extractOptions(row, columnMap) {
  const separateOptions = OPTION_KEYS.map((key) => {
    const column =
      key === "A"
        ? columnMap.optionA
        : key === "B"
          ? columnMap.optionB
          : key === "C"
            ? columnMap.optionC
            : columnMap.optionD;

    if (column === -1) {
      return null;
    }

    const label = String(row[column] || "").trim();
    return label ? { key, label } : null;
  }).filter(Boolean);

  if (separateOptions.length >= 2) {
    return separateOptions;
  }

  if (columnMap.optionsCombined === -1) {
    return [];
  }

  return parseCombinedOptions(row[columnMap.optionsCombined]);
}

function parseCombinedOptions(value) {
  const raw = String(value || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) {
    return [];
  }

  const matches = Array.from(
    raw.matchAll(/(?:^|[\s،,;])(?:\(|\[)?\s*([A-Da-dأابجد])\s*(?:\)|\]|\.)\s*[:\-]?\s*/g)
  );

  if (matches.length >= 2) {
    return matches
      .map((match, index) => {
        const key = normalizeOptionKey(match[1]);
        const start = match.index + match[0].length;
        const end = index < matches.length - 1 ? matches[index + 1].index : raw.length;
        const label = raw
          .slice(start, end)
          .trim()
          .replace(/^[\s،,:\-]+|[\s،,]+$/g, "");

        return key && label ? { key, label } : null;
      })
      .filter(Boolean);
  }

  return raw
    .split(/[|،;\n]/)
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((label, index) => ({
      key: OPTION_KEYS[index],
      label,
    }));
}

function resolveAnswer(rawAnswer, options) {
  const answerText = String(rawAnswer || "").trim();
  if (!answerText) {
    return null;
  }

  const markerMatch = answerText.match(
    /^\s*(?:\(|\[)?\s*([A-Da-dأابجد])\s*(?:\)|\])?/
  );
  if (markerMatch) {
    const key = normalizeOptionKey(markerMatch[1]);
    const found = options.find((option) => option.key === key);
    if (found) {
      return { key: found.key, text: found.label };
    }
  }

  const normalizedAnswer = normalizeLooseText(answerText);
  const byLabel = options.find((option) => {
    const normalizedOption = normalizeLooseText(option.label);
    return (
      normalizedOption === normalizedAnswer ||
      normalizedAnswer.includes(normalizedOption) ||
      normalizedOption.includes(normalizedAnswer)
    );
  });

  return byLabel ? { key: byLabel.key, text: byLabel.label } : null;
}

function parsePointValue(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return Number(digits || 0);
}

function findHeaderIndex(headers, aliases) {
  const normalizedAliases = aliases.map((alias) => normalizeHeader(alias));
  return headers.findIndex((header) => normalizedAliases.includes(header));
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\u200e\u200f]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, "")
    .replace(/[(){}\[\]\-_:،,؛./\\]/g, "");
}

function normalizeLooseText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\u200e\u200f]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .replace(/[(){}\[\]\-_:،,؛./\\]/g, "")
    .trim();
}

function normalizeOptionKey(value) {
  const token = String(value || "").trim().toUpperCase();
  if (token === "A" || token === "أ" || token === "ا") return "A";
  if (token === "B" || token === "ب") return "B";
  if (token === "C" || token === "ج") return "C";
  if (token === "D" || token === "د") return "D";
  return "";
}

function slugify(value) {
  return normalizeLooseText(value)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u0600-\u06ff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "category";
}

function countQuestionsInCategories(categories) {
  return categories.reduce(
    (total, category) => total + countCategoryQuestions(category),
    0
  );
}

function countCategoryQuestions(category, usedQuestionIds = []) {
  const usedQuestionIdSet =
    usedQuestionIds instanceof Set ? usedQuestionIds : new Set(usedQuestionIds);
  return POINT_VALUES.reduce(
    (total, pointValue) =>
      total +
      (category.questionsByPoints[String(pointValue)] || []).filter(
        (question) => !usedQuestionIdSet.has(question.id)
      ).length,
    0
  );
}

function estimateCategoryGameSlots(category, usedQuestionIds = []) {
  const usedQuestionIdSet =
    usedQuestionIds instanceof Set ? usedQuestionIds : new Set(usedQuestionIds);
  return POINT_VALUES.reduce((total, pointValue) => {
    const count = (category.questionsByPoints[String(pointValue)] || []).filter(
      (question) => !usedQuestionIdSet.has(question.id)
    ).length;
    return total + Math.min(1, count);
  }, 0);
}

function estimateGameSlotCapacity(categories) {
  return (categories || []).reduce(
    (total, category) => total + estimateCategoryGameSlots(category),
    0
  );
}

function getAvailableCategories(categories = state.categories, usedQuestionIds = []) {
  return (categories || []).filter(
    (category) => estimateCategoryGameSlots(category, usedQuestionIds) > 0
  );
}

function getAutoSelectedCategoryIds(categories = state.categories, usedQuestionIds = []) {
  const availableCategories = getAvailableCategories(categories, usedQuestionIds);
  return availableCategories.length <= 6
    ? availableCategories.map((category) => category.id)
    : [];
}

function getSelectedCategories() {
  const selectedSet = new Set(state.selectedCategoryIds);
  return state.categories.filter((category) => selectedSet.has(category.id));
}

function countRemainingSlots(board) {
  return flattenBoardSlots(board).filter((slot) => !slot.used && !slot.unavailable).length;
}

function countTotalAvailableSlots(board) {
  return flattenBoardSlots(board).filter((slot) => !slot.unavailable).length;
}

function countCardRemainingSlots(card) {
  return flattenBoardSlots([card]).filter((slot) => !slot.used && !slot.unavailable).length;
}

function countCardAvailableQuestions(card) {
  return flattenBoardSlots([card]).filter((slot) => !slot.unavailable).length;
}

function flattenBoardSlots(board) {
  return (board || []).flatMap((card) =>
    POINT_VALUES.map((pointValue) => card.slots?.[pointValue]).filter(Boolean)
  );
}

function appendSessionQuestionId(questionId, sessionUsedQuestionIds = []) {
  const nextIds = new Set(sessionUsedQuestionIds);
  if (questionId) {
    nextIds.add(questionId);
  }
  return Array.from(nextIds);
}

function downloadExcelTemplate() {
  if (!window.XLSX) {
    showToast("مكتبة الإكسل غير جاهزة حاليًا.");
    return;
  }

  const questionRows = [
    ["التصنيف", "السؤال", "الخيارات (أ، ب، ج، د)", "الإجابة الصحيحة", "النقاط"],
    [
      "معلومات عامة",
      "ما هي عاصمة المملكة العربية السعودية؟",
      "(أ) جدة (ب) الرياض (ج) مكة (د) الدمام",
      "(ب) الرياض",
      200,
    ],
    [
      "معلومات عامة",
      "كم عدد قارات العالم؟",
      "(أ) 5 (ب) 6 (ج) 7 (د) 8",
      "(ج) 7",
      400,
    ],
    [
      "معلومات عامة",
      "ما أسرع حيوان بري؟",
      "(أ) الفهد (ب) الأسد (ج) الحصان (د) الذئب",
      "(أ) الفهد",
      600,
    ],
    [
      "علوم",
      "ما الكوكب المعروف بالكوكب الأحمر؟",
      "(أ) الأرض (ب) المريخ (ج) زحل (د) نبتون",
      "(ب) المريخ",
      200,
    ],
    [
      "علوم",
      "كم عدد الكواكب في المجموعة الشمسية؟",
      "(أ) 7 (ب) 8 (ج) 9 (د) 10",
      "(ب) 8",
      400,
    ],
    [
      "علوم",
      "ما العنصر الذي يرمز له بالرمز O؟",
      "(أ) الذهب (ب) الأكسجين (ج) الحديد (د) الهيدروجين",
      "(ب) الأكسجين",
      600,
    ],
  ];

  const guideRows = [
    ["ملاحظات الاستخدام"],
    ["1. استخدم الصف الأول للعناوين كما هو تمامًا."],
    ["2. القيم المعتمدة للنقاط هي: 200 أو 400 أو 600."],
    ["3. اكتب الخيارات داخل خلية واحدة بنفس النمط: (أ) ... (ب) ... (ج) ... (د) ..."],
    ["4. اكتب الإجابة الصحيحة بصيغة مشابهة: (ب) الرياض أو اسم الإجابة نفسها."],
    ["5. يفضّل توفير أكثر من سؤال لكل قيمة داخل كل تصنيف لزيادة التنوع بين الجلسات."],
    ["6. يمكنك حذف صفوف الأمثلة واستبدالها بأسئلتك الخاصة."],
  ];

  const workbook = window.XLSX.utils.book_new();
  const questionsSheet = window.XLSX.utils.aoa_to_sheet(questionRows);
  const guideSheet = window.XLSX.utils.aoa_to_sheet(guideRows);

  questionsSheet["!cols"] = [
    { wch: 22 },
    { wch: 44 },
    { wch: 44 },
    { wch: 26 },
    { wch: 12 },
  ];

  guideSheet["!cols"] = [{ wch: 90 }];

  window.XLSX.utils.book_append_sheet(workbook, questionsSheet, "الأسئلة");
  window.XLSX.utils.book_append_sheet(workbook, guideSheet, "شرح");
  window.XLSX.writeFile(workbook, "نموذج-أسئلة-اللعبة.xlsx");
  showToast("تم تنزيل نموذج الإكسل.");
}

function isBoardFinished(board) {
  const availableSlots = flattenBoardSlots(board).filter((slot) => !slot.unavailable);
  return availableSlots.length > 0 && availableSlots.every((slot) => slot.used);
}

function canUseRemoveTwoInCurrentQuestion() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion) {
    return false;
  }

  const removablePlayers = state.teams.filter((player) => !player.abilities.removeTwo.used);
  if (!removablePlayers.length) {
    return false;
  }

  const wrongOptions = currentQuestion.question.options.filter(
    (option) =>
      option.key !== currentQuestion.question.answerKey &&
      !currentQuestion.removedOptionKeys.includes(option.key)
  );

  return Math.min(2, Math.max(0, wrongOptions.length - 1)) > 0;
}

function getBlockedPlayerIds(players) {
  return (players || [])
    .filter((player) => player.blockedByPlayerId)
    .map((player) => player.id);
}

function clearRoundBlocks(players, blockedPlayerIds = []) {
  const blockedIdSet = new Set(blockedPlayerIds);
  return players.map((player) =>
    blockedIdSet.has(player.id)
      ? {
          ...player,
          blockedByPlayerId: null,
        }
      : player
  );
}

function getPlayerById(playerId, players = state.teams) {
  return (players || []).find((player) => player.id === playerId) || null;
}

function getPlayerName(playerId, players = state.teams) {
  return getPlayerById(playerId, players)?.name || "";
}

function createRuntimePlayerId() {
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getNextAvailableColor(players = state.teams) {
  const usedColors = new Set(players.map((player) => normalizeColorHex(player.color)));
  const nextPaletteColor = TEAM_COLORS.find(
    (color) => !usedColors.has(normalizeColorHex(color))
  );
  if (nextPaletteColor) {
    return nextPaletteColor;
  }

  return hslToHex((players.length * 43) % 360, 82, 58);
}

function normalizeColorHex(color) {
  const value = String(color || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) {
    return value;
  }

  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }

  return "";
}

function hslToHex(h, s, l) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const saturation = Math.max(0, Math.min(100, Number(s))) / 100;
  const lightness = Math.max(0, Math.min(100, Number(l))) / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const toHex = (value) =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getContrastTextColor(color) {
  const normalized = normalizeColorHex(color);
  if (!normalized) {
    return "#ffffff";
  }

  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;

  return luminance > 160 ? "#112033" : "#ffffff";
}

function displayOptionKey(value) {
  return value === "A"
    ? "أ"
    : value === "B"
      ? "ب"
      : value === "C"
        ? "ج"
        : "د";
}

function formatNumber(value) {
  return new Intl.NumberFormat("ar-EG").format(Number(value || 0));
}

function formatSignedNumber(value) {
  return new Intl.NumberFormat("ar-EG", {
    signDisplay: "exceptZero",
  }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function shuffleArray(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = getRandomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function getRandomInt(max) {
  if (max <= 0) {
    return 0;
  }

  if (
    typeof window !== "undefined" &&
    window.crypto &&
    typeof window.crypto.getRandomValues === "function"
  ) {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    return values[0] % max;
  }

  return Math.floor(Math.random() * max);
}

function getRandomizedQuestionPool(questions, fileSignature, bucketKey) {
  const shuffled = shuffleArray(questions);

  if (!fileSignature || !shuffled.length) {
    return shuffled;
  }

  const fileMemory = shuffleMemory[fileSignature] || {};
  const lastFirstQuestionId = fileMemory[bucketKey];

  if (shuffled.length > 1 && lastFirstQuestionId && shuffled[0].id === lastFirstQuestionId) {
    shuffled.push(shuffled.shift());
  }

  shuffleMemory = {
    ...shuffleMemory,
    [fileSignature]: {
      ...fileMemory,
      [bucketKey]: shuffled[0]?.id || "",
    },
  };
  persistShuffleMemory();

  return shuffled;
}

function computeFileSignature(arrayBuffer, fileName = "") {
  const bytes = new Uint8Array(arrayBuffer);
  let hash = 2166136261;

  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }

  for (let index = 0; index < fileName.length; index += 1) {
    hash ^= fileName.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `file-${(hash >>> 0).toString(16)}-${bytes.length}`;
}

async function shareCurrentView() {
  const shareRoot = appElement.querySelector("[data-share-root]");
  if (!shareRoot || !window.html2canvas) {
    showToast("تعذر تجهيز الصورة للمشاركة.");
    return;
  }

  const isBoardView =
    shareRoot.classList.contains("board-canvas") || state.phase === "board";
  const shareWidth = isBoardView ? DESKTOP_SHARE_WIDTH : 980;
  const shareHeight = measureShareContentHeight(shareRoot, shareWidth);
  const hiddenElements = Array.from(shareRoot.querySelectorAll(".no-capture"));
  const previousVisibility = hiddenElements.map((element) => element.style.visibility);

  try {
    hiddenElements.forEach((element) => {
      element.style.visibility = "hidden";
    });

    const canvas = await window.html2canvas(shareRoot, {
      backgroundColor: null,
      scale: 1.35,
      useCORS: true,
      width: shareWidth,
      windowWidth: shareWidth,
      height: shareHeight,
      windowHeight: shareHeight,
      scrollX: 0,
      scrollY: 0,
      onclone(clonedDocument) {
        const clonedShareRoot = clonedDocument.querySelector("[data-share-root]");
        if (!clonedShareRoot) {
          return;
        }

        clonedDocument.body.dataset.captureMode = "desktop";
        const clonedBody = clonedDocument.body;
        const clonedRoot = clonedDocument.documentElement;
        clonedRoot.style.width = `${shareWidth}px`;
        clonedBody.style.width = `${shareWidth}px`;
        clonedBody.style.minHeight = `${shareHeight}px`;
        clonedBody.style.overflow = "visible";
        clonedBody.style.background = "transparent";
        clonedShareRoot.style.width = `${shareWidth}px`;
        clonedShareRoot.style.maxWidth = `${shareWidth}px`;
        clonedShareRoot.style.minWidth = `${shareWidth}px`;
        clonedShareRoot.style.margin = "0 auto";
        clonedShareRoot.style.background = "transparent";

        Array.from(clonedShareRoot.querySelectorAll(".no-capture")).forEach((element) => {
          element.style.visibility = "hidden";
        });
      },
    });

    const trimmedCanvas = trimTransparentCanvas(canvas);
    const blob = await new Promise((resolve) => trimmedCanvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("تعذر تحويل الصفحة إلى صورة.");
    }

    const file = new File([blob], `quiz-${state.phase}.png`, { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
      });
      showToast("تم فتح لوحة المشاركة.");
      return;
    }

    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `quiz-${state.phase}.png`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
    showToast("تم تنزيل الصورة لأن المشاركة المباشرة غير مدعومة هنا.");
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : "تعذر إنشاء صورة المشاركة."
    );
  } finally {
    hiddenElements.forEach((element, index) => {
      element.style.visibility = previousVisibility[index];
    });
  }
}

function trimTransparentCanvas(sourceCanvas) {
  const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return sourceCanvas;
  }

  const { width, height } = sourceCanvas;
  const imageData = context.getImageData(0, 0, width, height).data;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = imageData[(y * width + x) * 4 + 3];
      if (alpha <= 8) {
        continue;
      }

      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right === -1 || bottom === -1) {
    return sourceCanvas;
  }

  const padding = 8;
  const cropLeft = Math.max(0, left - padding);
  const cropTop = Math.max(0, top - padding);
  const cropRight = Math.min(width - 1, right + padding);
  const cropBottom = Math.min(height - 1, bottom + padding);
  const cropWidth = cropRight - cropLeft + 1;
  const cropHeight = cropBottom - cropTop + 1;

  const trimmedCanvas = document.createElement("canvas");
  trimmedCanvas.width = cropWidth;
  trimmedCanvas.height = cropHeight;
  const trimmedContext = trimmedCanvas.getContext("2d");
  if (!trimmedContext) {
    return sourceCanvas;
  }

  trimmedContext.drawImage(
    sourceCanvas,
    cropLeft,
    cropTop,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return trimmedCanvas;
}

function measureShareContentHeight(shareRoot, shareWidth) {
  const sandbox = document.createElement("div");
  sandbox.setAttribute("aria-hidden", "true");
  sandbox.style.position = "fixed";
  sandbox.style.left = "-20000px";
  sandbox.style.top = "0";
  sandbox.style.width = `${shareWidth}px`;
  sandbox.style.pointerEvents = "none";
  sandbox.style.opacity = "0";
  sandbox.style.zIndex = "-1";

  const clone = shareRoot.cloneNode(true);
  clone.style.width = `${shareWidth}px`;
  clone.style.maxWidth = `${shareWidth}px`;
  clone.style.minWidth = `${shareWidth}px`;
  clone.style.margin = "0 auto";

  Array.from(clone.querySelectorAll(".no-capture")).forEach((element) => {
    element.style.display = "none";
  });

  sandbox.appendChild(clone);
  document.body.appendChild(sandbox);

  const rootRect = clone.getBoundingClientRect();
  let maxBottom = 0;

  [clone, ...clone.querySelectorAll("*")].forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    maxBottom = Math.max(maxBottom, rect.bottom - rootRect.top);
  });

  const intrinsicHeight = Math.max(
    clone.scrollHeight || 0,
    clone.offsetHeight || 0,
    clone.clientHeight || 0
  );

  sandbox.remove();
  return Math.ceil(Math.max(360, intrinsicHeight, maxBottom + 40));
}

function showToast(message) {
  toastElement.hidden = false;
  toastElement.textContent = message;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
  }, 2600);
}
