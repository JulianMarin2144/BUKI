import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt, touchSession } from "@agents/db";
import { runAgentStream, clearCheckpoint } from "@agents/agent";
import type { StreamChunk } from "@agents/agent";
// v6 - always stream; repair broken tool_calls from additional_kwargs after response

function isCorruptSessionError(err: unknown): boolean {
  const candidates: string[] = [];
  candidates.push(String(err));
  try { candidates.push(JSON.stringify(err)); } catch { /* noop */ }
  const e = err as Record<string, unknown>;
  if (e?.message) candidates.push(String(e.message));
  const raw = (e?.metadata as Record<string, unknown>)?.raw;
  if (raw) candidates.push(String(raw));
  const joined = candidates.join(" ");
  // Corrupt session: OpenAI/OpenRouter requires tool_call messages after tool_calls
  // Also detect generic invalid_request_error (usually means the same thing in this context)
  return joined.includes("tool_call_id")
    || joined.includes("tool_calls")
    || joined.includes("invalid_request_error");
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { message, sessionId: requestedSessionId } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const db = createServerClient();

    const [profileResult, toolSettingsResult, integrationsResult] = await Promise.all([
      supabase.from("profiles").select("agent_system_prompt, agent_name").eq("id", user.id).single(),
      supabase.from("user_tool_settings").select("*").eq("user_id", user.id),
      supabase.from("user_integrations").select("*").eq("user_id", user.id).eq("status", "active"),
    ]);

    const profile = profileResult.data;
    const toolSettings = toolSettingsResult.data;
    const integrations = integrationsResult.data;

    let githubToken: string | undefined;
    const githubIntegration = (integrations ?? []).find(
      (i: Record<string, unknown>) => i.provider === "github"
    );
    if (githubIntegration?.encrypted_tokens) {
      try {
        githubToken = decrypt(githubIntegration.encrypted_tokens as string);
      } catch (err) {
        console.error("Failed to decrypt GitHub token:", err);
      }
    }

    let bukConfig: { tenant: string; country: string; token: string } | undefined;
    const bukIntegration = (integrations ?? []).find(
      (i: Record<string, unknown>) => i.provider === "buk"
    );
    if (bukIntegration?.encrypted_tokens) {
      try {
        bukConfig = JSON.parse(decrypt(bukIntegration.encrypted_tokens as string));
      } catch (err) {
        console.error("[chat] Failed to decrypt BUK config:", err);
      }
    }

    let session;
    if (requestedSessionId) {
      session = await supabase
        .from("agent_sessions").select("*")
        .eq("id", requestedSessionId).eq("user_id", user.id).eq("status", "active")
        .single().then((r) => r.data);
      if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    } else {
      session = await supabase
        .from("agent_sessions").select("*")
        .eq("user_id", user.id).eq("channel", "web").eq("status", "active")
        .order("last_used_at", { ascending: false }).limit(1).single().then((r) => r.data);

      if (!session) {
        const { data } = await supabase
          .from("agent_sessions")
          .insert({ user_id: user.id, channel: "web", status: "active", budget_tokens_used: 0, budget_tokens_limit: 100000 })
          .select().single();
        session = data;
      }
    }

    if (!session) return NextResponse.json({ error: "Failed to create session" }, { status: 500 });

    // Fire-and-forget: touching the session timestamp doesn't need to block stream start.
    touchSession(db, session.id).catch(() => {});

    const agentInput = {
      message,
      userId: user.id,
      sessionId: session.id,
      systemPrompt: (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      db,
      bukConfig,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string, user_id: t.user_id as string, tool_id: t.tool_id as string,
        enabled: t.enabled as boolean, config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string, user_id: i.user_id as string, provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [], status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
    };

    const encoder = new TextEncoder();
    const encode = (chunk: StreamChunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    // SSE comment used to force HTTP proxy / Turbopack buffer flush
    const FLUSH = encoder.encode(`: \n\n`);

    async function createFreshSession(sessionId: string) {
      await supabase.from("agent_sessions").update({ status: "revoked" }).eq("id", sessionId);
      const { data } = await supabase
        .from("agent_sessions")
        .insert({ user_id: user.id, channel: "web", status: "active", budget_tokens_used: 0, budget_tokens_limit: 100000 })
        .select().single();
      return data;
    }

    const stream = new ReadableStream({
      async start(controller) {
        const send = (chunk: StreamChunk) => {
          try {
            controller.enqueue(encode(chunk));
            // Flush any buffering layer (Turbopack dev proxy, nginx, etc.)
            controller.enqueue(FLUSH);
          } catch { /* stream already closed */ }
        };

        // 2 KB padding comment → forces Turbopack/proxy to flush its internal buffer
        // immediately so the client starts receiving chunks from the first byte.
        try { controller.enqueue(encoder.encode(`: ${"0".repeat(2048)}\n\n`)); } catch { /* ignore */ }

        try {
          let activeInput = agentInput;
          let gen = runAgentStream(activeInput);
          let first = await gen.next();
          if (first.done) { controller.close(); return; }

          // Handle corrupt session before sending anything to client
          if (first.value.type === "error" && isCorruptSessionError(first.value.message)) {
            console.warn("[chat/stream] Corrupt session — recreating…");
            await clearCheckpoint(session.id).catch(() => {});
            const freshSession = await createFreshSession(session.id);
            if (freshSession) {
              activeInput = { ...agentInput, sessionId: freshSession.id };
              gen = runAgentStream(activeInput);
              first = await gen.next();
              if (first.done) { controller.close(); return; }
            }
          }

          send(first.value);
          for await (const chunk of gen) { send(chunk); }

        } catch (err) {
          console.error("[chat/stream] unhandled error:", err);
          send({ type: "error", message: "Error interno del servidor" });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });

  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
