/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DASHBOARD_APP_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
