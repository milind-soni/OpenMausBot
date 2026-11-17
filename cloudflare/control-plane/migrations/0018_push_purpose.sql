-- What an APNs token is for: alerts (every row so far), one Live Activity's
-- update token, or the app's Live Activity push-to-start token. A send is
-- refused for a token registered for another purpose.
ALTER TABLE installation_push_devices
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'alert' CHECK (purpose IN ('alert', 'activity', 'activity-start'));
