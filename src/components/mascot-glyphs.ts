// The symbols the mascot stands aside to show. {{GRADIENT}} is filled in by CursorAvatar.

export const GLYPH_BANG =
  '<path fill="{{GRADIENT}}" d="M99 58 Q99 43 114.3 43 Q129.6 43 129.6 58 L123 150 Q122 161 114.3 161 Q106.6 161 105.6 150 Z"/>' +
  '<circle fill="{{GRADIENT}}" cx="114.3" cy="188" r="15"/>'

export const GLYPH_QUERY =
  '<path fill="none" stroke="{{GRADIENT}}" stroke-width="19" stroke-linecap="round" ' +
  'd="M88 76 A27 27 0 1 1 114.3 112 L114.3 132"/>' +
  '<circle fill="{{GRADIENT}}" cx="114.3" cy="170" r="13"/>'

/**
 * A speech bubble with three dots: a new reply to read. Unread is not
 * trouble, so it never borrows the exclamation mark of a real alert.
 */
export const GLYPH_MESSAGE =
  '<path fill="none" stroke="{{GRADIENT}}" stroke-width="15" stroke-linejoin="round" ' +
  'd="M72 66 H156 Q174 66 174 84 V138 Q174 156 156 156 H114 L86 184 L90 156 H72 Q54 156 54 138 V84 Q54 66 72 66 Z"/>' +
  '<circle fill="{{GRADIENT}}" cx="86" cy="111" r="10"/>' +
  '<circle fill="{{GRADIENT}}" cx="114.3" cy="111" r="10"/>' +
  '<circle fill="{{GRADIENT}}" cx="142.6" cy="111" r="10"/>'
