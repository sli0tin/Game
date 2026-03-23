import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  off,
  onDisconnect,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js';
import {
  getAuth,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { firebaseConfig } from './config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let authReady = Promise.resolve(null);

try {
  const auth = getAuth(app);
  authReady = signInAnonymously(auth).catch(() => null);
} catch (error) {
  authReady = Promise.resolve(null);
}

export {
  authReady,
  db,
  get,
  onDisconnect,
  onValue,
  off,
  push,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
};
