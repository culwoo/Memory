import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId
);

export const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : undefined;

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : undefined;

export const firestoreDb = firebaseApp
  ? initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    })
  : undefined;

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

function prefersRedirectSignIn(): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function subscribeAuth(callback: (user: User | null) => void): () => void {
  if (!firebaseAuth) {
    callback(null);
    return () => undefined;
  }

  return onAuthStateChanged(firebaseAuth, callback);
}

export async function signInWithGoogle(): Promise<void> {
  if (!firebaseAuth) {
    throw new Error("Firebase is not configured.");
  }

  if (prefersRedirectSignIn()) {
    await signInWithRedirect(firebaseAuth, googleProvider);
    return;
  }

  try {
    await signInWithPopup(firebaseAuth, googleProvider);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code.includes("popup") || code.includes("cancelled")) {
      await signInWithRedirect(firebaseAuth, googleProvider);
      return;
    }
    throw error;
  }
}

export async function signOutFromGoogle(): Promise<void> {
  if (!firebaseAuth) return;
  await signOut(firebaseAuth);
}

