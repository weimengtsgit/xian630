/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 演示应用所在主机地址前缀（默认 http://220.154.5.91），见 src/data/apps.ts */
  readonly VITE_DEMO_APP_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
