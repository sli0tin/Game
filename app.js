import {
  ANSWER_TIME_MS,
  ANSWER_TIME_SECONDS,
  APP_NAME,
  BOARD_VALUES,
  CHAT_MESSAGE_LIMIT,
  COLOR_PALETTE,
  MAX_LOADING_MS,
  MAX_PLAYERS,
  MIN_LOADING_MS,
  MIN_PLAYERS,
  PLAYER_AVATARS,
  REQUIRED_CATEGORY_COUNT,
  RESULT_STAGE_MS,
  SHARE_BASE_URL,
  STORAGE_KEYS,
} from './config.js';
import {
  authReady,
  db,
  get,
  onDisconnect,
  onValue,
  ref,
  remove,
  set,
  update,
} from './firebase.js';
import { parseQuestionsFile } from './excel-parser.js';
import {
  buildBankPayload,
  copyText,
  escapeHtml,
  formatPoints,
  getNextTurnPlayerId,
  getStoredJSON,
  getStoredString,
  normalizeBankSnapshot,
  normalizeSearch,
  normalizeText,
  parseRoomIdFromLocation,
  randomItem,
  renderOptionText,
  removeStored,
  setRoomIdInUrl,
  setStoredJSON,
  setStoredString,
  shuffle,
  sortPlayers,
  uid,
} from './utils.js';

const root = document.getElementById('app');
const toastRoot = document.getElementById('toast-root');
const questionBankRef = ref(db, 'questionBank');

let unsubscribeRoom = null;
let unsubscribeQuestionBank = null;

const state = {
  roomId: parseRoomIdFromLocation(),
  roomData: null,
  roomLookupResolved: false,
  playerId: '',
  playerName: getStoredString(STORAGE_KEYS.playerName, ''),
  bank: {
    categories: [],
    categoriesById: {},
    questions: [],
    questionsById: {},
    groupedQuestions: {},
    meta: { categoriesCount: 0, questionsCount: 0 },
    loaded: false,
  },
  adminUnlocked: getStoredString(STORAGE_KEYS.adminUnlocked, '') === '1',
  chatOpen: false,
  modal: null,
  upload: {
    status: 'idle',
    progress: 0,
    categoriesCount: 0,
    questionsCount: 0,
    message: '',
    fileName: '',
    parsed: null,
    error: '',
  },
  adminFilters: {
    search: '',
    categoryId: 'all',
  },
  restoreAttemptedRoomId: '',
  mutationLocked: false,
  lastReadyMarker: '',
  secretTapTimes: [],
};

function roomRef(roomId) {
  return ref(db, `rooms/${roomId}`);
}

function playerRef(roomId, playerId) {
  return ref(db, `rooms/${roomId}/players/${playerId}`);
}

function roomSessionKey(roomId) {
  return `${STORAGE_KEYS.roomSessionPrefix}${roomId}`;
}

function chatSeenKey(roomId) {
  return `${STORAGE_KEYS.chatSeenPrefix}${roomId}`;
}

function isAdminRoute() {
  return window.location.hash === '#admin';
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastRoot.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3200);
}

function getSavedRoomSession(roomId = state.roomId) {
  if (!roomId) {
    return null;
  }

  return getStoredJSON(roomSessionKey(roomId), null);
}

function persistRoomSession(roomId = state.roomId, player = getCurrentPlayer()) {
  if (!roomId || !player?.id) {
    return;
  }

  setStoredJSON(roomSessionKey(roomId), {
    playerId: player.id,
    name: player.name,
    lastKnownPlayer: player,
  });
}

function clearRoomSession(roomId = state.roomId) {
  if (!roomId) {
    return;
  }

  removeStored(roomSessionKey(roomId));
}

function getRoomPlayers(roomData = state.roomData) {
  return sortPlayers(Object.values(roomData?.players || {}));
}

function getCurrentPlayer(roomData = state.roomData) {
  return roomData?.players?.[state.playerId] || null;
}

function getMessages(roomData = state.roomData) {
  return Object.values(roomData?.chat?.messages || {}).sort(
    (left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0),
  );
}

function getUnreadMessagesCount() {
  if (!state.roomId) {
    return 0;
  }

  const seenAt = Number(getStoredString(chatSeenKey(state.roomId), '0'));

  return getMessages().filter(
    (message) =>
      Number(message.createdAt || 0) > seenAt && String(message.playerId) !== String(state.playerId),
  ).length;
}

function markChatSeen() {
  if (!state.roomId) {
    return;
  }

  const messages = getMessages();
  const lastMessage = messages[messages.length - 1];

  if (!lastMessage) {
    return;
  }

  setStoredString(chatSeenKey(state.roomId), String(lastMessage.createdAt || Date.now()));
}

function getShareLink(roomId = state.roomId) {
  return `${SHARE_BASE_URL}?room=${encodeURIComponent(roomId || '')}`;
}

function getColorById(colorId) {
  return COLOR_PALETTE.find((color) => color.id === colorId) || null;
}

function getPlayerDisplayColor(player) {
  const selected = getColorById(player?.colorId);

  if (selected) {
    return selected;
  }

  return {
    id: 'default',
    name: 'افتراضي',
    value: '#FFF7EA',
    contrast: '#6B3A0D',
  };
}

function getSelectedCategories(roomData = state.roomData) {
  return roomData?.game?.selectedCategories || {};
}

function getSelectedCategoryIds(roomData = state.roomData) {
  return Object.keys(getSelectedCategories(roomData));
}

function getBoard(roomData = state.roomData) {
  return roomData?.game?.board || {};
}

function getRound(roomData = state.roomData) {
  return roomData?.game?.round || null;
}

function isHost(roomData = state.roomData) {
  return roomData?.hostId && roomData.hostId === state.playerId;
}

function canJoinCurrentRoom() {
  if (!state.roomId) {
    return true;
  }

  if (!state.roomLookupResolved) {
    return false;
  }

  if (!state.roomData) {
    return false;
  }

  if (getCurrentPlayer(state.roomData)) {
    return true;
  }

  if (state.roomData.phase !== 'lobby') {
    return Boolean(getSavedRoomSession(state.roomId)?.playerId);
  }

  return getRoomPlayers(state.roomData).length < MAX_PLAYERS;
}

function roomPhaseLabel(phase) {
  switch (phase) {
    case 'lobby':
      return 'الانتظار';
    case 'colors':
      return 'اختيار الألوان';
    case 'categories':
      return 'اختيار التصنيفات';
    case 'board':
      return 'لوحة اللعب';
    case 'question-loading':
      return 'تجهيز السؤال';
    case 'question':
      return 'الإجابة';
    case 'answer-loading':
      return 'كشف الإجابات';
    case 'result':
      return 'نتيجة الجولة';
    case 'finished':
      return 'النتيجة النهائية';
    default:
      return 'غير معروف';
  }
}

function getTurnPlayer(roomData = state.roomData) {
  const turnPlayerId = roomData?.game?.turnPlayerId;
  return turnPlayerId ? roomData?.players?.[turnPlayerId] || null : null;
}

function renderPlayerScoreCard(player, { scoreMode = false } = {}) {
  const color = getPlayerDisplayColor(player);
  const isTurn = getTurnPlayer()?.id === player.id;
  const hostBadge = state.roomData?.hostId === player.id ? '<span class="host-badge">صاحب الغرفة</span>' : '';
  const turnBadge = isTurn && scoreMode ? '<span class="status-badge">الدور عليه</span>' : '';
  const points = scoreMode
    ? `<span class="score-value">${formatPoints(player.score || 0)}</span>`
    : `<div class="player-meta">النقاط الحالية: ${formatPoints(player.score || 0)}</div>`;

  return `
    <article class="${scoreMode ? 'score-card' : 'player-card'}" style="--player-color:${color.value};--player-contrast:${color.contrast};">
      <div class="player-emoji">${escapeHtml(player.avatar || '🙂')}</div>
      <h3 class="player-name">${escapeHtml(player.name || 'لاعب')}</h3>
      <div class="button-row">
        ${hostBadge}
        ${turnBadge}
      </div>
      <div class="score-meta">${escapeHtml(color.name)}</div>
      ${points}
    </article>
  `;
}

function renderGameHeader(turnText = '') {
  const players = getRoomPlayers();
  const unread = getUnreadMessagesCount();

  return `
    <section class="panel">
      <div class="panel-body room-layout">
        <div class="player-scoreboard">
          ${players.map((player) => renderPlayerScoreCard(player, { scoreMode: true })).join('')}
        </div>
        <div class="chat-bar">
          <div class="turn-banner">
            <h2 class="turn-title">${escapeHtml(turnText)}</h2>
          </div>
          <button class="chat-toggle" type="button" data-open-chat>
            دردشة
            ${unread ? `<span class="chat-badge">${unread}</span>` : ''}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderHomeView() {
  const roomPlayers = getRoomPlayers(state.roomData);
  const bankMeta = state.bank.meta || { categoriesCount: 0, questionsCount: 0 };
  const isJoinMode = Boolean(state.roomId);
  const actionLabel = isJoinMode ? 'دخول الغرفة' : 'إنشاء غرفة';
  const roomPreview = !isJoinMode
    ? ''
    : !state.roomLookupResolved
      ? '<p class="muted-note">جاري التحقق من حالة الغرفة...</p>'
      : !state.roomData
        ? '<p class="muted-note">لم يتم العثور على الغرفة المطلوبة.</p>'
        : `
          <div class="room-card">
            <div class="button-row">
              <span class="status-badge">رمز الغرفة: ${escapeHtml(state.roomId)}</span>
              <span class="status-badge">المرحلة: ${escapeHtml(roomPhaseLabel(state.roomData.phase))}</span>
            </div>
            <p class="muted-note">
              اللاعبون الحاليون: ${roomPlayers.length} / ${MAX_PLAYERS}
            </p>
          </div>
        `;

  return `
    <main class="screen-shell">
      <section class="hero-layout">
        <article class="panel hero-spotlight">
          <div class="panel-body">
            <span class="eyebrow">لعبة جماعية مباشرة</span>
            <h1 class="hero-title">${escapeHtml(APP_NAME)}</h1>
            <p class="hero-subtitle">
              أنشئ غرفة، شارك الرابط، اختر لونك، ثم تحدّوا بعضكم في لوحة منظمة بتصميم مرح وألوان فاتحة.
            </p>
          </div>
          <div class="panel-body">
            <div class="hero-stats">
              <article class="stat-card">
                <span class="stat-value">${MAX_PLAYERS}</span>
                <span class="stat-label">الحد الأقصى للاعبين</span>
              </article>
              <article class="stat-card">
                <span class="stat-value">${bankMeta.categoriesCount || 0}</span>
                <span class="stat-label">تصنيفات متاحة</span>
              </article>
              <article class="stat-card">
                <span class="stat-value">${bankMeta.questionsCount || 0}</span>
                <span class="stat-label">أسئلة مخزنة</span>
              </article>
            </div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-body">
            <h2 class="section-title">${isJoinMode ? 'الانضمام إلى غرفة' : 'ابدأ غرفة جديدة'}</h2>
            <p class="supporting-text">
              ${isJoinMode ? 'اكتب اسمك للدخول إلى الغرفة المرسلة لك.' : 'اكتب اسمك أولاً ثم أنشئ غرفة وشارك الرابط مع اللاعبين.'}
            </p>
            <form class="form-shell" data-home-form>
              <div>
                <label class="label" for="player-name-input">اسمك</label>
                <input
                  id="player-name-input"
                  class="text-input"
                  type="text"
                  name="playerName"
                  maxlength="24"
                  placeholder="مثلاً: خالد"
                  value="${escapeHtml(state.playerName)}"
                />
              </div>
              ${roomPreview}
              <div class="button-row">
                <button class="button" type="submit" ${canJoinCurrentRoom() ? '' : 'disabled'}>
                  ${escapeHtml(actionLabel)}
                </button>
                ${isJoinMode ? '<button class="ghost-button" type="button" data-cancel-room-link>إلغاء رابط الغرفة</button>' : ''}
              </div>
              <p class="muted-note">
                اللعب متاح من ${MIN_PLAYERS} إلى ${MAX_PLAYERS} لاعبين. لا يمكن دخول لاعبين جدد بعد بدء اللعبة.
              </p>
            </form>
          </div>
        </article>
      </section>
    </main>
  `;
}

function renderLobbyView() {
  const players = getRoomPlayers();
  const enoughPlayers = players.length >= MIN_PLAYERS && players.length <= MAX_PLAYERS;
  const bankReady = state.bank.questions.length > 0;

  return `
    <main class="screen-shell">
      <section class="panel">
        <div class="panel-body room-layout">
          <div class="room-card">
            <div class="button-row">
              <span class="room-code">${escapeHtml(state.roomId)}</span>
              <button class="soft-button" type="button" data-copy-room-code>نسخ الرمز</button>
            </div>
            <div class="room-link-box">
              <span class="room-link-text">${escapeHtml(getShareLink())}</span>
              <button class="button" type="button" data-copy-room-link>نسخ رابط الغرفة</button>
            </div>
            <p class="muted-note">
              الحد الأدنى ${MIN_PLAYERS} لاعبين والحد الأقصى ${MAX_PLAYERS}. بعد الضغط على "التالي" تبدأ مرحلة اختيار الألوان.
            </p>
          </div>
          <div class="button-row">
            ${isHost() ? `<button class="button" type="button" data-next-from-lobby ${enoughPlayers && bankReady ? '' : 'disabled'}>التالي</button>` : ''}
            <button class="ghost-button" type="button" data-leave-room>مغادرة الغرفة</button>
          </div>
          ${!bankReady ? '<p class="muted-note">يجب إضافة بنك الأسئلة من صفحة الإدارة أولاً.</p>' : ''}
          ${!enoughPlayers ? `<p class="muted-note">يلزم وجود ${MIN_PLAYERS} لاعبين على الأقل للمتابعة.</p>` : ''}
        </div>
      </section>

      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">اللاعبون</h2>
          <div class="players-grid">
            ${players.map((player) => renderPlayerScoreCard(player)).join('')}
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderColorSelectionView() {
  const players = getRoomPlayers();
  const me = getCurrentPlayer();
  const allChosen = players.length >= MIN_PLAYERS && players.every((player) => player.colorId);
  const takenColors = new Set(players.filter((player) => player.id !== me?.id && player.colorId).map((player) => player.colorId));

  return `
    <main class="screen-shell">
      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">اختر لونك</h2>
          <p class="supporting-text">
            كل لاعب يختار لوناً واحداً. اللون المختار يصبح معتماً عند بقية اللاعبين.
          </p>
          <div class="players-grid">
            ${players.map((player) => renderPlayerScoreCard(player)).join('')}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body">
          <div class="color-grid">
            ${COLOR_PALETTE.map((color) => {
              const isMine = me?.colorId === color.id;
              const isTaken = takenColors.has(color.id);
              return `
                <button
                  class="color-choice ${isMine ? 'selected' : ''} ${isTaken ? 'locked' : ''}"
                  type="button"
                  data-pick-color="${escapeHtml(color.id)}"
                  ${isTaken ? 'disabled' : ''}
                >
                  <span class="color-chip" style="background:${color.value};"></span>
                  <strong>${escapeHtml(color.name)}</strong>
                  <span class="muted-note">${isMine ? 'لونك الحالي' : isTaken ? 'مختار من لاعب آخر' : 'متاح الآن'}</span>
                </button>
              `;
            }).join('')}
          </div>
          <div class="button-row">
            ${isHost() ? `<button class="button" type="button" data-next-from-colors ${allChosen ? '' : 'disabled'}>التالي</button>` : ''}
            <button class="ghost-button" type="button" data-leave-room>مغادرة الغرفة</button>
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderCategorySelectionView() {
  const selectedCategories = getSelectedCategories();
  const selectedIds = Object.keys(selectedCategories);
  const selectedCount = selectedIds.length;
  const categories = state.bank.categories;
  const enoughSelected = selectedCount === REQUIRED_CATEGORY_COUNT;

  return `
    <main class="screen-shell">
      ${renderGameHeader(`اختروا ${REQUIRED_CATEGORY_COUNT} تصنيفات فقط لبدء اللعبة`)}
      <section class="panel">
        <div class="panel-body">
          <div class="button-row">
            <span class="status-badge">تم اختيار ${selectedCount} / ${REQUIRED_CATEGORY_COUNT}</span>
            ${isHost() ? `<button class="button" type="button" data-start-game ${enoughSelected ? '' : 'disabled'}>بدء اللعبة</button>` : ''}
          </div>
          <div class="category-selection-grid">
            ${categories.map((category) => {
              const selected = selectedCategories[category.id];
              const chosenBy = selected ? state.roomData?.players?.[selected.playerId]?.name || selected.playerName : '';
              return `
                <button
                  class="selection-card ${selected ? 'selected' : ''}"
                  type="button"
                  data-toggle-category="${escapeHtml(category.id)}"
                  ${!selected && selectedCount >= REQUIRED_CATEGORY_COUNT ? 'disabled' : ''}
                >
                  <h3 class="selection-title">${escapeHtml(category.name)}</h3>
                  <div class="selection-meta">
                    ${escapeHtml(String(category.questionCount || 0))} سؤال
                  </div>
                  ${selected ? `<span class="host-badge">اختاره ${escapeHtml(chosenBy || 'أحد اللاعبين')}</span>` : '<span class="tiny-badge">متاح</span>'}
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderBoardView() {
  const board = Object.values(getBoard());
  const turnPlayer = getTurnPlayer();
  const currentRound = getRound();
  const myTurn = turnPlayer?.id === state.playerId;

  return `
    <main class="screen-shell">
      ${renderGameHeader(`الدور على ${turnPlayer ? turnPlayer.name : '...'} لاختيار السؤال`)}
      <section class="panel">
        <div class="panel-body">
          <div class="board-grid">
            ${board.map((category) => {
              const categoryQuestions = state.bank.questions.filter((question) => question.categoryId === category.id);
              return `
                <article class="board-card">
                  <div class="board-header">
                    <div>
                      <h3 class="board-title">${escapeHtml(category.name)}</h3>
                      <p class="board-meta">${escapeHtml(String(categoryQuestions.length || 0))} سؤال متاح في البنك</p>
                    </div>
                    <span class="tiny-badge">3 مستويات</span>
                  </div>
                  <div class="board-buttons">
                    ${BOARD_VALUES.map((points) => {
                      const cell = category.cells?.[points] || { status: 'available' };
                      const owner = cell.answeredBy ? state.roomData?.players?.[cell.answeredBy] : null;
                      const color = owner ? getPlayerDisplayColor(owner) : null;
                      const statusClass = cell.status || 'available';
                      const disabled = statusClass !== 'available' || !myTurn || Boolean(currentRound);
                      return `
                        <button
                          class="board-button ${statusClass}"
                          type="button"
                          data-pick-cell="${escapeHtml(category.id)}:${points}"
                          ${disabled ? 'disabled' : ''}
                          style="${color ? `--player-color:${color.value};--player-contrast:${color.contrast};` : ''}"
                        >
                          ${points}
                        </button>
                      `;
                    }).join('')}
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderQuestionLoadingView() {
  const round = getRound();
  const readyCount = Object.keys(round?.readyPlayers || {}).length;
  const totalPlayers = getRoomPlayers().length;

  return `
    <main class="screen-shell">
      ${renderGameHeader(`تم اختيار ${round?.categoryName || ''} مقابل ${round?.points || ''}`)}
      <section class="stage-shell">
        <article class="stage-card">
          <div class="stage-emoji">⏳</div>
          <h2 class="stage-title">جاري تجهيز السؤال</h2>
          <p class="stage-text">
            التصنيف: ${escapeHtml(round?.categoryName || '')}
            <br />
            القيمة: ${escapeHtml(String(round?.points || ''))}
          </p>
          <div class="progress-shell">
            <div class="progress-bar"><span style="width:${Math.min(100, (readyCount / Math.max(totalPlayers, 1)) * 100)}%;"></span></div>
            <p class="muted-note">جاهزون الآن: ${readyCount} / ${totalPlayers}</p>
          </div>
        </article>
      </section>
    </main>
  `;
}

function renderQuestionView() {
  const round = getRound();
  const answers = round?.answers || {};
  const myAnswer = answers[state.playerId];
  const remainingMs = Math.max(0, Number(round?.deadlineAt || 0) - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  return `
    <main class="screen-shell">
      ${renderGameHeader(`السؤال من تصنيف ${round?.categoryName || ''}`)}
      <section class="stage-shell">
        <article class="stage-card">
          <div class="button-row">
            <span class="question-badge">${escapeHtml(round?.categoryName || '')}</span>
            <span class="question-badge">${escapeHtml(String(round?.points || ''))} نقطة</span>
          </div>
          <div class="countdown">${remainingSeconds}</div>
          <h2 class="stage-title">${escapeHtml(round?.questionText || '')}</h2>
          <div class="option-grid">
            ${(round?.options || []).map((option, index) => {
              const alreadyAnswered = Boolean(myAnswer);
              const selected = myAnswer?.optionKey === option.key;
              const disabled = alreadyAnswered || remainingMs <= 0;
              return `
                <button
                  class="option-button ${selected ? 'selected' : ''} ${disabled && !selected ? 'disabled' : ''}"
                  type="button"
                  data-answer-option="${escapeHtml(option.key)}"
                  ${disabled ? 'disabled' : ''}
                >
                  <span class="option-label">${escapeHtml(option.label)} )</span>
                  <span class="option-text">${escapeHtml(option.text)}</span>
                </button>
              `;
            }).join('')}
          </div>
          ${myAnswer ? '<p class="muted-note">تم تسجيل إجابتك. انتظر بقية اللاعبين أو انتهاء العداد.</p>' : '<p class="muted-note">لديك 40 ثانية للإجابة. عند إجابة الجميع ننتقل مباشرة.</p>'}
        </article>
      </section>
    </main>
  `;
}

function renderAnswerLoadingView() {
  const round = getRound();
  const readyCount = Object.keys(round?.readyPlayers || {}).length;
  const totalPlayers = getRoomPlayers().length;

  return `
    <main class="screen-shell">
      ${renderGameHeader('جاري كشف الإجابات')}
      <section class="stage-shell">
        <article class="stage-card">
          <div class="stage-emoji">🧠</div>
          <h2 class="stage-title">الجواب الصحيح هو</h2>
          <p class="stage-text">${escapeHtml(round?.correctAnswerFull || round?.correctAnswerText || '')}</p>
          <div class="progress-shell">
            <div class="progress-bar"><span style="width:${Math.min(100, (readyCount / Math.max(totalPlayers, 1)) * 100)}%;"></span></div>
            <p class="muted-note">تم تجهيز عرض النتيجة لـ ${readyCount} / ${totalPlayers}</p>
          </div>
        </article>
      </section>
    </main>
  `;
}

function renderResultView() {
  const round = getRound();
  const result = round?.result || {};
  const isSuccess = result.type === 'success';

  return `
    <main class="screen-shell">
      ${renderGameHeader(`الدور التالي سيكون على ${state.roomData?.players?.[state.roomData?.game?.turnPlayerId]?.name || '...'} بعد انتهاء العرض`)}
      <section class="stage-shell">
        <article class="stage-card ${isSuccess ? 'stage-good' : 'stage-bad'}">
          <div class="stage-emoji">${isSuccess ? '🥳' : '😔'}</div>
          <h2 class="stage-title">${isSuccess ? 'إجابة صحيحة!' : 'لم يجب أحد إجابة صحيحة'}</h2>
          ${
            isSuccess
              ? `
                <p class="stage-text">
                  أسرع لاعب أجاب بشكل صحيح هو
                  <strong>${escapeHtml(result.winnerName || '')}</strong>
                  <br />
                  وتمت إضافة ${escapeHtml(String(result.scoreDelta || 0))} نقطة له.
                </p>
              `
              : `
                <p class="stage-text">
                  لم يتمكن أي لاعب من الوصول إلى الإجابة الصحيحة في هذه الجولة.
                </p>
              `
          }
        </article>
      </section>
    </main>
  `;
}

function renderFinishedView() {
  const leaderboard = [...getRoomPlayers()].sort((left, right) => {
    if (Number(right.score || 0) !== Number(left.score || 0)) {
      return Number(right.score || 0) - Number(left.score || 0);
    }

    return Number(left.joinedAt || 0) - Number(right.joinedAt || 0);
  });
  const winner = leaderboard[0];
  const losers = leaderboard.slice(1);

  return `
    <main class="screen-shell">
      <section class="stage-shell">
        <article class="winner-shell">
          <div class="winner-crown">👑</div>
          <h1 class="winner-title">انتهت اللعبة</h1>
          <div class="winner-emoji">${escapeHtml(winner?.avatar || '🏆')}</div>
          <h2 class="winner-name">${escapeHtml(winner?.name || 'الفائز')}</h2>
          <p class="winner-points">برصيد ${formatPoints(winner?.score || 0)} نقطة</p>
          <div class="losers-list">
            ${losers
              .map(
                (player) => `
                  <div class="loser-card">
                    ${escapeHtml(player.name)} - ${formatPoints(player.score || 0)} نقطة
                  </div>
                `,
              )
              .join('')}
          </div>
          <div class="button-row" style="justify-content:center;">
            <button class="button" type="button" data-new-game ${isHost() ? '' : 'disabled'}>
              بدء لعبة جديدة
            </button>
            <button class="ghost-button" type="button" data-leave-room>مغادرة الغرفة</button>
          </div>
          ${!isHost() ? '<p class="muted-note">صاحب الغرفة فقط يمكنه بدء لعبة جديدة.</p>' : ''}
        </article>
      </section>
    </main>
  `;
}

function renderRoomView() {
  const phase = state.roomData?.phase || 'lobby';

  switch (phase) {
    case 'lobby':
      return renderLobbyView();
    case 'colors':
      return renderColorSelectionView();
    case 'categories':
      return renderCategorySelectionView();
    case 'board':
      return renderBoardView();
    case 'question-loading':
      return renderQuestionLoadingView();
    case 'question':
      return renderQuestionView();
    case 'answer-loading':
      return renderAnswerLoadingView();
    case 'result':
      return renderResultView();
    case 'finished':
      return renderFinishedView();
    default:
      return renderLobbyView();
  }
}

function renderProgressPanel() {
  if (state.upload.status === 'idle') {
    return '';
  }

  return `
    <div class="progress-shell">
      <div class="progress-bar"><span style="width:${state.upload.progress}%;"></span></div>
      <p class="muted-note">${escapeHtml(state.upload.message || '')}</p>
      <div class="button-row">
        <span class="status-badge">التصنيفات: ${state.upload.categoriesCount || 0}</span>
        <span class="status-badge">الأسئلة: ${state.upload.questionsCount || 0}</span>
      </div>
      ${state.upload.error ? `<p class="muted-note">${escapeHtml(state.upload.error)}</p>` : ''}
    </div>
  `;
}

function getFilteredQuestions() {
  const search = normalizeSearch(state.adminFilters.search);

  return state.bank.questions.filter((question) => {
    const categoryMatches =
      state.adminFilters.categoryId === 'all' || question.categoryId === state.adminFilters.categoryId;

    if (!categoryMatches) {
      return false;
    }

    if (!search) {
      return true;
    }

    const haystack = normalizeSearch(
      [
        question.categoryName,
        question.text,
        question.correctAnswerText,
        ...(question.options || []).map((option) => option.text),
      ].join(' '),
    );

    return haystack.includes(search);
  });
}

function renderAdminView() {
  const filteredQuestions = getFilteredQuestions();

  return `
    <main class="screen-shell">
      <section class="panel">
        <div class="panel-body">
          <div class="button-row">
            <span class="eyebrow">صفحة الإدارة</span>
            <button class="ghost-button" type="button" data-exit-admin>خروج</button>
          </div>
        </div>
      </section>

      <section class="admin-layout">
        <article class="panel">
          <div class="panel-body">
            <h2 class="section-title">استيراد ملف Excel</h2>
            <p class="supporting-text">
              يدعم نفس تنسيق الملف المرفق: التصنيف، السؤال، الخيارات، الإجابة الصحيحة، النقاط.
            </p>
            <div class="form-shell">
              <div>
                <label class="label" for="excel-input">رفع الملف</label>
                <input id="excel-input" class="file-input" type="file" accept=".xlsx,.xls" data-import-file />
              </div>
              ${renderProgressPanel()}
              ${
                state.upload.parsed
                  ? `
                    <div class="button-row">
                      <span class="status-badge">الملف: ${escapeHtml(state.upload.fileName)}</span>
                      <button class="button" type="button" data-upload-parsed-bank>
                        إضافة إلى فايربيس
                      </button>
                    </div>
                  `
                  : ''
              }
            </div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-body">
            <h2 class="section-title">التصنيفات</h2>
            <p class="supporting-text">
              عدد التصنيفات الحالية: ${state.bank.categories.length}
            </p>
            <div class="admin-categories-grid">
              ${
                state.bank.categories.length
                  ? state.bank.categories
                      .map(
                        (category) => `
                          <article class="admin-category-card">
                            <h3 class="admin-category-name">${escapeHtml(category.name)}</h3>
                            <p class="question-meta">
                              ${category.questionCount || 0} سؤال
                              <br />
                              200: ${category.pointsBreakdown?.[200] || 0} | 400: ${category.pointsBreakdown?.[400] || 0} | 600: ${category.pointsBreakdown?.[600] || 0}
                            </p>
                            <div class="button-row">
                              <button class="soft-button" type="button" data-edit-category="${escapeHtml(category.id)}">تعديل</button>
                              <button class="danger-button" type="button" data-delete-category="${escapeHtml(category.id)}">حذف</button>
                            </div>
                          </article>
                        `,
                      )
                      .join('')
                  : '<p class="empty-text">لا توجد تصنيفات مخزنة بعد.</p>'
              }
            </div>
          </div>
        </article>
      </section>

      <section class="panel">
        <div class="panel-body">
          <h2 class="section-title">الأسئلة</h2>
          <div class="toolbar">
            <input
              class="text-input"
              type="search"
              name="adminSearch"
              placeholder="ابحث عن سؤال أو كلمة..."
              value="${escapeHtml(state.adminFilters.search)}"
            />
            <select class="select-input" name="adminCategoryFilter">
              <option value="all">كل التصنيفات</option>
              ${state.bank.categories
                .map(
                  (category) => `
                    <option value="${escapeHtml(category.id)}" ${state.adminFilters.categoryId === category.id ? 'selected' : ''}>
                      ${escapeHtml(category.name)}
                    </option>
                  `,
                )
                .join('')}
            </select>
          </div>
          <p class="muted-note">النتائج الحالية: ${filteredQuestions.length}</p>
          <div class="question-list">
            ${
              filteredQuestions.length
                ? filteredQuestions
                    .map(
                      (question) => `
                        <article class="question-card">
                          <div class="button-row">
                            <span class="question-badge">${escapeHtml(question.categoryName)}</span>
                            <span class="question-badge">${escapeHtml(String(question.points))}</span>
                          </div>
                          <h3 class="question-title">${escapeHtml(question.text)}</h3>
                          <div class="question-options">
                            ${(question.options || [])
                              .map((option, index) => {
                                const isCorrect = index === Number(question.correctOptionIndex);
                                return `
                                  <div class="question-option ${isCorrect ? 'correct' : ''}">
                                    ${escapeHtml(renderOptionText(option))}
                                  </div>
                                `;
                              })
                              .join('')}
                          </div>
                          <div class="button-row">
                            <button class="soft-button" type="button" data-edit-question="${escapeHtml(question.id)}">تعديل السؤال</button>
                            <button class="danger-button" type="button" data-delete-question="${escapeHtml(question.id)}">حذف السؤال</button>
                          </div>
                        </article>
                      `,
                    )
                    .join('')
                : '<p class="empty-text">لا توجد نتائج مطابقة للبحث الحالي.</p>'
            }
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderQuestionModal(question) {
  if (!question) {
    return '';
  }

  return `
    <div class="modal-overlay" data-close-modal>
      <section class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h2 class="modal-title">تعديل السؤال</h2>
          <button class="icon-button" type="button" data-close-modal>إغلاق</button>
        </div>
        <div class="modal-body">
          <form class="modal-form" data-question-modal-form="${escapeHtml(question.id)}">
            <div>
              <label class="label">التصنيف</label>
              <select class="select-input" name="categoryId" required>
                ${state.bank.categories
                  .map(
                    (category) => `
                      <option value="${escapeHtml(category.id)}" ${category.id === question.categoryId ? 'selected' : ''}>
                        ${escapeHtml(category.name)}
                      </option>
                    `,
                  )
                  .join('')}
              </select>
            </div>
            <div>
              <label class="label">السؤال</label>
              <textarea class="textarea-input" name="questionText" required>${escapeHtml(question.text)}</textarea>
            </div>
            ${(question.options || [])
              .map(
                (option, index) => `
                  <div>
                    <label class="label">الخيار ${index + 1}</label>
                    <input class="text-input" type="text" name="option_${index}" value="${escapeHtml(option.text)}" required />
                  </div>
                `,
              )
              .join('')}
            <div>
              <label class="label">الإجابة الصحيحة</label>
              <select class="select-input" name="correctIndex">
                ${(question.options || [])
                  .map(
                    (option, index) => `
                      <option value="${index}" ${Number(question.correctOptionIndex) === index ? 'selected' : ''}>
                        ${escapeHtml(renderOptionText(option))}
                      </option>
                    `,
                  )
                  .join('')}
              </select>
            </div>
            <div>
              <label class="label">النقاط</label>
              <select class="select-input" name="points">
                ${BOARD_VALUES.map(
                  (points) => `
                    <option value="${points}" ${Number(question.points) === points ? 'selected' : ''}>${points}</option>
                  `,
                ).join('')}
              </select>
            </div>
            <div class="button-row">
              <button class="button" type="submit">حفظ التعديل</button>
              <button class="ghost-button" type="button" data-close-modal>إلغاء</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderCategoryModal(category) {
  if (!category) {
    return '';
  }

  return `
    <div class="modal-overlay" data-close-modal>
      <section class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h2 class="modal-title">تعديل التصنيف</h2>
          <button class="icon-button" type="button" data-close-modal>إغلاق</button>
        </div>
        <div class="modal-body">
          <form class="modal-form" data-category-modal-form="${escapeHtml(category.id)}">
            <div>
              <label class="label">اسم التصنيف</label>
              <input class="text-input" type="text" name="categoryName" value="${escapeHtml(category.name)}" required />
            </div>
            <div class="button-row">
              <button class="button" type="submit">حفظ التعديل</button>
              <button class="ghost-button" type="button" data-close-modal>إلغاء</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderChatModal() {
  if (!state.chatOpen || !state.roomId || !getCurrentPlayer()) {
    return '';
  }

  const messages = getMessages();

  return `
    <div class="chat-overlay" data-close-chat>
      <section class="chat-shell panel" onclick="event.stopPropagation()">
        <div class="chat-header">
          <h2 class="modal-title">الدردشة</h2>
          <button class="icon-button" type="button" data-close-chat>إغلاق</button>
        </div>
        <div class="chat-list">
          ${
            messages.length
              ? messages
                  .map((message) => {
                    const mine = String(message.playerId) === String(state.playerId);
                    return `
                      <article class="chat-message ${mine ? 'mine' : ''}">
                        <div class="chat-message-head">
                          <strong>${escapeHtml(message.playerName || 'لاعب')}</strong>
                          <span class="muted-note">
                            ${new Date(Number(message.createdAt || Date.now())).toLocaleTimeString('ar-KW', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div>${escapeHtml(message.text || '')}</div>
                      </article>
                    `;
                  })
                  .join('')
              : '<p class="empty-text">لا توجد رسائل بعد.</p>'
          }
        </div>
        <div class="chat-footer">
          <form class="chat-form" data-chat-form>
            <input class="text-input" type="text" name="message" maxlength="${CHAT_MESSAGE_LIMIT}" placeholder="اكتب رسالتك..." />
            <button class="button" type="submit">إرسال</button>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderGlobalAdminButton() {
  if (!state.adminUnlocked || isAdminRoute()) {
    return '';
  }

  return `
    <button class="admin-button global-admin-button" type="button" data-open-admin>
      Admin
    </button>
  `;
}

function renderModal() {
  if (!state.modal) {
    return '';
  }

  if (state.modal.type === 'question') {
    return renderQuestionModal(state.bank.questionsById[state.modal.id]);
  }

  if (state.modal.type === 'category') {
    return renderCategoryModal(state.bank.categoriesById[state.modal.id]);
  }

  return '';
}

function render() {
  const mainContent =
    isAdminRoute()
      ? renderAdminView()
      : state.roomId && state.roomData && getCurrentPlayer()
        ? renderRoomView()
        : renderHomeView();

  root.innerHTML = `${mainContent}${renderModal()}${renderChatModal()}${renderGlobalAdminButton()}`;

  if (state.chatOpen) {
    markChatSeen();
  }
}

function buildBoard(categoryIds = []) {
  const board = {};

  categoryIds.forEach((categoryId) => {
    const category = state.bank.categoriesById[categoryId];

    if (!category) {
      return;
    }

    board[categoryId] = {
      id: categoryId,
      name: category.name,
      cells: Object.fromEntries(
        BOARD_VALUES.map((points) => [
          points,
          {
            points,
            status: 'available',
          },
        ]),
      ),
    };
  });

  return board;
}

function getAvailableQuestionPool(categoryId, points) {
  return state.bank.groupedQuestions[`${categoryId}_${points}`] || [];
}

function pickRandomQuestion(categoryId, points) {
  const pool = shuffle(getAvailableQuestionPool(categoryId, points));
  return pool[0] || null;
}

function buildRound(question, roomData, categoryId, points) {
  const category = state.bank.categoriesById[categoryId];
  const opener = getCurrentPlayer(roomData);

  return {
    id: uid('round'),
    stageToken: uid('ready'),
    categoryId,
    categoryName: category?.name || question.categoryName,
    points,
    questionId: question.id,
    questionText: question.text,
    options: question.options || [],
    correctOptionIndex: question.correctOptionIndex,
    correctOptionKey: question.correctOptionKey,
    correctAnswerText: question.correctAnswerText,
    correctAnswerFull: question.correctAnswerFull,
    openedBy: opener?.id || state.playerId,
    openedByName: opener?.name || '',
    createdAt: Date.now(),
    answers: {},
    readyPlayers: {},
    result: null,
  };
}

async function ensureDisconnectRegistration(roomId = state.roomId, playerId = state.playerId) {
  if (!roomId || !playerId) {
    return;
  }

  try {
    await onDisconnect(playerRef(roomId, playerId)).remove();
  } catch (error) {
    console.error(error);
  }
}

async function createRoomWithPlayer(name) {
  await authReady;

  const playerName = normalizeText(name).slice(0, 24);

  if (!playerName) {
    throw new Error('اكتب اسمك أولاً.');
  }

  let roomId = '';

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = Math.random().toString(36).slice(2, 8).toUpperCase();
    const snapshot = await get(roomRef(candidate));

    if (!snapshot.exists()) {
      roomId = candidate;
      break;
    }
  }

  if (!roomId) {
    throw new Error('تعذر إنشاء غرفة جديدة حالياً. حاول مرة أخرى.');
  }

  const playerId = uid('player');
  const player = {
    id: playerId,
    name: playerName,
    avatar: PLAYER_AVATARS[0],
    joinedAt: Date.now(),
    score: 0,
    colorId: '',
  };

  await set(roomRef(roomId), {
    id: roomId,
    code: roomId,
    createdAt: Date.now(),
    hostId: playerId,
    phase: 'lobby',
    phaseStartedAt: Date.now(),
    players: {
      [playerId]: player,
    },
    game: {
      turnOrder: [playerId],
      turnPlayerId: playerId,
      selectedCategories: {},
      board: {},
      round: null,
      result: null,
    },
    chat: {
      messages: {},
    },
  });

  state.playerName = playerName;
  state.playerId = playerId;
  state.roomId = roomId;
  setStoredString(STORAGE_KEYS.playerName, playerName);
  setRoomIdInUrl(roomId);
  persistRoomSession(roomId, player);
  subscribeRoom(roomId);
  await ensureDisconnectRegistration(roomId, playerId);
}

function getUniqueAvatar(roomData, preferredAvatar = '') {
  if (preferredAvatar) {
    return preferredAvatar;
  }

  const used = new Set(getRoomPlayers(roomData).map((player) => player.avatar));
  return PLAYER_AVATARS.find((avatar) => !used.has(avatar)) || randomItem(PLAYER_AVATARS) || '🙂';
}

function mergeTurnOrder(turnOrder = [], playerId = '') {
  return [...new Set([...turnOrder.filter(Boolean), playerId])];
}

async function joinRoomWithPlayer(name) {
  const playerName = normalizeText(name).slice(0, 24);

  if (!playerName) {
    throw new Error('اكتب اسمك أولاً.');
  }

  if (!state.roomId) {
    throw new Error('لا يوجد رابط غرفة للانضمام إليه.');
  }

  const snapshot = await get(roomRef(state.roomId));

  if (!snapshot.exists()) {
    throw new Error('الغرفة غير موجودة.');
  }

  const roomData = snapshot.val();
  const savedSession = getSavedRoomSession(state.roomId);
  const restoringSamePlayer = savedSession?.playerId;

  if (restoringSamePlayer && roomData.players?.[restoringSamePlayer]) {
    state.playerId = restoringSamePlayer;
    state.playerName = roomData.players[restoringSamePlayer].name;
    setStoredString(STORAGE_KEYS.playerName, state.playerName);
    subscribeRoom(state.roomId);
    await ensureDisconnectRegistration(state.roomId, restoringSamePlayer);
    return;
  }

  if (!restoringSamePlayer && roomData.phase !== 'lobby') {
    throw new Error('لا يمكن دخول الغرفة بعد بدء اللعبة.');
  }

  if (!restoringSamePlayer && getRoomPlayers(roomData).length >= MAX_PLAYERS) {
    throw new Error('الغرفة ممتلئة.');
  }

  const playerId = restoringSamePlayer || uid('player');
  const restored = savedSession?.lastKnownPlayer || {};
  const player = {
    id: playerId,
    name: playerName,
    avatar: getUniqueAvatar(roomData, restored.avatar),
    joinedAt: restored.joinedAt || Date.now(),
    score: restored.score || 0,
    colorId: restored.colorId || '',
  };

  await update(roomRef(state.roomId), {
    [`players/${playerId}`]: player,
    'game/turnOrder': mergeTurnOrder(roomData.game?.turnOrder || [], playerId),
  });

  state.playerId = playerId;
  state.playerName = playerName;
  setStoredString(STORAGE_KEYS.playerName, playerName);
  persistRoomSession(state.roomId, player);
  subscribeRoom(state.roomId);
  await ensureDisconnectRegistration(state.roomId, playerId);
}

async function leaveRoom() {
  const roomId = state.roomId;
  const playerId = state.playerId;
  const players = getRoomPlayers();

  try {
    if (roomId && playerId) {
      if (players.length <= 1) {
        await remove(roomRef(roomId));
      } else {
        await remove(playerRef(roomId, playerId));
      }
    }
  } catch (error) {
    console.error(error);
  }

  clearRoomSession(roomId);
  state.playerId = '';
  state.roomId = '';
  state.roomData = null;
  state.roomLookupResolved = false;
  state.chatOpen = false;
  state.restoreAttemptedRoomId = '';
  setRoomIdInUrl('');

  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }

  render();
}

async function withRoomMutation(task) {
  if (state.mutationLocked) {
    return;
  }

  state.mutationLocked = true;

  try {
    await task();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'حدث خطأ غير متوقع.');
  } finally {
    state.mutationLocked = false;
  }
}

function countReadyPlayers(round) {
  return Object.keys(round?.readyPlayers || {}).length;
}

function countAnswers(round) {
  return Object.keys(round?.answers || {}).length;
}

function areAllPlayersReady(roomData) {
  const players = getRoomPlayers(roomData);
  return countReadyPlayers(getRound(roomData)) >= players.length;
}

function areAllPlayersAnswered(roomData) {
  const players = getRoomPlayers(roomData);
  return countAnswers(getRound(roomData)) >= players.length;
}

async function maybeRestoreSavedSession() {
  if (!state.roomId || !state.roomData || state.restoreAttemptedRoomId === state.roomId) {
    return;
  }

  state.restoreAttemptedRoomId = state.roomId;
  const session = getSavedRoomSession(state.roomId);

  if (!session?.playerId) {
    return;
  }

  if (state.roomData.players?.[session.playerId]) {
    state.playerId = session.playerId;
    await ensureDisconnectRegistration(state.roomId, session.playerId);
    render();
    return;
  }

  const player = session.lastKnownPlayer;

  if (!player) {
    return;
  }

  await update(roomRef(state.roomId), {
    [`players/${session.playerId}`]: {
      ...player,
      id: session.playerId,
      name: session.name || player.name,
    },
    'game/turnOrder': mergeTurnOrder(state.roomData.game?.turnOrder || [], session.playerId),
  });

  state.playerId = session.playerId;
  await ensureDisconnectRegistration(state.roomId, session.playerId);
  showToast('تمت استعادة دخولك إلى الغرفة.');
}

async function nextFromLobby() {
  const players = getRoomPlayers();

  if (players.length < MIN_PLAYERS) {
    throw new Error('يلزم وجود لاعبين على الأقل.');
  }

  if (!state.bank.questions.length) {
    throw new Error('بنك الأسئلة فارغ حالياً.');
  }

  const payload = {
    phase: 'colors',
    phaseStartedAt: Date.now(),
    'game/selectedCategories': {},
    'game/board': {},
    'game/round': null,
    'game/result': null,
    'game/turnOrder': players.map((player) => player.id),
    'game/turnPlayerId': players[0]?.id || state.playerId,
  };

  players.forEach((player) => {
    payload[`players/${player.id}/score`] = 0;
    payload[`players/${player.id}/colorId`] = '';
  });

  await update(roomRef(state.roomId), payload);
}

async function chooseColor(colorId) {
  const me = getCurrentPlayer();
  const taken = getRoomPlayers().find((player) => player.id !== me?.id && player.colorId === colorId);

  if (!me || taken) {
    return;
  }

  await update(roomRef(state.roomId), {
    [`players/${state.playerId}/colorId`]: colorId,
  });
}

async function nextFromColors() {
  const players = getRoomPlayers();

  if (!players.every((player) => player.colorId)) {
    throw new Error('يجب أن يختار الجميع ألوانهم أولاً.');
  }

  await update(roomRef(state.roomId), {
    phase: 'categories',
    phaseStartedAt: Date.now(),
    'game/selectedCategories': {},
    'game/round': null,
  });
}

async function toggleCategory(categoryId) {
  const selected = getSelectedCategories();
  const alreadySelected = Boolean(selected[categoryId]);

  if (!alreadySelected && Object.keys(selected).length >= REQUIRED_CATEGORY_COUNT) {
    showToast(`يمكن اختيار ${REQUIRED_CATEGORY_COUNT} تصنيفات فقط.`);
    return;
  }

  await update(roomRef(state.roomId), {
    [`game/selectedCategories/${categoryId}`]: alreadySelected
      ? null
      : {
          playerId: state.playerId,
          playerName: getCurrentPlayer()?.name || '',
          selectedAt: Date.now(),
        },
  });
}

async function startGame() {
  const selectedIds = getSelectedCategoryIds();

  if (selectedIds.length !== REQUIRED_CATEGORY_COUNT) {
    throw new Error(`يجب اختيار ${REQUIRED_CATEGORY_COUNT} تصنيفات بالضبط.`);
  }

  const invalidCategory = selectedIds.find((categoryId) =>
    BOARD_VALUES.some((points) => getAvailableQuestionPool(categoryId, points).length === 0),
  );

  if (invalidCategory) {
    throw new Error('أحد التصنيفات المختارة لا يحتوي على جميع مستويات النقاط المطلوبة.');
  }

  const players = getRoomPlayers();

  await update(roomRef(state.roomId), {
    phase: 'board',
    phaseStartedAt: Date.now(),
    'game/board': buildBoard(selectedIds),
    'game/turnOrder': players.map((player) => player.id),
    'game/turnPlayerId': players[0]?.id || state.playerId,
    'game/round': null,
    'game/result': null,
  });
}

async function pickBoardCell(categoryId, points) {
  const roomData = state.roomData;
  const turnPlayer = getTurnPlayer(roomData);
  const board = getBoard(roomData);
  const cell = board?.[categoryId]?.cells?.[points];

  if (!roomData || roomData.phase !== 'board' || state.playerId !== turnPlayer?.id) {
    return;
  }

  if (!cell || cell.status !== 'available') {
    return;
  }

  const question = pickRandomQuestion(categoryId, Number(points));

  if (!question) {
    showToast('لا يوجد سؤال متاح لهذه الخانة.');
    return;
  }

  const round = buildRound(question, roomData, categoryId, Number(points));

  await update(roomRef(state.roomId), {
    phase: 'question-loading',
    phaseStartedAt: Date.now(),
    'game/round': round,
  });
}

async function markReadyIfNeeded() {
  const round = getRound();
  const phase = state.roomData?.phase;

  if (!round?.stageToken || !['question-loading', 'answer-loading'].includes(phase) || !state.playerId) {
    state.lastReadyMarker = '';
    return;
  }

  const marker = `${phase}:${round.stageToken}:${state.playerId}`;

  if (state.lastReadyMarker === marker || round.readyPlayers?.[state.playerId]) {
    return;
  }

  state.lastReadyMarker = marker;

  try {
    await update(roomRef(state.roomId), {
      [`game/round/readyPlayers/${state.playerId}`]: true,
    });
  } catch (error) {
    console.error(error);
  }
}

async function submitAnswer(optionKey) {
  const round = getRound();
  const currentPhase = state.roomData?.phase;

  if (currentPhase !== 'question' || !round || round.answers?.[state.playerId]) {
    return;
  }

  if (Date.now() > Number(round.deadlineAt || 0)) {
    return;
  }

  await update(roomRef(state.roomId), {
    [`game/round/answers/${state.playerId}`]: {
      playerId: state.playerId,
      playerName: getCurrentPlayer()?.name || '',
      optionKey,
      answeredAt: Date.now(),
      isCorrect: optionKey === round.correctOptionKey,
    },
  });
}

async function showResultStage() {
  await update(roomRef(state.roomId), {
    phase: 'result',
    phaseStartedAt: Date.now(),
  });
}

function boardCompleted(board) {
  return Object.values(board || {}).every((category) =>
    BOARD_VALUES.every((points) => {
      const cell = category.cells?.[points];
      return cell && cell.status !== 'available';
    }),
  );
}

async function finalizeRound() {
  const roomData = state.roomData;
  const round = getRound(roomData);

  if (!round) {
    return;
  }

  const answers = Object.values(round.answers || {}).filter(
    (answer) => Number(answer.answeredAt || 0) <= Number(round.deadlineAt || 0),
  );
  const correctAnswers = answers
    .filter((answer) => answer.optionKey === round.correctOptionKey)
    .sort((left, right) => Number(left.answeredAt || 0) - Number(right.answeredAt || 0));
  const board = getBoard(roomData);
  const existingCell = board?.[round.categoryId]?.cells?.[round.points] || {
    status: 'available',
    points: round.points,
  };
  const players = getRoomPlayers(roomData);
  const activeIds = players.map((player) => player.id);
  const winner = correctAnswers[0] ? roomData.players?.[correctAnswers[0].playerId] : null;
  const payload = {
    phase: 'answer-loading',
    phaseStartedAt: Date.now(),
    [`game/board/${round.categoryId}/cells/${round.points}`]: winner
      ? {
          ...existingCell,
          status: 'claimed',
          answeredBy: winner.id,
          questionId: round.questionId,
        }
      : {
          ...existingCell,
          status: 'missed',
          questionId: round.questionId,
        },
    'game/round/readyPlayers': {},
    'game/round/result': winner
      ? {
          type: 'success',
          winnerId: winner.id,
          winnerName: winner.name,
          scoreDelta: round.points,
        }
      : {
          type: 'fail',
          scoreDelta: 0,
        },
    'game/turnPlayerId': winner
      ? winner.id
      : getNextTurnPlayerId(roomData.game?.turnOrder || [], round.openedBy, activeIds),
  };

  if (winner) {
    payload[`players/${winner.id}/score`] = Number(winner.score || 0) + Number(round.points || 0);
  }

  await update(roomRef(state.roomId), payload);
}

async function completeRound() {
  const board = getBoard();

  if (boardCompleted(board)) {
    await update(roomRef(state.roomId), {
      phase: 'finished',
      phaseStartedAt: Date.now(),
      'game/round': null,
    });
    return;
  }

  await update(roomRef(state.roomId), {
    phase: 'board',
    phaseStartedAt: Date.now(),
    'game/round': null,
  });
}

async function startNewGame() {
  const players = getRoomPlayers();
  const payload = {
    phase: 'colors',
    phaseStartedAt: Date.now(),
    'game/selectedCategories': {},
    'game/board': {},
    'game/round': null,
    'game/result': null,
    'game/turnOrder': players.map((player) => player.id),
    'game/turnPlayerId': players[0]?.id || state.playerId,
  };

  players.forEach((player) => {
    payload[`players/${player.id}/score`] = 0;
    payload[`players/${player.id}/colorId`] = '';
  });

  await update(roomRef(state.roomId), payload);
}

async function maintainRoomFlow() {
  const roomData = state.roomData;

  if (!roomData || state.mutationLocked) {
    return;
  }

  const players = getRoomPlayers(roomData);

  if (!players.length) {
    return;
  }

  if (!roomData.hostId || !roomData.players?.[roomData.hostId]) {
    if (players[0].id === state.playerId) {
      await withRoomMutation(async () => {
        await update(roomRef(state.roomId), {
          hostId: players[0].id,
        });
      });
    }
    return;
  }

  if (!isHost(roomData)) {
    return;
  }

  const round = getRound(roomData);
  const elapsed = Date.now() - Number(roomData.phaseStartedAt || 0);

  if (roomData.phase === 'question-loading' && round) {
    const ready = areAllPlayersReady(roomData);

    if ((ready && elapsed >= MIN_LOADING_MS) || elapsed >= MAX_LOADING_MS) {
      await withRoomMutation(async () => {
        await update(roomRef(state.roomId), {
          phase: 'question',
          phaseStartedAt: Date.now(),
          'game/round/readyPlayers': {},
          'game/round/questionStartedAt': Date.now(),
          'game/round/deadlineAt': Date.now() + ANSWER_TIME_MS,
        });
      });
    }

    return;
  }

  if (roomData.phase === 'question' && round) {
    if (areAllPlayersAnswered(roomData) || Date.now() >= Number(round.deadlineAt || 0)) {
      await withRoomMutation(finalizeRound);
    }

    return;
  }

  if (roomData.phase === 'answer-loading' && round) {
    const ready = areAllPlayersReady(roomData);

    if ((ready && elapsed >= MIN_LOADING_MS) || elapsed >= MAX_LOADING_MS) {
      await withRoomMutation(showResultStage);
    }

    return;
  }

  if (roomData.phase === 'result') {
    if (elapsed >= RESULT_STAGE_MS) {
      await withRoomMutation(completeRound);
    }
  }
}

async function handleImportFile(file) {
  if (!file) {
    return;
  }

  state.upload = {
    status: 'processing',
    progress: 0,
    categoriesCount: 0,
    questionsCount: 0,
    message: 'جاري البدء...',
    fileName: file.name,
    parsed: null,
    error: '',
  };
  render();

  let lastProgress = -1;

  try {
    const parsed = await parseQuestionsFile(file, (progressData) => {
      if (
        progressData.progress === lastProgress &&
        progressData.questionsCount === state.upload.questionsCount
      ) {
        return;
      }

      lastProgress = progressData.progress;
      state.upload = {
        ...state.upload,
        ...progressData,
        status: 'processing',
        fileName: file.name,
        parsed: null,
        error: '',
      };
      render();
    });

    state.upload = {
      status: 'ready',
      progress: 100,
      categoriesCount: parsed.categories.length,
      questionsCount: parsed.questions.length,
      message: 'اكتمل تحليل الملف. اضغط "إضافة إلى فايربيس" لحفظ البيانات.',
      fileName: file.name,
      parsed,
      error: '',
    };
    render();
    showToast('تم تحليل ملف Excel بنجاح.');
  } catch (error) {
    state.upload = {
      status: 'error',
      progress: 0,
      categoriesCount: 0,
      questionsCount: 0,
      message: '',
      fileName: file.name,
      parsed: null,
      error: error.message || 'تعذر قراءة الملف.',
    };
    render();
    showToast(state.upload.error);
  }
}

async function uploadParsedBank() {
  if (!state.upload.parsed) {
    return;
  }

  const parsed = state.upload.parsed;
  state.upload = {
    ...state.upload,
    status: 'uploading',
    progress: 16,
    message: 'جاري تجهيز بيانات فايربيس...',
    error: '',
  };
  render();
  await sleep(120);

  const payload = buildBankPayload(parsed.categories, parsed.questions, {
    importedAt: Date.now(),
    importedFileName: parsed.meta.fileName,
  });

  state.upload = {
    ...state.upload,
    progress: 64,
    message: 'جاري رفع التصنيفات والأسئلة إلى فايربيس...',
  };
  render();
  await sleep(120);

  await set(questionBankRef, payload);

  state.upload = {
    ...state.upload,
    status: 'done',
    progress: 100,
    message: 'تمت إضافة البيانات إلى فايربيس بنجاح.',
    parsed: null,
  };
  render();
  showToast('تم تحديث بنك الأسئلة في فايربيس.');
}

async function saveBank(categories, questions, message) {
  const payload = buildBankPayload(categories, questions, {
    importedAt: Date.now(),
    importedFileName: state.bank.meta?.importedFileName || '',
  });

  await set(questionBankRef, payload);
  state.modal = null;
  render();
  showToast(message);
}

async function deleteQuestion(questionId) {
  const question = state.bank.questionsById[questionId];

  if (!question) {
    return;
  }

  const confirmed = window.confirm('هل تريد حذف هذا السؤال نهائياً؟');

  if (!confirmed) {
    return;
  }

  const questions = state.bank.questions.filter((item) => item.id !== questionId);
  const categories = state.bank.categories;

  await saveBank(categories, questions, 'تم حذف السؤال.');
}

async function deleteCategory(categoryId) {
  const category = state.bank.categoriesById[categoryId];

  if (!category) {
    return;
  }

  const confirmed = window.confirm('سيتم حذف التصنيف وكل أسئلته. هل تود المتابعة؟');

  if (!confirmed) {
    return;
  }

  const categories = state.bank.categories.filter((item) => item.id !== categoryId);
  const questions = state.bank.questions.filter((question) => question.categoryId !== categoryId);

  await saveBank(categories, questions, 'تم حذف التصنيف وكل أسئلته.');
}

async function saveQuestionModal(form) {
  const questionId = form.getAttribute('data-question-modal-form');
  const existing = state.bank.questionsById[questionId];

  if (!existing) {
    return;
  }

  const formData = new FormData(form);
  const categoryId = normalizeText(formData.get('categoryId'));
  const questionText = normalizeText(formData.get('questionText'));
  const options = [0, 1, 2, 3].map((index) => {
    const label = ['أ', 'ب', 'ج', 'د'][index];
    const key = ['A', 'B', 'C', 'D'][index];
    const text = normalizeText(formData.get(`option_${index}`));
    return {
      label,
      key,
      text,
      full: `${label}) ${text}`,
    };
  });
  const correctIndex = Number(formData.get('correctIndex'));
  const points = Number(formData.get('points'));

  if (!questionText || options.some((option) => !option.text)) {
    showToast('أكمل جميع الحقول أولاً.');
    return;
  }

  const questions = state.bank.questions.map((question) =>
    question.id === questionId
      ? {
          ...question,
          categoryId,
          text: questionText,
          options,
          correctOptionIndex: correctIndex,
          correctOptionKey: options[correctIndex].key,
          correctAnswerText: options[correctIndex].text,
          correctAnswerFull: options[correctIndex].full,
          answerRaw: options[correctIndex].full,
          optionsRaw: options.map((option) => option.full).join(' '),
          points,
        }
      : question,
  );

  await saveBank(state.bank.categories, questions, 'تم حفظ تعديل السؤال.');
}

async function saveCategoryModal(form) {
  const categoryId = form.getAttribute('data-category-modal-form');
  const category = state.bank.categoriesById[categoryId];

  if (!category) {
    return;
  }

  const formData = new FormData(form);
  const categoryName = normalizeText(formData.get('categoryName'));

  if (!categoryName) {
    showToast('اكتب اسم التصنيف.');
    return;
  }

  const categories = state.bank.categories.map((item) =>
    item.id === categoryId
      ? {
          ...item,
          name: categoryName,
        }
      : item,
  );

  await saveBank(categories, state.bank.questions, 'تم حفظ تعديل التصنيف.');
}

async function sendChatMessage(text) {
  const message = normalizeText(text).slice(0, CHAT_MESSAGE_LIMIT);

  if (!message || !state.roomId || !getCurrentPlayer()) {
    return;
  }

  const messageId = uid('msg');

  await update(roomRef(state.roomId), {
    [`chat/messages/${messageId}`]: {
      id: messageId,
      playerId: state.playerId,
      playerName: getCurrentPlayer()?.name || '',
      text: message,
      createdAt: Date.now(),
    },
  });

  markChatSeen();
}

function subscribeQuestionBank() {
  if (unsubscribeQuestionBank) {
    unsubscribeQuestionBank();
  }

  unsubscribeQuestionBank = onValue(questionBankRef, (snapshot) => {
    state.bank = normalizeBankSnapshot(snapshot.val());
    render();
    void maintainRoomFlow();
  });
}

function subscribeRoom(roomId) {
  if (unsubscribeRoom) {
    unsubscribeRoom();
  }

  if (!roomId) {
    state.roomLookupResolved = false;
    state.roomData = null;
    render();
    return;
  }

  state.roomLookupResolved = false;
  unsubscribeRoom = onValue(roomRef(roomId), (snapshot) => {
    state.roomLookupResolved = true;
    state.roomData = snapshot.val();

    if (!state.roomData) {
      state.playerId = '';
      state.chatOpen = false;
      clearRoomSession(roomId);
      render();
      return;
    }

    const currentPlayer = getCurrentPlayer(state.roomData);

    if (currentPlayer) {
      persistRoomSession(roomId, currentPlayer);
      void ensureDisconnectRegistration(roomId, currentPlayer.id);
    } else if (state.playerId && !state.roomData.players?.[state.playerId]) {
      const session = getSavedRoomSession(roomId);
      if (!session?.playerId || session.playerId !== state.playerId) {
        state.playerId = '';
      }
    }

    render();
    void maybeRestoreSavedSession();
    void markReadyIfNeeded();
    void maintainRoomFlow();
  });
}

function handleSecretAdminTap() {
  const now = Date.now();
  state.secretTapTimes = [...state.secretTapTimes.filter((time) => now - time < 1200), now];

  if (state.secretTapTimes.length >= 5) {
    state.secretTapTimes = [];
    state.adminUnlocked = true;
    setStoredString(STORAGE_KEYS.adminUnlocked, '1');
    render();
    showToast('تم إظهار زر Admin.');
  }
}

async function handleClick(event) {
  const target = event.target.closest('[data-open-admin],[data-exit-admin],[data-cancel-room-link],[data-copy-room-code],[data-copy-room-link],[data-next-from-lobby],[data-leave-room],[data-next-from-colors],[data-toggle-category],[data-start-game],[data-pick-color],[data-pick-cell],[data-answer-option],[data-open-chat],[data-close-chat],[data-close-modal],[data-edit-question],[data-delete-question],[data-edit-category],[data-delete-category],[data-upload-parsed-bank],[data-new-game]');

  if (!target) {
    return;
  }

  if (target.hasAttribute('data-open-admin')) {
    window.location.hash = 'admin';
    render();
    return;
  }

  if (target.hasAttribute('data-exit-admin')) {
    window.location.hash = '';
    render();
    return;
  }

  if (target.hasAttribute('data-cancel-room-link')) {
    state.roomId = '';
    state.roomData = null;
    state.roomLookupResolved = false;
    state.playerId = '';
    state.restoreAttemptedRoomId = '';
    setRoomIdInUrl('');
    if (unsubscribeRoom) {
      unsubscribeRoom();
      unsubscribeRoom = null;
    }
    render();
    return;
  }

  if (target.hasAttribute('data-copy-room-code')) {
    await copyText(state.roomId);
    showToast('تم نسخ رمز الغرفة.');
    return;
  }

  if (target.hasAttribute('data-copy-room-link')) {
    await copyText(getShareLink());
    showToast('تم نسخ رابط الغرفة.');
    return;
  }

  if (target.hasAttribute('data-next-from-lobby')) {
    await withRoomMutation(nextFromLobby);
    return;
  }

  if (target.hasAttribute('data-leave-room')) {
    await leaveRoom();
    return;
  }

  if (target.hasAttribute('data-next-from-colors')) {
    await withRoomMutation(nextFromColors);
    return;
  }

  if (target.hasAttribute('data-start-game')) {
    await withRoomMutation(startGame);
    return;
  }

  if (target.hasAttribute('data-upload-parsed-bank')) {
    await uploadParsedBank();
    return;
  }

  if (target.hasAttribute('data-open-chat')) {
    state.chatOpen = true;
    markChatSeen();
    render();
    return;
  }

  if (target.hasAttribute('data-close-chat')) {
    state.chatOpen = false;
    render();
    return;
  }

  if (target.hasAttribute('data-close-modal')) {
    state.modal = null;
    render();
    return;
  }

  if (target.hasAttribute('data-edit-question')) {
    state.modal = { type: 'question', id: target.getAttribute('data-edit-question') };
    render();
    return;
  }

  if (target.hasAttribute('data-delete-question')) {
    await deleteQuestion(target.getAttribute('data-delete-question'));
    return;
  }

  if (target.hasAttribute('data-edit-category')) {
    state.modal = { type: 'category', id: target.getAttribute('data-edit-category') };
    render();
    return;
  }

  if (target.hasAttribute('data-delete-category')) {
    await deleteCategory(target.getAttribute('data-delete-category'));
    return;
  }

  if (target.hasAttribute('data-new-game')) {
    await withRoomMutation(startNewGame);
    return;
  }

  if (target.hasAttribute('data-toggle-category')) {
    await toggleCategory(target.getAttribute('data-toggle-category'));
    return;
  }

  if (target.hasAttribute('data-pick-color')) {
    await chooseColor(target.getAttribute('data-pick-color'));
    return;
  }

  if (target.hasAttribute('data-pick-cell')) {
    const [categoryId, points] = String(target.getAttribute('data-pick-cell')).split(':');
    await pickBoardCell(categoryId, Number(points));
    return;
  }

  if (target.hasAttribute('data-answer-option')) {
    await submitAnswer(target.getAttribute('data-answer-option'));
  }
}

async function handleSubmit(event) {
  const homeForm = event.target.closest('[data-home-form]');
  const chatForm = event.target.closest('[data-chat-form]');
  const questionModalForm = event.target.closest('[data-question-modal-form]');
  const categoryModalForm = event.target.closest('[data-category-modal-form]');

  if (homeForm) {
    event.preventDefault();
    const formData = new FormData(homeForm);
    const playerName = normalizeText(formData.get('playerName'));

    try {
      if (state.roomId) {
        await joinRoomWithPlayer(playerName);
      } else {
        await createRoomWithPlayer(playerName);
      }
      render();
    } catch (error) {
      console.error(error);
      showToast(error.message || 'تعذر تنفيذ الطلب.');
    }

    return;
  }

  if (chatForm) {
    event.preventDefault();
    const formData = new FormData(chatForm);
    await sendChatMessage(formData.get('message'));
    chatForm.reset();
    render();
    return;
  }

  if (questionModalForm) {
    event.preventDefault();
    await saveQuestionModal(questionModalForm);
    return;
  }

  if (categoryModalForm) {
    event.preventDefault();
    await saveCategoryModal(categoryModalForm);
  }
}

function handleChange(event) {
  const importInput = event.target.closest('[data-import-file]');

  if (importInput) {
    void handleImportFile(importInput.files?.[0]);
    return;
  }

  if (event.target.name === 'adminSearch') {
    state.adminFilters.search = event.target.value;
    render();
    return;
  }

  if (event.target.name === 'adminCategoryFilter') {
    state.adminFilters.categoryId = event.target.value;
    render();
  }
}

function handleInput(event) {
  if (event.target.name === 'adminSearch') {
    state.adminFilters.search = event.target.value;
    render();
  }
}

function handleHashChange() {
  render();
}

window.setInterval(() => {
  if (!state.roomData || !getCurrentPlayer()) {
    return;
  }

  if (['question-loading', 'question', 'answer-loading', 'result'].includes(state.roomData.phase)) {
    render();
    void maintainRoomFlow();
  }
}, 500);

async function bootstrap() {
  subscribeQuestionBank();

  if (state.roomId) {
    subscribeRoom(state.roomId);
  } else {
    render();
  }
}

document.addEventListener('pointerdown', handleSecretAdminTap);
document.addEventListener('click', (event) => {
  void handleClick(event);
});
document.addEventListener('submit', (event) => {
  void handleSubmit(event);
});
document.addEventListener('change', handleChange);
document.addEventListener('input', handleInput);
window.addEventListener('hashchange', handleHashChange);

bootstrap().catch((error) => {
  console.error(error);
  root.innerHTML = `
    <main class="screen-shell">
      <section class="panel">
        <div class="panel-body">
          <h1 class="hero-title">تعذر تشغيل التطبيق</h1>
          <p class="hero-subtitle">${escapeHtml(error.message || 'حدث خطأ أثناء التشغيل.')}</p>
        </div>
      </section>
    </main>
  `;
});
