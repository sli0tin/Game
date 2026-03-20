const STORAGE_KEY = "arena-quiz-state-v1";
const SHUFFLE_MEMORY_KEY = "arena-quiz-shuffle-memory-v1";
const POINT_VALUES = [200, 400, 600];
const OPTION_KEYS = ["A", "B", "C", "D"];
const WRONG_PENALTY = 50;
const DESKTOP_SHARE_WIDTH = 1440;
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
  "#a855f7",
  "#22c55e",
  "#fb7185",
  "#f97316",
  "#2dd4bf",
];

const appElement = document.querySelector("#app");
const toastElement = document.querySelector("#toast");

let toastTimer = null;
let shuffleMemory = loadShuffleMemory();
let state = loadState() || createInitialState();

render();

appElement.addEventListener("click", onAppClick);
appElement.addEventListener("change", onAppChange);
appElement.addEventListener("input", onAppInput);
appElement.addEventListener("submit", onAppSubmit);

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
    { name: "فريق الأبطال", color: TEAM_COLORS[0] },
    { name: "فريق النجوم", color: TEAM_COLORS[1] },
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

function createTeamState(team, index) {
  return {
    id: `team-${index}`,
    name: team.name,
    color: team.color,
    points: 0,
    abilities: createAbilityState(),
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

function normalizeStoredTeams(teams, teamDraft) {
  return [0, 1].map((index) => {
    const draftTeam = teamDraft[index] || createInitialTeamDraft()[index];
    const storedTeam = teams?.[index] || {};

    return {
      ...createTeamState(
        {
          name: storedTeam.name || draftTeam.name,
          color: storedTeam.color || draftTeam.color,
        },
        index
      ),
      ...storedTeam,
      abilities: mergeAbilityState(storedTeam.abilities),
    };
  });
}

function normalizeCurrentQuestion(currentQuestion) {
  if (!currentQuestion) {
    return null;
  }

  return {
    ...currentQuestion,
    multiplier: Number(currentQuestion.multiplier) || 1,
    removedOptionKeys: Array.isArray(currentQuestion.removedOptionKeys)
      ? currentQuestion.removedOptionKeys
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
    teams: teamDraft.map((team, index) => createTeamState(team, index)),
    board: [],
    activeTeamIndex: null,
    currentQuestion: null,
    pendingAnswerKey: "",
    confirmAnswer: false,
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

    const teamDraft = Array.isArray(parsed.teamDraft) && parsed.teamDraft.length
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

function commit(nextState) {
  state = nextState;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function resetAllState() {
  localStorage.removeItem(STORAGE_KEY);
  state = createInitialState();
  render();
}

function render() {
  const effectivePhase =
    state.phase === "answer"
      ? `answer-${state.lastResult?.type || (state.lastResult?.isCorrect ? "correct" : "wrong")}`
      : state.phase;
  document.body.dataset.phase = effectivePhase;

  switch (state.phase) {
    case "category-select":
      appElement.innerHTML = renderCategorySelectionScreen();
      break;
    case "team-setup":
      appElement.innerHTML = renderTeamSetupScreen();
      break;
    case "board":
      appElement.innerHTML = renderBoardScreen();
      break;
    case "question":
      appElement.innerHTML = renderQuestionScreen();
      break;
    case "answer":
      appElement.innerHTML = renderAnswerScreen();
      break;
    case "winner":
      appElement.innerHTML = renderWinnerScreen();
      break;
    case "upload":
    default:
      appElement.innerHTML = renderUploadScreen();
      break;
  }
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
            يدعم الموقع نقاط <strong>200 / 400 / 600</strong> كما في النموذج الذي أرسلته.
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
              اختيار التصنيفات، إعداد الفريقين، ثم لوحة اللعب الثنائية.
            </p>
          </div>

          <div class="mini-stat-list">
            <div class="mini-stat">
              <strong>6</strong>
              <span>عدد التصنيفات المعروضة في المباراة الواحدة</span>
            </div>
            <div class="mini-stat">
              <strong>2</strong>
              <span>فريقان بألوان مستقلة ونقاط محفوظة محليًا</span>
            </div>
            <div class="mini-stat">
              <strong>0</strong>
              <span>تكرار للأسئلة داخل المباراة الحالية</span>
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
        : `هذه هي التصنيفات المتبقية في الجلسة الحالية، وهي محددة مسبقًا.`;

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
              const selectableAttr = lockedSelection || exhausted
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
            التالي
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
        <h2 class="section-title">أسماء الفريقين وألوانهما</h2>
        <p class="section-subtitle">
          اكتب اسم كل فريق، اختر له لونًا، ثم ابدأ المباراة. كل فريق سيملك جانبًا
          واحدًا فقط من بطاقات التصنيفات.
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
                const label = index === 0 ? "الفريق الأيسر" : "الفريق الأيمن";

                return `
                  <article class="team-card">
                    <h3>${label}</h3>
                    <p class="helper-text">
                      هذا الفريق سيتحكم في الجهة ${index === 0 ? "اليسرى" : "اليمنى"} من الأزرار.
                    </p>
                    <input
                      type="text"
                      value="${escapeHtmlAttribute(team.name)}"
                      placeholder="اسم الفريق"
                      maxlength="30"
                      data-team-name-index="${index}"
                    />
                    <div class="color-picker">
                      ${TEAM_COLORS.map(
                        (color) => `
                          <button
                            class="color-swatch ${team.color === color ? "active" : ""}"
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
                        team.name || `الفريق ${index + 1}`
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
  const activeTeam = Number.isInteger(state.activeTeamIndex)
    ? state.teams[state.activeTeamIndex]
    : null;
  const remaining = countRemainingSlots(state.board);
  const total = countTotalAvailableSlots(state.board);
  const pendingDoubleTeams = state.teams.filter((team) => team.abilities.double.pending);
  const boardPrompt = activeTeam ? `الدور الآن على ${activeTeam.name}` : "";

  return `
    <section class="screen">
      <div class="board-view" data-share-root>
        ${renderScorePanel(state.teams[0], 0, 0 === state.activeTeamIndex)}

        <div class="board-center">
          <div class="panel board-banner">
            <div class="panel-inner" style="padding:0;">
              <h2 class="section-title">لوحة التحدي</h2>
              ${
                boardPrompt
                  ? `<p class="section-subtitle">${escapeHtml(boardPrompt)}</p>`
                  : ""
              }
              <div class="helper-row">
                <div class="pill">المتبقي: ${formatNumber(remaining)} / ${formatNumber(total)}</div>
                <div class="pill">اختر من جهة الفريق صاحب الدور فقط</div>
                ${
                  pendingDoubleTeams.length
                    ? `<div class="pill">2× جاهز لـ ${pendingDoubleTeams
                        .map(
                          (team) =>
                            `<span style="color:${team.color};">${escapeHtml(team.name)}</span>`
                        )
                        .join(" / ")}</div>`
                    : ""
                }
              </div>
            </div>
          </div>

          <div class="board-grid">
            ${state.board.map((card) => renderBoardCard(card)).join("")}
          </div>

          <div class="btn-row no-capture">
            <button class="btn btn-secondary" data-action="share-current">إرسال</button>
            <button class="btn btn-ghost" data-action="reset-all">تغيير الملف</button>
          </div>
        </div>

        ${renderScorePanel(state.teams[1], 1, 1 === state.activeTeamIndex)}
      </div>
    </section>
  `;
}

function renderQuestionScreen() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion) {
    return renderFallbackScreen("لا يوجد سؤال نشط حاليًا.");
  }

  const team = state.teams[currentQuestion.teamIndex];
  const opponentIndex = getOpponentTeamIndex(currentQuestion.teamIndex);
  const opponentTeam = state.teams[opponentIndex];
  const selectedKey = state.pendingAnswerKey;
  const selectedOption = currentQuestion.question.options.find(
    (option) => option.key === selectedKey
  );
  const visibleOptions = currentQuestion.question.options.filter(
    (option) => !currentQuestion.removedOptionKeys.includes(option.key)
  );
  const canUseRemoveTwo =
    !team.abilities.removeTwo.used &&
    !state.confirmAnswer &&
    visibleOptions.length > 2 &&
    currentQuestion.question.options.filter(
      (option) =>
        option.key !== currentQuestion.question.answerKey &&
        !currentQuestion.removedOptionKeys.includes(option.key)
    ).length > 1;
  const canUseBlock = !opponentTeam.abilities.block.used && !state.confirmAnswer;
  const displayedPoints = currentQuestion.question.points * currentQuestion.multiplier;

  return `
    <section class="screen question-shell">
      <div class="question-card" data-share-root style="border-color:${team.color}">
        <div class="question-meta">
          <span class="pill">${escapeHtml(currentQuestion.categoryName)}</span>
          <span class="pill">${escapeHtml(team.name)}</span>
          <span class="pill">${formatNumber(displayedPoints)} نقطة</span>
          ${
            currentQuestion.multiplier > 1
              ? `<span class="pill" style="color:${team.color};">دبل النقاط مفعّل</span>`
              : ""
          }
        </div>
        <h2 class="question-text">${escapeHtml(currentQuestion.question.text)}</h2>

        <div class="question-tools">
          <div class="question-tool-group">
            <button
              class="ability-icon ${team.abilities.removeTwo.used ? "used" : ""}"
              type="button"
              title="حذف إجابتين"
              ${canUseRemoveTwo ? "" : "disabled"}
              data-action="use-remove-two"
            >
              ${ABILITY_META.removeTwo.icon}
            </button>
          </div>

          ${
            !opponentTeam.abilities.block.used
              ? `
                <div class="question-tool-group">
                  <button
                    class="ability-icon danger"
                    type="button"
                    title="بلوك"
                    ${canUseBlock ? "" : "disabled"}
                    data-action="use-block"
                  >
                    ${ABILITY_META.block.icon}
                  </button>
                </div>
              `
              : ""
          }
        </div>

        <div class="options-list">
          ${visibleOptions
            .map(
              (option) => `
                <button
                  class="option-button ${selectedKey === option.key ? "selected" : ""}"
                  type="button"
                  data-action="select-option"
                  data-option-key="${option.key}"
                >
                  <strong>(${displayOptionKey(option.key)})</strong>
                  ${escapeHtml(option.label)}
                </button>
              `
            )
            .join("")}
        </div>

        <div class="btn-row no-capture" style="justify-content:center;">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
        </div>
      </div>

      ${
        state.confirmAnswer && selectedOption
          ? `
            <div class="modal-backdrop">
              <div class="modal-card">
                <h3 style="margin-top:0;">تأكيد الإجابة</h3>
                <p>
                  هل تريد اعتماد هذه الإجابة للفريق <strong>${escapeHtml(team.name)}</strong>؟
                </p>
                <p style="margin-top:12px;">
                  <strong>(${displayOptionKey(selectedOption.key)})</strong>
                  ${escapeHtml(selectedOption.label)}
                </p>
                <div class="btn-row">
                  <button class="btn btn-primary" data-action="confirm-answer">تأكيد</button>
                  <button class="btn btn-ghost" data-action="cancel-confirm">إلغاء</button>
                </div>
              </div>
            </div>
          `
          : ""
      }
    </section>
  `;
}

function renderAnswerScreen() {
  const result = state.lastResult;
  if (!result) {
    return renderFallbackScreen("لم يتم العثور على نتيجة السؤال.");
  }

  const team = state.teams[result.teamIndex];
  const resultType = result.type || (result.isCorrect ? "correct" : "wrong");
  const blockingTeam =
    Number.isInteger(result.blockingTeamIndex) && state.teams[result.blockingTeamIndex]
      ? state.teams[result.blockingTeamIndex]
      : null;
  const emoji =
    resultType === "correct" ? "🥳" : resultType === "wrong" ? "😔" : "⛔";
  const title =
    resultType === "correct"
      ? "إجابة صحيحة"
      : resultType === "wrong"
        ? "إجابة غير صحيحة"
        : "تم استخدام البلوك";
  const subtitle =
    resultType === "correct"
      ? `${team.name} أحرز نقاط هذا السؤال.`
      : resultType === "wrong"
        ? `${team.name} خسر نقاط هذا السؤال بسبب الإجابة الخاطئة.`
        : `${blockingTeam?.name || "فريق الخصم"} منع ${team.name} من الإجابة، وتم إطفاء السؤال.`;
  const scoreClass =
    resultType === "correct" ? "success" : resultType === "wrong" ? "fail" : "blocked";

  return `
    <section class="screen result-shell">
      <div class="result-card ${scoreClass}" data-share-root style="border-color:${team.color}">
        <div class="emoji">${emoji}</div>
        <h2 class="section-title">${title}</h2>
        <p class="section-subtitle">${escapeHtml(subtitle)}</p>

        <div class="score-big ${scoreClass}">
          ${formatSignedNumber(result.scoreDelta)}
        </div>

        <div class="answer-grid">
          <div class="answer-stat">
            <strong>${escapeHtml(result.categoryName)}</strong>
            <span>التصنيف</span>
          </div>
          <div class="answer-stat">
            <strong>${
              resultType === "blocked"
                ? escapeHtml(blockingTeam?.name || "")
                : escapeHtml(result.correctAnswer)
            }</strong>
            <span>${resultType === "blocked" ? "الفريق الذي فعّل البلوك" : "الإجابة الصحيحة"}</span>
          </div>
          <div class="answer-stat">
            <strong>${
              resultType === "blocked"
                ? result.usedDouble
                  ? "دبل النقاط احترق"
                  : "السؤال أُغلق"
                : escapeHtml(result.selectedAnswer)
            }</strong>
            <span>${resultType === "blocked" ? "حالة السؤال" : "الإجابة المختارة"}</span>
          </div>
        </div>

        ${
          result.usedDouble
            ? `<div class="helper-row" style="justify-content:center;"><div class="pill" style="color:${team.color};">تم تطبيق دبل النقاط ×2</div></div>`
            : ""
        }

        <div class="btn-row no-capture" style="justify-content:center;">
          <button class="btn btn-secondary" data-action="share-current">إرسال</button>
          <button class="btn btn-primary" data-action="next-after-answer">التالي</button>
        </div>
      </div>
    </section>
  `;
}

function renderWinnerScreen() {
  const teams = [...state.teams].sort((left, right) => right.points - left.points);
  const [winner, loser] = teams;
  const isTie = winner && loser && winner.points === loser.points;

  return `
    <section class="screen winner-shell">
      <div class="winner-card" data-share-root style="border-color:${winner?.color || "#ffd166"}">
        <div class="winner-crown">${isTie ? "🤝" : "👑"}</div>
        <h2 class="section-title">${isTie ? "انتهت المباراة بالتعادل" : "الفريق الفائز"}</h2>
        <h3 class="winner-name" style="color:${winner?.color || "#ffd166"};">
          ${escapeHtml(isTie ? "تعادل الفريقان" : winner?.name || "")}
        </h3>
        <p class="winner-points">
          ${
            isTie
              ? `كل فريق أنهى المباراة بـ ${formatNumber(winner?.points || 0)} نقطة`
              : `${escapeHtml(winner?.name || "")} جمع ${formatNumber(winner?.points || 0)} نقطة`
          }
        </p>

        <div class="winner-grid">
          <div class="winner-badge">
            <h3 style="margin-top:0;color:${winner?.color || "#ffd166"};">${
              escapeHtml(winner?.name || "")
            }</h3>
            <p style="margin:0;color:var(--muted);">
              ${formatNumber(winner?.points || 0)} نقطة
            </p>
          </div>
          <div class="loser-card">
            <h3 style="margin-top:0;color:${loser?.color || "#ff8a8a"};">${
              escapeHtml(loser?.name || "")
            }</h3>
            <p style="margin:0;">${formatNumber(loser?.points || 0)} نقطة</p>
          </div>
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

function renderScorePanel(team, teamIndex, isActive) {
  const turnLabel =
    state.activeTeamIndex === null
      ? "بانتظار تحديد الفريق الذي يبدأ"
      : isActive
        ? "هذا هو الدور الحالي"
        : "بانتظار الدور التالي";
  const canUseDouble =
    (!team.abilities.double.used || team.abilities.double.pending) &&
    (state.activeTeamIndex === null || state.activeTeamIndex === teamIndex);

  return `
    <aside
      class="score-panel team-slot-${teamIndex} ${isActive ? "active" : ""}"
      style="--team-color:${team.color};border-color:${team.color}33;"
    >
      <div class="team-mark">${escapeHtml(team.name)}</div>
      <div class="points-value">${formatNumber(team.points)}</div>
      <div class="turn-badge">${escapeHtml(turnLabel)}</div>
      <div class="team-abilities">
        ${renderAbilityButton({
          icon: ABILITY_META.double.icon,
          label: ABILITY_META.double.label,
          action: canUseDouble ? "activate-double" : "",
          dataAttributes: `data-team-index="${teamIndex}"`,
          used: team.abilities.double.used && !team.abilities.double.pending,
          active: team.abilities.double.pending,
          disabled: !canUseDouble,
          title: team.abilities.double.pending
            ? "سيتم تطبيق الدبل على السؤال التالي"
            : ABILITY_META.double.label,
        })}
        ${renderAbilityButton({
          icon: ABILITY_META.removeTwo.icon,
          label: ABILITY_META.removeTwo.label,
          action: "ability-hint",
          dataAttributes: `data-message="ميزة حذف إجابتين تُستخدم من داخل صفحة السؤال."`,
          used: team.abilities.removeTwo.used,
          disabled: false,
          title: ABILITY_META.removeTwo.label,
        })}
        ${renderAbilityButton({
          icon: ABILITY_META.block.icon,
          label: ABILITY_META.block.label,
          action: "ability-hint",
          dataAttributes: `data-message="ميزة البلوك تُستخدم من داخل صفحة السؤال."`,
          used: team.abilities.block.used,
          disabled: false,
          title: ABILITY_META.block.label,
        })}
      </div>
      ${
        team.abilities.double.pending
          ? `<div class="ability-note">2× جاهز للسؤال التالي</div>`
          : ""
      }
    </aside>
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
  const classes = [
    "ability-icon",
    used ? "used" : "",
    active ? "active" : "",
  ]
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
      ${disabled || used ? "disabled" : ""}
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
      <div class="category-rails">
        <div class="stack">
          ${POINT_VALUES.map((pointValue) =>
            renderPointButton(card, "left", pointValue)
          ).join("")}
        </div>

        <div class="card-core">
          <div aria-hidden="true"></div>
        </div>

        <div class="stack">
          ${POINT_VALUES.map((pointValue) =>
            renderPointButton(card, "right", pointValue)
          ).join("")}
        </div>
      </div>
    </article>
  `;
}

function renderPointButton(card, side, pointValue) {
  const slot = card.slots[side][pointValue];
  const teamIndex = side === "left" ? 0 : 1;
  const team = state.teams[teamIndex];
  const isLockedByTurn =
    Number.isInteger(state.activeTeamIndex) && state.activeTeamIndex !== teamIndex;
  const disabled = !slot || slot.used || slot.unavailable || isLockedByTurn;
  const classes = [
    "point-button",
    slot?.used ? "used" : "",
    slot?.unavailable ? "unavailable" : "",
    isLockedByTurn && !slot?.used && !slot?.unavailable ? "turn-locked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = slot?.used
    ? "تم استخدام هذا السؤال"
    : slot?.unavailable
      ? "لا يوجد سؤال متاح لهذه الخانة"
      : isLockedByTurn
        ? `الدور الآن على ${state.teams[state.activeTeamIndex].name}`
        : team.name;

  return `
    <button
      class="${classes}"
      style="--team-color:${team.color};"
      ${disabled ? "disabled" : ""}
      data-action="launch-slot"
      data-category-id="${escapeHtmlAttribute(card.categoryId)}"
      data-side="${side}"
      data-point-value="${pointValue}"
      title="${escapeHtmlAttribute(title)}"
    >
      ${formatNumber(pointValue)}
    </button>
  `;
}

function onAppClick(event) {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) {
    return;
  }

  const { action } = actionElement.dataset;

  switch (action) {
    case "start-flow":
      startFlow();
      break;
    case "download-template":
      downloadExcelTemplate();
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
      activateDoubleForTeam(Number(actionElement.dataset.teamIndex));
      break;
    case "ability-hint":
      showToast(actionElement.dataset.message || "تُستخدم هذه الميزة في موضع مختلف.");
      break;
    case "launch-slot":
      openQuestion(
        actionElement.dataset.categoryId || "",
        actionElement.dataset.side || "",
        Number(actionElement.dataset.pointValue)
      );
      break;
    case "use-remove-two":
      useRemoveTwo();
      break;
    case "use-block":
      useBlock();
      break;
    case "select-option":
      selectOption(actionElement.dataset.optionKey || "");
      break;
    case "cancel-confirm":
      commit({
        ...state,
        confirmAnswer: false,
      });
      break;
    case "confirm-answer":
      evaluateAnswer();
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

function onAppChange(event) {
  const target = event.target;

  if (target.id === "excel-file") {
    const [file] = target.files || [];
    if (file) {
      handleFileSelection(file);
    }
    return;
  }

  if (target.dataset.teamNameIndex) {
    const teamIndex = Number(target.dataset.teamNameIndex);
    syncTeamName(teamIndex, target.value, true);
  }
}

function onAppInput(event) {
  const target = event.target;
  if (!target.dataset.teamNameIndex) {
    return;
  }

  syncTeamName(Number(target.dataset.teamNameIndex), target.value, false);
}

function onAppSubmit(event) {
  if (event.target.id !== "teams-form") {
    return;
  }

  event.preventDefault();
  finalizeTeamsAndStartBoard();
}

function startFlow() {
  if (!state.categories.length) {
    showToast("ارفع ملف الإكسل أولاً.");
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

  commit({
    ...state,
    phase: "team-setup",
    selectedCategoryIds: selectedIds,
  });
}

function pickTeamColor(teamIndex, color) {
  if (!TEAM_COLORS.includes(color)) {
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
    name: (team.name || "").trim() || `الفريق ${index + 1}`,
    color: team.color,
  }));

  const uniqueNames = new Set(cleanedDraft.map((team) => normalizeLooseText(team.name)));
  const uniqueColors = new Set(cleanedDraft.map((team) => team.color));

  if (uniqueNames.size < cleanedDraft.length) {
    showToast("اختر اسمين مختلفين للفريقين.");
    return;
  }

  if (uniqueColors.size < cleanedDraft.length) {
    showToast("اختر لونين مختلفين للفريقين.");
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
    teams: cleanedDraft.map((team, index) => createTeamState(team, index)),
    board,
    activeTeamIndex: null,
    currentQuestion: null,
    pendingAnswerKey: "",
    confirmAnswer: false,
    lastResult: null,
  });
}

function buildBoard(selectedCategoryIds) {
  const usedQuestionIdSet = new Set(state.sessionUsedQuestionIds);
  const categories = state.categories.filter((category) =>
    selectedCategoryIds.includes(category.id)
  );

  return categories.map((category) => {
    const pointPools = {};
    POINT_VALUES.forEach((pointValue) => {
      const availableQuestions = (category.questionsByPoints[String(pointValue)] || []).filter(
        (question) => !usedQuestionIdSet.has(question.id)
      );
      pointPools[pointValue] = getRandomizedQuestionPool(
        availableQuestions,
        state.fileSignature,
        `${category.id}:${pointValue}`
      );
    });

    const slots = {
      left: {},
      right: {},
    };

    POINT_VALUES.forEach((pointValue) => {
      const leftQuestion = pointPools[pointValue].shift() || null;
      const rightQuestion = pointPools[pointValue].shift() || null;

      slots.left[pointValue] = createSlot(leftQuestion, 0, "left", pointValue);
      slots.right[pointValue] = createSlot(rightQuestion, 1, "right", pointValue);
    });

    return {
      categoryId: category.id,
      name: category.name,
      slots,
    };
  });
}

function createSlot(question, teamIndex, side, pointValue) {
  return {
    id: `${side}-${pointValue}-${question?.id || `empty-${teamIndex}-${pointValue}`}`,
    teamIndex,
    side,
    pointValue,
    used: false,
    unavailable: !question,
    question,
  };
}

function openQuestion(categoryId, side, pointValue) {
  if (!categoryId || !side || !POINT_VALUES.includes(pointValue)) {
    return;
  }

  const boardCard = state.board.find((card) => card.categoryId === categoryId);
  if (!boardCard) {
    return;
  }

  const slot = boardCard.slots?.[side]?.[pointValue];
  const teamIndex = side === "left" ? 0 : 1;

  if (!slot || slot.used || slot.unavailable) {
    return;
  }

  if (Number.isInteger(state.activeTeamIndex) && state.activeTeamIndex !== teamIndex) {
    showToast(`الدور الآن على ${state.teams[state.activeTeamIndex].name}.`);
    return;
  }

  const answeringTeam = state.teams[teamIndex];
  const multiplier = answeringTeam.abilities.double.pending ? 2 : 1;
  const updatedTeams = state.teams.map((team, index) =>
    index === teamIndex
      ? {
          ...team,
          abilities: {
            ...team.abilities,
            double: {
              ...team.abilities.double,
              pending: false,
            },
          },
        }
      : team
  );

  commit({
    ...state,
    phase: "question",
    teams: updatedTeams,
    currentQuestion: {
      categoryId,
      side,
      pointValue,
      teamIndex,
      categoryName: boardCard.name,
      question: slot.question,
      multiplier,
      removedOptionKeys: [],
    },
    pendingAnswerKey: "",
    confirmAnswer: false,
  });
}

function selectOption(optionKey) {
  if (!state.currentQuestion) {
    return;
  }

  if (state.currentQuestion.removedOptionKeys.includes(optionKey)) {
    return;
  }

  const selectedOption = state.currentQuestion.question.options.find(
    (option) => option.key === optionKey
  );
  if (!selectedOption) {
    return;
  }

  commit({
    ...state,
    pendingAnswerKey: optionKey,
    confirmAnswer: true,
  });
}

function activateDoubleForTeam(teamIndex) {
  if (teamIndex < 0 || teamIndex > 1) {
    return;
  }

  const team = state.teams[teamIndex];
  if (!team) {
    return;
  }

  if (Number.isInteger(state.activeTeamIndex) && state.activeTeamIndex !== teamIndex) {
    showToast(`الدور الآن على ${state.teams[state.activeTeamIndex].name}.`);
    return;
  }

  if (team.abilities.double.used && !team.abilities.double.pending) {
    return;
  }

  const updatedTeams = state.teams.map((currentTeam, index) =>
    index === teamIndex
      ? {
          ...currentTeam,
          abilities: {
            ...currentTeam.abilities,
            double: {
              used: !currentTeam.abilities.double.pending,
              pending: !currentTeam.abilities.double.pending,
            },
          },
        }
      : currentTeam
  );

  commit({
    ...state,
    teams: updatedTeams,
  });

  showToast(
    team.abilities.double.pending
      ? `تم إلغاء دبل النقاط لـ ${team.name}.`
      : `تم تفعيل دبل النقاط لـ ${team.name}.`
  );
}

function useRemoveTwo() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion) {
    return;
  }

  const team = state.teams[currentQuestion.teamIndex];
  if (team.abilities.removeTwo.used) {
    return;
  }

  if (state.confirmAnswer || state.pendingAnswerKey) {
    showToast("استخدم حذف إجابتين قبل اختيار الإجابة.");
    return;
  }

  const wrongOptions = currentQuestion.question.options.filter(
    (option) =>
      option.key !== currentQuestion.question.answerKey &&
      !currentQuestion.removedOptionKeys.includes(option.key)
  );
  const removableCount = Math.min(2, Math.max(0, wrongOptions.length - 1));

  if (removableCount <= 0) {
    showToast("لا يمكن استخدام حذف إجابتين في هذا السؤال.");
    return;
  }

  const removedKeys = shuffleArray(wrongOptions)
    .slice(0, removableCount)
    .map((option) => option.key);
  const updatedTeams = state.teams.map((currentTeam, index) =>
    index === currentQuestion.teamIndex
      ? {
          ...currentTeam,
          abilities: {
            ...currentTeam.abilities,
            removeTwo: {
              used: true,
            },
          },
        }
      : currentTeam
  );

  commit({
    ...state,
    teams: updatedTeams,
    currentQuestion: {
      ...currentQuestion,
      removedOptionKeys: [...currentQuestion.removedOptionKeys, ...removedKeys],
    },
  });

  showToast("تم حذف إجابتين غير صحيحتين.");
}

function useBlock() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion) {
    return;
  }

  const blockedTeamIndex = currentQuestion.teamIndex;
  const blockingTeamIndex = getOpponentTeamIndex(blockedTeamIndex);
  const blockingTeam = state.teams[blockingTeamIndex];

  if (blockingTeam.abilities.block.used) {
    return;
  }

  const updatedBoard = markBoardSlotUsed(
    state.board,
    currentQuestion.categoryId,
    currentQuestion.side,
    currentQuestion.pointValue
  );
  const updatedSessionUsedQuestionIds = appendSessionQuestionId(
    currentQuestion.question.id,
    state.sessionUsedQuestionIds
  );
  const updatedTeams = state.teams.map((team, index) =>
    index === blockingTeamIndex
      ? {
          ...team,
          abilities: {
            ...team.abilities,
            block: {
              used: true,
            },
          },
        }
      : team
  );

  commit({
    ...state,
    phase: "answer",
    board: updatedBoard,
    teams: updatedTeams,
    sessionUsedQuestionIds: updatedSessionUsedQuestionIds,
    activeTeamIndex: blockingTeamIndex,
    currentQuestion: null,
    pendingAnswerKey: "",
    confirmAnswer: false,
    lastResult: {
      type: "blocked",
      isCorrect: false,
      teamIndex: blockedTeamIndex,
      blockingTeamIndex,
      categoryName: currentQuestion.categoryName,
      scoreDelta: 0,
      selectedAnswer: "",
      correctAnswer: currentQuestion.question.answerText,
      usedDouble: currentQuestion.multiplier > 1,
    },
  });
}

function evaluateAnswer() {
  const currentQuestion = state.currentQuestion;
  if (!currentQuestion || !state.pendingAnswerKey) {
    showToast("اختر إجابة أولاً.");
    return;
  }

  const selectedOption = currentQuestion.question.options.find(
    (option) => option.key === state.pendingAnswerKey
  );

  if (!selectedOption) {
    showToast("تعذر قراءة الإجابة المختارة.");
    return;
  }

  const isCorrect = state.pendingAnswerKey === currentQuestion.question.answerKey;
  const scoreDelta = isCorrect
    ? currentQuestion.question.points * currentQuestion.multiplier
    : -WRONG_PENALTY * currentQuestion.multiplier;
  const updatedBoard = markBoardSlotUsed(
    state.board,
    currentQuestion.categoryId,
    currentQuestion.side,
    currentQuestion.pointValue
  );
  const updatedSessionUsedQuestionIds = appendSessionQuestionId(
    currentQuestion.question.id,
    state.sessionUsedQuestionIds
  );

  const updatedTeams = state.teams.map((team, index) =>
    index === currentQuestion.teamIndex
      ? {
          ...team,
          points: team.points + scoreDelta,
        }
      : team
  );

  commit({
    ...state,
    phase: "answer",
    board: updatedBoard,
    teams: updatedTeams,
    sessionUsedQuestionIds: updatedSessionUsedQuestionIds,
    activeTeamIndex: currentQuestion.teamIndex === 0 ? 1 : 0,
    currentQuestion: null,
    pendingAnswerKey: "",
    confirmAnswer: false,
    lastResult: {
      type: isCorrect ? "correct" : "wrong",
      isCorrect,
      teamIndex: currentQuestion.teamIndex,
      categoryName: currentQuestion.categoryName,
      scoreDelta,
      selectedAnswer: selectedOption.label,
      correctAnswer: currentQuestion.question.answerText,
      usedDouble: currentQuestion.multiplier > 1,
    },
  });
}

function moveAfterAnswer() {
  if (!state.lastResult) {
    return;
  }

  commit({
    ...state,
    phase: isBoardFinished(state.board) ? "winner" : "board",
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

function markBoardSlotUsed(board, categoryId, side, pointValue) {
  return board.map((card) => {
    if (card.categoryId !== categoryId) {
      return card;
    }

    return {
      ...card,
      slots: {
        ...card.slots,
        [side]: {
          ...card.slots[side],
          [pointValue]: {
            ...card.slots[side][pointValue],
            used: true,
          },
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
  const separateOptions = OPTION_KEYS.map((key, index) => {
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
    return total + Math.min(2, count);
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
    POINT_VALUES.flatMap((pointValue) => [
      card.slots.left[pointValue],
      card.slots.right[pointValue],
    ])
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
    ["5. لتفادي نقص الأزرار في اللوحة، وفّر سؤالين على الأقل لكل قيمة داخل كل تصنيف."],
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
  return availableSlots.every((slot) => slot.used);
}

function getOpponentTeamIndex(teamIndex) {
  return teamIndex === 0 ? 1 : 0;
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
  if (!window.html2canvas) {
    showToast("تعذر تجهيز الصورة للمشاركة.");
    return;
  }

  const captureTarget = document.body;
  const hiddenElements = Array.from(captureTarget.querySelectorAll(".no-capture"));
  const previousVisibility = hiddenElements.map((element) => element.style.visibility);
  const pageHeight = Math.max(
    document.body.scrollHeight,
    document.body.offsetHeight,
    document.documentElement.scrollHeight,
    document.documentElement.offsetHeight,
    document.documentElement.clientHeight
  );

  try {
    hiddenElements.forEach((element) => {
      element.style.visibility = "hidden";
    });

    const canvas = await window.html2canvas(captureTarget, {
      backgroundColor: null,
      scale: 1.35,
      useCORS: true,
      width: DESKTOP_SHARE_WIDTH,
      windowWidth: DESKTOP_SHARE_WIDTH,
      height: pageHeight,
      windowHeight: pageHeight,
      scrollX: 0,
      scrollY: 0,
      onclone(clonedDocument) {
        const clonedBody = clonedDocument.body;
        const clonedRoot = clonedDocument.documentElement;

        clonedRoot.style.width = `${DESKTOP_SHARE_WIDTH}px`;
        clonedBody.style.width = `${DESKTOP_SHARE_WIDTH}px`;
        clonedBody.style.minHeight = `${pageHeight}px`;
        clonedBody.style.overflow = "visible";

        Array.from(clonedDocument.querySelectorAll(".no-capture")).forEach((element) => {
          element.style.visibility = "hidden";
        });
      },
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("تعذر تحويل الصفحة إلى صورة.");
    }

    const file = new File([blob], `quiz-${state.phase}.png`, { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: "ساحة التحدي",
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

function showToast(message) {
  toastElement.hidden = false;
  toastElement.textContent = message;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastElement.hidden = true;
  }, 2600);
}
