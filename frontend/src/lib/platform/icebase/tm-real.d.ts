// The real Firebase SDK modules under the names the IceBase build's wrappers import them by
// (vite.config.ts aliases 'firebase/auth' and 'firebase/storage' to those wrappers).
declare module 'tm-real-auth' {
  export * from 'firebase/auth';
}
declare module 'tm-real-storage' {
  export * from 'firebase/storage';
}
