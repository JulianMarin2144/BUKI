import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

let _saver: PostgresSaver | null = null;

/**
 * Returns a singleton PostgresSaver backed by DATABASE_URL.
 * On first call, creates the LangGraph checkpoint tables (idempotent).
 *
 * Requires a direct (non-pooler) Postgres connection because LangGraph
 * checkpoint operations use advisory locks.
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!_saver) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required for LangGraph checkpointing");
    }
    _saver = PostgresSaver.fromConnString(url);
    await _saver.setup();
  }
  return _saver;
}

/**
 * Deletes all LangGraph checkpoint data for a given session (thread_id).
 * Call this when resetting a session to avoid corrupt state errors.
 */
export async function clearCheckpoint(sessionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    // LangGraph PostgresSaver tables; thread_id maps to our sessionId
    await client.query("DELETE FROM checkpoint_writes WHERE thread_id = $1", [sessionId]);
    await client.query("DELETE FROM checkpoint_blobs WHERE thread_id = $1", [sessionId]);
    await client.query("DELETE FROM checkpoints WHERE thread_id = $1", [sessionId]);
  } catch (err) {
    // Tables may not exist yet; ignore
    console.warn("[checkpointer] clearCheckpoint warning:", err);
  } finally {
    await client.end();
  }
}
