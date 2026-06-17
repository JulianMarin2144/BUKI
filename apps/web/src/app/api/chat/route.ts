import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt, touchSession } from "@agents/db";
import { runAgent, flushSessionMemory, clearCheckpoint } from "@agents/agent";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message, sessionId: requestedSessionId } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const db = createServerClient();

    // Parallel fetch of independent Supabase queries
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
        .from("agent_sessions")
        .select("*")
        .eq("id", requestedSessionId)
        .eq("user_id", user.id)
        .eq("status", "active")
        .single()
        .then((r) => r.data);
      if (!session) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
    } else {
      session = await supabase
        .from("agent_sessions")
        .select("*")
        .eq("user_id", user.id)
        .eq("channel", "web")
        .eq("status", "active")
        .order("last_used_at", { ascending: false })
        .limit(1)
        .single()
        .then((r) => r.data);

      if (!session) {
        const { data } = await supabase
          .from("agent_sessions")
          .insert({
            user_id: user.id,
            channel: "web",
            status: "active",
            budget_tokens_used: 0,
            budget_tokens_limit: 100000,
          })
          .select()
          .single();
        session = data;
      }
    }

    if (!session) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    await touchSession(db, session.id);

    const agentInput = {
      message,
      userId: user.id,
      sessionId: session.id,
      systemPrompt: (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      db,
      bukConfig,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
    };

    function isCorruptSessionError(err: unknown): boolean {
      const candidates: string[] = [];
      candidates.push(String(err));
      try { candidates.push(JSON.stringify(err)); } catch { /* noop */ }
      const e = err as Record<string, unknown>;
      if (e?.message) candidates.push(String(e.message));
      const raw = (e?.metadata as Record<string, unknown>)?.raw;
      if (raw) candidates.push(String(raw));
      const combined = candidates.join(" ");
      return combined.includes("tool_call_id") || combined.includes("tool_calls");
    }

    async function createFreshSession() {
      await supabase
        .from("agent_sessions")
        .update({ status: "revoked" })
        .eq("id", session.id);
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      return data;
    }

    let result;
    let activeSessionId = agentInput.sessionId;
    try {
      result = await runAgent(agentInput);
    } catch (agentErr) {
      if (isCorruptSessionError(agentErr)) {
        console.warn("[chat] Corrupt session detected, creating fresh session…");
        await clearCheckpoint(session.id).catch(() => {});
        const freshSession = await createFreshSession();
        if (!freshSession) throw agentErr;
        activeSessionId = freshSession.id;
        result = await runAgent({ ...agentInput, sessionId: activeSessionId });
      } else {
        throw agentErr;
      }
    }

    if (!result.pendingConfirmation) {
      flushSessionMemory({ db, userId: user.id, sessionId: activeSessionId }).catch(
        (err) => console.error("[chat] memory flush failed:", err)
      );
    }

    return NextResponse.json({
      response: result.pendingConfirmation ? null : result.response,
      pendingConfirmation: result.pendingConfirmation ?? null,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
