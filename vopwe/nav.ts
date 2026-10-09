export const VOPWE_NAV_MOVED = ["routines", "triggers", "apps", "team-map"] as const;

export const VOPWE_NAV_DESTINATIONS = {
  routines: "profile-menu+settings",
  triggers: "profile-menu-modal",
  apps: "profile-menu-modal",
  "team-map": "profile-menu+settings-advanced",
} as const;
