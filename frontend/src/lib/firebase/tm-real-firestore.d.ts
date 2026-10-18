/** vite.config.ts › firestoreAlias: the real SDK behind src/lib/firebase/routedFirestore.ts. */
declare module 'tm-real-firestore' {
  export * from 'firebase/firestore';
}
