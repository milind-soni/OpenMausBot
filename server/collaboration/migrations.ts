import type { DatabaseSync } from "node:sqlite";

import { OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";

export const COLLABORATION_SCHEMA_VERSION = 4;

interface Migration {
  version: number;
  name: string;
  checksum: string;
  apply(database: DatabaseSync): void;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initialize-collaboration-ledger",
    checksum: "v1:collaboration-ledger-metadata",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_ledger_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format TEXT NOT NULL,
          source_baseline TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      database
        .prepare(
          "INSERT INTO collaboration_ledger_metadata " +
            "(singleton, format, source_baseline, created_at) VALUES (1, ?, ?, ?)",
        )
        .run("openmausbot-collaboration", OPENMAUSBOT_SOURCE_BASELINE, Date.now());
    },
  },
  {
    version: 2,
    name: "add-work-item-ingress",
    checksum: "v2:identity-conversation-event-work-item-outbox",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_principals (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'unresolved')),
          display_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE collaboration_principal_aliases (
          source TEXT NOT NULL,
          alias_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (source, alias_kind, scope_id, external_id)
        ) STRICT;
        CREATE INDEX collaboration_principal_alias_principal
          ON collaboration_principal_aliases(principal_id);

        CREATE TABLE collaboration_conversations (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE collaboration_conversation_aliases (
          source TEXT NOT NULL,
          external_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (source, external_id)
        ) STRICT;

        CREATE TABLE collaboration_work_items (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('collecting', 'waiting_clarification', 'cancelled', 'accepted')),
          version INTEGER NOT NULL CHECK (version > 0),
          created_by TEXT NOT NULL REFERENCES collaboration_principals(id),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX collaboration_work_items_conversation_status
          ON collaboration_work_items(conversation_id, status, updated_at DESC);

        CREATE TABLE collaboration_external_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          transport_message_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES collaboration_conversations(id),
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          kind TEXT NOT NULL CHECK (kind = 'message'),
          normalized_json TEXT NOT NULL,
          raw_hash TEXT NOT NULL,
          association_state TEXT NOT NULL CHECK (association_state IN ('created', 'associated', 'ambiguous', 'invalid_reference')),
          work_item_id TEXT REFERENCES collaboration_work_items(id),
          received_at INTEGER NOT NULL,
          UNIQUE (source, source_event_id)
        ) STRICT;
        CREATE INDEX collaboration_external_events_work_item
          ON collaboration_external_events(work_item_id, received_at);

        CREATE TABLE collaboration_work_item_events (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          external_event_id TEXT NOT NULL UNIQUE REFERENCES collaboration_external_events(id),
          event_type TEXT NOT NULL CHECK (event_type IN ('problem.reported', 'contribution.added')),
          payload_json TEXT NOT NULL,
          principal_id TEXT NOT NULL REFERENCES collaboration_principals(id),
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE collaboration_association_options (
          external_event_id TEXT NOT NULL REFERENCES collaboration_external_events(id),
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          PRIMARY KEY (external_event_id, work_item_id)
        ) STRICT;

        CREATE TABLE collaboration_outbox (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('work_item', 'association')),
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('primary_status_card', 'association_choice_card', 'invalid_reference_card')),
          dedupe_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER
        ) STRICT;
        CREATE INDEX collaboration_outbox_pending
          ON collaboration_outbox(sent_at, created_at);
      `);
    },
  },
  {
    version: 3,
    name: "add-definition-and-planning",
    checksum: "v3:snapshots-frontier-fenced-plans-sequential-graph-outbox",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_work_items
          ADD COLUMN definition_status TEXT NOT NULL DEFAULT 'collecting'
          CHECK (definition_status IN (
            'collecting', 'waiting_clarification', 'planning', 'ready_for_execution', 'planning_failed'
          ));
        ALTER TABLE collaboration_work_items
          ADD COLUMN current_plan_revision INTEGER;

        CREATE TABLE collaboration_work_item_snapshots (
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          source_work_item_version INTEGER NOT NULL CHECK (source_work_item_version > 0),
          goal TEXT,
          goal_confirmed INTEGER NOT NULL CHECK (goal_confirmed IN (0, 1)),
          repository TEXT,
          facts_json TEXT NOT NULL,
          assumptions_json TEXT NOT NULL,
          acceptance_json TEXT NOT NULL,
          blocking_ambiguities_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_clarification_rounds (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          snapshot_revision INTEGER NOT NULL,
          questions_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (work_item_id, snapshot_revision),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_plan_revisions (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          snapshot_revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('published', 'planning_failed')),
          summary TEXT,
          proposal_hash TEXT,
          failure_json TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (work_item_id, revision),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_planning_attempts (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL REFERENCES collaboration_work_items(id),
          snapshot_revision INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'failed', 'stale')),
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE (work_item_id, snapshot_revision),
          FOREIGN KEY (work_item_id, snapshot_revision)
            REFERENCES collaboration_work_item_snapshots(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_work_nodes (
          work_item_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL CHECK (node_type IN ('analyze', 'modify', 'validate', 'report')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
          assigned_agent_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          input_evidence_json TEXT NOT NULL,
          instructions TEXT NOT NULL,
          read_scope_json TEXT NOT NULL,
          write_scope_json TEXT NOT NULL,
          deny_scope_json TEXT NOT NULL,
          commands_json TEXT NOT NULL,
          expected_artifacts_json TEXT NOT NULL,
          completion_definition TEXT NOT NULL,
          risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
          budget_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (work_item_id, plan_revision, node_id),
          FOREIGN KEY (work_item_id, plan_revision)
            REFERENCES collaboration_plan_revisions(work_item_id, revision)
        ) STRICT;

        CREATE TABLE collaboration_work_edges (
          work_item_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind = 'blocks'),
          PRIMARY KEY (work_item_id, plan_revision, from_node_id, to_node_id),
          FOREIGN KEY (work_item_id, plan_revision, from_node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id),
          FOREIGN KEY (work_item_id, plan_revision, to_node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id)
        ) STRICT;

        CREATE TABLE collaboration_plan_node_classifications (
          work_item_id TEXT NOT NULL,
          new_plan_revision INTEGER NOT NULL,
          previous_plan_revision INTEGER NOT NULL,
          previous_node_id TEXT NOT NULL,
          classification TEXT NOT NULL CHECK (classification IN ('valid', 'revalidate', 'obsolete')),
          reason TEXT NOT NULL,
          PRIMARY KEY (work_item_id, new_plan_revision, previous_plan_revision, previous_node_id),
          FOREIGN KEY (work_item_id, new_plan_revision)
            REFERENCES collaboration_plan_revisions(work_item_id, revision),
          FOREIGN KEY (work_item_id, previous_plan_revision, previous_node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id)
        ) STRICT;

        CREATE TRIGGER collaboration_snapshots_no_update
          BEFORE UPDATE ON collaboration_work_item_snapshots
          BEGIN SELECT RAISE(ABORT, 'work item snapshots are immutable'); END;
        CREATE TRIGGER collaboration_snapshots_no_delete
          BEFORE DELETE ON collaboration_work_item_snapshots
          BEGIN SELECT RAISE(ABORT, 'work item snapshots are immutable'); END;
        CREATE TRIGGER collaboration_plan_revisions_no_update
          BEFORE UPDATE ON collaboration_plan_revisions
          BEGIN SELECT RAISE(ABORT, 'plan revisions are immutable'); END;
        CREATE TRIGGER collaboration_plan_revisions_no_delete
          BEFORE DELETE ON collaboration_plan_revisions
          BEGIN SELECT RAISE(ABORT, 'plan revisions are immutable'); END;

        ALTER TABLE collaboration_outbox RENAME TO collaboration_outbox_v2;
        CREATE TABLE collaboration_outbox (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('work_item', 'association', 'plan')),
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'primary_status_card', 'association_choice_card', 'invalid_reference_card',
            'clarification_card', 'plan_status_card'
          )),
          dedupe_key TEXT NOT NULL UNIQUE,
          supersession_key TEXT,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          superseded_at INTEGER
        ) STRICT;
        INSERT INTO collaboration_outbox
          (id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind,
          dedupe_key, payload_json, created_at, sent_at)
        SELECT id, source, source_event_id, aggregate_type, aggregate_id, aggregate_version, kind,
               dedupe_key, payload_json, created_at, sent_at
        FROM collaboration_outbox_v2;
        DROP TABLE collaboration_outbox_v2;
        CREATE INDEX collaboration_outbox_pending
          ON collaboration_outbox(sent_at, created_at);
      `);
    },
  },
  {
    version: 4,
    name: "add-trusted-candidate-execution",
    checksum: "v4:runs-candidates-test-evidence-audit",
    apply(database) {
      database.exec(`
        ALTER TABLE collaboration_work_nodes
          ADD COLUMN execution_status TEXT NOT NULL DEFAULT 'not_started'
          CHECK (execution_status IN (
            'not_started', 'running', 'candidate_ready', 'invalid', 'needs_configuration', 'failed'
          ));

        CREATE TABLE collaboration_runs (
          id TEXT PRIMARY KEY,
          work_item_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          agent_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'running', 'succeeded', 'failed', 'invalid', 'needs_configuration', 'timed_out'
          )),
          repository_path TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          result_sha TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          error TEXT,
          UNIQUE (work_item_id, plan_revision, node_id, attempt),
          FOREIGN KEY (work_item_id, plan_revision, node_id)
            REFERENCES collaboration_work_nodes(work_item_id, plan_revision, node_id)
        ) STRICT;

        CREATE TABLE collaboration_run_events (
          run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          event_type TEXT NOT NULL CHECK (event_type IN ('progress', 'warning', 'result')),
          message TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, sequence)
        ) STRICT;

        CREATE TABLE collaboration_candidates (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES collaboration_runs(id),
          state TEXT NOT NULL CHECK (state IN (
            'target_tests_passed', 'test_failed', 'not_verified', 'invalid', 'needs_configuration'
          )),
          base_sha TEXT NOT NULL,
          result_sha TEXT,
          changed_paths_json TEXT NOT NULL,
          violations_json TEXT NOT NULL,
          quality_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE collaboration_test_evidence (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES collaboration_runs(id),
          command_id TEXT NOT NULL,
          argv_json TEXT NOT NULL,
          cwd TEXT NOT NULL,
          exit_code INTEGER,
          duration_ms INTEGER NOT NULL,
          stdout TEXT NOT NULL,
          stderr TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('target_passed', 'failed', 'timeout', 'output_limit')),
          created_at INTEGER NOT NULL,
          UNIQUE (run_id, command_id)
        ) STRICT;

        CREATE TABLE collaboration_audit_events (
          id TEXT PRIMARY KEY,
          run_id TEXT REFERENCES collaboration_runs(id),
          action TEXT NOT NULL,
          outcome TEXT NOT NULL,
          resource_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TRIGGER collaboration_candidates_no_update
          BEFORE UPDATE ON collaboration_candidates
          BEGIN SELECT RAISE(ABORT, 'candidate attempts are immutable'); END;
        CREATE TRIGGER collaboration_candidates_no_delete
          BEFORE DELETE ON collaboration_candidates
          BEGIN SELECT RAISE(ABORT, 'candidate attempts are immutable'); END;
        CREATE TRIGGER collaboration_test_evidence_no_update
          BEFORE UPDATE ON collaboration_test_evidence
          BEGIN SELECT RAISE(ABORT, 'test evidence is immutable'); END;
        CREATE TRIGGER collaboration_test_evidence_no_delete
          BEFORE DELETE ON collaboration_test_evidence
          BEGIN SELECT RAISE(ABORT, 'test evidence is immutable'); END;
      `);
    },
  },
];

export interface MigrationState {
  schemaVersion: number;
  appliedMigrations: number;
}

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function applyCollaborationMigrations(database: DatabaseSync): MigrationState {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = database
    .prepare("SELECT version, name, checksum FROM collaboration_schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;

  for (const row of applied) {
    const known = migrations.find((migration) => migration.version === row.version);
    if (!known || known.name !== row.name || known.checksum !== row.checksum) {
      throw new Error(`Collaboration migration ${row.version} does not match this service build`);
    }
  }

  for (const migration of migrations) {
    if (applied.some((row) => row.version === migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database);
      database
        .prepare(
          "INSERT INTO collaboration_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migration.checksum, Date.now());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const schemaVersion = userVersion(database);
  const countRow = database.prepare("SELECT count(*) AS count FROM collaboration_schema_migrations").get() as {
    count: number;
  };
  if (schemaVersion !== COLLABORATION_SCHEMA_VERSION || countRow.count !== migrations.length) {
    throw new Error(
      `Collaboration schema is inconsistent (user_version=${schemaVersion}, migrations=${countRow.count})`,
    );
  }
  return { schemaVersion, appliedMigrations: countRow.count };
}
