export const APP_NAME = 'الميدان';
export const SHARE_BASE_URL = 'https://sli0tin.github.io/Game/';

export const firebaseConfig = {
  apiKey: 'AIzaSyBpcJHADMt7FWqGo-PRae2oa_916qD6KAI',
  authDomain: 'ques-87f74.firebaseapp.com',
  databaseURL: 'https://ques-87f74-default-rtdb.firebaseio.com',
  projectId: 'ques-87f74',
  storageBucket: 'ques-87f74.firebasestorage.app',
  messagingSenderId: '110924910325',
  appId: '1:110924910325:web:e92f80606985124c77ffbc',
  measurementId: 'G-B7MMDCHE3V',
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const REQUIRED_CATEGORY_COUNT = 6;
export const BOARD_VALUES = [200, 400, 600];
export const ANSWER_TIME_SECONDS = 40;
export const ANSWER_TIME_MS = ANSWER_TIME_SECONDS * 1000;
export const MIN_LOADING_MS = 1200;
export const MAX_LOADING_MS = 4500;
export const RESULT_STAGE_MS = 3200;
export const CHAT_MESSAGE_LIMIT = 220;

export const STORAGE_KEYS = {
  playerName: 'midan_player_name',
  adminUnlocked: 'midan_admin_unlocked',
  roomSessionPrefix: 'midan_room_session_',
  chatSeenPrefix: 'midan_chat_seen_',
};

export const PLAYER_AVATARS = [
  '😎',
  '🦊',
  '🐯',
  '🦁',
  '🐼',
  '🐬',
  '🦄',
  '🐧',
  '🐵',
  '🦋',
  '🐝',
  '🐙',
];

export const COLOR_PALETTE = [
  { id: 'sunrise', name: 'شمسي', value: '#FDBA74', contrast: '#6B3200' },
  { id: 'mint', name: 'نعناعي', value: '#86EFAC', contrast: '#14532D' },
  { id: 'sky', name: 'سماوي', value: '#93C5FD', contrast: '#172554' },
  { id: 'rose', name: 'وردي', value: '#FDA4AF', contrast: '#831843' },
  { id: 'lavender', name: 'لافندر', value: '#C4B5FD', contrast: '#3B0764' },
  { id: 'lemon', name: 'ليموني', value: '#FDE68A', contrast: '#713F12' },
  { id: 'peach', name: 'خوخي', value: '#FDBA8C', contrast: '#7C2D12' },
  { id: 'ocean', name: 'فيروزي', value: '#67E8F9', contrast: '#083344' },
];
