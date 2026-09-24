# Organization branding

An organization administrator can upload a logo and up to 24 shared bot icons
in Admin → Branding. Use PNG, JPEG or WebP, up to 5 MB per upload. Admin resizes
the images before saving; the normalized collection is limited to 128 KiB.

Members connect through Settings → Organization as usual. The logo appears
in the sidebar and Organization settings. Shared icons appear in each bot's
avatar customization alongside the normal upload and mascot options.

Connected desktop apps refresh branding on the existing session heartbeat.
Use Refresh in Organization settings to fetch changes immediately. Older
Admins return no branding, so the standard app appearance remains unchanged.
Personal users do not need to sign in.

Selecting a shared icon stores a copy as a normal local avatar attachment.
It remains with that bot, including in workspace backups, even if an admin
later removes the icon or the member disconnects. Disconnecting hides the
organization logo and shared library; it does not delete personal avatars.
Branding does not change the installed application name, Dock/Start-menu icon,
model permissions, or authentication. Remote workspace pages cannot read the
local desktop's organization branding.
