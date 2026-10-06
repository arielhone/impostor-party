// מי האימפוסטר? — לוגיקת המשחק
// ארכיטקטורה: Firebase Auth (אנונימי) + Firestore. אין שרת משלנו.
// הדפדפן של המנהל משמש "שופט": מגריל שאלות ומעביר שלבים.
// הסודות מוגנים ע"י firestore.rules (ראה שם).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, collection, query, where,
  getDoc, getDocs, getDocsFromServer, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, increment, serverTimestamp, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, USE_EMULATOR } from "./firebase-config.js";
import { QUESTIONS } from "./questions.js";

// ---------- Firebase ----------
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ---------- State ----------
const S = {
  me: null,            // uid
  code: null,          // קוד חדר
  room: null,          // מסמך החדר
  players: {},         // uid -> player
  secret: null,        // השאלה שלי
  answers: { round: -1, list: null, loading: false },
  unsubs: [],
  joined: false,
  hostBusy: false,
  voteChoice: null,
  lastBeat: 0,         // מתי המנהל (אני) שלח פעימה אחרונה
  lastTakeover: 0,     // מתי ניסיתי להשתלט אחרונה
  lastSeenBeat: 0,     // מתי שלחתי seenAt אחרון
  seenVal: {},         // uid -> ערך seenAt האחרון שראינו
  seenLocal: {},       // uid -> מתי (בשעון שלי) ראיתי אותו משתנה
  aliveKey: "",        // מי מחובר כרגע — לרינדור כשמישהו נעלם
  lastTick: Date.now(), // מתי רץ הטיימר הפנימי בפעם האחרונה (לזיהוי טאב שהוקפא ברקע)
  awaitSync: 0,        // אחרי הקפאה: לא מחליטים כלום עד שמגיע עדכון שחקנים טרי
  renderPending: false, // רינדור שנדחה כי מישהו באמצע הקלדה
};

const BEAT_MS = 10000;      // תדירות פעימת המנהל
const STALE_MS = 30000;     // אחרי כמה זמן בלי פעימה אפשר להשתלט (תואם ל-firestore.rules)
const STAGGER_MS = 15000;   // השהיה נוספת לכל מועמד בתור
const SEEN_MS = 15000;      // כל שחקן מעדכן seenAt בתדירות הזו
const GHOST_MS = 30000;     // שחקן שלא נראה זמן כזה נחשב שסגר את הטלפון

const $ = (s) => document.querySelector(s);
const app = $("#app");
const PHASES_WITH_ANSWERS = ["reveal", "discussion", "voting", "results"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // בלי I ו-O שמתבלבלים

const roomRef = () => doc(db, "rooms", S.code);
const sub = (name) => collection(db, "rooms", S.code, name);
const subDoc = (name, id) => doc(db, "rooms", S.code, name, id);
const isHost = () => S.room && S.room.hostUid === S.me;
const inRound = () => !!S.room?.participants?.includes(S.me);
const isAlive = (uid) => uid === S.me || Date.now() - (S.seenLocal[uid] ?? 0) < GHOST_MS;
// משתתפים שעדיין רשומים בחדר (כולל מי שסגר את הטלפון — עדיין אפשר להצביע נגדו)
const presentParticipants = () => (S.room?.participants || []).filter((u) => S.players[u]);
// משתתפים שמחוברים בפועל — רק הם עוצרים מעבר שלב
const activeParticipants = () => presentParticipants().filter(isAlive);
const nameOf = (uid) => S.players[uid]?.name || "שחקן שעזב";
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// הגרלה משוקללת: weight(x) מחזיר משקל חיובי לכל איבר
function weightedPick(arr, weight) {
  const w = arr.map(weight);
  let x = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) if ((x -= w[i]) < 0) return arr[i];
  return arr[arr.length - 1];
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function vibrate(ms = 60) { try { navigator.vibrate?.(ms); } catch {} }

// ---------- Boot ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { console.error(e); app.innerHTML = `<div class="center">שגיאת התחברות ל-Firebase. בדוק את firebase-config.js ושהתחברות אנונימית מופעלת.</div>`; }
    return;
  }
  S.me = user.uid;
  const urlCode = new URLSearchParams(location.search).get("room");
  const saved = safeGet("impostor:room");
  const code = (urlCode || "").toUpperCase();
  // חזרה אוטומטית לחדר אחרי רענון
  if (code && saved === code) {
    const ok = await tryRejoin(code);
    if (ok) return;
  }
  render();
});

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

async function tryRejoin(code) {
  try {
    const p = await getDoc(doc(db, "rooms", code, "players", S.me));
    if (!p.exists()) return false;
    await enterRoom(code);
    return true;
  } catch { return false; }
}

// ---------- Room lifecycle ----------
async function createRoom(name) {
  let code;
  for (let i = 0; i < 10; i++) {
    code = Array.from({ length: 4 }, () => pick(CODE_CHARS)).join("");
    const snap = await getDoc(doc(db, "rooms", code));
    if (!snap.exists()) break;
    code = null;
  }
  if (!code) return toast("לא הצלחתי ליצור חדר, נסה שוב");
  await setDoc(doc(db, "rooms", code), {
    hostUid: S.me, phase: "lobby", round: 0, participants: [],
    discussionSec: 180, createdAt: Date.now(), result: null, normalQuestion: null, discussionEndsAt: null,
    hostSeenAt: serverTimestamp(),
  });
  await setDoc(doc(db, "rooms", code, "players", S.me), { name, score: 0, joinedAt: Date.now(), seenAt: serverTimestamp() });
  await enterRoom(code);
}

async function joinRoom(code, name) {
  code = code.toUpperCase().trim();
  const snap = await getDoc(doc(db, "rooms", code));
  if (!snap.exists()) return toast("לא מצאתי חדר עם הקוד הזה");
  const pRef = doc(db, "rooms", code, "players", S.me);
  const p = await getDoc(pRef);
  if (p.exists()) await updateDoc(pRef, { name });
  else await setDoc(pRef, { name, score: 0, joinedAt: Date.now(), seenAt: serverTimestamp() });
  await enterRoom(code);
}

async function enterRoom(code) {
  S.code = code;
  S.joined = true;
  safeSet("impostor:room", code);
  history.replaceState(null, "", `?room=${code}`);

  S.unsubs.push(onSnapshot(roomRef(), (snap) => {
    const prev = S.room;
    const prevPhase = prev?.phase, prevRound = prev?.round;
    S.room = snap.data({ serverTimestamps: "estimate" }) || null;
    if (!S.room) return leaveLocal("החדר נסגר");
    // פעימת מנהל בלבד — בלי רינדור, כדי לא לסגור את המקלדת למי שמקליד
    if (prev && onlyHeartbeatChanged(prev, S.room)) return;
    if (prev && prev.hostUid !== S.room.hostUid && S.room.hostUid === S.me) {
      S.lastBeat = 0;
      toast("אתה המנהל עכשיו 👑");
    }
    if (S.room.phase !== prevPhase || S.room.round !== prevRound) onPhaseChange(prevPhase);
    render();
    hostTick();
  }, (e) => console.error("room", e)));

  S.unsubs.push(onSnapshot(sub("players"), (snap) => {
    const prevKey = playersKey(S.players);
    S.players = {};
    snap.forEach((d) => {
      const p = (S.players[d.id] = d.data({ serverTimestamps: "estimate" }));
      // זוכרים מתי *ראינו* את seenAt משתנה (לפי השעון שלנו), כדי לא להיות תלויים בשעון של מכשיר אחר
      const v = p.seenAt?.toMillis?.() ?? 0;
      if (S.seenVal[d.id] !== v) {
        const now = Date.now();
        // פעם ראשונה שרואים שחקן (למשל אחרי רענון): לפי seenAt שלו, כדי ששחקן שנעלם מזמן לא ייראה מחובר.
        // זו ההשוואה היחידה בין השעון שלנו לשעון השרת, ולכן הגיל מוגבל ל-15 שניות: גם בשעון שזז
        // שחקן מחובר נשאר "מחובר" עד הפעימה הבאה שלו, ומי שנעלם נחשב מחובר לכל היותר 15 שניות.
        S.seenLocal[d.id] = d.id in S.seenVal ? now : now - Math.min(Math.max(0, now - v), GHOST_MS - SEEN_MS);
        S.seenVal[d.id] = v;
      }
    });
    // מצב טרי מהשרת — לא הד של כתיבה שלנו שעוד לא אושרה (אחרי הקפאה אנחנו כותבים seenAt מיד)
    if (!snap.metadata.fromCache && !snap.metadata.hasPendingWrites) S.awaitSync = 0;
    if (S.joined && !S.players[S.me] && !snap.metadata.hasPendingWrites) return leaveLocal("יצאת מהחדר");
    // פעימות "אני חי" בלבד — בלי רינדור, כדי לא לסגור את המקלדת למי שמקליד
    if (playersKey(S.players) === prevKey) return;
    render();
    hostTick();
  }, (e) => console.error("players", e)));

  S.unsubs.push(onSnapshot(subDoc("secrets", S.me), (snap) => {
    S.secret = snap.exists() ? snap.data() : null;
    render();
  }, (e) => console.error("secret", e)));
}

function leaveLocal(msg) {
  S.unsubs.forEach((u) => u());
  Object.assign(S, { unsubs: [], code: null, room: null, players: {}, secret: null, joined: false,
    answers: { round: -1, list: null, loading: false }, lastBeat: 0, lastTakeover: 0,
    lastSeenBeat: 0, seenVal: {}, seenLocal: {}, aliveKey: "" });
  safeSet("impostor:room", null);
  history.replaceState(null, "", location.pathname);
  if (msg) toast(msg);
  render();
}

async function leaveRoom() {
  if (!confirm("לצאת מהחדר?")) return;
  // מנהל שיוצא מעביר את התפקיד לשחקן הוותיק ביותר; אם לא נשאר אף אחד מחובר — סוגר את החדר
  if (isHost()) {
    let next = hostCandidates()[0];
    // לפני מחיקה — לוודא מול השרת שבאמת אף אחד לא מחובר (הטאב שלי אולי היה ברקע ולא קיבל עדכונים)
    let close = false;
    if (!next) {
      try { next = await freshAliveOther(); close = !next; }
      catch (e) { console.error("alive check", e); } // לא בטוח — לא מוחקים
    }
    if (close) {
      const code = S.code;
      S.joined = false;
      leaveLocal();
      try { await closeRoom(code); } catch (e) { console.error("close", e); }
      return;
    }
    if (next) {
      try { await updateDoc(roomRef(), { hostUid: next, hostSeenAt: serverTimestamp() }); }
      catch (e) { console.error(e); }
    }
  }
  S.joined = false;
  try { await deleteDoc(subDoc("players", S.me)); } catch {}
  leaveLocal();
}

// השחקן הוותיק ביותר (חוץ ממני) שנראה ב-30 השניות האחרונות.
// קורא ישר מהשרת ולא מהמטמון — הטאב שלי אולי היה ברקע ולא קיבל עדכונים.
async function freshAliveOther() {
  const now = Date.now();
  const snap = await getDocsFromServer(sub("players"));
  return snap.docs
    .filter((d) => d.id !== S.me && now - (d.data().seenAt?.toMillis?.() ?? 0) < GHOST_MS)
    .sort((a, b) => (a.data().joinedAt || 0) - (b.data().joinedAt || 0))[0]?.id || null;
}

// מחיקת חדר וכל מה שבתוכו. Firestore לא מוחק תתי-אוספים לבד, אז מוחקים כל מסמך.
// שלב closing פותח למנהל הרשאה לקרוא ולמחוק הכל (ראה firestore.rules).
async function closeRoom(code) {
  const ref = doc(db, "rooms", code);
  await updateDoc(ref, { phase: "closing" });
  const names = ["players", "secrets", "hostOnly", "answers", "votes"];
  const snaps = await Promise.all(names.map((n) => getDocs(collection(db, "rooms", code, n))));
  const refs = snaps.flatMap((s) => s.docs.map((d) => d.ref));
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
  await deleteDoc(ref);
}

// ---------- העברת מנהל ----------
function onlyHeartbeatChanged(a, b) {
  const strip = ({ hostSeenAt, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

// מפתח השוואה לרשימת השחקנים בלי seenAt
function playersKey(players) {
  return JSON.stringify(Object.keys(players).sort().map((u) => {
    const { seenAt, ...rest } = players[u];
    return [u, rest];
  }));
}

// שחקנים מחוברים שיכולים להחליף את המנהל, לפי ותק
function hostCandidates() {
  return Object.keys(S.players)
    .filter((u) => u !== S.room?.hostUid && isAlive(u))
    .sort((a, b) => (S.players[a].joinedAt || 0) - (S.players[b].joinedAt || 0));
}

// כל שחקן שולח "אני חי"; המנהל שולח גם פעימת מנהל; שאר השחקנים משתלטים אם הוא נעלם
function hostKeepalive() {
  if (!S.room || !S.code || !S.joined || !S.players[S.me]) return;
  const now = Date.now();
  if (now - S.lastSeenBeat >= SEEN_MS) {
    S.lastSeenBeat = now;
    updateDoc(subDoc("players", S.me), { seenAt: serverTimestamp() }).catch((e) => console.error("seen", e));
  }
  // מישהו התחבר/נעלם — לרנדר כדי לעדכן "מחכים ל…"
  const aliveKey = Object.keys(S.players).filter(isAlive).sort().join();
  if (aliveKey !== S.aliveKey) { S.aliveKey = aliveKey; render(); }
  if (isHost()) {
    if (now - S.lastBeat < BEAT_MS) return;
    S.lastBeat = now;
    updateDoc(roomRef(), { hostSeenAt: serverTimestamp() }).catch((e) => console.error("beat", e));
    return;
  }
  const k = hostCandidates().indexOf(S.me);
  if (k < 0 || now - S.lastTakeover < 5000) return;
  const hostGone = !S.players[S.room.hostUid];
  const seen = S.room.hostSeenAt?.toMillis?.() ?? 0;
  if (!hostGone && now - seen < STALE_MS + k * STAGGER_MS) return;
  S.lastTakeover = now;
  updateDoc(roomRef(), { hostUid: S.me, hostSeenAt: serverTimestamp() })
    .catch((e) => { if (e.code !== "permission-denied") console.error("takeover", e); });
}

function onPhaseChange(prev) {
  const ph = S.room.phase;
  if (ph === "answering") {
    S.voteChoice = null; vibrate();
    const a = $("#ansIn"); if (a) a.value = ""; // לא להשאיר תשובה לשאלה הקודמת
    if (prev === "answering") toast("השאלה הוחלפה 🔄");
  }
  if (ph === "discussion" || ph === "voting" || ph === "results") vibrate(ph === "results" ? 200 : 60);
  if (PHASES_WITH_ANSWERS.includes(ph) && S.answers.round !== S.room.round) loadAnswers();
}

async function loadAnswers() {
  const r = S.room.round;
  S.answers = { round: r, list: null, loading: true };
  try {
    const snap = await getDocs(query(sub("answers"), where("round", "==", r)));
    const list = [];
    snap.forEach((d) => list.push({ uid: d.id, ...d.data() }));
    list.sort((a, b) => (a.at || 0) - (b.at || 0));
    if (S.answers.round === r) S.answers = { round: r, list, loading: false };
  } catch (e) {
    console.error(e);
    S.answers = { round: -1, list: null, loading: false };
    setTimeout(() => S.room && PHASES_WITH_ANSWERS.includes(S.room.phase) && loadAnswers(), 800);
  }
  render();
}

// ---------- Player actions ----------
async function submitAnswer(text) {
  text = text.trim();
  if (!text) return toast("כתוב תשובה");
  const r = S.room.round;
  await setDoc(subDoc("answers", S.me), { round: r, text: text.slice(0, 80), name: nameOf(S.me), at: Date.now() });
  await updateDoc(subDoc("players", S.me), { answeredRound: r });
  vibrate();
}

async function readyToVote() {
  await updateDoc(subDoc("players", S.me), { readyRound: S.room.round });
}

async function submitVote() {
  if (!S.voteChoice) return toast("בחר חשוד");
  const r = S.room.round;
  await setDoc(subDoc("votes", S.me), { round: r, target: S.voteChoice });
  await updateDoc(subDoc("players", S.me), { votedRound: r });
  vibrate();
}

// ---------- Host (game master) ----------
async function hostDo(fn) {
  if (S.hostBusy) return;
  S.hostBusy = true;
  try { await fn(); } catch (e) { console.error(e); toast("שגיאה: " + (e.code || e.message)); }
  finally { S.hostBusy = false; }
}

// מעברי שלב אוטומטיים — רצים רק אצל המנהל
function hostTick() {
  if (!isHost() || S.hostBusy || !S.room || syncing()) return;
  const act = activeParticipants();
  const r = S.room.round;
  if (!act.length) return;
  switch (S.room.phase) {
    case "answering":
      // כולם ענו — ישר לדיון: התשובות והשאלה נחשפות יחד
      if (act.every((u) => S.players[u].answeredRound === r)) hostDo(goDiscussion);
      break;
    case "discussion": {
      const ready = act.filter((u) => S.players[u].readyRound === r).length;
      if (Date.now() >= S.room.discussionEndsAt || ready > act.length / 2) hostDo(goVoting);
      break;
    }
    case "voting":
      if (act.every((u) => S.players[u].votedRound === r)) hostDo(goResults);
      break;
  }
}

// אחרי שהטאב הוקפא ברקע, נתוני "מי מחובר" ישנים — מחכים לעדכון טרי (עד 16 שניות, סבב פעימות אחד)
const syncing = () => S.awaitSync && Date.now() - S.awaitSync < 16000;

// reroll: החלפת שאלה באמצע שלב המענה — אותו מספר סיבוב בתצוגה
async function startRound({ reroll = false } = {}) {
  // רק שחקנים מחוברים — מי שסגר את הטלפון לא נכנס לסיבוב ולא יכול להיות אימפוסטר
  if (syncing()) return toast("מתחבר מחדש… נסה שוב בעוד רגע");
  const ids = Object.keys(S.players).filter(isAlive);
  if (ids.length < 3) return toast("צריך לפחות 3 שחקנים מחוברים");

  const cq = reroll ? "" : $("#customQ")?.value.trim(), ci = reroll ? "" : $("#customImp")?.value.trim();
  if (!!cq !== !!ci) return toast("מלא את שתי השאלות, או השאר את שתיהן ריקות");
  // (2) רשימת השאלות שכבר היו נשמרת רק אצל המנהל — במסמך החדר היא חושפת את השאלה הנוכחית
  const prevState = (await getDoc(subDoc("hostOnly", "state"))).data();
  let pair, used = prevState?.usedQ || S.room.usedQ || [];
  if (cq && ci) {
    pair = { q: cq, imp: ci };
  } else {
    let pool = QUESTIONS.map((_, i) => i).filter((i) => !used.includes(i));
    if (!pool.length) { pool = QUESTIONS.map((_, i) => i); used = []; }
    const qi = pick(pool);
    pair = QUESTIONS[qi];
    used = [...used, qi];
  }

  // מי שלא היה אימפוסטר הרבה סיבובים מקבל סיכוי גבוה יותר: משקל (1 + סיבובים מאז)²
  const since = S.room.impSince || {};
  const imp = weightedPick(ids, (u) => (1 + (since[u] || 0)) ** 2);
  const r = (S.room.round || 0) + 1;
  const b = writeBatch(db);
  ids.forEach((u) => b.set(subDoc("secrets", u), { round: r, q: u === imp ? pair.imp : pair.q }));
  b.set(subDoc("hostOnly", "state"), { round: r, impostorUid: imp, normalQ: pair.q, impQ: pair.imp, usedQ: used });
  b.update(roomRef(), {
    phase: "answering", round: r, participants: ids, usedQ: deleteField(),
    skipped: (S.room.skipped || 0) + (reroll ? 1 : 0),
    normalQuestion: null, result: null, discussionEndsAt: null,
  });
  await b.commit();
  if ($("#customQ")) { $("#customQ").value = ""; $("#customImp").value = ""; }
}


async function goDiscussion() {
  const hs = (await getDoc(subDoc("hostOnly", "state"))).data();
  await updateDoc(roomRef(), {
    phase: "discussion",
    normalQuestion: hs.normalQ,
    discussionEndsAt: Date.now() + (S.room.discussionSec || 180) * 1000,
  });
}

const goVoting = () => updateDoc(roomRef(), { phase: "voting" });

async function goResults() {
  const r = S.room.round;
  const [vs, hsSnap] = await Promise.all([
    getDocs(query(sub("votes"), where("round", "==", r))),
    getDoc(subDoc("hostOnly", "state")),
  ]);
  const hs = hsSnap.data();
  const votes = [];
  vs.forEach((d) => votes.push({ from: d.id, to: d.data().target }));

  const counts = {};
  votes.forEach((v) => (counts[v.to] = (counts[v.to] || 0) + 1));
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((u) => counts[u] === max);
  const eliminated = max > 0 && top.length === 1 ? top[0] : null; // תיקו = אף אחד לא מודח
  const caught = eliminated === hs.impostorUid;

  // כמה סיבובים עברו מאז שכל אחד היה אימפוסטר (נשמר רק עכשיו, כשהזהות כבר גלויה)
  const impSince = { ...(S.room.impSince || {}) };
  (S.room.participants || []).forEach((u) => (impSince[u] = u === hs.impostorUid ? 0 : (impSince[u] || 0) + 1));

  // ניקוד: +1 לכל מי שהצביע לאימפוסטר, +2 לאימפוסטר אם שרד
  const delta = {};
  votes.forEach((v) => { if (v.to === hs.impostorUid) delta[v.from] = (delta[v.from] || 0) + 1; });
  if (!caught) delta[hs.impostorUid] = (delta[hs.impostorUid] || 0) + 2;

  const names = {};
  (S.room.participants || []).forEach((u) => (names[u] = nameOf(u)));

  const b = writeBatch(db);
  Object.entries(delta).forEach(([u, d]) => { if (S.players[u]) b.update(subDoc("players", u), { score: increment(d) }); });
  b.update(roomRef(), {
    phase: "results", impSince,
    result: {
      votes, counts, eliminated, caught, tie: max > 0 && top.length > 1,
      impostorUid: hs.impostorUid, impostorQ: hs.impQ, normalQ: hs.normalQ, names, delta,
    },
  });
  await b.commit();
}

async function backToLobby() {
  await updateDoc(roomRef(), { phase: "lobby", participants: [], result: null, normalQuestion: null });
}

async function kick(uid) {
  if (!confirm(`להוציא את ${nameOf(uid)} מהחדר?`)) return;
  await deleteDoc(subDoc("players", uid));
}

// ---------- Views ----------
function header() {
  const p = S.players[S.me];
  return `<header class="top">
    <div class="code-chip">חדר <b>${esc(S.code)}</b></div>
    <div class="me-chip">${esc(p?.name || "")}${isHost() ? ' <span class="crown">👑</span>' : ""} · ${p?.score || 0} נק'</div>
    <button class="leave-btn" data-act="leave" aria-label="יציאה מהחדר" title="יציאה מהחדר">🚪</button>
  </header>`;
}

function homeView() {
  const urlCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
  const name = safeGet("impostor:name") || "";
  return `<section class="home">
    <div class="logo">
      <div class="logo-eye">👀</div>
      <h1>מי האימפוסטר?</h1>
      <p class="muted">כולם מקבלים אותה שאלה. כמעט כולם.</p>
    </div>
    <label class="field"><span>השם שלך</span>
      <input id="nameIn" maxlength="16" autocomplete="nickname" value="${esc(name)}" placeholder="למשל: אריאל" />
    </label>
    ${urlCode ? `
      <button class="btn primary big" data-act="join">הצטרף לחדר ${esc(urlCode)}</button>
      <input id="codeIn" type="hidden" value="${esc(urlCode)}" />
      <button class="btn ghost" data-act="create">או: פתח חדר חדש</button>
    ` : `
      <button class="btn primary big" data-act="create">פתח חדר חדש</button>
      <div class="or">או הצטרף עם קוד</div>
      <div class="row">
        <input id="codeIn" class="code-input" maxlength="4" placeholder="ABCD" autocapitalize="characters" />
        <button class="btn" data-act="join">הצטרף</button>
      </div>
    `}
  </section>`;
}

function playerList({ showKick = false, showScores = false } = {}) {
  const ids = Object.keys(S.players).sort((a, b) =>
    showScores ? (S.players[b].score || 0) - (S.players[a].score || 0) : (S.players[a].joinedAt || 0) - (S.players[b].joinedAt || 0));
  return `<ul class="plist">${ids.map((u) => `
    <li>
      <span class="avatar" style="--h:${hue(u)}">${esc((S.players[u].name || "?")[0])}</span>
      <span class="pname">${esc(S.players[u].name)}${u === S.room.hostUid ? " 👑" : ""}${u === S.me ? ' <span class="muted">(אתה)</span>' : ""}</span>
      ${showScores ? `<span class="score">${S.players[u].score || 0}</span>` : ""}
      ${showKick && u !== S.me ? `<button class="x" data-act="kick" data-uid="${u}" aria-label="הוצא">✕</button>` : ""}
    </li>`).join("")}</ul>`;
}

function hue(uid) { let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function lobbyView() {
  const n = Object.keys(S.players).length;
  const host = isHost();
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  return `${header()}
  <section class="card center-text">
    <div class="muted">קוד החדר</div>
    <div class="big-code">${esc(S.code)}</div>
    <div id="qr" class="qr"></div>
    <button class="btn ghost small" data-act="share" data-url="${esc(url)}">📤 שתף קישור</button>
  </section>
  <section class="card">
    <h2>שחקנים (${n})</h2>
    ${playerList({ showKick: host, showScores: S.room.round > 0 })}
  </section>
  ${host ? `
  <section class="card">
    <h2>הגדרות</h2>
    <label class="field inline"><span>זמן דיון</span>
      <select id="discSel" data-act="disc">
        ${[60, 120, 180, 240, 300].map((s) => `<option value="${s}" ${S.room.discussionSec === s ? "selected" : ""}>${s / 60} דק'</option>`).join("")}
      </select>
    </label>
    <details class="custom">
      <summary>✍️ זוג שאלות משלכם (אופציונלי)</summary>
      <input id="customQ" maxlength="120" placeholder="השאלה של כולם" />
      <input id="customImp" maxlength="120" placeholder="השאלה של האימפוסטר" />
      <p class="muted small">אם שני השדות מלאים — הסיבוב הבא ישתמש בהם במקום בבנק.</p>
    </details>
  </section>
  <button class="btn primary big sticky" data-act="start" ${n < 3 ? "disabled" : ""}>
    ${n < 3 ? `מחכים לעוד ${3 - n} שחקנים…` : S.room.round > 0 ? "▶ סיבוב הבא" : "▶ התחל משחק"}
  </button>` : `<p class="center-text muted pulse">מחכים שהמנהל יתחיל…</p>`}`;
}

function waitingOutView() {
  return `${header()}<section class="card center-text">
    <div class="emoji">⏳</div>
    <h2>סיבוב בעיצומו</h2>
    <p class="muted">הצטרפת באמצע — תיכנס למשחק בסיבוב הבא.</p>
  </section>`;
}

function progress(field) {
  const act = activeParticipants();
  const done = act.filter((u) => S.players[u][field] === S.room.round);
  const waiting = act.filter((u) => S.players[u][field] !== S.room.round);
  return { done: done.length, total: act.length, waiting };
}

function progressBar(field) {
  const p = progress(field);
  return `<div class="progress"><div style="width:${(p.done / Math.max(1, p.total)) * 100}%"></div></div>
    <p class="muted small center-text">${p.done}/${p.total}${p.waiting.length && p.waiting.length <= 3 ? ` · מחכים ל: ${p.waiting.map((u) => esc(nameOf(u))).join(", ")}` : ""}</p>`;
}

// מספר הסיבוב לתצוגה (החלפות שאלה לא נספרות)
const roundNo = () => S.room.round - (S.room.skipped || 0);

function answeringView() {
  if (!inRound()) return waitingOutView();
  const answered = S.players[S.me]?.answeredRound === S.room.round;
  const q = S.secret?.round === S.room.round ? S.secret.q : null;
  return `${header()}
  <div class="round-tag">סיבוב ${roundNo()}</div>
  ${answered ? `
    <section class="card center-text">
      <div class="emoji">🤐</div>
      <h2>התשובה נשלחה</h2>
      <p class="muted">אל תספר לאף אחד מה הייתה השאלה שלך!</p>
    </section>` : `
    <section class="card question-card">
      <div class="muted small">השאלה שלך (סודי!)</div>
      <div class="question">${q ? esc(q) : '<span class="muted">טוען…</span>'}</div>
    </section>
    <input id="ansIn" class="answer-input" maxlength="80" placeholder="התשובה שלך" enterkeyhint="send" />
    <button class="btn primary big" data-act="answer" ${q ? "" : "disabled"}>שלח תשובה</button>
`}
  ${progressBar("answeredRound")}
  ${isHost() ? `<div class="row">
    <button class="btn ghost small grow" data-act="skip-q">🔄 החלף שאלה</button>
    <button class="btn ghost small grow" data-act="force-reveal">חשוף עכשיו</button>
  </div>` : ""}`;
}

function answersTable({ highlight = null } = {}) {
  if (!S.answers.list) return `<p class="muted center-text">טוען תשובות…</p>`;
  return `<ul class="answers">${S.answers.list.map((a, i) => `
    <li class="${highlight === a.uid ? "imp" : ""}" style="animation-delay:${i * 120}ms">
      <span class="avatar" style="--h:${hue(a.uid)}">${esc((a.name || "?")[0])}</span>
      <span class="aname">${esc(a.name)}</span>
      <span class="atext">${esc(a.text)}</span>
    </li>`).join("")}</ul>`;
}

function revealView() {
  return `${header()}
  <div class="round-tag">סיבוב ${roundNo()} · התשובות</div>
  ${answersTable()}
  ${isHost()
    ? `<button class="btn primary big sticky" data-act="discussion">🔓 חשוף את השאלה</button>`
    : `<p class="center-text muted pulse">המנהל יחשוף את השאלה בעוד רגע…</p>`}`;
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function discussionView() {
  const ready = S.players[S.me]?.readyRound === S.room.round;
  const p = progress("readyRound");
  return `${header()}
  <section class="card question-card">
    <div class="muted small">השאלה של כולם הייתה</div>
    <div class="question">${esc(S.room.normalQuestion)}</div>
  </section>
  <div class="timer" id="timer">${fmt(S.room.discussionEndsAt - Date.now())}</div>
  ${answersTable()}
  ${inRound() ? `<button class="btn ${ready ? "ghost" : "primary"} big sticky" data-act="ready" ${ready ? "disabled" : ""}>
      ${ready ? `✔ מוכן (${p.done}/${p.total}, צריך רוב)` : `🗳️ מוכן להצביע (${p.done}/${p.total})`}
    </button>` : ""}
  ${isHost() ? `<button class="btn ghost small" data-act="force-vote">עבור להצבעה עכשיו</button>` : ""}`;
}

function votingView() {
  if (!inRound()) return waitingOutView();
  const voted = S.players[S.me]?.votedRound === S.room.round;
  const options = presentParticipants().filter((u) => u !== S.me);
  const ansOf = (u) => S.answers.list?.find((a) => a.uid === u)?.text;
  return `${header()}
  <div class="round-tag">מי האימפוסטר?</div>
  ${voted ? `<section class="card center-text"><div class="emoji">🗳️</div><h2>ההצבעה נקלטה</h2></section>` : `
  <ul class="vote-list">${options.map((u) => `
    <li><button class="vote-opt ${S.voteChoice === u ? "sel" : ""}" data-act="choose" data-uid="${u}">
      <span class="avatar" style="--h:${hue(u)}">${esc(nameOf(u)[0])}</span>
      <span class="aname">${esc(nameOf(u))}</span>
      <span class="atext">${esc(ansOf(u) ?? "")}</span>
    </button></li>`).join("")}
  </ul>
  <button class="btn primary big sticky" data-act="vote" ${S.voteChoice ? "" : "disabled"}>הצבע</button>`}
  ${progressBar("votedRound")}
  ${isHost() ? `<button class="btn ghost small" data-act="force-results">סגור הצבעה</button>` : ""}`;
}

function resultsView() {
  const R = S.room.result;
  if (!R) return `<div class="center muted">סופר קולות…</div>`;
  const nm = (u) => esc(R.names?.[u] || nameOf(u));
  const ranked = Object.entries(R.counts || {}).sort((a, b) => b[1] - a[1]);
  const imAmImp = R.impostorUid === S.me;
  return `${header()}
  <section class="card center-text reveal-1">
    ${R.eliminated
      ? `<div class="muted">הודח מהחדר</div><div class="elim">${nm(R.eliminated)}</div>`
      : `<div class="muted">${R.tie ? "תיקו בהצבעה!" : "אף אחד לא קיבל קולות"}</div><div class="elim">אף אחד לא הודח</div>`}
  </section>

  <section class="card center-text verdict ${R.caught ? "caught" : "escaped"} reveal-2">
    <div class="emoji">${R.caught ? "🎯" : "🕵️"}</div>
    <div class="muted">האימפוסטר היה</div>
    <div class="imp-name">${nm(R.impostorUid)}${imAmImp ? " (אתה!)" : ""}</div>
    <div class="verdict-line">${R.caught ? "נתפס!" : "הצליח לברוח!"}</div>
  </section>

  <section class="card reveal-3">
    <div class="qpair"><span class="tag">כולם</span>${esc(R.normalQ)}</div>
    <div class="qpair imp"><span class="tag">אימפוסטר</span>${esc(R.impostorQ)}</div>
  </section>

  <section class="card reveal-3">
    <h2>התשובות</h2>
    ${answersTable({ highlight: R.impostorUid })}
  </section>

  <section class="card reveal-4">
    <h2>מי הצביע למי</h2>
    <ul class="votes">${(R.votes || []).map((v) =>
      `<li><b>${nm(v.from)}</b> ← ${nm(v.to)}${v.to === R.impostorUid ? " ✔" : ""}${R.delta?.[v.from] ? ` <span class="plus">+${R.delta[v.from]}</span>` : ""}</li>`).join("")}
    </ul>
    ${ranked.length ? `<p class="muted small">${ranked.map(([u, c]) => `${nm(u)}: ${c}`).join(" · ")}</p>` : ""}
    ${!R.caught ? `<p class="plus center-text">${nm(R.impostorUid)} +2 על הבריחה</p>` : ""}
  </section>

  <section class="card reveal-4">
    <h2>טבלת ניקוד</h2>
    ${playerList({ showScores: true })}
  </section>

  ${isHost() ? `<div class="row sticky">
      <button class="btn primary big grow" data-act="start">▶ סיבוב הבא</button>
      <button class="btn ghost" data-act="lobby">ללובי</button>
    </div>` : `<p class="center-text muted">המנהל יתחיל סיבוב חדש…</p>`}`;
}

function view() {
  if (!S.me) return `<div class="center muted">מתחבר…</div>`;
  if (!S.code) return homeView();
  if (!S.room || !S.players[S.me]) return `<div class="center muted">נכנס לחדר…</div>`;
  switch (S.room.phase) {
    case "lobby": return lobbyView();
    case "answering": return answeringView();
    case "reveal": return revealView();
    case "discussion": return discussionView();
    case "voting": return votingView();
    case "results": return resultsView();
    case "closing": return `<div class="center muted">החדר נסגר…</div>`;
  }
  return "";
}

// ---------- Render (שומר על טקסט שהוקלד בזמן רינדור מחדש) ----------
let lastViewKey = "";
function render() {
  // מישהו באמצע הקלדת תשובה ושום מסך לא התחלף — לא מרנדרים עכשיו (באייפון זה סוגר את המקלדת).
  // רק מה שמשתנה מתחת לשדה (ספירת "ענו") נדחה; שליחת התשובה, שאלה שנטענה וכל שינוי אחר — מרנדרים.
  const key = `${S.code}|${S.room?.phase}|${S.room?.round}`;
  if (key === lastViewKey && typingAnswer()) { S.renderPending = true; return; }
  S.renderPending = false;
  const saved = {};
  app.querySelectorAll("input[id], select[id]").forEach((el) => (saved[el.id] = el.value));
  const openDetails = app.querySelector("details[open]") != null;
  const focused = document.activeElement?.id;

  app.innerHTML = view();

  for (const [id, v] of Object.entries(saved)) {
    const el = document.getElementById(id);
    if (el && el.type !== "hidden" && el.tagName !== "SELECT") el.value = v;
  }
  if (openDetails) app.querySelector("details")?.setAttribute("open", "");
  if (focused) document.getElementById(focused)?.focus();

  // אנימציות רק כשנכנסים למסך חדש
  app.classList.toggle("no-anim", key === lastViewKey);
  lastViewKey = key;

  const qr = $("#qr");
  if (qr && window.QRCode) {
    new window.QRCode(qr, { text: `${location.origin}${location.pathname}?room=${S.code}`, width: 150, height: 150,
      colorDark: "#14111f", colorLight: "#ffffff" });
  }
}

function typingAnswer() {
  return document.activeElement?.id === "ansIn"
    && S.room?.phase === "answering"
    && S.players[S.me]?.answeredRound !== S.room.round // עוד לא שלח
    && S.secret?.round === S.room.round;               // השאלה כבר מוצגת
}

// טיימר דיון + בדיקות מנהל
setInterval(() => {
  // (1) הטיימר לא רץ מעל 3 שניות — הטאב היה ברקע. הנתונים ישנים עד שיגיע עדכון.
  const now = Date.now();
  if (now - S.lastTick > 3000 && S.code) S.awaitSync = now;
  S.lastTick = now;
  if (S.renderPending && !typingAnswer()) render();
  if (S.room?.phase === "discussion") {
    const t = $("#timer");
    const left = S.room.discussionEndsAt - Date.now();
    if (t) { t.textContent = fmt(left); t.classList.toggle("urgent", left < 30000); }
  }
  hostKeepalive();
  hostTick();
}, 500);

// ---------- Events ----------
app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const getName = () => {
    const n = $("#nameIn")?.value.trim();
    if (!n) { toast("כתוב שם"); return null; }
    safeSet("impostor:name", n);
    return n;
  };
  try {
    switch (act) {
      // (4) הכפתור חוזר לפעול גם כשהפעולה נכשלה בלי שגיאה (למשל "לא מצאתי חדר")
      case "create": { const n = getName(); if (n) { el.disabled = true; try { await createRoom(n); } finally { if (!S.code) el.disabled = false; } } break; }
      case "join": {
        const n = getName(); const c = $("#codeIn")?.value.trim();
        if (!n) break;
        if (!c || c.length !== 4) { toast("קוד של 4 אותיות"); break; }
        el.disabled = true; try { await joinRoom(c, n); } finally { if (!S.code) el.disabled = false; } break;
      }
      case "share": {
        const url = el.dataset.url;
        if (navigator.share) await navigator.share({ title: "מי האימפוסטר?", text: `בוא לשחק! קוד: ${S.code}`, url }).catch(() => {});
        else { await navigator.clipboard?.writeText(url); toast("הקישור הועתק"); }
        break;
      }
      case "kick": await kick(el.dataset.uid); break;
      case "leave": await leaveRoom(); break;
      case "start": hostDo(startRound); break;
      case "lobby": hostDo(backToLobby); break;
      case "answer": await submitAnswer($("#ansIn")?.value || ""); break;
      case "force-reveal": if (confirm("לחשוף בלי לחכות לכולם?")) hostDo(goDiscussion); break;
      case "discussion": hostDo(goDiscussion); break;
      case "ready": await readyToVote(); break;
      case "skip-q": if (confirm("להחליף שאלה? כולם יקבלו שאלה חדשה ואימפוסטר חדש.")) hostDo(() => startRound({ reroll: true })); break;
      case "force-vote": hostDo(goVoting); break;
      case "choose": S.voteChoice = el.dataset.uid; render(); break;
      case "vote": await submitVote(); break;
      case "force-results": if (confirm("לסגור את ההצבעה?")) hostDo(goResults); break;
    }
  } catch (err) {
    console.error(err);
    toast("שגיאה: " + (err.code || err.message));
    el.disabled = false;
  }
});

app.addEventListener("change", (e) => {
  if (e.target.id === "discSel" && isHost()) updateDoc(roomRef(), { discussionSec: Number(e.target.value) });
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "ansIn") $("[data-act=answer]")?.click();
  if (e.target.id === "codeIn" || e.target.id === "nameIn") ($("[data-act=join]") || $("[data-act=create]"))?.click();
});

app.addEventListener("input", (e) => {
  if (e.target.id === "codeIn") e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
});
