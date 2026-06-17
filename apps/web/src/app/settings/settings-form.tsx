"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { TOOL_CATALOG } from "@agents/types";

interface Props {
  userId: string;
  profile: Record<string, unknown> | null;
  toolSettings: Array<{ tool_id: string; enabled: boolean }>;
  telegramLinked: boolean;
  githubConnected: boolean;
  bukConnected: boolean;
}

export function SettingsForm({ userId, profile, toolSettings, telegramLinked, githubConnected, bukConnected }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [githubStatus, setGithubStatus] = useState<"connected" | "disconnected">(
    githubConnected ? "connected" : "disconnected"
  );
  const [disconnecting, setDisconnecting] = useState(false);

  const [bukStatus, setBukStatus] = useState<"connected" | "disconnected">(
    bukConnected ? "connected" : "disconnected"
  );
  const [bukTenant, setBukTenant] = useState("");
  const [bukCountry, setBukCountry] = useState("colombia");
  const [bukToken, setBukToken] = useState("");
  const [bukSaving, setBukSaving] = useState(false);
  const [bukError, setBukError] = useState<string | null>(null);
  const [bukDisconnecting, setBukDisconnecting] = useState(false);

  const [name, setName] = useState((profile?.name as string) ?? "");
  const [agentName, setAgentName] = useState((profile?.agent_name as string) ?? "Agente");
  const [systemPrompt, setSystemPrompt] = useState(
    (profile?.agent_system_prompt as string) ?? ""
  );
  const [enabledTools, setEnabledTools] = useState<string[]>(
    toolSettings.filter((t) => t.enabled).map((t) => t.tool_id)
  );
  const [linkCode, setLinkCode] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  function toggleTool(id: string) {
    setEnabledTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);

    await supabase.from("profiles").update({
      name,
      agent_name: agentName,
      agent_system_prompt: systemPrompt.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", userId);

    for (const toolId of TOOL_CATALOG.map((t) => t.id)) {
      await supabase.from("user_tool_settings").upsert(
        {
          user_id: userId,
          tool_id: toolId,
          enabled: enabledTools.includes(toolId),
          config_json: {},
        },
        { onConflict: "user_id,tool_id" }
      );
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  async function handleDisconnectGithub() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/github/disconnect", { method: "POST" });
      if (res.ok) {
        setGithubStatus("disconnected");
        router.refresh();
      }
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleConnectBuk() {
    setBukSaving(true);
    setBukError(null);
    try {
      const res = await fetch("/api/integrations/buk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant: bukTenant, country: bukCountry, token: bukToken }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        setBukError(data.error ?? "Error al conectar con BUK");
        return;
      }
      setBukStatus("connected");
      setBukTenant("");
      setBukToken("");
      router.refresh();
    } catch {
      setBukError("Error inesperado. Revisa la consola del servidor.");
    } finally {
      setBukSaving(false);
    }
  }

  async function handleDisconnectBuk() {
    setBukDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/buk/disconnect", { method: "POST" });
      if (res.ok) {
        setBukStatus("disconnected");
        router.refresh();
      }
    } finally {
      setBukDisconnecting(false);
    }
  }

  async function generateTelegramCode() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await supabase.from("telegram_link_codes").insert({
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    setLinkCode(code);
  }

  return (
    <div className="space-y-8">
      {/* Profile */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Perfil</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      </section>

      {/* Agent */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Agente</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre del agente</label>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            maxLength={50}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Instrucciones</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value.slice(0, 500))}
            rows={4}
            maxLength={500}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 text-right mt-1">{systemPrompt.length}/500</p>
        </div>
      </section>

      {/* Tools */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Herramientas</h2>
        <div className="space-y-2">
          {TOOL_CATALOG.map(({ id, displayName, displayDescription }) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabledTools.includes(id)}
                onChange={() => toggleTool(id)}
                className="rounded border-neutral-300"
              />
              <span>
                <span className="font-medium">{displayName}</span>
                <span className="ml-1 text-neutral-500">— {displayDescription}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* GitHub */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">GitHub</h2>
        {githubStatus === "connected" ? (
          <div className="flex items-center justify-between rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              <span className="text-sm font-medium text-green-700 dark:text-green-400">Conectado</span>
            </div>
            <button
              onClick={handleDisconnectGithub}
              disabled={disconnecting}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {disconnecting ? "Desconectando..." : "Desconectar"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de GitHub para que el agente pueda trabajar con tus repositorios e issues.
            </p>
            <a
              href="/api/integrations/github"
              className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Conectar GitHub
            </a>
          </div>
        )}
      </section>

      {/* BUK */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">BUK — Nómina y RRHH</h2>
        {bukStatus === "connected" ? (
          <div className="flex items-center justify-between rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
              <span className="text-sm font-medium text-green-700 dark:text-green-400">Conectado</span>
            </div>
            <button
              onClick={handleDisconnectBuk}
              disabled={bukDisconnecting}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {bukDisconnecting ? "Desconectando..." : "Desconectar"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de BUK para consultar empleados, ausencias y vacaciones desde el agente.
            </p>
            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium mb-1 text-neutral-600 dark:text-neutral-400">URL del tenant</label>
                <input
                  type="url"
                  placeholder="https://miempresa.buk.co"
                  value={bukTenant}
                  onChange={(e) => setBukTenant(e.target.value)}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 text-neutral-600 dark:text-neutral-400">País</label>
                <select
                  value={bukCountry}
                  onChange={(e) => setBukCountry(e.target.value)}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value="colombia">Colombia</option>
                  <option value="chile">Chile</option>
                  <option value="mexico">México</option>
                  <option value="peru">Perú</option>
                  <option value="brasil">Brasil</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1 text-neutral-600 dark:text-neutral-400">API Key (auth_token)</label>
                <input
                  type="password"
                  placeholder="Tu API Key de BUK"
                  value={bukToken}
                  onChange={(e) => setBukToken(e.target.value)}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <p className="text-xs text-neutral-400 mt-1">Generada en BUK: Configuración → Accesos API</p>
              </div>
            </div>
            {bukError && (
              <p className="text-sm text-red-600 dark:text-red-400">{bukError}</p>
            )}
            <button
              onClick={handleConnectBuk}
              disabled={bukSaving || !bukTenant || !bukToken}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {bukSaving ? "Verificando y conectando..." : "Conectar BUK"}
            </button>
          </div>
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Telegram</h2>
        {telegramLinked ? (
          <p className="text-sm text-green-600">Cuenta de Telegram vinculada.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Vincula tu cuenta de Telegram para usar el agente desde allí.
            </p>
            {linkCode ? (
              <div className="rounded-md bg-neutral-50 p-4 dark:bg-neutral-900">
                <p className="text-sm">
                  Envía este código al bot en Telegram:{" "}
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-sm font-mono font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    /link {linkCode}
                  </code>
                </p>
                <p className="text-xs text-neutral-400 mt-1">Expira en 10 minutos.</p>
              </div>
            ) : (
              <button
                onClick={generateTelegramCode}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Generar código de vinculación
              </button>
            )}
          </div>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
        {saved && (
          <span className="text-sm text-green-600">Guardado correctamente.</span>
        )}
      </div>
    </div>
  );
}
