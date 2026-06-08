/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_REMOTE_CLIENT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
