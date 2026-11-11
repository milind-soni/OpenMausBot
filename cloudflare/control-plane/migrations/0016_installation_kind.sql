-- What an installation is, as it says itself: the desktop app or a self-hosted server (`openmausbot serve`, a fleet
-- container). NULL until a client reports it; the control plane then tells them apart by what each release sends.
-- A server's tunnel is its public address, so the relay rules that end tunnels never apply to one.
ALTER TABLE installations ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('desktop', 'server'));
