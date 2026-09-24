/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project token. Analytics stay off when it is unset. */
  readonly VITE_POSTHOG_TOKEN?: string;
}
