-- AUTHORITATIVE EMBEDDED SQLITE DDL: PROJECT AETHER
-- Target: Cloudflare Durable Objects storage.sql

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA page_size = 4096;
PRAGMA auto_vacuum = INCREMENTAL;

-- 1. Core AST Syntax Nodes Table
CREATE TABLE IF NOT EXISTS ast_nodes (
    node_id TEXT PRIMARY KEY NOT NULL,              -- 64-char BLAKE3 hex hash
    parent_id TEXT,                                 -- NULL denotes virtual module root
    grammar_type TEXT NOT NULL,                     -- Tree-sitter grammar node classification
    pos_fractional TEXT NOT NULL,                   -- Base-65536 fractional coordinate string
    is_alive INTEGER NOT NULL DEFAULT 1,            -- 1 = active, 0 = soft-deleted tombstone
    birth_lamport INTEGER NOT NULL,                 -- Creation logical counter
    birth_agent TEXT NOT NULL,                      -- Originating Ed25519 public key
    death_lamport INTEGER,                          -- Deletion logical counter (NULL if alive)
    death_agent TEXT,                               -- Deletion Ed25519 public key
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ast_nodes_hierarchy 
ON ast_nodes (parent_id, is_alive, pos_fractional ASC);

CREATE INDEX IF NOT EXISTS idx_ast_nodes_birth 
ON ast_nodes (birth_lamport ASC, birth_agent ASC);

-- 2. Dynamic Semantic Attributes (LWW Registers)
CREATE TABLE IF NOT EXISTS ast_attributes (
    node_id TEXT NOT NULL,                          -- Target NodeID
    attr_key TEXT NOT NULL,                         -- 'token', '__trivia_lead', '__trivia_trail', etc.
    attr_val TEXT,                                  -- Serialized token value / literal
    lamport_counter INTEGER NOT NULL,               -- LWW logical counter
    agent_id TEXT NOT NULL,                         -- LWW tie-breaking public key
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (node_id, attr_key),
    FOREIGN KEY (node_id) REFERENCES ast_nodes(node_id) ON DELETE CASCADE
);

-- 3. Cycle-Free Structural Move History Log (SPEC-002)
CREATE TABLE IF NOT EXISTS ast_move_history (
    sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    new_parent_id TEXT NOT NULL,
    pos_fractional TEXT NOT NULL,
    lamport_counter INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_move_lamport 
ON ast_move_history (lamport_counter ASC);

-- 4. Merkle Phylogenetic State Ledger (SPEC-014)
CREATE TABLE IF NOT EXISTS crdt_merkle_ledger (
    sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_hash TEXT NOT NULL,
    parent_root TEXT NOT NULL,
    new_root TEXT NOT NULL,
    lamport_counter INTEGER NOT NULL,
    signer_public_key TEXT NOT NULL,
    committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merkle_ledger_root 
ON crdt_merkle_ledger (new_root);

CREATE TABLE IF NOT EXISTS ast_mutation_log (
    sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    lamport_counter INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    mutation_hash TEXT NOT NULL,
    mutation_json TEXT NOT NULL,
    committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ast_archive_index (
    r2_object_key TEXT PRIMARY KEY NOT NULL,
    payload_sha256 TEXT NOT NULL,
    first_mutation_sequence INTEGER NOT NULL,
    last_mutation_sequence INTEGER NOT NULL,
    first_ledger_sequence INTEGER NOT NULL,
    last_ledger_sequence INTEGER NOT NULL,
    min_lamport INTEGER NOT NULL,
    max_lamport INTEGER NOT NULL,
    first_parent_root TEXT NOT NULL,
    last_root TEXT NOT NULL,
    archived_at INTEGER NOT NULL
);

-- 5. Subtree Lease Locks for Human-in-the-Loop Governance (SPEC-018)
CREATE TABLE IF NOT EXISTS ast_subtree_locks (
    lock_id TEXT PRIMARY KEY NOT NULL,
    subtree_root_id TEXT NOT NULL,
    owner_identity TEXT NOT NULL,
    owner_public_key TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    lock_scope TEXT CHECK(lock_scope IN ('EXCLUSIVE_WRITE', 'AGENT_FREEZE')) NOT NULL
);

-- 6. Superposition Candidate Buffer for Semantic Conflict Arbitration
CREATE TABLE IF NOT EXISTS ast_superposition_pool (
    candidate_id TEXT PRIMARY KEY NOT NULL,
    target_parent_id TEXT NOT NULL,
    intent_spec TEXT NOT NULL,
    syntax_sexpr TEXT NOT NULL,
    raw_source TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    fitness_score REAL DEFAULT NULL
);

-- 7. Symbol Dependency Graph (Cross-Function Dependency & Signature Conflict Detection)
CREATE TABLE IF NOT EXISTS ast_symbol_definitions (
    symbol_name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    arity INTEGER NOT NULL DEFAULT 0,
    max_arity INTEGER,
    file_path TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol_name, file_path)
);

CREATE TABLE IF NOT EXISTS ast_symbol_references (
    reference_id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_name TEXT NOT NULL,
    caller_node_id TEXT NOT NULL,
    call_site_args INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbol_refs ON ast_symbol_references (symbol_name);

