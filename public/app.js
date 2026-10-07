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
  getDoc, getDocs, getDocsFromServer, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch, increment, serverTimestamp, deleteField, Timestamp,
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

// הפעימות הן רוב הצריכה של מכסת Firestore (כל פעימה נקראת אצל כל השחקנים בחדר) — לכן מרווחים גדולים
const BEAT_MS = 30000;      // תדירות פעימת המנהל
const STALE_MS = 90000;     // אחרי כמה זמן בלי פעימה אפשר להשתלט (תואם ל-firestore.rules)
const STAGGER_MS = 15000;   // השהיה נוספת לכל מועמד בתור
const SEEN_MS = 45000;      // כל שחקן מעדכן seenAt בתדירות הזו
const GHOST_MS = 90000;     // שחקן שלא נראה זמן כזה נחשב שסגר את הטלפון (תואם ל-firestore.rules)
const DEFAULT_DISC_SEC = 120; // זמן דיון ברירת מחדל
const DEFAULT_MIN_DISC_SEC = 30; // זמן דיון מינימלי ברירת מחדל (ניתן לשינוי בהגדרות)
const TTL_MS = 24 * 3600 * 1000; // תוקף expireAt. המחיקה עצמה (TTL) דורשת תוכנית Blaze — כרגע כבויה, ראה README
// חדר פעיל מאריך את התוקף בכל פעימה; חדר שכולם סגרו בו את הטלפון נמחק לבד
const expireAt = () => Timestamp.fromMillis(Date.now() + TTL_MS);

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

// הודעה קצרה בראש המסך. type: "info" | "ok" | "err"
let toastTimer;
function toast(msg, type = "info") {
  const t = $("#toast");
  const icon = { ok: "✓", err: "!", info: "i" }[type] || "i";
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="ticon">${icon}</span><span>${esc(msg)}</span>`;
  t.hidden = false;
  void t.offsetWidth; // מאתחל את האנימציה גם כשהודעה מחליפה הודעה
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    toastTimer = setTimeout(() => (t.hidden = true), 250);
  }, type === "err" ? 3600 : 2600);
}

// הודעת שגיאה קריאה במקום קוד של Firebase
function errText(e) {
  const code = e?.code || "";
  if (code.includes("permission-denied")) return "אין הרשאה לפעולה הזו. ייתכן שהמנהל התחלף";
  if (code.includes("unavailable") || code.includes("network")) return "אין חיבור לשרת. בדוק את האינטרנט ונסה שוב";
  return "משהו השתבש. נסה שוב";
}

// חלון אישור מעוצב במקום confirm() של הדפדפן. מחזיר true אם אישרו.
function ask({ title, text = "", ok = "אישור", cancel = "ביטול", danger = false }) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "modal-backdrop";
    el.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mTitle">
      <h2 id="mTitle">${esc(title)}</h2>
      ${text ? `<p class="muted">${esc(text)}</p>` : ""}
      <div class="row">
        <button class="btn grow ${danger ? "danger" : "primary"}" data-m="ok">${esc(ok)}</button>
        <button class="btn ghost grow" data-m="cancel">${esc(cancel)}</button>
      </div>
    </div>`;
    let closed = false;
    const done = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      el.classList.add("out");
      setTimeout(() => el.remove(), 160);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    el.addEventListener("click", (e) => {
      const m = e.target.closest("[data-m]")?.dataset.m;
      if (m) done(m === "ok");
      else if (e.target === el) done(false); // לחיצה מחוץ לחלון
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
    el.querySelector("[data-m=ok]").focus();
  });
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
  // נפתח מאייקון במסך הבית — אין קוד בכתובת, אז חוזרים לחדר האחרון שלא יצאנו ממנו
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const code = (urlCode || (installed ? saved : "") || "").toUpperCase();
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
  if (!code) return toast("לא הצלחתי ליצור חדר. נסה שוב", "err");
  await setDoc(doc(db, "rooms", code), {
    hostUid: S.me, phase: "lobby", round: 0, participants: [],
    discussionSec: DEFAULT_DISC_SEC, minDiscSec: DEFAULT_MIN_DISC_SEC, goal: "none", played: 0, createdAt: Date.now(), result: null, normalQuestion: null, discussionEndsAt: null, discussionStartedAt: null,
    hostSeenAt: serverTimestamp(), expireAt: expireAt(),
  });
  await setDoc(doc(db, "rooms", code, "players", S.me), { name, score: 0, joinedAt: Date.now(), seenAt: serverTimestamp(), expireAt: expireAt() });
  await enterRoom(code);
}

async function joinRoom(code, name) {
  code = code.toUpperCase().trim();
  const snap = await getDoc(doc(db, "rooms", code));
  if (!snap.exists()) return toast("לא מצאתי חדר עם הקוד הזה", "err");
  const pRef = doc(db, "rooms", code, "players", S.me);
  const p = await getDoc(pRef);
  if (p.exists()) await updateDoc(pRef, { name, expireAt: expireAt() });
  else await setDoc(pRef, { name, score: 0, joinedAt: Date.now(), seenAt: serverTimestamp(), expireAt: expireAt() });
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
      toast("אתה המנהל עכשיו 👑", "ok");
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
  if (!(await ask({ title: "לצאת מהחדר?", text: !isHost() ? "" : hostCandidates().length ? "תפקיד המנהל יעבור לשחקן אחר." : "אין שחקנים מחוברים נוספים, אז החדר ייסגר.", ok: "יציאה", danger: true }))) return;
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
  const strip = ({ hostSeenAt, expireAt, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

// מפתח השוואה לרשימת השחקנים בלי seenAt ו-expireAt (שמשתנים בכל פעימה)
function playersKey(players) {
  return JSON.stringify(Object.keys(players).sort().map((u) => {
    const { seenAt, expireAt, ...rest } = players[u];
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
    updateDoc(subDoc("players", S.me), { seenAt: serverTimestamp(), expireAt: expireAt() }).catch((e) => console.error("seen", e));
  }
  // מישהו התחבר/נעלם — לרנדר כדי לעדכן "מחכים ל…"
  const aliveKey = Object.keys(S.players).filter(isAlive).sort().join();
  if (aliveKey !== S.aliveKey) { S.aliveKey = aliveKey; render(); }
  if (isHost()) {
    if (now - S.lastBeat < BEAT_MS) return;
    S.lastBeat = now;
    updateDoc(roomRef(), { hostSeenAt: serverTimestamp(), expireAt: expireAt() }).catch((e) => console.error("beat", e));
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
    if (prev === "answering") toast("המנהל החליף את השאלה. יש לך שאלה חדשה");
  }
  if (["discussion", "voting", "results", "podium"].includes(ph)) vibrate(ph === "results" || ph === "podium" ? 200 : 60);
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
  if (!text) return toast("כתוב תשובה לפני השליחה", "err");
  const r = S.room.round;
  await setDoc(subDoc("answers", S.me), { round: r, text: text.slice(0, 80), name: nameOf(S.me), at: Date.now(), expireAt: expireAt() });
  await updateDoc(subDoc("players", S.me), { answeredRound: r });
  vibrate();
}

async function readyToVote() {
  await updateDoc(subDoc("players", S.me), { readyRound: S.room.round });
}

async function submitVote() {
  if (!S.voteChoice) return toast("בחר את מי אתה חושד", "err");
  const r = S.room.round;
  await setDoc(subDoc("votes", S.me), { round: r, target: S.voteChoice, expireAt: expireAt() });
  await updateDoc(subDoc("players", S.me), { votedRound: r });
  vibrate();
}

// ---------- Host (game master) ----------
async function hostDo(fn) {
  if (S.hostBusy) return;
  S.hostBusy = true;
  try { await fn(); } catch (e) { console.error(e); toast(errText(e), "err"); }
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
      // ב-30 השניות הראשונות צריך את כולם; אחרי זה רוב; ובסוף הטיימר עוברים בכל מקרה
      const ready = act.filter((u) => S.players[u].readyRound === r).length;
      const enough = discEarly() ? ready === act.length : ready > act.length / 2;
      if (Date.now() >= S.room.discussionEndsAt || enough) hostDo(goVoting);
      break;
    }
    case "voting":
      if (act.every((u) => S.players[u].votedRound === r)) hostDo(goResults);
      break;
  }
}

// כמה זמן עבר מתחילת הדיון. חדר שהתחיל דיון לפני שנוסף discussionStartedAt — מחשבים מהטיימר.
const discElapsed = () => Date.now() -
  (S.room.discussionStartedAt ?? S.room.discussionEndsAt - (S.room.discussionSec || DEFAULT_DISC_SEC) * 1000);
// לפני הזמן המינימלי עוברים להצבעה רק אם *כולם* מוכנים; אחריו מספיק רוב. 0 = כבוי.
const minDiscSec = () => S.room.minDiscSec ?? DEFAULT_MIN_DISC_SEC;
const discEarly = () => discElapsed() < minDiscSec() * 1000;

// אחרי שהטאב הוקפא ברקע, נתוני "מי מחובר" ישנים — מחכים לעדכון טרי (עד 16 שניות, סבב פעימות אחד)
const syncing = () => S.awaitSync && Date.now() - S.awaitSync < 16000;

// reroll: החלפת שאלה באמצע שלב המענה — אותו מספר סיבוב בתצוגה
async function startRound({ reroll = false } = {}) {
  // רק שחקנים מחוברים — מי שסגר את הטלפון לא נכנס לסיבוב ולא יכול להיות אימפוסטר
  if (S.room.gameOver) return toast("המשחק נגמר. התחילו משחק חדש", "err");
  if (syncing()) return toast("מתחבר מחדש… נסה שוב בעוד רגע");
  const ids = Object.keys(S.players).filter(isAlive);
  if (ids.length < 3) return toast("צריך לפחות 3 שחקנים מחוברים", "err");

  const cq = reroll ? "" : $("#customQ")?.value.trim(), ci = reroll ? "" : $("#customImp")?.value.trim();
  if (!!cq !== !!ci) return toast("מלא את שתי השאלות, או השאר את שתיהן ריקות", "err");
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
  // שחקן בלי רשומה (הצטרף מאוחר / לא השתתף עד עכשיו) לא היה אימפוסטר אף פעם — מקבל את המשקל הגבוה ביותר
  const since = S.room.impSince || {};
  const maxSince = Math.max(0, ...Object.values(since));
  const imp = weightedPick(ids, (u) => (1 + (since[u] ?? maxSince)) ** 2);
  const r = (S.room.round || 0) + 1;
  const b = writeBatch(db);
  ids.forEach((u) => b.set(subDoc("secrets", u), { round: r, q: u === imp ? pair.imp : pair.q, expireAt: expireAt() }));
  b.set(subDoc("hostOnly", "state"), { round: r, impostorUid: imp, normalQ: pair.q, impQ: pair.imp, usedQ: used, expireAt: expireAt() });
  b.update(roomRef(), {
    phase: "answering", round: r, participants: ids, usedQ: deleteField(),
    skipped: (S.room.skipped || 0) + (reroll ? 1 : 0),
    normalQuestion: null, result: null, discussionEndsAt: null, discussionStartedAt: null,
  });
  await b.commit();
  if ($("#customQ")) { $("#customQ").value = ""; $("#customImp").value = ""; }
}


async function goDiscussion() {
  const hs = (await getDoc(subDoc("hostOnly", "state"))).data();
  await updateDoc(roomRef(), {
    phase: "discussion",
    normalQuestion: hs.normalQ,
    discussionStartedAt: Date.now(),
    discussionEndsAt: Date.now() + (S.room.discussionSec || DEFAULT_DISC_SEC) * 1000,
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

  // סוף משחק: הגענו למספר הסיבובים, או שמישהו הגיע לניקוד היעד
  const played = playedRounds() + 1;
  const goal = parseGoal(S.room.goal);
  const gameOver = goal?.type === "rounds" ? played >= goal.n
    : goal?.type === "points" ? Object.keys(S.players).some((u) => (S.players[u].score || 0) + (delta[u] || 0) >= goal.n)
    : false;

  const b = writeBatch(db);
  Object.entries(delta).forEach(([u, d]) => { if (S.players[u]) b.update(subDoc("players", u), { score: increment(d) }); });
  b.update(roomRef(), {
    phase: "results", impSince, played, gameOver,
    result: {
      votes, counts, eliminated, caught, tie: max > 0 && top.length > 1,
      impostorUid: hs.impostorUid, impostorQ: hs.impQ, normalQ: hs.normalQ, names, delta,
    },
  });
  await b.commit();
}

async function showPodium() {
  await updateDoc(roomRef(), { phase: "podium" });
}

// משחק חדש: מאפסים ניקוד וספירת סיבובים. impSince נשמר כדי שההגרלה תישאר הוגנת בין משחקים.
async function newGame() {
  const b = writeBatch(db);
  Object.keys(S.players).forEach((u) => b.update(subDoc("players", u), { score: 0 }));
  b.update(roomRef(), { phase: "lobby", participants: [], result: null, normalQuestion: null, played: 0, gameOver: false });
  await b.commit();
}

async function backToLobby() {
  await updateDoc(roomRef(), { phase: "lobby", participants: [], result: null, normalQuestion: null });
}

async function kick(uid) {
  if (!(await ask({ title: `להוציא את ${nameOf(uid)}?`, text: "השחקן יוצא מהחדר והניקוד שלו נמחק.", ok: "הוצאה", danger: true }))) return;
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
    ${playerList({ showKick: host, showScores: playedRounds() > 0 })}
  </section>
  ${host ? `
  <section class="card settings">
    <h2>הגדרות</h2>
    ${settingsView()}
    <details class="custom">
      <summary>✍️ זוג שאלות משלכם (אופציונלי)</summary>
      <input id="customQ" maxlength="120" placeholder="השאלה של כולם" />
      <input id="customImp" maxlength="120" placeholder="השאלה של האימפוסטר" />
      <p class="muted small">אם שני השדות מלאים — הסיבוב הבא ישתמש בהם במקום בבנק.</p>
    </details>
  </section>
  <button class="btn primary big sticky" data-act="start" ${n < 3 ? "disabled" : ""}>
    ${n < 3 ? `מחכים לעוד ${3 - n} שחקנים…` : playedRounds() > 0 ? "▶ סיבוב הבא" : "▶ התחל משחק"}
  </button>` : `<p class="center-text muted small">${esc(settingsSummary())}</p>
  <p class="center-text muted pulse">מחכים שהמנהל יתחיל…</p>`}`;
}

// ---------- הגדרות (רק המנהל) ----------
// כפתורי בחירה במקום רשימות נפתחות: כל האפשרויות גלויות, לחיצה אחת בוחרת
const DISC_MAX = [60, 120, 180, 240, 300];     // זמן דיון מקסימלי (שניות)
const DISC_MIN = [0, 15, 30, 60];              // זמן מינימלי לפני מעבר ברוב (שניות), 0 = כבוי
const GOAL_NUMS = { rounds: [5, 8, 10], points: [10, 15, 20] };
const GOAL_DEFAULT = { rounds: 8, points: 15 };

function seg(key, options, current) {
  return `<div class="seg" role="radiogroup">${options.map(([val, label]) =>
    `<button type="button" role="radio" aria-checked="${val === current}" class="${val === current ? "on" : ""}"
      data-act="set" data-key="${key}" data-val="${val}">${label}</button>`).join("")}</div>`;
}

function settingsView() {
  const goal = parseGoal(S.room.goal);
  const type = goal?.type || "none";
  return `
    <div class="setting">
      <div class="setting-label">⏱️ זמן דיון <span class="muted">(דקות)</span></div>
      ${seg("discussionSec", DISC_MAX.map((s) => [String(s), String(s / 60)]), String(S.room.discussionSec || DEFAULT_DISC_SEC))}
    </div>
    <div class="setting">
      <div class="setting-label">⏳ זמן מינימלי <span class="muted">(שניות)</span></div>
      ${seg("minDiscSec", DISC_MIN.map((s) => [String(s), s ? String(s) : "כבוי"]), String(minDiscSec()))}
      <div class="setting-hint">${minDiscSec()
        ? "עד אז צריך שכולם יהיו מוכנים, אחר כך מספיק רוב"
        : "עוברים להצבעה ברגע שרוב השחקנים מוכנים"}</div>
    </div>
    <div class="setting">
      <div class="setting-label">🏁 אורך משחק</div>
      ${seg("goalType", [["none", "בלי הגבלה"], ["rounds", "סיבובים"], ["points", "נקודות"]], type)}
      ${goal ? seg("goalN", GOAL_NUMS[type].map((n) => [String(n), type === "rounds" ? `${n}` : `עד ${n}`]), String(goal.n)) : ""}
    </div>`;
}

// שורה קצרה לשחקנים שאינם המנהל: מה נבחר
function settingsSummary() {
  const goal = parseGoal(S.room.goal);
  const min = minDiscSec();
  return [
    `דיון עד ${(S.room.discussionSec || DEFAULT_DISC_SEC) / 60} דק'`,
    min ? `מינימום ${min} שנ'` : "",
    goal?.type === "rounds" ? `${goal.n} סיבובים` : goal?.type === "points" ? `עד ${goal.n} נקודות` : "בלי הגבלת סיבובים",
  ].filter(Boolean).join(" · ");
}

function applySetting(key, val) {
  const goal = parseGoal(S.room.goal);
  if (key === "discussionSec" || key === "minDiscSec") return updateDoc(roomRef(), { [key]: Number(val) });
  if (key === "goalType") {
    if (val === (goal?.type || "none")) return;
    return updateDoc(roomRef(), { goal: val === "none" ? "none" : `${val}:${GOAL_DEFAULT[val]}` });
  }
  if (key === "goalN" && goal) return updateDoc(roomRef(), { goal: `${goal.type}:${val}` });
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

// כמה סיבובים הסתיימו במשחק הנוכחי. חדר ישן בלי played: לפי מספר הסיבוב פחות החלפות שאלה.
const playedRounds = () => S.room.played ?? Math.max(0, S.room.round - (S.room.skipped || 0) - 1);
// מספר הסיבוב הנוכחי לתצוגה, עם היעד אם יש
function roundNo() {
  const goal = parseGoal(S.room.goal);
  const n = playedRounds() + 1;
  return goal?.type === "rounds" ? `${n} מתוך ${goal.n}` : goal?.type === "points" ? `${n} · עד ${goal.n} נק'` : n;
}

// אורך משחק: "none" | "rounds:N" | "points:N"
function parseGoal(g) {
  const [type, n] = String(g || "none").split(":");
  return (type === "rounds" || type === "points") && Number(n) > 0 ? { type, n: Number(n) } : null;
}

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
  <p class="disc-hint muted small center-text" id="discHint">${discHint()}</p>
  ${answersTable()}
  ${inRound() ? `<button class="btn ${ready ? "ghost" : "primary"} big sticky" data-act="ready" ${ready ? "disabled" : ""}>
      ${ready ? `✔ מוכן (${p.done}/${p.total})` : `🗳️ מוכן להצביע (${p.done}/${p.total})`}
    </button>` : ""}
  ${isHost() ? `<button class="btn ghost small" data-act="force-vote" ${discEarly() ? "disabled" : ""}>עבור להצבעה עכשיו</button>` : ""}`;
}

// מה צריך כדי לעבור להצבעה לפני שהטיימר נגמר
function discHint() {
  return discEarly()
    ? `מעבר מוקדם להצבעה רק אם <b>כולם</b> מוכנים · עוד ${fmt(minDiscSec() * 1000 - discElapsed())} יספיק רוב`
    : `עוברים להצבעה כש<b>רוב</b> השחקנים מוכנים`;
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

  ${S.room.gameOver ? `
  <section class="card center-text reveal-4">
    <div class="emoji">🏁</div>
    <h2>זה היה הסיבוב האחרון</h2>
  </section>
  ${isHost()
    ? `<button class="btn primary big sticky" data-act="podium">🏆 מי ניצח?</button>`
    : `<p class="center-text muted pulse">המנהל יחשוף את המנצחים…</p>`}`
  : isHost() ? `<div class="row sticky">
      <button class="btn primary big grow" data-act="start">▶ סיבוב הבא</button>
      <button class="btn ghost" data-act="lobby">ללובי</button>
    </div>` : `<p class="center-text muted">המנהל יתחיל סיבוב חדש…</p>`}`;
}

// מסך סיום: פודיום לשלושת הראשונים וטבלה מלאה. שוויון בניקוד = אותו מקום.
function podiumView() {
  const score = (u) => S.players[u].score || 0;
  const ids = Object.keys(S.players).sort((a, b) => score(b) - score(a));
  const place = {};
  ids.forEach((u, i) => (place[u] = i && score(u) === score(ids[i - 1]) ? place[ids[i - 1]] : i + 1));
  const winners = ids.filter((u) => place[u] === 1);
  const step = (u, cls) => u ? `<div class="step ${cls}">
      <span class="avatar" style="--h:${hue(u)}">${esc((S.players[u].name || "?")[0])}</span>
      <div class="step-name">${esc(S.players[u].name)}</div>
      <div class="step-block"><b>${place[u]}</b><span>${score(u)} נק'</span></div>
    </div>` : "";
  return `${header()}
  <section class="card center-text reveal-1">
    <div class="emoji">🏆</div>
    <div class="muted">${winners.length > 1 ? "במקום הראשון, בתיקו" : "במקום הראשון"}</div>
    <div class="winner-name">${winners.map((u) => esc(nameOf(u))).join(", ")}</div>
  </section>
  <div class="podium reveal-2">${step(ids[1], "second")}${step(ids[0], "first")}${step(ids[2], "third")}</div>
  <section class="card reveal-3">
    <h2>טבלה סופית</h2>
    ${playerList({ showScores: true })}
  </section>
  ${isHost()
    ? `<button class="btn primary big sticky" data-act="new-game">🔁 משחק חדש</button>`
    : `<p class="center-text muted">המנהל יתחיל משחק חדש…</p>`}`;
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
    case "podium": return podiumView();
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
    // עברו 30 השניות הראשונות — לרנדר כדי לפתוח את כפתור המנהל
    const button = $("[data-act=force-vote]");
    if (button && button.disabled !== discEarly()) render();
    else { const h = $("#discHint"); if (h) h.innerHTML = discHint(); }
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
    if (!n) { toast("כתוב את השם שלך", "err"); return null; }
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
        if (!c || c.length !== 4) { toast("קוד החדר הוא 4 אותיות", "err"); break; }
        el.disabled = true; try { await joinRoom(c, n); } finally { if (!S.code) el.disabled = false; } break;
      }
      case "share": {
        const url = el.dataset.url;
        if (navigator.share) await navigator.share({ title: "מי האימפוסטר?", text: `בוא לשחק! קוד: ${S.code}`, url }).catch(() => {});
        else { await navigator.clipboard?.writeText(url); toast("הקישור הועתק", "ok"); }
        break;
      }
      case "kick": await kick(el.dataset.uid); break;
      case "leave": await leaveRoom(); break;
      case "start": hostDo(startRound); break;
      case "set": if (isHost() && S.room?.phase === "lobby") await applySetting(el.dataset.key, el.dataset.val); break;
      case "lobby": hostDo(backToLobby); break;
      case "podium": hostDo(showPodium); break;
      case "new-game":
        if (await ask({ title: "להתחיל משחק חדש?", text: "הניקוד של כולם יתאפס.", ok: "🔁 משחק חדש" })
          && S.room?.phase === "podium") hostDo(newGame);
        break;
      case "answer": await submitAnswer($("#ansIn")?.value || ""); break;
      case "force-reveal":
        if (await ask({ title: "לחשוף עכשיו?", text: "מי שעוד לא ענה יישאר בלי תשובה בסיבוב הזה.", ok: "חשוף" })
          && S.room?.phase === "answering") hostDo(goDiscussion);
        break;
      case "discussion": hostDo(goDiscussion); break;
      case "ready": await readyToVote(); break;
      case "skip-q":
        if (await ask({ title: "להחליף שאלה?", text: "כל השחקנים יקבלו זוג שאלות חדש, ויוגרל אימפוסטר חדש. תשובות שכבר נשלחו יימחקו.", ok: "🔄 החלף שאלה" })
          && S.room?.phase === "answering") hostDo(() => startRound({ reroll: true }));
        break;
      case "force-vote": if (S.room?.phase === "discussion" && !discEarly()) hostDo(goVoting); break;
      case "choose": S.voteChoice = el.dataset.uid; render(); break;
      case "vote": await submitVote(); break;
      case "force-results":
        if (await ask({ title: "לסגור את ההצבעה?", text: "מי שעוד לא הצביע לא ייספר.", ok: "סגור הצבעה" })
          && S.room?.phase === "voting") hostDo(goResults);
        break;
    }
  } catch (err) {
    console.error(err);
    toast(errText(err), "err");
    el.disabled = false;
  }
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "ansIn") $("[data-act=answer]")?.click();
  if (e.target.id === "codeIn" || e.target.id === "nameIn") ($("[data-act=join]") || $("[data-act=create]"))?.click();
});

app.addEventListener("input", (e) => {
  if (e.target.id === "codeIn") e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "");
});
