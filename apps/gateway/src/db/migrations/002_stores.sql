-- Multi-store provisioning: upstream servers can now be created and removed by the store provisioner,
-- and a store's woo-mcp belongs to the user who created the store.
ALTER TABLE upstream_servers DROP CONSTRAINT IF EXISTS upstream_servers_managed_by_check;
ALTER TABLE upstream_servers ADD CONSTRAINT upstream_servers_managed_by_check CHECK (managed_by IN ('admin', 'helm', 'provisioner'));

-- NULL for ordinary servers. For a store's server: who may call its tools (besides admins), and which store it is.
ALTER TABLE upstream_servers ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE upstream_servers ADD COLUMN store_id text;
CREATE UNIQUE INDEX upstream_servers_store_id_idx ON upstream_servers (store_id) WHERE store_id IS NOT NULL;
