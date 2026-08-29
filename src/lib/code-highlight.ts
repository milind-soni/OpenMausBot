/**
 * Shiki emits both palettes as CSS variables. The active Agent Centipede skin
 * chooses one in styles.css, so switching skins never leaves dark-theme text
 * sitting on a light clinical surface (or the inverse).
 */
export const CODE_HIGHLIGHT_OPTIONS = {
  themes: {
    light: "github-light-default",
    dark: "github-dark-default",
  },
  defaultColor: false,
} as const;
