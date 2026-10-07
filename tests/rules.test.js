// בדיקות ל-firestore.rules מול אמולטור Firestore.
// הרצה: npm test (מתוך התיקייה tests/, דורש Java).
// כל בדיקה מתחילה מחדר נקי: מנהל host, משתתפים alice ו-bob, ו-carol שהצטרפה באמצע הסיבוב.

import { test, before, beforeEach, after } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, setLogLevel } from "firebase/firestore";

setLogLevel("silent"); // הרשאות שנדחו הן התוצאה המצופה ברוב הבדיקות — לא להציף את הפלט

const ROOM = "ROOM";
const ago = (sec) => Timestamp.fromMillis(Date.now() - sec * 1000);

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-impostor",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});

after(() => env.cleanup());

// מצב החדר ההתחלתי; over מאפשר לשנות שדות במסמך החדר
async function seed(over = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const at = (...p) => doc(db, "rooms", ROOM, ...p);
    await setDoc(doc(db, "rooms", ROOM), {
      hostUid: "host", phase: "answering", round: 1, participants: ["host", "alice", "bob"],
      hostSeenAt: ago(0), ...over,
    });
    for (const u of ["host", "alice", "bob", "carol"]) {
      await setDoc(at("players", u), { name: u, score: 0, joinedAt: 0, seenAt: ago(0) });
    }
    await setDoc(at("secrets", "alice"), { round: 1, q: "normal" });
    await setDoc(at("secrets", "bob"), { round: 1, q: "impostor" });
    await setDoc(at("hostOnly", "state"), { round: 1, impostorUid: "bob" });
    await setDoc(at("answers", "alice"), { round: 1, text: "7" });
    await setDoc(at("votes", "alice"), { round: 1, target: "bob" });
  });
}

const as = (uid) => env.authenticatedContext(uid).firestore();
const ref = (db, ...p) => doc(db, "rooms", ROOM, ...p);
const room = (db) => doc(db, "rooms", ROOM);

beforeEach(() => seed());

// ---------- סודות ----------

test("שחקן קורא רק את השאלה של עצמו", async () => {
  await assertSucceeds(getDoc(ref(as("alice"), "secrets", "alice")));
  await assertFails(getDoc(ref(as("alice"), "secrets", "bob")));
});

test("זהות האימפוסטר (hostOnly) גלויה רק למנהל", async () => {
  await assertFails(getDoc(ref(as("alice"), "hostOnly", "state")));
  await assertSucceeds(getDoc(ref(as("host"), "hostOnly", "state")));
});

test("שחקן לא יכול לכתוב שאלה סודית", async () => {
  await assertFails(setDoc(ref(as("alice"), "secrets", "bob"), { round: 1, q: "x" }));
});

test("משתמש לא מחובר לא קורא כלום", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(room(db)));
});

// ---------- תשובות ----------

test("תשובות נעולות לקריאה בזמן שלב המענה", async () => {
  await assertFails(getDoc(ref(as("bob"), "answers", "alice")));
  await seed({ phase: "discussion" });
  await assertSucceeds(getDoc(ref(as("bob"), "answers", "alice")));
});

test("משתתף כותב תשובה רק בשם עצמו, רק בסיבוב הנוכחי", async () => {
  const db = as("bob");
  await assertSucceeds(setDoc(ref(db, "answers", "bob"), { round: 1, text: "8" }));
  await assertFails(setDoc(ref(db, "answers", "alice"), { round: 1, text: "8" }));
  await assertFails(setDoc(ref(db, "answers", "bob"), { round: 0, text: "8" }));
});

test("מי שלא משתתף בסיבוב לא יכול לענות", async () => {
  await assertFails(setDoc(ref(as("carol"), "answers", "carol"), { round: 1, text: "8" }));
});

test("אי אפשר לענות אחרי ששלב המענה נסגר", async () => {
  await seed({ phase: "discussion" });
  await assertFails(setDoc(ref(as("bob"), "answers", "bob"), { round: 1, text: "8" }));
});

// ---------- הצבעות ----------

test("הצבעות גלויות רק למנהל ובשלב התוצאות", async () => {
  await seed({ phase: "voting" });
  await assertFails(getDoc(ref(as("bob"), "votes", "alice")));
  await assertSucceeds(getDoc(ref(as("host"), "votes", "alice")));
  await seed({ phase: "results" });
  await assertSucceeds(getDoc(ref(as("bob"), "votes", "alice")));
});

test("אי אפשר להצביע לעצמך או מחוץ לשלב ההצבעה", async () => {
  await assertFails(setDoc(ref(as("bob"), "votes", "bob"), { round: 1, target: "alice" }));
  await seed({ phase: "voting" });
  await assertFails(setDoc(ref(as("bob"), "votes", "bob"), { round: 1, target: "bob" }));
  await assertSucceeds(setDoc(ref(as("bob"), "votes", "bob"), { round: 1, target: "alice" }));
});

// ---------- שחקנים וניקוד ----------

test("שחקן לא יכול לשנות את הניקוד של עצמו", async () => {
  await assertFails(updateDoc(ref(as("alice"), "players", "alice"), { score: 99 }));
});

test("שחקן מעדכן אצלו שדות סטטוס, כולל seenAt ו-expireAt", async () => {
  await assertSucceeds(updateDoc(ref(as("alice"), "players", "alice"), {
    seenAt: serverTimestamp(), expireAt: ago(-86400), answeredRound: 1,
  }));
  await assertFails(updateDoc(ref(as("alice"), "players", "bob"), { seenAt: serverTimestamp() }));
});

test("שחקן חדש נכנס רק עם ניקוד 0, ורק בשם עצמו", async () => {
  await assertFails(setDoc(ref(as("dave"), "players", "dave"), { name: "d", score: 5 }));
  await assertFails(setDoc(ref(as("dave"), "players", "eve"), { name: "e", score: 0 }));
  await assertSucceeds(setDoc(ref(as("dave"), "players", "dave"), { name: "d", score: 0 }));
});

test("המנהל יכול לעדכן ניקוד ולהוציא שחקן", async () => {
  await assertSucceeds(updateDoc(ref(as("host"), "players", "alice"), { score: 3 }));
  await assertSucceeds(deleteDoc(ref(as("host"), "players", "bob")));
});

// ---------- שלבים וחדר ----------

test("רק המנהל מעביר שלב", async () => {
  await assertFails(updateDoc(room(as("alice")), { phase: "discussion" }));
  await assertSucceeds(updateDoc(room(as("host")), { phase: "discussion" }));
});

test("המנהל מעביר את התפקיד רק לשחקן שנמצא בחדר", async () => {
  await assertFails(updateDoc(room(as("host")), { hostUid: "stranger" }));
  await assertSucceeds(updateDoc(room(as("host")), { hostUid: "alice" }));
});

test("מחיקת חדר: רק המנהל, ורק בשלב closing", async () => {
  await assertFails(deleteDoc(room(as("host"))));
  await seed({ phase: "closing" });
  await assertFails(deleteDoc(room(as("alice"))));
  await assertSucceeds(deleteDoc(room(as("host"))));
});

test("בשלב closing המנהל יכול לקרוא ולמחוק סודות", async () => {
  await seed({ phase: "closing" });
  await assertSucceeds(getDoc(ref(as("host"), "secrets", "bob")));
  await assertSucceeds(deleteDoc(ref(as("host"), "answers", "alice")));
});

// ---------- השתלטות על תפקיד המנהל ----------

const takeover = (uid) => updateDoc(room(as(uid)), { hostUid: uid, hostSeenAt: serverTimestamp() });

test("אי אפשר להשתלט כשהמנהל שלח פעימה לאחרונה", async () => {
  await assertFails(takeover("alice"));
});

test("מנהל ששתק 60 שניות עדיין לא מוחלף (פעימה כל 30 שניות, סף 90)", async () => {
  await seed({ hostSeenAt: ago(60) });
  await assertFails(takeover("alice"));
});

test("שחקן מחובר משתלט כשהמנהל לא הגיב 90 שניות", async () => {
  await seed({ hostSeenAt: ago(120) });
  await assertSucceeds(takeover("alice"));
});

test("שחקן מחובר משתלט מיד כשהמנהל יצא מהחדר", async () => {
  await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), "rooms", ROOM, "players", "host")));
  await assertSucceeds(takeover("alice"));
});

test("שחקן שבעצמו לא מחובר (בלי פעימה 90 שניות) לא יכול להשתלט", async () => {
  await seed({ hostSeenAt: ago(120) });
  await env.withSecurityRulesDisabled((ctx) =>
    updateDoc(doc(ctx.firestore(), "rooms", ROOM, "players", "alice"), { seenAt: ago(120) }));
  await assertFails(takeover("alice"));
});

test("מי שלא בחדר לא יכול להשתלט", async () => {
  await seed({ hostSeenAt: ago(120) });
  await assertFails(takeover("stranger"));
});

test("השתלטות לא יכולה לשנות שדות אחרים או לקבוע זמן משלה", async () => {
  await seed({ hostSeenAt: ago(120) });
  await assertFails(updateDoc(room(as("alice")), { hostUid: "alice", hostSeenAt: serverTimestamp(), phase: "results" }));
  await assertFails(updateDoc(room(as("alice")), { hostUid: "alice", hostSeenAt: ago(-3600) }));
});

test("חדר בלי hostSeenAt לא פתוח להשתלטות", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "rooms", ROOM), { hostUid: "host", phase: "lobby", round: 0, participants: [] });
    await setDoc(doc(db, "rooms", ROOM, "players", "host"), { name: "host", score: 0, seenAt: ago(0) });
    await setDoc(doc(db, "rooms", ROOM, "players", "alice"), { name: "alice", score: 0, seenAt: ago(0) });
  });
  await assertFails(takeover("alice"));
});
