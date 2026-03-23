const HEADER_MAP = {
  category: ['التصنيف', 'الفئة', 'category'],
  question: ['السؤال', 'question'],
  options: ['الخياراتأبجدد', 'الخيارات', 'options'],
  answer: ['الاجابةالصحيحة', 'الإجابةالصحيحة', 'correctanswer'],
  points: ['النقاط', 'points'],
};

const OPTION_LABELS = ['أ', 'ب', 'ج', 'د'];

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u200f/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function simpleHash(value) {
  const text = normalizeText(value);
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function findHeaderIndexes(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const result = {};

  Object.entries(HEADER_MAP).forEach(([key, aliases]) => {
    result[key] = normalized.findIndex((headerValue) =>
      aliases.some((alias) => headerValue.includes(normalizeHeader(alias))),
    );
  });

  return result;
}

function parsePoints(value, rowNumber) {
  const normalized = normalizeText(value).replace(/\.0+$/, '');
  const number = Number(normalized);

  if (!Number.isFinite(number)) {
    throw new Error(`قيمة النقاط غير صالحة في الصف ${rowNumber}.`);
  }

  return number;
}

function splitOptions(optionCell) {
  const normalized = normalizeText(optionCell);
  const matches = Array.from(
    normalized.matchAll(/([أبجد])\)\s*([\s\S]*?)(?=(?:\s+[أبجد]\)\s*)|$)/g),
  );

  if (matches.length !== 4) {
    throw new Error('تعذر تقسيم الخيارات إلى أربعة عناصر.');
  }

  return matches.map((match, index) => ({
    key: ['A', 'B', 'C', 'D'][index],
    label: OPTION_LABELS[index],
    text: normalizeText(match[2]),
    full: `${OPTION_LABELS[index]}) ${normalizeText(match[2])}`,
  }));
}

function resolveCorrectOption(correctCell, options) {
  const normalized = normalizeText(correctCell);
  const labelMatch = normalized.match(/^([أبجد])\)/);

  if (labelMatch) {
    const labelIndex = OPTION_LABELS.indexOf(labelMatch[1]);

    if (labelIndex >= 0) {
      return labelIndex;
    }
  }

  const answerText = normalized.replace(/^([أبجد])\)\s*/, '');
  const optionIndex = options.findIndex(
    (option) => normalizeText(option.text) === normalizeText(answerText),
  );

  if (optionIndex >= 0) {
    return optionIndex;
  }

  throw new Error('تعذر تحديد الإجابة الصحيحة من النص الوارد في الملف.');
}

export async function parseQuestionsFile(file, onProgress = () => {}) {
  if (!window.XLSX) {
    throw new Error('تعذر تحميل مكتبة قراءة ملفات Excel.');
  }

  onProgress({
    progress: 6,
    categoriesCount: 0,
    questionsCount: 0,
    stage: 'reading',
    message: 'جاري قراءة الملف...',
  });

  const buffer = await file.arrayBuffer();

  onProgress({
    progress: 18,
    categoriesCount: 0,
    questionsCount: 0,
    stage: 'parsing',
    message: 'جاري تحليل ملف Excel...',
  });

  const workbook = window.XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error('الملف لا يحتوي على أي أوراق عمل.');
  }

  const worksheet = workbook.Sheets[sheetName];
  const rows = window.XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  if (!rows.length) {
    throw new Error('الملف فارغ.');
  }

  const headerIndexes = findHeaderIndexes(rows[0]);

  if (Object.values(headerIndexes).some((value) => value < 0)) {
    throw new Error(
      'تنسيق الملف غير مطابق. المطلوب أعمدة: التصنيف، السؤال، الخيارات، الإجابة الصحيحة، النقاط.',
    );
  }

  const categoriesMap = new Map();
  const questions = [];
  const dataRows = rows.slice(1).filter((row) =>
    row.some((cell) => normalizeText(cell)),
  );

  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    const rowNumber = index + 2;
    const categoryName = normalizeText(row[headerIndexes.category]);
    const questionText = normalizeText(row[headerIndexes.question]);
    const optionCell = normalizeText(row[headerIndexes.options]);
    const answerCell = normalizeText(row[headerIndexes.answer]);
    const points = parsePoints(row[headerIndexes.points], rowNumber);

    if (!categoryName || !questionText || !optionCell || !answerCell) {
      throw new Error(`هناك بيانات ناقصة في الصف ${rowNumber}.`);
    }

    const options = splitOptions(optionCell);
    const correctOptionIndex = resolveCorrectOption(answerCell, options);
    const categoryId = `cat_${simpleHash(categoryName)}`;

    if (!categoriesMap.has(categoryId)) {
      categoriesMap.set(categoryId, {
        id: categoryId,
        name: categoryName,
        sortIndex: categoriesMap.size,
        questionCount: 0,
        pointsBreakdown: { 200: 0, 400: 0, 600: 0 },
      });
    }

    const category = categoriesMap.get(categoryId);
    category.questionCount += 1;
    category.pointsBreakdown[points] = (category.pointsBreakdown[points] || 0) + 1;

    questions.push({
      id: `q_${rowNumber}_${simpleHash(`${categoryName}_${questionText}_${points}`)}`,
      rowNumber,
      categoryId,
      categoryName,
      text: questionText,
      options,
      correctOptionIndex,
      correctOptionKey: options[correctOptionIndex]?.key || 'A',
      correctOptionLabel: options[correctOptionIndex]?.label || 'أ',
      correctAnswerText: options[correctOptionIndex]?.text || answerCell,
      correctAnswerFull: options[correctOptionIndex]?.full || answerCell,
      optionsRaw: optionCell,
      answerRaw: answerCell,
      points,
      sourceSheet: sheetName,
    });

    const progress = 18 + Math.round(((index + 1) / dataRows.length) * 82);

    onProgress({
      progress: Math.min(progress, 100),
      categoriesCount: categoriesMap.size,
      questionsCount: questions.length,
      stage: 'processing',
      message: 'جاري تجهيز الأسئلة والتصنيفات...',
    });

    if ((index + 1) % 18 === 0) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
    }
  }

  return {
    sheetName,
    categories: Array.from(categoriesMap.values()).sort(
      (left, right) => left.sortIndex - right.sortIndex,
    ),
    questions,
    meta: {
      categoriesCount: categoriesMap.size,
      questionsCount: questions.length,
      fileName: file.name,
      importedAt: Date.now(),
    },
  };
}
