export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u200f/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSearch(value) {
  return normalizeText(value)
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function randomItem(items = []) {
  if (!items.length) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)];
}

export function shuffle(items = []) {
  const clone = [...items];

  for (let index = clone.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[targetIndex]] = [clone[targetIndex], clone[index]];
  }

  return clone;
}

export function parseRoomIdFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return normalizeText(params.get('room')).toUpperCase();
}

export function setRoomIdInUrl(roomId) {
  const url = new URL(window.location.href);

  if (roomId) {
    url.searchParams.set('room', roomId);
  } else {
    url.searchParams.delete('room');
  }

  window.history.replaceState({}, '', url);
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const input = document.createElement('textarea');
  input.value = text;
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
  return Promise.resolve();
}

export function getStoredString(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (error) {
    return fallback;
  }
}

export function setStoredString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    return false;
  }

  return true;
}

export function getStoredJSON(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

export function setStoredJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    return false;
  }

  return true;
}

export function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    return false;
  }

  return true;
}

export function formatPoints(value) {
  return Number(value || 0).toLocaleString('ar-EG');
}

export function sortPlayers(players = []) {
  return [...players].sort((left, right) => {
    const leftJoined = Number(left.joinedAt || 0);
    const rightJoined = Number(right.joinedAt || 0);

    if (leftJoined !== rightJoined) {
      return leftJoined - rightJoined;
    }

    return String(left.name || '').localeCompare(String(right.name || ''), 'ar');
  });
}

export function getNextTurnPlayerId(turnOrder = [], currentPlayerId = '', activeIds = []) {
  const filteredOrder = turnOrder.filter((id) => activeIds.includes(id));

  if (!filteredOrder.length) {
    return '';
  }

  const currentIndex = filteredOrder.indexOf(currentPlayerId);

  if (currentIndex === -1) {
    return filteredOrder[0];
  }

  return filteredOrder[(currentIndex + 1) % filteredOrder.length];
}

export function buildBankPayload(categoriesInput = [], questionsInput = [], extraMeta = {}) {
  const categoriesMap = new Map();

  categoriesInput.forEach((category, index) => {
    const id = category.id;

    if (!id) {
      return;
    }

    categoriesMap.set(id, {
      id,
      name: normalizeText(category.name),
      sortIndex: Number(category.sortIndex ?? index),
      questionCount: 0,
      pointsBreakdown: { 200: 0, 400: 0, 600: 0 },
    });
  });

  const questions = questionsInput
    .map((question, index) => {
      const categoryId = question.categoryId;
      const category = categoriesMap.get(categoryId);

      if (!category || !question.id) {
        return null;
      }

      const points = Number(question.points || 0);
      category.questionCount += 1;
      category.pointsBreakdown[points] = (category.pointsBreakdown[points] || 0) + 1;

      return {
        ...question,
        rowNumber: Number(question.rowNumber || index + 1),
        categoryName: category.name,
        text: normalizeText(question.text),
        correctAnswerText: normalizeText(question.correctAnswerText),
        correctAnswerFull: normalizeText(question.correctAnswerFull),
        answerRaw: normalizeText(question.answerRaw),
        optionsRaw: normalizeText(question.optionsRaw),
        points,
      };
    })
    .filter(Boolean);

  const categories = [...categoriesMap.values()].sort(
    (left, right) => left.sortIndex - right.sortIndex,
  );

  return {
    categories: Object.fromEntries(categories.map((category) => [category.id, category])),
    questions: Object.fromEntries(questions.map((question) => [question.id, question])),
    meta: {
      categoriesCount: categories.length,
      questionsCount: questions.length,
      updatedAt: Date.now(),
      ...extraMeta,
    },
  };
}

export function normalizeBankSnapshot(snapshotValue) {
  const categoryOrder = Object.fromEntries(
    Object.values(snapshotValue?.categories || {}).map((category) => [
      category.id,
      Number(category.sortIndex || 0),
    ]),
  );
  const categories = Object.values(snapshotValue?.categories || {}).sort(
    (left, right) => Number(left.sortIndex || 0) - Number(right.sortIndex || 0),
  );

  const questions = Object.values(snapshotValue?.questions || {}).sort((left, right) => {
    const categorySort =
      Number(categoryOrder[left.categoryId] ?? 0) - Number(categoryOrder[right.categoryId] ?? 0);

    if (categorySort !== 0) {
      return categorySort;
    }

    if (Number(left.points || 0) !== Number(right.points || 0)) {
      return Number(left.points || 0) - Number(right.points || 0);
    }

    return Number(left.rowNumber || 0) - Number(right.rowNumber || 0);
  });

  const grouped = {};

  questions.forEach((question) => {
    const bucketKey = `${question.categoryId}_${question.points}`;
    grouped[bucketKey] = grouped[bucketKey] || [];
    grouped[bucketKey].push(question);
  });

  return {
    categories,
    categoriesById: Object.fromEntries(categories.map((category) => [category.id, category])),
    questions,
    questionsById: Object.fromEntries(questions.map((question) => [question.id, question])),
    groupedQuestions: grouped,
    meta: snapshotValue?.meta || {
      categoriesCount: categories.length,
      questionsCount: questions.length,
    },
    loaded: true,
  };
}

export function renderOptionText(option) {
  if (!option) {
    return '';
  }

  if (typeof option === 'string') {
    return option;
  }

  return `${option.label || ''}) ${option.text || ''}`.trim();
}
