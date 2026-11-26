ALTER TABLE issues ADD COLUMN label TEXT;
CREATE INDEX issues_status ON issues (status);
