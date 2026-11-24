/** What is on a phone's screen that the back button can step back from, nearest first. */
export interface PhoneBackPlace {
  /** The automations calendar, which covers the list and the menu button. */
  calendar: boolean;
  drawerOpen: boolean;
  panelOpen: boolean;
  /** The apps page is open; it stays open under the list unless back closes it. */
  appsPage: boolean;
  /** Steps the bot list keeps: the open list, and a screen reached from it. */
  drawerSteps: number;
}

export type PhoneBackStep = "calendar" | "drawer" | "panels" | "apps-page";

export function phoneBackSteps(place: PhoneBackPlace): number {
  return (place.calendar ? 1 : 0) + (place.panelOpen ? 1 : 0) + place.drawerSteps;
}

/**
 * One back press: the calendar goes back to the automations list, then the open list closes, then the side panels;
 * the apps page reached from the list closes as the list comes back.
 */
export function phoneBackStep(place: PhoneBackPlace): PhoneBackStep {
  if (place.calendar) return "calendar";
  if (place.drawerOpen) return "drawer";
  if (place.panelOpen) return "panels";
  return place.appsPage && place.drawerSteps > 0 ? "apps-page" : "drawer";
}
