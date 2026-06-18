import {
  StateGraph,
  interrupt,
  Command,
  INTERRUPT,
} from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration, PendingConfirmation } from "@agents/types";
import {
  TOOL_CATALOG,
  toolRequiresConfirmation,
  getToolRisk,
} from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools, TOOL_HANDLERS } from "./tools/adapters";
import type { ToolContext } from "./tools/adapters";
import {
  addMessage,
  createToolCall,
  updateToolCallStatus,
  findExistingPendingToolCall,
} from "@agents/db";
import { getCheckpointer } from "./checkpointer";
import { GraphState } from "./state";
import { compactionNode } from "./nodes/compaction_node";
import { createMemoryInjectionNode } from "./nodes/memory_injection_node";
import { createLangfuseRunnableConfig, withLangfuseRootTrace } from "./langfuse";


export interface AgentInput {
  message?: string;
  resumeDecision?: "approve" | "reject";
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  bukConfig?: { tenant: string; country: string; token: string };
  /** Skip HITL interrupts and auto-approve all tool calls. Use only for unattended runs (e.g. cron). */
  bypassConfirmation?: boolean;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation?: PendingConfirmation;
}

/** Confirmation message shown to the human for a given tool + args. */
function buildConfirmationMessage(
  toolId: string,
  args: Record<string, unknown>
): string {
  switch (toolId) {
    case "github_create_issue":
      return `Se requiere confirmación para crear el issue "${args.title}" en ${args.owner}/${args.repo}.`;
    case "github_create_repo":
      return `Se requiere confirmación para crear el repositorio "${args.name}"${args.isPrivate ? " (privado)" : ""}.`;
    case "write_file": {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const preview = content.length > 300 ? `${content.slice(0, 300)}…` : content;
      return `Se requiere confirmación para crear el archivo \`${path}\` con el siguiente contenido:\n\`\`\`\n${preview}\n\`\`\``;
    }
    case "edit_file": {
      const path = String(args.path ?? "");
      const oldStr = String(args.old_string ?? "");
      const newStr = String(args.new_string ?? "");
      const oldPreview = oldStr.length > 200 ? `${oldStr.slice(0, 200)}…` : oldStr;
      const newPreview = newStr.length > 200 ? `${newStr.slice(0, 200)}…` : newStr;
      return `Se requiere confirmación para editar \`${path}\`.\n\n**Fragmento a reemplazar:**\n\`\`\`\n${oldPreview}\n\`\`\`\n\n**Nuevo contenido:**\n\`\`\`\n${newPreview}\n\`\`\``;
    }
    case "bash": {
      const prompt = String(args.prompt ?? "");
      const preview = prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt;
      const terminal = args.terminal ? ` en terminal "${args.terminal}"` : "";
      return `Se requiere confirmación para ejecutar el siguiente comando bash${terminal}:\n\`\`\`\n${preview}\n\`\`\``;
    }
    case "schedule_task": {
      const schedType = args.schedule_type === "recurring" ? "recurrente" : "una sola vez";
      const when =
        args.schedule_type === "one_time"
          ? `el ${new Date(args.run_at as string).toLocaleString("es")}`
          : `con expresión cron "${args.cron_expr}"`;
      return `Se requiere confirmación para programar una tarea (${schedType}) ${when}.\n\nPrompt: "${args.prompt}"`;
    }
    default:
      return `Se requiere confirmación para ejecutar "${toolId}" (riesgo: ${getToolRisk(toolId)}).`;
  }
}

const MAX_TOOL_ITERATIONS = 6;

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    resumeDecision,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    bukConfig,
    bypassConfirmation = false,
  } = input;

  const model = createChatModel();
  const toolCtx: ToolContext = { db, userId, sessionId, enabledTools, integrations, githubToken, bukConfig };
  const lcTools = buildLangChainTools(toolCtx);

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State,
    config?: RunnableConfig
  ): Promise<Partial<typeof GraphState.State>> {
    const currentDate = new Date().toLocaleString("es", {
      timeZone: "America/Bogota",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const systemPromptWithDate = `${state.systemPrompt}\n\nFecha y hora actual: ${currentDate} (hora Colombia).`;

    // Inject SystemMessage fresh so it is never accumulated in state.messages.
    const response = await modelWithTools.invoke(
      [
        new SystemMessage(systemPromptWithDate),
        ...state.messages,
      ],
      config
    );
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State,
    config?: RunnableConfig
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const results: BaseMessage[] = [];

    for (const tc of lastMsg.tool_calls) {
      const def = TOOL_CATALOG.find((t) => t.name === tc.name);
      const toolId = def?.id ?? tc.name;
      toolCallNames.push(tc.name);

      if (def && toolRequiresConfirmation(toolId)) {
        if (bypassConfirmation) {
          // Unattended run (e.g. cron): auto-approve without interrupting.
          const record = await createToolCall(db, sessionId, toolId, tc.args as Record<string, unknown>, true);
          await updateToolCallStatus(db, record.id, "approved");

          const autoHandler = TOOL_HANDLERS[toolId];
          try {
            const result = await autoHandler(tc.args as Record<string, unknown>, toolCtx);
            await updateToolCallStatus(db, record.id, "executed", result);
            results.push(new ToolMessage({ content: JSON.stringify(result), tool_call_id: tc.id! }));
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(db, record.id, "failed", errResult);
            results.push(new ToolMessage({ content: JSON.stringify(errResult), tool_call_id: tc.id! }));
          }
          continue;
        }

        // Idempotent: on graph replay after resume the record already exists.
        let record = await findExistingPendingToolCall(db, sessionId, toolId);
        if (!record) {
          record = await createToolCall(db, sessionId, toolId, tc.args as Record<string, unknown>, true);
        }

        const confirmMsg = buildConfirmationMessage(toolId, tc.args as Record<string, unknown>);

        // interrupt() pauses graph execution here on first pass.
        // On resume, it returns the decision value immediately.
        const decision = interrupt({
          tool_call_id: record.id,
          tool_name: toolId,
          message: confirmMsg,
          args: tc.args,
        }) as "approve" | "reject";

        if (decision !== "approve") {
          await updateToolCallStatus(db, record.id, "rejected");
          results.push(
            new ToolMessage({
              content: "Acción cancelada por el usuario.",
              tool_call_id: tc.id!,
            })
          );
          continue;
        }

        await updateToolCallStatus(db, record.id, "approved");

        // Call the handler directly to avoid withTracking creating a second DB record.
        const confirmedHandler = TOOL_HANDLERS[toolId];
        try {
          const result = await confirmedHandler(tc.args as Record<string, unknown>, toolCtx);
          await updateToolCallStatus(db, record.id, "executed", result);
          results.push(new ToolMessage({ content: JSON.stringify(result), tool_call_id: tc.id! }));
        } catch (err) {
          const errResult = { error: String(err) };
          await updateToolCallStatus(db, record.id, "failed", errResult);
          results.push(new ToolMessage({ content: JSON.stringify(errResult), tool_call_id: tc.id! }));
        }
        continue;
      }

      // Execute non-confirmed tools (withTracking handles DB record creation).
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      if (!matchingTool) {
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: `Tool '${tc.name}' not available` }),
            tool_call_id: tc.id!,
          })
        );
        continue;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResult = await (matchingTool as any).invoke(tc.args, config);
        results.push(
          new ToolMessage({ content: String(rawResult), tool_call_id: tc.id! })
        );
      } catch (err) {
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: String(err) }),
            tool_call_id: tc.id!,
          })
        );
      }
    }

    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const memoryInjectionNode = createMemoryInjectionNode({ db, userId });

  const graph = new StateGraph(GraphState)
    // .addNode("memory_injection", memoryInjectionNode)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });

  const traceName = resumeDecision ? "agent-confirmation" : "agent-message";
  const langfuseTags = [
    "10x-builders-agent",
    bypassConfirmation ? "cron" : "interactive",
    resumeDecision ? "resume" : "message",
  ];
  const langfuseMetadata = {
    agentSessionId: sessionId,
    bypassConfirmation,
  };

  const langfuseConfig = createLangfuseRunnableConfig({
    userId,
    sessionId,
    runName: traceName,
    tags: langfuseTags,
    metadata: langfuseMetadata,
  });
  const config: RunnableConfig = {
    ...langfuseConfig,
    configurable: { thread_id: sessionId },
  };

  let finalState: typeof GraphState.State & { [INTERRUPT]?: unknown[] };

  function traceOutputSummary(
    state: typeof GraphState.State & { [INTERRUPT]?: unknown[] }
  ) {
    const interrupts = (state as Record<string, unknown>)[INTERRUPT] as
      | Array<{ value: unknown }>
      | undefined;
    if (interrupts?.length) {
      const iv = interrupts[0].value as {
        tool_name: string;
        message: string;
      };
      return {
        interrupted: true,
        tool_name: iv.tool_name,
        confirmation_preview:
          iv.message.length > 2000 ? `${iv.message.slice(0, 2000)}…` : iv.message,
      };
    }
    const lastMessage = state.messages[state.messages.length - 1];
    const responseText =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    const max = 8000;
    return {
      interrupted: false,
      assistant_response:
        responseText.length <= max ? responseText : `${responseText.slice(0, max)}…`,
    };
  }

  if (resumeDecision) {
    // Resume interrupted graph with human decision
    finalState = await withLangfuseRootTrace({
      userId,
      sessionId,
      traceName,
      input: { resumeDecision },
      tags: langfuseTags,
      metadata: langfuseMetadata,
      execute: () =>
        app.invoke(new Command({ resume: resumeDecision }), config),
      summarizeResult: traceOutputSummary,
    });
  } else {
    // New message — persist to DB (audit log) then append to checkpointer state.
    // The checkpointer is the sole source of truth for message history; we never
    // reconstruct from DB to avoid duplicating messages across invocations.
    finalState = await withLangfuseRootTrace({
      userId,
      sessionId,
      traceName,
      input: { userMessage: message! },
      tags: langfuseTags,
      metadata: langfuseMetadata,
      execute: async () => {
        await addMessage(db, sessionId, "user", message!);
        return app.invoke(
          { messages: [new HumanMessage(message!)], sessionId, userId, systemPrompt },
          config
        );
      },
      summarizeResult: traceOutputSummary,
    });
  }

  // Check if the graph is paused at an interrupt
  const interrupts = (finalState as Record<string, unknown>)[INTERRUPT] as
    | Array<{ value: unknown }>
    | undefined;

  if (interrupts?.length) {
    const interruptValue = interrupts[0].value as {
      tool_call_id: string;
      tool_name: string;
      message: string;
      args: Record<string, unknown>;
    };

    const pendingConfirmation: PendingConfirmation = {
      tool_call_id: interruptValue.tool_call_id,
      tool_name: interruptValue.tool_name,
      message: interruptValue.message,
      args: interruptValue.args,
    };

    // Persist the pending confirmation so it survives page refresh.
    await addMessage(db, sessionId, "assistant", interruptValue.message, {
      structured_payload: {
        type: "pending_confirmation",
        ...pendingConfirmation,
      },
    });

    return {
      response: interruptValue.message,
      toolCalls: toolCallNames,
      pendingConfirmation,
    };
  }

  // Normal completion
  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  await addMessage(db, sessionId, "assistant", responseText);

  return {
    response: responseText,
    toolCalls: toolCallNames,
  };
}

// ─── Streaming ───────────────────────────────────────────────────────────────

export type StreamChunk =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string }
  | { type: "pending"; data: PendingConfirmation; toolCalls: string[] }
  | { type: "done"; response: string; toolCalls: string[] }
  | { type: "error"; message: string };

/**
 * Same as runAgent but yields StreamChunks for real-time streaming.
 * Only supports new messages (not HITL resume — use /api/chat/confirm for that).
 */
export async function* runAgentStream(input: AgentInput): AsyncGenerator<StreamChunk> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    bukConfig,
    bypassConfirmation = false,
  } = input;

  if (!message) return;

  const model = createChatModel();
  const toolCtx: ToolContext = { db, userId, sessionId, enabledTools, integrations, githubToken, bukConfig };
  const lcTools = buildLangChainTools(toolCtx);
  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;
  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State,
    config?: RunnableConfig
  ): Promise<Partial<typeof GraphState.State>> {
    const currentDate = new Date().toLocaleString("es", {
      timeZone: "America/Bogota",
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const systemPromptWithDate = `${state.systemPrompt}\n\nFecha y hora actual: ${currentDate} (hora Colombia).`;

    // Always invoke with the full LangGraph config so streamEvents captures tokens.
    // OpenRouter streaming quirk: when the model returns tool_calls, the chunks do NOT
    // accumulate correctly into AIMessage.tool_calls (they stay empty). However the raw
    // format is fully preserved in additional_kwargs.tool_calls.
    // After invoking, we detect and repair that case so the rest of the graph works.
    const rawResponse = await modelWithTools.invoke(
      [new SystemMessage(systemPromptWithDate), ...state.messages],
      config
    );

    // Repair broken tool_calls accumulation (OpenRouter + LangChain streaming bug)
    let response = rawResponse;
    const rawAkTcs = rawResponse.additional_kwargs?.tool_calls as
      | Array<{ id: string; type: string; function: { name: string; arguments: string } }>
      | undefined;
    if ((rawResponse.tool_calls?.length ?? 0) === 0 && Array.isArray(rawAkTcs) && rawAkTcs.length > 0) {
      response = new AIMessage({
        content: rawResponse.content,
        tool_calls: rawAkTcs.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: (() => { try { return JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } })(),
        })),
        additional_kwargs: rawResponse.additional_kwargs,
        response_metadata: rawResponse.response_metadata,
        id: rawResponse.id,
      });
    }
    const rc = typeof response.content === "string" ? response.content.length : 0;
    const akTcLog = JSON.stringify((response.additional_kwargs as Record<string, unknown>)?.tool_calls)?.slice(0, 80) ?? "none";
    console.log(`[agentNode] msgs_in=${state.messages.length} tools_bound=${lcTools.length} resp_content_len=${rc} tool_calls=${response.tool_calls?.length ?? 0} ak_tc=${akTcLog}`);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State,
    config?: RunnableConfig
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg?._getType?.() !== "ai" || !hasToolCalls(lastMsg)) return {};

    const aiMsg = lastMsg as AIMessage;
    // Use LangChain tool_calls if available; fall back to raw additional_kwargs format.
    const rawAkTcs = (aiMsg.additional_kwargs as Record<string, unknown>)?.tool_calls as
      | Array<{ id: string; type: string; function: { name: string; arguments: string } }>
      | undefined;
    const normalizedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> =
      (aiMsg.tool_calls?.length ?? 0) > 0
        ? (aiMsg.tool_calls as Array<{ id: string; name: string; args: Record<string, unknown> }>)
        : (rawAkTcs ?? []).map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: (() => {
              try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
              catch { return {} as Record<string, unknown>; }
            })(),
          }));
    console.log(`[toolExecutorNode] executing ${normalizedToolCalls.length} tool(s): ${normalizedToolCalls.map(t => t.name).join(", ")}`);

    const results: BaseMessage[] = [];
    for (const tc of normalizedToolCalls) {
      const def = TOOL_CATALOG.find((t) => t.name === tc.name);
      const toolId = def?.id ?? tc.name;
      toolCallNames.push(tc.name);

      if (def && toolRequiresConfirmation(toolId)) {
        if (bypassConfirmation) {
          const record = await createToolCall(db, sessionId, toolId, tc.args as Record<string, unknown>, true);
          await updateToolCallStatus(db, record.id, "approved");
          const autoHandler = TOOL_HANDLERS[toolId];
          try {
            const result = await autoHandler(tc.args as Record<string, unknown>, toolCtx);
            await updateToolCallStatus(db, record.id, "executed", result);
            results.push(new ToolMessage({ content: JSON.stringify(result), tool_call_id: tc.id! }));
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(db, record.id, "failed", errResult);
            results.push(new ToolMessage({ content: JSON.stringify(errResult), tool_call_id: tc.id! }));
          }
          continue;
        }

        let record = await findExistingPendingToolCall(db, sessionId, toolId);
        if (!record) record = await createToolCall(db, sessionId, toolId, tc.args as Record<string, unknown>, true);

        const decision = interrupt({
          tool_call_id: record.id,
          tool_name: toolId,
          message: buildConfirmationMessage(toolId, tc.args as Record<string, unknown>),
          args: tc.args,
        }) as "approve" | "reject";

        if (decision !== "approve") {
          await updateToolCallStatus(db, record.id, "rejected");
          results.push(new ToolMessage({ content: "Acción cancelada por el usuario.", tool_call_id: tc.id! }));
          continue;
        }
        await updateToolCallStatus(db, record.id, "approved");
        const confirmedHandler = TOOL_HANDLERS[toolId];
        try {
          const result = await confirmedHandler(tc.args as Record<string, unknown>, toolCtx);
          await updateToolCallStatus(db, record.id, "executed", result);
          results.push(new ToolMessage({ content: JSON.stringify(result), tool_call_id: tc.id! }));
        } catch (err) {
          const errResult = { error: String(err) };
          await updateToolCallStatus(db, record.id, "failed", errResult);
          results.push(new ToolMessage({ content: JSON.stringify(errResult), tool_call_id: tc.id! }));
        }
        continue;
      }

      const matchingTool = lcTools.find((t) => t.name === tc.name);
      if (!matchingTool) {
        results.push(new ToolMessage({ content: JSON.stringify({ error: `Tool '${tc.name}' not available` }), tool_call_id: tc.id! }));
        continue;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawResult = await (matchingTool as any).invoke(tc.args, config);
        results.push(new ToolMessage({ content: String(rawResult), tool_call_id: tc.id! }));
      } catch (err) {
        results.push(new ToolMessage({ content: JSON.stringify({ error: String(err) }), tool_call_id: tc.id! }));
      }
    }
    return { messages: results };
  }

  function hasToolCalls(msg: BaseMessage): boolean {
    const ai = msg as AIMessage;
    // Check LangChain format first, then raw OpenAI additional_kwargs as fallback.
    // The Postgres checkpointer may deserialize the message with tool_calls only
    // in additional_kwargs (raw OpenAI format) and not in the LangChain tool_calls field.
    if ((ai?.tool_calls?.length ?? 0) > 0) return true;
    const akTc = (ai?.additional_kwargs as Record<string, unknown>)?.tool_calls;
    return Array.isArray(akTc) && akTc.length > 0;
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    const type = lastMsg?._getType?.();
    const aiMsg = lastMsg as AIMessage;
    const tcLen = aiMsg?.tool_calls?.length ?? 0;
    const akTcLen = Array.isArray((aiMsg?.additional_kwargs as Record<string, unknown>)?.tool_calls)
      ? ((aiMsg.additional_kwargs as Record<string, unknown>).tool_calls as unknown[]).length
      : 0;
    console.log(`[shouldContinue] msgs=${state.messages.length} type=${type} tc=${tcLen} ak_tc=${akTcLen}`);
    // Use _getType() to avoid instanceof class-identity failures in monorepo.
    if (type === "ai" && hasToolCalls(lastMsg)) {
      const iterations = state.messages.filter(
        (m) => m?._getType?.() === "ai" && hasToolCalls(m)
      ).length;
      console.log(`[shouldContinue] → tools (iterations=${iterations})`);
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    console.log(`[shouldContinue] → end`);
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, { tools: "tools", end: "__end__" })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });

  const langfuseConfig = createLangfuseRunnableConfig({
    userId, sessionId, runName: "agent-stream",
    tags: ["streaming"], metadata: { agentSessionId: sessionId },
  });
  const config: RunnableConfig = { ...langfuseConfig, configurable: { thread_id: sessionId } };

  await addMessage(db, sessionId, "user", message);

  // Track which tools were announced to avoid duplicates
  const seenTools = new Set<string>();
  let finalStateOutput: (typeof GraphState.State & { [INTERRUPT]?: unknown[] }) | null = null;
  let finalResponse = "";
  let dbgTokens = 0; // diagnostic: total text tokens emitted

  try {
    for await (const event of app.streamEvents(
      { messages: [new HumanMessage(message)], sessionId, userId, systemPrompt },
      { ...config, version: "v2" }
    )) {
      // Stream tokens from any node except compaction (which runs Gemini internally)
      if (event.event === "on_chat_model_stream" && event.metadata?.langgraph_node !== "compaction") {
        const content = event.data?.chunk?.content;
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c: Record<string, unknown>) => c.type === "text")
                .map((c: Record<string, unknown>) => c.text as string)
                .join("")
            : "";
        if (text) {
          dbgTokens++;
          finalResponse += text;
          yield { type: "token", text };
        }
      }

      // Notify when a tool starts executing
      if (event.event === "on_tool_start" && event.metadata?.langgraph_node === "tools") {
        const toolName = event.name;
        if (!seenTools.has(toolName)) {
          seenTools.add(toolName);
          yield { type: "tool_call", name: toolName };
          finalResponse = ""; // reset — final response comes after tools
        }
      }

      // Capture final graph output — runName is "agent-stream", not "LangGraph"
      if (event.event === "on_chain_end" && event.name === "agent-stream") {
        finalStateOutput = event.data?.output as (typeof GraphState.State & { [INTERRUPT]?: unknown[] });
      }
    }
  } catch (err) {
    // Extract the deepest error message to detect corrupt session patterns
    let errMsg = String(err);
    try {
      const e = err as Record<string, unknown>;
      const inner = e?.error as Record<string, unknown> | undefined;
      const rawStr = (inner?.metadata as Record<string, unknown>)?.raw as string | undefined;
      const innerMsg = inner?.message as string | undefined;
      if (innerMsg) errMsg += " " + innerMsg;
      if (rawStr) errMsg += " " + rawStr;
    } catch { /* noop */ }
    console.error("[stream] graph error:", err);
    yield { type: "error", message: errMsg };
    return;
  }
  console.log(`[stream] done. tokens=${dbgTokens} responseLen=${finalResponse.length} stateOk=${!!finalStateOutput}`);

  // Use state as authoritative source for the final response text
  if (finalStateOutput) {
    const interrupts = (finalStateOutput as Record<string, unknown>)[INTERRUPT] as
      | Array<{ value: unknown }>
      | undefined;

    if (interrupts?.length) {
      const iv = interrupts[0].value as {
        tool_call_id: string; tool_name: string; message: string; args: Record<string, unknown>;
      };
      const pendingConfirmation: PendingConfirmation = {
        tool_call_id: iv.tool_call_id,
        tool_name: iv.tool_name,
        message: iv.message,
        args: iv.args,
      };
      await addMessage(db, sessionId, "assistant", iv.message, {
        structured_payload: { type: "pending_confirmation", ...pendingConfirmation },
      });
      yield { type: "pending", data: pendingConfirmation, toolCalls: toolCallNames };
      return;
    }

    const lastMsg = finalStateOutput.messages[finalStateOutput.messages.length - 1];
    if (lastMsg) {
      const rawContent = lastMsg.content;
      console.log(`[stream] finalState msgs=${finalStateOutput.messages.length} lastMsg type=${lastMsg._getType()} contentType=${typeof rawContent} contentLen=${typeof rawContent === "string" ? rawContent.length : JSON.stringify(rawContent).length}`);
      // Log last 3 messages types to see the full picture
      finalStateOutput.messages.slice(-3).forEach((m, i) => {
        const c = m.content;
        console.log(`  msg[-${3-i}] type=${m._getType()} len=${typeof c === "string" ? c.length : JSON.stringify(c).length}`);
      });
      finalResponse = typeof lastMsg.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg.content);
    }
  }

  await addMessage(db, sessionId, "assistant", finalResponse);
  const { flushSessionMemory } = await import("./memory_flush");
  flushSessionMemory({ db, userId, sessionId }).catch((err) =>
    console.error("[stream] memory flush failed:", err)
  );

  yield { type: "done", response: finalResponse, toolCalls: toolCallNames };
}
