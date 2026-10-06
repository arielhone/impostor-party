// הדבק כאן את ה-config מ-Firebase Console:
// Project settings → General → Your apps → Web app → SDK setup and configuration → Config
export const firebaseConfig = {
  apiKey: "AIzaSyDrzT7P0rzLbufe-KCpRYRL7T95JFZiQXM",
  authDomain: "imposter-c9f06.firebaseapp.com",
  projectId: "imposter-c9f06",
  storageBucket: "imposter-c9f06.firebasestorage.app",
  messagingSenderId: "214826463750",
  appId: "1:214826463750:web:3f326cdb0ca4eae81d0987",
};

// true = עבודה מול האמולטור המקומי (לבדיקות בלבד)
// (פעיל אוטומטית רק כשמריצים `firebase emulators:start` ופותחים את localhost:5000)
export const USE_EMULATOR =
  (location.hostname === "localhost" || location.hostname === "127.0.0.1") && location.port === "5000";
